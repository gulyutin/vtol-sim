import * as THREE from 'three';
import type { OsmBuilding, OsmData, OsmRunway } from '../sim/osm';
import type { QualitySettings } from './quality';

/*
 * Слой OpenStreetMap в 3D-виде: дома, деревья в лесах, взлётные полосы.
 * Сцена: x — восток, y — вверх (над площадкой взлёта), z — юг (−север).
 *
 * Дома собираются в меши по квадратам 1 км и строятся лениво, с бюджетом времени на кадр.
 * Деревья — два InstancedMesh (хвойные и лиственные) вокруг камеры; набор пересобирается
 * по частям, когда камера сдвинулась на четверть радиуса; у края радиуса деревья плавно
 * уменьшаются до нуля в вершинном шейдере. Полосы — лента по рельефу.
 */

type GroundAt = (east: number, north: number) => number;

/** Сторона квадрата домов, м. */
const CHUNK_M = 1000;
/** Бюджет сборки домов за один вызов update, мс. */
const BUILD_BUDGET_MS = 3;
const MAX_CHUNKS_PER_UPDATE = 2;
/** Бюджет расстановки деревьев за один вызов update, мс. */
const TREE_BUDGET_MS = 3;
/** Всего деревьев не больше. */
const TREE_CAP = 80_000;
/** Ячейка маски леса, м. */
const MASK_CELL_M = 10;
/** Ячеек в маске не больше — иначе ячейка крупнее. */
const MASK_MAX_CELLS = 40e6;
/** Без деревьев вокруг домов и полос, м. */
const CLEAR_M = 12;
/** Поляна вокруг площадки взлёта, м. */
const SITE_CLEAR_M = 30;
/** Доля пропусков в решётке — чтобы лес не был как посадка. */
const TREE_GAP = 0.08;
/** Высота эталонной модели дерева, м. */
const TREE_REF_H = 16;
/** Длина повтора текстуры полосы вдоль оси, м: штрих 30 м, разрыв 20 м. */
const RUNWAY_TILE_M = 50;
const RUNWAY_STEP_M = 15;

// --- хеш ---

/** Детерминированное число [0, 1) по трём целым. */
function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x61c88647, 0x165667b1) ^ Math.imul((c | 0) + 0x7f4a7c15, 0x2c1b3c6d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]!;
}

// --- цвета домов (sRGB) ---

const PLASTER = [0xe4dccb, 0xd8cdb6, 0xefe6d2, 0xd6cfc2, 0xe8d9b5, 0xcfd3cf];
const BRICK = [0xa35a3f, 0x8e4a35, 0xb56d4f, 0xc49a6c];
const PANEL = [0xb9b8b1, 0xa6a9a8, 0xc9c6bb, 0x9ea3a6];
const WOOD = [0x8a6a4a, 0x9b7b58, 0x7a5f45];
const METAL = [0xc0c3c4, 0xa9b0b3, 0xd0cfc8, 0x8f989c];
const WALLS: Record<OsmBuilding['kind'], number[]> = {
  house: [...PLASTER, ...BRICK, ...WOOD],
  apartments: [...PANEL, ...PANEL, ...PLASTER, ...BRICK],
  industrial: [...METAL, ...PANEL, ...PLASTER],
  other: [...PLASTER, ...PANEL, ...BRICK, ...METAL],
};
/** Скатные крыши: тёмно-красная, коричневая, серая, зелёный металл. */
const ROOF_PITCHED = [0x7a2e22, 0x6b4630, 0x6f7275, 0x3f6b4c, 0x5a3a2c, 0x8a8d90];
const ROOF_FLAT = [0x55585b, 0x6a6c6e, 0x7d7f80, 0x4b4d50];
const ROOF_INDUSTRIAL = [...ROOF_FLAT, 0x9a9ea1, 0xa7aaa8];

// --- геометрия домов ---

