import * as THREE from 'three';
import type { OsmBuilding } from '../sim/osm';
import { clipHalf, hash3, pick, type GroundAt, type OsmUniforms } from './osmShared';

/*
 * Дома из OpenStreetMap: стены по контуру с окнами, крыши — плоские или скатные.
 *
 * Окна — из атласа фасадов (4 стиля × 4 × 4 клетки «окно в простенке»): у вершин стен
 * координаты фасада — пролёт вдоль стены и этаж по высоте; шейдер берёт клетку атласа по
 * fract() с явными производными (без швов на границах клеток). Альфа атласа — стекло: оно не
 * окрашивается цветом стены, глаже отражает небо, а ночью часть окон светится тёплым — у каждого
 * окна свой хеш по номеру пролёта и этажа.
 */

/** Стили фасада (номер четверти атласа) и крыша. */
const STYLE_HOUSE = 0;
const STYLE_APARTMENTS = 1;
const STYLE_INDUSTRIAL = 2;
const STYLE_WOOD = 3;
const STYLE_ROOF = 4;

// --- цвета (sRGB) ---

const PLASTER = [0xe4dccb, 0xd8cdb6, 0xefe6d2, 0xd6cfc2, 0xe8d9b5, 0xcfd3cf];
const BRICK = [0xa35a3f, 0x8e4a35, 0xb56d4f, 0xc49a6c];
const PANEL = [0xb9b8b1, 0xa6a9a8, 0xc9c6bb, 0x9ea3a6];
const WOOD = [0x8a6a4a, 0x9b7b58, 0x7a5f45, 0xa08060, 0x6f5a48];
const METAL = [0xc0c3c4, 0xa9b0b3, 0xd0cfc8, 0x8f989c];

/** Крыша: цвет, шероховатость, металличность. */
type RoofPaint = readonly [number, number, number];
/** Скатные: красная и коричневая черепица, оцинковка, зелёный, синий и красный профлист, шифер. */
const ROOF_PITCHED: readonly RoofPaint[] = [
  [0x7a2e22, 0.8, 0],
  [0x6b4630, 0.85, 0],
  [0x7c7f82, 0.5, 0.45],
  [0x3f6b4c, 0.5, 0.3],
  [0x34506e, 0.5, 0.3],
  [0x8c3b2e, 0.5, 0.25],
  [0x5a3a2c, 0.85, 0],
  [0x8a8d90, 0.9, 0],
  [0x9a9da0, 0.45, 0.5],
];
const ROOF_FLAT: readonly RoofPaint[] = [
  [0x55585b, 0.95, 0],
  [0x6a6c6e, 0.95, 0],
  [0x7d7f80, 0.9, 0],
  [0x4b4d50, 0.95, 0],
];
const ROOF_INDUSTRIAL: readonly RoofPaint[] = [...ROOF_FLAT, [0x9a9ea1, 0.5, 0.45], [0xa7aaa8, 0.55, 0.4], [0x6f7a80, 0.5, 0.4]];

// --- буфер меша ---

/** Растущий буфер меша: позиции, нормали (int8), цвета (uint8), координаты и параметры фасада, индексы. */
export class MeshBuf {
  pos = new Float32Array(3 * 4096);
  nor = new Int8Array(3 * 4096);
  col = new Uint8Array(3 * 4096);
  fuv = new Float32Array(2 * 4096);
  finfo = new Uint8Array(4 * 4096);
  idx = new Uint32Array(6 * 4096);
  nv = 0;
  ni = 0;
  /** Параметры фасада для следующих вершин: стиль, этажей (0 — без окон), шероховатость и металличность ×255. */
  style = 0;
  floors = 0;
  rough = 230;
  metal = 0;

