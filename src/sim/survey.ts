import { dubins, samplePath } from './dubins';
import { fromLocal, toLocal } from './mission';
import { stateAt, type Timeline } from './timeline';
import type { GeoPoint, Site, Terrain } from './types';

/*
 * Аэрофотосъёмка (АФС) камерой, смотрящей вниз: высота по GSD, галсы с перекрытиями,
 * спуск затвора по базису, экспозиция по освещённости, покрытие участка годными кадрами.
 */

const RAD = Math.PI / 180;

export interface SurveyCamera {
  id: string;
  name: string;
  massKg: number;
  powerW: number;
  focalLengthMm: number;
  pixelPitchUm: number;
  /** Сторона матрицы поперёк полёта, пикселей. */
  widthPx: number;
  /** Сторона вдоль полёта, пикселей. */
  heightPx: number;
  fNumber: number;
  /** Наибольшее ISO, при котором кадр ещё годен для фотограмметрии. */
  isoMax: number;
  /** Наименьший интервал между кадрами (запись на карту), с. */
  minIntervalS: number;
  frameMB: number;
  /** Подвес держит камеру по линии пути: кадр не разворачивается на угол сноса. */
  stabilizedYaw?: boolean;
}

export interface SurveyParams {
  gsdM: number;
  /** Продольное перекрытие 0…1. */
  forwardOverlap: number;
  /** Поперечное перекрытие 0…1. */
  sideOverlap: number;
  /** Направление галсов, градусы от севера. */
  directionDeg: number;
  shutterS: number;
  /** Продление галса за границу участка с каждой стороны, м. */
  leadInM: number;
}

/** GSD = высота · шаг пикселя / f. */
export function gsdAtM(cam: SurveyCamera, heightM: number): number {
  return (heightM * cam.pixelPitchUm * 1e-6) / (cam.focalLengthMm * 1e-3);
}

export function heightForGsdM(cam: SurveyCamera, gsdM: number): number {
  return (gsdM * cam.focalLengthMm * 1e-3) / (cam.pixelPitchUm * 1e-6);
}

/** Размер кадра на земле: поперёк и вдоль полёта, м. */
export function footprintM(cam: SurveyCamera, heightM: number): { acrossM: number; alongM: number } {
  const g = gsdAtM(cam, heightM);
  return { acrossM: g * cam.widthPx, alongM: g * cam.heightPx };
}

/** Расстояние между галсами = ширина кадра · (1 − поперечное перекрытие). */
export function lineSpacingM(cam: SurveyCamera, p: SurveyParams): number {
  return footprintM(cam, heightForGsdM(cam, p.gsdM)).acrossM * (1 - p.sideOverlap);
}

/** Базис фотографирования = длина кадра · (1 − продольное перекрытие). */
export function triggerBaseM(cam: SurveyCamera, p: SurveyParams): number {
  return footprintM(cam, heightForGsdM(cam, p.gsdM)).alongM * (1 - p.forwardOverlap);
}

/**
 * Освещённость горизонтальной поверхности, лк. Простая модель ясного неба: прямой свет
 * ослабляется по воздушной массе ~1/sin(h), рассеянный растёт медленнее. Облака гасят прямой
 * свет пропорционально покрытию. Даёт ~105 клк при Солнце на 60°, ~14 клк на 10°.
 */
export function illuminanceLux(sunElevationDeg: number, cloudCover: number): number {
  if (sunElevationDeg <= -6) return 1;
  if (sunElevationDeg <= 0) return 400 * (1 + sunElevationDeg / 6);
  const s = Math.sin(sunElevationDeg * RAD);
  const direct = 128_000 * Math.exp(-0.21 / s) * s;
  const diffuse = 20_000 * s ** 0.6;
  return 400 + direct * (1 - 0.85 * cloudCover) + diffuse * (1 + 0.25 * cloudCover);
}

/**
 * ISO для правильной экспозиции: N² / t = L · S / K, где L = E · ρ / π — яркость
 * ламбертовой поверхности с альбедо ρ (растительность ≈ 0.15), K = 12.5.
 */
export function isoNeeded(cam: SurveyCamera, shutterS: number, lux: number, reflectance = 0.15): number {
  return (cam.fNumber ** 2 * 12.5 * Math.PI) / (shutterS * lux * reflectance);
}

export interface SurveyPlan {
  /** Точки между площадкой взлёта и посадки. Участок i ведёт в route[i]; последний — к площадке. */
  route: GeoPoint[];
  /** Номера участков, на которых идёт съёмка (галсы). */
  lineLegs: Set<number>;
  legLabels: string[];
  lineCount: number;
  heightAglM: number;
  spacingM: number;
  baseM: number;
  turnRadiusM: number;
  linesLengthM: number;
  firstLineStart: GeoPoint;
  lastLineEnd: GeoPoint;
}