/** Растущий буфер меша: позиции, нормали (int8), цвета (uint8), индексы. */
class MeshBuf {
  pos = new Float32Array(3 * 4096);
  nor = new Int8Array(3 * 4096);
  col = new Uint8Array(3 * 4096);
  idx = new Uint32Array(6 * 4096);
  nv = 0;
  ni = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, k: number): number {
    const o = this.nv * 3;
    if (o + 3 > this.pos.length) {
      const grow = <T extends Float32Array | Int8Array | Uint8Array>(a: T, make: (n: number) => T): T => {
        const b = make(a.length * 2);
        b.set(a);
        return b;
      };
      this.pos = grow(this.pos, (n) => new Float32Array(n));
      this.nor = grow(this.nor, (n) => new Int8Array(n));
      this.col = grow(this.col, (n) => new Uint8Array(n));
    }
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.nor[o] = Math.round(nx * 127);
    this.nor[o + 1] = Math.round(ny * 127);
    this.nor[o + 2] = Math.round(nz * 127);
    this.col[o] = Math.min(255, Math.round(c.r * k * 255));
    this.col[o + 1] = Math.min(255, Math.round(c.g * k * 255));
    this.col[o + 2] = Math.min(255, Math.round(c.b * k * 255));
    return this.nv++;
  }

  /** Треугольник; обход выбирается так, чтобы лицевая сторона смотрела по (nx, ny, nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    const p = this.pos;
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
    const ux = p[b * 3]! - ax, uy = p[b * 3 + 1]! - ay, uz = p[b * 3 + 2]! - az;
    const vx = p[c * 3]! - ax, vy = p[c * 3 + 1]! - ay, vz = p[c * 3 + 2]! - az;
    const dot = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (this.ni + 3 > this.idx.length) {
      const idx = new Uint32Array(this.idx.length * 2);
      idx.set(this.idx);
      this.idx = idx;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = dot < 0 ? c : b;
    this.idx[this.ni++] = dot < 0 ? b : c;
  }

  geometry(): THREE.BufferGeometry | null {
    if (!this.ni) return null;
    const n = this.nv * 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n), 3, true));
    const idx = this.nv < 65536 ? new Uint16Array(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Отсечение кольца [e0, n0, …] полуплоскостью a·e + b·n ≤ c. */
function clipHalf(r: number[], a: number, b: number, c: number): number[] {
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

/** Наименьший описанный прямоугольник по направлениям рёбер: центр, длинная ось, полуразмеры. */
function orientedBox(xs: Float64Array, ys: Float64Array) {
  const n = xs.length;
  let best: { area: number; ax: number; ay: number; u0: number; u1: number; v0: number; v1: number } | null = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = xs[j]! - xs[i]!;
    const dy = ys[j]! - ys[i]!;
    const len = Math.hypot(dx, dy);
    if (len < 0.3) continue;
    const ax = dx / len, ay = dy / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = xs[k]! * ax + ys[k]! * ay;
      const v = -xs[k]! * ay + ys[k]! * ax;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ax, ay, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ax, ay, u0, u1, v0, v1 } = best;
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const cx = ax * um - ay * vm;
  const cy = ay * um + ax * vm;
  // Длинная ось — вдоль u; если длиннее поперёк, поворачиваем на 90°.
  return u1 - u0 >= v1 - v0
    ? { cx, cy, ax, ay, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2, area: best.area }
    : { cx, cy, ax: -ay, ay: ax, hl: (v1 - v0) / 2, hw: (u1 - u0) / 2, area: best.area };
}

const tmpWall = new THREE.Color();
const tmpRoof = new THREE.Color();
/** Точки контура для triangulateShape (ей нужны Vector2), переиспользуются. */
const vecPool: THREE.Vector2[] = [];

/**
 * Дом: стены по контуру и крыша. Крыша — минимум из плоскостей (одна — плоская; две — двускатная;
 * четыре — вальмовая); стены доходят до крыши, на фронтонах — до конька.
 */
