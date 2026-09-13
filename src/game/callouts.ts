import { AIRCRAFT } from '../sim/aircraft';
import { FAILURES, LINK_TIMEOUT_S } from '../sim/failures';
import type { LiveMode } from '../sim/flight';

/*
 * Голос НСУ: что сказать оператору по потоку телеметрии — коротко, как речевой информатор,
 * чтобы глаза оставались на карте. Здесь только решение «что и когда»: пороги с гистерезисом,
 * выдержки, по одному разу на событие. Произносит ui/voice.ts — записью (public/voice) или синтезом.
 *
 * Время — симуляционное (t = flight.state.t), состояние — то, что видит НСУ (flight.telemetry):
 * без связи оно замирает, и всё, что случилось за это время, говорится после восстановления.
 * Все тексты — в PHRASES и функциях ниже; calloutCatalog() перечисляет их для записанной озвучки.
 */

export type CalloutPriority = 'critical' | 'warning' | 'info';

/** Меньше — важнее. */
export const PRIORITY_RANK: Record<CalloutPriority, number> = { critical: 0, warning: 1, info: 2 };

export interface Callout {
  /** Что сказать: коротко, числа словами. */
  text: string;
  priority: CalloutPriority;
  /** Сообщения с одним ключом вытесняют друг друга в очереди: устаревшее не договаривается. */
  key: string;
  /** Время симуляции, с. */
  t: number;
}

/** Зоны РЭБ и запретные зоны — необязательные поля состояния: интенсивности 0…1 и id зон. */
export interface EwState {
  gnssJam?: number;
  gnssSpoof?: number;
  linkJam?: number;
  noflyIds?: readonly (string | number)[];
}

/** Что нужно от телеметрии (LiveState подходит как есть); ew и качество связи — если есть. */
export interface CalloutState {
  mode: LiveMode;
  armed: boolean;
  soc: number;
  linkLost: boolean;
  failures: readonly string[];
  failsafePhase: 'plane' | 'copter' | null;
  aglM: number;
  /** Приборная по ПВД, м/с. */
  iasMs: number;
  bankDeg: number;
  routeLeg: number | null;
  ew?: EwState | null;
  /** Качество радиоканала 0…1, если его считает модель связи. */
  linkQuality?: number | null;
  /** Маршевый (LiveState.pusherState): для «Маршевый запущен» и «Запуск не удался». */
  pusherState?: 'run' | 'off' | 'starting' | null;
}

export interface CalloutContext {
  paused?: boolean;
  /** Открыт разбор: 3D показывает запись. */
  replay?: boolean;
  /** Ускорение времени, которое действует сейчас (в «Фэйлсейфе» — 1). */
  rate?: number;
  /** РЭБ и качество связи в обход телеметрии — если НСУ знает их не с борта. */
  ew?: EwState | null;
  linkQuality?: number | null;
  /** Борт в зоне действия ПДУ (LiveFlight.rcInRange()). */
  rcInRange?: boolean;
}

/** Маршрут для «Пройдена точка N» и «Галс N»: по номерам участков (state.routeLeg). */
export interface RouteInfo {
  /** Точек оператора: участок k (1…points) ведёт к точке k. */
  points?: number;
  /** Маршрут в обратную сторону (обратный полёт доставки): участок k ведёт к точке points − k + 1. */
  reversed?: boolean;
  /** Участки-галсы съёмки (SurveyPlan.lineLegs): на входе — «Галс N». */
  lineLegs?: Iterable<number>;
}

/** С такого ускорения говорим только критическое. */
export const FAST_RATE = 10;

