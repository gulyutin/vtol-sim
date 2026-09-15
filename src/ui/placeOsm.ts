import { buildOsm, createOverpass, encodeOsm, OSM_BUILD_VERSION, OVERPASS_ENDPOINTS, type OverpassTransport } from '../sim/osmBuild';
import type { GeoPoint } from '../sim/types';

/*
 * Дома, лес, дороги и вода для места без готового osm.bin — места полёта из журнала. Собираются
 * в браузере из Overpass API тем же кодом, что scripts/fetch-osm.mjs (src/sim/osmBuild.ts), и
 * хранятся в IndexedDB: повторно место открывается без сети. База своя (vtol-sim-osm): у журналов
 * и пакетов районов свои, со своими версиями.
 *
 * С траекторией (площадка, точки маршрута, пункт назначения) — только коридор вокруг неё: у
 * длинного перелёта не тянутся леса и дороги всего прямоугольника (CORRIDOR в osmBuild.ts).
 * Запросы — по очереди, с паузой и повторами, как у скрипта. User-Agent браузер задать не даёт.
 */

export interface PlaceOsmRequest {
  site: GeoPoint;
  bounds: { south: number; west: number; north: number; east: number };
  track?: GeoPoint[];
}

const DB = 'vtol-sim-osm';
const STORE = 'places';
/** Мест в кэше не больше: самые давние удаляются. Место — от сотен килобайт до мегабайтов. */
const KEEP = 12;
/** Тайм-аут одной попытки, мс: запрос с [timeout:240] сервер может держать долго, ответ — мегабайты. */
const ATTEMPT_TIMEOUT_MS = 300_000;
/** Короче не бывает: сигнатура и шесть счётчиков. */
const MIN_BYTES = 28;

interface Entry {
  key: string;
  savedAt: number;
  bytes: ArrayBuffer;
}

const round = (v: number, k: number) => Math.round(v * k) / k;
/**
 * Запрос для ключа и для сборки — одинаковый: площадка — до 1e-6° (от неё локальные координаты,
 * сдвиг меньше 0,1 м), область и траектория — до 1e-4° (~10 м; коридор — километры).
 */
function normalize(req: PlaceOsmRequest): PlaceOsmRequest {
  const b = req.bounds;
  return {
    site: { lat: round(req.site.lat, 1e6), lon: round(req.site.lon, 1e6) },
    bounds: { south: round(b.south, 1e4), west: round(b.west, 1e4), north: round(b.north, 1e4), east: round(b.east, 1e4) },
    ...(req.track?.length ? { track: req.track.map((p) => ({ lat: round(p.lat, 1e4), lon: round(p.lon, 1e4) })) } : {}),
  };
}
const keyOf = (n: PlaceOsmRequest) =>
  `v${OSM_BUILD_VERSION}|${n.site.lat},${n.site.lon}|${n.bounds.south},${n.bounds.west},${n.bounds.north},${n.bounds.east}|${(n.track ?? []).map((p) => `${p.lat},${p.lon}`).join(';')}`;

/** Ключ кэша места (округлённый запрос). */
export const placeOsmKey = (req: PlaceOsmRequest): string => keyOf(normalize(req));

// --- IndexedDB ---

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Хранилище браузера (IndexedDB) недоступно'));
  });
}

async function readCached(key: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  try {
    const entry = await new Promise<Entry | undefined>((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as Entry | undefined);
      r.onerror = () => reject(r.error ?? new Error('Хранилище браузера: чтение не удалось'));
    });
    return entry && entry.bytes instanceof ArrayBuffer && entry.bytes.byteLength >= MIN_BYTES ? entry.bytes : null;
  } finally {
    db.close();
  }
}

async function save(key: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const s = tx.objectStore(STORE);
      const entry: Entry = { key, savedAt: Date.now(), bytes };
      s.put(entry);
      // Сверх KEEP — удалить самые давние (новое место — последнее по времени).
      const count = s.count();
      count.onsuccess = () => {
        let extra = count.result - KEEP;
        if (extra <= 0) return;
        const cur = s.index('savedAt').openKeyCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || extra-- <= 0) return;
          s.delete(c.primaryKey);
          c.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Хранилище браузера: запись не удалась'));
    });
  } finally {
    db.close();
  }
}

// --- сеть ---

// --- ответы Overpass: сборка продолжается после сбоя или перезагрузки ---

/**
 * Ответы на запросы сборки, пока место не собрано целиком, — как папка --cache у скрипта: публичный
 * сервер бывает перегружен, и сборка идёт минутами. Отдельная база: у мест своя, со своей версией.
 */
const QDB = 'vtol-sim-osm-queries';
const QSTORE = 'answers';

function openQueries(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(QSTORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Хранилище браузера (IndexedDB) недоступно'));
  });
}

