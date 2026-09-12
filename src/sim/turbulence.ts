import { fromLocal } from './mission';
import type { Site, Terrain, Weather } from './types';
import { windAt } from './wind';

/*
 * Турбулентность — пульсации ветра поверх среднего (wind.ts). Спектр — как в модели Драйдена
 * для малых высот (MIL-F-8785C): масштаб вихрей растёт с высотой, горизонтальные пульсации
 * у земли сильнее вертикальных. Поле строится суммой случайных фурье-мод с весами по спектру,
 * «замороженное» и переносимое средним ветром (гипотеза Тейлора) и медленно живущее само.
 * Поэтому sample() — чистая функция времени и точки: один seed — одна и та же турбулентность,
 * сколько ни спрашивай и в каком порядке. У аппарата на висении пульсации меняются за L/U,
 * в крейсере — за L/V.
 *
 * Рельеф: в подветренной тени гряды (до ~12 её высот по ветру и не выше ~её высоты над гребнем)
 * пульсации сильнее и есть нисходящий поток; над склонами, повёрнутыми к Солнцу, — термики.
 */

const RAD = Math.PI / 180;
const FT = 3.2808;
/** Мод на составляющую: больше — ровнее спектр, дороже выборка. */
const MODES = 40;
/** Длины волн мод, м: от мелких вихрей до крупных. */
const WAVE_MIN_M = 6;
const WAVE_MAX_M = 4000;
/** Во сколько раз может вырасти СКО в подветренной тени. */
const LEE_GAIN = 1.5;
/** Нисходящий поток за грядой — доля скорости ветра. */
const LEE_SINK = 0.15;
/** Расстояния против ветра, на которых ищем гряду, м. */
const LEE_PROBE_M = [40, 80, 130, 200, 300, 450, 650, 900];
/** Клетка кэша рельефа, м: выборки высот дорогие, а тень рельефа меняется плавно. */
const CELL_M = 25;
/** Восходящий поток термика на склоне с избытком освещённости 1, м/с. */
const THERMAL_MS = 3;

export interface Gust {
  /** Восток, север, вверх, м/с. */
  e: number;
  n: number;
  u: number;
}

export interface SunDirection {
  elevationDeg: number;
  azimuthDeg: number;
}

function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Mode {
  /** Волновое число, рад/м, и его проекции на восток и север. */
  k: number;
  ke: number;
  kn: number;
  /** Собственная частота «жизни» вихря, рад/с. */
  w: number;
  phase: number;
}

/** Масштабы и СКО по Драйдену на высоте h над землёй, в долях СКО горизонтальных пульсаций на 10 м. */
export function drydenScales(aglM: number): { horizontal: number; vertical: number; lengthHM: number; lengthVM: number } {
  const hFt = Math.max(5, aglM) * FT;
  const ratio = (x: number) => Math.pow(0.177 + 0.000823 * Math.min(x, 1000), 0.4);
  // СКО вертикальных у Драйдена от высоты не зависит; турбулентность задана горизонтальной на 10 м.
  const sw = ratio(10 * FT);
  // Выше 1000 футов масштабы плавно выходят на 1750 футов, как в модели для средних высот.
  let lhFt: number;
  let lvFt: number;
  if (hFt <= 1000) {
    lhFt = hFt / Math.pow(0.177 + 0.000823 * hFt, 1.2);
    lvFt = hFt;
  } else {
    const f = Math.min(1, (hFt - 1000) / 1000);
    lhFt = 1000 + 750 * f;
    lvFt = lhFt;
  }
  // У самой земли вертикальные пульсации гасит поверхность.
  const ground = Math.min(1, Math.max(0.3, aglM / 15));
  return { horizontal: sw / ratio(hFt), vertical: sw * ground, lengthHM: lhFt / FT, lengthVM: lvFt / FT };
}

export class Turbulence {
  /** СКО горизонтальных пульсаций на 10 м над ровным местом, м/с. */
  readonly rmsMs: number;
  private readonly modes: Mode[][];
  /** Перенос поля средним ветром, м/с (восток, север). */
  private readonly advE: number;
  private readonly advN: number;
  private readonly windFromDeg: number;
  private readonly wind10Ms: number;
  private readonly cloud: number;
  private readonly leeCache = new Map<number, Float64Array>();
  private readonly slopeCache = new Map<number, Float64Array>();

