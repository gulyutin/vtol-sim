import { describe, expect, it } from 'vitest';
import { flightConclusion } from '../src/game/flightSummary';
import type { Recording, Sample } from '../src/game/recorder';
import type { Assessment } from '../src/game/scoring';

const sample = (t: number, mode: string, east: number, energyWh: number): Sample => {
  const air = mode !== 'landed' && mode !== 'crashed';
  return { t, east, north: 0, up: 0, headingDeg: 90, pitchDeg: 0, bankDeg: 10, iasMs: air ? 22 : 0, gsMs: air ? 22 : 0, vzMs: 0, aglM: air ? 150 : 0, powerW: 900, energyWh, soc: 1 - energyWh / 1000, mode, lift: 0, pusher: 0.5 };
};

/** Десять минут по прямой на восток, в конце — посадка или авария. */
function recording(end: 'landed' | 'crashed' | 'ground'): Recording {
  const samples = [sample(0, 'landed', 0, 0)];
  if (end !== 'ground') {
    for (let t = 10; t <= 600; t += 10) samples.push(sample(t, 'auto', (t - 10) * 20, t * 0.5));
    samples.push(sample(610, end, 11800, 305), sample(640, end, 11800, 305));
  } else samples.push(sample(60, 'landed', 0, 1));
  return {
    version: 1,
    meta: { title: 'Перелёт А → Б', startedAt: '2026-06-20T08:00:00Z', profileTitle: 'демо', source: 'sim', landing: { east: 11803, north: 0 } },
    samples,
    events: end === 'crashed' ? [{ t: 609, text: 'Удар о землю', kind: 'bad' }] : [],
  };
}

const assessment: Assessment = {
  total: 92,
  grade: 'отлично',
  items: [
    { title: 'Задание выполнено, посадка в точке', points: 25, max: 25, note: 'перелёт выполнен; посадка в районе' },
    { title: 'Точность посадки', points: 15, max: 15, note: 'промах 3 м при радиусе района 20 м' },
    { title: 'Запас энергии', points: 15, max: 15, note: 'израсходовано 305 Вт·ч' },
    { title: 'Порядок по РЛЭ', points: 12, max: 15, note: 'подготовка не требовалась; АРМ перед взлётом; ДИЗАРМ через 95 с после касания' },
    { title: 'Ограничения', points: 15, max: 15, note: 'нарушений нет' },
    { title: 'Действия при отказах', points: 10, max: 15, note: 'отказ ГНСС на T+5:00 — реакция через 40 с' },
  ],
};

describe('вывод о полёте', () => {
  it('после посадки — один абзац: исход, энергия, замечания, итог и совет', () => {
    const text = flightConclusion({ rec: recording('landed'), assessment, plannedWh: 300, usableWh: 900, capacityWh: 1000 });
    expect(text).not.toContain('\n');
    expect(text).toContain('«Перелёт А → Б»: перелёт выполнен; посадка в районе, в 3 м от точки');
    expect(text).toMatch(/в воздухе \d+ мин/);
    expect(text).toContain('пройдено 11,8 км');
    expect(text).toContain('Израсходовано 305 Вт·ч, как по плану, на посадке осталось');
    expect(text).toContain('Ограничения не нарушались.');
    expect(text).toContain('Порядок по РЛЭ: подготовка не требовалась');
    expect(text).toContain('Особые случаи: отказ ГНСС на T+5:00');
    expect(text).toContain('Итог — 92 из 100, «отлично»; в следующий раз — быстрее действовать при особых случаях');
  });

  it('авария без оценки — время и причина, остальное по записи', () => {
    const text = flightConclusion({ rec: recording('crashed') });
    expect(text).toContain('авария на T+10:10 (удар о землю)');
    expect(text).toContain('минимальный заряд');
    expect(text).toContain('Наибольший крен 10°');
    expect(text).not.toContain('Итог');
  });

  it('без взлёта — коротко', () => {
    expect(flightConclusion({ rec: recording('ground') })).toBe('«Перелёт А → Б»: взлёта не было.');
  });
});
