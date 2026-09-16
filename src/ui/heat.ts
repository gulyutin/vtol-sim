import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LocalPoint } from '../sim/timeline';

/*
 * Тёплые тела для поиска людей тепловизором: человек и звери (ложные цели). В обычном 3D-виде —
 * простые низкополигональные модели естественных цветов в натуральную величину; в тепловом
 * кадре (thermal.ts) те же меши рисуются «горячим» материалом по атрибуту heat вершин.
 * Модели: начало — на земле под серединой тела, нос (лицо) — к −Z, вверх — +Y.
 * Модуль без DOM — модели и помощники проверяются тестами в node.
 */

export type BodyHeatKind = 'person' | 'bear' | 'wolf' | 'moose' | 'deer';
/** Лесопожарный патруль (src/game/fire.ts): огонь, угли и ложные цели. */
export type FireHeatKind = 'flame' | 'ember' | 'rocks' | 'hut';
export type HeatKind = BodyHeatKind | FireHeatKind;
export type HeatPose = 'standing' | 'sitting' | 'lying' | 'walking';

export interface HeatBody {
  id: number;
  kind: HeatKind;
  /** Локальные метры от площадки, как всё в World. */
  east: number;
  north: number;
  /** Направление тела, градусы от севера. */
  headingDeg: number;
  pose?: HeatPose;
  /** 0…1 — фаза шага для ходьбы. */
  phase?: number;
}

export const HEAT_KINDS: readonly BodyHeatKind[] = ['person', 'bear', 'wolf', 'moose', 'deer'];
export const FIRE_HEAT_KINDS: readonly FireHeatKind[] = ['flame', 'ember', 'rocks', 'hut'];
/** Эти модели не кладутся по склону: огонь и сруб стоят отвесно. */
const UPRIGHT_KINDS = new Set<HeatKind>(['flame', 'hut']);

/**
 * Натуральные габариты стоя, м. Звери: длина — от носа до хвоста, высота — в холке (голова и рога
 * выше). Человек: рост и ширина в плечах; длина — толщина тела.
 */
export const HEAT_SIZE: Readonly<Record<HeatKind, { lengthM: number; heightM: number; widthM: number }>> = {
  person: { lengthM: 0.3, heightM: 1.75, widthM: 0.5 },
  bear: { lengthM: 2.0, heightM: 1.0, widthM: 0.72 },
  wolf: { lengthM: 1.3, heightM: 0.8, widthM: 0.32 },
  moose: { lengthM: 2.8, heightM: 2.0, widthM: 0.76 },
  deer: { lengthM: 1.6, heightM: 1.1, widthM: 0.34 },
  // Огонь и ложные цели патруля: кострище кромки, тлеющее место, развал камней, зимовье с трубой.
  flame: { lengthM: 3.2, heightM: 2.4, widthM: 3.2 },
  ember: { lengthM: 1.4, heightM: 0.5, widthM: 1.2 },
  rocks: { lengthM: 6, heightM: 1.8, widthM: 4.5 },
  hut: { lengthM: 4.6, heightM: 4.2, widthM: 4.2 },
};

/** Дальше этого от камеры 3D-вида тела не рисуются, м. */
export const HEAT_VIEW_M = 2000;
/** В тепловом кадре — дальше: там цель в несколько пикселей ещё видна пятнышком, м. */
export const HEAT_THERMAL_M = 5000;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

// ---------- позы ----------

/** Углы конечностей, рад: поворот вокруг оси X у плеча/бедра, + — стопа (кисть) вперёд. */
export interface LimbAngles {
  /** Звери: [переднее левое, переднее правое, заднее левое, заднее правое]; человек: [левая, правая]. */
  legs: number[];
  /** Руки человека [левая, правая]; у зверей пусто. */
  arms: number[];
  /** Отвод рук в стороны, рад (лёжа). */
  armSpread: number;
}

/** Размах шага, рад. */
const STRIDE_QUAD = 0.35;
const STRIDE_LEG = 0.45;
const STRIDE_ARM = 0.32;
/** Сложенные ноги лежащего зверя, рад. */
const FOLD = 1.45;

/**
 * Углы конечностей в позе. Ходьба — синус фазы: у зверей рысь (по диагонали в такт),
 * у человека ноги в противофазе, руки против ног. Звери не сидят — «сидя» у них как «лёжа».
 */