  constructor(
    seed: number,
    private readonly weather: Weather,
    private readonly terrain?: Terrain,
    private readonly site?: Site,
    /** Солнце для термиков: постоянное или по времени полёта; без него термиков нет. */
    private readonly sun?: SunDirection | ((t: number) => SunDirection),
  ) {
    this.rmsMs = Math.max(0, weather.turbulenceMs ?? 0);
    const r = rng(seed ^ 0x5eed);
    const kMin = (2 * Math.PI) / WAVE_MAX_M;
    const kMax = (2 * Math.PI) / WAVE_MIN_M;
    this.modes = [0, 1, 2].map(() => {
      const out: Mode[] = [];
      for (let j = 0; j < MODES; j++) {
        // Волновые числа — логарифмически равномерно с небольшим разбросом, направления случайные.
        const k = kMin * Math.pow(kMax / kMin, (j + 0.2 + 0.6 * r()) / MODES);
        const dir = 2 * Math.PI * r();
        // Вихрь размером 1/k живёт порядка 1/(σ·k) — поле меняется и без ветра.
        const w = (0.3 + 0.7 * r()) * k * Math.max(0.5, this.rmsMs);
        out.push({ k, ke: k * Math.sin(dir), kn: k * Math.cos(dir), w, phase: 2 * Math.PI * r() });
      }
      return out;
    });
    const adv = windAt(weather, 50);
    const to = (adv.fromDeg + 180) * RAD;
    this.advE = adv.speedMs * Math.sin(to);
    this.advN = adv.speedMs * Math.cos(to);
    this.windFromDeg = weather.wind.fromDeg;
    this.wind10Ms = windAt(weather, 10).speedMs;
    this.cloud = Math.min(1, Math.max(0, weather.cloudCover ?? 0));
  }

  /** Есть ли пульсации вообще (turbulenceMs > 0). */
  get active(): boolean {
    return this.rmsMs > 0;
  }

  /**
   * Пульсация ветра в момент t (с) в точке east/north (м от начала координат) на высоте aglM над
   * землёй, м/с. Прибавляется к среднему ветру windAt(). Без турбулентности — нули.
   */
  sample(t: number, east: number, north: number, aglM: number): Gust {
    if (this.rmsMs <= 0) return { e: 0, n: 0, u: 0 };
    const agl = Math.max(0, aglM);
    const sc = drydenScales(agl);
    const lee = this.leeFactor(east, north, agl);
    const thermal = this.thermal(t, east, north, agl);
    const gain = this.rmsMs * (1 + LEE_GAIN * lee) * (1 + thermal.gain);
    // Точка в «замороженном» поле, которое сносит ветер.
    const x = east - this.advE * t;
    const y = north - this.advN * t;
    const e = gain * sc.horizontal * this.field(this.modes[0]!, x, y, t, sc.lengthHM, false);
    const n = gain * sc.horizontal * this.field(this.modes[1]!, x, y, t, sc.lengthHM, false);
    const u = gain * sc.vertical * this.field(this.modes[2]!, x, y, t, sc.lengthVM, true) - LEE_SINK * this.wind10Ms * lee + thermal.updraftMs;
    return { e, n, u };
  }

  /**
   * Сумма мод с весами по спектру Драйдена для масштаба L: продольный для горизонтальных,
   * поперечный для вертикальной. Веса нормированы — СКО суммы ровно 1.
   */
  private field(modes: Mode[], x: number, y: number, t: number, L: number, vertical: boolean): number {
    let sumW = 0;
    let sum = 0;
    for (const m of modes) {
      const q = (L * m.k) ** 2;
      // Φ(Ω)·Ω — моды равномерны по log Ω.
      const phi = vertical ? ((1 + 3 * q) / (1 + q) ** 2) * m.k * L : ((2 * m.k * L) / (1 + q));
      sumW += phi;
      sum += Math.sqrt(phi) * Math.cos(m.ke * x + m.kn * y + m.w * t + m.phase);
    }
    // Дисперсия Σ a²/2 → множитель √2 делает СКО единичным.
    return sumW > 0 ? (sum * Math.SQRT2) / Math.sqrt(sumW) : 0;
  }

