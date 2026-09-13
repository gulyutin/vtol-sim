import type { GeoPoint } from './types';

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Высота над горизонтом, градусы. Отрицательная — Солнце под горизонтом. */
  elevationDeg: number;
  /** Азимут от севера по часовой, градусы. */
  azimuthDeg: number;
}

/**
 * Местное время, ч (0…24), по положению Солнца: часовой угол из высоты и азимута, затем
 * уравнение времени на дату, долгота и часовой пояс. Для часов в 3D — сцена получает только
 * Солнце. Точность — минута-другая; ночью тоже: часовой угол однозначен и под горизонтом.
 */
export function localHourFromSun(sun: SunPosition, p: GeoPoint, date: Date, utcOffsetH: number): number {
  const h = sun.elevationDeg * RAD;
  const a = sun.azimuthDeg * RAD;
  const lat = p.lat * RAD;
  // Часовой угол: к западу (после полудня) — положительный.
  const hourAngle = Math.atan2(-Math.sin(a) * Math.cos(h), Math.sin(h) * Math.cos(lat) - Math.cos(h) * Math.cos(a) * Math.sin(lat));
  const trueSolarMin = 720 + (hourAngle / RAD) * 4;
  // Уравнение времени, мин (приближение Спенсера — погрешность меньше минуты).
  const day = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000;
  const b = (2 * Math.PI * (day - 81)) / 364;
  const eqTimeMin = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const localMin = trueSolarMin - eqTimeMin - 4 * p.lon + 60 * utcOffsetH;
  return ((((localMin / 60) % 24) + 24) % 24);
}

/**
 * Положение Солнца по упрощённому алгоритму NOAA (точность ~0.1° для 1900–2100).
 * Без учёта рефракции.
 */
export function sunPosition(date: Date, p: GeoPoint): SunPosition {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));

  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin =
    4 *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD)) /
    RAD;
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarMin = (((utcMin + eqTimeMin + 4 * p.lon) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMin / 4 - 180) * RAD;

  const lat = p.lat * RAD;
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat));
  return { elevationDeg: 90 - zenith / RAD, azimuthDeg: (azimuth / RAD + 180 + 360) % 360 };
}
