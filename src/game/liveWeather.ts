import type { GeoPoint, Weather } from '../sim/types';
import { PRECIPITATION_NAME, type Precipitation } from './weather';

/*
 * Погода на площадке по прогнозу Open-Meteo (без ключа): почасово на сутки вылета плюс текущие
 * значения. Сеть — только в fetchLiveWeather; разбор ответа — чистая mapOpenMeteo, её и проверяют тесты.
 * Ядро собирается без DOM, поэтому fetch и AbortSignal описаны здесь по форме, а берутся из globalThis.
 */

export interface LiveWeather {
  weather: Weather;
  /** Сводка для оператора. */
  summary: string;
  /** К какому моменту относятся данные: час прогноза или текущие значения. */
  time: Date;
  attribution: 'Погода: Open-Meteo.com';
}

/** То, что нужно от AbortSignal; DOM-овский подходит как есть. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
interface Env {
  fetch?: (url: string, init: { signal: AbortSignalLike }) => Promise<FetchResponse>;
  AbortController?: new () => { readonly signal: AbortSignalLike; abort(): void };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
const env = globalThis as unknown as Env;

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 10_000;
const ABORTED = 'Загрузка погоды отменена';
const ATTRIBUTION = 'Погода: Open-Meteo.com';

const INSTANT = ['temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cloud_cover', 'cloud_cover_low', 'visibility'];
const SUMS = ['precipitation', 'rain', 'showers', 'snowfall', 'weather_code'];
const HOURLY = [...INSTANT, 'wind_speed_80m', 'wind_speed_120m', ...SUMS];

/** Показатель роста ветра с высотой, если выше 10 м данных нет, — как в заданиях. */
const DEFAULT_SHEAR = 0.2;
/** Нижняя граница конвективных облаков: ≈ 125 м на градус разницы температуры и точки росы (формула Ферреля). */
const LCL_M_PER_C = 125;
/** Облака среднего яруса и выше — не ниже ~2 км. */
const MID_CLOUD_BASE_M = 2000;

/** Коды погоды ВМО: название и, если это осадки, их вид и интенсивность, когда модель не дала количества. */
const CODES: Record<number, [string, Precipitation['kind']?, number?]> = {
  0: ['ясно'],
  1: ['малооблачно'],
  2: ['переменная облачность'],
  3: ['пасмурно'],
  45: ['туман'],
  48: ['туман с изморозью'],
  51: ['слабая морось', 'drizzle', 0.2],
  53: ['морось', 'drizzle', 0.5],
  55: ['сильная морось', 'drizzle', 1],
  56: ['переохлаждённая морось', 'drizzle', 0.3],
  57: ['сильная переохлаждённая морось', 'drizzle', 1],
  61: ['слабый дождь', 'rain', 1],
  63: ['дождь', 'rain', 3],
  65: ['сильный дождь', 'rain', 8],
  66: ['ледяной дождь', 'rain', 1],
  67: ['сильный ледяной дождь', 'rain', 5],
  71: ['слабый снег', 'snow', 0.5],
  73: ['снег', 'snow', 1.5],
  75: ['сильный снег', 'snow', 3],
  77: ['снежная крупа', 'snow', 0.5],
  80: ['слабый ливень', 'rain', 2],
  81: ['ливень', 'rain', 6],
  82: ['сильный ливень', 'rain', 15],
  85: ['снежный заряд', 'snow', 1.5],
  86: ['сильный снежный заряд', 'snow', 4],
  95: ['гроза', 'rain', 6],
  96: ['гроза с градом', 'rain', 10],
  99: ['сильная гроза с градом', 'rain', 20],
};

/** Единицы скорости Open-Meteo → м/с (просим м/с, но ответ проверяем). */
const SPEED_UNITS: Record<string, number> = { 'm/s': 1, 'km/h': 1 / 3.6, 'mp/h': 0.44704, kn: 0.514444 };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fmt = (x: number, d = 0) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (t: number) => `${t > 0.05 ? '+' : ''}${fmt(t, 1)}`;
const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : null);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Запрос к Open-Meteo: сутки (UTC) вокруг when, время в ответе — UTC. */
export function openMeteoUrl(site: GeoPoint, when: Date): string {
  const t = when.getTime();
  const q = [
    `latitude=${site.lat.toFixed(4)}`,
    `longitude=${site.lon.toFixed(4)}`,
    `hourly=${HOURLY.join(',')}`,
    `current=${[...INSTANT, ...SUMS].join(',')}`,
    'wind_speed_unit=ms',
    'timezone=GMT',
    // Час до и час после — чтобы у момента на границе суток были соседние часы.
    `start_date=${utcDay(t - 3600_000)}`,
    `end_date=${utcDay(t + 3600_000)}`,
  ];
  return `${ENDPOINT}?${q.join('&')}`;
}

/**
 * Погода на площадке к моменту when. Отменяется через signal; без ответа 10 с — отказ.
 * Все отказы — Error с сообщением для оператора.
 */
