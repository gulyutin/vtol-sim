import { distanceM, fromLocal, toLocal } from '../sim/mission';
import type { LocationSpec, RegionSpec, RoutePoint } from '../sim/profile';
import type { GeoPoint, Terrain } from '../sim/types';
import type { Recording, Sample } from './recorder';
import { LOG_REGION_ID } from './regions';

/*
 * Место полёта из бортового журнала как район заданий. Площадка — точка взлёта, область — вокруг
 * траектории, дата и час — как в журнале, ветер — оценка автопилота. «Облёт по маршруту» —
 * упрощённая траектория журнала с высотами над рельефом: тот же полёт можно повторить на модели
 * и сравнить с записью. Перелёт — в точку посадки, если сели не там, где взлетели. Без DOM.
 */

/** Запас области вокруг траектории, м. */
const MARGIN_M = 3000;
/** Сторона области не меньше, м. */
const MIN_SIZE_M = 8000;
/** Допуск упрощения траектории, м. */
const SIMPLIFY_M = 120;
/** Точек маршрута не больше. */
const MAX_POINTS = 24;
/** Точки ближе к площадке не берём: вылет и заход строит автопилот. */
const NEAR_SITE_M = 250;
/** Высота маршрута над рельефом не ниже, м. */
const MIN_HEIGHT_AGL_M = 60;
/** Сели дальше этого от точки взлёта — перелёт в точку посадки, м. */
const LANDED_ELSEWHERE_M = 300;

/** Самолётные режимы записи: по ним строится маршрут. */
const PLANE = new Set(['auto', 'guided', 'manual', 'hold', 'rtl']);
const AIRBORNE_NOT = new Set(['ground', 'spool', 'landed', 'crashed']);

interface P {
  e: number;
  n: number;
  up: number;
}

function segDist(p: P, a: P, b: P): number {
  const dx = b.e - a.e;
  const dy = b.n - a.n;
  const L2 = dx * dx + dy * dy;
  const k = L2 > 0 ? Math.min(1, Math.max(0, ((p.e - a.e) * dx + (p.n - a.n) * dy) / L2)) : 0;
  return Math.hypot(p.e - a.e - k * dx, p.n - a.n - k * dy);
}

/** Дуглас — Пекер: индексы оставленных точек. */
function simplify(pts: P[], tol: number): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let best = -1;
    let bestD = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist(pts[i]!, pts[i0]!, pts[i1]!);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  return [...keep.keys()].filter((i) => keep[i]);
}

/** Упрощённая траектория: допуск растёт, пока точек больше MAX_POINTS. */
function routeOf(pts: P[]): P[] {
  let tol = SIMPLIFY_M;
  let idx = simplify(pts, tol);
  while (idx.length > MAX_POINTS) idx = simplify(pts, (tol *= 1.5));
  return idx.map((i) => pts[i]!);
}

/** Где был аппарат: точки отсчётов в метрах от точки взлёта. */
const pointOf = (s: Sample): P => ({ e: s.east, n: s.north, up: s.up });

/**
 * Район по записи бортового журнала (meta.origin обязателен). terrain — рельеф вокруг траектории,
 * если уже загружен: по нему высоты маршрута пересчитываются над рельефом; без него — над точкой взлёта.
 */
