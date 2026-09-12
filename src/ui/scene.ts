import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AIRCRAFT } from '../sim/aircraft';
import { fromLocal, toLocal } from '../sim/mission';
import type { OsmData } from '../sim/osm';
import type { SunPosition } from '../sim/sun';
import type { Coverage, Frame } from '../sim/survey';
import type { LocalPoint } from '../sim/timeline';
import type { GeoPoint, Site, Terrain, Weather } from '../sim/types';
import type { Zone } from '../sim/zones';
import { createAircraft, type AircraftModel } from './aircraftModel';
import { OsmLayer } from './osmLayer';
import { createGroundStation, createLandingPad, createLandingZone, createVehicle, createWaypointMarker, RotorDust } from './props';
import { QUALITY, type QualitySettings } from './quality';
import { SkyDome } from './skyDome';
import { fogFor, overcastFactor, Precipitation } from './precipitation';
import type { Bounds } from './terrainData';
import { TerrainLod } from './terrainLod';
import { ZoneWalls } from './zones3d';

/** follow — облёт мышью; chase — за хвостом (тоже можно вращать); pad — с площадки; cinema — смена ракурсов. */
export type CameraMode = 'follow' | 'chase' | 'tail' | 'pad' | 'cinema';

export interface Pose {
  position: LocalPoint;
  headingDeg: number;
  pitchDeg: number;
  /** Положительный — крен вправо. */
  bankDeg: number;
}

/** Точка маршрута в 3D: положение, высота (над площадкой взлёта) и подпись. */
export interface Marker {
  east: number;
  north: number;
  up: number;
  label: string;
}

