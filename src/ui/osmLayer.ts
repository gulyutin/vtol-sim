import * as THREE from 'three';
import type { OsmData, OsmRunway } from '../sim/osm';
import { addBuilding, createBuildingMaterial, MeshBuf } from './osmBuildings';
import { OsmRoads } from './osmRoads';
import { FarForest, GroundCover } from './osmCover';
import { createOsmUniforms, hash3, LazyChunks, osmRanges, segDist2, type ChunkPart, type GroundAt, type OsmEnv } from './osmShared';
import { OsmWaterLayer } from './osmWater';
import type { QualitySettings } from './quality';

export type { OsmEnv } from './osmShared';

/*
 * Слой OpenStreetMap в 3D-виде: дома, деревья в лесах, дороги, вода, взлётные полосы.
 * Сцена: x — восток, y — вверх (над площадкой взлёта), z — юг (−север).
 *
 * Дома, дороги и вода собираются в меши по квадратам сетки и строятся лениво, ближние первыми,
 * с бюджетом времени на кадр (osmShared.LazyChunks). Деревья — два InstancedMesh (хвойные и
 * лиственные) вокруг камеры; набор пересобирается по частям, когда камера сдвинулась на
 * четверть радиуса; у края радиуса деревья плавно уменьшаются до нуля, в ветер качаются —
 * всё в вершинном шейдере. Полосы — лента по рельефу.
 *
 * Порядок отрисовки: рельеф и всё непрозрачное, затем вода (renderOrder 1), затем дороги
 * без записи глубины (2 — второстепенные, 3 — главные), затем фонари.
 */

/** Сторона квадрата домов, м. */
const CHUNK_M = 1000;
/** Бюджеты сборки за один вызов update, мс: вместе не больше 6 мс, пока подгружается новое место. */
const BUILD_BUDGET_MS = 1.5;
/** Высотки, трубы и башни (от TALL_M) видны в TALL_RANGE раз дальше домов; их мало — квадраты крупнее. */
const TALL_M = 40;
const TALL_RANGE = 2.5;
const TALL_CHUNK_M = 3000;
const TALL_BUDGET_MS = 0.5;
const WATER_BUDGET_MS = 1;
const ROAD_BUDGET_MS = 1;
const TREE_BUDGET_MS = 2.5;
/** Всего деревьев не больше. */
const TREE_CAP = 80_000;
/** Пересборка дальнего леса — не дольше этого за кадр, мс. */
const FAR_BUDGET_MS = 3;
/** Ячейка маски леса, м. */
const MASK_CELL_M = 10;
/** Ячеек в маске не больше — иначе ячейка крупнее. */
const MASK_MAX_CELLS = 40e6;
/** Без деревьев вокруг домов и полос, м. */
const CLEAR_M = 12;
/** Без деревьев по сторонам дорог и рек сверх половины ширины, м. */
const ROAD_CLEAR_M = 2;
/** Поляна вокруг площадки взлёта, м. */
const SITE_CLEAR_M = 30;
/** Доля пропусков в решётке — чтобы лес не был как посадка. */
const TREE_GAP = 0.08;
/** Высота эталонной модели дерева, м. */
const TREE_REF_H = 16;
/** Длина повтора текстуры полосы вдоль оси, м: штрих 30 м, разрыв 20 м. */
const RUNWAY_TILE_M = 50;
const RUNWAY_STEP_M = 15;

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

/**
 * Ель или пихта таёжная: невысокий ствол и пять ярусов узкого конуса — силуэт «свечой»; нижние
 * ярусы темнее (внутри кроны тень), кончики светлее. Высота TREE_REF_H; ~90 треугольников.
 */
function coniferGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.trunk(5, 0.34, 0.2, 0, 3.2, new THREE.Color(0x3f3024));
  const crown = new THREE.Color(0x27402a);
  const tiers: [number, number, number][] = [
    [2.0, 3.0, 7.4],
    [4.6, 2.5, 9.9],
    [7.2, 2.0, 12.2],
    [9.8, 1.45, 14.4],
    [12.3, 0.9, TREE_REF_H],
  ];
  tiers.forEach(([yb, r, yt], i) => {
    const k = 0.62 + 0.09 * i;
    g.cone(8, r, yb, yt, crown.clone().multiplyScalar(k), crown.clone().multiplyScalar(k + 0.45));
  });
  return g.build();
}

