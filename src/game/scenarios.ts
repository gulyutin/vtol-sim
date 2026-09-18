import { PROFILE } from '@profile';
import { AIRCRAFT } from '../sim/aircraft';
import { airDensity, G, tasFromIas } from '../sim/atmosphere';
import { distanceM, fromLocal, toLocal } from '../sim/mission';
import { roundSharpCorners, type LegPart } from '../sim/dubins';
import { LINK_TIMEOUT_S, type LinkLossAction } from '../sim/failures';
import { CAMERAS } from '../sim/payload';
import { windProcedures, type WindProcedures } from '../sim/procedures';
import { heightForGsdM, planSurvey, type SurveyCamera, type SurveyParams, type SurveyPlan } from '../sim/survey';
import { followTerrain, terrainEndAltitudes } from '../sim/terrain';
import type { AltitudeRef, LocationSpec, RoutePoint } from '../sim/profile';
import type { Relay } from '../sim/radio';
import type { GeoPoint, MissionPlan, PayloadLoad, Site, Terrain, Weather } from '../sim/types';
import { sunPosition } from '../sim/sun';
import { stabilityShear, windAt, windTriangle } from '../sim/wind';
import { activeRegion } from './regions';
import { searchPattern, THERMAL_CAMERA, type AnimalWeights, type ThermalCamera } from './search';

/** То, что игрок выбирает на планировании. Часть полей нужна не всем заданиям. */
export interface Settings {
  cameraId: string;
  gsdCm: number;
  forwardOverlapPct: number;
  sideOverlapPct: number;
  /** Направление галсов, градусы от севера. */
  directionDeg: number;
  /** Выдержка 1/shutter с. */
  shutter: number;
  /** Масса груза в доставке, кг. */
  cargoKg: number;
  /** Уставка приборной скорости, м/с. */
  iasMs: number;
  /** Прогноз ветра на 10 м. */
  windSpeedMs: number;
  windFromDeg: number;
  temperatureC: number;
  /** Местное время вылета, ч — для Солнца и освещённости. */
  localHour: number;
  /** Потеря связи с НСУ: что делает автопилот и через сколько секунд без связи. */
  linkLossAction: LinkLossAction;
  linkLossTimeoutS: number;
  /** Высота точек маршрута: над рельефом, над морем или от точки взлёта. */
  altitudeRef: AltitudeRef;
  /** Курс захода на посадку, градусы; нет (null) — против ветра. */
  approachDeg?: number | null;
}

export type ScenarioKind = 'transfer' | 'survey' | 'delivery' | 'route' | 'search' | 'fire';

export type { AltitudeRef, RoutePoint };

interface ScenarioBase {
  id: string;
  kind: ScenarioKind;
  title: string;
  briefing: string;
  /** Площадка взлёта; высота берётся из рельефа. */
  site: GeoPoint;
  siteName: string;
  /** Показатель роста ветра с высотой; null — по устойчивости воздуха в час вылета (stabilityShear). */
  shearExponent: number | null;
  cloudCover: number;
  /** Нижняя граница облаков над площадкой, м. */
  cloudBaseM: number;
  date: string;
  utcOffsetH: number;
  defaults: Settings;
  /** Ретрансляторы связи района (radio.ts) — для полёта, предполётной проверки и карты. */
  relays: Relay[];
}

export interface SurveyScenario extends ScenarioBase {
  kind: 'survey';
  /** Участок съёмки — выпуклый многоугольник. */
  area: GeoPoint[];
  requiredGsdM: number;
  /** Сколько годных кадров нужно на точку и на какой доле участка. */
  minFrames: number;
  minCoverage: number;
}

export interface DeliveryScenario extends ScenarioBase {
  kind: 'delivery';
  destination: GeoPoint;
  destinationName: string;
  /** Промежуточные точки туда; обратно — в обратном порядке. */
  route: RoutePoint[];
  /** Стоянка на разгрузку, с. */
  unloadS: number;
}

export interface RouteScenario extends ScenarioBase {
  kind: 'route';
  route: RoutePoint[];
}

/** Перелёт из А в Б: один полёт, посадка в пункте Б. */
export interface TransferScenario extends ScenarioBase {
  kind: 'transfer';
  destination: GeoPoint;
  destinationName: string;
  route: RoutePoint[];
}