function addBuilding(b: OsmBuilding, groundAt: GroundAt, out: MeshBuf) {
  const src = b.ring;
  const n = src.length >> 1;
  if (n < 3) return;
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += src[2 * j]! * src[2 * i + 1]! - src[2 * i]! * src[2 * j + 1]!;
  if (Math.abs(a2) < 2) return;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = a2 > 0 ? i : n - 1 - i; // против часовой стрелки
    xs[i] = src[2 * k]!;
    ys[i] = src[2 * k + 1]!;
  }
  const area = Math.abs(a2) / 2;

  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i]!;
    cy += ys[i]!;
  }
  cx /= n;
  cy /= n;
  let gMin = groundAt(cx, cy);
  let gMax = gMin;
  for (let i = 0; i < n; i++) {
    const g = groundAt(xs[i]!, ys[i]!);
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
  }
  const base = gMin - 0.5;
  const eave = Math.max(gMin + b.heightM, gMax + Math.min(2, b.heightM * 0.5));

  // Цвета — по хешу контура.
  const seed = Math.round(src[0]! * 10);
  const seed2 = Math.round(src[1]! * 10);
  const h1 = hash3(seed, seed2, n);
  const h2 = hash3(seed2, seed, n + 17);
  const h3 = hash3(seed + n, seed2 - n, 5);
  tmpWall.setHex(pick(WALLS[b.kind], h1)).multiplyScalar(0.94 + 0.12 * h3);

  // Плоскости крыши: y = c0 + ce·восток + cn·север.
  const planes: number[] = [];
  if (b.kind === 'house' && n <= 24 && area < 800) {
    const box = orientedBox(xs, ys);
    if (box && box.hw >= 1.5 && area / box.area > 0.6) {
      const rise = Math.min(3, Math.max(2, box.hw * 0.75));
      const s = rise / box.hw;
      const bx = -box.ay, by = box.ax;
      const plane = (dx: number, dy: number, half: number) =>
        planes.push(eave + s * (half + box.cx * dx + box.cy * dy), -s * dx, -s * dy);
      plane(bx, by, box.hw);
      plane(-bx, -by, box.hw);
      // Вальмовая — у почти квадратных и у части остальных.
      if (box.hl / box.hw < 1.15 || h2 < 0.3) {
        plane(box.ax, box.ay, box.hl);
        plane(-box.ax, -box.ay, box.hl);
      }
    }
  }
  const pitched = planes.length > 0;
  if (!pitched) planes.push(eave, 0, 0);
  const roofColors = b.kind === 'house' ? (pitched ? ROOF_PITCHED : ROOF_FLAT) : b.kind === 'industrial' ? ROOF_INDUSTRIAL : ROOF_FLAT;
  tmpRoof.setHex(pick(roofColors, h2)).multiplyScalar(0.92 + 0.16 * h3);
  const np = planes.length / 3;
  const P = (k: number, e: number, nn: number) => planes[3 * k]! + planes[3 * k + 1]! * e + planes[3 * k + 2]! * nn;
  const roofAt = (e: number, nn: number) => {
    let h = Infinity;
    for (let k = 0; k < np; k++) h = Math.min(h, P(k, e, nn));
    return Math.max(eave, h);
  };

  // Стены: ребро делится там, где меняется плоскость крыши над ним.
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = xs[i]!, y0 = ys[i]!, x1 = xs[j]!, y1 = ys[j]!;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const nx = dy / len, nz = dx / len; // наружу: справа от обхода, z = −север
    ts.length = 0;
    ts.push(0, 1);
    for (let k = 0; k < np; k++) {
      for (let l = k + 1; l < np; l++) {
        const f0 = P(k, x0, y0) - P(l, x0, y0);
        const f1 = P(k, x1, y1) - P(l, x1, y1);
        if ((f0 < 0 && f1 > 0) || (f0 > 0 && f1 < 0)) ts.push(f0 / (f0 - f1));
      }
    }
    ts.sort((p, q) => p - q);
    for (let t = 0; t + 1 < ts.length; t++) {
      const ta = ts[t]!, tb = ts[t + 1]!;
      if (tb - ta < 1e-4) continue;
      const ea = x0 + dx * ta, na = y0 + dy * ta;
      const eb = x0 + dx * tb, nb = y0 + dy * tb;
      const v0 = out.vert(ea, base, -na, nx, 0, nz, tmpWall, 0.8);
      const v1 = out.vert(eb, base, -nb, nx, 0, nz, tmpWall, 0.8);
      const v2 = out.vert(eb, roofAt(eb, nb), -nb, nx, 0, nz, tmpWall, 1);
      const v3 = out.vert(ea, roofAt(ea, na), -na, nx, 0, nz, tmpWall, 1);
      out.tri(v0, v1, v2, nx, 0, nz);
      out.tri(v0, v2, v3, nx, 0, nz);
    }
  }

  // Крыша: каждая плоскость — над своей частью контура.
  const ring: number[] = [];
  for (let i = 0; i < n; i++) ring.push(xs[i]!, ys[i]!);
  const contour: THREE.Vector2[] = [];
  for (let k = 0; k < np; k++) {
    let poly = ring;
    const c0 = planes[3 * k]!, ce = planes[3 * k + 1]!, cn = planes[3 * k + 2]!;
    for (let l = 0; l < np && poly.length >= 6; l++) {
      if (l !== k) poly = clipHalf(poly, ce - planes[3 * l + 1]!, cn - planes[3 * l + 2]!, planes[3 * l]! - c0);
    }
    const m = poly.length / 2;
    if (m < 3) continue;
    contour.length = 0;
    for (let i = 0; i < m; i++) contour.push((vecPool[i] ??= new THREE.Vector2()).set(poly[2 * i]!, poly[2 * i + 1]!));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!faces.length) continue;
    const len = Math.hypot(ce, 1, cn);
    const nx = -ce / len, ny = 1 / len, nz = cn / len;
    const first = out.nv;
    for (let i = 0; i < m; i++) {
      const e = poly[2 * i]!, nn = poly[2 * i + 1]!;
      out.vert(e, c0 + ce * e + cn * nn, -nn, nx, ny, nz, tmpRoof, 1);
    }
    for (const f of faces) out.tri(first + f[0]!, first + f[1]!, first + f[2]!, nx, ny, nz);
  }
}

// --- деревья ---

