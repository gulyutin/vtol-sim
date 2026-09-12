import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS, type RouteScenario } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { backTransitionAltitudeM, fromLocal, simulateMission, toLocal, transitionAltitudeM } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { MissionPlan, Terrain, Weather } from '../src/sim/types';

const route = SCENARIOS.find((s): s is RouteScenario => s.kind === 'route')!;
const site = route.site;
// Штиль с севера: взлёт и посадка — на север, к склону.
const calm = (w: Weather): Weather => ({ ...w, wind: { speedMs: 0, fromDeg: 0 } });
/** Площадка у подножия: в 250 м к северу начинается склон, через 450 м рельеф на 200 м выше. */
const slope: Terrain = {
  elevationM: (p) => 200 + 200 * Math.min(1, Math.max(0, (toLocal(site, p).north - 250) / 450)),
};
const overPlateau: RouteScenario = {
  ...route,
  route: [
    { ...fromLocal(site, 0, 3000), heightAglM: 150 },
    { ...fromLocal(site, 2500, 3500), heightAglM: 150 },
  ],
};
const VT = AIRCRAFT.vtol;

describe('крутой рельеф у площадки', () => {
  const weather = calm(forecastWeather(overPlateau, overPlateau.defaults));
  const plan = buildMission(overPlateau, overPlateau.defaults, slope, weather).stages[0]!;

  it('переход выше: профиль не уходит под рельеф, энергия считается', () => {
    expect(transitionAltitudeM(plan)).toBeGreaterThan(200 + VT.transitionHeightM + 50);
    expect(transitionAltitudeM(plan)).toBeLessThanOrEqual(200 + VT.transitionHeightM + 200);
    expect(backTransitionAltitudeM(plan)).toBeGreaterThan(200 + VT.backTransitionHeightM);
    const r = simulateMission(plan, weather);
    expect(r.issues.filter((i) => /над рельефом|снижение|набор/.test(i))).toEqual([]);
    expect(Number.isFinite(r.budget.totalWh)).toBe(true);
    // Вертикальный набор длиннее — дороже, чем по РЛЭ.
    const standard = simulateMission({ ...plan, transitionAltitudeM: undefined, backTransitionAltitudeM: undefined }, weather);
    const climb = (x: typeof r) => x.takeoffPhases.find((p) => p.name === 'Вертикальный набор')!.energyWh;
    expect(climb(r)).toBeGreaterThan(climb(standard));
  });

  it('живой полёт набирает высоту перехода на роторах и садится без удара о склон', () => {
    const f = new LiveFlight({ plan, terrain: slope, weather, origin: plan.takeoff, home: plan.takeoff });
    const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };
    f.command('arm');
    f.command('takeoff');
    let transitionUp = NaN;
    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 3 * 3600) {
      f.step(0.5, controls);
      if (Number.isNaN(transitionUp) && f.state.mode === 'transition') transitionUp = f.state.up;
    }
    expect(f.state.mode).toBe('landed');
    expect(transitionUp).toBeCloseTo(transitionAltitudeM(plan) - 200, 0);
  });
});

describe('стык участков', () => {
  it('доли метра высоты на нулевом отрезке не дают бесконечной энергии', () => {
    const weather = calm(forecastWeather(route, route.defaults));
    const p = buildMission(route, route.defaults, flatTerrain(200), weather).stages[0]!;
    const k = Math.floor(p.waypoints.length / 2);
    const wp = p.waypoints[k]!;
    const plan: MissionPlan = { ...p, waypoints: [...p.waypoints.slice(0, k + 1), { ...wp, altitudeM: wp.altitudeM + 1e-9 }, ...p.waypoints.slice(k + 1)] };
    const r = simulateMission(plan, weather);
    expect(Number.isFinite(r.budget.totalWh)).toBe(true);
    expect(r.issues.filter((i) => /без горизонтального/.test(i))).toEqual([]);
  });
});
