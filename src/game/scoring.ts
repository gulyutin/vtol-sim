import { AIRCRAFT } from '../sim/aircraft';
import type { Zone } from '../sim/zones';
import { GROUND_MODES, summarize, type Recording, type RecordingEvent, type Sample } from './recorder';

/*
 * Оценка полёта по записи — как разбор у инструктора: выполнено ли задание и где сели,
 * сохранён ли резерв АКБ, соблюдён ли порядок по РЛЭ (подготовка, АРМ, ДИЗАРМ сразу после
 * касания), не выходили ли за ограничения, как оператор отработал отказы. Сотня баллов
 * делится между критериями; грубые ошибки (авария, посадка мимо района без причины)
 * ограничивают итог сверху — хорошая энергетика не спасает разбитый аппарат.
 */

export type Grade = 'отлично' | 'хорошо' | 'удовлетворительно' | 'неудовлетворительно';

export interface AssessmentItem {
  title: string;
  points: number;
  max: number;
  note: string;
}

export interface Assessment {
  /** 0…100, сумма баллов по пунктам. */
  total: number;
  grade: Grade;
  items: AssessmentItem[];
}

export interface FailureEvent {
  /** Время отказа по часам полёта (как Sample.t), с. */
  t: number;
  id: string;
}

/** Итог поиска людей (src/game/search.ts, SearchWorld.result). */
export interface SearchOutcome {
  /** Сколько людей найдено и сколько было. */
  found: number;
  total: number;
  /** Отметки на звере или на пустом месте. */
  falseMarks: number;
  /** Первая находка — через столько после взлёта, с; null — никого не нашли. */
  firstFoundS: number | null;
  /** Доля района, побывавшая в кадре тепловизора, 0…1. */
  coverage: number;
}

/** Итог лесопожарного патруля (src/game/fire.ts, FireWorld.result). */
export interface FireOutcome {
  /** Сколько пожаров в районе, о скольких доложено по дыму и сколько очагов подтверждено тепловизором. */
  fires: number;
  reported: number;
  located: number;
  /** Огневые точки (угли, перебросы, тлеющие деревья): сколько их и сколько найдено. */
  spots: number;
  spotsFound: number;
  /** Отметки не по огню и донесения не по дыму. */
  falseMarks: number;
  /** Первое донесение (или подтверждённый очаг) — через столько после взлёта, с. */
  firstReportS: number | null;
}

export interface AssessInput {
  rec: Recording;
  scenarioKind: 'transfer' | 'survey' | 'delivery' | 'route' | 'search' | 'fire';
  /** Точка посадки задания, локальные метры. */
  landing: { east: number; north: number };
  landingZoneRadiusM: number;
  /** Доступная ёмкость без резерва и полная, Вт·ч. */
  usableWh: number;
  capacityWh: number;
  /** План: расход и время полёта. */
  plannedWh: number;
  plannedS: number;
  prepRequired: boolean;
  prepDone: boolean;
  failures: FailureEvent[];
  /** Доля участка с годными кадрами 0…1 (съёмка). */
  surveyCoverage?: number;
  /** Груз доставлен (доставка). */
  delivered?: boolean;
  /** Итог поиска людей (поиск): без него пункты поиска — по нулям. */
  search?: SearchOutcome;
  /** Итог лесопожарного патруля: без него пункты патруля — по нулям. */
  fire?: FireOutcome;
  /**
   * Зоны задания: есть запретные — в оценке пункт «Запретные зоны» и без нарушений. Сами
   * нарушения берутся из событий среды в записи (LiveFlight.envEvents).
   */
  zones?: readonly Zone[];
}

/** Названия отказов для разбора; неизвестный id показывается как есть. */
export const FAILURE_TITLES: Record<string, string> = {
  link: 'потеря связи',
  gnss: 'отказ ГНСС',
  airspeed: 'отказ приёмника воздушного давления',
  compass: 'отказ магнитометра',
  aileron: 'отказ элерона',
  elevator: 'отказ руля высоты',
  pusher: 'отказ маршевого двигателя',
  rotor: 'отказ подъёмного ротора',
  vtol: 'отказ вертикальной силовой установки',
  power: 'отказ питания',
  autopilot: 'отказ автопилота',
  fire: 'возгорание',
  stabilization: 'отказ стабилизации',
};

