import { summarize, type Recording } from './recorder';
import type { Assessment, AssessmentItem } from './scoring';

/*
 * Вывод о полёте одним абзацем — в отчёте после посадки и в разборе записи. Опирается на запись
 * и, если есть, на оценку; без оценки (бортовой журнал, разбор посреди полёта) — только на запись.
 */

export interface ConclusionInput {
  rec: Recording;
  assessment?: Assessment;
  /** Энергия по плану, доступная без резерва и полная ёмкость АКБ, Вт·ч. */
  plannedWh?: number;
  usableWh?: number;
  capacityWh?: number;
}

/** Что знает о полёте хозяин окна разбора, кроме записи и оценки. */
export type ConclusionContext = Omit<ConclusionInput, 'rec' | 'assessment'>;

/** Совет по самому слабому пункту оценки. */
const ADVICE: Record<string, string> = {
  'Задание выполнено, посадка в точке': 'довести задание до конца и сесть в районе посадки',
  'Точность посадки': 'точнее выводить аппарат на точку посадки',
  'Запас энергии': 'точнее планировать энергию и не трогать резерв АКБ',
  'Порядок по РЛЭ': 'строже соблюдать порядок по РЛЭ',
  Ограничения: 'пилотировать плавнее и держаться в ограничениях',
  'Действия при отказах': 'быстрее действовать при особых случаях — по таблице РЛЭ',
};
/** Пункты, о которых вывод говорит отдельно. */
const TASK = 'Задание выполнено, посадка в точке';
const COVERED = new Set([TASK, 'Точность посадки', 'Запас энергии']);

const fmt = (x: number, digits = 0) => x.toFixed(digits).replace('.', ',');
const clock = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** Длительность словами: «14 мин 20 с», «1 ч 05 мин». */
function duration(t: number): string {
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  if (m) return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`;
  return `${s} с`;
}
const distance = (m: number) => (m >= 1000 ? `${fmt(m / 1000, 1)} км` : `${fmt(m)} м`);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Первая буква строчная, если это не аббревиатура («ГНСС» остаётся). */
const lower = (s: string) => (/^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const full = (i: AssessmentItem | undefined) => !!i && i.points >= i.max;

export function flightConclusion(input: ConclusionInput): string {
  const { rec, assessment: a } = input;
  const sum = summarize(rec);
  const td = sum.touchdown;
  const item = (title: string) => a?.items.find((i) => i.title === title);
  const out: string[] = [];

  // Чем кончился полёт.
  const title = `«${rec.meta.title}»`;
  if (!sum.airborneS) {
    out.push(`${title}: взлёта не было.`);
  } else {
    const flown = `в воздухе ${duration(sum.airborneS)}, пройдено ${distance(sum.distanceM)}`;
    if (td?.crashed) {
      const cause = [...rec.events].reverse().find((e) => e.kind === 'bad' && e.t <= td.t + 1);
      out.push(`${title}: авария на T+${clock(td.t)}${cause ? ` (${lower(cause.text)})` : ''}; ${flown}.`);
    } else if (td) {
      const m = sum.landingMissM;
      const miss = m === null ? '' : m < 1 ? ', точно в точку' : `, в ${fmt(m)} м от точки`;
      out.push(`${title}: ${item(TASK)?.note ?? 'полёт завершён посадкой'}${miss}; ${flown}.`);
    } else out.push(`${title}: полёт не закончен посадкой — ${flown}.`);

    // Энергия.
    const end = td ? rec.samples.find((s) => s.t >= td.t) : rec.samples[rec.samples.length - 1];
    const usedWh = end?.energyWh ?? sum.energyWh;
    const energy = [`израсходовано ${fmt(usedWh)} Вт·ч`];
    if (input.plannedWh) {
      const dev = (usedWh / input.plannedWh - 1) * 100;
      energy.push(Math.abs(dev) < 3 ? 'как по плану' : `на ${fmt(Math.abs(dev))} % ${dev > 0 ? 'больше' : 'меньше'} плана`);
    }
    if (input.usableWh !== undefined && input.capacityWh) {
      const left = `${td && !td.crashed ? 'на посадке ' : ''}осталось ${fmt(Math.max(0, 1 - usedWh / input.capacityWh) * 100)} % заряда`;
      energy.push(usedWh > input.usableWh ? `резерв АКБ тронут, ${left}` : left);
    } else energy.push(`минимальный заряд ${fmt(sum.minSoc * 100)} %`);
    out.push(`${capitalize(energy.join(', '))}.`);
  }

  if (!a) {
    if (sum.airborneS) out.push(`Наибольший крен ${fmt(sum.maxBankDeg)}°, высота до ${fmt(sum.maxAglM)} м над рельефом, приборная до ${fmt(sum.maxIasMs, 1)} м/с.`);
    return out.join(' ');
  }

  // Порядок, ограничения, особые случаи и прочие пункты оценки — что было не так.
  const order = item('Порядок по РЛЭ');
  const limits = item('Ограничения');
  const ok: string[] = [];
  if (full(order)) ok.push('порядок по РЛЭ соблюдён');
  if (full(limits)) ok.push('ограничения не нарушались');
  if (ok.length) out.push(`${capitalize(ok.join(', '))}.`);
  if (order && !full(order)) out.push(`Порядок по РЛЭ: ${order.note}.`);
  if (limits && !full(limits)) out.push(`Ограничения: ${limits.note}.`);
  const failures = item('Действия при отказах');
  if (failures && !/^отказ(ов не было|ы не наступили)/u.test(failures.note)) out.push(`Особые случаи: ${failures.note}.`);
  for (const i of a.items) {
    if (i.max > 0 && i.points < i.max && !COVERED.has(i.title) && i !== order && i !== limits && i !== failures) out.push(`${i.title}: ${i.note}.`);
  }

  // Итог и совет по самому слабому месту.
  const capped = a.items.find((i) => i.max === 0);
  const weak = a.items.filter((i) => i.max > 0 && i.points < 0.7 * i.max).sort((x, y) => x.points / x.max - y.points / y.max)[0];
  const verdict = `Итог — ${a.total} из 100, «${a.grade}»${capped ? ` (ограничен: ${capped.note})` : ''}`;
  out.push(weak ? `${verdict}; в следующий раз — ${ADVICE[weak.title] ?? `обратить внимание: ${lower(weak.title)}`}.` : `${verdict}${a.total >= 85 ? ': полёт выполнен чисто' : ''}.`);
  return out.join(' ');
}