/** Постоянные фразы. Сокращения — как говорят операторы; как их произносить, знают запись и voice.ts. */
export const PHRASES = {
  linkLost: 'Потеря связи',
  linkBack: 'Связь восстановлена',
  weakLink: 'Слабый сигнал связи',
  gnssLost: 'Потеря ГНСС',
  gnssBack: 'ГНСС восстановлена',
  spoof: 'Подмена ГНСС',
  ewIn: 'Вход в зону РЭБ',
  ewOut: 'Выход из зоны РЭБ',
  noflyIn: 'Вход в запретную зону',
  noflyOut: 'Выход из запретной зоны',
  batteryEmpty: 'Батарея разряжена',
  lowAlt: 'Малая высота',
  stall: 'Сваливание',
  overspeed: 'Превышение скорости',
  bank: 'Большой крен',
  rc: 'ПДУ не достаёт',
  arm: 'Арм',
  disarm: 'Дизарм',
  takeoff: 'Взлёт',
  takeoffAborted: 'Взлёт прекращён',
  transition: 'Переход в самолётный режим',
  auto: 'Маршрут',
  guided: 'Оперативная точка',
  hold: 'Ожидание',
  manual: 'Ручной режим',
  rtl: 'Возврат',
  landing: 'Посадка',
  failsafeAuto: 'Фэйлсейф, управление с пульта',
  failsafePlane: 'Фэйлсейф, самолёт',
  failsafeCopter: 'Фэйлсейф, коптер',
  copter: 'Режим коптера',
  motorsOff: 'Моторы остановлены',
  touchdown: 'Касание',
  crash: 'Авария',
  lastLine: 'Последний галс',
  failureUnknown: 'Отказ на борту',
  pusherStarted: 'Маршевый запущен',
  pusherFailed: 'Запуск не удался',
  planeMode: 'Самолётный режим',
} as const;

type PhraseId = keyof typeof PHRASES;

/** Самый высокий приоритет, с которым фраза звучит (для каталога: критические загружаются заранее). */
const PHRASE_PRIORITY: Record<PhraseId, CalloutPriority> = {
  linkLost: 'critical',
  linkBack: 'warning',
  weakLink: 'warning',
  gnssLost: 'critical',
  gnssBack: 'warning',
  spoof: 'critical',
  ewIn: 'warning',
  ewOut: 'info',
  noflyIn: 'critical',
  noflyOut: 'info',
  batteryEmpty: 'critical',
  lowAlt: 'critical',
  stall: 'critical',
  overspeed: 'warning',
  bank: 'warning',
  rc: 'warning',
  arm: 'info',
  disarm: 'info',
  takeoff: 'info',
  takeoffAborted: 'warning',
  transition: 'info',
  auto: 'info',
  guided: 'info',
  hold: 'info',
  manual: 'info',
  rtl: 'warning',
  landing: 'info',
  failsafeAuto: 'critical',
  failsafePlane: 'warning',
  failsafeCopter: 'warning',
  copter: 'info',
  motorsOff: 'critical',
  touchdown: 'info',
  crash: 'critical',
  lastLine: 'info',
  failureUnknown: 'critical',
  pusherStarted: 'info',
  pusherFailed: 'warning',
  planeMode: 'info',
};

/** Пороги заряда: доля, приоритет. */
const BATTERY: readonly (readonly [number, CalloutPriority])[] = [
  [0.5, 'info'],
  [0.3, 'warning'],
  [0.2, 'warning'],
  [0.1, 'critical'],
];
/** Связь: потеря — если нет дольше, восстановление — если есть дольше, с. */
const LINK_LOST_S = 1;
const LINK_BACK_S = 2;
/** Слабый сигнал: ниже порога дольше выдержки; снова говорить — после возврата выше второго порога. */
const WEAK_LINK = 0.35;
const WEAK_LINK_OK = 0.6;
const WEAK_LINK_S = 3;
/** ГНСС: потеря и восстановление с выдержкой, с. */
const GNSS_LOST_S = 1;
const GNSS_BACK_S = 3;
/** РЭБ: вход — с этой интенсивности, выход — ниже второго порога дольше выдержки. */
const EW_IN = 0.2;
const EW_OUT = 0.05;
const EW_OUT_S = 3;
const SPOOF_IN = 0.5;
const SPOOF_OUT = 0.1;
const NOFLY_OUT_S = 2;
/** Малая высота в самолётном режиме: ниже запаса высоты на маршруте и высоты обратного перехода. */
const LOW_AGL_M = 0.8 * Math.min(AIRCRAFT.minClearanceM, AIRCRAFT.vtol.backTransitionHeightM);
const LOW_AGL_REARM_M = LOW_AGL_M + 15;
const LOW_AGL_S = 1;
/** Сваливание — как у модели полёта: ниже 0,85 скорости начала перехода. */
const STALL_IAS = 0.85 * AIRCRAFT.transitionLowIasMs;
const STALL_S = 1;
const OVERSPEED_S = 2;
/** Крен сверх ограничения РЛЭ (с ПДУ полный ход ручки — ровно оно). */
const BANK_WARN_DEG = AIRCRAFT.limits.maxBankDeg + 3;
const BANK_S = 1;
/** Смена режима после команды оператора в пределах этого времени — «по команде». */
const COMMAND_S = 3;
const RC_BACK_S = 3;

