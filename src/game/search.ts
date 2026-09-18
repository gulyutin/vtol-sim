import { fromLocal, toLocal } from '../sim/mission';
import type { RoutePoint } from '../sim/profile';
import type { GeoPoint, Terrain } from '../sim/types';
import type { DifficultyId, SearchOutcome } from './scoring';

/*
 * Поиск людей тепловизором (LWIR). Оператор ведёт аппарат над тайгой галсами и ищет пропавших по
 * тепловому следу; медведи, волки, лоси и олени тоже тёплые — это ложные цели. Здесь без DOM:
 * камера и её поле зрения, расстановка людей и зверей по сложности и по району, их движение,
 * обнаружимость по критериям Джонсона, отметки оператора, галсы поиска и покрытие района.
 * Координаты — локальные метры от площадки, как у полёта: восток, север.
 */

const RAD = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
/** Разность курсов b − a, приведённая к −180…180°. */
const angleDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;
const norm360 = (a: number) => ((a % 360) + 360) % 360;

export interface LocalPoint {
  east: number;
  north: number;
}

/* --------------------------------- Камера --------------------------------- */

export interface ThermalCamera {
  id: string;
  name: string;
  /** Матрица: поперёк полёта и вдоль, пикселей. */
  widthPx: number;
  heightPx: number;
  pixelPitchUm: number;
  focalLengthMm: number;
  massKg: number;
  powerW: number;
  /** Чувствительность NETD, мК — для пояснений; в модели порог контраста — CONTRAST_HALF_K. */
  netdMk: number;
  /** Наклон подвеса по умолчанию: угол оси ниже горизонта, ° (90 — отвесно вниз, 45 — вперёд-вниз). */
  tiltDeg: number;
}

/** Наклон «прямо вниз». */
export const NADIR_TILT_DEG = 90;

/**
 * Типовой неохлаждаемый тепловизор 640 × 512, шаг 12 мкм, объектив 13 мм: поле зрения
 * 32,9° × 26,6°, пиксель 0,92 мрад — 9 см со 100 м. Около 0,2 кг и 3 Вт с подвесом.
 */
export const THERMAL_CAMERA: ThermalCamera = {
  id: 'lwir640',
  name: 'Тепловизор LWIR 640 × 512, 13 мм',
  widthPx: 640,
  heightPx: 512,
  pixelPitchUm: 12,
  focalLengthMm: 13,
  massKg: 0.2,
  powerW: 3,
  netdMk: 50,
  tiltDeg: 45,
};

/** Мгновенное поле зрения пикселя IFOV = шаг / f, рад: 12 мкм / 13 мм = 0,92 мрад. */
export const ifovRad = (cam: ThermalCamera): number => (cam.pixelPitchUm * 1e-6) / (cam.focalLengthMm * 1e-3);

/** Поле зрения, °: 2·atan(N·шаг / 2f) — 32,9° поперёк (640 пикселей) и 26,6° вдоль (512). */
export function fovDeg(cam: ThermalCamera): { acrossDeg: number; alongDeg: number } {
  const full = (px: number) => (2 * Math.atan((px * cam.pixelPitchUm * 1e-6) / (2 * cam.focalLengthMm * 1e-3))) / RAD;
  return { acrossDeg: full(cam.widthPx), alongDeg: full(cam.heightPx) };
}

/** Где камера: подвес гасит крен и тангаж и смотрит по курсу с наклоном tiltDeg. */
export interface CameraPose {
  east: number;
  north: number;
  /** Высота над землёй под бортом, м. */
  aglM: number;
  /** Курс борта, °. */
  headingDeg: number;
  /** Наклон оси ниже горизонта, °; нет — по камере. */
  tiltDeg?: number;
  /** Высота борта над морем, м: с рельефом мира высота над каждой целью точнее, чем aglM. */
  altitudeM?: number;
}

export interface ImagePoint {
  /** Точка в кадре. */
  inView: boolean;
  /** Положение в кадре −1…1: x — вправо, y — вверх (к горизонту). Вне кадра — за пределами. */
  x: number;
  y: number;
  /** Наклонная дальность, м. */
  slantM: number;
  /** Угол линии визирования от вертикали у цели, °: 0 — прямо сверху. */
  zenithDeg: number;
}

/**
 * Точка на земле в кадре. Ось камеры в осях борта (вперёд, вправо, вниз) — (cos t, 0, sin t),
 * «вверх» кадра — (sin t, 0, −cos t); heightAboveM — высота борта над точкой.
 */
export function projectToImage(pose: CameraPose, cam: ThermalCamera, p: LocalPoint, heightAboveM = pose.aglM): ImagePoint {
  const h = pose.headingDeg * RAD;
  const de = p.east - pose.east;
  const dn = p.north - pose.north;
  const f = de * Math.sin(h) + dn * Math.cos(h);
  const r = de * Math.cos(h) - dn * Math.sin(h);
  const d = heightAboveM;
  const t = (pose.tiltDeg ?? cam.tiltDeg) * RAD;
  const along = f * Math.cos(t) + d * Math.sin(t);
  const up = f * Math.sin(t) - d * Math.cos(t);
  const slantM = Math.hypot(f, r, d);
  const zenithDeg = Math.acos(clamp(d / Math.max(slantM, 1e-9), -1, 1)) / RAD;
  if (along <= 1e-6) return { inView: false, x: NaN, y: NaN, slantM, zenithDeg };
  const { acrossDeg, alongDeg } = fovDeg(cam);
  const x = r / along / Math.tan((acrossDeg / 2) * RAD);
  const y = up / along / Math.tan((alongDeg / 2) * RAD);
  return { inView: Math.abs(x) <= 1 && Math.abs(y) <= 1, x, y, slantM, zenithDeg };
}

/* ------------------------------ Обнаружимость ------------------------------ */

export type AnimalKind = 'bear' | 'wolf' | 'moose' | 'deer';
export type BodyKind = 'person' | AnimalKind;
export type BodyPose = 'standing' | 'sitting' | 'lying' | 'walking';
export type SightLevel = 'none' | 'detect' | 'recognise' | 'identify';

export const ANIMAL_KINDS: readonly AnimalKind[] = ['bear', 'wolf', 'moose', 'deer'];

export const BODY_NAMES: Record<BodyKind, string> = { person: 'человек', bear: 'медведь', wolf: 'волк', moose: 'лось', deer: 'олень' };

/**
 * Критерии Джонсона: циклов (пар пикселей) на критический размер цели для вероятности 50 %.
 * Обнаружить — «что-то тёплое» (1 цикл = 2 пикселя), распознать — человек или зверь (4 цикла),
 * опознать — какой зверь, в какой позе человек (6,4 цикла).
 */
export const JOHNSON_N50 = { detect: 1, recognise: 4, identify: 6.4 } as const;