export function limbAngles(kind: HeatKind, pose: HeatPose = 'standing', phase = 0): LimbAngles {
  const s = pose === 'walking' ? Math.sin(TAU * phase) : 0;
  if (kind === 'person') {
    // Сидя на земле — ноги вытянуты вперёд, кисти у бёдер.
    if (pose === 'sitting') return { legs: [1.55, 1.55], arms: [0.45, 0.45], armSpread: 0.08 };
    if (pose === 'lying') return { legs: [0, 0], arms: [0, 0], armSpread: 0.3 };
    return { legs: [STRIDE_LEG * s, -STRIDE_LEG * s], arms: [-STRIDE_ARM * s, STRIDE_ARM * s], armSpread: 0.02 };
  }
  // Лёжа передние ноги подогнуты назад, задние — вперёд, под брюхо.
  if (pose === 'lying' || pose === 'sitting') return { legs: [-FOLD, -FOLD, FOLD, FOLD], arms: [], armSpread: 0 };
  const a = STRIDE_QUAD * s;
  return { legs: [a, -a, -a, a], arms: [], armSpread: 0 };
}

// ---------- луч на рельеф ----------

/**
 * Точка рельефа на луче из o по направлению d (локальные метры: восток, север, вверх): шаг —
 * половина запаса высоты над землёй, пересечение уточняется делением пополам. null — луч не
 * встретил землю ближе maxM (смотрит в небо). Начало под землёй — точка рельефа под ним.
 */
export function marchToGround(o: LocalPoint, d: LocalPoint, groundAt: (east: number, north: number) => number, maxM = 30000): LocalPoint | null {
  const len = Math.hypot(d.east, d.north, d.up);
  if (!(len > 0)) return null;
  const de = d.east / len;
  const dn = d.north / len;
  const du = d.up / len;
  const clearance = (t: number) => o.up + du * t - groundAt(o.east + de * t, o.north + dn * t);
  const at = (t: number): LocalPoint => {
    const east = o.east + de * t;
    const north = o.north + dn * t;
    return { east, north, up: groundAt(east, north) };
  };
  let t0 = 0;
  let h0 = clearance(0);
  if (!(h0 > 0)) return at(0);
  while (t0 < maxM) {
    const t1 = Math.min(maxM, t0 + Math.min(200, Math.max(0.5, h0 * 0.5)));
    const h1 = clearance(t1);
    if (h1 <= 0) {
      let lo = t0;
      let hi = t1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (clearance(mid) > 0) lo = mid;
        else hi = mid;
      }
      return at((lo + hi) / 2);
    }
    t0 = t1;
    h0 = h1;
  }
  return null;
}

// ---------- геометрия моделей ----------

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Матрица «сдвиг + поворот» (Эйлер XYZ). */
function tf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
}

/** Эллипсоид из грубой сферы — низкополигональный вид. */
const ell = (rx: number, ry: number, rz: number, w = 8, h = 6) => new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Конечность: усечённый конус от начала вниз на длину len. */
const limb = (len: number, rTop: number, rBottom: number, seg = 6) => new THREE.CylinderGeometry(rTop, rBottom, len, seg, 1).translate(0, -len / 2, 0);

/** Цилиндр от a до b (радиус rb у b). */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, rb = r, seg = 5): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(rb, r, len, seg, 1);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Набор деталей одной подвижной части: цвет и «нагрев» — атрибутами вершин, одна геометрия. */
class Part {
  private readonly list: THREE.BufferGeometry[] = [];

  /** heat — 0…1: доля от «горячего» (лицо, кисти — 1; мех — 0.7; копыта, рога — ~0.4). */
  add(geo: THREE.BufferGeometry, color: number, heat: number, m?: THREE.Matrix4): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (m) g.applyMatrix4(m);
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('heat', new THREE.BufferAttribute(new Float32Array(n).fill(heat), 1));
    this.list.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list);
    if (!g) throw new Error('heat: пустая деталь');
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

type LimbRole = 'leg' | 'arm';

interface LimbSpec {
  geo: THREE.BufferGeometry;
  pivot: THREE.Vector3;
  role: LimbRole;
}

