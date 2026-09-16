import * as THREE from 'three';
import { plumeHeight, plumeRise, type FireFlame, type FirePlume } from '../game/fire';

/*
 * Дым лесных пожаров и пламя на кромке (src/game/fire.ts). Дым — облако частиц: над очагом они
 * поднимаются, замедляясь, и их сносит ветром той высоты, где они оказались, — получается наклонный
 * столб, видный за километры. Пламя — короткие яркие частицы на горящей кромке.
 * В тепловом кадре ни то, ни другое не рисуется (ThermalView прячет Points): длинноволновый ИК
 * видит сквозь дым, и оператор находит очаг именно тепловизором.
 * Сцена: x — восток, y — вверх, z — минус север.
 */

const TAU = Math.PI * 2;
/** Частиц дыма в секунду на единицу силы очага. */
const SMOKE_RATE = 12;
/** Сколько живёт частица дыма, с: дольше — шлейф тянется на километры и теряет форму столба. */
const SMOKE_LIFE_S: [number, number] = [130, 240];
/** За сколько секунд частица разгоняется до ветра своей высоты. */
const SMOKE_RELAX_S = 6;
/** Частиц пламени в секунду на метр размера огня. */
const FLAME_RATE = 5;

function sprite(size: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Мягкий клуб: плотная середина и рваный край. */
function smokeSprite(): THREE.CanvasTexture {
  return sprite(128, (g) => {
    const blob = (x: number, y: number, r: number, a: number) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,255,255,${a})`);
      gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.4})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    };
    blob(64, 64, 60, 0.75);
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 12; i++) {
      const a = rnd() * TAU;
      const d = 10 + rnd() * 26;
      blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 14 + rnd() * 20, 0.16 + rnd() * 0.16);
    }
  });
}

/** Язык пламени: яркая середина. */
function flameSprite(): THREE.CanvasTexture {
  return sprite(64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  });
}

const LIGHT_HEAD = /* glsl */ `uniform vec3 ambientLightColor;
#if NUM_DIR_LIGHTS > 0
struct DirectionalLight { vec3 direction; vec3 color; };
uniform DirectionalLight directionalLights[NUM_DIR_LIGHTS];
#endif
#if NUM_SUN_LIGHTS > 0
struct SunLight { vec3 direction; vec3 color; };
uniform SunLight sunLights[NUM_SUN_LIGHTS];
#endif
#if NUM_HEMI_LIGHTS > 0
struct HemisphereLight { vec3 direction; vec3 skyColor; vec3 groundColor; };
uniform HemisphereLight hemisphereLights[NUM_HEMI_LIGHTS];
#endif`;

const SMOKE_VERTEX = /* glsl */ `attribute vec3 aPos;
attribute float aSize;
attribute float aAlpha;
attribute float aShade;
uniform vec3 uYoung;
uniform vec3 uOld;
${LIGHT_HEAD}
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  // Клуб — квадрат, всегда развёрнутый к камере: у точечных спрайтов размер ограничен драйвером,
  // а огромная точка пропадает целиком, едва её середина уйдёт за край кадра.
  vec4 mvPosition = modelViewMatrix * vec4(aPos, 1.0);
  mvPosition.xy += position.xy * aSize;
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  float dist = max(-mvPosition.z, 0.05);
  vec3 irr = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) irr += mix(hemisphereLights[i].groundColor, hemisphereLights[i].skyColor, 0.7);
  #endif
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) irr += directionalLights[i].color * 0.5;
  #endif
  #if NUM_SUN_LIGHTS > 0
  for (int i = 0; i < NUM_SUN_LIGHTS; i++) irr += sunLights[i].color * 0.5;
  #endif
  // Молодой дым у огня тёмный и бурый, дальше по столбу светлеет.
  vec3 albedo = mix(uYoung, uOld, aShade);
  // Вплотную к камере частица гаснет — пролёт сквозь дым не заливает кадр.
  vColor = vec4(albedo * irr * 0.45, aAlpha * smoothstep(4.0, 45.0, dist));
  if (aAlpha <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  #include <fog_vertex>
}`;

const SMOKE_FRAGMENT = /* glsl */ `uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, vUv).a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const FLAME_VERTEX = /* glsl */ `attribute vec3 aPos;
attribute float aSize;
attribute float aAlpha;
attribute float aHot;
uniform vec3 uHot;
uniform vec3 uCool;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(aPos, 1.0);
  // Издалека язык пламени мельче пикселя — держим ему видимый минимум по дальности.
  mvPosition.xy += position.xy * max(aSize, -mvPosition.z * 0.004);
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  float dist = max(-mvPosition.z, 0.05);
  // Издалека отдельные языки не разглядеть — там виден дым, а не искры.
  vColor = vec4(mix(uCool, uHot, aHot), aAlpha * smoothstep(5000.0, 1500.0, dist));
  if (aAlpha <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FLAME_FRAGMENT = /* glsl */ `uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float a = texture2D(uMap, vUv).a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * a, a);
}`;

interface FlameSource extends FireFlame {
  /** Высота земли под кромкой в сцене, м. */
  y: number;
}

interface PlumeSource extends FirePlume {
  /** Высота земли у очага в сцене, м. */
  baseY: number;
  rise: { w0: number; tauS: number };
  acc: number;
}

/** Ветер по высоте, посчитанный на кадр: сносить каждую частицу отдельным вызовом дорого. */
class WindTable {
  private static readonly H = [0, 25, 50, 100, 200, 350, 500, 700, 1000, 1400];
  private readonly east = new Float32Array(WindTable.H.length);
  private readonly north = new Float32Array(WindTable.H.length);

  set(windAt: (heightAglM: number) => { east: number; north: number }) {
    WindTable.H.forEach((h, i) => {
      const w = windAt(h);
      this.east[i] = w.east;
      this.north[i] = w.north;
    });
  }

  at(h: number, out: { east: number; north: number }) {
    const H = WindTable.H;
    let i = 1;
    while (i < H.length - 1 && h > H[i]!) i++;
    const k = Math.min(1, Math.max(0, (h - H[i - 1]!) / (H[i]! - H[i - 1]!)));
    out.east = this.east[i - 1]! + (this.east[i]! - this.east[i - 1]!) * k;
    out.north = this.north[i - 1]! + (this.north[i]! - this.north[i - 1]!) * k;
  }
}

/** Дым над очагами и пламя на кромке. */
export class FirePlumes {
  readonly object = new THREE.Group();
  private readonly smoke: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly flame: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly sources = new Map<string, PlumeSource>();
  private flames: FlameSource[] = [];
  private flameAcc = 0;
  private readonly wind = new WindTable();
  private readonly w = { east: 0, north: 0 };
  // Дым: положение, состояние и атрибуты.
  private readonly maxSmoke: number;
  private smokeCursor = 0;
  private readonly sPos: Float32Array;
  private readonly sSize: Float32Array;
  private readonly sAlpha: Float32Array;
  private readonly sShade: Float32Array;
  private readonly sAge: Float32Array;
  private readonly sLife: Float32Array;
  private readonly sW0: Float32Array;
  private readonly sTau: Float32Array;
  private readonly sBase: Float32Array;
  private readonly sS0: Float32Array;
  private readonly sS1: Float32Array;
  private readonly sA0: Float32Array;
  private readonly sVel: Float32Array;
  // Пламя.
  private readonly maxFlames: number;
  private flameCursor = 0;
  private readonly fPos: Float32Array;
  private readonly fSize: Float32Array;
  private readonly fAlpha: Float32Array;
  private readonly fHot: Float32Array;
  private readonly fAge: Float32Array;
  private readonly fLife: Float32Array;
  private readonly fS0: Float32Array;
  private readonly fRise: Float32Array;

  constructor(maxSmoke = 6000, maxFlames = 1200) {
    this.maxSmoke = maxSmoke;
    this.maxFlames = maxFlames;
    this.sPos = new Float32Array(maxSmoke * 3);
    this.sSize = new Float32Array(maxSmoke);
    this.sAlpha = new Float32Array(maxSmoke);
    this.sShade = new Float32Array(maxSmoke);
    this.sAge = new Float32Array(maxSmoke).fill(Infinity);
    this.sLife = new Float32Array(maxSmoke).fill(1);
    this.sW0 = new Float32Array(maxSmoke);
    this.sTau = new Float32Array(maxSmoke).fill(1);
    this.sBase = new Float32Array(maxSmoke);
    this.sS0 = new Float32Array(maxSmoke);
    this.sS1 = new Float32Array(maxSmoke);
    this.sA0 = new Float32Array(maxSmoke);
    this.sVel = new Float32Array(maxSmoke * 2);
    this.fPos = new Float32Array(maxFlames * 3);
    this.fSize = new Float32Array(maxFlames);
    this.fAlpha = new Float32Array(maxFlames);
    this.fHot = new Float32Array(maxFlames);
    this.fAge = new Float32Array(maxFlames).fill(Infinity);
    this.fLife = new Float32Array(maxFlames).fill(1);
    this.fS0 = new Float32Array(maxFlames);
    this.fRise = new Float32Array(maxFlames);

    const smokeUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      { uMap: { value: null }, uYoung: { value: new THREE.Color(0x5d554c) }, uOld: { value: new THREE.Color(0xc8ccd2) } },
    ]);
    smokeUniforms['uMap']!.value = smokeSprite();
    const smokeMat = new THREE.ShaderMaterial({
      uniforms: smokeUniforms,
      vertexShader: SMOKE_VERTEX,
      fragmentShader: SMOKE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      lights: true,
      fog: true,
    });
    this.smoke = new THREE.Mesh(this.geometry(this.sPos, this.sSize, this.sAlpha, 'aShade', this.sShade), smokeMat);
    this.smoke.name = 'fire-smoke';
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 8;

    const flameMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: flameSprite() }, uHot: { value: new THREE.Color(0xffd48a) }, uCool: { value: new THREE.Color(0xd23a10) } },
      vertexShader: FLAME_VERTEX,
      fragmentShader: FLAME_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.flame = new THREE.Mesh(this.geometry(this.fPos, this.fSize, this.fAlpha, 'aHot', this.fHot), flameMat);
    this.flame.name = 'fire-flames';
    this.flame.frustumCulled = false;
    this.flame.renderOrder = 9;

    this.object.name = 'fire';
    this.object.add(this.smoke, this.flame);
  }

  /** Очаги дыма и горящая кромка; groundAt — высота земли в сцене. */
  setSources(plumes: readonly FirePlume[], flames: readonly FireFlame[], groundAt: (east: number, north: number) => number) {
    const seen = new Set<string>();
    for (const p of plumes) {
      seen.add(p.key);
      const s = this.sources.get(p.key);
      const baseY = groundAt(p.east, p.north);
      if (s) Object.assign(s, p, { baseY, rise: plumeRise(p.strength) });
      else this.sources.set(p.key, { ...p, baseY, rise: plumeRise(p.strength), acc: 0 });
    }
    for (const key of [...this.sources.keys()]) if (!seen.has(key)) this.sources.delete(key);
    this.flames = flames.map((f) => ({ ...f, y: groundAt(f.east, f.north) }));
  }

  /** Дым идёт по времени полёта (dtSim), пламя мерцает по настоящему (dtReal). */
  update(dtSim: number, dtReal: number, windAt: (heightAglM: number) => { east: number; north: number }) {
    this.wind.set(windAt);
    this.stepSmoke(Math.max(0, Math.min(dtSim, 30)));
    this.stepFlames(Math.max(0, Math.min(dtReal, 0.2)));
  }

  /** Столбы уже стоят к началу полёта: прокрутить дым на seconds секунд вперёд. */
  prewarm(seconds: number, windAt: (heightAglM: number) => { east: number; north: number }, stepS = 4) {
    this.wind.set(windAt);
    for (let t = 0; t < seconds; t += stepS) this.stepSmoke(stepS);
  }

  dispose() {
    for (const p of [this.smoke, this.flame]) {
      p.geometry.dispose();
      const m = p.material as THREE.ShaderMaterial;
      (m.uniforms['uMap']!.value as THREE.Texture | null)?.dispose();
      m.dispose();
    }
  }

  /** Квадрат на каждую частицу: общие углы плюс место, размер и прозрачность — по экземплярам. */
  private geometry(pos: Float32Array, size: Float32Array, alpha: Float32Array, extraName: string, extra: Float32Array): THREE.InstancedBufferGeometry {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    g.setIndex(quad.getIndex());
    quad.dispose();
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    g.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alpha, 1));
    g.setAttribute(extraName, new THREE.InstancedBufferAttribute(extra, 1));
    g.instanceCount = size.length;
    return g;
  }

  private stepSmoke(dt: number) {
    if (dt > 0) {
      for (const s of this.sources) this.emit(s[1], dt);
      const relax = 1 - Math.exp(-dt / SMOKE_RELAX_S);
      const w = this.w;
      for (let i = 0; i < this.maxSmoke; i++) {
        const life = this.sLife[i]!;
        let age = this.sAge[i]!;
        if (age >= life) continue;
        age += dt;
        this.sAge[i] = age;
        if (age >= life) {
          this.sAlpha[i] = 0;
          this.sSize[i] = 0;
          continue;
        }
        const t = age / life;
        const j = i * 3;
        const h = plumeHeight({ w0: this.sW0[i]!, tauS: this.sTau[i]! }, age);
        this.wind.at(h, w);
        // Частица разгоняется до ветра своей высоты; лёгкая болтанка — столб не идеально прямой.
        const vx = this.sVel[i * 2]! + (w.east - this.sVel[i * 2]!) * relax + (Math.random() - 0.5) * 0.6 * dt;
        const vz = this.sVel[i * 2 + 1]! + (-w.north - this.sVel[i * 2 + 1]!) * relax + (Math.random() - 0.5) * 0.6 * dt;
        this.sVel[i * 2] = vx;
        this.sVel[i * 2 + 1] = vz;
        this.sPos[j] = this.sPos[j]! + vx * dt;
        this.sPos[j + 1] = this.sBase[i]! + h;
        this.sPos[j + 2] = this.sPos[j + 2]! + vz * dt;
        this.sSize[i] = this.sS0[i]! + (this.sS1[i]! - this.sS0[i]!) * Math.sqrt(t);
        this.sAlpha[i] = this.sA0[i]! * Math.min(1, t / 0.04) * (1 - t) ** 1.6;
        this.sShade[i] = Math.min(1, t * 3);
      }
    }
    const g = this.smoke.geometry;
    for (const k of ['aPos', 'aSize', 'aAlpha', 'aShade']) g.getAttribute(k).needsUpdate = true;
  }

  private emit(s: PlumeSource, dt: number) {
    s.acc += SMOKE_RATE * s.strength * dt;
    const n = Math.min(Math.floor(s.acc), this.maxSmoke);
    s.acc -= n;
    for (let k = 0; k < n; k++) {
      const i = this.smokeCursor;
      this.smokeCursor = (this.smokeCursor + 1) % this.maxSmoke;
      const a = Math.random() * TAU;
      const r = s.radiusM * 0.7 * Math.sqrt(Math.random());
      const j = i * 3;
      this.sPos[j] = s.east + Math.cos(a) * r;
      this.sPos[j + 1] = s.baseY + 2;
      this.sPos[j + 2] = -(s.north + Math.sin(a) * r);
      this.sVel[i * 2] = 0;
      this.sVel[i * 2 + 1] = 0;
      this.sAge[i] = 0;
      this.sLife[i] = SMOKE_LIFE_S[0] + (SMOKE_LIFE_S[1] - SMOKE_LIFE_S[0]) * Math.random();
      this.sW0[i] = s.rise.w0 * (0.85 + 0.3 * Math.random());
      this.sTau[i] = s.rise.tauS;
      this.sBase[i] = s.baseY + 2;
      this.sS0[i] = 4 + 7 * s.strength;
      this.sS1[i] = 30 + 80 * s.strength * (0.7 + 0.6 * Math.random());
      this.sA0[i] = (0.2 + 0.2 * Math.random()) * Math.min(1, 0.45 + s.strength);
      this.sShade[i] = 0;
      this.sSize[i] = this.sS0[i]!;
      this.sAlpha[i] = 0;
    }
  }

  private stepFlames(dt: number) {
    if (dt > 0 && this.flames.length) {
      const total = this.flames.reduce((a, f) => a + f.sizeM, 0);
      this.flameAcc += FLAME_RATE * total * dt;
      const n = Math.min(Math.floor(this.flameAcc), this.maxFlames);
      this.flameAcc -= n;
      for (let k = 0; k < n; k++) {
        const f = this.flames[Math.floor(Math.random() * this.flames.length)]!;
        const i = this.flameCursor;
        this.flameCursor = (this.flameCursor + 1) % this.maxFlames;
        const j = i * 3;
        const a = Math.random() * TAU;
        const r = f.sizeM * 0.45 * Math.sqrt(Math.random());
        this.fPos[j] = f.east + Math.cos(a) * r;
        this.fPos[j + 1] = f.y + 0.3;
        this.fPos[j + 2] = -(f.north + Math.sin(a) * r);
        this.fAge[i] = 0;
        this.fLife[i] = 0.45 + 0.75 * Math.random();
        this.fS0[i] = f.sizeM * (0.5 + 0.5 * Math.random());
        this.fRise[i] = 1.5 + 2.5 * Math.random();
        this.fSize[i] = this.fS0[i]!;
        this.fAlpha[i] = 0;
      }
    }
    for (let i = 0; i < this.maxFlames; i++) {
      const life = this.fLife[i]!;
      let age = this.fAge[i]!;
      if (age >= life) continue;
      age += dt;
      this.fAge[i] = age;
      if (age >= life) {
        this.fAlpha[i] = 0;
        this.fSize[i] = 0;
        continue;
      }
      const t = age / life;
      this.fPos[i * 3 + 1] = this.fPos[i * 3 + 1]! + this.fRise[i]! * dt;
      this.fSize[i] = this.fS0[i]! * (1 - 0.55 * t);
      this.fAlpha[i] = 0.85 * (1 - t) ** 1.2;
      // Язык гаснет от жёлтого к красному.
      this.fHot[i] = Math.max(0, 1 - 1.6 * t);
    }
    const g = this.flame.geometry;
    for (const k of ['aPos', 'aSize', 'aAlpha', 'aHot']) g.getAttribute(k).needsUpdate = true;
  }
}