const failureTitle = (id: string) => FAILURE_TITLES[id] ?? id;

/** Режимы, в которые оператор уводит аппарат при отказе. */
const REACTION_MODES = new Set(['rtl', 'backtransition', 'descent', 'final', 'hold', 'manual', 'guided']);
/** Смена режима позже этого после отказа — уже не реакция на него. */
const REACTION_WINDOW_S = 180;
/** «АРМ» отдельным словом: в «ДИЗАРМ» перед ним буква. */
const ARM_RE = /(?<!\p{L})АРМ(?!\p{L})/u;
const DISARM_RE = /ДИЗАРМ/u;
/** События зон и помех: в «Ограничениях» не считаются — у них свои пункты. */
const ENV_RE = /^(РЭБ:|ЗАПРЕТНАЯ ЗОНА:|ГНСС:|Нет связи с НСУ: помехи)/u;
/** Помехи до посадки: вынужденная посадка не в районе оправдана, как при отказе. */
const EW_FORCED_RE = /^(РЭБ:|ГНСС: (нет решения|срыв)|Нет связи с НСУ: помехи)/u;
const NOFLY_IN_RE = /^ЗАПРЕТНАЯ ЗОНА: (вход|борт внутри)/u;
const NOFLY_ENTRY_RE = /^ЗАПРЕТНАЯ ЗОНА: вход/u;
const NOFLY_OUT_RE = /^ЗАПРЕТНАЯ ЗОНА: выход/u;
const EW_ENTER_RE = /^РЭБ: (?:вход в зону|борт внутри новой зоны) /u;
/** Запретная зона: штраф за каждый вход и за время внутри сверх льготного (10 с — балл), итог не выше NOFLY_CAP. */
const NOFLY_ENTRY_PENALTY = 15;
const NOFLY_ENTRY_MAX = 30;
const NOFLY_GRACE_S = 30;
const NOFLY_TIME_MAX = 15;
const NOFLY_CAP = 69;

const fmt = (x: number, digits = 0) => x.toFixed(digits).replace('.', ',');
const clock = (t: number) => {
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * clamp01(k);

export function gradeOf(total: number): Grade {
  if (total >= 85) return 'отлично';
  if (total >= 70) return 'хорошо';
  if (total >= 50) return 'удовлетворительно';
  return 'неудовлетворительно';
}

/** Эпизоды выхода за предел: сколько раз величина пересекала порог вверх. */
function episodes(samples: Sample[], over: (s: Sample) => boolean): { count: number; firstT: number } {
  let count = 0;
  let firstT = NaN;
  let inside = false;
  for (const s of samples) {
    const o = over(s);
    if (o && !inside) {
      count++;
      if (Number.isNaN(firstT)) firstT = s.t;
    }
    inside = o;
  }
  return { count, firstT };
}

/** Входы в запретные зоны и время внутри — по событиям среды между t0 и t1. */
function noflyStats(events: readonly RecordingEvent[], t0: number, t1: number): { entries: number; firstT: number; insideS: number } {
  let entries = 0;
  let firstT = NaN;
  let open = 0;
  let since = 0;
  let insideS = 0;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.t < t0 || e.t > t1) continue;
    if (NOFLY_IN_RE.test(e.text)) {
      if (NOFLY_ENTRY_RE.test(e.text)) {
        entries++;
        if (Number.isNaN(firstT)) firstT = e.t;
      }
      if (open++ === 0) since = e.t;
    } else if (NOFLY_OUT_RE.test(e.text) && open > 0 && --open === 0) insideS += e.t - since;
  }
  if (open > 0) insideS += t1 - since;
  return { entries, firstT, insideS };
}

/** Сколько длились перерывы от события start до события end (незакрытый — до t1). */
function outage(events: readonly RecordingEvent[], start: RegExp, end: RegExp, t1: number): { count: number; s: number } {
  let count = 0;
  let s = 0;
  let from = NaN;
  for (const e of events) {
    if (start.test(e.text)) {
      if (Number.isNaN(from)) {
        from = e.t;
        count++;
      }
    } else if (end.test(e.text) && !Number.isNaN(from)) {
      s += e.t - from;
      from = NaN;
    }
  }
  if (!Number.isNaN(from)) s += t1 - from;
  return { count, s };
}

