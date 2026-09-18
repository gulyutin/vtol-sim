import { describe, expect, it } from 'vitest';
import { afterFlight, capacityWh, chargeBlock, chargeEtaS, install, installed, newPark, tickPark, toggleCharger } from '../src/game/batteries';

describe('аккумуляторы расчёта', () => {
  it('после полёта заряд падает, циклы растут, батарея тёплая; на зарядке — до полной за час с небольшим', () => {
    const p = newPark(3, 15);
    const b = installed(p)!;
    const cap = capacityWh(b);
    afterFlight(p, cap * 0.6, cap, 1500, false);
    expect(b.soc).toBeCloseTo(0.4, 6);
    expect(b.cycles).toBeCloseTo(20.6, 6);
    const hot = b.tempC;
    expect(hot).toBeGreaterThan(20);
    install(p, 'b2');
    expect(installed(p)!.id).toBe('b2');
    toggleCharger(p, b.id);
    expect(b.place).toBe('charger');
    let t = 0;
    while (b.soc < 1 && t < 4 * 3600) {
      tickPark(p, 60, 15);
      t += 60;
    }
    expect(b.soc).toBe(1);
    expect(t).toBeGreaterThan(45 * 60);
    expect(t).toBeLessThan(110 * 60);
    expect(chargeEtaS(b)).toBe(0);
  });

  it('на морозе на улице батарея не заряжается, в тепле — да; холодная — меньше ёмкость', () => {
    const p = newPark(3, -20);
    p.warmStore = false;
    const b = p.batteries[1]!;
    b.soc = 0.3;
    b.tempC = -20;
    toggleCharger(p, b.id);
    tickPark(p, 4 * 3600, -20);
    expect(chargeBlock(b)).toContain('холодная');
    expect(b.soc).toBeCloseTo(0.3, 6);
    p.warmStore = true;
    tickPark(p, 3 * 3600, -20);
    expect(b.soc).toBeGreaterThan(0.9);
    const warm = capacityWh(b);
    b.tempC = -20;
    expect(capacityWh(b)).toBeLessThan(warm * 0.9);
  });

  it('на зарядном — не больше двух', () => {
    const p = newPark(4, 15);
    toggleCharger(p, 'b2');
    toggleCharger(p, 'b3');
    toggleCharger(p, 'b4');
    expect(p.batteries.filter((b) => b.place === 'charger').length).toBe(2);
  });
});
