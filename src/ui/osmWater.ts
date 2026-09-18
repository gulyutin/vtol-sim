import * as THREE from 'three';
import type { OsmData, WaterKind } from '../sim/osm';
import { clipHalf, hash3, LazyChunks, Polyline, type ChunkPart, type GroundAt, type OsmUniforms } from './osmShared';

/*
 * Вода: озёра, пруды, водохранилища, реки площадями и реки и ручьи линиями.
 *
 * Площадь режется на клетки CELL_M (треугольники контура отсекаются по сетке), высота воды —
 * своя у каждой клетки уровня LEVEL_M: нижняя треть высот рельефа в её кусках. Где рельеф выше
 * уровня (берег в контуре, шум модели высот), вода ложится на рельеф — контур из OSM не рвётся.
 * Поверх рельефа — подъём LIFT_M и смещение полигонов: вода не мерцает.
 *
 * Материал — PBR с малой шероховатостью: отражает небо (scene.environment) по Френелю, на
 * отвесном взгляде — тёмная; рябь — две-три выборки бесшовной карты нормалей в мировых
 * координатах, сносимые ветром. Нормаль считается от вертикали, а не от сетки: на берегу, где
 * вода легла на склон, блики не выдают наклон.
 */

const CHUNK_M = 2000;
const CELL_M = 25;
const LEVEL_M = 250;
const LIFT_M = 0.25;
const LINE_STEP_M = 10;
/** Доля высот рельефа ниже уровня воды в клетке уровня. */
const LEVEL_QUANTILE = 0.35;

const COLORS: Record<WaterKind, number> = { lake: 0x27495a, river: 0x2d4f4c, reservoir: 0x27495a, basin: 0x3a4f42 };
const LINE_COLOR = 0x2f514b;

type Item = { area: number } | { line: number; a0: number; a1: number };

