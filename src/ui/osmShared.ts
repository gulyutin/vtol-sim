import * as THREE from 'three';
import type { QualitySettings } from './quality';

/*
 * Общее для слоя OpenStreetMap: высота рельефа, хеш, отсечение, ломаные, квадраты с ленивой
 * сборкой, дальности по качеству. Координаты — (восток, север) в метрах; сцена: x — восток,
 * y — вверх, z — юг.
 */

export type GroundAt = (east: number, north: number) => number;

/** Время, ночь и ветер для анимации слоя. */
export interface OsmEnv {
  /** Время, с (любое начало отсчёта, монотонное). */
  time: number;
  /** 0 — день … 1 — ночь. */
  nightFactor: number;
  /** Ветер у земли, м/с: x — на восток, y — на юг (−север), как x и z сцены. */
  wind: THREE.Vector2;
}

/** Униформы, общие для материалов слоя: меняются раз в кадр. */
export interface OsmUniforms {
  osmTime: { value: number };
  osmNight: { value: number };
  osmWind: { value: THREE.Vector2 };
  osmCam: { value: THREE.Vector3 };
  /** Время года (src/game/season.ts): снег на кронах и крышах, лёд на воде, голые лиственные — 0…1. */
  osmSnow: { value: number };
  osmIce: { value: number };
  osmBare: { value: number };
}

export function createOsmUniforms(): OsmUniforms {
  return {
    osmTime: { value: 0 },
    osmNight: { value: 0 },
    osmWind: { value: new THREE.Vector2() },
    osmCam: { value: new THREE.Vector3() },
    osmSnow: { value: 0 },
    osmIce: { value: 0 },
    osmBare: { value: 0 },
  };
}

/** Дальности слоя, м. Полей для дорог и воды в QualitySettings может не быть — тогда от радиуса домов. */
export interface OsmRanges {
  buildingsM: number;
  roadsM: number;
  waterM: number;
  streetLights: boolean;
}

type OptionalRanges = { roadsRadiusM?: number; waterRadiusM?: number; streetLights?: boolean };

export function osmRanges(q: QualitySettings): OsmRanges {
  const x = q as QualitySettings & OptionalRanges;
  const b = q.buildingsRadiusM;
  return {
    buildingsM: b,
    // Узкие дороги дальше нескольких километров — меньше пикселя; вода видна далеко.
    roadsM: x.roadsRadiusM ?? THREE.MathUtils.clamp(b * 0.55, 2500, 7000),
    waterM: x.waterRadiusM ?? THREE.MathUtils.clamp(b, 6000, 12000),
    streetLights: x.streetLights ?? true,
  };
}

// --- хеш ---

/** Детерминированное число [0, 1) по трём целым. */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x61c88647, 0x165667b1) ^ Math.imul((c | 0) + 0x7f4a7c15, 0x2c1b3c6d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]!;
}

// --- геометрия ---

/** Отсечение кольца [e0, n0, …] полуплоскостью a·e + b·n ≤ c. */
export function clipHalf(r: number[], a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pe = r[2 * i]!, pn = r[2 * i + 1]!, qe = r[2 * j]!, qn = r[2 * j + 1]!;
    const fp = a * pe + b * pn - c;
    const fq = a * qe + b * qn - c;
    if (fp <= 0) out.push(pe, pn);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push(pe + t * (qe - pe), pn + t * (qn - pn));
    }
  }
  return out;
}

export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Ломаная с длиной по пути: точки и нормали на заданных расстояниях от начала. Ленты дорог и рек
 * строятся по кускам [a0, a1]; вершины на стыке кусков считаются одинаково — лента без щелей.
 */
export class Polyline {
  readonly n: number;
  readonly cum: Float64Array;
  readonly total: number;

  constructor(readonly line: Float32Array) {
    this.n = line.length >> 1;
    this.cum = new Float64Array(Math.max(1, this.n));
    for (let i = 1; i < this.n; i++) this.cum[i] = this.cum[i - 1]! + Math.hypot(line[2 * i]! - line[2 * i - 2]!, line[2 * i + 1]! - line[2 * i - 1]!);
    this.total = this.cum[this.n - 1] ?? 0;
  }

