import type { LiveState } from '../sim/flight';
import type { GeoPoint } from '../sim/types';
import { isZone, type Zone } from '../sim/zones';
import type { Surfaces } from './surfaces';

/*
 * Запись полёта для разбора: компактные отсчёты состояния с постоянной частотой плюс
 * события. Смена режима пишется всегда, даже между отсчётами, — иначе на графиках
 * и в повторе съедаются короткие фазы (переход, касание). Числа округляются при записи:
 * запись в памяти совпадает с сохранённой в файл, а файл выходит втрое короче.
 */

export type EventKind = 'info' | 'warn' | 'bad' | 'cmd';

/**
 * Вид события по тексту — для событий LiveFlight.events и envEvents: авария, отказ и вход в
 * запретную зону — bad; помехи РЭБ и прочие события зон — warn (в оценке их считают отдельно).
 */
export function eventKindOf(text: string): EventKind {
  if (/^(АВАРИЯ|ОТКАЗ|ЗАПРЕТНАЯ ЗОНА: вход)/u.test(text)) return 'bad';
  if (/^(РЭБ:|ЗАПРЕТНАЯ ЗОНА:|ГНСС: (нет решения|срыв)|Нет связи с НСУ: помехи)/u.test(text)) return 'warn';
  return 'info';
}

/**
 * Отсчёт состояния. Локальные метры — восток, север, вверх от площадки взлёта. Рули (Surfaces) —
 * только в записях бортового журнала: команды автопилота.
 */
export interface Sample extends Partial<Surfaces> {
  t: number;
  east: number;
  north: number;
  up: number;
  headingDeg: number;
  /** Тангаж, °; нос вверх — плюс. */
  pitchDeg: number;
  bankDeg: number;
  iasMs: number;
  gsMs: number;
  vzMs: number;
  aglM: number;
  powerW: number;
  energyWh: number;
  /** Заряд 0…1. */
  soc: number;
  /** Режим — как LiveMode в src/sim/flight.ts; у внешних записей может быть и другим. */
  mode: string;
  /** Загрузка подъёмных роторов и маршевого винта 0…1. */
  lift: number;
  pusher: number;
  /** Связь (не во всех записях): мощность приёма на борту, дБм, и качество приёма, %. */
  rxDbm?: number;
  linkPct?: number;
}

/** Необязательные поля отсчёта — рули и связь — и знаков после запятой при записи. */
const OPT_DIGITS = { ailL: 3, ailR: 3, tailL: 3, tailR: 3, rxDbm: 1, linkPct: 0 } as const satisfies Partial<Record<keyof Sample, number>>;
export const OPT_KEYS = Object.keys(OPT_DIGITS) as (keyof typeof OPT_DIGITS)[];

export interface RecordingEvent {
  t: number;
  text: string;
  /** info | warn | bad | cmd (команда оператора); у внешних записей — любая строка. */
  kind?: string;
}

export interface RecordingMeta {
  title: string;
  scenarioId?: string;
  /** ISO-время начала. */
  startedAt: string;
  profileTitle: string;
  source: 'sim' | 'log';
  /** Точка посадки задания в локальных метрах — для промаха в разборе. */
  landing?: { east: number; north: number };
  difficulty?: string;
  /** Запретные зоны и зоны РЭБ на конец полёта — чтобы нарисовать их в разборе. */
  zones?: Zone[];
  /**
   * Где записан полёт: точка отсчёта локальных координат (место взлёта). Нет — площадка района,
   * в котором сделана запись (записи симулятора).
   */
  origin?: GeoPoint;
  /** Ветер по бортовому журналу, средний в полёте: м/с и откуда дует, °. */
  wind?: { speedMs: number; fromDeg: number };
}

export interface Recording {
  version: 1;
  meta: RecordingMeta;
  samples: Sample[];
  events: RecordingEvent[];
}

/** Порядок полей отсчёта в файле: отсчёты хранятся строками без имён полей. */
const NUM_KEYS = [
  't',
  'east',
  'north',
  'up',
  'headingDeg',
  'pitchDeg',
  'bankDeg',
  'iasMs',
  'gsMs',
  'vzMs',
  'aglM',
  'powerW',
  'energyWh',
  'soc',
  'lift',
  'pusher',
] as const satisfies readonly (keyof Sample)[];
type NumKey = (typeof NUM_KEYS)[number];