/** Модель вида: неподвижная часть и конечности на шарнирах (порядок ног — как в limbAngles). */
export interface HeatRig {
  body: THREE.BufferGeometry;
  limbs: readonly LimbSpec[];
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Четыре ноги зверя: одна геометрия, шарниры на высоте y, передние на zf, задние на zr, ±x. */
function quadLegs(leg: THREE.BufferGeometry, y: number, zf: number, zr: number, x: number): LimbSpec[] {
  return [V(-x, y, zf), V(x, y, zf), V(-x, y, zr), V(x, y, zr)].map((pivot) => ({ geo: leg, pivot, role: 'leg' as const }));
}

/** Человек 1.75 м в тёмной походной одежде, с рюкзаком. */
function personRig(): HeatRig {
  const JACKET = 0x2f3a2c;
  const TROUSERS = 0x2b2d31;
  const BOOTS = 0x1b1a18;
  const SKIN = 0xc69478;
  const HAIR = 0x2a211b;
  const PACK = 0x6b2b22;
  const b = new Part();
  b.add(box(0.34, 0.2, 0.2), TROUSERS, 0.76, tf(0, 0.93, 0));
  b.add(new THREE.CylinderGeometry(0.18, 0.16, 0.5, 7).scale(1, 1, 0.62), JACKET, 0.8, tf(0, 1.2, 0));
  b.add(ell(0.2, 0.08, 0.12), JACKET, 0.8, tf(0, 1.42, 0));
  b.add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6), SKIN, 0.98, tf(0, 1.52, 0));
  b.add(ell(0.085, 0.11, 0.1), SKIN, 1, tf(0, 1.64, -0.005));
  b.add(ell(0.09, 0.065, 0.1), HAIR, 0.85, tf(0, 1.69, 0.012));
  // Рюкзак экранирует тепло спины — в тепловизоре он холодный.
  b.add(box(0.3, 0.4, 0.14), PACK, 0.45, tf(0, 1.2, 0.17));
  const leg = new Part().add(limb(0.82, 0.075, 0.055), TROUSERS, 0.76).add(box(0.11, 0.08, 0.26), BOOTS, 0.5, tf(0, -0.86, -0.05)).build();
  const arm = new Part().add(limb(0.56, 0.055, 0.045), JACKET, 0.8).add(ell(0.045, 0.055, 0.045), SKIN, 1, tf(0, -0.6, 0)).build();
  return {
    body: b.build(),
    limbs: [
      { geo: leg, pivot: V(-0.1, 0.9, 0), role: 'leg' },
      { geo: leg, pivot: V(0.1, 0.9, 0), role: 'leg' },
      { geo: arm, pivot: V(-0.2, 1.42, 0), role: 'arm' },
      { geo: arm, pivot: V(0.2, 1.42, 0), role: 'arm' },
    ],
  };
}

/** Бурый медведь: ~2 м, в холке ~1 м, горб над лопатками. */
function bearRig(): HeatRig {
  const FUR = 0x4a3020;
  const HUMP = 0x563826;
  const MUZZLE = 0x7a5c40;
  const LEG = 0x3a261a;
  const DARK = 0x21170f;
  const b = new Part();
  b.add(ell(0.36, 0.3, 0.7), FUR, 0.72, tf(0, 0.68, 0.02));
  b.add(ell(0.3, 0.2, 0.32), HUMP, 0.7, tf(0, 0.84, -0.35));
  b.add(ell(0.33, 0.28, 0.36), FUR, 0.72, tf(0, 0.72, 0.4));
  b.add(ell(0.24, 0.24, 0.26), FUR, 0.74, tf(0, 0.8, -0.7));
  b.add(ell(0.2, 0.19, 0.22), FUR, 0.8, tf(0, 0.8, -0.9));
  b.add(ell(0.1, 0.09, 0.12), MUZZLE, 0.9, tf(0, 0.74, -1.08));
  b.add(ell(0.04, 0.035, 0.03), DARK, 0.95, tf(0, 0.76, -1.19));
  for (const s of [-1, 1]) b.add(ell(0.06, 0.06, 0.03), FUR, 0.85, tf(s * 0.13, 0.97, -0.86));
  b.add(ell(0.06, 0.06, 0.06), FUR, 0.65, tf(0, 0.78, 0.78));
  const leg = new Part().add(limb(0.6, 0.12, 0.1), LEG, 0.78).add(box(0.17, 0.07, 0.24), DARK, 0.7, tf(0, -0.585, -0.04)).build();
  return { body: b.build(), limbs: quadLegs(leg, 0.62, -0.42, 0.42, 0.19) };
}

