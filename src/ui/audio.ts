// Процедурный звук аппарата и сигналы НСУ на Web Audio — без звуковых файлов.
// Аппарат в сцене — один источник: четыре подъёмных ротора, маршевый винт и обтекание сходятся
// в общую «пространственную» цепочку (затухание с расстоянием, завал верхов вдали, панорама, доплер).
// Сигналы НСУ идут отдельной «пультовой» шиной мимо неё: пульт слышно одинаково, где бы ни была камера.
// Граф (SoundGraph) строится на любом BaseAudioContext — в том числе на OfflineAudioContext для проверок;
// Sound отвечает за жизненный цикл: контекст только после жеста пользователя, пауза в скрытой вкладке.

const DEG = Math.PI / 180;
/** Скорость звука, м/с — для доплеровского сдвига. */
const SOUND_SPEED = 343;

// ---------- акустика винтов: чистые функции ----------

// Шкала оборотов для слуха. У визуальной модели ~590 об/мин на полной загрузке — это под стробоскоп
// лопастей, а на слух дало бы ЧСЛ 20 Гц, ниже порога. Подъёмный винт ~0,4 м на висении крутится
// около 5500 об/мин, на холостом после АРМ — около 1200.
export const LIFT_RPM_IDLE = 1200;
export const LIFT_RPM_MAX = 5500;
/** Загрузка роторов на холостом после АРМ (как у модели полёта). */
export const LIFT_LOAD_IDLE = 0.08;
/** Маршевый меньше нагружен по тяге на оборот — крутится быстрее, отсюда более высокий тон. */
export const PUSHER_RPM_MAX = 7500;
const BLADES = 2;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Обороты подъёмного винта по загрузке, об/мин. Тяга ∝ n², а загрузка ~ доля тяги, поэтому между
 * холостым и полным — интерполяция по √загрузки; ниже холостого — раскрутка с нуля (проверка роторов).
 */
export function liftRpm(load: number): number {
  const l = clamp01(load);
  if (l <= LIFT_LOAD_IDLE) return (LIFT_RPM_IDLE * l) / LIFT_LOAD_IDLE;
  const s0 = Math.sqrt(LIFT_LOAD_IDLE);
  return LIFT_RPM_IDLE + ((LIFT_RPM_MAX - LIFT_RPM_IDLE) * (Math.sqrt(l) - s0)) / (1 - s0);
}

/** Обороты маршевого винта, об/мин (тяга ∝ n²). */
export const pusherRpm = (load: number) => PUSHER_RPM_MAX * Math.sqrt(clamp01(load));

/** Частота следования лопастей, Гц — главный тон винта. */
export const bladePassHz = (rpm: number, blades = BLADES) => (rpm / 60) * blades;

/** Громкость подъёмного винта: акустическая мощность растёт быстрее тяги, ∝ загрузка^1,5. */
export function liftLevel(load: number): number {
  const l = clamp01(load);
  return l * Math.sqrt(l);
}

/** Шум обтекания ∝ V²; 25 м/с — опорный уровень, выше — с ограничением, чтобы не забивал всё. */
export const airLevel = (speedMs: number) => Math.min(1.6, (Math.max(0, speedMs) / 25) ** 2);

// ---------- слушатель: чистые функции ----------

/** Ближе этого громкость не растёт: камера «в упор» не должна оглушать. */
export const NEAR_M = 6;

/** Затухание сферической волны ∝ 1/r с полкой вблизи. */
export const distanceGain = (r: number) => NEAR_M / Math.max(NEAR_M, r);

/**
 * Срез ФНЧ, Гц: поглощение верхов воздухом (вдали остаётся гул) и «тень головы» — источник позади
 * камеры глуше. Две секции подряд дают 24 дБ/окт — вдали завал заметный.
 */
export function distanceCutoffHz(r: number, bearingDeg: number): number {
  const rear = Math.max(0, -Math.cos(bearingDeg * DEG));
  return Math.max(180, (16000 / (1 + Math.max(0, r) / 50)) * (1 - 0.4 * rear));
}

/** Панорама −1…+1 по пеленгу; не до упора — чтобы в наушниках не «выпадало» ухо. */
export const panOf = (bearingDeg: number) => 0.9 * Math.sin(bearingDeg * DEG);

/** Доля настоящего доплера: полный сдвиг от рывков камеры звучит как сбой, а не как пролёт. */
const DOPPLER_SHARE = 0.5;

