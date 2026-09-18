import * as THREE from 'three';
import { hash3, type GroundAt, type OsmUniforms } from './osmShared';

/*
 * Растительность сверх деревьев рядом с камерой (osmLayer.ts): дальний лес — простые конусы до
 * горизонта (тайга не обрывается в плоский снимок), и подстилка у камеры — пучки травы и кусты на
 * опушках, когда аппарат низко (взлёт и посадка). Где лес — по той же маске лесов (maskAt: 0 — не
 * лес, 1 — хвойный, 2 — лиственный, 3 — смешанный).
 */

export type MaskAt = (e: number, n: number) => number;

const FAR_CAP = 140_000;
const GRASS_CAP = 9000;
const BUSH_CAP = 4000;

const FADE_VERT = /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
  float dCam = length(instanceMatrix[3].xz - osmCam.xz);
  transformed *= smoothstep(coverFade.x, coverFade.y, dCam) * (1.0 - smoothstep(coverFade.z, coverFade.w, dCam));
#endif
  vUpness = normal.y;`;

const SNOW_FRAG = /* glsl */ `#include <color_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.94), osmSnow * smoothstep(0.1, 0.7, vUpness) * 0.75);`;

/** Материал растительности: плавное появление и исчезание по расстоянию (fade: x→y появление, z→w уход), снег сверху. */
function coverMaterial(u: OsmUniforms, fade: THREE.Vector4, key: string): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.osmCam = u.osmCam;
    shader.uniforms.osmSnow = u.osmSnow;
    shader.uniforms.coverFade = { value: fade };
    shader.vertexShader =
      'uniform vec3 osmCam;\nuniform vec4 coverFade;\nvarying float vUpness;\n' + shader.vertexShader.replace('#include <begin_vertex>', FADE_VERT);
    shader.fragmentShader = 'uniform float osmSnow;\nvarying float vUpness;\n' + shader.fragmentShader.replace('#include <color_fragment>', SNOW_FRAG);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** Цвет вершин: светлее к верху (1 — основание, top — верх). */
function shade(g: THREE.BufferGeometry, base: number, top: number): THREE.BufferGeometry {
  const p = g.attributes['position']!;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.count; i++) {
    y0 = Math.min(y0, p.getY(i));
    y1 = Math.max(y1, p.getY(i));
  }
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = base + (top - base) * ((p.getY(i) - y0) / Math.max(1e-6, y1 - y0));
    c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, cap);
  m.name = name;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  m.count = 0;
  m.frustumCulled = false;
  return m;
}

/** Матрица экземпляра: поворот вокруг вертикали, масштаб по ширине и высоте, положение. */
function put(M: Float32Array, k: number, e: number, y: number, n: number, sw: number, sh: number, a: number) {
  const cs = Math.cos(a), sn = Math.sin(a);
  const o = k * 16;
  M[o] = cs * sw;
  M[o + 1] = 0;
  M[o + 2] = -sn * sw;
  M[o + 3] = 0;
  M[o + 4] = 0;
  M[o + 5] = sh;
  M[o + 6] = 0;
  M[o + 7] = 0;
  M[o + 8] = sn * sw;
  M[o + 9] = 0;
  M[o + 10] = cs * sw;
  M[o + 11] = 0;
  M[o + 12] = e;
  M[o + 13] = y;
  M[o + 14] = -n;
  M[o + 15] = 1;
}

function commit(mesh: THREE.InstancedMesh, M: Float32Array, C: Float32Array, count: number) {
  mesh.count = count;
  mesh.visible = count > 0;
  if (!count) return;
  (mesh.instanceMatrix.array as Float32Array).set(M.subarray(0, count * 16));
  mesh.instanceMatrix.clearUpdateRanges();
  mesh.instanceMatrix.addUpdateRange(0, count * 16);
  mesh.instanceMatrix.needsUpdate = true;
  const ic = mesh.instanceColor!;
  (ic.array as Float32Array).set(C.subarray(0, count * 3));
  ic.clearUpdateRanges();
  ic.addUpdateRange(0, count * 3);
  ic.needsUpdate = true;
}

interface FarPop {
  ce: number;
  cn: number;
  j: number;
  j1: number;
  n: number;
}

/**
 * Дальний лес: за радиусом деревьев рядом (rIn) до rOut — конусы по сетке spacing там, где лес;
 * хвойные уже и темнее, лиственные шире и светлее, осенью желтеют. Пересборка по частям, когда
 * камера ушла на восьмую часть rOut.
 */
export class FarForest {
  readonly mesh: THREE.InstancedMesh;
  private readonly fade = new THREE.Vector4(1e9, 1e9, 1e9, 1e9);
  private readonly M = new Float32Array(FAR_CAP * 16);
  private readonly C = new Float32Array(FAR_CAP * 3);
  private pop: FarPop | null = null;
  private centre: { e: number; n: number } | null = null;
  autumn = 0;

