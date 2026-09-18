import { takeoffMassKg } from '../sim/aero';
import { AIRCRAFT } from '../sim/aircraft';
import { airDensity, tasFromIas } from '../sim/atmosphere';
import { LINK_TIMEOUT_S } from '../sim/failures';
import { backTransitionAltitudeM, distanceM, transitionAltitudeM } from '../sim/mission';
import { windComponents, type WindProcedures } from '../sim/procedures';
import { BOARD_ANTENNA_M, LINK_LOST_DB, LinkNetwork, linkAlongNetwork, linkJamDb, minLinkAltitudeM, RADIO, type Relay, type Station } from '../sim/radio';
import type { TerrainWind } from '../sim/terrainWind';
import type { MissionPlan, Site, Terrain, Weather } from '../sim/types';
import { windAt } from '../sim/wind';
import {
  EW_EFFECT_THRESHOLD,
  isEwZone,
  routeZoneCrossings,
  routeZoneExposure,
  zoneEffectsAt,
  zoneKindPhrase,
  zoneLabel,
  type RoutePoint3D,
  type Zone,
  type ZoneKind,
} from '../sim/zones';
import { PRECIPITATION_NAME } from './weather';

/*
 * Предполётные проверки по РЛЭ: метеоусловия, лётные ограничения, взлётный маршрут,
 * связь с НСУ вдоль маршрута. Пороги — из профиля аппарата.
 */

export interface Check {
  text: string;
  ok: boolean;
  /** block — РЛЭ запрещает взлёт (статус «НЕ ГОТОВ»); warn — предупреждение. */
  level: 'block' | 'warn';
}

export interface PreflightInput {
  stages: MissionPlan[];
  weather: Weather;
  procedures: WindProcedures[];
  /** Нижняя граница облаков по заданию, м; если она есть в погоде (weather.cloudBaseM) — берётся оттуда. */
  cloudBaseM: number;
  terrain: Terrain;
  /** Площадка НСУ; антенна — на RADIO.groundAntennaM над ней. */
  gcs: Site;
  /** Запретные зоны и зоны РЭБ (zones.ts) — см. zoneChecks. */
  zones?: readonly Zone[];
  /** Ретрансляторы (radio.ts) — для проверки связи вдоль маршрута. */
  relays?: readonly Relay[];
  /** Ветер у рельефа по прогнозной погоде (terrainWind.ts) — см. terrainWindChecks. */
  terrainWind?: TerrainWind;
  /** Проверка связи, посчитанная заранее (linkCheck): от погоды не зависит. Нет — считается здесь. */
  link?: Check;
}

/** Меньше — полёт запрещён (туман); меньше SURVEY_VISIBILITY_M — не видно, что снимать. */
const MIN_VISIBILITY_M = 1000;
const SURVEY_VISIBILITY_M = 3000;
/** Осадки и туман при такой температуре у земли на высоте маршрута уже около нуля. */
const ICING_WET_MAX_C = 2;
/** Стандартный градиент температуры, °C/м. */
const LAPSE_C_PER_M = 0.0065;

const RAD = Math.PI / 180;
const fmt = (x: number, d = 0) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDistance = (m: number) => (m < 1000 ? `${fmt(Math.round(m / 10) * 10)} м` : `${fmt(m / 1000, m < 10_000 ? 1 : 0)} км`);