const PLANE: readonly LiveMode[] = ['auto', 'guided', 'hold', 'manual', 'rtl'];
const ON_GROUND: readonly LiveMode[] = ['ground', 'landed', 'crashed'];

/** Отказы — коротко и без сокращений. Нет в списке — название из РЛЭ. */
const FAILURE_SPEECH: Record<string, string> = {
  airspeed: 'Отказ датчика скорости',
  compass: 'Отказ компаса',
  radalt: 'Отказ радиовысотомера',
  aileron: 'Отказ элерона',
  elevator: 'Отказ руля высоты',
  tail: 'Отрыв стабилизатора',
  pusher: 'Отрыв маршевого винта',
  rotor: 'Отрыв подъёмного винта',
  vtol: 'Отказ подъёмных роторов',
  power: 'Отказ питания',
  autopilot: 'Отказ автопилота',
  fire: 'Пожар на борту',
  boom: 'Отрыв балки',
  wing: 'Отрыв консоли',
  stabilization: 'Потеря стабилизации',
};

const ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Целое 0…999 словами (женский род — «одна», «две»); больше — цифрами. */
export function numberWords(n: number, feminine = false): string {
  const v = Math.round(Math.abs(n));
  if (v >= 1000) return String(v);
  if (v === 0) return ONES[0]!;
  const parts: string[] = [];
  if (v >= 100) parts.push(HUNDREDS[Math.floor(v / 100)]!);
  let r = v % 100;
  if (r >= 20) {
    parts.push(TENS[Math.floor(r / 10)]!);
    r %= 10;
  }
  if (r > 0) parts.push(feminine && r <= 2 ? (r === 1 ? 'одна' : 'две') : ONES[r]!);
  return parts.join(' ');
}

/** Форма слова при числе: 1 процент, 2 процента, 5 процентов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** «Заряд тридцать процентов». */
export const batteryText = (percent: number) => `Заряд ${numberWords(percent)} ${plural(percent, 'процент', 'процента', 'процентов')}`;
/** «Нет связи тридцать секунд». */
export const linkReminderText = (s = LINK_TIMEOUT_S) => `Нет связи ${numberWords(s, true)} ${plural(s, 'секунду', 'секунды', 'секунд')}`;
/** «Пройдена точка двенадцать». */
export const pointText = (n: number) => `Пройдена точка ${numberWords(n)}`;
/** «Галс три». */
export const lineText = (n: number) => `Галс ${numberWords(n)}`;
/** Отказ по id: короткая форма, иначе название из РЛЭ. */
export const failureText = (id: string) => FAILURE_SPEECH[id] ?? FAILURES.find((f) => f.id === id)?.title ?? PHRASES.failureUnknown;

export interface CatalogPhrase {
  text: string;
  priority: CalloutPriority;
}

/** Всё, что может сказать Callouts; номера точек и галсов — до maxN. Для записанной озвучки и проверок. */
export function calloutCatalog(maxN = 60): CatalogPhrase[] {
  const out = new Map<string, CalloutPriority>();
  const add = (text: string, p: CalloutPriority) => {
    const q = out.get(text);
    if (!q || PRIORITY_RANK[p] < PRIORITY_RANK[q]) out.set(text, p);
  };
  for (const id of Object.keys(PHRASES) as PhraseId[]) add(PHRASES[id], PHRASE_PRIORITY[id]);
  for (const [level, p] of BATTERY) add(batteryText(Math.round(level * 100)), p);
  add(linkReminderText(), 'warning');
  for (const f of FAILURES) if (f.id !== 'link' && f.id !== 'gnss') add(failureText(f.id), 'critical');
  for (let n = 1; n <= maxN; n++) {
    add(pointText(n), 'info');
    add(lineText(n), 'info');
  }
  return [...out].map(([text, priority]) => ({ text, priority }));
}

