import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLiveWeather, mapOpenMeteo, openMeteoUrl, type AbortSignalLike } from '../src/game/liveWeather';
import { blocked, preflightChecks, type Check } from '../src/game/preflight';
import { buildMission, forecastWeather, SCENARIOS, type DeliveryScenario } from '../src/game/scenarios';
import { actualWeather, fogFor, overcastFactor, weatherPreset, type WeatherPresetKind } from '../src/game/weather';
import { AIRCRAFT } from '../src/sim/aircraft';
import { flatTerrain } from '../src/sim/terrain';
import type { Weather } from '../src/sim/types';

/*
 * Погода: разбор ответа Open-Meteo (без сети — ответ написан руками), ошибка прогноза, погода
 * заданной сложности, дымка и пасмурность, проверки РЛЭ по порывам, видимости, осадкам и обледенению.
 */

const SITE = { lat: 55.0, lon: 37.0 };
const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00Z`);

/** Три часа 09–11 UTC; row — значения для 10:00, остальные часы — сухо и тихо. */
function fixture(row: Record<string, number>, extra: Record<string, unknown> = {}) {
  const quiet: Record<string, number> = {
    temperature_2m: 5,
    dew_point_2m: 1,
    wind_speed_10m: 2,
    wind_direction_10m: 180,
    wind_gusts_10m: 3,
    wind_speed_80m: 3,
    wind_speed_120m: 3.3,
    cloud_cover: 20,
    cloud_cover_low: 0,
    visibility: 30000,
    precipitation: 0,
    rain: 0,
    showers: 0,
    snowfall: 0,
    weather_code: 1,
  };
  const hourly: Record<string, unknown> = { time: ['2026-03-10T09:00', '2026-03-10T10:00', '2026-03-10T11:00'] };
  for (const k of Object.keys(quiet)) hourly[k] = [quiet[k], row[k] ?? quiet[k], quiet[k]];
  return { latitude: 55, longitude: 37, utc_offset_seconds: 0, hourly_units: { wind_speed_10m: 'm/s' }, hourly, ...extra };
}

describe('погода Open-Meteo: разбор ответа', () => {
  // Ветер 4 м/с на 10 м и степенной закон с α = 0.25 на 80 и 120 м.
  const base = {
    temperature_2m: 12,
    dew_point_2m: 8,
    wind_speed_10m: 4,
    wind_direction_10m: 270,
    wind_gusts_10m: 9,
    wind_speed_80m: 4 * 8 ** 0.25,
    wind_speed_120m: 4 * 12 ** 0.25,
    cloud_cover: 90,
    cloud_cover_low: 60,
    visibility: 24000,
    weather_code: 3,
  };

  it('ветер, показатель профиля, порывы и турбулентность', () => {
    const live = mapOpenMeteo(fixture(base), at('10:00'));
    const w = live.weather;
    expect(w.wind.speedMs).toBeCloseTo(4, 6);
    expect(w.wind.fromDeg).toBe(270);
    expect(w.windProfile).toEqual({ referenceHeightM: 10, shearExponent: expect.closeTo(0.25, 6) });
    expect(w.gustMs).toBe(9);
    expect(w.turbulenceMs).toBeCloseTo((9 - 4) / 2.5, 6);
    expect(w.visibilityM).toBe(24000);
    expect(w.cloudCover).toBeCloseTo(0.9, 6);
    expect(w.precipitation).toBeNull();
    expect(live.time.toISOString()).toBe('2026-03-10T10:00:00.000Z');
    expect(live.attribution).toBe('Погода: Open-Meteo.com');
    expect(live.summary).toMatch(/^Пасмурно; ветер З \(270°\) 4,0 м\/с, порывы до 9,0 м\/с/);
  });

  it('показатель профиля ограничен 0.05…0.45; без верхних уровней — 0.2', () => {
    const steep = mapOpenMeteo(fixture({ ...base, wind_speed_80m: 4 * 8 ** 0.9, wind_speed_120m: 4 * 12 ** 0.9 }), at('10:00'));
    expect(steep.weather.windProfile!.shearExponent).toBe(0.45);
    const flat = mapOpenMeteo(fixture({ ...base, wind_speed_80m: 3, wind_speed_120m: 3 }), at('10:00'));
    expect(flat.weather.windProfile!.shearExponent).toBe(0.05);
    const json = fixture(base);
    delete (json.hourly as Record<string, unknown>)['wind_speed_80m'];
    delete (json.hourly as Record<string, unknown>)['wind_speed_120m'];
    expect(mapOpenMeteo(json, at('10:00')).weather.windProfile!.shearExponent).toBe(0.2);
  });

  it('нижняя граница облаков — по разнице температуры и точки росы, если есть низкая облачность', () => {
    expect(mapOpenMeteo(fixture(base), at('10:00')).weather.cloudBaseM).toBe(500);
    // Низких облаков нет — граница не ниже среднего яруса.
    expect(mapOpenMeteo(fixture({ ...base, cloud_cover_low: 0 }), at('10:00')).weather.cloudBaseM).toBe(2000);
  });

  it('вид осадков — по коду погоды, дождю и снегопаду', () => {
    const w = (row: Record<string, number>) => mapOpenMeteo(fixture({ ...base, ...row }), at('10:00')).weather.precipitation;
    expect(w({ weather_code: 63, precipitation: 2.4, rain: 2.4 })).toEqual({ kind: 'rain', mmPerH: 2.4 });
    expect(w({ weather_code: 81, precipitation: 5, showers: 5 })).toEqual({ kind: 'rain', mmPerH: 5 });
    expect(w({ temperature_2m: -3, dew_point_2m: -5, weather_code: 73, precipitation: 2, snowfall: 1.4 })).toEqual({ kind: 'snow', mmPerH: 2 });
    expect(w({ temperature_2m: 1, dew_point_2m: 0, weather_code: 73, precipitation: 1.6, rain: 0.6, snowfall: 0.7 })).toEqual({ kind: 'sleet', mmPerH: 1.6 });
    expect(w({ weather_code: 53, precipitation: 0.3, rain: 0.3 })!.kind).toBe('drizzle');
    // Код есть, а количества модель не дала — интенсивность по коду.
    expect(w({ weather_code: 53 })).toEqual({ kind: 'drizzle', mmPerH: 0.5 });
    // Без кода, но с заметным количеством — всё равно осадки.
    expect(w({ weather_code: 3, precipitation: 0.4, rain: 0.4 })).toEqual({ kind: 'rain', mmPerH: 0.4 });
  });

  it('суммы осадков — за предыдущий час: к 09:20 относится час 10:00, мгновенные значения — от 09:00', () => {
    const live = mapOpenMeteo(fixture({ ...base, weather_code: 61, precipitation: 1.2, rain: 1.2 }), at('09:20'));
    expect(live.weather.precipitation).toEqual({ kind: 'rain', mmPerH: 1.2 });
    expect(live.weather.wind.speedMs).toBe(2);
    expect(live.time.toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });

  it('текущие значения ближе нужного момента — берутся они; км/ч переводятся в м/с', () => {
    const current = { time: '2026-03-10T10:15', interval: 900, temperature_2m: 7, wind_speed_10m: 18, wind_direction_10m: 90, wind_gusts_10m: 36, precipitation: 0.5, rain: 0.5, weather_code: 63 };
    const json = fixture(base, { current, current_units: { wind_speed_10m: 'km/h' } });
    const live = mapOpenMeteo(json, at('10:15'));
    expect(live.weather.wind.speedMs).toBeCloseTo(5, 6);
    expect(live.weather.gustMs).toBeCloseTo(10, 6);
    expect(live.weather.groundTemperatureC).toBe(7);
    // 0,5 мм за 15 минут — 2 мм/ч.
    expect(live.weather.precipitation).toEqual({ kind: 'rain', mmPerH: 2 });
    expect(live.time.toISOString()).toBe('2026-03-10T10:15:00.000Z');
  });

  it('сдвиг часового пояса ответа учитывается', () => {
    const json = { ...fixture(base), utc_offset_seconds: 7 * 3600 };
    // «10:00» местного — 03:00 UTC.
    expect(mapOpenMeteo(json, new Date('2026-03-10T03:00:00Z')).weather.wind.speedMs).toBe(4);
  });

  it('непонятный ответ или время вне ряда — ошибка по-русски', () => {
    expect(() => mapOpenMeteo({ foo: 1 }, at('10:00'))).toThrow(/нет почасовых данных/);
    expect(() => mapOpenMeteo(fixture(base), new Date('2026-03-11T10:00:00Z'))).toThrow(/нет прогноза на это время/);
  });
});

describe('погода Open-Meteo: запрос', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

  it('адрес: координаты, ветер в м/с, сутки вокруг момента', () => {
    const url = openMeteoUrl(SITE, new Date('2026-03-10T23:30:00Z'));
    expect(url).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    expect(url).toContain('latitude=55.0000&longitude=37.0000');
    expect(url).toContain('wind_speed_unit=ms');
    expect(url).toContain('wind_speed_80m');
    expect(url).toContain('start_date=2026-03-10&end_date=2026-03-11');
  });

  it('ответ разбирается', async () => {
    const fetch = vi.fn(async () => ok(fixture({ wind_speed_10m: 6 })));
    vi.stubGlobal('fetch', fetch);
    const live = await fetchLiveWeather(SITE, at('10:00'));
    expect(live.weather.wind.speedMs).toBe(6);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('ошибки сервиса и сети — отказ с сообщением по-русски', async () => {
    vi.stubGlobal('fetch', async () => ok({ error: true, reason: 'Parameter start_date is out of allowed range' }, 400));
    await expect(fetchLiveWeather(SITE, at('10:00'))).rejects.toThrow(/На эту дату прогноза нет/);
    vi.stubGlobal('fetch', async () => ok({ error: true, reason: 'boom' }, 500));
    await expect(fetchLiveWeather(SITE, at('10:00'))).rejects.toThrow(/ответил ошибкой 500: boom/);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchLiveWeather(SITE, at('10:00'))).rejects.toThrow(/Нет связи с сервисом погоды/);
  });

  /** fetch, который ждёт вечно и отваливается только по сигналу. */
  const hanging = () =>
    vi.fn(
      (_url: string, init: { signal: AbortSignalLike }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('AbortError')))),
    );
  /** Сигнал отмены без DOM-типов — ядро собирается без lib.dom. */
  const canceller = () => {
    const listeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener: (_: 'abort', f: () => void) => void listeners.add(f),
      removeEventListener: (_: 'abort', f: () => void) => void listeners.delete(f),
    };
    return {
      signal,
      abort() {
        signal.aborted = true;
        listeners.forEach((f) => f());
      },
    };
  };

  it('без ответа 10 с — отказ по таймауту', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hanging());
    const p = fetchLiveWeather(SITE, at('10:00'));
    const check = expect(p).rejects.toThrow(/не ответил за 10 с/);
    await vi.advanceTimersByTimeAsync(10_001);
    await check;
  });

  it('отмена через signal', async () => {
    vi.stubGlobal('fetch', hanging());
    const ctrl = canceller();
    const p = fetchLiveWeather(SITE, at('10:00'), ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow(/отменена/);
  });
});

describe('ошибка прогноза', () => {
  const plain: Weather = { groundTemperatureC: 10, wind: { speedMs: 6, fromDeg: 200 }, windProfile: { referenceHeightM: 10, shearExponent: 0.2 } };
  const full: Weather = { ...plain, gustMs: 10, turbulenceMs: 1.5, visibilityM: 8000, precipitation: { kind: 'rain', mmPerH: 2 }, cloudCover: 0.8, cloudBaseM: 700 };

  it('ветер и температура от seed не зависят от того, есть ли остальные поля', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const a = actualWeather(plain, seed);
      const b = actualWeather(full, seed);
      expect(b.wind).toEqual(a.wind);
      expect(b.groundTemperatureC).toBe(a.groundTemperatureC);
      expect(a.gustMs).toBeUndefined();
      expect(a.visibilityM).toBeUndefined();
      expect(a.precipitation).toBeUndefined();
    }
  });

  it('возмущения правдоподобны: порывы не слабее ветра, видимость и облачность в пределах', () => {
    let dry = 0;
    for (let seed = 0; seed < 400; seed++) {
      const w = actualWeather(full, seed);
      expect(w.gustMs!).toBeGreaterThanOrEqual(w.wind.speedMs);
      expect(w.turbulenceMs!).toBeGreaterThan(0);
      expect(w.visibilityM!).toBeGreaterThanOrEqual(50);
      expect(w.cloudCover!).toBeGreaterThanOrEqual(0);
      expect(w.cloudCover!).toBeLessThanOrEqual(1);
      expect(w.cloudBaseM!).toBeGreaterThanOrEqual(30);
      if (!w.precipitation) dry++;
      else expect(w.precipitation.mmPerH).toBeGreaterThan(0);
    }
    // Осадки прогноз иногда «проносит» — но редко.
    expect(dry).toBeGreaterThan(20);
    expect(dry).toBeLessThan(120);
    expect(actualWeather(full, 5)).toEqual(actualWeather(full, 5));
  });
});

describe('дымка и пасмурность', () => {
  it('дымка: при хорошей видимости — обычная, с ухудшением ближе, монотонно', () => {
    expect(fogFor(undefined)).toEqual({ near: 4000, far: 34000 });
    expect(fogFor(60_000)).toEqual({ near: 4000, far: 34000 });
    let prev = { near: 0, far: 0 };
    for (const v of [10, 100, 300, 800, 1000, 2000, 5000, 10_000, 20_000, 30_000, 50_000]) {
      const f = fogFor(v);
      expect(f.far).toBeGreaterThan(f.near);
      expect(f.near).toBeGreaterThanOrEqual(prev.near);
      expect(f.far).toBeGreaterThanOrEqual(prev.far);
      prev = f;
    }
    // На видимости — почти полная дымка.
    const f = fogFor(1000);
    expect(f.far).toBeGreaterThan(1000);
    expect(f.far).toBeLessThan(1500);
  });

  it('пасмурность 0…1 растёт с облачностью, осадками и туманом', () => {
    const clear: Weather = { groundTemperatureC: 10, wind: { speedMs: 3, fromDeg: 0 }, cloudCover: 0, visibilityM: 30_000, precipitation: null };
    expect(overcastFactor(clear)).toBe(0);
    expect(overcastFactor({ ...clear, cloudCover: 1 })).toBeGreaterThan(0.8);
    expect(overcastFactor({ ...clear, cloudCover: 0.3 })).toBeLessThan(overcastFactor({ ...clear, cloudCover: 0.7 }));
    expect(overcastFactor({ ...clear, precipitation: { kind: 'rain', mmPerH: 1 } })).toBeGreaterThanOrEqual(0.75);
    expect(overcastFactor({ ...clear, visibilityM: 300 })).toBeGreaterThan(0.9);
    expect(overcastFactor({ ...clear, cloudCover: 1, precipitation: { kind: 'rain', mmPerH: 50 }, visibilityM: 100 })).toBeLessThanOrEqual(1);
  });
});

describe('предполётные проверки: метеоусловия РЛЭ', () => {
  const LIM = AIRCRAFT.limits;
  const terrain = flatTerrain(260);
  const delivery = SCENARIOS.find((s): s is DeliveryScenario => s.kind === 'delivery')!;
  const base: Weather = { ...forecastWeather(delivery, delivery.defaults), wind: { speedMs: 3, fromDeg: 250 }, groundTemperatureC: 12 };
  const mission = buildMission(delivery, delivery.defaults, terrain, base);
  const run = (w: Weather) => preflightChecks({ stages: mission.stages, weather: w, procedures: mission.procedures, cloudBaseM: delivery.cloudBaseM, terrain, gcs: mission.site });
  const failing = (checks: Check[], re: RegExp) => checks.filter((c) => !c.ok && re.test(c.text));

  it('прогноз по заданию: без порывов и видимости, осадков нет — «ГОТОВ»', () => {
    const checks = run(base);
    expect(blocked(checks)).toBe(false);
    // В прогнозе задания нет порывов и видимости — таких строк нет; облачность и «без осадков» есть.
    expect(checks.some((c) => /^(Порывы|Видимость)/.test(c.text))).toBe(false);
    expect(checks.find((c) => c.text === 'Без осадков')?.ok).toBe(true);
    expect(checks.find((c) => /^Опасности обледенения нет/.test(c.text))?.ok).toBe(true);
  });

  it('порывы сильнее допустимых — взлёт запрещён', () => {
    expect(blocked(run({ ...base, gustMs: LIM.gustMaxMs }))).toBe(false);
    const checks = run({ ...base, gustMs: LIM.gustMaxMs + 1 });
    expect(blocked(checks)).toBe(true);
    expect(failing(checks, /^Порывы/)).toHaveLength(1);
  });

  it('видимость: меньше 1 км — запрет, меньше 3 км — предупреждение про съёмку', () => {
    const fog = run({ ...base, visibilityM: 800 });
    expect(blocked(fog)).toBe(true);
    expect(failing(fog, /^Видимость 800 м/)[0]!.level).toBe('block');
    const haze = run({ ...base, visibilityM: 2000 });
    expect(blocked(haze)).toBe(false);
    const warn = failing(haze, /не позволяет вести съёмку/);
    expect(warn).toHaveLength(1);
    expect(warn[0]!.level).toBe('warn');
    expect(failing(run({ ...base, visibilityM: 5000 }), /Видимость/)).toHaveLength(0);
  });

  it('любые осадки — взлёт запрещён; сухо — отдельной строкой', () => {
    const wet = run({ ...base, precipitation: { kind: 'drizzle', mmPerH: 0.2 } });
    expect(blocked(wet)).toBe(true);
    expect(failing(wet, /^Осадки: морось/)).toHaveLength(1);
    const dry = run({ ...base, precipitation: null });
    expect(blocked(dry)).toBe(false);
    expect(dry.find((c) => c.text === 'Без осадков')?.ok).toBe(true);
    expect(dry.find((c) => c.text === 'Опасности обледенения нет')?.ok).toBe(true);
  });

  it('обледенение: осадки или туман около нуля, облака на высоте маршрута в мороз', () => {
    expect(failing(run({ ...base, groundTemperatureC: 1, visibilityM: 700 }), /обледенения/)).toHaveLength(1);
    expect(failing(run({ ...base, groundTemperatureC: -5, precipitation: { kind: 'snow', mmPerH: 1 } }), /обледенения/)).toHaveLength(1);
    // Туман в тепле — запрет по видимости, но не обледенение.
    expect(failing(run({ ...base, groundTemperatureC: 12, visibilityM: 700 }), /обледенения/)).toHaveLength(0);

    const site = mission.stages[0]!.takeoff.elevationM;
    const topAgl = Math.max(...mission.stages.flatMap((s) => s.waypoints.map((p) => p.altitudeM))) - site;
    const low = topAgl - 20;
    expect(failing(run({ ...base, groundTemperatureC: 0, cloudBaseM: low }), /обледенения: маршрут заходит в облака/)).toHaveLength(1);
    expect(failing(run({ ...base, groundTemperatureC: 15, cloudBaseM: low }), /обледенения/)).toHaveLength(0);
    // Облака выше маршрута — мороз не мешает.
    expect(failing(run({ ...base, groundTemperatureC: -10, cloudBaseM: topAgl + 200 }), /обледенения/)).toHaveLength(0);
  });

  it('нижняя граница облаков из погоды важнее, чем из задания', () => {
    const checks = run({ ...base, cloudBaseM: LIM.minCloudBaseM - 50 });
    expect(blocked(checks)).toBe(true);
    expect(failing(checks, /^Нижняя граница облаков/)).toHaveLength(1);
  });

  it('погода заданной сложности: тихо, свежо и порывисто проходят, остальное — нет', () => {
    const verdict = (k: WeatherPresetKind) => blocked(run(weatherPreset(k, base)));
    for (const k of ['calm', 'breezy', 'gusty'] as const) expect(verdict(k), k).toBe(false);
    for (const k of ['rain', 'snow', 'fog', 'lowcloud', 'storm'] as const) expect(verdict(k), k).toBe(true);
    for (const k of ['calm', 'storm', 'rain'] as const) expect(weatherPreset(k, base).wind.fromDeg).toBe(250);
    expect(weatherPreset('snow', base).groundTemperatureC).toBeLessThan(0);
    expect(weatherPreset('rain', { ...base, groundTemperatureC: -8 }).groundTemperatureC).toBeGreaterThan(2);
  });
});