/** Множитель частоты по радиальной скорости (+ удаляется → ниже). */
export function dopplerFactor(radialMs: number): number {
  const v = Math.max(-40, Math.min(40, radialMs));
  return 1 + DOPPLER_SHARE * (SOUND_SPEED / (SOUND_SPEED + v) - 1);
}

// ---------- тембры ----------

// Гармоники относительно частоты вращения вала: 2-я — ЧСЛ двухлопастного винта, чётные — её обертоны,
// 1-я — дисбаланс лопастей, 7-я и 14-я — вой мотора (7 пар полюсов). Одна волна вместо набора
// генераторов — дёшево, и гармоники не расходятся по фазе при смене оборотов.
const LIFT_WAVE: readonly (readonly [number, number])[] = [
  [1, 0.14], [2, 1], [3, 0.1], [4, 0.5], [6, 0.28], [7, 0.05], [8, 0.16], [10, 0.09], [12, 0.05], [14, 0.04], [16, 0.02],
];
// Маршевый: обертоны ЧСЛ сильнее и заметный вой мотора — «звенит» выше подъёмных.
const PUSHER_WAVE: readonly (readonly [number, number])[] = [
  [1, 0.1], [2, 1], [4, 0.6], [6, 0.4], [7, 0.25], [8, 0.25], [10, 0.16], [12, 0.1], [14, 0.4], [21, 0.12], [28, 0.18],
];

/** Постоянная расстройка роторов: одинаковые винты не крутятся одинаково — отсюда биения. */
const DETUNE: readonly number[] = [1, 1.017, 0.986, 1.008];
/** Медленное «гуляние» оборотов, рад/с: автопилот всё время подруливает тягой. */
const WOBBLE: readonly number[] = [0.83, 1.27, 0.61, 1.49];

// Уровни внутри графа (до общей громкости). Висение в 15 м от камеры — около −22 дБ ПШ по RMS,
// вплотную — пики упираются в компрессор; сигналы пульта — заметно выше гула.
const LIFT_TONE = 0.11;
const LIFT_HISS = 0.26;
const PUSHER_TONE = 0.1;
const PUSHER_HISS = 0.15;
const AIR_GAIN = 0.32;
const CONSOLE_GAIN = 0.9;

function wave(ctx: BaseAudioContext, harmonics: readonly (readonly [number, number])[]): PeriodicWave {
  let n = 0;
  for (const h of harmonics) n = Math.max(n, h[0] + 1);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (const [k, a] of harmonics) imag[k] = a;
  return ctx.createPeriodicWave(real, imag);
}

/**
 * 2 с белого шума петлёй — на все шипящие составляющие. Источники стартуют с разных смещений,
 * чтобы шумы роторов не были копиями друг друга. Генератор детерминированный (mulberry32).
 */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const n = Math.round(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return buf;
}

// ---------- граф ----------

/** Регистрирует плавно ведомый параметр: порог изменения (доля) и постоянная времени, с; → номер. */
type KnobFn = (param: AudioParam, eps: number, tau: number) => number;

/**
 * Голос винта: тон (волна на частоте вала) + шум в полосе, промодулированный тем же тоном —
 * «хлопанье» лопастей на ЧСЛ, по которому винт узнаётся на слух. Поля — номера параметров в графе.
 */
class PropVoice {
  readonly freq: number;
  readonly tone: number;
  readonly hiss: number;
  readonly band: number;
  readonly sources: AudioScheduledSourceNode[];

  constructor(ctx: BaseAudioContext, pw: PeriodicWave, noise: AudioBuffer, chopDepth: number, offsetS: number, out: AudioNode, knob: KnobFn, tau: number) {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pw);
    osc.frequency.value = 20;
    const tone = ctx.createGain();
    tone.gain.value = 0;
    osc.connect(tone).connect(out);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 800;
    band.Q.value = 0.8;
    // Модуляция: усиление chop = (1 − depth) + depth·тон.
    const chop = ctx.createGain();
    chop.gain.value = 1 - chopDepth;
    const depth = ctx.createGain();
    depth.gain.value = chopDepth;
    osc.connect(depth).connect(chop.gain);
    const hiss = ctx.createGain();
    hiss.gain.value = 0;
    src.connect(band).connect(chop).connect(hiss).connect(out);

