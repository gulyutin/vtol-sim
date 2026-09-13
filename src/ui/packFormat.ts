/*
 * Пакет района для работы без сети: формат manifest.json, покрытие тайла пакетом, выбор источника
 * тайла, перечень и число тайлов для сборщика (scripts/region-pack.mjs). Без DOM и сети —
 * проверяется тестами (tests/packs.test.ts).
 *
 * Пакет лежит в `${packsBaseUrl}<id>/`:
 *   manifest.json                — описание (PackManifest);
 *   terrain/{z}/{x}/{y}.png      — высоты Terrarium;
 *   imagery/{z}/{x}/{y}.jpg      — снимки, если они есть (источник и лицензия — в манифесте);
 *   osm.bin                      — дома, дороги, вода и лес (src/sim/osm.ts).
 */
import { mercatorPixel } from '../sim/terrain';
import type { GeoPoint } from '../sim/types';

export const PACK_FORMAT = 1;
/** Запас вокруг области района, м: столько же берёт рельеф (main.ts: expandBounds(REGION, 3000)). */
export const REGION_MARGIN_M = 3000;
/** Уровень сетки высот, по которой считается физика и строятся сетки 3D-рельефа (loadTerrain). */
export const TERRAIN_GRID_ZOOM = 12;

export interface PackBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Уровни minZoom…maxZoom, на которых у пакета есть тайлы в этих областях. */
export interface PackLevel {
  minZoom: number;
  maxZoom: number;
  areas: PackBounds[];
}

/** Слой пакета: рельеф или снимки. */
export interface PackLayer {
  /** Все уровни слоя по возрастанию. */
  zooms: number[];
  levels: PackLevel[];
  /** Тайлов в пакете и их объём, байт. */
  tiles: number;
  bytes: number;
  /** Сколько тайлов источник не отдал (нет данных на этом уровне): они — «нет данных». */
  missing: number;
  source: string;
  license: string;
}

export interface PackOsm {
  file: 'osm.bin';
  bytes: number;
  source: string;
  license: string;
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  id: string;
  title?: string;
  /** Область пакета: область района с запасом. */
  bounds: PackBounds;
  /** Когда собран, ISO 8601. */
  created: string;
  /** Весь пакет: байт и тайлов. */
  bytes: number;
  tiles: number;
  terrain: PackLayer & { encoding: 'terrarium' };
  /** null — снимков в пакете нет: без сети 3D и карта показывают тонированный рельеф. */
  imagery: (PackLayer & { format: 'jpg'; corridorKm?: number }) | null;
  osm: PackOsm | null;
  generator?: string;
}

export interface TileRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Тайлы уровня z (Web Mercator, 256 px), которых касается область, — как в loadTerrain. */
export function tileRange(b: PackBounds, z: number): TileRange {
  const max = 2 ** z - 1;
  const nw = mercatorPixel({ lat: b.north, lon: b.west }, z);
  const se = mercatorPixel({ lat: b.south, lon: b.east }, z);
  const clamp = (v: number) => Math.max(0, Math.min(max, Math.floor(v / 256)));
  return { x0: clamp(nw.x), y0: clamp(nw.y), x1: clamp(se.x), y1: clamp(se.y) };
}

/** Границы, расширенные на marginM метров во все стороны. */
export function expandBounds(b: PackBounds, marginM: number): PackBounds {
  const dLat = marginM / 111_195;
  const dLon = marginM / (111_195 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLon, east: b.east + dLon };
}

/** Есть ли тайл (z, x, y) в слое пакета. */
export function layerCovers(layer: Pick<PackLayer, 'levels'> | null | undefined, z: number, x: number, y: number): boolean {
  if (!layer) return false;
  for (const l of layer.levels) {
    if (z < l.minZoom || z > l.maxZoom) continue;
    for (const a of l.areas) {
      const r = tileRange(a, z);
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
    }
  }
  return false;
}

/** Покрывает ли рельеф пакета область b целиком на уровне сетки высот. */
export function packCoversBounds(m: PackManifest, b: PackBounds): boolean {
  const r = tileRange(b, TERRAIN_GRID_ZOOM);
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (!layerCovers(m.terrain, TERRAIN_GRID_ZOOM, x, y)) return false;
  return true;
}

export type TileOrigin = 'pack' | 'cache' | 'net';