/**
 * Поиск людей тепловизором (src/game/search.ts): облёт по точкам, как маршрут, — по умолчанию
 * галсы над районом поиска; взлёт и посадка на площадке.
 */
export interface SearchScenario extends ScenarioBase {
  kind: 'search';
  /** Район поиска — многоугольник. */
  area: GeoPoint[];
  route: RoutePoint[];
  camera: ThermalCamera;
  /** Высота галсов по умолчанию над рельефом, м, и наклон подвеса (угол оси ниже горизонта), °. */
  heightAglM: number;
  tiltDeg: number;
  /** Веса видов зверей района; нет — обычная тайга. */
  animals?: AnimalWeights;
}

/**
 * Лесопожарный патруль (src/game/fire.ts): облёт зоны патрулирования, как маршрут. Дымы видно в
 * 3D-виде за километры, очаги и огневые точки — тепловизором.
 */
export interface FireScenario extends ScenarioBase {
  kind: 'fire';
  /** Зона патрулирования — многоугольник. */
  area: GeoPoint[];
  route: RoutePoint[];
  camera: ThermalCamera;
  /** Высота патруля над рельефом, м, и наклон подвеса, °. */
  heightAglM: number;
  tiltDeg: number;
}

export type Scenario = TransferScenario | SurveyScenario | DeliveryScenario | RouteScenario | SearchScenario | FireScenario;

/** Высота поиска по умолчанию над рельефом, м: со 100 м полоса тепловизора под 45° — 84 м. */
const SEARCH_HEIGHT_AGL_M = 100;
/** Высота патруля по умолчанию над рельефом, м: дым виден дальше, а очаг в кадре ещё различим. */
const PATROL_HEIGHT_AGL_M = 250;

/** Брифинг и ретрансляторы района одной фразой. */
export function withRelays(briefing: string, relays: readonly Relay[] = []): string {
  if (!relays.length) return briefing;
  const where = relays.map((r) => (r.kind === 'air' ? `аппарат-ретранслятор ${r.name ?? ''}` : `мачта ${r.name ?? ''}`).trim());
  return `${briefing} Связь за рельефом держ${relays.length > 1 ? 'ат ретрансляторы' : 'ит ретранслятор'}: ${where.join(', ')}.`;
}

/** Задания района. Первое — стартовое. */
export function buildScenarios(L: LocationSpec): Scenario[] {
  const common = {
    site: L.site,
    siteName: L.siteName,
    relays: L.relays ?? [],
    shearExponent: null,
    cloudCover: 0.3,
    cloudBaseM: 1500,
    date: L.date,
    utcOffsetH: L.utcOffsetH,
  };
  const defaults: Settings = {
    cameraId: PROFILE.camera.id,
    gsdCm: 4,
    forwardOverlapPct: 80,
    sideOverlapPct: 60,
    directionDeg: 90,
    shutter: 1600,
    cargoKg: AIRCRAFT.payloadMaxKg,
    iasMs: AIRCRAFT.cruiseIasMs,
    windSpeedMs: L.windSpeedMs,
    windFromDeg: L.windFromDeg,
    temperatureC: L.temperatureC,
    localHour: L.localHour ?? 11,
    linkLossAction: 'rtl',
    linkLossTimeoutS: LINK_TIMEOUT_S,
    altitudeRef: 'agl',
  };
  const list: Scenario[] = [
    {
      ...common,
      id: 'transfer',
      kind: 'transfer',
      title: L.transfer.title,
      briefing: withRelays(L.transfer.briefing, L.relays),
      destination: L.transfer.destination,
      destinationName: L.transfer.destinationName,
      route: L.transfer.route,
      defaults: { ...defaults },
    },
    {
      ...common,
      id: 'route',
      kind: 'route',
      title: 'Облёт по маршруту',
      briefing: withRelays(L.route.briefing, L.relays),
      route: L.route.route,
      defaults: { ...defaults },
    },
    {
      ...common,
      id: 'survey',
      kind: 'survey',
      title: L.survey.title,
      briefing: withRelays(L.survey.briefing, L.relays),
      area: L.survey.area,
      requiredGsdM: 0.04,
      minFrames: 5,
      minCoverage: 0.95,
      defaults: { ...defaults },
    },
    {
      ...common,
      id: 'delivery',
      kind: 'delivery',
      title: L.delivery.title,
      briefing: withRelays(L.delivery.briefing, L.relays),
      destination: L.delivery.destination,
      destinationName: L.delivery.destinationName,
      route: L.delivery.route,
      unloadS: 60,
      defaults: { ...defaults },
    },
  ];
  if (L.search) {
    // Галсы по умолчанию: высота SEARCH_HEIGHT_AGL_M, радиус разворота — по крейсерской скорости
    // (истинная у земли ≈ приборная + 5 %) и ветру по умолчанию.
    const camera = THERMAL_CAMERA;
    const heightAglM = Math.max(SEARCH_HEIGHT_AGL_M, AIRCRAFT.minClearanceM + 50);
    const pattern = searchPattern(L.search.area, L.site, { heightAglM, camera, tiltDeg: camera.tiltDeg, turnRadiusM: turnRadius(AIRCRAFT.cruiseIasMs * 1.05, L.windSpeedMs) });
    list.push({
      ...common,
      id: 'search',
      kind: 'search',
      title: L.search.title,
      briefing: withRelays(L.search.briefing, L.relays),
      area: L.search.area,
      route: pattern.route,
      camera,
      heightAglM,
      tiltDeg: camera.tiltDeg,
      ...(L.search.animals ? { animals: L.search.animals } : {}),
      defaults: { ...defaults },
    });
  }
  if (L.fire) {
    const camera = THERMAL_CAMERA;
    list.push({
      ...common,
      id: 'fire',
      kind: 'fire',
      title: L.fire.title,
      briefing: withRelays(L.fire.briefing, L.relays),
      area: L.fire.area,
      route: L.fire.route,
      camera,
      heightAglM: L.fire.route[0]?.heightAglM ?? PATROL_HEIGHT_AGL_M,
      tiltDeg: camera.tiltDeg,
      defaults: { ...defaults },
    });
  }
  return list;
}

