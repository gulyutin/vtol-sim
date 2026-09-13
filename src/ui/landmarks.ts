import * as THREE from 'three';
import { toLocal } from '../sim/mission';
import type { OsmData, OsmBuilding } from '../sim/osm';
import type { ClockTowerSpec, Landmark, LandmarkKind } from '../sim/profile';
import { localHourFromSun, type SunPosition } from '../sim/sun';
import type { GeoPoint } from '../sim/types';

/*
 * Ориентиры района — узнаваемые здания процедурными моделями (LocationSpec.landmarks).
 * Модель стоит на рельефе (по самой низкой точке основания), главный фасад — по headingDeg.
 *
 *   clockTower — башня по ярусам (Landmark.tower): высоты, ширины, облицовка, прорези, рёбра
 *                с подсвеченными проёмами, карнизы и ограждения, расширяющийся карниз-«корона»,
 *                циферблаты с ободом и цифрами, завершение — шатёр с рёбрами или стеклянная
 *                пирамида, шпиль с шаром и флюгером. Без описания — классическая башня со
 *                шатром. Стрелки — местное время по положению Солнца; ночью светится то, что
 *                подсвечено у настоящей башни (glow у ярусов, циферблатов и кровли).
 *   museum     — массивный объём с карнизом-выкружкой, трапециевидный «египетский» портал
 *                с парой колонн с раструбными капителями. Дом OSM под ним не рисуется.
 *
 * Оси модели: x — вправо по фасаду, y — вверх, −z — вперёд (куда смотрит фасад).
 */

type GroundAt = (east: number, north: number) => number;

const DEG = Math.PI / 180;

/** Модель заменяет дом OSM, в контур которого попадает её точка; башня встаёт в здание. */
const REPLACES: Record<LandmarkKind, boolean> = { clockTower: false, museum: true };

const DEFAULTS: Record<LandmarkKind, { heightM: number; widthM: number; depthM: number }> = {
  clockTower: { heightM: 50, widthM: 9, depthM: 9 },
  museum: { heightM: 16, widthM: 32, depthM: 40 },
};