export function preflightChecks(o: PreflightInput): Check[] {
  const L = AIRCRAFT.limits;
  const w = o.weather;
  const wind10 = windAt(w, 10);
  const checks: Check[] = [];
  const add = (ok: boolean, level: Check['level'], text: string) => checks.push({ ok, level, text });
  const top = Math.max(...o.stages.flatMap((s) => s.waypoints.map((p) => p.altitudeM)));

  // РЛЭ, предварительная подготовка: отложить полёт при сильном ветре, порывах, боковом ветре
  // на разгоне, плохой видимости, осадках. Поля погоды, которых нет, не проверяются.
  add(wind10.speedMs <= L.windMaxMs, 'block', `Ветер у земли ${fmt(wind10.speedMs, 1)} м/с — допустимо до ${L.windMaxMs} м/с`);
  // Ветер на высоте полёта сильнее, чем у земли: по нему снос и путевая. Нос развернётся против
  // бокового ветра на угол сноса, крылья при этом ровные — так летит и настоящий аппарат.
  const cruise = o.stages[0]?.waypoints.map((p) => p.altitudeM - o.terrain.elevationM(p)).sort((a, b) => a - b);
  if (cruise?.length) {
    const agl = Math.max(10, cruise[Math.floor(cruise.length / 2)]!);
    const aloft = windAt(w, agl);
    const first = o.stages[0]!;
    const tas = tasFromIas(first.iasMs, airDensity({ altitudeM: first.takeoff.elevationM + agl, temperatureC: w.groundTemperatureC }));
    const crab = aloft.speedMs < tas ? Math.asin(aloft.speedMs / tas) / RAD : 90;
    add(true, 'warn', `Ветер на высоте полёта (~${fmt(Math.round(agl / 10) * 10)} м над рельефом) ${fmt(aloft.speedMs, 1)} м/с: чисто боковой развернёт нос против ветра до ${fmt(crab)}°`);
  }
  if (w.gustMs !== undefined) add(w.gustMs <= L.gustMaxMs, 'block', `Порывы ${fmt(w.gustMs, 1)} м/с — допустимо до ${L.gustMaxMs} м/с`);
  o.procedures.forEach((p, i) => {
    const c = windComponents(wind10, p.takeoffHeadingDeg);
    const ok = wind10.speedMs <= L.takeoffAnyWindMs || (c.headwindMs > 0 && c.crosswindMs <= L.takeoffAnyWindMs);
    const where = o.stages.length > 1 ? ` (взлёт ${i + 1})` : '';
    add(ok, 'block', `Разгон${where} на ${fmt(p.takeoffHeadingDeg)}°: встречный ${fmt(c.headwindMs, 1)}, боковой ${fmt(c.crosswindMs, 1)} м/с — при ветре сильнее ${L.takeoffAnyWindMs} м/с только против ветра`);
  });
  // Курс захода задан вручную (не против ветра) — чем он оплачен: попутный и боковой ветер на посадочной прямой.
  o.procedures.forEach((p, i) => {
    const off = Math.abs(((p.landingHeadingDeg - wind10.fromDeg + 540) % 360) - 180);
    if (wind10.speedMs < 1 || off < 1) return;
    const c = windComponents(wind10, p.landingHeadingDeg);
    const ok = wind10.speedMs <= L.takeoffAnyWindMs || (c.headwindMs > 0 && c.crosswindMs <= L.takeoffAnyWindMs);
    const where = o.stages.length > 1 ? ` (посадка ${i + 1})` : '';
    add(
      ok,
      'warn',
      `Заход${where} курсом ${fmt(p.landingHeadingDeg)}°: ${c.headwindMs >= 0 ? 'встречный' : 'попутный'} ${fmt(Math.abs(c.headwindMs), 1)}, боковой ${fmt(c.crosswindMs, 1)} м/с${ok ? '' : ` — при ветре сильнее ${L.takeoffAnyWindMs} м/с заход против ветра`}`,
    );
  });
  const cloudBase = w.cloudBaseM ?? o.cloudBaseM;
  add(cloudBase >= L.minCloudBaseM, 'block', `Нижняя граница облаков ${fmt(cloudBase)} м — не ниже ${L.minCloudBaseM} м`);
  const vis = w.visibilityM;
  if (vis !== undefined) {
    if (vis < MIN_VISIBILITY_M) add(false, 'block', `Видимость ${fmtDistance(vis)} — меньше ${fmtDistance(MIN_VISIBILITY_M)}, полёт запрещён`);
    else
      add(
        vis >= SURVEY_VISIBILITY_M,
        'warn',
        vis >= SURVEY_VISIBILITY_M ? `Видимость ${fmtDistance(vis)} — не меньше ${fmtDistance(SURVEY_VISIBILITY_M)}` : `Видимость ${fmtDistance(vis)} — не позволяет вести съёмку, нужно от ${fmtDistance(SURVEY_VISIBILITY_M)}`,
      );
  }
  const rain = w.precipitation;
  if (rain !== undefined) add(!rain, 'block', rain ? `Осадки: ${PRECIPITATION_NAME[rain.kind]} ${fmt(rain.mmPerH, 1)} мм/ч — в осадках не летать` : 'Без осадков');
  const t = w.groundTemperatureC;
  add(t >= L.temperatureMinC && t <= L.temperatureMaxC, 'block', `Температура ${fmt(t)} °C — от ${L.temperatureMinC} до +${L.temperatureMaxC} °C`);

  // Аппарат не допущен к полётам в условиях обледенения. Переохлаждённая вода — это осадки или туман
  // около нуля у земли (выше холоднее) либо облака на высоте маршрута, если там мороз.
  const siteElevation = o.stages[0]?.takeoff.elevationM ?? o.gcs.elevationM;
  const cloudT = t - LAPSE_C_PER_M * cloudBase;
  const wet = !!rain || (vis !== undefined && vis < MIN_VISIBILITY_M);
  const wetIcing = wet && t <= ICING_WET_MAX_C;
  const cloudIcing = top - siteElevation > cloudBase && cloudT <= 0;
  if (wetIcing || cloudIcing || rain !== undefined || vis !== undefined || w.cloudBaseM !== undefined) {
    const why = wetIcing
      ? `${rain ? PRECIPITATION_NAME[rain.kind] : 'туман'} при ${fmt(t)} °C`
      : `маршрут заходит в облака выше ${fmt(cloudBase)} м, там ${fmt(cloudT)} °C`;
    add(!(wetIcing || cloudIcing), 'block', wetIcing || cloudIcing ? `Опасность обледенения: ${why} — в таких условиях не летать` : 'Опасности обледенения нет');
  }

  const maxPayload = Math.max(0, ...o.stages.map((s) => s.payload?.massKg ?? 0));
  const mass = takeoffMassKg(maxPayload);
  add(maxPayload <= AIRCRAFT.payloadMaxKg + 1e-9, 'block', `Нагрузка ${fmt(maxPayload, 1)} кг — не больше ${fmt(AIRCRAFT.payloadMaxKg, 1)} кг`);
  add(mass <= L.mtowKg + 1e-9, 'block', `Взлётная масса ${fmt(mass, 1)} кг — не больше ${fmt(L.mtowKg, 1)} кг`);
  const ias = Math.max(...o.stages.map((s) => s.iasMs));
  add(ias <= L.maxIasMs + 1e-9, 'block', `Приборная скорость ${fmt(ias * 3.6)} км/ч — не больше ${fmt(L.maxIasMs * 3.6)} км/ч`);
  add(top <= L.maxAltitudeM, 'block', `Наибольшая высота маршрута ${fmt(top)} м — не выше ${fmt(L.maxAltitudeM)} м`);
  const dep = o.stages.map((s, i) => distanceM(s.takeoff, o.procedures[i]!.departure));
  add(
    dep.every((d) => d >= AIRCRAFT.procedures.departureDistanceM - 1) && AIRCRAFT.vtol.transitionHeightM >= AIRCRAFT.procedures.minHoverHeightM,
    'block',
    `Взлётный маршрут: первая точка в ${fmt(Math.min(...dep))} м, зависание на ${AIRCRAFT.vtol.transitionHeightM} м — не ближе ${AIRCRAFT.procedures.departureDistanceM} м и не ниже ${AIRCRAFT.procedures.minHoverHeightM} м`,
  );

  checks.push(o.link ?? linkCheck(o));
  if (o.zones?.length) checks.push(...zoneChecks(o.stages, o.zones, o.gcs));
  if (o.terrainWind) checks.push(...terrainWindChecks(o.stages, o.terrainWind));
  return checks;
}

