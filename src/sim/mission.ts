import { AIRCRAFT } from './aircraft';
import { brakingDistanceM, climbPowerW, HOVER_TRANSLATE_MS, hoverPowerW, takeoffMassKg, verticalClimbPowerW, verticalDescentPowerW } from './aero';
import { airDensity, batteryCapacityWh, G, tasFromIas, temperatureAt } from './atmosphere';
import type {
  AirState,
  GeoPoint,
  MissionPlan,
  MissionResult,
  PayloadLoad,
  Phase,
  SegmentResult,
  Site,
  Waypoint,
  Weather,
} from './types';
import { windAt, windTriangle } from './wind';

const EARTH_RADIUS_M = 6371000;
const RAD = Math.PI / 180;
const VTOL = AIRCRAFT.vtol;
/** Вертикальная скорость проверяется на участках не короче этого, м: на коротких отрезках скругления округление высот даёт ложные всплески. */
const VZ_WINDOW_M = 50;

/** Высота перехода в самолётный режим над площадкой взлёта, м над морем: по плану или по РЛЭ. */
export const transitionAltitudeM = (plan: MissionPlan): number => plan.transitionAltitudeM ?? plan.takeoff.elevationM + VTOL.transitionHeightM;

/** Высота обратного перехода над площадкой посадки, м над морем: по плану или по РЛЭ. */
export const backTransitionAltitudeM = (plan: MissionPlan): number => plan.backTransitionAltitudeM ?? plan.landing.elevationM + VTOL.backTransitionHeightM;

export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Начальный путевой угол из a в b, градусы 0…360. */
export function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const lat1 = a.lat * RAD;
  const lat2 = b.lat * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Точка на расстоянии distance по начальному путевому углу bearing. */
export function destination(p: GeoPoint, bearing: number, distance: number): GeoPoint {
  const d = distance / EARTH_RADIUS_M;
  const th = bearing * RAD;
  const lat1 = p.lat * RAD;
  const lon1 = p.lon * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(th));
  const lon2 = lon1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / RAD, lon: ((lon2 / RAD + 540) % 360) - 180 };
}

/** Смещение точки относительно origin в метрах: восток, север. Для масштабов задания (десятки км). */
export function toLocal(origin: GeoPoint, p: GeoPoint): { east: number; north: number } {
  return {
    east: (p.lon - origin.lon) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD),
    north: (p.lat - origin.lat) * RAD * EARTH_RADIUS_M,
  };
}

/** Обратное к toLocal. */
export function fromLocal(origin: GeoPoint, east: number, north: number): GeoPoint {
  return {
    lat: origin.lat + north / EARTH_RADIUS_M / RAD,
    lon: origin.lon + east / (EARTH_RADIUS_M * Math.cos(origin.lat * RAD)) / RAD,
  };
}

function phase(name: string, durationS: number, powerW: number): Phase {
  return { name, durationS, powerW, energyWh: (powerW * durationS) / 3600 };
}

/** Взлёт: раскрутка на земле и вертикальный набор до высоты перехода climbM над площадкой. ρ — у площадки. */
export function takeoffPhases(massKg: number, rho: number, climbM = VTOL.transitionHeightM): Phase[] {
  return [
    phase('Раскрутка на земле', VTOL.spoolUpS, VTOL.spoolUpFactor * hoverPowerW(massKg, rho)),
    phase('Вертикальный набор', climbM / VTOL.climbRateMs, verticalClimbPowerW(massKg, rho)),
  ];
}

export function transitionPhase(massKg: number, rho: number): Phase {
  return phase('Переход в самолётный режим', VTOL.transitionS, VTOL.transitionFactor * hoverPowerW(massKg, rho));
}

/**
 * Посадка: вертикальное снижение с высоты обратного перехода descentM над площадкой и финальный
 * участок. Снижение почти не дешевле висения и длится вдвое дольше набора — поэтому
 * посадка дороже взлёта.
 */
export function landingPhases(massKg: number, rho: number, approach?: { tasMs: number; headwindMs: number }, descentM = VTOL.backTransitionHeightM): Phase[] {
  const phases: Phase[] = [];
  if (approach) {
    // Маршевый выключен за pusherOffBeforeLandingM; если встречный ветер погасил путевую раньше,
    // остаток до точки — на роторах, с сохранением высоты.
    const cut = AIRCRAFT.procedures.pusherOffBeforeLandingM;
    const crawl = cut - brakingDistanceM(massKg, approach.tasMs, rho, approach.headwindMs, cut);
    if (crawl > 1) phases.push(phase('Подход к точке на роторах', crawl / HOVER_TRANSLATE_MS, hoverPowerW(massKg, rho)));
  }
  phases.push(
    phase('Вертикальное снижение', (descentM - VTOL.finalHeightM) / VTOL.descentRateMs, verticalDescentPowerW(massKg, rho)),
    phase('Финальный участок и касание', VTOL.finalS, hoverPowerW(massKg, rho)),
  );
  return phases;
}

