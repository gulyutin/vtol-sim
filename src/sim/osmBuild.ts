import type { GeoPoint } from './types';

/*
 * Сборка osm.bin (формат — src/sim/osm.ts) из ответов Overpass API: дома, трубы, башни и мачты,
 * леса, взлётные полосы, дороги, вода и реки. Общая часть для scripts/fetch-osm.mjs (Node: файл
 * района) и src/ui/placeOsm.ts (браузер: место полёта из журнала). Здесь нет ни node:*, ни DOM:
 * сеть и кэш даёт вызывающий — функция OverpassQuery (для неё — createOverpass с повторами).
 * Node запускает файл напрямую, снимая типы, поэтому TypeScript здесь только стираемый: без enum,
 * namespace и импортов значений из других модулей (только import type).
 *
 * Координаты — локальные метры относительно площадки (восток, север), как toLocal в
 * src/sim/mission.ts. Области запросов:
 *  - без траектории — как всегда: дома в радиусе buildingsRadiusM от площадки (квадраты до 14 км),
 *    полосы — в области; леса, дороги и вода — в области с запасом 3 км, как рельеф
 *    (expandBounds(region, 3000) в src/ui/terrainData.ts), квадратами 2 × 2, 3 × 3 и 2 × 2;
 *    реки — одним запросом по области с запасом;
 *  - с траекторией (track: площадка, точки маршрута, пункт назначения) — коридор: область с
 *    запасом делится на клетки; леса, дороги, вода и реки запрашиваются только по клеткам не
 *    дальше CORRIDOR.fieldsBufferM от траектории, дома, трубы и мачты — по клеткам не дальше
 *    CORRIDOR.buildingsBufferM и, как без траектории, в радиусе buildingsRadiusM от площадки.
 *    Длинное узкое место полёта (перелёт на десятки километров) так не тянет леса и дороги всего
 *    прямоугольника. Режутся ответы по-прежнему по области с запасом.
 */

export const OVERPASS_ENDPOINTS: readonly string[] = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
/** Версия сборки: меняется — кэш браузера (src/ui/placeOsm.ts) собирает заново. */
export const OSM_BUILD_VERSION = 1;

const R = 6371000;
const RAD = Math.PI / 180;
/** Дома — в этом радиусе от площадки, м (--buildings-radius). */
export const BUILDINGS_RADIUS_DEFAULT_M = 14000;
/** Выше — ошибка в теге: у самых высоких зданий и труб меньше. */
const MAX_HEIGHT_M = 500;
/** Леса, дороги и вода — в области, расширенной на столько, м (как рельеф). */
const MARGIN_M = 3000;

/**
 * Коридор вокруг траектории, м. Клетка — точность отбора; блок — наибольшая сторона одного
 * запроса: в блоке запрашивается охват выбранных клеток. Блоки — порядка прежних квадратов
 * запросов района: ответ по густому месту не упирается в тайм-аут сервера.
 */
export const CORRIDOR = {
  fieldsBufferM: 6000,
  fieldsCellM: 2000,
  forestsBlockM: 20000,
  waterBlockM: 20000,
  roadsBlockM: 15000,
  buildingsBufferM: 3000,
  buildingsCellM: 1000,
  buildingsBlockM: 14000,
  /** Упрощение траектории перед отбором: тысячи точек журнала ни к чему. */
  trackTolM: 50,
} as const;

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Поправка по id OSM: высота или {height, roof, kind, levels} (--heights). */
export type HeightOverride = number | { height?: number | string; roof?: string; kind?: string; levels?: number | string };

export interface OsmBuildOptions {
  /** Площадка — начало локальных координат. */
  site: GeoPoint;
  /** Область места (без запаса: запас 3 км для лесов, дорог и воды добавляется здесь). */
  bounds: GeoBounds;
  /** Траектория — ломаная; есть — леса, дороги, вода и дома только в коридоре вокруг неё. */
  track?: readonly GeoPoint[];
  /** Мелкие постройки kind=other меньше этой площади, м², отбрасываются (не знаковые). */
  minBuildingArea?: number;
  /** Радиус домов от площадки, м. */
  buildingsRadiusM?: number;
  /** Поправки по id OSM: «w123», «n45», «r6». */
  overrides?: Readonly<Record<string, HeightOverride>>;
}

export interface OverpassPoint {
  lat: number;
  lon: number;
}
export interface OverpassMember {
  type: string;
  role?: string;
  geometry?: (OverpassPoint | null)[];
}
/** Элемент ответа Overpass «out geom». */
export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Readonly<Record<string, string>>;
  geometry?: (OverpassPoint | null)[];
  members?: OverpassMember[];
}
/** Запрос Overpass QL → элементы; label — подпись для хода работы и имени файла кэша. */
export type OverpassQuery = (query: string, label: string) => Promise<OverpassElement[]>;
export type OsmProgress = (done: number, total: number, label: string) => void;

/** Прямоугольник в локальных метрах: [восток0, север0, восток1, север1]. */
export type Rect = [number, number, number, number];

export type OsmJobKind = 'buildings' | 'structures' | 'forests' | 'runways' | 'roads' | 'water' | 'waterways';
export interface OsmJob {
  kind: OsmJobKind;
  label: string;
  query: string;
  /** Прямоугольник запроса, м. */
  rect: Rect;
}
export interface OsmPlan {
  corridor: boolean;
  /** Все запросы — в порядке выполнения. */
  jobs: OsmJob[];
  /** Область с запасом, м: по ней режутся леса, дороги и вода. */
  area: Rect;
}

// Записи в дециметрах — как в файле.
interface BuildingRec {
  kind: number;
  heightDm: number;
  levels: number;
  roof: number;
  ring: number[];
}
interface ForestRec {
  leaf: number;
  rings: number[][];
}
interface RunwayRec {
  widthDm: number;
  paved: number;
  line: number[];
}
interface RoadRec {
  cls: number;
  flags: number;
  widthDm: number;
  line: number[];
}
interface WaterRec {
  kind: number;
  rings: number[][];
}
interface WaterwayRec {
  kind: number;
  widthDm: number;
  line: number[];
}
export interface OsmBuildData {
  buildings: BuildingRec[];
  forests: ForestRec[];
  runways: RunwayRec[];
  roads: RoadRec[];
  water: WaterRec[];
  waterways: WaterwayRec[];
}
export interface OsmBuildStats {
  /** Отброшено мелких построек (--min-building-area). */
  dropped: number;
  landmarks: number;
  /** Труб, башен и мачт, не обведённых как здания. */
  structures: number;
  roadsDropped: number;
  /** Отрезков рек внутри площадей воды. */
  inside: number;
}

type Tags = Readonly<Record<string, string>>;
interface Override {
  height?: unknown;
  roof?: unknown;
  kind?: unknown;
  levels?: unknown;
}
interface Polygon {
  outer: number[];
  holes: number[][];
}

/** Своё (не унаследованное) значение словаря по строковому ключу. */
function own<T>(obj: Readonly<Record<string, T>>, k: unknown): T | undefined {
  return typeof k === 'string' && Object.hasOwn(obj, k) ? obj[k] : undefined;
}

// --- Overpass: повторы и вежливость ---