/**
 * Откуда брать тайл, по порядку: пакет активного района, если он покрывает тайл; постоянный кэш
 * просмотренного (только рельеф и OSM — снимки Esri хранить нельзя); сеть, если она есть.
 * Пустой список — данных нет: тайл «нет данных», без запросов и повторов.
 */
export function chooseSources(o: { inPack: boolean; offline: boolean; persistentCache?: boolean }): TileOrigin[] {
  const out: TileOrigin[] = [];
  if (o.inPack) out.push('pack');
  if (o.persistentCache) out.push('cache');
  if (!o.offline) out.push('net');
  return out;
}

/** Уровни «10-16», «12» или «8,10-12» → [10, 11, …]. */
export function parseZooms(s: string): number[] {
  const out = new Set<number>();
  for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`Уровни zoom: «${s}» — ожидается, например, 10-16 или 8,12`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a > b || b > 22) throw new Error(`Уровни zoom: «${part}» — от меньшего к большему, не выше 22`);
    for (let z = a; z <= b; z++) out.add(z);
  }
  if (!out.size) throw new Error('Уровни zoom не заданы');
  return [...out].sort((p, q) => p - q);
}

/** Уровни одной областью → PackLevel подряд идущими отрезками. */
export function levelsFor(zooms: number[], areas: PackBounds[]): PackLevel[] {
  const out: PackLevel[] = [];
  for (const z of [...zooms].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.maxZoom === z - 1) last.maxZoom = z;
    else out.push({ minZoom: z, maxZoom: z, areas });
  }
  return out;
}

/** Все тайлы уровней без повторов: [z, x, y] по возрастанию z, затем по строкам. */
export function listTiles(levels: PackLevel[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  const zooms = new Set<number>();
  for (const l of levels) for (let z = l.minZoom; z <= l.maxZoom; z++) zooms.add(z);
  for (const z of [...zooms].sort((a, b) => a - b)) {
    const seen = new Set<number>();
    const size = 2 ** z;
    for (const l of levels) {
      if (z < l.minZoom || z > l.maxZoom) continue;
      for (const a of l.areas) {
        const r = tileRange(a, z);
        for (let y = r.y0; y <= r.y1; y++)
          for (let x = r.x0; x <= r.x1; x++) {
            const k = y * size + x;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push([z, x, y]);
          }
      }
    }
  }
  return out;
}

/** Число тайлов по уровням (без повторов). */
export function countTiles(levels: PackLevel[]): { total: number; perZoom: Record<number, number> } {
  const perZoom: Record<number, number> = {};
  const tiles = listTiles(levels);
  for (const [z] of tiles) perZoom[z] = (perZoom[z] ?? 0) + 1;
  return { total: tiles.length, perZoom };
}

/**
 * Средний объём тайла для оценки до скачивания, байт. Terrarium — PNG 256×256: на равнине около
 * 45 КБ, в горах z11–12 около 100 КБ (Хибины: 95 КБ в среднем); берём 90 КБ, чтобы места хватило.
 * Снимки 256×256 JPEG — 10–30 КБ, берём 20 КБ.
 */
export const AVG_TERRAIN_TILE_BYTES = 90_000;
export const AVG_IMAGERY_TILE_BYTES = 20_000;

/** Детальные снимки — только вокруг площадок и маршрутов: коридор ± corridorKm. */
export interface CorridorSpec {
  km: number;
  /** С этого уровня снимки только в коридоре; ниже — по всей области. */
  fromZoom: number;
}

export interface PackPlan {
  bounds: PackBounds;
  terrain: { levels: PackLevel[]; total: number; perZoom: Record<number, number>; bytes: number };
  imagery: { levels: PackLevel[]; total: number; perZoom: Record<number, number>; bytes: number } | null;
  tiles: number;
  bytes: number;
}

/** План пакета для --dry-run и загрузки: уровни, число тайлов, примерный объём. */
export function planPack(o: { bounds: PackBounds; terrainZooms: number[]; imageryZooms?: number[] | null; corridor?: { spec: CorridorSpec; areas: PackBounds[] } | null }): PackPlan {
  const tLevels = levelsFor(o.terrainZooms, [o.bounds]);
  const t = countTiles(tLevels);
  const terrain = { levels: tLevels, ...t, bytes: t.total * AVG_TERRAIN_TILE_BYTES };
  let imagery: PackPlan['imagery'] = null;
  if (o.imageryZooms?.length) {
    const full = o.corridor ? o.imageryZooms.filter((z) => z < o.corridor!.spec.fromZoom) : o.imageryZooms;
    const near = o.corridor ? o.imageryZooms.filter((z) => z >= o.corridor!.spec.fromZoom) : [];
    const iLevels = [...levelsFor(full, [o.bounds]), ...(near.length ? levelsFor(near, clipAreas(o.corridor!.areas, o.bounds)) : [])];
    const c = countTiles(iLevels);
    imagery = { levels: iLevels, ...c, bytes: c.total * AVG_IMAGERY_TILE_BYTES };
  }
  return { bounds: o.bounds, terrain, imagery, tiles: terrain.total + (imagery?.total ?? 0), bytes: terrain.bytes + (imagery?.bytes ?? 0) };
}

/** Области, обрезанные по границам; пустые — прочь. */
function clipAreas(areas: PackBounds[], b: PackBounds): PackBounds[] {
  return areas
    .map((a) => ({ south: Math.max(a.south, b.south), west: Math.max(a.west, b.west), north: Math.min(a.north, b.north), east: Math.min(a.east, b.east) }))
    .filter((a) => a.south < a.north && a.west < a.east);
}

const isPoint = (v: unknown): v is GeoPoint => !!v && typeof v === 'object' && Number.isFinite((v as GeoPoint).lat) && Number.isFinite((v as GeoPoint).lon);

/**
 * Площадки и маршруты заданий района (LocationSpec): площадка, участок съёмки, точки маршрутов
 * от площадки до пункта назначения и обратно, ретрансляторы и прочие точки. Линии — ломаные.
 */
export function missionGeometry(location: { site: GeoPoint; region?: unknown } & Record<string, unknown>): { points: GeoPoint[]; lines: GeoPoint[][] } {
  const points: GeoPoint[] = [location.site];
  const lines: GeoPoint[][] = [];
  const visit = (v: unknown, key: string) => {
    if (key === 'region' || !v || typeof v !== 'object') return;
    if (isPoint(v)) {
      points.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, '');
      return;
    }
    const o = v as Record<string, unknown>;
    const route = Array.isArray(o['route']) ? (o['route'] as unknown[]).filter(isPoint) : [];
    const dest = isPoint(o['destination']) ? o['destination'] : null;
    if (route.length || dest) lines.push([location.site, ...route, ...(dest ? [dest, location.site] : [location.site])]);
    const area = Array.isArray(o['area']) ? (o['area'] as unknown[]).filter(isPoint) : [];
    if (area.length > 1) lines.push([...area, area[0]!]);
    for (const [k, x] of Object.entries(o)) visit(x, k);
  };
  for (const [k, v] of Object.entries(location)) if (k !== 'site') visit(v, k);
  return { points, lines };
}