interface P2 {
  e: number;
  n: number;
}

export interface SurveyOptions {
  /** Круги над площадкой: до участка (набор высоты) и после (снижение). */
  loops?: { start: number; end: number };
  /**
   * auto — если галсы ближе двух радиусов разворота, «ипподром»: галсы через k, туда и
   * обратно, чтобы разворот был полуокружностью, а не петлёй. serpentine — всегда подряд.
   */
  order?: 'auto' | 'serpentine';
}

/**
 * Галсы через выпуклый участок по направлению directionDeg с разворотами Дубинса
 * минимального радиуса.
 */
export function planSurvey(
  area: GeoPoint[],
  site: GeoPoint,
  cam: SurveyCamera,
  p: SurveyParams,
  turnRadiusM: number,
  opts: SurveyOptions = {},
): SurveyPlan {
  const loops = opts.loops ?? { start: 0, end: 0 };
  const th = p.directionDeg * RAD;
  const u = { e: Math.sin(th), n: Math.cos(th) };
  const v = { e: Math.cos(th), n: -Math.sin(th) };
  const poly = area.map((g) => {
    const l = toLocal(site, g);
    return { s: l.east * u.e + l.north * u.n, w: l.east * v.e + l.north * v.n };
  });
  const ws = poly.map((q) => q.w);
  const wMin = Math.min(...ws);
  const wMax = Math.max(...ws);
  const spacingM = lineSpacingM(cam, p);
  const count = Math.max(1, Math.ceil((wMax - wMin) / spacingM));
  const mid = (wMin + wMax) / 2;
  const at = (s: number, w: number): P2 => ({ e: s * u.e + w * v.e, n: s * u.n + w * v.n });

  const bands: [P2, P2][] = [];
  for (let k = 0; k < count; k++) {
    const w = mid + spacingM * (k - (count - 1) / 2);
    const cross: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if ((a.w - w) * (b.w - w) <= 0 && a.w !== b.w) cross.push(a.s + ((w - a.w) / (b.w - a.w)) * (b.s - a.s));
    }
    if (cross.length < 2) continue;
    bands.push([at(Math.min(...cross) - p.leadInM, w), at(Math.max(...cross) + p.leadInM, w)]);
  }
  if (bands.length === 0) throw new Error('Галсы не пересекают участок');

  // Порядок облёта. «Ипподром»: галсы делятся на блоки равного размера; внутри блока из m
  // галсов порядок 0, k, 1, k+1, … при k = ⌈m/2⌉ — развороты смещают на k и k − 1 галсов,
  // и оба не меньше двух радиусов, если блок не меньше 2·minK.
  const minK = Math.ceil((2 * turnRadiusM) / spacingM) + 1;
  const racetrack = opts.order !== 'serpentine' && spacingM < 2 * turnRadiusM;
  const lines: [P2, P2][] = [];
  if (!racetrack) {
    bands.forEach(([a, b], k) => lines.push(k % 2 === 0 ? [a, b] : [b, a]));
  } else {
    const blocks = Math.max(1, Math.floor(bands.length / (2 * minK)));
    let first = 0;
    for (let block = 0; block < blocks; block++) {
      const size = Math.round((bands.length - first) / (blocks - block));
      const k = Math.ceil(size / 2);
      for (let i = 0; i < k; i++) {
        const out = bands[first + i]!;
        lines.push([out[0], out[1]]);
        if (k + i < size) {
          const back = bands[first + k + i]!;
          lines.push([back[1], back[0]]);
        }
      }
      first += size;
    }
  }

  const route: GeoPoint[] = [];
  const labels: string[] = [];
  const lineLegs = new Set<number>();
  const push = (q: P2, label: string) => {
    route.push(fromLocal(site, q.e, q.n));
    labels.push(label);
  };
  const heading = (a: P2, b: P2) => Math.atan2(b.n - a.n, b.e - a.e);
  /** Круги радиуса разворота вокруг площадки, начиная со стороны точки towards. */
  const orbit = (towards: P2, turns: number, label: string) => {
    if (turns <= 0) return;
    const a0 = Math.atan2(towards.n, towards.e);
    const steps = Math.ceil((2 * Math.PI * turnRadiusM) / 15) * turns;
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (2 * Math.PI * turns * k) / steps;
      push({ e: Math.cos(a) * turnRadiusM, n: Math.sin(a) * turnRadiusM }, label);
    }
  };

  const n = lines.length;
  orbit(lines[0]![0], loops.start, 'Набор высоты по кругу');
  let linesLengthM = 0;
  lines.forEach(([a, b], k) => {
    if (k === 0) {
      push(a, 'Выход на первый галс');
    } else {
      const [pa, pb] = lines[k - 1]!;
      const turn = dubins({ x: pb.e, y: pb.n, theta: heading(pa, pb) }, { x: a.e, y: a.n, theta: heading(a, b) }, turnRadiusM);
      for (const q of samplePath(turn, 15).slice(1)) push({ e: q.x, n: q.y }, `Разворот на галс ${k + 1}`);
    }
    push(b, `Галс ${k + 1} из ${n}`);
    lineLegs.add(route.length - 1);
    linesLengthM += Math.hypot(b.e - a.e, b.n - a.n);
  });
  orbit(lines[n - 1]![1], loops.end, 'Снижение по кругу');
  labels.push('Возврат на площадку');

  const first = lines[0]![0];
  const last = lines[n - 1]![1];
  return {
    route,
    lineLegs,
    legLabels: labels,
    lineCount: n,
    heightAglM: heightForGsdM(cam, p.gsdM),
    spacingM,
    baseM: triggerBaseM(cam, p),
    turnRadiusM,
    linesLengthM,
    firstLineStart: fromLocal(site, first.e, first.n),
    lastLineEnd: fromLocal(site, last.e, last.n),
  };
}