/**
 * Вероятность по числу циклов (функция TTPF): P = (N/N50)^E / (1 + (N/N50)^E), E = 2,7 + 0,7·N/N50.
 * Ровно N50 циклов — 50 %, вдвое больше — 94 %, вдвое меньше — 11 %.
 */
export function johnsonP(cycles: number, n50: number): number {
  if (!(cycles > 0)) return 0;
  const k = cycles / n50;
  if (k > 20) return 1;
  const x = k ** (2.7 + 0.7 * k);
  return x / (1 + x);
}

/**
 * Площадь тела сверху и сбоку, м². Критический размер — √(S_верх·cos z + S_бок·sin z) по углу
 * визирования z от вертикали: стоящий человек сверху — 0,39 м (голова и плечи), под 45° — 0,85 м;
 * лежащий — 0,94 м; волк 0,65 м сверху; лось 1,6 м. Лежащий зверь сбоку вдвое ниже.
 */
const PERSON_SHAPE: Record<BodyPose, { top: number; side: number }> = {
  lying: { top: 0.875, side: 0.5 },
  sitting: { top: 0.3, side: 0.45 },
  standing: { top: 0.15, side: 0.875 },
  walking: { top: 0.15, side: 0.875 },
};
const ANIMAL_SHAPE: Record<AnimalKind, { top: number; side: number }> = {
  wolf: { top: 0.42, side: 0.6 },
  bear: { top: 1.7, side: 1.9 },
  moose: { top: 2.5, side: 3.4 },
  deer: { top: 0.72, side: 1.0 },
};

export function criticalSizeM(kind: BodyKind, pose: BodyPose = 'standing', zenithDeg = 0): number {
  const s = kind === 'person' ? PERSON_SHAPE[pose] : ANIMAL_SHAPE[kind];
  const side = kind !== 'person' && pose === 'lying' ? s.side / 2 : s.side;
  const z = clamp(zenithDeg, 0, 90) * RAD;
  return Math.sqrt(s.top * Math.cos(z) + side * Math.sin(z));
}

/** Типичный критический размер человека с воздуха, м: стоящий под 45° — 0,85, лежащий — 0,94. */
export const PERSON_SIZE_M = 0.8;

/**
 * Дальность, на которой критический размер sizeM даёт N50 циклов уровня level — вероятность 50 %
 * без полога и при хорошем контрасте: R = size / (2·N50·IFOV). Человек (0,8 м) штатной камерой:
 * обнаружить — 430 м, распознать — 110 м, опознать — 68 м.
 */
export function detectionRangeM(cam: ThermalCamera, sizeM = PERSON_SIZE_M, level: Exclude<SightLevel, 'none'> = 'detect'): number {
  return sizeM / (2 * JOHNSON_N50[level] * ifovRad(cam));
}

export interface ThermalEnv {
  /** Температура воздуха у земли, °C. */
  airTemperatureC: number;
  /** Высота Солнца, °. */
  sunElevationDeg: number;
  /** Облачность 0…1; нет — 0,3. */
  cloudCover?: number;
}

/**
 * Поверхность тела теплее воздуха на долю от (37 − T_воздуха): одежда и мех держат тепло внутри.
 * Одетый человек — 0,35 (при +10 °C поверхность на 9 K теплее воздуха), густой мех медведя — 0,2.
 */
const INSULATION: Record<BodyKind, number> = { person: 0.35, wolf: 0.25, bear: 0.2, moose: 0.3, deer: 0.3 };
/** Солнце прогревает землю и кроны сверх воздуха до 14 K при Солнце в зените и ясном небе. */
const SUN_HEAT_K = 14;
/** Ясной ночью фон выхолаживается ниже воздуха на 3 K. */
const NIGHT_COOL_K = 3;
/** Контраст, при котором камера теряет половину различимых циклов, K. */
export const CONTRAST_HALF_K = 1.5;

/**
 * Тепловой контраст тела и фона, K (знак: тело теплее фона — плюс). Фон: воздух + прогрев Солнцем
 * S = 14 K · sin(h☉) · (1 − 0,8·облачность), ночью — выхолаживание до −3 K. Тело само прогревается
 * на половину S. Человек при +10 °C ночью — +12 K, в пасмурный день +12 °C — +8 K, в жаркий
 * солнечный день +25 °C при Солнце на 50° — всего −1 K: прогретая земля почти как одежда.
 */
export function thermalContrastK(kind: BodyKind, env: ThermalEnv): number {
  const cloud = clamp01(env.cloudCover ?? 0.3);
  const sun = SUN_HEAT_K * Math.sin(Math.max(0, env.sunElevationDeg) * RAD) * (1 - 0.8 * cloud);
  const night = NIGHT_COOL_K * (1 - cloud) * clamp01(-env.sunElevationDeg / 6);
  const body = INSULATION[kind] * (37 - env.airTemperatureC) + 0.5 * sun;
  return body - (sun - night);
}

/** Доля различимых циклов при контрасте ΔT: |ΔT| / (|ΔT| + 1,5 K) — 12 K → 0,89, 4 K → 0,73, 1 K → 0,4. */
export const contrastFactor = (contrastK: number): number => Math.abs(contrastK) / (Math.abs(contrastK) + CONTRAST_HALF_K);

/**
 * Просвет полога по линии взгляда: (1 − c)^(1/cos z) — закон Бугера для кроны сомкнутостью c.
 * Густой лес (0,8) сверху — 20 % просвета, под 45° — 10 %: в густом лесу лучше смотреть отвесно вниз.
 */
export function canopyGap(canopy: number, zenithDeg: number): number {
  return (1 - clamp01(canopy)) ** (1 / Math.max(0.1, Math.cos(zenithDeg * RAD)));
}

export interface DetectTarget extends LocalPoint {
  kind: BodyKind;
  /** Сомкнутость полога над целью 0…1. */
  canopy: number;
  pose?: BodyPose;
}

export interface Detectability extends ImagePoint {
  /** Критический размер по линии взгляда, м. */
  sizeM: number;
  /** Пикселей на критический размер и циклов (пар пикселей) — до поправки на контраст. */
  pixels: number;
  cycles: number;
  contrastK: number;
  contrastFactor: number;
  canopyGap: number;
  /** Вероятности обнаружить, распознать (человек или зверь), опознать (вид, поза); вне кадра — 0. */
  pDetect: number;
  pRecognise: number;
  pIdentify: number;
  /** Высший уровень с вероятностью от 50 %. */
  level: SightLevel;
}

/**
 * Обнаружимость цели. Циклы N = размер / (2 · дальность · IFOV) · доля по контрасту; вероятность
 * уровня — johnsonP(N, N50) · просвет полога. Лежащий человек со 100 м отвесно вниз на открытом месте
 * ночью: пиксель 9 см, 10 пикселей = 5 циклов, с контрастом 4,5 — обнаружить ~100 %, распознать
 * 60 %, опознать 24 %. Тот же человек в жаркий полдень — 2,4 цикла: распознать 15 %.
 */