export class Callouts {
  private started = false;
  private lastT = -Infinity;
  private mode: LiveMode = 'ground';
  private phase: 'plane' | 'copter' | null = null;
  private armed = false;
  private batteryDone = new Set<number>();
  private emptySaid = false;
  private failuresSaid = new Set<string>();
  private lastCommand: { c: string; t: number } | null = null;
  private pusher: string | null = null;
  /** Переход начался из «Фэйлсейфа» или после остановки моторов — в конце «Самолётный режим». */
  private resuming = false;

  private linkLostSince: number | null = null;
  private linkOkSince: number | null = null;
  private linkAnnounced = false;
  private linkReminded = false;
  private weakSince: number | null = null;
  private weakOkSince: number | null = null;
  private weakSaid = false;

  private gnssSince: number | null = null;
  private gnssAnnounced = false;

  private ewIn = false;
  private ewLowSince: number | null = null;
  private spoofSaid = false;
  private nofly = new Set<string>();
  private noflyEmptySince: number | null = null;

  private lowSince: number | null = null;
  private lowSaid = false;
  private stallSince: number | null = null;
  private stallSaid = false;
  private overSince: number | null = null;
  private overSaid = false;
  private bankSince: number | null = null;
  private bankSaid = false;
  private rcSaid = false;
  private rcOkSince: number | null = null;

  private route: RouteInfo | null = null;
  private lineRank = new Map<number, number>();
  private maxLeg: number | null = null;

  /** Новый полёт с начала (новое задание, «Заново»). Второй полёт доставки — без сброса: заряд тот же. */
  reset(): void {
    const route = this.route;
    Object.assign(this, new Callouts());
    this.setRoute(route);
  }

  /** Маршрут для сообщений о точках и галсах; null — не говорить о них. */
  setRoute(r: RouteInfo | null): void {
    this.route = r;
    this.lineRank = new Map([...(r?.lineLegs ?? [])].sort((a, b) => a - b).map((leg, i) => [leg, i + 1]));
    this.maxLeg = null;
  }

  /** Команда оператора прошла (для «Фэйлсейфа» и «Возврата» по команде — ниже приоритет). */
  command(c: string, t: number): void {
    this.lastCommand = { c, t };
  }

  /**
   * Раз в кадр (или чаще): t — время симуляции сейчас, s — телеметрия НСУ. Возвращает, что сказать,
   * важное — первым. На паузе и в разборе — ничего; при ускорении от FAST_RATE — только критическое.
   * Память обновляется всегда: пропущенное не выговаривается задним числом.
   */
  update(t: number, s: CalloutState, ctx: CalloutContext = {}): Callout[] {
    if (t < this.lastT - 1e-6) this.reset();
    this.lastT = t;
    const out: Callout[] = [];
    const say = (text: string, priority: CalloutPriority, key: string) => out.push({ text, priority, key, t });

    if (!this.started) {
      this.baseline(t, s);
      return [];
    }

    this.link(t, s, say);
    // Без связи телеметрия замерла; пока восстановление не подтверждено — не сравниваем её.
    const trusted = !s.linkLost && !this.linkAnnounced;
    if (trusted) {
      this.linkQuality(t, ctx.linkQuality ?? s.linkQuality ?? null, say);
      this.failures(t, s, say);
      this.modes(t, s, say);
      this.battery(s, say);
      this.limits(t, s, say);
      this.waypoints(s, say);
      this.rc(t, s, ctx.rcInRange, say);
    }
    this.ew(t, ctx.ew ?? s.ew ?? null, say);

    if (ctx.paused || ctx.replay) return [];
    const fast = (ctx.rate ?? 1) >= FAST_RATE;
    return out.filter((c) => !fast || c.priority === 'critical').sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  }

  /** Первый кадр: запомнить, как есть, и ничего не говорить. */
  private baseline(t: number, s: CalloutState) {
    this.started = true;
    this.mode = s.mode;
    this.phase = s.failsafePhase;
    this.armed = s.armed;
    this.pusher = s.pusherState ?? null;
    for (const [level] of BATTERY) if (s.soc <= level) this.batteryDone.add(level);
    for (const id of s.failures) this.failuresSaid.add(id);
    if (s.linkLost) {
      this.linkLostSince = t;
      this.linkAnnounced = true;
    }
    this.gnssAnnounced = s.failures.includes('gnss');
  }

