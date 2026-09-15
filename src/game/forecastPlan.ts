import { AIRCRAFT } from '../sim/aircraft';
import { combineResults, distanceM, simulateMission } from '../sim/mission';
import { windComponents } from '../sim/procedures';
import type { Relay } from '../sim/radio';
import { sunPosition } from '../sim/sun';
import { heightForGsdM, illuminanceLux, isoNeeded } from '../sim/survey';
import { TerrainWind, type TerrainRelief } from '../sim/terrainWind';
import type { MissionResult, Site, Terrain, Weather } from '../sim/types';
import { windAt } from '../sim/wind';
import type { Zone } from '../sim/zones';
import { OPEN_METEO_ATTRIBUTION, type AbortSignalLike, type HourlyWeather } from './liveWeather';
import { linkCheck, preflightChecks, zoneChecks, type Check } from './preflight';
import { atDeparture, buildMission, departure, findCamera, type Mission, type Scenario, type Settings } from './scenarios';
import { contrastFactor, thermalContrastK } from './search';
import { PRECIPITATION_NAME } from './weather';

/*
 * Прогноз на реальный вылет: текущее задание (тот же маршрут, те же настройки) прогоняется на
 * каждый час почасового прогноза с настоящими датой и часом вылета — Солнце, термики и освещённость
 * на этот момент. По каждому часу — «лететь / с оговорками / не лететь» и почему, запас энергии,
 * ветер у земли, на высоте маршрута и на посадке, осадки, облака, обледенение, ветер у площадок.
 * Итог — лучшее время вылета и непрерывные окна.
 *
 * Считается порциями (forecastSteps — генератор, по часу за шаг), чтобы не подвешивать интерфейс.
 * Что от погоды не зависит, считается один раз: связь по маршруту (linkCheck), рельеф для ветра
 * (TerrainRelief — снаружи); сетки ветра у рельефа — одни на направление ветра с шагом 10°.
 */

export type Verdict = 'go' | 'caution' | 'nogo';

export interface ForecastInput {
  scenario: Scenario;
  settings: Settings;
  terrain: Terrain;
  /** Рельеф для ветра у склонов — один на район. */
  relief: TerrainRelief;
  zones?: readonly Zone[];
  relays?: readonly Relay[];
  /** Площадка НСУ. */
  gcs: Site;
  /** Почасовой прогноз (fetchForecast). */
  hours: readonly HourlyWeather[];
  /**
   * Какие часы вылета оценивать. Часы прогноза после окна нужны только для погоды на время посадки
   * (см. FORECAST_LOOKAHEAD_H). Нет — все часы.
   */
  window?: { from: Date; hours: number };
}

/** Ветер у площадки на 10 м с поправкой рельефа — относительно курса разгона или посадочного курса. */
export interface SiteWind {
  /** «взлёта», «посадки», «посадки в Тик-Губе». */
  name: string;
  /** Через сколько после вылета, с. */
  atS: number;
  headingDeg: number;
  speedMs: number;
  fromDeg: number;
  gustMs?: number;
  /** Встречная (+) / попутная (−) и боковая составляющие, м/с. */
  headwindMs: number;
  crosswindMs: number;
  /** Опасность ветра у рельефа (windHazardAt) 0…1 и что ждать; 0 и '' — рельеф ровный. */
  hazard: number;
  hazardText: string;
}

export interface ForecastEnergy {
  feasible: boolean;
  /** Почему задание невыполнимо (simulateMission). */
  issues: string[];
  totalWh: number;
  usableWh: number;
  capacityWh: number;
  /** Сверх аварийного резерва на посадке, Вт·ч; отрицательный — не хватит. */
  marginWh: number;
  /** Заряд на посадке, доля ёмкости. */
  socAtLanding: number;
  durationS: number;
  distanceM: number;
}