  private groundM(east: number, north: number): number {
    return this.terrain!.elevationM(fromLocal(this.site!, east, north));
  }

  private key(east: number, north: number): number {
    return Math.round(east / CELL_M) * 1_000_003 + Math.round(north / CELL_M);
  }

  /**
   * Подветренная тень 0…1: против ветра есть гряда выше точки на H, точка ближе ~12·H за ней
   * и не выше гребня больше чем на H + 20 м. Сила — по ветру: в слабый ветер тени нет.
   */
  private leeFactor(east: number, north: number, agl: number): number {
    if (!this.terrain || !this.site) return 0;
    const windK = Math.min(1, Math.max(0, (this.wind10Ms - 2) / 6));
    if (windK <= 0) return 0;
    const key = this.key(east, north);
    let rises = this.leeCache.get(key);
    if (!rises) {
      const ce = Math.round(east / CELL_M) * CELL_M;
      const cn = Math.round(north / CELL_M) * CELL_M;
      const here = this.groundM(ce, cn);
      const fe = Math.sin(this.windFromDeg * RAD);
      const fn = Math.cos(this.windFromDeg * RAD);
      rises = new Float64Array(LEE_PROBE_M.map((d) => this.groundM(ce + fe * d, cn + fn * d) - here));
      if (this.leeCache.size > 50_000) this.leeCache.clear();
      this.leeCache.set(key, rises);
    }
    let lee = 0;
    for (let i = 0; i < LEE_PROBE_M.length; i++) {
      const H = rises[i]!;
      if (H < 3) continue;
      const wake = Math.max(0, 1 - LEE_PROBE_M[i]! / (12 * H));
      const depth = Math.min(1, Math.max(0, 1 - (agl - H) / (H + 20)));
      lee = Math.max(lee, wake * depth);
    }
    return lee * windK;
  }

  /**
   * Термик над склоном, освещённым сильнее ровного места: избыток освещённости cos(i) − sin(h☉),
   * без облаков. Восходящий поток растёт от земли до ~50 м и ослабевает к ~1 км; пульсации там же сильнее.
   */
  private thermal(t: number, east: number, north: number, agl: number): { updraftMs: number; gain: number } {
    if (!this.sun || !this.terrain || !this.site) return { updraftMs: 0, gain: 0 };
    const sun = typeof this.sun === 'function' ? this.sun(t) : this.sun;
    if (sun.elevationDeg < 5) return { updraftMs: 0, gain: 0 };
    const key = this.key(east, north);
    let n = this.slopeCache.get(key);
    if (!n) {
      const ce = Math.round(east / CELL_M) * CELL_M;
      const cn = Math.round(north / CELL_M) * CELL_M;
      const d = 30;
      const ge = (this.groundM(ce + d, cn) - this.groundM(ce - d, cn)) / (2 * d);
      const gn = (this.groundM(ce, cn + d) - this.groundM(ce, cn - d)) / (2 * d);
      const len = Math.hypot(ge, gn, 1);
      n = new Float64Array([-ge / len, -gn / len, 1 / len]);
      if (this.slopeCache.size > 50_000) this.slopeCache.clear();
      this.slopeCache.set(key, n);
    }
    const el = sun.elevationDeg * RAD;
    const az = sun.azimuthDeg * RAD;
    const s = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
    const excess = Math.max(0, n[0]! * s[0]! + n[1]! * s[1]! + n[2]! * s[2]! - Math.sin(el)) * (1 - this.cloud);
    if (excess <= 0) return { updraftMs: 0, gain: 0 };
    const shape = Math.min(1, agl / 50) * Math.exp(-agl / 1000);
    return { updraftMs: THERMAL_MS * excess * shape, gain: 2 * excess * shape };
  }
}
