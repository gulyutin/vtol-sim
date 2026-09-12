import { PROFILE } from '@profile';
import type { AircraftSpec, CruiseReference, HoverReference } from './profile';

/*
 * Константы аппарата — единственный источник правды. Берутся из профиля
 * (src/sim/profile.ts): private/profile, если он есть, иначе демо-профиль.
 */

export const AIRCRAFT: AircraftSpec = PROFILE.aircraft;
/** Опорная точка крейсера — по ней подбирается CD0. */
export const CRUISE_REFERENCE: CruiseReference = PROFILE.cruiseReference;
/** Опорная точка висения — по ней подбирается FM. */
export const HOVER_REFERENCE: HoverReference = PROFILE.hoverReference;

/** Удлинение AR = b² / S. */
export const ASPECT_RATIO = AIRCRAFT.wingSpanM ** 2 / AIRCRAFT.wingAreaM2;