  /** Номер отрезка, на котором лежит расстояние s. */
  seg(s: number): number {
    let lo = 0;
    let hi = this.n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid]! <= s) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** Точка на расстоянии s: out = [e, n, левая нормаль e, n, множитель ширины]. */
  at(s: number, out: number[], atVertex = -1): number[] {
    const L = this.line;
    if (atVertex > 0 && atVertex < this.n - 1) {
      // В изломе — биссектриса: края ленты параллельны обоим отрезкам.
      const v = atVertex;
      const d0 = this.dir(v - 1), d1 = this.dir(v);
      let tx = d0[0] + d1[0], ty = d0[1] + d1[1];
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) [tx, ty] = d0;
      else {
        tx /= tl;
        ty /= tl;
      }
      const cos = Math.max(0.4, tx * d0[0] + ty * d0[1]);
      out[0] = L[2 * v]!;
      out[1] = L[2 * v + 1]!;
      out[2] = -ty;
      out[3] = tx;
      out[4] = 1 / cos;
      return out;
    }
    const i = this.seg(s);
    const [dx, dy] = this.dir(i);
    const len = this.cum[i + 1]! - this.cum[i]!;
    const t = len > 1e-9 ? (s - this.cum[i]!) / len : 0;
    out[0] = L[2 * i]! + (L[2 * i + 2]! - L[2 * i]!) * t;
    out[1] = L[2 * i + 1]! + (L[2 * i + 3]! - L[2 * i + 1]!) * t;
    out[2] = -dy;
    out[3] = dx;
    out[4] = 1;
    return out;
  }

  private dir(i: number): [number, number] {
    const L = this.line;
    const dx = L[2 * i + 2]! - L[2 * i]!, dy = L[2 * i + 3]! - L[2 * i + 1]!;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? [dx / len, dy / len] : [1, 0];
  }

  /**
   * Станции ленты на [a0, a1] с шагом не больше step: в изломах и между ними.
   * Пишет в out по 6 чисел: s, e, n, нормаль e, n, множитель ширины.
   */
  stations(a0: number, a1: number, step: number, out: number[]): void {
    out.length = 0;
    const tmp: number[] = [0, 0, 0, 0, 0];
    const push = (s: number, vertex: number) => {
      this.at(s, tmp, vertex);
      out.push(s, tmp[0]!, tmp[1]!, tmp[2]!, tmp[3]!, tmp[4]!);
    };
    let i = this.seg(a0);
    push(a0, a0 === this.cum[i] ? i : -1);
    for (; i < this.n - 1 && this.cum[i]! < a1; i++) {
      const s0 = Math.max(a0, this.cum[i]!);
      const s1 = Math.min(a1, this.cum[i + 1]!);
      if (s1 <= s0) continue;
      const k = Math.max(1, Math.ceil((s1 - s0) / step));
      for (let j = 1; j <= k; j++) {
        const s = j === k ? s1 : s0 + ((s1 - s0) * j) / k;
        push(s, j === k && s1 === this.cum[i + 1] ? i + 1 : -1);
      }
    }
  }

  /** Куски по квадратам сетки size: блоки по block м пути, соседние в одном квадрате — вместе. */
  pieces(size: number, block: number, cb: (ix: number, iy: number, a0: number, a1: number) => void): void {
    if (this.n < 2 || !(this.total > 0)) return;
    const tmp: number[] = [0, 0, 0, 0, 0];
    let cur: { ix: number; iy: number; a0: number; a1: number } | null = null;
    const nb = Math.max(1, Math.ceil(this.total / block));
    for (let k = 0; k < nb; k++) {
      const s0 = (this.total * k) / nb;
      const s1 = k === nb - 1 ? this.total : (this.total * (k + 1)) / nb;
      this.at((s0 + s1) / 2, tmp);
      const ix = Math.floor(tmp[0]! / size), iy = Math.floor(tmp[1]! / size);
      if (cur && cur.ix === ix && cur.iy === iy) cur.a1 = s1;
      else {
        if (cur) cb(cur.ix, cur.iy, cur.a0, cur.a1);
        cur = { ix, iy, a0: s0, a1: s1 };
      }
    }
    if (cur) cb(cur.ix, cur.iy, cur.a0, cur.a1);
  }
}

