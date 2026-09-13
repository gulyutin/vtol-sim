import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS, type TransferScenario } from '../src/game/scenarios';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { fromLocal, toLocal } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { Weather } from '../src/sim/types';

const terrain = flatTerrain(200);
const transfer = SCENARIOS.find((s): s is TransferScenario => s.kind === 'transfer')!;
const calm = (w: Weather): Weather => ({ ...w, wind: { speedMs: 0, fromDeg: 0 } });
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };

describe('пункт Б перенесли в полёте', () => {
  it('посадочный маршрут перестраивается, аппарат садится в новом Б', () => {
    const weather = calm(forecastWeather(transfer, transfer.defaults));
    const m = buildMission(transfer, transfer.defaults, terrain, weather);
    const f = new LiveFlight({ plan: m.stages[0]!, terrain, weather, origin: m.site, home: m.site });
    f.command('arm');
    f.command('takeoff');
    while (f.state.mode !== 'auto' && f.state.t < 600) f.step(0.5, controls);
    for (let i = 0; i < 120; i++) f.step(0.5, controls);
    expect(f.state.mode).toBe('auto');

    // Б — на 2 км восточнее прежнего.
    const old = toLocal(m.site, transfer.destination);
    const moved: TransferScenario = { ...transfer, destination: fromLocal(m.site, old.east + 2000, old.north) };
    const m2 = buildMission(moved, moved.defaults, terrain, weather);
    f.replacePlan(m2.stages[0]!);
    expect(f.landing.east).toBeCloseTo(old.east + 2000, 0);

    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 4 * 3600) f.step(0.5, controls);
    expect(f.state.mode).toBe('landed');
    expect(Math.hypot(f.state.east - (old.east + 2000), f.state.north - old.north)).toBeLessThan(10);
  });
});
