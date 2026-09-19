/*
 * Линейка на карте: расстояние и азимут между точками, профиль рельефа и прямая видимость между
 * антеннами с учётом кривизны Земли и рефракции (эквивалентный радиус k = 4/3). Без DOM.
 */

export interface GeoPt {
  lat: number;
  lon: number;
}

const R = 6_371_000;
const RAD = Math.PI / 180;

/** Расстояние по большому кругу, м. */
export function distanceM(a: GeoPt, b: GeoPt): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Азимут из a на b, ° от севера по часовой. */
export function bearingDeg(a: GeoPt, b: GeoPt): number {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return ((Math.atan2(y, x) / RAD) % 360 + 360) % 360;
}

export interface ProfilePoint {
  /** От начала линии, м. */
  d: number;
  /** Высота рельефа, м. */
  h: number;
}

/** Профиль рельефа по линии: n + 1 точек через равные доли (достаточно для коротких линий — без геодезической интерполяции). */
export function lineProfile(a: GeoPt, b: GeoPt, elevation: (p: GeoPt) => number, n = 200): ProfilePoint[] {
  const len = distanceM(a, b);
  const out: ProfilePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    out.push({ d: len * f, h: elevation({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }) });
  }
  return out;
}

export interface Sight {
  /** Видимость есть: луч выше рельефа везде. */
  clear: boolean;
  /** Наименьший запас луча над рельефом (с кривизной), м; меньше нуля — перекрыт. */
  clearanceM: number;
  /** Где наименьший запас, м от начала. */
  worstD: number;
}

/**
 * Прямая видимость между антенной на hA м над рельефом в начале и hB м над рельефом в конце.
 * Земля «поднимается» к середине трассы на d1·d2 / (2·k·R) — эквивалентный радиус k = 4/3.
 */
export function lineOfSight(p: readonly ProfilePoint[], hA: number, hB: number, k = 4 / 3): Sight {
  const first = p[0]!;
  const last = p[p.length - 1]!;
  const za = first.h + hA;
  const zb = last.h + hB;
  const L = last.d || 1;
  let clearanceM = Infinity;
  let worstD = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const q = p[i]!;
    const bulge = (q.d * (L - q.d)) / (2 * k * R);
    const ray = za + ((zb - za) * q.d) / L;
    const c = ray - (q.h + bulge);
    if (c < clearanceM) {
      clearanceM = c;
      worstD = q.d;
    }
  }
  if (!Number.isFinite(clearanceM)) clearanceM = Math.min(za, zb);
  return { clear: clearanceM > 0, clearanceM, worstD };
}
