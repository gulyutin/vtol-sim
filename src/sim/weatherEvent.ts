import type { LocalWind } from './terrainWind';
import type { Weather } from './types';
import { windAt } from './wind';

/*
 * Погода, которая меняется в полёте: холодный фронт или грозовая ячейка. Прогноз, по которому
 * строился план, их не учитывает — решение «продолжать или возвращаться» оператор принимает сам.
 *
 * Холодный фронт — прямая линия, идёт со скоростью FRONT_SPEED_MS; за ней ветер поворачивает
 * вправо и усиливается, облака опускаются, идёт ливневый дождь; на самой линии — шквал: порывы,
 * восходящий поток перед ней и нисходящий за ней.
 *
 * Грозовая ячейка — круг, смещается с ведущим потоком (ветер на ~1,5 км); растёт, зреет и
 * распадается. Под ядром — ливень и нисходящий поток, вокруг — растекание холодного воздуха от
 * ядра (порывистый ветер от ячейки) и сильная болтанка.
 */

export type WeatherEventKind = 'none' | 'front' | 'storm';

export const WEATHER_EVENTS: readonly { id: WeatherEventKind; title: string }[] = [
  { id: 'none', title: 'не меняется' },
  { id: 'front', title: 'подходит холодный фронт' },
  { id: 'storm', title: 'грозовая ячейка' },
];

type Precipitation = NonNullable<Weather['precipitation']>;

const FRONT_SPEED_MS = 9;
/** Полуширина переходной зоны фронта, м. */
const FRONT_HALF_M = 1200;
const STORM_CORE_M = 2000;
const STORM_OUTFLOW_M = 6500;

const RAD = Math.PI / 180;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Погода в точке от события: что изменить в погоде для вида (дождь, облака, видимость). */
export interface EventWeather {
  /** Насколько событие здесь сейчас, 0…1: 0 — погода прогноза. */
  strength: number;
  precipitation: Precipitation | null;
  cloudBaseM: number | null;
  cloudCover: number | null;
  visibilityM: number | null;
  /** Грозовые вспышки поблизости. */
  lightning: boolean;
}

/** Что рисовать на карте, локальные метры от площадки. */
export type WeatherHazard =
  | { kind: 'front'; a: { east: number; north: number }; b: { east: number; north: number }; moveDeg: number; speedMs: number }
  | { kind: 'storm'; center: { east: number; north: number }; coreM: number; outflowM: number; moveDeg: number; speedMs: number; strength: number };

export interface WeatherEventOptions {
  seed: number;
  /** Куда нацелено событие: центр маршрута, м от площадки. */
  target: { east: number; north: number };
  /** Через сколько секунд после начала отсчёта событие дойдёт до цели. */
  arriveS?: number;
}

export class WeatherEvent {
  readonly kind: Exclude<WeatherEventKind, 'none'>;
  private readonly base: Weather;
  /** Направление движения, куда, ° и единичный вектор. */
  readonly moveDeg: number;
  private readonly dir: { e: number; n: number };
  readonly speedMs: number;
  /** Фронт: где линия в момент 0 — расстояние по направлению движения от начала координат, м. */
  private readonly s0: number;
  /** Ячейка: центр в момент 0. */
  private readonly c0: { east: number; north: number };
  /** Ячейка: время зрелости, с. */
  private readonly matureT: number;
  /** После фронта: поворот ветра, ° и множитель скорости. */
  private readonly veerDeg: number;
  private readonly gain: number;

  constructor(kind: Exclude<WeatherEventKind, 'none'>, base: Weather, o: WeatherEventOptions) {
    this.kind = kind;
    this.base = base;
    const r = mulberry32(o.seed * 7919 + (kind === 'front' ? 11 : 23));
    const arrive = o.arriveS ?? 900 + 900 * r();
    const w = base.wind;
    if (kind === 'front') {
      // Холодный фронт приходит с запада-северо-запада (или по ветру, если ветер оттуда).
      const from = w.speedMs > 3 && (w.fromDeg > 200 || w.fromDeg < 20) ? w.fromDeg + 20 : 290 + 30 * (r() - 0.5);
      this.moveDeg = (from + 180) % 360;
      this.speedMs = FRONT_SPEED_MS * (0.85 + 0.3 * r());
    } else {
      const steer = windAt(base, 1500);
      this.moveDeg = steer.speedMs > 2 ? (steer.fromDeg + 180 + 20 * (r() - 0.5)) % 360 : 360 * r();
      this.speedMs = Math.max(6, Math.min(14, steer.speedMs * 0.9 + 3));
    }
    this.dir = { e: Math.sin(this.moveDeg * RAD), n: Math.cos(this.moveDeg * RAD) };
    // В момент arrive линия (центр ячейки) проходит через цель; ячейка — со смещением вбок до 2,5 км.
    const along = o.target.east * this.dir.e + o.target.north * this.dir.n;
    this.s0 = along - this.speedMs * arrive;
    const side = (r() - 0.5) * 5000;
    const at = { east: o.target.east + this.dir.n * side, north: o.target.north - this.dir.e * side };
    this.c0 = { east: at.east - this.dir.e * this.speedMs * arrive, north: at.north - this.dir.n * this.speedMs * arrive };
    this.matureT = arrive - 300 + 600 * r();
    this.veerDeg = 40 + 30 * r();
    this.gain = 1.6 + 0.4 * r();
  }

