import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS, type DeliveryScenario, type RouteScenario, type TransferScenario } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { combineResults, distanceM, fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import { fillVoids, flatTerrain, removeSpikes } from '../src/sim/terrain';
import type { GeoPoint, Weather } from '../src/sim/types';

const terrain = flatTerrain(260);
const delivery = SCENARIOS.find((s): s is DeliveryScenario => s.kind === 'delivery')!;
const route = SCENARIOS.find((s): s is RouteScenario => s.kind === 'route')!;
const calm = (w: Weather): Weather => ({ ...w, wind: { speedMs: 0, fromDeg: 0 } });
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };

function fly(f: LiveFlight) {
  f.command('arm');
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

  it('высота точек над морем или от взлёта — между точками ровно по высоте, над рельефом — огибая холм', () => {
    // Холм 200 м между точками 1 и 2 (с 4 до 6 км на север).
    const ground = (p: GeoPoint) => {
      const n = toLocal(route.site, p).north;
      return 260 + 200 * Math.max(0, 1 - Math.abs(n - 5000) / 1000);
    };
    const hills = { elevationM: ground };
    const pts = [
      { ...fromLocal(route.site, 0, 3000), heightAglM: 300, altitudeM: 560 },
      { ...fromLocal(route.site, 0, 7000), heightAglM: 300, altitudeM: 560 },
    ];
    const weather = calm(forecastWeather(route, route.defaults));
    const between = (ref: 'agl' | 'msl' | 'takeoff') => {
      const sc: RouteScenario = { ...route, route: pts };
      const plan = buildMission(sc, { ...sc.defaults, altitudeRef: ref }, hills, weather).stages[0]!;
      return plan.waypoints.filter((w) => w.routeLeg === 2).map((w) => ({ n: toLocal(route.site, w).north, alt: w.altitudeM }));
    };
    const agl = between('agl');
    const msl = between('msl');
    const top = (xs: { n: number; alt: number }[]) => xs.reduce((a, b) => (Math.abs(b.n - 5000) < Math.abs(a.n - 5000) ? b : a));
    // Над рельефом — над холмом выше на его высоту; над морем — те же 560 м по всему участку.
    expect(top(agl).alt).toBeGreaterThan(700);
    for (const w of msl) expect(w.alt).toBeCloseTo(560, 0);
    // От точки взлёта — та же абсолютная высота точек, отсчёт другой только для показа.
    expect(between('takeoff').map((w) => Math.round(w.alt))).toEqual(msl.map((w) => Math.round(w.alt)));
  });

  it('склон за площадкой круче, чем успеваем набрать, — круги над площадкой, дальше не ниже половины заданной высоты, а не сквозь склон', () => {
    // От 1 до 2,5 км на север рельеф поднимается на 900 м — 60 %.
    const ground = (p: GeoPoint) => 260 + 900 * Math.min(1, Math.max(0, (toLocal(route.site, p).north - 1000) / 1500));
    const hills = { elevationM: ground };
    const points = [
      { ...fromLocal(route.site, 0, 3000), heightAglM: 150 },
      { ...fromLocal(route.site, 0, 6000), heightAglM: 150 },
    ];
    const sc: RouteScenario = { ...route, route: points };
    const weather = calm(forecastWeather(sc, sc.defaults));
    const m = buildMission(sc, sc.defaults, hills, weather);
    const plan = m.stages[0]!;
    expect(plan.legLabels?.[0]).toContain('набор высоты по кругу');
    for (const w of plan.waypoints) expect(w.altitudeM - ground(w)).toBeGreaterThanOrEqual(AIRCRAFT.minClearanceM);
    const nearest = (p: GeoPoint) => plan.waypoints.reduce((best, w) => (distanceM(w, p) < distanceM(best, p) ? w : best));
    for (const p of points) expect(nearest(p).altitudeM - ground(p)).toBeGreaterThanOrEqual(p.heightAglM / 2 - 5);
    const f = new LiveFlight({ plan, terrain: hills, weather, origin: m.site, home: m.site });
    fly(f);
    expect(f.state.mode).toBe('landed');
    // План выполним: кругов по ходу полёта автопилоту добавлять не пришлось.
    expect(f.events.some((e) => e.text.startsWith('Набор высоты по кругу'))).toBe(false);
  });
});

describe('данные рельефа', () => {
  it('узкий шпиль-выброс срезается, широкая гора и крутой склон остаются', () => {
    const w = 120;
    const cell = 15;
    const g = new Float32Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        // Широкая гора 600 м (радиус ~700 м), шпиль 260 м шириной ~120 м и склон-уступ.
        const hill = 600 * Math.exp(-(((x - 40) * cell) ** 2 + ((y - 40) * cell) ** 2) / (2 * 450 ** 2));
        const spike = 260 * Math.max(0, 1 - Math.hypot((x - 85) * cell, (y - 85) * cell) / 60);
        const step = x > 100 ? 300 * Math.min(1, (x - 100) / 6) : 0;
        g[y * w + x] = 200 + hill + spike + step;
      }
    }
    const hillTop = g[40 * w + 40]!;
    const cliff = g[60 * w + 110]!;
    const spikeTop = g[85 * w + 85]!;
    // Там же без шпиля: шпиль стоит на склоне горы.
    const ground = 200 + 600 * Math.exp(-(((85 - 40) * cell) ** 2 * 2) / (2 * 450 ** 2));
    expect(removeSpikes(g, w, w, cell)).toBeGreaterThan(0);
    expect(spikeTop - g[85 * w + 85]!).toBeGreaterThan(100);
    expect(g[85 * w + 85]! - ground).toBeLessThan(130);
    expect(g[40 * w + 40]).toBe(hillTop);
    expect(g[60 * w + 110]).toBe(cliff);
  });

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

describe('перелёт А → Б', () => {
  const transfer = SCENARIOS.find((s): s is TransferScenario => s.kind === 'transfer')!;

  it('задание по умолчанию: один полёт с посадкой в Б, живой полёт садится в Б', () => {
    expect(SCENARIOS[0]!.kind).toBe('transfer');
    const weather = calm(forecastWeather(transfer, transfer.defaults));
    const m = buildMission(transfer, transfer.defaults, terrain, weather);
    expect(m.stages).toHaveLength(1);
    expect(distanceM(m.stages[0]!.landing, transfer.destination)).toBeLessThan(1);
    expect(distanceM(m.stages[0]!.takeoff, transfer.site)).toBeLessThan(1);
    const f = new LiveFlight({ plan: m.stages[0]!, terrain, weather, origin: m.site, home: m.site });
    fly(f);
    expect(f.state.mode).toBe('landed');
    const dest = toLocal(m.site, m.stages[0]!.landing);
    expect(Math.hypot(f.state.east - dest.east, f.state.north - dest.north)).toBeLessThan(5);
  });
});