/** Район заданий — выбранный оператором (src/game/regions.ts); переключение — перезагрузкой страницы. */
export const ACTIVE_REGION = activeRegion();
/** Область рельефа и снимков, на которой строятся все задания. */
export const REGION = ACTIVE_REGION.location.region;
/** Дома, леса, дороги и вода района (src/sim/osm.ts), если они есть. */
export const ACTIVE_OSM_URL = ACTIVE_REGION.osmUrl;

/** Задания выбранного района. Первое — стартовое. */
export const SCENARIOS: readonly Scenario[] = buildScenarios(ACTIVE_REGION.location);

export function findCamera(id: string): SurveyCamera {
  return CAMERAS.find((c) => c.id === id) ?? CAMERAS[0]!;
}

export function surveyParams(s: Settings): SurveyParams {
  return {
    gsdM: s.gsdCm / 100,
    forwardOverlap: s.forwardOverlapPct / 100,
    sideOverlap: s.sideOverlapPct / 100,
    directionDeg: s.directionDeg,
    shutterS: 1 / s.shutter,
    leadInM: 60,
  };
}

export function forecastWeather(sc: Scenario, s: Settings): Weather {
  return {
    groundTemperatureC: s.temperatureC,
    wind: { speedMs: s.windSpeedMs, fromDeg: s.windFromDeg },
    windProfile: { referenceHeightM: 10, shearExponent: sc.shearExponent ?? stabilityShear(sunPosition(departure(sc, s), sc.site).elevationDeg, sc.cloudCover, s.windSpeedMs) },
    cloudCover: sc.cloudCover,
    cloudBaseM: sc.cloudBaseM,
    precipitation: null,
  };
}

/** Время вылета в UTC. */
export function departure(sc: Scenario, s: Settings): Date {
  const minutes = Math.round((s.localHour - sc.utcOffsetH) * 60);
  return new Date(Date.parse(`${sc.date}T00:00:00Z`) + minutes * 60_000);
}

/**
 * То же задание с вылетом в момент utc: дата и местный час — по часовому поясу района, так что
 * departure() даёт utc, а Солнце, термики и освещённость — на этот момент. Исходные не меняются.
 */
export function atDeparture<S extends Scenario>(sc: S, s: Settings, utc: Date): { scenario: S; settings: Settings } {
  const local = new Date(utc.getTime() + sc.utcOffsetH * 3_600_000);
  return {
    scenario: { ...sc, date: local.toISOString().slice(0, 10) },
    settings: { ...s, localHour: local.getUTCHours() + local.getUTCMinutes() / 60 },
  };
}