  private link(t: number, s: CalloutState, say: Say) {
    if (s.linkLost) {
      this.linkOkSince = null;
      this.linkLostSince ??= t;
      if (!this.linkAnnounced && t - this.linkLostSince >= LINK_LOST_S) {
        this.linkAnnounced = true;
        this.linkReminded = false;
        say(PHRASES.linkLost, 'critical', 'link');
      }
      // Автопилот без связи через LINK_TIMEOUT_S уходит на ВОЗВРАТ — напомнить, если борт был в воздухе.
      if (this.linkAnnounced && !this.linkReminded && t - this.linkLostSince >= LINK_TIMEOUT_S && !ON_GROUND.includes(s.mode)) {
        this.linkReminded = true;
        say(linkReminderText(), 'warning', 'link');
      }
      return;
    }
    this.linkLostSince = null;
    if (!this.linkAnnounced) return;
    this.linkOkSince ??= t;
    if (t - this.linkOkSince >= LINK_BACK_S) {
      this.linkAnnounced = false;
      this.linkOkSince = null;
      say(PHRASES.linkBack, 'warning', 'link');
    }
  }

  private linkQuality(t: number, q: number | null, say: Say) {
    if (q === null || !Number.isFinite(q)) return;
    if (q < WEAK_LINK) {
      this.weakOkSince = null;
      this.weakSince ??= t;
      if (!this.weakSaid && t - this.weakSince >= WEAK_LINK_S) {
        this.weakSaid = true;
        say(PHRASES.weakLink, 'warning', 'linkq');
      }
    } else {
      this.weakSince = null;
      if (q > WEAK_LINK_OK) {
        this.weakOkSince ??= t;
        if (t - this.weakOkSince >= 2 * WEAK_LINK_S) this.weakSaid = false;
      }
    }
  }

  private failures(t: number, s: CalloutState, say: Say) {
    // ГНСС: может пропадать и возвращаться (РЭБ) — с выдержкой в обе стороны.
    const gnss = s.failures.includes('gnss');
    if (gnss !== this.gnssAnnounced) {
      this.gnssSince ??= t;
      if (t - this.gnssSince >= (gnss ? GNSS_LOST_S : GNSS_BACK_S)) {
        this.gnssAnnounced = gnss;
        this.gnssSince = null;
        say(gnss ? PHRASES.gnssLost : PHRASES.gnssBack, gnss ? 'critical' : 'warning', 'gnss');
      }
    } else this.gnssSince = null;

    for (const id of s.failures) {
      if (id === 'link' || id === 'gnss' || this.failuresSaid.has(id)) continue;
      this.failuresSaid.add(id);
      say(failureText(id), 'critical', `fail:${id}`);
    }
  }

  private commanded(t: number, ...cs: string[]): boolean {
    const c = this.lastCommand;
    return !!c && cs.includes(c.c) && t - c.t <= COMMAND_S;
  }

