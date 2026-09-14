import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GroundTest } from '../game/preparation';
import { neutralSurfaces, type Surfaces } from '../game/surfaces';
import { glowSprite } from './props';

/** Высота стоек упрощённой модели: начало координат — точка касания земли. */
const GEAR_M = 0.24;
/**
 * RAL 3024 Leuchtrot — светящийся (флуоресцентный) красный. Точно в sRGB не передаётся;
 * берём ближайший насыщенный красно-оранжевый.
 */
const RAL_3024 = 0xf52a1d;
/** Детали, окрашенные в цвет аппарата (имена материалов GLB-модели). */
const LIVERY_PARTS = ['airframe', 'tail', 'aileron'];
/** Полное отклонение руля, рад. */
const MAX_DEFLECTION_RAD = 0.35;

export interface AircraftModel {
  /** Позицию и ориентацию задают снаружи. Нос смотрит в −Z, правое крыло — в +X, размеры в метрах. */
  group: THREE.Group;
  /**
   * dt — реальное время кадра, с; lift и pusher — загрузка подъёмных роторов и маршевого винта 0…1.
   * test — проверка на земле (предполётная подготовка): роторы по отдельности, рули, огни.
   * surfaces — отклонения рулей в полёте (src/game/surfaces.ts); на проверке СП рули — из test.
   */
  animate(dt: number, lift: number, pusher: number, test?: GroundTest | null, surfaces?: Surfaces | null): void;
  /** Посадочная фара под носом: 0 — выключена, 1 — полная яркость. */
  setLandingLight(level: number): void;
  /** БАНО горят, только когда на борт подано питание. */
  setLights(on: boolean): void;
}

/** Руль на шарнире по передней кромке: поворот вокруг axis (в системе родителя шарнира), плюс — задняя кромка вниз. */
interface SurfaceRig {
  node: THREE.Object3D;
  axis: THREE.Vector3;
  key: keyof Surfaces;
  angle: number;
}

interface Rig {
  /** Узлы подъёмных винтов: вращение вокруг своей оси Y, лопасти в исходном положении — поперёк балки. */
  rotors: { node: THREE.Object3D; dir: number }[];
  /** Узел маршевого винта: вращение вокруг своей оси Z. */
  pusher: THREE.Object3D;
  rotorRadius: number;
  pusherRadius: number;
  rotorBlade: THREE.Material;
  pusherBlade: THREE.Material;
  strobe: THREE.Object3D;
  /** Огни на законцовках крыла: красный слева, зелёный справа. */
  navs: THREE.Object3D[];
  /** Элероны и рули оперения. */
  surfaces: SurfaceRig[];
}

const approach = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

/** Лакированная краска корпуса: плотный цвет и прозрачный лак с бликами неба. */
function paint(from?: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    name: from?.name ?? 'airframe',
    color: RAL_3024,
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.1,
    side: from?.side ?? THREE.FrontSide,
  });
}
const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function discMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0x2a2c30, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
}

function navLight(color: number, at: THREE.Vector3): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(at);
  // Ореол огня — виден издалека и подхватывается свечением при высоком качестве.
  m.add(glowSprite(color, 0.5));
  return m;
}