  /** Фронт: на сколько метров линия уже прошла за точку (+ — точка за фронтом). */
  private passed(east: number, north: number, t: number): number {
    return this.s0 + this.speedMs * t - (east * this.dir.e + north * this.dir.n);
  }

  private center(t: number): { east: number; north: number } {
    return { east: this.c0.east + this.dir.e * this.speedMs * t, north: this.c0.north + this.dir.n * this.speedMs * t };
  }

  /** Ячейка: жизнь — рост 15 мин до зрелости, зрелость ~25 мин, распад 15 мин. 0…1. */
  private life(t: number): number {
    return smooth(this.matureT - 900, this.matureT, t) * (1 - smooth(this.matureT + 1500, this.matureT + 2400, t));
  }

  /** Местный ветер с событием: ветер у борта, вертикальный поток и болтанка. */
  apply(lw: LocalWind, east: number, north: number, aglM: number, t: number): LocalWind {
    if (this.kind === 'front') {
      const d = this.passed(east, north, t);
      const f = smooth(-FRONT_HALF_M, FRONT_HALF_M, d);
      if (f <= 0 && d < -3 * FRONT_HALF_M) return lw;
      // За фронтом: поворот вправо и усиление; на линии — шквал.
      const a = this.veerDeg * f * RAD;
      const k = 1 + (this.gain - 1) * f;
      // Поворот по часовой (направление, куда дует, растёт на a) — ветер «правеет».
      const e = (lw.eastMs * Math.cos(a) + lw.northMs * Math.sin(a)) * k;
      const n = (lw.northMs * Math.cos(a) - lw.eastMs * Math.sin(a)) * k;
      const line = Math.exp(-((d / 900) ** 2));
      const up = 1.8 * Math.exp(-(((d + 1500) / 1000) ** 2)) - 2.5 * Math.exp(-(((d - 700) / 700) ** 2));
      return { eastMs: e, northMs: n, upMs: lw.upMs + up * Math.min(1, aglM / 150 + 0.2), turbulenceScale: lw.turbulenceScale * (1 + 0.8 * f), turbulenceAddMs: lw.turbulenceAddMs + 3.5 * line + 0.8 * f };
    }
    const c = this.center(t);
    const life = this.life(t);
    if (life <= 0) return lw;
    const de = east - c.east;
    const dn = north - c.north;
    const r = Math.hypot(de, dn);
    if (r > STORM_OUTFLOW_M * 1.5) return lw;
    const core = 1 - smooth(STORM_CORE_M * 0.6, STORM_CORE_M, r);
    // Растекание: радиально от ядра, сильнее у земли, пик у кромки ядра.
    const out = life * 12 * Math.exp(-(((r - STORM_CORE_M) / 2200) ** 2)) * Math.max(0.35, 1 - aglM / 800);
    const ue = r > 1 ? de / r : 0;
    const un = r > 1 ? dn / r : 0;
    const down = -life * 6 * core * Math.min(1, aglM / 200 + 0.3);
    const rough = life * (5 * core + 2.5 * Math.exp(-(((r - STORM_CORE_M) / 2500) ** 2)));
    return { eastMs: lw.eastMs + out * ue, northMs: lw.northMs + out * un, upMs: lw.upMs + down, turbulenceScale: lw.turbulenceScale, turbulenceAddMs: lw.turbulenceAddMs + rough };
  }

