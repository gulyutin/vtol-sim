import { takeoffMassKg } from '../sim/aero';
import { AIRCRAFT } from '../sim/aircraft';
import { distanceM } from '../sim/mission';
import { windComponents, type WindProcedures } from '../sim/procedures';
import { lineOfSight } from '../sim/radio';
import type { MissionPlan, Site, Terrain, Weather } from '../sim/types';
import { windAt } from '../sim/wind';
import { PRECIPITATION_NAME } from './weather';

/*
 * Предполётные проверки по РЛЭ: метеоусловия, лётные ограничения, взлётный маршрут,
 * прямая видимость с НСУ. Пороги — из профиля аппарата.
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
  /** Площадка НСУ; антенна — на 3 м над ней. */
  gcs: Site;
}

/** Меньше — полёт запрещён (туман); меньше SURVEY_VISIBILITY_M — не видно, что снимать. */
const MIN_VISIBILITY_M = 1000;
const SURVEY_VISIBILITY_M = 3000;
/** Осадки и туман при такой температуре у земли на высоте маршрута уже около нуля. */
const ICING_WET_MAX_C = 2;
/** Стандартный градиент температуры, °C/м. */
const LAPSE_C_PER_M = 0.0065;

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
  if (w.gustMs !== undefined) add(w.gustMs <= L.gustMaxMs, 'block', `Порывы ${fmt(w.gustMs, 1)} м/с — допустимо до ${L.gustMaxMs} м/с`);
  o.procedures.forEach((p, i) => {
    const c = windComponents(wind10, p.takeoffHeadingDeg);
    const ok = wind10.speedMs <= L.takeoffAnyWindMs || (c.headwindMs > 0 && c.crosswindMs <= L.takeoffAnyWindMs);
    const where = o.stages.length > 1 ? ` (взлёт ${i + 1})` : '';
    add(ok, 'block', `Разгон${where} на ${fmt(p.takeoffHeadingDeg)}°: встречный ${fmt(c.headwindMs, 1)}, боковой ${fmt(c.crosswindMs, 1)} м/с — при ветре сильнее ${L.takeoffAnyWindMs} м/с только против ветра`);
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

  // Прямая видимость от антенны НСУ до всех точек маршрута (прореживаем до ~200 проверок).
  const antenna = { lat: o.gcs.lat, lon: o.gcs.lon, altitudeM: o.gcs.elevationM + 3 };
  const pts = o.stages.flatMap((s) => s.waypoints);
  const step = Math.max(1, Math.floor(pts.length / 200));
  let lost = 0;
  let checked = 0;
  let far = 0;
  for (let i = 0; i < pts.length; i += step) {
    const los = lineOfSight(o.terrain, antenna, pts[i]!);
    checked++;
    far = Math.max(far, los.distanceM);
    if (!los.clear) lost++;
  }
  add(
    lost === 0 && far <= L.radioRangeM,
    'warn',
    lost === 0
      ? `Прямая видимость с НСУ по всему маршруту, до ${fmt(far / 1000, 1)} км`
      : `Рельеф закрывает связь с НСУ на ${fmt((100 * lost) / checked)} % маршрута — борт пройдёт его автономно`,
  );
  return checks;
}

export const blocked = (checks: Check[]) => checks.some((c) => !c.ok && c.level === 'block');
