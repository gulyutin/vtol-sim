/*
 * Скачать район для работы без сети (в браузере): рельеф уровня сетки — в кэш рельефа, снимки
 * Sentinel-2 cloudless 2017 (EOX, CC BY 4.0) z8–14 — в кэш снимков, файл домов и леса (OSM) —
 * через сервис-воркер в кэш приложения. Всё хранится в Cache API браузера до очистки; уже
 * скачанное не качается повторно. Снимки Esri и тайлы OSM не сохраняются — лицензии не позволяют.
 */
import { REGION_PRESETS, LOG_REGION_ID, type RegionPreset } from '../game/regions';
import { offlinePlan } from './packFormat';
import { hasSavedImagery, hasSavedTerrain, osmUrlFor, saveImageryTile, saveTerrainTile, SAVED_MAX_ZOOM, SAVED_MIN_ZOOM, tileEnv } from './tileSource';

export interface DownloadProgress {
  region: string;
  done: number;
  total: number;
  /** Скачано сейчас, байт (уже сохранённое не считается). */
  bytes: number;
  failed: number;
}

const ZOOMS = Array.from({ length: SAVED_MAX_ZOOM - SAVED_MIN_ZOOM + 1 }, (_, i) => SAVED_MIN_ZOOM + i);
const CONCURRENCY = 4;

/** Районы, которые можно скачать (без «места из журнала»: у него нет своей области). */
export const downloadableRegions = (): RegionPreset[] => REGION_PRESETS.filter((r) => r.id !== LOG_REGION_ID);

/** Сколько тайлов и примерно байт у района. */
export function regionPlan(r: RegionPreset) {
  return offlinePlan(r.location.region, ZOOMS);
}

/** Сколько тайлов района уже сохранено (проверка по кэшу, без сети). */
export async function regionSaved(r: RegionPreset): Promise<{ have: number; total: number }> {
  const p = regionPlan(r);
  const checks = await Promise.all([...p.terrain.map(([z, x, y]) => hasSavedTerrain(z, x, y)), ...p.imagery.map(([z, x, y]) => hasSavedImagery(z, x, y))]);
  return { have: checks.filter(Boolean).length, total: checks.length };
}

/** Скачать район; повторный вызов докачивает недостающее. Прерывание — signal. */
export async function downloadRegion(r: RegionPreset, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<DownloadProgress> {
  if (tileEnv().offline) throw new Error('нет сети');
  const plan = regionPlan(r);
  const jobs: (() => Promise<number>)[] = [
    ...plan.terrain.map(([z, x, y]) => () => saveTerrainTile(z, x, y)),
    ...plan.imagery.map(([z, x, y]) => async () => (await saveImageryTile(z, x, y, signal)).bytes),
  ];
  const osm = await osmUrlFor(r);
  if (osm)
    jobs.push(async () => {
      const res = await fetch(osm, signal ? { signal } : {});
      return res.ok ? (await res.arrayBuffer()).byteLength : 0;
    });
  const p: DownloadProgress = { region: r.title, done: 0, total: jobs.length, bytes: 0, failed: 0 };
  onProgress({ ...p });
  let next = 0;
  let lastReport = 0;
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) {
      const job = jobs[next++]!;
      try {
        p.bytes += await job();
      } catch {
        if (signal?.aborted) return;
        p.failed++;
      }
      p.done++;
      const now = performance.now();
      if (now - lastReport > 150 || p.done === p.total) {
        lastReport = now;
        onProgress({ ...p });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return p;
}

/** Место, занятое сайтом, и квота браузера, байт; null — браузер не сообщает. */
export async function storageUse(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    const s = navigator.storage;
    if (!s?.estimate) return null;
    const e = await s.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await s.persisted?.()) ?? false };
  } catch {
    return null;
  }
}

/** Попросить браузер не вытирать сохранённое при нехватке места. */
export async function askPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Докачивать открытый район в фоне (по умолчанию — да). */
const AUTO_KEY = 'vtol-offline-auto';
export function autoDownload(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0';
  } catch {
    return false;
  }
}
export function setAutoDownload(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0');
  } catch {
    // Без localStorage — только на этот сеанс.
  }
}

export interface OfflineState {
  running: boolean;
  /** Идёт сейчас. */
  progress: DownloadProgress | null;
  /** Районы в очереди после текущего. */
  queued: string[];
  /** Последний законченный: итог или ошибка. */
  last: { region: string; ok: boolean; text: string } | null;
}

/** Очередь загрузок районов — одна на страницу: её показывает окно, в неё же ставит фоновая докачка. */
class OfflineQueue {
  readonly state: OfflineState = { running: false, progress: null, queued: [], last: null };
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private readonly pending: RegionPreset[] = [];

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.state.queued = this.pending.map((r) => r.title);
    for (const fn of this.listeners) fn();
  }

  /** Поставить районы в очередь (уже стоящие не повторяются). */
  add(regions: RegionPreset[]): void {
    for (const r of regions) if (!this.pending.includes(r) && this.state.progress?.region !== r.title) this.pending.push(r);
    this.emit();
    if (!this.state.running) void this.run();
  }

  cancel(): void {
    this.pending.length = 0;
    this.abort?.abort();
    this.emit();
  }

  private async run() {
    this.state.running = true;
    void askPersist();
    while (this.pending.length) {
      const r = this.pending.shift()!;
      this.abort = new AbortController();
      const signal = this.abort.signal;
      try {
        const p = await downloadRegion(
          r,
          (p) => {
            this.state.progress = p;
            this.emit();
          },
          signal,
        );
        this.state.last = signal.aborted
          ? { region: r.title, ok: false, text: 'остановлено — докачается при следующем запуске' }
          : { region: r.title, ok: p.failed === 0, text: p.failed ? `готово, но ${p.failed} из ${p.total} не скачались — повторите` : `готово${p.bytes ? `, скачано ${(p.bytes / 1e6).toFixed(1).replace('.', ',')} МБ` : ', всё уже было сохранено'}` };
      } catch (e) {
        this.state.last = { region: r.title, ok: false, text: e instanceof Error ? e.message : String(e) };
      }
      this.state.progress = null;
      this.emit();
      if (signal.aborted) break;
    }
    this.abort = null;
    this.state.running = false;
    this.emit();
  }
}

export const offlineQueue = new OfflineQueue();