export function regionFromRecording(rec: Recording, terrain?: Terrain): RegionSpec {
  const origin = rec.meta.origin;
  if (!origin) throw new Error('В записи нет места полёта');
  const s = rec.samples;
  if (!s.length) throw new Error('В записи нет отсчётов');
  const geo = (p: P): GeoPoint => fromLocal(origin, p.e, p.n);

  // Область: вся траектория с запасом, не меньше MIN_SIZE_M по каждой стороне.
  let e0 = 0;
  let e1 = 0;
  let n0 = 0;
  let n1 = 0;
  for (const x of s) {
    e0 = Math.min(e0, x.east);
    e1 = Math.max(e1, x.east);
    n0 = Math.min(n0, x.north);
    n1 = Math.max(n1, x.north);
  }
  const grow = (a: number, b: number): [number, number] => {
    const half = Math.max(MIN_SIZE_M / 2, (b - a) / 2 + MARGIN_M);
    const c = (a + b) / 2;
    return [c - half, c + half];
  };
  [e0, e1] = grow(e0, e1);
  [n0, n1] = grow(n0, n1);
  const sw = fromLocal(origin, e0, n0);
  const ne = fromLocal(origin, e1, n1);

  // Маршрут — самолётная часть полёта, без точек у самой площадки.
  const plane = s.filter((x) => PLANE.has(x.mode)).map(pointOf);
  const farFromSite = (p: P) => Math.hypot(p.e, p.n) > NEAR_SITE_M;
  const originElev = terrain?.elevationM(origin);
  const routePoint = (p: P): RoutePoint => {
    const g = geo(p);
    const over = originElev !== undefined && terrain ? p.up + originElev - terrain.elevationM(g) : p.up;
    return { lat: round6(g.lat), lon: round6(g.lon), heightAglM: Math.max(MIN_HEIGHT_AGL_M, Math.round(over / 10) * 10) };
  };
  let route = routeOf(plane).filter(farFromSite).map(routePoint);
  // Самолётом не летали (висение, короткий подлёт) — хотя бы дальняя точка полёта.
  const far = s.reduce((a, x) => (Math.hypot(x.east, x.north) > Math.hypot(a.east, a.north) ? x : a), s[0]!);
  const farP = pointOf(far);
  if (!route.length && farFromSite(farP)) route = [routePoint({ ...farP, up: Math.max(farP.up, 100) })];

  // Посадка: последняя точка записи.
  // Полёт кончился аварией — место падения не пункт Б.
  const last = s[s.length - 1]!;
  const landing = geo(pointOf(last));
  const landedElsewhere = last.mode !== 'crashed' && distanceM(origin, landing) > LANDED_ELSEWHERE_M;
  const farGeo = farFromSite(farP) ? geo(farP) : fromLocal(origin, 0, 2000);
  const destination = landedElsewhere ? landing : farGeo;

  // Время: взлёт по журналу. Часовой пояс — по долготе: для Солнца важно время UTC, пояс — для подписей.
  const utcOffsetH = Math.round(origin.lon / 15);
  const takeoff = s.find((x) => !AIRBORNE_NOT.has(x.mode)) ?? s[0]!;
  const start = Date.parse(rec.meta.startedAt);
  const local = new Date((Number.isNaN(start) ? Date.now() : start) + (utcOffsetH * 3600 + takeoff.t) * 1000);
  const date = local.toISOString().slice(0, 10);
  const localHour = Math.round((local.getUTCHours() + local.getUTCMinutes() / 60) * 4) / 4;
  const wind = rec.meta.wind ?? { speedMs: 3, fromDeg: 270 };
  const flownKm = s.reduce((acc, x, i) => (i ? acc + Math.hypot(x.east - s[i - 1]!.east, x.north - s[i - 1]!.north) : 0), 0) / 1000;

  // Съёмка — участок 800 × 500 м на трети пути к дальней точке.
  const c = geo({ e: (farP.e || 0) / 3, n: (farP.n || 2000) / 3, up: 0 });
  const dLat = 250 / 111_320;
  const dLon = 400 / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  const area: GeoPoint[] = [
    { lat: c.lat - dLat, lon: c.lon - dLon },
    { lat: c.lat + dLat, lon: c.lon - dLon },
    { lat: c.lat + dLat, lon: c.lon + dLon },
    { lat: c.lat - dLat, lon: c.lon + dLon },
  ].map((p) => ({ lat: round6(p.lat), lon: round6(p.lon) }));

  const stamp = `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)} ${String(Math.floor(localHour)).padStart(2, '0')}:${String(Math.round((localHour % 1) * 60)).padStart(2, '0')}`;
  const location: LocationSpec = {
    regionName: `Место полёта из журнала ${stamp}`,
    site: { lat: round6(origin.lat), lon: round6(origin.lon) },
    siteName: 'точка взлёта из журнала',
    region: { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon },
    date,
    utcOffsetH,
    localHour,
    windSpeedMs: Math.round(wind.speedMs * 2) / 2,
    windFromDeg: Math.round(wind.fromDeg),
    temperatureC: 15,
    route: {
      briefing: `Повтор полёта из бортового журнала: маршрут — упрощённая траектория журнала (${route.length} точек), высоты над рельефом — как в журнале. Взлёт и посадка — в точке взлёта журнала. Пройдите его на модели и сравните с записью в разборе.`,
      route,
    },
    transfer: {
      title: 'Перелёт А → Б',
      briefing: landedElsewhere
        ? 'Перелёт как в журнале: взлёт в точке взлёта (А), посадка там, где сел аппарат (Б), промежуточные точки — по траектории журнала.'
        : 'Перелёт из точки взлёта журнала (А) в дальнюю точку полёта (Б). Точку Б можно перетащить на карте.',
      destination,
      destinationName: landedElsewhere ? 'точка посадки из журнала' : 'дальняя точка полёта',
      route: landedElsewhere ? route : [],
    },
    delivery: {
      title: 'Доставка к дальней точке полёта',
      briefing: 'Отвезти груз из точки взлёта журнала в дальнюю точку полёта, сесть, разгрузиться и вернуться.',
      destination: farGeo,
      destinationName: 'дальняя точка полёта',
      route: [],
    },
    survey: {
      title: 'Аэрофотосъёмка участка',
      briefing: 'Ортофотоплан участка 0,8 × 0,5 км у траектории журнала штатной камерой. Нужно GSD не хуже 4 см и не меньше 5 годных кадров на 95 % участка.',
      area,
    },
  };
  return {
    id: LOG_REGION_ID,
    title: `Место полёта ${stamp}`,
    hint: `Из бортового журнала: ${Math.round(flownKm)} км полёта, взлёт на ${originElev !== undefined ? `${Math.round(originElev)} м` : 'высоте журнала'}`,
    location,
  };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Запись с местом полёта — в координаты другой площадки: сдвиг по горизонтали от site до точки
 * взлёта записи и по высоте на upShiftM (разность рельефа). Записи без места не меняются.
 */
export function placeRecording(rec: Recording, site: GeoPoint, upShiftM: number): Recording {
  const origin = rec.meta.origin;
  if (!origin) return rec;
  const d = toLocal(site, origin);
  return {
    ...rec,
    meta: { ...rec.meta, origin: site },
    samples: rec.samples.map((x) => ({ ...x, east: x.east + d.east, north: x.north + d.north, up: x.up + upShiftM })),
  };
}

const ON_GROUND = new Set(['ground', 'spool', 'landed', 'crashed']);

/**
 * Высоты записи журнала — к рельефу сцены. Высота в журнале — по баро и ГНСС от точки взлёта: за
 * полёт она уходит на метры, а земля в точке посадки не той высоты, что в точке взлёта, — без
 * поправки аппарат в повторе стоит под землёй. На земле отсчёт ставится на рельеф; в воздухе
 * поправка идёт линейно от последней на земле до отрыва к первой после касания, и ниже рельефа
 * аппарат не опускается.
 */
export function settleOnTerrain(rec: Recording, groundAt: (east: number, north: number) => number): Recording {
  const s = rec.samples;
  const n = s.length;
  const ground = s.map((x) => groundAt(x.east, x.north));
  const onGround = s.map((x) => ON_GROUND.has(x.mode));
  // Ближайшие отсчёты на земле до и после каждого.
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0, p = -1; i < n; i++) prev[i] = onGround[i] ? (p = i) : p;
  for (let i = n - 1, q = -1; i >= 0; i--) next[i] = onGround[i] ? (q = i) : q;
  const fix = (i: number) => ground[i]! - s[i]!.up;
  const samples = s.map((x, i) => {
    let up = ground[i]!;
    if (!onGround[i]) {
      const a = prev[i]!;
      const b = next[i]!;
      const fa = a >= 0 ? fix(a) : b >= 0 ? fix(b) : 0;
      const fb = b >= 0 ? fix(b) : fa;
      const k = a >= 0 && b >= 0 ? (x.t - s[a]!.t) / Math.max(1e-6, s[b]!.t - s[a]!.t) : 0;
      up = Math.max(ground[i]!, x.up + fa + (fb - fa) * k);
    }
    return up === x.up ? x : { ...x, up };
  });
  return { ...rec, samples };
}

/** Точка внутри области района. */
export const inBounds = (b: { south: number; west: number; north: number; east: number }, p: GeoPoint): boolean =>
  p.lat > b.south && p.lat < b.north && p.lon > b.west && p.lon < b.east;