export function detectability(target: DetectTarget, pose: CameraPose, cam: ThermalCamera, env: ThermalEnv, heightAboveM = pose.aglM): Detectability {
  const v = projectToImage(pose, cam, target, heightAboveM);
  const sizeM = criticalSizeM(target.kind, target.pose ?? 'standing', v.zenithDeg);
  const pixels = sizeM / Math.max(v.slantM * ifovRad(cam), 1e-6);
  const cycles = pixels / 2;
  const contrastK = thermalContrastK(target.kind, env);
  const kc = contrastFactor(contrastK);
  const gap = canopyGap(target.canopy, v.zenithDeg);
  const n = cycles * kc;
  const vis = v.inView ? gap : 0;
  const pDetect = vis * johnsonP(n, JOHNSON_N50.detect);
  const pRecognise = vis * johnsonP(n, JOHNSON_N50.recognise);
  const pIdentify = vis * johnsonP(n, JOHNSON_N50.identify);
  const level: SightLevel = pIdentify >= 0.5 ? 'identify' : pRecognise >= 0.5 ? 'recognise' : pDetect >= 0.5 ? 'detect' : 'none';
  return { ...v, sizeM, pixels, cycles, contrastK, contrastFactor: kc, canopyGap: gap, pDetect, pRecognise, pIdentify, level };
}

/* ------------------------------ Кадр на земле ------------------------------ */

/** Граница кадра: углы и середины сторон, y = −1 — ближний край. */
const BORDER: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/**
 * Кадр тепловизора на ровной земле, локальные метры: лучи границы кадра до земли. Дальше
 * maxRangeM (по умолчанию — дальность обнаружения человека) кадр обрезается: там человека
 * всё равно не видно, а наклонный кадр у горизонта уходит в бесконечность.
 */
export function footprint(pose: CameraPose, cam: ThermalCamera, maxRangeM = detectionRangeM(cam)): LocalPoint[] {
  const agl = pose.aglM;
  if (!(agl > 0) || maxRangeM <= agl) return [];
  const t = (pose.tiltDeg ?? cam.tiltDeg) * RAD;
  const { acrossDeg, alongDeg } = fovDeg(cam);
  const tx = Math.tan((acrossDeg / 2) * RAD);
  const ty = Math.tan((alongDeg / 2) * RAD);
  const reach = Math.sqrt(maxRangeM ** 2 - agl ** 2);
  const sh = Math.sin(pose.headingDeg * RAD);
  const ch = Math.cos(pose.headingDeg * RAD);
  return BORDER.map(([x, y]) => {
    const fwd = Math.cos(t) + y * ty * Math.sin(t);
    const right = x * tx;
    const down = Math.sin(t) - y * ty * Math.cos(t);
    const len = Math.hypot(fwd, right);
    const s = down > 1e-9 ? agl / down : Infinity;
    const k = s * len > reach ? reach / len : s;
    const f = fwd * k;
    const r = right * k;
    return { east: pose.east + f * sh + r * ch, north: pose.north + f * ch - r * sh };
  });
}

export interface Swath {
  /** Ширина полосы по центру кадра, м. */
  swathM: number;
  /** Сколько впереди борта ближний край, центр и дальний край кадра, м (минус — позади). */
  aheadNearM: number;
  aheadCenterM: number;
  aheadFarM: number;
}

/**
 * Полоса обзора на высоте heightAglM: ширина кадра поперёк полёта там, где ось камеры встречает
 * землю, — 2 · (h / sin t) · tg(½ поля). Со 100 м отвесно вниз — 59 м, под 45° — 84 м; центр кадра
 * под 45° — на 100 м впереди борта, ближний край — на 62 м.
 */
export function swathOf(cam: ThermalCamera, heightAglM: number, tiltDeg = cam.tiltDeg, maxRangeM = detectionRangeM(cam)): Swath {
  const t = clamp(tiltDeg, 1, 90) * RAD;
  const { acrossDeg, alongDeg } = fovDeg(cam);
  const half = (alongDeg / 2) * RAD;
  const reach = Math.sqrt(Math.max(0, maxRangeM ** 2 - heightAglM ** 2));
  const ahead = (a: number) => (a <= 1e-6 ? Infinity : (heightAglM * Math.cos(a)) / Math.sin(a));
  const slantC = Math.min(heightAglM / Math.sin(t), maxRangeM);
  return {
    swathM: 2 * slantC * Math.tan((acrossDeg / 2) * RAD),
    aheadNearM: Math.min(ahead(t + half), reach),
    aheadCenterM: Math.min(ahead(t), reach),
    aheadFarM: Math.min(ahead(t - half), reach),
  };
}

/* ------------------------------ Многоугольник ------------------------------ */

export function insidePolygon(e: number, n: number, poly: readonly LocalPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.north > n !== b.north > n && e < ((b.east - a.east) * (n - a.north)) / (b.north - a.north) + a.east) inside = !inside;
  }
  return inside;
}

/** На сколько точка за границей многоугольника, м; внутри — 0. */
export function distanceOutside(p: LocalPoint, poly: readonly LocalPoint[]): number {
  if (poly.length < 3 || insidePolygon(p.east, p.north, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    const de = b.east - a.east;
    const dn = b.north - a.north;
    const l2 = de * de + dn * dn;
    const k = l2 > 0 ? clamp01(((p.east - a.east) * de + (p.north - a.north) * dn) / l2) : 0;
    best = Math.min(best, Math.hypot(p.east - (a.east + k * de), p.north - (a.north + k * dn)));
  }
  return best;
}

export const centroid = (poly: readonly LocalPoint[]): LocalPoint => ({
  east: poly.reduce((s, p) => s + p.east, 0) / poly.length,
  north: poly.reduce((s, p) => s + p.north, 0) / poly.length,
});

/* -------------------------------- Покрытие -------------------------------- */

/**
 * Какая доля района побывала в кадре тепловизора: клетки cellM (центр клетки внутри кадра,
 * кадр обрезан дальностью обнаружения человека). Не больше миллиона клеток — на огромном
 * районе клетка крупнее.
 */
export class CoverageGrid {
  readonly cellM: number;
  readonly e0: number;
  readonly n0: number;
  readonly cols: number;
  readonly rows: number;
  /** 1 — клетка внутри района. */
  readonly inside: Uint8Array;
  /** 1 — клетка побывала в кадре. */
  readonly seen: Uint8Array;
  readonly insideCells: number;
  private seenInside = 0;

  constructor(area: readonly LocalPoint[], cellM = 10) {
    const es = area.map((p) => p.east);
    const ns = area.map((p) => p.north);
    this.e0 = Math.min(...es);
    this.n0 = Math.min(...ns);
    const w = Math.max(...es) - this.e0;
    const h = Math.max(...ns) - this.n0;
    this.cellM = Math.max(cellM, Math.sqrt((w * h) / 1e6));
    this.cols = Math.max(1, Math.ceil(w / this.cellM));
    this.rows = Math.max(1, Math.ceil(h / this.cellM));
    this.inside = new Uint8Array(this.cols * this.rows);
    this.seen = new Uint8Array(this.cols * this.rows);
    let n = 0;
    for (let j = 0; j < this.rows; j++)
      for (let i = 0; i < this.cols; i++)
        if (insidePolygon(this.e0 + (i + 0.5) * this.cellM, this.n0 + (j + 0.5) * this.cellM, area)) {
          this.inside[j * this.cols + i] = 1;
          n++;
        }
    this.insideCells = n;
  }

  /** Отметить клетки внутри многоугольника (кадра); возвращает, сколько клеток района добавилось. */
  addPolygon(poly: readonly LocalPoint[]): number {
    if (poly.length < 3) return 0;
    const c = this.cellM;
    const i0 = Math.max(0, Math.floor((Math.min(...poly.map((p) => p.east)) - this.e0) / c));
    const i1 = Math.min(this.cols - 1, Math.floor((Math.max(...poly.map((p) => p.east)) - this.e0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(...poly.map((p) => p.north)) - this.n0) / c));
    const j1 = Math.min(this.rows - 1, Math.floor((Math.max(...poly.map((p) => p.north)) - this.n0) / c));
    let added = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * this.cols + i;
        if (!this.inside[k] || this.seen[k]) continue;
        if (insidePolygon(this.e0 + (i + 0.5) * c, this.n0 + (j + 0.5) * c, poly)) {
          this.seen[k] = 1;
          added++;
        }
      }
    this.seenInside += added;
    return added;
  }

  /** Кадр камеры в этом положении. */
  add(pose: CameraPose, cam: ThermalCamera = THERMAL_CAMERA, maxRangeM?: number): number {
    return this.addPolygon(footprint(pose, cam, maxRangeM));
  }

  /** Доля района в кадре 0…1. */
  get fraction(): number {
    return this.insideCells ? this.seenInside / this.insideCells : 0;
  }
}

