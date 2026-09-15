import { afterEach, describe, expect, it, vi } from 'vitest';
import { blocked, preflightChecks } from '../src/game/preflight';
import { activeRegion, REGION_PRESETS, REGIONS, setRegion } from '../src/game/regions';
import { ACTIVE_OSM_URL, buildMission, buildScenarios, forecastWeather, REGION, SCENARIOS, type TransferScenario } from '../src/game/scenarios';
import { hoverPowerW, takeoffMassKg } from '../src/sim/aero';
import { AIRCRAFT } from '../src/sim/aircraft';
import { airDensity, tasFromIas } from '../src/sim/atmosphere';
import { combineResults, distanceM, simulateMission } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { GeoPoint } from '../src/sim/types';

/*
 * Районы заданий (src/game/regions.ts): задания каждого района строятся и проходят предполётные
 * проверки в погоде по умолчанию. Рельеф — ровный на высоте площадки (по тайлам Terrarium);
 * проверка трасс на настоящем рельефе — при подборе районов, не в тестах (нужна сеть).
 */

/** Высота площадки над морем, м; у домашнего района — условная. */
const SITE_ELEVATION_M: Record<string, number> = { home: 250, elbrus: 1876, khibiny: 231, baikal: 488 };
/** Дополнительные районы профиля (PROFILE.regions) — условная высота. */
const siteElevationM = (id: string) => SITE_ELEVATION_M[id] ?? 200;

const inside = (r: { south: number; west: number; north: number; east: number }, p: GeoPoint) =>
  p.lat > r.south && p.lat < r.north && p.lon > r.west && p.lon < r.east;

afterEach(() => vi.unstubAllGlobals());

describe('районы', () => {
  it('первый — домашний из профиля, у всех разные id и есть подсказка', () => {
    expect(REGIONS[0]!.id).toBe('home');
    expect(new Set(REGIONS.map((r) => r.id)).size).toBe(REGIONS.length);
    expect(REGIONS.length).toBeGreaterThanOrEqual(4);
    for (const r of REGIONS) expect(r.title && r.hint).toBeTruthy();
    // Кутурчин без готового файла: дома и лес собираются в браузере (src/ui/placeOsm.ts).
    for (const r of REGION_PRESETS.slice(1)) if (r.id !== 'kuturchin') expect(r.osmUrl).toMatch(/\.bin/);
  });

  it('без адреса и хранилища (тесты) — домашний район; задания и область — из него', () => {
    expect(activeRegion().id).toBe('home');
    const home = REGION_PRESETS[0]!;
    expect(REGION).toEqual(home.location.region);
    expect(ACTIVE_OSM_URL).toBe(home.osmUrl);
    expect(SCENARIOS.map((s) => s.title)).toEqual(buildScenarios(home.location).map((s) => s.title));
  });

  it('выбор: ?region= в адресе, иначе последний выбор; неизвестный id — домашний', () => {
    const store = new Map<string, string>();
    const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const location = { search: '?model=aircraft' };
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('location', location);
    setRegion('baikal');
    expect(location.search).toBe('?model=aircraft&region=baikal');
    expect(activeRegion().id).toBe('baikal');
    location.search = '';
    expect(activeRegion().id).toBe('baikal');
    location.search = '?region=khibiny';
    expect(activeRegion().id).toBe('khibiny');
    location.search = '?region=nowhere';
    expect(activeRegion().id).toBe('home');
  });
});

describe.each(REGION_PRESETS.map((r) => [r.id, r] as const))('район %s', (id, preset) => {
  const L = preset.location;
  const terrain = flatTerrain(siteElevationM(id));
  const scenarios = buildScenarios(L);

  it('четыре задания (и поиск, если он есть в районе), первое — перелёт; все точки внутри области не больше 0,3° × 0,5°', () => {
    expect(scenarios.map((s) => s.kind)).toEqual(['transfer', 'route', 'survey', 'delivery', ...(L.search ? ['search'] : [])]);
    expect(L.region.north - L.region.south).toBeLessThanOrEqual(0.33);
    expect(L.region.east - L.region.west).toBeLessThanOrEqual(0.51);
    const points = [L.site, L.transfer.destination, L.delivery.destination, ...L.transfer.route, ...L.delivery.route, ...L.route.route, ...L.survey.area, ...(L.search?.area ?? [])];
    for (const p of points) expect(inside(L.region, p), `${p.lat}, ${p.lon}`).toBe(true);
  });

  it('перелёт садится в Б', () => {
    const t = scenarios[0] as TransferScenario;
    const m = buildMission(t, t.defaults, terrain);
    expect(m.stages).toHaveLength(1);
    expect(distanceM(m.stages[0]!.landing, t.destination)).toBeLessThan(1);
    expect(distanceM(m.stages[0]!.takeoff, L.site)).toBeLessThan(1);
  });

  it.each(scenarios.map((s) => [s.kind, s] as const))('%s: в погоде по умолчанию готов к вылету, энергии хватает с запасом', (_, sc) => {
    const weather = forecastWeather(sc, sc.defaults);
    const m = buildMission(sc, sc.defaults, terrain, weather);
    const checks = preflightChecks({ stages: m.stages, weather, procedures: m.procedures, cloudBaseM: sc.cloudBaseM, terrain, gcs: m.site });
    expect(checks.filter((c) => !c.ok && c.level === 'block').map((c) => c.text)).toEqual([]);
    expect(blocked(checks)).toBe(false);
    const results = m.stages.map((p) => simulateMission(p, weather));
    const total = combineResults(results, sc.kind === 'delivery' ? sc.unloadS : 0);
    expect(total.issues).toEqual([]);
    // Сверх аварийного запаса остаётся не меньше пятой части батареи.
    expect(total.socAtLanding).toBeGreaterThan(AIRCRAFT.reserve + 0.2);
  });
});

describe('высота площадки', () => {
  const air = (id: string) => {
    const L = REGION_PRESETS.find((r) => r.id === id)!.location;
    return airDensity({ altitudeM: SITE_ELEVATION_M[id]!, temperatureC: L.temperatureC });
  };

  it('в горах воздух реже: висение дороже, истинная скорость при той же приборной выше', () => {
    const mass = takeoffMassKg(AIRCRAFT.payloadMaxKg);
    const [home, elbrus] = [air('home'), air('elbrus')];
    expect(elbrus / home).toBeLessThan(0.87);
    expect(hoverPowerW(mass, elbrus) / hoverPowerW(mass, home)).toBeGreaterThan(1.05);
    expect(tasFromIas(AIRCRAFT.cruiseIasMs, elbrus) / tasFromIas(AIRCRAFT.cruiseIasMs, home)).toBeGreaterThan(1.07);
  });

  it('взлёт того же перелёта на высокогорной площадке расходует больше', () => {
    const takeoffWh = (id: string) => {
      const L = REGION_PRESETS.find((r) => r.id === id)!.location;
      const t = buildScenarios(L)[0] as TransferScenario;
      const weather = { ...forecastWeather(t, t.defaults), groundTemperatureC: 15 };
      const plan = buildMission(t, t.defaults, flatTerrain(SITE_ELEVATION_M[id]!), weather).stages[0]!;
      return simulateMission(plan, weather).budget.takeoffWh;
    };
    expect(takeoffWh('elbrus') / takeoffWh('home')).toBeGreaterThan(1.05);
  });
});
