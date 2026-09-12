import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../src/sim/aircraft';
import { climbPowerW, polar, takeoffMassKg } from '../src/sim/aero';
import { airDensity, G, tasFromIas } from '../src/sim/atmosphere';
import { dubins, samplePath } from '../src/sim/dubins';
import { destination, fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import { sunPosition } from '../src/sim/sun';
import { flatTerrain, followTerrain, GridTerrain, mercatorPixel, mercatorToGeo } from '../src/sim/terrain';
import type { MissionPlan, Site, Terrain, Weather } from '../src/sim/types';
import { windAt } from '../src/sim/wind';

const SITE: Site = { lat: 55, lon: 60, elevationM: 300 };
const CALM: Weather = { groundTemperatureC: 20, wind: { speedMs: 0, fromDeg: 0 } };
const M = takeoffMassKg(AIRCRAFT.payloadRefKg);

/** Рельеф как функция расстояния на восток от площадки. */
function terrainByEast(f: (x: number) => number): Terrain {
  return { elevationM: (p) => f(toLocal(SITE, p).east) };
}

function straightPlan(lengthM: number, terrain: Terrain, landingElevationM: number, heightAglM = 100): MissionPlan {
  const end = destination(SITE, 90, lengthM);
  const tas = tasFromIas(21, airDensity({ altitudeM: SITE.elevationM + heightAglM, temperatureC: 20 }));
  const waypoints = followTerrain(
    [SITE, end],
    terrain,
    SITE.elevationM + AIRCRAFT.vtol.transitionHeightM,
    landingElevationM + AIRCRAFT.vtol.backTransitionHeightM,
    AIRCRAFT.planeClimbRateMaxMs * 0.9,
    AIRCRAFT.planeDescentRateMaxMs * 0.9,
    { heightAglM, groundSpeedMs: () => tas },
  );
  return { takeoff: SITE, landing: { ...end, elevationM: landingElevationM }, waypoints, iasMs: 21, payload: null, terrain };
}

describe('рельеф', () => {
  it('сетка высот: значения в центрах пикселей и билинейно между ними', () => {
    const z = 13;
    const px = mercatorPixel(SITE, z);
    const x0 = Math.floor(px.x) - 1;
    const y0 = Math.floor(px.y) - 1;
    const grid = new GridTerrain(new Float32Array([100, 200, 300, 400, 500, 600, 700, 800, 900]), 3, 3, z, x0, y0);
    const at = (i: number, j: number) => grid.elevationM(mercatorToGeo(x0 + i + 0.5, y0 + j + 0.5, z));
    expect(at(0, 0)).toBeCloseTo(100, 3);
    expect(at(2, 1)).toBeCloseTo(600, 3);
    expect(at(0.5, 0.5)).toBeCloseTo(300, 3);
    expect(at(-5, 1)).toBeCloseTo(400, 3);
  });

  it('огибание хребта: набор начинается заранее, градиенты не круче предельных, над гребнем — заданная высота', () => {
    const ridge = (x: number) => 300 + 300 * Math.exp(-(((x - 5000) / 800) ** 2));
    const plan = straightPlan(10_000, terrainByEast(ridge), 300);
    const tas = tasFromIas(21, airDensity({ altitudeM: 400, temperatureC: 20 }));
    const pts = [{ ...SITE, altitudeM: SITE.elevationM + AIRCRAFT.vtol.transitionHeightM }, ...plan.waypoints];
    for (let i = 1; i < pts.length; i++) {
      const d = toLocal(SITE, pts[i]!).east - toLocal(SITE, pts[i - 1]!).east;
      const dh = pts[i]!.altitudeM - pts[i - 1]!.altitudeM;
      // Допуск 1e-4 — разница между дугой большого круга и локальными координатами.
      expect(dh / d).toBeLessThanOrEqual(((AIRCRAFT.planeClimbRateMaxMs * 0.9) / tas) * (1 + 1e-4));
      expect(-dh / d).toBeLessThanOrEqual(((AIRCRAFT.planeDescentRateMaxMs * 0.9) / tas) * (1 + 1e-4));
    }
    const crest = plan.waypoints.reduce((best, w) => (Math.abs(toLocal(SITE, w).east - 5000) < Math.abs(toLocal(SITE, best).east - 5000) ? w : best));
    expect(crest.altitudeM).toBeGreaterThanOrEqual(ridge(5000) + 100 - 1);
    const r = simulateMission(plan, CALM);
    expect(r.issues).toEqual([]);
    expect(r.minClearanceM).toBeGreaterThanOrEqual(AIRCRAFT.minClearanceM);
  });

  it('подъём на плато стоит m·g·Δh / η_climb', () => {
    const rise = 300;
    const ramp = (x: number) => 300 + rise * Math.min(1, Math.max(0, (x - 2000) / 6000));
    const hill = simulateMission(straightPlan(12_000, terrainByEast(ramp), 300 + rise), CALM);
    const flat = simulateMission(straightPlan(12_000, flatTerrain(300), 300), CALM);
    // План без нагрузки — масса планера с АКБ.
    const climbWh = (takeoffMassKg(0) * G * rise) / AIRCRAFT.etaClimb / 3600;
    // Посадка сравнивается отдельно: в разреженном воздухе и висение, и путь торможения другие.
    const flying = (r: typeof hill) => r.budget.totalWh - r.budget.landingWh;
    expect(flying(hill) - flying(flat)).toBeGreaterThan(climbWh);
    expect(flying(hill) - flying(flat)).toBeLessThan(climbWh + 2);
  });

  it('полёт ниже рельефа даёт замечание', () => {
    const wall = terrainByEast((x) => (x > 4000 && x < 5000 ? 700 : 300));
    const plan: MissionPlan = { ...straightPlan(10_000, flatTerrain(300), 300), terrain: wall };
    const r = simulateMission(plan, CALM);
    expect(r.minClearanceM).toBeLessThan(0);
    expect(r.issues.some((s) => s.includes('над рельефом'))).toBe(true);
  });
});

describe('развороты', () => {
  it('в развороте мощность растёт на индуктивную часть · (n² − 1)', () => {
    const rho = airDensity({ altitudeM: 500, temperatureC: 20 });
    const tas = tasFromIas(21, rho);
    const n = 1 / Math.cos((25 * Math.PI) / 180);
    // Поляра без CD0 — чисто индуктивная мощность.
    const induced = polar(M, tas, rho, 0).powerW;
    expect(climbPowerW(M, tas, rho, 0, n) - climbPowerW(M, tas, rho, 0)).toBeCloseTo(induced * (n * n - 1), 6);
  });

  it('дуга минимального радиуса проходится с предельным креном', () => {
    const tas = tasFromIas(21, airDensity({ altitudeM: 400, temperatureC: 20 }));
    const R = tas ** 2 / (G * Math.tan((AIRCRAFT.maxBankDeg * Math.PI) / 180));
    const arc = samplePath(dubins({ x: 1000, y: 0, theta: 0 }, { x: 1000, y: 2 * R, theta: Math.PI }, R), 15);
    const waypoints = [...arc, { x: 0, y: 2 * R, theta: Math.PI }].map((q) => ({ ...fromLocal(SITE, q.x, q.y), altitudeM: 400 }));
    const end = fromLocal(SITE, 0, 2 * R);
    const r = simulateMission({ takeoff: SITE, landing: { ...end, elevationM: 300 }, waypoints, iasMs: 21, payload: null }, CALM);
    const onArc = r.segments.slice(2, arc.length - 1).map((s) => s.bankDeg);
    const mean = onArc.reduce((a, b) => a + b, 0) / onArc.length;
    expect(mean).toBeGreaterThan(AIRCRAFT.maxBankDeg - 3);
    expect(Math.max(...onArc)).toBeLessThanOrEqual(AIRCRAFT.maxBankDeg);
    expect(r.segments[0]!.bankDeg).toBeLessThan(1);
  });
});

describe('ветер и Солнце', () => {
  it('ветер растёт с высотой по степенному закону от прогноза на 10 м', () => {
    const w: Weather = { ...CALM, wind: { speedMs: 5, fromDeg: 270 }, windProfile: { referenceHeightM: 10, shearExponent: 0.14 } };
    expect(windAt(w, 10).speedMs).toBeCloseTo(5, 9);
    expect(windAt(w, 100).speedMs).toBeCloseTo(5 * 10 ** 0.14, 9);
    expect(windAt({ ...CALM, wind: { speedMs: 5, fromDeg: 0 } }, 100).speedMs).toBe(5);
  });

  it('Солнце в истинный полдень летнего солнцестояния на 55° с. ш.: высота ≈ 58.4°, на юге', () => {
    // Истинный полдень на 60° в. д. — около 08:02 UTC.
    const s = sunPosition(new Date('2026-06-21T08:02:00Z'), { lat: 55, lon: 60 });
    expect(s.elevationDeg).toBeCloseTo(90 - 55 + 23.44, 0);
    expect(Math.abs(s.azimuthDeg - 180)).toBeLessThan(2);
  });
});