/** Зоны РЭБ для разбора: куда входили, сколько были без ГНСС и без связи, на сколько уводила подмена. */
function ewSummary(events: readonly RecordingEvent[], t0: number, t1: number): string {
  const ev = events.filter((e) => e.t >= t0 && e.t <= t1).sort((a, b) => a.t - b.t);
  const parts: string[] = [];
  const entered = ev.filter((e) => EW_ENTER_RE.test(e.text)).map((e) => `${e.text.replace(EW_ENTER_RE, '')} на T+${clock(e.t)}`);
  if (entered.length) parts.push(`зона ${entered.slice(0, 4).join(', ')}${entered.length > 4 ? ' …' : ''}`);
  const gnss = outage(ev, /^ГНСС: (нет решения|срыв)/u, /^(ГНСС: повторный захват|Сигнал ГНСС восстановлен)/u, t1);
  if (gnss.count) parts.push(`без ГНСС ${clock(gnss.s)}`);
  const link = outage(ev, /^Нет связи с НСУ: помехи/u, /^Связь с НСУ восстановлена/u, t1);
  if (link.count) parts.push(`без связи из-за помех ${clock(link.s)}`);
  const offsets = ev.map((e) => /^РЭБ: подмена ГНСС прекратилась — место было уведено на (\d+) м/u.exec(e.text)).filter((m) => m !== null);
  if (offsets.length) parts.push(`подмена ГНСС уводила место до ${Math.max(...offsets.map((m) => Number(m[1])))} м`);
  else if (ev.some((e) => /^РЭБ: подмена ГНСС — приёмник захвачен/u.test(e.text))) parts.push('приёмник ГНСС захвачен подменой');
  return parts.join('; ');
}

/**
 * Поиск людей: общие пункты (задание и посадка, точность, энергия, РЛЭ, ограничения, отказы)
 * сжимаются до 60 баллов, остальные 40 — поиск: люди 20, первая находка 6, ложные отметки 8,
 * покрытие района 6.
 */
const SEARCH_BASE_SHARE = 0.6;
/** Штраф за ложную отметку или донесение в патруле, баллов. */
const FIRE_FALSE_PENALTY = 2;
/** Покрытие района, за которое пункт — полностью. */
const SEARCH_COVERAGE_FULL = 0.9;
/** Штраф за ложную отметку (зверь или пусто), баллов. */
const SEARCH_FALSE_PENALTY = 3;

function searchItems(r: SearchOutcome | undefined, plannedS: number): AssessmentItem[] {
  const out: AssessmentItem[] = [];
  // Найдены люди — главное: баллы пропорционально найденным.
  {
    const max = 20;
    if (!r) out.push({ title: 'Найдены люди', points: 0, max, note: 'итога поиска нет' });
    else if (r.total <= 0) out.push({ title: 'Найдены люди', points: max, max, note: 'искать было некого' });
    else out.push({ title: 'Найдены люди', points: max * clamp01(r.found / r.total), max, note: `найдено ${r.found} из ${r.total}${r.found >= r.total ? ' — все' : ''}` });
  }
  // Время до первой находки: до 40 % планового времени полёта — полностью, к 100 % — 2 балла, позже — 1.
  {
    const max = 6;
    if (!r || r.firstFoundS === null) out.push({ title: 'Время до первой находки', points: 0, max, note: 'никого не нашли' });
    else {
      const ref = plannedS > 0 ? plannedS : 1800;
      const k = r.firstFoundS / ref;
      const points = k <= 0.4 ? max : k <= 1 ? lerp(max, 2, (k - 0.4) / 0.6) : 1;
      out.push({ title: 'Время до первой находки', points, max, note: `первая находка на T+${clock(r.firstFoundS)} — ${fmt(k * 100)} % планового времени ${clock(ref)}` });
    }
  }
  // Ложные отметки: зверь или пустое место — минус 3 балла за каждую.
  {
    const max = 8;
    const n = r?.falseMarks ?? 0;
    out.push({ title: 'Ложные отметки', points: Math.max(0, max - SEARCH_FALSE_PENALTY * n), max, note: n ? `ложных отметок: ${n}` : 'ложных отметок нет' });
  }
  // Покрытие района кадрами тепловизора: 90 % — полностью.
  {
    const max = 6;
    const cov = r?.coverage ?? 0;
    out.push({ title: 'Покрытие района', points: max * clamp01(cov / SEARCH_COVERAGE_FULL), max, note: `осмотрено ${fmt(cov * 100)} % района (нужно ${fmt(SEARCH_COVERAGE_FULL * 100)} %)` });
  }
  return out;
}

