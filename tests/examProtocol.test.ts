import { describe, expect, it } from 'vitest';
import { admission, PASS_SCORE } from '../src/game/admission';
import type { Recording } from '../src/game/recorder';
import type { Assessment } from '../src/game/scoring';

const rec = (crashed = false): Recording => ({
  version: 1,
  meta: { title: 't', startedAt: '2026-09-18T10:00:00Z', profileTitle: 'p', source: 'sim' },
  samples: [{ t: 0, east: 0, north: 0, up: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0, iasMs: 0, gsMs: 0, vzMs: 0, aglM: 0, powerW: 0, energyWh: 0, soc: 1, mode: crashed ? 'crashed' : 'landed', lift: 0, pusher: 0 }],
  events: [],
});
const a = (total: number): Assessment => ({ total, grade: total >= 85 ? 'отлично' : 'хорошо', items: [] });

describe('допуск по протоколу', () => {
  it('проходной балл, авария, грубые замечания', () => {
    expect(admission(rec(), a(PASS_SCORE), []).pass).toBe(true);
    expect(admission(rec(), a(PASS_SCORE - 1), []).pass).toBe(false);
    expect(admission(rec(true), a(95), []).why).toBe('авария');
    const bad = Array.from({ length: 3 }, () => ({ t: 1, level: 'bad' as const, text: 'x' }));
    expect(admission(rec(), a(90), bad).pass).toBe(false);
    expect(admission(rec(), undefined, []).pass).toBe(false);
  });
});
