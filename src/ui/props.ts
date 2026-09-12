import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Реквизит сцены: площадка, НСУ, машина экипажа, пыль от роторов, маркеры маршрута.
// Текстуры, материалы и геометрия общие для всех экземпляров (ленивые кэши модуля);
// dispose() на них безопасен — при следующем показе three.js загрузит их заново.

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

// ---------- общие помощники ----------

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Значение создаётся при первом обращении и дальше переиспользуется. */
function lazy<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

/** Детерминированный генератор (mulberry32): текстуры одинаковы от запуска к запуску. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Мелкое зерно поверх рисунка — чтобы поверхность не выглядела пластиковой. */
function grain(g: CanvasRenderingContext2D, w: number, h: number, amp: number, seed: number) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amp;
    d[i] = d[i]! + n;
    d[i + 1] = d[i + 1]! + n;
    d[i + 2] = d[i + 2]! + n;
  }
  g.putImageData(img, 0, 0);
}

function std(color: number, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Матрица «сдвиг + поворот» (Эйлер XYZ). */
function tf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
}

/** Локальная матрица детали внутри узла parent. */
function under(parent: THREE.Matrix4, local: THREE.Matrix4): THREE.Matrix4 {
  return parent.clone().multiply(local);
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

/** Цилиндр от точки a до точки b (радиус rb у b). */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6, rb = r): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(rb, r, len, seg, 1);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Плоский выпуклый многоугольник веером; лицевая сторона — в сторону outward. */
function polygon(pts: THREE.Vector3[], outward: THREE.Vector3): THREE.BufferGeometry {
  const p0 = pts[0]!;
  const n = new THREE.Vector3().subVectors(pts[1]!, p0).cross(new THREE.Vector3().subVectors(pts[2]!, p0));
  const ordered = n.dot(outward) < 0 ? [...pts].reverse() : pts;
  const pos: number[] = [];
  for (let i = 1; i + 1 < ordered.length; i++) {
    for (const p of [ordered[0]!, ordered[i]!, ordered[i + 1]!]) pos.push(p.x, p.y, p.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Приводит геометрию к общему виду для слияния: без индекса, только position/normal/uv. */
function normalized(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
  }
  if (!n.getAttribute('normal')) n.computeVertexNormals();
  if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
  n.clearGroups();
  return n;
}

/** Набор деталей: сливает их по материалам — один вызов отрисовки на материал. */
class Kit {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(mat: THREE.Material, geo: THREE.BufferGeometry, m?: THREE.Matrix4): this {
    if (m) geo.applyMatrix4(m);
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(geo);
    return this;
  }

  build(group: THREE.Group, cast = true, receive = true) {
    for (const [mat, list] of this.parts) {
      const geo = mergeGeometries(list.map(normalized));
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      group.add(mesh);
    }
    this.parts.clear();
  }
}

// ---------- посадочная площадка ----------

const PAD_M = 3.5;
const PAD_T = 0.04;
/** Подъём над землёй против мерцания с рельефом. */
const PAD_LIFT = 0.006;

const padTextures = lazy(() => {
  const S = 1024;
  const k = S / PAD_M;
  const r = rng(7);
  const map = canvasTexture(S, S, (g) => {
    g.fillStyle = '#2b2f2d';
    g.fillRect(0, 0, S, S);
    // Переплетение прорезиненной ткани.
    g.fillStyle = 'rgba(0,0,0,0.07)';
    for (let i = 0; i < S; i += 4) g.fillRect(i, 0, 1, S);
    g.fillStyle = 'rgba(255,255,255,0.025)';
    for (let i = 2; i < S; i += 4) g.fillRect(0, i, S, 1);
    // Пыль и пятна.
    for (let i = 0; i < 46; i++) {
      const x = r() * S;
      const y = r() * S;
      const rad = (0.1 + r() * 0.55) * k;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const a = 0.04 + r() * 0.09;
      gr.addColorStop(0, `rgba(150,132,104,${a})`);
      gr.addColorStop(1, 'rgba(150,132,104,0)');
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
    }
    // Оранжевый кант со строчкой.
    const b = 0.17 * k;
    g.strokeStyle = '#e4651f';
    g.lineWidth = b;
    g.strokeRect(b / 2, b / 2, S - b, S - b);
    g.setLineDash([9, 6]);
    g.strokeStyle = 'rgba(60,24,8,0.6)';
    g.lineWidth = 2;
    g.strokeRect(9, 9, S - 18, S - 18);
    g.strokeRect(b - 8, b - 8, S - 2 * b + 16, S - 2 * b + 16);
    g.setLineDash([]);
    // Белая разметка: круг касания, «H», угловые метки.
    const c = S / 2;
    g.strokeStyle = g.fillStyle = '#ecebe6';
    g.lineWidth = 0.08 * k;
    g.beginPath();
    g.arc(c, c, 1.2 * k, 0, TAU);
    g.stroke();
    const hw = 0.5 * k;
    const hh = 0.75 * k;
    const bar = 0.2 * k;
    g.fillRect(c - hw, c - hh, bar, 2 * hh);
    g.fillRect(c + hw - bar, c - hh, bar, 2 * hh);
    g.fillRect(c - hw, c - bar / 2, 2 * hw, bar);
    const inset = 0.3 * k;
    const arm = 0.4 * k;
    const t = 0.07 * k;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      const x0 = sx > 0 ? inset : S - inset;
      const y0 = sy > 0 ? inset : S - inset;
      g.fillRect(sx > 0 ? x0 : x0 - arm, sy > 0 ? y0 : y0 - t, arm, t);
      g.fillRect(sx > 0 ? x0 : x0 - t, sy > 0 ? y0 : y0 - arm, t, arm);
    }
    // Люверсы под колышки.
    const e = 0.085 * k;
    for (const [x, y] of [[e, e], [S - e, e], [e, S - e], [S - e, S - e]] as const) {
      g.fillStyle = '#a4a6a8';
      g.beginPath();
      g.arc(x, y, 0.028 * k, 0, TAU);
      g.fill();
      g.fillStyle = '#1b1c1c';
      g.beginPath();
      g.arc(x, y, 0.014 * k, 0, TAU);
      g.fill();
    }
    // Потёртости краски.
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = `rgba(43,47,45,${0.12 + r() * 0.4})`;
      g.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 2);
    }
    grain(g, S, S, 12, 11);
  });
  map.anisotropy = 8;
  const bump = canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#808080';
      g.fillRect(0, 0, 512, 512);
      g.fillStyle = 'rgba(0,0,0,0.28)';
      for (let i = 0; i < 512; i += 4) g.fillRect(i, 0, 2, 512);
      g.fillStyle = 'rgba(255,255,255,0.14)';
      for (let i = 0; i < 512; i += 4) g.fillRect(0, i, 512, 2);
      grain(g, 512, 512, 40, 5);
    },
    false,
  );
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(4, 4);
  return { map, bump };
});

