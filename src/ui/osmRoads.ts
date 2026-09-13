import * as THREE from 'three';
import { bridgeDeckEnds, type OsmBuilding, type OsmRoad } from '../sim/osm';
import { hash3, LazyChunks, Polyline, type ChunkPart, type GroundAt, type OsmUniforms } from './osmShared';

/*
 * Дороги и железные дороги: ленты по рельефу. Узлы — в изломах осевой и через ROAD_STEP_M
 * между ними, высота каждого края — по рельефу плюс ROAD_LIFT_M. Мост — прямой настил между
 * береговыми концами своей цепочки (bridgeDeckEnds: стык линий над руслом не тянет настил к
 * воде); борта и опоры — отдельной бетонной сеткой с записью глубины: настил, нарисованный
 * позже, закрывает опоры сверху, а опоры — то, что за ними. Дороги рисуются после рельефа и
 * воды без записи глубины и со смещением полигонов:
 * не мерцают ни на рельефе, ни друг на друге (в местах пересечения — порядок отрисовки:
 * грунтовые, потом асфальт, главные поверх второстепенных).
 *
 * Покрытие — атлас из четырёх колонок: асфальт с разметкой, асфальт, грунтовка с колеями,
 * железная дорога. Ночью в посёлках — фонари: точки с ореолом вдоль дорог.
 */

/** Сторона квадрата дорог, м. */
const CHUNK_M = 2000;
/** Шаг узлов ленты по длине, м (рельеф — сетка ~20 м). */
const ROAD_STEP_M = 10;
const ROAD_LIFT_M = 0.3;
/** Длина повтора текстуры вдоль дороги, м: штрих осевой 3 м, разрыв 9 м. */
const TILE_M = 12;
/** Шаг фонарей, м. */
const LAMP_STEP_M = 38;
const LAMP_HEIGHT_M = 7;
/** Второстепенные дороги видны до этой доли радиуса. */
const MINOR_RANGE = 0.5;
/** Клетка карты плотности домов, м. */
const TOWN_CELL_M = 100;
/** Опоры моста: шаг от начала линии, м, и просвет под настилом, с которого они ставятся, м. */
const PIER_STEP_M = 45;
const PIER_MIN_CLEARANCE_M = 4;
/** Борт пролёта — на столько ниже настила, м. */
const BRIDGE_SIDE_M = 1.2;

const CLASS_RANK: Record<OsmRoad['cls'], number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5, unclassified: 4, residential: 3, service: 2, track: 1, rail: 0,
};

interface Piece {
  road: number;
  a0: number;
  a1: number;
}

/** Колонка атласа: 0 — асфальт с разметкой, 1 — асфальт, 2 — грунт, 3 — железная дорога. */
function column(r: OsmRoad): number {
  if (r.cls === 'rail') return 3;
  if (!r.paved) return 2;
  return CLASS_RANK[r.cls] >= 6 || (r.cls === 'tertiary' && r.widthM >= 6) ? 0 : 1;
}

const isMajor = (r: OsmRoad) => r.cls === 'rail' || CLASS_RANK[r.cls] >= 5;

/** Порядок отрисовки внутри квадрата: рельсы, грунт, асфальт; главные позже. */
const drawOrder = (r: OsmRoad) => (r.cls === 'rail' ? 0 : r.paved ? 10 + CLASS_RANK[r.cls] : 1 + CLASS_RANK[r.cls] * 0.1);

// --- атлас покрытий ---

const ATLAS_W = 512;
const ATLAS_H = 512;
const COL_W = ATLAS_W / 4;