/**
 * Лесопожарный патруль: общие пункты тоже сжимаются до 60 баллов, остальные 40 — патруль:
 * доложенные дымы 10, подтверждённые очаги 10, огневые точки 10, время до первого донесения 5,
 * ложные отметки и донесения 5.
 */
function fireItems(r: FireOutcome | undefined, plannedS: number): AssessmentItem[] {
  const out: AssessmentItem[] = [];
  const share = (title: string, max: number, done: number, total: number, note: (d: number, t: number) => string) => {
    if (!r) out.push({ title, points: 0, max, note: 'итога патруля нет' });
    else if (total <= 0) out.push({ title, points: max, max, note: 'искать было нечего' });
    else out.push({ title, points: max * clamp01(done / total), max, note: note(done, total) });
  };
  share('Дымы доложены', 10, r?.reported ?? 0, r?.fires ?? 0, (d, t) => `доложено ${d} из ${t} пожаров${d >= t ? ' — все' : ''}`);
  share('Очаги подтверждены', 10, r?.located ?? 0, r?.fires ?? 0, (d, t) => `подтверждено тепловизором ${d} из ${t}`);
  share('Огневые точки', 10, r?.spotsFound ?? 0, r?.spots ?? 0, (d, t) => `найдено ${d} из ${t}`);
  // Время до первого донесения: до 20 % планового времени полёта — полностью, к 100 % — 1 балл.
  {
    const max = 5;
    if (!r || r.firstReportS === null) out.push({ title: 'Время до первого донесения', points: 0, max, note: 'донесений не было' });
    else {
      const ref = plannedS > 0 ? plannedS : 1800;
      const k = r.firstReportS / ref;
      const points = k <= 0.2 ? max : k <= 1 ? lerp(max, 1, (k - 0.2) / 0.8) : 1;
      out.push({ title: 'Время до первого донесения', points, max, note: `первое донесение на T+${clock(r.firstReportS)} — ${fmt(k * 100)} % планового времени ${clock(ref)}` });
    }
  }
  {
    const max = 5;
    const n = r?.falseMarks ?? 0;
    out.push({ title: 'Ложные отметки', points: Math.max(0, max - FIRE_FALSE_PENALTY * n), max, note: n ? `ложных отметок и донесений: ${n}` : 'ложных отметок нет' });
  }
  return out;
}

