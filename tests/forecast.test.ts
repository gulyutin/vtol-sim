import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyForecastHour, forecastWindows, planForecast, planForecastAsync, type ForecastHour, type ForecastPlan } from '../src/game/forecastPlan';
import { fetchForecast, forecastUrl, mapOpenMeteoHourly, type HourlyWeather } from '../src/game/liveWeather';
import { atDeparture, departure, SCENARIOS, type RouteScenario, type TransferScenario } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { bearingDeg, toLocal } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import { TerrainRelief, TerrainWind } from '../src/sim/terrainWind';
import type { Site, Terrain, Weather } from '../src/sim/types';

/*
 * Прогноз на реальный вылет: разбор почасового ответа Open-Meteo (фикстура — ответ в формате
 * сервиса), план по часам на ровном рельефе с синтетическим прогнозом.
 */

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-hourly.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const SITE = { lat: 67.577, lon: 33.5804 };
const utcAt = (hhmm: string) => new Date(`2026-09-14T${hhmm}:00Z`);

describe('почасовой прогноз Open-Meteo: разбор', () => {
  const hours = mapOpenMeteoHourly(FIXTURE, utcAt('06:00'), 5);

  it('часы окна по порядку; час без ветра на краю прогноза пропускается', () => {
    expect(hours.map((h) => h.time.toISOString().slice(11, 16))).toEqual(['06:00', '07:00', '08:00', '09:00']);
  });

  it('ветер, порывы, профиль, облака и нулевая изотерма — на час вылета', () => {
    const h = hours[0]!;
    expect(h.weather.wind).toEqual({ speedMs: 4, fromDeg: 210 });
    expect(h.weather.gustMs).toBe(8);
    expect(h.weather.windProfile!.shearExponent).toBeGreaterThan(0.1);
    expect(h.weather.cloudCover).toBeCloseTo(0.3, 6);
    expect(h.weather.visibilityM).toBe(30000);
    expect(h.freezingLevelM).toBe(2100);
    expect(h.dewPointC).toBe(3);
    // Низких облаков нет — граница не ниже среднего яруса.
    expect(h.weather.cloudBaseM).toBe(2000);
    // Низкие облака: граница у уровня конденсации, 125 м на градус.
    expect(hours[1]!.weather.cloudBaseM).toBe(250);
  });

  it('осадки и код погоды — за час после вылета (в ряду они за предыдущий час)', () => {
    expect(hours[0]!.weather.precipitation).toBeNull();
    expect(hours[0]!.sky).toBe('пасмурно');
    expect(hours[1]!.weather.precipitation).toEqual({ kind: 'rain', mmPerH: 1.8 });
    expect(hours[1]!.sky).toBe('дождь');
    expect(hours[2]!.weather.precipitation).toEqual({ kind: 'snow', mmPerH: 1.4 });
    expect(hours[3]!.thunder).toBe(true);
    expect(hours[3]!.weather.precipitation).toEqual({ kind: 'rain', mmPerH: 5 });
    expect(hours[3]!.summary).toMatch(/^Гроза; ветер З/);
  });

  it('нулевой изотермы в ответе нет — оценка по температуре на высоте ячейки модели', () => {
    const json = structuredClone(FIXTURE);
    delete (json['hourly'] as Record<string, unknown>)['freezing_level_height'];
    const h = mapOpenMeteoHourly(json, utcAt('06:00'), 1)[0]!;
    // 231 м + 6 °C / 6,5 °C/км ≈ 1150 м.
    expect(h.freezingLevelM).toBe(1150);
    expect(h.freezingLevelEstimated).toBe(true);
    expect(hours[0]!.freezingLevelEstimated).toBeUndefined();
  });

  it('км/ч переводятся в м/с; время ответа со сдвигом пояса — в UTC', () => {
    const json = structuredClone(FIXTURE);
    json['hourly_units'] = { ...(json['hourly_units'] as object), wind_speed_10m: 'km/h' };
    expect(mapOpenMeteoHourly(json, utcAt('06:00'), 1)[0]!.weather.wind.speedMs).toBeCloseTo(4 / 3.6, 6);
    const shifted = { ...FIXTURE, utc_offset_seconds: 3 * 3600 };
    // «06:00» местного — 03:00 UTC.
    expect(mapOpenMeteoHourly(shifted, utcAt('03:00'), 1)[0]!.weather.wind.speedMs).toBe(4);
  });

  it('нет часов окна или нет ряда — ошибка по-русски', () => {
    expect(() => mapOpenMeteoHourly(FIXTURE, utcAt('20:00'), 3)).toThrow(/нет прогноза на это время/);
    expect(() => mapOpenMeteoHourly({ hourly: {} }, utcAt('06:00'), 3)).toThrow(/нет почасовых данных/);
  });
});