/** Покрытие района кадрами вдоль пролетённого пути (положения камеры по порядку). */
export function coverageOfTrack(area: readonly LocalPoint[], track: readonly CameraPose[], cam: ThermalCamera = THERMAL_CAMERA, cellM = 10): number {
  const g = new CoverageGrid(area, cellM);
  for (const p of track) g.add(p, cam);
  return g.fraction;
}

/* ------------------------------ Галсы поиска ------------------------------ */

export interface SearchPatternOptions {
  /** Высота поиска над рельефом, м. */
  heightAglM: number;
  camera?: ThermalCamera;
  /** Наклон подвеса, °; нет — по камере. */
  tiltDeg?: number;
  /** Перекрытие соседних полос 0…1; по умолчанию 0,2. */
  overlap?: number;
  /** Направление галсов, ° от севера; нет — вдоль длинной стороны района (меньше галсов). */
  directionDeg?: number;
  /** Радиус разворота, м: галсы ближе двух радиусов идут «ипподромом» (через несколько). */
  turnRadiusM?: number;
  /** Запас прямой перед входом в район, м. */
  leadInM?: number;
}

export interface SearchPattern {
  /** Точки маршрута: начало и конец каждого галса по порядку облёта. */
  route: RoutePoint[];
  directionDeg: number;
  swathM: number;
  spacingM: number;
  lineCount: number;
  linesLengthM: number;
  /** Сколько впереди борта ближний край кадра, м: на столько галсы сдвинуты назад. */
  aheadM: number;
}

/**
 * Галсы «змейкой» над районом. Расстояние между галсами — полоса обзора · (1 − перекрытие):
 * со 100 м под 45° — 84 м · 0,8 = 67 м, то есть 15 км галсов на квадратный километр. Камера
 * смотрит вперёд, поэтому галс начинается раньше границы на ближний край кадра (+ leadInM) и
 * кончается на столько же раньше выхода: дальняя часть кадра уже прошла границу. Если галсы ближе
 * двух радиусов разворота — порядок «ипподромом», как у АФС (src/sim/survey.ts): разворот —
 * полуокружность через несколько галсов, а не петля.
 */
export function searchPattern(area: readonly GeoPoint[], origin: GeoPoint, o: SearchPatternOptions): SearchPattern {
  const cam = o.camera ?? THERMAL_CAMERA;
  const sw = swathOf(cam, o.heightAglM, o.tiltDeg ?? cam.tiltDeg);
  const spacingM = sw.swathM * (1 - clamp(o.overlap ?? 0.2, 0, 0.9));
  const leadIn = o.leadInM ?? 30;
  const R = o.turnRadiusM ?? 0;
  const poly = area.map((g) => toLocal(origin, g));
  const frame = (deg: number) => {
    const th = deg * RAD;
    const u = { e: Math.sin(th), n: Math.cos(th) };
    const v = { e: Math.cos(th), n: -Math.sin(th) };
    return { u, v, pts: poly.map((p) => ({ s: p.east * u.e + p.north * u.n, w: p.east * v.e + p.north * v.n })) };
  };
  const width = (deg: number) => {
    const ws = frame(deg).pts.map((q) => q.w);
    return Math.max(...ws) - Math.min(...ws);
  };
  let directionDeg = o.directionDeg;
  if (directionDeg === undefined) {
    directionDeg = 0;
    for (let d = 5; d < 180; d += 5) if (width(d) < width(directionDeg) - 1e-6) directionDeg = d;
  }
  const { u, v, pts } = frame(directionDeg);
  const ws = pts.map((q) => q.w);
  const wMin = Math.min(...ws);
  const wMax = Math.max(...ws);
  const count = Math.max(1, Math.ceil((wMax - wMin) / spacingM));
  const mid = (wMin + wMax) / 2;

  const bands: { w: number; sMin: number; sMax: number }[] = [];
  for (let k = 0; k < count; k++) {
    const w = wMax - wMin > 1 ? clamp(mid + spacingM * (k - (count - 1) / 2), wMin + 0.5, wMax - 0.5) : mid;
    const cross: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if ((a.w - w) * (b.w - w) <= 0 && a.w !== b.w) cross.push(a.s + ((w - a.w) / (b.w - a.w)) * (b.s - a.s));
    }
    if (cross.length >= 2) bands.push({ w, sMin: Math.min(...cross), sMax: Math.max(...cross) });
  }
  if (!bands.length) throw new Error('Галсы не пересекают район поиска');

  const at = (s: number, w: number) => ({ east: s * u.e + w * v.e, north: s * u.n + w * v.n });
  const order = (list: typeof bands) => {
    const out: { band: (typeof bands)[number]; dir: 1 | -1 }[] = [];
    const minK = Math.ceil((2 * R) / spacingM) + 1;
    if (!(R > 0 && spacingM < 2 * R)) {
      list.forEach((band, k) => out.push({ band, dir: k % 2 === 0 ? 1 : -1 }));
      return out;
    }
    const blocks = Math.max(1, Math.floor(list.length / (2 * minK)));
    let first = 0;
    for (let block = 0; block < blocks; block++) {
      const size = Math.round((list.length - first) / (blocks - block));
      const k = Math.ceil(size / 2);
      for (let i = 0; i < k; i++) {
        out.push({ band: list[first + i]!, dir: 1 });
        if (k + i < size) out.push({ band: list[first + k + i]!, dir: -1 });
      }
      first += size;
    }
    return out;
  };
  /** Галс: вход и выход по направлению, сдвинутые назад на ближний край кадра. */
  const line = ({ band, dir }: { band: (typeof bands)[number]; dir: 1 | -1 }) => {
    const entry = dir > 0 ? band.sMin : band.sMax;
    const exit = dir > 0 ? band.sMax : band.sMin;
    return { a: at(entry - dir * (sw.aheadNearM + leadIn), band.w), b: at(exit - dir * sw.aheadNearM, band.w) };
  };
  // Четыре варианта (с какого края района и в какую сторону) — начинаем с ближнего к площадке.
  let best: ReturnType<typeof line>[] = [];
  let bestD = Infinity;
  for (const list of [bands, [...bands].reverse()])
    for (const flip of [1, -1] as const) {
      const lines = order(list).map((x) => line({ band: x.band, dir: (x.dir * flip) as 1 | -1 }));
      const d = Math.hypot(lines[0]!.a.east, lines[0]!.a.north);
      if (d < bestD - 1e-6) [best, bestD] = [lines, d];
    }

  const route: RoutePoint[] = best.flatMap(({ a, b }) => [a, b].map((q) => ({ ...fromLocal(origin, q.east, q.north), heightAglM: o.heightAglM })));
  return {
    route,
    directionDeg,
    swathM: sw.swathM,
    spacingM,
    lineCount: best.length,
    linesLengthM: best.reduce((s, { a, b }) => s + Math.hypot(b.east - a.east, b.north - a.north), 0),
    aheadM: sw.aheadNearM,
  };
}