  private modes(t: number, s: CalloutState, say: Say) {
    const prev = this.mode;
    const m = s.mode;
    const prevPhase = this.phase;
    this.mode = m;
    this.phase = s.failsafePhase;

    // АРМ — на земле; ДИЗАРМ — на земле после посадки (в воздухе и при аварии говорят о другом).
    if (s.armed !== this.armed) {
      this.armed = s.armed;
      if (s.armed && m === 'ground') say(PHRASES.arm, 'info', 'arm');
      else if (!s.armed && (m === 'ground' || m === 'landed') && prev === m) say(PHRASES.disarm, 'info', 'arm');
    }

    // Маршевый, запущенный в полёте: запустился или нет. На земле и в переходе о нём не говорим.
    const pz = s.pusherState ?? null;
    const prevPz = this.pusher;
    this.pusher = pz;
    if (pz !== prevPz && prevPz !== null && !ON_GROUND.includes(m) && m !== 'spool' && m !== 'transition') {
      if (pz === 'run') say(PHRASES.pusherStarted, 'info', 'pusher');
      else if (prevPz === 'starting' && pz === 'off') say(PHRASES.pusherFailed, 'warning', 'pusher');
    }
    // Из «Фэйлсейфа» или после остановки моторов — снова автопилот самолётом: сразу или в конце перехода.
    if (m !== prev) {
      const back = prev === 'failsafe' || prev === 'falling';
      if (PLANE.includes(m) && (back || (prev === 'transition' && this.resuming))) say(PHRASES.planeMode, 'info', 'plane');
      this.resuming = m === 'transition' && back;
    }

    if (m === prev) {
      if (m === 'failsafe' && prevPhase === 'plane' && s.failsafePhase === 'copter') say(PHRASES.copter, 'info', 'mode');
      return;
    }
    switch (m) {
      case 'spool':
        return say(PHRASES.takeoff, 'info', 'mode');
      case 'transition':
        return say(PHRASES.transition, 'info', 'mode');
      case 'auto':
        return say(PHRASES.auto, 'info', 'mode');
      case 'guided':
        return say(PHRASES.guided, 'info', 'mode');
      case 'hold':
        return say(PHRASES.hold, 'info', 'mode');
      case 'manual':
        return say(PHRASES.manual, 'info', 'mode');
      case 'rtl':
        return say(PHRASES.rtl, this.commanded(t, 'rtl') ? 'info' : 'warning', 'mode');
      case 'backtransition':
        return say(PHRASES.landing, 'info', 'mode');
      case 'descent':
        // После торможения «Посадка» уже сказана; сюда же — посадка на месте со взлёта.
        if (prev !== 'backtransition') say(PHRASES.landing, 'info', 'mode');
        return;
      case 'failsafe':
        // После запуска моторов в воздухе автопилот сам ставит «Фэйлсейф» — это ожидаемо, не тревога.
        if (prev === 'falling' || this.commanded(t, 'failsafe', 'copter')) return say(s.failsafePhase === 'copter' ? PHRASES.failsafeCopter : PHRASES.failsafePlane, 'warning', 'mode');
        return say(PHRASES.failsafeAuto, 'critical', 'mode');
      case 'falling':
        return say(PHRASES.motorsOff, 'critical', 'mode');
      case 'landed':
        return say(PHRASES.touchdown, 'info', 'mode');
      case 'crashed':
        return say(PHRASES.crash, 'critical', 'mode');
      case 'ground':
        if (prev === 'spool') say(PHRASES.takeoffAborted, 'warning', 'mode');
        return;
      default:
        return;
    }
  }

  private battery(s: CalloutState, say: Say) {
    // Скачок через несколько порогов (телеметрия после потери связи) — говорим только последний.
    let hit: readonly [number, CalloutPriority] | null = null;
    for (const b of BATTERY) {
      if (s.soc <= b[0] && !this.batteryDone.has(b[0])) {
        this.batteryDone.add(b[0]);
        hit = b;
      }
    }
    if (s.soc <= 0.005 && !this.emptySaid) {
      this.emptySaid = true;
      return say(PHRASES.batteryEmpty, 'critical', 'battery');
    }
    if (hit) say(batteryText(Math.round(hit[0] * 100)), hit[1], 'battery');
  }

  /** Самолётный режим: малая высота, сваливание, скорость, крен. */
  private limits(t: number, s: CalloutState, say: Say) {
    const plane = PLANE.includes(s.mode) || (s.mode === 'failsafe' && s.failsafePhase === 'plane');
    if (!plane) {
      this.lowSince = this.stallSince = this.overSince = this.bankSince = null;
      return;
    }
    const held = (cond: boolean, since: number | null, holdS: number): [number | null, boolean] => {
      if (!cond) return [null, false];
      const from = since ?? t;
      return [from, t - from >= holdS];
    };

    let fire: boolean;
    [this.lowSince, fire] = held(s.aglM < LOW_AGL_M, this.lowSince, LOW_AGL_S);
    if (fire && !this.lowSaid) {
      this.lowSaid = true;
      say(PHRASES.lowAlt, 'critical', 'agl');
    }
    if (s.aglM > LOW_AGL_REARM_M) this.lowSaid = false;

    // Показания ПВД при его отказе — не признак: об отказе уже сказано.
    const airdata = !s.failures.includes('airspeed');
    [this.stallSince, fire] = held(airdata && s.iasMs < STALL_IAS, this.stallSince, STALL_S);
    if (fire && !this.stallSaid) {
      this.stallSaid = true;
      say(PHRASES.stall, 'critical', 'stall');
    }
    if (s.iasMs > AIRCRAFT.transitionLowIasMs) this.stallSaid = false;

    [this.overSince, fire] = held(airdata && s.iasMs > AIRCRAFT.limits.maxIasMs, this.overSince, OVERSPEED_S);
    if (fire && !this.overSaid) {
      this.overSaid = true;
      say(PHRASES.overspeed, 'warning', 'speed');
    }
    if (s.iasMs < 0.95 * AIRCRAFT.limits.maxIasMs) this.overSaid = false;

    [this.bankSince, fire] = held(Math.abs(s.bankDeg) > BANK_WARN_DEG, this.bankSince, BANK_S);
    if (fire && !this.bankSaid) {
      this.bankSaid = true;
      say(PHRASES.bank, 'warning', 'bank');
    }
    if (Math.abs(s.bankDeg) < AIRCRAFT.maxBankDeg) this.bankSaid = false;
  }