/** Геометрия эталонного дерева: позиции, нормали, цвета. */
class Geo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];

  /** Треугольник; обход — по средней нормали вершин. */
  tri(p: THREE.Vector3[], nrm: THREE.Vector3[], c: THREE.Color[]) {
    const [a, b, d] = p as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    const avg = new THREE.Vector3();
    for (const v of nrm) avg.add(v);
    const order = face.dot(avg) < 0 ? [0, 2, 1] : [0, 1, 2];
    for (const i of order) {
      const v = p[i]!, nv = nrm[i]!, cv = c[i]!;
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(nv.x, nv.y, nv.z);
      this.col.push(cv.r, cv.g, cv.b);
    }
  }

  /** Ствол — n-угольная призма от y0 до y1. */
  trunk(seg: number, rb: number, rt: number, y0: number, y1: number, c: THREE.Color) {
    const cb = c.clone().multiplyScalar(0.8);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const n0 = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
      const n1 = new THREE.Vector3(Math.cos(a1), 0, Math.sin(a1));
      const b0 = new THREE.Vector3(rb * n0.x, y0, rb * n0.z), b1 = new THREE.Vector3(rb * n1.x, y0, rb * n1.z);
      const t0 = new THREE.Vector3(rt * n0.x, y1, rt * n0.z), t1 = new THREE.Vector3(rt * n1.x, y1, rt * n1.z);
      this.tri([b0, b1, t1], [n0, n1, n1], [cb, cb, c]);
      this.tri([b0, t1, t0], [n0, n1, n0], [cb, c, c]);
    }
  }

  /** Конус хвои с дном. */
  cone(seg: number, r: number, yb: number, yt: number, cBase: THREE.Color, cTop: THREE.Color) {
    const h = yt - yb;
    const apex = new THREE.Vector3(0, yt, 0);
    const centre = new THREE.Vector3(0, yb, 0);
    const down = new THREE.Vector3(0, -1, 0);
    const under = cBase.clone().multiplyScalar(0.6);
    const side = (a: number) => new THREE.Vector3(h * Math.cos(a), r, h * Math.sin(a)).normalize();
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p0 = new THREE.Vector3(r * Math.cos(a0), yb, r * Math.sin(a0));
      const p1 = new THREE.Vector3(r * Math.cos(a1), yb, r * Math.sin(a1));
      this.tri([apex, p0, p1], [side((a0 + a1) / 2), side(a0), side(a1)], [cTop, cBase, cBase]);
      this.tri([centre, p0, p1], [down, down, down], [under, under, under]);
    }
  }

  /** Неровный шар кроны из икосаэдра; нормали — от центра. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, c: THREE.Color, lump: number) {
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const pos = ico.getAttribute('position');
    const pts: THREE.Vector3[] = [];
    const nrm: THREE.Vector3[] = [];
    const cols: THREE.Color[] = [];
    for (let i = 0; i < pos.count; i++) {
      const u = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      const k = 1 + 0.16 * Math.sin(u.x * 5.3 + u.y * 3.1 + u.z * 4.7 + lump);
      pts.push(new THREE.Vector3(cx + u.x * rx * k, cy + u.y * ry * k, cz + u.z * rx * k));
      nrm.push(u);
      cols.push(c.clone().multiplyScalar(0.7 + 0.4 * (u.y + 1) * 0.5));
    }
    for (let i = 0; i + 2 < pts.length; i += 3) this.tri(pts.slice(i, i + 3), nrm.slice(i, i + 3), cols.slice(i, i + 3));
    ico.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Ель: ствол и три конуса; высота TREE_REF_H; 52 треугольника. */
function coniferGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.trunk(5, 0.38, 0.26, 0, 4.2, new THREE.Color(0x4a3728));
  const crown = new THREE.Color(0x2f4b2c);
  const tiers: [number, number, number][] = [
    [2.6, 3.5, 9.4],
    [6.2, 2.8, 12.8],
    [9.6, 2.0, TREE_REF_H],
  ];
  for (const [yb, r, yt] of tiers) g.cone(7, r, yb, yt, crown.clone().multiplyScalar(0.72), crown.clone().multiplyScalar(1.1));
  return g.build();
}

/** Лиственное: ствол и две неровные кроны; высота TREE_REF_H; 50 треугольников. */
function broadleafGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.trunk(5, 0.42, 0.3, 0, 7.5, new THREE.Color(0x5b4a3a));
  const crown = new THREE.Color(0x4e7b35);
  g.blob(0, 10.6, 0, 5.0, 4.4, crown, 0);
  g.blob(1.7, 12.8, -1.1, 3.4, 3.0, crown.clone().multiplyScalar(1.08), 2.1);
  return g.build();
}

/** Маска леса: 0 — нет, 1 — хвойный, 2 — лиственный, 3 — смешанный. */
interface ForestMask {
  e0: number;
  n0: number;
  cell: number;
  w: number;
  h: number;
  data: Uint8Array;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Растеризация лесов (чёт-нечет по всем кольцам леса — дыры пустые), затем поляны у домов и полос. */
function buildForestMask(data: OsmData): ForestMask | null {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const f of data.forests) {
    for (const r of f.rings) {
      for (let i = 0; i + 1 < r.length; i += 2) {
        const e = r[i]!, nn = r[i + 1]!;
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
        if (nn < minN) minN = nn;
        if (nn > maxN) maxN = nn;
      }
    }
  }
  if (!(maxE > minE && maxN > minN)) return null;
  let cell = MASK_CELL_M;
  while (Math.ceil((maxE - minE) / cell + 1) * Math.ceil((maxN - minN) / cell + 1) > MASK_MAX_CELLS) cell *= 1.5;
  const w = Math.ceil((maxE - minE) / cell) + 1;
  const h = Math.ceil((maxN - minN) / cell) + 1;
  const mask: ForestMask = { e0: minE, n0: minN, cell, w, h, data: new Uint8Array(w * h) };
  const d = mask.data;

