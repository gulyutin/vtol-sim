import * as THREE from 'three';
import { ATMOSPHERE_GLSL, dawnGlow, SUN_E, twilight, type AtmosphereState } from './atmosphere';

/*
 * Небо — модель рассеяния из atmosphere.ts: синий зенит, светлый горизонт, ореол вокруг Солнца,
 * тёплая заря и сумерки, звёзды ночью. Те же формулы дают дымку над рельефом, поэтому горы
 * уходят в горизонт без шва. Ниже горизонта — цвет дымки у земли. Купол проходит ту же тональную
 * кривую, что и рельеф.
 */

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform vec3 sunDir;
uniform vec3 sunLight;
uniform vec3 sunDisc;
uniform vec3 ground;
uniform float twilight;
uniform float dawn;
uniform float night;
uniform float overcast;
varying vec3 vDir;

vec3 sky(vec3 d) {
  float y = max(d.y, 0.0);
  float m = min(ATMO_SKY_AIRMASS_MAX, atmoAirmass(y));
  float mu = dot(d, sunDir);
  vec3 tR = ATMO_BR * ATMO_HR;
  float tM = ATMO_BM * ATMO_HM;
  vec3 col = sunLight * (tR * atmoPhaseR(mu) + tM * atmoPhaseM(mu, ATMO_G)) / (tR + tM) * (1.0 - exp(-(tR + tM) * m));
  col += vec3(0.28, 0.4, 0.75) * twilight * (1.0 - 0.5 * y);
  vec2 hz = d.xz / max(length(d.xz), 1e-4);
  vec2 sz = sunDir.xz / max(length(sunDir.xz), 1e-4);
  col += vec3(1.0, 0.42, 0.18) * dawn * pow(max(dot(hz, sz), 0.0), 4.0) * exp(-y * 9.0);
  return col + ATMO_NIGHT;
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = sky(d);
  // Ниже горизонта — дымка над землёй: купол виден только там, где рельефа нет.
  col = mix(col, ground, smoothstep(0.0, 0.08, -d.y));
  if (night > 0.01 && d.y > 0.0) {
    vec3 q = floor(d * 420.0);
    float r = fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float star = step(0.9982, r) * (0.35 + 0.65 * fract(r * 7919.0));
    col += vec3(0.9, 0.93, 1.0) * star * night * smoothstep(0.02, 0.25, d.y) * 0.25;
  }
  // Диск Солнца ярче единицы — его подхватывает свечение.
  col += sunDisc * smoothstep(0.99985, 0.99995, dot(d, sunDir)) * (1.0 - overcast);
  // Пасмурно: небо сереет и тускнеет.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l, l, l * 1.04), overcast * 0.85) * (1.0 - 0.3 * overcast);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SkyDome {
  /** Купол вокруг камеры — рисуется первым, без глубины. */
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** Тот же купол для карты отражений (кубическая камера в начале координат, дальность 100 м). */
  readonly envMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly uniforms = {
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunLight: { value: new THREE.Vector3(1, 1, 1) },
    sunDisc: { value: new THREE.Vector3(1, 1, 1) },
    ground: { value: new THREE.Vector3(0.5, 0.55, 0.6) },
    twilight: { value: 0 },
    dawn: { value: 0 },
    night: { value: 0 },
    overcast: { value: 0 },
  };

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), material);
    this.mesh.renderOrder = -1e9;
    this.mesh.frustumCulled = false;
    this.envMesh = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), material);
  }

  /** Небо по положению Солнца (atmosphereFor); ground — дымка над землёй ниже горизонта. */
  setSun(dir: THREE.Vector3, elDeg: number, a: AtmosphereState, ground: THREE.Vector3, overcast: number) {
    const u = this.uniforms;
    u.sunDir.value.copy(dir);
    u.sunLight.value.copy(a.sunLight);
    // Диск ярче неба на порядок — хватает для свечения; ярче — ореол свечения заливает полкадра.
    u.sunDisc.value.copy(a.transmittance).multiplyScalar(SUN_E * 0.5);
    u.ground.value.copy(ground);
    u.twilight.value = twilight(elDeg) * SUN_E * 0.012;
    u.dawn.value = dawnGlow(elDeg) * SUN_E * 0.05;
    u.night.value = a.night;
    u.overcast.value = overcast;
  }

  /** Купол всегда вокруг камеры. */
  follow(camera: THREE.Vector3) {
    this.mesh.position.copy(camera);
  }
}