const padTemplate = lazy(() => {
  const { map, bump } = padTextures();
  const top = std(0xffffff, 0.92, 0, { map, bumpMap: bump, bumpScale: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const hem = std(0xc4561c, 0.85);
  const skirt = std(0x3b342a, 1);
  const steel = std(0x8e9195, 0.42, 0.75);
  const cap = std(0xff7a1a, 0.55);

  const g = new THREE.Group();
  g.name = 'landing-pad';
  // Грани коробки идут ±x, ±y, ±z по 6 индексов: верх — своя группа, остальное кант (3 вызова вместо 6).
  const matGeo = box(PAD_M, PAD_T, PAD_M);
  matGeo.clearGroups();
  matGeo.addGroup(0, 12, 0);
  matGeo.addGroup(12, 6, 1);
  matGeo.addGroup(18, 18, 0);
  const mat = new THREE.Mesh(matGeo, [hem, top]);
  mat.position.y = PAD_T / 2 + PAD_LIFT;
  mat.receiveShadow = true;
  // Подол уходит под землю: если площадку поднимут над рельефом, она не повиснет в воздухе.
  const under = new THREE.Mesh(box(PAD_M - 0.03, 0.2, PAD_M - 0.03), skirt);
  under.position.y = -0.1 + PAD_LIFT;
  under.receiveShadow = true;
  g.add(under, mat);

  const kit = new Kit();
  const y = PAD_T + PAD_LIFT;
  const e = PAD_M / 2 - 0.085;
  for (const [x, z] of [[e, e], [-e, e], [e, -e], [-e, -e]] as const) {
    kit.add(steel, new THREE.TorusGeometry(0.024, 0.006, 4, 12), tf(x, y + 0.002, z, Math.PI / 2));
    kit.add(steel, new THREE.CylinderGeometry(0.006, 0.004, 0.11, 6), tf(x, y - 0.025, z));
    kit.add(cap, new THREE.CylinderGeometry(0.019, 0.024, 0.02, 8), tf(x, y + 0.035, z));
  }
  kit.build(g, true, false);
  return g;
});

/** Переносная посадочная площадка ~3.5 × 3.5 м: начало координат — центр на земле. */
export function createLandingPad(): THREE.Group {
  return padTemplate().clone();
}

// ---------- наземная станция управления ----------

const tableTexture = lazy(() =>
  canvasTexture(256, 256, (g) => {
    g.fillStyle = '#c8ccd0';
    g.fillRect(0, 0, 256, 256);
    const r = rng(3);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)';
      g.fillRect(r() * 256, r() * 256, 20 + r() * 70, 1);
    }
    // Швы между рейками алюминиевой столешницы.
    for (let i = 0; i <= 7; i++) {
      const y = Math.round((i * 256) / 7);
      g.fillStyle = 'rgba(40,44,48,0.6)';
      g.fillRect(0, y - 2, 256, 3);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(0, y + 1, 256, 1);
    }
    grain(g, 256, 256, 8, 4);
  }),
);

const keyboardTexture = lazy(() =>
  canvasTexture(256, 112, (g) => {
    g.fillStyle = '#121416';
    g.fillRect(0, 0, 256, 112);
    const cols = 15;
    const rows = 6;
    const kw = 256 / cols;
    const kh = 112 / rows;
    g.fillStyle = '#2d3033';
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (j === rows - 1 && i > 4 && i < 11) continue;
        g.fillRect(i * kw + 1.5, j * kh + 1.5, kw - 3, kh - 3);
      }
    }
    g.fillRect(4 * kw + 1.5, (rows - 1) * kh + 1.5, 7 * kw - 3, kh - 3);
  }),
);

/** Экран ноутбука: тёмная карта, участок, маршрут галсами, телеметрия. */
const screenTexture = lazy(() =>
  canvasTexture(512, 320, (g) => {
    const W = 512;
    const H = 320;
    const r = rng(21);
    g.fillStyle = '#13211a';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 34; i++) {
      const cx = r() * W;
      const cy = r() * H;
      const rad = 20 + r() * 50;
      g.fillStyle = r() < 0.5 ? 'rgba(40,74,46,0.35)' : 'rgba(78,78,50,0.3)';
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU + r() * 0.6;
        const rr = rad * (0.6 + r() * 0.5);
        g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
    }
    g.strokeStyle = '#2a5a70';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(-10, 60);
    g.bezierCurveTo(150, 120, 200, 20, 520, 90);
    g.stroke();
    g.strokeStyle = 'rgba(190,180,140,0.45)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 270);
    g.lineTo(512, 200);
    g.moveTo(180, 320);
    g.lineTo(230, 30);
    g.stroke();

    const area = [[250, 88], [440, 104], [424, 250], [262, 236]] as const;
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [x, y] of area) g.lineTo(x, y);
    g.closePath();
    g.fill();
    g.stroke();

    const home: [number, number] = [110, 262];
    const route: [number, number][] = [home];
    for (let k = 0; k < 7; k++) {
      const x = 272 + k * 23;
      const top = 104 + (x - 250) * 0.084;
      const bot = 230 + (x - 262) * 0.086;
      if (k % 2 === 0) route.push([x, bot], [x, top]);
      else route.push([x, top], [x, bot]);
    }
    route.push(home);
    g.strokeStyle = '#ff9a3c';
    g.lineWidth = 2.2;
    g.lineJoin = 'round';
    g.beginPath();
    for (const [x, y] of route) g.lineTo(x, y);
    g.stroke();
    g.fillStyle = '#ffd6b0';
    for (const [x, y] of route.slice(1, -1)) {
      g.beginPath();
      g.arc(x, y, 2.6, 0, TAU);
      g.fill();
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(home[0], home[1], 9, 0, TAU);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = 'bold 11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('H', home[0], home[1] + 0.5);

    g.save();
    g.translate(318, 150);
    g.rotate(-0.1);
    g.fillStyle = '#4ee6ff';
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.restore();

    g.fillStyle = 'rgba(5,8,11,0.92)';
    g.fillRect(0, 0, W, 24);
    g.font = '600 13px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#d6ecff';
    g.fillText('ВЫС 120 м  V 23 м/с  АКБ 76%  GPS 18', 10, 12.5);
    g.textAlign = 'right';
    g.fillStyle = '#7dffa8';
    g.fillText('● СВЯЗЬ', W - 10, 12.5);

    // Авиагоризонт.
    const cx = 46;
    const cy = H - 46;
    const R = 34;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.clip();
    g.translate(cx, cy);
    g.rotate(0.14);
    g.fillStyle = '#2f6db0';
    g.fillRect(-R * 1.5, -R * 1.5, R * 3, R * 1.5 + 4);
    g.fillStyle = '#7a5530';
    g.fillRect(-R * 1.5, 4, R * 3, R * 1.5);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-R * 1.5, 4);
    g.lineTo(R * 1.5, 4);
    g.stroke();
    g.restore();
    g.strokeStyle = '#0b0e12';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.stroke();
    g.strokeStyle = '#ffd24a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 18, cy);
    g.lineTo(cx - 6, cy);
    g.moveTo(cx + 6, cy);
    g.lineTo(cx + 18, cy);
    g.stroke();

    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(W - 90, H - 20);
    g.lineTo(W - 90, H - 14);
    g.lineTo(W - 20, H - 14);
    g.lineTo(W - 20, H - 20);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('500 м', W - 55, H - 26);
  }),
);

