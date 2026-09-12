import { AIRCRAFT } from './aircraft';
import { toLocal } from './mission';
import type { MissionPlan, MissionResult, SegmentResult, Waypoint } from './types';

/*
 * Проигрывание рассчитанной миссии по времени. Длительности, мощности и энергия
 * берутся из MissionResult без изменений — таймлайн только раскладывает их
 * в пространстве, чтобы аппарат можно было показать в каждый момент.
 */

/** Координаты относительно площадки взлёта, м. up — над площадкой взлёта. */
export interface LocalPoint {
  east: number;
  north: number;
  up: number;
}

export type LegKind = 'spool' | 'climb' | 'transition' | 'cruise' | 'descent' | 'final';
export type FlightMode = 'ground' | 'vtol' | 'transition' | 'plane';

/**
 * Профиль скорости на участке. τ ∈ [0, 1] — доля времени, путь нормирован на 1,
 * скорости — в единицах «длина участка / длительность». Разгон от vs за долю
 * времени a, постоянная скорость, торможение до ve за долю b.
 */
export interface SpeedProfile {
  vs: number;
  ve: number;
  a: number;
  b: number;
}

export interface Leg {
  kind: LegKind;
  name: string;
  t0: number;
  t1: number;
  /** Мощность вместе с нагрузкой, Вт. */
  powerW: number;
  /** Израсходовано к началу участка, Вт·ч. */
  energy0Wh: number;
  /** Пройдено по горизонтали к началу участка, м. */
  distance0M: number;
  from: LocalPoint;
  to: LocalPoint;
  headingDeg: number;
  trackDeg: number;
  profile: SpeedProfile;
  /**
   * Для перехода и крейсера: отрезок [s0, s1] по горизонтальной длине ломаной маршрута.
   * Положение берётся с ломаной, а не прямой from → to.
   */
  path: [number, number] | null;
  /** Сегмент маршрута: для крейсера — свой, для перехода — первый. */
  segment: SegmentResult | null;
  segmentIndex: number | null;
}

export interface Timeline {
  legs: Leg[];
  durationS: number;
  capacityWh: number;
  usableWh: number;
  totalWh: number;
  /** Точки самолётного участка: над площадкой взлёта, промежуточные, над площадкой посадки. */
  route: LocalPoint[];
  /** Горизонтальная длина ломаной route от начала до каждой точки, м. */
  routeLengths: number[];
  landing: LocalPoint;
}

export interface FlightState {
  t: number;
  leg: Leg;
  mode: FlightMode;
  position: LocalPoint;
  headingDeg: number;
  trackDeg: number;
  driftDeg: number;
  groundSpeedMs: number;
  verticalSpeedMs: number;
  /** Истинная воздушная скорость; на висении 0. */
  airspeedMs: number;
  powerW: number;
  energyWh: number;
  /** Остаток заряда, доля capacityWh; отрицательный — батарея уже пуста. */
  soc: number;
  distanceM: number;
  /** Условная загрузка подъёмных роторов и маршевого винта 0…1 — для отрисовки. */
  lift: number;
  pusher: number;
}

const STILL: SpeedProfile = { vs: 0, ve: 0, a: 0, b: 0 };
/** Торможение перед обратным переходом над площадкой посадки, с. */
const BACK_TRANSITION_DECEL_S = 12;
/** Мощность, при которой маршевый винт рисуется на полном газу, Вт. */
const PUSHER_FULL_W = 1600;

const MODE: Record<LegKind, FlightMode> = {
  spool: 'ground',
  climb: 'vtol',
  transition: 'transition',
  cruise: 'plane',
  descent: 'vtol',
  final: 'vtol',
};

function plateau(p: SpeedProfile): number {
  return (1 - (p.a * p.vs + p.b * p.ve) / 2) / (1 - (p.a + p.b) / 2);
}