    const t = ctx.currentTime;
    osc.start(t);
    src.start(t, offsetS);
    this.sources = [osc, src];
    this.freq = knob(osc.frequency, 5e-4, tau);
    this.tone = knob(tone.gain, 0.01, tau);
    this.hiss = knob(hiss.gain, 0.01, tau);
    this.band = knob(band.frequency, 0.01, tau);
  }
}

export interface SoundState {
  rotors: [number, number, number, number]; // загрузка 0…1
  pusher: number; // 0…1
  tasMs: number;
  /** Амплитуда прибавки порывов к обдуву, м/с; сами порывы — медленная псевдослучайная огибающая. */
  gustMs?: number;
  listenerDistanceM: number; // от камеры до аппарата
  listenerBearingDeg: number; // аппарат относительно направления камеры, + вправо
  armed: boolean;
}

export type AlarmKind = 'arm' | 'disarm' | 'warning' | 'failure' | 'crash' | 'shutter' | 'lowBattery' | 'prepStep';
type LoopKind = 'lowBattery' | 'failure';

interface Loop {
  kind: LoopKind;
  /** Период повтора, с. */
  period: number;
  /** Своя шина: при выключении повтора уже запланированный рисунок гасится сразу, а не доигрывает. */
  bus: GainNode;
  on: boolean;
  next: number;
}

/** Не больше стольких одновременных голосов пульта — частые вызовы alarm() не копят узлы. */
const MAX_VOICES = 48;

/** Граф синтеза. Работает и на OfflineAudioContext — для проверки уровней без звуковой карты. */
export class SoundGraph {
  readonly ctx: BaseAudioContext;
  private readonly noise: AudioBuffer;
  private readonly masterNode: GainNode;
  private readonly consoleBus: GainNode;
  private readonly lift: PropVoice[] = [];
  private readonly pusher: PropVoice;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly loops: Loop[];

  // Плавно ведомые параметры. Цели кадра пишутся в типизированные массивы, в Web Audio уходят только
  // заметные изменения: каждый setTargetAtTime — событие в очереди автоматизации. Дробные числа между
  // функциями не гоняем: при неинлайненном вызове V8 упаковывает их в кучу, а update() — каждый кадр.
  private readonly params: AudioParam[] = [];
  private readonly target: Float64Array;
  private readonly last: Float64Array;
  private readonly eps: Float64Array;
  private readonly tau: Float64Array;
  private readonly kDist: number;
  private readonly kLp1: number;
  private readonly kLp2: number;
  private readonly kPan: number;
  private readonly kAirGain: number;
  private readonly kAirBand: number;