function inRing(r: Float32Array, e: number, n: number): boolean {
  let inside = false;
  const m = r.length / 2;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = r[2 * i]!, yi = r[2 * i + 1]!, xj = r[2 * j]!, yj = r[2 * j + 1]!;
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Номера домов OSM, которые заменяют модели (точка модели внутри контура дома). */
export function replacedBuildings(buildings: readonly OsmBuilding[], landmarks: readonly Landmark[], site: GeoPoint): Set<number> {
  const out = new Set<number>();
  const pts = landmarks.filter((l) => REPLACES[l.kind]).map((l) => toLocal(site, l));
  if (!pts.length) return out;
  buildings.forEach((b, i) => {
    const r = b.ring;
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (let k = 0; k < r.length; k += 2) {
      e0 = Math.min(e0, r[k]!);
      e1 = Math.max(e1, r[k]!);
      n0 = Math.min(n0, r[k + 1]!);
      n1 = Math.max(n1, r[k + 1]!);
    }
    for (const p of pts) {
      if (p.east < e0 || p.east > e1 || p.north < n0 || p.north > n1) continue;
      if (inRing(r, p.east, p.north)) {
        out.add(i);
        break;
      }
    }
  });
  return out;
}

/**
 * Классическая башня по высоте и ширине: ствол с поясами, ярус часов, фонарь с арками,
 * шатёр и золочёный шпиль.
 */
export function defaultTower(heightM: number, widthM: number): ClockTowerSpec {
  const w = widthM;
  const stage = w * 1.1;
  const lantern = w * 0.75;
  const roofH = w * 1.3;
  const shaft = Math.max(w * 2, heightM - stage - lantern - roofH - w * 0.9);
  const wall = '#e2d9c6';
  return {
    tiers: [
      { toM: shaft, widthM: w, color: wall, style: 'banded' },
      { toM: shaft + stage, widthM: w, color: wall },
      { toM: shaft + stage + lantern, widthM: w * 0.78, color: wall, style: 'arcaded' },
    ],
    clock: { centerM: shaft + stage * 0.48, diameterM: w * 0.72, faceColor: '#f3ecd8', markColor: '#1c1c1c', handColor: '#121212' },
    top: { kind: 'tent', toM: shaft + stage + lantern + roofH, widthM: w * 0.88, color: '#3d6b5c' },
    spire: { toM: heightM, widthM: 0.5, color: '#d4af4a', ball: true },
  };
}

// --- детали ---

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Стержень между двумя точками (рёбра кровли). */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** Цифры 5 × 7 для циферблата: строки сверху вниз. */
const FONT: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

interface DialStyle {
  face: THREE.Color;
  mark: THREE.Color;
  rim: THREE.Color | null;
  numerals: boolean;
}

/**
 * Циферблат попиксельно (без canvas): фон, обод или кольцо, риски, цифры. Строка 0 текстуры —
 * низ циферблата (v = 0), поэтому «12» — вверху по y.
 */
function dialTexture(s: DialStyle): THREE.Texture {
  const S = 512;
  const data = new Uint8Array(S * S * 4);
  const rgb = (c: THREE.Color) => [c.r, c.g, c.b].map((v) => Math.round(v * 255));
  const f = rgb(s.face);
  const k = rgb(s.mark);
  const rim = s.rim ? rgb(s.rim) : null;
  const put = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const o = (y * S + x) * 4;
    data[o] = c[0]!;
    data[o + 1] = c[1]!;
    data[o + 2] = c[2]!;
    data[o + 3] = 255;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / (S / 2) - 1;
      const dy = (y + 0.5) / (S / 2) - 1;
      const r = Math.hypot(dx, dy);
      // Угол от «12» по часовой; расстояние до ближайшей риски — вдоль окружности.
      const a = Math.atan2(dx, dy);
      const step = (Math.PI * 2) / 60;
      const i = Math.round(a / step);
      const off = Math.abs(a - i * step) * r;
      const big = ((i % 5) + 5) % 5 === 0;
      let c = f;
      if (rim) {
        // С цифрами: тонкие минутные риски у обода, обод по краю.
        if (r > 0.93) c = rim;
        else if (r > 0.84 && r < 0.9 && off < (big ? 0.02 : 0.008)) c = k;
      } else {
        const tick = r > (big ? 0.66 : 0.76) && r < 0.84 && off < (big ? 0.035 : 0.012);
        if (tick || (r > 0.87 && r < 0.93)) c = k;
      }
      put(x, y, c);
    }
  }
  if (s.numerals) {
    const unit = Math.max(2, Math.round(S * 0.012));
    for (let n = 1; n <= 12; n++) {
      const text = String(n);
      const a = (n / 12) * Math.PI * 2;
      const cx = S / 2 + Math.sin(a) * S * 0.345;
      const cy = S / 2 + Math.cos(a) * S * 0.345;
      const total = text.length * 5 * unit + (text.length - 1) * unit;
      let x0 = Math.round(cx - total / 2);
      const yTop = Math.round(cy + 3.5 * unit);
      for (const ch of text) {
        const rows = FONT[ch]!;
        for (let gy = 0; gy < 7; gy++) {
          for (let gx = 0; gx < 5; gx++) {
            if (rows[gy]![gx] !== '1') continue;
            for (let py = 0; py < unit; py++) for (let px = 0; px < unit; px++) put(x0 + gx * unit + px, yTop - (gy + 1) * unit + py, k);
          }
        }
        x0 += 6 * unit;
      }
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Стрелка от оси вверх (на 12): при повороте вокруг z — по циферблату. */
function hand(length: number, width: number, mat: THREE.Material): THREE.Object3D {
  const pivot = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(width, length, width * 0.4), mat);
  m.position.y = length * 0.42;
  pivot.add(m);
  return pivot;
}

interface ClockFace {
  hour: THREE.Object3D;
  minute: THREE.Object3D;
}

/** Материал, который ночью светится: emissiveIntensity = base + k · ночь. */
interface Glow {
  mat: THREE.MeshStandardMaterial;
  base: number;
  k: number;
}

/** Четыре грани: fn строит деталь для грани, смотрящей в −z, группа поворачивает её. */
function onFaces(g: THREE.Group, fn: (face: THREE.Group) => void) {
  for (let i = 0; i < 4; i++) {
    const face = new THREE.Group();
    face.rotation.y = (i * Math.PI) / 2;
    fn(face);
    g.add(face);
  }
}

function clockTower(l: Landmark, faces: ClockFace[], glow: Glow[], textures: THREE.Texture[]): THREE.Group {
  const d = DEFAULTS.clockTower;
  const spec = l.tower ?? defaultTower(l.heightM ?? d.heightM, l.widthM ?? d.widthM);
  const g = new THREE.Group();
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const surface = (color: string, metallic: boolean) => ({ color: new THREE.Color(color), roughness: metallic ? 0.38 : 0.85, metalness: metallic ? 0.65 : 0 });
  const mat = (color: string, metallic = false): THREE.MeshStandardMaterial => {
    const key = `${color}${metallic ? 'm' : ''}`;
    let m = mats.get(key);
    if (!m) mats.set(key, (m = new THREE.MeshStandardMaterial(surface(color, metallic))));
    return m;
  };
  /** Светится ночью: свой материал, в списке подсветки. */
  const lit = (color: string, glowColor: string, k: number, metallic = false): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ ...surface(color, metallic), emissive: new THREE.Color(glowColor), emissiveIntensity: 0 });
    glow.push({ mat: m, base: 0, k });
    return m;
  };
  const dark = mat('#121212');

  // Ярусы: первый — от земли (и на 2 м ниже: на склоне не висит).
  let from = -2;
  for (const t of spec.tiers) {
    const h = t.toM - from;
    const w = t.widthM;
    const color = t.color ?? '#d8d8d8';
    const k = t.glow ?? 0;
    const m = k > 0 && t.style !== 'ribbed' ? lit(color, t.glowColor ?? color, k, t.metallic) : mat(color, t.metallic);
    if (t.style === 'ribbed') {
      // Сердцевина — тёмные проёмы (ночью подсвечены), по граням — рёбра-пилястры.
      const gap = k > 0 ? lit(t.gapColor ?? '#2c2a26', t.gapGlowColor ?? '#ffb060', k) : mat(t.gapColor ?? '#2c2a26');
      g.add(box(w * 0.8, h, w * 0.8, gap, 0, from, 0));
      const n = t.ribs ?? 5;
      const rw = (w / n) * 0.55;
      onFaces(g, (face) => {
        for (let i = 0; i < n; i++) face.add(box(rw, h, w * 0.12, m, -w / 2 + (w * (i + 0.5)) / n, from, -w / 2 + w * 0.06));
      });
    } else if (t.style === 'flared') {
      const tw = t.topWidthM ?? w * 1.1;
      const geo = new THREE.CylinderGeometry(tw / Math.SQRT2, w / Math.SQRT2, h, 4, 1);
      geo.rotateY(Math.PI / 4);
      const fl = new THREE.Mesh(geo, m);
      fl.position.y = from + h / 2;
      fl.castShadow = true;
      g.add(fl);
    } else {
      g.add(box(w, h, w, m, 0, from, 0));
    }
    if (t.style === 'slotted') {
      const s = t.slots ?? { count: 3, widthM: w * 0.07 };
      const sm = mat(s.color ?? '#3b3a36');
      const y0 = Math.max(from, 0) + 1.5;
      const y1 = t.toM - (t.cornice?.heightM ?? 0) - 1.5;
      onFaces(g, (face) => {
        for (let i = 0; i < s.count; i++) face.add(box(s.widthM, y1 - y0, 0.12, sm, -w / 2 + (w * (i + 1)) / (s.count + 1), y0, -w / 2 - 0.02));
      });
    }
    if (t.style === 'banded') {
      const band = mat('#b9ab92');
      for (const q of [1 / 3, 2 / 3]) g.add(box(w * 1.06, 0.6, w * 1.06, band, 0, from + h * q, 0));
      g.add(box(w * 1.14, 0.9, w * 1.14, band, 0, t.toM - 0.9, 0));
    }
    if (t.style === 'arcaded') {
      onFaces(g, (face) => face.add(box(w * 0.3, h * 0.62, 0.3, dark, 0, from + h * 0.18, -w / 2 - 0.02)));
    }
    if (t.cornice) {
      const c = t.cornice;
      g.add(box(c.widthM, c.heightM, c.widthM, mat(c.color ?? color), 0, t.toM - c.heightM, 0));
    }
    if (t.balustrade) {
      // Ограждение площадки по краю карниза: поручень, средняя перекладина, стойки.
      const bw = (t.cornice?.widthM ?? w) - 0.3;
      const bh = t.balustrade.heightM;
      const bm = mat(t.balustrade.color ?? '#d8dadc', true);
      const posts = Math.max(2, Math.round(bw / 1.2));
      onFaces(g, (face) => {
        face.add(box(bw, 0.08, 0.08, bm, 0, t.toM + bh - 0.08, -bw / 2));
        face.add(box(bw, 0.05, 0.05, bm, 0, t.toM + bh * 0.45, -bw / 2));
        for (let i = 0; i < posts; i++) face.add(box(0.06, bh, 0.06, bm, -bw / 2 + (bw * i) / posts, t.toM, -bw / 2));
      });
    }
    from = t.toM;
  }
  const top0 = from;

  // Часы: панель, циферблаты и стрелки на четырёх гранях.
  const c = spec.clock;
  const tierAt = spec.tiers.find((t) => t.toM >= c.centerM) ?? spec.tiers[spec.tiers.length - 1]!;
  let faceOff = tierAt.widthM / 2;
  if (c.panel) {
    const p = c.panel;
    g.add(box(p.widthM, p.toM - p.fromM, p.widthM, mat(p.color ?? '#16181b'), 0, p.fromM, 0));
    faceOff = Math.max(faceOff, p.widthM / 2);
  }
  const tex = dialTexture({
    face: new THREE.Color(c.faceColor ?? '#f3ecd8'),
    mark: new THREE.Color(c.markColor ?? '#1c1c1c'),
    rim: c.rimColor ? new THREE.Color(c.rimColor) : null,
    numerals: !!c.numerals,
  });
  textures.push(tex);
  // Светятся светлые элементы (карта свечения — сам циферблат), тёмный фон — нет.
  const dialMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, emissive: 0xfff2c8, emissiveMap: tex, emissiveIntensity: 0.05, roughness: 0.5 });
  glow.push({ mat: dialMat, base: 0.05, k: c.glow ?? 1.4 });
  const handMat = mat(c.handColor ?? '#121212', true);
  const r = c.diameterM / 2;
  onFaces(g, (face) => {
    const at = new THREE.Group();
    at.position.set(0, c.centerM, -(faceOff + 0.05));
    at.rotation.y = Math.PI;
    at.add(new THREE.Mesh(new THREE.CircleGeometry(r, 64), dialMat));
    const hour = hand(r * 0.55, r * 0.08, handMat);
    const minute = hand(r * 0.85, r * 0.05, handMat);
    hour.position.z = 0.05;
    minute.position.z = 0.1;
    at.add(hour, minute);
    face.add(at);
    faces.push({ hour, minute });
  });

  // Завершение.
  let peak = top0;
  const tp = spec.top;
  if (tp) {
    const radius = tp.widthM / Math.SQRT2;
    let base = top0;
    const color = tp.color ?? (tp.kind === 'glassPyramid' ? '#e6eef3' : '#3d6b5c');
    let roofMat: THREE.MeshStandardMaterial;
    if (tp.kind === 'glassPyramid') {
      roofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.12, metalness: 0.55, emissive: new THREE.Color(color), emissiveIntensity: 0 });
      glow.push({ mat: roofMat, base: 0, k: tp.glow ?? 0.8 });
      if (tp.wallToM && tp.wallToM > base) {
        g.add(box(tp.widthM, tp.wallToM - base, tp.widthM, roofMat, 0, base, 0));
        base = tp.wallToM;
      }
    } else if (tp.glow) {
      roofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.45, emissive: new THREE.Color(color), emissiveIntensity: 0 });
      glow.push({ mat: roofMat, base: 0, k: tp.glow });
    } else roofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.45 });
    const roof = new THREE.Mesh(new THREE.ConeGeometry(radius, tp.toM - base, 4, 1), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = base + (tp.toM - base) / 2;
    roof.castShadow = true;
    g.add(roof);
    if (tp.ribColor) {
      // Светлые рёбра по углам и серединам скатов — чуть над поверхностью.
      const rm = mat(tp.ribColor, true);
      const apex = new THREE.Vector3(0, tp.toM + 0.05, 0);
      const hw = tp.widthM / 2 + 0.05;
      for (const [x, z] of [[hw, hw], [-hw, hw], [hw, -hw], [-hw, -hw], [0, hw], [0, -hw], [hw, 0], [-hw, 0]] as const) {
        g.add(rod(new THREE.Vector3(x, base, z), apex, 0.07, rm));
      }
    }
    peak = tp.toM;
  }
  const sp = spec.spire;
  if (sp && sp.toM > peak) {
    const m = mat(sp.color ?? '#d4af4a', true);
    // Шпиль начинается чуть ниже вершины завершения — без щели.
    const s0 = peak - 1;
    const pole = new THREE.Mesh(new THREE.ConeGeometry(sp.widthM / 2, sp.toM - s0, 8), m);
    pole.position.y = s0 + (sp.toM - s0) / 2;
    g.add(pole);
    if (sp.ball) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.4, sp.widthM), 12, 8), m);
      ball.position.y = s0 + (sp.toM - s0) * 0.35;
      g.add(ball);
    }
    if (sp.vane) g.add(box(1.0, 0.55, 0.04, m, 0.5, sp.toM - 1.6, 0));
  }
  return g;
}

