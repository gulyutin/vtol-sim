import type { GeoPoint, Terrain, Waypoint } from './types';

const RAD = Math.PI / 180;

/** Координата точки в пикселях мировой карты Web Mercator на уровне zoom (тайл 256 px). */
export function mercatorPixel(p: GeoPoint, zoom: number): { x: number; y: number } {
  const n = 256 * 2 ** zoom;
  const lat = Math.max(-85.05, Math.min(85.05, p.lat)) * RAD;
  return {
    x: ((p.lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

/** Обратное к mercatorPixel. */
export function mercatorToGeo(x: number, y: number, zoom: number): GeoPoint {
  const n = 256 * 2 ** zoom;
  const m = Math.PI * (1 - (2 * y) / n);
  return { lat: Math.atan(Math.sinh(m)) / RAD, lon: (x / n) * 360 - 180 };
}

/**
 * Рельеф из сетки высот в проекции Web Mercator (как тайлы Terrarium).
 * Пиксель (x0 + i, y0 + j) на уровне zoom хранится в heights[j * width + i].
 * Высота между узлами — билинейно, за краем сетки — по краю.
 */
export class GridTerrain implements Terrain {
  constructor(
    readonly heights: Float32Array,
    readonly width: number,
    readonly height: number,
    readonly zoom: number,
    readonly x0: number,
    readonly y0: number,
  ) {
    if (heights.length !== width * height) throw new Error('Размер сетки не совпадает с данными');
  }

  elevationM(p: GeoPoint): number {
    const px = mercatorPixel(p, this.zoom);
    // Значение пикселя относится к его центру.
    const fx = Math.min(this.width - 1, Math.max(0, px.x - this.x0 - 0.5));
    const fy = Math.min(this.height - 1, Math.max(0, px.y - this.y0 - 0.5));
    const i = Math.min(this.width - 2, Math.floor(fx));
    const j = Math.min(this.height - 2, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const h = this.heights;
    const w = this.width;
    const top = h[j * w + i]! * (1 - u) + h[j * w + i + 1]! * u;
    const bottom = h[(j + 1) * w + i]! * (1 - u) + h[(j + 1) * w + i + 1]! * u;
    return top * (1 - v) + bottom * v;
  }
}

export interface TerrainFollowing {
  /**
   * Высота над рельефом, которую держит автопилот, м: одна на весь маршрут или по участкам —
   * функция номера участка и доли пути по нему 0…1.
   */
  heightAglM: number | ((leg: number, f: number) => number);
  /** Путевая скорость на участке с путевым углом trackDeg — для перевода Vz в градиент. */
  groundSpeedMs(trackDeg: number): number;
  /** Шаг выборки рельефа, м. */
  stepM?: number;
  /**
   * Если в маршрут вставлены развороты (roundSharpCorners): к какому исходному участку относится
   * каждый отрезок points[k]→points[k+1] и какую долю его пути занимает.
   */
  parts?: { leg: number; f0: number; f1: number }[];
}

const EARTH_RADIUS_M = 6371000;

function distanceM(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Точка профиля: место, участок и доля участка, путь от начала; набор и снижение — м высоты на метр пути. */
type RouteSample = GeoPoint & { leg: number; f: number; d: number; climb: number; descent: number };

function sampleRoute(points: GeoPoint[], climbRateMs: number, descentRateMs: number, o: TerrainFollowing): RouteSample[] {
  const step = o.stepM ?? 100;
  const samples: RouteSample[] = [];
  let d = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!;
    const b = points[k]!;
    const len = distanceM(a, b);
    const gs = Math.max(1, o.groundSpeedMs(bearingDeg(a, b)));
    const n = Math.max(1, Math.ceil(len / step));
    const part = o.parts?.[k - 1] ?? { leg: k - 1, f0: 0, f1: 1 };
    if (k === 1) samples.push({ ...a, leg: part.leg, f: part.f0, d: 0, climb: climbRateMs / gs, descent: descentRateMs / gs });
    for (let j = 1; j <= n; j++) {
      const f = j / n;
      samples.push({
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        leg: part.leg,
        f: part.f0 + (part.f1 - part.f0) * f,
        d: d + len * f,
        climb: climbRateMs / gs,
        descent: descentRateMs / gs,
      });
    }
    d += len;
  }
  return samples;
}

/**
 * Высоты концов профиля с огибанием рельефа, м над морем. Если рельеф сразу за площадкой взлёта
 * поднимается быстрее предельного набора (или перед площадкой посадки — быстрее предельного
 * снижения), профиль followTerrain прошёл бы ниже рельефа. Тогда переход в самолётный режим
 * выше: вертикальный набор (снижение) на роторах длиннее — но не больше maxExtraM сверх
 * startAltitudeM и endAltitudeM; остальное покажет проверка запаса высоты в simulateMission.
 */
export function terrainEndAltitudes(
  points: GeoPoint[],
  terrain: Terrain,
  startAltitudeM: number,
  endAltitudeM: number,
  climbRateMs: number,
  descentRateMs: number,
  o: TerrainFollowing,
  clearanceM: number,
  maxExtraM: number,
): { startAltitudeM: number; endAltitudeM: number } {
  const samples = sampleRoute(points, climbRateMs, descentRateMs, o);
  const last = samples.length - 1;
  if (last < 2) return { startAltitudeM, endAltitudeM };
  const dd = (i: number) => samples[i + 1]!.d - samples[i]!.d;
  const req = (i: number) => terrain.elevationM(samples[i]!) + clearanceM;
  // Наименьшая высота в точке i, с которой набором не круче предельного проходим над всеми следующими.
  let start = -Infinity;
  for (let i = last - 1; i >= 1; i--) start = Math.max(req(i), start - samples[i + 1]!.climb * dd(i));
  start -= samples[1]!.climb * dd(0);
  // То же к площадке посадки — со снижением не круче предельного.
  let end = -Infinity;
  for (let i = 1; i <= last - 1; i++) end = Math.max(req(i), end - samples[i]!.descent * dd(i - 1));
  end -= samples[last]!.descent * dd(last - 1);
  return {
    startAltitudeM: Math.min(startAltitudeM + maxExtraM, Math.max(startAltitudeM, start)),
    endAltitudeM: Math.min(endAltitudeM + maxExtraM, Math.max(endAltitudeM, end)),
  };
}

/**
 * Профиль полёта с огибанием рельефа — так летает автопилот: держит заданную высоту над землёй,
 * а не над уровнем моря. points — маршрут в плане от площадки взлёта
 * до площадки посадки. Высота на первом и последнем пункте — startAltitudeM и endAltitudeM.
 *
 * Набор и снижение ограничены предельной вертикальной скоростью, поэтому перед высоким
 * рельефом набор начинается заранее. Где рельеф круче возможного, профиль проходит ниже
 * заданной высоты — это покажет проверка запаса высоты в simulateMission.
 * Возвращает промежуточные точки без первого и последнего пункта.
 */
export function followTerrain(
  points: GeoPoint[],
  terrain: Terrain,
  startAltitudeM: number,
  endAltitudeM: number,
  climbRateMs: number,
  descentRateMs: number,
  o: TerrainFollowing,
): Waypoint[] {
  const samples = sampleRoute(points, climbRateMs, descentRateMs, o);
  const last = samples.length - 1;
  const height = (s: { leg: number; f: number }) => (typeof o.heightAglM === 'number' ? o.heightAglM : o.heightAglM(s.leg, s.f));
  const alt = samples.map((s, i) => (i === 0 ? startAltitudeM : i === last ? endAltitudeM : terrain.elevationM(s) + height(s)));
  const dd = (i: number) => samples[i + 1]!.d - samples[i]!.d;
  // Набор заранее перед подъёмом рельефа.
  for (let i = last - 1; i >= 0; i--) alt[i] = Math.max(alt[i]!, alt[i + 1]! - samples[i + 1]!.climb * dd(i));
  // Снижение не круче предельного.
  for (let i = 1; i <= last; i++) alt[i] = Math.max(alt[i]!, alt[i - 1]! - samples[i]!.descent * dd(i - 1));
  // От высоты перехода над площадкой взлёта — не круче предельного набора.
  alt[0] = startAltitudeM;
  for (let i = 1; i <= last; i++) alt[i] = Math.min(alt[i]!, alt[i - 1]! + samples[i]!.climb * dd(i - 1));
  // К высоте обратного перехода над площадкой посадки — не круче предельного снижения.
  alt[last] = endAltitudeM;
  for (let i = last - 1; i >= 0; i--) alt[i] = Math.min(alt[i]!, alt[i + 1]! + samples[i + 1]!.descent * dd(i));

  return samples.slice(1, -1).map((s, i) => ({ lat: s.lat, lon: s.lon, altitudeM: alt[i + 1]!, routeLeg: s.leg }));
}

/** Метка «нет данных» в сетке высот (тайл не загрузился). */
export const NO_DATA = -9000;

/**
 * Пустоты в данных высот (в тайлах Terrarium встречаются над водой: −5…90 м там, где рядом
 * 140 м) заполняются от соседей. Пустота — ниже 2-го процентиля всех высот больше чем на dropM
 * или не выше NO_DATA.
 * Возвращает число заполненных клеток.
 */
export function fillVoids(heights: Float32Array, width: number, height: number, dropM = 40): number {
  const stride = Math.max(1, Math.floor(heights.length / 200_000));
  const sample: number[] = [];
  // NO_DATA (незагруженный тайл) — пустота всегда и в порог не входит.
  for (let i = 0; i < heights.length; i += stride) if (heights[i]! > NO_DATA) sample.push(heights[i]!);
  sample.sort((a, b) => a - b);
  const floor = (sample[Math.floor(sample.length * 0.02)] ?? 0) - dropM;
  const bad = new Uint8Array(heights.length);
  let left = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i]! < floor || heights[i]! <= NO_DATA) {
      bad[i] = 1;
      left++;
    }
  }
  const filled = left;
  // Заполняем снаружи внутрь: клетка получает среднее годных соседей.
  for (let pass = 0; left > 0 && pass < 500; pass++) {
    const done: number[] = [];
    for (let i = 0; i < heights.length; i++) {
      if (!bad[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < width && yy < height && !bad[yy * width + xx]) {
            sum += heights[yy * width + xx]!;
            n++;
          }
        }
      }
      if (n > 0) {
        heights[i] = sum / n;
        done.push(i);
      }
    }
    for (const i of done) bad[i] = 0;
    left -= done.length;
    if (done.length === 0) break;
  }
  return filled;
}

/** Ровная местность на одной высоте. */
export function flatTerrain(elevationM: number): Terrain {
  return { elevationM: () => elevationM };
}
