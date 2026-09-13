import { PRIORITY_RANK, type Callout, type CalloutPriority } from '../game/callouts';

/*
 * Голос НСУ. Фразы из записанной озвучки (public/voice/<голос>/index.json: текст → mp3) играются
 * через WebAudio; чего в записи нет — говорит синтез речи браузера (Web Speech API).
 * Очередь с приоритетами общая: важное перебивает менее важное, устаревшее выбрасывается,
 * одно и то же подряд не повторяется. По умолчанию — запись; из синтеза — лучший голос
 * (нейросетевые онлайн, затем улучшенные системные, компактные — в последнюю очередь).
 * Нет ни записи, ни русского голоса — тихо выключается: available = false, reason — почему.
 * Настройки — в localStorage.
 */

// Минимальные типы Web Speech API и WebAudio: модуль собирается и без DOM — для проверок в Node.
export interface SynthVoice {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default?: boolean;
}

export interface SynthUtterance {
  text: string;
  lang: string;
  voice: SynthVoice | null;
  volume: number;
  rate: number;
  pitch: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

export interface Synth {
  readonly speaking: boolean;
  readonly pending: boolean;
  speak(u: SynthUtterance): void;
  cancel(): void;
  getVoices(): SynthVoice[];
  addEventListener?(type: 'voiceschanged', cb: () => void): void;
  onvoiceschanged?: (() => void) | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Проигрыватель записанных фраз. По умолчанию — WebAudio; для проверок — поддельный. */
export interface ClipPlayer {
  /** Можно играть: аудиоконтекст создан по жесту пользователя. */
  readonly ready: boolean;
  /** Из обработчика жеста: создать и запустить аудиоконтекст. */
  unlock(): void;
  /** Загрузить и декодировать; keep — не вытеснять из кэша (критические фразы). */
  load(url: string, keep?: boolean): Promise<void>;
  loaded(url: string): boolean;
  /** Играть загруженное; onend — когда доиграло (после stop() не зовётся). */
  play(url: string, volume: number, onend: () => void): { stop(): void };
}

/** Манифест записанной озвучки (public/voice/<голос>/index.json). */
export interface VoicePackManifest {
  voice: string;
  /** Как голос называется в списке: «Ксения (запись)». */
  name: string;
  /** Текст фразы → файл в папке набора. */
  files: Record<string, string>;
  /** Критические фразы — загрузить при первом жесте пользователя. */
  preload: string[];
}

export type Platform = 'mac' | 'windows' | 'other';

export interface VoiceDeps {
  /** null — синтеза нет. По умолчанию — speechSynthesis браузера. */
  synth?: Synth | null;
  makeUtterance?: (text: string) => SynthUtterance;
  storage?: StorageLike | null;
  /** Реальное время, с. */
  now?: () => number;
  /** Для подсказки, где взять голос получше; по умолчанию — по userAgent. */
  platform?: Platform;
  /** Папка записанной озвучки (с index.json); null — без записей. По умолчанию — BASE_URL + voice/xenia/. */
  packUrl?: string | null;
  /** Загрузка манифеста; по умолчанию fetch. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Проигрыватель записей; по умолчанию WebAudio, если он есть. */
  clips?: ClipPlayer | null;
}

/** Темп и тон голоса: темп 0,5…2 (1 — обычный), тон 0,5…2. */
export interface VoiceTuning {
  rate: number;
  pitch: number;
}

export interface VoiceSettings {
  enabled: boolean;
  /** 0…1. */
  volume: number;
  /** Общий множитель темпа синтеза 0,5…2 поверх темпа голоса. */
  rate: number;
  /** Выбранный голос (запись — «rec:<голос>»); null — лучший из имеющихся, запись первой. */
  voiceURI: string | null;
  /** Свои темп и тон для голосов синтеза, по voiceURI. */
  perVoice: Record<string, Partial<VoiceTuning>>;
}

export type VoiceQuality = 'recorded' | 'neural' | 'enhanced' | 'standard' | 'compact';

export const VOICE_QUALITY_LABEL: Record<VoiceQuality, string> = {
  recorded: 'запись',
  neural: 'нейросетевой',
  enhanced: 'улучшенный',
  standard: 'обычный',
  compact: 'компактный',
};

/** Голос для выбора в интерфейсе. */
export interface VoiceOption {
  uri: string;
  name: string;
  lang: string;
  quality: VoiceQuality;
  qualityLabel: string;
  /** Работает без сети (запись или голос системы). */
  local: boolean;
  selected: boolean;
  /** Темп и тон, с которыми он звучит (с поправками пользователя); у записи — 1 и 1. */
  tuning: VoiceTuning;
}

export const VOICE_KEY = 'vtol-sim.voice';
const DEFAULTS: VoiceSettings = { enabled: true, volume: 1, rate: 1, voiceURI: null, perVoice: {} };

export const VOICE_NO_API = 'Браузер не поддерживает синтез речи';
export const VOICE_NO_RUSSIAN = 'В системе нет русского голоса — добавьте его в настройках речи системы';
export const VOICE_LOADING = 'Загружаю голоса…';
/** Пробная фраза синтеза — «Прослушать». */
export const VOICE_SAMPLE = 'Переход в самолётный режим. Заряд тридцать процентов.';
/** Пробная фраза записи — одна из записанных. */
export const REC_SAMPLE = 'Переход в самолётный режим';

/** Где взять голос получше, если есть только компактный. */
export const VOICE_UPGRADE_HINT: Record<Platform, string> = {
  mac:
    'Сейчас только компактный голос — он звучит механически. Естественнее: откройте тренажёр в Chrome (голос «Google русский») или в Edge (Svetlana, Dmitry). ' +
    'Или скачайте улучшенную «Милену»: Системные настройки → Универсальный доступ → Устный контент → Голос системы → Управление голосами… → Русский; после загрузки перезапустите браузер.',
  windows:
    'Сейчас только компактный голос. Естественные русские голоса Svetlana и Dmitry (Natural) есть в браузере Microsoft Edge — откройте тренажёр в нём. ' +
    'Или добавьте русский голос в Windows: Параметры → Время и язык → Речь.',
  other: 'Сейчас только компактный голос. Естественнее звучат нейросетевые голоса: «Google русский» в Chrome или Svetlana и Dmitry (Natural) в Microsoft Edge.',
};

/** Сокращения для синтеза — словами, как говорят операторы (в записи это уже учтено). */
const SYNTH_SPEECH: readonly (readonly [RegExp, string])[] = [
  [/ГНСС/g, 'гэ-эн-эс-эс'],
  [/ПДУ/g, 'пэ-дэ-у'],
  [/РЭБ/g, 'рэб'],
];
export const synthText = (text: string) => SYNTH_SPEECH.reduce((s, [re, w]) => s.replace(re, w), text);

/** Сколько сообщение ждёт в очереди, прежде чем устареть, с. */
const TTL_S: Record<CalloutPriority, number> = { critical: 12, warning: 8, info: 5 };
/** Пауза между фразами; перед информационной — длиннее, чтобы не тараторить. */
const GAP_S = 0.25;
const INFO_GAP_S = 0.8;
/** Та же фраза раньше этого — не повторять, с. */
const REPEAT_S = 4;
const MAX_QUEUE = 6;
/** Столько ждём голосов (в Chrome они приходят не сразу), потом — «нет русского голоса». */
const VOICES_WAIT_S = 3;
/** Звук держится приглушённым столько после фразы — чтобы не «качало» между фразами. */
const DUCK_HOLD_S = 0.6;
/** Декодированных записей в памяти, кроме критических. */
const MAX_CLIPS = 64;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const rank = (c: Callout) => PRIORITY_RANK[c.priority];

export const isRussian = (v: SynthVoice) => /^ru([-_]|$)/i.test(v.lang);

/**
 * Качество по имени и voiceURI. Нейросетевые: Microsoft … Online (Natural) в Edge, «Google русский»
 * в Chrome. Улучшенные: Enhanced / Premium / «улучшенный» (в Safari — …voice.enhanced… в voiceURI).
 * Компактные: системные Milena, Yuri, Katya без пометки качества, eSpeak.
 */
export function voiceQuality(v: SynthVoice): VoiceQuality {
  const n = v.name.toLowerCase();
  const uri = v.voiceURI.toLowerCase();
  if (/natural|neural|нейро|google/.test(n) || (/microsoft/.test(n) && /online/.test(n))) return 'neural';
  if (/enhanced|premium|улучш|премиум|высок/.test(n) || /\.(enhanced|premium)\./.test(uri)) return 'enhanced';
  if (/\.compact\./.test(uri) || /espeak|milena|милена|yuri|юрий|katya|катя/.test(n)) return 'compact';
  return 'standard';
}

const TIER: Record<VoiceQuality, number> = { recorded: 500, neural: 400, enhanced: 300, standard: 200, compact: 100 };

/** Порядок выбора голоса синтеза: сначала качество, внутри — известные удачные голоса. */
export function voiceScore(v: SynthVoice): number {
  const n = v.name.toLowerCase();
  const q = voiceQuality(v);
  let s = TIER[q];
  if (q === 'enhanced' && /premium|премиум/.test(`${n} ${v.voiceURI.toLowerCase()}`)) s += 20;
  if (/svetlana|светлана/.test(n)) s += 12;
  else if (/dmitry|дмитрий/.test(n)) s += 10;
  else if (/google/.test(n)) s += 8;
  else if (/dariya|дарья/.test(n)) s += 6;
  if (/^ru[-_]ru$/i.test(v.lang)) s += 2;
  if (v.localService) s += 1;
  return s;
}

/**
 * Темп и тон по голосу — чтобы звучало естественно. Нейросетевые и улучшенные хороши как есть;
 * компактный на обычном темпе частит и звучит механичнее — чуть медленнее.
 */
export function voiceTuning(v: SynthVoice | null): VoiceTuning {
  if (v && voiceQuality(v) === 'compact') return { rate: 0.95, pitch: 1 };
  return { rate: 1, pitch: 1 };
}

/** Голос синтеза: выбранный раньше, если он есть, иначе лучший русский; нет русских — null. */
export function pickVoice(voices: readonly SynthVoice[], preferredURI?: string | null): SynthVoice | null {
  const ru = voices.filter(isRussian);
  return ru.find((v) => v.voiceURI === preferredURI) ?? [...ru].sort((a, b) => voiceScore(b) - voiceScore(a))[0] ?? null;
}

/** Манифест из JSON: только текст → имя файла без путей. */
export function parseManifest(j: unknown): VoicePackManifest | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (!o.files || typeof o.files !== 'object') return null;
  const files: Record<string, string> = {};
  for (const [text, f] of Object.entries(o.files as Record<string, unknown>)) if (typeof f === 'string' && /^[\w.-]+$/.test(f)) files[text] = f;
  if (Object.keys(files).length === 0) return null;
  return {
    voice: typeof o.voice === 'string' && /^[\w-]+$/.test(o.voice) ? o.voice : 'pack',
    name: typeof o.name === 'string' ? o.name : 'Запись',
    files,
    preload: Array.isArray(o.preload) ? o.preload.filter((x): x is string => typeof x === 'string') : [],
  };
}

interface Item {
  c: Callout;
  until: number;
  started: number;
  kind?: 'synth' | 'clip';
  stop?: () => void;
}

// WebAudio — столько, сколько нужно проигрывателю.
interface ClipBuffer {
  readonly duration: number;
}
interface ClipNode {
  connect(n: unknown): unknown;
  disconnect(): void;
}
interface ClipGain extends ClipNode {
  gain: { value: number };
}
interface ClipSource extends ClipNode {
  buffer: ClipBuffer | null;
  onended: (() => void) | null;
  start(): void;
  stop(): void;
}
interface ClipContext {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<ClipBuffer>;
  createBufferSource(): ClipSource;
  createGain(): ClipGain;
}
type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

type Globals = {
  speechSynthesis?: Synth;
  SpeechSynthesisUtterance?: new (text: string) => SynthUtterance;
  localStorage?: StorageLike;
  performance?: { now(): number };
  navigator?: { userAgent?: string };
  AudioContext?: new () => ClipContext;
  webkitAudioContext?: new () => ClipContext;
  fetch?: Fetcher;
};
const G = globalThis as unknown as Globals;

/** Записи через WebAudio: скачиваем и декодируем один раз, играем без задержки, громкость — своя. */
export class WebAudioClips implements ClipPlayer {
  private ctx: ClipContext | null = null;
  private readonly buffers = new Map<string, ClipBuffer>();
  private readonly kept = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly Ctor: new () => ClipContext,
    private readonly fetcher: Fetcher,
  ) {}

