import { fromLocal, toLocal } from './mission';
import type { GeoPoint } from './types';

/*
 * Кратчайшие пути Дубинса: из точки с курсом в точку с курсом при ограниченном радиусе
 * разворота (L — влево, R — вправо, S — прямо). Координаты плоские: x — восток, y — север,
 * угол θ — от оси x против часовой (математический).
 */

export interface Pose2 {
  x: number;
  y: number;
  theta: number;
}

type Seg = 'L' | 'S' | 'R';

export interface DubinsPath {
  segments: [Seg, Seg, Seg];
  /** Длины сегментов в радиусах разворота. */
  lengths: [number, number, number];
  radius: number;
  start: Pose2;
  /** Полная длина, м. */
  length: number;
}

const TWO_PI = Math.PI * 2;
const mod2pi = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

export function dubins(q0: Pose2, q1: Pose2, radius: number): DubinsPath {
  const dx = q1.x - q0.x;
  const dy = q1.y - q0.y;
  const d = Math.hypot(dx, dy) / radius;
  const th = mod2pi(Math.atan2(dy, dx));
  const a = mod2pi(q0.theta - th);
  const b = mod2pi(q1.theta - th);
  const sa = Math.sin(a);
  const sb = Math.sin(b);
  const ca = Math.cos(a);
  const cb = Math.cos(b);
  const cab = Math.cos(a - b);
  const candidates: { segments: [Seg, Seg, Seg]; lengths: [number, number, number] }[] = [];

  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, d + sa - sb);
      candidates.push({ segments: ['L', 'S', 'L'], lengths: [mod2pi(-a + tmp), Math.sqrt(p2), mod2pi(b - tmp)] });
    }
  }
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, d - sa + sb);
      candidates.push({ segments: ['R', 'S', 'R'], lengths: [mod2pi(a - tmp), Math.sqrt(p2), mod2pi(-b + tmp)] });
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      candidates.push({ segments: ['L', 'S', 'R'], lengths: [mod2pi(-a + tmp), p, mod2pi(-b + tmp)] });
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      candidates.push({ segments: ['R', 'S', 'L'], lengths: [mod2pi(a - tmp), p, mod2pi(b - tmp)] });
    }
  }
  {
    const tmp = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
    if (Math.abs(tmp) <= 1) {
      const p = mod2pi(TWO_PI - Math.acos(tmp));
      const t = mod2pi(a - Math.atan2(ca - cb, d - sa + sb) + p / 2);
      candidates.push({ segments: ['R', 'L', 'R'], lengths: [t, p, mod2pi(a - b - t + p)] });
    }
  }
  {
    const tmp = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
    if (Math.abs(tmp) <= 1) {
      const p = mod2pi(TWO_PI - Math.acos(tmp));
      const t = mod2pi(-a + Math.atan2(-ca + cb, d + sa - sb) + p / 2);
      candidates.push({ segments: ['L', 'R', 'L'], lengths: [t, p, mod2pi(b - a - t + p)] });
    }
  }

  let best = candidates[0]!;
  const total = (c: (typeof candidates)[number]) => c.lengths[0] + c.lengths[1] + c.lengths[2];
  for (const c of candidates) if (total(c) < total(best)) best = c;
  return { ...best, radius, start: q0, length: total(best) * radius };
}

function advance(q: Pose2, seg: Seg, len: number, r: number): Pose2 {
  if (seg === 'S') return { x: q.x + r * len * Math.cos(q.theta), y: q.y + r * len * Math.sin(q.theta), theta: q.theta };
  if (seg === 'L') {
    const th = q.theta + len;
    return { x: q.x + r * (Math.sin(th) - Math.sin(q.theta)), y: q.y - r * (Math.cos(th) - Math.cos(q.theta)), theta: th };
  }
  const th = q.theta - len;
  return { x: q.x - r * (Math.sin(th) - Math.sin(q.theta)), y: q.y + r * (Math.cos(th) - Math.cos(q.theta)), theta: th };
}

/** Часть исходного участка маршрута: номер участка и доля пути по нему в начале и конце. */
export interface LegPart {
  leg: number;
  f0: number;
  f1: number;
}

/**
 * Крутые повороты маршрута (больше maxTurnDeg) аппарат проходит не углом, а разворотом
 * минимального радиуса: путь Дубинса строится перед вершиной, на входящем участке, и приходит
 * в вершину уже на новом курсе. Так план совпадает с тем, как летит автопилот, — например,
 * разворот на посадочную прямую после подхода с наветренной стороны. Номера исходных
 * участков сохраняются (parts), чтобы подписи, галсы и правка маршрута не сбивались.
 */
export function roundSharpCorners(points: GeoPoint[], radiusM: number, maxTurnDeg = 90): { points: GeoPoint[]; parts: LegPart[] } {
  if (points.length < 3) return { points: [...points], parts: points.slice(1).map((_, i) => ({ leg: i, f0: 0, f1: 1 })) };
  const o = points[0]!;
  const L = points.map((p) => {
    const q = toLocal(o, p);
    return { x: q.east, y: q.north };
  });
  const heading = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.atan2(b.y - a.y, b.x - a.x);
  const out: GeoPoint[] = [points[0]!];
  const parts: LegPart[] = [];
  for (let k = 0; k < L.length - 1; k++) {
    const a = L[k]!;
    const b = L[k + 1]!;
    const next = L[k + 2];
    // Промежуточные точки участка k — без начала, конец последним.
    const pts: { x: number; y: number }[] = [];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (next && len > 1 && Math.hypot(next.x - b.x, next.y - b.y) > 1) {
      const hin = heading(a, b);
      const hout = heading(b, next);
      const turn = Math.abs(Math.atan2(Math.sin(hout - hin), Math.cos(hout - hin)));
      if (turn > (maxTurnDeg * Math.PI) / 180) {
        const d = Math.min(2 * radiusM, 0.5 * len);
        const p = { x: b.x - Math.cos(hin) * d, y: b.y - Math.sin(hin) * d };
        pts.push(p);
        for (const q of samplePath(dubins({ ...p, theta: hin }, { ...b, theta: hout }, radiusM), 30).slice(1, -1)) pts.push({ x: q.x, y: q.y });
      }
    }
    pts.push(b);
    let prev = a;
    const lens = pts.map((q) => {
      const d = Math.hypot(q.x - prev.x, q.y - prev.y);
      prev = q;
      return d;
    });
    const total = lens.reduce((s, x) => s + x, 0) || 1;
    let acc = 0;
    pts.forEach((q, i) => {
      const f0 = acc / total;
      acc += lens[i]!;
      parts.push({ leg: k, f0, f1: acc / total });
      out.push(i === pts.length - 1 ? points[k + 1]! : fromLocal(o, q.x, q.y));
    });
  }
  return { points: out, parts };
}

/** Точки пути с шагом не больше stepM, включая начало и конец. */
export function samplePath(path: DubinsPath, stepM: number): Pose2[] {
  const out: Pose2[] = [path.start];
  let q = path.start;
  for (let i = 0; i < 3; i++) {
    const len = path.lengths[i]!;
    const n = Math.max(1, Math.ceil((len * path.radius) / stepM));
    for (let k = 1; k <= n; k++) out.push(advance(q, path.segments[i]!, (len * k) / n, path.radius));
    q = advance(q, path.segments[i]!, len, path.radius);
  }
  return out;
}