/** Трапеция в плоскости xy (шире внизу), вытянутая по z на depth, передом к −z. */
function trapezoid(bottom: number, top: number, height: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(-bottom / 2, 0);
  s.lineTo(bottom / 2, 0);
  s.lineTo(top / 2, height);
  s.lineTo(-top / 2, height);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const std = (color: number, roughness = 0.85, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

function museum(l: Landmark): THREE.Group {
  const d = DEFAULTS.museum;
  const h = l.heightM ?? d.heightM;
  const W = l.widthM ?? d.widthM;
  const D = l.depthM ?? d.depthM;
  const g = new THREE.Group();
  const wall = std(0xdcb98e);
  const trim = std(0xb88f62);
  const band = std(0x8a5a3c);
  const glass = std(0x2a3036, 0.35, 0.2);
  const dark = std(0x241d18);

  // Объём и карниз-выкружка (два уступа наружу).
  g.add(box(W, h + 2, D, wall, 0, -2, 0));
  g.add(box(W + 0.8, 0.9, D + 0.8, trim, 0, h - 0.9, 0));
  g.add(box(W + 1.6, 0.7, D + 1.6, trim, 0, h, 0));
  // Окна: ряды по бокам и по фасаду вне портала.
  const floors = Math.max(2, Math.round(h / 5));
  const fh = h / floors;
  for (let f = 0; f < floors; f++) {
    const y = f * fh + fh * 0.3;
    for (let x = -W / 2 + 2.5; x <= W / 2 - 2.5; x += 3.2) {
      if (Math.abs(x) < W * 0.28) continue;
      g.add(box(1.4, fh * 0.45, 0.2, glass, x, y, -D / 2 - 0.05));
      g.add(box(1.4, fh * 0.45, 0.2, glass, x, y, D / 2 + 0.05));
    }
    for (let z = -D / 2 + 3; z <= D / 2 - 3; z += 3.4) {
      g.add(box(0.2, fh * 0.45, 1.4, glass, -W / 2 - 0.05, y, z));
      g.add(box(0.2, fh * 0.45, 1.4, glass, W / 2 + 0.05, y, z));
    }
  }
  // Портал-пилон: трапеция выше объёма, выступает вперёд; поверху — карниз и тёмный пояс.
  const pw = W * 0.5;
  const ph = h * 1.3;
  const pd = 5;
  const pz = -D / 2 - pd / 2 + 1.5;
  const pylon = trapezoid(pw, pw * 0.84, ph, pd, wall);
  pylon.position.set(0, -2, pz);
  g.add(pylon);
  g.add(box(pw * 0.9, 1.1, pd + 0.8, trim, 0, ph - 2.6, pz));
  g.add(box(pw * 0.92, 0.9, pd + 1.2, trim, 0, ph - 1.5, pz));
  g.add(box(pw * 0.7, 0.7, 0.2, band, 0, ph - 4.3, pz - pd / 2 - 0.06));
  // Проём портала и две колонны с раструбными («папирусными») капителями.
  const doorW = pw * 0.46;
  const doorH = ph * 0.62;
  g.add(box(doorW, doorH, 0.6, dark, 0, 0, pz - pd / 2 + 0.2));
  const colH = doorH - 1.2;
  for (const x of [-doorW * 0.24, doorW * 0.24]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, colH, 16), wall);
    col.position.set(x, colH / 2, pz - pd / 2 - 0.9);
    col.castShadow = true;
    g.add(col);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 0.75, 1.3, 16), trim);
    cap.position.set(x, colH + 0.65, pz - pd / 2 - 0.9);
    g.add(cap);
  }
  g.add(box(doorW + 1, 0.9, 2.2, trim, 0, colH + 1.3, pz - pd / 2 - 0.6));
  // Ступени.
  g.add(box(doorW + 3, 0.5, 3, trim, 0, -0.3, pz - pd / 2 - 1.8));
  return g;
}

