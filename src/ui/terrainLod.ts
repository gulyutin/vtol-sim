import * as THREE from 'three';
import { fromLocal, toLocal } from '../sim/mission';
import { mercatorPixel, mercatorToGeo } from '../sim/terrain';
import type { Site, Terrain } from '../sim/types';
import { reliefRgb } from './reliefTint';
import type { Bounds } from './terrainData';
import { imageryFallback, imagerySource, packImageryUrl } from './tileSource';
import {
  ancestorUv,
  hostIndex,
  isPlaceholderPixels,
  mayBePlaceholder,
  pickRequests,
  REQUESTS_PER_HOST,
  retryDelayMs,
  shouldSplit,
  tilePriority,
  type Candidate,
} from './tileSchedule';

export const IMAGERY_ATTRIBUTION =
  'Снимки © Esri, Maxar, Earthstar Geographics · Рельеф: AWS Terrain Tiles (SRTM и др.) · Дома, дороги, вода и лес: © участники OpenStreetMap';
/** Оба сервера отдают одни и те же снимки; по HTTP/1.1 у каждого свои шесть соединений браузера. */
const IMAGERY_HOSTS = ['server.arcgisonline.com', 'services.arcgisonline.com'];
/** Снимки из пакета района — ещё один «сервер» очереди, со своими местами (tileSource.ts). */
const PACK_HOST = IMAGERY_HOSTS.length;
const imageryUrl = (host: number, z: number, x: number, y: number) =>
  host === PACK_HOST ? packImageryUrl(z, x, y) : `https://${IMAGERY_HOSTS[host]}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

/** Узлов сетки на сторону тайла. */
const GRID = 24;
/** Снимков в памяти сверх нужных сейчас — на случай разворота. */
const CACHE_TEXTURES = 250;
/** Сеток рельефа сверх нужных сейчас. */
const CACHE_MESHES = 400;
/** Время на построение сеток рельефа за кадр, мс: иначе при быстром полёте рывки. */
const MESH_BUDGET_MS = 4;
/** Запрос дольше — обрываем и повторяем: зависшее соединение не должно держать место. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Подгрузка вперёд по курсу: куда камера придёт за это время, с. */
const LOOKAHEAD_S = 8;
/** Ветви дерева, не нужные столько кадров, забываются. */
const PRUNE_FRAMES = 1800;

/**
 * idle — своего снимка нет (можно запросить); absent — у сервера нет снимков этого масштаба
 * (глубже не делим); nodata — снимка взять неоткуда: без сети и не в пакете. Такой тайл не
 * запрашивается и не повторяется, но делится — сетка рельефа уточняется и без снимков.
 */
type State = 'idle' | 'loading' | 'ready' | 'absent' | 'nodata';

interface TileNode {
  z: number;
  x: number;
  y: number;
  /** Откуда брать снимок: пакет или сеть. */
  origin: 'pack' | 'net' | null;
  parent: TileNode | null;
  center: THREE.Vector3;
  sizeM: number;
  state: State;
  /** Материал со своим снимком, когда тот загружен. */
  material: THREE.MeshLambertMaterial | null;
  /** Сетка рельефа тайла. Снимок на ней — свой или участок снимка предка (source). */
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null;
  source: TileNode | null;
  /** Тайлы, на сетках которых сейчас лежит снимок этого. */
  borrowers: Set<TileNode>;
  children: TileNode[] | null;
  lastUsed: number;
  /** Кадр, в котором тайл последний раз попал в список нужных, и его очерёдность. */
  wanted: number;
  priority: number;
  tries: number;
  retryAt: number;
}

/** Общие для всех тайлов параметры затенения земли: камера, облака, Солнце. */
export interface TerrainShading {
  camera: THREE.Vector3;
  cloudOffset: THREE.Vector2;
  cloudCover: number;
  cloudBaseY: number;
  sunDir: THREE.Vector3;
}

const SHADER_HEAD = /* glsl */ `
uniform vec3 tCamera; uniform vec2 tCloudOffset; uniform float tCloudCover; uniform float tCloudBase; uniform vec3 tSunDir;
uniform float tSnow; uniform float tSnowLine; uniform float tValleyFog; uniform float tValleyTop;
varying vec3 vTerrainWorld;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y); }
float tFbm4(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * tNoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
float tFbm6(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * tNoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
`;

const SHADER_FRAGMENT = /* glsl */ `
#include <map_fragment>
#ifdef TERRAIN_DETAIL
{
  // Вблизи пиксель снимка (~0.3 м) растянут на полэкрана — добавляем неоднородность травы и пашни
  // в трёх масштабах: пятна ~8 м, пучки ~0.6 м и у самой камеры травинки ~0.1 м.
  float dist = distance(tCamera, vTerrainWorld);
  float near = 1.0 - smoothstep(40.0, 380.0, dist);
  if (near > 0.0) {
    vec2 q = vTerrainWorld.xz;
    float patches = tFbm4(q * 0.12);
    float tufts = tFbm4(q * 1.7);
    float blades = mix(0.5, tNoise(q * 9.0), 1.0 - smoothstep(6.0, 35.0, dist));
    float k = 0.7 + 0.6 * (0.5 * tufts + 0.3 * patches + 0.2 * blades);
    // Где снимок зелёный — ещё и оттенок: где гуще и сочнее, где суше.
    float green = smoothstep(0.0, 0.06, diffuseColor.g - diffuseColor.r);
    vec3 tint = mix(vec3(1.0), mix(vec3(1.08, 1.02, 0.82), vec3(0.9, 1.06, 0.92), patches), green);
    diffuseColor.rgb *= mix(vec3(1.0), tint * k, near);
  }
}
#endif
if (tSnow > 0.001 || tSnowLine < 9000.0) {
  // Снег: по покрову у площадки и выше границы снега в горах (граница — неровная). Пятнами, когда
  // покров неполный; крутые склоны его не держат; в лесу (тёмный снимок) снег виден между деревьями.
  vec3 p = vTerrainWorld;
  vec3 nrm = normalize(cross(dFdx(p), dFdy(p)));
  float flatness = mix(0.35, 1.0, smoothstep(0.62, 0.86, abs(nrm.y)));
  float line = smoothstep(tSnowLine - 140.0, tSnowLine + 140.0, p.y + 120.0 * (tFbm4(p.xz / 420.0) - 0.5));
  float cover = max(tSnow, line);
  float patchN = tFbm4(p.xz / 70.0 + 3.0);
  float c = smoothstep(1.0 - cover - 0.07, 1.0 - cover + 0.07, patchN) * flatness;
  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  float forest = 1.0 - smoothstep(0.07, 0.19, lum);
  vec3 snowCol = vec3(0.86, 0.89, 0.94) * (0.93 + 0.07 * tNoise(p.xz * 0.4));
  vec3 under = mix(diffuseColor.rgb, snowCol * 0.5, 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(snowCol, under, forest), c);
}
if (tValleyFog > 0.001) {
  // Утренний туман в низинах: сверху — белая пелена там, где рельеф ниже её верхней границы.
  float depth = tValleyTop - vTerrainWorld.y + 30.0 * (tFbm4(vTerrainWorld.xz / 650.0) - 0.5);
  float f = smoothstep(-10.0, 30.0, depth) * tValleyFog;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.94), 0.9 * f);
}
#ifdef TERRAIN_CLOUD_SHADOWS
if (tSunDir.y > 0.05) {
  // Тень облака: точка облачного слоя на луче к Солнцу, та же функция, что у облаков.
  vec2 p = vTerrainWorld.xz + tSunDir.xz / tSunDir.y * (tCloudBase - vTerrainWorld.y);
  float d = tFbm4((p + tCloudOffset) / 2600.0);
  float c = smoothstep(1.0 - tCloudCover, 1.0 - tCloudCover + 0.22, d);
  diffuseColor.rgb *= 1.0 - 0.42 * c;
}
#endif
`;

/** Пиксели четырёх угловых квадратов 8×8 снимка, RGBA подряд. */
function cornerPixels(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const s = 8;
  const corners = [
    [0, 0],
    [bitmap.width - s, 0],
    [0, bitmap.height - s],
    [bitmap.width - s, bitmap.height - s],
  ] as const;
  const out = new Uint8ClampedArray(corners.length * s * s * 4);
  corners.forEach(([x, y], i) => out.set(ctx.getImageData(x, y, s, s).data, i * s * s * 4));
  return out;
}

/**
 * Рельеф со спутниковыми снимками: квадродерево тайлов Web Mercator. Рядом с камерой — мелкие
 * тайлы, дальше — крупные. Тайл делится сразу, как готовы сетки детей; пока их снимки грузятся,
 * на сетках лежит участок снимка ближайшего загруженного предка — та же картинка, только грубее.
 * Загрузка — очередью: что на экране, впереди и грубее всего показано — раньше; не больше шести
 * запросов на сервер; при ошибке — повтор с паузой. Высоты вершин и нормали — из той же сетки
 * высот, по которой считается физика.
 */
export class TerrainLod {
  readonly group = new THREE.Group();
  private readonly roots: TileNode[] = [];
  private readonly all = new Set<TileNode>();
  /** Тайлы, нарисованные в прошлом кадре. */
  private shown: TileNode[] = [];
  /** Тайлы без своего снимка, нужные в этом кадре. */
  private wantList: TileNode[] = [];
  private readonly inflight = [...IMAGERY_HOSTS, 'pack'].map(() => 0);
  private frame = 0;
  private split = 2.6;
  private detail = true;
  private cloudShadows = true;
  private disposed = false;
  private meshBudgetEnd = 0;
  private look: THREE.Vector3 | null = null;
  private readonly lookDir = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly lastCamera = new THREE.Vector3();
  private lastTime = 0;
  private readonly ahead = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  /** На сетке, пока ни у тайла, ни у предков нет снимка; такая сетка не рисуется. */
  private readonly blank = new THREE.MeshLambertMaterial();
  /**
   * Рельеф без снимка — окраска по высоте и склону (цвета вершин, reliefTint.ts): пока снимок
   * грузится и там, где его взять неоткуда (без сети, вне пакета).
   */
  private readonly relief = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly uniforms = {
    tCamera: { value: new THREE.Vector3() },
    tCloudOffset: { value: new THREE.Vector2() },
    tCloudCover: { value: 0 },
    tCloudBase: { value: 1500 },
    tSunDir: { value: new THREE.Vector3(0, 1, 0) },
    tSnow: { value: 0 },
    tSnowLine: { value: 1e5 },
    tValleyFog: { value: 0 },
    tValleyTop: { value: -1e5 },
  };

  /** Туман в низинах: 0…1 и верхняя граница, м по высоте сцены. */
  setValleyFog(amount: number, topY: number) {
    this.uniforms.tValleyFog.value = amount;
    this.uniforms.tValleyTop.value = topY;
  }

  /** Снег на земле: покров у площадки 0…1 и граница снега в горах, м по высоте сцены. */
  setSnow(cover: number, lineY: number) {
    this.uniforms.tSnow.value = cover;
    this.uniforms.tSnowLine.value = lineY;
  }

  constructor(
    private readonly terrain: Terrain,
    private readonly site: Site,
    bounds: Bounds,
    private maxZoom: number,
    private readonly anisotropy: number,
    rootZoom = 11,
  ) {
    const nw = mercatorPixel({ lat: bounds.north, lon: bounds.west }, rootZoom);
    const se = mercatorPixel({ lat: bounds.south, lon: bounds.east }, rootZoom);
    for (let y = Math.floor(nw.y / 256); y <= Math.floor(se.y / 256); y++) {
      for (let x = Math.floor(nw.x / 256); x <= Math.floor(se.x / 256); x++) this.roots.push(this.node(rootZoom, x, y, null));
    }
    this.shade(this.relief);
  }

  /** Детальность: делить тайл, если камера ближе split его размеров; наибольший уровень снимков; эффекты земли. */
  setQuality(split: number, maxZoom: number, detail: boolean, cloudShadows: boolean) {
    this.split = split;
    this.maxZoom = maxZoom;
    if (detail !== this.detail || cloudShadows !== this.cloudShadows) {
      this.detail = detail;
      this.cloudShadows = cloudShadows;
      for (const n of this.all) if (n.material) this.applyDefines(n.material);
      this.applyDefines(this.relief);
    }
  }

  /**
   * Вызывать каждый кадр: положение камеры в координатах сцены, параметры затенения и направление
   * взгляда — что впереди, грузится раньше.
   */
  update(camera: THREE.Vector3, shading?: TerrainShading, look?: THREE.Vector3) {
    this.frame++;
    const now = performance.now();
    if (shading) {
      this.uniforms.tCamera.value.copy(shading.camera);
      this.uniforms.tCloudOffset.value.copy(shading.cloudOffset);
      this.uniforms.tCloudCover.value = shading.cloudCover;
      this.uniforms.tCloudBase.value = shading.cloudBaseY;
      this.uniforms.tSunDir.value.copy(shading.sunDir);
    }
    this.trackVelocity(camera, now);
    this.look = look && look.lengthSq() > 0 ? this.lookDir.copy(look).normalize() : null;
    for (const n of this.shown) if (n.mesh) n.mesh.visible = false;
    this.shown = [];
    this.wantList = [];
    this.meshBudgetEnd = now + MESH_BUDGET_MS;
    for (const r of this.roots) this.select(r, camera);
    // Вперёд по курсу: что понадобится через несколько секунд — в очередь после нужного сейчас.
    if (this.velocity.lengthSq() > 25) {
      this.ahead.copy(camera).addScaledVector(this.velocity, LOOKAHEAD_S);
      for (const r of this.roots) this.prefetch(r, this.ahead);
    }
    this.startLoads(now);
    if (this.frame % 30 === 0) this.evict();
  }

  /** Освободить всё; загрузки, что ещё идут, свой результат выбросят. */
  dispose() {
    this.disposed = true;
    for (const n of this.all) {
      if (n.mesh) this.dropMesh(n);
      if (n.material) this.dropTexture(n);
    }
    this.blank.dispose();
    this.relief.dispose();
  }

  /** Скорость камеры, сглаженная, — для подгрузки вперёд. Скачок (смена ракурса) — не движение. */
  private trackVelocity(camera: THREE.Vector3, now: number) {
    const dt = (now - this.lastTime) / 1000;
    if (this.lastTime > 0 && dt > 0 && dt < 0.5) {
      this.tmp.subVectors(camera, this.lastCamera).divideScalar(dt);
      if (this.tmp.lengthSq() > 400 ** 2) this.velocity.set(0, 0, 0);
      else this.velocity.lerp(this.tmp, Math.min(1, dt * 2));
    } else {
      this.velocity.set(0, 0, 0);
    }
    this.lastCamera.copy(camera);
    this.lastTime = now;
  }

  private node(z: number, x: number, y: number, parent: TileNode | null): TileNode {
    const c = mercatorToGeo((x + 0.5) * 256, (y + 0.5) * 256, z);
    const w = toLocal(this.site, mercatorToGeo(x * 256, (y + 0.5) * 256, z));
    const e = toLocal(this.site, mercatorToGeo((x + 1) * 256, (y + 0.5) * 256, z));
    const l = toLocal(this.site, c);
    const origin = imagerySource(z, x, y);
    const n: TileNode = {
      z,
      x,
      y,
      origin,
      parent,
      center: new THREE.Vector3(l.east, this.terrain.elevationM(c) - this.site.elevationM, -l.north),
      sizeM: e.east - w.east,
      state: origin ? 'idle' : 'nodata',
      material: null,
      mesh: null,
      source: null,
      borrowers: new Set(),
      children: null,
      lastUsed: this.frame,
      wanted: 0,
      priority: 0,
      tries: 0,
      retryAt: 0,
    };
    this.all.add(n);
    return n;
  }

  private createChildren(n: TileNode): TileNode[] {
    return [0, 1, 2, 3].map((k) => this.node(n.z + 1, n.x * 2 + (k % 2), n.y * 2 + (k >> 1), n));
  }

  private select(n: TileNode, camera: THREE.Vector3) {
    n.lastUsed = this.frame;
    const d = camera.distanceTo(n.center);
    if (n.state !== 'absent' && shouldSplit(d, n.sizeM, n.z, this.maxZoom, this.split)) {
      const children = (n.children ??= this.createChildren(n));
      // Делим, как только у детей готовы сетки: снимок им пока даст предок — та же картинка.
      if (children.every((c) => this.ensureMesh(c))) {
        for (const c of children) this.select(c, camera);
        return;
      }
    }
    this.draw(n, camera, d);
  }

  private draw(n: TileNode, camera: THREE.Vector3, d: number) {
    const src = n.state === 'ready' ? n : this.readyAncestor(n);
    if (this.ensureMesh(n)) {
      if (src) {
        if (n.source !== src) this.setSource(n, src);
        src.lastUsed = this.frame;
      } else if (n.mesh!.material !== this.relief) {
        // Снимка нет ни у тайла, ни у предков — рельеф в цветах высоты и склона.
        this.unsetSource(n);
        n.mesh!.material = this.relief;
      }
      n.mesh!.visible = true;
      this.shown.push(n);
    }
    if (n.state === 'ready') return;
    // Нужен свой снимок, и промежуточные уровни между показанным и нужным — картинка уточняется по шагам.
    const shownZ = src ? src.z : n.z - 10;
    this.want(n, camera, d, n.z - shownZ, false);
    for (let a = n.parent; a && a !== src; a = a.parent) this.want(a, camera, camera.distanceTo(a.center), a.z - shownZ, false);
  }

  /** Спуск по дереву из будущего положения камеры: недостающие снимки — в очередь, без сеток и показа. */
  private prefetch(n: TileNode, at: THREE.Vector3) {
    const d = at.distanceTo(n.center);
    if (n.state !== 'absent' && shouldSplit(d, n.sizeM, n.z, this.maxZoom, this.split)) {
      n.lastUsed = this.frame;
      for (const c of (n.children ??= this.createChildren(n))) this.prefetch(c, at);
      return;
    }
    if (n.state !== 'idle') return;
    const src = this.readyAncestor(n);
    this.want(n, at, d, src ? n.z - src.z : 10, true);
  }

  private readyAncestor(n: TileNode): TileNode | null {
    for (let a = n.parent; a; a = a.parent) if (a.state === 'ready') return a;
    return null;
  }

  private want(n: TileNode, from: THREE.Vector3, d: number, deficit: number, prefetch: boolean) {
    if (n.state !== 'idle') return;
    n.lastUsed = this.frame;
    const facing = this.look && d > 1 ? this.tmp.subVectors(n.center, from).dot(this.look) / d : 1;
    const p = tilePriority({ distanceM: d, sizeM: n.sizeM, facing, deficit, prefetch });
    if (n.wanted !== this.frame) {
      n.wanted = this.frame;
      n.priority = p;
      this.wantList.push(n);
    } else if (p < n.priority) {
      n.priority = p;
    }
  }

  private startLoads(now: number) {
    if (this.wantList.length === 0 || this.inflight.every((k) => k >= REQUESTS_PER_HOST)) return;
    const candidates: Candidate<TileNode>[] = this.wantList.map((n) => ({
      item: n,
      priority: n.priority,
      host: n.origin === 'pack' ? PACK_HOST : hostIndex(n.x, n.y, IMAGERY_HOSTS.length),
      notBefore: n.retryAt,
    }));
    for (const c of pickRequests(candidates, this.inflight, REQUESTS_PER_HOST, now)) void this.load(c.item, c.host);
  }

  private async load(n: TileNode, host: number) {
    n.state = 'loading';
    this.inflight[host]!++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    const fromPack = host === PACK_HOST;
    // Тайла не оказалось в пакете (или он испорчен): в сеть, если она есть, иначе «нет данных» —
    // без повторов: локальный файл от повтора не появится.
    const packMiss = () => {
      n.origin = imageryFallback();
      n.state = n.origin ? 'idle' : 'nodata';
    };
    try {
      const res = await fetch(imageryUrl(host, n.z, n.x, n.y), { signal: abort.signal });
      if (fromPack && !res.ok) {
        packMiss();
        return;
      }
      if (res.status === 404) {
        n.state = 'absent';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Растр переворачивается при декодировании: у ImageBitmap WebGL не делает flipY.
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      if (this.disposed || (mayBePlaceholder(blob.size) && isPlaceholderPixels(cornerPixels(bitmap)))) {
        bitmap.close();
        n.state = this.disposed ? 'idle' : 'absent';
        return;
      }
      n.material = this.createMaterial(bitmap);
      n.state = 'ready';
      n.tries = 0;
    } catch {
      if (fromPack) {
        packMiss();
        return;
      }
      // Сеть, сервер или обрыв по времени — повтор с растущей паузой; место в очереди свободно сразу.
      n.tries++;
      n.retryAt = performance.now() + retryDelayMs(n.tries, Math.random());
      n.state = 'idle';
    } finally {
      clearTimeout(timer);
      this.inflight[host]!--;
    }
  }

  private createMaterial(bitmap: ImageBitmap): THREE.MeshLambertMaterial {
    const tex = new THREE.Texture(bitmap);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;
    const material = new THREE.MeshLambertMaterial({ map: tex });
    this.shade(material);
    return material;
  }

  /** Затенение земли — трава вблизи и тени облаков — у материала со снимком и у окраски рельефа. */
  private shade(material: THREE.MeshLambertMaterial) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = 'varying vec3 vTerrainWorld;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = SHADER_HEAD + shader.fragmentShader.replace('#include <map_fragment>', SHADER_FRAGMENT);
    };
    this.applyDefines(material);
  }

  private applyDefines(m: THREE.MeshLambertMaterial) {
    const defines: Record<string, string> = {};
    if (this.detail) defines['TERRAIN_DETAIL'] = '';
    if (this.cloudShadows) defines['TERRAIN_CLOUD_SHADOWS'] = '';
    m.defines = defines;
    m.customProgramCacheKey = () => `terrain-${this.detail ? 1 : 0}${this.cloudShadows ? 1 : 0}`;
    m.needsUpdate = true;
  }

  /** Сетка рельефа тайла; false — время на сетки в этом кадре вышло, тайл пока не делится. */
  private ensureMesh(n: TileNode): boolean {
    if (n.mesh) return true;
    if (n.parent && performance.now() > this.meshBudgetEnd) return false;
    n.mesh = new THREE.Mesh(this.geometry(n), this.blank);
    n.mesh.receiveShadow = true;
    n.mesh.visible = false;
    this.group.add(n.mesh);
    return true;
  }

  /** Положить на сетку тайла снимок src — свой или предка, тем участком, что приходится на тайл. */
  private setSource(n: TileNode, src: TileNode) {
    n.source?.borrowers.delete(n);
    n.source = src;
    if (src !== n) src.borrowers.add(n);
    const mesh = n.mesh!;
    mesh.material = src.material!;
    const t = ancestorUv(n.z, n.x, n.y, src.z, src.x, src.y);
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const base = mesh.geometry.userData['uv0'] as Float32Array;
    const out = uv.array as Float32Array;
    for (let i = 0; i < base.length; i += 2) {
      out[i] = t.offsetU + base[i]! * t.scale;
      out[i + 1] = t.offsetV + base[i + 1]! * t.scale;
    }
    uv.needsUpdate = true;
  }

  private unsetSource(n: TileNode) {
    if (n.source && n.source !== n) n.source.borrowers.delete(n);
    n.source = null;
    if (n.mesh) {
      n.mesh.material = this.blank;
      n.mesh.visible = false;
    }
  }

  /** Освободить давно не нужное: снимки и сетки сверх запаса, забытые ветви дерева. */
  private evict() {
    const recent = this.frame - 2;
    const ready: TileNode[] = [];
    const meshed: TileNode[] = [];
    for (const n of this.all) {
      if (!n.parent) continue;
      if (n.material) ready.push(n);
      if (n.mesh) meshed.push(n);
    }
    this.trim(ready, CACHE_TEXTURES, recent, (n) => this.dropTexture(n));
    this.trim(meshed, CACHE_MESHES, recent, (n) => this.dropMesh(n));
    for (const r of this.roots) this.prune(r);
  }

  /** Из давно не нужных оставить cache последних, остальные — drop. */
  private trim(list: TileNode[], cache: number, recent: number, drop: (n: TileNode) => void) {
    const idle = list.filter((n) => n.lastUsed < recent);
    let excess = idle.length - cache;
    if (excess <= 0) return;
    idle.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const n of idle) {
      if (excess-- <= 0) break;
      drop(n);
    }
  }

  private dropTexture(n: TileNode) {
    for (const b of [...n.borrowers]) this.unsetSource(b);
    if (n.source === n) this.unsetSource(n);
    const m = n.material!;
    (m.map?.image as ImageBitmap | undefined)?.close?.();
    m.map?.dispose();
    m.dispose();
    n.material = null;
    n.state = 'idle';
  }

  private dropMesh(n: TileNode) {
    const mesh = n.mesh!;
    this.unsetSource(n);
    this.group.remove(mesh);
    mesh.geometry.dispose();
    n.mesh = null;
  }

  /** Забыть ветви, давно не нужные: без снимков, сеток и загрузок. */
  private prune(n: TileNode) {
    if (!n.children) return;
    for (const c of n.children) this.prune(c);
    const old = this.frame - PRUNE_FRAMES;
    if (n.children.every((c) => !c.children && !c.mesh && (c.state === 'idle' || c.state === 'nodata') && c.lastUsed < old)) {
      for (const c of n.children) this.all.delete(c);
      n.children = null;
    }
  }

  private geometry(n: TileNode): THREE.BufferGeometry {
    const N = GRID;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const index: number[] = [];
    const delta = Math.max(5, n.sizeM / N);
    const h = (east: number, north: number) => this.terrain.elevationM(fromLocal(this.site, east, north));
    const rgb: [number, number, number] = [0, 0, 0];
    // Цвета вершин — в линейном пространстве, как ждёт three.js.
    const lin = (c: number) => (c / 255) ** 2.2;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const g = mercatorToGeo((n.x + i / N) * 256, (n.y + j / N) * 256, n.z);
        const l = toLocal(this.site, g);
        const elev = this.terrain.elevationM(g);
        pos.push(l.east, elev - this.site.elevationM, -l.north);
        // Нормаль из уклона рельефа: y = f(x, z), x — восток, z — юг.
        const dhde = (h(l.east + delta, l.north) - h(l.east - delta, l.north)) / (2 * delta);
        const dhdn = (h(l.east, l.north + delta) - h(l.east, l.north - delta)) / (2 * delta);
        const len = Math.hypot(dhde, 1, dhdn);
        nrm.push(-dhde / len, 1 / len, dhdn / len);
        uv.push(i / N, 1 - j / N);
        reliefRgb(elev, Math.hypot(dhde, dhdn), rgb);
        col.push(lin(rgb[0]), lin(rgb[1]), lin(rgb[2]));
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i;
        index.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2);
      }
    }
    // «Юбка» по краям — закрывает щели между тайлами разной детальности.
    const depth = 10 + n.sizeM * 0.03;
    const edges = [
      Array.from({ length: N + 1 }, (_, i) => i),
      Array.from({ length: N + 1 }, (_, i) => N * (N + 1) + i),
      Array.from({ length: N + 1 }, (_, j) => j * (N + 1)),
      Array.from({ length: N + 1 }, (_, j) => j * (N + 1) + N),
    ];
    for (const edge of edges) {
      const base = pos.length / 3;
      for (const v of edge) {
        pos.push(pos[v * 3]!, pos[v * 3 + 1]! - depth, pos[v * 3 + 2]!);
        nrm.push(nrm[v * 3]!, nrm[v * 3 + 1]!, nrm[v * 3 + 2]!);
        uv.push(uv[v * 2]!, uv[v * 2 + 1]!);
        col.push(col[v * 3]!, col[v * 3 + 1]!, col[v * 3 + 2]!);
      }
      for (let k = 0; k < edge.length - 1; k++) {
        const t0 = edge[k]!;
        const t1 = edge[k + 1]!;
        const b0 = base + k;
        const b1 = base + k + 1;
        index.push(t0, b0, t1, t1, b0, b1, t0, t1, b0, t1, b1, b0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // Свои UV тайла; на сетке — они же или пересчитанные на снимок предка (setSource).
    geo.userData['uv0'] = new Float32Array(uv);
    geo.setIndex(index);
    geo.computeBoundingSphere();
    return geo;
  }
}
