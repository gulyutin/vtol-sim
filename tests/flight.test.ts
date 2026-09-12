import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { simulateMission } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { Terrain } from '../src/sim/types';

const sc = SCENARIOS.find((s) => s.kind === 'survey')!;
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
    f.command('arm');
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
    f.command('arm');
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
    f.command('arm');
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
    f.command('arm');
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.mode === 'auto');
    f.command('manual');
    runUntil(f, { ...controls, courseDeg: 90, heightAglM: 60 }, (x) => x.state.mode === 'crashed', 3600);
    expect(f.state.reason).toBe('Столкновение с рельефом');
  });

  it('шаг нулевой длины ничего не меняет и не портит энергию', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.command('arm');
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
    f.command('arm');
    f.command('takeoff');
    runUntil(f, controls, (x) => x.state.mode === 'crashed' || x.state.mode === 'landed');
    // Моторы встают, аппарат падает и разбивается — причина в сообщении об ударе.
    expect(f.state.mode).toBe('crashed');
    expect(f.state.reason).toMatch(/батарея разряжена/i);
  });
});

describe('турбулентность в живом полёте', () => {
  const rough = { ...weather, turbulenceMs: 1.5 };
  const fly = (w: typeof weather, seed?: number) => {
    const f = new LiveFlight({ plan, terrain, weather: w, seed });
    f.command('arm');
    f.command('takeoff');
    let gust = 0;
    let bank = 0;
    let vz = 0;
    let reading = 0;
    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 4 * 3600) {
      f.step(0.5, controls);
      gust = Math.max(gust, f.state.gustMs);
      if (f.state.mode === 'auto') {
        bank = Math.max(bank, Math.abs(f.state.bankDeg));
        vz = Math.max(vz, Math.abs(f.state.vzMs));
        reading = Math.max(reading, Math.abs(f.state.iasReadingMs - f.state.iasMs));
      }
    }
    return { f, gust, bank, vz, reading };
  };

  it('в болтанку задание выполняется: посадка в районе, но не так точно; энергии чуть больше; тот же seed — тот же полёт', () => {
    const calm = fly(weather);
    const a = fly(rough, 3);
    const b = fly(rough, 3);
    expect(a.f.state.mode).toBe('landed');
    expect(b.f.state.east).toBe(a.f.state.east);
    expect(b.f.state.energyWh).toBe(a.f.state.energyWh);
    const miss = Math.hypot(a.f.state.east - a.f.home.east, a.f.state.north - a.f.home.north);
    const calmMiss = Math.hypot(calm.f.state.east - calm.f.home.east, calm.f.state.north - calm.f.home.north);
    expect(miss).toBeLessThan(AIRCRAFT.limits.landingZoneRadiusM);
    expect(miss).toBeGreaterThan(calmMiss);
    expect(a.f.state.energyWh / calm.f.state.energyWh).toBeGreaterThan(1);
    expect(a.f.state.energyWh / calm.f.state.energyWh).toBeLessThan(1.1);
    // Порывы видны: сила порыва, крен и вертикальная пляшут, стрелка ПВД дёргается.
    expect(calm.gust).toBe(0);
    expect(a.gust).toBeGreaterThan(1);
    expect(a.bank).toBeGreaterThan(calm.bank);
    expect(a.vz).toBeGreaterThan(calm.vz);
    expect(a.reading).toBeGreaterThan(0.3);
    expect(a.bank).toBeLessThan(AIRCRAFT.limits.failsafeBankDeg);
  });
});

describe('АРМ и ДИЗАРМ', () => {
  it('без АРМ взлёт не начинается; заармленный на земле — роторы на холостых и расход', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    expect(f.command('takeoff')).not.toBeNull();
    expect(f.command('arm')).toBeNull();
    f.step(10, controls);
    expect(f.state.mode).toBe('ground');
    expect(f.state.armed).toBe(true);
    expect(f.state.lift).toBeGreaterThan(0);
    expect(f.state.energyWh).toBeGreaterThan(0);
    expect(f.command('disarm')).toBeNull();
    expect(f.state.armed).toBe(false);
    expect(f.command('takeoff')).not.toBeNull();
  });

  it('после посадки остаётся заармленным и тратит батарею, пока оператор не задизармит', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.command('arm');
    f.command('takeoff');
    while (f.state.mode !== 'auto' && f.state.t < 600) f.step(0.5, controls);
    expect(f.command('land')).toBeNull();
    while (f.state.mode !== 'landed' && f.state.t < 1200) f.step(0.5, controls);
    expect(f.state.mode).toBe('landed');
    const e = f.state.energyWh;
    f.step(30, controls);
    expect(f.state.armed).toBe(true);
    expect(f.state.lift).toBeGreaterThan(0);
    expect(f.state.energyWh).toBeGreaterThan(e);
    expect(f.command('disarm')).toBeNull();
    const e2 = f.state.energyWh;
    f.step(30, controls);
    expect(f.state.energyWh).toBe(e2);
    expect(f.state.lift).toBe(0);
  });

  it('ДИЗАРМ в крейсере — моторы стоят, аппарат планирует со снижением и разбивается', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.command('arm');
    f.command('takeoff');
    while (!(f.state.mode === 'auto' && f.state.aglM > 100) && f.state.t < 1200) f.step(0.5, controls);
    const start = { e: f.state.east, n: f.state.north, agl: f.state.aglM };
    expect(f.command('disarm')).toBeNull();
    expect(f.state.mode).toBe('falling');
    let thrust = 0;
    let power = 0;
    while (f.state.mode === 'falling' && f.state.t < 3600) {
      f.step(0.2, controls);
      thrust = Math.max(thrust, f.state.lift, f.state.pusher);
      power = Math.max(power, f.state.powerW);
    }
    // Моторы стоят; от батареи питается только нагрузка (камера).
    expect(thrust).toBe(0);
    expect(power).toBeLessThanOrEqual((plan.payload?.powerW ?? 0) + 1e-9);
    expect(f.state.mode).toBe('crashed');
    expect(f.state.reason).toMatch(/ДИЗАРМ/);
    // Крыло держит: пролетел в несколько раз дальше, чем был высоко.
    expect(Math.hypot(f.state.east - start.e, f.state.north - start.n)).toBeGreaterThan(3 * start.agl);
  });

  it('ДИЗАРМ на висении — падение почти вертикально и авария', () => {
    const f = new LiveFlight({ plan, terrain, weather: { ...weather, wind: { speedMs: 0, fromDeg: 0 } } });
    f.command('arm');
    f.command('takeoff');
    while (!(f.state.mode === 'climb' && f.state.aglM > 25) && f.state.t < 120) f.step(0.1, controls);
    const start = { e: f.state.east, n: f.state.north };
    expect(f.command('disarm')).toBeNull();
    while (f.state.mode === 'falling' && f.state.t < 300) f.step(0.1, controls);
    expect(f.state.mode).toBe('crashed');
    expect(Math.hypot(f.state.east - start.e, f.state.north - start.n)).toBeLessThan(15);
  });
});