/**
 * Берёза или осина: светлый тонкий ствол и крона из четырёх неровных клубов, вытянутая вверх.
 * Высота TREE_REF_H; ~90 треугольников. Осенью цвет кроны меняет цвет экземпляра.
 */
function broadleafGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.trunk(5, 0.3, 0.16, 0, 10.5, new THREE.Color(0xbdb6a6));
  const crown = new THREE.Color(0x4f7a33);
  g.blob(0, 10.4, 0, 3.0, 3.3, crown.clone().multiplyScalar(0.85), 0);
  g.blob(1.4, 12.5, 0.6, 2.4, 2.6, crown, 2.1);
  g.blob(-1.2, 12.1, -0.8, 2.3, 2.5, crown.clone().multiplyScalar(0.95), 4.3);
  g.blob(0.2, 14.3, 0.1, 1.8, 1.8, crown.clone().multiplyScalar(1.12), 1.3);
  return g.build();
}

/**
 * Вершинный шейдер деревьев: у края радиуса дерево уменьшается до нуля; в ветер крона
 * отклоняется по ветру (∝ квадрату высоты над комлем, ∝ размеру дерева) с порывами и
 * покачиванием; фаза — от положения дерева, соседние качаются не в такт.
 */
const TREE_FADE = /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
  transformed *= 1.0 - smoothstep(osmFade.x, osmFade.y, length(instanceMatrix[3].xz - osmCam.xz));
#endif
  // Крона (зелёные вершины): у голых лиственных — вдвое меньше и серо-бурая сетка ветвей.
  vCrown = color.g > color.r * 1.12 ? 1.0 : 0.0;
  vTreeUp = normal.y;
  vTreeP = position;
#ifdef OSM_BROADLEAF
  if (vCrown > 0.5) transformed = mix(transformed, vec3(0.0, 12.0, 0.0) + (transformed - vec3(0.0, 12.0, 0.0)) * 0.72, osmBare);
#endif`;

/** Фрагменты деревьев: снег на кронах сверху, голые ветви лиственных — дырявые серо-бурые. */
const TREE_COLOR = /* glsl */ `#include <color_fragment>
#ifdef OSM_BROADLEAF
  if (vCrown > 0.5 && osmBare > 0.01) {
    float h = fract(sin(dot(floor(vTreeP * 2.6), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    if (h < 0.62 * osmBare) discard;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.26, 0.23), osmBare);
  }
#endif
#ifdef OSM_BROADLEAF
  float snowOn = osmSnow * (1.0 - 0.85 * osmBare);
#else
  float snowOn = osmSnow;
#endif
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.94), snowOn * vCrown * smoothstep(0.1, 0.7, vTreeUp) * 0.8);`;

