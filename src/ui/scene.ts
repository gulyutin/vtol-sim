import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { fromLocal, toLocal } from '../sim/mission';
import type { SunPosition } from '../sim/sun';
import type { Coverage, Frame } from '../sim/survey';
import type { LocalPoint } from '../sim/timeline';
import type { GeoPoint, Site, Terrain } from '../sim/types';
import { createAircraft, type AircraftModel } from './aircraftModel';
import type { Bounds } from './terrainData';
import { TerrainLod } from './terrainLod';

export type CameraMode = 'follow' | 'chase' | 'pad';

export interface Pose {
  position: LocalPoint;
  headingDeg: number;
  pitchDeg: number;
  /** Положительный — крен вправо. */
  bankDeg: number;
}

export interface Environment {
  terrain: Terrain;
  site: Site;
  /** Область, покрытая рельефом и снимками. */
  bounds: Bounds;
  /** Участок съёмки. */
  area: GeoPoint[];
  /** Наибольший уровень снимков (ESRI над Уралом есть до z19). */
  maxImageryZoom: number;
  /** Нижняя граница облаков над площадкой, м; покрытие 0…1. */
  cloudBaseM: number;
  cloudCover: number;
}

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const TRAIL_MAX = 40_000;
const FRAMES_MAX = 5_000;
/** Отрезков на сторону кадра — чтобы контур лёг на рельеф. */
const EDGE_STEPS = 4;

