import type { Remark } from './remarks';
import type { Recording } from './recorder';
import type { Assessment } from './scoring';

/*
 * Допуск оператора по итогам проверочного полёта (протокол — src/ui/examProtocol.ts): не меньше
 * PASS_SCORE баллов, без аварии и без трёх и больше грубых замечаний.
 */

/** Проходной балл для допуска. */
export const PASS_SCORE = 70;

/** Итог: допущен ли и почему нет. */
export function admission(rec: Recording, a: Assessment | undefined, remarks: readonly Remark[]): { pass: boolean; why: string } {
  const crashed = rec.samples.some((s) => s.mode === 'crashed');
  if (!a) return { pass: false, why: 'оценки нет — полёт не закончен' };
  if (crashed) return { pass: false, why: 'авария' };
  if (a.total < PASS_SCORE) return { pass: false, why: `${a.total} баллов — меньше ${PASS_SCORE}` };
  const gross = remarks.filter((r) => r.level === 'bad').length;
  if (gross >= 3) return { pass: false, why: `${gross} грубых замечания` };
  return { pass: true, why: `${a.total} баллов, ${a.grade}` };
}