export async function fetchLiveWeather(site: GeoPoint, when: Date, signal?: AbortSignalLike): Promise<LiveWeather> {
  const fetch = env.fetch;
  const Controller = env.AbortController;
  if (!fetch || !Controller) throw new Error('Браузер не умеет загружать погоду');
  if (signal?.aborted) throw new Error(ABORTED);
  const ctrl = new Controller();
  let timedOut = false;
  const timer = env.setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  // Отмену и таймаут fetch выдаёт как исключение — различаем по флагам.
  const lost = (fallback: string) => new Error(timedOut ? `Сервис погоды не ответил за ${TIMEOUT_MS / 1000} с` : signal?.aborted ? ABORTED : fallback);
  try {
    let res: FetchResponse;
    try {
      res = await fetch(openMeteoUrl(site, when), { signal: ctrl.signal });
    } catch {
      throw lost('Нет связи с сервисом погоды Open-Meteo');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (timedOut || signal?.aborted) throw lost('');
      body = null;
    }
    if (!res.ok) {
      const reason = obj(body)?.['reason'];
      if (typeof reason === 'string' && /out of allowed range/i.test(reason)) {
        throw new Error('На эту дату прогноза нет: Open-Meteo даёт погоду примерно на три месяца назад и две недели вперёд');
      }
      throw new Error(`Сервис погоды ответил ошибкой ${res.status}${typeof reason === 'string' ? `: ${reason}` : ''}`);
    }
    if (body === null) throw new Error('Сервис погоды прислал непонятный ответ');
    return mapOpenMeteo(body, when);
  } finally {
    env.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Показатель степенного профиля ветра по 10 м и верхним уровням: наименьшие квадраты в логарифмах
 * с закреплённой точкой 10 м (от неё считает windAt). Ночью у земли штиль, а на 100 м — струя:
 * показатель уходит за 0.45, а степенной закон там всё равно не годится — ограничиваем.
 */
function fitShear(v10: number, upper: [heightM: number, speedMs: number | undefined][]): number {
  let sxy = 0;
  let sxx = 0;
  for (const [h, v] of upper) {
    if (v === undefined) continue;
    const x = Math.log(h / 10);
    sxy += x * Math.log(Math.max(v, 0.3) / Math.max(v10, 0.3));
    sxx += x * x;
  }
  return sxx > 0 ? clamp(sxy / sxx, 0.05, 0.45) : DEFAULT_SHEAR;
}

/** Разбор ответа Open-Meteo (формат JSON, как у openMeteoUrl) к моменту when. */
export function mapOpenMeteo(json: unknown, when: Date): LiveWeather {
  const root = obj(json);
  const hourly = obj(root?.['hourly']);
  const times = hourly?.['time'];
  if (!root || !hourly || !Array.isArray(times) || times.length === 0) throw new Error('В ответе сервиса погоды нет почасовых данных');
  const offsetMs = (num(root['utc_offset_seconds']) ?? 0) * 1000;
  // Время — строка местного времени ответа или секунды UTC (timeformat=unixtime).
  const parse = (t: unknown) => (typeof t === 'string' ? Date.parse(`${t}Z`) - offsetMs : typeof t === 'number' ? t * 1000 : NaN);
  const ms = times.map(parse);
  const target = when.getTime();
  let near = -1;
  for (let i = 0; i < ms.length; i++) {
    const d = Math.abs(ms[i]! - target);
    if (Number.isFinite(d) && (near < 0 || d < Math.abs(ms[near]! - target))) near = i;
  }
  if (near < 0 || Math.abs(ms[near]! - target) > 3 * 3600_000) throw new Error('В ответе сервиса погоды нет прогноза на это время');
  // Суммы осадков и код погоды в почасовом ряду — за предыдущий час: берём первый час не раньше when.
  let sumAt = ms.findIndex((t) => t >= target);
  if (sumAt < 0) sumAt = ms.length - 1;

  // Текущие значения (шаг 15 мин) — если они ближе к when, чем ближайший час.
  const cur = obj(root['current']);
  const curMs = cur ? parse(cur['time']) : NaN;
  const useCur = !!cur && Math.abs(curMs - target) <= 1800_000 && Math.abs(curMs - target) < Math.abs(ms[near]! - target);
  const curHours = (num(cur?.['interval']) ?? 3600) / 3600;

  const speedUnit = (units: unknown) => SPEED_UNITS[String(obj(units)?.['wind_speed_10m'] ?? 'm/s')] ?? 1;
  const hourK = speedUnit(root['hourly_units']);
  const curK = speedUnit(root['current_units']);
  const row = (field: string, i: number) => {
    const a = hourly[field];
    return Array.isArray(a) ? num(a[i]) : undefined;
  };
  const inst = (field: string) => (useCur ? num(cur![field]) : undefined) ?? row(field, near);
  const speed = (field: string) => {
    const c = useCur ? num(cur![field]) : undefined;
    if (c !== undefined) return c * curK;
    const h = row(field, near);
    return h === undefined ? undefined : h * hourK;
  };
  /** Сумма за шаг → в час. */
  const rate = (field: string) => {
    const c = useCur ? num(cur![field]) : undefined;
    return c !== undefined ? c / curHours : row(field, sumAt);
  };

  const t = inst('temperature_2m');
  const v10 = speed('wind_speed_10m');
  const dir = inst('wind_direction_10m');
  if (t === undefined || v10 === undefined || dir === undefined) throw new Error('В ответе сервиса погоды нет ветра или температуры');
  const td = inst('dew_point_2m');
  const gust = speed('wind_gusts_10m');
  const shear = fitShear(v10, [
    [80, row('wind_speed_80m', near) !== undefined ? row('wind_speed_80m', near)! * hourK : undefined],
    [120, row('wind_speed_120m', near) !== undefined ? row('wind_speed_120m', near)! * hourK : undefined],
  ]);

  const coverPct = inst('cloud_cover');
  const lowPct = inst('cloud_cover_low');
  const cloudCover = coverPct === undefined ? undefined : clamp(coverPct / 100, 0, 1);
  let cloudBaseM: number | undefined;
  if (td !== undefined) {
    const lcl = LCL_M_PER_C * Math.max(0, t - td);
    // Низкие облака (или туман) есть — их граница у уровня конденсации; нет — облака, если есть, выше.
    cloudBaseM = Math.round(((lowPct ?? 0) >= 10 ? lcl : Math.max(lcl, MID_CLOUD_BASE_M)) / 10) * 10;
  }

  const code = useCur ? num(cur!['weather_code']) : row('weather_code', sumAt);
  const info = code === undefined ? undefined : CODES[code];
  const rainMm = (rate('rain') ?? 0) + (rate('showers') ?? 0);
  // Снег — сантиметры свежего снега; в воде 7 см ≈ 10 мм (так считает Open-Meteo).
  const snowMm = ((rate('snowfall') ?? 0) * 10) / 7;
  const totalMm = rate('precipitation') ?? rainMm + snowMm;
  let precipitation: Precipitation | null = null;
  if (totalMm >= 0.1 || info?.[1]) {
    const kind: Precipitation['kind'] =
      rainMm > 0.05 && snowMm > 0.05 ? 'sleet' : snowMm > 0.05 ? 'snow' : rainMm > 0.05 ? (info?.[1] === 'drizzle' ? 'drizzle' : 'rain') : (info?.[1] ?? 'rain');
    precipitation = { kind, mmPerH: totalMm >= 0.05 ? totalMm : (info?.[2] ?? 0.2) };
  }

  const visibilityM = inst('visibility');
  const weather: Weather = {
    groundTemperatureC: t,
    wind: { speedMs: v10, fromDeg: ((dir % 360) + 360) % 360 },
    windProfile: { referenceHeightM: 10, shearExponent: shear },
    precipitation,
  };
  if (gust !== undefined) {
    weather.gustMs = Math.max(gust, v10);
    // Порыв ≈ средний ветер + 2,5 СКО пульсаций.
    weather.turbulenceMs = clamp((gust - v10) / 2.5, 0, 4);
  }
  if (visibilityM !== undefined) weather.visibilityM = visibilityM;
  if (cloudCover !== undefined) weather.cloudCover = cloudCover;
  if (cloudBaseM !== undefined) weather.cloudBaseM = cloudBaseM;

  return { weather, summary: summarize(weather, td, info?.[0]), time: new Date(useCur ? curMs : ms[near]!), attribution: ATTRIBUTION };
}

function summarize(w: Weather, dewPointC: number | undefined, sky: string | undefined): string {
  const parts: string[] = [];
  if (sky) parts.push(sky[0]!.toUpperCase() + sky.slice(1));
  const from = w.wind.fromDeg;
  let wind = `ветер ${COMPASS[Math.round(from / 45) % 8]} (${fmt(from)}°) ${fmt(w.wind.speedMs, 1)} м/с`;
  if (w.gustMs !== undefined && w.gustMs > w.wind.speedMs + 0.5) wind += `, порывы до ${fmt(w.gustMs, 1)} м/с`;
  parts.push(wind);
  parts.push(`${signed(w.groundTemperatureC)} °C${dewPointC !== undefined ? `, точка росы ${signed(dewPointC)} °C` : ''}`);
  if (w.cloudCover !== undefined) {
    const pct = Math.round(w.cloudCover * 100);
    parts.push(pct >= 10 && w.cloudBaseM !== undefined ? `облачность ${pct} %, нижняя граница ≈ ${fmt(w.cloudBaseM)} м` : `облачность ${pct} %`);
  }
  const v = w.visibilityM;
  if (v !== undefined) parts.push(`видимость ${v < 1000 ? `${fmt(Math.round(v / 10) * 10)} м` : `${fmt(v / 1000, v < 10_000 ? 1 : 0)} км`}`);
  const p = w.precipitation;
  parts.push(p ? `осадки: ${PRECIPITATION_NAME[p.kind]} ${fmt(p.mmPerH, 1)} мм/ч` : 'без осадков');
  const s = parts.join('; ');
  return s[0]!.toUpperCase() + s.slice(1);
}