/** Локальные координаты задания → сцена: x — восток, y — вверх (над площадкой взлёта), z — юг. */
export function toScene(p: LocalPoint, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p.east, p.up, -p.north);
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const CLOUD_VERTEX = `varying vec3 vWorld;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const CLOUD_FRAGMENT = `uniform vec2 offset; uniform float cover; uniform vec3 lit; uniform vec3 shade; uniform vec3 cam; uniform float fadeFar;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
void main() {
  vec2 p = (vWorld.xz + offset) / 2600.0;
  float d = fbm(p);
  float c = smoothstep(1.0 - cover, 1.0 - cover + 0.22, d);
  float fade = 1.0 - smoothstep(fadeFar * 0.45, fadeFar, distance(cam.xz, vWorld.xz));
  vec3 col = mix(shade, lit, smoothstep(0.35, 0.85, fbm(p * 1.7 + 3.0)));
  gl_FragColor = vec4(col, c * fade * 0.95);
  #include <colorspace_fragment>
}`;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 60000);
  readonly controls: OrbitControls;
  aircraft: AircraftModel = createAircraft();
  private cameraMode: CameraMode = 'follow';
  private readonly terrain: Terrain;
  private readonly site: Site;
  private readonly lod: TerrainLod;
  private readonly sky = new Sky();
  private readonly skyEnv = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastSun: SunPosition | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private readonly hemi = new THREE.HemisphereLight(0xdcecff, 0x6a6a55, 0.7);
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly clouds: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly routeGroup = new THREE.Group();
  private areaLine: THREE.LineLoop | null = null;
  private pads: THREE.Mesh[] = [];
  private readonly trail: THREE.Line;
  private trailCount = 0;
  private readonly frameLines: THREE.LineSegments;
  private frameCount = 0;
  private coverage: THREE.Mesh | null = null;
  private readonly dust: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly sockPivot = new THREE.Group();
  private readonly target = new THREE.Vector3();
  private readonly lastTarget = new THREE.Vector3();
  private readonly padCamera: THREE.Vector3;
  private readonly chaseOffset = new THREE.Vector3(0, 3.5, 13);
  private readonly pipCamera = new THREE.PerspectiveCamera(6, 3 / 2, 0.5, 30000);
  private clock = 0;
  private readonly windOffset = new THREE.Vector2();
  private readonly cloudWind = new THREE.Vector2();

  constructor(private readonly container: HTMLElement, env: Environment) {
    this.terrain = env.terrain;
    this.site = env.site;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // Небо по модели рассеяния Прити; тот же купол даёт отражения на модели аппарата.
    this.sky.scale.setScalar(450000);
    const u = this.sky.material.uniforms;
    u['turbidity']!.value = 5;
    u['rayleigh']!.value = 1.4;
    u['mieCoefficient']!.value = 0.004;
    u['mieDirectionalG']!.value = 0.8;
    this.scene.add(this.sky);
    this.skyEnv.add(new Sky().copy(this.sky));

    this.scene.fog = new THREE.Fog(0xbfd0e0, 6000, 38000);
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -10;
    sc.right = 10;
    sc.top = 10;
    sc.bottom = -10;
    sc.near = 1;
    sc.far = 3000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.lod = new TerrainLod(env.terrain, env.site, env.bounds, env.maxImageryZoom, this.renderer.capabilities.getMaxAnisotropy());

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
    trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x00e5ff }));
    this.trail.frustumCulled = false;

    const verts = FRAMES_MAX * EDGE_STEPS * 4 * 2;
    const frameGeo = new THREE.BufferGeometry();
    frameGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    frameGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    frameGeo.setDrawRange(0, 0);
    this.frameLines = new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    this.frameLines.frustumCulled = false;

    this.scene.add(this.lod.group, this.createGroundFill(env.bounds), this.routeGroup, this.trail, this.frameLines, this.createPad());
    this.scene.add(this.createWindsock({ east: 8, north: 6 }));
    this.setArea(env.area);

    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(120000, 120000),
      new THREE.ShaderMaterial({
        vertexShader: CLOUD_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          offset: { value: this.windOffset },
          cover: { value: env.cloudCover },
          lit: { value: new THREE.Color(0xffffff) },
          shade: { value: new THREE.Color(0x9aa6b4) },
          cam: { value: new THREE.Vector3() },
          fadeFar: { value: 40000 },
        },
      }),
    );
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = env.cloudBaseM;
    this.scene.add(this.clouds);

    this.dust = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xcbb893, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.dust.rotation.x = -Math.PI / 2;
    this.scene.add(this.dust, this.aircraft.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 6000;
    this.camera.position.set(7, 3.2, 11);
    this.controls.target.set(0, 1, 0);
    this.lastTarget.set(0, 0.4, 0);
    this.padCamera = new THREE.Vector3(24, this.groundAt(24, -16) + 1.7, 16);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Высота рельефа в точке (восток, север) относительно площадки взлёта. */
  groundAt(east: number, north: number): number {
    return this.terrain.elevationM(fromLocal(this.site, east, north)) - this.site.elevationM;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setAircraft(model: AircraftModel) {
    model.group.position.copy(this.aircraft.group.position);
    model.group.rotation.copy(this.aircraft.group.rotation);
    this.scene.remove(this.aircraft.group);
    this.aircraft = model;
    this.scene.add(model.group);
  }

  setCameraMode(mode: CameraMode) {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'follow';
    if (mode === 'follow') {
      this.camera.fov = 50;
      this.camera.position.copy(this.target).add(new THREE.Vector3(9, 4, 12));
      this.controls.target.copy(this.target);
      this.camera.updateProjectionMatrix();
    }
  }

  setPose(pose: Pose) {
    toScene(pose.position, this.aircraft.group.position);
    this.aircraft.group.rotation.set(pose.pitchDeg * DEG, -pose.headingDeg * DEG, -pose.bankDeg * DEG, 'YXZ');
  }

  /** Ветер у земли (для ветроуказателя) и на высоте облаков (для их сноса). Направление — откуда дует. */
  setWind(groundMs: number, fromDeg: number, cloudsMs: number) {
    const to = (fromDeg + 180) * DEG;
    const droop = (1 - Math.min(1, groundMs / 9)) * 75 * DEG;
    this.sockPivot.rotation.set(0, Math.PI / 2 - to, -droop, 'YZX');
    this.cloudWind.set(Math.sin(to) * cloudsMs, -Math.cos(to) * cloudsMs);
  }

  /** Положение Солнца: небо, прямой свет, рассеянный свет, дымка и отражения. */
  setSun(sun: SunPosition) {
    if (this.lastSun && Math.abs(this.lastSun.elevationDeg - sun.elevationDeg) < 0.2 && Math.abs(this.lastSun.azimuthDeg - sun.azimuthDeg) < 0.2) return;
    this.lastSun = sun;
    const el = sun.elevationDeg * DEG;
    const az = sun.azimuthDeg * DEG;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    this.sky.material.uniforms['sunPosition']!.value.copy(this.sunDir);
    (this.skyEnv.children[0] as Sky).material.uniforms['sunPosition']!.value.copy(this.sunDir);

    const day = THREE.MathUtils.smoothstep(sun.elevationDeg, -4, 12);
    const warm = 1 - THREE.MathUtils.smoothstep(sun.elevationDeg, 2, 30);
    this.sun.color.setRGB(1, 0.96 - 0.25 * warm, 0.9 - 0.45 * warm);
    this.sun.intensity = 3.2 * day;
    this.hemi.intensity = 0.35 + 0.9 * day;
    (this.scene.fog as THREE.Fog).color.setRGB(0.55 + 0.2 * day - 0.05 * warm, 0.62 + 0.2 * day - 0.1 * warm, 0.7 + 0.18 * day - 0.2 * warm);
    const clouds = this.clouds.material.uniforms;
    (clouds['lit']!.value as THREE.Color).setRGB(1, 1 - 0.15 * warm, 1 - 0.3 * warm).multiplyScalar(0.4 + 0.6 * day);
    (clouds['shade']!.value as THREE.Color).setRGB(0.55, 0.6, 0.68).multiplyScalar(0.4 + 0.6 * day);

    this.envTarget?.dispose();
    this.envTarget = this.pmrem.fromScene(this.skyEnv);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.6;
  }

  /** Контур участка съёмки, уложенный на рельеф. */
  setArea(area: GeoPoint[]) {
    if (this.areaLine) {
      this.scene.remove(this.areaLine);
      this.areaLine.geometry.dispose();
      this.areaLine = null;
    }
    if (area.length < 2) return;
    const pts: THREE.Vector3[] = [];
    const local = area.map((p) => toLocal(this.site, p));
    for (let i = 0; i < local.length; i++) {
      const a = local[i]!;
      const b = local[(i + 1) % local.length]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.east - a.east, b.north - a.north) / 20));
      for (let k = 0; k < n; k++) {
        const e = a.east + ((b.east - a.east) * k) / n;
        const nn = a.north + ((b.north - a.north) * k) / n;
        pts.push(new THREE.Vector3(e, this.groundAt(e, nn) + 4, -nn));
      }
    }
    this.areaLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.scene.add(this.areaLine);
  }

  /** Маршрут: пунктир на высоте полёта и след на земле. */
  setRoute(route: LocalPoint[]) {
    for (const child of [...this.routeGroup.children]) {
      this.routeGroup.remove(child);
      (child as THREE.Line).geometry?.dispose();
    }
    if (route.length < 2) return;
    const air = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(route.map((p) => toScene(p))),
      new THREE.LineDashedMaterial({ color: 0xff9a3c, dashSize: 14, gapSize: 10 }),
    );
    air.computeLineDistances();
    const ground = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(route.map((p) => new THREE.Vector3(p.east, this.groundAt(p.east, p.north) + 2, -p.north))),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
    );
    this.routeGroup.add(ground, air);
  }

  resetTrail() {
    this.trailCount = 0;
    this.trail.geometry.setDrawRange(0, 0);
  }

  appendTrail(p: LocalPoint) {
    if (this.trailCount >= TRAIL_MAX) return;
    const a = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    a.setXYZ(this.trailCount++, p.east, p.up, -p.north);
    a.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailCount);
  }

  resetFrames() {
    this.frameCount = 0;
    this.frameLines.geometry.setDrawRange(0, 0);
  }

  /** Контур кадра на земле: зелёный — годный, красный — брак. */
  addFrame(f: Frame) {
    if (this.frameCount >= FRAMES_MAX) return;
    const pos = this.frameLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.frameLines.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color(f.ok ? 0x7dffa8 : 0xff5d5d);
    let v = this.frameCount * EDGE_STEPS * 8;
    for (let i = 0; i < 4; i++) {
      const [ae, an] = f.corners[i]!;
      const [be, bn] = f.corners[(i + 1) % 4]!;
      for (let k = 0; k < EDGE_STEPS; k++) {
        for (const s of [k / EDGE_STEPS, (k + 1) / EDGE_STEPS]) {
          const e = ae + (be - ae) * s;
          const n = an + (bn - an) * s;
          pos.setXYZ(v, e, this.groundAt(e, n) + 3, -n);
          col.setXYZ(v, c.r, c.g, c.b);
          v++;
        }
      }
    }
    this.frameCount++;
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.frameLines.geometry.setDrawRange(0, this.frameCount * EDGE_STEPS * 8);
  }

  /** Карта покрытия: сколько годных кадров легло на клетку. null — убрать. */
  setCoverage(cov: Coverage | null) {
    if (this.coverage) {
      this.scene.remove(this.coverage);
      this.coverage.geometry.dispose();
      this.coverage = null;
    }
    if (!cov) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    for (let j = 0; j < cov.rows; j++) {
      for (let i = 0; i < cov.cols; i++) {
        const k = j * cov.cols + i;
        if (!cov.inside[k]) continue;
        const c = cov.counts[k]!;
        color.set(c >= 5 ? 0x4fd08a : c >= 3 ? 0xffc24d : c >= 1 ? 0xff5d5d : 0x7a1414);
        const e0 = cov.e0 + i * cov.cellM;
        const n0 = cov.n0 + j * cov.cellM;
        const y = this.groundAt(e0 + cov.cellM / 2, n0 + cov.cellM / 2) + 2.5;
        const q = [
          [e0, n0],
          [e0 + cov.cellM, n0],
          [e0 + cov.cellM, n0 + cov.cellM],
          [e0, n0 + cov.cellM],
        ];
        for (const idx of [0, 1, 2, 0, 2, 3]) {
          positions.push(q[idx]![0]!, y, -q[idx]![1]!);
          colors.push(color.r, color.g, color.b);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.coverage = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.scene.add(this.coverage);
  }

  /** amount 0…1 — насколько сильно поток от винтов поднимает пыль. */
  updateDust(dt: number, position: LocalPoint, amount: number) {
    this.clock += dt;
    this.dust.position.set(position.east, this.groundAt(position.east, position.north) + 0.15, -position.north);
    this.dust.scale.setScalar(2.2 + 1.2 * Math.sin(this.clock * 7) ** 2 + 1.5 * amount);
    this.dust.material.opacity = 0.45 * amount;
  }

  updateCamera(dt: number, pose: Pose) {
    toScene(pose.position, this.target);
    this.target.y += 0.4;
    const h = pose.headingDeg * DEG;
    const forward = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));

    if (this.cameraMode === 'follow') {
      this.camera.position.add(this.target.clone().sub(this.lastTarget));
      this.controls.target.copy(this.target);
      this.controls.update();
    } else if (this.cameraMode === 'chase') {
      // Смещение держится относительно аппарата: при ускорении времени камера не отстаёт,
      // сглаживается только поворот вслед за курсом.
      const desired = forward.clone().multiplyScalar(-13).addScaledVector(UP, 3.5);
      this.chaseOffset.lerp(desired, 1 - Math.exp(-dt * 2.5));
      this.camera.position.copy(this.target).add(this.chaseOffset);
      this.camera.lookAt(this.target);
      if (this.camera.fov !== 50) {
        this.camera.fov = 50;
        this.camera.updateProjectionMatrix();
      }
    } else {
      // С площадки — как наблюдатель с телевиком: аппарат держится в кадре одного размера.
      this.camera.position.copy(this.padCamera);
      this.camera.lookAt(this.target);
      const d = this.camera.position.distanceTo(this.target);
      this.camera.fov = Math.min(55, Math.max(1.2, (2 * Math.atan(6 / d)) / DEG));
      this.camera.updateProjectionMatrix();
    }
    const floor = this.groundAt(this.camera.position.x, -this.camera.position.z) + 1.5;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.lastTarget.copy(this.target);

    this.sun.position.copy(this.target).addScaledVector(this.sunDir, 1200);
    this.sun.target.position.copy(this.target);
  }

  render(dt = 0) {
    this.windOffset.addScaledVector(this.cloudWind, -dt);
    (this.clouds.material.uniforms['cam']!.value as THREE.Vector3).copy(this.camera.position);
    this.clouds.position.x = this.camera.position.x;
    this.clouds.position.z = this.camera.position.z;
    this.lod.update(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Окно камеры нагрузки поверх 3D-вида: камера в точке eye смотрит на look.
   * rect — в CSS-пикселях от правого нижнего угла вида. up — «верх» кадра (нужен, когда смотрим вниз).
   */
  renderPip(rect: { right: number; bottom: number; width: number; height: number }, eye: LocalPoint, look: LocalPoint, fovDeg: number, up?: THREE.Vector3) {
    const size = this.renderer.getSize(new THREE.Vector2());
    const cam = this.pipCamera;
    toScene(eye, cam.position);
    cam.up.copy(up ?? UP);
    cam.fov = fovDeg;
    cam.aspect = rect.width / rect.height;
    cam.updateProjectionMatrix();
    cam.lookAt(toScene(look));
    const x = size.x - rect.right - rect.width;
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, rect.bottom, rect.width, rect.height);
    this.renderer.setScissor(x, rect.bottom, rect.width, rect.height);
    this.renderer.render(this.scene, cam);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
  }

  /** Равнина вокруг загруженного рельефа — чтобы до горизонта не было пустоты. */
  private createGroundFill(bounds: Bounds): THREE.Mesh {
    let min = Infinity;
    for (const lat of [bounds.south, bounds.north]) {
      for (const lon of [bounds.west, bounds.east]) min = Math.min(min, this.terrain.elevationM({ lat, lon }));
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), new THREE.MeshLambertMaterial({ color: 0x5f6b45 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = min - this.site.elevationM - 40;
    return ground;
  }

  /** Дополнительные площадки посадки (пункт доставки), локальные метры. */
  setPads(points: { east: number; north: number }[]) {
    for (const p of this.pads) {
      this.scene.remove(p);
      p.geometry.dispose();
    }
    this.pads = points.map((p) => this.createPad(p.east, p.north));
    for (const p of this.pads) this.scene.add(p);
  }

  private createPad(east = 0, north = 0): THREE.Mesh {
    const tex = canvasTexture(256, (g) => {
      g.fillStyle = '#6b6f73';
      g.beginPath();
      g.arc(128, 128, 126, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#f4f4f0';
      g.lineWidth = 9;
      g.beginPath();
      g.arc(128, 128, 106, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#f4f4f0';
      g.font = 'bold 150px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('H', 128, 136);
    });
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(4.5, 48),
      new THREE.MeshLambertMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(east, this.groundAt(east, north) + 0.25, -north);
    pad.receiveShadow = true;
    return pad;
  }

  private createWindsock(at: { east: number; north: number }): THREE.Group {
    const g = new THREE.Group();
    g.position.set(at.east, this.groundAt(at.east, at.north), -at.north);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 5, 10), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.4 }));
    pole.position.y = 2.5;
    g.add(pole);
    const tex = canvasTexture(64, (ctx) => {
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? '#f4f4f0' : '#ff5a14';
        ctx.fillRect(0, (i * 64) / 5, 64, 64 / 5 + 1);
      }
    });
    const sock = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.38, 2.4, 16, 1, true),
      new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    sock.rotation.z = -Math.PI / 2;
    sock.position.x = 1.2;
    this.sockPivot.position.y = 4.9;
    this.sockPivot.add(sock);
    g.add(this.sockPivot);
    return g;
  }
}