/**
 * Связь с НСУ на самолётной части всех полётов задания (radio.ts): рельеф, дальность,
 * ретрансляторы, помеха у НСУ. Где связи не будет — самый длинный участок, хватит ли на нём
 * таймаута до ВОЗВРАТА и с какой высоты там связь есть.
 */
export function linkCheck(o: Pick<PreflightInput, 'stages' | 'terrain' | 'gcs' | 'zones' | 'relays'>): Check {
  const antenna: Station = { lat: o.gcs.lat, lon: o.gcs.lon, altitudeM: o.gcs.elevationM + RADIO.groundAntennaM };
  const ew = (o.zones ?? []).filter(isEwZone);
  const gcsJamDb = ew.length ? linkJamDb(zoneEffectsAt(ew, o.gcs, antenna.altitudeM).linkJam) : 0;
  const net = new LinkNetwork(o.terrain, antenna, o.relays ?? [], undefined, gcsJamDb);
  const v = AIRCRAFT.vtol;
  let lost = 0;
  let poor = 0;
  let far = 0;
  let min = Infinity;
  // Самый длинный участок без связи; присваивается в замыкании — тип задан явно.
  let worst = null as { stage: number; fromM: number; lengthM: number; s: number; point: Station; los: boolean } | null;
  o.stages.forEach((st, i) => {
    const path: Station[] = [
      { lat: st.takeoff.lat, lon: st.takeoff.lon, altitudeM: transitionAltitudeM(st) },
      ...st.waypoints,
      { lat: st.landing.lat, lon: st.landing.lon, altitudeM: backTransitionAltitudeM(st) },
    ];
    const r = linkAlongNetwork(net, path, { maxPoints: 300 });
    lost += r.lostM;
    poor += r.poorM;
    far = Math.max(far, r.farthestM);
    min = Math.min(min, r.minMarginDb);
    for (const x of r.lostStretches) {
      const len = x.toM - x.fromM;
      if (worst && len <= worst.lengthM) continue;
      const inside = r.points.filter((p) => p.alongM >= x.fromM && p.alongM <= x.toM);
      const w = inside.reduce((a, b) => (b.marginDb < a.marginDb ? b : a), inside[0] ?? r.points[0]!);
      worst = { stage: i, fromM: x.fromM, lengthM: len, s: len / Math.max(1, st.iasMs), point: w.point, los: w.los };
    }
  });
  // Борт на земле в пункте посадки вдали от НСУ (у доставки — разгрузка и взлёт обратно).
  const deaf = o.stages.some(
    (st) => distanceM(st.landing, antenna) > 500 && net.link({ lat: st.landing.lat, lon: st.landing.lon, altitudeM: st.landing.elevationM + BOARD_ANTENNA_M }).marginDb < LINK_LOST_DB,
  );
  const onGround = 'на земле в пункте посадки связи с НСУ нет — телеметрии не будет, команды только с ПДУ расчёта; нужен ретранслятор';
  if (!worst) {
    if (deaf) return { ok: false, level: 'warn', text: `Связь с НСУ в полёте по всему маршруту, до ${fmtDistance(far)}, но ${onGround}` };
    return poor > 0
      ? { ok: true, level: 'warn', text: `Связь с НСУ по всему маршруту, до ${fmtDistance(far)}; слабая на ${fmtDistance(poor)} (запас до ${fmt(min)} дБ) — телеметрия с пропусками` }
      : { ok: true, level: 'warn', text: `Связь с НСУ по всему маршруту, до ${fmtDistance(far)}, запас не меньше ${fmt(min)} дБ` };
  }
  const w = worst;
  const where = o.stages.length > 1 ? ` (полёт ${w.stage + 1})` : '';
  const why = gcsJamDb > 0 ? 'помеха у НСУ' : w.los ? 'далеко от НСУ' : 'рельеф закрывает НСУ';
  const alt = minLinkAltitudeM(net, w.point, { maxAglM: AIRCRAFT.limits.maxAltitudeM });
  const fix = alt !== null && alt <= AIRCRAFT.limits.maxAltitudeM ? `связь там — с высоты ${fmt(Math.ceil(alt / 10) * 10)} м над морем или через ретранслятор` : 'нужен ретранслятор';
  const then = w.s > LINK_TIMEOUT_S ? `это ~${fmt(w.s)} с без связи: через ${LINK_TIMEOUT_S} с автопилот уйдёт на ВОЗВРАТ, задание прервётся` : 'борт пройдёт его без телеметрии';
  return {
    ok: false,
    level: 'warn',
    text: `Нет связи с НСУ на ${fmtDistance(lost)} маршрута; самый длинный участок${where} — ${fmtDistance(w.lengthM)} с ${fmtDistance(w.fromM)} от взлёта (${why}): ${then}; ${fix}${deaf ? `; ${onGround}` : ''}`,
  };
}