  for (const f of data.forests) {
    const code = f.leaf === 'needle' ? 1 : f.leaf === 'broad' ? 2 : 3;
    let fMin = Infinity, fMax = -Infinity;
    for (const r of f.rings) {
      for (let i = 1; i < r.length; i += 2) {
        if (r[i]! < fMin) fMin = r[i]!;
        if (r[i]! > fMax) fMax = r[i]!;
      }
    }
    if (!(fMax > fMin)) continue;
    // Строка r — центр ячейки на n0 + (r + 0.5)·cell.
    const r0 = Math.max(0, Math.ceil((fMin - minN) / cell - 0.5));
    const r1 = Math.min(h - 1, Math.ceil((fMax - minN) / cell - 0.5) - 1);
    if (r1 < r0) continue;
    const rows: number[][] = Array.from({ length: r1 - r0 + 1 }, () => []);
    for (const r of f.rings) {
      const m = r.length >> 1;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const xa = r[2 * j]!, ya = r[2 * j + 1]!, xb = r[2 * i]!, yb = r[2 * i + 1]!;
        if (ya === yb) continue;
        const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
        const ra = Math.max(r0, Math.ceil((lo - minN) / cell - 0.5));
        const rb = Math.min(r1, Math.ceil((hi - minN) / cell - 0.5) - 1);
        const k = (xb - xa) / (yb - ya);
        for (let row = ra; row <= rb; row++) rows[row - r0]!.push(xa + (minN + (row + 0.5) * cell - ya) * k);
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const xs = rows[i]!;
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const off = (r0 + i) * w;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k]! - minE) / cell - 0.5));
        const c1 = Math.min(w - 1, Math.floor((xs[k + 1]! - minE) / cell - 0.5));
        if (c1 >= c0) d.fill(code, off + c0, off + c1 + 1);
      }
    }
  }

  const clearBox = (e0: number, n0: number, e1: number, n1: number, keep?: (e: number, n: number) => boolean) => {
    const c0 = Math.max(0, Math.floor((e0 - minE) / cell)), c1 = Math.min(w - 1, Math.floor((e1 - minE) / cell));
    const q0 = Math.max(0, Math.floor((n0 - minN) / cell)), q1 = Math.min(h - 1, Math.floor((n1 - minN) / cell));
    for (let q = q0; q <= q1; q++) {
      if (!keep) {
        if (c1 >= c0) d.fill(0, q * w + c0, q * w + c1 + 1);
        continue;
      }
      const nn = minN + (q + 0.5) * cell;
      for (let c = c0; c <= c1; c++) if (!keep(minE + (c + 0.5) * cell, nn)) d[q * w + c] = 0;
    }
  };
  for (const b of data.buildings) {
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (let i = 0; i + 1 < b.ring.length; i += 2) {
      e0 = Math.min(e0, b.ring[i]!);
      e1 = Math.max(e1, b.ring[i]!);
      n0 = Math.min(n0, b.ring[i + 1]!);
      n1 = Math.max(n1, b.ring[i + 1]!);
    }
    if (e1 >= e0) clearBox(e0 - CLEAR_M, n0 - CLEAR_M, e1 + CLEAR_M, n1 + CLEAR_M);
  }
  for (const rw of data.runways) {
    const reach = rw.widthM / 2 + CLEAR_M;
    for (let i = 0; i + 3 < rw.line.length; i += 2) {
      const ax = rw.line[i]!, ay = rw.line[i + 1]!, bx = rw.line[i + 2]!, by = rw.line[i + 3]!;
      clearBox(Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach, (e, nn) => segDist2(e, nn, ax, ay, bx, by) > reach * reach);
    }
  }
  clearBox(-SITE_CLEAR_M, -SITE_CLEAR_M, SITE_CLEAR_M, SITE_CLEAR_M, (e, nn) => e * e + nn * nn > SITE_CLEAR_M * SITE_CLEAR_M);
  return mask;
}

function maskAt(m: ForestMask, e: number, n: number): number {
  const c = Math.floor((e - m.e0) / m.cell);
  const r = Math.floor((n - m.n0) / m.cell);
  if (c < 0 || r < 0 || c >= m.w || r >= m.h) return 0;
  return m.data[r * m.w + c]!;
}

// --- полосы ---

