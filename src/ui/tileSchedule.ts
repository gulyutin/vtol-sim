/*
 * Планирование загрузки тайлов снимков: выбор уровня, порядок загрузки, ограничение одновременных
 * запросов на сервер, повтор при ошибке и показ участка тайла на снимке предка, пока свой не пришёл.
 * Без DOM и three.js — проверяется тестами (tests/tileSchedule.test.ts).
 */

/**
 * Серверы снимков отвечают по HTTP/1.1: браузер держит не больше шести соединений на домен,
 * лишние запросы стоят в его очереди и занимают наши места впустую.
 */
export const REQUESTS_PER_HOST = 6;

/** Делить ли тайл на четыре: камера ближе split его размеров и есть уровень детальнее. */
export function shouldSplit(distanceM: number, sizeM: number, z: number, maxZoom: number, split: number): boolean {
  return z < maxZoom && distanceM < split * sizeM;
}

export interface PriorityInput {
  /** От камеры до центра тайла, м. */
  distanceM: number;
  sizeM: number;
  /** Косинус угла между взглядом (или курсом) и направлением на тайл: 1 — прямо впереди, −1 — позади. */
  facing: number;
  /**
   * На сколько уровней грубее снимок, который сейчас лежит на месте тайла: 1 — родительский,
   * 2 — «дедушкин»… Если не лежит ничего — большое число.
   */
  deficit: number;
  /** Тайл нужен не сейчас, а впереди по курсу. */
  prefetch?: boolean;
}

/**
 * Очерёдность загрузки: меньше — раньше.
 * - Основа — расстояние в размерах тайла, то есть угловой размер на экране: у всех уровней
 *   квадродерева она одного порядка, 0…2·split.
 * - Что позади и сбоку взгляда — позже (до ×3,25 прямо сзади); под самой камерой направление не важно.
 * - Где сейчас лежит снимок на несколько уровней грубее — раньше: сначала всё поле зрения
 *   получает приличную картинку, потом доводится до полной детальности.
 * - Подгрузка впереди по курсу уступает такому же тайлу, нужному на экране сейчас, но не ждёт,
 *   пока очередь опустеет: при быстром полёте она не пустеет никогда.
 */
export function tilePriority(p: PriorityInput): number {
  const base = p.distanceM / p.sizeM;
  const near = p.distanceM < 1.5 * p.sizeM;
  const view = near || p.facing >= 0.5 ? 1 : 1 + (0.5 - p.facing) * 1.5;
  const q = (base * view) / Math.max(1, p.deficit);
  return p.prefetch ? q * 2 + 1 : q;
}

/**
 * Пауза перед повтором после tries неудач подряд, мс: 0,5 · 1 · 2 · 4 … не больше 30 с.
 * Сдаваться насовсем нельзя: сеть восстановится, а дыра в снимках останется до перезагрузки.
 * jitter 0…1 разносит повторы соседних тайлов, чтобы они не шли пачкой.
 */
export function retryDelayMs(tries: number, jitter = 0.5): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, tries - 1)) * (0.8 + 0.4 * jitter);
}

/** Сервер для тайла. Выбор постоянный: у одного и того же тайла один адрес — работает кэш браузера. */
export function hostIndex(x: number, y: number, hosts: number): number {
  return (((x + y) % hosts) + hosts) % hosts;
}

export interface Candidate<T> {
  item: T;
  priority: number;
  host: number;
  /** Раньше этого времени не запрашивать (пауза после ошибки). */
  notBefore: number;
}

/**
 * Какие запросы начать сейчас: по возрастанию priority, не больше perHost одновременных
 * на каждый сервер, без тех, чья пауза после ошибки ещё не кончилась.
 */
export function pickRequests<T>(candidates: readonly Candidate<T>[], inflight: readonly number[], perHost: number, now: number): Candidate<T>[] {
  const free = inflight.map((n) => Math.max(0, perHost - n));
  let left = free.reduce((s, f) => s + f, 0);
  const out: Candidate<T>[] = [];
  if (left === 0) return out;
  const ready = candidates.filter((c) => c.notBefore <= now).sort((a, b) => a.priority - b.priority);
  for (const c of ready) {
    if ((free[c.host] ?? 0) === 0) continue;
    free[c.host]!--;
    out.push(c);
    if (--left === 0) break;
  }
  return out;
}

/**
 * Где участок тайла (z, x, y) лежит на снимке предка (za, xa, ya): u' = offsetU + u·scale,
 * v' = offsetV + v·scale. Координата v — снизу вверх (снимок переворачивается при декодировании).
 */
export function ancestorUv(z: number, x: number, y: number, za: number, xa: number, ya: number): { scale: number; offsetU: number; offsetV: number } {
  const k = 2 ** (z - za);
  const scale = 1 / k;
  return { scale, offsetU: (x - xa * k) * scale, offsetV: 1 - (y - ya * k) * scale - scale };
}

/**
 * На масштабах, где снимков нет, сервер отдаёт заглушку «Map data not yet available» —
 * ровно-серый JPEG (~2,5 КБ) с белой надписью посередине. Настоящие тайлы обычно крупнее,
 * но ледники, снег и облака тоже сжимаются в 1–3 КБ — по размеру только отбираем, кого проверить.
 */
export function mayBePlaceholder(bytes: number): boolean {
  return bytes < 4000;
}

/**
 * Заглушка ли это — по пикселям углов снимка (RGBA подряд): у заглушки все ровно серые (204, 204, 204).
 * Снег и облака — белые (255) или с оттенком, их показываем.
 */
export function isPlaceholderPixels(rgba: ArrayLike<number>): boolean {
  if (rgba.length < 4) return false;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    if (Math.abs(rgba[i]! - 204) > 3 || Math.abs(rgba[i + 1]! - 204) > 3 || Math.abs(rgba[i + 2]! - 204) > 3) return false;
  }
  return true;
}