export interface ForecastHour {
  /** Час вылета, UTC. */
  time: Date;
  /** Местные дата (ГГГГ-ММ-ДД) и час вылета — по часовому поясу района. */
  localDate: string;
  localHour: number;
  hourly: HourlyWeather;
  weather: Weather;
  verdict: Verdict;
  /** Непройденные проверки часа: сначала запрещающие (block), потом оговорки (warn). */
  reasons: Check[];
  /** Все проверки часа, кроме общих для всех часов (связь, зоны РЭБ) — они в ForecastPlan. */
  checks: Check[];
  energy: ForecastEnergy;
  wind: {
    /** Ветер у земли (10 м), откуда, порывы. */
    groundMs: number;
    fromDeg: number;
    gustMs?: number;
    /** На типичной высоте маршрута над рельефом и наибольший на участках. */
    routeHeightAglM: number;
    routeMs: number;
    routeMaxMs: number;
  };
  takeoff: SiteWind[];
  landing: SiteWind[];
  sky: {
    precipitation: string | null;
    visibilityM?: number;
    cloudCover?: number;
    cloudBaseM?: number;
    /** Нулевая изотерма над морем, м. */
    freezingLevelM?: number;
    icing: boolean;
    thunder: boolean;
    sky?: string;
  };
  /** Высота Солнца на вылете и на последней посадке, градусы. */
  sun: { takeoffDeg: number; landingDeg: number };
  /** Для выбора лучшего часа: больше — лучше. */
  score: number;
}

/** Непрерывное окно: вылет возможен в каждый час с from по last включительно. */
export interface ForecastWindow {
  /** Индексы в ForecastPlan.hours. */
  start: number;
  end: number;
  from: Date;
  last: Date;
  hours: number;
  /** go — все часы «лететь», caution — есть часы с оговорками. */
  verdict: 'go' | 'caution';
  /** Лучший час окна — индекс в ForecastPlan.hours. */
  best: number;
}

export interface ForecastPlan {
  hours: ForecastHour[];
  /** Лучший час вылета — индекс в hours; null — лететь нельзя ни в один час. */
  best: number | null;
  windows: ForecastWindow[];
  /** Связь с НСУ по маршруту — от погоды не зависит, одна на все часы. */
  link: Check;
  /** Зоны по маршруту — общие для всех часов (запреты, РЭБ). */
  route: Check[];
  mission: string;
  utcOffsetH: number;
  /** Время расчёта без пауз, мс. */
  computeMs: number;
  attribution: typeof OPEN_METEO_ATTRIBUTION;
}

export interface ForecastProgress {
  done: number;
  total: number;
}

/** Сколько часов прогноза сверх окна нужно, чтобы знать погоду на время посадки последних часов. */
export const FORECAST_LOOKAHEAD_H = 3;

const HOUR_MS = 3_600_000;
/** Опасность ветра у площадки от этого уровня — оговорка (как terrainWindChecks). */
const WIND_HAZARD_WARN = 0.3;
/** Ветер и порывы от этой доли предела — оговорка: ошибка прогноза выведет за предел. */
const NEAR_LIMIT = 0.85;
/** Запас сверх резерва меньше этой доли доступной энергии — оговорка. */
const THIN_MARGIN = 0.1;
/** Солнце ниже — темно (гражданские сумерки кончились). */
const DARK_SUN_DEG = -6;
/** Шаг направления ветра для общих сеток ветра у рельефа, градусы. */
const GRID_STEP_DEG = 10;

const fmt = (x: number, d = 0) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const now = () => (globalThis as unknown as { performance?: { now(): number } }).performance?.now() ?? Date.now();
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** Местные дата и время по часовому поясу района. */
export function localTime(t: Date, utcOffsetH: number): { date: string; hour: number; hhmm: string } {
  const l = new Date(t.getTime() + utcOffsetH * HOUR_MS);
  const hour = l.getUTCHours() + l.getUTCMinutes() / 60;
  return { date: l.toISOString().slice(0, 10), hour, hhmm: `${String(l.getUTCHours()).padStart(2, '0')}:${String(l.getUTCMinutes()).padStart(2, '0')}` };
}

/** Типичная высота маршрута над рельефом: съёмка — по GSD, остальное — средняя по точкам оператора. */
function routeHeightAglM(sc: Scenario, s: Settings): number {
  if (sc.kind === 'survey') return heightForGsdM(findCamera(s.cameraId), s.gsdCm / 100);
  const h = sc.route.map((p) => p.heightAglM);
  return h.length ? h.reduce((a, b) => a + b, 0) / h.length : 150;
}

interface Context {
  input: ForecastInput;
  link: Check | null;
  /** Сетки ветра у рельефа по направлению (шаг GRID_STEP_DEG). */
  grids: Map<number, TerrainWind>;
  route: Map<string, Check>;
}

interface Evaluated {
  hour: ForecastHour;
  /** Запрещающие проверки погоды — для часов, чья посадка приходится на этот час. */
  weatherBlocks: string[];
}