function runwayTexture(): THREE.CanvasTexture {
  const W = 128, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 62 + Math.floor(hash3(x, y, 11) * 22) + (hash3(x >> 3, y >> 3, 12) < 0.15 ? -8 : 0);
      const o = (y * W + x) * 4;
      img.data[o] = v;
      img.data[o + 1] = v + 2;
      img.data[o + 2] = v + 4;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(236, 236, 228, 0.9)';
  // Осевая: штрих 30 м из 50 м повтора.
  g.fillRect(W / 2 - 2, 0, 4, Math.round((H * 30) / RUNWAY_TILE_M));
  // Боковые линии.
  g.fillRect(4, 0, 3, H);
  g.fillRect(W - 7, 0, 3, H);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Лента полос по рельефу: узлы через RUNWAY_STEP_M вдоль и поперёк, +0.3 м. */
function runwayGeometry(runways: OsmRunway[], groundAt: GroundAt): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const rw of runways) {
    const w = rw.widthM;
    let vOff = 0;
    for (let i = 0; i + 3 < rw.line.length; i += 2) {
      const ax = rw.line[i]!, ay = rw.line[i + 1]!, bx = rw.line[i + 2]!, by = rw.line[i + 3]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const px = -dy, py = dx; // влево
      const nA = Math.max(1, Math.ceil(len / RUNWAY_STEP_M));
      const nC = Math.max(2, Math.ceil(w / RUNWAY_STEP_M));
      const first = pos.length / 3;
      for (let s = 0; s <= nA; s++) {
        const along = (s / nA) * len;
        for (let t = 0; t <= nC; t++) {
          const across = (t / nC - 0.5) * w;
          const e = ax + dx * along + px * across;
          const nn = ay + dy * along + py * across;
          pos.push(e, groundAt(e, nn) + 0.3, -nn);
          uv.push(t / nC, (vOff + along) / RUNWAY_TILE_M);
        }
      }
      // Вдоль, затем поперёк влево — против часовой в (восток, север), лицом вверх.
      for (let s = 0; s < nA; s++) {
        for (let t = 0; t < nC; t++) {
          const v00 = first + s * (nC + 1) + t;
          const v10 = v00 + nC + 1;
          idx.push(v00, v10, v10 + 1, v00, v10 + 1, v00 + 1);
        }
      }
      vOff += len;
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// --- слой ---

interface Chunk {
  ce: number;
  cn: number;
  items: number[];
  mesh: THREE.Mesh | null;
  built: boolean;
}

interface ChunkBuild {
  chunk: Chunk;
  next: number;
  buf: MeshBuf;
}

interface TreePopulation {
  ce: number;
  cn: number;
  rp: number;
  sp: number;
  j: number;
  j1: number;
  /** 0 — подсчёт, 1 — расстановка. */
  phase: 0 | 1;
  count: number;
  keep: number;
  nc: number;
  nb: number;
}

export class OsmLayer {
  readonly group = new THREE.Group();
  private quality: QualitySettings;
  private readonly data: OsmData;
  private readonly groundAt: GroundAt;
  private disposed = false;

  private readonly buildings = new THREE.Group();
  private readonly buildingMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  private readonly chunks: Chunk[] = [];
  private build: ChunkBuild | null = null;

  private mask: ForestMask | null | undefined = undefined;
  private readonly conifers: THREE.InstancedMesh;
  private readonly broadleaves: THREE.InstancedMesh;
  private readonly treeMats: THREE.MeshLambertMaterial[] = [];
  private readonly fade = { osmCam: { value: new THREE.Vector3() }, osmFade: { value: new THREE.Vector2(1e9, 1e9) } };
  /** Промежуточный набор: хвойные с начала, лиственные с конца. */
  private stageM: Float32Array | null = null;
  private stageC: Float32Array | null = null;
  private pop: TreePopulation | null = null;
  private treeCentre: { e: number; n: number } | null = null;
  private treesDirty = true;

  private readonly runwayParts: { mesh: THREE.Mesh; tex?: THREE.Texture }[] = [];

  constructor(data: OsmData, groundAt: (east: number, north: number) => number, quality: QualitySettings) {
    this.data = data;
    this.groundAt = groundAt;
    this.quality = quality;
    this.group.name = 'osm';
    this.buildings.name = 'osm-buildings';
    this.group.add(this.buildings);

    // Дома — по квадратам сетки по среднему вершин.
    const byKey = new Map<string, Chunk>();
    data.buildings.forEach((b, i) => {
      const n = b.ring.length >> 1;
      if (n < 3) return;
      let e = 0, nn = 0;
      for (let k = 0; k < n; k++) {
        e += b.ring[2 * k]!;
        nn += b.ring[2 * k + 1]!;
      }
      const ix = Math.floor(e / n / CHUNK_M), iy = Math.floor(nn / n / CHUNK_M);
      const key = `${ix},${iy}`;
      let c = byKey.get(key);
      if (!c) {
        c = { ce: (ix + 0.5) * CHUNK_M, cn: (iy + 0.5) * CHUNK_M, items: [], mesh: null, built: false };
        byKey.set(key, c);
        this.chunks.push(c);
      }
      c.items.push(i);
    });

    // Деревья.
    const makeTrees = (geo: THREE.BufferGeometry, name: string) => {
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.osmCam = this.fade.osmCam;
        shader.uniforms.osmFade = this.fade.osmFade;
        shader.vertexShader =
          'uniform vec3 osmCam;\nuniform vec2 osmFade;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
#ifdef USE_INSTANCING
  transformed *= 1.0 - smoothstep(osmFade.x, osmFade.y, length(instanceMatrix[3].xz - osmCam.xz));
#endif`,
          );
      };
      mat.customProgramCacheKey = () => 'osm-tree-fade';
      this.treeMats.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, TREE_CAP);
      mesh.name = name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TREE_CAP * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    this.conifers = makeTrees(coniferGeometry(), 'osm-conifers');
    this.broadleaves = makeTrees(broadleafGeometry(), 'osm-broadleaves');

    this.createRunways();
  }

  setQuality(q: QualitySettings): void {
    const old = this.quality;
    this.quality = q;
    if (old.treeRadiusM !== q.treeRadiusM || old.treeSpacingM !== q.treeSpacingM) {
      this.treesDirty = true;
      this.pop = null;
    }
  }

  /** Каждый кадр, позиция камеры в координатах сцены. */
  update(camera: THREE.Vector3): void {
    if (this.disposed) return;
    const ce = camera.x, cn = -camera.z;
    this.updateBuildings(ce, cn);
    this.updateTrees(camera, ce, cn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.chunks) {
      if (c.mesh) c.mesh.geometry.dispose();
      c.mesh = null;
    }
    this.build = null;
    this.buildingMat.dispose();
    for (const m of [this.conifers, this.broadleaves]) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of this.treeMats) m.dispose();
    for (const p of this.runwayParts) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      p.tex?.dispose();
    }
    this.stageM = this.stageC = null;
    this.mask = null;
    this.group.clear();
  }

  // --- дома ---

  private updateBuildings(ce: number, cn: number) {
    const R = this.quality.buildingsRadiusM;
    const show = R > 0 ? R + CHUNK_M : -1;
    const keep = R > 0 ? R + 3 * CHUNK_M : -1;
    const dist = (c: Chunk) => Math.hypot(c.ce - ce, c.cn - cn);
    for (const c of this.chunks) {
      if (!c.built) continue;
      const d = dist(c);
      if (d > keep) {
        if (c.mesh) {
          this.buildings.remove(c.mesh);
          c.mesh.geometry.dispose();
          c.mesh = null;
        }
        c.built = false;
      } else if (c.mesh) c.mesh.visible = d < show;
    }
    if (this.build && dist(this.build.chunk) > keep) this.build = null;

    const deadline = performance.now() + BUILD_BUDGET_MS;
    for (let done = 0; done < MAX_CHUNKS_PER_UPDATE; ) {
      if (!this.build) {
        let best: Chunk | null = null;
        let bestD = show;
        for (const c of this.chunks) {
          if (c.built) continue;
          const d = dist(c);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (!best) break;
        this.build = { chunk: best, next: 0, buf: new MeshBuf() };
      }
      const b = this.build;
      const items = b.chunk.items;
      do addBuilding(this.data.buildings[items[b.next++]!]!, this.groundAt, b.buf);
      while (b.next < items.length && performance.now() < deadline);
      if (b.next < items.length) break;
      this.finishChunk(b, dist(b.chunk) < show);
      this.build = null;
      done++;
      if (performance.now() >= deadline) break;
    }
  }

  private finishChunk(b: ChunkBuild, visible: boolean) {
    const geo = b.buf.geometry();
    b.chunk.built = true;
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, this.buildingMat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = visible;
    b.chunk.mesh = mesh;
    this.buildings.add(mesh);
  }

  // --- деревья ---

  private updateTrees(camera: THREE.Vector3, ce: number, cn: number) {
    const R = this.quality.treeRadiusM;
    if (!(R > 0) || !this.data.forests.length) {
      this.conifers.visible = this.broadleaves.visible = false;
      this.pop = null;
      this.treeCentre = null;
      this.treesDirty = true;
      return;
    }
    this.fade.osmCam.value.copy(camera);
    this.fade.osmFade.value.set(R * 0.72, R);
    if (this.mask === undefined) this.mask = buildForestMask(this.data);
    if (!this.mask) return;
    if (!this.pop) {
      const moved = this.treeCentre ? Math.hypot(ce - this.treeCentre.e, cn - this.treeCentre.n) : Infinity;
      if (this.treesDirty || moved > R / 4) this.pop = this.startPopulation(ce, cn);
    }
    if (this.pop) this.stepPopulation(this.mask, performance.now() + TREE_BUDGET_MS);
  }

  private startPopulation(ce: number, cn: number): TreePopulation {
    this.treesDirty = false;
    const q = this.quality;
    const sp = Math.max(2, q.treeSpacingM);
    // С запасом на сдвиг камеры до следующей пересборки.
    const rp = q.treeRadiusM * 1.25 + 3 * sp + 30;
    return { ce, cn, rp, sp, j: Math.floor((cn - rp) / sp), j1: Math.floor((cn + rp) / sp), phase: 0, count: 0, keep: 1, nc: 0, nb: 0 };
  }

  /** Строки решётки: сначала подсчёт (для прореживания до TREE_CAP), затем расстановка. */
  private stepPopulation(mask: ForestMask, deadline: number) {
    const p = this.pop!;
    const { ce, cn, rp, sp } = p;
    const r2 = rp * rp;
    if (!this.stageM || !this.stageC) {
      this.stageM = new Float32Array(TREE_CAP * 16);
      this.stageC = new Float32Array(TREE_CAP * 3);
    }
    const M = this.stageM, C = this.stageC;
    while (p.j <= p.j1) {
      const j = p.j++;
      const dy = (j + 0.5) * sp - cn;
      const half2 = (rp + sp) * (rp + sp) - dy * dy;
      if (half2 > 0) {
        const half = Math.sqrt(half2);
        const i0 = Math.floor((ce - half) / sp), i1 = Math.floor((ce + half) / sp);
        for (let i = i0; i <= i1; i++) {
          if (hash3(i, j, 3) < TREE_GAP) continue;
          const e = (i + 0.1 + 0.8 * hash3(i, j, 1)) * sp;
          const n = (j + 0.1 + 0.8 * hash3(i, j, 2)) * sp;
          if ((e - ce) * (e - ce) + (n - cn) * (n - cn) > r2) continue;
          const code = maskAt(mask, e, n);
          if (!code) continue;
          if (p.phase === 0) {
            p.count++;
            continue;
          }
          if (p.keep < 1 && hash3(i, j, 4) >= p.keep) continue;
          if (p.nc + p.nb >= TREE_CAP) continue;
          const kr = hash3(i, j, 5);
          const conifer = code === 1 ? kr < 0.9 : code === 2 ? kr < 0.15 : kr < 0.55;
          const k = conifer ? p.nc++ : TREE_CAP - 1 - p.nb++;
          const hr = hash3(i, j, 6);
          const sh = (10 + 14 * hr) / TREE_REF_H;
          const sw = sh * (0.8 + 0.4 * hash3(i, j, 7));
          const a = hash3(i, j, 8) * Math.PI * 2;
          const cs = Math.cos(a), sn = Math.sin(a);
          const o = k * 16;
          M[o] = cs * sw;
          M[o + 1] = 0;
          M[o + 2] = -sn * sw;
          M[o + 3] = 0;
          M[o + 4] = 0;
          M[o + 5] = sh;
          M[o + 6] = 0;
          M[o + 7] = 0;
          M[o + 8] = sn * sw;
          M[o + 9] = 0;
          M[o + 10] = cs * sw;
          M[o + 11] = 0;
          M[o + 12] = e;
          M[o + 13] = this.groundAt(e, n) - 0.2;
          M[o + 14] = -n;
          M[o + 15] = 1;
          const l = 0.78 + 0.4 * hash3(i, j, 9);
          const warm = hash3(i, j, 10);
          C[k * 3] = l * (0.92 + 0.2 * warm);
          C[k * 3 + 1] = l;
          C[k * 3 + 2] = l * (0.97 - 0.12 * warm);
        }
      }
      if (performance.now() >= deadline) return;
    }
    if (p.phase === 0) {
      p.phase = 1;
      p.keep = p.count > TREE_CAP ? TREE_CAP / p.count : 1;
      p.j = Math.floor((cn - rp) / sp);
      return;
    }
    // Готово — переносим в меши.
    const put = (mesh: THREE.InstancedMesh, from: number, count: number) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (!count) return;
      const im = mesh.instanceMatrix;
      (im.array as Float32Array).set(M.subarray(from * 16, (from + count) * 16));
      im.clearUpdateRanges();
      im.addUpdateRange(0, count * 16);
      im.needsUpdate = true;
      const ic = mesh.instanceColor!;
      (ic.array as Float32Array).set(C.subarray(from * 3, (from + count) * 3));
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, count * 3);
      ic.needsUpdate = true;
    };
    put(this.conifers, 0, p.nc);
    put(this.broadleaves, TREE_CAP - p.nb, p.nb);
    this.treeCentre = { e: ce, n: cn };
    this.pop = null;
  }

  // --- полосы ---

  private createRunways() {
    const paved = this.data.runways.filter((r) => r.paved);
    const soft = this.data.runways.filter((r) => !r.paved);
    const pg = runwayGeometry(paved, this.groundAt);
    if (pg) {
      const tex = runwayTexture();
      const mesh = new THREE.Mesh(
        pg,
        new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
      );
      mesh.name = 'osm-runways';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.runwayParts.push({ mesh, tex });
      this.group.add(mesh);
    }
    const sg = runwayGeometry(soft, this.groundAt);
    if (sg) {
      const mesh = new THREE.Mesh(
        sg,
        new THREE.MeshLambertMaterial({
          color: 0xd6e4a8,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      );
      mesh.name = 'osm-strips';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.runwayParts.push({ mesh });
      this.group.add(mesh);
    }
  }
}
