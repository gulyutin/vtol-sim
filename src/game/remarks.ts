import type { Recording, Sample } from './recorder';

/*
 * Замечания инструктора по записи полёта — то, что оценка сводит в баллы, здесь по месту и времени:
 * где и насколько аппарат ушёл от плана по высоте и в сторону (участок маршрута по плану), как
 * быстро оператор отреагировал на отказ, где и надолго ли терялась связь, как прошла посадка,
 * не кренил ли оператор слишком круто в ручном управлении.
 */

export interface Remark {
  /** Время по часам записи (как Sample.t); null — к полёту в целом. */
  t: number | null;
  level: 'good' | 'warn' | 'bad';
  text: string;
}

/** Событие записи с замечанием инструктора (пульт инструктора пишет его так). */
export const INSTRUCTOR_PREFIX = 'Замечание инструктора: ';
const INSTRUCTOR_RE = /^Замечание инструктора: (.+)$/su;

export interface RemarkInput {
  rec: Recording;
  /**
   * План по порядку полётов: точки маршрута в локальных метрах (up — от начала координат; leg — номер
   * участка исходного маршрута у точек огибания рельефа), подписи участков по этим номерам.
   */
  plans: { path: { east: number; north: number; up: number; leg?: number }[]; legLabels?: string[] }[];
}

/** Высота от плана: столько метров — уже замечание, если держится EPISODE_S. */
const ALT_DEV_M = 40;
const XTE_M = 150;
const EPISODE_S = 15;
/** Реакция на отказ: быстро — до, поздно — после. */
const REACT_GOOD_S = 20;
const REACT_LATE_S = 60;
/** Крен в ручном управлении — не круче. */
const MANUAL_BANK_DEG = 45;
/** Режимы, в которые переходят по решению оператора после отказа. */
const ACTIONS: Record<string, string> = {
  rtl: 'ВОЗВРАТ',
  backtransition: 'посадка на месте',
  failsafe: 'ФЭЙЛСЕЙФ',
  hold: 'ОЖИДАНИЕ',
  manual: 'РУЧНОЙ',
  guided: 'оперативная точка',
};

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

interface Leg {
  plan: number;
  i: number;
  a: { east: number; north: number; up: number };
  b: { east: number; north: number; up: number };
  label: string;
}

/** Ближайший участок плана: отклонение в сторону (м), высота плана в этой точке и сам участок. */
function nearestLeg(legs: readonly Leg[], s: Sample): { leg: Leg; xte: number; planUp: number } | null {
  let best: { leg: Leg; xte: number; planUp: number } | null = null;
  for (const leg of legs) {
    const de = leg.b.east - leg.a.east;
    const dn = leg.b.north - leg.a.north;
    const len2 = de * de + dn * dn;
    const f = len2 > 1 ? Math.max(0, Math.min(1, ((s.east - leg.a.east) * de + (s.north - leg.a.north) * dn) / len2)) : 0;
    const pe = leg.a.east + de * f;
    const pn = leg.a.north + dn * f;
    const xte = Math.hypot(s.east - pe, s.north - pn);
    if (!best || xte < best.xte) best = { leg, xte, planUp: leg.a.up + (leg.b.up - leg.a.up) * f };
  }
  return best;
}