export interface OverpassResponse {
  status: number;
  json(): Promise<unknown>;
}
export interface OverpassTransport {
  /** POST тела body (data=…) на адрес; тайм-аут и отмена — здесь. */
  post(url: string, body: string): Promise<OverpassResponse>;
  sleep(ms: number): Promise<void>;
  warn?(message: string): void;
  /** Отменено — ошибку не повторять. */
  aborted?(): boolean;
  /** Пауза между запросами, мс (по умолчанию 3000). */
  pauseMs?: number;
  /** Попыток на запрос (по умолчанию 7). */
  attempts?: number;
}

const hostOf = (url: string) => /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url;

/**
 * Запросы Overpass по очереди: пауза между ними (у публичного сервера ограничение на частоту),
 * серверы по кругу, на 429 и 5xx — повтор с растущим ожиданием, на прочие 4xx — ошибка.
 */
export function createOverpass(t: OverpassTransport): OverpassQuery {
  let requests = 0;
  const warn = (m: string) => t.warn?.(m);
  return async (query, label) => {
    // Между запросами — пауза: у публичного сервера ограничение на частоту.
    if (requests++ > 0) await t.sleep(t.pauseMs ?? 3000);
    const attempts = t.attempts ?? 7;
    let wait = 8000;
    for (let i = 0; i < attempts; i++) {
      const url = OVERPASS_ENDPOINTS[i % OVERPASS_ENDPOINTS.length]!;
      const host = hostOf(url);
      try {
        const res = await t.post(url, 'data=' + encodeURIComponent(query));
        if (res.status >= 200 && res.status < 300) {
          const json = (await res.json()) as { remark?: unknown; elements?: OverpassElement[] };
          // Тайм-аут или нехватка памяти на сервере приходят с кодом 200 и пометкой remark.
          if (typeof json.remark === 'string' && /runtime error|timed out|out of memory/i.test(json.remark)) {
            warn(`  ${label}: ${host} — ошибка выполнения запроса, повтор`);
          } else {
            return json.elements ?? [];
          }
        } else if (res.status === 429 || res.status >= 500) {
          warn(`  ${label}: ${host} — HTTP ${res.status}, повтор`);
          if (res.status === 429) wait = Math.max(wait, 30000);
        } else {
          throw new Error(`${label}: ${host} — HTTP ${res.status}`);
        }
      } catch (err) {
        if (t.aborted?.()) throw err;
        if (err instanceof Error && /HTTP 4\d\d/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
        warn(`  ${label}: ${host} — ${err instanceof Error ? err.name : 'ошибка'}, повтор`);
      }
      if (i < attempts - 1) {
        await t.sleep(wait);
        wait = Math.min(wait * 2, 90000);
      }
    }
    throw new Error(`${label}: Overpass не ответил после ${attempts} попыток`);
  };
}

// --- геометрия ---

/** Ориентированная площадь кольца [e0,n0,e1,n1,…] (без повтора первой точки), м², > 0 — против часовой. */
function signedArea(r: ArrayLike<number>): number {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j]! * r[2 * i + 1]! - r[2 * i]! * r[2 * j + 1]!;
  return s / 2;
}
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}
/** Дуглас — Пекер для открытой ломаной, отмечает оставленные точки. */
function dpMark(pts: ArrayLike<number>, i0: number, i1: number, tol2: number, keep: Uint8Array): void {
  const stack: [number, number][] = [[i0, i1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[2 * i]!, pts[2 * i + 1]!, pts[2 * a]!, pts[2 * a + 1]!, pts[2 * b]!, pts[2 * b + 1]!);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
}
/** Упрощение замкнутого кольца: делим в точке, самой далёкой от первой. */
function simplifyRing(r: number[], tol: number): number[] {
  const n = r.length / 2;
  if (n <= 3) return r;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[2 * i]! - r[0]!) ** 2 + (r[2 * i + 1]! - r[1]!) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const pts = new Float64Array(2 * (n + 1));
  pts.set(r);
  pts[2 * n] = r[0]!;
  pts[2 * n + 1] = r[1]!;
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  dpMark(pts, 0, far, tol * tol, keep);
  dpMark(pts, far, n, tol * tol, keep);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i]!, r[2 * i + 1]!);
  return out;
}
/** Упрощение открытой ломаной. */
function simplifyLine(r: number[], tol: number): number[] {
  const n = r.length / 2;
  if (n <= 2) return r;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  dpMark(r, 0, n - 1, tol * tol, keep);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i]!, r[2 * i + 1]!);
  return out;
}
/** Округление до дециметров и удаление подряд идущих совпадений. */
function quantize(r: ArrayLike<number>, closed: boolean): number[] {
  const out: number[] = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const e = Math.round(r[2 * i]! * 10);
    const nn = Math.round(r[2 * i + 1]! * 10);
    const k = out.length;
    if (k && out[k - 2] === e && out[k - 1] === nn) continue;
    out.push(e, nn);
  }
  if (closed) while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}
