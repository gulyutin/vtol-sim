import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * Погода, которую видно издалека: грозовое облако (башня с тёмным основанием и наковальней) со
 * стеной ливня и молниями, вал облаков вдоль холодного фронта, радуга напротив Солнца, когда за
 * спиной у зрителя Солнце, а впереди дождь. Опасная погода — из weatherEvent.ts (WeatherHazard),
 * здесь только вид. Молния даёт вспышку — World подсвечивает сцену на доли секунды.
 */

export type FxHazard =
  | { kind: 'front'; a: { east: number; north: number }; b: { east: number; north: number }; moveDeg: number }
  | { kind: 'storm'; center: { east: number; north: number }; coreM: number; strength: number };

const RAD = Math.PI / 180;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Гладкий шум по направлению: одинаковый у совпадающих вершин — поверхность без трещин. */
function bumps(v: THREE.Vector3, seed: number): number {
  const n = v.clone().normalize();
  return (
    0.5 * Math.sin(n.x * 5.1 + seed) * Math.sin(n.y * 4.3 + seed * 1.7) * Math.sin(n.z * 4.7 + seed * 0.3) +
    0.3 * Math.sin(n.x * 11.3 + seed * 2.1) * Math.sin(n.y * 9.7) * Math.sin(n.z * 10.9 + seed) +
    0.2 * Math.sin(n.x * 23.0 + seed) * Math.sin(n.y * 21.0 + seed * 0.7) * Math.sin(n.z * 19.0)
  );
}