/** Маршрут ближе этого к запретной зоне — предупреждение, м. */
const NOFLY_MARGIN_M = 200;

const EW_CONSEQUENCE: Record<Exclude<ZoneKind, 'nofly'>, string> = {
  'gnss-jam': 'ГНСС будет подавлен — автопилот пойдёт по счислению, место на карте уйдёт от истинного; после выхода повторный захват до 35 с',
  'gnss-spoof': 'возможна подмена ГНСС — место уведут незаметно для карты; сверять путевую скорость и угол с приборной, курсом и ветром',
  'link-jam': `связь с НСУ пропадёт — команды не дойдут, через ${LINK_TIMEOUT_S} с автопилот уйдёт на ВОЗВРАТ, задание прервётся`,
};

/** Путь полёта с высотами над уровнем моря: вертикальный взлёт, точки маршрута, посадка. */
function stageRoute(p: MissionPlan): RoutePoint3D[] {
  return [
    { lat: p.takeoff.lat, lon: p.takeoff.lon, altitudeM: p.takeoff.elevationM },
    { lat: p.takeoff.lat, lon: p.takeoff.lon, altitudeM: transitionAltitudeM(p) },
    ...p.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, altitudeM: w.altitudeM })),
    { lat: p.landing.lat, lon: p.landing.lon, altitudeM: backTransitionAltitudeM(p) },
    { lat: p.landing.lat, lon: p.landing.lon, altitudeM: p.landing.elevationM },
  ];
}

