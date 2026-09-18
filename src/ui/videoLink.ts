import * as THREE from 'three';

/*
 * Видео с подвеса через радиолинию, как на НСУ: кадр идёт с задержкой, при слабом сигнале кодек
 * снижает разрешение, картинка рассыпается на блоки, потерянные блоки подменяются кусками прошлого
 * кадра, видео подтормаживает; без связи кадр замирает. Кадр окна камеры уже нарисован на холсте
 * (renderPip, renderThermal) — отсюда он копируется в кольцо кадров видеоканала и рисуется обратно
 * испорченным и с задержкой.
 */

/** Состояние видеоканала: связь (radio.ts LinkState) и нет ли её вовсе. */
export interface VideoLinkState {
  lost: boolean;
  /** Сила сигнала 0…1. */
  quality: number;
  /** Потери пакетов 0…1. */
  loss: number;
}

/** Частота кадров видеоканала, Гц: столько кадров в секунду передаёт борт. */
const VIDEO_HZ = 25;
/** Наибольшее разрешение видеоканала (как у бортового кодека 720p), пиксели. */
const VIDEO_MAX_W = 1280;
const VIDEO_MAX_H = 720;
/** Кадров в кольце: на наибольшую задержку. */
const RING = 28;

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Уменьшение кадра холста до разрешения видеоканала. */
const COPY_FRAG = /* glsl */ `uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

/** Кадр на экран: пониженное разрешение, блоки, подмена потерянных блоков, квантование, замирание. */
const SHOW_FRAG = /* glsl */ `
uniform sampler2D tCur;
uniform sampler2D tPrev;
uniform vec2 uRes;
uniform float uArt;
uniform float uPix;
uniform float uSeed;
uniform float uFreeze;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 px = vUv * uRes;
  float s = max(1.0, uPix);
  vec2 q = (floor(px / s) + 0.5) * s / uRes;
  vec3 c = texture2D(tCur, q).rgb;
  // Макроблоки 16 пикселей: при сильном сжатии остаются почти одни средние цвета блоков.
  vec2 blk = floor(px / 16.0);
  vec3 dc = texture2D(tCur, (blk + 0.5) * 16.0 / uRes).rgb;
  float flatten = smoothstep(0.15, 0.9, uArt) * step(0.35, hash(blk + uSeed));
  c = mix(c, mix(c, dc, 0.7), flatten);
  // Потерянные блоки — из прошлого кадра со сдвигом (так кодек скрывает ошибки).
  float drop = step(1.0 - 0.3 * uArt * uArt, hash(blk * 1.7 + uSeed * 3.1));
  vec2 shift = vec2(hash(blk + 5.0) - 0.5, hash(blk + 9.0) - 0.5) * 24.0 / uRes;
  c = mix(c, texture2D(tPrev, q + shift).rgb, drop);
  // Меньше бит — грубее цвета.
  float levels = mix(96.0, 14.0, uArt);
  c = floor(c * levels + 0.5) / levels;
  c *= 1.0 - 0.3 * uFreeze;
  gl_FragColor = vec4(c, 1.0);
}`;

interface Slot {
  target: THREE.WebGLRenderTarget;
  t: number;
}

export class VideoLink {
  private readonly scratch = new THREE.FramebufferTexture(4, 4);
  private readonly ring: Slot[] = [];
  private head = -1;
  private lastStoreT = -Infinity;
  private shown: Slot | null = null;
  private prev: Slot | null = null;
  private seed = 0;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly showMat: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  private readonly pos = new THREE.Vector2();
  private videoW = 0;
  private videoH = 0;
  /** Кадр замер: связи нет — показывается последний пришедший. */
  frozen = false;
  /** Задержка видео сейчас, с. */
  latencyS = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.scratch.colorSpace = THREE.NoColorSpace;
    this.copyMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY_FRAG, uniforms: { tSrc: { value: this.scratch } }, depthTest: false, depthWrite: false });
    this.showMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: SHOW_FRAG,
      uniforms: {
        tCur: { value: null },
        tPrev: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uArt: { value: 0 },
        uPix: { value: 1 },
        uSeed: { value: 0 },
        uFreeze: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /**
   * Звать сразу после того, как кадр окна камеры нарисован на холсте в rect (CSS-пиксели от правого
   * нижнего угла, как у renderPip): кадр уходит в видеоканал, на его место — то, что пришло на НСУ.
   */
  present(rect: { right: number; bottom: number; width: number; height: number }, link: VideoLinkState, t: number) {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    r.getSize(this.size);
    const x = this.size.x - rect.right - rect.width;
    const pw = Math.max(4, Math.floor(rect.width * pr));
    const ph = Math.max(4, Math.floor(rect.height * pr));
    this.resize(pw, ph);
    // Задержка: кодирование и эфир ~0,15 с, на слабом сигнале — повторы и буфер до ~0,8 с.
    const weak = 1 - link.quality;
    this.latencyS = 0.15 + 0.45 * weak * weak + 0.35 * link.loss;
    this.frozen = link.lost;
    // Кадр видеоканала — VIDEO_HZ раз в секунду, пока связь есть.
    if (!link.lost && t - this.lastStoreT >= 1 / VIDEO_HZ) {
      this.lastStoreT = t;
      this.pos.set(Math.floor(x * pr), Math.floor(rect.bottom * pr));
      r.copyFramebufferToTexture(this.scratch, this.pos);
      this.head = (this.head + 1) % RING;
      const slot = this.ring[this.head]!;
      slot.t = t;
      this.blit(this.copyMat, slot.target, null);
    }
    // Что пришло: новейший кадр старше задержки. Потери — видео подтормаживает (кадр держится).
    if (!link.lost) {
      const due = this.pick(t - this.latencyS);
      const stall = Math.random() < 0.9 * Math.pow(link.loss, 1.5);
      if (due && due !== this.shown && !stall) {
        this.prev = this.shown ?? due;
        this.shown = due;
        this.seed = (this.seed + 1) % 97;
      }
    }
    if (!this.shown) return;
    const u = this.showMat.uniforms;
    u['tCur']!.value = this.shown.target.texture;
    u['tPrev']!.value = (this.prev ?? this.shown).target.texture;
    (u['uRes']!.value as THREE.Vector2).set(this.videoW, this.videoH);
    // Сжатие: чем слабее сигнал и больше потерь, тем меньше бит — ниже разрешение, крупнее блоки.
    const art = Math.min(1, Math.max(0, (0.7 - link.quality) / 0.55) + 1.2 * link.loss);
    u['uArt']!.value = link.lost ? Math.max(0.3, art) : art;
    u['uPix']!.value = 1 + 3 * art * art;
    u['uSeed']!.value = this.seed;
    u['uFreeze']!.value = link.lost ? 1 : 0;
    this.blit(this.showMat, null, { x, y: rect.bottom, w: rect.width, h: rect.height });
  }

  /** Новый полёт или окно спрятано: кольцо — пустое, замирать нечему. */
  reset() {
    this.shown = null;
    this.prev = null;
    this.head = -1;
    this.lastStoreT = -Infinity;
    for (const s of this.ring) s.t = -Infinity;
  }

  dispose() {
    for (const s of this.ring) s.target.dispose();
    this.scratch.dispose();
    this.copyMat.dispose();
    this.showMat.dispose();
  }

  private pick(before: number): Slot | null {
    let best: Slot | null = null;
    for (const s of this.ring) if (s.t <= before && (!best || s.t > best.t)) best = s;
    return best;
  }

  /** Размер кадра холста и видеоканала; кольцо пересоздаётся при смене размера. */
  private resize(pw: number, ph: number) {
    if (this.scratch.image.width !== pw || this.scratch.image.height !== ph) {
      this.scratch.image.width = pw;
      this.scratch.image.height = ph;
      this.scratch.needsUpdate = true;
      this.scratch.dispose();
    }
    const k = Math.min(1, VIDEO_MAX_W / pw, VIDEO_MAX_H / ph);
    const vw = Math.max(4, Math.round(pw * k));
    const vh = Math.max(4, Math.round(ph * k));
    if (vw === this.videoW && vh === this.videoH && this.ring.length) return;
    this.videoW = vw;
    this.videoH = vh;
    for (const s of this.ring) s.target.dispose();
    this.ring.length = 0;
    for (let i = 0; i < RING; i++) {
      const target = new THREE.WebGLRenderTarget(vw, vh, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      target.texture.colorSpace = THREE.NoColorSpace;
      this.ring.push({ target, t: -Infinity });
    }
    this.reset();
  }

  /** Полноэкранный четырёхугольник материалом m — в цель или на холст в прямоугольник (CSS-пиксели). */
  private blit(m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, rect: { x: number; y: number; w: number; h: number } | null) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevTone = r.toneMapping;
    this.quad.material = m;
    r.autoClear = false;
    r.toneMapping = THREE.NoToneMapping;
    try {
      r.setRenderTarget(target);
      if (rect) {
        r.setScissorTest(true);
        r.setViewport(rect.x, rect.y, rect.w, rect.h);
        r.setScissor(rect.x, rect.y, rect.w, rect.h);
      }
      r.render(this.scene, this.camera);
    } finally {
      if (rect) {
        r.setScissorTest(false);
        r.setViewport(0, 0, this.size.x, this.size.y);
      }
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAuto;
      r.toneMapping = prevTone;
    }
  }
}

/** Что пишет борт поверх видео: полётные данные, подвес, точка в центре кадра, связь. */
export interface OsdData {
  channel: string;
  mode: string;
  flightS: number;
  aglM: number;
  altM: number;
  speedMs: number;
  headingDeg: number;
  panDeg: number;
  tiltDeg: number;
  zoom: number;
  /** Точка рельефа в центре кадра; null — центр в небе. */
  center: { lat: number; lon: number } | null;
  linkQuality: number;
  latencyS: number;
  frozen: boolean;
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');
const fmtT = (s: number) => `${pad2(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}`;

/**
 * Служебная информация поверх видео с подвеса, как её вшивает борт: по углам — время записи и
 * режим, связь и задержка, высота, скорость и курс, углы подвеса, зум и координаты центра кадра.
 * Без связи — «НЕТ ВИДЕО» поверх замершего кадра.
 */
export class VideoOsd {
  private readonly el: HTMLDivElement;
  private readonly tl: HTMLDivElement;
  private readonly tr: HTMLDivElement;
  private readonly bl: HTMLDivElement;
  private readonly br: HTMLDivElement;
  private readonly lost: HTMLDivElement;

  constructor(pip: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'osd';
    this.el.hidden = true;
    const part = (cls: string) => {
      const d = document.createElement('div');
      d.className = cls;
      this.el.appendChild(d);
      return d;
    };
    this.tl = part('osd-tl');
    this.tr = part('osd-tr');
    this.bl = part('osd-bl');
    this.br = part('osd-br');
    this.lost = part('osd-lost');
    this.lost.textContent = 'НЕТ ВИДЕО';
    pip.appendChild(this.el);
  }

  update(d: OsdData | null) {
    this.el.hidden = !d;
    if (!d) return;
    const bars = '▂▄▆█'.slice(0, Math.max(0, Math.min(4, Math.ceil(d.linkQuality * 4))));
    this.tl.textContent = `● ЗАП ${fmtT(d.flightS)}\n${d.channel} · ${d.mode}`;
    this.tr.textContent = `СВЯЗЬ ${Math.round(d.linkQuality * 100)}% ${bars}\nЗАДЕРЖКА ${Math.round(d.latencyS * 1000)} мс`;
    this.bl.textContent = `H ${Math.round(d.aglM)} м (${Math.round(d.altM)} абс)\nV ${d.speedMs.toFixed(1)} м/с  К ${String(Math.round(d.headingDeg) % 360).padStart(3, '0')}°`;
    const c = d.center ? `${d.center.lat.toFixed(5)}° ${d.center.lon.toFixed(5)}°` : '—';
    this.br.textContent = `АЗ ${d.panDeg >= 0 ? '+' : ''}${Math.round(d.panDeg)}°  УМ ${Math.round(d.tiltDeg)}°  ×${d.zoom.toFixed(1)}\nЦЕНТР ${c}`;
    this.lost.hidden = !d.frozen;
  }
}