export interface Mission {
  kind: ScenarioKind;
  /** Полёты задания по порядку; у доставки — туда и обратно. */
  stages: MissionPlan[];
  stageNames: string[];
  /** Взлётный и посадочный маршруты каждого полёта. */
  procedures: WindProcedures[];
  site: Site;
  destination: Site | null;
  camera: SurveyCamera | null;
  params: SurveyParams | null;
  survey: SurveyPlan | null;
}

const VT = AIRCRAFT.vtol;
/** Высоты двух первых точек посадочного маршрута над рельефом, м (глиссада к точке посадки). */
const APPROACH_AGL = [120, 80] as const;
const siteAt = (terrain: Terrain, p: GeoPoint): Site => ({ lat: p.lat, lon: p.lon, elevationM: terrain.elevationM(p) });
const CLIMB = () => AIRCRAFT.planeClimbRateMaxMs * 0.9;
const DESCENT = () => AIRCRAFT.planeDescentRateMaxMs * 0.9;
const TAKEOFF_LEG = 'Взлётный маршрут: разгон против ветра';
/** Рельеф у площадки круче предельного набора или снижения — переход выше, но не больше чем на столько сверх РЛЭ, м. */
const MAX_EXTRA_VERTICAL_M = 200;
/** Запас к минимальной высоте над рельефом: профиль строится по точкам через 100 м, а между ними рельеф бывает выше, м. */
const BETWEEN_SAMPLES_M = 15;
/** Не хватает высоты меньше этого, м, — без кругов над площадкой: разница в пределах допуска автопилота. */
const LOOP_MIN_SHORT_M = 15;
/** Больше кругов над площадкой не ставим: дальше пусть покажет проверка запаса высоты. */
const MAX_LOOPS = 30;

/**
 * Радиус разворота — по наибольшей путевой скорости (по ветру) с 10 % запаса, иначе на
 * подветренной части дуги предельного крена не хватит и аппарат вынесет. Объявление функцией:
 * buildScenarios зовёт её ещё при загрузке модуля (SCENARIOS), раньше этой строки.
 */
function turnRadius(tas: number, windMs: number): number {
  return (1.1 * (tas + windMs) ** 2) / (G * Math.tan((AIRCRAFT.maxBankDeg * Math.PI) / 180));
}

/** Высота над рельефом по узлам маршрута, между узлами — линейно. */
const byNodes = (heights: number[]) => (leg: number, f: number) => heights[leg]! + (heights[leg + 1]! - heights[leg]!) * f;

/** Витки радиуса r вокруг c, точки через ~15 м; начало и конец — со стороны towards. */
function orbitAround(c: GeoPoint, towards: GeoPoint, r: number, turns: number): GeoPoint[] {
  const t = toLocal(c, towards);
  const a0 = Math.atan2(t.north, t.east);
  const steps = Math.ceil((2 * Math.PI * r) / 15) * turns;
  return Array.from({ length: steps + 1 }, (_, k) => {
    const a = a0 + (2 * Math.PI * turns * k) / steps;
    return fromLocal(c, Math.cos(a) * r, Math.sin(a) * r);
  });
}

/**
 * Маршрут со скруглёнными углами и кругами над площадками: набор — после взлётного разгона
 * (base[1]), снижение — перед посадочным маршрутом (base[n − 3]). Номера исходных участков (parts)
 * те же, что без кругов: набор — часть взлётного участка, снижение — последнего участка оператора.
 */
function withOrbits(base: GeoPoint[], radiusM: number, loops: { start: number; end: number }): { points: GeoPoint[]; parts: LegPart[] } {
  const pts: GeoPoint[] = [];
  // Исходный участок и доли пути по нему — для каждого отрезка pts[k] → pts[k + 1].
  const seg: LegPart[] = [];
  const add = (p: GeoPoint, part: LegPart) => {
    if (pts.length) seg.push(part);
    pts.push(p);
  };
  const approach = base.length - 3;
  base.forEach((p, k) => {
    if (k === approach && loops.end > 0) for (const q of orbitAround(base[base.length - 1]!, base[k - 1]!, radiusM, loops.end)) add(q, { leg: k - 1, f0: 0, f1: 0 });
    add(p, { leg: k - 1, f0: 0, f1: 1 });
    if (k === 1 && loops.start > 0) for (const q of orbitAround(base[0]!, base[2]!, radiusM, loops.start)) add(q, { leg: 0, f0: 1, f1: 1 });
  });
  const r = roundSharpCorners(pts, radiusM);
  const parts = r.parts.map((p) => {
    const s = seg[p.leg]!;
    return { leg: s.leg, f0: s.f0 + (s.f1 - s.f0) * p.f0, f1: s.f0 + (s.f1 - s.f0) * p.f1 };
  });
  return { points: r.points, parts };
}

