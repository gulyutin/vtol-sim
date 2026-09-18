import { describe, expect, it } from 'vitest';
import { flightRemarks } from '../src/game/remarks';
import type { Recording, Sample } from '../src/game/recorder';

const sample = (t: number, over: Partial<Sample>): Sample => ({
  t, east: 0, north: t * 20, up: 150, headingDeg: 0, pitchDeg: 0, bankDeg: 0, iasMs: 20, gsMs: 20, vzMs: 0, aglM: 150, powerW: 800, energyWh: 0, soc: 1, mode: 'auto', lift: 0, pusher: 0.5, ...over,
});
const rec = (samples: Sample[], events: { t: number; text: string }[] = []): Recording => ({ version: 1, meta: {} as Recording['meta'], samples, events });
const plans = [{ path: [{ east: 0, north: 0, up: 150, leg: 0 }, { east: 0, north: 10000, up: 150, leg: 1 }], legLabels: ['Взлётный маршрут', 'Участок 1 → 2'] }];

describe('замечания инструктора', () => {
  it('ниже плана дольше 15 с — замечание с участком и временем', () => {
    const s = Array.from({ length: 120 }, (_, i) => sample(i, { up: i > 30 && i < 60 ? 80 : 150 }));
    const r = flightRemarks({ rec: rec(s), plans });
    const low = r.find((x) => x.text.includes('ниже плана'));
    expect(low?.text).toContain('«Участок 1 → 2»');
    expect(low?.text).toContain('до 70 м');
    expect(low?.level).toBe('warn');
  });

  it('реакция на отказ: ВОЗВРАТ через 8 с — хорошо, без смены режима — плохо', () => {
    const s = Array.from({ length: 200 }, (_, i) => sample(i, { mode: i >= 58 ? 'rtl' : 'auto' }));
    const good = flightRemarks({ rec: rec(s, [{ t: 50, text: 'ОТКАЗ: Отказ ГНСС' }]), plans: [] });
    expect(good.find((x) => x.text.includes('отказ'))).toMatchObject({ level: 'good' });
    const s2 = Array.from({ length: 200 }, (_, i) => sample(i, {}));
    const bad = flightRemarks({ rec: rec(s2, [{ t: 50, text: 'ОТКАЗ: Отказ ГНСС' }]), plans: [] });
    expect(bad.find((x) => x.text.includes('отказ'))).toMatchObject({ level: 'bad' });
  });

  it('потери связи — сколько раз и самая долгая', () => {
    const s = Array.from({ length: 200 }, (_, i) => sample(i, {}));
    const r = flightRemarks({
      rec: rec(s, [
        { t: 20, text: 'Нет связи с НСУ: рельеф закрывает НСУ' },
        { t: 30, text: 'Связь с НСУ восстановлена' },
        { t: 100, text: 'Нет связи с НСУ: рельеф закрывает НСУ' },
        { t: 145, text: 'Связь с НСУ восстановлена' },
      ]),
      plans: [],
    });
    const link = r.find((x) => x.text.startsWith('Связь терялась'));
    expect(link?.text).toContain('2 раза');
    expect(link?.text).toContain('45 с');
    expect(link?.level).toBe('bad');
  });

  it('чистый полёт — «замечаний нет»', () => {
    const s = Array.from({ length: 100 }, (_, i) => sample(i, {}));
    expect(flightRemarks({ rec: rec(s), plans })).toEqual([{ t: null, level: 'good', text: expect.stringContaining('Замечаний нет') }]);
  });
});
