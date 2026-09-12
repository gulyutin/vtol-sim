import * as THREE from 'three';
import { toLocal } from '../sim/mission';
import type { Site } from '../sim/types';
import type { Zone, ZoneKind } from '../sim/zones';

/*
 * Зоны в 3D: полупрозрачные стены по границе от рельефа (или от пола зоны) до потолка, без
 * потолка — до WALL_TOP_M над площадкой. Внизу плотнее, кверху тают. Запретная — красная со
 * штриховкой, РЭБ — фиолетовая или жёлтая. Глубину не пишут: не заслоняют аппарат и друг друга.
 */

const WALL_TOP_M = 1500;
/** Шаг по периметру, м: стена ложится на рельеф; вершин на зону не больше MAX_POINTS. */
const STEP_M = 60;
const MAX_POINTS = 600;
/** Масштаб штриховки, м на повтор. */
const STRIPE_M = 120;

export const ZONE_COLOR_3D: Record<ZoneKind, number> = {
  nofly: 0xff3b3b,
  'gnss-jam': 0xa45cff,
  'gnss-spoof': 0xff5fd2,
  'link-jam': 0xffc933,
};

export class ZoneWalls {
  readonly group = new THREE.Group();
  private stripes: THREE.CanvasTexture | null = null;

  constructor(private readonly groundAt: (east: number, north: number) => number) {
    this.group.name = 'zones';
  }

  /** Стены зон; site — начало координат сцены (площадка взлёта). */
  set(zones: readonly Zone[], site: Site) {
    this.clear();
    for (const z of zones) {
      const pts = outline(z, site);
      if (pts.length < 3) continue;
      const top = z.ceilingM !== undefined ? z.ceilingM - site.elevationM : WALL_TOP_M;
      const nofly = z.kind === 'nofly';
      const n = pts.length;
      const pos = new Float32Array((n + 1) * 2 * 3);
      const col = new Float32Array((n + 1) * 2 * 4);
      const uv = new Float32Array((n + 1) * 2 * 2);
      const ground: THREE.Vector3[] = [];
      let along = 0;
      for (let i = 0; i <= n; i++) {
        const p = pts[i % n]!;
        if (i > 0) along += Math.hypot(p.e - pts[i - 1]!.e, p.n - pts[i - 1]!.n);
        const g = this.groundAt(p.e, p.n);
        const bottom = z.floorM !== undefined ? Math.max(g, z.floorM - site.elevationM) : g - 3;
        const up = Math.max(bottom, top);
        pos.set([p.e, bottom, -p.n, p.e, up, -p.n], i * 6);
        col.set([1, 1, 1, nofly ? 0.42 : 0.32, 1, 1, 1, 0.02], i * 8);
        uv.set([along / STRIPE_M, 0, along / STRIPE_M, (up - bottom) / STRIPE_M], i * 4);
        if (i < n) ground.push(new THREE.Vector3(p.e, Math.max(g, bottom) + 2, -p.n));
      }
      const index: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = 2 * i;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(index);
      geo.computeBoundingSphere();
      const wall = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: ZONE_COLOR_3D[z.kind],
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          map: nofly ? this.stripeTexture() : null,
          toneMapped: false,
        }),
      );
      wall.renderOrder = 2;
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(ground),
        new THREE.LineBasicMaterial({ color: ZONE_COLOR_3D[z.kind], transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }),
      );
      line.renderOrder = 2;
      this.group.add(wall, line);
    }
  }

  dispose() {
    this.clear();
    this.stripes?.dispose();
    this.stripes = null;
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }

  /** Косая штриховка: полосы плотнее фона, всё умножается на прозрачность стены. */
  private stripeTexture(): THREE.CanvasTexture {
    if (this.stripes) return this.stripes;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d')!;
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 12;
    for (const d of [-64, 0, 64]) {
      g.beginPath();
      g.moveTo(d, 64);
      g.lineTo(d + 64, 0);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.stripes = tex;
    return tex;
  }
}

/** Граница зоны в локальных метрах, замкнутая без повтора первой точки, с шагом около STEP_M. */
function outline(z: Zone, site: Site): { e: number; n: number }[] {
  if (z.center && z.radiusM && z.radiusM > 0) {
    const c = toLocal(site, z.center);
    const k = Math.min(256, Math.max(48, Math.ceil((2 * Math.PI * z.radiusM) / STEP_M)));
    return Array.from({ length: k }, (_, i) => {
      const a = (2 * Math.PI * i) / k;
      return { e: c.east + z.radiusM! * Math.sin(a), n: c.north + z.radiusM! * Math.cos(a) };
    });
  }
  if (!z.polygon || z.polygon.length < 3) return [];
  const v = z.polygon.map((p) => {
    const q = toLocal(site, p);
    return { e: q.east, n: q.north };
  });
  let perimeter = 0;
  for (let i = 0; i < v.length; i++) perimeter += Math.hypot(v[(i + 1) % v.length]!.e - v[i]!.e, v[(i + 1) % v.length]!.n - v[i]!.n);
  const step = Math.max(STEP_M, perimeter / MAX_POINTS);
  const out: { e: number; n: number }[] = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i]!;
    const b = v[(i + 1) % v.length]!;
    const k = Math.max(1, Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / step));
    for (let j = 0; j < k; j++) out.push({ e: a.e + ((b.e - a.e) * j) / k, n: a.n + ((b.n - a.n) * j) / k });
  }
  return out;
}