/** Длина ломаной в дм-координатах, м. */
export function lineLengthDm(q: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i + 3 < q.length; i += 2) s += Math.hypot(q[i + 2]! - q[i]!, q[i + 3]! - q[i + 1]!);
  return s / 10;
}
/** Отсечение кольца полуплоскостью a·e + b·n ≤ c (Сазерленд — Ходжмен). */
function clipHalf(r: number[], a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pe = r[2 * i]!, pn = r[2 * i + 1]!, qe = r[2 * j]!, qn = r[2 * j + 1]!;
    const fp = a * pe + b * pn - c;
    const fq = a * qe + b * qn - c;
    if (fp <= 0) out.push(pe, pn);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push(pe + t * (qe - pe), pn + t * (qn - pn));
    }
  }
  return out;
}
function clipRect(r: number[], e0: number, n0: number, e1: number, n1: number): number[] {
  let o = clipHalf(r, -1, 0, -e0);
  o = clipHalf(o, 1, 0, e1);
  o = clipHalf(o, 0, -1, -n0);
  return clipHalf(o, 0, 1, n1);
}
/** Отрезок AB и прямоугольник по Ляну — Барски: [t0, t1] внутри или null. */
function clipSeg(ax: number, ay: number, bx: number, by: number, e0: number, n0: number, e1: number, n1: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  let ok = true;
  for (const [p, q] of [[-dx, ax - e0], [dx, e1 - ax], [-dy, ay - n0], [dy, n1 - ay]] as const) {
    if (p === 0) {
      if (q < 0) ok = false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return !ok || t0 > t1 ? null : [t0, t1];
}
/** Отсечение ломаной прямоугольником (Лян — Барски по отрезкам) → куски внутри. */
function clipLineRect(r: number[], e0: number, n0: number, e1: number, n1: number): number[][] {
  const runs: number[][] = [];
  let cur: number[] | null = null;
  const n = r.length / 2;
  for (let i = 0; i + 1 < n; i++) {
    const ax = r[2 * i]!, ay = r[2 * i + 1]!, bx = r[2 * i + 2]!, by = r[2 * i + 3]!;
    const dx = bx - ax, dy = by - ay;
    const tt = clipSeg(ax, ay, bx, by, e0, n0, e1, n1);
    if (!tt) {
      cur = null;
      continue;
    }
    const [t0, t1] = tt;
    const sx = ax + dx * t0, sy = ay + dy * t0, ex = ax + dx * t1, ey = ay + dy * t1;
    if (!cur || t0 > 0) {
      cur = [sx, sy];
      runs.push(cur);
    }
    cur.push(ex, ey);
    if (t1 < 1) cur = null;
  }
  return runs.filter((c) => c.length >= 4);
}
function pointInRing(px: number, py: number, r: ArrayLike<number>): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i]!, yi = r[2 * i + 1]!, xj = r[2 * j]!, yj = r[2 * j + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ccw(r: number[]): number[] {
  if (signedArea(r) >= 0) return r;
  const out: number[] = [];
  for (let i = r.length / 2 - 1; i >= 0; i--) out.push(r[2 * i]!, r[2 * i + 1]!);
  return out;
}
const parseNum = (s: unknown): number => {
  if (s == null) return NaN;
  const str = String(s).replace(',', '.').trim();
  const v = parseFloat(str);
  if (!Number.isFinite(v)) return NaN;
  return /ft|'/.test(str) ? v * 0.3048 : v;
};
const samePt = (a: OverpassPoint, b: OverpassPoint) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;

// --- коридор ---

/** Квадрат расстояния от прямоугольника до отрезка AB, м²; пересекает или внутри — 0. */
function rectSegDist2(c: Rect, ax: number, ay: number, bx: number, by: number): number {
  const [e0, n0, e1, n1] = c;
  if (clipSeg(ax, ay, bx, by, e0, n0, e1, n1)) return 0;
  // Не пересекаются — ближе всего конец отрезка к прямоугольнику или угол к отрезку.
  const toRect = (x: number, y: number) => (x - Math.max(e0, Math.min(e1, x))) ** 2 + (y - Math.max(n0, Math.min(n1, y))) ** 2;
  return Math.min(toRect(ax, ay), toRect(bx, by), segDist2(e0, n0, ax, ay, bx, by), segDist2(e1, n0, ax, ay, bx, by), segDist2(e0, n1, ax, ay, bx, by), segDist2(e1, n1, ax, ay, bx, by));
}
/** Расстояние от прямоугольника до ломаной [e0,n0,e1,n1,…], м; одна точка — до точки. */
export function rectTrackDist(c: Rect, track: ArrayLike<number>): number {
  const k = track.length / 2;
  if (k < 1) return Infinity;
  let best = Infinity;
  for (let i = 0; i === 0 || i + 1 < k; i++) {
    const j = Math.min(i + 1, k - 1);
    best = Math.min(best, rectSegDist2(c, track[2 * i]!, track[2 * i + 1]!, track[2 * j]!, track[2 * j + 1]!));
  }
  return Math.sqrt(best);
}
/** Расстояние от точки до ломаной, м. */
export function pointTrackDist(e: number, n: number, track: ArrayLike<number>): number {
  const k = track.length / 2;
  if (k < 1) return Infinity;
  let best = Infinity;
  for (let i = 0; i === 0 || i + 1 < k; i++) {
    const j = Math.min(i + 1, k - 1);
    best = Math.min(best, segDist2(e, n, track[2 * i]!, track[2 * i + 1]!, track[2 * j]!, track[2 * j + 1]!));
  }
  return Math.sqrt(best);
}

export interface CorridorSpec {
  bufferM: number;
  cellM: number;
  blockM: number;
}
/**
 * Прямоугольники запросов коридора: область делится на клетки около cellM; клетка выбрана, если
 * до ломаной track не дальше bufferM (и skip её не исключает). Клетки группируются в блоки около
 * blockM по стороне (поровну по области); в блоке — охват его выбранных клеток. Порядок — рядами
 * с юга на север, в ряду с запада на восток.
 */
export function corridorRects(area: Rect, track: ArrayLike<number>, spec: CorridorSpec, skip?: (cell: Rect) => boolean): Rect[] {
  const [e0, n0, e1, n1] = area;
  const nx = Math.max(1, Math.ceil((e1 - e0) / spec.cellM));
  const ny = Math.max(1, Math.ceil((n1 - n0) / spec.cellM));
  const cw = (e1 - e0) / nx;
  const ch = (n1 - n0) / ny;
  const cell = (i: number, j: number): Rect => [e0 + cw * i, n0 + ch * j, e0 + cw * (i + 1), n0 + ch * (j + 1)];
  const sel = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cell(i, j);
      if (rectTrackDist(c, track) <= spec.bufferM && !skip?.(c)) sel[j * nx + i] = 1;
    }
  }
  const mx = Math.min(nx, Math.max(1, Math.round((e1 - e0) / spec.blockM)));
  const my = Math.min(ny, Math.max(1, Math.round((n1 - n0) / spec.blockM)));
  const out: Rect[] = [];
  for (let bj = 0; bj < my; bj++) {
    for (let bi = 0; bi < mx; bi++) {
      let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
      for (let j = Math.floor((bj * ny) / my); j < Math.floor(((bj + 1) * ny) / my); j++) {
        for (let i = Math.floor((bi * nx) / mx); i < Math.floor(((bi + 1) * nx) / mx); i++) {
          if (!sel[j * nx + i]) continue;
          i0 = Math.min(i0, i);
          i1 = Math.max(i1, i);
          j0 = Math.min(j0, j);
          j1 = Math.max(j1, j);
        }
      }
      if (i1 >= 0) {
        const a = cell(i0, j0);
        const b = cell(i1, j1);
        out.push([a[0], a[1], b[2], b[3]]);
      }
    }
  }
  // Соседние охваты — одним запросом, если вместе не больше блока и почти без лишней площади:
  // узкий коридор на стыке блоков не дробится на полоски.
  const cap = spec.blockM * spec.blockM;
  const areaOf = (c: Rect) => (c[2] - c[0]) * (c[3] - c[1]);
  for (let merged = true; merged; ) {
    merged = false;
    for (let a = 0; a < out.length && !merged; a++) {
      for (let b = a + 1; b < out.length && !merged; b++) {
        const p = out[a]!;
        const q = out[b]!;
        const u: Rect = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];
        if (areaOf(u) <= cap && areaOf(u) <= 1.2 * (areaOf(p) + areaOf(q))) {
          out[a] = u;
          out.splice(b, 1);
          merged = true;
        }
      }
    }
  }
  return out.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
}

// --- классы и таблицы ---

