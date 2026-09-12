import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Высота стоек упрощённой модели: начало координат — точка касания земли. */
const GEAR_M = 0.24;
/**
 * RAL 3024 Leuchtrot — светящийся (флуоресцентный) красный. Точно в sRGB не передаётся;
 * берём ближайший насыщенный красно-оранжевый.
 */
const RAL_3024 = 0xf52a1d;
/** Детали, окрашенные в цвет аппарата (имена материалов GLB-модели). */
const LIVERY_PARTS = ['airframe', 'tail', 'aileron'];

export interface AircraftModel {
  /** Позицию и ориентацию задают снаружи. Нос смотрит в −Z, правое крыло — в +X, размеры в метрах. */
  group: THREE.Group;
  /** dt — реальное время кадра, с; lift и pusher — загрузка подъёмных роторов и маршевого винта 0…1. */
  animate(dt: number, lift: number, pusher: number): void;
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
}

const approach = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function discMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0x2a2c30, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
}

function navLight(color: number, at: THREE.Vector3): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(at);
  return m;
}

/** Анимация винтов: разгон, остановка вдоль балки, размытие диска на оборотах. */
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
  return {
    group,
    animate(dt, lift, pusherLoad) {
      clock += dt;
      for (const r of rotors) {
        const target = lift * 62;
        r.omega = approach(r.omega, target, dt, target > r.omega ? 0.5 : 1.2);
        if (r.omega < 1.5 && lift < 0.01) {
          // Остановленные винты встают вдоль балки — так они меньше мешают в крейсере.
          const rel = r.node.rotation.y - r.base - Math.PI / 2;
          const aligned = r.base + Math.PI / 2 + Math.round(rel / Math.PI) * Math.PI;
          r.node.rotation.y = approach(r.node.rotation.y, aligned, dt, 0.25);
        } else {
          r.node.rotation.y += r.dir * r.omega * dt;
        }
      }
      const rotorBlur = smooth01((rotors[0]!.omega - 12) / 40);
      rotorDisc.opacity = 0.28 * rotorBlur;
      blade(rig.rotorBlade, 1 - 0.75 * rotorBlur);

      const pusherTarget = pusherLoad * 80;
      pusherOmega = approach(pusherOmega, pusherTarget, dt, pusherTarget > pusherOmega ? 0.4 : 1.0);
      rig.pusher.rotation.z += pusherOmega * dt;
      const pusherBlur = smooth01((pusherOmega - 12) / 40);
      pusherDisc.opacity = 0.25 * pusherBlur;
      blade(rig.pusherBlade, 1 - 0.75 * pusherBlur);

      rig.strobe.visible = clock % 1.2 < 0.08;
    },
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
    // Окраска аппарата — RAL 3024 (Leuchtrot); винты и подвес остаются тёмными.
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (!Array.isArray(m) && LIVERY_PARTS.includes(m.name)) m.color.set(RAL_3024);
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
  root.add(navLight(0xff2a2a, extremes.left), navLight(0x2aff6a, extremes.right), strobe);

  const group = new THREE.Group();
  group.add(root);
  return rigged(group, {
    rotors,
    pusher,
    rotorRadius: radius(rotors[0]!.node, ['x', 'z']),
    pusherRadius: radius(pusher, ['x', 'y']),
    rotorBlade: materialOf(rotors[0]!.node),
    pusherBlade: materialOf(pusher),
    strobe,
  });
}

/** Упрощённая модель — пока грузится CAD-модель или если она недоступна. */
export function createAircraft(): AircraftModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = GEAR_M;
  group.add(body);

  const white = new THREE.MeshStandardMaterial({ color: RAL_3024, roughness: 0.45, metalness: 0.05 });
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

  const profile = [
    [0, -0.8], [0.05, -0.8], [0.08, -0.62], [0.11, -0.32], [0.125, 0], [0.12, 0.3],
    [0.1, 0.55], [0.07, 0.72], [0.035, 0.82], [0, 0.86],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  add(new THREE.LatheGeometry(profile, 28), white, 0, 0.02, 0).rotation.x = -Math.PI / 2;
  add(new THREE.BoxGeometry(3.0, 0.035, 0.2), white, 0, 0.13, -0.08);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.16, 0.038, 0.202), orange, sx * 1.42, 0.13, -0.08);
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
  add(new THREE.BoxGeometry(0.86, 0.02, 0.17), orange, 0, 0.39, 1.1);

  const pusher = new THREE.Group();
  pusher.position.set(0, 0.02, 0.86);
  body.add(pusher);
  add(new THREE.BoxGeometry(0.425, 0.045, 0.01), pusherBlade, 0, 0, 0, pusher);

  const strobe = navLight(0xffffff, new THREE.Vector3(0, 0.41, 1.1));
  body.add(navLight(0xff2a2a, new THREE.Vector3(-1.51, 0.13, -0.08)), navLight(0x2aff6a, new THREE.Vector3(1.51, 0.13, -0.08)), strobe);

  return rigged(group, { rotors, pusher, rotorRadius: 0.212, pusherRadius: 0.2125, rotorBlade, pusherBlade, strobe });
}