/** Один час вылета: миссия, энергия, проверки РЛЭ, ветер у площадок. */
function evaluateHour(ctx: Context, hw: HourlyWeather): Evaluated {
  const input = ctx.input;
  const L = AIRCRAFT.limits;
  const { scenario: sc, settings: s } = atDeparture(input.scenario, input.settings, hw.time);
  const w = hw.weather;
  const off = sc.utcOffsetH;
  const lt = localTime(hw.time, off);
  const w10 = windAt(w, 10);
  const routeH = routeHeightAglM(sc, s);
  const base = {
    time: hw.time,
    localDate: lt.date,
    localHour: lt.hour,
    hourly: hw,
    weather: w,
    wind: { groundMs: w10.speedMs, fromDeg: w10.fromDeg, ...(w.gustMs !== undefined ? { gustMs: w.gustMs } : {}), routeHeightAglM: routeH, routeMs: windAt(w, routeH).speedMs, routeMaxMs: windAt(w, routeH).speedMs },
  };
  const sky: ForecastHour['sky'] = {
    precipitation: w.precipitation ? `${PRECIPITATION_NAME[w.precipitation.kind]} ${fmt(w.precipitation.mmPerH, 1)} мм/ч` : null,
    icing: false,
    thunder: hw.thunder,
  };
  if (w.visibilityM !== undefined) sky.visibilityM = w.visibilityM;
  if (w.cloudCover !== undefined) sky.cloudCover = w.cloudCover;
  sky.cloudBaseM = w.cloudBaseM ?? sc.cloudBaseM;
  if (hw.freezingLevelM !== undefined) sky.freezingLevelM = hw.freezingLevelM;
  if (hw.sky !== undefined) sky.sky = hw.sky;

  let mission: Mission;
  try {
    mission = buildMission(sc, s, input.terrain, w);
  } catch (e) {
    const text = `Маршрут не строится: ${e instanceof Error ? e.message : String(e)}`;
    const reason: Check = { ok: false, level: 'block', text };
    const energy: ForecastEnergy = { feasible: false, issues: [text], totalWh: NaN, usableWh: NaN, capacityWh: NaN, marginWh: -Infinity, socAtLanding: NaN, durationS: 0, distanceM: 0 };
    const dep = sunPosition(hw.time, sc.site).elevationDeg;
    return {
      hour: { ...base, verdict: 'nogo', reasons: [reason], checks: [reason], energy, takeoff: [], landing: [], sky, sun: { takeoffDeg: dep, landingDeg: dep }, score: -Infinity },
      weatherBlocks: [],
    };
  }

  const groundS = sc.kind === 'delivery' ? sc.unloadS : 0;
  const parts: MissionResult[] = mission.stages.map((p) => simulateMission(p, w));
  const result = combineResults(parts, groundS);
  const segWinds = result.segments.map((x) => x.wind.speedMs).filter(Number.isFinite);
  base.wind.routeMaxMs = Math.max(base.wind.routeMs, ...segWinds);

  // Связь от погоды не зависит — один раз, по маршруту первого посчитанного часа.
  ctx.link ??= linkCheck({ stages: mission.stages, terrain: input.terrain, gcs: input.gcs, zones: input.zones ?? [], relays: input.relays ?? [] });
  const pre = preflightChecks({
    stages: mission.stages,
    weather: w,
    procedures: mission.procedures,
    cloudBaseM: sc.cloudBaseM,
    terrain: input.terrain,
    gcs: input.gcs,
    relays: input.relays ?? [],
    link: ctx.link,
  }).filter((c) => c !== ctx.link && (sc.kind === 'survey' || !c.text.includes('не позволяет вести съёмку')));
  const checks: Check[] = [...pre];
  const cautions: Check[] = [];
  const add = (list: Check[], level: Check['level'], text: string) => list.push({ ok: false, level, text });

  // Зоны: заход в запретную — нельзя в этот час; предупреждения общие для всех часов.
  if (input.zones?.length) {
    for (const z of zoneChecks(mission.stages, input.zones, input.gcs)) {
      if (!z.ok && z.level === 'block') checks.push(z);
      else if (!ctx.route.has(z.text)) ctx.route.set(z.text, z);
    }
  }

  // Гроза и обледенение выше нулевой изотермы — сверх проверок РЛЭ по температуре у земли.
  if (hw.thunder) add(checks, 'block', `Гроза${hw.sky ? ` (${hw.sky})` : ''} — не летать`);
  const top = Math.max(...mission.stages.flatMap((st) => st.waypoints.map((p) => p.altitudeM)));
  const siteElevation = mission.site.elevationM;
  const cloudBase = w.cloudBaseM ?? sc.cloudBaseM;
  const preIcing = pre.some((c) => !c.ok && c.text.startsWith('Опасность обледенения'));
  const inCloud = top - siteElevation > cloudBase && (w.cloudCover ?? 0) >= 0.3;
  const fl = hw.freezingLevelM;
  const flIcing = !preIcing && fl !== undefined && top > fl && (inCloud || !!w.precipitation);
  if (flIcing) {
    const k = checks.findIndex((c) => c.ok && c.text.startsWith('Опасности обледенения нет'));
    if (k >= 0) checks.splice(k, 1);
    add(checks, 'block', `Опасность обледенения: маршрут до ${fmt(top)} м над морем, нулевая изотерма на ${fmt(fl)} м, ${w.precipitation ? PRECIPITATION_NAME[w.precipitation.kind] : 'облака'} — в таких условиях не летать`);
  }
  sky.icing = preIcing || flIcing;

  // Ветер и порывы у самого предела — ошибка прогноза выведет за него.
  if (w10.speedMs > NEAR_LIMIT * L.windMaxMs && w10.speedMs <= L.windMaxMs) add(cautions, 'warn', `Ветер у земли ${fmt(w10.speedMs, 1)} м/с — у предела ${L.windMaxMs} м/с`);
  if (w.gustMs !== undefined && w.gustMs > NEAR_LIMIT * L.gustMaxMs && w.gustMs <= L.gustMaxMs) add(cautions, 'warn', `Порывы ${fmt(w.gustMs, 1)} м/с — у предела ${L.gustMaxMs} м/с`);

  // Моменты взлётов и посадок: у доставки — посадка в пункте, стоянка, взлёт обратно.
  const dep = departure(sc, s).getTime();
  const sunAt = (t: number) => sunPosition(new Date(dep + t * 1000), mission.site);
  let tw: TerrainWind | null = null;
  if (!input.relief.flat) {
    const key = Math.round(w.wind.fromDeg / GRID_STEP_DEG) % (360 / GRID_STEP_DEG);
    const grid = ctx.grids.get(key);
    tw = new TerrainWind(input.relief, { ...w, wind: { speedMs: w.wind.speedMs, fromDeg: key * GRID_STEP_DEG } }, { sun: sunAt, ...(grid ? { grid } : {}) });
    if (!grid) ctx.grids.set(key, tw);
  }
  const siteWind = (p: Site, name: string, headingDeg: number, atS: number): SiteWind => {
    let speedMs = w10.speedMs;
    let fromDeg = w10.fromDeg;
    let factor = 1;
    let hazard = 0;
    let hazardText = '';
    if (tw) {
      const z = tw.windHazardAtPoint(p, { t: atS });
      factor = z.speedFactor;
      speedMs *= factor;
      fromDeg = (((fromDeg + z.turnDeg) % 360) + 360) % 360;
      hazard = z.level;
      hazardText = z.text;
    }
    const c = windComponents({ speedMs, fromDeg }, headingDeg);
    const sw: SiteWind = { name, atS, headingDeg, speedMs, fromDeg, headwindMs: c.headwindMs, crosswindMs: c.crosswindMs, hazard, hazardText };
    if (w.gustMs !== undefined) sw.gustMs = w.gustMs * factor;
    return sw;
  };
  const takeoff: SiteWind[] = [];
  const landing: SiteWind[] = [];
  const points: { p: Site; x: SiteWind; name: string }[] = [];
  const away = (p: Site) => (mission.destination && distanceM(p, mission.destination) < 50 ? ` в ${destinationName(sc)}` : '');
  let t = 0;
  mission.stages.forEach((st, i) => {
    const proc = mission.procedures[i]!;
    const up = siteWind(st.takeoff, `взлёта${away(st.takeoff)}`, proc.takeoffHeadingDeg, t);
    t += parts[i]!.durationS;
    const down = siteWind(st.landing, `посадки${away(st.landing)}`, proc.landingHeadingDeg, t);
    t += groundS;
    takeoff.push(up);
    landing.push(down);
    points.push({ p: st.takeoff, x: up, name: 'взлёта' }, { p: st.landing, x: down, name: 'посадки' });
  });

  // Ветер у площадок (рельеф): одна строка на площадку — по худшему из моментов.
  if (tw) {
    const sites: { p: Site; worst: SiteWind; names: string[] }[] = [];
    for (const { p, x, name } of points) {
      const found = sites.find((y) => distanceM(y.p, p) < 50);
      if (!found) sites.push({ p, worst: x, names: [name] });
      else {
        if (!found.names.includes(name)) found.names.push(name);
        if (x.hazard > found.worst.hazard) found.worst = x;
      }
    }
    for (const { p, worst, names } of sites)
      checks.push({ ok: worst.hazard < WIND_HAZARD_WARN, level: 'warn', text: `Ветер у площадки ${names.join(' и ')}${away(p)}: ${lower(worst.hazardText)}` });
  }
  // Посадка: ветер у площадки повёрнут рельефом — боковой или попутный на посадочном курсе.
  for (const x of landing) {
    if (x.speedMs <= L.takeoffAnyWindMs) continue;
    if (x.crosswindMs > L.takeoffAnyWindMs)
      add(cautions, 'warn', `Посадка${x.name.slice('посадки'.length)} курсом ${fmt(x.headingDeg)}°: у земли боковой ${fmt(x.crosswindMs, 1)} м/с — ветер у площадки повёрнут рельефом`);
    else if (x.headwindMs < 0) add(cautions, 'warn', `Посадка${x.name.slice('посадки'.length)} курсом ${fmt(x.headingDeg)}°: у земли попутный ${fmt(-x.headwindMs, 1)} м/с`);
  }

  // Свет: съёмке — хватит ли ISO камеры, остальным — не темно ли.
  const sunTakeoff = sunAt(0).elevationDeg;
  const sunLanding = sunAt(result.durationS).elevationDeg;
  const darkest = Math.min(sunTakeoff, sunLanding);
  if (sc.kind === 'survey' && mission.camera) {
    const iso = isoNeeded(mission.camera, 1 / s.shutter, illuminanceLux(darkest, w.cloudCover ?? sc.cloudCover));
    if (iso > mission.camera.isoMax) add(checks, 'block', `Мало света для съёмки: Солнце на ${fmt(darkest)}°, нужна ISO ${fmt(Math.round(iso / 10) * 10)} при выдержке 1/${s.shutter} — камера годна до ISO ${fmt(mission.camera.isoMax)}`);
  } else if (darkest < DARK_SUN_DEG) add(cautions, 'warn', `Темно: Солнце на ${fmt(-darkest)}° под горизонтом — визуального контроля борта не будет`);
  // Поиск тепловизором: в жаркий солнечный день человек почти не теплее прогретой земли.
  if (sc.kind === 'search') {
    const sunHigh = Math.max(sunTakeoff, sunLanding);
    const dT = thermalContrastK('person', { airTemperatureC: w.groundTemperatureC, sunElevationDeg: sunHigh, cloudCover: w.cloudCover ?? sc.cloudCover });
    if (contrastFactor(dT) < 0.5)
      add(
        cautions,
        'warn',
        `Слабый тепловой контраст: человек ${dT >= 0 ? 'теплее' : 'холоднее'} фона всего на ${fmt(Math.abs(dT), 1)} K (воздух ${fmt(w.groundTemperatureC)} °C, Солнце на ${fmt(sunHigh)}°) — на прогретой земле люди теряются, лучше утром, вечером или ночью`,
      );
  }

  // Энергия: не хватает — нельзя; впритык — ошибка прогноза ветра съест запас.
  const energy: ForecastEnergy = {
    feasible: result.feasible,
    issues: result.issues,
    totalWh: result.budget.totalWh,
    usableWh: result.usableWh,
    capacityWh: result.capacityWh,
    marginWh: result.marginWh,
    socAtLanding: result.socAtLanding,
    durationS: result.durationS,
    distanceM: result.distanceM,
  };
  const energyBlocks: Check[] = result.issues.map((text) => ({ ok: false, level: 'block', text }));
  if (result.feasible && result.marginWh < THIN_MARGIN * result.usableWh)
    add(cautions, 'warn', `Запас сверх резерва ${fmt(result.marginWh)} Вт·ч (${fmt((100 * result.marginWh) / result.capacityWh)} % ёмкости) — впритык, ошибка прогноза ветра его съест`);

  const all = [...checks, ...cautions];
  const failed = all.filter((c) => !c.ok);
  const reasons = [...failed.filter((c) => c.level === 'block'), ...energyBlocks, ...failed.filter((c) => c.level === 'warn')];
  const verdict: Verdict = reasons.some((c) => c.level === 'block') ? 'nogo' : reasons.length ? 'caution' : 'go';
  const hazardMax = Math.max(0, ...takeoff.map((x) => x.hazard), ...landing.map((x) => x.hazard));
  const windLoad = Math.max(w10.speedMs / L.windMaxMs, (w.gustMs ?? 0) / L.gustMaxMs);
  const rank = verdict === 'go' ? 2 : verdict === 'caution' ? 1 : 0;
  const score = rank * 1000 + 100 * clamp(result.marginWh / result.usableWh, -1, 1) - 10 * windLoad - 10 * hazardMax;
  return {
    hour: { ...base, verdict, reasons, checks: all, energy, takeoff, landing, sky, sun: { takeoffDeg: sunTakeoff, landingDeg: sunLanding }, score },
    weatherBlocks: checks.filter((c) => !c.ok && c.level === 'block').map((c) => c.text),
  };
}

