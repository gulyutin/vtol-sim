import * as THREE from 'three';
import { fromLocal, toLocal } from '../sim/mission';
import { mercatorPixel, mercatorToGeo } from '../sim/terrain';
import type { Site, Terrain } from '../sim/types';
import type { Bounds } from './terrainData';

export const IMAGERY_ATTRIBUTION = 'Снимки © Esri, Maxar, Earthstar Geographics · Рельеф: AWS Terrain Tiles (SRTM и др.)';
const imageryUrl = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

/** Узлов сетки на сторону тайла. */
const GRID = 24;
/** Тайл делится, если камера ближе SPLIT размеров тайла. */
const SPLIT = 2.6;
const MAX_LOADS = 8;
const MAX_READY = 450;

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
}

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
  private readonly loader = new THREE.TextureLoader();

  constructor(
    private readonly terrain: Terrain,
    private readonly site: Site,
    bounds: Bounds,
    private readonly maxZoom: number,
    private readonly anisotropy: number,
    rootZoom = 11,
  ) {
    this.loader.setCrossOrigin('anonymous');
    const nw = mercatorPixel({ lat: bounds.north, lon: bounds.west }, rootZoom);
    const se = mercatorPixel({ lat: bounds.south, lon: bounds.east }, rootZoom);
    for (let y = Math.floor(nw.y / 256); y <= Math.floor(se.y / 256); y++) {
      for (let x = Math.floor(nw.x / 256); x <= Math.floor(se.x / 256); x++) this.roots.push(this.node(rootZoom, x, y));
    }
  }

  /** Вызывать каждый кадр с положением камеры в координатах сцены. */
  update(camera: THREE.Vector3) {
    this.frame++;
    for (const n of this.all) if (n.mesh) n.mesh.visible = false;
    for (const r of this.roots) this.select(r, camera);
    this.queue = this.queue.filter((n) => n.state === 'queued' && n.lastUsed >= this.frame - 1);
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.loading < MAX_LOADS && this.queue.length > 0) this.load(this.queue.shift()!);
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
    };
    this.all.push(n);
    return n;
  }

  /** true — участок тайла покрыт (им самим или потомками). */
  private select(n: TileNode, camera: THREE.Vector3): boolean {
    n.lastUsed = this.frame;
    const d = camera.distanceTo(n.center);
    if (n.z < this.maxZoom && d < SPLIT * n.sizeM) {
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
    if (n.state === 'idle') {
      n.state = 'queued';
      this.queue.push(n);
    }
  }

  private load(n: TileNode) {
    n.state = 'loading';
    this.loading++;
    this.loader.load(
      imageryUrl(n.z, n.x, n.y),
      (tex) => {
        this.loading--;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.anisotropy;
        n.mesh = new THREE.Mesh(this.geometry(n), new THREE.MeshLambertMaterial({ map: tex }));
        n.mesh.receiveShadow = true;
        n.mesh.visible = false;
        this.group.add(n.mesh);
        n.state = 'ready';
      },
      undefined,
      () => {
        this.loading--;
        n.state = 'failed';
      },
    );
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
      n.mesh!.material.map?.dispose();
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