const gcsTemplate = lazy(() => {
  const alu = std(0xbfc4c9, 0.38, 0.75);
  const top = std(0xffffff, 0.45, 0.55, { map: tableTexture() });
  const plastic = std(0x2c2f32, 0.55);
  const rubber = std(0x131415, 0.9);
  const metal = std(0x45484c, 0.4, 0.7);
  const radome = std(0xdedfd9, 0.55);
  const olive = std(0x3d4331, 0.5);
  const keys = std(0xffffff, 0.7, 0, { map: keyboardTexture() });
  const screen = std(0x050607, 0.2, 0, { emissive: 0xffffff, emissiveMap: screenTexture(), emissiveIntensity: 2 });

  const kit = new Kit();
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Складной стол 1.2 × 0.7 м, столешница на 0.735 м.
  const TOP = 0.735;
  kit.add(top, box(1.2, 0.03, 0.7), tf(0, TOP - 0.015, 0));
  kit.add(alu, box(1.14, 0.04, 0.02), tf(0, TOP - 0.05, 0.33));
  kit.add(alu, box(1.14, 0.04, 0.02), tf(0, TOP - 0.05, -0.33));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) kit.add(alu, rod(V(sx * 0.54, TOP - 0.03, sz * 0.3), V(sx * 0.58, 0, sz * 0.33), 0.013, 6));
    kit.add(alu, rod(V(sx * 0.555, 0.18, -0.315), V(sx * 0.555, 0.18, 0.315), 0.008, 5));
  }
  for (const sz of [-1, 1]) kit.add(alu, rod(V(-0.565, 0.12, sz * 0.32), V(0.565, 0.12, sz * 0.32), 0.008, 5));

  // Защищённый ноутбук, экран к оператору (+z).
  const lx = 0.08;
  const lz = 0.04;
  kit.add(plastic, box(0.34, 0.04, 0.27), tf(lx, TOP + 0.02, lz));
  kit.add(keys, new THREE.PlaneGeometry(0.29, 0.12), tf(lx, TOP + 0.0405, lz - 0.03, -Math.PI / 2));
  for (const sx of [-1, 1]) kit.add(rubber, box(0.02, 0.018, 0.04), tf(lx + sx * 0.09, TOP + 0.02, lz + 0.15));
  kit.add(rubber, box(0.2, 0.018, 0.016), tf(lx, TOP + 0.02, lz + 0.172));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.add(rubber, box(0.035, 0.046, 0.035), tf(lx + sx * 0.158, TOP + 0.02, lz + sz * 0.123));
  const lid = tf(lx, TOP + 0.04, lz - 0.123, -0.28);
  kit.add(plastic, box(0.34, 0.25, 0.022).translate(0, 0.125, -0.011), lid);
  kit.add(screen, new THREE.PlaneGeometry(0.298, 0.186).translate(0, 0.133, 0.0012), lid);

  // Пульт и радиомодем.
  const tx = tf(-0.34, TOP, 0.1, 0, 0.25);
  kit.add(plastic, box(0.2, 0.05, 0.12), under(tx, tf(0, 0.025, 0)));
  for (const sx of [-1, 1]) {
    kit.add(metal, rod(V(sx * 0.05, 0.05, 0.005), V(sx * 0.05, 0.075, 0.005), 0.003, 5), tx);
    kit.add(rubber, new THREE.SphereGeometry(0.008, 6, 4), under(tx, tf(sx * 0.05, 0.078, 0.005)));
  }
  kit.add(rubber, rod(V(0.08, 0.05, -0.05), V(0.1, 0.17, -0.07), 0.004, 5, 0.003), tx);
  const modem = tf(0.42, TOP, -0.2, 0, -0.3);
  kit.add(metal, box(0.11, 0.03, 0.075), under(modem, tf(0, 0.015, 0)));
  kit.add(rubber, rod(V(0.04, 0.03, -0.02), V(0.04, 0.12, -0.02), 0.004, 5, 0.003), modem);

  // Штатив-мачта с панельной антенной (смотрит в −z) и штырём.
  const MX = 1.35;
  const MZ = -0.45;
  const HUB = 0.95;
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + 0.3 + (i * TAU) / 3;
    const foot = V(MX + Math.cos(a) * 0.75, 0, MZ + Math.sin(a) * 0.75);
    const head = V(MX + Math.cos(a) * 0.035, HUB, MZ + Math.sin(a) * 0.035);
    kit.add(alu, rod(head, foot, 0.013, 6));
    kit.add(rubber, new THREE.CylinderGeometry(0.02, 0.023, 0.03, 6), tf(foot.x, 0.015, foot.z));
    kit.add(alu, rod(head.clone().lerp(foot, 0.45), V(MX, 0.5, MZ), 0.006, 5));
  }
  kit.add(metal, new THREE.CylinderGeometry(0.045, 0.045, 0.09, 10), tf(MX, HUB, MZ));
  kit.add(alu, rod(V(MX, 0.48, MZ), V(MX, 1.75, MZ), 0.019, 8));
  kit.add(metal, new THREE.CylinderGeometry(0.028, 0.028, 0.07, 8), tf(MX, 1.75, MZ));
  kit.add(alu, rod(V(MX, 1.75, MZ), V(MX, 2.44, MZ), 0.014, 8));
  kit.add(metal, box(0.05, 0.1, 0.07), tf(MX, 2.3, MZ - 0.045));
  kit.add(radome, box(0.26, 0.34, 0.045), tf(MX, 2.3, MZ - 0.1, 0.09));
  kit.add(metal, new THREE.CylinderGeometry(0.013, 0.013, 0.05, 8), tf(MX, 2.465, MZ));
  kit.add(rubber, rod(V(MX, 2.49, MZ), V(MX, 2.95, MZ), 0.005, 5, 0.003));

  // Кабель от ноутбука по земле и вверх по мачте.
  const cable = new THREE.CatmullRomCurve3(
    [
      V(lx + 0.05, TOP + 0.01, lz - 0.14),
      V(0.22, TOP + 0.006, -0.3),
      V(0.32, TOP, -0.355),
      V(0.4, 0.35, -0.4),
      V(0.55, 0.012, -0.44),
      V(1.0, 0.012, -0.47),
      V(MX + 0.03, 0.3, MZ + 0.02),
      V(MX + 0.028, 1.2, MZ + 0.022),
      V(MX + 0.024, 2.1, MZ + 0.02),
      V(MX, 2.26, MZ - 0.02),
    ],
    false,
    'catmullrom',
    0.3,
  );
  kit.add(rubber, new THREE.TubeGeometry(cable, 64, 0.004, 4, false));

  // Кейс для аппаратуры.
  const cs = tf(-0.95, 0, 0.4, 0, 0.35);
  kit.add(olive, box(0.56, 0.23, 0.42), under(cs, tf(0, 0.12, 0)));
  kit.add(olive, box(0.575, 0.03, 0.435), under(cs, tf(0, 0.165, 0)));
  for (const sx of [-1, 1]) {
    kit.add(metal, box(0.05, 0.045, 0.02), under(cs, tf(sx * 0.16, 0.16, 0.218)));
    kit.add(rubber, box(0.025, 0.028, 0.03), under(cs, tf(sx * 0.075, 0.245, 0)));
  }
  kit.add(rubber, box(0.17, 0.022, 0.03), under(cs, tf(0, 0.262, 0)));

  const g = new THREE.Group();
  g.name = 'ground-station';
  kit.build(g, true, true);
  return g;
});