/** Доля пройденного пути к моменту τ. */
export function profileDistance(p: SpeedProfile, tau: number): number {
  const v = plateau(p);
  if (tau < p.a) return p.vs * tau + ((v - p.vs) * tau * tau) / (2 * p.a);
  const accel = (p.a * (p.vs + v)) / 2;
  const c = 1 - p.b;
  if (tau <= c) return accel + v * (tau - p.a);
  const u = tau - c;
  return accel + v * (c - p.a) + v * u + ((p.ve - v) * u * u) / (2 * p.b);
}

/** Скорость в долях «длина участка / длительность». */
export function profileSpeed(p: SpeedProfile, tau: number): number {
  const v = plateau(p);
  if (tau < p.a) return p.vs + ((v - p.vs) * tau) / p.a;
  const c = 1 - p.b;
  if (tau <= c) return v;
  return v + ((p.ve - v) * (tau - c)) / p.b;
}

const lerpPoint = (a: LocalPoint, b: LocalPoint, s: number): LocalPoint => ({
  east: a.east + (b.east - a.east) * s,
  north: a.north + (b.north - a.north) * s,
  up: a.up + (b.up - a.up) * s,
});

const horizontal = (a: LocalPoint, b: LocalPoint) => Math.hypot(b.east - a.east, b.north - a.north);

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

interface LegSpec {
  kind: LegKind;
  name: string;
  durationS: number;
  /** Мощность фазы без нагрузки, Вт. */
  phasePowerW: number;
  from: LocalPoint;
  to: LocalPoint;
  segment: SegmentResult;
  profile: SpeedProfile;
  path?: [number, number];
  segmentIndex?: number;
}

