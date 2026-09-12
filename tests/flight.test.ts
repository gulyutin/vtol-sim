import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { simulateMission } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { Terrain } from '../src/sim/types';

const sc = SCENARIOS[0]!;
const terrain = flatTerrain(320);
const weather = forecastWeather(sc, sc.defaults);
const plan = buildMission(sc, sc.defaults, terrain, weather).stages[0]!;
const controls: Controls = { iasMs: sc.defaults.iasMs, heightAglM: 150, courseDeg: 0, target: null };

function runUntil(f: LiveFlight, c: Controls, done: (f: LiveFlight) => boolean, limitS = 4 * 3600) {
  let maxBank = 0;
  while (!done(f) && f.state.t < limitS) {
    f.step(0.5, c);
    maxBank = Math.max(maxBank, Math.abs(f.state.bankDeg));
  }
  return maxBank;
}

describe('живой полёт', () => {
  it('задание в АВТО сходится с расчётом планировщика по энергии и времени', () => {
    const planned = simulateMission(plan, weather);
    const f = new LiveFlight({ plan, terrain, weather });
    expect(f.command('takeoff')).toBeNull();
    const maxBank = runUntil(f, controls, (x) => x.state.mode === 'landed' || x.state.mode === 'crashed');
    expect(f.state.mode).toBe('landed');
    expect(Math.abs(f.state.energyWh / planned.budget.totalWh - 1)).toBeLessThan(0.04);
    expect(Math.abs(f.state.t / planned.durationS - 1)).toBeLessThan(0.05);
    expect(Math.hypot(f.state.east - f.home.east, f.state.north - f.home.north)).toBeLessThan(5);
    expect(maxBank).toBeLessThanOrEqual(AIRCRAFT.maxBankDeg + 1e-9);
  });

  it('ВОЗВРАТ с середины задания приводит на площадку', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.t > 600);
    expect(f.state.mode).toBe('auto');
    expect(f.command('rtl')).toBeNull();
    runUntil(f, controls, (x) => x.state.mode === 'landed' || x.state.mode === 'crashed');
    expect(f.state.mode).toBe('landed');
    expect(Math.hypot(f.state.east - f.home.east, f.state.north - f.home.north)).toBeLessThan(5);
  });

  it('ЦЕЛЬ: аппарат кружит вокруг точки', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.mode === 'auto');
    const target = { east: 1500, north: 800 };
    f.command('guided');
    const c = { ...controls, target };
    runUntil(f, c, (x) => x.state.modeT > 400);
    const r: number[] = [];
    for (let i = 0; i < 120; i++) {
      f.step(1, c);
      r.push(Math.hypot(f.state.east - target.east, f.state.north - target.north));
    }
    const loiter = Math.max(1.3 * f.turnRadiusM(), 150);
    expect(Math.min(...r)).toBeGreaterThan(0.6 * loiter);
    expect(Math.max(...r)).toBeLessThan(1.6 * loiter);
  });

  it('РУЧНОЙ низко на стену выше предельного набора — столкновение с рельефом', () => {
    const wall: Terrain = { elevationM: (p) => (p.lon > plan.takeoff.lon + 0.03 ? 900 : 320) };
    const f = new LiveFlight({ plan, terrain: wall, weather });
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.mode === 'auto');
    f.command('manual');
    runUntil(f, { ...controls, courseDeg: 90, heightAglM: 60 }, (x) => x.state.mode === 'crashed', 3600);
    expect(f.state.reason).toBe('Столкновение с рельефом');
  });

  it('шаг нулевой длины ничего не меняет и не портит энергию', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.mode === 'auto');
    const before = { ...f.state };
    f.step(0, controls);
    expect(f.state.energyWh).toBe(before.energyWh);
    expect(Number.isFinite(f.state.energyWh)).toBe(true);
    f.step(1, controls);
    expect(Number.isFinite(f.state.energyWh)).toBe(true);
  });

  it('разряд батареи в воздухе — авария', () => {
    const f = new LiveFlight({ plan, terrain, weather, capacityWh: 60 });
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.mode === 'crashed' || x.state.mode === 'landed');
    expect(f.state.reason).toBe('Батарея разряжена');
  });
});
