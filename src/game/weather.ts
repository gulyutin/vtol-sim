import { AIRCRAFT } from '../sim/aircraft';
import type { Weather } from '../sim/types';

export type Precipitation = NonNullable<Weather['precipitation']>;

/** Названия осадков для сводок и предполётных проверок. */
export const PRECIPITATION_NAME: Record<Precipitation['kind'], string> = {
  drizzle: 'морось',
  rain: 'дождь',
  sleet: 'мокрый снег',
  snow: 'снег',
};

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Около нуля снег и дождь переходят друг в друга через мокрый снег. Дождь в мороз остаётся дождём — ледяным. */
function phaseAt(kind: Precipitation['kind'], temperatureC: number): Precipitation['kind'] {
  if (kind === 'snow' && temperatureC > 2) return 'sleet';
  if (kind === 'sleet') return temperatureC > 4 ? 'rain' : temperatureC < -2 ? 'snow' : 'sleet';
  return kind;
}

/**
 * Фактическая погода по прогнозу. Ошибки — типичные для прогноза на сутки:
 * ветер на 10 м ±1.5 м/с и ±20° (СКО), температура ±1.5 °C. Один seed — один «день».
 * Порывы, турбулентность, видимость, осадки и облака возмущаются, только если они есть в прогнозе.
 */
export function actualWeather(forecast: Weather, seed: number): Weather {
  const r = rng(seed);
  const speed = Math.max(0, forecast.wind.speedMs + 1.5 * normal(r));
  const from = (((forecast.wind.fromDeg + 20 * normal(r)) % 360) + 360) % 360;
  const temperature = forecast.groundTemperatureC + 1.5 * normal(r);
  // Случайные числа тянем всегда в одном порядке: тот же seed даёт тот же ветер
  // и температуру, есть в прогнозе остальные поля или нет.
  const nGust = normal(r);
  const nTurb = normal(r);
  const nVis = normal(r);
  const nRate = normal(r);
  const uRain = r();
  const nCover = normal(r);
  const nBase = normal(r);

  const out: Weather = { ...forecast, groundTemperatureC: temperature, wind: { speedMs: speed, fromDeg: from } };
  if (forecast.gustMs !== undefined) {
    // Прибавка порывов к среднему ветру ошибается в разы меньше, чем сами порывы: ±25 % логнормально.
    const excess = Math.max(0, forecast.gustMs - forecast.wind.speedMs);
    out.gustMs = speed + excess * Math.exp(0.25 * nGust);
  }
  if (forecast.turbulenceMs !== undefined) {
    // Механическая турбулентность растёт вместе с ветром.
    out.turbulenceMs = forecast.turbulenceMs * Math.exp(0.3 * nTurb) * ((speed + 1) / (forecast.wind.speedMs + 1));
  }
  if (forecast.visibilityM !== undefined) out.visibilityM = Math.max(50, forecast.visibilityM * Math.exp(0.35 * nVis));
  const p = forecast.precipitation;
  if (p) {
    // Осадки прогноз ошибается и по времени: примерно каждый седьмой раз их не будет вовсе.
    out.precipitation = uRain < 0.15 ? null : { kind: phaseAt(p.kind, temperature), mmPerH: p.mmPerH * Math.exp(0.5 * nRate) };
  } else if (p === null && (forecast.cloudCover ?? 0) >= 0.7 && uRain < 0.1) {
    // Сплошная облачность «без осадков» иногда всё же сыплет — слабо.
    const kind = temperature <= -1 ? 'snow' : temperature < 2 ? 'sleet' : 'drizzle';
    out.precipitation = { kind, mmPerH: 0.3 * Math.exp(0.5 * nRate) };
  }
  if (forecast.cloudCover !== undefined) out.cloudCover = clamp(forecast.cloudCover + 0.15 * nCover, 0, 1);
  if (forecast.cloudBaseM !== undefined) out.cloudBaseM = Math.max(30, forecast.cloudBaseM * Math.exp(0.2 * nBase));
  return out;
}

export type WeatherPresetKind = 'calm' | 'breezy' | 'gusty' | 'rain' | 'snow' | 'fog' | 'lowcloud' | 'storm';

/**
 * Погода заданной сложности (экзамен). Направление ветра и его профиль — из base; скорость ветра —
 * из вида погоды или base (дождь, снег, низкая облачность). Пороги — от ограничений аппарата:
 * «тихо», «свежо», «порывисто» проходят предполётные проверки (порывисто — у самого предела),
 * дождь, снег, туман, низкая облачность и гроза — нет, как требует РЛЭ.
 */