  constructor(u: OsmUniforms) {
    const geo = shade(new THREE.ConeGeometry(0.34, 1, 6, 1, false).translate(0, 0.5, 0), 0.55, 1.05);
    this.mesh = instanced(geo, coverMaterial(u, this.fade, 'osm-far-forest'), FAR_CAP, 'osm-far-forest');
  }

  /** Пересобрать с нуля (осень, смена качества). */
  invalidate() {
    this.centre = null;
    this.pop = null;
  }

  update(ce: number, cn: number, rIn: number, rOut: number, spacing: number, maskAt: MaskAt, groundAt: GroundAt, deadline: number) {
    if (!(rOut > rIn)) {
      this.mesh.visible = false;
      return;
    }
    this.fade.set(rIn * 0.75, rIn * 0.95, rOut * 0.8, rOut);
    if (!this.pop) {
      const moved = this.centre ? Math.hypot(ce - this.centre.e, cn - this.centre.n) : Infinity;
      if (moved < rOut / 8) return;
      const R = rOut * 1.1;
      this.pop = { ce, cn, j: Math.floor((cn - R) / spacing), j1: Math.floor((cn + R) / spacing), n: 0 };
    }
    const p = this.pop;
    const R = rOut * 1.1;
    const rMin = rIn * 0.7;
    while (p.j <= p.j1) {
      const j = p.j++;
      const dy = (j + 0.5) * spacing - p.cn;
      const half2 = R * R - dy * dy;
      if (half2 <= 0) continue;
      const half = Math.sqrt(half2);
      for (let i = Math.floor((p.ce - half) / spacing); i <= Math.floor((p.ce + half) / spacing); i++) {
        if (p.n >= FAR_CAP) break;
        const e = (i + 0.15 + 0.7 * hash3(i, j, 21)) * spacing;
        const n = (j + 0.15 + 0.7 * hash3(i, j, 22)) * spacing;
        const d2 = (e - p.ce) ** 2 + (n - p.cn) ** 2;
        if (d2 < rMin * rMin || d2 > R * R) continue;
        const code = maskAt(e, n);
        if (!code) continue;
        const kr = hash3(i, j, 23);
        const conifer = code === 1 ? kr < 0.9 : code === 2 ? kr < 0.15 : kr < 0.55;
        const h = 12 + 12 * hash3(i, j, 24);
        const w = conifer ? h * (0.9 + 0.3 * hash3(i, j, 25)) : h * (1.8 + 0.5 * hash3(i, j, 25));
        put(this.M, p.n, e, groundAt(e, n) - 0.5, n, w, conifer ? h : h * 0.8, hash3(i, j, 26) * 6.28);
        const l = 0.8 + 0.35 * hash3(i, j, 27);
        let r = conifer ? 0.08 * l : 0.16 * l;
        let g = conifer ? 0.14 * l : 0.24 * l;
        let b = conifer ? 0.09 * l : 0.1 * l;
        if (!conifer && this.autumn > 0) {
          const turn = this.autumn * (0.35 + 0.65 * hash3(i, j, 28));
          r *= 1 + turn * 2.8;
          g *= 1 + turn * 0.5;
          b *= 1 - turn * 0.5;
        }
        this.C[p.n * 3] = r;
        this.C[p.n * 3 + 1] = g;
        this.C[p.n * 3 + 2] = b;
        p.n++;
      }
      if (performance.now() >= deadline) return;
    }
    commit(this.mesh, this.M, this.C, p.n);
    this.centre = { e: p.ce, n: p.cn };
    this.pop = null;
  }
}

/**
 * Подстилка у камеры, пока она низко: пучки травы вокруг (на открытой земле) и кусты по опушкам.
 * Пересборка, когда камера ушла на несколько метров; зимой под снегом травы нет.
 */
export class GroundCover {
  readonly grass: THREE.InstancedMesh;
  readonly bushes: THREE.InstancedMesh;
  private readonly grassFade = new THREE.Vector4(-1, 0, 26, 34);
  private readonly bushFade = new THREE.Vector4(-1, 0, 190, 230);
  private readonly MG = new Float32Array(GRASS_CAP * 16);
  private readonly CG = new Float32Array(GRASS_CAP * 3);
  private readonly MB = new Float32Array(BUSH_CAP * 16);
  private readonly CB = new Float32Array(BUSH_CAP * 3);
  private grassAt: { e: number; n: number } | null = null;
  private bushAt: { e: number; n: number } | null = null;
  autumn = 0;