  get ready(): boolean {
    return this.ctx !== null;
  }

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new this.Ctor();
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  loaded(url: string): boolean {
    return this.buffers.has(url);
  }

  load(url: string, keep = false): Promise<void> {
    if (keep) this.kept.add(url);
    if (this.buffers.has(url)) return Promise.resolve();
    const ctx = this.ctx;
    if (!ctx) return Promise.reject(new Error('Нет аудиоконтекста'));
    let p = this.pending.get(url);
    if (!p) {
      p = this.fetcher(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => {
          this.buffers.set(url, buf);
          this.evict();
        })
        .finally(() => this.pending.delete(url));
      this.pending.set(url, p);
    }
    return p;
  }

  play(url: string, volume: number, onend: () => void): { stop(): void } {
    const ctx = this.ctx;
    const buf = this.buffers.get(url);
    if (!ctx || !buf) throw new Error('Запись не загружена');
    // Недавно игравшие — в конец очереди на вытеснение.
    this.buffers.delete(url);
    this.buffers.set(url, buf);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    let done = false;
    const release = () => {
      done = true;
      src.onended = null;
      gain.disconnect();
    };
    src.onended = () => {
      if (done) return;
      release();
      onend();
    };
    src.start();
    return {
      stop: () => {
        if (done) return;
        release();
        try {
          src.stop();
        } catch {
          // уже остановлен
        }
      },
    };
  }

