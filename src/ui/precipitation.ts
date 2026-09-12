import * as THREE from 'three';
import type { Weather } from '../sim/types';

export { fogFor, overcastFactor } from '../game/weather';

/*
 * Осадки вокруг камеры: дождь — штрихи, вытянутые по скорости падения, снег — плывущие хлопья,
 * мокрый снег — вперемешку. Один экземплярный меш — один вызов отрисовки. Положения считает
 * вершинный шейдер: каждая частица — в кубе вокруг камеры, сдвинутая на пройденный путь (ветер +
 * падение) и «завёрнутая» по модулю куба. Поэтому частицы стоят в мире, а не едут с камерой, и на
 * CPU за кадр — только несколько uniform'ов, без выделения памяти.
 */

/** Ребро большого куба, м; малый (1/3) — густая завеса у самой камеры. Малый делит большой нацело — один сдвиг на оба. */
const BOX = 72;
const NEAR_SHARE = 0.5;

const VERTEX = /* glsl */ `
attribute vec3 aSeed;
attribute vec3 aRand;
uniform vec3 uOffset[2];
uniform vec3 uRainDir;
uniform float uBox;
uniform float uSnowShare;
uniform float uRainLen;
uniform float uRainWidth;
uniform float uFlakeSize;
uniform float uTime;
uniform float uViewH;
uniform float uAlpha;
uniform vec3 ambientLightColor;
#if NUM_DIR_LIGHTS > 0
struct DirectionalLight { vec3 direction; vec3 color; };
uniform DirectionalLight directionalLights[NUM_DIR_LIGHTS];
#endif
#if NUM_HEMI_LIGHTS > 0
struct HemisphereLight { vec3 direction; vec3 skyColor; vec3 groundColor; };
uniform HemisphereLight hemisphereLights[NUM_HEMI_LIGHTS];
#endif
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vSnow;
#include <fog_pars_vertex>
void main() {
  float snow = aRand.x < uSnowShare ? 1.0 : 0.0;
  float b = aRand.y < ${NEAR_SHARE.toFixed(2)} ? uBox / 3.0 : uBox;
  // Смещение от камеры, м: сдвиг (снос + падение − камера) приходит с CPU уже по модулю куба.
  vec3 local = mod(aSeed * b + (snow > 0.5 ? uOffset[1] : uOffset[0]), b) - 0.5 * b;
  // Хлопья покачиваются.
  float ph = aRand.z * 40.0;
  local.xz += snow * 0.35 * vec2(sin(uTime * (0.6 + aRand.z) + ph), cos(uTime * (0.5 + 0.8 * aRand.z) + ph * 1.3));
  // Камера — начало видовых координат, поэтому хватает поворота: без больших мировых чисел во float.
  mat3 view = mat3(viewMatrix);
  vec3 c = view * local;
  float dist = max(length(c), 1e-3);
  // Метров в пикселе на этом расстоянии.
  float px = 2.0 * dist / (projectionMatrix[1][1] * uViewH);
  float a;
  vec3 p;
  if (snow > 0.5) {
    float s = uFlakeSize * (0.6 + 0.8 * aRand.z);
    float sd = max(s, 1.5 * px);
    a = (s / sd) * (s / sd);
    p = c + vec3(position.x * 0.5, position.y - 0.5, 0.0) * sd;
  } else {
    vec3 dir = normalize(view * uRainDir);
    vec3 across = cross(dir, c / dist);
    float al = length(across);
    // Смотрим точно вдоль струй — штрих вырождается в точку, ширину берём по экрану.
    across = al > 1e-4 ? across / al : vec3(1.0, 0.0, 0.0);
    float w = uRainWidth * (0.7 + 0.6 * aRand.z);
    // Тоньше пикселя не рисуем — мерцало бы; вместо этого бледнее.
    float wd = max(w, 1.2 * px);
    a = w / wd;
    p = c + dir * (uRainLen * (0.7 + 0.6 * aRand.z) * (position.y - 0.5)) + across * (wd * 0.5 * position.x);
  }
  // У края куба частица гаснет — шов «заворачивания» не виден; вплотную к камере — тоже.
  float r = length(local);
  a *= uAlpha * (1.0 - smoothstep(0.30 * b, 0.48 * b, r)) * smoothstep(0.4, 1.5, dist);
  vec3 irr = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) irr += mix(hemisphereLights[i].groundColor, hemisphereLights[i].skyColor, 0.7);
  #endif
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) irr += directionalLights[i].color * 0.5;
  #endif
  // Вода почти прозрачна и светлее фона только за счёт отражённого неба; снег — белый рассеиватель.
  vColor = irr * mix(0.42, 0.85, snow);
  vAlpha = a;
  vSnow = snow;
  vUv = vec2(position.x, position.y * 2.0 - 1.0);
  vec4 mvPosition = vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (a < 0.003) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vSnow;
#include <fog_pars_fragment>
void main() {
  float a;
  if (vSnow > 0.5) {
    a = 1.0 - smoothstep(0.35, 1.0, length(vUv));
  } else {
    // Поперёк — мягкий край, вдоль — сужение к обоим концам штриха.
    a = (1.0 - abs(vUv.x)) * (1.0 - smoothstep(0.6, 1.0, abs(vUv.y)));
  }
  a *= vAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Вид осадков → параметры: скорость падения, м/с; доля хлопьев; размеры, м; непрозрачность; насыщение по интенсивности, мм/ч. */
interface Look {
  rainFallMs: number;
  snowFallMs: number;
  snowShare: number;
  rainWidthM: number;
  rainLenS: number;
  flakeM: number;
  alpha: number;
  fullMmPerH: number;
}
const LOOKS: Record<NonNullable<Weather['precipitation']>['kind'], Look> = {
  drizzle: { rainFallMs: 2.5, snowFallMs: 1, snowShare: 0, rainWidthM: 0.004, rainLenS: 0.1, flakeM: 0.01, alpha: 0.45, fullMmPerH: 1 },
  rain: { rainFallMs: 7, snowFallMs: 1, snowShare: 0, rainWidthM: 0.009, rainLenS: 0.1, flakeM: 0.01, alpha: 0.55, fullMmPerH: 10 },
  sleet: { rainFallMs: 5, snowFallMs: 1.8, snowShare: 0.5, rainWidthM: 0.008, rainLenS: 0.09, flakeM: 0.022, alpha: 0.6, fullMmPerH: 5 },
  snow: { rainFallMs: 5, snowFallMs: 1.1, snowShare: 1, rainWidthM: 0.008, rainLenS: 0.1, flakeM: 0.03, alpha: 0.85, fullMmPerH: 3 },
};

export class Precipitation {
  readonly object: THREE.Object3D;
  private readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;
  private readonly u: {
    uOffset: { value: THREE.Vector3[] };
    uRainDir: { value: THREE.Vector3 };
    uBox: { value: number };
    uSnowShare: { value: number };
    uRainLen: { value: number };
    uRainWidth: { value: number };
    uFlakeSize: { value: number };
    uTime: { value: number };
    uViewH: { value: number };
    uAlpha: { value: number };
  };
  private max = 0;
  /** Доля пула, которая сейчас идёт, 0…1. */
  private density = 0;
  /** Скорости частиц в сцене (дождевые, снежные), м/с, и пройденный путь по модулю BOX — в double на CPU. */
  private readonly vel = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly drift = [0, 0, 0, 0, 0, 0];
  private time = 0;

  constructor(maxParticles: number) {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      {
        uOffset: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        uRainDir: { value: new THREE.Vector3(0, -1, 0) },
        uBox: { value: BOX },
        uSnowShare: { value: 0 },
        uRainLen: { value: 0.7 },
        uRainWidth: { value: 0.009 },
        uFlakeSize: { value: 0.03 },
        uTime: { value: 0 },
        uViewH: { value: 800 },
        uAlpha: { value: 0.5 },
      },
    ]);
    this.u = uniforms as unknown as Precipitation['u'];
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Ось «поперёк» штриха — cross(направление, луч взгляда): при падении вниз четырёхугольник зеркален.
      side: THREE.DoubleSide,
      lights: true,
      fog: true,
    });
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.material);
    this.mesh.name = 'precipitation';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // Прозрачное — после облаков пыли и прочего, чтобы капли у камеры были поверх.
    this.mesh.renderOrder = 10;
    const viewport = new THREE.Vector4();
    // Куб — вокруг той камеры, что рисует сейчас (главный вид, окно камеры): сдвиг и размер пикселя — по ней.
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(viewport);
      this.u.uViewH.value = viewport.w;
      this.place(camera);
      this.material.uniformsNeedUpdate = true;
    };
    this.object = this.mesh;
    this.setMax(maxParticles);
  }

  /** Осадки (null — сухо) и ветер на высоте камеры в сцене: x — на восток, y — на юг (−север), м/с. */
  setWeather(p: Weather['precipitation'], windScene: THREE.Vector2) {
    if (!p || !(p.mmPerH > 0)) {
      this.density = 0;
      this.mesh.visible = false;
      return;
    }
    const look = LOOKS[p.kind];
    // Сильнее осадки — гуще, но не пропорционально: плотность капель растёт медленнее интенсивности.
    const k = Math.min(1, Math.sqrt(p.mmPerH / look.fullMmPerH));
    this.density = 0.2 + 0.8 * k;
    // Ливень — капли крупнее и падают быстрее.
    const rainFall = look.rainFallMs + (p.kind === 'rain' ? 1.5 * k : 0);
    this.vel[0]!.set(windScene.x, -rainFall, windScene.y);
    this.vel[1]!.set(windScene.x, -look.snowFallMs, windScene.y);
    const u = this.u;
    u.uRainDir.value.copy(this.vel[0]!).normalize();
    u.uSnowShare.value = look.snowShare;
    u.uRainLen.value = this.vel[0]!.length() * look.rainLenS;
    u.uRainWidth.value = look.rainWidthM * (1 + 0.3 * k);
    u.uFlakeSize.value = look.flakeM * (0.8 + 0.4 * k);
    u.uAlpha.value = look.alpha * (0.7 + 0.3 * k);
    this.applyCount();
    this.mesh.visible = this.max > 0;
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.mesh.visible || !(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    for (let k = 0; k < 2; k++) {
      const v = this.vel[k]!;
      const d = this.drift;
      d[3 * k] = (d[3 * k]! + v.x * dt) % BOX;
      d[3 * k + 1] = (d[3 * k + 1]! + v.y * dt) % BOX;
      d[3 * k + 2] = (d[3 * k + 2]! + v.z * dt) % BOX;
    }
    this.time = (this.time + dt) % 3600;
    this.u.uTime.value = this.time;
    this.place(camera);
  }

  setMax(maxParticles: number) {
    const n = Math.max(0, Math.floor(maxParticles));
    if (n === this.max) return;
    this.max = n;
    // Новая геометрия, старая — с буферами на GPU — освобождается целиком.
    const old = this.mesh.geometry;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const seed = new Float32Array(n * 3);
    const rand = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      seed[i] = Math.random();
      rand[i] = Math.random();
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
    g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 3));
    this.mesh.geometry = g;
    old.dispose();
    this.applyCount();
    if (n === 0) this.mesh.visible = false;
    else if (this.density > 0) this.mesh.visible = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private applyCount() {
    // Случайные seed'ы равномерны, поэтому любая голова пула — та же смесь видов и кубов.
    this.mesh.geometry.instanceCount = Math.round(this.max * this.density);
  }

  /** Сдвиги для камеры: (путь − камера + BOX/2) по модулю BOX, в double — потом во float уже малые числа. */
  private place(camera: THREE.Camera) {
    const e = camera.matrixWorld.elements;
    const d = this.drift;
    for (let k = 0; k < 2; k++) {
      const j = 3 * k;
      this.u.uOffset.value[k]!.set(wrap(d[j]! - e[12]!), wrap(d[j + 1]! - e[13]!), wrap(d[j + 2]! - e[14]!));
    }
  }
}

function wrap(x: number): number {
  const m = (x + BOX / 2) % BOX;
  return m < 0 ? m + BOX : m;
}