function destinationName(sc: Scenario): string {
  return sc.kind === 'delivery' || sc.kind === 'transfer' ? sc.destinationName : '';
}

/** Лучший час из списка индексов: наибольший score, при равенстве — раньше. */
function bestOf(hours: readonly ForecastHour[], idx: readonly number[]): number | null {
  let best: number | null = null;
  for (const i of idx) if (hours[i]!.verdict !== 'nogo' && (best === null || hours[i]!.score > hours[best]!.score)) best = i;
  return best;
}

/** Непрерывные окна: подряд идущие часы (шаг 1 ч), в которые можно лететь. */
export function forecastWindows(hours: readonly ForecastHour[]): ForecastWindow[] {
  const out: ForecastWindow[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    const idx = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    out.push({
      start,
      end,
      from: hours[start]!.time,
      last: hours[end]!.time,
      hours: idx.length,
      verdict: idx.every((i) => hours[i]!.verdict === 'go') ? 'go' : 'caution',
      best: bestOf(hours, idx)!,
    });
    start = -1;
  };
  hours.forEach((h, i) => {
    const flyable = h.verdict !== 'nogo';
    const next = i > 0 && h.time.getTime() - hours[i - 1]!.time.getTime() === HOUR_MS;
    if (start >= 0 && (!flyable || !next)) close(i - 1);
    if (flyable && start < 0) start = i;
  });
  close(hours.length - 1);
  return out;
}