  private grow() {
    const cap = this.pos.length / 3 * 2;
    const g = <A extends Float32Array | Int8Array | Uint8Array>(a: A, make: (n: number) => A, k: number): A => {
      const b = make(cap * k);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, (n) => new Float32Array(n), 3);
    this.nor = g(this.nor, (n) => new Int8Array(n), 3);
    this.col = g(this.col, (n) => new Uint8Array(n), 3);
    this.fuv = g(this.fuv, (n) => new Float32Array(n), 2);
    this.finfo = g(this.finfo, (n) => new Uint8Array(n), 4);
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, k: number, u = 0, v = 0): number {
    if ((this.nv + 1) * 3 > this.pos.length) this.grow();
    const o = this.nv * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.nor[o] = Math.round(nx * 127);
    this.nor[o + 1] = Math.round(ny * 127);
    this.nor[o + 2] = Math.round(nz * 127);
    this.col[o] = Math.min(255, Math.round(c.r * k * 255));
    this.col[o + 1] = Math.min(255, Math.round(c.g * k * 255));
    this.col[o + 2] = Math.min(255, Math.round(c.b * k * 255));
    this.fuv[this.nv * 2] = u;
    this.fuv[this.nv * 2 + 1] = v;
    const f = this.nv * 4;
    this.finfo[f] = this.style;
    this.finfo[f + 1] = this.floors;
    this.finfo[f + 2] = this.rough;
    this.finfo[f + 3] = this.metal;
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
    const n = this.nv;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    g.setAttribute('facadeUv', new THREE.BufferAttribute(this.fuv.slice(0, n * 2), 2));
    g.setAttribute('facadeInfo', new THREE.BufferAttribute(this.finfo.slice(0, n * 4), 4, false));
    const idx = n < 65536 ? new Uint16Array(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// --- дом ---

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

type PitchedShape = 'gabled' | 'hipped' | 'skillion';

/** Форма скатной крыши или null — плоская. */
function roofShape(b: OsmBuilding, area: number, n: number, r: number): PitchedShape | null {
  if (b.roof === 'flat') return null;
  if (b.roof === 'gabled') return 'gabled';
  if (b.roof === 'hipped' || b.roof === 'pyramidal') return 'hipped';
  if (b.roof === 'skillion') return 'skillion';
  // Без тега: скатные у жилых домов и мелких построек, плоские у больших, многоэтажных и цехов.
  if (n > 24) return null;
  if (b.kind === 'house') return area < 800 ? (r < 0.3 ? 'hipped' : 'gabled') : null;
  if (b.kind === 'other') return area < 120 ? (r < 0.35 ? 'skillion' : r < 0.8 ? 'gabled' : null) : area < 600 && r < 0.6 ? 'gabled' : null;
  if (b.kind === 'industrial') return area < 500 && r < 0.5 ? 'gabled' : null;
  return null;
}

/**
 * Дом: стены по контуру и крыша. Крыша — минимум из плоскостей (одна — плоская или односкатная;
 * две — двускатная, конёк вдоль длинной стороны; четыре — вальмовая); стены доходят до крыши,
 * на фронтонах — до конька. У вершин стен — координаты фасада для окон.
 */
export function addBuilding(b: OsmBuilding, groundAt: GroundAt, out: MeshBuf) {
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

  // Цвета и стиль — по хешу контура.
  const seed = Math.round(src[0]! * 10);
  const seed2 = Math.round(src[1]! * 10);
  const h1 = hash3(seed, seed2, n);
  const h2 = hash3(seed2, seed, n + 17);
  const h3 = hash3(seed + n, seed2 - n, 5);
  const h4 = hash3(seed - n, seed2 + n, 23);

  let style: number;
  let wall: number;
  let bay: number;
  let windows = true;
  const small = area < 60 || b.heightM <= 3.5;
  if (b.kind === 'house') {
    // В посёлках много деревянных домов: брус и окна с наличниками.
    if (h4 < 0.35) {
      style = STYLE_WOOD;
      wall = pick(WOOD, h1);
    } else {
      style = STYLE_HOUSE;
      wall = pick(h1 < 0.7 ? PLASTER : BRICK, h1 < 0.7 ? h1 / 0.7 : (h1 - 0.7) / 0.3);
    }
    bay = 3.6;
    windows = area >= 20;
  } else if (b.kind === 'apartments') {
    style = STYLE_APARTMENTS;
    wall = pick([...PANEL, ...PANEL, ...PLASTER, ...BRICK], h1);
    bay = 3.0;
  } else if (b.kind === 'industrial') {
    style = STYLE_INDUSTRIAL;
    wall = pick([...METAL, ...PANEL, ...PLASTER], h1);
    bay = 6;
  } else {
    // Прочие: гаражи и сараи — глухие; большие — как цеха или конторы.
    style = b.levels >= 2 ? STYLE_APARTMENTS : STYLE_INDUSTRIAL;
    wall = pick([...PLASTER, ...PANEL, ...BRICK, ...METAL], h1);
    bay = style === STYLE_APARTMENTS ? 3.4 : 6;
    windows = !small;
  }
  tmpWall.setHex(wall).multiplyScalar(0.94 + 0.12 * h3);

  // Этажи: по тегу или по высоте; высота этажа — в разумных пределах, выше последнего — глухая стена.
  const h = b.heightM;
  let floors = b.levels > 0 ? b.levels : style === STYLE_INDUSTRIAL ? Math.max(1, Math.round(h / 6)) : Math.max(1, Math.floor(h / 3));
  const floorH = style === STYLE_INDUSTRIAL ? THREE.MathUtils.clamp(h / floors, 3.5, 8) : THREE.MathUtils.clamp(h / floors, 2.6, 3.6);
  floors = Math.min(floors, Math.floor((eave - gMin) / floorH + 0.3), 250);
  if (!windows) floors = 0;

  // Плоскости крыши: y = c0 + ce·восток + cn·север.
  const planes: number[] = [];
  const shape = roofShape(b, area, n, h2);
  if (shape) {
    const box = orientedBox(xs, ys);
    if (box && box.hw >= 1.2 && area / box.area > 0.6) {
      const big = box.hw > 6;
      const rise = shape === 'skillion' ? Math.min(1.8, box.hw * 0.4) : big ? THREE.MathUtils.clamp(box.hw * 0.5, 2, 5) : THREE.MathUtils.clamp(box.hw * 0.75, 1.5, 3);
      const bx = -box.ay, by = box.ax;
      if (shape === 'skillion') {
        const s = rise / (2 * box.hw);
        planes.push(eave + s * (box.hw + box.cx * bx + box.cy * by), -s * bx, -s * by);
      } else {
        const s = rise / box.hw;
        const plane = (dx: number, dy: number, half: number) => planes.push(eave + s * (half + box.cx * dx + box.cy * dy), -s * dx, -s * dy);
        plane(bx, by, box.hw);
        plane(-bx, -by, box.hw);
        // Вальмовая — у почти квадратных и по форме крыши.
        if (shape === 'hipped' || box.hl / box.hw < 1.15) {
          plane(box.ax, box.ay, box.hl);
          plane(-box.ax, -box.ay, box.hl);
        }
      }
    }
  }
  const pitched = planes.length > 0;
  if (!pitched) planes.push(eave, 0, 0);
  const roofPaints = pitched ? ROOF_PITCHED : b.kind === 'industrial' || b.kind === 'other' ? ROOF_INDUSTRIAL : ROOF_FLAT;
  const paint = pick(roofPaints, hash3(seed, seed2, 91));
  tmpRoof.setHex(paint[0]).multiplyScalar(0.92 + 0.16 * h3);
  const np = planes.length / 3;
  const P = (k: number, e: number, nn: number) => planes[3 * k]! + planes[3 * k + 1]! * e + planes[3 * k + 2]! * nn;
  const roofAt = (e: number, nn: number) => {
    let hh = Infinity;
    for (let k = 0; k < np; k++) hh = Math.min(hh, P(k, e, nn));
    return Math.max(eave, hh);
  };

  // Стены: ребро делится там, где меняется плоскость крыши над ним.
  out.style = style;
  out.rough = 235;
  out.metal = 0;
  const u0 = Math.floor(h1 * 997) * 4;
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = xs[i]!, y0 = ys[i]!, x1 = xs[j]!, y1 = ys[j]!;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const nx = dy / len, nz = dx / len; // наружу: справа от обхода, z = −север
    // Пролётов на стене — целое число, окна по центрам пролётов; короткие стены — глухие.
    const bays = Math.floor(len / bay + 0.3);
    out.floors = bays > 0 ? floors : 0;
    const uw = u0 + i * 5;
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
      const ra = roofAt(ea, na), rb = roofAt(eb, nb);
      const ua = uw + ta * Math.max(1, bays), ub = uw + tb * Math.max(1, bays);
      const v0 = out.vert(ea, base, -na, nx, 0, nz, tmpWall, 0.8, ua, (base - gMin) / floorH);
      const v1 = out.vert(eb, base, -nb, nx, 0, nz, tmpWall, 0.8, ub, (base - gMin) / floorH);
      const v2 = out.vert(eb, rb, -nb, nx, 0, nz, tmpWall, 1, ub, (rb - gMin) / floorH);
      const v3 = out.vert(ea, ra, -na, nx, 0, nz, tmpWall, 1, ua, (ra - gMin) / floorH);
      out.tri(v0, v1, v2, nx, 0, nz);
      out.tri(v0, v2, v3, nx, 0, nz);
    }
  }

  // Крыша: каждая плоскость — над своей частью контура.
  out.style = STYLE_ROOF;
  out.floors = 0;
  out.rough = Math.round(paint[1] * 255);
  out.metal = Math.round(paint[2] * 255);
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

// --- атлас фасадов ---

const ATLAS = 512;
const QUAD = ATLAS / 2;
const CELL = QUAD / 4;

/**
 * Атлас фасадов: четверти — кирпичный или оштукатуренный дом, панельный дом, цех, деревянный дом;
 * в каждой 4 × 4 клетки 64 px (пролёт × этаж). RGB — светлая основа стены (умножается на цвет
 * стены) и окна; A — стекло. Строка 0 — низ (v = 0).
 */
function facadeAtlas(): THREE.DataTexture {
  const data = new Uint8Array(ATLAS * ATLAS * 4);
  const glass = (cx: number, cy: number, r: number, out: number[]) => {
    // Тёмное стекло, сверху светлее (отражение неба); часть окон — со шторами по краям.
    const g = 34 + 26 * cy;
    out[0] = g;
    out[1] = g + 10;
    out[2] = g + 18;
    if (r < 0.55 && (cx < 0.18 || cx > 0.82)) {
      const curtain = r < 0.2 ? [205, 185, 150] : r < 0.4 ? [190, 196, 176] : [214, 204, 196];
      out[0] = curtain[0]! * 0.8;
      out[1] = curtain[1]! * 0.8;
      out[2] = curtain[2]! * 0.8;
    }
    out[3] = 255;
  };
  const px = [0, 0, 0, 0];
  for (let y = 0; y < ATLAS; y++) {
    for (let x = 0; x < ATLAS; x++) {
      const style = (x >= QUAD ? 1 : 0) + (y >= QUAD ? 2 : 0);
      const lx = x % QUAD, ly = y % QUAD;
      const ci = Math.floor(lx / CELL), cj = Math.floor(ly / CELL);
      const cx = ((lx % CELL) + 0.5) / CELL, cy = ((ly % CELL) + 0.5) / CELL;
      const r = hash3(ci, cj, style * 7 + 1);
      const r2 = hash3(ci, cj, style * 7 + 2);
      const noise = hash3(x, y, 3) * 10 - 5;
      let base = 236 + noise;
      px[3] = 0;
      const inRect = (x0: number, x1: number, y0: number, y1: number) => cx >= x0 && cx < x1 && cy >= y0 && cy < y1;
      const wallPx = (v: number) => {
        px[0] = px[1] = px[2] = v;
        px[3] = 0;
      };
      wallPx(base);
      if (style === STYLE_HOUSE) {
        if (inRect(0.28, 0.72, 0.26, 0.3)) wallPx(200);
        else if (inRect(0.3, 0.7, 0.3, 0.74)) {
          const frame = cx < 0.335 || cx > 0.665 || cy < 0.335 || cy > 0.705 || Math.abs(cx - 0.5) < 0.015 || Math.abs(cy - 0.6) < 0.012;
          if (frame) wallPx(250);
          else glass((cx - 0.3) / 0.4, (cy - 0.3) / 0.44, r, px);
        }
      } else if (style === STYLE_WOOD) {
        // Брус: тёмные швы между венцами, волокна.
        const log = (cy * 7) % 1;
        base = 214 + noise * 2 + 14 * Math.sin(cx * 40 + cj * 3) * 0.3 - 60 * Math.max(0, 1 - Math.min(log, 1 - log) / 0.08) * 0.6;
        wallPx(base);
        if (inRect(0.27, 0.73, 0.72, 0.8) && Math.abs(cx - 0.5) < 0.23 - (cy - 0.72) * 2.2) wallPx(248);
        else if (inRect(0.27, 0.73, 0.26, 0.32)) wallPx(245);
        else if (inRect(0.3, 0.7, 0.3, 0.72)) {
          const frame = cx < 0.35 || cx > 0.65 || cy < 0.35 || cy > 0.67 || Math.abs(cx - 0.5) < 0.015;
          if (frame) wallPx(248);
          else glass((cx - 0.3) / 0.4, (cy - 0.3) / 0.42, r, px);
        }
      } else if (style === STYLE_APARTMENTS) {
        // Панели: швы по краям клетки; окна крупнее; у части — балконы.
        if (cx < 0.02 || cy < 0.02) wallPx(176);
        const balcony = r2 < 0.3;
        if (balcony && inRect(0.1, 0.9, 0.04, 0.38)) {
          const rail = Math.abs(((cx * 20) % 1) - 0.5) < 0.12 || cy > 0.34;
          wallPx(rail ? 150 : 196);
        } else if (inRect(0.18, 0.82, 0.3, 0.8)) {
          const frame = cx < 0.205 || cx > 0.795 || cy < 0.325 || cy > 0.775 || Math.abs(cx - 0.5) < 0.012;
          if (frame) wallPx(242);
          else glass((cx - 0.18) / 0.64, (cy - 0.3) / 0.5, r, px);
        }
      } else {
        // Цех: профлист, цоколь, ленточное остекление поверху, у части пролётов — ворота.
        base = 222 + 18 * Math.sin(cx * Math.PI * 2 * 12) + noise;
        wallPx(base);
        if (cy < 0.06) wallPx(150 + noise);
        else if (r2 < 0.22 && cj % 4 === 0 && inRect(0.18, 0.82, 0.06, 0.55)) wallPx(((cy * 30) % 1) < 0.15 ? 120 : 160);
        else if (inRect(0.05, 0.95, 0.62, 0.84)) {
          const mull = ((cx - 0.05) / 0.9) * 4;
          if (Math.abs(mull - Math.round(mull)) < 0.04 || cy < 0.635 || cy > 0.825) wallPx(200);
          else glass(0.5, (cy - 0.62) / 0.22, 1, px);
        }
      }
      const o = (y * ATLAS + x) * 4;
      data[o] = Math.max(0, Math.min(255, px[0]!));
      data[o + 1] = Math.max(0, Math.min(255, px[1]!));
      data[o + 2] = Math.max(0, Math.min(255, px[2]!));
      data[o + 3] = px[3]!;
    }
  }
  const tex = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const FACADE_HEAD = /* glsl */ `
uniform sampler2D osmFacade;
uniform float osmNight;
varying vec2 vFacadeUv;
varying vec4 vFacadeInfo;
float osmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const FACADE_MAP = /* glsl */ `
float fGlass = 0.0;
vec3 fLight = vec3(0.0);
if (vFacadeInfo.x < 3.5) {
  // Клетка атласа: пролёт × этаж; 4 × 4 клетки в четверти стиля.
  vec2 q = vFacadeUv * 0.25;
  vec2 origin = vec2(mod(vFacadeInfo.x, 2.0), floor(vFacadeInfo.x * 0.5)) * 0.5;
  vec2 f = fract(q);
  // Выше последнего этажа и на глухих стенах — простенок у края клетки, без окна.
  float windows = step(0.5, vFacadeInfo.y) * step(vFacadeUv.y, vFacadeInfo.y);
  if (windows < 0.5) f.x = 0.01;
  vec4 t = textureGrad(osmFacade, origin + f * 0.5, dFdx(q) * 0.5, dFdy(q) * 0.5);
  diffuseColor.rgb *= t.rgb;
  fGlass = t.a * windows;
  // Ночью светится часть окон; вдали, где в пикселе несколько окон, — среднее.
  vec2 cellId = floor(vFacadeUv);
  float h = osmHash(cellId);
  float h2 = osmHash(cellId + 17.3);
  float blur = clamp(max(fwidth(vFacadeUv.x), fwidth(vFacadeUv.y)) - 0.5, 0.0, 1.0);
  float lit = mix(step(h, 0.38), 0.38, blur);
  vec3 tint = mix(mix(vec3(1.0, 0.66, 0.34), vec3(0.6, 0.72, 1.0), step(0.86, h2)), vec3(0.95, 0.68, 0.4), blur);
  fLight = lit * tint * mix(0.55 + 0.9 * h2, 1.0, blur);
}
`;

/** Фасады домов: цвет по вершинам, окна из атласа, свет в окнах ночью. */
export function createBuildingMaterial(u: OsmUniforms): { material: THREE.MeshStandardMaterial; atlas: THREE.Texture } {
  const atlas = facadeAtlas();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.osmNight = u.osmNight;
    shader.uniforms.osmFacade = { value: atlas };
    shader.vertexShader =
      'attribute vec2 facadeUv;\nattribute vec4 facadeInfo;\nvarying vec2 vFacadeUv;\nvarying vec4 vFacadeInfo;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFacadeUv = facadeUv;\n  vFacadeInfo = facadeInfo;');
    shader.fragmentShader =
      FACADE_HEAD +
      shader.fragmentShader
        .replace('#include <map_fragment>', FACADE_MAP)
        // Стекло не окрашивается цветом стены (vColor в three — vec4 при любых цветах вершин).
        .replace(
          '#include <color_fragment>',
          '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n  diffuseColor *= mix(vColor, vec4(1.0), fGlass);\n#endif',
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nif (vFacadeInfo.x > 3.5) roughnessFactor = vFacadeInfo.z / 255.0;\nroughnessFactor = mix(roughnessFactor, 0.15, fGlass);',
        )
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vFacadeInfo.w / 255.0 * (1.0 - fGlass);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fGlass * fLight * osmNight * 2.4;');
  };
  material.customProgramCacheKey = () => 'osm-facade';
  return { material, atlas };
}
