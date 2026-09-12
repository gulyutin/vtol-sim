import { fromLocal, toLocal } from './mission';
import { LEE_GAIN, LEE_SINK, type SunDirection } from './turbulence';
import type { GeoPoint, Site, Terrain, Weather, Wind } from './types';
import { windAt } from './wind';

/*
 * Ветер у рельефа — поправки к фоновому ветру погоды (wind.ts); пульсации поверх — turbulence.ts.
 * Не CFD, а несколько объяснимых поправок по сглаженному рельефу области, посчитанному заранее
 * на грубой сетке (~200 м):
 *  - обтекание склона: вертикальный поток w = V·∇h — вверх на наветренном, вниз на подветренном;
 *    затухает с высотой над рельефом на масштабе его перепадов;
 *  - форма рельефа: ветер сильнее на гребнях и в седловинах (точка выше соседей вдоль ветра),
 *    слабее в понижениях поперёк ветра — как ΔV/V ≈ 2H/L у Джексона — Ханта;
 *  - подветренная тень: за гребнем до 5–10 его высот и не выше гребня — роторная зона: ветер
 *    слабее, нисходящий поток, болтанка сильнее;
 *  - долина: у дна ветер поворачивает вдоль её оси, к высоте гребней — обратно к фоновому;
 *  - днём — термики: пятна восходящих потоков над склонами, освещёнными сильнее ровного места;
 *    живут ~15 мин и сносятся ветром; ночью — слабый стекающий вниз по склонам ветер.
 * Всё детерминировано по seed и времени. Над ровным местом поправок нет вовсе.
 *
 * TerrainRelief — сетка рельефа области (дорого, один раз); TerrainWind — поправки для погоды
 * (десятки мс); localWind() — билинейная выборка из сеток и несколько формул.
 */

const RAD = Math.PI / 180;
/** Шаг сетки по умолчанию, м, и предел числа узлов. */
const CELL_M = 200;
const MAX_NODES = 250_000;
/** Запас вокруг области, м: гряды против ветра и сглаживание у края. Во внешней половине запаса поправки гаснут. */
const PAD_M = 3000;
/** Масштабы сглаживания, м: уклоны; разброс высот; линии рельефа (оси долин). */
const SLOPE_WIDTH_M = 400;
const RELIEF_WIDTH_M = 1000;
const LINES_WIDTH_M = 800;
/** Борта долины ищем поперёк её оси на этих расстояниях, м. */
const VALLEY_PROBE_M = [500, 1000, 1500, 2000];
/** Разброс высот, при котором рельеф ровный, м. */
const FLAT_M = 1;

/** Точку сравниваем с соседями вдоль ветра и поперёк на ±2σ, м. */
const ALONG_WIDTH_M = 1500;
/** ΔV/V на 1 км превышения над соседями вдоль ветра; добавка седловины; одиночную вершину поток отчасти обходит. */
const SPEEDUP_PER_KM = 2.5;
const GAP_PER_KM = 2.5;
const ISO_PER_KM = 0.5;
const SPEEDUP_MIN = -0.6;
const SPEEDUP_MAX = 0.9;

/** Гряды ищем против ветра до LEE_RANGE_M; тень полная до LEE_NEAR высот гряды, дальше LEE_FAR её нет. */
const LEE_RANGE_M = 6000;
const LEE_NEAR = 5;
const LEE_FAR = 10;
const LEE_MIN_H = 15;
/** В тени горизонтальный ветер слабее на эту долю; добавка СКО пульсаций — доля ветра на высоте гребня. */
const LEE_SHELTER = 0.5;
const ROTOR_TURB = 0.15;

/** У дна долины скорость вдоль оси чуть больше — поток зажат склонами; поперёк остаётся хоть немного. */
const VALLEY_GAIN = 0.2;
const VALLEY_MAX = 0.9;

/** Термик: пик в сердцевине при полной освещённости склона, м/с; шаг решётки пятен, м; жизнь, с. */
const THERMAL_MS = 3.5;
const THERMAL_SPACING_M = 1400;
const THERMAL_LIFE_S = 900;
/** Доля мест решётки, где в данный срок жизни термик есть. */
const THERMAL_CHANCE = 0.75;
/** Избыток освещённости склона над ровным местом, при котором термики в полную силу. */
const THERMAL_EXCESS_FULL = 0.2;
/** Высота слоя перемешивания, если нижняя граница облаков неизвестна, м. */
const MIXING_M = 1500;
/** Ночной сток: на склоне круче 0.2, м/с; высота его максимума над склоном, м. */
const KATABATIC_MS = 2;
const KATABATIC_H_M = 20;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smoothstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Равномерное 0…1 по целым координатам — одно и то же при любом порядке опроса. */
function hash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x1b873593) ^ Math.imul(d | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Билинейно по сетке nx × ny в координатах узлов; за краем — по краю. */
function bil(g: Float64Array, nx: number, ny: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x > nx - 1 ? nx - 1 : x;
  const cy = y < 0 ? 0 : y > ny - 1 ? ny - 1 : y;
  const i = Math.min(nx - 2, Math.floor(cx));
  const j = Math.min(ny - 2, Math.floor(cy));
  const u = cx - i;
  const v = cy - j;
  const k = j * nx + i;
  return (g[k]! * (1 - u) + g[k + 1]! * u) * (1 - v) + (g[k + nx]! * (1 - u) + g[k + nx + 1]! * u) * v;
}

/** Гауссово сглаживание сетки, σ — в клетках; у края — по краю. */
function blur(src: Float64Array, nx: number, ny: number, width: number): Float64Array {
  const r = Math.max(1, Math.ceil(3 * width));
  const kern = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let q = -r; q <= r; q++) sum += kern[q + r] = Math.exp(-(q * q) / (2 * width * width));
  for (let q = 0; q < kern.length; q++) kern[q]! /= sum;
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let q = -r; q <= r; q++) s += kern[q + r]! * src[row + clamp(i + q, 0, nx - 1)]!;
      tmp[row + i] = s;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let q = -r; q <= r; q++) s += kern[q + r]! * tmp[clamp(j + q, 0, ny - 1) * nx + i]!;
      out[j * nx + i] = s;
    }
  }
  return out;
}

