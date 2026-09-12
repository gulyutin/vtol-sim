import { describe, expect, it } from 'vitest';
import { blocked, preflightChecks } from '../src/game/preflight';
import { buildMission, forecastWeather, SCENARIOS, type DeliveryScenario, type RouteScenario, type Scenario, type Settings } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { roundSharpCorners } from '../src/sim/dubins';
import { bearingDeg, combineResults, distanceM, fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import { CAMERAS } from '../src/sim/payload';
import { windProcedures } from '../src/sim/procedures';
import { lineOfSight } from '../src/sim/radio';
import { frameAt } from '../src/sim/survey';
import { flatTerrain } from '../src/sim/terrain';
import type { Terrain, Weather } from '../src/sim/types';

/*
 * Проверки по РЛЭ: взлётный и посадочный маршруты,
 * порядок посадки, эксплуатационные ограничения, прямая видимость, стабилизация нагрузки.
 */

const terrain = flatTerrain(260);
const route = SCENARIOS.find((s): s is RouteScenario => s.kind === 'route')!;
const delivery = SCENARIOS.find((s): s is DeliveryScenario => s.kind === 'delivery')!;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };
const windy = (sc: Scenario, speedMs: number, fromDeg: number): Weather => ({ ...forecastWeather(sc, sc.defaults), wind: { speedMs, fromDeg } });

describe('план совпадает с живым полётом', () => {
  it('крутой поворот проходится разворотом, вершины и номера участков сохраняются', () => {
    const o = route.site;
    const pts = [o, fromLocal(o, 0, 2000), fromLocal(o, 300, 500)];
    const r = roundSharpCorners(pts, 200);
    expect(r.points.length).toBeGreaterThan(pts.length);
    expect(r.parts).toHaveLength(r.points.length - 1);
    for (const p of pts) expect(r.points).toContain(p);
    const iB = r.points.indexOf(pts[1]!);
    expect(r.parts[iB - 1]).toMatchObject({ leg: 0, f1: 1 });
    expect(r.parts.at(-1)).toEqual({ leg: 1, f0: 0, f1: 1 });
    // В вершину аппарат приходит уже почти на новом курсе.
    expect(Math.abs(wrap(bearingDeg(pts[1]!, pts[2]!) - bearingDeg(r.points[iB - 1]!, pts[1]!)))).toBeLessThan(20);
  });

  for (const sc of [route, delivery] as Scenario[]) {
    it(`${sc.kind}: при ветре 8 м/с живой полёт расходится с планом меньше чем на 3 %, посадка в точку`, () => {
      const weather = windy(sc, 8, 30);
      const m = buildMission(sc, sc.defaults, terrain, weather);
      const unload = sc.kind === 'delivery' ? sc.unloadS : 0;
      const planned = combineResults(
        m.stages.map((p) => simulateMission(p, weather)),
        unload,
      );
      let startT = 0;
      let used = 0;
      for (const plan of m.stages) {
        const f = new LiveFlight({ plan, terrain, weather, origin: m.site, home: m.site, startT, initialEnergyWh: used });
        f.command('takeoff');
        while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < startT + 4 * 3600) f.step(0.5, controls);
        expect(f.state.mode).toBe('landed');
        const dest = toLocal(m.site, plan.landing);
        expect(Math.hypot(f.state.east - dest.east, f.state.north - dest.north)).toBeLessThan(5);
        startT = f.state.t + unload;
        used = f.state.energyWh;
      }
      expect(Math.abs(used / planned.budget.totalWh - 1)).toBeLessThan(0.03);
    });
  }
});