async function answers<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openQueries();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(QSTORE, mode);
      const r = fn(tx.objectStore(QSTORE));
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Хранилище браузера: ошибка'));
    });
  } finally {
    db.close();
  }
}
/** Ключ — сам текст запроса. Без хранилища сборка просто идёт из сети. */
const savedAnswer = (query: string) => answers<string | undefined>('readonly', (s) => s.get(query) as IDBRequest<string | undefined>).catch(() => undefined);
const saveAnswer = (query: string, text: string) => answers('readwrite', (s) => s.put(text, query)).catch(() => undefined);
const clearAnswers = () => answers('readwrite', (s) => s.clear()).catch(() => undefined);
/** Ответ 200 с ошибкой выполнения сервера — не сохранять: его повторят. */
const failedAnswer = (text: string) => /"remark"\s*:\s*"[^"]*(runtime error|timed out|out of memory)/i.test(text);

/** Проба сервера Overpass перед сборкой, мс: молчащее зеркало иначе держит запрос до тайм-аута. */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Какие серверы Overpass отвечают: запрос состояния ко всем сразу, без CORS — важно лишь, ответил ли
 * сервер. Пусто — не ответил никто; тогда запросы идут, как без пробы.
 */
async function aliveEndpoints(signal?: AbortSignal): Promise<string[]> {
  const probe = async (url: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      await fetch(url.replace(/\/interpreter$/, '/status'), { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const ok = await Promise.all(OVERPASS_ENDPOINTS.map(probe));
  return OVERPASS_ENDPOINTS.filter((_, i) => ok[i]);
}

function browserTransport(signal?: AbortSignal): OverpassTransport {
  const reason = (): unknown => signal?.reason ?? new DOMException('Сборка отменена', 'AbortError');
  // Серверы, ответившие на пробу: запрос к молчащему уходит на отвечающий, а сервер, не ответивший
  // на запрос, выбывает до конца сборки, если остаются другие.
  let alive: Promise<string[]> | null = null;
  return {
    async post(url, body) {
      // Уже отвеченный запрос (сборка прервалась раньше) — из хранилища, без сервера.
      const saved = await savedAnswer(body);
      if (saved !== undefined) return { status: 200, json: async () => JSON.parse(saved) as unknown };
      alive ??= aliveEndpoints(signal);
      const live = await alive;
      const target = live.length && !live.includes(url) ? live[0]! : url;
      const ctl = new AbortController();
      const onAbort = () => ctl.abort(reason());
      const timer = setTimeout(() => ctl.abort(new DOMException('Overpass не ответил вовремя', 'TimeoutError')), ATTEMPT_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort);
      if (signal?.aborted) onAbort();
      try {
        // Content-Type и Accept — простые заголовки: запрос без предварительного OPTIONS.
        const res = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: ctl.signal });
        // Тело читается здесь же — под тем же тайм-аутом и отменой.
        const text = res.ok ? await res.text() : '';
        if (res.ok && !failedAnswer(text)) await saveAnswer(body, text);
        if (!res.ok) void res.body?.cancel().catch(() => undefined);
        return { status: res.status, json: async () => JSON.parse(text) as unknown };
      } catch (e) {
        if (!signal?.aborted && live.length > 1 && live.includes(target)) live.splice(live.indexOf(target), 1);
        throw e;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
    sleep: (ms) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(reason());
        const stop = () => {
          clearTimeout(timer);
          reject(reason());
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', stop);
          resolve();
        }, ms);
        signal?.addEventListener('abort', stop, { once: true });
      }),
    warn: (m) => console.warn(`Дома и лес места: ${m.trim()}`),
    aborted: () => !!signal?.aborted,
  };
}

/** Радиус домов вокруг площадки для места полёта, м — как полоса домов у траектории (CORRIDOR.buildingsBufferM). */
const PLACE_BUILDINGS_RADIUS_M = 3000;

/** Дома, лес, дороги и вода места: из кэша браузера или собрать из Overpass. Байты — формат osm.bin (parseOsm). */
export async function placeOsm(
  req: PlaceOsmRequest,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number, label: string) => void } = {},
): Promise<ArrayBuffer> {
  const { signal, onProgress } = opts;
  signal?.throwIfAborted();
  const n = normalize(req);
  const key = keyOf(n);
  try {
    const hit = await readCached(key);
    if (hit) return hit;
  } catch (e) {
    console.warn('Кэш домов и леса в браузере недоступен — собираю из сети:', e);
  }
  signal?.throwIfAborted();
  // Место полёта: дома — только в коридоре у траектории (она начинается на площадке), без
  // квадратов по 14 км вокруг площадки, как у районов: с публичного сервера это минуты лишнего ожидания.
  const opts2 = n.track?.length ? { ...n, buildingsRadiusM: PLACE_BUILDINGS_RADIUS_M } : n;
  // Попыток больше, чем у скрипта: публичный сервер бывает перегружен, а полученные ответы не пропадут.
  const { data } = await buildOsm(opts2, createOverpass({ ...browserTransport(signal), attempts: 12 }), onProgress);
  const { bytes } = encodeOsm(data);
  try {
    await save(key, bytes.buffer);
    // Место собрано — промежуточные ответы больше не нужны.
    void clearAnswers();
  } catch (e) {
    console.warn('Дома и лес не сохранились в браузере — в следующий раз соберутся снова:', e);
  }
  return bytes.buffer;
}