function roadAtlas(): THREE.DataTexture {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let y = 0; y < ATLAS_H; y++) {
    const v = (y + 0.5) / ATLAS_H;
    for (let x = 0; x < ATLAS_W; x++) {
      const col = Math.floor(x / COL_W);
      const u = ((x % COL_W) + 0.5) / COL_W;
      const n1 = hash3(x, y, 31);
      const n2 = hash3(x >> 3, y >> 3, 32 + col);
      let r: number, g: number, b: number;
      if (col <= 1) {
        // Асфальт: мелкое зерно и заплаты; у края — обочина.
        const a = (col === 0 ? 74 : 86) + n1 * 18 - (n2 < 0.12 ? 10 : 0);
        [r, g, b] = [a, a + 1, a + 3];
        if (u < 0.035 || u > 0.965) [r, g, b] = [128 + n1 * 20, 120 + n1 * 18, 104 + n1 * 14];
        if (col === 0) {
          const line = (u > 0.05 && u < 0.075) || (u > 0.925 && u < 0.95) || (Math.abs(u - 0.5) < 0.012 && v < 0.25);
          if (line) [r, g, b] = [214 + n1 * 20, 214 + n1 * 20, 204 + n1 * 16];
        } else if (u < 0.08 || u > 0.92) {
          // Край без разметки — выкрошен.
          const k = n2 * 0.5;
          [r, g, b] = [r + (128 - r) * k, g + (120 - g) * k, b + (104 - b) * k];
        }
      } else if (col === 2) {
        // Грунтовка: колеи темнее, между ними и по краям — трава.
        [r, g, b] = [132 + n1 * 26, 112 + n1 * 22, 84 + n1 * 18];
        const rut = Math.min(Math.abs(u - 0.28), Math.abs(u - 0.72));
        if (rut < 0.06) [r, g, b] = [r * 0.82, g * 0.8, b * 0.78];
        const grass = Math.abs(u - 0.5) < 0.09 ? 0.75 : u < 0.08 || u > 0.92 ? 0.85 : 0;
        if (grass && n2 < 0.8) [r, g, b] = [r + (96 - r) * grass, g + (112 - g) * grass, b + (62 - b) * grass];
      } else {
        // Железная дорога: щебень, бетонные шпалы через 0.6 м, два рельса.
        [r, g, b] = [118 + n1 * 30, 112 + n1 * 28, 104 + n1 * 26];
        const sleeper = (v * 20) % 1 < 0.32 && u > 0.2 && u < 0.8;
        if (sleeper) [r, g, b] = [150 + n1 * 12, 148 + n1 * 12, 142 + n1 * 12];
        const rail = Math.min(Math.abs(u - 0.31), Math.abs(u - 0.69));
        if (rail < 0.018) [r, g, b] = rail < 0.007 ? [196, 198, 204] : [92, 80, 72];
      }
      const o = (y * ATLAS_W + x) * 4;
      data[o] = Math.max(0, Math.min(255, r));
      data[o + 1] = Math.max(0, Math.min(255, g));
      data[o + 2] = Math.max(0, Math.min(255, b));
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, ATLAS_W, ATLAS_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// --- фонари ---

const LAMP_VERTEX = /* glsl */ `
uniform float osmNight;
uniform float lampScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(1.0, -mv.z);
  float size = lampScale * 10.0 / d;
  gl_PointSize = clamp(size, 2.0, 64.0);
  // Мельче двух пикселей — тусклее, а не меньше: вдали огни не мерцают.
  vA = osmNight * clamp(size / 2.0, 0.25, 1.0) * (1.0 - smoothstep(5000.0, 9000.0, d));
}`;

const LAMP_FRAGMENT = /* glsl */ `
uniform vec3 lampColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float glow = exp(-r2 * 22.0) * 2.4 + exp(-r2 * 4.0) * 0.28;
  gl_FragColor = vec4(lampColor * glow * vA, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Карта плотности домов: «посёлок» — где рядом много домов. */
function townMap(buildings: OsmBuilding[]): (e: number, n: number) => boolean {
  const cells = new Map<number, number>();
  const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (const b of buildings) {
    const m = b.ring.length >> 1;
    if (m < 3) continue;
    let e = 0, n = 0;
    for (let k = 0; k < m; k++) {
      e += b.ring[2 * k]!;
      n += b.ring[2 * k + 1]!;
    }
    const k = key(Math.floor(e / m / TOWN_CELL_M), Math.floor(n / m / TOWN_CELL_M));
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  return (e, n) => {
    const i = Math.floor(e / TOWN_CELL_M), j = Math.floor(n / TOWN_CELL_M);
    let s = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) s += cells.get(key(i + di, j + dj)) ?? 0;
    return s >= 6;
  };
}

export class OsmRoads {
  private readonly chunks: LazyChunks<Piece>;
  private readonly lines: Polyline[];
  private readonly atlas = roadAtlas();
  private readonly material: THREE.MeshLambertMaterial;
  /** Борта и опоры мостов: бетон, с записью глубины. */
  private readonly structureMaterial = new THREE.MeshLambertMaterial({ color: 0x8e8b85, side: THREE.DoubleSide });
  private readonly lampMaterial: THREE.ShaderMaterial;
  private readonly lampScale = { value: 500 };
  private readonly inTown: (e: number, n: number) => boolean;
  /** Высоты концов настила у мостов (bridgeDeckEnds). */
  private readonly deckEnds: ([number, number] | null)[];

  constructor(
    private readonly roads: OsmRoad[],
    buildings: OsmBuilding[],
    private readonly groundAt: GroundAt,
    uniforms: OsmUniforms,
  ) {
    this.material = new THREE.MeshLambertMaterial({ map: this.atlas, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.deckEnds = bridgeDeckEnds(roads, groundAt);
    this.lampMaterial = new THREE.ShaderMaterial({
      vertexShader: LAMP_VERTEX,
      fragmentShader: LAMP_FRAGMENT,
      uniforms: { osmNight: uniforms.osmNight, lampScale: this.lampScale, lampColor: { value: new THREE.Color(1.0, 0.62, 0.3) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.inTown = townMap(buildings);
    this.lines = roads.map((r) => new Polyline(r.line));
    this.chunks = new LazyChunks<Piece>(CHUNK_M, (items, ix, iy) => this.buildChunk(items, ix, iy));
    this.chunks.group.name = 'osm-roads';
    this.lines.forEach((pl, road) => pl.pieces(CHUNK_M, 150, (ix, iy, a0, a1) => this.chunks.addAt(ix, iy, { road, a0, a1 })));
  }

  get group(): THREE.Group {
    return this.chunks.group;
  }

  update(ce: number, cn: number, radius: number, night: number, lights: boolean, deadline: number): void {
    this.chunks.update(ce, cn, radius, deadline);
    // Фонари — только ночью и только в пределах своей дальности (её уже учла видимость квадратов).
    const show = lights && night > 0.02;
    this.chunks.forEachVisible((o) => {
      if (o instanceof THREE.Points) o.visible = show;
    });
  }

  dispose(): void {
    this.chunks.dispose();
    this.material.dispose();
    this.structureMaterial.dispose();
    this.lampMaterial.dispose();
    this.atlas.dispose();
  }

  private *buildChunk(items: readonly Piece[], ix: number, iy: number): Generator<unknown, ChunkPart[], unknown> {
    const sorted = [...items].sort((p, q) => drawOrder(this.roads[p.road]!) - drawOrder(this.roads[q.road]!));
    const major = new Ribbon();
    const minor = new Ribbon();
    const structure = new Ribbon();
    const lamps: number[] = [];
    const st: number[] = [];
    const tmp: number[] = [0, 0, 0, 0, 0];
    for (const p of sorted) {
      const road = this.roads[p.road]!;
      const pl = this.lines[p.road]!;
      pl.stations(p.a0, p.a1, ROAD_STEP_M, st);
      this.ribbon(p.road, pl, st, isMajor(road) ? major : minor);
      if (road.bridge) this.bridgeStructure(p, pl, st, structure, tmp);
      // Фонари: освещённые дороги и асфальт в посёлках; шаг — от начала дороги, без повторов на стыках.
      if (road.cls !== 'rail' && (road.lit || (road.paved && CLASS_RANK[road.cls] >= 3))) {
        for (let s = Math.ceil(p.a0 / LAMP_STEP_M) * LAMP_STEP_M; s < p.a1; s += LAMP_STEP_M) {
          pl.at(s, tmp);
          const e = tmp[0]!, n = tmp[1]!;
          if (!road.lit && !this.inTown(e, n)) continue;
          const side = Math.round(s / LAMP_STEP_M) % 2 ? 1 : -1;
          const off = side * (road.widthM / 2 + 1.5);
          const le = e + tmp[2]! * off, ln = n + tmp[3]! * off;
          lamps.push(le, this.groundAt(le, ln) + LAMP_HEIGHT_M, -ln);
        }
      }
      yield;
    }
    const parts: ChunkPart[] = [];
    const add = (rb: Ribbon, order: number, range: number, name: string) => {
      const geo = rb.geometry();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = name;
      mesh.renderOrder = order;
      mesh.receiveShadow = true;
      parts.push({ object: mesh, range });
    };
    add(minor, 2, MINOR_RANGE, `osm-roads-minor ${ix},${iy}`);
    add(major, 3, 1, `osm-roads ${ix},${iy}`);
    const sgeo = structure.geometry();
    if (sgeo) {
      const mesh = new THREE.Mesh(sgeo, this.structureMaterial);
      mesh.name = `osm-bridges ${ix},${iy}`;
      // Раньше настила: настил без записи глубины ложится поверх опор под собой.
      mesh.renderOrder = 1;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parts.push({ object: mesh, range: 1 });
    }
    if (lamps.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3));
      geo.computeBoundingSphere();
      const pts = new THREE.Points(geo, this.lampMaterial);
      pts.name = `osm-lamps ${ix},${iy}`;
      pts.renderOrder = 5;
      pts.visible = false;
      // Размер ореола в пикселях: высота буфера и поле зрения камеры.
      pts.onBeforeRender = (renderer, _scene, camera) => {
        const h = renderer.getRenderTarget()?.height ?? renderer.getDrawingBufferSize(tmpSize).y;
        this.lampScale.value = (h * camera.projectionMatrix.elements[5]!) / 2;
      };
      parts.push({ object: pts, range: 0.8 });
    }
    return parts;
  }

  private lift(road: OsmRoad): number {
    return ROAD_LIFT_M + (road.cls === 'rail' ? 0 : CLASS_RANK[road.cls] * 0.01);
  }

  /** Высота настила моста ri на расстоянии s от начала линии: прямая между концами цепочки. */
  private deckY(ri: number, pl: Polyline, s: number): number {
    const road = this.roads[ri]!;
    const L = road.line;
    const [y0, y1] = this.deckEnds[ri] ?? [this.groundAt(L[0]!, L[1]!), this.groundAt(L[L.length - 2]!, L[L.length - 1]!)];
    const t = pl.total > 0 ? s / pl.total : 0;
    return y0 + (y1 - y0) * t + this.lift(road) + 0.4;
  }

  /** Лента дороги ri по станциям: край по рельефу; у моста — прямой настил. */
  private ribbon(ri: number, pl: Polyline, st: number[], out: Ribbon) {
    const road = this.roads[ri]!;
    const hw = road.widthM / 2;
    const col = column(road);
    const u0 = (col + 0.04) / 4, u1 = (col + 0.96) / 4;
    const lift = this.lift(road);
    const k = st.length / 6;
    const first = out.nv;
    for (let i = 0; i < k; i++) {
      const s = st[6 * i]!, e = st[6 * i + 1]!, n = st[6 * i + 2]!;
      const nx = st[6 * i + 3]! * hw * st[6 * i + 5]!, ny = st[6 * i + 4]! * hw * st[6 * i + 5]!;
      const le = e + nx, ln = n + ny, re = e - nx, rn = n - ny;
      let yl: number, yr: number;
      if (road.bridge) {
        const y = this.deckY(ri, pl, s);
        yl = Math.max(y, this.groundAt(le, ln) + lift);
        yr = Math.max(y, this.groundAt(re, rn) + lift);
      } else {
        yl = this.groundAt(le, ln) + lift;
        yr = this.groundAt(re, rn) + lift;
      }
      const v = s / TILE_M;
      out.vert(re, yr, -rn, u1, v);
      out.vert(le, yl, -ln, u0, v);
    }
    for (let i = 0; i + 1 < k; i++) {
      const r0 = first + 2 * i, l0 = r0 + 1, r1 = r0 + 2, l1 = r0 + 3;
      out.quad(r0, r1, l1, l0);
    }
  }

  /**
   * Борта пролёта — полосы вниз от краёв настила; опоры — через PIER_STEP_M от начала линии
   * (у куска квадрата — только свои, без повторов на стыках), где под настилом выше
   * PIER_MIN_CLEARANCE_M: над водой и оврагами, не на подходах.
   */
  private bridgeStructure(p: Piece, pl: Polyline, st: number[], out: Ribbon, tmp: number[]) {
    const road = this.roads[p.road]!;
    const hw = road.widthM / 2;
    const lift = this.lift(road);
    const k = st.length / 6;
    for (const side of [1, -1]) {
      const top = out.nv;
      for (let i = 0; i < k; i++) {
        const s = st[6 * i]!;
        const w = side * hw * st[6 * i + 5]!;
        const e = st[6 * i + 1]! + st[6 * i + 3]! * w, n = st[6 * i + 2]! + st[6 * i + 4]! * w;
        const y = Math.max(this.deckY(p.road, pl, s), this.groundAt(e, n) + lift);
        out.vert(e, y, -n, 0, 0);
        out.vert(e, y - BRIDGE_SIDE_M, -n, 0, 0);
      }
      for (let i = 0; i + 1 < k; i++) {
        const t0 = top + 2 * i, b0 = t0 + 1, t1 = t0 + 2, b1 = t0 + 3;
        out.quad(t0, b0, b1, t1);
      }
    }
    const pw = Math.min(hw * 0.7, 6);
    const pt = 1.2;
    const end = pl.total - 8;
    for (let s = Math.ceil(Math.max(p.a0, 8) / PIER_STEP_M) * PIER_STEP_M; s < Math.min(p.a1, end); s += PIER_STEP_M) {
      pl.at(s, tmp);
      const e = tmp[0]!, n = tmp[1]!, nx = tmp[2]!, ny = tmp[3]!;
      const g = this.groundAt(e, n);
      const topY = this.deckY(p.road, pl, s) - BRIDGE_SIDE_M;
      if (topY - g < PIER_MIN_CLEARANCE_M) continue;
      // Поперёк оси — на ширину настила, вдоль — толщина опоры.
      const tx = ny, ty = -nx;
      const corner = (a: number, b: number): [number, number] => [e + nx * pw * a + tx * pt * b, n + ny * pw * a + ty * pt * b];
      const cs = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];
      for (let c = 0; c < 4; c++) {
        const [ae, an] = cs[c]!;
        const [be, bn] = cs[(c + 1) % 4]!;
        const a0 = out.vert(ae, g - 1, -an, 0, 0), b0 = out.vert(be, g - 1, -bn, 0, 0);
        const b1 = out.vert(be, topY, -bn, 0, 0), a1 = out.vert(ae, topY, -an, 0, 0);
        out.quad(a0, b0, b1, a1);
      }
    }
  }
}

const tmpSize = new THREE.Vector2();

/** Растущая лента: позиции, uv, индексы. */
class Ribbon {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  nv = 0;

  vert(x: number, y: number, z: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    return this.nv++;
  }

  /** Четырёхугольник a, b, c, d против часовой стрелки при взгляде сверху. */
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  geometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.nv < 65536 ? new THREE.Uint16BufferAttribute(this.idx, 1) : new THREE.Uint32BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
