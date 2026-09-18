import { describe, expect, it } from 'vitest';
import { axisValue, defaultMapping } from '../src/game/rcMapping';

describe('раскладка пульта', () => {
  it('калибровка: упоры — ±1, середина — 0, несимметричный ход растягивается по половинам', () => {
    const a = { index: 0, invert: false, min: -0.85, center: 0.02, max: 0.8 };
    expect(axisValue(0.8, a)).toBeCloseTo(1, 6);
    expect(axisValue(-0.85, a)).toBeCloseTo(-1, 6);
    expect(axisValue(0.02, a)).toBeCloseTo(0, 6);
    expect(axisValue(1, a)).toBe(1);
    expect(axisValue(0.41, { ...a, invert: true })).toBeCloseTo(-0.5, 2);
  });

  it('по умолчанию: геймпад — режим 2, пульт — AETR', () => {
    const g = defaultMapping(true);
    expect([g.yaw.index, g.throttle.index, g.roll.index, g.pitch.index]).toEqual([0, 1, 2, 3]);
    expect(g.pitch.invert && g.throttle.invert).toBe(true);
    const r = defaultMapping(false);
    expect([r.roll.index, r.pitch.index, r.throttle.index, r.yaw.index]).toEqual([0, 1, 2, 3]);
  });
});