/** Прямоугольник в локальных координатах от начала (восток, север), м. */
export interface WindArea {
  east0: number;
  north0: number;
  east1: number;
  north1: number;
}

export interface ReliefOptions {
  /** Где нужен ветер; по умолчанию ±15 км на восток и ±20 км на север от начала. */
  area?: WindArea;
  /** Шаг сетки, м; по умолчанию 200. Если узлов выходит больше ~250 тыс., шаг растёт. */
  cellM?: number;
}

type Pause = () => Promise<void>;
const nextMacrotask: Pause = () =>
  new Promise<void>((ok) => (globalThis as unknown as { setTimeout(f: () => void, ms: number): unknown }).setTimeout(ok, 0));

/**
 * Рельеф области на грубой сетке: высоты, уклоны, превышение над окрестностью, перепады, долины.
 * От ветра не зависит — строится один раз на область.
 */
export class TerrainRelief {
  /** Узел (0, 0) — в локальных координатах, м; шаг сетки, м; число узлов. */
  readonly e0: number;
  readonly n0: number;
  readonly cellM: number;
  readonly nx: number;
  readonly ny: number;
  readonly area: WindArea;
  /** Рельеф без перепадов: поправок нет. */
  flat = true;
  /** Высота клетки, м (среднее по клетке), и она же сглаженная — для уклонов. */
  readonly h: Float64Array;
  readonly hs: Float64Array;
  /** Уклон сглаженного рельефа: восток, север. */
  readonly gx: Float64Array;
  readonly gy: Float64Array;
  /** Высота над рельефом, на которой поправки обтекания слабеют в e раз, м. */
  readonly dz: Float64Array;
  /** Долина: вес поворота 0…1; ось как (cos 2φ, sin 2φ) — без разрыва на 180°; глубина, м. */
  readonly valley: Float64Array;
  readonly axC: Float64Array;
  readonly axS: Float64Array;
  readonly valleyDepth: Float64Array;

  private constructor(
    readonly origin: Site,
    o: ReliefOptions,
  ) {
    const a = o.area ?? { east0: -15_000, north0: -20_000, east1: 15_000, north1: 20_000 };
    this.area = a;
    const w = a.east1 - a.east0 + 2 * PAD_M;
    const hgt = a.north1 - a.north0 + 2 * PAD_M;
    const cell = Math.max(o.cellM ?? CELL_M, Math.sqrt((w * hgt) / MAX_NODES));
    this.cellM = cell;
    this.nx = Math.max(3, Math.ceil(w / cell) + 1);
    this.ny = Math.max(3, Math.ceil(hgt / cell) + 1);
    this.e0 = a.east0 - PAD_M;
    this.n0 = a.north0 - PAD_M;
    const n = this.nx * this.ny;
    this.h = new Float64Array(n);
    this.hs = new Float64Array(n);
    this.gx = new Float64Array(n);
    this.gy = new Float64Array(n);
    this.dz = new Float64Array(n);
    this.valley = new Float64Array(n);
    this.axC = new Float64Array(n);
    this.axS = new Float64Array(n);
    this.valleyDepth = new Float64Array(n);
  }

  /** Построить сразу. Область 30×40 км по сетке высот — десятки миллисекунд. */
  static build(terrain: Terrain, origin: Site, o: ReliefOptions = {}): TerrainRelief {
    const r = new TerrainRelief(origin, o);
    const it = r.steps(terrain);
    while (!it.next().done);
    return r;
  }

  /** Построить порциями не дольше budgetMs, отдавая управление между ними (для интерфейса). */
  static async buildAsync(terrain: Terrain, origin: Site, o: ReliefOptions = {}, onProgress?: (f: number) => void, budgetMs = 12, pause: Pause = nextMacrotask): Promise<TerrainRelief> {
    const r = new TerrainRelief(origin, o);
    let t0 = Date.now();
    for (const f of r.steps(terrain)) {
      if (Date.now() - t0 < budgetMs) continue;
      onProgress?.(f);
      await pause();
      t0 = Date.now();
    }
    onProgress?.(1);
    return r;
  }