describe('взлётный и посадочный маршруты (РЛЭ)', () => {
  const p = windProcedures(route.site, route.site, { speedMs: 6, fromDeg: 250 }, route.route[0]!, route.route[3]!);

  it('разгон против ветра к первой точке в 300 м', () => {
    expect(p.takeoffHeadingDeg).toBe(250);
    expect(distanceM(route.site, p.departure)).toBeCloseTo(AIRCRAFT.procedures.departureDistanceM, 0);
    expect(Math.abs(wrap(bearingDeg(route.site, p.departure) - 250))).toBeLessThan(0.5);
  });

  it('посадочный маршрут — три точки через 550 м, заход против ветра', () => {
    expect(distanceM(p.approach[1], route.site)).toBeCloseTo(AIRCRAFT.procedures.approachLegM, 0);
    expect(distanceM(p.approach[0], p.approach[1])).toBeCloseTo(AIRCRAFT.procedures.approachLegM, 0);
    expect(Math.abs(wrap(bearingDeg(p.approach[1], route.site) - 250))).toBeLessThan(0.5);
  });

  it('в штиль разгон — на первую точку маршрута', () => {
    const calm = windProcedures(route.site, route.site, { speedMs: 0, fromDeg: 0 }, route.route[0]!, null);
    expect(calm.takeoffHeadingDeg).toBeCloseTo(bearingDeg(route.site, route.route[0]!), 6);
  });
});

describe('живой полёт: взлёт и посадка против ветра', () => {
  const weather = windy(route, 6, 250);
  const m = buildMission(route, route.defaults, terrain, weather);
  const f = new LiveFlight({ plan: m.stages[0]!, terrain, weather, origin: m.site, home: m.site });
  f.command('takeoff');
  let takeoffHeading = NaN;
  let pusherOffAt = NaN;
  let hoverHeading = NaN;
  while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 7200) {
    const before = f.state.mode;
    f.step(0.2, controls);
    if (f.state.mode === 'transition' && Number.isNaN(takeoffHeading)) takeoffHeading = f.state.headingDeg;
    if (before !== 'backtransition' && f.state.mode === 'backtransition') {
      pusherOffAt = Math.hypot(f.state.east - f.landing.east, f.state.north - f.landing.north);
    }
    if (f.state.mode === 'final') hoverHeading = f.state.headingDeg;
  }

  it('разгон — носом против ветра', () => {
    expect(Math.abs(wrap(takeoffHeading - 250))).toBeLessThan(3);
  });

  it('маршевый выключается за ~200 м до точки посадки', () => {
    expect(pusherOffAt).toBeGreaterThan(185);
    expect(pusherOffAt).toBeLessThanOrEqual(AIRCRAFT.procedures.pusherOffBeforeLandingM + 1);
  });

  it('над точкой — носом против ветра, посадка в районе радиусом 20 м', () => {
    expect(f.state.mode).toBe('landed');
    expect(Math.abs(wrap(hoverHeading - 250))).toBeLessThan(5);
    expect(Math.hypot(f.state.east - f.landing.east, f.state.north - f.landing.north)).toBeLessThan(AIRCRAFT.limits.landingZoneRadiusM);
  });

  it('ВОЗВРАТ садится против фактического ветра', () => {
    const g = new LiveFlight({ plan: m.stages[0]!, terrain, weather, origin: m.site, home: m.site });
    g.command('takeoff');
    while (g.state.t < 500) g.step(0.5, controls);
    expect(g.command('rtl')).toBeNull();
    let heading = NaN;
    while (g.state.mode !== 'landed' && g.state.mode !== 'crashed' && g.state.t < 7200) {
      g.step(0.2, controls);
      if (g.state.mode === 'final') heading = g.state.headingDeg;
    }
    expect(g.state.mode).toBe('landed');
    expect(Math.abs(wrap(heading - 250))).toBeLessThan(5);
    expect(Math.hypot(g.state.east - g.home.east, g.state.north - g.home.north)).toBeLessThan(AIRCRAFT.limits.landingZoneRadiusM);
  });
});