/** Серый волк: ~1.3 м, в холке 0.8 м, хвост опущен. */
function wolfRig(): HeatRig {
  const GREY = 0x77736b;
  const SADDLE = 0x57534d;
  const LIGHT = 0xb5aea0;
  const LEG = 0x8a847a;
  const DARK = 0x2a2724;
  const b = new Part();
  b.add(ell(0.15, 0.17, 0.4), GREY, 0.7, tf(0, 0.6, 0.02));
  b.add(ell(0.16, 0.2, 0.2), GREY, 0.72, tf(0, 0.6, -0.22));
  b.add(ell(0.13, 0.06, 0.3), SADDLE, 0.66, tf(0, 0.74, 0.02));
  b.add(ell(0.1, 0.12, 0.16), GREY, 0.74, tf(0, 0.72, -0.4, 0.5));
  b.add(ell(0.09, 0.09, 0.12), GREY, 0.82, tf(0, 0.8, -0.52));
  b.add(ell(0.045, 0.045, 0.1), LIGHT, 0.9, tf(0, 0.76, -0.64));
  b.add(ell(0.02, 0.02, 0.02), DARK, 0.95, tf(0, 0.775, -0.735));
  for (const s of [-1, 1]) b.add(new THREE.ConeGeometry(0.035, 0.09, 4), GREY, 0.8, tf(s * 0.055, 0.91, -0.5));
  b.add(ell(0.05, 0.05, 0.18), SADDLE, 0.6, tf(0, 0.5, 0.47, 0.9));
  const leg = new Part().add(limb(0.5, 0.045, 0.03), LEG, 0.8).add(box(0.06, 0.035, 0.09), DARK, 0.75, tf(0, -0.5, -0.02)).build();
  return { body: b.build(), limbs: quadLegs(leg, 0.52, -0.24, 0.27, 0.08) };
}

/** Лось: ~2.8 м, в холке ~2 м, длинные светлые ноги, горбоносая голова, лопатообразные рога. */
function mooseRig(): HeatRig {
  const BODY = 0x3a2a1f;
  const HUMP = 0x2f2219;
  const LEG = 0x9a8b78;
  const MUZZLE = 0x2e231b;
  const ANTLER = 0xb9a88a;
  const HOOF = 0x1e1914;
  const b = new Part();
  b.add(ell(0.38, 0.42, 0.95), BODY, 0.68, tf(0, 1.45, 0.05));
  b.add(ell(0.3, 0.3, 0.42), HUMP, 0.66, tf(0, 1.72, -0.45));
  b.add(ell(0.2, 0.24, 0.32), BODY, 0.72, tf(0, 1.72, -0.98, 0.3));
  b.add(ell(0.14, 0.17, 0.3), BODY, 0.78, tf(0, 1.7, -1.34, -0.35));
  b.add(ell(0.13, 0.13, 0.15), MUZZLE, 0.92, tf(0, 1.56, -1.56));
  b.add(ell(0.04, 0.14, 0.06), BODY, 0.75, tf(0, 1.42, -1.08));
  for (const s of [-1, 1]) {
    b.add(ell(0.05, 0.11, 0.04), BODY, 0.8, tf(s * 0.15, 1.92, -1.18, 0, 0, -s * 0.5));
    // Рога: ствол, «лопата» и отростки по краю — холодные.
    b.add(rod(V(s * 0.1, 1.86, -1.2), V(s * 0.34, 1.97, -1.18), 0.04, 0.035), ANTLER, 0.4);
    b.add(ell(0.26, 0.035, 0.18, 8, 4), ANTLER, 0.4, tf(s * 0.5, 2.04, -1.14, 0, 0, s * 0.35));
    for (let k = 0; k < 4; k++) b.add(new THREE.ConeGeometry(0.025, 0.14, 4), ANTLER, 0.4, tf(s * (0.38 + 0.1 * k), 2.1 + 0.035 * k, -1.08 + 0.05 * (k % 2)));
  }
  b.add(ell(0.06, 0.08, 0.05), BODY, 0.65, tf(0, 1.58, 1.02));
  const leg = new Part().add(limb(1.2, 0.085, 0.05), LEG, 0.8).add(box(0.09, 0.07, 0.13), HOOF, 0.45, tf(0, -1.215, -0.02)).build();
  return { body: b.build(), limbs: quadLegs(leg, 1.25, -0.55, 0.6, 0.2) };
}

