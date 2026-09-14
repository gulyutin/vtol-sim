import { describe, expect, it } from 'vitest';
import { Preparation, PREP_STEPS, type PrepStepId } from '../src/game/preparation';

const ok = () => ({ ok: true, text: 'норма' });

/** Выполнить шаг целиком, собирая, что показывал аппарат. */
function run(p: Preparation, id: PrepStepId, t0: number, evaluate = ok) {
  expect(p.start(id, t0)).toBeNull();
  const def = PREP_STEPS.find((s) => s.id === id)!;
  const seen = [];
  for (let t = t0; t <= t0 + def.durationS + 0.1; t += 0.1) seen.push(p.update(t, evaluate));
  return seen;
}

describe('предполётная подготовка (РЛЭ, прил. А.3–А.4)', () => {
  it('питание — первым, опрос — последним, по одной проверке за раз', () => {
    const p = new Preparation();
    expect(p.start('vtol', 0)).toMatch(/питание/);
    expect(p.start('power', 0)).toBeNull();
    expect(p.start('link', 1)).toMatch(/другая/);
    for (let t = 0; t <= 6.1; t += 0.1) p.update(t, ok);
    expect(p.status.power).toBe('done');
    expect(p.start('poll', 7)).toMatch(/остальные/);
  });

  it('регуляторы СВВП: роторы раскручиваются строго по очереди 1 → 4', () => {
    const p = new Preparation();
    run(p, 'power', 0);
    const seen = run(p, 'vtol', 10);
    const order: number[] = [];
    for (const g of seen) {
      const spinning = g.rotors.map((v, i) => (v > 0.05 ? i : -1)).filter((i) => i >= 0);
      expect(spinning.length).toBeLessThanOrEqual(1);
      if (spinning.length && order.at(-1) !== spinning[0]) order.push(spinning[0]!);
    }
    expect(order).toEqual([0, 1, 2, 3]);
    expect(p.status.vtol).toBe('done');
  });

  it('СП отклоняет элероны и оба руля V-оперения в обе стороны, СВС показывает приборную и возвращает к нулю', () => {
    const p = new Preparation();
    expect(p.powered).toBe(false);
    run(p, 'power', 0);
    expect(p.powered).toBe(true);
    const servos = run(p, 'servos', 10);
    for (const k of ['ailL', 'ailR', 'tailL', 'tailR'] as const) {
      expect(Math.max(...servos.map((g) => g.surfaces[k])), k).toBeGreaterThan(0.9);
      expect(Math.min(...servos.map((g) => g.surfaces[k])), k).toBeLessThan(-0.9);
    }
    // Руль направления: рули оперения врозь.
    expect(servos.some((g) => g.surfaces.tailL > 0.5 && g.surfaces.tailR < -0.5)).toBe(true);
    expect(servos.at(-1)!.surfaces.ailL).toBe(0);
    const air = run(p, 'airdata', 20);
    expect(Math.max(...air.map((g) => g.airspeedMs))).toBeGreaterThan(5);
    expect(air.at(-1)!.airspeedMs).toBeLessThan(0.5);
  });

  it('после всех пунктов подготовка выполнена; проваленный пункт её не завершает', () => {
    const p = new Preparation();
    let t = 0;
    for (const s of PREP_STEPS) {
      if (s.id === 'poll') continue;
      run(p, s.id, t);
      t += 20;
    }
    run(p, 'poll', t, () => ({ ok: false, text: 'ветер сильнее допустимого' }));
    expect(p.status.poll).toBe('failed');
    expect(p.done).toBe(false);
    run(p, 'poll', t + 20);
    expect(p.done).toBe(true);
    p.reset();
    expect(p.done).toBe(false);
  });
});