/**
 * План порциями: по часу за шаг (next() — десятки миллисекунд даже в горах), в конце — итог.
 * Для интерфейса — planForecastAsync; синхронно — planForecast.
 */
export function* forecastSteps(input: ForecastInput): Generator<ForecastProgress, ForecastPlan, void> {
  let busy = 0;
  let t0 = now();
  const sorted = [...input.hours].sort((a, b) => a.time.getTime() - b.time.getTime());
  const from = input.window ? Math.floor(input.window.from.getTime() / HOUR_MS) * HOUR_MS : -Infinity;
  const to = input.window ? from + input.window.hours * HOUR_MS : Infinity;
  const inWindow = sorted.filter((h) => h.time.getTime() >= from && h.time.getTime() < to);
  const after = sorted.filter((h) => h.time.getTime() >= to && h.time.getTime() < to + FORECAST_LOOKAHEAD_H * HOUR_MS);
  const ctx: Context = { input, link: null, grids: new Map(), route: new Map() };
  const total = inWindow.length + after.length;
  const done: Evaluated[] = [];
  const extra: Evaluated[] = [];

  for (const h of inWindow) {
    done.push(evaluateHour(ctx, h));
    busy += now() - t0;
    yield { done: done.length, total };
    t0 = now();
  }
  // Посадка последних часов окна — уже после него: погода на это время из следующих часов.
  const flightEnd = (e: Evaluated) => e.hour.time.getTime() + e.hour.energy.durationS * 1000 + HOUR_MS / 2;
  const needUntil = Math.max(-Infinity, ...done.map(flightEnd));
  for (const h of after) {
    if (h.time.getTime() >= needUntil) break;
    extra.push(evaluateHour(ctx, h));
    busy += now() - t0;
    yield { done: done.length + extra.length, total };
    t0 = now();
  }

  // Погода к посадке: час, чья половина приходится на полёт, запрещает — не лететь и в час вылета.
  const timeline = [...done, ...extra];
  const off = input.scenario.utcOffsetH;
  for (const e of done) {
    if (e.hour.verdict === 'nogo') continue;
    const t = e.hour.time.getTime();
    const end = flightEnd(e);
    const bad = timeline.find((x) => x.hour.time.getTime() > t && x.hour.time.getTime() < end && x.weatherBlocks.length);
    if (!bad) continue;
    const text = `К посадке (≈ ${localTime(new Date(t + e.hour.energy.durationS * 1000), off).hhmm}) погода хуже: в ${localTime(bad.hour.time, off).hhmm} — ${lower(bad.weatherBlocks[0]!)}`;
    const c: Check = { ok: false, level: 'block', text };
    e.hour.reasons.unshift(c);
    e.hour.checks.push(c);
    e.hour.score -= (e.hour.verdict === 'go' ? 2 : 1) * 1000;
    e.hour.verdict = 'nogo';
  }

  const hours = done.map((e) => e.hour);
  const link = ctx.link ?? { ok: true, level: 'warn' as const, text: 'Связь не проверялась: нет ни одного часа прогноза' };
  busy += now() - t0;
  return {
    hours,
    best: bestOf(
      hours,
      hours.map((_, i) => i),
    ),
    windows: forecastWindows(hours),
    link,
    route: [...ctx.route.values()],
    mission: input.scenario.title,
    utcOffsetH: off,
    computeMs: busy,
    attribution: OPEN_METEO_ATTRIBUTION,
  };
}

