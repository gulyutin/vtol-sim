import { AIRCRAFT } from './aircraft';
import { bearingDeg, destination } from './mission';
import type { GeoPoint, Wind } from './types';

/*
 * Взлётный и посадочный маршруты по РЛЭ: разгон против ветра к первой точке не ближе
 * departureDistanceM; посадочный маршрут — прямая из трёх точек через approachLegM,
 * последняя — точка посадки, заход против ветра.
 */

export interface WindProcedures {
  /** Направление разгона после перехода, градусы. */
  takeoffHeadingDeg: number;
  /** Первая точка взлётного маршрута. */
  departure: GeoPoint;
  /** Курс на посадочной прямой, градусы (против ветра). */
  landingHeadingDeg: number;
  /** Первые две точки посадочного маршрута: выравнивание и фиксация направления. Третья — площадка. */
  approach: [GeoPoint, GeoPoint];
}

/** Слабее этого ветер направления не задаёт: по РЛЭ при отсутствии ветра разгон — на первую точку маршрута. */
const CALM_MS = 1;

export function windProcedures(takeoff: GeoPoint, landing: GeoPoint, wind: Wind, first: GeoPoint | null, last: GeoPoint | null): WindProcedures {
  const P = AIRCRAFT.procedures;
  const calm = wind.speedMs < CALM_MS;
  const takeoffHeadingDeg = calm ? bearingDeg(takeoff, first ?? landing) : wind.fromDeg;
  const landingHeadingDeg = calm ? bearingDeg(last ?? takeoff, landing) : wind.fromDeg;
  const downwind = (landingHeadingDeg + 180) % 360;
  return {
    takeoffHeadingDeg,
    departure: destination(takeoff, takeoffHeadingDeg, P.departureDistanceM),
    landingHeadingDeg,
    approach: [destination(landing, downwind, 2 * P.approachLegM), destination(landing, downwind, P.approachLegM)],
  };
}

/** Встречная (+) и боковая составляющие ветра для курса headingDeg, м/с. */
export function windComponents(wind: Wind, headingDeg: number): { headwindMs: number; crosswindMs: number } {
  const rel = ((wind.fromDeg - headingDeg) * Math.PI) / 180;
  return { headwindMs: wind.speedMs * Math.cos(rel), crosswindMs: Math.abs(wind.speedMs * Math.sin(rel)) };
}