  private waypoints(s: CalloutState, say: Say) {
    const r = this.route;
    const leg = s.routeLeg;
    if (!r || s.mode !== 'auto' || leg === null) return;
    const prev = this.maxLeg;
    if (prev !== null && leg <= prev) return;
    this.maxLeg = leg;
    if (prev === null) return;
    const rank = this.lineRank.get(leg);
    if (rank !== undefined) {
      const last = rank === this.lineRank.size;
      return say(last && rank > 1 ? PHRASES.lastLine : lineText(rank), 'info', 'route');
    }
    // Закончены участки prev…leg−1: участок j кончается точкой оператора j. Говорим последнюю.
    const n = r.points ?? 0;
    const k = Math.min(leg - 1, n);
    if (k >= Math.max(1, prev)) say(pointText(r.reversed ? n - k + 1 : k), 'info', 'route');
  }

  private rc(t: number, s: CalloutState, inRange: boolean | undefined, say: Say) {
    if (inRange === undefined || s.mode !== 'failsafe') {
      this.rcOkSince = null;
      if (s.mode !== 'failsafe') this.rcSaid = false;
      return;
    }
    if (!inRange) {
      this.rcOkSince = null;
      if (!this.rcSaid) {
        this.rcSaid = true;
        say(PHRASES.rc, 'warning', 'rc');
      }
    } else if (this.rcSaid) {
      this.rcOkSince ??= t;
      if (t - this.rcOkSince >= RC_BACK_S) this.rcSaid = false;
    }
  }

  private ew(t: number, ew: EwState | null, say: Say) {
    if (!ew) return;
    const level = Math.max(ew.gnssJam ?? 0, ew.gnssSpoof ?? 0, ew.linkJam ?? 0);
    if (!this.ewIn && level >= EW_IN) {
      this.ewIn = true;
      this.ewLowSince = null;
      say(PHRASES.ewIn, 'warning', 'ew');
    } else if (this.ewIn) {
      if (level <= EW_OUT) {
        this.ewLowSince ??= t;
        if (t - this.ewLowSince >= EW_OUT_S) {
          this.ewIn = false;
          say(PHRASES.ewOut, 'info', 'ew');
        }
      } else this.ewLowSince = null;
    }
    const spoof = ew.gnssSpoof ?? 0;
    if (!this.spoofSaid && spoof >= SPOOF_IN) {
      this.spoofSaid = true;
      say(PHRASES.spoof, 'critical', 'spoof');
    } else if (spoof <= SPOOF_OUT) this.spoofSaid = false;

    // Зоны, о которых сказано, забываются только после выхода из всех: дрожь на границе не повторяется.
    const ids = (ew.noflyIds ?? []).map(String);
    const fresh = ids.filter((id) => !this.nofly.has(id));
    for (const id of fresh) this.nofly.add(id);
    if (fresh.length > 0) {
      this.noflyEmptySince = null;
      say(PHRASES.noflyIn, 'critical', 'nofly');
    } else if (this.nofly.size > 0 && ids.length === 0) {
      this.noflyEmptySince ??= t;
      if (t - this.noflyEmptySince >= NOFLY_OUT_S) {
        this.nofly.clear();
        this.noflyEmptySince = null;
        say(PHRASES.noflyOut, 'info', 'nofly');
      }
    } else this.noflyEmptySince = null;
  }
}

type Say = (text: string, priority: CalloutPriority, key: string) => void;