/** НСУ в поле: складной стол с защищённым ноутбуком (экран светится картой), штатив-мачта ~2.5 м с антенной, кейс. Начало — на земле. */
export function createGroundStation(): THREE.Group {
  return gcsTemplate().clone();
}

// ---------- машина экипажа ----------

const VAN_L = 5.0;
const VAN_W = 1.96;
/** Скругление кромок кузова (фаска выдавливания). */
const VAN_B = 0.03;
const ARCH = 0.44;
const AXLE_REAR = 1.0;
const AXLE_FRONT = 4.0;
const WHEEL_R = 0.372;
/** Пикселей на метр в текстуре борта. */
const PXM = 200;

/** Окна борта в координатах профиля (u — от кормы вперёд, v — вверх), м. */
const VAN_WINDOWS: [number, number][][] = [
  [[3.12, 1.3], [4.26, 1.3], [3.74, 1.84], [3.12, 1.84]],
  [[1.95, 1.3], [2.95, 1.3], [2.95, 1.84], [1.95, 1.84]],
  [[0.22, 1.3], [1.78, 1.3], [1.78, 1.84], [0.22, 1.84]],
];

const vanSideTexture = lazy(() => {
  const tex = canvasTexture(1024, 512, (g) => {
    const X = (u: number) => u * PXM;
    const Y = (v: number) => (2.56 - v) * PXM;
    const paint = g.createLinearGradient(0, Y(2.1), 0, Y(0.35));
    paint.addColorStop(0, '#f1f3f4');
    paint.addColorStop(1, '#d8dbdd');
    g.fillStyle = paint;
    g.fillRect(0, 0, 1024, 512);
    const dirt = g.createLinearGradient(0, Y(1.0), 0, Y(0.38));
    dirt.addColorStop(0, 'rgba(118,98,72,0)');
    dirt.addColorStop(1, 'rgba(118,98,72,0.55)');
    g.fillStyle = dirt;
    g.fillRect(0, Y(1.0), 1024, Y(0.38) - Y(1.0));
    // Молдинг и сигнальная полоса.
    g.fillStyle = '#383b3e';
    g.fillRect(X(0.04), Y(0.75), X(VAN_L - 0.08), 0.09 * PXM);
    g.fillStyle = '#ff7a1a';
    g.fillRect(0, Y(1.08), 1024, 0.1 * PXM);
    // Уплотнители окон.
    g.fillStyle = g.strokeStyle = '#15181b';
    g.lineWidth = 0.06 * PXM;
    g.lineJoin = 'round';
    for (const w of VAN_WINDOWS) {
      g.beginPath();
      for (const [u, v] of w) g.lineTo(X(u), Y(v));
      g.closePath();
      g.fill();
      g.stroke();
    }
    // Швы дверей и ручки.
    g.strokeStyle = 'rgba(58,62,66,0.85)';
    g.lineWidth = 2;
    g.beginPath();
    for (const u of [1.86, 3.05]) {
      g.moveTo(X(u), Y(0.43));
      g.lineTo(X(u), Y(1.96));
    }
    g.moveTo(X(4.45), Y(0.86));
    g.lineTo(X(4.45), Y(1.24));
    g.moveTo(X(1.86), Y(1.96));
    g.lineTo(X(3.05), Y(1.96));
    g.stroke();
    g.fillStyle = '#2a2d30';
    g.fillRect(X(2.8), Y(1.24), 0.15 * PXM, 0.04 * PXM);
    g.fillRect(X(3.16), Y(1.24), 0.15 * PXM, 0.04 * PXM);
    g.strokeStyle = 'rgba(58,62,66,0.7)';
    g.beginPath();
    g.arc(X(0.62), Y(1.22), 0.07 * PXM, 0, TAU);
    g.stroke();
    grain(g, 1024, 512, 6, 9);
  });
  tex.repeat.set(1 / 5.12, 1 / 2.56);
  tex.anisotropy = 4;
  return tex;
});

/** Профиль кузова (фургон с короткой мордой), u — от кормы вперёд. */
function vanProfile(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 0.52);
  s.quadraticCurveTo(0, 0.4, 0.1, 0.4);
  s.absarc(AXLE_REAR, 0.4, ARCH, Math.PI, 0, true);
  s.absarc(AXLE_FRONT, 0.4, ARCH, Math.PI, 0, true);
  s.lineTo(4.9, 0.4);
  s.quadraticCurveTo(5.0, 0.4, 5.0, 0.52);
  s.lineTo(4.98, 0.92);
  s.quadraticCurveTo(4.96, 1.1, 4.78, 1.13);
  s.lineTo(4.42, 1.24);
  s.lineTo(3.78, 1.9);
  s.quadraticCurveTo(3.7, 2.0, 3.52, 2.0);
  s.lineTo(0.14, 2.0);
  s.quadraticCurveTo(0.02, 2.0, 0.02, 1.88);
  return s;
}