  constructor(u: OsmUniforms) {
    // Пучок: семь узких треугольных травинок врозь, у основания темнее.
    const pos: number[] = [];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + 0.4 * Math.sin(k * 3.1);
      const lean = 0.18 + 0.1 * Math.sin(k * 1.7);
      const w = 0.035;
      const cx = Math.cos(a), cz = Math.sin(a);
      pos.push(-cz * w, 0, cx * w, cz * w, 0, -cx * w, cx * lean, 1, cz * lean);
    }
    const tuft = new THREE.BufferGeometry();
    tuft.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    tuft.computeVertexNormals();
    // Трава видна с обеих сторон: нормаль — вверх (освещение как у земли).
    const nrm = tuft.attributes['normal']!;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    shade(tuft, 0.45, 1.0);
    const grassMat = coverMaterial(u, this.grassFade, 'osm-grass');
    grassMat.side = THREE.DoubleSide;
    this.grass = instanced(tuft, grassMat, GRASS_CAP, 'osm-grass');
    const bush = shade(new THREE.IcosahedronGeometry(1, 1).translate(0, 0.7, 0), 0.55, 1.0);
    this.bushes = instanced(bush, coverMaterial(u, this.bushFade, 'osm-bush'), BUSH_CAP, 'osm-bush');
  }

  update(ce: number, cn: number, heightAgl: number, snow: number, maskAt: MaskAt, groundAt: GroundAt, isWater: (e: number, n: number) => boolean) {
    const low = heightAgl < 60 && snow < 0.5;
    this.grass.visible = low && this.grass.count > 0;
    this.bushes.visible = heightAgl < 250 && this.bushes.count > 0;
    if (low && (!this.grassAt || Math.hypot(ce - this.grassAt.e, cn - this.grassAt.n) > 5)) {
      this.grassAt = { e: ce, n: cn };
      const s = 0.75;
      const R = 36;
      let k = 0;
      for (let j = Math.floor((cn - R) / s); j <= Math.floor((cn + R) / s) && k < GRASS_CAP; j++) {
        for (let i = Math.floor((ce - R) / s); i <= Math.floor((ce + R) / s) && k < GRASS_CAP; i++) {
          const e = (i + hash3(i, j, 31)) * s;
          const n = (j + hash3(i, j, 32)) * s;
          if ((e - ce) ** 2 + (n - cn) ** 2 > R * R || hash3(i, j, 33) < 0.25) continue;
          if (maskAt(e, n) || isWater(e, n)) continue;
          const h = 0.25 + 0.35 * hash3(i, j, 34);
          put(this.MG, k, e, groundAt(e, n) - 0.02, n, 0.8 + 0.6 * hash3(i, j, 35), h, hash3(i, j, 36) * 6.28);
          const dry = hash3(i, j, 37) * 0.5 + this.autumn * 0.5;
          this.CG[k * 3] = 0.28 + 0.3 * dry;
          this.CG[k * 3 + 1] = 0.42 + 0.12 * dry;
          this.CG[k * 3 + 2] = 0.14 + 0.05 * dry;
          k++;
        }
      }
      commit(this.grass, this.MG, this.CG, k);
      this.grass.visible = k > 0;
    }
    if (heightAgl < 250 && (!this.bushAt || Math.hypot(ce - this.bushAt.e, cn - this.bushAt.n) > 30)) {
      this.bushAt = { e: ce, n: cn };
      const s = 6;
      const R = 230;
      let k = 0;
      for (let j = Math.floor((cn - R) / s); j <= Math.floor((cn + R) / s) && k < BUSH_CAP; j++) {
        for (let i = Math.floor((ce - R) / s); i <= Math.floor((ce + R) / s) && k < BUSH_CAP; i++) {
          const e = (i + hash3(i, j, 41)) * s;
          const n = (j + hash3(i, j, 42)) * s;
          if ((e - ce) ** 2 + (n - cn) ** 2 > R * R || maskAt(e, n) || isWater(e, n)) continue;
          // Опушка: рядом лес; в поле — редкие одиночные кусты.
          const edge = maskAt(e + 7, n) || maskAt(e - 7, n) || maskAt(e, n + 7) || maskAt(e, n - 7);
          if (!(edge ? hash3(i, j, 43) < 0.7 : hash3(i, j, 43) < 0.02)) continue;
          const sz = 1 + 1.6 * hash3(i, j, 44);
          put(this.MB, k, e, groundAt(e, n) - 0.3, n, sz * (1 + 0.4 * hash3(i, j, 45)), sz, hash3(i, j, 46) * 6.28);
          const l = 0.75 + 0.35 * hash3(i, j, 47);
          this.CB[k * 3] = (0.2 + 0.25 * this.autumn) * l;
          this.CB[k * 3 + 1] = 0.3 * l;
          this.CB[k * 3 + 2] = 0.12 * l;
          k++;
        }
      }
      commit(this.bushes, this.MB, this.CB, k);
      this.bushes.visible = k > 0;
    }
  }

  invalidate() {
    this.grassAt = null;
    this.bushAt = null;
  }
}
