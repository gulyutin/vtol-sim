import { distanceM } from './mission';
import type { GeoPoint, Terrain } from './types';

/** Эквивалентный радиус Земли для радиоволн при стандартной рефракции (4/3 R). */
const EFFECTIVE_EARTH_RADIUS_M = (6371000 * 4) / 3;

export interface LineOfSight {
  clear: boolean;
  /** Наименьший просвет между лучом и рельефом, м; отрицательный — луч упирается в рельеф. */
  clearanceM: number;
  distanceM: number;
}

/**
 * Прямая видимость между антенной НСУ и бортом: рельеф и кривизна Земли (4/3 R), без учёта
 * зоны Френеля. По РЛЭ нужна прямая видимость с самой дальней точкой маршрута.
 */
export function lineOfSight(
  terrain: Terrain,
  antenna: GeoPoint & { altitudeM: number },
  target: GeoPoint & { altitudeM: number },
  samples = 80,
): LineOfSight {
  const d = distanceM(antenna, target);
  let clearanceM = Infinity;
  for (let i = 1; i < samples; i++) {
    const f = i / samples;
    const p = { lat: antenna.lat + (target.lat - antenna.lat) * f, lon: antenna.lon + (target.lon - antenna.lon) * f };
    const x = d * f;
    const ray = antenna.altitudeM + (target.altitudeM - antenna.altitudeM) * f;
    // Выпуклость Земли над хордой между антенной и бортом.
    const bulge = (x * (d - x)) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    clearanceM = Math.min(clearanceM, ray - terrain.elevationM(p) - bulge);
  }
  return { clear: clearanceM > 0, clearanceM, distanceM: d };
}