export function flightRemarks(input: RemarkInput): Remark[] {
  const { rec, plans } = input;
  const out: Remark[] = [];
  const s = rec.samples;
  const t0 = s[0]?.t ?? 0;
  const at = (t: number) => `T+${fmtT(Math.max(0, t - t0))}`;
  const legs: Leg[] = plans.flatMap((p, k) =>
    p.path.slice(1).map((b, i) => {
      const a = p.path[i]!;
      const leg = b.leg ?? a.leg ?? i;
      return { plan: k, i, a, b, label: p.legLabels?.[leg] ?? `участок ${leg + 1}` };
    }),
  );

  // Набор и снижение по кругу автопилот делает сам — там высота «не по плану» законно.
  const orbit: [number, number][] = [];
  let open: number | null = null;
  for (const e of rec.events) {
    if (/по кругу/.test(e.text) && !/закончено/.test(e.text)) open ??= e.t;
    else if (open !== null && /(набрана|закончено|продолжаю)/.test(e.text)) {
      orbit.push([open, e.t]);
      open = null;
    }
  }
  if (open !== null) orbit.push([open, Infinity]);
  const inOrbit = (t: number) => orbit.some(([a, b]) => t >= a && t <= b);

  // 1–2. Высота и линия пути на маршруте: эпизоды дольше EPISODE_S.
  if (legs.length) {
    type Ep = { t0: number; t1: number; max: number; label: string };
    const alt: Ep[] = [];
    const xte: Ep[] = [];
    let a: Ep | null = null;
    let x: Ep | null = null;
    const close = (e: Ep | null, list: Ep[]) => {
      if (e && e.t1 - e.t0 >= EPISODE_S) list.push(e);
    };
    for (const p of s) {
      const n = p.mode === 'auto' && !inOrbit(p.t) ? nearestLeg(legs, p) : null;
      const dz = n ? p.up - n.planUp : 0;
      if (n && Math.abs(dz) > ALT_DEV_M && n.xte < 600) {
        if (a && Math.sign(a.max) === Math.sign(dz) && p.t - a.t1 < 5) {
          a.t1 = p.t;
          if (Math.abs(dz) > Math.abs(a.max)) a.max = dz;
        } else {
          close(a, alt);
          a = { t0: p.t, t1: p.t, max: dz, label: n.leg.label };
        }
      } else if (a && p.t - a.t1 >= 5) {
        close(a, alt);
        a = null;
      }
      if (n && n.xte > XTE_M) {
        if (x && p.t - x.t1 < 5) {
          x.t1 = p.t;
          x.max = Math.max(x.max, n.xte);
        } else {
          close(x, xte);
          x = { t0: p.t, t1: p.t, max: n.xte, label: n.leg.label };
        }
      } else if (x && p.t - x.t1 >= 5) {
        close(x, xte);
        x = null;
      }
    }
    close(a, alt);
    close(x, xte);
    for (const e of alt.slice(0, 6)) {
      out.push({
        t: e.t0,
        level: Math.abs(e.max) > 2 * ALT_DEV_M ? 'bad' : 'warn',
        text: `${at(e.t0)} «${e.label}»: ${e.max > 0 ? 'выше' : 'ниже'} плана до ${Math.round(Math.abs(e.max))} м, ${Math.round(e.t1 - e.t0)} с${e.max < 0 ? ' — проверьте запас над рельефом и нисходящие потоки' : ''}`,
      });
    }
    for (const e of xte.slice(0, 6)) {
      out.push({ t: e.t0, level: e.max > 2 * XTE_M ? 'bad' : 'warn', text: `${at(e.t0)} «${e.label}»: уход с линии пути до ${Math.round(e.max)} м, ${Math.round(e.t1 - e.t0)} с` });
    }
  }

  // 3. Реакция на отказы: первая смена режима по решению оператора после отказа.
  for (const e of rec.events) {
    const m = /^ОТКАЗ: (.+)$/.exec(e.text);
    if (!m || /связ/i.test(m[1]!)) continue;
    const i0 = s.findIndex((p) => p.t >= e.t);
    if (i0 < 0) continue;
    const before = s[i0]!.mode;
    const act = s.slice(i0).find((p) => p.mode !== before && p.mode in ACTIONS);
    const ended = s.slice(i0).find((p) => p.mode === 'landed' || p.mode === 'crashed');
    if (act && (!ended || act.t <= ended.t)) {
      const dt = act.t - e.t;
      out.push({
        t: e.t,
        level: dt <= REACT_GOOD_S ? 'good' : dt <= REACT_LATE_S ? 'warn' : 'bad',
        text: `${at(e.t)} отказ «${m[1]}»: ${ACTIONS[act.mode]} через ${Math.round(dt)} с${dt > REACT_GOOD_S ? ' — поздно, по РЛЭ решение — сразу по сигналу' : ''}`,
      });
    } else {
      const flewOn = (ended?.t ?? s[s.length - 1]!.t) - e.t;
      if (flewOn > 60) out.push({ t: e.t, level: 'bad', text: `${at(e.t)} отказ «${m[1]}»: режим не меняли ещё ${fmtT(flewOn)} — задание продолжено с отказом` });
    }
  }

  // 4. Связь: сколько раз терялась и дольше всего.
  const losses: [number, number][] = [];
  let lost: number | null = null;
  for (const e of rec.events) {
    if (/^Нет связи с НСУ/.test(e.text)) lost ??= e.t;
    else if (lost !== null && /Связь с НСУ восстановлена/.test(e.text)) {
      losses.push([lost, e.t]);
      lost = null;
    }
  }
  if (lost !== null) losses.push([lost, s[s.length - 1]?.t ?? lost]);
  if (losses.length) {
    const longest = losses.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    const d = longest[1] - longest[0];
    out.push({
      t: longest[0],
      level: d > 30 ? 'bad' : 'warn',
      text: `Связь терялась ${losses.length} раз${losses.length > 1 && losses.length < 5 ? 'а' : ''}, дольше всего ${Math.round(d)} с (${at(longest[0])}) — выше высота на этом участке или ретранслятор`,
    });
  }

  // 5. Посадка: авария или жёсткая.
  const crash = rec.events.find((e) => /^АВАРИЯ/.test(e.text));
  if (crash) out.push({ t: crash.t, level: 'bad', text: `${at(crash.t)} ${crash.text}` });
  const hard = rec.events.find((e) => /Жёсткая посадка/.test(e.text));
  if (hard) out.push({ t: hard.t, level: 'bad', text: `${at(hard.t)} ${hard.text.replace(/^./, (c) => c.toLowerCase())} — снижение на висении медленнее` });

  // 6. Ручное управление: слишком крутой крен.
  const steep = s.find((p) => (p.mode === 'manual' || p.mode === 'failsafe') && Math.abs(p.bankDeg) > MANUAL_BANK_DEG);
  if (steep) out.push({ t: steep.t, level: 'warn', text: `${at(steep.t)} крен ${Math.round(Math.abs(steep.bankDeg))}° в ручном управлении — круче ${MANUAL_BANK_DEG}° теряется высота и растёт скорость сваливания` });

  // 7. Замечания инструктора, записанные в полёте (пульт инструктора) — как есть, со временем.
  for (const e of rec.events) {
    const m = INSTRUCTOR_RE.exec(e.text);
    if (m) out.push({ t: e.t, level: e.kind === 'bad' ? 'bad' : e.kind === 'info' ? 'good' : 'warn', text: `${at(e.t)} инструктор: ${m[1]}` });
  }

  if (!out.some((r) => r.level !== 'good')) out.push({ t: null, level: 'good', text: 'Замечаний нет: высота и линия пути по плану, связь без перерывов.' });
  return out.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
}