/** Олень: ~1.6 м, в холке ~1.1 м, белое «зеркало», небольшие рога. */
function deerRig(): HeatRig {
  const COAT = 0x8b5a34;
  const BELLY = 0xcdb89a;
  const LEG = 0x7a5233;
  const WHITE = 0xe8e0d0;
  const MUZZLE = 0x5a4636;
  const DARK = 0x2a2019;
  const ANTLER = 0xb8a585;
  const b = new Part();
  b.add(ell(0.17, 0.2, 0.56), COAT, 0.7, tf(0, 0.9, 0.04));
  b.add(ell(0.17, 0.2, 0.22), COAT, 0.72, tf(0, 0.9, -0.34));
  b.add(ell(0.14, 0.08, 0.4), BELLY, 0.74, tf(0, 0.74, 0.02));
  b.add(ell(0.075, 0.09, 0.26), COAT, 0.76, tf(0, 1.12, -0.52, 0.95));
  b.add(ell(0.07, 0.08, 0.13), COAT, 0.82, tf(0, 1.38, -0.7, -0.25));
  b.add(ell(0.04, 0.045, 0.07), MUZZLE, 0.9, tf(0, 1.34, -0.82));
  b.add(ell(0.02, 0.02, 0.02), DARK, 0.95, tf(0, 1.35, -0.885));
  for (const s of [-1, 1]) {
    b.add(ell(0.03, 0.075, 0.02), COAT, 0.85, tf(s * 0.07, 1.47, -0.64, 0, 0, -s * 0.7));
    b.add(rod(V(s * 0.04, 1.44, -0.66), V(s * 0.1, 1.68, -0.62), 0.014, 0.01), ANTLER, 0.45);
    b.add(rod(V(s * 0.075, 1.56, -0.645), V(s * 0.09, 1.63, -0.72), 0.011, 0.008), ANTLER, 0.45);
  }
  b.add(ell(0.12, 0.13, 0.06), WHITE, 0.68, tf(0, 0.92, 0.56));
  b.add(ell(0.035, 0.07, 0.035), WHITE, 0.62, tf(0, 0.98, 0.62));
  const leg = new Part().add(limb(0.74, 0.045, 0.022), LEG, 0.8).add(box(0.04, 0.03, 0.06), DARK, 0.45, tf(0, -0.745, -0.01)).build();
  return { body: b.build(), limbs: quadLegs(leg, 0.76, -0.38, 0.4, 0.1) };
}


/**
 * Горящая кромка: выгоревшая земля и языки пламени. Нагрев больше единицы — пламя в тепловом
 * кадре уходит в насыщение и даёт ореол, как настоящий огонь у матрицы.
 */
function flameRig(): HeatRig {
  const BURN = 0x1c1512;
  const ASH = 0x555049;
  const FIRE = 0xff6a15;
  const CORE = 0xffd15c;
  const b = new Part();
  b.add(new THREE.CylinderGeometry(1.6, 1.6, 0.08, 10), BURN, 1.05, tf(0, 0.04, 0));
  b.add(new THREE.CylinderGeometry(0.9, 1.2, 0.06, 9), ASH, 0.95, tf(0.4, 0.09, -0.3));
  const tongue = (x: number, z: number, h: number, r: number, hot: number) => {
    b.add(new THREE.ConeGeometry(r, h, 6), FIRE, hot, tf(x, h / 2 + 0.05, z));
    b.add(new THREE.ConeGeometry(r * 0.45, h * 0.55, 5), CORE, hot + 0.15, tf(x, h * 0.3, z));
  };
  tongue(0, 0, 2.3, 0.55, 1.45);
  tongue(-0.75, 0.4, 1.5, 0.4, 1.35);
  tongue(0.8, -0.35, 1.7, 0.42, 1.4);
  tongue(0.15, 0.9, 1.1, 0.34, 1.3);
  tongue(-0.5, -0.8, 1.3, 0.36, 1.32);
  return { body: b.build(), limbs: [] };
}

/** Тлеющее место: прогоревший валежник, угли и слабый язычок пламени. */
function emberRig(): HeatRig {
  const CHAR = 0x241812;
  const COAL = 0xc23a12;
  const FIRE = 0xff8a2a;
  const b = new Part();
  b.add(ell(0.7, 0.12, 0.6), CHAR, 1.0, tf(0, 0.1, 0));
  b.add(ell(0.34, 0.09, 0.3), COAL, 1.2, tf(0.1, 0.16, -0.05));
  b.add(ell(0.2, 0.07, 0.22), COAL, 1.15, tf(-0.25, 0.14, 0.18));
  b.add(new THREE.ConeGeometry(0.16, 0.45, 5), FIRE, 1.25, tf(0.08, 0.36, -0.03));
  return { body: b.build(), limbs: [] };
}

