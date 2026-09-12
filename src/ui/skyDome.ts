import * as THREE from 'three';

/*
 * Небо: градиент от горизонта к зениту, диск Солнца и ореол. Цвета заданы явно (днём —
 * голубой зенит и светлый горизонт, на закате — тёплый горизонт, ночью — тёмный), поэтому небо
 * не выгорает в белое, как модель рассеяния на ярком дне. Проходит ту же тональную кривую,
 * что и рельеф, — цвет горизонта годится для дымки.
 */

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(h, 0.45));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  // Диск Солнца ярче единицы — его подхватывает свечение; вокруг — ореол.
  col += sunColor * (smoothstep(0.99985, 0.99995, s) * 12.0 + pow(s, 200.0) * 0.6 + pow(s, 10.0) * 0.18);
  // У горизонта со стороны Солнца светлее и теплее.
  col += sunColor * horizon * pow(1.0 - h, 6.0) * s * s * 0.25;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const C = (hex: number) => new THREE.Color(hex);
const ZENITH = { day: C(0x3a78c9), sunset: C(0x2c4d80), night: C(0x070e1c) };
const HORIZON = { day: C(0xbcd6f0), sunset: C(0xf2b27e), night: C(0x1b2535) };

export class SkyDome {
  /** Купол вокруг камеры — рисуется первым, без глубины. */
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** Тот же купол для карты отражений (кубическая камера в начале координат, дальность 100 м). */
  readonly envMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly uniforms = {
    zenith: { value: ZENITH.day.clone() },
    horizon: { value: HORIZON.day.clone() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color(1, 1, 1) },
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

  /**
   * Цвета по положению Солнца: day 0…1 — день, warm 0…1 — насколько низко и тепло.
   * Возвращает цвет горизонта (линейный) — для дымки.
   */
  setSun(dir: THREE.Vector3, day: number, warm: number): THREE.Color {
    const u = this.uniforms;
    u.sunDir.value.copy(dir);
    u.zenith.value.copy(ZENITH.day).lerp(ZENITH.sunset, warm * 0.8).lerp(ZENITH.night, 1 - day);
    u.horizon.value.copy(HORIZON.day).lerp(HORIZON.sunset, warm).lerp(HORIZON.night, 1 - day);
    u.sunColor.value.setRGB(1, 0.95 - 0.3 * warm, 0.85 - 0.5 * warm).multiplyScalar(day);
    return u.horizon.value;
  }

  /** Купол всегда вокруг камеры. */
  follow(camera: THREE.Vector3) {
    this.mesh.position.copy(camera);
  }
}