/**
 * Полёт по точкам оператора с огибанием рельефа. Маршрут по РЛЭ: взлётный (разгон против ветра
 * к точке в 300 м), точки оператора, посадочный (три точки против ветра, последняя — площадка).
 * Высота над рельефом своя у каждой точки, между точками — плавно. Если склон за площадкой круче,
 * чем успеваем набрать по пути (или перед посадкой — снизиться), — круги над площадкой: без них
 * профиль прошёл бы ниже заданной высоты, а то и сквозь склон.
 */
function routeStage(
  from: Site,
  to: Site,
  points: RoutePoint[],
  payload: PayloadLoad | null,
  s: Settings,
  terrain: Terrain,
  weather: Weather,
  label: (leg: number, legs: number) => string,
  landingName: string,
): { plan: MissionPlan; proc: WindProcedures } {
  const proc = windProcedures(from, to, windAt(weather, 10), points[0] ?? to, points[points.length - 1] ?? from, s.approachDeg ?? null);
  // Высота точек над морем или от взлёта — между точками прямая по высоте; к первой точке и от
  // последней — огибание рельефа до этой же высоты над ним.
  const absolute = s.altitudeRef !== 'agl';
  const abs = points.map((p) => p.altitudeM ?? terrain.elevationM(p) + p.heightAglM);
  const h = absolute ? points.map((p, i) => Math.max(AIRCRAFT.minClearanceM, abs[i]! - terrain.elevationM(p))) : points.map((p) => p.heightAglM);
  const first = h[0] ?? 150;
  const heights = [first, first, ...h, APPROACH_AGL[0], APPROACH_AGL[1], VT.backTransitionHeightM];
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const tas = tasFromIas(s.iasMs, airDensity({ altitudeM: from.elevationM + mean, temperatureC: weather.groundTemperatureC }));
  const wind = windAt(weather, mean);
  const radius = turnRadius(tas, wind.speedMs);
  const base = [from, proc.departure, ...points, proc.approach[0], proc.approach[1], to];
  const userLegs = points.length + 1;
  // Круги — чтобы от первой точки оператора до последней нигде не пройти ниже половины заданной
  // высоты над рельефом: добрать до полной по пути — обычное дело, а сквозь склон — нет. Разгон
  // после взлёта и снижение к посадке — без этого требования.
  const hold = (leg: number, f: number) => (leg + f >= 2 && leg + f <= userLegs ? byNodes(heights)(leg, f) / 2 : 0);
  const loops = { start: 0, end: 0 };
  const build = () => {
    const r = withOrbits(base, radius, loops);
    const follow = {
      heightAglM: byNodes(heights),
      groundSpeedMs: (track: number) => windTriangle(tas, track, wind)?.groundSpeedMs ?? tas,
      stepM: 100,
      parts: r.parts,
      // Участки между точками оператора (2…число точек) — по заданной высоте над морем.
      ...(absolute ? { altitudeM: (leg: number, f: number) => (leg >= 2 && leg <= points.length ? abs[leg - 2]! + (abs[leg - 1]! - abs[leg - 2]!) * f : null) } : {}),
    };
    const ends = terrainEndAltitudes(r.points, terrain, from.elevationM + VT.transitionHeightM, to.elevationM + VT.backTransitionHeightM, CLIMB(), DESCENT(), follow, AIRCRAFT.minClearanceM + BETWEEN_SAMPLES_M, MAX_EXTRA_VERTICAL_M, hold);
    return { points: r.points, follow, ends };
  };
  // Витков — сколько не хватает высоты, делённое на набор (снижение) за виток.
  const turnsFor = (shortM: number, rateMs: number) => (shortM > LOOP_MIN_SHORT_M ? Math.ceil(shortM / ((rateMs * 2 * Math.PI * radius) / tas)) : 0);
  let route = build();
  for (let pass = 0; pass < 4; pass++) {
    const start = Math.min(MAX_LOOPS, loops.start + turnsFor(route.ends.startShortM, CLIMB()));
    const end = Math.min(MAX_LOOPS, loops.end + turnsFor(route.ends.endShortM, DESCENT()));
    if (start === loops.start && end === loops.end) break;
    Object.assign(loops, { start, end });
    route = build();
  }
  const { ends } = route;
  const waypoints = followTerrain(route.points, terrain, ends.startAltitudeM, ends.endAltitudeM, CLIMB(), DESCENT(), route.follow);
  return {
    plan: {
      takeoff: from,
      landing: to,
      waypoints,
      transitionAltitudeM: ends.startAltitudeM,
      backTransitionAltitudeM: ends.endAltitudeM,
      iasMs: s.iasMs,
      payload,
      terrain,
      legLabels: [
        loops.start ? `${TAKEOFF_LEG}, набор высоты по кругу над площадкой` : TAKEOFF_LEG,
        ...Array.from({ length: userLegs }, (_, i) => label(i, userLegs) + (loops.end && i === userLegs - 1 ? ', снижение по кругу над площадкой посадки' : '')),
        `Посадочный маршрут${landingName}: выравнивание`,
        `Посадочный маршрут${landingName}: на точку посадки`,
      ],
    },
    proc,
  };
}