  /** Последняя частота вала по роторам — разгон и выбег идут с разной постоянной времени. */
  private readonly shaftHz = new Float64Array(4);
  private clock = 0;
  private now = 0;
  private lastR = -1;
  private radial = 0;
  private voices = 0;
  private noiseOffset = 0;

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx);
    const epsList: number[] = [];
    const tauList: number[] = [];
    const knob: KnobFn = (param, eps, tau) => {
      this.params.push(param);
      epsList.push(eps);
      tauList.push(tau);
      return this.params.length - 1;
    };

    // Компрессор-ограничитель: висение вплотную плюс сирена не должны перегружать выход.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 10;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(out);
    this.masterNode = ctx.createGain();
    this.masterNode.gain.value = 0;
    this.masterNode.connect(comp);

    // Пространственная цепочка: сумма голосов → расстояние → ФНЧ ×2 → панорама.
    const pan = ctx.createStereoPanner();
    pan.connect(this.masterNode);
    const lp2 = ctx.createBiquadFilter();
    const lp1 = ctx.createBiquadFilter();
    for (const f of [lp1, lp2]) {
      f.type = 'lowpass';
      f.frequency.value = 16000;
      f.Q.value = 0; // без подъёма на срезе (Q здесь в дБ)
    }
    lp2.connect(pan);
    lp1.connect(lp2);
    const dist = ctx.createGain();
    dist.gain.value = 0;
    dist.connect(lp1);
    this.kDist = knob(dist.gain, 0.005, 0.05);
    this.kLp1 = knob(lp1.frequency, 0.01, 0.05);
    this.kLp2 = knob(lp2.frequency, 0.01, 0.05);
    this.kPan = knob(pan.pan, 0.005, 0.05);

    // Пульт: мимо пространственной цепочки; ФНЧ смягчает прямоугольные сигналы.
    const consoleLp = ctx.createBiquadFilter();
    consoleLp.type = 'lowpass';
    consoleLp.frequency.value = 6500;
    consoleLp.connect(this.masterNode);
    this.consoleBus = ctx.createGain();
    this.consoleBus.gain.value = CONSOLE_GAIN;
    this.consoleBus.connect(consoleLp);
    const loopBus = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.consoleBus);
      return g;
    };
    this.loops = [
      { kind: 'lowBattery', period: 5, bus: loopBus(), on: false, next: 0 },
      { kind: 'failure', period: 1.6, bus: loopBus(), on: false, next: 0 },
    ];

    const liftWave = wave(ctx, LIFT_WAVE);
    for (let i = 0; i < 4; i++) this.lift.push(new PropVoice(ctx, liftWave, this.noise, 0.45, 0.13 + i * 0.41, dist, knob, 0.12));
    this.pusher = new PropVoice(ctx, wave(ctx, PUSHER_WAVE), this.noise, 0.2, 1.77, dist, knob, 0.15);
    for (const v of [...this.lift, this.pusher]) this.sources.push(...v.sources);

    // Обтекание: широкая полоса шума, центр растёт со скоростью.
    const air = ctx.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    const airBand = ctx.createBiquadFilter();
    airBand.type = 'bandpass';
    airBand.frequency.value = 300;
    airBand.Q.value = 0.5;
    const airGain = ctx.createGain();
    airGain.gain.value = 0;
    air.connect(airBand).connect(airGain).connect(dist);
    air.start(ctx.currentTime, 0.91);
    this.sources.push(air);
    this.kAirGain = knob(airGain.gain, 0.01, 0.15);
    this.kAirBand = knob(airBand.frequency, 0.01, 0.2);

    const n = this.params.length;
    this.target = new Float64Array(n);
    this.last = new Float64Array(n).fill(NaN);
    this.eps = Float64Array.from(epsList);
    this.tau = Float64Array.from(tauList);
  }

  /** Общая громкость (линейный множитель), с плавным переходом. */
  setMaster(gain: number): void {
    this.masterNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.03);
  }

  /** Раз в кадр: цели параметров по состоянию аппарата и камеры. Без выделений памяти. */
  update(dt: number, s: SoundState): void {
    const T = this.target;
    const tau = this.tau;
    this.clock += dt;
    const c = this.clock;

    // Слушатель. Радиальная скорость — по изменению дальности; скачок камеры (смена вида) —
    // не движение, в доплер его не берём.
    const r = s.listenerDistanceM > 0 ? s.listenerDistanceM : 0;
    if (dt > 0 && this.lastR >= 0) {
      const vr = (r - this.lastR) / dt;
      if (Math.abs(vr) < 80) this.radial += (vr - this.radial) * Math.min(1, dt / 0.25);
    }
    this.lastR = r;
    const dop = dopplerFactor(this.radial);
    T[this.kDist] = distanceGain(r);
    const fc = distanceCutoffHz(r, s.listenerBearingDeg);
    T[this.kLp1] = fc;
    T[this.kLp2] = fc;
    T[this.kPan] = panOf(s.listenerBearingDeg);

    // Подъёмные роторы; частота волны — частота вала, ЧСЛ — её 2-я гармоника.
    // Без АРМ моторы не тормозят винт — он выбегает дольше.
    const spinDown = s.armed ? 0.1 : 0.45;
    for (let i = 0; i < 4; i++) {
      const v = this.lift[i]!;
      const load = clamp01(s.rotors[i] ?? 0);
      const f = (liftRpm(load) / 60) * DETUNE[i]! * (1 + 0.004 * Math.sin(c * WOBBLE[i]! + i * 1.7)) * dop;
      const k = f > this.shaftHz[i]! ? 0.12 : spinDown;
      this.shaftHz[i] = f;
      const lvl = liftLevel(load);
      T[v.freq] = f > 4 ? f : 4;
      T[v.tone] = LIFT_TONE * lvl;
      T[v.hiss] = LIFT_HISS * lvl * (0.5 + 0.5 * load);
      T[v.band] = 500 + 14 * f; // полоса шума ~ 7 × ЧСЛ
      tau[v.freq] = tau[v.tone] = tau[v.hiss] = tau[v.band] = k;
    }

    // Маршевый: и тон, и шум ∝ загрузке.
    const pl = clamp01(s.pusher);
    const pf = (pusherRpm(pl) / 60) * dop;
    const p = this.pusher;
    T[p.freq] = pf > 4 ? pf : 4;
    T[p.tone] = PUSHER_TONE * pl;
    T[p.hiss] = PUSHER_HISS * pl;
    T[p.band] = 900 + 18 * pf;

    // Обтекание ∝ V²; порыв — не постоянная прибавка, а медленные несоизмеримые синусы 0…1.
    const gust = (s.gustMs ?? 0) * (0.5 + 0.3 * Math.sin(c * 0.73) + 0.2 * Math.sin(c * 1.91 + 1.3));
    const va = Math.max(0, s.tasMs + gust);
    T[this.kAirGain] = AIR_GAIN * airLevel(va);
    T[this.kAirBand] = 180 + 45 * va;

    const now = this.ctx.currentTime;
    const P = this.params;
    const L = this.last;
    const E = this.eps;
    for (let k = 0; k < P.length; k++) {
      const v = T[k]!;
      const l = L[k]!;
      if (Math.abs(v - l) <= E[k]! * (Math.abs(l) + 1e-3)) continue;
      L[k] = v;
      P[k]!.setTargetAtTime(v, now, tau[k]!);
    }

    this.now = now;
    this.tickLoops();
  }

  /** Повторяющиеся сигналы: следующий рисунок ставится заранее по часам контекста (this.now). */
  private tickLoops(): void {
    const now = this.now;
    for (let i = 0; i < this.loops.length; i++) {
      const l = this.loops[i]!;
      if (!l.on || now < l.next - 0.1) continue;
      // После приостановки контекста не наверстываем пропущенное — просто играем сейчас.
      const at = Math.max(l.next, now + 0.02);
      this.play(l.kind, l.bus, at);
      l.next = at + l.period;
    }
  }

  setLoop(kind: LoopKind, on: boolean): void {
    const l = this.loops.find((x) => x.kind === kind)!;
    if (l.on === on) return;
    l.on = on;
    const now = this.ctx.currentTime;
    l.bus.gain.setTargetAtTime(on ? 1 : 0, now, 0.02);
    if (on) {
      l.next = now;
      this.now = now;
      this.tickLoops();
    }
  }

  /** Один сигнал пульта. out — шина (по умолчанию пульт), at — время по часам контекста. */
  play(kind: AlarmKind, out: AudioNode = this.consoleBus, at = this.ctx.currentTime + 0.01): void {
    const t = at;
    switch (kind) {
      case 'arm': // восходящая пара: «моторы под напряжением»
        this.beep(out, t, 880, 0.09, 0.22);
        this.beep(out, t + 0.13, 1320, 0.16, 0.22);
        break;
      case 'disarm': // нисходящая пара
        this.beep(out, t, 1320, 0.09, 0.2);
        this.beep(out, t + 0.13, 660, 0.2, 0.2);
        break;
      case 'prepStep': // тихое «принято» — шагов подготовки много, не должно утомлять
        this.beep(out, t, 1568, 0.05, 0.1, 'sine');
        this.beep(out, t + 0.07, 2093, 0.08, 0.09, 'sine');
        break;
      case 'warning': // «внимание»: двухтональный гонг
        this.beep(out, t, 988, 0.2, 0.2, 'sine');
        this.beep(out, t + 0.26, 784, 0.32, 0.2, 'sine');
        break;
      case 'failure': // главное предупреждение: частое чередование резким тембром
        for (let k = 0; k < 3; k++) {
          this.beep(out, t + k * 0.3, 1480, 0.12, 0.12, 'square');
          this.beep(out, t + k * 0.3 + 0.15, 1000, 0.12, 0.12, 'square');
        }
        break;
      case 'lowBattery': // три коротких средних тона
        for (let k = 0; k < 3; k++) this.beep(out, t + k * 0.17, 740, 0.09, 0.2);
        break;
      case 'crash': // удар (шум + низкий «бум») и следом падающий тон тревоги
        this.burst(out, t, 0.7, 0.5, 'lowpass', 2400, 300);
        this.beep(out, t, 120, 0.22, 0.6, 'sine', 38);
        this.beep(out, t + 0.5, 900, 1, 0.12, 'sawtooth', 330);
        break;
      case 'shutter': // затвор: два сухих щелчка
        this.burst(out, t, 0.012, 0.45, 'highpass', 2500);
        this.burst(out, t + 0.06, 0.02, 0.3, 'bandpass', 1800, 1800, 1.2);
        break;
    }
  }

  /** Тон: атака 4 мс и экспоненциальный спад — края без щелчков. f1 — скольжение к концу. */
  private beep(out: AudioNode, t0: number, f0: number, dur: number, level: number, type: OscillatorType = 'triangle', f1 = f0): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.004);
    g.gain.setTargetAtTime(0, t0 + dur, 0.012);
    o.connect(g).connect(out);
    this.voice(o, g, t0, t0 + dur + 0.1);
  }

  /** Отфильтрованный шумовой удар: мгновенная атака, спад примерно за dur. */
  private burst(out: AudioNode, t0: number, dur: number, level: number, type: BiquadFilterType, f0: number, f1 = f0, q = 0.7): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.002);
    g.gain.setTargetAtTime(0, t0 + 0.002, dur / 5);
    src.connect(flt).connect(g).connect(out);
    // Каждый удар — со своего места буфера, иначе щелчки затвора звучали бы одинаково.
    this.noiseOffset = (this.noiseOffset + 0.377) % 1.5;
    this.voice(src, g, t0, t0 + dur + 0.05, this.noiseOffset);
  }

  private voice(src: AudioScheduledSourceNode, tail: AudioNode, start: number, stop: number, offset?: number): void {
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      tail.disconnect();
    };
    if (offset !== undefined) (src as AudioBufferSourceNode).start(start, offset);
    else src.start(start);
    src.stop(stop);
  }

  /** Останавливает постоянные источники (перед закрытием контекста). */
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // уже остановлен
      }
    }
    this.masterNode.disconnect();
  }
}

