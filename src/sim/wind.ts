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

/**
 * Показатель степенного профиля ветра при безразличной стратификации. Прогнозный ветер на 10 м —
 * над открытой ровной местностью (флюгер метеостанции), отсюда классический закон 1/7.
 */
export const NEUTRAL_SHEAR = 1 / 7;

/**
 * Показатель роста ветра с высотой по устойчивости воздуха. Днём прогретая Солнцем земля
 * перемешивает воздух — наверху ветер ненамного сильнее, чем у земли; ясной тихой ночью приземный
 * слой застаивается — наверху заметно сильнее. Облака гасят и прогрев, и выхолаживание, сильный
 * ветер перемешивает воздух сам — профиль ближе к безразличному.
 */
export function stabilityShear(sunElevationDeg: number, cloudCover: number, wind10Ms: number, neutral = NEUTRAL_SHEAR): number {
  const clear = 1 - Math.min(1, Math.max(0, cloudCover));
  const calm = 1 - Math.min(1, Math.max(0, (wind10Ms - 2) / 8));
  let k = 1;
  if (sunElevationDeg > 0) k -= 0.45 * Math.min(1, Math.sin(sunElevationDeg * RAD) / Math.sin(45 * RAD)) * (1 - 0.7 * (1 - clear)) * calm;
  else if (sunElevationDeg < -2) k += 0.9 * clear * calm;
  return neutral * k;
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