/** Знаков после запятой по полям: сантиметры, десятые градуса, ватты. */
const DIGITS: Record<NumKey, number> = {
  t: 2,
  east: 2,
  north: 2,
  up: 2,
  headingDeg: 1,
  pitchDeg: 1,
  bankDeg: 1,
  iasMs: 2,
  gsMs: 2,
  vzMs: 2,
  aglM: 2,
  powerW: 0,
  energyWh: 3,
  soc: 4,
  lift: 3,
  pusher: 3,
};

const round = (x: number, digits: number) => {
  const k = 10 ** digits;
  // +0 убирает −0: иначе после JSON запись не совпадает сама с собой.
  return Math.round(x * k) / k + 0;
};
const norm360 = (d: number) => ((d % 360) + 360) % 360;
const wrap180 = (d: number) => norm360(d + 180) - 180;
const RAD = Math.PI / 180;

/** Округлить отсчёт до точности записи. */
export function compactSample(s: Sample): Sample {
  const out = { mode: s.mode } as Sample;
  for (const k of NUM_KEYS) out[k] = round(k === 'headingDeg' ? norm360(s[k]) : s[k], DIGITS[k]);
  if (out.headingDeg >= 360) out.headingDeg = 0;
  for (const k of OPT_KEYS) {
    const x = s[k];
    if (x !== undefined) out[k] = round(x, OPT_DIGITS[k]);
  }
  return out;
}

/** Режимы, в которых аппарат летит по-самолётному, — для тангажа по траектории. */
const PLANE_MODES = new Set(['transition', 'auto', 'guided', 'manual', 'hold', 'rtl', 'backtransition', 'falling']);

/** Отсчёт из живого состояния. Тангажа в LiveState нет — берём наклон траектории, как 3D-вид. */
export function sampleOf(s: LiveState): Sample {
  const extra = s as LiveState & { pitchDeg?: number };
  const pitchDeg =
    typeof extra.pitchDeg === 'number'
      ? extra.pitchDeg
      : (PLANE_MODES.has(s.mode) || (s.mode === 'failsafe' && s.failsafePhase === 'plane')) && s.groundSpeedMs > 3
        ? Math.atan2(s.vzMs, s.groundSpeedMs) / RAD + 2
        : 0;
  return compactSample({
    t: s.t,
    east: s.east,
    north: s.north,
    up: s.up,
    headingDeg: s.headingDeg,
    pitchDeg,
    bankDeg: s.bankDeg,
    iasMs: s.iasMs,
    gsMs: s.groundSpeedMs,
    vzMs: s.vzMs,
    aglM: s.aglM,
    powerW: s.powerW,
    energyWh: s.energyWh,
    soc: s.soc,
    mode: s.mode,
    lift: s.lift,
    pusher: s.pusher,
    // Связь по модели радиоканала — чтобы сравнить с журналом, где она записана.
    ...(s.link ? { rxDbm: s.link.rssiDbm, linkPct: s.linkQuality * 100 } : {}),
  });
}

export class FlightRecorder {
  private readonly intervalS: number;
  private samples: Sample[] = [];
  private events: RecordingEvent[] = [];

  constructor(opts: { hz?: number } = {}) {
    const hz = opts.hz ?? 2;
    if (!(hz > 0)) throw new Error('Частота записи должна быть больше нуля');
    this.intervalS = 1 / hz;
  }

  /** Сколько отсчётов записано. */
  get length(): number {
    return this.samples.length;
  }

  /**
   * Вызывать хоть на каждом шаге симуляции: лишнее отбрасывается по s.t. Смена режима
   * пишется всегда. Время назад (новый полёт без reset) — начинает запись заново.
   */
  sample(s: LiveState): void {
    const last = this.samples[this.samples.length - 1];
    if (last && s.t < last.t) this.samples = [];
    const prev = this.samples[this.samples.length - 1];
    if (!prev) {
      this.samples.push(sampleOf(s));
      return;
    }
    const modeChanged = s.mode !== prev.mode;
    if (s.t === prev.t) {
      // Тот же момент (пауза или несколько вызовов за шаг) — последнее состояние вернее.
      if (modeChanged) this.samples[this.samples.length - 1] = sampleOf(s);
      return;
    }
    // Допуск на погрешность шага: 0.1 с × 5 не всегда ровно 0.5.
    if (modeChanged || s.t - prev.t >= this.intervalS - 1e-6) this.samples.push(sampleOf(s));
  }

  event(t: number, text: string, kind: EventKind = 'info'): void {
    this.events.push({ t: round(t, 2), text, kind });
  }

  toRecording(meta: RecordingMeta): Recording {
    return {
      version: 1,
      meta: { ...meta },
      samples: this.samples.slice(),
      events: this.events.slice().sort((a, b) => a.t - b.t),
    };
  }