/**
 * Проверки по зонам для всех этапов задания: заход в запретную зону — взлёт запрещён;
 * проход рядом с ней и через зоны РЭБ — предупреждения с тем, что будет. gcs — площадка НСУ.
 */
export function zoneChecks(stages: readonly MissionPlan[], zones: readonly Zone[], gcs?: Site): Check[] {
  const checks: Check[] = [];
  if (!zones.length) return checks;
  const nofly = zones.filter((z) => z.kind === 'nofly');
  const ew = zones.filter(isEwZone);
  let crossed = false;
  let exposed = false;
  stages.forEach((st, i) => {
    const where = stages.length > 1 ? ` (полёт ${i + 1})` : '';
    const route = stageRoute(st);
    const hits = routeZoneCrossings(nofly, route);
    for (const c of hits) {
      crossed = true;
      checks.push({ ok: false, level: 'block', text: `Маршрут${where} заходит в запретную зону «${zoneLabel(c.zone)}» в ${fmtDistance(c.atM)} от взлёта — перестроить в обход` });
    }
    for (const c of routeZoneCrossings(nofly, route, NOFLY_MARGIN_M)) {
      if (hits.some((h) => h.zone === c.zone)) continue;
      checks.push({ ok: false, level: 'warn', text: `Маршрут${where} проходит ближе ${NOFLY_MARGIN_M} м от запретной зоны «${zoneLabel(c.zone)}» — снос или разворот могут завести в неё` });
    }
    for (const x of routeZoneExposure(ew, route)) {
      exposed = true;
      const kind = x.zone.kind as Exclude<ZoneKind, 'nofly'>;
      checks.push({
        ok: false,
        level: 'warn',
        text: `Маршрут${where} проходит через зону ${zoneKindPhrase(x.zone)}: ${fmtDistance(x.lengthM)} с ${fmtDistance(x.atM)} от взлёта — ${EW_CONSEQUENCE[kind]}`,
      });
    }
  });
  if (gcs && zoneEffectsAt(ew, gcs, gcs.elevationM + 3).linkJam >= EW_EFFECT_THRESHOLD)
    checks.push({ ok: false, level: 'warn', text: 'НСУ в зоне подавления связи — связи с бортом не будет' });
  const takeoff = stages[0]?.takeoff;
  if (takeoff && zoneEffectsAt(ew, takeoff, takeoff.elevationM + 2).gnssJam >= EW_EFFECT_THRESHOLD)
    checks.push({ ok: false, level: 'warn', text: 'Площадка взлёта в зоне подавления ГНСС — решения ГНСС на земле не будет' });
  if (nofly.length && !crossed) checks.push({ ok: true, level: 'block', text: `Запретные зоны (${nofly.length}): маршрут в них не заходит` });
  if (ew.length && !exposed) checks.push({ ok: true, level: 'warn', text: `Зоны РЭБ (${ew.length}): маршрут вне их действия` });
  return checks;
}

/** Опасность у площадки от этого уровня — предупреждение (terrainWind.ts windHazardAt). */
const WIND_HAZARD_WARN = 0.3;

/**
 * Ветер у рельефа на площадках взлёта и посадки при прогнозном ветре: подветренная сторона хребта,
 * гребень или седловина, долина, термики, ночной сток. Планировщик считает по ровному ветру —
 * здесь то, чего он не видит. Площадка, общая для нескольких полётов, — одной строкой.
 */
export function terrainWindChecks(stages: readonly MissionPlan[], tw: TerrainWind): Check[] {
  if (!tw.active) return [];
  const sites: { p: Site; names: string[] }[] = [];
  const put = (p: Site, name: string) => {
    const s = sites.find((x) => distanceM(x.p, p) < 50);
    if (!s) sites.push({ p, names: [name] });
    else if (!s.names.includes(name)) s.names.push(name);
  };
  for (const st of stages) {
    put(st.takeoff, 'взлёта');
    put(st.landing, 'посадки');
  }
  return sites.map(({ p, names }) => {
    const hz = tw.windHazardAtPoint(p);
    return { ok: hz.level < WIND_HAZARD_WARN, level: 'warn', text: `Ветер у площадки ${names.join(' и ')}: ${hz.text[0]!.toLowerCase()}${hz.text.slice(1)}` };
  });
}

export const blocked = (checks: Check[]) => checks.some((c) => !c.ok && c.level === 'block');