export interface LandmarkClock {
  /** Дата района (уравнение времени) и часовой пояс. */
  date: Date;
  utcOffsetH: number;
}

export class Landmarks {
  readonly group = new THREE.Group();
  private readonly faces: ClockFace[] = [];
  private readonly glow: Glow[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor(
    private readonly list: readonly Landmark[],
    private readonly site: GeoPoint,
    groundAt: GroundAt,
    private readonly clock: LandmarkClock,
  ) {
    this.group.name = 'landmarks';
    for (const l of list) {
      const model = l.kind === 'clockTower' ? clockTower(l, this.faces, this.glow, this.textures) : museum(l);
      const p = toLocal(site, l);
      // По самой низкой точке основания: на склоне модель не висит.
      const d = DEFAULTS[l.kind];
      const hw = (l.widthM ?? d.widthM) / 2;
      const hd = (l.depthM ?? l.widthM ?? d.depthM) / 2;
      let ground = Infinity;
      for (const [a, b] of [[0, 0], [hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd]] as const) ground = Math.min(ground, groundAt(p.east + a, p.north + b));
      model.position.set(p.east, ground, -p.north);
      model.rotation.y = -(l.headingDeg ?? 0) * DEG;
      model.name = `landmark-${l.kind}`;
      this.group.add(model);
    }
  }

  get count(): number {
    return this.list.length;
  }

  /** Данные OSM без домов, которые заменяют модели. */
  withoutReplaced(data: OsmData): OsmData {
    const hide = replacedBuildings(data.buildings, this.list, this.site);
    return hide.size ? { ...data, buildings: data.buildings.filter((_, i) => !hide.has(i)) } : data;
  }

  /** Стрелки — местное время по Солнцу. */
  setSun(sun: SunPosition) {
    if (!this.faces.length) return;
    this.setTime(localHourFromSun(sun, this.site, this.clock.date, this.clock.utcOffsetH));
  }

  /** Время на часах, ч. */
  setTime(hour: number) {
    const h12 = ((hour % 12) + 12) % 12;
    const min = (((hour * 60) % 60) + 60) % 60;
    for (const f of this.faces) {
      f.hour.rotation.z = -(h12 / 12) * Math.PI * 2;
      f.minute.rotation.z = -(min / 60) * Math.PI * 2;
    }
  }

  /** Ночная подсветка (0 — день, 1 — ночь). */
  update(nightFactor: number) {
    for (const g of this.glow) g.mat.emissiveIntensity = g.base + g.k * nightFactor;
  }

  dispose() {
    const mats = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        mats.add(o.material as THREE.Material);
      }
    });
    for (const m of mats) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