  reset(): void {
    this.samples = [];
    this.events = [];
  }
}

/** Индекс последнего отсчёта с t ≤ time (0, если time раньше начала). */
export function indexAt(rec: Recording, time: number): number {
  const s = rec.samples;
  let lo = 0;
  let hi = s.length - 1;
  if (hi < 0) return -1;
  if (time <= s[0]!.t) return 0;
  if (time >= s[hi]!.t) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.t <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Состояние на момент t: числа — линейно между соседними отсчётами, курс — по кратчайшей
 * дуге (через север, а не через юг), режим — от предыдущего отсчёта.
 */
export function stateAt(rec: Recording, t: number): Sample {
  const i = indexAt(rec, t);
  if (i < 0) throw new Error('Запись пуста');
  const a = rec.samples[i]!;
  const b = rec.samples[i + 1];
  if (!b || t <= a.t) return { ...a };
  const k = Math.min(1, (t - a.t) / (b.t - a.t));
  const out = { mode: a.mode } as Sample;
  for (const key of NUM_KEYS) out[key] = a[key] + (b[key] - a[key]) * k;
  for (const key of OPT_KEYS) {
    const x = a[key];
    const y = b[key];
    if (x !== undefined && y !== undefined) out[key] = x + (y - x) * k;
  }
  out.t = t;
  out.headingDeg = norm360(a.headingDeg + wrap180(b.headingDeg - a.headingDeg) * k);
  out.bankDeg = a.bankDeg + wrap180(b.bankDeg - a.bankDeg) * k;
  return out;
}

/** Поза для 3D-повтора (world.setPose) из отсчёта; lift / pusher — для aircraft.animate. */
export function poseOf(s: Sample) {
  return {
    position: { east: s.east, north: s.north, up: s.up },
    headingDeg: s.headingDeg,
    pitchDeg: s.pitchDeg,
    bankDeg: s.bankDeg,
  };
}

export function durationS(rec: Recording): number {
  const s = rec.samples;
  return s.length ? s[s.length - 1]!.t - s[0]!.t : 0;
}

/** Режимы на земле: в них полёта нет. */
export const GROUND_MODES: ReadonlySet<string> = new Set(['ground', 'landed', 'crashed']);

export interface RecordingSummary {
  startT: number;
  endT: number;
  durationS: number;
  /** Время от первого отсчёта в воздухе до последнего. */
  airborneS: number;
  /** Путь над землёй по отсчётам, м. */
  distanceM: number;
  energyWh: number;
  maxBankDeg: number;
  maxAglM: number;
  maxIasMs: number;
  minSoc: number;
  /** Где и когда аппарат оказался на земле в конце: режим landed или crashed. */
  touchdown: { t: number; east: number; north: number; crashed: boolean } | null;
  /** Промах от meta.landing, если она известна и была посадка. */
  landingMissM: number | null;
}

export function summarize(rec: Recording): RecordingSummary {
  const s = rec.samples;
  const first = s[0];
  const last = s[s.length - 1];
  let distanceM = 0;
  let maxBankDeg = 0;
  let maxAglM = 0;
  let maxIasMs = 0;
  let minSoc = first ? first.soc : 1;
  let airStart = -1;
  let airEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const p = s[i]!;
    if (i > 0) distanceM += Math.hypot(p.east - s[i - 1]!.east, p.north - s[i - 1]!.north);
    maxBankDeg = Math.max(maxBankDeg, Math.abs(p.bankDeg));
    maxAglM = Math.max(maxAglM, p.aglM);
    maxIasMs = Math.max(maxIasMs, p.iasMs);
    minSoc = Math.min(minSoc, p.soc);
    if (!GROUND_MODES.has(p.mode)) {
      if (airStart < 0) airStart = p.t;
      airEnd = p.t;
    }
  }
  let touchdown: RecordingSummary['touchdown'] = null;
  if (last && (last.mode === 'landed' || last.mode === 'crashed')) {
    // Первый отсчёт последнего «наземного» участка — момент касания.
    let j = s.length - 1;
    while (j > 0 && s[j - 1]!.mode === last.mode) j--;
    const p = s[j]!;
    touchdown = { t: p.t, east: p.east, north: p.north, crashed: last.mode === 'crashed' };
  }
  const L = rec.meta.landing;
  return {
    startT: first?.t ?? 0,
    endT: last?.t ?? 0,
    durationS: durationS(rec),
    airborneS: airStart >= 0 ? airEnd - airStart : 0,
    distanceM,
    energyWh: first && last ? last.energyWh - first.energyWh : 0,
    maxBankDeg,
    maxAglM,
    maxIasMs,
    minSoc,
    touchdown,
    landingMissM: touchdown && L ? Math.hypot(touchdown.east - L.east, touchdown.north - L.north) : null,
  };
}