  private evict(): void {
    const free = [...this.buffers.keys()].filter((u) => !this.kept.has(u));
    for (let i = 0; i < free.length - MAX_CLIPS; i++) this.buffers.delete(free[i]!);
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return G.localStorage ?? null;
  } catch {
    return null;
  }
}

function detectPlatform(): Platform {
  const ua = G.navigator?.userAgent ?? '';
  if (/iPhone|iPad|iPod|Android/.test(ua)) return 'other';
  return /Macintosh|Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other';
}

/** Корень сайта (на GitHub Pages — /vtol-sim/). */
function baseUrl(): string {
  return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
}

const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, lo, hi) : d);

function cleanTuning(t: unknown): Partial<VoiceTuning> {
  const o = (t && typeof t === 'object' ? t : {}) as Partial<Record<keyof VoiceTuning, unknown>>;
  const r: Partial<VoiceTuning> = {};
  if (typeof o.rate === 'number' && Number.isFinite(o.rate)) r.rate = clamp(o.rate, 0.5, 2);
  if (typeof o.pitch === 'number' && Number.isFinite(o.pitch)) r.pitch = clamp(o.pitch, 0.5, 2);
  return r;
}

function loadSettings(storage: StorageLike | null): VoiceSettings {
  try {
    const raw = storage?.getItem(VOICE_KEY);
    if (!raw) return { ...DEFAULTS, perVoice: {} };
    const j = JSON.parse(raw) as Partial<Record<keyof VoiceSettings, unknown>>;
    const perVoice: Record<string, Partial<VoiceTuning>> = {};
    if (j.perVoice && typeof j.perVoice === 'object') for (const [uri, t] of Object.entries(j.perVoice)) perVoice[uri] = cleanTuning(t);
    return {
      enabled: typeof j.enabled === 'boolean' ? j.enabled : DEFAULTS.enabled,
      volume: num(j.volume, 0, 1, DEFAULTS.volume),
      rate: num(j.rate, 0.5, 2, DEFAULTS.rate),
      voiceURI: typeof j.voiceURI === 'string' ? j.voiceURI : null,
      perVoice,
    };
  } catch {
    return { ...DEFAULTS, perVoice: {} };
  }
}

