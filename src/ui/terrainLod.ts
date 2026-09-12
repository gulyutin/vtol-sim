import * as THREE from 'three';
import { fromLocal, toLocal } from '../sim/mission';
import { mercatorPixel, mercatorToGeo } from '../sim/terrain';
import type { Site, Terrain } from '../sim/types';
import { fetchWithRetry, type Bounds } from './terrainData';

export const IMAGERY_ATTRIBUTION =
  'Снимки © Esri, Maxar, Earthstar Geographics · Рельеф: AWS Terrain Tiles (SRTM и др.) · Дома и лес: © участники OpenStreetMap';
const imageryUrl = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

/** Узлов сетки на сторону тайла. */
const GRID = 24;
const MAX_LOADS = 8;
const MAX_READY = 450;
/** Попыток загрузить снимок, дальше тайл считается недоступным и рисуется родитель. */
const MAX_TRIES = 3;
/**
 * На масштабах, где снимков нет, сервер отдаёт заглушку «Map data not yet available» —
 * маленький однотонный JPEG. Настоящие тайлы крупнее.
 */
const PLACEHOLDER_MAX_BYTES = 3500;

type State = 'idle' | 'queued' | 'loading' | 'ready' | 'failed';

interface TileNode {
  z: number;
  x: number;
  y: number;
  center: THREE.Vector3;
  sizeM: number;
  state: State;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null;
  children: TileNode[] | null;
  lastUsed: number;
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
#ifdef TERRAIN_CLOUD_SHADOWS
if (tSunDir.y > 0.05) {
  // Тень облака: точка облачного слоя на луче к Солнцу, та же функция, что у облаков.
  vec2 p = vTerrainWorld.xz + tSunDir.xz / tSunDir.y * (tCloudBase - vTerrainWorld.y);
  float d = tFbm6((p + tCloudOffset) / 2600.0);
  float c = smoothstep(1.0 - tCloudCover, 1.0 - tCloudCover + 0.22, d);
  diffuseColor.rgb *= 1.0 - 0.42 * c;
}
#endif
`;

/**
 * Рельеф со спутниковыми снимками: квадродерево тайлов Web Mercator. Рядом с камерой —
 * мелкие тайлы, дальше — крупные; пока дети грузятся, рисуется родитель.
 * Высоты вершин и нормали — из той же сетки высот, по которой считается физика.
 */
export class TerrainLod {
  readonly group = new THREE.Group();
  private readonly roots: TileNode[] = [];
  private readonly all: TileNode[] = [];
  private queue: TileNode[] = [];
  private loading = 0;
  private frame = 0;
  private split = 2.6;
  private detail = true;
  private cloudShadows = true;
  private readonly uniforms = {
    tCamera: { value: new THREE.Vector3() },
    tCloudOffset: { value: new THREE.Vector2() },
    tCloudCover: { value: 0 },
    tCloudBase: { value: 1500 },
    tSunDir: { value: new THREE.Vector3(0, 1, 0) },
  };

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
      for (let x = Math.floor(nw.x / 256); x <= Math.floor(se.x / 256); x++) this.roots.push(this.node(rootZoom, x, y));
    }
  }

  /** Детальность: делить тайл, если камера ближе split его размеров; наибольший уровень снимков; эффекты земли. */
  setQuality(split: number, maxZoom: number, detail: boolean, cloudShadows: boolean) {
    this.split = split;
    this.maxZoom = maxZoom;
    if (detail !== this.detail || cloudShadows !== this.cloudShadows) {
      this.detail = detail;
      this.cloudShadows = cloudShadows;
      for (const n of this.all) if (n.mesh) this.applyDefines(n.mesh.material);
    }
  }

  /** Вызывать каждый кадр: положение камеры в координатах сцены и параметры затенения. */
  update(camera: THREE.Vector3, shading?: TerrainShading) {
    this.frame++;
    if (shading) {
      this.uniforms.tCamera.value.copy(shading.camera);
      this.uniforms.tCloudOffset.value.copy(shading.cloudOffset);
      this.uniforms.tCloudCover.value = shading.cloudCover;
      this.uniforms.tCloudBase.value = shading.cloudBaseY;
      this.uniforms.tSunDir.value.copy(shading.sunDir);
    }
    for (const n of this.all) if (n.mesh) n.mesh.visible = false;
    for (const r of this.roots) this.select(r, camera);
    this.queue = this.queue.filter((n) => n.state === 'queued' && n.lastUsed >= this.frame - 1);
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.loading < MAX_LOADS && this.queue.length > 0) void this.load(this.queue.shift()!);
    this.evict();
  }

  private node(z: number, x: number, y: number): TileNode {
    const c = mercatorToGeo((x + 0.5) * 256, (y + 0.5) * 256, z);
    const w = toLocal(this.site, mercatorToGeo(x * 256, (y + 0.5) * 256, z));
    const e = toLocal(this.site, mercatorToGeo((x + 1) * 256, (y + 0.5) * 256, z));
    const l = toLocal(this.site, c);
    const n: TileNode = {
      z,
      x,
      y,
      center: new THREE.Vector3(l.east, this.terrain.elevationM(c) - this.site.elevationM, -l.north),
      sizeM: e.east - w.east,
      state: 'idle',
      mesh: null,
      children: null,
      lastUsed: 0,
      priority: 0,
      tries: 0,
      retryAt: 0,
    };
    this.all.push(n);
    return n;
  }

  /** true — участок тайла покрыт (им самим или потомками). */
  private select(n: TileNode, camera: THREE.Vector3): boolean {
    n.lastUsed = this.frame;
    const d = camera.distanceTo(n.center);
    if (n.z < this.maxZoom && d < this.split * n.sizeM) {
      n.children ??= [0, 1, 2, 3].map((k) => this.node(n.z + 1, n.x * 2 + (k % 2), n.y * 2 + (k >> 1)));
      for (const c of n.children) {
        c.lastUsed = this.frame;
        if (c.state !== 'ready') this.request(c, camera.distanceTo(c.center));
      }
      if (n.children.every((c) => c.state === 'ready')) {
        for (const c of n.children) this.select(c, camera);
        return true;
      }
    }
    if (n.state === 'ready') {
      n.mesh!.visible = true;
      return true;
    }
    this.request(n, d);
    return false;
  }

  private request(n: TileNode, distance: number) {
    // Ближние и крупные тайлы — в первую очередь.
    n.priority = distance / n.sizeM - n.z * 0.01;
    if (n.state === 'idle' && performance.now() >= n.retryAt) {
      n.state = 'queued';
      this.queue.push(n);
    }
  }

  private async load(n: TileNode) {
    n.state = 'loading';
    this.loading++;
    try {
      const res = await fetchWithRetry(imageryUrl(n.z, n.x, n.y), 2);
      const blob = await res.blob();
      if (blob.size < PLACEHOLDER_MAX_BYTES && n.z > 15) throw new Error('нет снимков на этом масштабе');
      // Растр переворачивается при декодировании: у ImageBitmap WebGL не делает flipY.
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      const tex = new THREE.Texture(bitmap);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.needsUpdate = true;
      const material = new THREE.MeshLambertMaterial({ map: tex });
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = 'varying vec3 vTerrainWorld;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = SHADER_HEAD + shader.fragmentShader.replace('#include <map_fragment>', SHADER_FRAGMENT);
      };
      this.applyDefines(material);
      n.mesh = new THREE.Mesh(this.geometry(n), material);
      n.mesh.receiveShadow = true;
      n.mesh.visible = false;
      this.group.add(n.mesh);
      n.state = 'ready';
    } catch {
      // Повтор позже; после MAX_TRIES — недоступен, остаётся родитель.
      n.tries++;
      n.state = n.tries >= MAX_TRIES ? 'failed' : 'idle';
      n.retryAt = performance.now() + 2000 * 2 ** n.tries;
    } finally {
      this.loading--;
    }
  }

  private applyDefines(m: THREE.MeshLambertMaterial) {
    const defines: Record<string, string> = {};
    if (this.detail) defines['TERRAIN_DETAIL'] = '';
    if (this.cloudShadows) defines['TERRAIN_CLOUD_SHADOWS'] = '';
    m.defines = defines;
    m.customProgramCacheKey = () => `terrain-${this.detail ? 1 : 0}${this.cloudShadows ? 1 : 0}`;
    m.needsUpdate = true;
  }

  /** Освободить давно не нужные тайлы, когда их слишком много. */
  private evict() {
    const ready = this.all.filter((n) => n.state === 'ready' && !this.roots.includes(n));
    if (ready.length <= MAX_READY) return;
    ready.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const n of ready.slice(0, ready.length - MAX_READY)) {
      if (n.lastUsed >= this.frame - 2) break;
      this.group.remove(n.mesh!);
      n.mesh!.geometry.dispose();
      const map = n.mesh!.material.map;
      (map?.image as ImageBitmap | undefined)?.close?.();
      map?.dispose();
      n.mesh!.material.dispose();
      n.mesh = null;
      n.state = 'idle';
    }
  }

  private geometry(n: TileNode): THREE.BufferGeometry {
    const N = GRID;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const delta = Math.max(5, n.sizeM / N);
    const h = (east: number, north: number) => this.terrain.elevationM(fromLocal(this.site, east, north));
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const g = mercatorToGeo((n.x + i / N) * 256, (n.y + j / N) * 256, n.z);
        const l = toLocal(this.site, g);
        pos.push(l.east, this.terrain.elevationM(g) - this.site.elevationM, -l.north);
        // Нормаль из уклона рельефа: y = f(x, z), x — восток, z — юг.
        const dhde = (h(l.east + delta, l.north) - h(l.east - delta, l.north)) / (2 * delta);
        const dhdn = (h(l.east, l.north + delta) - h(l.east, l.north - delta)) / (2 * delta);
        const len = Math.hypot(dhde, 1, dhdn);
        nrm.push(-dhde / len, 1 / len, dhdn / len);
        uv.push(i / N, 1 - j / N);
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
    geo.setIndex(index);
    geo.computeBoundingSphere();
    return geo;
  }
}