export interface Frame {
  t: number;
  east: number;
  north: number;
  headingDeg: number;
  aglM: number;
  gsdM: number;
  /** Смаз за выдержку, пикселей. */
  blurPx: number;
  iso: number;
  acrossM: number;
  alongM: number;
  ok: boolean;
  reason: string | null;
  /** Углы кадра на земле, локальные метры [восток, север]. */
  corners: [number, number][];
}

export interface CaptureContext {
  site: Site;
  terrain: Terrain;
  lineLegs: Set<number>;
  /** Освещённость в момент t полёта, лк. */
  luxAt(t: number): number;
}

/** Что камере нужно знать об аппарате в момент кадра. */
export interface CameraPose {
  t: number;
  position: { east: number; north: number; up: number };
  groundSpeedMs: number;
  headingDeg: number;
  /** Путевой угол — для подвеса со стабилизацией по курсу. */
  trackDeg?: number;
}

export function frameAt(s: CameraPose, cam: SurveyCamera, p: SurveyParams, ctx: CaptureContext): Frame {
  const { east, north, up } = s.position;
  const aglM = up + ctx.site.elevationM - ctx.terrain.elevationM(fromLocal(ctx.site, east, north));
  const gsdM = gsdAtM(cam, aglM);
  const blurPx = (s.groundSpeedMs * p.shutterS) / gsdM;
  const iso = isoNeeded(cam, p.shutterS, ctx.luxAt(s.t));
  const reasons = [...(blurPx > 1 ? ['смаз'] : []), ...(iso > cam.isoMax ? ['недодержка'] : [])];
  const { acrossM, alongM } = footprintM(cam, aglM);
  // Жёстко закреплённая камера разворачивает кадр вместе с аппаратом на угол сноса;
  // подвес со стабилизацией по курсу держит кадр вдоль линии пути.
  const yaw = cam.stabilizedYaw && s.trackDeg !== undefined ? s.trackDeg : s.headingDeg;
  const h = yaw * RAD;
  const ua = [Math.sin(h), Math.cos(h)] as const;
  const va = [Math.cos(h), -Math.sin(h)] as const;
  const corners = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([a, c]) => [
    east + ((a! * alongM) / 2) * ua[0] + ((c! * acrossM) / 2) * va[0],
    north + ((a! * alongM) / 2) * ua[1] + ((c! * acrossM) / 2) * va[1],
  ]) as [number, number][];
  // headingDeg кадра — ориентация самого кадра на земле (по ней считается покрытие).
  return { t: s.t, east, north, headingDeg: yaw, aglM, gsdM, blurPx, iso, acrossM, alongM, ok: reasons.length === 0, reason: reasons.join(', ') || null, corners };
}

/**
 * Спуск затвора на галсах: каждый раз, когда пройден базис, но не чаще, чем позволяет камера.
 * При сильном попутном ветре базис растёт, продольное перекрытие падает. На новом галсе —
 * первый кадр сразу.
 */
export class FrameTrigger {
  private line = -1;
  private lastDist = -Infinity;
  private lastT = -Infinity;
  private readonly base: number;

  constructor(
    private readonly cam: SurveyCamera,
    private readonly p: SurveyParams,
    private readonly ctx: CaptureContext,
  ) {
    this.base = triggerBaseM(cam, p);
  }