const TREE_PROJECT = /* glsl */ `vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  float hN = clamp(position.y / ${TREE_REF_H.toFixed(1)}, 0.0, 1.0);
  float ph = dot(instanceMatrix[3].xz, vec2(0.173, 0.291));
  float ws = length(osmWind);
  vec2 dir = ws > 0.05 ? osmWind / ws : vec2(0.0);
  float amp = hN * hN * instanceMatrix[1].y * (0.02 * ws + 0.004 * ws * ws);
  float gust = 0.55 + 0.45 * sin(osmTime * 0.55 + ph * 0.11);
  float sway = gust * 0.7 + 0.3 * sin(osmTime * (1.5 + 0.4 * fract(ph)) + ph);
  mvPosition.xz += dir * amp * sway + vec2(-dir.y, dir.x) * amp * 0.15 * sin(osmTime * 2.3 + ph * 1.7);
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

/**
 * Маска леса: 0 — нет, 1 — хвойный, 2 — лиственный, 3 — смешанный. bare — в тех же ячейках 1, где
 * земля закрыта: дома, дороги, полосы, асфальт площадями — там не растёт трава.
 */
interface ForestMask {
  e0: number;
  n0: number;
  cell: number;
  w: number;
  h: number;
  data: Uint8Array;
  bare: Uint8Array;
}

/** Заливка колец (чёт-нечет — дыры пустые) значением code по центрам ячеек маски (или слоя d). */
function fillRings(mask: ForestMask, rings: readonly Float32Array[], code: number, d: Uint8Array = mask.data) {
  const { e0: minE, n0: minN, cell, w, h } = mask;
  let fMin = Infinity, fMax = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if (r[i]! < fMin) fMin = r[i]!;
      if (r[i]! > fMax) fMax = r[i]!;
    }
  }
  if (!(fMax > fMin)) return;
  // Строка r — центр ячейки на n0 + (r + 0.5)·cell.
  const r0 = Math.max(0, Math.ceil((fMin - minN) / cell - 0.5));
  const r1 = Math.min(h - 1, Math.ceil((fMax - minN) / cell - 0.5) - 1);
  if (r1 < r0) return;
  const rows: number[][] = Array.from({ length: r1 - r0 + 1 }, () => []);
  for (const r of rings) {
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

/** Растеризация лесов, затем вода, поляны у домов и полос, просеки дорог и рек. */
/**
 * Где не расти траве и кустам: вода (озеро, река площадью — контуры с островами), полосы и дороги
 * (осевая линия с шириной и запасом). Решётка по 250 м со списком того, что в клетке.
 */
function waterTest(data: OsmData): (e: number, n: number) => boolean {
  const water = waterAreaTest(data);
  const CELL = 250;
  const lines = new Map<number, { line: ArrayLike<number>; half: number }[]>();
  const key = (i: number, j: number) => i * 100_003 + j;
  const addLine = (line: ArrayLike<number>, widthM: number) => {
    const half = widthM / 2 + 1.5;
    for (let k = 0; k + 3 < line.length; k += 2) {
      const e0 = Math.min(line[k]!, line[k + 2]!) - half, e1 = Math.max(line[k]!, line[k + 2]!) + half;
      const n0 = Math.min(line[k + 1]!, line[k + 3]!) - half, n1 = Math.max(line[k + 1]!, line[k + 3]!) + half;
      for (let i = Math.floor(e0 / CELL); i <= Math.floor(e1 / CELL); i++)
        for (let j = Math.floor(n0 / CELL); j <= Math.floor(n1 / CELL); j++) {
          const kk = key(i, j);
          const seg = { line: [line[k]!, line[k + 1]!, line[k + 2]!, line[k + 3]!], half };
          const l = lines.get(kk);
          if (l) l.push(seg);
          else lines.set(kk, [seg]);
        }
    }
  };
  for (const r of data.runways) addLine(r.line, r.widthM);
  for (const r of data.roads) addLine(r.line, r.widthM);
  return (e, n) => {
    const l = lines.get(key(Math.floor(e / CELL), Math.floor(n / CELL)));
    if (l)
      for (const s of l) {
        const [x0, y0, x1, y1] = s.line as number[];
        const dx = x1! - x0!, dy = y1! - y0!;
        const L2 = dx * dx + dy * dy;
        const f = L2 > 0 ? Math.max(0, Math.min(1, ((e - x0!) * dx + (n - y0!) * dy) / L2)) : 0;
        if ((e - x0! - dx * f) ** 2 + (n - y0! - dy * f) ** 2 < s.half * s.half) return true;
      }
    return water(e, n);
  };
}

/** Точка в воде (озеро, река площадью): решётка по 250 м со списком водоёмов и проверка контуров с островами. */
function waterAreaTest(data: OsmData): (e: number, n: number) => boolean {
  const CELL = 250;
  const bins = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100_003 + j;
  data.water.forEach((w, idx) => {
    const o = w.rings[0];
    if (!o) return;
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (let i = 0; i + 1 < o.length; i += 2) {
      e0 = Math.min(e0, o[i]!);
      e1 = Math.max(e1, o[i]!);
      n0 = Math.min(n0, o[i + 1]!);
      n1 = Math.max(n1, o[i + 1]!);
    }
    for (let i = Math.floor(e0 / CELL); i <= Math.floor(e1 / CELL); i++)
      for (let j = Math.floor(n0 / CELL); j <= Math.floor(n1 / CELL); j++) {
        const k = key(i, j);
        const l = bins.get(k);
        if (l) l.push(idx);
        else bins.set(k, [idx]);
      }
  });
  const inRing = (r: ArrayLike<number>, e: number, n: number) => {
    let inside = false;
    for (let i = 0, j = r.length - 2; i + 1 < r.length; j = i, i += 2) {
      const ei = r[i]!, ni = r[i + 1]!, ej = r[j]!, nj = r[j + 1]!;
      if (ni > n !== nj > n && e < ((ej - ei) * (n - ni)) / (nj - ni) + ei) inside = !inside;
    }
    return inside;
  };
  return (e, n) => {
    const l = bins.get(key(Math.floor(e / CELL), Math.floor(n / CELL)));
    if (!l) return false;
    for (const idx of l) {
      const rings = data.water[idx]!.rings;
      if (inRing(rings[0]!, e, n) && !rings.slice(1).some((h) => inRing(h, e, n))) return true;
    }
    return false;
  };
}

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
  const mask: ForestMask = { e0: minE, n0: minN, cell, w, h, data: new Uint8Array(w * h), bare: new Uint8Array(w * h) };
  const d = mask.data;
  const bare = mask.bare;

  for (const f of data.forests) fillRings(mask, f.rings, f.leaf === 'needle' ? 1 : f.leaf === 'broad' ? 2 : 3);
  for (const wa of data.water) fillRings(mask, wa.rings, 0);
  // Парковки и площади: ни деревьев, ни травы.
  for (const p of data.paved) {
    fillRings(mask, p.rings, 0);
    fillRings(mask, p.rings, 1, bare);
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
    fillRings(mask, [b.ring], 1, bare);
  }
  for (const rw of data.runways) {
    const reach = rw.widthM / 2 + CLEAR_M;
    for (let i = 0; i + 3 < rw.line.length; i += 2) {
      const ax = rw.line[i]!, ay = rw.line[i + 1]!, bx = rw.line[i + 2]!, by = rw.line[i + 3]!;
      clearBox(Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach, (e, nn) => segDist2(e, nn, ax, ay, bx, by) > reach * reach);
    }
  }
  // Просеки: шагом в полъячейки вдоль осевой — ячейки ближе половины ширины с запасом.
  // bareToo — и трава не растёт (дорога, полоса), иначе только деревья (ручей).
  const corridor = (line: Float32Array, half: number, bareToo: boolean) => {
    const reach = half + ROAD_CLEAR_M;
    const step = cell / 2;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i]!, ay = line[i + 1]!, bx = line[i + 2]!, by = line[i + 3]!;
      if (Math.max(ax, bx) + reach < minE || Math.min(ax, bx) - reach > maxE || Math.max(ay, by) + reach < minN || Math.min(ay, by) - reach > maxN) continue;
      const len = Math.hypot(bx - ax, by - ay);
      const k = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s <= k; s++) {
        const e = ax + ((bx - ax) * s) / k, nn = ay + ((by - ay) * s) / k;
        const c0 = Math.max(0, Math.floor((e - reach - minE) / cell)), c1 = Math.min(w - 1, Math.floor((e + reach - minE) / cell));
        const q0 = Math.max(0, Math.floor((nn - reach - minN) / cell)), q1 = Math.min(h - 1, Math.floor((nn + reach - minN) / cell));
        for (let q = q0; q <= q1; q++) {
          const dn = minN + (q + 0.5) * cell - nn;
          for (let c = c0; c <= c1; c++) {
            const de = minE + (c + 0.5) * cell - e;
            if (de * de + dn * dn <= reach * reach) d[q * w + c] = 0;
            if (bareToo && de * de + dn * dn <= half * half + (cell * cell) / 4) bare[q * w + c] = 1;
          }
        }
      }
    }
  };
  for (const r of data.roads) corridor(r.line, r.widthM / 2, true);
  for (const r of data.waterways) corridor(r.line, r.widthM / 2, false);
  for (const rw of data.runways) if (rw.paved) corridor(rw.line, rw.widthM / 2, true);
  clearBox(-SITE_CLEAR_M, -SITE_CLEAR_M, SITE_CLEAR_M, SITE_CLEAR_M, (e, nn) => e * e + nn * nn > SITE_CLEAR_M * SITE_CLEAR_M);
  return mask;
}

function maskAt(m: ForestMask, e: number, n: number, d: Uint8Array = m.data): number {
  const c = Math.floor((e - m.e0) / m.cell);
  const r = Math.floor((n - m.n0) / m.cell);
  if (c < 0 || r < 0 || c >= m.w || r >= m.h) return 0;
  return d[r * m.w + c]!;
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
  /** Время последнего update, мс, — для отладки производительности. */
  lastUpdateMs = 0;
  private quality: QualitySettings;
  private readonly data: OsmData;
  private readonly groundAt: GroundAt;
  private disposed = false;
  private readonly uniforms = createOsmUniforms();

  private readonly buildings: LazyChunks<number>;
  /** Высотки, трубы и башни — отдельно: видны дальше домов. */
  private readonly tall: LazyChunks<number>;
  private readonly buildingMat: THREE.MeshStandardMaterial;
  private readonly facadeAtlas: THREE.Texture;
  private readonly roads: OsmRoads;
  private readonly water: OsmWaterLayer;

  private mask: ForestMask | null | undefined = undefined;
  private readonly conifers: THREE.InstancedMesh;
  private readonly broadleaves: THREE.InstancedMesh;
  private readonly treeMats: THREE.MeshLambertMaterial[] = [];
  private readonly osmFade = { value: new THREE.Vector2(1e9, 1e9) };
  /** Промежуточный набор: хвойные с начала, лиственные с конца. */
  private stageM: Float32Array | null = null;
  private stageC: Float32Array | null = null;
  private pop: TreePopulation | null = null;
  private treeCentre: { e: number; n: number } | null = null;
  private treesDirty = true;

  private readonly runwayParts: { mesh: THREE.Mesh; tex?: THREE.Texture }[] = [];

  /** Осень 0…1: доля пожелтевших лиственных и насколько они жёлтые. */
  private autumn: number;

  constructor(data: OsmData, groundAt: (east: number, north: number) => number, quality: QualitySettings, season: { autumn?: number } = {}) {
    this.autumn = Math.min(1, Math.max(0, season.autumn ?? 0));
    this.data = data;
    this.groundAt = groundAt;
    this.quality = quality;
    this.group.name = 'osm';

    // Дома — по квадратам сетки по среднему вершин.
    const bm = createBuildingMaterial(this.uniforms);
    this.buildingMat = bm.material;
    this.facadeAtlas = bm.atlas;
    this.buildings = new LazyChunks<number>(CHUNK_M, (items) => this.buildBuildings(items));
    this.buildings.group.name = 'osm-buildings';
    this.tall = new LazyChunks<number>(TALL_CHUNK_M, (items) => this.buildBuildings(items));
    this.tall.group.name = 'osm-tall';
    data.buildings.forEach((b, i) => {
      const n = b.ring.length >> 1;
      if (n < 3) return;
      let e = 0, nn = 0;
      for (let k = 0; k < n; k++) {
        e += b.ring[2 * k]!;
        nn += b.ring[2 * k + 1]!;
      }
      (b.heightM >= TALL_M ? this.tall : this.buildings).add(e / n, nn / n, i);
    });
    this.group.add(this.buildings.group);
    this.group.add(this.tall.group);

    this.water = new OsmWaterLayer(data, groundAt, this.uniforms);
    this.group.add(this.water.group);
    this.roads = new OsmRoads(data.roads, data.buildings, groundAt, this.uniforms);
    this.group.add(this.roads.group);

    // Деревья.
    const makeTrees = (geo: THREE.BufferGeometry, name: string) => {
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.osmCam = this.uniforms.osmCam;
        shader.uniforms.osmFade = this.osmFade;
        shader.uniforms.osmTime = this.uniforms.osmTime;
        shader.uniforms.osmWind = this.uniforms.osmWind;
        shader.uniforms.osmSnow = this.uniforms.osmSnow;
        shader.uniforms.osmBare = this.uniforms.osmBare;
        const vary = 'varying float vCrown;\nvarying float vTreeUp;\nvarying vec3 vTreeP;\nuniform float osmSnow;\nuniform float osmBare;\n';
        shader.vertexShader =
          vary +
          'uniform vec3 osmCam;\nuniform vec2 osmFade;\nuniform float osmTime;\nuniform vec2 osmWind;\n' +
          shader.vertexShader.replace('#include <begin_vertex>', TREE_FADE).replace('#include <project_vertex>', TREE_PROJECT);
        shader.fragmentShader = vary + shader.fragmentShader.replace('#include <color_fragment>', TREE_COLOR);
      };
      if (name === 'osm-broadleaves') mat.defines = { OSM_BROADLEAF: '' };
      mat.customProgramCacheKey = () => `osm-tree-${name}`;
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
    // Дальний лес до горизонта и подстилка у камеры (osmCover.ts).
    this.farForest = new FarForest(this.uniforms);
    this.farForest.autumn = this.autumn;
    this.cover = new GroundCover(this.uniforms);
    this.cover.autumn = this.autumn;
    this.group.add(this.farForest.mesh, this.cover.grass, this.cover.bushes);
    this.isWater = waterTest(data);

    this.createRunways();
  }

  private readonly farForest: FarForest;
  private readonly cover: GroundCover;
  private readonly isWater: (e: number, n: number) => boolean;

  setQuality(q: QualitySettings): void {
    const old = this.quality;
    this.quality = q;
    if (old.treeRadiusM !== q.treeRadiusM || old.treeSpacingM !== q.treeSpacingM) {
      this.treesDirty = true;
      this.pop = null;
    }
  }

  /**
   * Каждый кадр: позиция камеры в координатах сцены; env — время, ночь и ветер (без него
   * время идёт по часам, ночь и ветер — прежние).
   */
  update(camera: THREE.Vector3, env?: OsmEnv): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const u = this.uniforms;
    if (env) {
      u.osmTime.value = env.time;
      u.osmNight.value = THREE.MathUtils.clamp(env.nightFactor, 0, 1);
      u.osmWind.value.copy(env.wind);
    } else u.osmTime.value = t0 / 1000;
    u.osmCam.value.copy(camera);
    const ce = camera.x, cn = -camera.z;
    const r = osmRanges(this.quality);
    this.buildings.update(ce, cn, r.buildingsM, performance.now() + BUILD_BUDGET_MS);
    this.tall.update(ce, cn, r.buildingsM * TALL_RANGE, performance.now() + TALL_BUDGET_MS);
    this.water.update(ce, cn, r.waterM, performance.now() + WATER_BUDGET_MS);
    this.roads.update(ce, cn, r.roadsM, u.osmNight.value, r.streetLights, performance.now() + ROAD_BUDGET_MS);
    this.updateTrees(ce, cn);
    const mask = this.mask;
    if (mask) {
      const q = this.quality as QualitySettings & { farTreeRadiusM?: number; farTreeSpacingM?: number; groundCover?: boolean };
      const at = (e: number, n: number) => maskAt(mask, e, n);
      const bareAt = (e: number, n: number) => maskAt(mask, e, n, mask.bare) === 1;
      this.farForest.update(ce, cn, q.treeRadiusM, q.farTreeRadiusM ?? 0, q.farTreeSpacingM ?? 32, at, this.groundAt, performance.now() + FAR_BUDGET_MS);
      if (q.groundCover) this.cover.update(ce, cn, camera.y - this.groundAt(ce, cn), u.osmSnow.value, at, this.groundAt, (e, n) => bareAt(e, n) || this.isWater(e, n));
      else this.cover.grass.visible = this.cover.bushes.visible = false;
    }
    this.lastUpdateMs = performance.now() - t0;
  }

  /** Уровень ближайшей воды у точки (м сцены) — для зеркала; null — рядом воды нет. */
  waterLevelNear(e: number, n: number, radius: number): { y: number; d: number } | null {
    return this.water.levelNear(e, n, radius);
  }

  /** Вода — чтобы спрятать её на время съёмки отражения. */
  get waterGroup(): THREE.Group {
    return this.water.group;
  }

  get reflectionOn(): boolean {
    return this.uniforms.osmReflOn.value > 0.5;
  }

  /** Временно без зеркала (кадр с другой камеры) и обратно. */
  suspendReflection(on: boolean) {
    this.uniforms.osmReflOn.value = on ? 0 : this.uniforms.osmRefl.value ? 1 : 0;
  }

  /** Зеркало воды: текстура отражения, её матрица, уровень воды; tex = null — выключить. */
  setReflection(tex: THREE.Texture | null, matrix: THREE.Matrix4 | null, y: number) {
    const u = this.uniforms;
    u.osmReflOn.value = tex ? 1 : 0;
    u.osmRefl.value = tex;
    if (matrix) u.osmReflMatrix.value.copy(matrix);
    u.osmReflY.value = y;
  }

  /** Время года: снег на кронах и крышах, лёд, голые лиственные; осенняя листва — перекраска деревьев. */
  setSeason(s: { snow: number; ice: number; bare: number; autumn: number }): void {
    this.uniforms.osmSnow.value = s.snow;
    this.uniforms.osmIce.value = s.ice;
    this.uniforms.osmBare.value = s.bare;
    const autumn = Math.min(1, Math.max(0, s.autumn));
    if (Math.abs(autumn - this.autumn) > 0.01) {
      this.autumn = autumn;
      this.treesDirty = true;
      this.farForest.autumn = this.cover.autumn = autumn;
      this.farForest.invalidate();
      this.cover.invalidate();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buildings.dispose();
    this.tall.dispose();
    this.buildingMat.dispose();
    this.facadeAtlas.dispose();
    this.water.dispose();
    this.roads.dispose();
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

  private *buildBuildings(items: readonly number[]): Generator<unknown, ChunkPart[], unknown> {
    const buf = new MeshBuf();
    for (const i of items) {
      addBuilding(this.data.buildings[i]!, this.groundAt, buf);
      yield;
    }
    const geo = buf.geometry();
    if (!geo) return [];
    const mesh = new THREE.Mesh(geo, this.buildingMat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return [{ object: mesh, range: 1 }];
  }

  // --- деревья ---

  private updateTrees(ce: number, cn: number) {
    const R = this.quality.treeRadiusM;
    if (!(R > 0) || !this.data.forests.length) {
      this.conifers.visible = this.broadleaves.visible = false;
      this.pop = null;
      this.treeCentre = null;
      this.treesDirty = true;
      return;
    }
    this.osmFade.value.set(R * 0.72, R);
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
          let r = l * (0.92 + 0.2 * warm);
          let gr = l;
          let b = l * (0.97 - 0.12 * warm);
          // Осень: лиственные желтеют не разом — у каждого своя доля, некоторые уже рыжие.
          if (!conifer && this.autumn > 0) {
            const turn = this.autumn * (0.35 + 0.65 * hash3(i, j, 11));
            const orange = hash3(i, j, 12) < 0.25;
            r *= 1 + turn * (orange ? 4.6 : 3.8);
            gr *= 1 + turn * (orange ? 0.0 : 0.32);
            b *= 1 - turn * 0.6;
          }
          C[k * 3] = r;
          C[k * 3 + 1] = gr;
          C[k * 3 + 2] = b;
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