const KIND: Readonly<Record<string, number>> = { house: 0, apartments: 1, industrial: 2, other: 3 };
const HOUSE = new Set(['house', 'detached', 'residential', 'semidetached_house', 'terrace', 'bungalow', 'cabin']);
const APARTMENTS = new Set(['apartments', 'dormitory']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'commercial', 'retail', 'office', 'hangar', 'farm_auxiliary', 'barn']);
const SMALL = new Set(['garage', 'garages', 'shed', 'roof', 'hut']);
/** roof:shape → код формы крыши (src/sim/osm.ts ROOF_SHAPES). */
const ROOF: Readonly<Record<string, number>> = { flat: 1, gabled: 2, saltbox: 2, gambrel: 2, mansard: 2, 'half-hipped': 3, hipped: 3, pyramidal: 4, dome: 4, onion: 4, cone: 4, round: 2, skillion: 5, lean_to: 5 };
/** Храмы: building=* или amenity=place_of_worship. */
const WORSHIP = new Set(['cathedral', 'church', 'chapel', 'mosque', 'synagogue', 'temple', 'shrine', 'monastery', 'bell_tower']);
const isWorship = (tags: Tags) => WORSHIP.has(tags.building ?? '') || tags.amenity === 'place_of_worship';
/** Знаковое: узнаётся с воздуха по силуэту — не отбрасывается по площади и упрощается мягче. */
function isLandmark(tags: Tags): boolean {
  return (
    isWorship(tags) ||
    tags.tourism === 'attraction' ||
    (!!tags.historic && tags.historic !== 'no') ||
    /^(tower|mast|chimney)$/.test(tags.man_made ?? '') ||
    parseNum(tags.height) >= 50 ||
    parseNum(tags['building:levels']) >= 16
  );
}
function buildingKind(tags: Tags, area: number, ov: Override | null) {
  const b = tags.building ?? '';
  let kind: string;
  let h: number;
  // Высота до карниза без тегов: частный дом — одноэтажный (так чаще всего в посёлках).
  if (HOUSE.has(b)) [kind, h] = ['house', 4.5];
  else if (APARTMENTS.has(b)) [kind, h] = ['apartments', 15];
  else if (INDUSTRIAL.has(b)) [kind, h] = ['industrial', 8];
  else if (SMALL.has(b)) [kind, h] = ['other', 3];
  // Храм без высоты: часовня ниже, собор выше.
  else if (isWorship(tags)) [kind, h] = ['other', b === 'cathedral' ? 25 : b === 'chapel' ? 8 : 14];
  else if (tags.man_made === 'chimney' || tags['tower:type'] === 'cooling') [kind, h] = ['industrial', 40];
  else if (tags.man_made === 'tower' || tags.man_made === 'mast') [kind, h] = ['other', 25];
  else [kind, h] = area < 250 ? ['house', 4.5] : ['other', 6];
  const height = parseNum(tags.height);
  const roofHeight = parseNum(tags['roof:height']);
  const ovLevels = Number(ov?.levels);
  const levelsTag = ovLevels > 0 ? ovLevels : parseNum(tags['building:levels']);
  const levels = levelsTag > 0 ? Math.min(60, Math.round(levelsTag)) : 0;
  // height — до верха крыши, в файле — до карниза.
  if (height > 0) h = roofHeight > 0 && roofHeight < height ? height - roofHeight : height;
  else if (levels > 0) h = levels * 3 + 1;
  const ovHeight = Number(ov?.height);
  if (ovHeight > 0) h = ovHeight;
  if (own(KIND, ov?.kind) !== undefined) kind = ov!.kind as string;
  let roof = own(ROOF, ov?.roof ?? tags['roof:shape']) ?? 0;
  // Купол или шпиль небольшого храма без roof:shape — шатром.
  if (!roof && isWorship(tags) && area < 1500) roof = ROOF.pyramidal!;
  return { kind, height: Math.min(MAX_HEIGHT_M, Math.max(2, h)), levels, roof };
}

/** Трубы, башни и мачты, не обведённые как здания: высота без тега и поперечник точки, м. Мачта — тонкая, у высокой трубы — широкое основание. */
const STRUCTURE: Readonly<Record<string, { kind: string; height: number; diameter: (h: number) => number }>> = {
  chimney: { kind: 'industrial', height: 40, diameter: (h) => (h >= 150 ? 16 : h >= 60 ? 8 : 4) },
  tower: { kind: 'other', height: 25, diameter: () => 8 },
  mast: { kind: 'other', height: 30, diameter: () => 2.5 },
};

/** Класс (src/sim/osm.ts ROAD_CLASSES) и ширина по умолчанию, м. */
const HIGHWAY: Readonly<Record<string, readonly [number, number]>> = {
  motorway: [0, 10], motorway_link: [0, 5],
  trunk: [1, 9], trunk_link: [1, 5],
  primary: [2, 8], primary_link: [2, 5],
  secondary: [3, 7], secondary_link: [3, 5],
  tertiary: [4, 5], tertiary_link: [4, 5],
  unclassified: [5, 5], road: [5, 5],
  residential: [6, 5], living_street: [6, 4],
  service: [7, 3],
  track: [8, 3],
};
const RAILWAY: Readonly<Record<string, number>> = { rail: 4, narrow_gauge: 3, light_rail: 3.5, tram: 3 };
const PAVED = new Set(['asphalt', 'concrete', 'paved', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'chipseal']);
const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'ground', 'earth', 'grass', 'sand', 'compacted', 'mud', 'pebblestone', 'woodchips', 'rock', 'grass_paver', 'dirt/sand', 'clay']);
/** Служебные проезды, которых слишком много и которые с высоты не видны. */
const SERVICE_SKIP = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);

const WATERWAY: Readonly<Record<string, readonly [number, number]>> = { river: [0, 10], stream: [1, 3], canal: [2, 6] };
function waterKind(t: Tags): number {
  if (t.waterway === 'riverbank' || ['river', 'canal', 'stream', 'oxbow', 'rapids'].includes(t.water ?? '')) return 1;
  if (t.landuse === 'reservoir' || t.water === 'reservoir') return 2;
  if (t.landuse === 'basin' || ['wastewater', 'basin', 'lagoon'].includes(t.water ?? '')) return 3;
  return 0;
}
/** Площадь воды — те же условия, что в запросе воды. */
function isWaterArea(el: OverpassElement): boolean {
  const t = el.tags ?? {};
  if (!(el.type === 'way' || (el.type === 'relation' && t.type === 'multipolygon'))) return false;
  return t.natural === 'water' || t.waterway === 'riverbank' || /^(reservoir|basin)$/.test(t.landuse ?? '');
}
/** Осевая реки — те же условия, что в запросе рек. */
const isWaterwayLine = (el: OverpassElement) => el.type === 'way' && /^(river|stream|canal)$/.test(el.tags?.waterway ?? '');

/** Ось и ширина полосы, нарисованной площадью: длинная сторона наименьшего описанного прямоугольника. */
function axisOfArea(r: number[]): { line: number[]; width: number } | null {
  const n = r.length / 2;
  let best: { area: number; ax: number; ay: number; u0: number; u1: number; v0: number; v1: number } | null = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = r[2 * j]! - r[2 * i]!;
    const dy = r[2 * j + 1]! - r[2 * i + 1]!;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ax = dx / len, ay = dy / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = r[2 * k]! * ax + r[2 * k + 1]! * ay;
      const v = -r[2 * k]! * ay + r[2 * k + 1]! * ax;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ax, ay, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ax, ay, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) {
    // Длинная сторона поперёк выбранного ребра — меняем оси.
    [ax, ay] = [-ay, ax];
    [u0, u1, v0, v1] = [v0, v1, -u1, -u0];
  }
  const vm = (v0 + v1) / 2;
  const pt = (u: number) => [u * ax - vm * ay, u * ay + vm * ax];
  return { line: [...pt(u0), ...pt(u1)], width: v1 - v0 };
}

