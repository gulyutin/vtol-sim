import { describe, expect, it } from 'vitest';
import { takeoffMassKg } from '../src/sim/aero';
import { AIRCRAFT } from '../src/sim/aircraft';
import { airDensity, batteryCapacityWh, tasFromIas } from '../src/sim/atmosphere';
import { destination, fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import { planReach, pointOfNoReturn, reachFrom, type ReachOptions } from '../src/sim/reach';
import { flatTerrain, followTerrain, GridTerrain, mercatorPixel } from '../src/sim/terrain';
import type { Site, Terrain, Weather } from '../src/sim/types';

const site: Site = { lat: 54.8, lon: 37.6, elevationM: 200 };
const flat = flatTerrain(200);
const weather = (speedMs: number, fromDeg = 270): Weather => ({
  groundTemperatureC: AIRCRAFT.batteryRefTemperatureC,
  wind: { speedMs, fromDeg },
  windProfile: { referenceHeightM: 10, shearExponent: 0.2 },
});
const opts = (w: Weather, terrain: Terrain = flat): ReachOptions => ({ weather: w, terrain, iasMs: AIRCRAFT.cruiseIasMs, payload: null, cruiseHeightAglM: 150 });
const usable = (w: Weather) => batteryCapacityWh(w.groundTemperatureC) * (1 - AIRCRAFT.reserve);
/** Номер луча по направлению (лучей 72 на планировании, 36 в полёте). */
const ray = (deg: number, rays: number) => Math.round((deg / 360) * rays) % rays;
const VT = AIRCRAFT.vtol;

/** Задание «туда и обратно» по лучу bearing на дальность d — как его посчитал бы simulateMission. */
function outAndBack(bearing: number, d: number, w: Weather) {
  const P = destination(site, bearing, d);
  const tas = tasFromIas(AIRCRAFT.cruiseIasMs, airDensity({ altitudeM: site.elevationM + 150, temperatureC: w.groundTemperatureC }));
  const follow = { heightAglM: 150, groundSpeedMs: () => tas, stepM: 100 };
  const waypoints = followTerrain([site, P, site], flat, site.elevationM + VT.transitionHeightM, site.elevationM + VT.backTransitionHeightM, AIRCRAFT.planeClimbRateMaxMs * 0.9, AIRCRAFT.planeDescentRateMaxMs * 0.9, follow);
  return simulateMission({ takeoff: site, landing: site, waypoints, iasMs: AIRCRAFT.cruiseIasMs, payload: null, terrain: flat }, w);
}

describe('досягаемость на планировании', () => {
  it('штиль, ровный рельеф: почти круг, радиус сходится с simulateMission туда-обратно', () => {
    const w = weather(0);
    const r = planReach(site, opts(w));
    const zero = r.rings[r.rings.length - 1]!;
    expect(zero.label).toBe('впритык');
    expect((r.stats.maxRadiusM - r.stats.minRadiusM) / r.stats.meanRadiusM).toBeLessThan(0.02);
    // Кольца вложены: запас 25 % < 10 % < впритык < в один конец.
    const d = (k: number) => r.rings[k]!.distanceM[0]!;
    expect(d(0)).toBeLessThan(d(1));
    expect(d(1)).toBeLessThan(d(2));
    expect(d(2)).toBeLessThan(r.oneWay.distanceM[0]!);
    const R = zero.distanceM[ray(90, 72)]!;
    expect(Math.abs(outAndBack(90, R, w).marginWh) / usable(w)).toBeLessThan(0.01);
    expect(outAndBack(90, R * 0.96, w).marginWh).toBeGreaterThan(0);
    expect(outAndBack(90, R * 1.04, w).marginWh).toBeLessThan(0);
    // Запас 25 %: израсходовано три четверти доступного.
    const m25 = outAndBack(90, r.rings[0]!.distanceM[ray(90, 72)]!, w);
    expect(m25.budget.totalWh / usable(w)).toBeCloseTo(0.75, 1);
    expect(r.stats.computeMs).toBeLessThan(1000);
  });

  it('ветер 8 м/с: против ветра ближе всего, по ветру дальше; «в один конец» смещена по ветру', () => {
    const r = planReach(site, opts(weather(8, 270)));
    const zero = r.rings[r.rings.length - 1]!.distanceM;
    const up = zero[ray(270, 72)]!;
    const down = zero[ray(90, 72)]!;
    expect(up).toBeLessThan(down);
    expect(Math.abs((((r.stats.minBearingDeg - 270) % 360) + 540) % 360 - 180)).toBeLessThanOrEqual(20);
    expect(r.stats.meanRadiusM).toBeLessThan(planReach(site, opts(weather(0))).stats.meanRadiusM);
    // Центр кольца «впритык» — по ветру (к востоку) от площадки.
    const east = r.rings[r.rings.length - 1]!.polygon.reduce((a, p) => a + toLocal(site, p).east, 0) / zero.length;
    expect(east).toBeGreaterThan(0);
    expect(r.oneWay.distanceM[ray(90, 72)]!).toBeGreaterThan(1.5 * r.oneWay.distanceM[ray(270, 72)]!);
  });

  it('хребет: на плато за уступом в один конец ближе на набор; туда-обратно набор возвращается на снижении', () => {
    const w = weather(0);
    const riseM = 400;
    // Уступ в 8…10 км к востоку, за ним плато на riseM выше.
    const plateau: Terrain = { elevationM: (p) => 200 + riseM * Math.min(1, Math.max(0, (toLocal(site, p).east - 8000) / 2000)) };
    // Гряда в 10 км к востоку: 500 м высотой, 4 км у подножия.
    const ridge: Terrain = { elevationM: (p) => 200 + 500 * Math.max(0, 1 - Math.abs(toLocal(site, p).east - 10_000) / 2000) };
    const base = planReach(site, opts(w));
    const high = planReach(site, opts(w, plateau));
    const E = ray(90, 72);
    const W = ray(270, 72);
    const lostM = base.oneWay.distanceM[E]! - high.oneWay.distanceM[E]!;
    expect(lostM).toBeGreaterThan(500);
    // Потеря дальности ≈ энергия набора m·g·Δh/η по расходу на метр в крейсере.
    const mgh = (takeoffMassKg(0) * 9.80665 * riseM) / AIRCRAFT.etaClimb / 3600;
    const whPerM = usable(w) / (2 * base.oneWay.distanceM[W]!) ;
    expect(lostM).toBeGreaterThan((0.5 * mgh) / whPerM);
    expect(lostM).toBeLessThan((2 * mgh) / whPerM);
    // На запад рельеф ровный — там ничего не меняется.
    expect(high.oneWay.distanceM[W]).toBeCloseTo(base.oneWay.distanceM[W]!, -1);
    const over = planReach(site, opts(w, ridge));
    const zero = (x: typeof base) => x.rings[x.rings.length - 1]!.distanceM[E]!;
    expect(zero(over)).toBeLessThanOrEqual(zero(base) + 1);
    expect(Math.abs(zero(over) / zero(base) - 1)).toBeLessThan(0.01);
  });
});

describe('досягаемость в полёте', () => {
  const w = weather(8, 270);
  const aloft = { ...site, altitudeM: site.elevationM + 150 };

  it('с половиной заряда радиус меньше, а с полной батареей — не меньше, чем на планировании', () => {
    const E = usable(w);
    const full = reachFrom(aloft, E, site, opts(w));
    const half = reachFrom(aloft, E / 2, site, opts(w));
    const plan = planReach(site, opts(w));
    expect(half.stats.meanRadiusM).toBeLessThan(0.6 * full.stats.meanRadiusM);
    expect(full.stats.meanRadiusM).toBeGreaterThan(plan.stats.meanRadiusM);
    // Грубее и дешевле планирования.
    expect(half.bearingsDeg.length).toBeLessThan(plan.bearingsDeg.length);
    expect(half.stats.computeMs).toBeLessThan(plan.stats.computeMs + 50);
  });

  it('от борта вдали от дома: область вытянута к дому, возврат отсюда стоит энергии', () => {
    const pos = { ...fromLocal(site, 10_000, 0), altitudeM: site.elevationM + 150 };
    const r = reachFrom(pos, usable(w) / 2, site, opts(w));
    expect(r.stats.returnNowWh).toBeGreaterThan(0);
    const zero = r.rings[r.rings.length - 1]!.distanceM;
    // Дом к западу: на запад (к дому) дальше, чем на восток (от дома).
    expect(zero[ray(270, 36)]!).toBeGreaterThan(zero[ray(90, 36)]!);
  });

  it('точка невозврата: на кольце «впритык» по курсу, время — по путевой, пройденная — когда не хватает', () => {
    const pos = { ...fromLocal(site, 5000, 0), altitudeM: site.elevationM + 150 };
    const E = usable(w) * 0.6;
    const pnr = pointOfNoReturn(pos, 90, E, site, opts(w));
    expect(pnr.passed).toBe(false);
    expect(pnr.position).not.toBeNull();
    const ring = reachFrom(pos, E, site, opts(w)).rings.at(-1)!.distanceM[ray(90, 36)]!;
    expect(Math.abs(pnr.distanceM / ring - 1)).toBeLessThan(0.01);
    expect(pnr.spareWh).toBeGreaterThan(0);
    // Курс по ветру: путевая больше воздушной.
    const tas = tasFromIas(AIRCRAFT.cruiseIasMs, airDensity({ altitudeM: pos.altitudeM, temperatureC: w.groundTemperatureC }));
    expect(pnr.distanceM / pnr.timeS).toBeGreaterThan(tas);
    expect(pnr.returnPath[1]).toEqual(site);
    // Энергии меньше, чем нужно на возврат, — точка пройдена.
    const late = pointOfNoReturn(pos, 90, pnr.returnNowWh * 0.9, site, opts(w));
    expect(late.passed).toBe(true);
    // Меньше энергии — точка невозврата ближе.
    expect(pointOfNoReturn(pos, 90, E * 0.8, site, opts(w)).distanceM).toBeLessThan(pnr.distanceM);
  });
});

describe('время расчёта', () => {
  it('на сетке высот: планирование до 0,3 с (с запасом на медленную машину — до 1 с), полёт — дешевле', () => {
    const size = 1024;
    const c = mercatorPixel(site, 12);
    const h = new Float32Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) h[j * size + i] = 200 + 120 * Math.sin(i / 40) * Math.cos(j / 55) + 60 * Math.sin((i + j) / 17);
    const terrain = new GridTerrain(h, size, size, 12, Math.floor(c.x) - size / 2, Math.floor(c.y) - size / 2);
    const s = { ...site, elevationM: terrain.elevationM(site) };
    const w = weather(8, 270);
    const plan = planReach(s, opts(w, terrain));
    const flight1 = reachFrom({ ...fromLocal(s, 3000, 2000), altitudeM: s.elevationM + 200 }, usable(w) * 0.7, s, opts(w, terrain));
    const flight2 = reachFrom({ ...fromLocal(s, 3200, 2000), altitudeM: s.elevationM + 200 }, usable(w) * 0.69, s, opts(w, terrain));
    console.log(`досягаемость: планирование ${plan.stats.computeMs.toFixed(0)} мс, полёт ${flight1.stats.computeMs.toFixed(0)} мс (с полем возврата), ${flight2.stats.computeMs.toFixed(0)} мс (поле из памяти)`);
    expect(plan.stats.computeMs).toBeLessThan(1000);
    expect(flight2.stats.computeMs).toBeLessThan(plan.stats.computeMs);
  });
});
