import * as THREE from 'three';
import type { LocalPoint } from '../sim/timeline';
import { heatMaterial, marchToGround } from './heat';

/*
 * Тепловизор (LWIR) в окне поверх 3D-вида. Проход 1: сцена в маленький кадр датчика (как у
 * матрицы 640×512 — не больше MAX_W по ширине) с тепловыми материалами: у каждого обычного
 * материала — двойник с тем же вершинным шейдером (качание и таяние деревьев, рельеф, вода),
 * а цвет заменён «температурой» по роду поверхности, её альбедо и нагреву Солнцем. Тёплые тела
 * рисуются в том же проходе «горячим» материалом (heat.ts), так что деревья и склоны закрывают их
 * по глубине. В кадре: R — температура, G — «тёплое тело» (для ореола), A — покрытие (0 — небо).
 * Проход 2: полноэкранный квад в прямоугольнике окна — небо по высоте луча, лёгкое размытие,
 * ореол вокруг тел, шум матрицы, виньетка, узкий диапазон и палитра (белое или чёрное — горячее).
 * Обычный вид не меняется: материалы и видимость возвращаются после прохода.
 */

/** Род поверхности для тепловой картинки; hide — не рисовать (линии, облака, подписи). */
export type ThermalKind = 'terrain' | 'tree' | 'building' | 'road' | 'water' | 'machine' | 'generic' | 'body' | 'hide';