describe('почасовой прогноз Open-Meteo: запрос', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('адрес: почасовые поля, UTC, дни окна и час сверх него', () => {
    const url = forecastUrl(SITE, new Date('2026-09-14T22:30:00Z'), 2);
    expect(url).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    for (const f of ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'precipitation', 'rain', 'snowfall', 'visibility', 'cloud_cover', 'cloud_cover_low', 'freezing_level_height', 'weather_code', 'dew_point_2m'])
      expect(url).toContain(f);
    expect(url).toContain('timezone=GMT');
    expect(url).toContain('start_date=2026-09-14&end_date=2026-09-15');
  });

  it('ответ разбирается', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => FIXTURE }));
    vi.stubGlobal('fetch', fetch);
    const hours = await fetchForecast(SITE, utcAt('06:00'), 3);
    expect(hours).toHaveLength(3);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('freezing_level_height');
  });
});

// --- план по часам ---

const L = AIRCRAFT.limits;
const route = SCENARIOS.find((s): s is RouteScenario => s.kind === 'route')!;
const transfer = SCENARIOS.find((s): s is TransferScenario => s.kind === 'transfer')!;
const terrain = flatTerrain(200);
const gcs: Site = { ...route.site, elevationM: 200 };
const relief = TerrainRelief.build(terrain, gcs, { area: { east0: -3000, north0: -3000, east1: 3000, north1: 3000 } });
const DAY = '2026-06-20';
/** Час вылета по местному времени района. */
const utc = (localHour: number) => new Date(Date.parse(`${DAY}T00:00:00Z`) + (localHour - route.utcOffsetH) * 3_600_000);

function hourAt(localHour: number, over: Partial<Weather> = {}, extra: Partial<HourlyWeather> = {}): HourlyWeather {
  return {
    time: utc(localHour),
    weather: {
      groundTemperatureC: 15,
      wind: { speedMs: 1.5, fromDeg: 270 },
      windProfile: { referenceHeightM: 10, shearExponent: 0.15 },
      gustMs: 3,
      visibilityM: 30_000,
      cloudCover: 0.3,
      cloudBaseM: 1500,
      precipitation: null,
      ...over,
    },
    summary: 'синтетический прогноз',
    thunder: false,
    ...extra,
  };
}
const strong: Partial<Weather> = { wind: { speedMs: 1.3 * L.windMaxMs, fromDeg: 270 }, gustMs: 1.3 * L.gustMaxMs };
const moderate: Partial<Weather> = { wind: { speedMs: 0.55 * L.windMaxMs, fromDeg: 90 }, gustMs: 0.6 * L.gustMaxMs };
const rain: Partial<Weather> = { precipitation: { kind: 'rain', mmPerH: 2 }, cloudCover: 1, cloudBaseM: 800 };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

const plan = (hours: HourlyWeather[], sc: RouteScenario | TransferScenario = route): ForecastPlan =>
  planForecast({ scenario: sc, settings: sc.defaults, terrain, relief, gcs, relays: sc.relays, hours });
const byHour = (p: ForecastPlan, h: number): ForecastHour => p.hours.find((x) => Math.round(x.localHour) === h)!;
/** Идёт ли полёт с вылетом в час h в следующий час (правило «к посадке»). */
const spillsOver = (x: ForecastHour) => x.energy.durationS / 60 + 30 > 60;