  /** Доля поправок у края сетки: во внешней половине запаса гаснут до нуля. fx, fy — в клетках. */
  edge(fx: number, fy: number): number {
    const d = Math.min(fx, fy, this.nx - 1 - fx, this.ny - 1 - fy) * this.cellM;
    return smoothstep(d, 0, PAD_M / 2);
  }

  /** Выборка сетки в локальной точке, м. */
  at(g: Float64Array, east: number, north: number): number {
    return bil(g, this.nx, this.ny, (east - this.e0) / this.cellM, (north - this.n0) / this.cellM);
  }

  /** Шаги построения; отдаёт долю готовности. */
  private *steps(terrain: Terrain): Generator<number> {
    const { nx, ny, cellM: c } = this;
    const N = nx * ny;
    const el = (e: number, n: number) => terrain.elevationM(fromLocal(this.origin, e, n));
    const q = c / 4;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < ny; j++) {
      const n = this.n0 + j * c;
      for (let i = 0; i < nx; i++) {
        const e = this.e0 + i * c;
        // Среднее по клетке из четырёх выборок: узкий гребень не пропадёт между узлами.
        const z = (el(e - q, n - q) + el(e + q, n - q) + el(e - q, n + q) + el(e + q, n + q)) / 4;
        this.h[j * nx + i] = z;
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      }
      yield (0.7 * (j + 1)) / ny;
    }
    this.flat = !(hi - lo >= FLAT_M);
    if (this.flat) return;

    this.hs.set(blur(this.h, nx, ny, SLOPE_WIDTH_M / c));
    yield 0.75;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const iw = Math.max(0, i - 1);
        const ie = Math.min(nx - 1, i + 1);
        const js = Math.max(0, j - 1);
        const jn = Math.min(ny - 1, j + 1);
        this.gx[j * nx + i] = (this.hs[j * nx + ie]! - this.hs[j * nx + iw]!) / ((ie - iw) * c);
        this.gy[j * nx + i] = (this.hs[jn * nx + i]! - this.hs[js * nx + i]!) / ((jn - js) * c);
      }
    }
    // Разброс высот вокруг: σ = √(⟨h²⟩ − ⟨h⟩²), от среднего по области — без потери точности.
    const mean = this.h.reduce((s, z) => s + z, 0) / N;
    const d = this.h.map((z) => z - mean);
    const m1 = blur(d, nx, ny, RELIEF_WIDTH_M / c);
    const m2 = blur(
      d.map((z) => z * z),
      nx,
      ny,
      RELIEF_WIDTH_M / c,
    );
    for (let k = 0; k < N; k++) {
      const sd = Math.sqrt(Math.max(0, m2[k]! - m1[k]! ** 2));
      // Возмущения обтекания доходят примерно до полутора перепадов высот вокруг.
      this.dz[k] = clamp(150 + 3 * sd, 150, 1200);
    }
    yield 0.85;
    // Линии рельефа — тензор структуры: поперёк долины уклоны склонов обоих бортов складываются,
    // а не гасят друг друга; ось долины — направление наименьших уклонов.
    const s = LINES_WIDTH_M / c;
    const jxx = blur(this.gx.map((g) => g * g), nx, ny, s);
    const jyy = blur(this.gy.map((g) => g * g), nx, ny, s);
    const jxy = blur(
      this.gx.map((g, k) => g * this.gy[k]!),
      nx,
      ny,
      s,
    );
    for (let k = 0; k < N; k++) {
      const a = jxx[k]!;
      const b = jyy[k]!;
      const x = jxy[k]!;
      const tr = a + b;
      const root = Math.sqrt(((a - b) / 2) ** 2 + x * x);
      const l1 = tr / 2 + root;
      const coherence = tr > 1e-12 ? (2 * root) / tr : 0;
      // Направление наибольших уклонов (поперёк оси) φ₁ = ½·atan2(2Jxy, Jxx − Jyy) от оси «восток»;
      // ось долины перпендикулярна: 2φ = 2φ₁ + 180°.
      const two = Math.atan2(2 * x, a - b);
      this.axC[k] = -Math.cos(two);
      this.axS[k] = -Math.sin(two);
      // Дно долины ниже обоих бортов; у подножия одиночной гряды борт один — это не долина.
      const ce = Math.cos(two / 2);
      const cn = Math.sin(two / 2);
      const i = k % nx;
      const j = (k - i) / nx;
      let depth = 0;
      for (const d of VALLEY_PROBE_M) {
        const q = d / c;
        const side = Math.min(bil(this.hs, nx, ny, i + ce * q, j + cn * q), bil(this.hs, nx, ny, i - ce * q, j - cn * q));
        depth = Math.max(depth, side - this.hs[k]!);
      }
      this.valley[k] = coherence * smoothstep(depth, 15, 60) * smoothstep(Math.sqrt(l1), 0.03, 0.1);
      this.valleyDepth[k] = clamp(depth + 30, 50, 2000);
    }
    yield 1;
  }
}