export function assessFlight(input: AssessInput): Assessment {
  const { rec, landing, landingZoneRadiusM: R, failures } = input;
  const samples = rec.samples;
  const events = rec.events;
  const sum = summarize(rec);
  const td = sum.touchdown;
  const crashed = samples.some((s) => s.mode === 'crashed');
  const landed = !!td && !td.crashed && !crashed;
  const miss = landed ? Math.hypot(td.east - landing.east, td.north - landing.north) : null;
  const flightEndT = td ? td.t : sum.endT;
  // Отказы, которые успели наступить в полёте, — только они оправдывают посадку не там.
  const occurred = failures.filter((f) => f.t >= sum.startT && f.t <= flightEndT);
  // Помехи РЭБ до посадки тоже оправдывают вынужденную посадку не там.
  const forced = occurred.length > 0 || events.some((e) => e.t >= sum.startT && e.t <= flightEndT && EW_FORCED_RE.test(e.text));
  const items: AssessmentItem[] = [];

  // 1. Задание и посадка в точке.
  {
    const max = 25;
    let points = 0;
    let note: string;
    if (crashed) note = 'авария — задание не выполнено';
    else if (!landed) note = 'полёт не закончен посадкой';
    else {
      let task = 1;
      let taskNote: string;
      if (input.scenarioKind === 'survey') {
        const cov = input.surveyCoverage ?? 0;
        task = clamp01(cov / 0.95);
        taskNote = `покрытие ${fmt(cov * 100)} % (нужно 95 %)`;
      } else if (input.scenarioKind === 'delivery') {
        task = input.delivered ? 1 : 0;
        taskNote = input.delivered ? 'груз доставлен' : 'груз не доставлен';
      } else if (input.scenarioKind === 'search') {
        // Итог поиска — своими пунктами ниже; здесь только полёт и посадка.
        const r = input.search;
        taskNote = r ? `поиск проведён, найдено ${r.found} из ${r.total}` : 'поиск проведён';
      } else if (input.scenarioKind === 'fire') {
        const r = input.fire;
        taskNote = r ? `патруль проведён, доложено ${r.reported} из ${r.fires} пожаров` : 'патруль проведён';
      } else taskNote = input.scenarioKind === 'transfer' ? 'перелёт выполнен' : 'маршрут пройден';
      let land: number;
      let landNote: string;
      if (miss! <= R) {
        land = 1;
        landNote = 'посадка в районе';
      } else if (miss! <= 3 * R) {
        land = 0.7;
        landNote = 'посадка рядом с районом';
      } else if (forced) {
        land = 0.6;
        landNote = 'вынужденная посадка вне района';
      } else {
        land = 0.2;
        landNote = 'посадка вне района';
      }
      points = max * task * land;
      note = `${taskNote}; ${landNote}`;
    }
    items.push({ title: 'Задание выполнено, посадка в точке', points, max, note });
  }

  // 2. Точность посадки.
  {
    const max = 15;
    let points = 0;
    let note = 'посадки не было';
    if (miss !== null) {
      if (miss <= R / 4) points = max;
      else if (miss <= R) points = lerp(15, 10, (miss - R / 4) / (0.75 * R));
      else if (miss <= 3 * R) points = lerp(6, 1, (miss - R) / (2 * R));
      note = `промах ${fmt(miss)} м при радиусе района ${fmt(R)} м`;
    }
    items.push({ title: 'Точность посадки', points, max, note });
  }

  // 3. Запас энергии при посадке: резерв АКБ трогать нельзя.
  {
    const max = 15;
    const end = td ? (samples.find((s) => s.t >= td.t) ?? samples[samples.length - 1]) : samples[samples.length - 1];
    const usedWh = end ? end.energyWh : 0;
    const { usableWh, capacityWh } = input;
    const leftWh = capacityWh - usedWh;
    const reserveWh = capacityWh - usableWh;
    let points: number;
    if (usedWh <= usableWh) points = max;
    else if (usedWh < capacityWh) points = 0.4 * max * (1 - (usedWh - usableWh) / Math.max(1, reserveWh));
    else points = 0;
    const parts = [`израсходовано ${fmt(usedWh)} Вт·ч`, `остаток ${fmt(Math.max(0, leftWh))} при резерве ${fmt(reserveWh)}`];
    if (input.plannedWh > 0) {
      const dev = (usedWh / input.plannedWh - 1) * 100;
      parts.push(`план ${fmt(input.plannedWh)} Вт·ч (${dev >= 0 ? '+' : '−'}${fmt(Math.abs(dev))} %)`);
    }
    if (input.plannedS > 0 && sum.airborneS > 0) parts.push(`в воздухе ${clock(sum.airborneS)} при плане ${clock(input.plannedS)}`);
    if (usedWh > usableWh) parts.unshift('резерв АКБ израсходован');
    items.push({ title: 'Запас энергии', points, max, note: parts.join('; ') });
  }

  // 4. Порядок по РЛЭ: подготовка, АРМ перед взлётом, ДИЗАРМ сразу после касания.
  {
    const max = 15;
    let points = 0;
    const notes: string[] = [];
    if (!input.prepRequired) {
      points += 5;
      notes.push('подготовка не требовалась');
    } else if (input.prepDone) {
      points += 5;
      notes.push('подготовка выполнена');
    } else notes.push('предполётная подготовка не выполнена');

    const takeoff = samples.find((s) => !GROUND_MODES.has(s.mode));
    const arm = events.find((e) => ARM_RE.test(e.text));
    if (!takeoff) notes.push('взлёта не было');
    else if (arm && arm.t <= takeoff.t) {
      points += 3;
      notes.push('АРМ перед взлётом');
    } else notes.push('АРМ перед взлётом не зафиксирован');

    if (landed) {
      const dis = events.find((e) => DISARM_RE.test(e.text) && e.t >= td.t - 0.5);
      // Без события — по отсчётам: на земле роторы стоят, когда задизармлен.
      const disT = dis ? dis.t : samples.find((s) => s.t >= td.t && s.mode === 'landed' && s.lift === 0)?.t;
      if (disT === undefined) notes.push('после посадки не задизармлен');
      else {
        const dt = disT - td.t;
        points += dt <= 30 ? 7 : dt <= 120 ? 4 : 2;
        notes.push(`ДИЗАРМ через ${fmt(Math.max(0, dt))} с после касания`);
      }
    } else notes.push('посадки не было');
    items.push({ title: 'Порядок по РЛЭ', points, max, note: notes.join('; ') });
  }

  // 5. Ограничения: предупреждения в журнале событий и выходы за пределы по отсчётам.
  {
    const max = 15;
    const lim = AIRCRAFT.limits;
    // Сообщение о самом отказе нарушением оператора не считается.
    const alerts = events.filter(
      (e) => (e.kind === 'warn' || e.kind === 'bad') && !failures.some((f) => Math.abs(e.t - f.t) <= 1) && !/^Отказ/u.test(e.text) && !ENV_RE.test(e.text),
    );
    const bank = episodes(samples, (s) => Math.abs(s.bankDeg) > lim.maxBankDeg + 1);
    const ias = episodes(samples, (s) => s.iasMs > lim.maxIasMs);
    const inFlightDisarm = events.filter((e) => /ДИЗАРМ в полёте/u.test(e.text)).length;
    const n = alerts.length + bank.count + ias.count + inFlightDisarm;
    const points = crashed ? 0 : Math.max(0, max - 3 * n);
    const notes: string[] = [];
    if (bank.count) notes.push(`крен больше ${lim.maxBankDeg}° — ${bank.count} раз, впервые на T+${clock(bank.firstT)}`);
    if (ias.count) notes.push(`приборная больше ${fmt(lim.maxIasMs, 1)} м/с — ${ias.count} раз`);
    if (inFlightDisarm) notes.push('ДИЗАРМ в полёте');
    if (alerts.length) notes.push(`предупреждений: ${alerts.length}${alerts[0] ? ` («${alerts[0].text}»${alerts.length > 1 ? ' …' : ''})` : ''}`);
    if (crashed) notes.unshift('авария');
    items.push({ title: 'Ограничения', points, max, note: notes.length ? notes.join('; ') : 'нарушений нет' });
  }

  // 6. Действия при отказах: как быстро оператор отреагировал и чем кончилось.
  {
    const max = 15;
    if (!occurred.length) {
      items.push({ title: 'Действия при отказах', points: max, max, note: failures.length ? 'отказы не наступили до посадки' : 'отказов не было' });
    } else {
      const cmds = events.filter((e) => e.kind === 'cmd');
      const notes: string[] = [];
      let score = 0;
      for (const f of occurred) {
        let reaction: { t: number; what: string } | null = null;
        const cmd = cmds.find((e) => e.t >= f.t);
        if (cmd) reaction = { t: cmd.t, what: cmd.text };
        // Команд в записи нет или связь потеряна — реакцией считается уход в режим возврата/посадки,
        // но только в первые REACTION_WINDOW_S: штатная посадка в конце маршрута реакцией не считается.
        if (!cmds.length || f.id === 'link') {
          const before = samples.filter((s) => s.t <= f.t).pop()?.mode;
          const m = samples.find((s) => s.t > f.t && s.t <= f.t + REACTION_WINDOW_S && s.mode !== before && REACTION_MODES.has(s.mode));
          if (m && (!reaction || m.t < reaction.t)) reaction = { t: m.t, what: m.mode };
        }
        let k = 0;
        if (reaction) {
          const dt = reaction.t - f.t;
          k = dt <= 20 ? 1 : dt <= 60 ? lerp(1, 0.5, (dt - 20) / 40) : dt <= 180 ? 0.4 : 0.2;
          notes.push(`${failureTitle(f.id)} на T+${clock(f.t)} — реакция через ${fmt(dt)} с`);
        } else notes.push(`${failureTitle(f.id)} на T+${clock(f.t)} — реакции нет`);
        // Исход: разбит — отработка не удалась, не сел — наполовину.
        score += k * (crashed ? 0 : landed ? 1 : 0.5);
      }
      if (crashed) notes.push('аппарат потерян');
      items.push({ title: 'Действия при отказах', points: (max * score) / occurred.length, max, note: notes.join('; ') });
    }
  }

  // Поиск людей и лесопожарный патруль: общие пункты — 60 баллов из ста, само задание — 40.
  if (input.scenarioKind === 'search' || input.scenarioKind === 'fire') {
    for (const it of items) {
      it.points *= SEARCH_BASE_SHARE;
      it.max = Math.round(it.max * SEARCH_BASE_SHARE * 10) / 10;
    }
    items.push(...(input.scenarioKind === 'search' ? searchItems(input.search, input.plannedS) : fireItems(input.fire, input.plannedS)));
  }

  // 7. Запретные зоны: вход — грубое нарушение, штраф сверх сотни и потолок итога.
  const nf = noflyStats(events, sum.startT, flightEndT);
  if (nf.entries || nf.insideS > 0 || input.zones?.some((z) => z.kind === 'nofly')) {
    const penalty = Math.min(NOFLY_ENTRY_MAX, NOFLY_ENTRY_PENALTY * nf.entries) + Math.min(NOFLY_TIME_MAX, Math.floor(Math.max(0, nf.insideS - NOFLY_GRACE_S) / 10));
    const notes: string[] = [];
    if (nf.entries) notes.push(`вход в запретную зону — ${nf.entries} раз, впервые на T+${clock(nf.firstT)}`);
    if (nf.insideS > 0) notes.push(`в зоне ${clock(nf.insideS)}`);
    items.push({ title: 'Запретные зоны', points: penalty ? -penalty : 0, max: 0, note: notes.length ? notes.join('; ') : 'запретные зоны не нарушены' });
  }

  // 8. Зоны РЭБ — для разбора, без баллов.
  const ew = ewSummary(events, sum.startT, flightEndT);
  if (ew) items.push({ title: 'Зоны РЭБ', points: 0, max: 0, note: ew });

  for (const it of items) it.points = Math.round(it.points * 10) / 10;
  let total = Math.round(items.reduce((s, it) => s + it.points, 0));

  // Грубые ошибки ограничивают итог сверху.
  let cap = 100;
  let capNote = '';
  if (crashed) [cap, capNote] = [20, 'авария'];
  else if (!landed) [cap, capNote] = [45, 'полёт не закончен посадкой'];
  else if (miss! > 3 * R && !forced) [cap, capNote] = [45, 'посадка вне района без отказа'];
  else if (miss! > R && !forced) [cap, capNote] = [69, 'посадка за пределами района'];
  if (nf.entries && cap > NOFLY_CAP) [cap, capNote] = [NOFLY_CAP, 'заход в запретную зону'];
  if (total > cap) {
    items.push({ title: 'Итог ограничен', points: cap - total, max: 0, note: capNote });
    total = cap;
  }
  total = Math.max(0, Math.min(100, total));
  return { total, grade: gradeOf(total), items };
}

