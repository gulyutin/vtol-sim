import type { Weather } from '../sim/types';

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

/**
 * Фактическая погода по прогнозу. Ошибки — типичные для прогноза на сутки:
 * ветер на 10 м ±1.5 м/с и ±20° (СКО), температура ±1.5 °C. Один seed — один «день».
 */
export function actualWeather(forecast: Weather, seed: number): Weather {
  const r = rng(seed);
  const speed = Math.max(0, forecast.wind.speedMs + 1.5 * normal(r));
  const from = (((forecast.wind.fromDeg + 20 * normal(r)) % 360) + 360) % 360;
  return {
    ...forecast,
    groundTemperatureC: forecast.groundTemperatureC + 1.5 * normal(r),
    wind: { speedMs: speed, fromDeg: from },
  };
}