/** В файл: JSON, отсчёты — строками по столбцам (втрое короче объектов). */
export function serialize(rec: Recording): string {
  // Необязательные поля (рули, связь): столбцы есть, если они есть хоть у одного отсчёта.
  const opt = OPT_KEYS.filter((k) => rec.samples.some((s) => s[k] !== undefined));
  const rows = rec.samples.map((s) => [...NUM_KEYS.map((k) => s[k]), ...opt.map((k) => s[k] ?? null), s.mode]);
  return JSON.stringify({ version: rec.version, meta: rec.meta, columns: [...NUM_KEYS, ...opt, 'mode'], rows, events: rec.events });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Разобрать файл записи (serialize или отсчёты объектами). Ошибка — с понятным текстом. */
export function parseRecording(text: string): Recording {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Файл записи повреждён: это не JSON');
  }
  if (!isObj(raw)) throw new Error('Файл записи повреждён');
  if (raw.version !== 1) throw new Error(`Неизвестная версия записи: ${String(raw.version)}`);

  const m = raw.meta;
  if (!isObj(m) || typeof m.title !== 'string' || typeof m.startedAt !== 'string' || typeof m.profileTitle !== 'string')
    throw new Error('В записи нет заголовка');
  if (m.source !== 'sim' && m.source !== 'log') throw new Error('Неизвестный источник записи');
  const meta: RecordingMeta = { title: m.title, startedAt: m.startedAt, profileTitle: m.profileTitle, source: m.source };
  if (typeof m.scenarioId === 'string') meta.scenarioId = m.scenarioId;
  if (typeof m.difficulty === 'string') meta.difficulty = m.difficulty;
  if (isObj(m.landing) && num(m.landing.east) && num(m.landing.north)) meta.landing = { east: m.landing.east, north: m.landing.north };
  if (Array.isArray(m.zones)) meta.zones = m.zones.filter(isZone);
  if (isObj(m.origin) && num(m.origin.lat) && num(m.origin.lon)) meta.origin = { lat: m.origin.lat, lon: m.origin.lon };
  if (isObj(m.wind) && num(m.wind.speedMs) && num(m.wind.fromDeg)) meta.wind = { speedMs: m.wind.speedMs, fromDeg: m.wind.fromDeg };

  let objects: Record<string, unknown>[];
  if (Array.isArray(raw.rows)) {
    const cols = raw.columns;
    if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string')) throw new Error('В записи нет списка столбцов');
    objects = raw.rows.map((row, i) => {
      if (!Array.isArray(row) || row.length !== cols.length) throw new Error(`Отсчёт ${i + 1}: неверное число полей`);
      return Object.fromEntries(cols.map((c, j) => [c, row[j]]));
    });
  } else if (Array.isArray(raw.samples)) {
    objects = raw.samples.map((s, i) => {
      if (!isObj(s)) throw new Error(`Отсчёт ${i + 1} повреждён`);
      return s;
    });
  } else throw new Error('В записи нет отсчётов');

  const samples = objects.map((o, i) => {
    const s = { mode: o.mode } as Sample;
    if (typeof s.mode !== 'string') throw new Error(`Отсчёт ${i + 1}: нет режима`);
    for (const k of NUM_KEYS) {
      const v = o[k];
      if (!num(v)) throw new Error(`Отсчёт ${i + 1}: поле ${k} не число`);
      s[k] = v;
    }
    // Рули и связь — необязательные столбцы.
    for (const k of OPT_KEYS) {
      const v = o[k];
      if (num(v)) s[k] = v;
    }
    return s;
  });
  if (samples.length === 0) throw new Error('В записи нет отсчётов');
  for (let i = 1; i < samples.length; i++)
    if (samples[i]!.t < samples[i - 1]!.t) throw new Error(`Отсчёт ${i + 1}: время идёт назад`);

  const evs = raw.events ?? [];
  if (!Array.isArray(evs)) throw new Error('События записи повреждены');
  const events = evs.map((e, i) => {
    if (!isObj(e) || !num(e.t) || typeof e.text !== 'string') throw new Error(`Событие ${i + 1} повреждено`);
    const ev: RecordingEvent = { t: e.t, text: e.text };
    if (typeof e.kind === 'string') ev.kind = e.kind;
    return ev;
  });
  return { version: 1, meta, samples, events };
}