/** Ветер в точке с поправками рельефа. */
export interface LocalWind {
  /** Куда дует, м/с: на восток, на север, вверх. */
  eastMs: number;
  northMs: number;
  upMs: number;
  /** Множитель СКО турбулентности погоды: 1 — как над ровным местом. */
  turbulenceScale: number;
  /** Добавка СКО пульсаций от роторов за грядой, м/с — есть и при turbulenceMs = 0. */
  turbulenceAddMs: number;
}

/** То же с разбором по составляющим — для карты, предполётной и отладки. */
export interface WindFieldSample extends LocalWind {
  /** Фоновый ветер погоды на этой высоте — без рельефа. */
  background: Wind;
  /** Во сколько раз горизонтальный ветер сильнее фонового. */
  speedFactor: number;
  /** Подветренная тень 0…1 и гряда, которая её даёт: превышение над точкой, м; расстояние против ветра, м. */
  lee: number;
  ridgeAboveM: number;
  ridgeDistanceM: number;
  /** Добавка скорости в седловине, доля фонового. */
  gap: number;
  /** Долина: вес поворота вдоль оси 0…1 и ось, ° от севера (0…180). */
  valley: number;
  valleyAxisDeg: number;
  /** Вертикальные составляющие, м/с (+ вверх): обтекание склона, нисходящий в тени, термики. */
  slopeFlowMs: number;
  leeSinkMs: number;
  thermalMs: number;
  /** Сердцевина термика над этим местом при нынешнем Солнце, м/с — без случайных пятен. */
  thermalPotentialMs: number;
  /** Ночной сток вниз по склону, горизонтальная скорость, м/с. */
  katabaticMs: number;
}

export interface TerrainWindOptions {
  /** Случайность термиков; по умолчанию 1. */
  seed?: number;
  /** Солнце — постоянное или по времени; без него нет ни термиков, ни ночного стока. */
  sun?: SunDirection | ((t: number) => SunDirection);
}

export interface WindHazardOptions {
  /** Высоты над площадкой, на которых проверяем заход, м. */
  heightsM?: number[];
  /** Радиус вокруг площадки, м. */
  radiusM?: number;
  /** Момент, с (для Солнца: термики, ночной сток). */
  t?: number;
}

export interface WindHazard {
  /** 0 — местных эффектов нет, 1 — садиться опасно. */
  level: number;
  /** Наибольший нисходящий и восходящий поток в столбе захода, м/с (без случайных термиков). */
  sinkMs: number;
  liftMs: number;
  /** Болтанка: множитель к турбулентности погоды и добавка роторов, м/с. */
  turbulenceScale: number;
  turbulenceAddMs: number;
  /** Ветер на 10 м над площадкой: во сколько раз сильнее фонового и на сколько градусов повёрнут. */
  speedFactor: number;
  turnDeg: number;
  /** Сердцевина термика и ночной сток, м/с. */
  thermalMs: number;
  katabaticMs: number;
  /** Что ждать, по-русски, одной строкой; notes — то же по пунктам. */
  text: string;
  notes: string[];
}

/** Поле на сетке для карты: узел (i, j) — в точке (east0 + i·step, north0 + j·step). */
export interface WindFieldGrid {
  east0: number;
  north0: number;
  stepM: number;
  nx: number;
  ny: number;
  eastMs: Float32Array;
  northMs: Float32Array;
  upMs: Float32Array;
  turbulenceScale: Float32Array;
}

const fmt = (x: number, d = 1) => x.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: d });

/**
 * Поправки рельефа для погоды: направление ветра задаёт тень и «выше соседей вдоль ветра»,
 * скорость — силу поправок в момент запроса. Направление ветра в погоде постоянное.
 */
export class TerrainWind {
  /** Единичный вектор «куда дует». */
  private readonly toE: number;
  private readonly toN: number;
  private readonly speedUp: Float64Array;
  private readonly gapUp: Float64Array;
  /** Две гряды против ветра: с самой полной тенью и с наибольшим «тень × высота»; для второй — и расстояние. */
  private readonly leeWA: Float64Array;
  private readonly leeHA: Float64Array;
  private readonly leeWB: Float64Array;
  private readonly leeHB: Float64Array;
  private readonly leeDB: Float64Array;
  /** Тень в слабый ветер не образуется. */
  private readonly windK: number;
  private readonly wind10: number;
  private readonly cloud: number;
  private readonly mixingM: number;
  /** В сильный ветер термики рвутся. */
  private readonly thermalK: number;
  /** Ночной сток слабеет в ветер и под облаками. */
  private readonly katabaticK: number;
  /** Снос пятен термиков, м/с. */
  private readonly driftE: number;
  private readonly driftN: number;
  private readonly seed: number;
  private readonly sun?: SunDirection | ((t: number) => SunDirection);