/**
 * Миссия АФС: высота по GSD над рельефом, галсы с разворотами минимального радиуса
 * (по наибольшей путевой скорости, предельный крен + 10 % запаса), огибание рельефа
 * с запасом 10 % по вертикальной скорости. Если по пути до участка высоту не набрать — круги.
 * Взлётный и посадочный маршруты — по ветру.
 */
function surveyMission(sc: SurveyScenario, s: Settings, terrain: Terrain, weather: Weather): Mission {
  const camera = findCamera(s.cameraId);
  const params = surveyParams(s);
  const site = siteAt(terrain, sc.site);
  const height = heightForGsdM(camera, params.gsdM);
  const tas = tasFromIas(s.iasMs, airDensity({ altitudeM: site.elevationM + height, temperatureC: weather.groundTemperatureC }));
  const wind = windAt(weather, height);
  // Радиус разворота — по наибольшей путевой скорости (по ветру), иначе на подветренной
  // части дуги предельного крена не хватит и аппарат вынесет.
  const radius = turnRadius(tas, wind.speedMs);

  const draft = planSurvey(sc.area, sc.site, camera, params, radius);
  const loopsFor = (dh: number, distance: number, rate: number) => {
    const need = (dh * tas) / rate;
    return need > distance ? Math.ceil((need - distance) / (2 * Math.PI * radius)) : 0;
  };
  const start = loopsFor(
    terrain.elevationM(draft.firstLineStart) + height - (site.elevationM + VT.transitionHeightM),
    distanceM(sc.site, draft.firstLineStart),
    CLIMB(),
  );
  const end = loopsFor(
    terrain.elevationM(draft.lastLineEnd) + height - (site.elevationM + VT.backTransitionHeightM),
    distanceM(sc.site, draft.lastLineEnd),
    DESCENT(),
  );
  const base = start || end ? planSurvey(sc.area, sc.site, camera, params, radius, { loops: { start, end } }) : draft;

  // Взлётный маршрут в начало, посадочный — в конец; номера участков съёмки сдвигаются на один.
  const proc = windProcedures(site, site, windAt(weather, 10), base.firstLineStart, base.lastLineEnd, s.approachDeg ?? null);
  const n = base.route.length;
  const survey: SurveyPlan = {
    ...base,
    route: [proc.departure, ...base.route, proc.approach[0], proc.approach[1]],
    lineLegs: new Set([...base.lineLegs].map((k) => k + 1)),
    legLabels: [TAKEOFF_LEG, ...base.legLabels.slice(0, n), 'Возврат к посадочному маршруту', 'Посадочный маршрут: выравнивание', 'Посадочный маршрут: на точку посадки'],
  };
  const heights = [height, height, ...base.route.map(() => height), APPROACH_AGL[0], APPROACH_AGL[1], VT.backTransitionHeightM];
  const rounded = roundSharpCorners([sc.site, ...survey.route, sc.site], radius);
  const follow = { heightAglM: byNodes(heights), groundSpeedMs: (track: number) => windTriangle(tas, track, wind)?.groundSpeedMs ?? tas, stepM: 100, parts: rounded.parts };
  const ends = terrainEndAltitudes(rounded.points, terrain, site.elevationM + VT.transitionHeightM, site.elevationM + VT.backTransitionHeightM, CLIMB(), DESCENT(), follow, AIRCRAFT.minClearanceM + BETWEEN_SAMPLES_M, MAX_EXTRA_VERTICAL_M);
  const waypoints = followTerrain(rounded.points, terrain, ends.startAltitudeM, ends.endAltitudeM, CLIMB(), DESCENT(), follow);
  return {
    kind: 'survey',
    stages: [
      {
        takeoff: site,
        landing: site,
        waypoints,
        transitionAltitudeM: ends.startAltitudeM,
        backTransitionAltitudeM: ends.endAltitudeM,
        iasMs: s.iasMs,
        payload: camera,
        terrain,
        legLabels: survey.legLabels,
      },
    ],
    stageNames: ['Съёмка'],
    procedures: [proc],
    site,
    destination: null,
    camera,
    params,
    survey,
  };
}