/* --------------------------- Люди и звери: расстановка --------------------------- */

export type AnimalWeights = Partial<Record<AnimalKind, number>>;
export type CanopyClass = 'open' | 'sparse' | 'dense';

/** Обычная тайга, веса групп: лоси и олени чаще, медведи и волчьи стаи реже. */
export const DEFAULT_ANIMALS: Readonly<Record<AnimalKind, number>> = { bear: 1.5, wolf: 1.5, moose: 3, deer: 3 };

export interface SearchDifficulty {
  /** Сколько людей и зверей (особей), от и до. */
  people: [number, number];
  animals: [number, number];
  /** Доли открытого места, редколесья и густого леса над телами. */
  canopy: Record<CanopyClass, number>;
  /** Доля людей, которые бредут; остальные травмированы — лежат или сидят. */
  walking: number;
}

/** Чем сложнее — тем больше людей и зверей, гуще лес и больше бредущих. */
export const SEARCH_DIFFICULTY: Readonly<Record<DifficultyId, SearchDifficulty>> = {
  train: { people: [1, 1], animals: [2, 4], canopy: { open: 0.6, sparse: 0.4, dense: 0 }, walking: 0 },
  normal: { people: [2, 2], animals: [5, 8], canopy: { open: 0.4, sparse: 0.45, dense: 0.15 }, walking: 0.25 },
  hard: { people: [2, 3], animals: [9, 13], canopy: { open: 0.2, sparse: 0.45, dense: 0.35 }, walking: 0.35 },
  exam: { people: [3, 3], animals: [12, 16], canopy: { open: 0.1, sparse: 0.4, dense: 0.5 }, walking: 0.4 },
};

/** Сомкнутость полога по классу: поляна и болото, редколесье, густой ельник. */
const CANOPY_RANGE: Record<CanopyClass, [number, number]> = { open: [0, 0.15], sparse: [0.3, 0.55], dense: [0.65, 0.9] };
export const canopyClassOf = (c: number): CanopyClass => (c < 0.25 ? 'open' : c < 0.6 ? 'sparse' : 'dense');

/** Волки — стаей 3–6, медведь — один, лоси — 1–3, олени — 2–5 (последняя группа может быть меньше). */
export const GROUP_SIZE: Readonly<Record<AnimalKind, [number, number]>> = { wolf: [3, 6], bear: [1, 1], moose: [1, 3], deer: [2, 5] };

/** Виды района с весами больше нуля; без animals — обычная тайга. */
export function animalWeights(animals?: AnimalWeights): [AnimalKind, number][] {
  const src = animals ?? DEFAULT_ANIMALS;
  return ANIMAL_KINDS.map((k) => [k, src[k] ?? 0] as [AnimalKind, number]).filter(([, w]) => Number.isFinite(w) && w > 0);
}

export interface SearchBody {
  id: string;
  kind: BodyKind;
  /** Номер группы: стая, лоси вместе; у человека и медведя — своя. */
  group: number;
  east: number;
  north: number;
  headingDeg: number;
  speedMs: number;
  pose: BodyPose;
  /** Фаза шага 0…1 (доля цикла). */
  phase: number;
  /** Сомкнутость полога над телом 0…1 и её класс. */
  canopy: number;
  canopyClass: CanopyClass;
  /** Двигается: все звери и бредущие люди; травмированный человек лежит или сидит на месте. */
  mobile: boolean;
  /** Человек найден — отмечен оператором. */
  found: boolean;
}

/** Тепловое тело для сцены (src/ui/heat.ts, World.setHeatBodies). */
export interface HeatBody {
  id: string;
  kind: BodyKind;
  east: number;
  north: number;
  headingDeg: number;
  pose?: BodyPose;
  phase?: number;
}

export const toHeatBody = (b: SearchBody): HeatBody => ({ id: b.id, kind: b.kind, east: b.east, north: b.north, headingDeg: b.headingDeg, pose: b.pose, phase: b.phase });

type Mode = 'rest' | 'graze' | 'walk' | 'trot';

interface ModeSpec {
  speedMs: number;
  durS: [number, number];
  /** Блуждание курса, °/√с. */
  wanderDeg: number;
  next: Partial<Record<Mode, number>>;
}

/**
 * Поведение: режимы, скорость, сколько длятся и что потом. Волки лежат 2–8 мин, идут шагом
 * 1,4 м/с, срываются на рысь 3,2 м/с на 15–60 с. Медведь бродит 0,25–0,8 м/с с долгим отдыхом.
 * Лоси и олени пасутся (0,1–0,15 м/с) и изредка переходят шагом. Бредущий человек — 0,5 м/с
 * по нескольку минут, потом садится отдохнуть.
 */
