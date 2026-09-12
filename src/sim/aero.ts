import { AIRCRAFT, ASPECT_RATIO, CRUISE_REFERENCE, HOVER_REFERENCE } from './aircraft';
import { airDensity, G, tasFromIas } from './atmosphere';
import type { CruiseReference, HoverReference } from './profile';

export interface PolarPoint {
  cl: number;
  cd: number;
  dragN: number;
  liftToDrag: number;
  /** Электрическая мощность P = D · V / η, Вт. */
  powerW: number;
}

export function takeoffMassKg(payloadKg: number): number {
  return AIRCRAFT.emptyMassKg + payloadKg;
}

/** Установившийся горизонтальный полёт по поляре. V — истинная скорость. */
export function polar(massKg: number, tasMs: number, rho: number, cd0: number = AIRCRAFT.cd0): PolarPoint {
  const weight = massKg * G;
  const qS = 0.5 * rho * tasMs ** 2 * AIRCRAFT.wingAreaM2;
  const cl = weight / qS;
  const cd = cd0 + cl ** 2 / (Math.PI * ASPECT_RATIO * AIRCRAFT.oswald);
  const dragN = qS * cd;
  return { cl, cd, dragN, liftToDrag: cl / cd, powerW: (dragN * tasMs) / AIRCRAFT.etaDrive };
}

export function cruisePowerW(massKg: number, tasMs: number, rho: number): number {
  return polar(massKg, tasMs, rho).powerW;
}

/**
 * Набор и снижение в самолётном режиме: P = P_cruise + m·g·Vz / η_climb (η_climb — из профиля). На снижении та же формула с Vz < 0, но не ниже холостой мощности.
 * В развороте подъёмная сила больше веса в n = 1/cos(крен) раз — растёт индуктивное сопротивление.
 */
export function climbPowerW(massKg: number, tasMs: number, rho: number, vzMs: number, loadFactor = 1): number {
  const p = polar(massKg * loadFactor, tasMs, rho).powerW + (massKg * G * vzMs) / AIRCRAFT.etaClimb;
  return Math.max(p, AIRCRAFT.idlePowerPlaneW);
}

/** Подъёмные роторы на висении: P_ideal / (FM · η_elec), Вт. */
export function rotorHoverPowerW(massKg: number, rho: number, figureOfMerit: number = AIRCRAFT.figureOfMerit): number {
  const thrust = massKg * G;
  const diskArea = AIRCRAFT.rotorCount * Math.PI * (AIRCRAFT.rotorDiameterM / 2) ** 2;
  const ideal = thrust ** 1.5 / Math.sqrt(2 * rho * diskArea);
  return ideal / (figureOfMerit * AIRCRAFT.etaElec);
}

/** Висение по батарее: роторы + маршевый винт и бортовое питание, Вт. */
export function hoverPowerW(massKg: number, rho: number): number {
  return rotorHoverPowerW(massKg, rho) + AIRCRAFT.auxPowerHoverW;
}

export function verticalClimbPowerW(massKg: number, rho: number): number {
  return AIRCRAFT.vtol.climbFactor * hoverPowerW(massKg, rho);
}

export function verticalDescentPowerW(massKg: number, rho: number): number {
  return AIRCRAFT.vtol.descentFactor * hoverPowerW(massKg, rho);
}

export type { CruiseReference, HoverReference };

/** CD0, при котором поляра даёт ref.powerW в опорной точке. Решение в замкнутой форме. */
export function calibrateCd0(ref: CruiseReference = CRUISE_REFERENCE): number {
  const rho = airDensity(ref.air);
  const tas = tasFromIas(ref.iasMs, rho);
  const withoutCd0 = polar(ref.massKg, tas, rho, 0);
  const qS = withoutCd0.dragN / withoutCd0.cd;
  const cdTotal = (ref.powerW * AIRCRAFT.etaDrive) / tas / qS;
  return cdTotal - withoutCd0.cd;
}

/** FM, при котором роторы на висении потребляют ref.rotorPowerW. */
export function calibrateFigureOfMerit(ref: HoverReference = HOVER_REFERENCE): number {
  return rotorHoverPowerW(ref.massKg, airDensity(ref.air), 1) / ref.rotorPowerW;
}

/** Скорость подхвата роторами при торможении перед посадкой, м/с истинной. */
export const ROTOR_CATCH_MS = 12;
/** Предельная путевая скорость перемещения на роторах (режим коптера), м/с. */
export const HOVER_TRANSLATE_MS = 5;

/**
 * Торможение с выключенным маршевым: сопротивление по поляре; ниже ROTOR_CATCH_MS подхватывают
 * роторы (доля lift) и дотормаживают так, чтобы путевая скорость к точке погасла над ней.
 * towardMs — путевая скорость к точке, dM — расстояние до неё. Замедление воздушной скорости, м/с².
 */
export function brakeDecel(massKg: number, tasMs: number, rho: number, towardMs: number, dM: number): { decel: number; lift: number } {
  const drag = tasMs > 1 ? polar(massKg, tasMs, rho).dragN / massKg : 0;
  const lift = Math.min(1, Math.max(0, (ROTOR_CATCH_MS - tasMs) / 6));
  const needed = dM > 1 ? Math.max(0, towardMs) ** 2 / (2 * dM) : 2;
  return { decel: Math.max(drag, lift * Math.min(2, needed)), lift };
}

/**
 * Путь торможения по земле к точке посадки на расстоянии distanceM — одномерно, как торможение
 * в живом полёте. Встречный ветер гасит путевую скорость раньше воздушной: аппарат встаёт,
 * не долетев, и остаток проходит на роторах. Подхватившие роторы частично держат аппарат
 * против ветра — на него действует доля ветра 1 − 0.8·lift.
 */
export function brakingDistanceM(massKg: number, tasMs: number, rho: number, headwindMs: number, distanceM: number): number {
  const dt = 0.1;
  let v = tasMs;
  let s = 0;
  let lift = 0;
  for (let i = 0; i < 10_000; i++) {
    const toward = v - headwindMs * (1 - 0.8 * lift);
    const d = distanceM - s;
    if (toward <= 1 || v < 1.5 || d < 3) break;
    const b = brakeDecel(massKg, v, rho, toward, d);
    lift = b.lift;
    v = Math.max(0, v - b.decel * dt);
    s += toward * dt;
  }
  return Math.min(s, distanceM);
}
