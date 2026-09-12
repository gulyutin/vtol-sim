import { describe, expect, it } from 'vitest';
import { calibrateCd0, calibrateFigureOfMerit, cruisePowerW, hoverPowerW, rotorHoverPowerW, takeoffMassKg } from '../src/sim/aero';
import { AIRCRAFT, CRUISE_REFERENCE, HOVER_REFERENCE } from '../src/sim/aircraft';
import { airDensity, batteryCapacityWh, tasFromIas } from '../src/sim/atmosphere';
import { maxStraightFlight, type StraightFlightOptions } from '../src/sim/mission';
import { CAMERAS } from '../src/sim/payload';
import type { Weather } from '../src/sim/types';

/*
 * Согласованность профиля аппарата (src/sim/profile.ts) — для любого профиля, демо или своего.
 */

const CALM: Weather = { groundTemperatureC: AIRCRAFT.batteryRefTemperatureC, wind: { speedMs: 0, fromDeg: 0 } };

function fullFlight(overrides: Partial<StraightFlightOptions> = {}) {
  return maxStraightFlight({
    site: { lat: 55, lon: 37, elevationM: CRUISE_REFERENCE.air.altitudeM - 100 },
    trackDeg: 90,
    cruiseHeightAglM: 100,
    iasMs: AIRCRAFT.cruiseIasMs,
    payload: { massKg: AIRCRAFT.payloadRefKg, powerW: 0 },
    weather: CALM,
    reserve: 0,
    ...overrides,
  });
}

describe('профиль аппарата', () => {
  it('CD0 и FM совпадают с подбором по опорным точкам', () => {
    expect(AIRCRAFT.cd0).toBeCloseTo(calibrateCd0(), 4);
    expect(AIRCRAFT.figureOfMerit).toBeCloseTo(calibrateFigureOfMerit(), 4);
  });

  it('опорные точки сняты при массе планера с опорной нагрузкой', () => {
    expect(takeoffMassKg(AIRCRAFT.payloadRefKg)).toBeCloseTo(CRUISE_REFERENCE.massKg, 9);
    expect(takeoffMassKg(AIRCRAFT.payloadRefKg)).toBeCloseTo(HOVER_REFERENCE.massKg, 9);
  });

  it('крейсер в опорной точке даёт опорную мощность, висение — роторы плюс маршевый и питание', () => {
    // CD0 и FM в профиле округлены до 4 знаков — отсюда допуск 0,1 %.
    const near = (value: number, target: number) => expect(Math.abs(value / target - 1)).toBeLessThan(1e-3);
    const rho = airDensity(CRUISE_REFERENCE.air);
    near(cruisePowerW(CRUISE_REFERENCE.massKg, tasFromIas(CRUISE_REFERENCE.iasMs, rho), rho), CRUISE_REFERENCE.powerW);
    const rhoH = airDensity(HOVER_REFERENCE.air);
    near(rotorHoverPowerW(HOVER_REFERENCE.massKg, rhoH), HOVER_REFERENCE.rotorPowerW);
    near(hoverPowerW(HOVER_REFERENCE.massKg, rhoH), HOVER_REFERENCE.rotorPowerW + AIRCRAFT.auxPowerHoverW);
  });

  it('с предельной нагрузкой — не тяжелее максимальной взлётной массы', () => {
    expect(takeoffMassKg(AIRCRAFT.payloadMaxKg)).toBeLessThanOrEqual(AIRCRAFT.limits.mtowKg + 1e-9);
  });

  it('зависание перед разгоном не ниже минимального, уставки скорости по порядку', () => {
    expect(AIRCRAFT.vtol.transitionHeightM).toBeGreaterThanOrEqual(AIRCRAFT.procedures.minHoverHeightM);
    expect(AIRCRAFT.transitionLowIasMs).toBeLessThan(AIRCRAFT.transitionHighIasMs);
    expect(AIRCRAFT.transitionHighIasMs).toBeLessThanOrEqual(AIRCRAFT.cruiseIasMs);
    expect(AIRCRAFT.cruiseIasMs).toBeLessThan(AIRCRAFT.limits.maxIasMs);
  });

  it('штатная камера — первая в списке и с гиростабилизацией', () => {
    expect(CAMERAS[0]!.stabilizedYaw).toBe(true);
    expect(CAMERAS[0]!.massKg).toBeLessThanOrEqual(AIRCRAFT.payloadMaxKg);
  });

  it('на полной батарее в штиль — больше часа и десятки километров', () => {
    const r = fullFlight();
    expect(Math.abs(r.marginWh)).toBeLessThan(1);
    expect(r.durationS / 60).toBeGreaterThan(45);
    expect(r.distanceM / 1000).toBeGreaterThan(50);
  });

  it('встречный ветер 10 м/с сокращает дальность не меньше чем на 40 %', () => {
    const headwind = fullFlight({ weather: { ...CALM, wind: { speedMs: 10, fromDeg: 90 } } });
    expect(1 - headwind.distanceM / fullFlight().distanceM).toBeGreaterThanOrEqual(0.4);
  });

  it('на морозе ёмкость меньше, нагрузка сокращает дальность монотонно', () => {
    expect(batteryCapacityWh(-25)).toBeLessThan(batteryCapacityWh(AIRCRAFT.batteryRefTemperatureC));
    const ranges = [0.5, 1, 1.5, 2].map((massKg) => fullFlight({ payload: { massKg, powerW: 0 } }).distanceM);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!).toBeLessThan(ranges[i - 1]!);
  });
});