describe('маршрут в реальном времени', () => {
  it('после правки в полёте аппарат идёт к точке с тем же номером на новом месте', () => {
    const weather = windy(route, 3, 250);
    const m = buildMission(route, route.defaults, terrain, weather);
    const f = new LiveFlight({ plan: m.stages[0]!, terrain, weather, origin: m.site, home: m.site });
    f.command('takeoff');
    // Участок 2 ведёт к точке 2 оператора (участок 0 — взлётный маршрут).
    while (f.state.routeLeg !== 2 && f.state.t < 3600) f.step(0.5, controls);
    expect(f.state.routeLeg).toBe(2);
    const moved = fromLocal(m.site, toLocal(m.site, route.route[1]!).east + 1500, toLocal(m.site, route.route[1]!).north);
    const edited: RouteScenario = { ...route, route: route.route.map((p, i) => (i === 1 ? { ...p, ...moved } : p)) };
    f.replacePlan(buildMission(edited, edited.defaults, terrain, weather).stages[0]!);
    const target = toLocal(m.site, moved);
    let closest = Infinity;
    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 7200) {
      f.step(0.5, controls);
      closest = Math.min(closest, Math.hypot(f.state.east - target.east, f.state.north - target.north));
    }
    expect(closest).toBeLessThan(150);
    expect(f.state.mode).toBe('landed');
  });
});

describe('предполётные проверки (РЛЭ)', () => {
  const LIM = AIRCRAFT.limits;
  const run = (s: Partial<Settings>, weather: Weather) => {
    const settings = { ...delivery.defaults, ...s };
    const m = buildMission(delivery, settings, terrain, weather);
    return preflightChecks({ stages: m.stages, weather, procedures: m.procedures, cloudBaseM: delivery.cloudBaseM, terrain, gcs: m.site });
  };

  it('ветер 6 м/с, взлёт против ветра — «ГОТОВ»', () => {
    expect(blocked(run({}, windy(delivery, 6, 250)))).toBe(false);
  });

  it('ветер сильнее допустимого у земли — взлёт запрещён', () => {
    expect(blocked(run({}, windy(delivery, LIM.windMaxMs + 1, 250)))).toBe(true);
  });

  it('груз больше допустимого — взлёт запрещён', () => {
    expect(blocked(run({ cargoKg: AIRCRAFT.payloadMaxKg + 0.5 }, windy(delivery, 3, 250)))).toBe(true);
  });

  it('мороз ниже рабочего диапазона — взлёт запрещён', () => {
    expect(blocked(run({}, { ...windy(delivery, 3, 250), groundTemperatureC: LIM.temperatureMinC - 5 }))).toBe(true);
  });
});

describe('прямая видимость с НСУ (РЛЭ)', () => {
  const antenna = { lat: 55, lon: 37, altitudeM: 263 };
  const target = { lat: 54.84, lon: 37, altitudeM: 410 };

  it('гряда между НСУ и бортом закрывает связь, над ровным — видно', () => {
    const ridge: Terrain = { elevationM: (p) => (Math.abs(p.lat - 54.92) < 0.005 ? 600 : 260) };
    expect(lineOfSight(ridge, antenna, target).clear).toBe(false);
    expect(lineOfSight(flatTerrain(260), antenna, target).clear).toBe(true);
  });

  it('кривизна Земли: за 40 км у самой земли прямой видимости нет', () => {
    const far = { lat: 55 - 40_000 / 111_195, lon: 37, altitudeM: 270 };
    expect(lineOfSight(flatTerrain(260), antenna, far).clear).toBe(false);
  });
});

describe('штатная камера с гиростабилизацией', () => {
  const nadir = CAMERAS[0]!;
  const fixed = CAMERAS.find((c) => c.id === 'ff61')!;
  const ctx = { site: { lat: 55, lon: 37, elevationM: 260 }, terrain, lineLegs: new Set<number>(), luxAt: () => 80_000 };
  const params = { gsdM: 0.04, forwardOverlap: 0.8, sideOverlap: 0.6, directionDeg: 0, shutterS: 1 / 1600, leadInM: 60 };
  const pose = { t: 0, position: { east: 0, north: 0, up: 150 }, groundSpeedMs: 20, headingDeg: 25, trackDeg: 0 };

  it('подвес держит кадр по линии пути, жёсткая камера разворачивается на снос', () => {
    expect(frameAt(pose, nadir, params, ctx).headingDeg).toBe(0);
    expect(frameAt(pose, fixed, params, ctx).headingDeg).toBe(25);
  });
});
