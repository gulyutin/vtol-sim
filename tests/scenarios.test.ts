import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS, type DeliveryScenario, type RouteScenario } from '../src/game/scenarios';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { combineResults, distanceM, fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import { fillVoids, flatTerrain } from '../src/sim/terrain';
import type { GeoPoint, Weather } from '../src/sim/types';

const terrain = flatTerrain(260);
const delivery = SCENARIOS.find((s): s is DeliveryScenario => s.kind === 'delivery')!;
const route = SCENARIOS.find((s): s is RouteScenario => s.kind === 'route')!;
const calm = (w: Weather): Weather => ({ ...w, wind: { speedMs: 0, fromDeg: 0 } });
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };

function fly(f: LiveFlight) {
  f.command('takeoff');
  while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 4 * 3600) f.step(0.5, controls);
}

describe('доставка', () => {
  const weather = calm(forecastWeather(delivery, delivery.defaults));
  const m = buildMission(delivery, delivery.defaults, terrain, weather);
  const [out, back] = m.stages.map((p) => simulateMission(p, weather)) as [ReturnType<typeof simulateMission>, ReturnType<typeof simulateMission>];

  it('два полёта: туда с грузом до пункта доставки, обратно без груза', () => {
    expect(m.stages).toHaveLength(2);
    expect(m.stages[0]!.payload!.massKg).toBe(delivery.defaults.cargoKg);
    expect(m.stages[1]!.payload!.massKg).toBe(0);
    expect(distanceM(m.stages[0]!.landing, delivery.destination)).toBeLessThan(1);
    expect(distanceM(m.stages[1]!.landing, delivery.site)).toBeLessThan(1);
  });

  it('в штиль обратно дешевле: аппарат легче на массу груза', () => {
    expect(Math.abs(out.distanceM - back.distanceM) / out.distanceM).toBeLessThan(0.01);
    expect(back.budget.totalWh).toBeLessThan(out.budget.totalWh);
  });

  it('общий бюджет — сумма полётов на одной батарее, со стоянкой', () => {
    const c = combineResults([out, back], delivery.unloadS);
    expect(c.budget.totalWh).toBeCloseTo(out.budget.totalWh + back.budget.totalWh, 6);
    expect(c.socAtLanding).toBeCloseTo(1 - c.budget.totalWh / c.capacityWh, 9);
    expect(c.durationS).toBeCloseTo(out.durationS + back.durationS + delivery.unloadS, 6);
    expect(c.issues).toEqual([]);
  });

  it('живой полёт: садится в пункте доставки, после разгрузки возвращается', () => {
    const site = m.site;
    const f1 = new LiveFlight({ plan: m.stages[0]!, terrain, weather, origin: site, home: site });
    fly(f1);
    expect(f1.state.mode).toBe('landed');
    const dest = toLocal(site, m.stages[0]!.landing);
    expect(Math.hypot(f1.state.east - dest.east, f1.state.north - dest.north)).toBeLessThan(5);

    const f2 = new LiveFlight({ plan: m.stages[1]!, terrain, weather, origin: site, home: site, startT: f1.state.t + 60, initialEnergyWh: f1.state.energyWh });
    expect(f2.state.east).toBeCloseTo(dest.east, 3);
    expect(f2.state.energyWh).toBe(f1.state.energyWh);
    fly(f2);
    expect(f2.state.mode).toBe('landed');
    expect(Math.hypot(f2.state.east, f2.state.north)).toBeLessThan(5);
    const planned = combineResults([out, back], delivery.unloadS);
    expect(Math.abs(f2.state.energyWh / planned.budget.totalWh - 1)).toBeLessThan(0.05);
  });
});

describe('построение маршрута', () => {
  it('высота над рельефом своя у каждой точки, между точками — плавно', () => {
    const points = [
      { ...fromLocal(route.site, 200, 3300), heightAglM: 100 },
      { ...fromLocal(route.site, 200, 7700), heightAglM: 300 },
    ];
    const sc: RouteScenario = { ...route, route: points };
    const wps = buildMission(sc, sc.defaults, terrain, calm(forecastWeather(sc, sc.defaults))).stages[0]!.waypoints;
    const nearest = (p: GeoPoint) => wps.reduce((best, w) => (distanceM(w, p) < distanceM(best, p) ? w : best));
    expect(nearest(points[0]!).altitudeM).toBeCloseTo(360, -1);
    expect(nearest(points[1]!).altitudeM).toBeCloseTo(560, -1);
    const between = wps.filter((w) => w.routeLeg === 1).map((w) => w.altitudeM);
    for (let i = 1; i < between.length; i++) expect(between[i]!).toBeGreaterThanOrEqual(between[i - 1]! - 1e-9);
  });
});

describe('данные рельефа', () => {
  it('пустоты заполняются соседями, настоящая ложбина остаётся', () => {
    const w = 40;
    const g = new Float32Array(w * w).fill(200);
    for (let y = 18; y < 21; y++) for (let x = 18; x < 21; x++) g[y * w + x] = -30;
    g[5 * w + 5] = 185;
    expect(fillVoids(g, w, w)).toBe(9);
    for (let y = 18; y < 21; y++) for (let x = 18; x < 21; x++) expect(g[y * w + x]).toBeCloseTo(200, 3);
    expect(g[5 * w + 5]).toBe(185);
  });
});