/* ---------------------------- Сложность и отказы ---------------------------- */

export type DifficultyId = 'train' | 'normal' | 'hard' | 'exam';
export type WeatherKind = 'calm' | 'breezy' | 'gusty' | 'rain' | 'snow' | 'fog' | 'lowcloud';

export interface Difficulty {
  id: DifficultyId;
  title: string;
  description: string;
  weather: WeatherKind;
  failures: {
    /** Сколько отказов: не меньше count и не больше countMax (по умолчанию ровно count). */
    count: number;
    countMax?: number;
    /** Окно, в котором наступают отказы: секунды от начала полёта. */
    windowS: [number, number];
    pool: string[];
  };
  prepRequired: boolean;
}

export const DIFFICULTY: readonly Difficulty[] = [
  {
    id: 'train',
    title: 'Тренировка',
    description: 'Штиль, без отказов, подготовка по желанию. Освоиться с НСУ и порядком полёта.',
    weather: 'calm',
    failures: { count: 0, windowS: [0, 0], pool: [] },
    prepRequired: false,
  },
  {
    id: 'normal',
    title: 'Штатный полёт',
    description: 'Умеренный ветер, обязательная предполётная подготовка, возможен один несложный отказ датчика.',
    weather: 'breezy',
    failures: { count: 0, countMax: 1, windowS: [180, 1500], pool: ['airspeed', 'compass', 'gnss', 'link'] },
    prepRequired: true,
  },
  {
    id: 'hard',
    title: 'Сложные условия',
    description: 'Порывистый ветер, один-два отказа датчиков, связи или рулей. Нужна своевременная реакция.',
    weather: 'gusty',
    failures: {
      count: 1,
      countMax: 2,
      windowS: [120, 1800],
      pool: ['link', 'gnss', 'airspeed', 'compass', 'aileron', 'elevator', 'pusher', 'power', 'stabilization'],
    },
    prepRequired: true,
  },
  {
    id: 'exam',
    title: 'Зачёт',
    description: 'Дождь и низкая облачность, один-два серьёзных отказа силовой установки или систем. Оценка — как у инструктора.',
    weather: 'rain',
    failures: {
      count: 1,
      countMax: 2,
      windowS: [120, 1800],
      pool: ['pusher', 'rotor', 'vtol', 'power', 'autopilot', 'fire', 'aileron', 'elevator', 'stabilization', 'link'],
    },
    prepRequired: true,
  },
];