/** Анимация винтов: разгон, остановка вдоль балки, размытие диска на оборотах; рули и огни. */
function rigged(group: THREE.Group, rig: Rig): AircraftModel {
  const rotorDisc = discMaterial();
  const pusherDisc = discMaterial();
  for (const r of rig.rotors) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(rig.rotorRadius, 40), rotorDisc);
    disc.rotation.x = -Math.PI / 2;
    r.node.add(disc);
  }
  rig.pusher.add(new THREE.Mesh(new THREE.CircleGeometry(rig.pusherRadius, 40), pusherDisc));
  rig.rotorBlade.transparent = true;
  rig.pusherBlade.transparent = true;
  const blade = (m: THREE.Material, opacity: number) => (m.opacity = opacity);

  const rotors = rig.rotors.map((r) => ({ ...r, omega: 0, base: r.node.rotation.y }));
  let pusherOmega = 0;
  let clock = 0;
  let lightsOn = false;
  const neutral = neutralSurfaces();

  // Посадочная фара: под носом, светит вперёд-вниз. Свет есть всегда (меняется только яркость),
  // чтобы при включении не пересобирались шейдеры.
  const box = new THREE.Box3().setFromObject(group);
  const nose = new THREE.Vector3(0, box.min.y + Math.min(0.25, (box.max.y - box.min.y) * 0.3), box.min.z + 0.2);
  const landing = new THREE.SpotLight(0xfff1dc, 0, 160, 0.42, 0.55, 1.6);
  landing.position.copy(nose);
  landing.target.position.copy(nose).add(new THREE.Vector3(0, -12, -14));
  const landingGlow = glowSprite(0xfff1dc, 0.9);
  landingGlow.position.copy(nose);
  landingGlow.visible = false;
  group.add(landing, landing.target, landingGlow);

  return {
    group,
    setLandingLight(level) {
      landing.intensity = 4000 * level;
      landingGlow.visible = level > 0.01;
    },
    setLights(on) {
      lightsOn = on;
    },
    animate(dt, lift, pusherLoad, test, surfaces) {
      clock += dt;
      rotors.forEach((r, i) => {
        // На проверке регуляторов роторы крутятся по одному.
        const load = test ? (test.rotors[i] ?? 0) : lift;
        const target = load * 62;
        r.omega = approach(r.omega, target, dt, target > r.omega ? 0.5 : 1.2);
        if (r.omega < 1.5 && load < 0.01) {
          // Остановленные винты встают вдоль балки — так они меньше мешают в крейсере.
          const rel = r.node.rotation.y - r.base - Math.PI / 2;
          const aligned = r.base + Math.PI / 2 + Math.round(rel / Math.PI) * Math.PI;
          r.node.rotation.y = approach(r.node.rotation.y, aligned, dt, 0.25);
        } else {
          r.node.rotation.y += r.dir * r.omega * dt;
        }
      });
      // Рули: на проверке СП — по программе проверки, иначе — что пришло снаружи.
      const want = test?.surfaces ?? surfaces ?? neutral;
      for (const s of rig.surfaces) {
        s.angle = approach(s.angle, want[s.key] * MAX_DEFLECTION_RAD, dt, 0.06);
        s.node.quaternion.setFromAxisAngle(s.axis, s.angle);
      }
      const rotorBlur = smooth01((Math.max(...rotors.map((r) => r.omega)) - 12) / 40);
      rotorDisc.opacity = 0.28 * rotorBlur;
      blade(rig.rotorBlade, 1 - 0.75 * rotorBlur);

      const pusherTarget = (test ? test.pusher : pusherLoad) * 80;
      pusherOmega = approach(pusherOmega, pusherTarget, dt, pusherTarget > pusherOmega ? 0.4 : 1.0);
      rig.pusher.rotation.z += pusherOmega * dt;
      const pusherBlur = smooth01((pusherOmega - 12) / 40);
      pusherDisc.opacity = 0.25 * pusherBlur;
      blade(rig.pusherBlade, 1 - 0.75 * pusherBlur);

      // БАНО: без питания не горят; на проверке огни мигают, строб — часто.
      const testing = test?.lights ?? false;
      for (const n of rig.navs) n.visible = lightsOn && (!testing || clock % 0.5 < 0.3);
      rig.strobe.visible = lightsOn && (testing ? clock % 0.25 < 0.12 : clock % 1.2 < 0.08);
    },
  };
}

/**
 * Руль из GLB — на шарнир по передней кромке. Ось шарнира — вдоль размаха поверхности: главная ось
 * её точек в плоскости x–y (у элерона почти по X, у руля V-оперения — наклонно), к +X, чтобы плюс
 * у всех рулей означал «задняя кромка вниз».
 */