  /** Погода в точке для вида: дождь, облака, видимость. */
  weatherAt(east: number, north: number, t: number): EventWeather {
    if (this.kind === 'front') {
      const d = this.passed(east, north, t);
      const f = smooth(-FRONT_HALF_M * 2, FRONT_HALF_M, d);
      // Ливень — в полосе 1–8 км за линией, дальше — моросит.
      const rain = f * (d < 8000 ? 6 * Math.exp(-(((d - 2500) / 3000) ** 2)) + 0.6 : 0.6);
      return {
        strength: f,
        precipitation: rain > 0.2 ? { kind: 'rain', mmPerH: rain } : null,
        cloudBaseM: f > 0 ? (this.base.cloudBaseM ?? 1500) * (1 - f) + 450 * f : null,
        cloudCover: f > 0 ? Math.max(this.base.cloudCover ?? 0.3, 0.3 + 0.65 * f) : null,
        visibilityM: rain > 1 ? 12000 / (1 + rain) : null,
        lightning: false,
      };
    }
    const c = this.center(t);
    const life = this.life(t);
    const r = Math.hypot(east - c.east, north - c.north);
    const k = life * (1 - smooth(STORM_CORE_M, STORM_OUTFLOW_M * 1.6, r));
    const core = life * (1 - smooth(STORM_CORE_M * 0.5, STORM_CORE_M * 1.3, r));
    const rain = 35 * core + 3 * k;
    return {
      strength: k,
      precipitation: rain > 0.3 ? { kind: 'rain', mmPerH: rain } : null,
      cloudBaseM: k > 0.05 ? (this.base.cloudBaseM ?? 1500) * (1 - 0.6 * k) : null,
      cloudCover: k > 0.05 ? Math.min(1, (this.base.cloudCover ?? 0.3) + 0.7 * k) : null,
      visibilityM: rain > 1 ? 15000 / (1 + rain * 0.6) : null,
      lightning: life > 0.5 && r < 15000,
    };
  }

  /** Для карты и сводок: где сейчас линия фронта или ячейка. */
  hazard(t: number, extentM: number): WeatherHazard | null {
    if (this.kind === 'front') {
      // Точка линии, ближайшая к началу координат, и отрезок вдоль неё.
      const s = this.s0 + this.speedMs * t;
      const p = { east: this.dir.e * s, north: this.dir.n * s };
      const q = { e: -this.dir.n, n: this.dir.e };
      return { kind: 'front', a: { east: p.east + q.e * extentM, north: p.north + q.n * extentM }, b: { east: p.east - q.e * extentM, north: p.north - q.n * extentM }, moveDeg: this.moveDeg, speedMs: this.speedMs };
    }
    const life = this.life(t);
    if (life <= 0.02) return null;
    return { kind: 'storm', center: this.center(t), coreM: STORM_CORE_M, outflowM: STORM_OUTFLOW_M, moveDeg: this.moveDeg, speedMs: this.speedMs, strength: life };
  }

  /** Сколько метров до события от точки (0 — точка в нём) и через сколько секунд оно здесь (null — не дойдёт). */
  approach(east: number, north: number, t: number): { distanceM: number; etaS: number | null } {
    if (this.kind === 'front') {
      const d = this.passed(east, north, t);
      if (d >= -FRONT_HALF_M) return { distanceM: 0, etaS: 0 };
      return { distanceM: -d, etaS: -d / this.speedMs };
    }
    const c = this.center(t);
    const de = east - c.east;
    const dn = north - c.north;
    const r = Math.hypot(de, dn);
    const edge = Math.max(0, r - STORM_OUTFLOW_M * 0.6);
    // Сближение — проекция на направление движения ячейки.
    const closing = (de * this.dir.e + dn * this.dir.n) / Math.max(r, 1);
    const lateral = Math.abs(de * this.dir.n - dn * this.dir.e);
    const eta = closing > 0.2 && lateral < STORM_OUTFLOW_M ? edge / (this.speedMs * closing) : null;
    return { distanceM: edge, etaS: this.life(t) > 0.02 ? eta : null };
  }
}

/** Ветер погоды в точке как местный — когда поля рельефа нет. */
export function plainLocalWind(weather: Weather, aglM: number): LocalWind {
  const w = windAt(weather, Math.max(0, aglM));
  const to = (w.fromDeg + 180) * RAD;
  return { eastMs: w.speedMs * Math.sin(to), northMs: w.speedMs * Math.cos(to), upMs: 0, turbulenceScale: 1, turbulenceAddMs: 0 };
}
