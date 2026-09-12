import { takeoffMassKg } from '../sim/aero';
import { AIRCRAFT } from '../sim/aircraft';
import { distanceM } from '../sim/mission';
import { windComponents, type WindProcedures } from '../sim/procedures';
import { lineOfSight } from '../sim/radio';
import type { MissionPlan, Site, Terrain, Weather } from '../sim/types';
import { windAt } from '../sim/wind';

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
  cloudBaseM: number;
  terrain: Terrain;
  /** Площадка НСУ; антенна — на 3 м над ней. */
  gcs: Site;
}

const fmt = (x: number, d = 0) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

export function preflightChecks(o: PreflightInput): Check[] {
  const L = AIRCRAFT.limits;
  const wind10 = windAt(o.weather, 10);
  const checks: Check[] = [];
  const add = (ok: boolean, level: Check['level'], text: string) => checks.push({ ok, level, text });

  add(wind10.speedMs <= L.windMaxMs, 'block', `Ветер у земли ${fmt(wind10.speedMs, 1)} м/с — допустимо до ${L.windMaxMs} м/с`);
  o.procedures.forEach((p, i) => {
    const c = windComponents(wind10, p.takeoffHeadingDeg);
    const ok = wind10.speedMs <= L.takeoffAnyWindMs || (c.headwindMs > 0 && c.crosswindMs <= L.takeoffAnyWindMs);
    const where = o.stages.length > 1 ? ` (взлёт ${i + 1})` : '';
    add(ok, 'block', `Разгон${where} на ${fmt(p.takeoffHeadingDeg)}°: встречный ${fmt(c.headwindMs, 1)}, боковой ${fmt(c.crosswindMs, 1)} м/с — при ветре сильнее ${L.takeoffAnyWindMs} м/с только против ветра`);
  });
  add(o.cloudBaseM >= L.minCloudBaseM, 'block', `Нижняя граница облаков ${fmt(o.cloudBaseM)} м — не ниже ${L.minCloudBaseM} м`);
  const t = o.weather.groundTemperatureC;
  add(t >= L.temperatureMinC && t <= L.temperatureMaxC, 'block', `Температура ${fmt(t)} °C — от ${L.temperatureMinC} до +${L.temperatureMaxC} °C`);

  const maxPayload = Math.max(0, ...o.stages.map((s) => s.payload?.massKg ?? 0));
  const mass = takeoffMassKg(maxPayload);
  add(maxPayload <= AIRCRAFT.payloadMaxKg + 1e-9, 'block', `Нагрузка ${fmt(maxPayload, 1)} кг — не больше ${fmt(AIRCRAFT.payloadMaxKg, 1)} кг`);
  add(mass <= L.mtowKg + 1e-9, 'block', `Взлётная масса ${fmt(mass, 1)} кг — не больше ${fmt(L.mtowKg, 1)} кг`);
  const ias = Math.max(...o.stages.map((s) => s.iasMs));
  add(ias <= L.maxIasMs + 1e-9, 'block', `Приборная скорость ${fmt(ias * 3.6)} км/ч — не больше ${fmt(L.maxIasMs * 3.6)} км/ч`);
  const top = Math.max(...o.stages.flatMap((s) => s.waypoints.map((w) => w.altitudeM)));
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