  constructor(
    readonly relief: TerrainRelief,
    readonly weather: Weather,
    o: TerrainWindOptions = {},
  ) {
    this.seed = (o.seed ?? 1) | 0;
    this.sun = o.sun;
    const to = (weather.wind.fromDeg + 180) * RAD;
    this.toE = Math.sin(to);
    this.toN = Math.cos(to);
    this.wind10 = windAt(weather, 10).speedMs;
    this.windK = smoothstep(this.wind10, 2, 7);
    this.cloud = clamp(weather.cloudCover ?? 0, 0, 1);
    this.mixingM = clamp(weather.cloudBaseM ?? MIXING_M, 300, 3000);
    this.thermalK = 1 / (1 + (this.wind10 / 10) ** 2);
    this.katabaticK = (1 - 0.7 * this.cloud) / (1 + (this.wind10 / 4) ** 2);
    const drift = windAt(weather, 300).speedMs;
    this.driftE = drift * this.toE;
    this.driftN = drift * this.toN;
    const N = relief.flat ? 0 : relief.nx * relief.ny;
    this.speedUp = new Float64Array(N);
    this.gapUp = new Float64Array(N);
    this.leeWA = new Float64Array(N);
    this.leeHA = new Float64Array(N);
    this.leeWB = new Float64Array(N);
    this.leeHB = new Float64Array(N);
    this.leeDB = new Float64Array(N);
    if (N > 0) this.build();
  }

  /** Есть ли поправки вообще: рельеф не ровный. */
  get active(): boolean {
    return !this.relief.flat;
  }