/** Клуб облака: гладкая сфера с «цветной капустой» по шуму; цвет вершин — светлее сверху, темнее снизу. */
function puff(r: () => number, radius: number): THREE.BufferGeometry {
  const seed = r() * 100;
  const g = mergeVertices(new THREE.IcosahedronGeometry(radius, 3).deleteAttribute('normal').deleteAttribute('uv'));
  const p = g.attributes['position']!;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const k = 1 + 0.22 * bumps(v, seed);
    v.multiplyScalar(k);
    // Снизу облако плоское: основание ровнее.
    if (v.y < -radius * 0.35) v.y = -radius * 0.35 - (v.y + radius * 0.35) * 0.25;
    p.setXYZ(i, v.x, v.y, v.z);
    const h = (v.y / radius + 1) / 2;
    const c = 0.22 + 0.72 * Math.pow(h, 1.1);
    col[i * 3] = c;
    col[i * 3 + 1] = c * 1.01;
    col[i * 3 + 2] = c * 1.05;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Грозовое облако высотой topM от base: башня из клубов, наверху — наковальня по ветру. */
function cumulonimbus(seed: number, baseM: number, radiusM: number, material: THREE.Material): THREE.Group {
  const r = mulberry32(seed);
  const g = new THREE.Group();
  const top = baseM + 9000;
  // Башня: внизу широкая (4–6 клубов вразброс), к верху уже; клубы разного размера и сдвинуты
  // вбок — не столб, а нагромождение кучевых башен.
  for (let y = baseM + radiusM * 0.35; y < top - 1500; y += radiusM * (0.45 + 0.25 * r())) {
    const f = (y - baseM) / (top - baseM);
    const spread = radiusM * (1.5 - 0.9 * f);
    const n = f < 0.3 ? 6 : f < 0.6 ? 4 : 3;
    for (let k = 0; k < n; k++) {
      const rr = radiusM * (0.55 + 0.5 * r()) * (1 - 0.3 * f);
      const m = new THREE.Mesh(puff(r, rr), material);
      const a = r() * Math.PI * 2;
      const d = spread * Math.sqrt(r());
      m.position.set(Math.cos(a) * d, y + (r() - 0.5) * rr * 0.5, Math.sin(a) * d);
      m.scale.set(1 + 0.3 * r(), 0.8 + 0.3 * r(), 1 + 0.3 * r());
      g.add(m);
    }
  }
  // Наковальня: широкая плоская шапка.
  for (let k = 0; k < 7; k++) {
    const m = new THREE.Mesh(puff(r, radiusM * 1.1), material);
    const a = (k / 7) * Math.PI * 2;
    m.position.set(Math.cos(a) * radiusM * 1.6, top - 600, Math.sin(a) * radiusM * 1.6);
    m.scale.set(1.3, 0.35, 1.3);
    g.add(m);
  }
  return g;
}

const RAIN_VERT = /* glsl */ `varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
/** Стена ливня: серая завеса, плотнее к середине и к основанию облака, с полосами, что опускаются. */
const RAIN_FRAG = /* glsl */ `uniform float uTime; uniform float uOpacity; uniform vec3 uColor; varying vec2 vUv; varying vec3 vW; varying vec3 vN;
float h(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
void main() {
  float streak = 0.75 + 0.25 * h(floor(vUv.x * 240.0) + floor(vUv.y * 6.0 + uTime * 0.8));
  float edge = smoothstep(0.0, 0.25, vUv.y) * (0.6 + 0.4 * vUv.y);
  // К краям завесы — прозрачнее: скользящий взгляд сквозь тонкий край.
  float face = smoothstep(0.0, 0.7, abs(dot(normalize(vN), normalize(cameraPosition - vW))));
  float a = uOpacity * edge * streak * face;
  gl_FragColor = vec4(uColor, a);
}`;

export class WeatherFx {
  readonly group = new THREE.Group();
  private readonly cloudMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
  /** Вал фронта — тяжёлые серые облака. */
  private readonly shelfMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true, color: 0x8d949c });
  private storm: THREE.Group | null = null;
  private rain: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial> | null = null;
  private frontBand: THREE.Group | null = null;
  private frontKey = '';
  private readonly bolt: THREE.Line;
  private boltLeft = 0;
  private nextBolt = 3;
  private readonly rng = mulberry32(7);
  private readonly rainbow: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private time = 0;
  /** Вспышка молнии 0…1 — на этот кадр (World добавляет к свету). */
  flash = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'weather-fx';
    scene.add(this.group);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 24), 3));
    this.bolt = new THREE.Line(bg, new THREE.LineBasicMaterial({ color: new THREE.Color(4, 4, 5), toneMapped: false, transparent: true }));
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    this.group.add(this.bolt);
    // Радуга: кольцо 42° вокруг точки против Солнца, цвета — по радиусу, края прозрачные.
    this.rainbow = new THREE.Mesh(
      new THREE.RingGeometry(0.955, 1.045, 128, 1, 0, Math.PI),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uOpacity: { value: 0 } },
        vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform float uOpacity; varying vec3 vP;
          vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
          // Снаружи — красный, внутри — фиолетовый, как у первичной радуги.
          void main() { float t = (length(vP.xy) - 0.955) / 0.09; float a = smoothstep(0.0, 0.15, t) * smoothstep(1.0, 0.85, t);
            gl_FragColor = vec4(hue((1.0 - t) * 0.8) * a * uOpacity, 1.0); }`,
      }),
    );
    this.rainbow.visible = false;
    this.rainbow.frustumCulled = false;
    this.rainbow.renderOrder = -1;
    this.group.add(this.rainbow);
  }

  /**
   * Кадр: hazard — опасная погода сейчас (локальные метры, сцена: x — восток, z — −север);
   * cloudBaseY — основание облаков; ground — высота рельефа; rainbow — насколько видна радуга 0…1.
   */
  update(dt: number, camera: THREE.Camera, hazard: FxHazard | null, cloudBaseY: number, ground: (e: number, n: number) => number, sunDir: THREE.Vector3, rainbow: number) {
    this.time += dt;
    this.flash = 0;
    this.updateStorm(dt, hazard?.kind === 'storm' ? hazard : null, cloudBaseY, ground, camera);
    this.updateFront(hazard?.kind === 'front' ? hazard : null, cloudBaseY);
    this.updateRainbow(camera, sunDir, rainbow);
  }

  private updateStorm(dt: number, h: Extract<FxHazard, { kind: 'storm' }> | null, baseY: number, ground: (e: number, n: number) => number, camera: THREE.Camera) {
    if (!h) {
      if (this.storm) {
        this.group.remove(this.storm);
        this.storm = null;
      }
      if (this.rain) this.rain.visible = false;
      this.bolt.visible = false;
      return;
    }
    const base = Math.max(400, baseY * 0.6);
    if (!this.storm) {
      this.storm = cumulonimbus(11, 0, h.coreM * 1.1, this.cloudMat);
      this.group.add(this.storm);
    }
    const gy = ground(h.center.east, h.center.north);
    this.storm.position.set(h.center.east, gy + base, -h.center.north);
    const s = 0.4 + 0.6 * h.strength;
    this.storm.scale.set(s, s, s);
    // Стена ливня от земли до основания облака.
    if (!this.rain) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.55 }, uColor: { value: new THREE.Color(0.42, 0.45, 0.5) } },
        vertexShader: RAIN_VERT,
        fragmentShader: RAIN_FRAG,
      });
      this.rain = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.15, 1, 48, 1, true).translate(0, 0.5, 0), mat);
      this.rain.frustumCulled = false;
      this.group.add(this.rain);
    }
    this.rain.visible = true;
    this.rain.position.set(h.center.east, gy - 20, -h.center.north);
    this.rain.scale.set(h.coreM * 0.8, base + 40, h.coreM * 0.8);
    this.rain.material.uniforms['uTime']!.value = this.time;
    this.rain.material.uniforms['uOpacity']!.value = 0.55 * h.strength;
    // Молнии: раз в несколько секунд, ярче — ближе.
    this.boltLeft -= dt;
    this.nextBolt -= dt;
    if (this.nextBolt <= 0 && h.strength > 0.5) {
      this.nextBolt = 2 + this.rng() * 8;
      this.boltLeft = 0.18;
      const p = this.bolt.geometry.attributes['position'] as THREE.BufferAttribute;
      const a = this.rng() * Math.PI * 2;
      const d = this.rng() * h.coreM * 0.6;
      let x = h.center.east + Math.cos(a) * d;
      let z = -h.center.north + Math.sin(a) * d;
      const y0 = gy + base;
      const y1 = ground(x, -z);
      for (let i = 0; i < 24; i++) {
        const f = i / 23;
        x += (this.rng() - 0.5) * 120;
        z += (this.rng() - 0.5) * 120;
        p.setXYZ(i, x, y0 + (y1 - y0) * f, z);
      }
      p.needsUpdate = true;
    }
    this.bolt.visible = this.boltLeft > 0;
    if (this.boltLeft > 0) {
      const dist = camera.position.distanceTo(new THREE.Vector3(h.center.east, gy + base / 2, -h.center.north));
      this.flash = Math.min(1, 6000 / Math.max(dist, 1500)) * (this.boltLeft / 0.18);
    }
  }

  private updateFront(h: Extract<FxHazard, { kind: 'front' }> | null, baseY: number) {
    if (!h) {
      if (this.frontBand) {
        this.group.remove(this.frontBand);
        this.frontBand = null;
      }
      return;
    }
    // Вал облаков вдоль линии фронта — один раз построить, дальше двигать целиком.
    const key = `${h.moveDeg.toFixed(1)}`;
    if (!this.frontBand || key !== this.frontKey) {
      if (this.frontBand) this.group.remove(this.frontBand);
      const r = mulberry32(5);
      const g = new THREE.Group();
      const len = Math.hypot(h.b.east - h.a.east, h.b.north - h.a.north);
      for (let s = -len / 2; s <= len / 2; s += 1400) {
        const m = new THREE.Mesh(puff(r, 900 + 500 * r()), this.shelfMat);
        m.position.set(s, 300 * r(), (r() - 0.5) * 800);
        m.scale.set(1.3, 0.55, 1);
        g.add(m);
      }
      this.frontBand = g;
      this.frontKey = key;
      this.group.add(g);
    }
    const c = { east: (h.a.east + h.b.east) / 2, north: (h.a.north + h.b.north) / 2 };
    this.frontBand.position.set(c.east, Math.max(350, baseY * 0.45), -c.north);
    // Ось вала (локальная x) — вдоль линии фронта, поперёк движения: (−cos, 0, −sin) курса в сцене.
    this.frontBand.rotation.y = Math.PI - h.moveDeg * RAD;
  }

  private updateRainbow(camera: THREE.Camera, sunDir: THREE.Vector3, amount: number) {
    const on = amount > 0.02 && sunDir.y > 0.05 && sunDir.y < Math.sin(40 * RAD);
    this.rainbow.visible = on;
    if (!on) return;
    // Центр — точка против Солнца; радиус 42°: кольцо на расстоянии D с радиусом D·tg 42°.
    const D = 4000;
    const anti = sunDir.clone().negate();
    const R = D * Math.tan(42 * RAD);
    this.rainbow.position.copy(camera.position).addScaledVector(anti, D);
    this.rainbow.scale.setScalar(R);
    // Лицом к зрителю, верх кольца — вверх: видна дуга над горизонтом.
    this.rainbow.lookAt(camera.position);
    this.rainbow.material.uniforms['uOpacity']!.value = 0.35 * amount;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