describe('прогноз на вылет: план по часам', () => {
  it('в тихую погоду задание выполнимо с запасом — все часы «лететь»', () => {
    const p = plan(range(9, 12).map((h) => hourAt(h)));
    expect(p.hours).toHaveLength(4);
    for (const h of p.hours) {
      expect(h.verdict, h.reasons.map((c) => c.text).join('; ')).toBe('go');
      expect(h.energy.marginWh).toBeGreaterThan(0);
      expect(h.localDate).toBe(DAY);
    }
    expect(p.windows).toHaveLength(1);
    expect(p.windows[0]!.hours).toBe(4);
    // Связь — одна на все часы и в проверках часа не повторяется.
    expect(p.link.text).toMatch(/Связь с НСУ|Нет связи/);
    for (const h of p.hours) expect(h.checks.some((c) => c.text === p.link.text)).toBe(false);
  });

  it('сильный ветер днём — в эти часы «не лететь», и час, чья посадка приходится на ветер, тоже', () => {
    const p = plan(range(8, 19).map((h) => hourAt(h, h >= 12 && h <= 14 ? strong : {})));
    for (const h of [12, 13, 14]) {
      const x = byHour(p, h);
      expect(x.verdict).toBe('nogo');
      expect(x.reasons.map((c) => c.text).join('\n')).toMatch(/Ветер у земли/);
    }
    for (const h of [8, 9, 15, 16, 17, 18, 19]) expect(byHour(p, h).verdict).not.toBe('nogo');
    const before = byHour(p, 11);
    if (spillsOver(before)) {
      expect(before.verdict).toBe('nogo');
      expect(before.reasons[0]!.text).toMatch(/^К посадке .* погода хуже: в 12:00/);
    } else expect(before.verdict).not.toBe('nogo');
    // Окна — до ветра и после.
    expect(p.windows).toHaveLength(2);
    expect(Math.round(p.hours[p.windows[0]!.start]!.localHour)).toBe(8);
    expect(Math.round(p.hours[p.windows[1]!.start]!.localHour)).toBe(15);
  });

  it('дождь и гроза — нельзя', () => {
    const p = plan([hourAt(10), hourAt(11, rain), hourAt(12, rain, { thunder: true, sky: 'гроза' }), hourAt(13)]);
    const r = byHour(p, 11);
    expect(r.verdict).toBe('nogo');
    expect(r.sky.precipitation).toMatch(/дождь 2/);
    expect(r.reasons.map((c) => c.text).join('\n')).toMatch(/Осадки: дождь/);
    const t = byHour(p, 12);
    expect(t.verdict).toBe('nogo');
    expect(t.sky.thunder).toBe(true);
    expect(t.reasons.map((c) => c.text).join('\n')).toMatch(/Гроза/);
    expect(byHour(p, 13).verdict).toBe('go');
  });

  it('обледенение: маршрут выше нулевой изотермы в облаках — нельзя', () => {
    const cold = hourAt(10, { groundTemperatureC: 3, cloudCover: 0.9, cloudBaseM: 100 }, { freezingLevelM: 250 });
    const x = plan([cold]).hours[0]!;
    expect(x.verdict).toBe('nogo');
    expect(x.sky.icing).toBe(true);
    expect(x.reasons.map((c) => c.text).join('\n')).toMatch(/обледенения/);
  });

  it('лучшее время — в тихом окне, окна — непрерывные часы, где можно лететь', () => {
    const weather = (h: number): Partial<Weather> => (h <= 10 ? moderate : h === 11 ? strong : h <= 15 ? {} : h === 16 ? rain : moderate);
    const p = plan(range(8, 19).map((h) => hourAt(h, weather(h))));
    expect(p.best).not.toBeNull();
    const best = p.hours[p.best!]!;
    expect(Math.round(best.localHour)).toBe(12);
    expect(best.verdict).toBe('go');
    // Тихо — запас больше, чем в ветер.
    expect(best.energy.marginWh).toBeGreaterThan(byHour(p, 8).energy.marginWh);
    expect(p.windows).toHaveLength(3);
    const home = p.windows.find((w) => w.start <= p.best! && p.best! <= w.end)!;
    expect(home.best).toBe(p.best);
    expect(Math.round(p.hours[home.start]!.localHour)).toBe(12);
    for (const w of p.windows) for (let i = w.start; i <= w.end; i++) expect(p.hours[i]!.verdict).not.toBe('nogo');
    // Окна пересчитываются по вердиктам.
    expect(forecastWindows(p.hours)).toEqual(p.windows);
  });

  it('запас энергии падает при встречном ветре; на посадке ветер — встречный по посадочному курсу', () => {
    const toB = bearingDeg(transfer.site, transfer.destination);
    const v = 0.55 * L.windMaxMs;
    const p = plan(
      [
        hourAt(10),
        hourAt(11, { wind: { speedMs: v, fromDeg: toB }, gustMs: v + 2 }),
        hourAt(12, { wind: { speedMs: v, fromDeg: (toB + 180) % 360 }, gustMs: v + 2 }),
      ],
      transfer,
    );
    const [calm, head, tail] = p.hours as [ForecastHour, ForecastHour, ForecastHour];
    expect(head.energy.marginWh).toBeLessThan(calm.energy.marginWh);
    expect(tail.energy.marginWh).toBeGreaterThan(head.energy.marginWh);
    expect(head.energy.durationS).toBeGreaterThan(tail.energy.durationS);
    // Заход — против ветра: встречный во всю силу ветра, бокового нет.
    const land = head.landing[0]!;
    expect(land.headwindMs).toBeCloseTo(v, 6);
    expect(land.crosswindMs).toBeLessThan(1e-6);
    expect(head.wind.routeMs).toBeGreaterThan(v);
  });

  it('вылет — настоящие дата и час: Солнце на этот момент', () => {
    const p = plan([hourAt(4), hourAt(13)]);
    expect(byHour(p, 13).sun.takeoffDeg).toBeGreaterThan(byHour(p, 4).sun.takeoffDeg);
  });

  it('окно: часы после него — только для погоды к посадке', () => {
    const hours = range(8, 13).map((h) => hourAt(h, h === 12 ? strong : {}));
    const p = planForecast({ scenario: route, settings: route.defaults, terrain, relief, gcs, hours, window: { from: utc(9), hours: 3 } });
    expect(p.hours.map((x) => Math.round(x.localHour))).toEqual([9, 10, 11]);
    expect(byHour(p, 11).verdict).toBe(spillsOver(byHour(p, 11)) ? 'nogo' : 'go');
  });

  it('порциями — тот же результат; ход расчёта и отмена', async () => {
    const hours = range(8, 13).map((h) => hourAt(h, h === 10 ? rain : {}));
    const input = { scenario: route, settings: route.defaults, terrain, relief, gcs, hours };
    const sync = planForecast(input);
    const progress: number[] = [];
    let pauses = 0;
    const p = await planForecastAsync(input, { budgetMs: 0, onProgress: (d) => progress.push(d), pause: async () => void pauses++ });
    expect(p.hours.map((x) => [x.verdict, x.energy.marginWh])).toEqual(sync.hours.map((x) => [x.verdict, x.energy.marginWh]));
    expect(progress.at(-1)).toBe(6);
    expect(pauses).toBeGreaterThanOrEqual(6);
    await expect(planForecastAsync(input, { signal: { aborted: true, addEventListener() {}, removeEventListener() {} } })).rejects.toThrow(/отменён/);
  });
});

