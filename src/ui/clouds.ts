import * as THREE from 'three';
import { fogUniforms } from './atmosphere';

/*
 * Объёмные облака: слой между базой и вершиной, по лучу из камеры — проход с шагом, плотность
 * из покрытия (та же функция шума, что у теней облаков на рельефе, — тени совпадают с облаками),
 * профиля по высоте (плоское дно, круглые вершины) и мелкого объёмного шума по краям. Свет:
 * самозатенение короткими шагами к Солнцу, ореол на просвет (рассеяние вперёд), рассеянный
 * свет неба сверху и отражённый от земли снизу. Даль уходит в ту же дымку, что и рельеф.
 *
 * Рисуется внутренними гранями большого бокса вокруг камеры: из-под слоя видна его вершина,
 * над слоем — основание, внутри — всё вокруг. Рельеф перед облаками закрывает их по глубине.
 * Тепловизору облака не видны (World.thermalKinds прячет этот меш).
 */

/** Размер бокса вокруг камеры по горизонтали, м. */
const LAYER_SIZE_M = 100_000;

export const CLOUD_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const CLOUD_FRAGMENT = /* glsl */ `
uniform vec2 offset;
uniform float cover;
uniform float base;
uniform float thickness;
uniform float fadeFar;
uniform float density;
uniform vec3 sunDir;
uniform vec3 sunLight;
uniform vec3 skyTop;
uniform vec3 skyBottom;
uniform vec3 fogColor;
uniform vec4 fogExtR;
uniform vec4 fogSun;
uniform vec4 fogSunView;
varying vec3 vWorld;

float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), u.x), mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), u.x), u.y); }
float cFbm4(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * cNoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
float cHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float cNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(cHash3(i), cHash3(i + vec3(1, 0, 0)), u.x);
  float b = mix(cHash3(i + vec3(0, 1, 0)), cHash3(i + vec3(1, 1, 0)), u.x);
  float c = mix(cHash3(i + vec3(0, 0, 1)), cHash3(i + vec3(1, 0, 1)), u.x);
  float d = mix(cHash3(i + vec3(0, 1, 1)), cHash3(i + vec3(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

/** Покрытие в точке — та же функция, что у теней облаков на рельефе (terrainLod.ts). */
float coverageAt(vec2 xz) {
  return smoothstep(1.0 - cover, 1.0 - cover + 0.22, cFbm4((xz + offset) / 2600.0));
}

float densityAt(vec3 p, float detail) {
  float h = (p.y - base) / thickness;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float c = coverageAt(p.xz);
  if (c < 0.01) return 0.0;
  // Где покрытие гуще — облако выше; дно плоское, вершина скруглена.
  float top = mix(0.3, 1.0, c);
  float prof = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(top * 0.55, top, h));
  float d = c * prof;
  if (detail > 0.5 && d > 0.0) {
    vec3 q = vec3(p.x + offset.x, p.y, p.z + offset.y) * 0.0045;
    float n = 0.65 * cNoise3(q) + 0.35 * cNoise3(q * 2.7 + 5.1);
    d -= (1.0 - n) * 0.42 * (1.0 - 0.4 * h);
  }
  return max(d, 0.0) * density;
}

float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1e-4, 1.0 + g2 - 2.0 * g * mu), 1.5)); }

/** Дымка между камерой и облаком — те же формулы, что у рельефа (atmosphere.ts). */
vec3 haze(vec3 col, float y0, float y1, float dist, float mu) {
  float H = fogExtR.w;
  float k = (clamp(y1, -1000.0, 30000.0) - clamp(y0, -1000.0, 30000.0)) / H;
  float e0 = exp(-clamp(y0, -1000.0, 30000.0) / H);
  float shape = abs(k) > 1e-3 ? e0 * (1.0 - exp(-k)) / k : e0;
  vec3 T = exp(-(fogExtR.rgb + vec3(fogSun.w * shape)) * dist);
  float g = fogSunView.w;
  vec3 beta = fogExtR.rgb + vec3(fogSun.w);
  vec3 inl = fogColor + fogSun.rgb * (fogExtR.rgb * 0.0597 * (1.0 + mu * mu) + vec3(fogSun.w * hg(mu, g))) / beta;
  return inl + (col - inl) * T;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  float y0 = base, y1 = base + thickness;
  float tA, tB;
  if (abs(rd.y) < 1e-5) {
    if (ro.y < y0 || ro.y > y1) discard;
    tA = 0.0; tB = fadeFar;
  } else {
    float ta = (y0 - ro.y) / rd.y, tb = (y1 - ro.y) / rd.y;
    tA = max(min(ta, tb), 0.0);
    tB = min(max(ta, tb), fadeFar);
  }
  if (tB <= tA) discard;
  // Шаг — по длине пути в слое, но не мельче 25 м; начало шага сдвинуто на случайную долю —
  // вместо полос лёгкий шум.
  float len = tB - tA;
  float stepLen = max(len / float(STEPS), 25.0);
  // Чередующийся градиентный шум (Хименес): зерно мельче и ровнее белого шума.
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = tA + stepLen * ign;
  float mu = dot(rd, sunDir);
  // В облаке свет рассеивается многократно: к ореолу на просвет добавляется ровная доля во все стороны.
  float phase = 0.08 + mix(hg(mu, 0.6), hg(mu, -0.2), 0.3);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float tSum = 0.0, wSum = 0.0;
  const float EXTINCTION = 0.018;
  for (int i = 0; i < STEPS; i++) {
    if (t > tB || T < 0.03) break;
    vec3 p = ro + rd * t;
    float d = densityAt(p, 1.0);
    if (d > 0.0) {
      float od = 0.0;
      for (int j = 1; j <= LIGHT_STEPS; j++) od += densityAt(p + sunDir * (110.0 * float(j)), 0.0);
      // Многократное рассеяние смягчает тень внутри облака: часть света проходит, как сквозь тонкий слой.
      float lightT = 0.7 * exp(-od * 110.0 * EXTINCTION) + 0.3 * exp(-od * 110.0 * EXTINCTION * 0.25);
      float powder = 1.0 - exp(-d * 60.0 * EXTINCTION);
      float h = clamp((p.y - base) / thickness, 0.0, 1.0);
      vec3 S = sunLight * lightT * phase * mix(0.6, 1.0, powder) + mix(skyBottom, skyTop, h);
      float Ts = exp(-d * EXTINCTION * stepLen);
      L += T * (1.0 - Ts) * S;
      tSum += t * T * (1.0 - Ts);
      wSum += T * (1.0 - Ts);
      T *= Ts;
    }
    t += stepLen;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.004) discard;
  vec3 col = L / alpha;
  float tm = wSum > 0.0 ? tSum / wSum : tA;
  col = haze(col, ro.y, ro.y + rd.y * tm, tm, mu);
  alpha *= 1.0 - smoothstep(fadeFar * 0.55, fadeFar, tm);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export type CloudLayer = THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;

/** Качество: шагов по лучу и самозатенения. */
export function setCloudSteps(layer: CloudLayer, [steps, light]: [number, number]) {
  const d = layer.material.defines as Record<string, number>;
  if (d['STEPS'] === steps && d['LIGHT_STEPS'] === light) return;
  d['STEPS'] = steps;
  d['LIGHT_STEPS'] = light;
  layer.material.needsUpdate = true;
}

/**
 * Слой по погоде: база, покрытие, дальность. Сплошная облачность — слой ниже и тоньше
 * (слоистые), разорванная — кучевые потолще.
 */
export function setCloudWeather(layer: CloudLayer, o: { baseM?: number; cover?: number; fadeFarM: number }) {
  const u = layer.material.uniforms;
  if (o.cover !== undefined) u['cover']!.value = o.cover;
  if (o.baseM !== undefined) {
    layer.position.y = o.baseM;
    u['base']!.value = o.baseM;
  }
  const cover = u['cover']!.value as number;
  const thickness = cover > 0.8 ? 500 : 700 + 500 * Math.min(1, cover / 0.6);
  u['thickness']!.value = thickness;
  layer.scale.y = thickness;
  u['density']!.value = cover > 0.8 ? 1.4 : 1;
  u['fadeFar']!.value = o.fadeFarM;
}

/** Свет для облаков: Солнце за атмосферой, небо сверху и отражённый землёй свет снизу. */
export function setCloudLight(layer: CloudLayer, sunDir: THREE.Vector3, sun: THREE.Vector3, skyTop: THREE.Vector3, skyBottom: THREE.Vector3) {
  const u = layer.material.uniforms;
  (u['sunDir']!.value as THREE.Vector3).copy(sunDir);
  (u['sunLight']!.value as THREE.Vector3).copy(sun);
  (u['skyTop']!.value as THREE.Vector3).copy(skyTop);
  (u['skyBottom']!.value as THREE.Vector3).copy(skyBottom);
}

/**
 * Слой облаков: position.y — база, униформы cover/offset/fadeFar — как у прежней плоскости
 * (их же берёт рельеф для теней); fogColor — цвет дымки сцены (тот же объект).
 */
export function createCloudLayer(o: { baseM: number; cover: number; offset: THREE.Vector2; fogColor: THREE.Color }): CloudLayer {
  // Бокс от 0 до 1 по высоте: масштаб по y — толщина слоя, положение — база.
  const geo = new THREE.BoxGeometry(LAYER_SIZE_M, 1, LAYER_SIZE_M).translate(0, 0.5, 0);
  const material = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    defines: { STEPS: 32, LIGHT_STEPS: 2 },
    uniforms: {
      offset: { value: o.offset },
      cover: { value: o.cover },
      base: { value: o.baseM },
      thickness: { value: 900 },
      fadeFar: { value: 40_000 },
      density: { value: 1 },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunLight: { value: new THREE.Vector3(3, 3, 3) },
      skyTop: { value: new THREE.Vector3(0.5, 0.6, 0.8) },
      skyBottom: { value: new THREE.Vector3(0.25, 0.25, 0.25) },
      fogColor: { value: o.fogColor },
      fogExtR: fogUniforms.fogExtR,
      fogSun: fogUniforms.fogSun,
      fogSunView: fogUniforms.fogSunView,
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'clouds';
  mesh.frustumCulled = false;
  mesh.position.y = o.baseM;
  mesh.scale.y = 900;
  return mesh;
}