export class Voice {
  /** Можно говорить: есть запись или русский голос синтеза. */
  available = false;
  /** Почему нельзя — для подсказки в интерфейсе; null — всё в порядке. */
  reason: string | null = VOICE_LOADING;
  /** Изменились голоса, доступность или настройки — перерисовать интерфейс. */
  onChange: (() => void) | null = null;
  /** Речь началась / кончилась — приглушить звук (Sound.duck). */
  onSpeaking: ((on: boolean) => void) | null = null;

  private readonly synth: Synth | null;
  private readonly make: ((text: string) => SynthUtterance) | null;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly platform: Platform;
  private readonly clips: ClipPlayer | null;
  private readonly createdAt: number;
  private cfg: VoiceSettings;
  private ru: SynthVoice[] = [];
  private voice: SynthVoice | null = null;
  private pack: { url: string; m: VoicePackManifest } | null = null;
  private packLoading = false;
  private queue: Item[] = [];
  private current: Item | null = null;
  private lastEnd = -Infinity;
  private readonly said = new Map<string, number>();
  private suspended = false;
  /** Браузер не дал говорить без жеста пользователя — ждём unlock(). */
  private blocked = false;
  private unlocked = false;
  private clipsUnlocked = false;
  private ducked = false;
  private waitedOut = false;