/** Квадрат ± km вокруг точки. */
function boxAround(p: GeoPoint, km: number): PackBounds {
  const dLat = (km * 1000) / 111_195;
  const dLon = (km * 1000) / (111_195 * Math.cos((p.lat * Math.PI) / 180));
  return { south: p.lat - dLat, north: p.lat + dLat, west: p.lon - dLon, east: p.lon + dLon };
}

/** Коридор ± km вокруг точек и линий: квадраты вдоль линий с шагом km (перекрываются). */
export function corridorAreas(geometry: { points: GeoPoint[]; lines: GeoPoint[][] }, km: number): PackBounds[] {
  if (!(km > 0)) throw new Error('Ширина коридора должна быть больше нуля');
  const centers: GeoPoint[] = [...geometry.points];
  for (const line of geometry.lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!;
      const b = line[i + 1]!;
      const dN = (b.lat - a.lat) * 111.195;
      const dE = (b.lon - a.lon) * 111.195 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      const steps = Math.max(1, Math.ceil(Math.hypot(dN, dE) / km));
      for (let s = 0; s <= steps; s++) centers.push({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps });
    }
  }
  // Одинаковые центры — один раз (площадка встречается во всех заданиях).
  const seen = new Set<string>();
  const out: PackBounds[] = [];
  for (const c of centers) {
    const k = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(boxAround(c, km));
  }
  return out;
}

// --- разбор manifest.json ---

