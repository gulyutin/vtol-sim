import { PROFILE } from '@profile';
import { AIRCRAFT } from '../sim/aircraft';
import { airDensity, G, tasFromIas } from '../sim/atmosphere';
import { distanceM } from '../sim/mission';
import { roundSharpCorners } from '../sim/dubins';
import { CAMERAS } from '../sim/payload';
import { windProcedures, type WindProcedures } from '../sim/procedures';
import { heightForGsdM, planSurvey, type SurveyCamera, type SurveyParams, type SurveyPlan } from '../sim/survey';
import { followTerrain } from '../sim/terrain';
import type { RoutePoint } from '../sim/profile';
import type { GeoPoint, MissionPlan, PayloadLoad, Site, Terrain, Weather } from '../sim/types';
import { windAt, windTriangle } from '../sim/wind';

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
}

export type ScenarioKind = 'transfer' | 'survey' | 'delivery' | 'route';

export type { RoutePoint };

interface ScenarioBase {
  id: string;
  kind: ScenarioKind;
  title: string;
  briefing: string;
  /** Площадка взлёта; высота берётся из рельефа. */
  site: GeoPoint;
  siteName: string;
  /** Показатель роста ветра с высотой для этой местности. */
  shearExponent: number;
  cloudCover: number;
  /** Нижняя граница облаков над площадкой, м. */
  cloudBaseM: number;
  date: string;
  utcOffsetH: number;
  defaults: Settings;
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

export type Scenario = TransferScenario | SurveyScenario | DeliveryScenario | RouteScenario;

/** Район заданий — из профиля. */
const L = PROFILE.location;
/** Область рельефа и снимков, на которой строятся все задания. */
export const REGION = L.region;

const COMMON = {
  site: L.site,
  siteName: L.siteName,
  shearExponent: 0.2,
  cloudCover: 0.3,
  cloudBaseM: 1500,
  date: L.date,
  utcOffsetH: L.utcOffsetH,
};

const DEFAULTS: Settings = {
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
  localHour: 11,
};

/** Первое задание — стартовое. */
export const SCENARIOS: readonly Scenario[] = [
  {
    ...COMMON,
    id: 'transfer',
    kind: 'transfer',
    title: L.transfer.title,
    briefing: L.transfer.briefing,
    destination: L.transfer.destination,
    destinationName: L.transfer.destinationName,
    route: L.transfer.route,
    defaults: { ...DEFAULTS },
  },
  {
    ...COMMON,
    id: 'route',
    kind: 'route',
    title: 'Облёт по маршруту',
    briefing: L.route.briefing,
    route: L.route.route,
    defaults: { ...DEFAULTS },
  },
  {
    ...COMMON,
    id: 'survey',
    kind: 'survey',
    title: L.survey.title,
    briefing: L.survey.briefing,
    area: L.survey.area,
    requiredGsdM: 0.04,
    minFrames: 5,
    minCoverage: 0.95,
    defaults: { ...DEFAULTS },
  },
  {
    ...COMMON,
    id: 'delivery',
    kind: 'delivery',
    title: L.delivery.title,
    briefing: L.delivery.briefing,
    destination: L.delivery.destination,
    destinationName: L.delivery.destinationName,
    route: L.delivery.route,
    unloadS: 60,
    defaults: { ...DEFAULTS },
  },
];

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
    windProfile: { referenceHeightM: 10, shearExponent: sc.shearExponent },
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

/**
 * Радиус разворота — по наибольшей путевой скорости (по ветру) с 10 % запаса, иначе на
 * подветренной части дуги предельного крена не хватит и аппарат вынесет.
 */
const turnRadius = (tas: number, windMs: number) => (1.1 * (tas + windMs) ** 2) / (G * Math.tan((AIRCRAFT.maxBankDeg * Math.PI) / 180));

/** Высота над рельефом по узлам маршрута, между узлами — линейно. */
const byNodes = (heights: number[]) => (leg: number, f: number) => heights[leg]! + (heights[leg + 1]! - heights[leg]!) * f;

/**
 * Полёт по точкам оператора с огибанием рельефа. Маршрут по РЛЭ: взлётный (разгон против ветра
 * к точке в 300 м), точки оператора, посадочный (три точки против ветра, последняя — площадка).
 * Высота над рельефом своя у каждой точки, между точками — плавно.
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
  const proc = windProcedures(from, to, windAt(weather, 10), points[0] ?? to, points[points.length - 1] ?? from);
  const h = points.map((p) => p.heightAglM);
  const first = h[0] ?? 150;
  const heights = [first, first, ...h, APPROACH_AGL[0], APPROACH_AGL[1], VT.backTransitionHeightM];
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const tas = tasFromIas(s.iasMs, airDensity({ altitudeM: from.elevationM + mean, temperatureC: weather.groundTemperatureC }));
  const wind = windAt(weather, mean);
  const rounded = roundSharpCorners([from, proc.departure, ...points, proc.approach[0], proc.approach[1], to], turnRadius(tas, wind.speedMs));
  const waypoints = followTerrain(rounded.points, terrain, from.elevationM + VT.transitionHeightM, to.elevationM + VT.backTransitionHeightM, CLIMB(), DESCENT(), {
    heightAglM: byNodes(heights),
    groundSpeedMs: (track) => windTriangle(tas, track, wind)?.groundSpeedMs ?? tas,
    stepM: 100,
    parts: rounded.parts,
  });
  const userLegs = points.length + 1;
  return {
    plan: {
      takeoff: from,
      landing: to,
      waypoints,
      iasMs: s.iasMs,
      payload,
      terrain,
      legLabels: [
        TAKEOFF_LEG,
        ...Array.from({ length: userLegs }, (_, i) => label(i, userLegs)),
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
  const proc = windProcedures(site, site, windAt(weather, 10), base.firstLineStart, base.lastLineEnd);
  const n = base.route.length;
  const survey: SurveyPlan = {
    ...base,
    route: [proc.departure, ...base.route, proc.approach[0], proc.approach[1]],
    lineLegs: new Set([...base.lineLegs].map((k) => k + 1)),
    legLabels: [TAKEOFF_LEG, ...base.legLabels.slice(0, n), 'Возврат к посадочному маршруту', 'Посадочный маршрут: выравнивание', 'Посадочный маршрут: на точку посадки'],
  };
  const heights = [height, height, ...base.route.map(() => height), APPROACH_AGL[0], APPROACH_AGL[1], VT.backTransitionHeightM];
  const rounded = roundSharpCorners([sc.site, ...survey.route, sc.site], radius);
  const waypoints = followTerrain(rounded.points, terrain, site.elevationM + VT.transitionHeightM, site.elevationM + VT.backTransitionHeightM, CLIMB(), DESCENT(), {
    heightAglM: byNodes(heights),
    groundSpeedMs: (track) => windTriangle(tas, track, wind)?.groundSpeedMs ?? tas,
    stepM: 100,
    parts: rounded.parts,
  });
  return {
    kind: 'survey',
    stages: [{ takeoff: site, landing: site, waypoints, iasMs: s.iasMs, payload: camera, terrain, legLabels: survey.legLabels }],
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
  }
}