  constructor(deps: VoiceDeps = {}) {
    this.synth = deps.synth !== undefined ? deps.synth : (G.speechSynthesis ?? null);
    const Ctor = G.SpeechSynthesisUtterance;
    this.make = deps.makeUtterance ?? (Ctor ? (text: string) => new Ctor(text) : null);
    this.storage = deps.storage !== undefined ? deps.storage : defaultStorage();
    this.now = deps.now ?? (() => (G.performance?.now() ?? Date.now()) / 1000);
    this.platform = deps.platform ?? detectPlatform();
    const fetcher: Fetcher | null = G.fetch ? (url) => G.fetch!(url) : null;
    const AC = G.AudioContext ?? G.webkitAudioContext;
    this.clips = deps.clips !== undefined ? deps.clips : AC && fetcher ? new WebAudioClips(AC, fetcher) : null;
    const packUrl = deps.packUrl !== undefined ? deps.packUrl : `${baseUrl()}voice/xenia/`;
    const fetchJson = deps.fetchJson ?? (fetcher ? (url: string) => fetcher(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))) : null);
    this.createdAt = this.now();
    this.cfg = loadSettings(this.storage);
    const synth = this.synth;
    if (synth && this.make) {
      const cb = () => this.refresh();
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', cb);
      else if ('onvoiceschanged' in synth) synth.onvoiceschanged = cb;
    }
    if (this.clips && packUrl && fetchJson) this.loadPack(packUrl, fetchJson);
    this.refresh();
  }

  get settings(): Readonly<VoiceSettings> {
    return this.cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Записанная озвучка загружена. */
  get recordedReady(): boolean {
    return this.pack !== null;
  }

  /** Есть ли фраза в записи. */
  hasRecording(text: string): boolean {
    return !!this.pack?.m.files[text];
  }

  /** Имя голоса, которым говорим. */
  get voiceName(): string | null {
    return this.recSelected ? this.pack!.m.name : (this.voice?.name ?? null);
  }

  /** Качество голоса, которым говорим. */
  get quality(): VoiceQuality | null {
    return this.recSelected ? 'recorded' : this.voice ? voiceQuality(this.voice) : null;
  }

  /** Записи нет, а русские голоса синтеза все компактные — стоит показать upgradeHint. */
  get compactOnly(): boolean {
    return !this.pack && this.ru.length > 0 && this.ru.every((v) => voiceQuality(v) === 'compact');
  }

  /** Как поставить голос получше — если есть только компактный; иначе null. */
  get upgradeHint(): string | null {
    return this.compactOnly ? VOICE_UPGRADE_HINT[this.platform] : null;
  }

  /** Голоса для выбора в интерфейсе: запись первой, затем синтез — лучшие первыми. */
  voices(): VoiceOption[] {
    const list: VoiceOption[] = [];
    if (this.pack) {
      list.push({
        uri: this.recUri!,
        name: this.pack.m.name,
        lang: 'ru-RU',
        quality: 'recorded',
        qualityLabel: VOICE_QUALITY_LABEL.recorded,
        local: true,
        selected: this.recSelected,
        tuning: { rate: 1, pitch: 1 },
      });
    }
    const rec = this.recSelected;
    for (const v of [...this.ru].sort((a, b) => voiceScore(b) - voiceScore(a))) {
      const quality = voiceQuality(v);
      list.push({
        uri: v.voiceURI,
        name: v.name,
        lang: v.lang,
        quality,
        qualityLabel: VOICE_QUALITY_LABEL[quality],
        local: v.localService,
        selected: !rec && v === this.voice,
        tuning: this.tuningOf(v),
      });
    }
    return list;
  }

  setEnabled(on: boolean): void {
    this.cfg.enabled = on;
    if (!on) this.clear();
    this.save();
  }

  setVolume(v: number): void {
    this.cfg.volume = clamp(v, 0, 1);
    this.save();
  }

  /** Общий множитель темпа синтеза поверх темпа голоса. */
  setRate(r: number): void {
    this.cfg.rate = clamp(r, 0.5, 2);
    this.save();
  }

  /** uri из voices(); null — снова лучший из имеющихся (запись, если есть). */
  setVoice(uri: string | null): void {
    this.cfg.voiceURI = uri;
    this.save();
    this.refresh();
  }

  /** Свои темп и тон для голоса синтеза; null — как задумано для него. */
  setTuning(uri: string, t: Partial<VoiceTuning> | null): void {
    if (t === null) delete this.cfg.perVoice[uri];
    else this.cfg.perVoice[uri] = { ...this.cfg.perVoice[uri], ...cleanTuning(t) };
    this.save();
  }

  /**
   * «Прослушать»: пробная фраза голосом uri (по умолчанию — текущим) сразу, из обработчика щелчка.
   * У записи — записанная фраза (text, если она есть в записи, иначе REC_SAMPLE). Работает и при
   * выключенном голосе и на паузе; очередь не трогает. false — говорить нечем.
   */
  preview(uri: string | null = null, text?: string): boolean {
    const pack = this.pack;
    const rec = pack !== null && (uri === null ? this.recSelected : uri === this.recUri);
    if (rec && pack && this.clips) {
      const m = pack.m;
      const t = text !== undefined && m.files[text] ? text : m.files[REC_SAMPLE] ? REC_SAMPLE : Object.keys(m.files)[0]!;
      this.stopCurrent();
      this.unlockClips();
      this.blocked = false;
      const now = this.now();
      this.playClip({ c: { text: t, priority: 'critical', key: 'preview', t: 0 }, until: Infinity, started: now }, pack.url + m.files[t], now, false);
      return true;
    }
    const v = uri === null ? this.voice : (this.ru.find((x) => x.voiceURI === uri) ?? null);
    if (!v || !this.synth || !this.make) return false;
    this.stopCurrent();
    try {
      this.synth.cancel();
    } catch {
      // уже молчит
    }
    // Щелчок — жест пользователя: после него браузер разрешает речь.
    this.unlocked = true;
    this.blocked = false;
    const now = this.now();
    this.speak({ c: { text: text ?? VOICE_SAMPLE, priority: 'critical', key: 'preview', t: 0 }, until: Infinity, started: now }, now, v, false);
    return true;
  }

  /** Пауза, разбор: молчать и забыть очередь. */
  setSuspended(on: boolean): void {
    if (on === this.suspended) return;
    this.suspended = on;
    if (on) this.clear();
  }

  /** Из обработчика жеста (pointerdown/keydown): браузеры разрешают звук и речь только после него. */
  unlock(): void {
    this.blocked = false;
    this.unlockClips();
    if (this.unlocked || !this.synth || !this.make) return;
    this.unlocked = true;
    try {
      const u = this.make(' ');
      u.volume = 0;
      u.lang = 'ru-RU';
      this.synth.speak(u);
    } catch {
      // Не вышло — попробуем говорить как есть.
    }
  }

  /** В очередь. Одинаковый key вытесняет ждущее; важнее звучащего — перебивает его. */
  say(callouts: Callout | readonly Callout[]): void {
    const list: readonly Callout[] = Array.isArray(callouts) ? callouts : [callouts as Callout];
    for (const c of list) this.enqueue(c);
  }

  /** Раз в кадр: запустить следующую фразу, выбросить устаревшие, отследить зависшую речь. */
  update(): void {
    const now = this.now();
    if (!this.available && !this.waitedOut && this.synth && now - this.createdAt >= VOICES_WAIT_S) {
      this.waitedOut = true;
      this.refresh();
    }
    const cur = this.current;
    if (cur) {
      // В Chrome onend иногда не приходит: молчит дольше секунды или звучит дольше разумного — конец.
      const long = now - cur.started > 4 + (0.12 * cur.c.text.length) / this.cfg.rate;
      const silent = cur.kind !== 'clip' && this.synth !== null && !this.synth.speaking && !this.synth.pending && now - cur.started > 1.5;
      if (long) {
        this.stopCurrent();
        this.lastEnd = now;
      } else if (silent) this.finish(cur);
    }
    this.queue = this.queue.filter((i) => i.until > now);
    if (!this.current && !this.blocked && !this.suspended && this.queue.length > 0) {
      let best = this.queue[0]!;
      for (const i of this.queue) if (rank(i.c) < rank(best.c)) best = i;
      if (now - this.lastEnd >= (best.c.priority === 'info' ? INFO_GAP_S : GAP_S)) {
        this.queue = this.queue.filter((i) => i !== best);
        this.start(best, now);
      }
    }
    this.setDuck(this.current !== null || (this.queue.length > 0 && !this.blocked && !this.suspended) || now - this.lastEnd < DUCK_HOLD_S);
  }

  /** Замолчать и очистить очередь. */
  clear(): void {
    this.queue = [];
    if (this.current) {
      this.stopCurrent();
      this.lastEnd = this.now();
    }
  }

  /** Аудиоконтекст для записей — по жесту (повторно — возобновит приостановленный); тогда же загрузить критические фразы. */
  private unlockClips(): void {
    const clips = this.clips;
    if (!clips) return;
    clips.unlock();
    if (this.clipsUnlocked) return;
    this.clipsUnlocked = true;
    this.preloadCritical();
  }

  private get recUri(): string | null {
    return this.pack ? `rec:${this.pack.m.voice}` : null;
  }

  /** Говорим записью: она есть, и выбрана она (или ничего, или выбранного голоса синтеза нет). */
  private get recSelected(): boolean {
    if (!this.pack) return false;
    const uri = this.cfg.voiceURI;
    return uri === null || uri === this.recUri || !this.ru.some((v) => v.voiceURI === uri);
  }

  private clipUrl(text: string): string | null {
    const p = this.pack;
    const f = p?.m.files[text];
    return p && f && this.clips ? p.url + f : null;
  }

  private loadPack(url: string, fetchJson: (url: string) => Promise<unknown>): void {
    this.packLoading = true;
    Promise.resolve()
      .then(() => fetchJson(`${url}index.json`))
      .then((j) => {
        const m = parseManifest(j);
        if (m) this.pack = { url, m };
      })
      .catch(() => {
        // Записи нет — говорит синтез.
      })
      .finally(() => {
        this.packLoading = false;
        this.refresh();
        this.preloadCritical();
      });
  }

  /** Критические фразы — заранее, чтобы прозвучали без задержки. Только после жеста пользователя. */
  private preloadCritical(): void {
    const p = this.pack;
    const clips = this.clips;
    if (!p || !clips || !this.clipsUnlocked || !clips.ready) return;
    for (const t of p.m.preload) {
      const f = p.m.files[t];
      if (f) clips.load(p.url + f, true).catch(() => {});
    }
  }

  private tuningOf(v: SynthVoice | null): VoiceTuning {
    const own = v ? this.cfg.perVoice[v.voiceURI] : undefined;
    return { ...voiceTuning(v), ...own };
  }

  private enqueue(c: Callout): void {
    if (!this.cfg.enabled || !this.available || this.suspended) return;
    const now = this.now();
    if ((this.said.get(c.text) ?? -Infinity) > now - REPEAT_S) return;
    if (this.current?.c.text === c.text || this.queue.some((i) => i.c.text === c.text)) return;
    this.queue = this.queue.filter((i) => i.c.key !== c.key);
    this.queue.push({ c, until: now + TTL_S[c.priority], started: 0 });
    if (this.queue.length > MAX_QUEUE) {
      // Лишнее — самое неважное и самое старое.
      let worst = this.queue[0]!;
      for (const i of this.queue) if (rank(i.c) > rank(worst.c)) worst = i;
      this.queue = this.queue.filter((i) => i !== worst);
    }
    const cur = this.current;
    if (cur && rank(c) < rank(cur.c)) {
      this.stopCurrent();
      this.lastEnd = now;
    }
  }

  /** Записью, если фраза записана и выбрана запись; иначе синтезом. */
  private start(item: Item, now: number): void {
    const url = this.recSelected ? this.clipUrl(item.c.text) : null;
    if (url) this.playClip(item, url, now, true);
    else this.speak(item, now);
  }

  private remember(text: string, now: number): void {
    this.said.set(text, now);
    if (this.said.size > 64) for (const [t, at] of this.said) if (at < now - REPEAT_S) this.said.delete(t);
  }

  private playClip(item: Item, url: string, now: number, remember: boolean): void {
    const clips = this.clips!;
    if (!clips.ready) {
      // Без жеста пользователя звук не заиграет: фраза ждёт unlock().
      if (remember) {
        this.blocked = true;
        this.queue.unshift(item);
      }
      return;
    }
    const cur: Item = { ...item, started: now, kind: 'clip' };
    this.current = cur;
    if (remember) this.remember(item.c.text, now);
    const go = () => {
      if (this.current !== cur) return;
      try {
        const h = clips.play(url, this.cfg.volume, () => this.finish(cur));
        cur.stop = () => h.stop();
      } catch {
        this.finish(cur);
      }
    };
    if (clips.loaded(url)) go();
    else {
      clips.load(url).then(go, () => {
        // Запись не загрузилась — скажем синтезом.
        if (this.current !== cur) return;
        this.current = null;
        this.speak(item, this.now(), this.voice, false);
      });
    }
  }

  private speak(item: Item, now: number, voice = this.voice, remember = true): void {
    const synth = this.synth;
    const make = this.make;
    if (!synth || !make || !voice) {
      // Говорить нечем (есть только запись, а фразы в ней нет).
      this.lastEnd = now;
      return;
    }
    const cur: Item = { ...item, started: now, kind: 'synth' };
    const tune = this.tuningOf(voice);
    const u = make(synthText(item.c.text));
    u.lang = voice.lang;
    u.voice = voice;
    u.volume = this.cfg.volume;
    u.rate = clamp(this.cfg.rate * tune.rate, 0.5, 2);
    u.pitch = clamp(tune.pitch, 0.5, 2);
    u.onend = () => {
      if (this.current === cur) this.finish(cur);
    };
    u.onerror = (e) => {
      if (this.current !== cur) return;
      if (e?.error === 'not-allowed' && remember) {
        // Без жеста пользователя браузер не говорит: фраза ждёт unlock().
        this.blocked = true;
        this.current = null;
        this.queue.unshift(item);
        return;
      }
      this.finish(cur);
    };
    this.current = cur;
    if (remember) this.remember(item.c.text, now);
    try {
      synth.speak(u);
    } catch {
      this.finish(cur);
    }
  }

  private stopCurrent(): void {
    const cur = this.current;
    this.current = null;
    if (!cur) return;
    if (cur.kind === 'clip') cur.stop?.();
    else {
      try {
        this.synth?.cancel();
      } catch {
        // уже молчит
      }
    }
  }

  private finish(cur: Item): void {
    if (this.current !== cur) return;
    this.current = null;
    this.lastEnd = this.now();
  }

  private setDuck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.onSpeaking?.(on);
  }

  private refresh(): void {
    const before = `${this.available}|${this.reason}|${this.voice?.voiceURI}|${this.ru.length}|${this.pack !== null}`;
    let all: SynthVoice[] = [];
    if (this.synth && this.make) {
      try {
        all = this.synth.getVoices() ?? [];
      } catch {
        all = [];
      }
    }
    this.ru = all.filter(isRussian);
    // Голос синтеза нужен и при записи — для фраз, которых в ней нет.
    this.voice = pickVoice(this.ru, this.cfg.voiceURI);
    this.available = this.pack !== null || this.voice !== null;
    this.reason = this.available
      ? null
      : this.packLoading
        ? VOICE_LOADING
        : !this.synth || !this.make
          ? VOICE_NO_API
          : all.length > 0 || this.waitedOut
            ? VOICE_NO_RUSSIAN
            : VOICE_LOADING;
    if (!this.available) this.clear();
    if (`${this.available}|${this.reason}|${this.voice?.voiceURI}|${this.ru.length}|${this.pack !== null}` !== before) this.onChange?.();
  }

  private save(): void {
    try {
      this.storage?.setItem(VOICE_KEY, JSON.stringify(this.cfg));
    } catch {
      // Не сохранится — не страшно.
    }
    this.onChange?.();
  }
}