/** Курумник: развал глыб, нагретых солнцем, — в тепловом кадре тёплое пятно без формы. */
function rocksRig(): HeatRig {
  const STONE = 0x8b8880;
  const SHADE = 0x6d6a63;
  const LICHEN = 0x8f9470;
  const b = new Part();
  const place: [number, number, number, number, number][] = [
    [0, 0.55, 0, 1.1, 0.62],
    [1.6, 0.42, 0.6, 0.85, 0.6],
    [-1.5, 0.48, -0.5, 0.95, 0.64],
    [0.9, 0.3, -1.3, 0.7, 0.58],
    [-1.0, 0.32, 1.2, 0.72, 0.6],
    [2.2, 0.26, -0.9, 0.55, 0.56],
  ];
  place.forEach(([x, y, z, r, heat], i) => {
    b.add(new THREE.DodecahedronGeometry(r, 0), i % 2 ? STONE : SHADE, heat, tf(x, y, z, i * 0.7, i * 0.4, i * 0.3));
  });
  b.add(ell(0.5, 0.05, 0.45), LICHEN, 0.5, tf(-0.6, 0.06, -1.5));
  return { body: b.build(), limbs: [] };
}

/** Зимовье: сруб, двускатная крыша и горячая труба — печь топится. */
function hutRig(): HeatRig {
  const LOG = 0x6d5436;
  const ROOF = 0x4a4038;
  const DOOR = 0x3a2c1c;
  const PIPE = 0x3a3733;
  const HOT = 0x8a3a1a;
  const b = new Part();
  b.add(box(3.8, 2.1, 3.4), LOG, 0.52, tf(0, 1.05, 0));
  b.add(box(1.0, 1.7, 0.12), DOOR, 0.6, tf(0, 0.85, -1.73));
  b.add(new THREE.ConeGeometry(3.0, 1.2, 4), ROOF, 0.58, tf(0, 2.7, 0, 0, Math.PI / 4));
  b.add(box(0.46, 1.3, 0.46), PIPE, 0.8, tf(1.1, 3.2, 0.7));
  b.add(box(0.56, 0.16, 0.56), HOT, 1.3, tf(1.1, 3.9, 0.7));
  return { body: b.build(), limbs: [] };
}

const RIG_BUILDERS: Record<HeatKind, () => HeatRig> = { person: personRig, bear: bearRig, wolf: wolfRig, moose: mooseRig, deer: deerRig, flame: flameRig, ember: emberRig, rocks: rocksRig, hut: hutRig };
const rigs = new Map<HeatKind, HeatRig>();

/** Геометрия вида — общая для всех особей (строится один раз). */
export function heatRig(kind: HeatKind): HeatRig {
  let r = rigs.get(kind);
  if (!r) rigs.set(kind, (r = RIG_BUILDERS[kind]()));
  return r;
}

// ---------- материалы ----------

let natural: THREE.MeshStandardMaterial | null = null;

/** Обычный вид: цвета вершин, матовый мех и ткань, грани — низкополигональный стиль. */
function naturalMaterial(): THREE.MeshStandardMaterial {
  return (natural ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }));
}

const HOT_VERTEX = /* glsl */ `attribute float heat;
uniform vec3 uRoot;
uniform float uRadius;
uniform float uPxAngle;
uniform float uMinPx;
varying float vHeat;
varying float vWeight;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // Мельче uMinPx пикселей тело раздувается вокруг середины, а контраст падает на ту же долю:
  // точечная цель не пропадает между пикселями, а светится слабым пятнышком, как у настоящей матрицы.
  float px = uRadius / (max(distance(cameraPosition, uRoot), 1.0) * uPxAngle);
  float s = clamp(uMinPx / max(px, 1e-3), 1.0, 6.0);
  wp.xyz = uRoot + (wp.xyz - uRoot) * s;
  vWeight = 1.0 / (s * sqrt(s));
  vHeat = heat;
  vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * normal);
  vec4 mv = viewMatrix * wp;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const HOT_FRAGMENT = /* glsl */ `uniform float uAmbient;