export function findDifficulty(id: string): Difficulty {
  return DIFFICULTY.find((d) => d.id === id) ?? DIFFICULTY[0]!;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Какие отказы и когда: один seed — один и тот же набор. Окно обрезается по плановой
 * длительности полёта (до 80 %), чтобы отказ пришёлся на полёт, а не на стоянку после посадки.
 */
export function planFailures(d: Difficulty, seed: number, flightDurationS: number): FailureEvent[] {
  const { count, countMax = count, windowS, pool } = d.failures;
  if (!pool.length || countMax <= 0) return [];
  let salt = 0;
  for (const ch of d.id) salt = (Math.imul(salt, 31) + ch.charCodeAt(0)) | 0;
  const r = rng(seed ^ salt);
  const n = Math.min(pool.length, count + Math.floor(r() * (countMax - count + 1)));
  if (n <= 0) return [];
  const hi = flightDurationS > 0 ? Math.min(windowS[1], flightDurationS * 0.8) : windowS[1];
  const lo = Math.min(windowS[0], hi * 0.5);
  // Без повторов: перемешать пул и взять первые n.
  const ids = pool.slice();
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    // Между отказами хотя бы минута, если окно позволяет, — иначе второй теряется в первом.
    let t = lo + r() * (hi - lo);
    for (let k = 0; k < 8 && times.some((x) => Math.abs(x - t) < 60); k++) t = lo + r() * (hi - lo);
    times.push(Math.round(t));
  }
  times.sort((a, b) => a - b);
  return ids.slice(0, n).map((id, i) => ({ t: times[i]!, id }));
}

