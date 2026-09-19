/*
 * Откуда брать рельеф, снимки и OSM: единая точка для terrainData.ts, terrainLod.ts, map2d.ts и
 * main.ts. Порядок — пакет активного района (src/ui/packFormat.ts), если он покрывает тайл; для
 * рельефа ещё постоянный кэш просмотренного; затем сеть, если она есть.
 *
 * Настольное приложение даёт window.vtolDesktop = { version, platform, packsBaseUrl, offline }.
 * В браузере его нет: пакеты ищутся в BASE_URL + 'packs/' (public/packs/<id>/), сеть — как есть.
 * Отладка: ?offline=1 в адресе — как offline: true у настольного приложения (внешних запросов
 * тайлов нет вовсе, всё из пакета или «нет данных»).
 *
 * Лицензии: в постоянный кэш (Cache API) идут рельеф Terrarium и снимки Sentinel-2 cloudless 2017
 * (EOX, CC BY 4.0 — хранить можно, с подписью). Снимки Esri — только обычный HTTP-кэш браузера:
 * хранить их для работы без сети без лицензии ArcGIS нельзя. В сети — Esri (детальнее), без сети —
 * сохранённый Sentinel-2 (10 м на пиксель, до SAVED_MAX_ZOOM; крупнее — растягивается предок).
 */
import { activeRegion } from '../game/regions';
import { chooseSources, layerCovers, parseManifest, type PackManifest } from './packFormat';

/** Мост настольного приложения (договор с desktop/). */
export interface DesktopBridge {
  version: string;
  platform: 'win' | 'mac' | 'linux';
  packsBaseUrl: string;
  offline: boolean;
}

export interface TileEnv {
  /** Запущено в настольном приложении. */
  desktop: DesktopBridge | null;
  /** Сети нет или она заблокирована: внешних запросов тайлов не делать. */
  offline: boolean;
  /** Почему офлайн: 'desktop' — так сказало приложение, 'debug' — ?offline=1, 'browser' — navigator.onLine. */
  offlineReason: 'desktop' | 'debug' | 'browser' | null;
  /** Адрес папки пакетов, с «/» на конце. */
  packsBaseUrl: string;
}