const BEHAVIOUR: Record<BodyKind, Partial<Record<Mode, ModeSpec>>> = {
  wolf: {
    rest: { speedMs: 0, durS: [120, 480], wanderDeg: 0, next: { walk: 1 } },
    walk: { speedMs: 1.4, durS: [60, 240], wanderDeg: 6, next: { trot: 0.4, walk: 0.3, rest: 0.3 } },
    trot: { speedMs: 3.2, durS: [15, 60], wanderDeg: 3, next: { walk: 1 } },
  },
  bear: {
    graze: { speedMs: 0.25, durS: [60, 300], wanderDeg: 15, next: { walk: 0.6, graze: 0.25, rest: 0.15 } },
    walk: { speedMs: 0.8, durS: [30, 180], wanderDeg: 8, next: { graze: 1 } },
    rest: { speedMs: 0, durS: [300, 900], wanderDeg: 0, next: { graze: 1 } },
  },
  moose: {
    graze: { speedMs: 0.1, durS: [120, 600], wanderDeg: 15, next: { walk: 0.3, graze: 0.5, rest: 0.2 } },
    walk: { speedMs: 1.1, durS: [20, 90], wanderDeg: 6, next: { graze: 1 } },
    rest: { speedMs: 0, durS: [300, 1200], wanderDeg: 0, next: { graze: 1 } },
  },
  deer: {
    graze: { speedMs: 0.15, durS: [60, 300], wanderDeg: 15, next: { walk: 0.4, graze: 0.45, rest: 0.15 } },
    walk: { speedMs: 1.3, durS: [15, 60], wanderDeg: 8, next: { graze: 1 } },
    rest: { speedMs: 0, durS: [200, 800], wanderDeg: 0, next: { graze: 1 } },
  },
  person: {
    walk: { speedMs: 0.5, durS: [120, 600], wanderDeg: 10, next: { rest: 0.4, walk: 0.6 } },
    rest: { speedMs: 0, durS: [60, 300], wanderDeg: 0, next: { walk: 1 } },
  },
};

/** Длина шага (цикла походки), м — для фазы. */
const STRIDE_M: Record<BodyKind, number> = { person: 1.4, wolf: 1.5, bear: 1.6, moose: 2.4, deer: 1.6 };
/** Мягкая граница: за районом группу разворачивает к центру, дальше этого — сразу. */
const BOUNDARY_SOFT_M = 60;
/** Группы при расстановке — не ближе, м: отметка не должна задевать соседнюю группу. */
const GROUP_SPACING_M = 80;
/** Наибольший шаг модели движения, с. */
const MAX_STEP_S = 0.5;

interface Herd {
  kind: BodyKind;
  members: SearchBody[];
  /** Места в группе относительно вожака: вперёд и вправо по строю, м. */
  offsets: { f: number; r: number }[];
  east: number;
  north: number;
  headingDeg: number;
  /** Куда развёрнут строй — поворачивается только на ходу, иначе стоящие ходили бы по кругу. */
  formationDeg: number;
  speedMs: number;
  mode: Mode;
  timerS: number;
  mobile: boolean;
  restPose: BodyPose;
  /** Человек: направление под уклон, ° (null — ровно или нет рельефа), и когда пересчитать. */
  downhillDeg: number | null;
  gradTimerS: number;
}

/** Генератор mulberry32: один seed — одна и та же последовательность. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const uniform = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
/** Нормальное распределение (сумма четырёх равномерных), σ = 1. */
const gauss = (r: Rng) => (r() + r() + r() + r() - 2) * Math.sqrt(3);
function pick<T>(r: Rng, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [k, w] of entries) if ((x -= w) < 0) return k;
  return entries[entries.length - 1]![0];
}

export interface PopulateOptions {
  difficulty: DifficultyId;
  seed: number;
  animals?: AnimalWeights;
  /** Сомкнутость полога в точке (например, по лесам OSM); null — по сложности. */
  canopyAt?: (east: number, north: number) => number | null;
}

function randomInside(r: Rng, poly: readonly LocalPoint[], taken: readonly LocalPoint[]): LocalPoint {
  const es = poly.map((p) => p.east);
  const ns = poly.map((p) => p.north);
  const [e0, e1, n0, n1] = [Math.min(...es), Math.max(...es), Math.min(...ns), Math.max(...ns)];
  let fallback: LocalPoint | null = null;
  for (let k = 0; k < 300; k++) {
    const p = { east: uniform(r, e0, e1), north: uniform(r, n0, n1) };
    if (!insidePolygon(p.east, p.north, poly)) continue;
    fallback ??= p;
    if (taken.every((q) => Math.hypot(q.east - p.east, q.north - p.north) >= GROUP_SPACING_M)) return p;
  }
  return fallback ?? centroid(poly);
}

function populate(area: readonly LocalPoint[], o: PopulateOptions, r: Rng): Herd[] {
  const d = SEARCH_DIFFICULTY[o.difficulty] ?? SEARCH_DIFFICULTY.train;
  const herds: Herd[] = [];
  const anchors: LocalPoint[] = [];
  const counters: Partial<Record<BodyKind, number>> = {};

  const add = (kind: BodyKind, size: number, mobile: boolean, restPose: BodyPose) => {
    const anchor = randomInside(r, area, anchors);
    anchors.push(anchor);
    const cls = pick(r, (['open', 'sparse', 'dense'] as const).map((c) => [c, d.canopy[c]] as const));
    const base = uniform(r, ...CANOPY_RANGE[cls]);
    const heading = uniform(r, 0, 360);
    const offsets: { f: number; r: number }[] = [];
    for (let i = 0; i < size; i++) {
      if (i === 0) offsets.push({ f: 0, r: 0 });
      else if (kind === 'wolf') offsets.push({ f: -i * uniform(r, 4, 8), r: uniform(r, -4, 4) });
      else {
        const a = uniform(r, 0, 2 * Math.PI);
        const rad = uniform(r, 6, 25);
        offsets.push({ f: rad * Math.cos(a), r: rad * Math.sin(a) });
      }
    }
    const group = herds.length;
    const h = heading * RAD;
    const members = offsets.map((off, i): SearchBody => {
      // Место в строю; за границей района — ближе к вожаку.
      let e = anchor.east;
      let n = anchor.north;
      for (const k of i ? [1, 0.5, 0.25] : []) {
        const pe = anchor.east + k * (off.f * Math.sin(h) + off.r * Math.cos(h));
        const pn = anchor.north + k * (off.f * Math.cos(h) - off.r * Math.sin(h));
        if (insidePolygon(pe, pn, area)) {
          [e, n] = [pe, pn];
          break;
        }
      }
      const at = o.canopyAt?.(e, n);
      const canopy = at === null || at === undefined ? clamp01(base + uniform(r, -0.05, 0.05)) : clamp01(at);
      counters[kind] = (counters[kind] ?? 0) + 1;
      return {
        id: `${kind}-${counters[kind]}`,
        kind,
        group,
        east: e,
        north: n,
        headingDeg: norm360(heading + (i ? uniform(r, -30, 30) : 0)),
        speedMs: 0,
        pose: restPose,
        phase: r(),
        canopy,
        canopyClass: at === null || at === undefined ? cls : canopyClassOf(canopy),
        mobile,
        found: false,
      };
    });
    const modes = Object.keys(BEHAVIOUR[kind]) as Mode[];
    const mode: Mode = !mobile ? 'rest' : kind === 'person' ? 'walk' : modes[int(r, 0, modes.length - 1)]!;
    const spec = BEHAVIOUR[kind][mode]!;
    herds.push({
      kind,
      members,
      offsets,
      east: anchor.east,
      north: anchor.north,
      headingDeg: heading,
      formationDeg: heading,
      speedMs: 0,
      mode,
      timerS: mobile ? uniform(r, ...spec.durS) : Infinity,
      mobile,
      restPose,
      downhillDeg: null,
      gradTimerS: 0,
    });
  };

  // Люди: травмированные лежат или сидят, остальные бредут.
  const people = int(r, d.people[0], d.people[1]);
  for (let i = 0; i < people; i++) {
    const walking = r() < d.walking;
    add('person', 1, walking, walking ? 'sitting' : r() < 0.6 ? 'lying' : 'sitting');
  }
  // Звери: вид — по весам района, число особей — по сложности; волки — стаей, медведь — один.
  const weights = animalWeights(o.animals);
  let left = int(r, d.animals[0], d.animals[1]);
  while (left > 0 && weights.length) {
    let kind = pick(r, weights);
    const others = weights.filter(([k]) => k !== 'wolf');
    if (kind === 'wolf' && left < GROUP_SIZE.wolf[0] && others.length) kind = pick(r, others);
    const [lo, hi] = GROUP_SIZE[kind];
    const size = kind === 'wolf' ? Math.max(lo, Math.min(int(r, lo, hi), left)) : Math.min(int(r, lo, hi), left);
    add(kind, size, true, 'lying');
    left -= size;
  }
  return herds;
}