/* ---------------------------------- Итоги ---------------------------------- */

export interface ResultEntry {
  /** ISO-время полёта. */
  at: string;
  scenarioId?: string;
  scenarioTitle?: string;
  difficulty?: string;
  total: number;
  grade: Grade;
  durationS?: number;
}

const RESULTS_KEY = 'vtol-sim:results';
const RESULTS_MAX = 100;

/** Ядро собирается без DOM-типов: хранилище берём через globalThis, если оно есть. */
type KeyValueStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const store = () => (globalThis as { localStorage?: KeyValueStore }).localStorage;

/** Итоги прошлых полётов, новые первыми. Без localStorage (тесты, приватный режим) — пусто. */
export function loadResults(): ResultEntry[] {
  try {
    const ls = store();
    if (!ls) return [];
    const raw = JSON.parse(ls.getItem(RESULTS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is ResultEntry => typeof r === 'object' && r !== null && typeof r.at === 'string' && typeof r.total === 'number' && typeof r.grade === 'string',
    );
  } catch {
    return [];
  }
}

export function saveResult(r: ResultEntry): void {
  try {
    const ls = store();
    if (!ls) return;
    ls.setItem(RESULTS_KEY, JSON.stringify([r, ...loadResults()].slice(0, RESULTS_MAX)));
  } catch {
    // Хранилище переполнено или запрещено — итог просто не сохранится.
  }
}