// ---------- жизненный цикл ----------

/**
 * Звук симулятора. До resume() ничего не создаёт и молчит: браузер разрешает звук только после
 * жеста пользователя, а контекст, созданный раньше, заводится приостановленным и ругается в консоль.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private graph: SoundGraph | null = null;
  private volume = 0.7;
  private isMuted = false;
  private hidden = false;
  private disposed = false;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly loopsOn: Record<LoopKind, boolean> = { lowBattery: false, failure: false };

  // Скрытая вкладка: requestAnimationFrame стоит, update() не зовётся, и звук застыл бы на последнем
  // кадре. Сначала уводим громкость, потом останавливаем контекст — обрыв на полуволне дал бы щелчок.
  private readonly onVisibility = () => {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    this.hidden = document.hidden;
    this.applyMaster();
    clearTimeout(this.suspendTimer);
    if (this.hidden) this.suspendTimer = setTimeout(() => void ctx.suspend().catch(() => {}), 150);
    else void ctx.resume().catch(() => {});
  };

  /** Вызывать из обработчика жеста пользователя (pointerdown/keydown); повторные вызовы дешёвы. */
  async resume(): Promise<void> {
    if (this.disposed || typeof AudioContext === 'undefined') return;
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.graph = new SoundGraph(ctx, ctx.destination);
      for (const k of ['lowBattery', 'failure'] as const) if (this.loopsOn[k]) this.graph.setLoop(k, true);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.hidden = document.hidden;
    this.applyMaster();
    if (this.ctx.state !== 'running' && !this.hidden) {
      try {
        await this.ctx.resume();
      } catch {
        // Без жеста браузер может отказать — попробуем на следующем.
      }
    }
  }

  /** Громкость 0…1; на слух ровнее квадратичная шкала. */
  setVolume(v: number): void {
    this.volume = clamp01(v);
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this.isMuted = m;
    this.applyMaster();
  }

  get muted(): boolean {
    return this.isMuted;
  }

  /** Раз в кадр, с реальным (не ускоренным) dt. До resume() — ничего не делает. */
  update(dt: number, s: SoundState): void {
    if (this.graph && !this.hidden) this.graph.update(dt, s);
  }

  alarm(kind: AlarmKind): void {
    if (this.graph && !this.hidden) this.graph.play(kind);
  }

  /** Повтор сигнала, пока не выключат; можно звать и до resume() — начнётся после него. */
  setLoop(kind: 'lowBattery' | 'failure', on: boolean): void {
    this.loopsOn[kind] = on;
    this.graph?.setLoop(kind, on);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.suspendTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.graph?.stop();
    void this.ctx?.close().catch(() => {});
    this.graph = null;
    this.ctx = null;
  }

  private applyMaster(): void {
    this.graph?.setMaster(this.isMuted || this.hidden ? 0 : this.volume * this.volume);
  }
}