  /** Кадр, если в этот момент камера срабатывает, иначе null. distanceM — пройденный путь. */
  offer(pose: CameraPose, routeLeg: number | null, distanceM: number): Frame | null {
    if (routeLeg === null || !this.ctx.lineLegs.has(routeLeg)) return null;
    if (routeLeg !== this.line) {
      this.line = routeLeg;
      this.lastDist = -Infinity;
    }
    if (distanceM - this.lastDist < this.base || pose.t - this.lastT < this.cam.minIntervalS) return null;
    this.lastDist = distanceM;
    this.lastT = pose.t;
    return frameAt(pose, this.cam, this.p, this.ctx);
  }
}

/** Все кадры рассчитанного полёта (для прогноза до вылета). */
export function captureFrames(tl: Timeline, cam: SurveyCamera, p: SurveyParams, ctx: CaptureContext, untilS = tl.durationS, stepS = 0.05): Frame[] {
  const trigger = new FrameTrigger(cam, p, ctx);
  const frames: Frame[] = [];
  for (const leg of tl.legs) {
    if (leg.kind !== 'cruise' || !leg.segment) continue;
    const routeLeg = leg.segment.to.routeLeg ?? leg.segment.from.routeLeg ?? null;
    if (routeLeg === null || !ctx.lineLegs.has(routeLeg)) continue;
    const end = Math.min(leg.t1, untilS);
    for (let t = leg.t0; t < end; t += stepS) {
      const s = stateAt(tl, t);
      const f = trigger.offer(s, routeLeg, s.distanceM);
      if (f) frames.push(f);
    }
  }
  return frames;
}

export interface Coverage {
  cellM: number;
  e0: number;
  n0: number;
  cols: number;
  rows: number;
  /** Годных кадров на клетку. */
  counts: Uint16Array;
  /** 1 — клетка внутри участка. */
  inside: Uint8Array;
  insideCells: number;
  atLeast1: number;
  atLeast3: number;
  atLeast5: number;
  meanFrames: number;
}

function insidePolygon(e: number, n: number, poly: { east: number; north: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.north > n !== b.north > n && e < ((b.east - a.east) * (n - a.north)) / (b.north - a.north) + a.east) inside = !inside;
  }
  return inside;
}

/** Сколько годных кадров легло на каждую клетку участка (центр клетки внутри кадра). */
export function coverageOf(frames: Frame[], area: GeoPoint[], site: GeoPoint, cellM = 10): Coverage {
  const poly = area.map((g) => toLocal(site, g));
  const e0 = Math.min(...poly.map((q) => q.east));
  const n0 = Math.min(...poly.map((q) => q.north));
  const cols = Math.ceil((Math.max(...poly.map((q) => q.east)) - e0) / cellM);
  const rows = Math.ceil((Math.max(...poly.map((q) => q.north)) - n0) / cellM);
  const counts = new Uint16Array(cols * rows);
  const inside = new Uint8Array(cols * rows);
  let insideCells = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (insidePolygon(e0 + (i + 0.5) * cellM, n0 + (j + 0.5) * cellM, poly)) {
        inside[j * cols + i] = 1;
        insideCells++;
      }
    }
  }
  for (const f of frames) {
    if (!f.ok) continue;
    const h = f.headingDeg * RAD;
    const ue = Math.sin(h);
    const un = Math.cos(h);
    const r = Math.hypot(f.acrossM, f.alongM) / 2;
    const i0 = Math.max(0, Math.floor((f.east - r - e0) / cellM));
    const i1 = Math.min(cols - 1, Math.floor((f.east + r - e0) / cellM));
    const j0 = Math.max(0, Math.floor((f.north - r - n0) / cellM));
    const j1 = Math.min(rows - 1, Math.floor((f.north + r - n0) / cellM));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * cols + i;
        if (!inside[k]) continue;
        const de = e0 + (i + 0.5) * cellM - f.east;
        const dn = n0 + (j + 0.5) * cellM - f.north;
        if (Math.abs(de * ue + dn * un) <= f.alongM / 2 && Math.abs(de * un - dn * ue) <= f.acrossM / 2) counts[k]!++;
      }
    }
  }
  let c1 = 0;
  let c3 = 0;
  let c5 = 0;
  let sum = 0;
  for (let k = 0; k < counts.length; k++) {
    if (!inside[k]) continue;
    const c = counts[k]!;
    sum += c;
    if (c >= 1) c1++;
    if (c >= 3) c3++;
    if (c >= 5) c5++;
  }
  const d = Math.max(1, insideCells);
  return { cellM, e0, n0, cols, rows, counts, inside, insideCells, atLeast1: c1 / d, atLeast3: c3 / d, atLeast5: c5 / d, meanFrames: sum / d };
}
