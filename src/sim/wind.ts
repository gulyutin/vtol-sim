import type { Weather, Wind } from './types';

const RAD = Math.PI / 180;

export interface WindTriangle {
  /** Угол сноса, градусы. Положительный — нос вправо от линии пути. */
  driftDeg: number;
  groundSpeedMs: number;
}

/**
 * Навигационный треугольник скоростей для сегмента с путевым углом ψ.
 *   δ  = asin(Vw · sin(φ − ψ) / V)
 *   Vg = V · cos δ − Vw · cos(φ − ψ)
 * φ — откуда дует ветер. Возвращает null, если сегмент непроходим:
 * боковая составляющая ветра не меньше воздушной скорости или путевая ≤ 0.
 */
export function windTriangle(airspeedMs: number, trackDeg: number, wind: Wind): WindTriangle | null {
  const rel = (wind.fromDeg - trackDeg) * RAD;
  const s = (wind.speedMs * Math.sin(rel)) / airspeedMs;
  if (Math.abs(s) >= 1) return null;
  const drift = Math.asin(s);
  const groundSpeedMs = airspeedMs * Math.cos(drift) - wind.speedMs * Math.cos(rel);
  if (groundSpeedMs <= 0) return null;
  return { driftDeg: drift / RAD, groundSpeedMs };
}

/** Ветер на высоте heightAglM над землёй. Ниже 2 м профиль не продолжается. */
export function windAt(weather: Weather, heightAglM: number): Wind {
  const profile = weather.windProfile;
  if (!profile) return weather.wind;
  const k = (Math.max(2, heightAglM) / profile.referenceHeightM) ** profile.shearExponent;
  return { speedMs: weather.wind.speedMs * k, fromDeg: weather.wind.fromDeg };
}

/** Расход на километр пути, Вт·ч/км. */
export function energyPerKmWh(powerW: number, groundSpeedMs: number): number {
  return powerW / (groundSpeedMs * 3.6);
}