export function weatherPreset(kind: WeatherPresetKind, base: Weather): Weather {
  const L = AIRCRAFT.limits;
  const t = base.groundTemperatureC;
  const v = base.wind.speedMs;
  const make = (speedMs: number, gustMs: number, rest: Omit<Weather, 'wind' | 'gustMs'> & Partial<Pick<Weather, 'groundTemperatureC'>>): Weather => ({
    ...base,
    wind: { speedMs, fromDeg: base.wind.fromDeg },
    gustMs,
    ...rest,
  });
  switch (kind) {
    case 'calm':
      return make(1.5, 3, { groundTemperatureC: t, turbulenceMs: 0.3, visibilityM: 30_000, precipitation: null, cloudCover: 0.1, cloudBaseM: Math.max(base.cloudBaseM ?? 0, 2500) });
    case 'breezy': {
      const w = 0.6 * L.windMaxMs;
      return make(w, w + 3.5, { groundTemperatureC: t, turbulenceMs: 1.2, visibilityM: 20_000, precipitation: null, cloudCover: 0.4, cloudBaseM: 1500 });
    }
    case 'gusty':
      return make(0.75 * L.windMaxMs, 0.93 * L.gustMaxMs, { groundTemperatureC: t, turbulenceMs: 2.5, visibilityM: 15_000, precipitation: null, cloudCover: 0.6, cloudBaseM: 1200 });
    case 'rain':
      // Дождь — значит у земли тепло; иначе это был бы мокрый снег.
      return make(v, v + 4, { groundTemperatureC: Math.max(t, 4), turbulenceMs: 1.2, visibilityM: 5000, precipitation: { kind: 'rain', mmPerH: 3 }, cloudCover: 1, cloudBaseM: 600 });
    case 'snow':
      return make(v, v + 3, { groundTemperatureC: Math.min(t, -4), turbulenceMs: 1, visibilityM: 1500, precipitation: { kind: 'snow', mmPerH: 1.2 }, cloudCover: 1, cloudBaseM: 400 });
    case 'fog': {
      const w = Math.min(v, 1.5);
      return make(w, w + 1, { groundTemperatureC: t, turbulenceMs: 0.2, visibilityM: 400, precipitation: null, cloudCover: 1, cloudBaseM: 60 });
    }
    case 'lowcloud':
      return make(v, v + 3, { groundTemperatureC: t, turbulenceMs: 0.8, visibilityM: 7000, precipitation: null, cloudCover: 0.95, cloudBaseM: 0.6 * L.minCloudBaseM });
    case 'storm':
      return make(1.4 * L.windMaxMs, 1.5 * L.gustMaxMs, {
        groundTemperatureC: t,
        turbulenceMs: 4,
        visibilityM: 2500,
        precipitation: { kind: t > 1 ? 'rain' : 'snow', mmPerH: 12 },
        cloudCover: 1,
        cloudBaseM: 500,
      });
  }
}

/**
 * Дальности линейной дымки (THREE.Fog) по метеорологической видимости. Видимость — расстояние,
 * на котором контраст падает до 5 %; у линейной дымки со smoothstep это ≈ 0,86 пути от near к far,
 * отсюда far ≈ 1,15·V и near ≈ 0,12·V. При хорошей видимости (или неизвестной) — обычная дымка 4 / 34 км.
 */
export function fogFor(visibilityM: number | undefined): { near: number; far: number } {
  if (visibilityM === undefined || !Number.isFinite(visibilityM)) return { near: 4000, far: 34_000 };
  const v = Math.max(50, visibilityM);
  return { near: Math.min(4000, 0.12 * v), far: Math.min(34_000, 1.15 * v) };
}

/**
 * Насколько пасмурно, 0…1: 0 — ясно, Солнце в полную силу; 1 — Солнца не видно, небо ровное серое.
 * Для приглушения неба, Солнца и теней. Осадки идут из сплошных облаков, туман закрывает небо сам.
 */
export function overcastFactor(w: Weather): number {
  let f = 0.85 * clamp(w.cloudCover ?? 0, 0, 1) ** 1.5;
  const p = w.precipitation;
  if (p) f = Math.max(f, 0.75 + 0.25 * Math.min(1, p.mmPerH / 6));
  if (w.visibilityM !== undefined) f = Math.max(f, 0.95 * (1 - smoothstep(w.visibilityM, 800, 10_000)));
  return clamp(f, 0, 1);
}