function hingeSurface(mesh: THREE.Mesh, tail: boolean): SurfaceRig {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  const each = (fn: (p: THREE.Vector3) => void) => {
    for (let i = 0; i < pos.count; i++) fn(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  };
  let mx = 0;
  let my = 0;
  let minZ = Infinity;
  each((p) => {
    mx += p.x;
    my += p.y;
    minZ = Math.min(minZ, p.z);
  });
  mx /= pos.count;
  my /= pos.count;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  each((p) => {
    cxx += (p.x - mx) ** 2;
    cyy += (p.y - my) ** 2;
    cxy += (p.x - mx) * (p.y - my);
  });
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const axis = new THREE.Vector3(Math.cos(th), Math.sin(th), 0);
  if (axis.x < 0) axis.negate();
  const parent = mesh.parent!;
  const pivot = new THREE.Group();
  pivot.position.copy(parent.worldToLocal(new THREE.Vector3(mx, my, minZ)));
  parent.add(pivot);
  pivot.updateMatrixWorld(true);
  pivot.attach(mesh);
  const left = mx < 0;
  return {
    node: pivot,
    axis: axis.transformDirection(parent.matrixWorld.clone().invert()),
    key: tail ? (left ? 'tailL' : 'tailR') : left ? 'ailL' : 'ailR',
    angle: 0,
  };
}

/** Модель аппарата из GLB: узлы airframe, rotor_fl/fr/rl/rr, pusher; материалы airframe, tail, aileron, rotor, pusher. */
export async function loadAircraft(url: string): Promise<AircraftModel> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Окраска аппарата — RAL 3024 (Leuchtrot) под лаком, с отражениями неба; винты и подвес остаются тёмными.
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (Array.isArray(m)) return;
    if (LIVERY_PARTS.includes(m.name)) mesh.material = paint(m);
    else if (m.name === 'gimbal') Object.assign(m, { roughness: 0.28, metalness: 0.45 });
    else m.roughness = 0.45;
  });
  const need = (name: string) => {
    const o = root.getObjectByName(name);
    if (!o) throw new Error(`В модели нет узла ${name}`);
    return o;
  };
  const materialOf = (o: THREE.Object3D) => {
    let found: THREE.Material | null = null;
    o.traverse((x) => {
      const m = (x as THREE.Mesh).material;
      if (!found && m && !Array.isArray(m)) found = m;
    });
    if (!found) throw new Error(`У узла ${o.name} нет материала`);
    return found as THREE.Material;
  };
  const radius = (o: THREE.Object3D, axes: ('x' | 'y' | 'z')[]) => {
    const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    return Math.max(...axes.map((a) => size[a])) / 2;
  };

  const rotors = (
    [
      ['rotor_fl', 1],
      ['rotor_fr', -1],
      ['rotor_rl', -1],
      ['rotor_rr', 1],
    ] as const
  ).map(([name, dir]) => ({ node: need(name), dir }));
  const pusher = need('pusher');

  // Огни — по крайним точкам планера: законцовки крыла и верх оперения.
  const airframe = need('airframe');
  airframe.updateMatrixWorld(true);
  const extremes = { left: new THREE.Vector3(Infinity), right: new THREE.Vector3(-Infinity), top: new THREE.Vector3(0, -Infinity) };
  const v = new THREE.Vector3();
  airframe.traverse((o) => {
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const pos = geo?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.x < extremes.left.x) extremes.left.copy(v);
      if (v.x > extremes.right.x) extremes.right.copy(v);
      if (v.y > extremes.top.y) extremes.top.copy(v);
    }
  });
  const strobe = navLight(0xffffff, extremes.top.clone().add(new THREE.Vector3(0, 0.02, 0)));
  const navs = [navLight(0xff2a2a, extremes.left), navLight(0x2aff6a, extremes.right)];
  root.add(...navs, strobe);

  // Рули — отдельные тела: элероны (материал aileron) и рули V-оперения (tail).
  const bodies: { mesh: THREE.Mesh; tail: boolean }[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && (m.name === 'aileron' || m.name === 'tail')) bodies.push({ mesh: o as THREE.Mesh, tail: m.name === 'tail' });
  });
  root.updateMatrixWorld(true);
  const surfaces = bodies.map(({ mesh, tail }) => hingeSurface(mesh, tail));

  const group = new THREE.Group();
  group.add(root);
  return rigged(group, {
    surfaces,
    rotors,
    pusher,
    rotorRadius: radius(rotors[0]!.node, ['x', 'z']),
    pusherRadius: radius(pusher, ['x', 'y']),
    rotorBlade: materialOf(rotors[0]!.node),
    pusherBlade: materialOf(pusher),
    strobe,
    navs,
  });
}