/** Точка на ломаной на горизонтальном расстоянии s от начала и уклон в ней. */
function pointOnRoute(route: LocalPoint[], lengths: number[], s: number): { p: LocalPoint; slope: number } {
  let lo = 0;
  let hi = lengths.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lengths[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = route[lo]!;
  const b = route[lo + 1] ?? a;
  const len = lengths[lo + 1]! - lengths[lo]!;
  if (!(len > 0)) return { p: a, slope: 0 };
  const f = Math.min(1, Math.max(0, (s - lengths[lo]!) / len));
  return { p: lerpPoint(a, b, f), slope: (b.up - a.up) / len };
}

/** Раскладывает рассчитанную миссию во времени. Бросает, если маршрут непроходим. */
export function buildTimeline(plan: MissionPlan, result: MissionResult): Timeline {
  const segs = result.segments;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const [spool, climb] = result.takeoffPhases;
  // Посадка: [подход на роторах,] снижение, касание — подход есть, если встречный ветер погасил путевую раньше точки.
  const final = result.landingPhases.at(-1);
  const descent = result.landingPhases.at(-2);
  const approach = result.landingPhases.length > 2 ? result.landingPhases[0] : undefined;
  if (!first || !last || !spool || !climb || !descent || !final || segs.some((s) => s.infeasible)) {
    throw new Error('Маршрут непроходим — проигрывать нечего');
  }
  const payloadW = plan.payload?.powerW ?? 0;
  const origin = plan.takeoff;
  const local = (w: Waypoint): LocalPoint => ({ ...toLocal(origin, w), up: w.altitudeM - origin.elevationM });

  const legs: Leg[] = [];
  let t = 0;
  let energy = 0;
  let dist = 0;
  const add = (s: LegSpec) => {
    const powerW = s.phasePowerW + payloadW;
    legs.push({
      kind: s.kind,
      name: s.name,
      t0: t,
      t1: t + s.durationS,
      powerW,
      energy0Wh: energy,
      distance0M: dist,
      from: s.from,
      to: s.to,
      headingDeg: norm360(s.segment.trackDeg + s.segment.driftDeg),
      trackDeg: s.segment.trackDeg,
      profile: s.profile,
      path: s.path ?? null,
      segment: s.kind === 'cruise' || s.kind === 'transition' ? s.segment : null,
      segmentIndex: s.segmentIndex ?? null,
    });
    t += s.durationS;
    energy += (powerW * s.durationS) / 3600;
    dist = s.path ? s.path[1] : dist + horizontal(s.from, s.to);
  };

  const ground: LocalPoint = { east: 0, north: 0, up: 0 };
  const top = local(first.from);
  add({ kind: 'spool', name: spool.name, durationS: spool.durationS, phasePowerW: spool.powerW, from: ground, to: ground, segment: first, profile: STILL });
  add({ kind: 'climb', name: climb.name, durationS: climb.durationS, phasePowerW: climb.powerW, from: ground, to: top, segment: first, profile: { vs: 0, ve: 0, a: 0.15, b: 0.15 } });

  // Ломаная самолётного участка. Переход — разгон с места вдоль неё; крейсер проходит
  // остаток ломаной, равномерно сжатый на путь разгона (время и энергия — как в расчёте).
  const route = [top, ...segs.map((s) => local(s.to))];
  const lengths = [0];
  for (let i = 1; i < route.length; i++) lengths.push(lengths[i - 1]! + horizontal(route[i - 1]!, route[i]!));
  const total = lengths[lengths.length - 1]!;
  const at = (s: number) => pointOnRoute(route, lengths, s).p;
  const trDistance = Math.min(0.5 * first.groundSpeedMs * result.transition.durationS, 0.5 * total);
  const squeeze = total > 0 ? (total - trDistance) / total : 0;
  add({
    kind: 'transition',
    name: result.transition.name,
    durationS: result.transition.durationS,
    phasePowerW: result.transition.powerW,
    from: top,
    to: at(trDistance),
    segment: first,
    path: [0, trDistance],
    profile: { vs: 0, ve: 0, a: 1, b: 0 },
  });

  // При огибании рельефа участок маршрута разбит на много сегментов — нумеруем по исходным участкам.
  const legOf = (s: SegmentResult, i: number) => s.to.routeLeg ?? s.from.routeLeg ?? i;
  const legCount = Math.max(...segs.map(legOf)) + 1;
  segs.forEach((s, i) => {
    const isLast = i === segs.length - 1;
    const b = isLast && s.durationS > 0 ? Math.min(0.5, BACK_TRANSITION_DECEL_S / s.durationS) : 0;
    add({
      kind: 'cruise',
      name: plan.legLabels?.[legOf(s, i)] ?? `Крейсер, участок ${legOf(s, i) + 1} из ${legCount}`,
      durationS: s.durationS,
      phasePowerW: s.powerW,
      from: at(trDistance + lengths[i]! * squeeze),
      to: at(trDistance + lengths[i + 1]! * squeeze),
      segment: s,
      segmentIndex: i,
      path: [trDistance + lengths[i]! * squeeze, trDistance + lengths[i + 1]! * squeeze],
      profile: { vs: 1, ve: 0, a: 0, b },
    });
  });

  const landingTop = local(last.to);
  const landing: LocalPoint = { ...toLocal(origin, plan.landing), up: plan.landing.elevationM - origin.elevationM };
  const finalTop: LocalPoint = { ...landing, up: landing.up + AIRCRAFT.vtol.finalHeightM };
  // Подход на роторах: путь до точки уже пройден крейсерскими участками — здесь только время и энергия.
  if (approach) add({ kind: 'descent', name: approach.name, durationS: approach.durationS, phasePowerW: approach.powerW, from: landingTop, to: landingTop, segment: last, profile: STILL });
  add({ kind: 'descent', name: descent.name, durationS: descent.durationS, phasePowerW: descent.powerW, from: landingTop, to: finalTop, segment: last, profile: { vs: 0, ve: 0.4, a: 0.1, b: 0.15 } });
  add({ kind: 'final', name: final.name, durationS: final.durationS, phasePowerW: final.powerW, from: finalTop, to: landing, segment: last, profile: { vs: 0, ve: 0.3, a: 0, b: 0.5 } });

  return {
    legs,
    durationS: t,
    capacityWh: result.capacityWh,
    usableWh: result.usableWh,
    totalWh: energy,
    route,
    routeLengths: lengths,
    landing,
  };
}

/** Первый участок, который ещё не закончился к моменту t; после конца — последний. */
export function legAt(tl: Timeline, t: number): Leg {
  let lo = 0;
  let hi = tl.legs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t >= tl.legs[mid]!.t1) lo = mid + 1;
    else hi = mid;
  }
  return tl.legs[lo]!;
}