// --- квадраты с ленивой сборкой ---

/** Часть квадрата: объект и доля радиуса слоя, до которой он виден. */
export interface ChunkPart {
  object: THREE.Object3D;
  range: number;
}

/** Сборка квадрата по частям: yield — можно прерваться до следующего кадра. */
export type ChunkBuilder<T> = (items: readonly T[], ix: number, iy: number) => Iterator<unknown, ChunkPart[], unknown>;

interface LazyChunk<T> {
  ix: number;
  iy: number;
  ce: number;
  cn: number;
  items: T[];
  parts: ChunkPart[] | null;
  built: boolean;
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
}

/**
 * Квадраты сетки: строятся по мере приближения камеры (ближние первыми, с бюджетом времени),
 * прячутся за радиусом и освобождаются, когда камера ушла далеко.
 */
export class LazyChunks<T> {
  readonly group = new THREE.Group();
  private readonly chunks: LazyChunk<T>[] = [];
  private readonly byKey = new Map<number, LazyChunk<T>>();
  private job: { chunk: LazyChunk<T>; it: Iterator<unknown, ChunkPart[], unknown> } | null = null;

  constructor(
    readonly size: number,
    private readonly build: ChunkBuilder<T>,
  ) {}

  get count(): number {
    return this.chunks.length;
  }

  /** Сколько квадратов собрано. */
  get built(): number {
    let n = 0;
    for (const c of this.chunks) if (c.built) n++;
    return n;
  }

  addAt(ix: number, iy: number, item: T): void {
    const key = (ix + 32768) * 65536 + (iy + 32768);
    let c = this.byKey.get(key);
    if (!c) {
      c = { ix, iy, ce: (ix + 0.5) * this.size, cn: (iy + 0.5) * this.size, items: [], parts: null, built: false };
      this.byKey.set(key, c);
      this.chunks.push(c);
    }
    c.items.push(item);
  }

  add(e: number, n: number, item: T): void {
    this.addAt(Math.floor(e / this.size), Math.floor(n / this.size), item);
  }

  /** Видимость и сборка: камера (восток, север), радиус слоя, м; сборка — пока performance.now() < deadline. */
  update(ce: number, cn: number, radius: number, deadline: number): void {
    const half = this.size * 0.71;
    const show = radius > 0 ? radius + half : -1;
    const keep = radius > 0 ? radius + 3 * this.size : -1;
    for (const c of this.chunks) {
      if (!c.built) continue;
      const d = Math.hypot(c.ce - ce, c.cn - cn);
      if (d > keep) this.unload(c);
      else for (const p of c.parts!) p.object.visible = d < radius * p.range + half;
    }
    if (this.job && Math.hypot(this.job.chunk.ce - ce, this.job.chunk.cn - cn) > keep) this.job = null;

    while (performance.now() < deadline) {
      if (!this.job) {
        let best: LazyChunk<T> | null = null;
        let bestD = show;
        for (const c of this.chunks) {
          if (c.built) continue;
          const d = Math.hypot(c.ce - ce, c.cn - cn);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (!best) break;
        this.job = { chunk: best, it: this.build(best.items, best.ix, best.iy) };
      }
      const r = this.job.it.next();
      if (!r.done) continue;
      const c = this.job.chunk;
      this.job = null;
      c.built = true;
      c.parts = r.value;
      const d = Math.hypot(c.ce - ce, c.cn - cn);
      for (const p of c.parts) {
        p.object.visible = d < radius * p.range + half;
        p.object.matrixAutoUpdate = false;
        this.group.add(p.object);
      }
    }
  }

  /** Обойти видимые объекты. */
  forEachVisible(cb: (o: THREE.Object3D) => void): void {
    for (const c of this.chunks) if (c.parts) for (const p of c.parts) if (p.object.visible) cb(p.object);
  }

  private unload(c: LazyChunk<T>) {
    for (const p of c.parts ?? []) {
      this.group.remove(p.object);
      disposeObject(p.object);
    }
    c.parts = null;
    c.built = false;
  }

  dispose(): void {
    for (const c of this.chunks) this.unload(c);
    this.job = null;
  }
}