export interface Environment {
  terrain: Terrain;
  site: Site;
  /** Область, покрытая рельефом и снимками. */
  bounds: Bounds;
  /** Участок съёмки. */
  area: GeoPoint[];
  /** Наибольший уровень снимков до выбора качества. */
  maxImageryZoom: number;
  /** Нижняя граница облаков над площадкой, м; покрытие 0…1. */
  cloudBaseM: number;
  cloudCover: number;
  quality?: QualitySettings;
}

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const TRAIL_MAX = 40_000;
const FRAMES_MAX = 5_000;
/** Отрезков на сторону кадра — чтобы контур лёг на рельеф. */
const EDGE_STEPS = 4;
/** Смена ракурса в режиме «кино», с. */
const CINEMA_SHOT_S = 9;

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
  /** 0 — день, 1 — ночь (по высоте Солнца). */
  nightFactor = 0;
  private cameraMode: CameraMode = 'follow';
  private q: QualitySettings;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly terrain: Terrain;
  private readonly site: Site;
  private readonly lod: TerrainLod;
  private osm: OsmLayer | null = null;
  private readonly sky = new SkyDome();
  private readonly skyEnv = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastSun: SunPosition | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private readonly hemi = new THREE.HemisphereLight(0xdcecff, 0x6a6a55, 0.7);
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly clouds: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** Дождь и снег вокруг камеры. */
  private readonly precip: Precipitation;
  /** 0 — ясно, 1 — сплошная облачность: гасит Солнце и серит небо. */
  private overcast = 0;
  private readonly routeGroup = new THREE.Group();
  private readonly markerGroup = new THREE.Group();
  /** Стены запретных зон и зон РЭБ. */
  private readonly zoneWalls = new ZoneWalls((e, n) => this.groundAt(e, n));
  private areaLine: THREE.LineLoop | null = null;
  private pads: THREE.Group[] = [];
  private readonly trail: THREE.Line;
  private trailCount = 0;
  private readonly frameLines: THREE.LineSegments;
  private frameCount = 0;
  private coverage: THREE.Mesh | null = null;
  private readonly dust: RotorDust;
  private readonly blob: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly groundWind = new THREE.Vector2();
  private readonly sockPivot = new THREE.Group();
  private readonly target = new THREE.Vector3();
  private readonly lastTarget = new THREE.Vector3();
  private readonly padCamera: THREE.Vector3;
  private readonly chaseOffset = new THREE.Vector3(0, 3.5, 13);
  private readonly pipCamera = new THREE.PerspectiveCamera(6, 3 / 2, 0.5, 30000);
  private readonly tmp = new THREE.Vector3();
  private clock = 0;
  private readonly windOffset = new THREE.Vector2();
  private readonly cloudWind = new THREE.Vector2();
  // Камера за хвостом: поворот мышью вокруг аппарата и расстояние колёсиком.
  private orbitYaw = 0;
  private orbitPitch = 0;
  private chaseDist = 13.5;
  // Камера на хвосте: точка крепления в системе модели и небольшой наклон вниз.
  private tailMount: THREE.Vector3 | null = null;
  private readonly tailTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -6 * DEG);
  private speed = 0;
  // Режим «кино».
  private shot = -1;
  private shotLeft = 0;
  private readonly shotEye = new THREE.Vector3();

  constructor(private readonly container: HTMLElement, env: Environment) {
    this.terrain = env.terrain;
    this.site = env.site;
    this.q = env.quality ?? QUALITY.medium;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // Композитор: сцена в HDR с MSAA, свечение ярких мест, затем тональная кривая и sRGB.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Небо — градиент с явными цветами (skyDome.ts); тот же купол даёт отражения на модели аппарата.
    this.scene.add(this.sky.mesh);
    this.skyEnv.add(this.sky.envMesh);

    // Дымка: чем дальше, тем больше рельеф уходит в цвет неба.
    this.scene.fog = new THREE.Fog(0xbfd0e0, 4000, 34000);
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.left = -12;
    sc.right = 12;
    sc.top = 12;
    sc.bottom = -12;
    sc.near = 1;
    sc.far = 3000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
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

    this.scene.add(this.lod.group, this.createGroundFill(env.bounds), this.routeGroup, this.markerGroup, this.trail, this.frameLines, this.createPad(0, 0));
    this.scene.add(this.createWindsock({ east: 8, north: 6 }), this.createCamp(), this.zoneWalls.group);
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
    this.precip = new Precipitation(this.q.precipParticles);
    this.scene.add(this.precip.object);
    this.scene.add(this.clouds);

    this.dust = new RotorDust(this.q.dustParticles);
    // Мягкая тень под аппаратом: видна на любой высоте, в отличие от карты теней вокруг него.
    const blobTex = canvasTexture(128, (g) => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.45, 'rgba(0,0,0,0.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    });
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.scene.add(this.dust.object, this.blob, this.aircraft.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 6000;
    this.camera.position.set(7, 3.2, 11);
    this.controls.target.set(0, 1, 0);
    this.lastTarget.set(0, 0.4, 0);
    this.padCamera = new THREE.Vector3(24, this.groundAt(24, -16) + 1.7, 16);
    this.bindChaseMouse();

    this.setQuality(this.q);
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
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Качество графики: разрешение, тени, постобработка, детальность рельефа, дома и деревья, пыль. */
  setQuality(q: QualitySettings) {
    this.q = q;
    const ratio = Math.min(window.devicePixelRatio, q.pixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.bloom.enabled = q.bloom;
    this.lod.setQuality(q.lodSplit, q.maxImageryZoom, q.detailTexture, q.cloudShadows);
    this.osm?.setQuality(q);
    this.dust.setMax(q.dustParticles);
    this.precip.setMax(q.precipParticles);
    this.resize();
  }

  /** Погода в картинке: дождь или снег, дымка по видимости, пасмурность, облака. */
  setWeather(w: Weather) {
    const to = (w.wind.fromDeg + 180) * DEG;
    const s = w.wind.speedMs;
    this.precip.setWeather(w.precipitation ?? null, new THREE.Vector2(Math.sin(to) * s, -Math.cos(to) * s));
    const f = fogFor(w.visibilityM);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = f.near;
    fog.far = f.far;
    this.overcast = overcastFactor(w);
    const cu = this.clouds.material.uniforms;
    if (w.cloudCover !== undefined) cu['cover']!.value = w.cloudCover;
    if (w.cloudBaseM !== undefined) this.clouds.position.y = w.cloudBaseM;
    // В тумане облака дальше видимости не видны.
    cu['fadeFar']!.value = Math.min(40000, Math.max(3000, f.far * 1.2));
    // Небо и свет пересчитаются с новой пасмурностью на следующем setSun.
    this.lastSun = null;
  }

  /** Дома, леса и полосы из OpenStreetMap. */
  setOsm(data: OsmData) {
    if (this.osm) {
      this.scene.remove(this.osm.group);
      this.osm.dispose();
    }
    this.osm = new OsmLayer(data, (e, n) => this.groundAt(e, n), this.q);
    this.scene.add(this.osm.group);
  }

  setAircraft(model: AircraftModel) {
    model.group.position.copy(this.aircraft.group.position);
    model.group.rotation.copy(this.aircraft.group.rotation);
    this.scene.remove(this.aircraft.group);
    this.aircraft = model;
    this.tailMount = null;
    this.scene.add(model.group);
  }

  setCameraMode(mode: CameraMode) {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'follow';
    this.shot = -1;
    // С хвоста планер виден в полуметре — ближняя плоскость отсечения ближе.
    this.camera.near = mode === 'tail' ? 0.2 : 0.5;
    this.camera.updateProjectionMatrix();
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

  /** Ветер у земли (для ветроуказателя и пыли) и на высоте облаков (для их сноса). Направление — откуда дует. */
  setWind(groundMs: number, fromDeg: number, cloudsMs: number) {
    const to = (fromDeg + 180) * DEG;
    const droop = (1 - Math.min(1, groundMs / 9)) * 75 * DEG;
    this.sockPivot.rotation.set(0, Math.PI / 2 - to, -droop, 'YZX');
    this.groundWind.set(Math.sin(to) * groundMs, -Math.cos(to) * groundMs);
    this.cloudWind.set(Math.sin(to) * cloudsMs, -Math.cos(to) * cloudsMs);
  }

  /** Положение Солнца: небо, прямой свет, рассеянный свет, дымка и отражения. */
  setSun(sun: SunPosition) {
    if (this.lastSun && Math.abs(this.lastSun.elevationDeg - sun.elevationDeg) < 0.2 && Math.abs(this.lastSun.azimuthDeg - sun.azimuthDeg) < 0.2) return;
    this.lastSun = sun;
    const el = sun.elevationDeg * DEG;
    const az = sun.azimuthDeg * DEG;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));

    const day = THREE.MathUtils.smoothstep(sun.elevationDeg, -4, 12);
    const warm = 1 - THREE.MathUtils.smoothstep(sun.elevationDeg, 2, 30);
    // Ночь: окна домов, огни, посадочная фара и звёзды берут этот коэффициент.
    this.nightFactor = 1 - day;
    this.sun.color.setRGB(1, 0.96 - 0.25 * warm, 0.9 - 0.45 * warm);
    // Под сплошной облачностью прямого Солнца почти нет — свет рассеянный, тени бледные.
    const oc = this.overcast;
    this.sun.intensity = 3.2 * day * (1 - 0.75 * oc);
    this.hemi.intensity = (0.35 + 0.9 * day) * (1 - 0.2 * oc);
    // Дымка — цвет неба у горизонта: вдали рельеф уходит в небо без шва.
    (this.scene.fog as THREE.Fog).color.copy(this.sky.setSun(this.sunDir, day, warm, oc));
    const clouds = this.clouds.material.uniforms;
    (clouds['lit']!.value as THREE.Color).setRGB(1, 1 - 0.15 * warm, 1 - 0.3 * warm).multiplyScalar((0.4 + 0.6 * day) * (1 - 0.35 * oc));
    (clouds['shade']!.value as THREE.Color).setRGB(0.55, 0.6, 0.68).multiplyScalar((0.4 + 0.6 * day) * (1 - 0.3 * oc));

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

  /** Запретные зоны и зоны РЭБ: полупрозрачные стены по границе (zones3d.ts). */
  setZones(zones: readonly Zone[]) {
    this.zoneWalls.set(zones, this.site);
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

  /** Точки маршрута оператора: мачта от земли до высоты полёта, кольцо и номер. */
  setMarkers(markers: Marker[]) {
    this.markerGroup.clear();
    for (const m of markers) {
      const marker = createWaypointMarker(m.label, this.groundAt(m.east, m.north), m.up);
      marker.position.set(m.east, 0, -m.north);
      this.markerGroup.add(marker);
    }
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

  /** Пыль от роторов (amount 0…1 — насколько сильно поток поднимает пыль) и тень под аппаратом. */
  updateDust(dt: number, position: LocalPoint, amount: number) {
    this.clock += dt;
    const g = this.groundAt(position.east, position.north);
    this.dust.update(dt, toScene(position, this.tmp), g, amount, this.groundWind);
    const agl = Math.max(0, position.up - g);
    const s = 3.6 + agl * 0.05;
    this.blob.position.set(position.east, g + 0.06, -position.north);
    this.blob.scale.set(s, s, 1);
    this.blob.material.opacity = 0.42 * (1 - THREE.MathUtils.smoothstep(agl, 1, 110));
  }

  updateCamera(dt: number, pose: Pose) {
    toScene(pose.position, this.target);
    this.target.y += 0.4;
    const h = pose.headingDeg * DEG;
    const forward = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    if (dt > 0) this.speed += (this.target.distanceTo(this.lastTarget) / dt - this.speed) * (1 - Math.exp(-dt * 2));

    if (this.cameraMode === 'follow') {
      this.camera.position.add(this.target.clone().sub(this.lastTarget));
      this.controls.target.copy(this.target);
      this.controls.update();
    } else if (this.cameraMode === 'chase') {
      // Смещение держится относительно аппарата: при ускорении времени камера не отстаёт,
      // сглаживается только поворот вслед за курсом. Мышью — поворот вокруг, колёсиком — расстояние.
      const pitch = 0.26 + this.orbitPitch;
      const back = forward.clone().negate().applyAxisAngle(UP, this.orbitYaw);
      const desired = back.multiplyScalar(Math.cos(pitch) * this.chaseDist).addScaledVector(UP, Math.sin(pitch) * this.chaseDist);
      this.chaseOffset.lerp(desired, 1 - Math.exp(-dt * 2.5));
      this.camera.position.copy(this.target).add(this.chaseOffset);
      this.camera.lookAt(this.target);
      // На скорости поле зрения чуть шире — ощущение движения.
      this.setFov(50 + THREE.MathUtils.clamp((this.speed - 12) * 0.3, 0, 7));
    } else if (this.cameraMode === 'tail') {
      // Камера закреплена на оперении и смотрит вперёд по оси аппарата: крен и тангаж — по горизонту.
      const g = this.aircraft.group;
      g.updateMatrixWorld();
      this.camera.position.copy(this.tailMountPoint()).applyMatrix4(g.matrixWorld);
      this.camera.quaternion.copy(g.quaternion).multiply(this.tailTilt);
      this.setFov(72);
    } else if (this.cameraMode === 'cinema') {
      this.cinema(dt, forward);
    } else {
      this.telephoto(this.padCamera);
    }
    if (this.cameraMode !== 'tail') {
      const floor = this.groundAt(this.camera.position.x, -this.camera.position.z) + 1.5;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
    }
    this.lastTarget.copy(this.target);

    this.sun.position.copy(this.target).addScaledVector(this.sunDir, 1200);
    this.sun.target.position.copy(this.target);
  }

  render(dt = 0) {
    this.sky.follow(this.camera.position);
    this.windOffset.addScaledVector(this.cloudWind, -dt);
    const cu = this.clouds.material.uniforms;
    (cu['cam']!.value as THREE.Vector3).copy(this.camera.position);
    this.clouds.position.x = this.camera.position.x;
    this.clouds.position.z = this.camera.position.z;
    this.lod.update(this.camera.position, {
      camera: this.camera.position,
      cloudOffset: this.windOffset,
      cloudCover: cu['cover']!.value as number,
      cloudBaseY: this.clouds.position.y,
      sunDir: this.sunDir,
    });
    // Мир из OpenStreetMap: деревья качает ветер, ночью горят окна и фонари.
    this.osm?.update(this.camera.position, { time: this.clock, nightFactor: this.nightFactor, wind: this.groundWind });
    this.precip.update(dt, this.camera);
    if (this.q.postprocess) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
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

  private setFov(fov: number) {
    if (Math.abs(this.camera.fov - fov) < 0.05) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Точка крепления камеры на хвосте в системе модели: над верхом оперения, по оси аппарата (нос — к −Z). */
  private tailMountPoint(): THREE.Vector3 {
    if (this.tailMount) return this.tailMount;
    const g = this.aircraft.group;
    g.updateMatrixWorld(true);
    const toModel = g.matrixWorld.clone().invert();
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const eachVertex = (fn: (p: THREE.Vector3) => void) =>
      g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const pos = mesh.isMesh ? mesh.geometry.getAttribute('position') : undefined;
        if (!pos) return;
        m.multiplyMatrices(toModel, mesh.matrixWorld);
        for (let i = 0; i < pos.count; i++) fn(v.fromBufferAttribute(pos, i).applyMatrix4(m));
      });
    let minZ = Infinity;
    let maxZ = -Infinity;
    eachVertex((p) => {
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });
    // Верх оперения — самая высокая точка в задней пятой части аппарата.
    const rear = maxZ - 0.2 * (maxZ - minZ);
    const top = new THREE.Vector3(0, -Infinity, 0);
    eachVertex((p) => {
      if (p.z >= rear && p.y > top.y) top.copy(p);
    });
    this.tailMount = Number.isFinite(top.y) ? new THREE.Vector3(0, top.y + 0.08, top.z) : new THREE.Vector3(0, 0.6, 1.2);
    return this.tailMount;
  }

  /** Наблюдатель с телевиком из точки eye: аппарат держится в кадре примерно одного размера. */
  private telephoto(eye: THREE.Vector3, sizeM = 6) {
    this.camera.position.copy(eye);
    this.camera.lookAt(this.target);
    const d = this.camera.position.distanceTo(this.target);
    this.setFov(Math.min(55, Math.max(1.2, (2 * Math.atan(sizeM / d)) / DEG)));
  }

  /** «Кино»: сбоку, пролёт мимо неподвижной камеры, с площадки, сверху-сзади — по очереди. */
  private cinema(dt: number, forward: THREE.Vector3) {
    this.shotLeft -= dt;
    const side = new THREE.Vector3(-forward.z, 0, forward.x);
    const passed = this.shot === 1 && this.shotEye.distanceTo(this.target) > 220;
    if (this.shotLeft <= 0 || passed) {
      this.shot = (this.shot + 1) % 4;
      this.shotLeft = CINEMA_SHOT_S;
      if (this.shot === 1) {
        // Камера на пути впереди и чуть в стороне — аппарат проходит мимо.
        const ahead = Math.max(60, this.speed * 5);
        this.shotEye.copy(this.target).addScaledVector(forward, ahead).addScaledVector(side, 22);
        this.shotEye.y = Math.max(this.target.y - 6, this.groundAt(this.shotEye.x, -this.shotEye.z) + 2);
      }
    }
    if (this.shot === 0) {
      const eye = this.target.clone().addScaledVector(side, 16).addScaledVector(forward, 4).addScaledVector(UP, 2);
      this.camera.position.lerp(eye, 1 - Math.exp(-dt * 3));
      this.camera.lookAt(this.target);
      this.setFov(45);
    } else if (this.shot === 1) {
      this.telephoto(this.shotEye, 9);
    } else if (this.shot === 2) {
      this.telephoto(this.padCamera);
    } else {
      const eye = this.target.clone().addScaledVector(forward, -30).addScaledVector(UP, 32);
      this.camera.position.lerp(eye, 1 - Math.exp(-dt * 2));
      this.camera.lookAt(this.target);
      this.setFov(50);
    }
  }

  /** В режиме «за хвостом» мышь поворачивает камеру вокруг аппарата, колёсико — расстояние, двойной щелчок — сброс. */
  private bindChaseMouse() {
    const el = this.renderer.domElement;
    let drag: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.cameraMode !== 'chase') return;
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.orbitYaw -= (e.clientX - drag.x) * 0.006;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + (e.clientY - drag.y) * 0.004, -0.3, 1.2);
      drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => (drag = null);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.cameraMode !== 'chase') return;
        e.preventDefault();
        this.chaseDist = THREE.MathUtils.clamp(this.chaseDist * Math.exp(e.deltaY * 0.001), 5, 90);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => {
      this.orbitYaw = 0;
      this.orbitPitch = 0;
      this.chaseDist = 13.5;
    });
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
    for (const p of this.pads) this.scene.remove(p);
    this.pads = points.map((p) => this.createPad(p.east, p.north));
    for (const p of this.pads) this.scene.add(p);
  }

  /** Площадка и круг зоны посадки вокруг неё. */
  private createPad(east: number, north: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(east, this.groundAt(east, north), -north);
    g.add(createLandingPad(), createLandingZone(AIRCRAFT.limits.landingZoneRadiusM));
    return g;
  }

  /** Лагерь экипажа у площадки: НСУ со штативом-антенной и машина. */
  private createCamp(): THREE.Group {
    const g = new THREE.Group();
    const place = (o: THREE.Object3D, east: number, north: number, yawDeg: number) => {
      o.position.set(east, this.groundAt(east, north), -north);
      o.rotation.y = yawDeg * DEG;
      g.add(o);
    };
    // С западной стороны — не на линии камеры «с площадки» (она к юго-востоку от площадки).
    place(createGroundStation(), -12, -9, 150);
    place(createVehicle(), -21, -15, 70);
    return g;
  }

  private createWindsock(at: { east: number; north: number }): THREE.Group {
    const g = new THREE.Group();
    g.position.set(at.east, this.groundAt(at.east, at.north), -at.north);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 5, 10), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.4, roughness: 0.4 }));
    pole.position.y = 2.5;
    pole.castShadow = true;
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
    sock.castShadow = true;
    this.sockPivot.position.y = 4.9;
    this.sockPivot.add(sock);
    g.add(this.sockPivot);
    return g;
  }
}