/** Бесшовная карта нормалей ряби: сумма синусоид с целыми волновыми числами. */
function waterNormals(): THREE.DataTexture {
  const S = 128;
  const waves: [number, number, number, number][] = [];
  for (let i = 0; i < 20; i++) {
    const k = 2 + Math.floor(hash3(i, 1, 77) * 11);
    const a = hash3(i, 2, 77) * Math.PI * 2;
    const kx = Math.round(k * Math.cos(a)), ky = Math.round(k * Math.sin(a));
    if (!kx && !ky) continue;
    waves.push([kx, ky, 1 / Math.pow(Math.hypot(kx, ky), 1.4), hash3(i, 3, 77) * Math.PI * 2]);
  }
  const gx = new Float32Array(S * S);
  const gy = new Float32Array(S * S);
  let max = 1e-6;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, amp, ph] of waves) {
        const c = Math.cos(2 * Math.PI * ((kx * x + ky * y) / S) + ph) * amp * 2 * Math.PI;
        dx += kx * c;
        dy += ky * c;
      }
      gx[y * S + x] = dx;
      gy[y * S + x] = dy;
      max = Math.max(max, Math.hypot(dx, dy));
    }
  }
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const sx = (-gx[i]! / max) * 0.7, sy = (-gy[i]! / max) * 0.7;
    const l = Math.hypot(sx, sy, 1);
    data[4 * i] = Math.round((sx / l) * 127.5 + 127.5);
    data[4 * i + 1] = Math.round((sy / l) * 127.5 + 127.5);
    data[4 * i + 2] = Math.round((1 / l) * 127.5 + 127.5);
    data[4 * i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const WATER_HEAD = /* glsl */ `
uniform sampler2D osmWaterNormals;
uniform float osmTime;
uniform vec2 osmWind;
uniform float osmIce;
varying vec3 vWaterWorld;
`;

const WATER_NORMAL = /* glsl */ `
{
  vec2 p = vWaterWorld.xz;
  float ws = length(osmWind);
  vec2 dir = ws > 0.05 ? osmWind / ws : vec2(0.7071, 0.7071);
  vec2 drift = dir * osmTime * (0.25 + 0.06 * min(ws, 15.0));
  vec3 n1 = texture2D(osmWaterNormals, (p - drift) / 19.0).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(osmWaterNormals, (mat2(0.8, 0.6, -0.6, 0.8) * p - drift * 1.6) / 7.3).xyz * 2.0 - 1.0;
  vec3 n3 = texture2D(osmWaterNormals, (mat2(0.6, -0.8, 0.8, 0.6) * p - drift * 0.5) / 61.0).xyz * 2.0 - 1.0;
  // Сильнее при ветре; вдали — спокойнее (иначе блики рябят в пикселях).
  float strength = (0.12 + 0.035 * min(ws, 14.0)) / (1.0 + distance(vWaterWorld, cameraPosition) / 1800.0) * (1.0 - osmIce);
  vec2 slope = (n1.xy + 0.55 * n2.xy + 0.9 * n3.xy) * strength;
  vec3 nWorld = normalize(vec3(slope.x, 1.0, slope.y));
  normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
}
`;

export class OsmWaterLayer {
  private readonly chunks: LazyChunks<Item>;
  private readonly tris = new Map<number, Float64Array>();
  private readonly lines: Polyline[];
  private readonly normals = waterNormals();
  private readonly material: THREE.MeshStandardMaterial;

  constructor(
    private readonly data: OsmData,
    private readonly groundAt: GroundAt,
    uniforms: OsmUniforms,
  ) {
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.07,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.osmTime = uniforms.osmTime;
      shader.uniforms.osmWind = uniforms.osmWind;
      shader.uniforms.osmIce = uniforms.osmIce;
      shader.uniforms.osmWaterNormals = { value: this.normals };
      shader.vertexShader =
        'varying vec3 vWaterWorld;\n' +
        shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader =
        WATER_HEAD +
        shader.fragmentShader
          .replace('#include <normal_fragment_maps>', WATER_NORMAL)
          // Лёд под снегом: белёсый, матовый, без ряби; у кромки и промоин — темнее.
          .replace(
            '#include <color_fragment>',
            // Переметённый ветром снег на льду — плавные полосы по крупной текстуре ряби.
            '#include <color_fragment>\n  float drift = texture2D(osmWaterNormals, vWaterWorld.xz / vec2(260.0, 90.0)).x;\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.92) * (0.9 + 0.12 * drift), osmIce);',
          )
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.8, osmIce);');
    };
    this.material.customProgramCacheKey = () => 'osm-water';

    this.chunks = new LazyChunks<Item>(CHUNK_M, (items, ix, iy) => this.buildChunk(items, ix, iy));
    this.chunks.group.name = 'osm-water';
    data.water.forEach((w, area) => {
      const o = w.rings[0];
      if (!o || o.length < 6) return;
      let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
      for (let i = 0; i + 1 < o.length; i += 2) {
        e0 = Math.min(e0, o[i]!);
        e1 = Math.max(e1, o[i]!);
        n0 = Math.min(n0, o[i + 1]!);
        n1 = Math.max(n1, o[i + 1]!);
      }
      for (let ix = Math.floor(e0 / CHUNK_M); ix <= Math.floor(e1 / CHUNK_M); ix++) {
        for (let iy = Math.floor(n0 / CHUNK_M); iy <= Math.floor(n1 / CHUNK_M); iy++) this.chunks.addAt(ix, iy, { area });
      }
    });
    this.lines = data.waterways.map((w) => new Polyline(w.line));
    this.lines.forEach((pl, line) => pl.pieces(CHUNK_M, 150, (ix, iy, a0, a1) => this.chunks.addAt(ix, iy, { line, a0, a1 })));
  }

  get group(): THREE.Group {
    return this.chunks.group;
  }

  update(ce: number, cn: number, radius: number, deadline: number): void {
    this.chunks.update(ce, cn, radius, deadline);
  }

  dispose(): void {
    this.chunks.dispose();
    this.material.dispose();
    this.normals.dispose();
    this.tris.clear();
  }

  /** Треугольники площади (с островами) против часовой стрелки: [ax, ay, bx, by, cx, cy, …]. */
  private triangles(k: number): Float64Array {
    const cached = this.tris.get(k);
    if (cached) return cached;
    const rings = this.data.water[k]!.rings.filter((r) => r.length >= 6);
    const toVec = (r: Float32Array) => {
      const out: THREE.Vector2[] = [];
      for (let i = 0; i + 1 < r.length; i += 2) out.push(new THREE.Vector2(r[i]!, r[i + 1]!));
      return out;
    };
    const contour = toVec(rings[0]!);
    const holes = rings.slice(1).map(toVec);
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const all = contour.concat(...holes);
    const t = new Float64Array(faces.length * 6);
    let o = 0;
    for (const f of faces) {
      const a = all[f[0]!], b0 = all[f[1]!], c0 = all[f[2]!];
      if (!a || !b0 || !c0) continue;
      const ccw = (b0.x - a.x) * (c0.y - a.y) - (b0.y - a.y) * (c0.x - a.x) >= 0;
      const [b, c] = ccw ? [b0, c0] : [c0, b0];
      t[o++] = a.x;
      t[o++] = a.y;
      t[o++] = b.x;
      t[o++] = b.y;
      t[o++] = c.x;
      t[o++] = c.y;
    }
    const out = t.subarray(0, o);
    this.tris.set(k, out);
    return out;
  }

  private *buildChunk(items: readonly Item[], ix: number, iy: number): Generator<unknown, ChunkPart[], unknown> {
    const pos: number[] = [];
    const col: number[] = [];
    const color = new THREE.Color();
    const x0 = ix * CHUNK_M, y0 = iy * CHUNK_M, x1 = x0 + CHUNK_M, y1 = y0 + CHUNK_M;
    let steps = 0;
    for (const it of items) {
      if ('line' in it) {
        color.setHex(LINE_COLOR);
        this.lineRibbon(it.line, it.a0, it.a1, pos, col, color);
        yield;
        continue;
      }
      color.setHex(COLORS[this.data.water[it.area]!.kind]);
      const tri = this.triangles(it.area);
      yield;
      // Куски по клеткам сетки, собранные в клетки уровня.
      const cells = new Map<number, { xy: number[]; g: number[]; tri: number[] }>();
      for (let t = 0; t < tri.length; t += 6) {
        const ax = tri[t]!, ay = tri[t + 1]!, bx = tri[t + 2]!, by = tri[t + 3]!, cx = tri[t + 4]!, cy = tri[t + 5]!;
        if (Math.max(ax, bx, cx) <= x0 || Math.min(ax, bx, cx) >= x1 || Math.max(ay, by, cy) <= y0 || Math.min(ay, by, cy) >= y1) continue;
        let poly = [ax, ay, bx, by, cx, cy];
        poly = clipHalf(poly, -1, 0, -x0);
        poly = clipHalf(poly, 1, 0, x1);
        poly = clipHalf(poly, 0, -1, -y0);
        poly = clipHalf(poly, 0, 1, y1);
        if (poly.length < 6) continue;
        let pMin = Infinity, pMax = -Infinity;
        for (let i = 1; i < poly.length; i += 2) {
          pMin = Math.min(pMin, poly[i]!);
          pMax = Math.max(pMax, poly[i]!);
        }
        for (let r = Math.max(0, Math.floor((pMin - y0) / CELL_M)); y0 + r * CELL_M < pMax; r++) {
          const ya = y0 + r * CELL_M;
          const row = clipHalf(clipHalf(poly, 0, -1, -ya), 0, 1, ya + CELL_M);
          if (row.length < 6) continue;
          let rMin = Infinity, rMax = -Infinity;
          for (let i = 0; i < row.length; i += 2) {
            rMin = Math.min(rMin, row[i]!);
            rMax = Math.max(rMax, row[i]!);
          }
          for (let c = Math.max(0, Math.floor((rMin - x0) / CELL_M)); x0 + c * CELL_M < rMax; c++) {
            const xa = x0 + c * CELL_M;
            const cell = clipHalf(clipHalf(row, -1, 0, -xa), 1, 0, xa + CELL_M);
            const m = cell.length / 2;
            if (m < 3) continue;
            const key = Math.floor((c * CELL_M) / LEVEL_M) * 64 + Math.floor((r * CELL_M) / LEVEL_M);
            let lc = cells.get(key);
            if (!lc) cells.set(key, (lc = { xy: [], g: [], tri: [] }));
            const base = lc.g.length;
            for (let i = 0; i < m; i++) {
              lc.xy.push(cell[2 * i]!, cell[2 * i + 1]!);
              lc.g.push(this.groundAt(cell[2 * i]!, cell[2 * i + 1]!));
            }
            for (let i = 1; i + 1 < m; i++) lc.tri.push(base, base + i, base + i + 1);
          }
          if (++steps % 6 === 0) yield;
        }
      }
      const levels = new Map<number, number>();
      for (const [key, lc] of cells) {
        const sorted = Float64Array.from(lc.g).sort();
        levels.set(key, sorted[Math.floor((sorted.length - 1) * LEVEL_QUANTILE)]!);
      }
      // Вершина на границе клеток уровня берёт больший из соседних уровней — без щелей между клетками.
      const levelAt = (e: number, n: number) => {
        const fx = (e - x0) / LEVEL_M, fy = (n - y0) / LEVEL_M;
        const rx = Math.round(fx), ry = Math.round(fy);
        const xs = Math.abs(fx - rx) < 1e-6 ? [rx - 1, rx] : [Math.floor(fx)];
        const ys = Math.abs(fy - ry) < 1e-6 ? [ry - 1, ry] : [Math.floor(fy)];
        let best = -Infinity;
        for (const i of xs) {
          for (const j of ys) {
            const l = i >= 0 && j >= 0 ? levels.get(i * 64 + j) : undefined;
            if (l !== undefined && l > best) best = l;
          }
        }
        return best;
      };
      for (const lc of cells.values()) {
        for (const v of lc.tri) {
          const e = lc.xy[2 * v]!, n = lc.xy[2 * v + 1]!;
          pos.push(e, Math.max(levelAt(e, n), lc.g[v]!) + LIFT_M, -n);
          col.push(color.r, color.g, color.b);
        }
      }
      yield;
    }
    if (!pos.length) return [];
    const nv = pos.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nor = new Int8Array(nv * 3);
    for (let i = 0; i < nv; i++) nor[3 * i + 1] = 127;
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    const c8 = new Uint8Array(nv * 3);
    for (let i = 0; i < c8.length; i++) c8[i] = Math.round(col[i]! * 255);
    g.setAttribute('color', new THREE.BufferAttribute(c8, 3, true));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = `osm-water ${ix},${iy}`;
    // После рельефа и до дорог: мосты рисуются поверх воды, дороги у берега — под ней.
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    return [{ object: mesh, range: 1 }];
  }

  /** Лента реки или ручья по рельефу. */
  private lineRibbon(k: number, a0: number, a1: number, pos: number[], col: number[], color: THREE.Color) {
    const w = this.data.waterways[k]!;
    const pl = this.lines[k]!;
    const st: number[] = [];
    pl.stations(a0, a1, LINE_STEP_M, st);
    const hw = w.widthM / 2;
    const m = st.length / 6;
    let pr: number[] | null = null;
    for (let i = 0; i < m; i++) {
      const e = st[6 * i + 1]!, n = st[6 * i + 2]!;
      const nx = st[6 * i + 3]! * hw * st[6 * i + 5]!, ny = st[6 * i + 4]! * hw * st[6 * i + 5]!;
      const le = e + nx, ln = n + ny, re = e - nx, rn = n - ny;
      const cur = [re, this.groundAt(re, rn) + LIFT_M, -rn, le, this.groundAt(le, ln) + LIFT_M, -ln];
      if (pr) {
        // (R0, R1, L1), (R0, L1, L0) — против часовой при взгляде сверху.
        pos.push(pr[0]!, pr[1]!, pr[2]!, cur[0]!, cur[1]!, cur[2]!, cur[3]!, cur[4]!, cur[5]!);
        pos.push(pr[0]!, pr[1]!, pr[2]!, cur[3]!, cur[4]!, cur[5]!, pr[3]!, pr[4]!, pr[5]!);
        for (let j = 0; j < 6; j++) col.push(color.r, color.g, color.b);
      }
      pr = cur;
    }
  }
}