uniform float uHot;
varying float vHeat;
varying float vWeight;
varying vec3 vN;
varying vec3 vV;
void main() {
  // Под скользящим углом излучательная способность меньше — края тела темнее середины.
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float h = mix(uAmbient, uHot, vHeat) * mix(0.84, 1.0, facing);
  h = mix(uAmbient, h, vWeight);
  // R — температура, G — «тёплое тело» (для ореола), A — покрытие.
  gl_FragColor = vec4(h, max(0.0, h - uAmbient), 0.0, 1.0);
}`;

let hot: THREE.ShaderMaterial | null = null;

/**
 * «Горячий» материал теплового кадра: температура из атрибута heat (0 — фон, 1 — uHot).
 * Униформы uPxAngle (рад на пиксель кадра), uAmbient, uHot ставит тепловой проход; uRoot и uRadius —
 * каждое тело перед своей отрисовкой (onBeforeRender).
 */
export function heatMaterial(): THREE.ShaderMaterial {
  return (hot ??= new THREE.ShaderMaterial({
    vertexShader: HOT_VERTEX,
    fragmentShader: HOT_FRAGMENT,
    uniforms: {
      uRoot: { value: new THREE.Vector3() },
      uRadius: { value: 1 },
      uPxAngle: { value: 0.001 },
      uMinPx: { value: 1.6 },
      uAmbient: { value: 0.35 },
      uHot: { value: 1 },
    },
  }));
}

// ---------- особи ----------

interface PoseInfo {
  q: THREE.Quaternion;
  /** Подъём позы, чтобы нижняя точка легла на землю, м. */
  lift: number;
  /** Середина тела над землёй и половина наибольшего габарита, м. */
  centerY: number;
  radius: number;
}

interface Model {
  kind: HeatKind;
  root: THREE.Group;
  posed: THREE.Group;
  legs: THREE.Group[];
  arms: THREE.Group[];
  pose: HeatPose | null;
  info: PoseInfo | null;
}

/** Модель вида без позы: корень → поза → тело и шарниры конечностей. */
function buildModel(kind: HeatKind): Model {
  const rig = heatRig(kind);
  const mat = naturalMaterial();
  const root = new THREE.Group();
  root.name = `heat-${kind}`;
  const posed = new THREE.Group();
  root.add(posed);
  const m: Model = { kind, root, posed, legs: [], arms: [], pose: null, info: null };
  const mesh = (geo: THREE.BufferGeometry) => {
    const x = new THREE.Mesh(geo, mat);
    x.castShadow = true;
    x.receiveShadow = true;
    return x;
  };
  posed.add(mesh(rig.body));
  for (const l of rig.limbs) {
    const pivot = new THREE.Group();
    pivot.position.copy(l.pivot);
    pivot.add(mesh(l.geo));
    posed.add(pivot);
    (l.role === 'leg' ? m.legs : m.arms).push(pivot);
  }
  return m;
}

function setLimbs(m: Model, a: LimbAngles) {
  m.legs.forEach((g, i) => (g.rotation.x = a.legs[i] ?? 0));
  m.arms.forEach((g, i) => {
    g.rotation.x = a.arms[i] ?? 0;
    // Левая рука (−x) отводится к −x, правая — к +x.
    g.rotation.z = (i === 0 ? -1 : 1) * a.armSpread;
  });
}

/** Лёжа человек на спине, головой по курсу (−Z); остальные позы без поворота. */
function poseRotation(kind: HeatKind, pose: HeatPose): THREE.Quaternion {
  if (kind === 'person' && pose === 'lying') {
    return new THREE.Quaternion().setFromAxisAngle(UP, Math.PI).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  }
  return new THREE.Quaternion();
}

const poseCache = new Map<string, PoseInfo>();

/** Поворот и подъём позы — по габариту модели в этой позе (считается один раз). */
function poseInfo(kind: HeatKind, pose: HeatPose): PoseInfo {
  // Ходьба — как стоя: подъём не меняется в шаге.
  const key = `${kind}:${pose === 'walking' ? 'standing' : pose}`;
  let info = poseCache.get(key);
  if (info) return info;
  const m = buildModel(kind);
  const q = poseRotation(kind, pose);
  setLimbs(m, limbAngles(kind, pose === 'walking' ? 'standing' : pose, 0));
  m.posed.quaternion.copy(q);
  m.root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(m.root, true);
  const size = bb.getSize(new THREE.Vector3());
  info = { q, lift: -bb.min.y, centerY: (bb.max.y - bb.min.y) / 2, radius: Math.max(size.x, size.y, size.z) / 2 };
  poseCache.set(key, info);
  return info;
}

/** Поставить модель в позу (для ходьбы — с фазой шага). */
function applyPose(m: Model, pose: HeatPose, phase: number) {
  if (m.pose !== pose) {
    const info = poseInfo(m.kind, pose);
    m.posed.quaternion.copy(info.q);
    m.posed.position.y = info.lift;
    m.pose = pose;
    m.info = info;
  }
  setLimbs(m, limbAngles(m.kind, pose, phase));
}

/** Отдельная модель в позе (превью, тесты): начало — на земле, нос к −Z. */
export function createHeatModel(kind: HeatKind, pose: HeatPose = 'standing', phase = 0): THREE.Group {
  const m = buildModel(kind);
  applyPose(m, pose, phase);
  return m.root;
}

interface Item {
  model: Model;
  east: number;
  north: number;
  headingDeg: number;
  upright: boolean;
}

/** Предельный наклон по склону, рад. */
const MAX_TILT = 0.6;

/**
 * Тёплые тела в сцене: создание, обновление и удаление по id, постановка на рельеф (звери и
 * лежащий человек — по склону), видимость по расстоянию.
 */
export class HeatBodies {
  readonly group = new THREE.Group();
  private readonly items = new Map<number, Item>();
  private readonly center = new THREE.Vector3();

  constructor(private readonly groundAt: (east: number, north: number) => number) {
    this.group.name = 'heat-bodies';
  }

  get count(): number {
    return this.items.size;
  }

  set(bodies: readonly HeatBody[]) {
    const seen = new Set<number>();
    for (const b of bodies) {
      seen.add(b.id);
      let it = this.items.get(b.id);
      if (it && it.model.kind !== b.kind) {
        this.group.remove(it.model.root);
        it = undefined;
      }
      if (!it) {
        const model = buildModel(b.kind);
        this.hook(model);
        it = { model, east: NaN, north: NaN, headingDeg: NaN, upright: true };
        this.items.set(b.id, it);
        this.group.add(model.root);
      }
      this.place(it, b);
    }
    for (const [id, it] of this.items) {
      if (seen.has(id)) continue;
      this.group.remove(it.model.root);
      this.items.delete(id);
    }
  }

  /** Видны только тела ближе rangeM к точке from (координаты сцены). */
  cull(from: THREE.Vector3, rangeM: number) {
    const r2 = rangeM * rangeM;
    for (const it of this.items.values()) it.model.root.visible = it.model.root.position.distanceToSquared(from) < r2;
  }

  private place(it: Item, b: HeatBody) {
    const m = it.model;
    const pose = b.pose ?? 'standing';
    applyPose(m, pose, b.phase ?? 0);
    const upright = m.kind === 'person' ? pose !== 'lying' : UPRIGHT_KINDS.has(m.kind);
    if (b.east === it.east && b.north === it.north && b.headingDeg === it.headingDeg && upright === it.upright) return;
    it.east = b.east;
    it.north = b.north;
    it.headingDeg = b.headingDeg;
    it.upright = upright;
    const g = this.groundAt(b.east, b.north);
    let pitch = 0;
    let roll = 0;
    if (!upright) {
      // Наклон по склону: вдоль тела — тангаж, поперёк — крен.
      const size = HEAT_SIZE[m.kind];
      const half = m.kind === 'person' ? 0.85 : size.lengthM / 2;
      const side = Math.max(0.25, size.widthM / 2);
      const s = Math.sin(b.headingDeg * DEG);
      const c = Math.cos(b.headingDeg * DEG);
      const gf = this.groundAt(b.east + s * half, b.north + c * half);
      const gb = this.groundAt(b.east - s * half, b.north - c * half);
      const gr = this.groundAt(b.east + c * side, b.north - s * side);
      const gl = this.groundAt(b.east - c * side, b.north + s * side);
      pitch = THREE.MathUtils.clamp(Math.atan2(gf - gb, 2 * half), -MAX_TILT, MAX_TILT);
      roll = THREE.MathUtils.clamp(Math.atan2(gr - gl, 2 * side), -MAX_TILT, MAX_TILT);
    }
    m.root.position.set(b.east, g, -b.north);
    m.root.rotation.set(pitch, -b.headingDeg * DEG, roll, 'YXZ');
  }

  /** Перед отрисовкой «горячим» материалом — середина и размер тела в его униформы. */
  private hook(m: Model) {
    const center = this.center;
    const before = (_r: THREE.WebGLRenderer, _s: THREE.Object3D, _c: THREE.Camera, _g: THREE.BufferGeometry, material: THREE.Material) => {
      const h = hot;
      if (!h || material !== h || !m.info) return;
      center.set(0, m.info.centerY, 0).applyMatrix4(m.root.matrixWorld);
      (h.uniforms['uRoot']!.value as THREE.Vector3).copy(center);
      h.uniforms['uRadius']!.value = m.info.radius;
      h.uniformsNeedUpdate = true;
    };
    m.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.onBeforeRender = before;
    });
  }
}
