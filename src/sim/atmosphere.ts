import { AIRCRAFT } from './aircraft';
import type { AirState } from './types';

export const G = 9.80665;
/** Плотность воздуха по МСА на уровне моря, кг/м³. */
export const RHO0 = 1.225;

const R_AIR = 287.053;
const P0 = 101325;
const T0 = 288.15;
const LAPSE = 0.0065;

/** Давление по МСА (тропосфера), Па. */
export function pressurePa(altitudeM: number): number {
  return P0 * Math.pow(1 - (LAPSE * altitudeM) / T0, G / (R_AIR * LAPSE));
}

/** ρ(h, T): давление по МСА на высоте h, температура — фактическая, кг/м³. */
export function airDensity(air: AirState): number {
  return pressurePa(air.altitudeM) / (R_AIR * (air.temperatureC + 273.15));
}

/** Температура на высоте по градиенту МСА от известной у земли, °C. */
export function temperatureAt(altitudeM: number, groundTemperatureC: number, groundElevationM: number): number {
  return groundTemperatureC - LAPSE * (altitudeM - groundElevationM);
}

/** Истинная скорость по приборной: V = V_ias · √(ρ₀/ρ). */
export function tasFromIas(iasMs: number, rho: number): number {
  return iasMs * Math.sqrt(RHO0 / rho);
}

/** Множитель ёмкости по таблице профиля (1.00 при +25 °C). */
export function batteryDerate(temperatureC: number): number {
  const table = AIRCRAFT.batteryTemperatureDerate;
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (temperatureC <= first[0]) return first[1];
  if (temperatureC >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [t1, k1] = table[i]!;
    if (temperatureC <= t1) {
      const [t0, k0] = table[i - 1]!;
      return k0 + ((k1 - k0) * (temperatureC - t0)) / (t1 - t0);
    }
  }
  return last[1];
}

/**
 * Доступная ёмкость АКБ при температуре, Вт·ч. batteryWh задана при batteryRefTemperatureC,
 * поэтому таблица применяется относительно этой температуры.
 */
export function batteryCapacityWh(temperatureC: number): number {
  return (AIRCRAFT.batteryWh * batteryDerate(temperatureC)) / batteryDerate(AIRCRAFT.batteryRefTemperatureC);
}
