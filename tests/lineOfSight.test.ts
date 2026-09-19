import { describe, expect, it } from 'vitest';
import { bearingDeg, distanceM, lineOfSight, lineProfile } from '../src/game/profile';

describe('линейка', () => {
  it('расстояние и азимут', () => {
    const a = { lat: 60, lon: 30 };
    expect(distanceM(a, { lat: 60.01, lon: 30 })).toBeCloseTo(1112, 0);
    expect(bearingDeg(a, { lat: 60.01, lon: 30 })).toBeCloseTo(0, 3);
    expect(bearingDeg(a, { lat: 60, lon: 30.01 })).toBeCloseTo(90, 1);
    expect(bearingDeg(a, { lat: 59.99, lon: 30 })).toBeCloseTo(180, 3);
  });
  it('гряда посередине закрывает видимость, на высоте — открывает', () => {
    const a = { lat: 60, lon: 30 };
    const b = { lat: 60.1, lon: 30 };
    const ridge = (p: { lat: number }) => (Math.abs(p.lat - 60.05) < 0.005 ? 150 : 100);
    const prof = lineProfile(a, b, ridge);
    expect(prof).toHaveLength(201);
    const low = lineOfSight(prof, 3, 3);
    expect(low.clear).toBe(false);
    expect(low.clearanceM).toBeLessThan(-40);
    expect(low.worstD).toBeGreaterThan(5000);
    expect(lineOfSight(prof, 3, 150).clear).toBe(true);
  });
  it('кривизна Земли: на ровном месте за 30 км антенны по 3 м друг друга не видят', () => {
    const flat = () => 0;
    const prof = lineProfile({ lat: 60, lon: 30 }, { lat: 60.27, lon: 30 }, flat);
    const s = lineOfSight(prof, 3, 3);
    // Подъём Земли посередине 30 км трассы с k = 4/3 — около 13 м.
    expect(s.clear).toBe(false);
    expect(s.clearanceM).toBeCloseTo(3 - 13.2, 0);
  });
});