/** Упрощённая модель — пока грузится CAD-модель или если она недоступна. */
export function createAircraft(): AircraftModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = GEAR_M;
  group.add(body);

  const white = paint();
  const orange = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.5 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.55, metalness: 0.3 });
  const black = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.4, metalness: 0.2 });
  const rotorBlade = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5 });
  const pusherBlade = rotorBlade.clone();

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  /** Руль на шарнире с осью по X; тело руля — позади шарнира (нос — к −Z). */
  const surfaces: SurfaceRig[] = [];
  const hinged = (key: keyof Surfaces, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const hinge = new THREE.Group();
    hinge.position.set(x, y, z);
    body.add(hinge);
    add(new THREE.BoxGeometry(w, h, d), orange, 0, 0, d / 2, hinge);
    surfaces.push({ node: hinge, axis: new THREE.Vector3(1, 0, 0), key, angle: 0 });
  };

  const profile = [
    [0, -0.8], [0.05, -0.8], [0.08, -0.62], [0.11, -0.32], [0.125, 0], [0.12, 0.3],
    [0.1, 0.55], [0.07, 0.72], [0.035, 0.82], [0, 0.86],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  add(new THREE.LatheGeometry(profile, 28), white, 0, 0.02, 0).rotation.x = -Math.PI / 2;
  add(new THREE.BoxGeometry(3.0, 0.035, 0.2), white, 0, 0.13, -0.08);
  // Законцовки-элероны на шарнире по передней кромке.
  for (const sx of [-1, 1]) hinged(sx < 0 ? 'ailL' : 'ailR', sx * 1.42, 0.13, -0.181, 0.16, 0.038, 0.202);
  add(new THREE.SphereGeometry(0.075, 20, 14), black, 0, -0.15, -0.45);

  const rotors: Rig['rotors'] = [];
  for (const sx of [-1, 1]) {
    const x = sx * 0.42;
    add(new THREE.CylinderGeometry(0.028, 0.028, 1.95, 12), grey, x, 0.09, 0.175).rotation.x = Math.PI / 2;
    for (const z of [-0.72, 0.6]) {
      add(new THREE.CylinderGeometry(0.04, 0.045, 0.08, 16), black, x, 0.15, z);
      const legLength = 0.062 + GEAR_M;
      add(new THREE.CylinderGeometry(0.012, 0.012, legLength, 8), grey, x, 0.062 - legLength / 2, z);
      const rotor = new THREE.Group();
      rotor.position.set(x, 0.2, z);
      body.add(rotor);
      add(new THREE.BoxGeometry(0.4, 0.008, 0.05), rotorBlade, 0, 0, 0, rotor);
      rotors.push({ node: rotor, dir: sx * (z < 0 ? 1 : -1) });
    }
    add(new THREE.BoxGeometry(0.018, 0.3, 0.2), white, x, 0.24, 1.08);
  }
  // Стабилизатор и две половины руля высоты за ним — вместо рулей V-оперения настоящей модели.
  add(new THREE.BoxGeometry(0.86, 0.02, 0.11), orange, 0, 0.39, 1.07);
  for (const sx of [-1, 1]) hinged(sx < 0 ? 'tailL' : 'tailR', sx * 0.215, 0.39, 1.125, 0.42, 0.018, 0.06);

  const pusher = new THREE.Group();
  pusher.position.set(0, 0.02, 0.86);
  body.add(pusher);
  add(new THREE.BoxGeometry(0.425, 0.045, 0.01), pusherBlade, 0, 0, 0, pusher);

  const strobe = navLight(0xffffff, new THREE.Vector3(0, 0.41, 1.1));
  const navs = [navLight(0xff2a2a, new THREE.Vector3(-1.51, 0.13, -0.08)), navLight(0x2aff6a, new THREE.Vector3(1.51, 0.13, -0.08))];
  body.add(...navs, strobe);

  return rigged(group, { rotors, pusher, rotorRadius: 0.212, pusherRadius: 0.2125, rotorBlade, pusherBlade, strobe, navs, surfaces });
}