function flySegment(
  from: Waypoint,
  to: Waypoint,
  iasMs: number,
  massKg: number,
  weather: Weather,
  airAt: (altitudeM: number) => AirState,
  groundAt: (p: GeoPoint) => number,
  curvature: number,
): SegmentResult {
  const dist = distanceM(from, to);
  const trackDeg = bearingDeg(from, to);
  const dh = to.altitudeM - from.altitudeM;
  const midAltitude = (from.altitudeM + to.altitudeM) / 2;
  const rho = airDensity(airAt(midAltitude));
  const trueAirspeedMs = tasFromIas(iasMs, rho);
  const wind = windAt(weather, midAltitude - groundAt({ lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 }));
  const base = { from, to, distanceM: dist, trackDeg, trueAirspeedMs, wind };
  const blocked = { ...base, driftDeg: 0, groundSpeedMs: 0, verticalSpeedMs: 0, bankDeg: 0, durationS: Infinity, powerW: 0, energyWh: Infinity, infeasible: true };

  if (dist < 1) {
    // Смена высоты без горизонтального участка в самолётном режиме не считается;
    // доли метра — погрешность округления на стыке участков.
    if (Math.abs(dh) > 0.5) return blocked;
    return { ...base, driftDeg: 0, groundSpeedMs: 0, verticalSpeedMs: 0, bankDeg: 0, durationS: 0, powerW: 0, energyWh: 0, infeasible: false };
  }
  const tri = windTriangle(trueAirspeedMs, trackDeg, wind);
  if (!tri) return blocked;
  const durationS = dist / tri.groundSpeedMs;
  const verticalSpeedMs = dh / durationS;
  // Крен для линии пути заданной кривизны: tg(крен) = Vg² · κ / g; круче предельного аппарат не кренится.
  const bankDeg = Math.min(AIRCRAFT.maxBankDeg, Math.atan((tri.groundSpeedMs ** 2 * curvature) / G) / RAD);
  const powerW = climbPowerW(massKg, trueAirspeedMs, rho, verticalSpeedMs, 1 / Math.cos(bankDeg * RAD));
  return {
    ...base,
    driftDeg: tri.driftDeg,
    groundSpeedMs: tri.groundSpeedMs,
    verticalSpeedMs,
    bankDeg,
    durationS,
    powerW,
    energyWh: (powerW * durationS) / 3600,
    infeasible: false,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface SimOptions {
  /** Аварийный запас, доля ёмкости. По умолчанию AIRCRAFT.reserve; 0 — до пустой батареи. */
  reserve?: number;
}

/**
 * Энергобаланс задания. Маршрут: вертикальный взлёт, переход над площадкой,
 * сегменты takeoff → waypoints… → landing в самолётном режиме, посадка.
 * Температура по высоте — от температуры у площадки взлёта по градиенту МСА.
 */
export function simulateMission(plan: MissionPlan, weather: Weather, opts: SimOptions = {}): MissionResult {
  const issues: string[] = [];
  const payloadKg = plan.payload?.massKg ?? 0;
  const payloadW = plan.payload?.powerW ?? 0;
  if (payloadKg > AIRCRAFT.payloadMaxKg) {
    issues.push(`Нагрузка ${payloadKg} кг больше допустимой ${AIRCRAFT.payloadMaxKg} кг`);
  }
  if (plan.iasMs < AIRCRAFT.transitionLowIasMs) {
    issues.push(`Скорость ${plan.iasMs} м/с ниже порога обратного перехода ${AIRCRAFT.transitionLowIasMs} м/с`);
  }

  const massKg = takeoffMassKg(payloadKg);
  const airAt = (altitudeM: number): AirState => ({
    altitudeM,
    temperatureC: temperatureAt(altitudeM, weather.groundTemperatureC, plan.takeoff.elevationM),
  });
  const rhoTakeoff = airDensity(airAt(plan.takeoff.elevationM));
  const rhoLanding = airDensity(airAt(plan.landing.elevationM));

  const takeoff = takeoffPhases(massKg, rhoTakeoff, transitionAltitudeM(plan) - plan.takeoff.elevationM);
  const transition = transitionPhase(massKg, rhoTakeoff);
  // Заход: курс последнего отрезка и встречная составляющая ветра на высоте обратного перехода.
  const beforeLanding = plan.waypoints[plan.waypoints.length - 1] ?? plan.takeoff;
  const finalWind = windAt(weather, VTOL.backTransitionHeightM);
  const headwindMs = finalWind.speedMs * Math.cos((finalWind.fromDeg - bearingDeg(beforeLanding, plan.landing)) * RAD);
  const landing = landingPhases(massKg, rhoLanding, { tasMs: tasFromIas(plan.iasMs, rhoLanding), headwindMs }, backTransitionAltitudeM(plan) - plan.landing.elevationM);

  const path: Waypoint[] = [
    { lat: plan.takeoff.lat, lon: plan.takeoff.lon, altitudeM: transitionAltitudeM(plan) },
    ...plan.waypoints,
    { lat: plan.landing.lat, lon: plan.landing.lon, altitudeM: backTransitionAltitudeM(plan) },
  ];
  const terrain = plan.terrain;
  const groundAt = terrain ? (p: GeoPoint) => terrain.elevationM(p) : () => plan.takeoff.elevationM;
  // Кривизна пути в вершинах: угол поворота на полусумму соседних отрезков.
  const legLength = path.slice(1).map((p, i) => distanceM(path[i]!, p));
  const legTrack = path.slice(1).map((p, i) => bearingDeg(path[i]!, p));
  const curvature = path.map((_, j) => {
    if (j === 0 || j === path.length - 1) return 0;
    const len = (legLength[j - 1]! + legLength[j]!) / 2;
    if (legLength[j - 1]! < 1 || legLength[j]! < 1) return 0;
    const turn = Math.abs((((legTrack[j]! - legTrack[j - 1]!) % 360) + 540) % 360 - 180) * RAD;
    return turn / len;
  });
  const segments = path
    .slice(1)
    .map((to, i) => flySegment(path[i]!, to, plan.iasMs, massKg, weather, airAt, groundAt, (curvature[i]! + curvature[i + 1]!) / 2));
  segments.forEach((s, i) => {
    if (!s.infeasible) return;
    issues.push(
      s.distanceM < 1
        ? `Сегмент ${i + 1}: смена высоты без горизонтального участка`
        : `Сегмент ${i + 1}: ветер не даёт пройти курсом ${s.trackDeg.toFixed(0)}° при истинной скорости ${s.trueAirspeedMs.toFixed(1)} м/с`,
    );
  });

  const vz: number[] = [];
  let acc = { d: 0, dh: 0, t: 0 };
  for (const s of segments) {
    if (s.infeasible) continue;
    acc = { d: acc.d + s.distanceM, dh: acc.dh + (s.to.altitudeM - s.from.altitudeM), t: acc.t + s.durationS };
    if (acc.d < VZ_WINDOW_M) continue;
    vz.push(acc.dh / acc.t);
    acc = { d: 0, dh: 0, t: 0 };
  }
  if (acc.t > 0) vz.push(acc.dh / acc.t);
  const vzMax = Math.max(0, ...vz);
  const vzMin = Math.min(0, ...vz);
  if (vzMax > AIRCRAFT.planeClimbRateMaxMs + 0.05) {
    issues.push(`Нужен набор ${vzMax.toFixed(1)} м/с — аппарат может ${AIRCRAFT.planeClimbRateMaxMs} м/с`);
  }
  if (-vzMin > AIRCRAFT.planeDescentRateMaxMs + 0.05) {
    issues.push(`Нужно снижение ${(-vzMin).toFixed(1)} м/с — предел ${AIRCRAFT.planeDescentRateMaxMs} м/с`);
  }

  // Запас высоты над рельефом вдоль маршрута, с шагом ~50 м.
  let minClearanceM = Infinity;
  let minClearanceAtM = 0;
  if (terrain) {
    let along = 0;
    for (const s of segments) {
      const n = Math.max(1, Math.ceil(s.distanceM / 50));
      for (let j = 0; j <= n; j++) {
        const f = j / n;
        const p = { lat: s.from.lat + (s.to.lat - s.from.lat) * f, lon: s.from.lon + (s.to.lon - s.from.lon) * f };
        const clearance = s.from.altitudeM + (s.to.altitudeM - s.from.altitudeM) * f - terrain.elevationM(p);
        if (clearance < minClearanceM) {
          minClearanceM = clearance;
          minClearanceAtM = along + s.distanceM * f;
        }
      }
      along += s.distanceM;
    }
    if (minClearanceM < AIRCRAFT.minClearanceM) {
      issues.push(
        `На ${(minClearanceAtM / 1000).toFixed(1)} км маршрута всего ${minClearanceM.toFixed(0)} м над рельефом — нужно не меньше ${AIRCRAFT.minClearanceM} м`,
      );
    }
  }

  const phases = [...takeoff, transition, ...landing];
  const durationS = sum(phases.map((p) => p.durationS)) + sum(segments.map((s) => s.durationS));
  const takeoffWh = sum(takeoff.map((p) => p.energyWh));
  const transitionWh = transition.energyWh;
  const cruiseWh = sum(segments.map((s) => s.energyWh));
  const payloadWh = (payloadW * durationS) / 3600;
  const landingWh = sum(landing.map((p) => p.energyWh));
  const totalWh = takeoffWh + transitionWh + cruiseWh + payloadWh + landingWh;

  const capacityWh = batteryCapacityWh(weather.groundTemperatureC);
  const usableWh = capacityWh * (1 - (opts.reserve ?? AIRCRAFT.reserve));
  const marginWh = usableWh - totalWh;
  if (marginWh < 0 && Number.isFinite(totalWh)) {
    issues.push(`До посадки с запасом не хватает ${(-marginWh).toFixed(0)} Вт·ч`);
  }

  return {
    takeoffPhases: takeoff,
    transition,
    segments,
    landingPhases: landing,
    budget: { takeoffWh, transitionWh, cruiseWh, payloadWh, landingWh, totalWh },
    distanceM: sum(segments.map((s) => s.distanceM)),
    durationS,
    capacityWh,
    usableWh,
    marginWh,
    socAtLanding: (capacityWh - totalWh) / capacityWh,
    minClearanceM,
    feasible: issues.length === 0,
    issues,
  };
}

/**
 * Задание из нескольких полётов на одной батарее (доставка с посадкой и разгрузкой):
 * энергия и время складываются, запас проверяется по сумме. groundS — стоянка между полётами.
 */
export function combineResults(parts: MissionResult[], groundS = 0): MissionResult {
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const total = (k: keyof MissionResult['budget']) => sum(parts.map((p) => p.budget[k]));
  const budget = {
    takeoffWh: total('takeoffWh'),
    transitionWh: total('transitionWh'),
    cruiseWh: total('cruiseWh'),
    payloadWh: total('payloadWh'),
    landingWh: total('landingWh'),
    totalWh: total('totalWh'),
  };
  const issues = parts.flatMap((p, i) =>
    p.issues.filter((x) => !x.startsWith('До посадки')).map((x) => (parts.length > 1 ? `Полёт ${i + 1}: ${x}` : x)),
  );
  const marginWh = first.usableWh - budget.totalWh;
  if (marginWh < 0 && Number.isFinite(budget.totalWh)) {
    issues.push(`До последней посадки с запасом не хватает ${(-marginWh).toFixed(0)} Вт·ч`);
  }
  return {
    ...first,
    segments: parts.flatMap((p) => p.segments),
    landingPhases: last.landingPhases,
    budget,
    distanceM: sum(parts.map((p) => p.distanceM)),
    durationS: sum(parts.map((p) => p.durationS)) + groundS * (parts.length - 1),
    marginWh,
    socAtLanding: (first.capacityWh - budget.totalWh) / first.capacityWh,
    minClearanceM: Math.min(...parts.map((p) => p.minClearanceM)),
    feasible: issues.length === 0,
    issues,
  };
}

export interface StraightFlightOptions {
  site: Site;
  trackDeg: number;
  cruiseHeightAglM: number;
  iasMs: number;
  payload: PayloadLoad | null;
  weather: Weather;
  reserve?: number;
}

/**
 * Предельный полёт по прямой над ровным рельефом: взлёт, переход, набор высоты
 * на первом километре, крейсер, снижение на последнем километре, посадка.
 * Расход линеен по длине маршрута, поэтому длина находится по двум прогонам
 * simulateMission, итог — прогоном на найденной длине.
 */
export function maxStraightFlight(o: StraightFlightOptions): MissionResult {
  const leg = 1000;
  const plan = (lengthM: number): MissionPlan => {
    const at = (d: number) => destination(o.site, o.trackDeg, d);
    const altitudeM = o.site.elevationM + o.cruiseHeightAglM;
    return {
      takeoff: o.site,
      landing: { ...at(lengthM), elevationM: o.site.elevationM },
      waypoints: [
        { ...at(leg), altitudeM },
        { ...at(lengthM - leg), altitudeM },
      ],
      iasMs: o.iasMs,
      payload: o.payload,
    };
  };
  const opts: SimOptions = o.reserve === undefined ? {} : { reserve: o.reserve };
  const l1 = 10 * leg;
  const l2 = 50 * leg;
  const r1 = simulateMission(plan(l1), o.weather, opts);
  if (r1.segments.some((s) => s.infeasible)) return r1;
  const r2 = simulateMission(plan(l2), o.weather, opts);
  const whPerM = (r2.budget.totalWh - r1.budget.totalWh) / (l2 - l1);
  const lengthM = Math.max(2 * leg, l1 + r1.marginWh / whPerM);
  return simulateMission(plan(lengthM), o.weather, opts);
}