export function buildMission(sc: Scenario, s: Settings, terrain: Terrain, weather: Weather = forecastWeather(sc, s)): Mission {
  const site = siteAt(terrain, sc.site);
  switch (sc.kind) {
    case 'survey':
      return surveyMission(sc, s, terrain, weather);
    case 'delivery': {
      const dest = siteAt(terrain, sc.destination);
      const out = routeStage(site, dest, sc.route, { massKg: s.cargoKg, powerW: 0 }, s, terrain, weather, (i, n) => `Туда: участок ${i + 1} из ${n}`, ` в ${sc.destinationName}`);
      const back = routeStage(dest, site, [...sc.route].reverse(), { massKg: 0, powerW: 0 }, s, terrain, weather, (i, n) => `Обратно: участок ${i + 1} из ${n}`, ' на аэродром');
      return {
        kind: 'delivery',
        stages: [out.plan, back.plan],
        stageNames: [`Туда с грузом ${s.cargoKg.toLocaleString('ru-RU')} кг`, 'Обратно пустым'],
        procedures: [out.proc, back.proc],
        site,
        destination: dest,
        camera: null,
        params: null,
        survey: null,
      };
    }
    case 'transfer': {
      const dest = siteAt(terrain, sc.destination);
      const r = routeStage(site, dest, sc.route, null, s, terrain, weather, (i, n) => (i === n - 1 ? 'К посадочному маршруту' : `Перелёт: участок ${i + 1} из ${n}`), ` в ${sc.destinationName}`);
      return {
        kind: 'transfer',
        stages: [r.plan],
        stageNames: ['Перелёт'],
        procedures: [r.proc],
        site,
        destination: dest,
        camera: null,
        params: null,
        survey: null,
      };
    }
    case 'route': {
      const r = routeStage(site, site, sc.route, null, s, terrain, weather, (i, n) => (i === 0 ? 'К точке 1' : i === n - 1 ? 'К посадочному маршруту' : `Точка ${i} → ${i + 1}`), '');
      return {
        kind: 'route',
        stages: [r.plan],
        stageNames: ['Облёт'],
        procedures: [r.proc],
        site,
        destination: null,
        camera: null,
        params: null,
        survey: null,
      };
    }
    case 'search': {
      // Как облёт по маршруту, нагрузка — тепловизор (масса и питание).
      const payload = { massKg: sc.camera.massKg, powerW: sc.camera.powerW };
      const r = routeStage(site, site, sc.route, payload, s, terrain, weather, (i, n) => (i === 0 ? 'К району поиска' : i === n - 1 ? 'К посадочному маршруту' : `Поиск: точка ${i} → ${i + 1}`), '');
      return {
        kind: 'search',
        stages: [r.plan],
        stageNames: ['Поиск'],
        procedures: [r.proc],
        site,
        destination: null,
        camera: null,
        params: null,
        survey: null,
      };
    }
    case 'fire': {
      const payload = { massKg: sc.camera.massKg, powerW: sc.camera.powerW };
      const r = routeStage(
        site,
        site,
        sc.route,
        payload,
        s,
        terrain,
        weather,
        (i, n) => (i === 0 ? 'К зоне патрулирования' : i === n - 1 ? 'К посадочному маршруту' : `Патруль: точка ${i} → ${i + 1}`),
        '',
      );
      return {
        kind: 'fire',
        stages: [r.plan],
        stageNames: ['Патрулирование'],
        procedures: [r.proc],
        site,
        destination: null,
        camera: null,
        params: null,
        survey: null,
      };
    }
  }
}