const vanTemplate = lazy(() => {
  const paint = std(0xe9ebec, 0.35);
  const side = std(0xffffff, 0.35, 0, { map: vanSideTexture() });
  const glass = std(0x0d1317, 0.06, 0.3, { envMapIntensity: 1.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const trim = std(0x26282b, 0.7);
  const tire = std(0x161718, 0.92);
  const rim = std(0x7d8288, 0.4, 0.6);
  const lamp = std(0xdfe7ee, 0.12, 0.4);
  const tail = std(0x9c1414, 0.3, 0, { emissive: 0x220000 });
  const amber = std(0xff9a1a, 0.3, 0, { emissive: 0x3a1a00 });
  const liner = std(0x1a1b1c, 0.95, 0, { side: THREE.BackSide });
  const plate = std(0xf2f2f2, 0.5);

  const L2 = VAN_L / 2;
  const W2 = VAN_W / 2;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  /** Профиль → сцена: нос в −z. */
  const at = (x: number, u: number, v: number) => V(x, v, L2 - u);

  const bodyGeo = new THREE.ExtrudeGeometry(vanProfile(), {
    depth: VAN_W - 2 * VAN_B,
    bevelEnabled: true,
    bevelThickness: VAN_B,
    bevelSize: VAN_B,
    bevelSegments: 1,
    curveSegments: 6,
  });
  bodyGeo.translate(-L2, 0, -(W2 - VAN_B));
  bodyGeo.rotateY(Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, [side, paint]);
  body.castShadow = true;
  body.receiveShadow = true;

  const kit = new Kit();
  // Стёкла: борта, лобовое, задние двери.
  for (const sx of [-1, 1]) {
    for (const w of VAN_WINDOWS) kit.add(glass, polygon(w.map(([u, v]) => at(sx * (W2 + 0.004), u, v)), V(sx, 0, 0)));
  }
  {
    const a = new THREE.Vector2(4.42, 1.24);
    const d = new THREE.Vector2(3.78, 1.9).sub(a);
    const n = new THREE.Vector2(d.y, -d.x).normalize();
    const p = (t: number) => a.clone().addScaledVector(d, t).addScaledVector(n, VAN_B + 0.006);
    const lo = p(0.07);
    const hi = p(0.93);
    const hw = W2 - 0.1;
    kit.add(glass, polygon([at(-hw, lo.x, lo.y), at(hw, lo.x, lo.y), at(hw, hi.x, hi.y), at(-hw, hi.x, hi.y)], V(0, n.y, -n.x)));
  }
  for (const [x0, x1] of [[-W2 + 0.12, -0.06], [0.06, W2 - 0.12]] as const) {
    const z = L2 + 0.021;
    kit.add(glass, polygon([V(x0, 1.3, z), V(x1, 1.3, z), V(x1, 1.8, z), V(x0, 1.8, z)], V(0, 0, 1)));
  }

  // Колёса: шина вращением профиля, диск и ступица.
  const tireGeo = new THREE.LatheGeometry(
    [[0.25, -0.11], [0.34, -0.118], [WHEEL_R, -0.07], [WHEEL_R, 0.07], [0.34, 0.118], [0.25, 0.11]].map(([r, y]) => new THREE.Vector2(r, y)),
    14,
  ).rotateZ(Math.PI / 2);
  const WX = W2 - 0.12;
  for (const z of [L2 - AXLE_REAR, L2 - AXLE_FRONT]) {
    for (const sx of [-1, 1]) {
      const x = sx * WX;
      kit.add(tire, tireGeo.clone(), tf(x, WHEEL_R, z));
      kit.add(rim, new THREE.CircleGeometry(0.25, 14).rotateY((sx * Math.PI) / 2), tf(x + sx * 0.1, WHEEL_R, z));
      kit.add(rim, new THREE.CircleGeometry(0.25, 14).rotateY((-sx * Math.PI) / 2), tf(x - sx * 0.1, WHEEL_R, z));
      kit.add(trim, new THREE.CylinderGeometry(0.075, 0.09, 0.05, 10).rotateZ(Math.PI / 2), tf(x + sx * 0.115, WHEEL_R, z));
    }
    // Подкрылок: полуцилиндр в арке, видна внутренняя сторона.
    kit.add(liner, new THREE.CylinderGeometry(ARCH - VAN_B - 0.006, ARCH - VAN_B - 0.006, VAN_W - 0.04, 10, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), tf(0, 0.4, z));
  }
  kit.add(trim, box(1.44, 0.22, 3.9), tf(0, 0.36, 0));

  // Перед: бампер, решётка, фары, номер.
  kit.add(trim, box(2.0, 0.19, 0.16), tf(0, 0.49, -L2 - 0.03));
  kit.add(trim, box(1.0, 0.2, 0.05), tf(0, 0.72, -L2 - 0.015));
  for (const sx of [-1, 1]) kit.add(lamp, box(0.32, 0.13, 0.06), tf(sx * 0.68, 0.86, -L2 - 0.02));
  kit.add(plate, box(0.52, 0.11, 0.012), tf(0, 0.5, -L2 - 0.115));
  // Корма: бампер, фонари, шов дверей, номер.
  kit.add(trim, box(2.0, 0.19, 0.16), tf(0, 0.49, L2 + 0.03));
  for (const sx of [-1, 1]) kit.add(tail, box(0.07, 0.42, 0.05), tf(sx * (W2 - 0.06), 1.0, L2 + 0.02));
  kit.add(trim, box(0.014, 1.42, 0.006), tf(0, 1.2, L2 + 0.031));
  kit.add(plate, box(0.52, 0.11, 0.012), tf(0, 0.5, L2 + 0.115));
  // Зеркала.
  for (const sx of [-1, 1]) {
    kit.add(trim, box(0.14, 0.025, 0.03), tf(sx * (W2 + 0.06), 1.3, -1.8));
    kit.add(trim, box(0.05, 0.24, 0.15), tf(sx * (W2 + 0.13), 1.36, -1.78));
  }
  // Багажник на крыше, маячок, штыревая антенна.
  const ROOF = 2.0 + VAN_B;
  for (const sx of [-1, 1]) {
    kit.add(trim, box(0.04, 0.035, 3.2), tf(sx * 0.78, ROOF + 0.06, 0.7));
    for (const z of [-0.85, 2.25]) kit.add(trim, box(0.05, 0.05, 0.06), tf(sx * 0.78, ROOF + 0.025, z));
  }
  for (const z of [-0.6, 0.7, 2.0]) kit.add(trim, box(1.6, 0.025, 0.05), tf(0, ROOF + 0.09, z));
  kit.add(amber, new THREE.CylinderGeometry(0.08, 0.09, 0.12, 12), tf(0, ROOF + 0.06, -1.05));
  kit.add(trim, new THREE.CylinderGeometry(0.02, 0.025, 0.04, 8), tf(0.5, ROOF + 0.02, 2.1));
  kit.add(trim, rod(V(0.5, ROOF + 0.04, 2.1), V(0.5, ROOF + 0.9, 2.1), 0.004, 4, 0.002));

  const g = new THREE.Group();
  g.name = 'crew-vehicle';
  g.add(body);
  kit.build(g, true, true);
  return g;
});

/** Машина экипажа (фургон/пикап, ~5 × 2 × 2 м), низкополигональная. Начало — на земле, нос в −z. */
export function createVehicle(): THREE.Group {
  return vanTemplate().clone();
}

// ---------- пыль от потока роторов ----------

/** Наибольшее время жизни частицы, с: при amount = 1 пул как раз не переполняется. */
const LIFE_MAX = 2.5;
/** Доля травинок среди частиц. */
const BLADE_SHARE = 0.2;

/** Атлас спрайтов: слева мягкий клуб пыли, справа травинка. Нужен только канал альфа. */
const dustSprite = lazy(() =>
  canvasTexture(
    256,
    128,
    (g) => {
      const r = rng(5);
      const blob = (x: number, y: number, rad: number, a: number) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, `rgba(255,255,255,${a})`);
        gr.addColorStop(0.5, `rgba(255,255,255,${a * 0.45})`);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
      };
      blob(64, 64, 60, 0.5);
      for (let i = 0; i < 9; i++) {
        const a = r() * TAU;
        const d = r() * 22;
        blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 18 + r() * 16, 0.2 + r() * 0.2);
      }
      g.save();
      g.translate(192, 64);
      g.rotate(0.5);
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(0, 0, 7, 44, 0, 0, TAU);
      g.fill();
      g.restore();
    },
    false,
  ),
);