const fail = (msg: string): never => {
  throw new Error(`manifest.json: ${msg}`);
};
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} — не число`));
const str = (v: unknown, what: string): string => (typeof v === 'string' && v.trim() ? v : fail(`${what} — пустая строка или нет поля`));

function bounds(v: unknown, what: string): PackBounds {
  if (!v || typeof v !== 'object') return fail(`${what} — нет области`);
  const o = v as Record<string, unknown>;
  const b = { south: num(o['south'], `${what}.south`), west: num(o['west'], `${what}.west`), north: num(o['north'], `${what}.north`), east: num(o['east'], `${what}.east`) };
  if (!(b.south < b.north && b.west < b.east) || Math.abs(b.south) > 90 || Math.abs(b.north) > 90) fail(`${what} — неверная область`);
  return b;
}

function layer(v: unknown, what: string): PackLayer {
  if (!v || typeof v !== 'object') return fail(`${what} — нет описания слоя`);
  const o = v as Record<string, unknown>;
  const levels = Array.isArray(o['levels'])
    ? (o['levels'] as unknown[]).map((l, i) => {
        const lo = (l ?? {}) as Record<string, unknown>;
        const minZoom = num(lo['minZoom'], `${what}.levels[${i}].minZoom`);
        const maxZoom = num(lo['maxZoom'], `${what}.levels[${i}].maxZoom`);
        if (minZoom > maxZoom || minZoom < 0 || maxZoom > 22) fail(`${what}.levels[${i}] — неверные уровни`);
        const areas = Array.isArray(lo['areas']) ? (lo['areas'] as unknown[]).map((a, k) => bounds(a, `${what}.levels[${i}].areas[${k}]`)) : fail(`${what}.levels[${i}].areas — нет областей`);
        return { minZoom, maxZoom, areas };
      })
    : fail(`${what}.levels — нет уровней`);
  const zooms = [...new Set(levels.flatMap((l) => Array.from({ length: l.maxZoom - l.minZoom + 1 }, (_, k) => l.minZoom + k)))].sort((a, b) => a - b);
  return {
    zooms,
    levels,
    tiles: num(o['tiles'], `${what}.tiles`),
    bytes: num(o['bytes'], `${what}.bytes`),
    missing: typeof o['missing'] === 'number' ? o['missing'] : 0,
    source: str(o['source'], `${what}.source`),
    license: str(o['license'], `${what}.license`),
  };
}

/** Проверенный манифест пакета; ошибка — с понятным текстом, что не так. */
export function parseManifest(json: unknown): PackManifest {
  if (!json || typeof json !== 'object') return fail('не объект JSON');
  const o = json as Record<string, unknown>;
  if (o['format'] !== PACK_FORMAT) fail(`версия формата ${String(o['format'])}, поддерживается ${PACK_FORMAT} — пакет собран другой версией сборщика`);
  const id = str(o['id'], 'id');
  if (!/^[\w.-]+$/.test(id)) fail('id — только латиница, цифры, «_», «-» и «.»');
  const created = str(o['created'], 'created');
  if (Number.isNaN(Date.parse(created))) fail('created — не дата');
  const terrain = layer(o['terrain'], 'terrain');
  let imagery: PackManifest['imagery'] = null;
  if (o['imagery'] !== null && o['imagery'] !== undefined) {
    const i = o['imagery'] as Record<string, unknown>;
    imagery = { ...layer(i, 'imagery'), format: 'jpg', ...(typeof i['corridorKm'] === 'number' ? { corridorKm: i['corridorKm'] } : {}) };
  }
  let osm: PackOsm | null = null;
  if (o['osm'] !== null && o['osm'] !== undefined) {
    const s = o['osm'] as Record<string, unknown>;
    osm = { file: 'osm.bin', bytes: num(s['bytes'], 'osm.bytes'), source: str(s['source'], 'osm.source'), license: str(s['license'], 'osm.license') };
  }
  return {
    format: PACK_FORMAT,
    id,
    ...(typeof o['title'] === 'string' ? { title: o['title'] } : {}),
    bounds: bounds(o['bounds'], 'bounds'),
    created,
    bytes: num(o['bytes'], 'bytes'),
    tiles: num(o['tiles'], 'tiles'),
    terrain: { ...terrain, encoding: 'terrarium' },
    imagery,
    osm,
    ...(typeof o['generator'] === 'string' ? { generator: o['generator'] } : {}),
  };
}

/** «12,3 МБ». */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}