/** Люди и звери района без движения — для проверки и предпросмотра. */
export function generateBodies(area: readonly LocalPoint[], o: PopulateOptions): SearchBody[] {
  return populate(area, o, mulberry32(o.seed)).flatMap((h) => h.members);
}

/* --------------------------------- Отметки --------------------------------- */

/** Радиус отметки: ближе этого к телу — отметка его, м. */
export const MARK_RADIUS_M = 25;

/** found — найден человек; repeat — этот человек уже найден; false — зверь; empty — никого. */
export type MarkResult = 'found' | 'repeat' | 'false' | 'empty';

export interface SearchMark extends LocalPoint {
  t: number;
  result: MarkResult;
  kind: BodyKind | null;
  bodyId: string | null;
  distanceM: number | null;
  text: string;
}

export interface Sighting {
  body: SearchBody;
  d: Detectability;
}

/* ---------------------------------- Мир ---------------------------------- */

export interface SearchSetup {
  /** Начало локальных координат — площадка задания, как у полёта. */
  origin: GeoPoint;
  area: readonly GeoPoint[];
  difficulty: DifficultyId;
  seed: number;
  /** Веса видов зверей района (LocationSpec.search.animals); нет — обычная тайга. */
  animals?: AnimalWeights;
  /** Рельеф: бредущий человек спускается под уклон; высота борта над целью. */
  terrain?: Terrain;
  camera?: ThermalCamera;
  markRadiusM?: number;
  coverageCellM?: number;
  canopyAt?: (east: number, north: number) => number | null;
}

/**
 * Мир поиска: люди и звери района, их движение, покрытие района кадрами и отметки оператора.
 * Каждый кадр — step(dt) и observe(позиция камеры); heatBodies() — в сцену; mark() — отметка;
 * result() — в оценку (AssessInput.search). Один seed и те же dt — одно и то же движение.
 */
export class SearchWorld {
  readonly origin: GeoPoint;
  /** Район поиска, локальные метры. */
  readonly area: LocalPoint[];
  readonly camera: ThermalCamera;
  readonly markRadiusM: number;
  readonly bodies: SearchBody[];
  readonly marks: SearchMark[] = [];
  readonly coverage: CoverageGrid;
  /** Время модели движения, с. */
  t = 0;
  private readonly herds: Herd[];
  private readonly rng: Rng;
  private readonly terrain: Terrain | undefined;
  private readonly center: LocalPoint;
  private lastPose: CameraPose | null = null;
  private lastFocalMm = NaN;

  constructor(setup: SearchSetup) {
    this.origin = setup.origin;
    this.area = setup.area.map((g) => toLocal(setup.origin, g));
    this.camera = setup.camera ?? THERMAL_CAMERA;
    this.markRadiusM = setup.markRadiusM ?? MARK_RADIUS_M;
    this.terrain = setup.terrain;
    this.center = centroid(this.area);
    this.rng = mulberry32(setup.seed);
    const o: PopulateOptions = { difficulty: setup.difficulty, seed: setup.seed };
    if (setup.animals) o.animals = setup.animals;
    if (setup.canopyAt) o.canopyAt = setup.canopyAt;
    this.herds = populate(this.area, o, this.rng);
    this.bodies = this.herds.flatMap((h) => h.members);
    this.coverage = new CoverageGrid(this.area, setup.coverageCellM ?? 10);
  }

  get people(): SearchBody[] {
    return this.bodies.filter((b) => b.kind === 'person');
  }

  /** Движение за dt, с; длинный dt делится на шаги не больше MAX_STEP_S. */
  step(dt: number): void {
    let left = Math.max(0, dt);
    while (left > 1e-9) {
      const h = Math.min(MAX_STEP_S, left);
      for (const herd of this.herds) this.tick(herd, h);
      this.t += h;
      left -= h;
    }
  }

  /** Кадр камеры в покрытие района; кадры чаще, чем сдвиг на полклетки, пропускаются. */
  observe(pose: CameraPose, camera: ThermalCamera = this.camera): void {
    const p = this.lastPose;
    const c = this.coverage.cellM / 2;
    const same =
      p &&
      Math.hypot(pose.east - p.east, pose.north - p.north) < c &&
      Math.abs(angleDiff(p.headingDeg, pose.headingDeg)) < 2 &&
      Math.abs(pose.aglM - p.aglM) < 2 &&
      Math.abs((pose.tiltDeg ?? 0) - (p.tiltDeg ?? 0)) < 1 &&
      camera.focalLengthMm === this.lastFocalMm;
    if (same) return;
    this.lastPose = { ...pose };
    this.lastFocalMm = camera.focalLengthMm;
    this.coverage.add(pose, camera);
  }

  /** Тела для сцены (World.setHeatBodies). */
  heatBodies(): HeatBody[] {
    return this.bodies.map(toHeatBody);
  }

  /** Высота борта над телом: с рельефом и высотой над морем — точно, иначе aglM под бортом. */
  heightAbove(pose: CameraPose, p: LocalPoint): number {
    if (pose.altitudeM === undefined || !this.terrain) return pose.aglM;
    return pose.altitudeM - this.terrain.elevationM(fromLocal(this.origin, p.east, p.north));
  }