const DUST_VERTEX = `attribute float aSize;
attribute float aAlpha;
attribute float aRot;
attribute vec2 aInfo;
uniform float uViewH;
uniform vec3 uDust;
uniform vec3 uGrass;
uniform vec3 uBlade;
uniform vec3 ambientLightColor;
#if NUM_DIR_LIGHTS > 0
struct DirectionalLight { vec3 direction; vec3 color; };
uniform DirectionalLight directionalLights[NUM_DIR_LIGHTS];
#endif
#if NUM_SUN_LIGHTS > 0
struct SunLight { vec3 direction; vec3 color; };
uniform SunLight sunLights[NUM_SUN_LIGHTS];
#endif
#if NUM_HEMI_LIGHTS > 0
struct HemisphereLight { vec3 direction; vec3 skyColor; vec3 groundColor; };
uniform HemisphereLight hemisphereLights[NUM_HEMI_LIGHTS];
#endif
varying vec4 vColor;
varying vec3 vSpin;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 0.05);
  // Размер в метрах → пиксели текущего вьюпорта.
  gl_PointSize = min(aSize * projectionMatrix[1][1] * uViewH * 0.5 / dist, uViewH * 0.6);
  // Облако без нормалей: рассеянный свет плюс доля прямого.
  vec3 irr = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) irr += mix(hemisphereLights[i].groundColor, hemisphereLights[i].skyColor, 0.6);
  #endif
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) irr += directionalLights[i].color * 0.6;
  #endif
  #if NUM_SUN_LIGHTS > 0
  for (int i = 0; i < NUM_SUN_LIGHTS; i++) irr += sunLights[i].color * 0.6;
  #endif
  vec3 albedo = aInfo.y > 0.5 ? uBlade : mix(uDust, uGrass, aInfo.x);
  // Облако рассеивает свет и вперёд — ярче матовой поверхности (0.5 вместо 1/π).
  // Вплотную к камере частица гаснет — не закрывает весь кадр.
  vColor = vec4(albedo * irr * 0.5, aAlpha * smoothstep(0.6, 3.0, dist));
  vSpin = vec3(cos(aRot), sin(aRot), aInfo.y);
  if (aAlpha <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  #include <fog_vertex>
}`;