describe('прогноз на вылет: применить час', () => {
  it('задание с другой датой и часом вылета — departure даёт этот момент', () => {
    const before = JSON.stringify(route);
    const t = new Date('2026-09-14T21:00:00Z');
    const { scenario, settings } = atDeparture(route, route.defaults, t);
    expect(departure(scenario, settings).getTime()).toBe(t.getTime());
    expect(scenario.route).toBe(route.route);
    expect(JSON.stringify(route)).toBe(before);
  });

  it('погода часа — в настройки задания с шагом ползунков, прогноз часа — целиком', () => {
    const h = hourAt(14, { wind: { speedMs: 4.3, fromDeg: 247 }, groundTemperatureC: 17.6, gustMs: 8, windProfile: { referenceHeightM: 10, shearExponent: 0.25 } });
    const r = applyForecastHour(route, route.defaults, h);
    expect(r.scenario.date).toBe(DAY);
    expect(r.settings.localHour).toBe(14);
    expect(r.settings.windSpeedMs).toBe(4.5);
    expect(r.settings.windFromDeg).toBe(245);
    expect(r.settings.temperatureC).toBe(18);
    expect(r.scenario.shearExponent).toBe(0.25);
    expect(r.weather.gustMs).toBe(8);
    expect(r.summary).toMatch(/^Прогноз на 20\.06\.2026 14:00: синтетический прогноз · Погода: Open-Meteo\.com$/);
    expect(route.defaults.localHour).not.toBe(14);
  });
});

describe('ветер у рельефа по часам', () => {
  const site: Site = { lat: 45, lon: 40, elevationM: 800 };
  const ridge: Terrain = {
    elevationM: (p) => {
      const { east } = toLocal(site, p);
      return site.elevationM + 400 * Math.exp(-((east + 1500) ** 2) / (2 * 1000 ** 2));
    },
  };
  const r = TerrainRelief.build(ridge, site, { area: { east0: -8000, north0: -8000, east1: 8000, north1: 8000 } });
  const w = (speedMs: number): Weather => ({ groundTemperatureC: 15, wind: { speedMs, fromDeg: 270 }, cloudCover: 0.2 });

  it('сетки одного направления общие: результат тот же, что у поля с нуля', () => {
    const first = new TerrainWind(r, w(6));
    const shared = new TerrainWind(r, w(10), { grid: first });
    const fresh = new TerrainWind(r, w(10));
    expect(shared.windHazardAt(0, 0)).toEqual(fresh.windHazardAt(0, 0));
    expect(shared.localWind(300, -200, 40, 0)).toEqual(fresh.localWind(300, -200, 40, 0));
    // Другое направление — сетки свои.
    const other = new TerrainWind(r, { ...w(10), wind: { speedMs: 10, fromDeg: 90 } }, { grid: first });
    expect(other.windHazardAt(0, 0)).toEqual(new TerrainWind(r, { ...w(10), wind: { speedMs: 10, fromDeg: 90 } }).windHazardAt(0, 0));
  });
});