  /** Тела в кадре с обнаружимостью, самые заметные первыми — для подсказок. */
  sightings(pose: CameraPose, env: ThermalEnv): Sighting[] {
    return this.bodies
      .map((body) => ({ body, d: detectability(body, pose, this.camera, env, this.heightAbove(pose, body)) }))
      .filter((s) => s.d.inView)
      .sort((a, b) => b.d.pDetect - a.d.pDetect);
  }

  /**
   * Отметка оператора в точке p в момент t: ближайший ненайденный человек в радиусе — найден
   * (один раз); уже найденный — повтор; иначе ближайший зверь — ложная отметка с видом; иначе пусто.
   */
  mark(p: LocalPoint, t: number): SearchMark {
    const R = this.markRadiusM;
    const near = (b: SearchBody) => Math.hypot(b.east - p.east, b.north - p.north);
    const nearest = (list: SearchBody[]) => list.map((b) => ({ b, d: near(b) })).filter((x) => x.d <= R).sort((a, b) => a.d - b.d)[0];
    const people = this.people;
    const person = nearest(people.filter((b) => !b.found));
    let m: SearchMark;
    if (person) {
      person.b.found = true;
      const n = people.filter((b) => b.found).length;
      m = { ...p, t, result: 'found', kind: 'person', bodyId: person.b.id, distanceM: person.d, text: `Найден человек: ${n} из ${people.length}` };
    } else {
      const again = nearest(people);
      const animal = again ? undefined : nearest(this.bodies.filter((b) => b.kind !== 'person'));
      if (again) m = { ...p, t, result: 'repeat', kind: 'person', bodyId: again.b.id, distanceM: again.d, text: 'Этот человек уже отмечен' };
      else if (animal) m = { ...p, t, result: 'false', kind: animal.b.kind, bodyId: animal.b.id, distanceM: animal.d, text: `Ложная отметка: ${BODY_NAMES[animal.b.kind]}` };
      else m = { ...p, t, result: 'empty', kind: null, bodyId: null, distanceM: null, text: `Пусто: в ${R} м от отметки никого нет` };
    }
    this.marks.push(m);
    return m;
  }

  /** Итог для оценки (AssessInput.search): время первой находки — от takeoffT по часам отметок. */
  result(takeoffT = 0): SearchOutcome {
    const people = this.people;
    const first = this.marks.find((m) => m.result === 'found');
    return {
      found: people.filter((b) => b.found).length,
      total: people.length,
      falseMarks: this.marks.filter((m) => m.result === 'false' || m.result === 'empty').length,
      firstFoundS: first ? Math.max(0, first.t - takeoffT) : null,
      coverage: this.coverage.fraction,
    };
  }

  private tick(herd: Herd, dt: number): void {
    const r = this.rng;
    if (herd.mobile) {
      herd.timerS -= dt;
      if (herd.timerS <= 0) {
        const next = BEHAVIOUR[herd.kind][herd.mode]!.next;
        herd.mode = pick(r, Object.entries(next) as [Mode, number][]);
        herd.timerS = uniform(r, ...BEHAVIOUR[herd.kind][herd.mode]!.durS);
      }
      const spec = BEHAVIOUR[herd.kind][herd.mode]!;
      herd.headingDeg += gauss(r) * spec.wanderDeg * Math.sqrt(dt);
      // Заблудившийся человек идёт под уклон — к ручью, к реке.
      if (herd.kind === 'person' && this.terrain && spec.speedMs > 0) {
        herd.gradTimerS -= dt;
        if (herd.gradTimerS <= 0) {
          herd.downhillDeg = this.downhill(herd);
          herd.gradTimerS = 10;
        }
        if (herd.downhillDeg !== null) herd.headingDeg += angleDiff(herd.headingDeg, herd.downhillDeg) * Math.min(1, dt / 20);
      }
      // За районом — к центру: мягко, а дальше BOUNDARY_SOFT_M — сразу.
      const out = distanceOutside(herd, this.area);
      if (out > 0) {
        const toCenter = Math.atan2(this.center.east - herd.east, this.center.north - herd.north) / RAD;
        const k = out >= BOUNDARY_SOFT_M ? 1 : Math.min(1, ((out / BOUNDARY_SOFT_M) * dt) / 3);
        herd.headingDeg += angleDiff(herd.headingDeg, toCenter) * k;
      }
      herd.headingDeg = norm360(herd.headingDeg);
      herd.speedMs += (spec.speedMs - herd.speedMs) * Math.min(1, dt / 2);
      const h = herd.headingDeg * RAD;
      herd.east += herd.speedMs * Math.sin(h) * dt;
      herd.north += herd.speedMs * Math.cos(h) * dt;
      herd.formationDeg = norm360(herd.formationDeg + angleDiff(herd.formationDeg, herd.headingDeg) * Math.min(1, (herd.speedMs * dt) / 20));
    }
    const f = herd.formationDeg * RAD;
    herd.members.forEach((m, i) => {
      if (!m.mobile) return;
      const off = herd.offsets[i]!;
      const te = herd.east + off.f * Math.sin(f) + off.r * Math.cos(f);
      const tn = herd.north + off.f * Math.cos(f) - off.r * Math.sin(f);
      const de = te - m.east;
      const dn = tn - m.north;
      const dist = Math.hypot(de, dn);
      const move = Math.min(dist, Math.min(herd.speedMs + 1, dist / 1.5) * dt);
      if (dist > 1e-9) {
        m.east += (de / dist) * move;
        m.north += (dn / dist) * move;
      }
      m.speedMs = move / dt;
      if (m.speedMs > 0.2) m.headingDeg = norm360(m.headingDeg + angleDiff(m.headingDeg, Math.atan2(de, dn) / RAD) * Math.min(1, dt / 0.7));
      else m.headingDeg = norm360(m.headingDeg + angleDiff(m.headingDeg, herd.headingDeg) * Math.min(1, dt / 5));
      m.pose = m.speedMs > 0.3 ? 'walking' : herd.mode === 'rest' || herd.kind === 'person' ? herd.restPose : 'standing';
      m.phase = (m.phase + (m.speedMs * dt) / STRIDE_M[m.kind]) % 1;
    });
  }

  /** Направление под уклон по рельефу (разности через ±15 м), °; почти ровно — null. */
  private downhill(p: LocalPoint): number | null {
    const z = (de: number, dn: number) => this.terrain!.elevationM(fromLocal(this.origin, p.east + de, p.north + dn));
    const ge = (z(15, 0) - z(-15, 0)) / 30;
    const gn = (z(0, 15) - z(0, -15)) / 30;
    return Math.hypot(ge, gn) < 0.01 ? null : norm360(Math.atan2(-ge, -gn) / RAD);
  }
}