  private build() {
    const r = this.relief;
    const { nx, ny, cellM: c } = r;
    const we = this.toE;
    const wn = this.toN;
    // Соседи вдоль ветра и поперёк: гауссовы веса на ±2σ через клетку.
    const K = Math.ceil((2 * ALONG_WIDTH_M) / c);
    const wts = Array.from({ length: K + 1 }, (_, k) => Math.exp(-((k * c) ** 2) / (2 * ALONG_WIDTH_M ** 2)));
    const steps = Math.floor(LEE_RANGE_M / c);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k0 = j * nx + i;
        const hs0 = r.hs[k0]!;
        let sa = hs0;
        let sc = hs0;
        let sw = 1;
        for (let k = 1; k <= K; k++) {
          const w = wts[k]!;
          const dx = we * k;
          const dy = wn * k;
          sa += w * (bil(r.hs, nx, ny, i + dx, j + dy) + bil(r.hs, nx, ny, i - dx, j - dy));
          sc += w * (bil(r.hs, nx, ny, i + dy, j - dx) + bil(r.hs, nx, ny, i - dy, j + dx));
          sw += 2 * w;
        }
        // Превышение над соседями, км: вдоль ветра (гребень, проход) и поперёк (седловина < 0, вершина > 0).
        const up = (hs0 - sa / sw) / 1000;
        const across = (hs0 - sc / sw) / 1000;
        const gap = up > 0 ? Math.min(Math.max(0, -across), 2 * up) : 0;
        const iso = up > 0 ? Math.min(Math.max(0, across), up) : 0;
        this.gapUp[k0] = GAP_PER_KM * gap;
        this.speedUp[k0] = clamp(SPEEDUP_PER_KM * up + GAP_PER_KM * gap - ISO_PER_KM * iso, SPEEDUP_MIN, SPEEDUP_MAX);

        // Тень: против ветра гряда выше точки на H в d от неё; полная тень до LEE_NEAR·H, нет — за LEE_FAR·H.
        const h0 = r.h[k0]!;
        let wA = 0;
        let hA = 0;
        let wB = 0;
        let hB = 0;
        let dB = 0;
        for (let s = 1; s <= steps; s++) {
          const H = bil(r.h, nx, ny, i - we * s, j - wn * s) - h0;
          if (H < LEE_MIN_H) continue;
          const d = s * c;
          const wake = 1 - smoothstep(d / H, LEE_NEAR, LEE_FAR);
          if (wake <= 0) continue;
          if (wake > wA || (wake === wA && H > hA)) {
            wA = wake;
            hA = H;
          }
          if (wake * H > wB * hB) {
            wB = wake;
            hB = H;
            dB = d;
          }
        }
        this.leeWA[k0] = wA;
        this.leeHA[k0] = hA;
        this.leeWB[k0] = wB;
        this.leeHB[k0] = hB;
        this.leeDB[k0] = dB;
      }
    }
  }

  /**
   * Ветер в точке east/north (м от начала) на высоте aglM над землёй в момент t (с): фоновый по
   * погоде с поправками рельефа. Вызывать можно на каждом шаге полёта.
   */
  localWind(east: number, north: number, aglM: number, t: number): LocalWind {
    const s = this.sample(east, north, aglM, t, true);
    return { eastMs: s.eastMs, northMs: s.northMs, upMs: s.upMs, turbulenceScale: s.turbulenceScale, turbulenceAddMs: s.turbulenceAddMs };
  }

  /** То же с разбором по составляющим. spots = false — без случайных пятен термиков (для планирования). */
  windFieldSample(east: number, north: number, aglM: number, t: number, spots = true): WindFieldSample {
    return this.sample(east, north, aglM, t, spots);
  }

  private sunAt(t: number): SunDirection | null {
    if (!this.sun) return null;
    return typeof this.sun === 'function' ? this.sun(t) : this.sun;
  }

  private sample(east: number, north: number, aglM: number, t: number, spots: boolean): WindFieldSample {
    const agl = Math.max(0, aglM);
    const bg = windAt(this.weather, agl);
    // Как windVec в flight.ts — над ровным местом ровно тот же вектор.
    const ve = bg.speedMs * Math.sin((bg.fromDeg + 180) * RAD);
    const vn = bg.speedMs * Math.cos((bg.fromDeg + 180) * RAD);
    const out: WindFieldSample = {
      eastMs: ve,
      northMs: vn,
      upMs: 0,
      turbulenceScale: 1,
      turbulenceAddMs: 0,
      background: bg,
      speedFactor: 1,
      lee: 0,
      ridgeAboveM: 0,
      ridgeDistanceM: 0,
      gap: 0,
      valley: 0,
      valleyAxisDeg: 0,
      slopeFlowMs: 0,
      leeSinkMs: 0,
      thermalMs: 0,
      thermalPotentialMs: 0,
      katabaticMs: 0,
    };
    const r = this.relief;
    if (r.flat) return out;
    const fx = (east - r.e0) / r.cellM;
    const fy = (north - r.n0) / r.cellM;
    const edge = r.edge(fx, fy);
    if (edge <= 0) return out;
    const nx = r.nx;
    const i = Math.min(nx - 2, Math.floor(fx));
    const j = Math.min(r.ny - 2, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const k = j * nx + i;
    const at = (g: Float64Array) => (g[k]! * (1 - u) + g[k + 1]! * u) * (1 - v) + (g[k + nx]! * (1 - u) + g[k + nx + 1]! * u) * v;

    const gx = at(r.gx);
    const gy = at(r.gy);
    const decay = Math.exp(-agl / at(r.dz));

    // Тень гряды: полная до высоты гребня, выше гаснет за полвысоты гряды.
    const depth = (H: number) => (H <= 0 ? 0 : clamp(1 - (agl - H) / (0.5 * H + 30), 0, 1));
    const hA = at(this.leeHA);
    const hB = at(this.leeHB);
    const la = at(this.leeWA) * depth(hA);
    const lb = at(this.leeWB) * depth(hB);
    const lee = Math.max(la, lb) * this.windK;
    // Ротор гонит ветер на высоте гребня той гряды, что дала тень.
    const ridge = lb >= la ? hB : hA;

    // Горизонтальный: форма рельефа и укрытость.
    const sp = at(this.speedUp) * decay;
    const kh = (1 + sp) * (1 - LEE_SHELTER * lee);
    let he = kh * ve;
    let hn = kh * vn;
    // Долина: у дна — вдоль оси, к гребням — обратно к фоновому.
    let beta = 0;
    let axisDeg = 0;
    const vw = at(r.valley);
    if (vw > 0.01) {
      beta = Math.min(VALLEY_MAX, vw) * (1 - smoothstep(agl / at(r.valleyDepth), 0.2, 1));
      const phi = Math.atan2(at(r.axS), at(r.axC)) / 2;
      const ae = Math.cos(phi);
      const an = Math.sin(phi);
      axisDeg = ((((90 - phi / RAD) % 180) + 180) % 180);
      if (beta > 0) {
        const p = (he * ae + hn * an) * (1 + VALLEY_GAIN);
        he += beta * (p * ae - he);
        hn += beta * (p * an - hn);
      }
    }

    // Вертикальный: обтекание склона (в тени поток отрывается — вниз слабее) и нисходящий в тени.
    let slope = (ve * gx + vn * gy) * decay;
    if (slope < 0) slope *= 1 - 0.5 * lee;
    const uc = lee > 0 ? windAt(this.weather, Math.max(agl, ridge)).speedMs : 0;
    const sink = -LEE_SINK * uc * lee;
    let up = slope + sink;
    let scale = 1 + LEE_GAIN * lee;
    const add = ROTOR_TURB * uc * lee;

    // Солнце: днём термики над освещёнными склонами, ночью сток вниз по склону.
    let thermal = 0;
    let potentialMs = 0;
    let kat = 0;
    const sun = this.sunAt(t);
    if (sun) {
      const el = sun.elevationDeg;
      if (el > 3) {
        const sv = sunVector(sun);
        const prof = this.thermalProfile(agl) * this.thermalK;
        const pot = this.potential(gx, gy, sv);
        potentialMs = THERMAL_MS * pot * prof;
        // Над прогретым склоном и пульсации сильнее.
        scale += pot * prof;
        if (spots && prof > 0) thermal = this.thermals(east, north, agl, t, sv) * prof;
        up += thermal;
      }
      const g = Math.hypot(gx, gy);
      const night = clamp((2 - el) / 8, 0, 1) * this.katabaticK;
      if (night > 0 && g > 0.01) {
        const a = agl / KATABATIC_H_M;
        kat = KATABATIC_MS * night * Math.min(1, g / 0.2) * a * Math.exp(1 - a);
        he -= (kat * gx) / g;
        hn -= (kat * gy) / g;
        up -= kat * g;
      }
    }

    out.eastMs = ve + edge * (he - ve);
    out.northMs = vn + edge * (hn - vn);
    out.upMs = edge * up;
    out.turbulenceScale = 1 + edge * (scale - 1);
    out.turbulenceAddMs = edge * add;
    out.speedFactor = bg.speedMs > 1e-6 ? Math.hypot(out.eastMs, out.northMs) / bg.speedMs : 1;
    out.lee = edge * lee;
    out.ridgeAboveM = lee > 0 ? hB : 0;
    out.ridgeDistanceM = lee > 0 ? at(this.leeDB) : 0;
    out.gap = edge * at(this.gapUp) * decay;
    out.valley = edge * beta;
    out.valleyAxisDeg = axisDeg;
    out.slopeFlowMs = edge * slope;
    out.leeSinkMs = edge * sink;
    out.thermalMs = edge * thermal;
    out.thermalPotentialMs = edge * potentialMs;
    out.katabaticMs = edge * kat;
    return out;
  }

  /** Сила термиков по склону 0…1: избыток освещённости cos(i) − sin(h☉) над ровным местом, без облаков. */
  private potential(gx: number, gy: number, sv: readonly [number, number, number]): number {
    const len = Math.hypot(gx, gy, 1);
    const excess = (-gx * sv[0] - gy * sv[1] + sv[2]) / len - sv[2];
    return excess <= 0 ? 0 : Math.min(1, (excess * (1 - this.cloud)) / THERMAL_EXCESS_FULL);
  }

  /** Термики по высоте: от нуля у земли, максимум на ~¼ слоя перемешивания, нуль у его верха. */
  private thermalProfile(agl: number): number {
    const z = agl / this.mixingM;
    if (z <= 0 || z >= 1 / 1.1) return 0;
    return (Math.cbrt(z) * (1 - 1.1 * z)) / 0.458;
  }

  /**
   * Пятна термиков: решётка с шагом THERMAL_SPACING_M сносится ветром; в каждой клетке в свой срок
   * жизни — термик со случайным местом, размером и силой, растущий и гаснущий за THERMAL_LIFE_S.
   * Сила — по склону под его сердцевиной. Вокруг сердцевины — слабое кольцо опускания (масса сходится).
   */
  private thermals(east: number, north: number, agl: number, t: number, sv: readonly [number, number, number]): number {
    const S = THERMAL_SPACING_M;
    const x = east - this.driftE * t;
    const y = north - this.driftN * t;
    const ci = Math.floor(x / S);
    const cj = Math.floor(y / S);
    const rBase = 90 + 0.12 * agl;
    const sd = this.seed;
    let w = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        const life = t / THERMAL_LIFE_S + hash(i, j, 0, sd);
        const k = Math.floor(life);
        if (hash(i, j, k, sd + 1) > THERMAL_CHANCE) continue;
        const px = (i + 0.15 + 0.7 * hash(i, j, k, sd + 2)) * S;
        const py = (j + 0.15 + 0.7 * hash(i, j, k, sd + 3)) * S;
        const rad = rBase * (0.7 + 0.6 * hash(i, j, k, sd + 4));
        const q = ((x - px) ** 2 + (y - py) ** 2) / (rad * rad);
        if (q > 40) continue;
        const ce = px + this.driftE * t;
        const cn = py + this.driftN * t;
        const r = this.relief;
        const edge = r.edge((ce - r.e0) / r.cellM, (cn - r.n0) / r.cellM);
        if (edge <= 0) continue;
        const pot = this.potential(r.at(r.gx, ce, cn), r.at(r.gy, ce, cn), sv) * edge;
        if (pot <= 0) continue;
        const amp = Math.sin(Math.PI * (life - k)) ** 2 * (0.6 + 0.6 * hash(i, j, k, sd + 5));
        // e^(−q) − e^(−q/6)/6: поток через круг нулевой; ×1.2 — пик в сердцевине 1.
        w += THERMAL_MS * pot * amp * 1.2 * (Math.exp(-q) - Math.exp(-q / 6) / 6);
      }
    }
    return w;
  }

  /**
   * Чего ждать у площадки при этом ветре: столб захода (heightsM) над ней и вокруг в radiusM,
   * без случайных пятен термиков. Уровень 0…1 и текст для оператора.
   */
  windHazardAt(east: number, north: number, o: WindHazardOptions = {}): WindHazard {
    const heights = o.heightsM ?? [10, 30, 60, 100, 150];
    const R = o.radiusM ?? 150;
    const t = o.t ?? 0;
    const pts: [number, number][] = [
      [0, 0],
      [R, 0],
      [-R, 0],
      [0, R],
      [0, -R],
    ];
    let sink = 0;
    let lift = 0;
    let scale = 1;
    let add = 0;
    let lee = 0;
    let ridge = 0;
    let ridgeD = 0;
    let thermal = 0;
    let kat = 0;
    for (const [de, dn] of pts) {
      for (const agl of heights) {
        const s = this.sample(east + de, north + dn, agl, t, false);
        sink = Math.max(sink, -s.upMs);
        lift = Math.max(lift, s.upMs);
        scale = Math.max(scale, s.turbulenceScale);
        add = Math.max(add, s.turbulenceAddMs);
        thermal = Math.max(thermal, s.thermalPotentialMs);
        kat = Math.max(kat, s.katabaticMs);
        if (s.lee > lee) {
          lee = s.lee;
          ridge = s.ridgeAboveM;
          ridgeD = s.ridgeDistanceM;
        }
      }
    }
    const low = this.sample(east, north, 10, t, false);
    const bg = low.background;
    const fromDeg = (Math.atan2(-low.eastMs, -low.northMs) / RAD + 360) % 360;
    const turn = bg.speedMs > 0.5 ? ((fromDeg - bg.fromDeg + 540) % 360) - 180 : 0;
    const extraMs = (low.speedFactor - 1) * bg.speedMs;

    const notes: string[] = [];
    if (lee >= 0.2) {
      const where = `подветренная сторона хребта (гребень на ${fmt(ridge, 0)} м выше, ${fmt(ridgeD / 1000)} км против ветра)`;
      notes.push(sink >= 0.3 ? `${where}: нисходящие потоки до ${fmt(sink)} м/с, болтанка` : `${where}: болтанка`);
    } else if (lift >= 0.5) notes.push(`наветренный склон: восходящий поток до ${fmt(lift)} м/с`);
    if (lee < 0.2 && sink >= 0.5) notes.push(`склон по ветру: нисходящий поток до ${fmt(sink)} м/с`);
    if (low.speedFactor >= 1.15) {
      const where = low.gap > 0.1 ? 'седловина' : 'гребень';
      notes.push(`${where}: ветер у земли сильнее в ${fmt(low.speedFactor)} раза — ${fmt(low.speedFactor * bg.speedMs)} м/с`);
    } else if (low.speedFactor <= 0.8 && lee < 0.2) notes.push(`укрытое место: ветер у земли слабее — ${fmt(low.speedFactor * bg.speedMs)} м/с`);
    if (low.valley >= 0.3 && Math.abs(turn) >= 20)
      notes.push(`долина: у земли ветер вдоль долины, с ${fmt(Math.round(fromDeg), 0)}° вместо ${fmt(Math.round(bg.fromDeg), 0)}°`);
    if (thermal >= 1) notes.push(`над склоном под Солнцем термики до ${fmt(thermal)} м/с`);
    if (kat >= 0.5) notes.push(`стекающий по склону ветер до ${fmt(kat)} м/с`);
    if (notes.length === 0) notes.push('местных эффектов рельефа не ожидается');

    const level = clamp(
      Math.max(sink / 4, 0.8 * lee, (scale - 1) / (2 * LEE_GAIN), extraMs / 6, (Math.min(90, Math.abs(turn)) / 90) * 0.4, thermal / 8, kat / 6),
      0,
      1,
    );
    const text = notes.map((n, i) => (i === 0 ? n[0]!.toUpperCase() + n.slice(1) : n)).join('; ');
    return { level, sinkMs: sink, liftMs: lift, turbulenceScale: scale, turbulenceAddMs: add, speedFactor: low.speedFactor, turnDeg: turn, thermalMs: thermal, katabaticMs: kat, text, notes };
  }

  /** То же для точки на карте (площадки). */
  windHazardAtPoint(p: GeoPoint, o: WindHazardOptions = {}): WindHazard {
    const { east, north } = toLocal(this.relief.origin, p);
    return this.windHazardAt(east, north, o);
  }

  /** Поле по области на высоте aglM над землёй — для карты; без случайных пятен термиков. */
  fieldGrid(aglM: number, t = 0, stepM = this.relief.cellM): WindFieldGrid {
    const a = this.relief.area;
    const nx = Math.max(2, Math.floor((a.east1 - a.east0) / stepM) + 1);
    const ny = Math.max(2, Math.floor((a.north1 - a.north0) / stepM) + 1);
    const g: WindFieldGrid = {
      east0: a.east0,
      north0: a.north0,
      stepM,
      nx,
      ny,
      eastMs: new Float32Array(nx * ny),
      northMs: new Float32Array(nx * ny),
      upMs: new Float32Array(nx * ny),
      turbulenceScale: new Float32Array(nx * ny),
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const s = this.sample(a.east0 + i * stepM, a.north0 + j * stepM, aglM, t, false);
        const k = j * nx + i;
        g.eastMs[k] = s.eastMs;
        g.northMs[k] = s.northMs;
        g.upMs[k] = s.upMs;
        g.turbulenceScale[k] = s.turbulenceScale;
      }
    }
    return g;
  }
}

/** Направление на Солнце: восток, север, вверх. */
function sunVector(sun: SunDirection): readonly [number, number, number] {
  const el = sun.elevationDeg * RAD;
  const az = sun.azimuthDeg * RAD;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

/** Рельеф области и поправки для погоды разом, синхронно. Для интерфейса — TerrainRelief.buildAsync. */
export function terrainWind(terrain: Terrain, origin: Site, weather: Weather, o: ReliefOptions & TerrainWindOptions = {}): TerrainWind {
  return new TerrainWind(TerrainRelief.build(terrain, origin, o), weather, o);
}