/** План сразу, без пауз (тесты, расчёт вне интерфейса). */
export function planForecast(input: ForecastInput): ForecastPlan {
  const it = forecastSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

type Pause = () => Promise<void>;
const nextMacrotask: Pause = () => new Promise<void>((ok) => (globalThis as unknown as { setTimeout(f: () => void, ms: number): unknown }).setTimeout(ok, 0));

/**
 * План порциями не дольше budgetMs, отдавая управление между ними. Отмена — через signal
 * (исключение «Расчёт прогноза отменён»); onProgress — сколько часов посчитано из скольких.
 */
export async function planForecastAsync(
  input: ForecastInput,
  o: { onProgress?: (done: number, total: number) => void; signal?: AbortSignalLike; budgetMs?: number; pause?: Pause } = {},
): Promise<ForecastPlan> {
  const it = forecastSteps(input);
  const budget = o.budgetMs ?? 12;
  const pause = o.pause ?? nextMacrotask;
  let t0 = now();
  for (;;) {
    if (o.signal?.aborted) throw new Error('Расчёт прогноза отменён');
    const r = it.next();
    if (r.done) return r.value;
    o.onProgress?.(r.value.done, r.value.total);
    if (now() - t0 >= budget) {
      await pause();
      t0 = now();
    }
  }
}

/**
 * Погода часа для задания: дата и время вылета — этого часа, ветер, температура, облака — по
 * прогнозу (ползунки — с их шагом), weather — прогноз часа целиком (порывы, осадки, видимость).
 */
export function applyForecastHour<S extends Scenario>(sc: S, s: Settings, hour: ForecastHour | HourlyWeather): { scenario: S; settings: Settings; weather: Weather; summary: string } {
  const hw = 'hourly' in hour ? hour.hourly : hour;
  const at = atDeparture(sc, s, hw.time);
  const w = hw.weather;
  const lt = localTime(hw.time, sc.utcOffsetH);
  return {
    scenario: { ...at.scenario, shearExponent: w.windProfile?.shearExponent ?? sc.shearExponent, cloudCover: w.cloudCover ?? sc.cloudCover, cloudBaseM: w.cloudBaseM ?? sc.cloudBaseM },
    settings: {
      ...at.settings,
      windSpeedMs: Math.round(w.wind.speedMs * 2) / 2,
      windFromDeg: (Math.round(w.wind.fromDeg / 5) * 5) % 360,
      temperatureC: Math.round(w.groundTemperatureC),
    },
    weather: { ...w },
    summary: `Прогноз на ${lt.date.split('-').reverse().join('.')} ${lt.hhmm}: ${hw.summary} · ${OPEN_METEO_ATTRIBUTION}`,
  };
}