function actuators(leg: Leg, tau: number): { lift: number; pusher: number } {
  switch (leg.kind) {
    case 'spool':
      return { lift: Math.min(1, tau * 1.5), pusher: 0.15 };
    case 'climb':
      return { lift: 1, pusher: 0.15 };
    case 'transition':
      // Роторы гаснут за время перехода после команды на переход.
      return { lift: 1 - tau * tau, pusher: 1 };
    case 'cruise': {
      const cruise = Math.min(1, leg.powerW / PUSHER_FULL_W);
      const b = leg.profile.b;
      const u = b > 0 ? (tau - (1 - b)) / b : -1;
      if (u <= 0) return { lift: 0, pusher: cruise };
      return { lift: Math.min(1, u * 1.5), pusher: cruise * (1 - u) + 0.1 * u };
    }
    default:
      return { lift: 1, pusher: 0.1 };
  }
}

export function stateAt(tl: Timeline, time: number): FlightState {
  const t = Math.min(Math.max(time, 0), tl.durationS);
  const leg = legAt(tl, t);
  const duration = leg.t1 - leg.t0;
  const tau = duration > 0 ? (t - leg.t0) / duration : 1;
  const s = profileDistance(leg.profile, tau);
  const rate = duration > 0 ? profileSpeed(leg.profile, tau) / duration : 0;
  let position: LocalPoint;
  let groundSpeedMs: number;
  let verticalSpeedMs: number;
  let distanceM: number;
  if (leg.path) {
    const [s0, s1] = leg.path;
    const along = s0 + (s1 - s0) * s;
    const here = pointOnRoute(tl.route, tl.routeLengths, along);
    position = here.p;
    groundSpeedMs = rate * (s1 - s0);
    verticalSpeedMs = groundSpeedMs * here.slope;
    distanceM = along;
  } else {
    const hor = horizontal(leg.from, leg.to);
    position = lerpPoint(leg.from, leg.to, s);
    groundSpeedMs = rate * hor;
    verticalSpeedMs = rate * (leg.to.up - leg.from.up);
    distanceM = leg.distance0M + s * hor;
  }
  const ref = leg.segment;
  const k = ref && ref.groundSpeedMs > 0 ? groundSpeedMs / ref.groundSpeedMs : 0;
  const energyWh = leg.energy0Wh + (leg.powerW * (t - leg.t0)) / 3600;
  return {
    t,
    leg,
    mode: MODE[leg.kind],
    position,
    headingDeg: leg.headingDeg,
    trackDeg: leg.trackDeg,
    driftDeg: ref ? ref.driftDeg * Math.min(1, k) : 0,
    groundSpeedMs,
    verticalSpeedMs,
    airspeedMs: ref ? ref.trueAirspeedMs * k : 0,
    powerW: leg.powerW,
    energyWh,
    soc: (tl.capacityWh - energyWh) / tl.capacityWh,
    distanceM,
    ...actuators(leg, tau),
  };
}

/** Момент, когда израсходовано wh; null — за полёт не набирается. */
export function timeWhenEnergyReaches(tl: Timeline, wh: number): number | null {
  for (const leg of tl.legs) {
    const end = leg.energy0Wh + (leg.powerW * (leg.t1 - leg.t0)) / 3600;
    if (end >= wh && leg.powerW > 0) return leg.t0 + Math.max(0, ((wh - leg.energy0Wh) * 3600) / leg.powerW);
  }
  return null;
}