const DUST_FRAGMENT = `uniform sampler2D uMap;
varying vec4 vColor;
varying vec3 vSpin;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  p = vec2(vSpin.x * p.x - vSpin.y * p.y, vSpin.y * p.x + vSpin.x * p.y) + 0.5;
  float a = texture2D(uMap, vec2((clamp(p.x, 0.0, 1.0) + vSpin.z) * 0.5, 1.0 - p.y)).a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Пыль и трава от потока роторов на малой высоте. */
export class RotorDust {
  readonly object: THREE.Object3D;
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;
  private max = 0;
  private cursor = 0;
  private acc = 0;
  private alive = 0;
  // Атрибуты (пишутся каждый кадр).
  private pos = new Float32Array(0);
  private size = new Float32Array(0);
  private alpha = new Float32Array(0);
  private rot = new Float32Array(0);
  private info = new Float32Array(0);
  // Состояние частиц.
  private vel = new Float32Array(0);
  private age = new Float32Array(0);
  private life = new Float32Array(0);
  private s0 = new Float32Array(0);
  private s1 = new Float32Array(0);
  private a0 = new Float32Array(0);
  private spin = new Float32Array(0);
  private blade = new Uint8Array(0);

  constructor(maxParticles: number) {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      {
        uMap: { value: null },
        uViewH: { value: 800 },
        uDust: { value: new THREE.Color(0xc9ba9b) },
        uGrass: { value: new THREE.Color(0xa3aa84) },
        uBlade: { value: new THREE.Color(0x5b7a34) },
      },
    ]);
    // Текстуру ставим после merge: он клонирует значения, а атлас общий.
    uniforms['uMap']!.value = dustSprite();
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true,
      depthWrite: false,
      lights: true,
      fog: true,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.name = 'rotor-dust';
    this.points.frustumCulled = false;
    this.points.visible = false;
    const viewport = new THREE.Vector4();
    const viewH = uniforms['uViewH']!;
    // Размер точки зависит от высоты вьюпорта — берём текущий (главный вид, окно камеры, композитор).
    this.points.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(viewport);
      if (viewH.value !== viewport.w) {
        viewH.value = viewport.w;
        this.material.uniformsNeedUpdate = true;
      }
    };
    this.object = this.points;
    this.alloc(Math.max(0, Math.floor(maxParticles)));
  }

  setMax(maxParticles: number) {
    const n = Math.max(0, Math.floor(maxParticles));
    if (n !== this.max) this.alloc(n);
  }

  /** source — положение аппарата (сцена), groundY — высота земли под ним, amount 0…1 (уже учитывает высоту), wind — ветер у земли в сцене (x, z), м/с. */
  update(dt: number, source: THREE.Vector3, groundY: number, amount: number, wind: THREE.Vector2) {
    if (!(dt > 0) || this.max === 0) return;
    dt = Math.min(dt, 0.1);
    amount = THREE.MathUtils.clamp(amount, 0, 1);
    const wx = wind.x;
    const wz = wind.y;

    if (amount > 0.001) {
      this.acc = Math.min(this.acc + amount * (this.max / LIFE_MAX) * dt, this.max * 0.25);
      const n = Math.floor(this.acc);
      this.acc -= n;
      const h = Math.max(0, source.y - groundY);
      for (let k = 0; k < n; k++) this.spawn(source, groundY, h, amount, wx, wz);
      if (n > 0) {
        this.alive += n;
        this.points.geometry.getAttribute('aInfo').needsUpdate = true;
      }
    } else {
      this.acc = 0;
    }
    if (this.alive === 0) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;

    const fDust = Math.exp(-1.1 * dt);
    const fBlade = Math.exp(-1.8 * dt);
    const fRise = Math.exp(-0.6 * dt);
    const { pos, vel, age, life, size, alpha, rot, s0, s1, a0, spin, blade } = this;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const lf = life[i]!;
      let ag = age[i]!;
      if (ag >= lf) continue;
      ag += dt;
      age[i] = ag;
      if (ag >= lf) {
        alpha[i] = 0;
        size[i] = 0;
        continue;
      }
      alive++;
      const t = ag / lf;
      const j = i * 3;
      const isBlade = blade[i] === 1;
      // Сопротивление воздуха тянет скорость к ветру; немного турбулентности.
      const f = isBlade ? fBlade : fDust;
      let vx = wx + (vel[j]! - wx) * f + (Math.random() - 0.5) * 3 * dt;
      let vy = isBlade ? (vel[j + 1]! - 5 * dt) * fBlade : vel[j + 1]! * fRise + 0.12 * dt;
      let vz = wz + (vel[j + 2]! - wz) * f + (Math.random() - 0.5) * 3 * dt;
      const x = pos[j]! + vx * dt;
      let y = pos[j + 1]! + vy * dt;
      const z = pos[j + 2]! + vz * dt;
      const s = s0[i]! + (s1[i]! - s0[i]!) * (1 - (1 - t) * (1 - t));
      const floor = groundY + (isBlade ? 0.02 : 0.1 + 0.2 * s);
      if (y < floor) {
        y = floor;
        vy = Math.max(0, vy);
        if (isBlade) {
          vx *= 0.3;
          vz *= 0.3;
        }
      }
      pos[j] = x;
      pos[j + 1] = y;
      pos[j + 2] = z;
      vel[j] = vx;
      vel[j + 1] = vy;
      vel[j + 2] = vz;
      size[i] = s;
      alpha[i] = a0[i]! * Math.min(1, t / 0.1) * Math.pow(1 - t, 1.4);
      rot[i] = rot[i]! + spin[i]! * dt;
    }
    this.alive = alive;
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aSize').needsUpdate = true;
    geo.getAttribute('aAlpha').needsUpdate = true;
    geo.getAttribute('aRot').needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }

  /** Кольцо под аппаратом (1–3 м), разлёт наружу 4–10 м/с, подъём 0.3–1.5 м/с. */
  private spawn(src: THREE.Vector3, groundY: number, h: number, amount: number, wx: number, wz: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const j = i * 3;
    const a = Math.random() * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r = 1 + Math.random() * 2 * (0.4 + 0.6 * amount) + Math.min(h, 10) * 0.08;
    const isBlade = Math.random() < BLADE_SHARE;
    this.pos[j] = src.x + ca * r;
    this.pos[j + 1] = groundY + 0.05 + Math.random() * 0.25;
    this.pos[j + 2] = src.z + sa * r;
    const speed = (4 + 6 * Math.random()) * (0.5 + 0.5 * amount);
    const swirl = (Math.random() - 0.5) * 2;
    this.vel[j] = ca * speed - sa * swirl + wx * 0.3;
    this.vel[j + 1] = isBlade ? 1 + 2.5 * Math.random() : 0.3 + 1.2 * Math.random();
    this.vel[j + 2] = sa * speed + ca * swirl + wz * 0.3;
    this.age[i] = 0;
    this.blade[i] = isBlade ? 1 : 0;
    if (isBlade) {
      this.life[i] = 0.8 + Math.random();
      this.s0[i] = this.s1[i] = 0.06 + 0.1 * Math.random();
      this.a0[i] = 0.95;
    } else {
      this.life[i] = 1.2 + 1.3 * Math.random();
      this.s0[i] = 0.4 + 0.3 * Math.random();
      this.s1[i] = 2 + Math.random();
      this.a0[i] = (0.3 + 0.25 * Math.random()) * (0.55 + 0.45 * amount);
    }
    this.info[i * 2] = isBlade ? 0 : Math.pow(Math.random(), 1.6);
    this.info[i * 2 + 1] = isBlade ? 1 : 0;
    this.rot[i] = Math.random() * TAU;
    this.spin[i] = (Math.random() - 0.5) * (isBlade ? 14 : 1.4);
    this.size[i] = this.s0[i]!;
    this.alpha[i] = 0;
  }

  /** Новый пул на n частиц; живые из старого (сколько поместится) сохраняются. */
  private alloc(n: number) {
    const keep = Math.min(n, this.max);
    const grow = <T extends Float32Array | Uint8Array>(old: T, per: number, make: (len: number) => T): T => {
      const next = make(n * per);
      next.set(old.subarray(0, keep * per));
      return next;
    };
    const f32 = (len: number) => new Float32Array(len);
    this.pos = grow(this.pos, 3, f32);
    this.size = grow(this.size, 1, f32);
    this.alpha = grow(this.alpha, 1, f32);
    this.rot = grow(this.rot, 1, f32);
    this.info = grow(this.info, 2, f32);
    this.vel = grow(this.vel, 3, f32);
    this.age = grow(this.age, 1, f32);
    this.life = grow(this.life, 1, f32);
    this.s0 = grow(this.s0, 1, f32);
    this.s1 = grow(this.s1, 1, f32);
    this.a0 = grow(this.a0, 1, f32);
    this.spin = grow(this.spin, 1, f32);
    this.blade = grow(this.blade, 1, (len) => new Uint8Array(len));
    this.max = n;
    this.cursor = n > 0 ? this.cursor % n : 0;
    this.alive = keep;

    const geo = new THREE.BufferGeometry();
    const attr = (arr: Float32Array, itemSize: number) => new THREE.BufferAttribute(arr, itemSize).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(this.pos, 3));
    geo.setAttribute('aSize', attr(this.size, 1));
    geo.setAttribute('aAlpha', attr(this.alpha, 1));
    geo.setAttribute('aRot', attr(this.rot, 1));
    geo.setAttribute('aInfo', attr(this.info, 2));
    this.points.geometry.dispose();
    this.points.geometry = geo;
    if (n === 0) this.points.visible = false;
  }
}

// ---------- маркеры маршрута ----------

const WP_COLOR = 0xff9a3c;
const WP_RING_R = 6;
/** Высота подписи вблизи, м; издалека — не меньше доли высоты кадра. */
const LABEL_H = 5;
const LABEL_MIN_SCREEN = 0.03;

const wpShared = lazy(() => {
  const circle: THREE.Vector3[] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * TAU;
    circle.push(new THREE.Vector3(Math.cos(a) * WP_RING_R, 0, Math.sin(a) * WP_RING_R));
  }
  const transparent = { color: WP_COLOR, transparent: true, depthWrite: false };
  return {
    poleGeo: new THREE.CylinderGeometry(0.2, 0.2, 1, 8, 1, true).translate(0, 0.5, 0),
    poleLineGeo: new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
    ringGeo: new THREE.TorusGeometry(WP_RING_R, 0.15, 6, 72).rotateX(Math.PI / 2),
    ringLineGeo: new THREE.BufferGeometry().setFromPoints(circle),
    footGeo: new THREE.RingGeometry(1.0, 1.4, 32).rotateX(-Math.PI / 2),
    pole: new THREE.MeshBasicMaterial({ ...transparent, opacity: 0.45 }),
    ring: new THREE.MeshBasicMaterial({ ...transparent, opacity: 0.9 }),
    line: new THREE.LineBasicMaterial({ ...transparent, opacity: 0.8 }),
    foot: new THREE.MeshBasicMaterial({ ...transparent, opacity: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
});

const labelCache = new Map<string, { tex: THREE.CanvasTexture; aspect: number }>();

function labelTexture(label: string): { tex: THREE.CanvasTexture; aspect: number } {
  const cached = labelCache.get(label);
  if (cached) return cached;
  const font = '700 72px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(label).width) + 48;
  const h = 104;
  const tex = canvasTexture(w, h, (g) => {
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 14;
    g.strokeStyle = 'rgba(12,14,18,0.9)';
    g.strokeText(label, w / 2, h / 2 + 3);
    g.fillStyle = '#ffffff';
    g.fillText(label, w / 2, h / 2 + 3);
  });
  const entry = { tex, aspect: w / h };
  labelCache.set(label, entry);
  return entry;
}

/** Маркер точки маршрута: тонкая мачта от земли до высоты полёта, кольцо на высоте и подпись. */
export function createWaypointMarker(label: string, groundY: number, altitudeY: number): THREE.Group {
  const s = wpShared();
  const height = Math.max(0.5, altitudeY - groundY);
  const top = groundY + height;
  const g = new THREE.Group();
  g.name = `waypoint ${label}`;

  const pole = new THREE.Mesh(s.poleGeo, s.pole);
  // Линия в 1 пиксель держит мачту и кольцо видимыми издалека, когда сетка уже тоньше пикселя.
  const poleLine = new THREE.Line(s.poleLineGeo, s.line);
  for (const o of [pole, poleLine]) {
    o.position.y = groundY;
    o.scale.y = height;
  }
  const ring = new THREE.Mesh(s.ringGeo, s.ring);
  const ringLine = new THREE.LineLoop(s.ringLineGeo, s.line);
  ring.position.y = ringLine.position.y = top;
  const foot = new THREE.Mesh(s.footGeo, s.foot);
  foot.position.y = groundY + 0.3;
  g.add(pole, poleLine, ring, ringLine, foot);

  if (label) {
    const { tex, aspect } = labelTexture(label);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    sprite.name = 'label';
    sprite.center.set(0.5, 0);
    sprite.position.y = top + 2.5;
    sprite.scale.set(LABEL_H * aspect, LABEL_H, 1);
    sprite.renderOrder = 2;
    const here = new THREE.Vector3();
    const eye = new THREE.Vector3();
    // Вблизи подпись в метрах, издалека — не мельче LABEL_MIN_SCREEN высоты кадра (читается с 1–2 км).
    sprite.onBeforeRender = (_r, _s, camera) => {
      let h = LABEL_H;
      const cam = camera as THREE.PerspectiveCamera;
      if (cam.isPerspectiveCamera) {
        const d = here.setFromMatrixPosition(sprite.matrixWorld).distanceTo(eye.setFromMatrixPosition(cam.matrixWorld));
        h = Math.max(LABEL_H, (2 * d * Math.tan((cam.fov * Math.PI) / 360) * LABEL_MIN_SCREEN) / cam.zoom);
      }
      if (sprite.scale.y !== h) {
        sprite.scale.set(h * aspect, h, 1);
        sprite.updateMatrixWorld();
      }
    };
    g.add(sprite);
  }
  return g;
}

// ---------- зона посадки ----------

const ZONE_W = 0.5;
/** Подъём над плоскостью начала против мерцания, м. */
const ZONE_LIFT = 0.06;

const zoneMaterial = lazy(() => {
  // Период: белый штрих, пропуск, оранжевый штрих, пропуск; тёмная окантовка для контраста.
  const tex = canvasTexture(256, 32, (g) => {
    for (const [x0, color] of [[0, '#ffffff'], [128, '#ff9a3c']] as const) {
      g.fillStyle = 'rgba(16,16,16,0.3)';
      g.fillRect(x0 + 2, 0, 88, 32);
      g.fillStyle = color;
      g.fillRect(x0 + 5, 4, 82, 24);
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
});

/** Круг зоны посадки (пунктир) заданного радиуса на земле; начало — центр. */
export function createLandingZone(radiusM: number): THREE.Mesh {
  const r = Math.max(1, radiusM);
  const seg = Math.min(720, Math.max(64, Math.round((TAU * r) / 0.6)));
  // Целое число периодов пунктира (~7 м) — без шва.
  const periods = Math.max(4, Math.round((TAU * r) / 7));
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const u = (i / seg) * periods;
    pos.push(c * (r - ZONE_W / 2), s * (r - ZONE_W / 2), ZONE_LIFT, c * (r + ZONE_W / 2), s * (r + ZONE_W / 2), ZONE_LIFT);
    uv.push(u, 0, u, 1);
    if (i < seg) {
      const k = i * 2;
      idx.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, zoneMaterial());
  mesh.name = 'landing-zone';
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

// ---------- огни ----------

const glowTexture = lazy(() =>
  canvasTexture(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.12, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.28)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.07)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  }),
);

/** Мягкое свечение (аддитивный спрайт) для огней. */
export function glowSprite(color: number, sizeM: number): THREE.Sprite {
  // Материал свой у каждого огня: мигание одного не трогает остальные. Текстура общая.
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      sizeAttenuation: true,
    }),
  );
  sprite.scale.setScalar(sizeM);
  sprite.renderOrder = 3;
  return sprite;
}