/** Индекс площадей воды по клеткам: точка внутри — true. */
function waterIndex(water: readonly WaterRec[]): (e: number, n: number) => boolean {
  const CELL = 500;
  const grid = new Map<string, number[]>();
  const polys = water.map((w) => {
    const rings = w.rings.map((r) => r.map((v) => v / 10));
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    const o = rings[0]!;
    for (let i = 0; i < o.length; i += 2) {
      e0 = Math.min(e0, o[i]!); e1 = Math.max(e1, o[i]!);
      n0 = Math.min(n0, o[i + 1]!); n1 = Math.max(n1, o[i + 1]!);
    }
    return { rings, e0, n0, e1, n1 };
  });
  polys.forEach((p, k) => {
    for (let j = Math.floor(p.n0 / CELL); j <= Math.floor(p.n1 / CELL); j++) {
      for (let i = Math.floor(p.e0 / CELL); i <= Math.floor(p.e1 / CELL); i++) {
        const key = `${i},${j}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(k);
      }
    }
  });
  return (e, n) => {
    for (const k of grid.get(`${Math.floor(e / CELL)},${Math.floor(n / CELL)}`) ?? []) {
      const p = polys[k]!;
      if (e < p.e0 || e > p.e1 || n < p.n0 || n > p.n1) continue;
      let inside = false;
      for (const r of p.rings) if (pointInRing(e, n, r)) inside = !inside;
      if (inside) return true;
    }
    return false;
  };
}

// --- место: проекция, запросы, разбор ответов ---

function place(opts: OsmBuildOptions) {
  const lat0 = opts.site.lat;
  const lon0 = opts.site.lon;
  const { south, west, north, east } = opts.bounds;
  if (!(south < north && west < east)) throw new Error('Область места: нужно south < north и west < east');
  const r = opts.buildingsRadiusM ?? BUILDINGS_RADIUS_DEFAULT_M;
  if (!(r > 0)) throw new Error('Радиус домов: ожидается число метров');
  const minBuildingArea = opts.minBuildingArea ?? 0;
  const overrides = opts.overrides ?? {};
  const cosLat0 = Math.cos(lat0 * RAD);

  /** Как toLocal: восток, север, м. */
  const toLocal = (lat: number, lon: number): [number, number] => [(lon - lon0) * RAD * R * cosLat0, (lat - lat0) * RAD * R];
  /** Прямоугольник вокруг площадки в локальных метрах → строка bbox Overpass. */
  const bboxLocal = (e0: number, n0: number, e1: number, n1: number): string => {
    const s = lat0 + n0 / R / RAD;
    const nn = lat0 + n1 / R / RAD;
    const w = lon0 + e0 / (R * cosLat0) / RAD;
    const e = lon0 + e1 / (R * cosLat0) / RAD;
    return `${s.toFixed(6)},${w.toFixed(6)},${nn.toFixed(6)},${e.toFixed(6)}`;
  };
  /** Область места в локальных метрах — для полос. */
  const region: Rect = [...toLocal(south, west), ...toLocal(north, east)];
  /** Область с запасом — та же формула, что у expandBounds для рельефа. */
  const dLat = MARGIN_M / 111_195;
  const dLon = MARGIN_M / (111_195 * Math.cos((((south + north) / 2) * Math.PI) / 180));
  const area: Rect = [...toLocal(south - dLat, west - dLon), ...toLocal(north + dLat, east + dLon)];
  const [AREA_E0, AREA_N0, AREA_E1, AREA_N1] = area;

  /** Прямоугольник, разрезанный на k × k частей. */
  const tiles = ([e0, n0, e1, n1]: Rect, k: number): Rect[] => {
    const out: Rect[] = [];
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) out.push([e0 + ((e1 - e0) * i) / k, n0 + ((n1 - n0) * j) / k, e0 + ((e1 - e0) * (i + 1)) / k, n0 + ((n1 - n0) * (j + 1)) / k]);
    }
    return out;
  };

  // Траектория в локальных метрах, упрощённая; нет — прежние области.
  const rawTrack = opts.track ?? [];
  const track = rawTrack.length ? simplifyLine(rawTrack.flatMap((p) => toLocal(p.lat, p.lon)), CORRIDOR.trackTolM) : null;
  /** Дом вне радиуса от площадки остаётся, если у траектории. */
  const nearTrack = track ? (e: number, n: number) => pointTrackDist(e, n, track) <= CORRIDOR.buildingsBufferM : () => false;

  // --- запросы ---
  const jobs: OsmJob[] = [];
  /** Запросы по прямоугольникам; подпись — «дома 2/4» (по ней же имя файла кэша у scripts/fetch-osm.mjs). */
  const add = (kind: OsmJobKind, label: string, rects: readonly Rect[], query: (bb: string) => string, numbered = true) =>
    rects.forEach((rect, p) => jobs.push({ kind, label: numbered ? `${label} ${p + 1}/${rects.length}` : label, query: query(bboxLocal(...rect)), rect }));

  // Дома — квадраты со стороной до 14 км (при радиусе 14 км — четыре квадранта): меньше нагрузка
  // на сервер за один запрос, и ответ по большому городу не упирается в тайм-аут.
  // Маленький радиус (место полёта) — одним квадратом: четыре крошечных запроса только дольше ждать.
  const k = r <= 7000 ? 1 : 2 * Math.ceil(r / 14000);
  const step = (2 * r) / k;
  const buildingRects: Rect[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) buildingRects.push([-r + i * step, -r + j * step, -r + (i + 1) * step, -r + (j + 1) * step]);
  if (track) {
    // Коридор: клетки, целиком лежащие в квадрате вокруг площадки, уже запрошены.
    const inSite = (c: Rect) => c[0] >= -r && c[2] <= r && c[1] >= -r && c[3] <= r;
    buildingRects.push(...corridorRects(area, track, { bufferM: CORRIDOR.buildingsBufferM, cellM: CORRIDOR.buildingsCellM, blockM: CORRIDOR.buildingsBlockM }, inSite));
  }
  add('buildings', 'дома', buildingRects, (bb) => `[out:json][timeout:180];(way["building"]["building"!="no"](${bb});relation["building"]["building"!="no"]["type"="multipolygon"](${bb}););out geom;`);
  // Трубы, башни и мачты — по охвату областей домов.
  const hull: Rect = track
    ? buildingRects.reduce<Rect>((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])], [-r, -r, r, r])
    : [-r, -r, r, r];
  add('structures', 'сооружения', [hull], (bb) => `[out:json][timeout:180];nwr["man_made"~"^(chimney|tower|mast)$"](${bb});out geom;`, false);
  // Леса и вода — квадратами 2 × 2 области с запасом, без повторов на стыках: ответ по всей области
  // с лесами или водой большого района не укладывается в тайм-аут сервера. Геометрия у элемента
  // полная, режется по всей области потом — итог тот же, что одним запросом.
  const fields = (blockM: number) => corridorRects(area, track!, { bufferM: CORRIDOR.fieldsBufferM, cellM: CORRIDOR.fieldsCellM, blockM });
  add('forests', 'леса', track ? fields(CORRIDOR.forestsBlockM) : tiles(area, 2), (bb) =>
    `[out:json][timeout:180];(` +
    `way["landuse"="forest"](${bb});way["natural"="wood"](${bb});` +
    `relation["landuse"="forest"]["type"="multipolygon"](${bb});relation["natural"="wood"]["type"="multipolygon"](${bb});` +
    `);out geom;`,
  );
  add('runways', 'полосы', [region], (bb) => `[out:json][timeout:180];way["aeroway"="runway"](${bb});out geom;`, false);
  const hw = Object.keys(HIGHWAY).join('|');
  const rw = Object.keys(RAILWAY).join('|');
  add('roads', 'дороги', track ? fields(CORRIDOR.roadsBlockM) : tiles(area, 3), (bb) => `[out:json][timeout:180];(way["highway"~"^(${hw})$"](${bb});way["railway"~"^(${rw})$"](${bb}););out tags geom;`);
  // В коридоре реки — в том же запросе, что площади воды: запросов вдвое меньше.
  add('water', 'вода', track ? fields(CORRIDOR.waterBlockM) : tiles(area, 2), (bb) =>
    `[out:json][timeout:240];(` +
    `way["natural"="water"](${bb});relation["natural"="water"]["type"="multipolygon"](${bb});` +
    `way["waterway"="riverbank"](${bb});relation["waterway"="riverbank"]["type"="multipolygon"](${bb});` +
    `way["landuse"~"^(reservoir|basin)$"](${bb});relation["landuse"~"^(reservoir|basin)$"]["type"="multipolygon"](${bb});` +
    (track ? `way["waterway"~"^(river|stream|canal)$"](${bb});` : '') +
    // Не «out tags geom»: без тела у мультиполигона нет членов — реки площадями пропадали бы.
    `);out geom;`,
  );
  if (!track) add('waterways', 'реки', [area], (bb) => `[out:json][timeout:180];way["waterway"~"^(river|stream|canal)$"](${bb});out tags geom;`, false);
  const plan: OsmPlan = { corridor: !!track, jobs, area };

  // --- разбор ---
  /** geometry Overpass [{lat, lon}] → [e, n, …]; замкнутость отдельно. */
  function geomToLocal(geom: readonly (OverpassPoint | null)[]): number[] {
    const out: number[] = [];
    for (const g of geom) {
      if (!g) continue;
      const [e, n] = toLocal(g.lat, g.lon);
      out.push(e, n);
    }
    return out;
  }
  /** Кольцо из замкнутой линии без повтора первой точки, или null. */
  function closedRing(geom: (OverpassPoint | null)[] | undefined): number[] | null {
    if (!geom || geom.length < 4 || !samePt(geom[0]!, geom[geom.length - 1]!)) return null;
    return geomToLocal(geom.slice(0, -1));
  }
  /** Сборка колец мультиполигона из линий-членов: стыкуем концы. */
  function assembleRings(ways: (OverpassPoint | null)[][]): number[][] {
    const pool = ways.filter((g) => g && g.length >= 2 && g.every(Boolean)).map((g) => g.slice() as OverpassPoint[]);
    const rings: number[][] = [];
    while (pool.length) {
      let cur = pool.pop()!;
      let guard = 0;
      while (!samePt(cur[0]!, cur[cur.length - 1]!) && guard++ < 100000) {
        const end = cur[cur.length - 1]!;
        let idx = pool.findIndex((g) => samePt(g[0]!, end) || samePt(g[g.length - 1]!, end));
        if (idx < 0) {
          // Начало тоже может стыковаться — переворачиваем текущую и пробуем с другого конца.
          const start = cur[0]!;
          idx = pool.findIndex((g) => samePt(g[0]!, start) || samePt(g[g.length - 1]!, start));
          if (idx < 0) break;
          cur.reverse();
          continue;
        }
        let next = pool.splice(idx, 1)[0]!;
        if (!samePt(next[0]!, end)) next = next.reverse();
        cur = cur.concat(next.slice(1));
      }
      // Незамкнутое кольцо — замыкаем как есть, если в нём достаточно точек.
      if (!samePt(cur[0]!, cur[cur.length - 1]!)) cur.push(cur[0]!);
      if (cur.length >= 4) rings.push(geomToLocal(cur.slice(0, -1)));
    }
    return rings;
  }
  /** Внешние и внутренние кольца мультиполигона. */
  function multipolygon(rel: OverpassElement): Polygon[] {
    const outerWays: (OverpassPoint | null)[][] = [];
    const innerWays: (OverpassPoint | null)[][] = [];
    for (const m of rel.members ?? []) {
      if (m.type !== 'way' || !m.geometry) continue;
      (m.role === 'inner' ? innerWays : outerWays).push(m.geometry);
    }
    const outers = assembleRings(outerWays).map((outer): Polygon => ({ outer, holes: [] }));
    for (const inner of assembleRings(innerWays)) {
      const host = outers.find((o) => pointInRing(inner[0]!, inner[1]!, o.outer));
      if (host) host.holes.push(inner);
    }
    return outers;
  }
  /** Полигоны элемента Overpass: замкнутая линия или мультиполигон. */
  function polygonsOf(el: OverpassElement): Polygon[] {
    if (el.type === 'way') {
      const ring = closedRing(el.geometry);
      return ring ? [{ outer: ring, holes: [] }] : [];
    }
    if (el.type === 'relation') return multipolygon(el);
    return [];
  }
  /** Поправка по id OSM (--heights) или null. */
  function overrideOf(el: OverpassElement): Override | null {
    const o = own(overrides, `${el.type.charAt(0)}${el.id}`);
    return o == null ? null : typeof o === 'number' ? { height: o } : (o as Override);
  }

  const stats: OsmBuildStats = { dropped: 0, landmarks: 0, structures: 0, roadsDropped: 0, inside: 0 };

  function addBuildings(els: readonly OverpassElement[], seen: Set<string>, out: BuildingRec[]): void {
    for (const el of els) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = el.tags ?? {};
      const landmark = isLandmark(tags);
      const ov = overrideOf(el);
      for (const { outer: raw } of polygonsOf(el)) {
        let ring = simplifyRing(ccw(raw), landmark ? 0.2 : 0.5);
        ring = quantize(ring, true);
        const n = ring.length / 2;
        if (n < 3 || n > 65535) continue;
        const m = ring.map((v) => v / 10);
        const area = signedArea(m);
        if (area < 4) continue;
        let ce = 0;
        let cn = 0;
        for (let i = 0; i < n; i++) {
          ce += m[2 * i]!;
          cn += m[2 * i + 1]!;
        }
        ce /= n;
        cn /= n;
        if (ce * ce + cn * cn > r * r && !nearTrack(ce, cn)) continue;
        const { kind, height, levels, roof } = buildingKind(tags, area, ov);
        if (kind === 'other' && area < minBuildingArea && !landmark && !ov) {
          stats.dropped++;
          continue;
        }
        if (landmark) stats.landmarks++;
        out.push({ kind: KIND[kind]!, heightDm: Math.round(height * 10), levels, roof, ring });
      }
    }
  }

  function structures(els: readonly OverpassElement[], seen: Set<string>): BuildingRec[] {
    const out: BuildingRec[] = [];
    for (const el of els) {
      const key = `${el.type}${el.id}`;
      // Обведённые как здания уже взяты вместе с домами.
      if (seen.has(key)) continue;
      seen.add(key);
      const t = el.tags ?? {};
      const s = own(STRUCTURE, t.man_made);
      const type = t['tower:type'];
      if (!s || type === 'lighting' || t.disused === 'yes' || t['demolished:man_made']) continue;
      const ov = overrideOf(el);
      const ovHeight = Number(ov?.height);
      let height = ovHeight > 0 ? ovHeight : parseNum(t.height);
      if (!(height > 0)) height = type === 'cooling' ? 60 : type === 'bell_tower' ? 15 : s.height;
      let ring: number[];
      if (el.type === 'node') {
        const dTag = parseNum(t.diameter);
        const d = dTag > 0 && dTag < 200 ? dTag : type === 'cooling' ? 50 : s.diameter(height);
        const [ce, cn] = toLocal(el.lat!, el.lon!);
        ring = [];
        for (let i = 0; i < 8; i++) ring.push(ce + (d / 2) * Math.cos((i * Math.PI) / 4), cn + (d / 2) * Math.sin((i * Math.PI) / 4));
      } else {
        const p = polygonsOf(el)[0];
        if (!p) continue;
        ring = simplifyRing(ccw(p.outer), 0.2);
      }
      const q = quantize(ring, true);
      const n = q.length / 2;
      if (n < 3) continue;
      let ce = 0;
      let cn = 0;
      for (let i = 0; i < n; i++) {
        ce += q[2 * i]! / 10;
        cn += q[2 * i + 1]! / 10;
      }
      if ((ce / n) ** 2 + (cn / n) ** 2 > r * r && !nearTrack(ce / n, cn / n)) continue;
      const kind = own(KIND, ov?.kind) !== undefined ? (ov!.kind as string) : type === 'cooling' ? 'industrial' : s.kind;
      out.push({ kind: KIND[kind]!, heightDm: Math.round(Math.min(MAX_HEIGHT_M, Math.max(2, height)) * 10), levels: 0, roof: own(ROOF, ov?.roof) ?? ROOF.flat!, ring: q });
    }
    return out;
  }

  function forests(els: readonly OverpassElement[]): ForestRec[] {
    const prep = (raw: number[]) => {
      const q = quantize(simplifyRing(clipRect(raw, AREA_E0, AREA_N0, AREA_E1, AREA_N1), 6), true);
      if (q.length / 2 < 3) return null;
      const a = Math.abs(signedArea(q.map((v) => v / 10)));
      return a >= 400 ? q : null;
    };
    const out: ForestRec[] = [];
    for (const el of els) {
      const tags = el.tags ?? {};
      const lt = tags.leaf_type;
      const leaf = lt === 'needleleaved' ? 0 : lt === 'broadleaved' ? 1 : 2;
      for (const p of polygonsOf(el)) {
        const outer = prep(p.outer);
        if (!outer) continue;
        const rings = [outer];
        for (const h of p.holes) {
          const hole = prep(h);
          if (hole) rings.push(hole);
        }
        out.push({ leaf, rings });
      }
    }
    return out;
  }

  function runways(els: readonly OverpassElement[]): RunwayRec[] {
    const out: RunwayRec[] = [];
    for (const el of els) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const tags = el.tags ?? {};
      const paved = ['asphalt', 'concrete', 'paved', 'concrete:plates'].includes(tags.surface ?? '');
      let width = parseNum(tags.width);
      let line: number[];
      const closed = el.geometry.length >= 4 && samePt(el.geometry[0]!, el.geometry[el.geometry.length - 1]!);
      if (closed || tags.area === 'yes') {
        const a = axisOfArea(geomToLocal(closed ? el.geometry.slice(0, -1) : el.geometry));
        if (!a) continue;
        line = a.line;
        if (!(width > 0)) width = a.width;
      } else line = geomToLocal(el.geometry);
      if (!(width > 0)) width = paved ? 30 : 20;
      const q = quantize(line, false);
      if (q.length < 4) continue;
      out.push({ widthDm: Math.round(width * 10), paved: paved ? 1 : 0, line: q });
    }
    return out;
  }

  function addRoads(els: readonly OverpassElement[], seen: Set<number>, out: RoadRec[]): void {
    for (const el of els) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const key = el.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = el.tags ?? {};
      if (t.area === 'yes' || (t.tunnel && t.tunnel !== 'no') || t.disused === 'yes' || t.abandoned === 'yes') continue;
      if (t.highway === 'service' && SERVICE_SKIP.has(t.service ?? '')) {
        stats.roadsDropped++;
        continue;
      }
      let cls: number;
      let width: number;
      const hw = own(HIGHWAY, t.highway);
      const rw = own(RAILWAY, t.railway);
      if (hw) [cls, width] = hw;
      else if (rw) [cls, width] = [9, rw];
      else continue;
      const oneway = t.oneway === 'yes' || t.oneway === '1';
      if (cls <= 2 && oneway) width -= 2;
      const wTag = parseNum(t.width);
      const lanes = parseNum(t.lanes);
      if (cls < 9 && wTag >= 2 && wTag <= 30) width = wTag;
      else if (cls < 8 && lanes >= 1 && lanes <= 8) width = Math.max(width, lanes * 3.5);
      let paved = cls !== 8;
      if (PAVED.has(t.surface ?? '')) paved = true;
      else if (UNPAVED.has(t.surface ?? '')) paved = false;
      else if (cls === 8 && t.tracktype === 'grade1') paved = true;
      const bridge = !!t.bridge && t.bridge !== 'no';
      const lit = t.lit === 'yes';
      const tol = cls >= 7 ? 1.5 : 1;
      for (const run of clipLineRect(geomToLocal(el.geometry), AREA_E0, AREA_N0, AREA_E1, AREA_N1)) {
        const line = quantize(simplifyLine(run, tol), false);
        if (line.length < 4) continue;
        if (!bridge && lineLengthDm(line) < (cls >= 7 ? 25 : 10)) {
          stats.roadsDropped++;
          continue;
        }
        out.push({ cls, flags: (paved ? 1 : 0) | (bridge ? 2 : 0) | (lit ? 4 : 0), widthDm: Math.round(width * 10), line });
      }
    }
  }

  function water(els: readonly OverpassElement[]): WaterRec[] {
    const prep = (raw: number[]) => {
      const q = quantize(simplifyRing(clipRect(raw, AREA_E0, AREA_N0, AREA_E1, AREA_N1), 1.5), true);
      if (q.length / 2 < 3) return null;
      return Math.abs(signedArea(q.map((v) => v / 10))) >= 150 ? q : null;
    };
    const seen = new Set<string>();
    const out: WaterRec[] = [];
    for (const el of els) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = el.tags ?? {};
      // Пересыхающие пруды и болотца с высоты не вода.
      if (t.intermittent === 'yes' || t.seasonal === 'yes' || t.natural === 'wetland') continue;
      const kind = waterKind(t);
      for (const p of polygonsOf(el)) {
        const outer = prep(p.outer);
        if (!outer) continue;
        const rings = [outer];
        for (const h of p.holes) {
          const hole = prep(h);
          if (hole) rings.push(hole);
        }
        out.push({ kind, rings });
      }
    }
    return out;
  }

  function waterways(els: readonly OverpassElement[], areas: readonly WaterRec[]): WaterwayRec[] {
    const inWater = waterIndex(areas);
    const out: WaterwayRec[] = [];
    for (const el of els) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const t = el.tags ?? {};
      // Трубы под дорогами и пересыхающие ручьи не рисуем.
      if ((t.tunnel && t.tunnel !== 'no') || t.intermittent === 'yes' || t.seasonal === 'yes') continue;
      const ww = own(WATERWAY, t.waterway);
      if (!ww) continue;
      const [kind, def] = ww;
      const wTag = parseNum(t.width);
      const width = wTag >= 1 && wTag <= 200 ? wTag : def;
      for (const run of clipLineRect(geomToLocal(el.geometry), AREA_E0, AREA_N0, AREA_E1, AREA_N1)) {
        const line = simplifyLine(run, 1.5);
        // Осевые внутри площадей воды не нужны: режем на куски вне воды.
        const n = line.length / 2;
        const inPt: boolean[] = [];
        for (let i = 0; i < n; i++) inPt.push(inWater(line[2 * i]!, line[2 * i + 1]!));
        let cur: number[] | null = null;
        const pieces: number[][] = [];
        for (let i = 0; i + 1 < n; i++) {
          const me = (line[2 * i]! + line[2 * i + 2]!) / 2, mn = (line[2 * i + 1]! + line[2 * i + 3]!) / 2;
          const drop = inPt[i] && inPt[i + 1] && inWater(me, mn);
          if (drop) {
            stats.inside++;
            cur = null;
            continue;
          }
          if (!cur) {
            cur = [line[2 * i]!, line[2 * i + 1]!];
            pieces.push(cur);
          }
          cur.push(line[2 * i + 2]!, line[2 * i + 3]!);
        }
        for (const piece of pieces) {
          const q = quantize(piece, false);
          if (q.length < 4 || lineLengthDm(q) < 30) continue;
          out.push({ kind, widthDm: Math.round(width * 10), line: q });
        }
      }
    }
    return out;
  }

  /** Все запросы по очереди → записи файла. */
  async function run(overpass: OverpassQuery, onProgress?: OsmProgress): Promise<{ data: OsmBuildData; stats: OsmBuildStats }> {
    let done = 0;
    const of = (kind: OsmJobKind) => jobs.filter((j) => j.kind === kind);
    const fetchOne = async (job: OsmJob) => {
      onProgress?.(done, jobs.length, job.label);
      const els = await overpass(job.query, job.label);
      done++;
      return els;
    };
    /** Ответы нескольких квадратов без повторов на стыках. */
    const fetchTiled = async (list: readonly OsmJob[]) => {
      const seen = new Set<string>();
      const out: OverpassElement[] = [];
      for (const job of list) {
        for (const el of await fetchOne(job)) {
          const key = `${el.type}${el.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(el);
        }
      }
      return out;
    };

    const seen = new Set<string>();
    const buildings: BuildingRec[] = [];
    for (const job of of('buildings')) addBuildings(await fetchOne(job), seen, buildings);
    const extra: BuildingRec[] = [];
    for (const job of of('structures')) extra.push(...structures(await fetchOne(job), seen));
    stats.structures = extra.length;
    buildings.push(...extra);
    const forestRecs = forests(await fetchTiled(of('forests')));
    const runwayRecs: RunwayRec[] = [];
    for (const job of of('runways')) runwayRecs.push(...runways(await fetchOne(job)));
    const roadSeen = new Set<number>();
    const roads: RoadRec[] = [];
    for (const job of of('roads')) addRoads(await fetchOne(job), roadSeen, roads);
    const waterEls = await fetchTiled(of('water'));
    // В коридоре реки пришли вместе с водой.
    const waterRecs = water(track ? waterEls.filter(isWaterArea) : waterEls);
    const lineEls = track ? waterEls.filter(isWaterwayLine) : [];
    for (const job of of('waterways')) lineEls.push(...(await fetchOne(job)));
    const waterwayRecs = waterways(lineEls, waterRecs);
    onProgress?.(jobs.length, jobs.length, 'готово');
    return { data: { buildings, forests: forestRecs, runways: runwayRecs, roads, water: waterRecs, waterways: waterwayRecs }, stats: { ...stats } };
  }

  return { plan, run };
}

/** Запросы места без сети: области и подписи (для хода работы и проверки коридора). */
export function planOsm(opts: OsmBuildOptions): OsmPlan {
  return place(opts).plan;
}

/**
 * Дома, леса, полосы, дороги и вода места из Overpass. Запросы — по очереди через overpass
 * (сеть, кэш — у вызывающего); onProgress — перед каждым запросом и в конце («готово»).
 */
export function buildOsm(opts: OsmBuildOptions, overpass: OverpassQuery, onProgress?: OsmProgress): Promise<{ data: OsmBuildData; stats: OsmBuildStats }> {
  return place(opts).run(overpass, onProgress);
}

// --- запись ---

/** Растущий буфер байтов. */
class Bytes {
  buf = new Uint8Array(1 << 20);
  n = 0;
  room(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u8(v: number): void {
    this.room(1);
    this.buf[this.n++] = v & 0xff;
  }
  u32(v: number): void {
    for (let i = 0; i < 4; i++) this.u8(Math.floor(v / 256 ** i));
  }
  varint(v: number): void {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new Error(`varint: ${v}`);
    while (v >= 128) {
      this.u8((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }
  zz(v: number): void {
    this.varint(v >= 0 ? 2 * v : -2 * v - 1);
  }
  /** Точки в дм: число и разности. */
  points(arr: readonly number[]): void {
    this.varint(arr.length / 2);
    let pe = 0;
    let pn = 0;
    for (let i = 0; i < arr.length; i += 2) {
      this.zz(arr[i]! - pe);
      this.zz(arr[i + 1]! - pn);
      pe = arr[i]!;
      pn = arr[i + 1]!;
    }
  }
  rings(rings: readonly (readonly number[])[]): void {
    this.varint(rings.length);
    for (const r of rings) this.points(r);
  }
  bytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.n);
  }
}

/** Записи → байты osm.bin версии 2 и размеры разделов (для отчёта). */
export function encodeOsm(d: OsmBuildData): { bytes: Uint8Array<ArrayBuffer>; sizes: Record<string, number> } {
  const w = new Bytes();
  const sizes: Record<string, number> = {};
  let mark = 0;
  const section = (name: string) => {
    sizes[name] = w.n - mark;
    mark = w.n;
  };
  for (const c of 'OSM2') w.u8(c.charCodeAt(0));
  for (const k of ['buildings', 'forests', 'runways', 'roads', 'water', 'waterways'] as const) w.u32(d[k].length);
  section('заголовок');
  for (const b of d.buildings) {
    w.u8(b.kind);
    w.u8(b.levels);
    w.u8(b.roof);
    w.varint(b.heightDm);
    w.points(b.ring);
  }
  section('дома');
  for (const f of d.forests) {
    w.u8(f.leaf);
    w.rings(f.rings);
  }
  section('леса');
  for (const r of d.runways) {
    w.u8(r.paved);
    w.varint(r.widthDm);
    w.points(r.line);
  }
  section('полосы');
  for (const r of d.roads) {
    w.u8(r.cls);
    w.u8(r.flags);
    w.varint(r.widthDm);
    w.points(r.line);
  }
  section('дороги');
  for (const r of d.water) {
    w.u8(r.kind);
    w.rings(r.rings);
  }
  section('вода');
  for (const r of d.waterways) {
    w.u8(r.kind);
    w.varint(r.widthDm);
    w.points(r.line);
  }
  section('реки');
  return { bytes: w.bytes(), sizes };
}