const TERRARIUM = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const TERRAIN_CACHE = 'vtol-sim-terrain-v1';
/** Снимки для работы без сети: Sentinel-2 cloudless 2017 от EOX (CC BY 4.0). */
export const S2_URL = (z: number, x: number, y: number) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/${z}/${y}/${x}.jpg`;
export const S2_ATTRIBUTION = 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2017), CC BY 4.0';
const SAVED_CACHE = 'vtol-sim-s2-v1';
/** Уровни сохраняемых снимков: 10 м на пиксель — это примерно z14. */
export const SAVED_MIN_ZOOM = 8;
export const SAVED_MAX_ZOOM = 14;
/** Пакет лежит рядом (диск или локальный сервер): отвечает быстро — ждать дольше незачем. */
const PACK_TIMEOUT_MS = 8000;

let envMemo: TileEnv | null = null;

/** Где мы и есть ли сеть. Считается один раз: смена сети — перезагрузкой, как смена района. */
export function tileEnv(): TileEnv {
  if (envMemo) return envMemo;
  const g = globalThis as unknown as { vtolDesktop?: DesktopBridge; location?: { search: string }; navigator?: { onLine?: boolean } };
  const desktop = g.vtolDesktop && typeof g.vtolDesktop.packsBaseUrl === 'string' ? g.vtolDesktop : null;
  const debug = /[?&]offline=1(?:&|#|$)/.test(g.location?.search ?? '');
  const browserOff = g.navigator?.onLine === false;
  const offlineReason = desktop?.offline ? 'desktop' : debug ? 'debug' : browserOff ? 'browser' : null;
  let base = desktop ? desktop.packsBaseUrl : `${import.meta.env.BASE_URL}packs/`;
  if (!base.endsWith('/')) base += '/';
  envMemo = { desktop, offline: offlineReason !== null, offlineReason, packsBaseUrl: base };
  return envMemo;
}

/** Только для тестов и отладки: сбросить запомненное окружение и пакеты. */
export function resetTileSource(): void {
  envMemo = null;
  packs.clear();
  active = undefined;
}

// --- пакеты ---

export interface LoadedPack {
  manifest: PackManifest;
  /** Адрес папки пакета, с «/» на конце. */
  baseUrl: string;
}

/** Что нашлось по адресу пакета района. */
export interface PackProbe {
  id: string;
  status: 'installed' | 'absent' | 'broken';
  pack: LoadedPack | null;
  /** Для 'broken': что не так с manifest.json. */
  error?: string;
}

const packs = new Map<string, Promise<PackProbe>>();
let active: LoadedPack | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Запрос с ограничением времени; ошибка сети — исключение. */
async function fetchWithin(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Пакет района id: manifest.json по адресу пакетов. Запрос один на район за сеанс. */
export function probePack(id: string): Promise<PackProbe> {
  let p = packs.get(id);
  if (!p) {
    p = (async (): Promise<PackProbe> => {
      const baseUrl = `${tileEnv().packsBaseUrl}${encodeURIComponent(id)}/`;
      let res: Response;
      try {
        res = await fetchWithin(`${baseUrl}manifest.json`, PACK_TIMEOUT_MS, { cache: 'no-cache' });
      } catch {
        return { id, status: 'absent', pack: null };
      }
      if (!res.ok) return { id, status: 'absent', pack: null };
      const text = await res.text().catch(() => '');
      // Сервер разработки на неизвестный адрес отдаёт index.html — это «пакета нет», а не поломка.
      if (/^\s*</.test(text)) return { id, status: 'absent', pack: null };
      try {
        const manifest = parseManifest(JSON.parse(text));
        if (manifest.id !== id) console.warn(`Пакет района ${id}: в manifest.json id «${manifest.id}»`);
        return { id, status: 'installed', pack: { manifest, baseUrl } };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(`Пакет района ${id} не читается:`, error);
        return { id, status: 'broken', pack: null, error };
      }
    })();
    packs.set(id, p);
  }
  return p;
}

/** Пакет района или null. */
export async function packFor(id: string): Promise<LoadedPack | null> {
  return (await probePack(id)).pack;
}

/** Пакет активного района (выбранного в адресе или последним). Дождаться — до выбора источников. */
export async function activePack(): Promise<LoadedPack | null> {
  if (active === undefined) active = await packFor(activeRegion().id);
  return active;
}

/** То же без ожидания: null, пока activePack() не завершился или пакета нет. */
export function activePackNow(): LoadedPack | null {
  return active ?? null;
}

// --- рельеф ---

/** Запрос с повтором: сеть и серверы тайлов иногда отвечают ошибкой — пробуем ещё с растущей паузой. */
export async function fetchWithRetry(url: string, attempts = 4): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      last = new Error(`${url}: HTTP ${res.status}`);
      if (res.status === 404) break;
    } catch (e) {
      last = e;
    }
    await sleep(400 * 2 ** i);
  }
  throw last;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

async function hasMagic(blob: Blob, magic: number[]): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, magic.length).arrayBuffer());
  return magic.every((b, i) => head[i] === b);
}

async function terrainCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(TERRAIN_CACHE);
  } catch {
    return null;
  }
}

/** Откуда рельеф (z, x, y) будет взят сейчас: список по порядку. */
export function terrainSources(z: number, x: number, y: number) {
  return chooseSources({ inPack: layerCovers(activePackNow()?.manifest.terrain, z, x, y), offline: tileEnv().offline, persistentCache: true });
}

/**
 * PNG тайла высот Terrarium (z, x, y): из пакета, из кэша просмотренного или из сети (с повторами;
 * пришедшее — в кэш). Без сети и без тайла в пакете и кэше — исключение сразу, без ожидания.
 */
export async function terrainTile(z: number, x: number, y: number): Promise<{ blob: Blob; origin: 'pack' | 'cache' | 'net' }> {
  const url = TERRARIUM(z, x, y);
  let last: unknown = new Error(`Рельеф ${z}/${x}/${y}: нет ни в пакете района, ни в кэше, а сети нет`);
  for (const origin of terrainSources(z, x, y)) {
    try {
      if (origin === 'pack') {
        const res = await fetchWithin(`${activePackNow()!.baseUrl}terrain/${z}/${x}/${y}.png`, PACK_TIMEOUT_MS);
        const blob = res.ok ? await res.blob() : null;
        if (blob && (await hasMagic(blob, PNG_MAGIC))) return { blob, origin };
        last = new Error(`Рельеф ${z}/${x}/${y}: в пакете нет тайла`);
      } else if (origin === 'cache') {
        const hit = await (await terrainCache())?.match(url);
        if (hit) return { blob: await hit.blob(), origin };
      } else {
        const res = await fetchWithRetry(url);
        const blob = await res.blob();
        void terrainCache().then((c) => c?.put(url, new Response(blob, { headers: { 'Content-Type': 'image/png' } })).catch(() => undefined));
        return { blob, origin };
      }
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Сколько тайлов рельефа в кэше просмотренного; null — кэша нет (Cache API недоступен). */
export async function viewedCacheTiles(): Promise<number | null> {
  const c = await terrainCache();
  return c ? (await c.keys()).length : null;
}

/** Очистить кэш просмотренного рельефа. */
export async function clearViewedCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(TERRAIN_CACHE);
  } catch {
    // Нет Cache API — и чистить нечего.
  }
}

// --- снимки ---

export type ImageryOrigin = 'pack' | 'net' | 'saved';

/**
 * Откуда снимок (z, x, y): 'pack' — из пакета, 'net' — Esri по сети, 'saved' — сохранённый
 * Sentinel-2 (без сети), null — данных нет (без запросов).
 */
export function imagerySource(z: number, x: number, y: number): ImageryOrigin | null {
  const s = chooseSources({ inPack: layerCovers(activePackNow()?.manifest.imagery, z, x, y), offline: tileEnv().offline });
  if (s[0] === 'pack' || s[0] === 'net') return s[0];
  return z >= SAVED_MIN_ZOOM && z <= SAVED_MAX_ZOOM ? 'saved' : null;
}

/** Куда идти, если тайла не оказалось в пакете: в сеть, в сохранённые снимки или никуда. */
export function imageryFallback(z = SAVED_MAX_ZOOM): ImageryOrigin | null {
  return tileEnv().offline ? (z >= SAVED_MIN_ZOOM && z <= SAVED_MAX_ZOOM ? 'saved' : null) : 'net';
}

async function savedCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(SAVED_CACHE);
  } catch {
    return null;
  }
}

/** Сохранённый снимок Sentinel-2 (z, x, y) или null — не скачан. */
export async function savedImagery(z: number, x: number, y: number): Promise<Blob | null> {
  if (z < SAVED_MIN_ZOOM || z > SAVED_MAX_ZOOM) return null;
  const hit = await (await savedCache())?.match(S2_URL(z, x, y));
  return hit ? await hit.blob() : null;
}

/** Скачать снимок Sentinel-2 в постоянный кэш; fresh — скачан сейчас, bytes — его размер. */
export async function saveImageryTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<{ bytes: number; fresh: boolean }> {
  const c = await savedCache();
  if (!c) throw new Error('Cache API недоступен — сохранить снимки нельзя');
  const url = S2_URL(z, x, y);
  const hit = await c.match(url);
  if (hit) return { bytes: Number(hit.headers.get('Content-Length') ?? 0), fresh: false };
  const res = await fetch(url, signal ? { signal } : {});
  if (res.status === 404) return { bytes: 0, fresh: false };
  if (!res.ok) throw new Error(`Снимок ${z}/${x}/${y}: HTTP ${res.status}`);
  const blob = await res.blob();
  await c.put(url, new Response(blob, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(blob.size) } }));
  return { bytes: blob.size, fresh: true };
}

/** Есть ли снимок в кэше (без чтения). */
export async function hasSavedImagery(z: number, x: number, y: number): Promise<boolean> {
  return !!(await (await savedCache())?.match(S2_URL(z, x, y)));
}

/** Скачать тайл рельефа в кэш (для работы без сети); bytes — скачано сейчас (0 — уже был). */
export async function saveTerrainTile(z: number, x: number, y: number): Promise<number> {
  const c = await terrainCache();
  if (!c) throw new Error('Cache API недоступен — сохранить рельеф нельзя');
  const url = TERRARIUM(z, x, y);
  if (await c.match(url)) return 0;
  const blob = await (await fetchWithRetry(url, 3)).blob();
  if (!(await hasMagic(blob, PNG_MAGIC))) throw new Error(`Рельеф ${z}/${x}/${y}: не PNG`);
  await c.put(url, new Response(blob, { headers: { 'Content-Type': 'image/png' } }));
  return blob.size;
}

/** Есть ли тайл рельефа в кэше. */
export async function hasSavedTerrain(z: number, x: number, y: number): Promise<boolean> {
  return !!(await (await terrainCache())?.match(TERRARIUM(z, x, y)));
}

/** Удалить сохранённые снимки и рельеф (всё, что качалось для работы без сети). */
export async function clearSaved(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      await caches.delete(SAVED_CACHE);
      await caches.delete(TERRAIN_CACHE);
    }
  } catch {
    // Нечего чистить.
  }
}

export function packImageryUrl(z: number, x: number, y: number): string {
  return `${activePackNow()!.baseUrl}imagery/${z}/${x}/${y}.jpg`;
}

/** Уровни снимков пакета, если они есть. */
export function packImageryZooms(): { min: number; max: number } | null {
  const z = activePackNow()?.manifest.imagery?.zooms;
  return z?.length ? { min: z[0]!, max: z[z.length - 1]! } : null;
}

/** Есть ли у тайла пакета правильный JPEG (не страница ошибки). */
export const isJpeg = (blob: Blob) => hasMagic(blob, JPEG_MAGIC);

/** Подпись источников для карты и окна «Районы и карты». */
export function attribution(): { imagery: string | null; saved: string; terrain: string; osm: string } {
  const pack = activePackNow()?.manifest;
  const offline = tileEnv().offline;
  const packImagery = pack?.imagery ? `Снимки: ${pack.imagery.source} (${pack.imagery.license})` : null;
  const esri = 'Снимки © Esri, Maxar, Earthstar Geographics';
  return {
    imagery: offline ? packImagery : packImagery ? `${packImagery}; вне пакета — ${esri}` : esri,
    saved: `Снимки без сети: ${S2_ATTRIBUTION}`,
    terrain: 'Рельеф: AWS Terrain Tiles (SRTM и др.)',
    osm: '© участники OpenStreetMap (ODbL)',
  };
}

// --- OSM ---

/**
 * Адрес osm.bin района: из пакета, если он есть и в нём есть OSM, иначе прежний (файл, который
 * идёт с приложением). undefined — домов и дорог у района нет.
 */
export async function osmUrlFor(region: { id: string; osmUrl?: string }): Promise<string | undefined> {
  const pack = await packFor(region.id);
  if (pack?.manifest.osm) return `${pack.baseUrl}osm.bin`;
  return region.osmUrl;
}