export interface ThermalRect {
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Условия съёмки. */
export interface ThermalEnv {
  /** Направление на Солнце в координатах сцены. */
  sunDir: THREE.Vector3;
  /** Нагрев Солнцем 0…1: высота Солнца и облачность. */
  solar: number;
  /** 0 — день, 1 — ночь. */
  night: number;
  /** 0 — ясно, 1 — сплошная облачность. */
  overcast: number;
  /** Дальность, на которой воздух заметно съедает контраст, м. */
  airRangeM: number;
  whiteHot: boolean;
  /** Палитра; нет — по whiteHot: белое или чёрное — горячее. */
  palette?: ThermalPalette;
}

export type ThermalPalette = 'white' | 'black' | 'iron' | 'rainbow';

/** Палитры тепловизора по порядку в шейдере (uPalette). */
export const THERMAL_PALETTES: readonly { id: ThermalPalette; title: string }[] = [
  { id: 'white', title: 'Белый — горячо' },
  { id: 'black', title: 'Чёрный — горячо' },
  { id: 'iron', title: 'Железо' },
  { id: 'rainbow', title: 'Радуга' },
];

/** Наибольшая ширина кадра датчика, пикс. */
const MAX_W = 640;

const KIND_CODE: Record<Exclude<ThermalKind, 'body' | 'hide'>, number> = {
  generic: 0,
  terrain: 1,
  tree: 2,
  building: 3,
  road: 4,
  water: 5,
  machine: 6,
};

/*
 * «Температура» — условные единицы 0…1: ~0.03 — ясное небо в зените, ~0.2 — вода, 0.3–0.45 —
 * земля и лес, до ~0.7 — нагретый Солнцем грунт, асфальт и крыши; 0.8–1 — тела.
 */
const THERMAL_HEAD = /* glsl */ `
uniform vec3 thSunView; uniform float thSolar; uniform float thNight; uniform float thAir; uniform float thRange;
varying vec3 vThermalView;
float thSurface(vec3 alb, vec3 n) {
  float L = dot(alb, vec3(0.2126, 0.7152, 0.0722));
  // Нагрев: Солнце по косинусу падения плюс рассеянный свет неба.
  float q = thSolar * (0.3 + 0.7 * max(dot(n, thSunView), 0.0));
#if THERMAL_KIND == 1
  // Земля по снимку: тёмная зелень — лес (испаряет — прохладный), светлое — открытый грунт и
  // камень (днём греется, ночью остывает), тёмное синеватое — вода (холоднее всего).
  vec3 ch = alb / (alb.r + alb.g + alb.b + 1e-4);
  float open = smoothstep(0.025, 0.16, L);
  float veg = smoothstep(0.36, 0.44, ch.g);
  float wet = smoothstep(0.33, 0.40, ch.b) * (1.0 - smoothstep(0.015, 0.06, L));
  float forest = mix(0.40, 0.35, thNight) + 0.07 * q;
  float ground = mix(0.37, 0.29, thNight) + (0.26 + 0.10 * (1.0 - veg)) * q;
  float h = mix(forest, ground, open) + (L - 0.08) * 0.25 * thSolar;
  return mix(h, mix(0.2, 0.25, thNight), wet);
#elif THERMAL_KIND == 2
  return mix(0.41, 0.35, thNight) + 0.08 * q + (L - 0.05) * 0.3;
#elif THERMAL_KIND == 3
  // Дома: днём крыши и стены греются, ночью отдают тепло — светлее остывшей земли.
  return mix(0.45, 0.41, thNight) + 0.22 * q;
#elif THERMAL_KIND == 4
  return mix(0.43, 0.36, thNight) + 0.3 * q;
#elif THERMAL_KIND == 5
  // Вода: холодная; под скользящим углом отражает холодное небо — ещё темнее.
  return mix(0.2, 0.25, thNight) - 0.05 * (1.0 - abs(n.z));
#elif THERMAL_KIND == 6
  return mix(0.5, 0.44, thNight) + 0.18 * q;
#else
  return mix(0.38, 0.31, thNight) + 0.22 * q * (1.0 - L);
#endif
}
`;

function thermalTail(basic: boolean): string {
  const n = basic ? 'normalize(cross(dFdx(vThermalView), dFdy(vThermalView)))' : 'normalize(normal)';
  return /* glsl */ `
  {
    float thH = thSurface(diffuseColor.rgb, ${n});
    // Воздух: вдали контраст уходит в тон горизонта.
    thH = mix(thH, thAir, 1.0 - exp(-length(vThermalView) / thRange));
    gl_FragColor = vec4(thH, 0.0, 0.0, diffuseColor.a);
  }
`;
}

const POST_VERTEX = /* glsl */ `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FRAGMENT = /* glsl */ `uniform sampler2D tHeat;
uniform vec2 uRes;
uniform float uFrame;
uniform float uPalette;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uSkyZenith;
uniform float uSkyHorizon;
uniform float uLo;
uniform float uHi;
varying vec2 vUv;
// Палитры тепловизора: «железо» — чёрный, фиолетовый, красный, оранжевый, жёлтый, белый; радуга — от синего к красному.
vec3 ironbow(float t) {
  t = clamp(t, 0.0, 1.0) * 5.0;
  vec3 c0 = vec3(0.0), c1 = vec3(0.17, 0.0, 0.42), c2 = vec3(0.66, 0.02, 0.52), c3 = vec3(0.94, 0.3, 0.05), c4 = vec3(1.0, 0.76, 0.12), c5 = vec3(1.0, 1.0, 0.86);
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  return mix(c4, c5, t - 4.0);
}
vec3 rainbow(float t) {
  float h = (1.0 - clamp(t, 0.0, 1.0)) * 0.7;
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Небо: холодное в зените, к горизонту — теплее (длиннее путь в воздухе).
float skyAt(vec2 uv) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  return mix(uSkyHorizon, uSkyZenith, pow(clamp(d.y, 0.0, 1.0), 0.4));
}
float sceneAt(vec2 uv, float sky) { vec4 c = texture2D(tHeat, uv); return c.r + sky * (1.0 - c.a); }
void main() {
  vec2 px = 1.0 / uRes;
  float sky = skyAt(vUv);
  // Оптика: лёгкое размытие.
  float v = sceneAt(vUv, sky) * 0.4
    + (sceneAt(vUv + vec2(px.x, 0.0), sky) + sceneAt(vUv - vec2(px.x, 0.0), sky)
    + sceneAt(vUv + vec2(0.0, px.y), sky) + sceneAt(vUv - vec2(0.0, px.y), sky)) * 0.15;
  // Ореол вокруг тёплых тел — два кольца выборок.
  float halo = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236;
    vec2 dir = vec2(cos(a), sin(a)) * px;
    halo += texture2D(tHeat, vUv + dir * 2.5).g * 0.6 + texture2D(tHeat, vUv + dir * 5.5).g * 0.4;
  }
  v += halo / 12.0 * 0.5 + texture2D(tHeat, vUv).g * 0.12;
  // Шум матрицы: временной по пикселям датчика и слабый неподвижный по столбцам.
  vec2 cell = floor(vUv * uRes);
  v += (hash(cell + fract(uFrame * 0.618) * 97.0) - 0.5) * 0.035;
  v += (hash(vec2(cell.x, 7.0)) - 0.5) * 0.012;
  // Узкий диапазон: ни чистого чёрного, ни чистого белого.
  float t = mix(0.05, 0.95, clamp((v - uLo) / (uHi - uLo), 0.0, 1.0));
  vec3 col = uPalette < 0.5 ? vec3(t) : uPalette < 1.5 ? vec3(1.0 - t) : uPalette < 2.5 ? ironbow(t) : rainbow(t);
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(q, q);
  gl_FragColor = vec4(col, 1.0);
}`;

interface CacheEntry {
  version: number;
  byKind: Map<ThermalKind, THREE.Material>;
}

type AnyMaterial = THREE.Material & { isMeshBasicMaterial?: boolean; fog?: boolean; defines?: Record<string, unknown> };

function supported(m: THREE.Material): boolean {
  const x = m as THREE.Material & Record<string, unknown>;
  return !!(x['isMeshBasicMaterial'] || x['isMeshLambertMaterial'] || x['isMeshPhongMaterial'] || x['isMeshStandardMaterial'] || x['isMeshToonMaterial'] || x['isMeshMatcapMaterial']);
}

export class ThermalView {
  /** Камера последнего теплового кадра: по ней и thermalPick. */
  readonly camera = new THREE.PerspectiveCamera(20, 4 / 3, 0.5, 30000);
  private readonly target: THREE.WebGLRenderTarget;
  private readonly uniforms = {
    thSunView: { value: new THREE.Vector3(0, 1, 0) },
    thSolar: { value: 0 },
    thNight: { value: 0 },
    thAir: { value: 0.34 },
    thRange: { value: 20000 },
  };
  private readonly cache = new WeakMap<THREE.Material, CacheEntry>();
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly post: THREE.ShaderMaterial;
  private readonly postScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
  private readonly hidden: THREE.Object3D[] = [];
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();
  private frame = 0;
  private rect: ThermalRect | null = null;
  private kinds: ReadonlyMap<THREE.Object3D, ThermalKind> = new Map();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(4, 3, { type: THREE.HalfFloatType, samples: 4 });
    this.target.texture.name = 'thermal';
    this.post = new THREE.ShaderMaterial({
      vertexShader: POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tHeat: { value: this.target.texture },
        uRes: { value: new THREE.Vector2(4, 3) },
        uFrame: { value: 0 },
        uPalette: { value: 0 },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uSkyZenith: { value: 0.03 },
        uSkyHorizon: { value: 0.34 },
        uLo: { value: 0.08 },
        uHi: { value: 0.95 },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  /**
   * Тепловой кадр в окне rect (CSS-пиксели от правого нижнего угла холста). Камеру (положение,
   * взгляд, поле зрения, аспект) надо выставить заранее. kinds — род поверхности для узлов сцены,
   * наследуется потомками; без него — generic.
   */
  render(scene: THREE.Scene, kinds: ReadonlyMap<THREE.Object3D, ThermalKind>, rect: ThermalRect, env: ThermalEnv) {
    const r = this.renderer;
    const cam = this.camera;
    this.rect = { ...rect };
    this.kinds = kinds;
    const w = Math.max(16, Math.min(MAX_W, Math.round(rect.width)));
    const h = Math.max(12, Math.round((w * rect.height) / Math.max(1, rect.width)));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    cam.updateMatrixWorld();

    const u = this.uniforms;
    u.thSunView.value.copy(env.sunDir).transformDirection(cam.matrixWorldInverse);
    u.thSolar.value = env.solar;
    u.thNight.value = env.night;
    const air = THREE.MathUtils.lerp(0.34, 0.31, env.night) + 0.02 * env.overcast;
    u.thAir.value = air;
    u.thRange.value = env.airRangeM;
    const hu = heatMaterial().uniforms;
    hu['uPxAngle']!.value = (cam.fov * Math.PI) / 180 / h;
    hu['uAmbient']!.value = THREE.MathUtils.lerp(0.38, 0.32, env.night);

    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    try {
      this.swap(scene, 'generic');
      // Карта теней — от главного прохода: тепловые материалы её не используют.
      r.shadowMap.autoUpdate = false;
      r.autoClear = true;
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.render(scene, cam);
    } finally {
      for (const [mesh, m] of this.swapped) mesh.material = m;
      for (const o of this.hidden) o.visible = true;
      this.swapped.length = 0;
      this.hidden.length = 0;
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clear, prevAlpha);
      r.autoClear = prevAuto;
      r.shadowMap.autoUpdate = prevShadow;
    }

    const pu = this.post.uniforms;
    (pu['uRes']!.value as THREE.Vector2).set(w, h);
    pu['uFrame']!.value = ++this.frame % 1000;
    pu['uPalette']!.value = THERMAL_PALETTES.findIndex((x) => x.id === (env.palette ?? (env.whiteHot === false ? 'black' : 'white')));
    (pu['uInvProj']!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (pu['uCamWorld']!.value as THREE.Matrix4).copy(cam.matrixWorld);
    pu['uSkyZenith']!.value = 0.03 + 0.22 * env.overcast;
    pu['uSkyHorizon']!.value = air;
    const size = r.getSize(this.size);
    const x = size.x - rect.right - rect.width;
    r.setScissorTest(true);
    r.setViewport(x, rect.bottom, rect.width, rect.height);
    r.setScissor(x, rect.bottom, rect.width, rect.height);
    r.render(this.postScene, this.postCamera);
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
  }

  /**
   * Точка рельефа под щелчком в последнем тепловом кадре: x, y — CSS-пиксели от левого верхнего
   * угла окна. null — кадра ещё не было, щелчок вне окна или луч уходит в небо.
   */
  pick(xCss: number, yCss: number, groundAt: (east: number, north: number) => number): LocalPoint | null {
    const rect = this.rect;
    if (!rect || !(xCss >= 0 && yCss >= 0 && xCss <= rect.width && yCss <= rect.height)) return null;
    const cam = this.camera;
    const p = new THREE.Vector3((xCss / rect.width) * 2 - 1, 1 - (yCss / rect.height) * 2, 0.5).unproject(cam);
    const d = p.sub(cam.position);
    return marchToGround({ east: cam.position.x, north: -cam.position.z, up: cam.position.y }, { east: d.x, north: -d.z, up: d.y }, groundAt);
  }

  dispose() {
    this.target.dispose();
    this.post.dispose();
    this.hiddenMaterial.dispose();
  }

  /** Тепловые материалы на меши, лишнее — скрыть; всё записывается для возврата. */
  private swap(o: THREE.Object3D, inherited: ThermalKind) {
    if (!o.visible) return;
    const kind = this.kinds.get(o) ?? inherited;
    if (kind === 'hide') {
      this.hide(o);
      return;
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const m = kind === 'body' ? heatMaterial() : this.materialFor(mesh.material, kind);
      if (m) {
        this.swapped.push([mesh, mesh.material]);
        mesh.material = m;
      } else {
        this.hide(o);
        return;
      }
    } else if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) {
      this.hide(o);
      return;
    }
    for (const c of o.children) this.swap(c, kind);
  }

  private hide(o: THREE.Object3D) {
    o.visible = false;
    this.hidden.push(o);
  }

  private materialFor(m: THREE.Material | THREE.Material[], kind: Exclude<ThermalKind, 'body' | 'hide'>): THREE.Material | THREE.Material[] | null {
    if (Array.isArray(m)) return m.map((x) => this.thermalOf(x, kind) ?? this.hiddenMaterial);
    return this.thermalOf(m, kind);
  }

  /** Двойник материала для рода kind; пересоздаётся, если исходный изменился (needsUpdate). */
  private thermalOf(orig: THREE.Material, kind: Exclude<ThermalKind, 'body' | 'hide'>): THREE.Material | null {
    if (!supported(orig)) return null;
    let e = this.cache.get(orig);
    if (e && e.version !== orig.version) {
      for (const m of e.byKind.values()) m.dispose();
      e = undefined;
    }
    if (!e) {
      e = { version: orig.version, byKind: new Map() };
      this.cache.set(orig, e);
      orig.addEventListener('dispose', this.onDispose);
    }
    let t = e.byKind.get(kind);
    if (!t) e.byKind.set(kind, (t = this.createThermal(orig as AnyMaterial, kind)));
    t.visible = orig.visible;
    t.opacity = orig.opacity;
    return t;
  }

  private readonly onDispose = (ev: { target: THREE.Material }) => {
    const orig = ev.target;
    const e = this.cache.get(orig);
    if (e) for (const m of e.byKind.values()) m.dispose();
    this.cache.delete(orig);
    orig.removeEventListener('dispose', this.onDispose);
  };

  private createThermal(orig: AnyMaterial, kind: Exclude<ThermalKind, 'body' | 'hide'>): THREE.Material {
    const t = orig.clone() as AnyMaterial;
    t.fog = false;
    t.toneMapped = false;
    // defines копирует не всякий материал (у рельефа они свои) — берём те же.
    if (orig.defines) t.defines = orig.defines;
    const code = KIND_CODE[kind];
    const basic = orig.isMeshBasicMaterial === true;
    const baseKey = orig.customProgramCacheKey();
    t.onBeforeCompile = (shader, renderer) => {
      // Сначала правки исходного материала (качание деревьев, рельеф, вода), потом свои.
      orig.onBeforeCompile(shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader =
        'varying vec3 vThermalView;\n' + shader.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n  vThermalView = mvPosition.xyz;');
      shader.fragmentShader = `#define THERMAL_KIND ${code}\n${THERMAL_HEAD}${shader.fragmentShader.replace(/\}\s*$/, `${thermalTail(basic)}}\n`)}`;
    };
    t.customProgramCacheKey = () => `${baseKey}|thermal${code}${basic ? 'b' : ''}`;
    return t;
  }
}
