import { describe, expect, it } from 'vitest';
import {
  ancestorUv,
  hostIndex,
  isPlaceholderPixels,
  mayBePlaceholder,
  pickRequests,
  REQUESTS_PER_HOST,
  retryDelayMs,
  shouldSplit,
  tilePriority,
} from '../src/ui/tileSchedule';

/*
 * Планирование загрузки снимков рельефа (src/ui/tileSchedule.ts): выбор уровня, очерёдность,
 * очередь с лимитом на сервер, повтор при ошибке, снимок предка вместо недогруженного.
 */

describe('выбор уровня', () => {
  it('делит тайл, пока камера ближе split его размеров и есть уровень детальнее', () => {
    expect(shouldSplit(100, 200, 15, 18, 2.6)).toBe(true);
    expect(shouldSplit(600, 200, 15, 18, 2.6)).toBe(false);
    expect(shouldSplit(100, 200, 18, 18, 2.6)).toBe(false);
  });

  it('вдали сразу грубый уровень: вдвое дальше — на уровень грубее', () => {
    // Тайл уровня z — 40 км / 2^(z − 11); глубина — первый уровень, который уже не делится.
    const depth = (d: number) => {
      let z = 11;
      while (shouldSplit(d, 40_000 / 2 ** (z - 11), z, 18, 2.6)) z++;
      return z;
    };
    expect(depth(100)).toBe(18);
    expect(depth(2000)).toBe(17);
    expect(depth(4000)).toBe(16);
    expect(depth(8000)).toBe(15);
    expect(depth(20_000)).toBe(14);
  });
});

describe('очерёдность загрузки', () => {
  const base = { distanceM: 3000, sizeM: 1000, facing: 1, deficit: 1 };

  it('впереди — раньше, чем сбоку, сбоку — раньше, чем позади', () => {
    expect(tilePriority(base)).toBeLessThan(tilePriority({ ...base, facing: 0 }));
    expect(tilePriority({ ...base, facing: 0 })).toBeLessThan(tilePriority({ ...base, facing: -1 }));
  });

  it('под самой камерой направление не важно', () => {
    const under = { ...base, distanceM: 1000 };
    expect(tilePriority({ ...under, facing: -1 })).toBe(tilePriority(under));
  });

  it('важен угловой размер: крупный дальний тайл наравне с мелким ближним', () => {
    expect(tilePriority({ ...base, distanceM: 2000 })).toBeLessThan(tilePriority(base));
    expect(tilePriority({ ...base, distanceM: 12_000, sizeM: 4000 })).toBe(tilePriority(base));
  });

  it('где снимок на несколько уровней грубее — раньше; где пусто — прежде всего, даже позади', () => {
    expect(tilePriority({ ...base, deficit: 3 })).toBeLessThan(tilePriority(base));
    expect(tilePriority({ ...base, deficit: 10, facing: -1 })).toBeLessThan(tilePriority(base));
  });

  it('подгрузка вперёд уступает такому же тайлу, нужному сейчас, но не голодает', () => {
    for (const distanceM of [300, 3000, 8000]) {
      expect(tilePriority({ ...base, distanceM, prefetch: true })).toBeGreaterThan(tilePriority({ ...base, distanceM }));
    }
    // Тайл, над которым будем через несколько секунд, — раньше, чем нужный сейчас сбоку позади.
    expect(tilePriority({ ...base, distanceM: 0, prefetch: true })).toBeLessThan(tilePriority({ ...base, facing: -1 }));
  });
});

describe('очередь запросов', () => {
  const c = (item: string, priority: number, host = 0, notBefore = 0) => ({ item, priority, host, notBefore });

  it('по очерёдности и не больше лимита на сервер', () => {
    const got = pickRequests([c('a', 3), c('b', 1), c('c', 2), c('d', 0.5, 1), c('e', 4, 1)], [0, 0], 2, 0);
    expect(got.map((x) => x.item)).toEqual(['d', 'b', 'c', 'e']);
  });

  it('учитывает запросы, что уже идут', () => {
    const got = pickRequests([c('a', 1), c('b', 2, 1)], [REQUESTS_PER_HOST, REQUESTS_PER_HOST - 1], REQUESTS_PER_HOST, 0);
    expect(got.map((x) => x.item)).toEqual(['b']);
    expect(pickRequests([c('a', 1)], [6, 6], 6, 0)).toEqual([]);
  });

  it('после ошибки ждёт паузу, место в очереди отдаёт другим', () => {
    expect(pickRequests([c('a', 1, 0, 5000), c('b', 2)], [0], 6, 1000).map((x) => x.item)).toEqual(['b']);
    expect(pickRequests([c('a', 1, 0, 5000), c('b', 2)], [0], 6, 6000).map((x) => x.item)).toEqual(['a', 'b']);
  });
});

describe('повтор при ошибке', () => {
  it('пауза растёт вдвое и упирается в 30 с — не сдаёмся насовсем', () => {
    expect(retryDelayMs(1)).toBe(500);
    expect(retryDelayMs(2)).toBe(1000);
    expect(retryDelayMs(4)).toBe(4000);
    expect(retryDelayMs(50)).toBe(30_000);
  });

  it('разброс ±20 %, чтобы соседние тайлы не шли пачкой', () => {
    expect(retryDelayMs(3, 0)).toBeCloseTo(1600);
    expect(retryDelayMs(3, 1)).toBeCloseTo(2400);
  });
});

describe('два сервера снимков', () => {
  it('у тайла всегда один сервер (кэш браузера), соседи — поровну', () => {
    expect(hostIndex(10, 20, 2)).toBe(hostIndex(10, 20, 2));
    const counts = [0, 0];
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) counts[hostIndex(x, y, 2)]!++;
    expect(counts).toEqual([32, 32]);
  });
});

describe('снимок предка, пока свой грузится', () => {
  it('свой тайл — без сдвига', () => {
    expect(ancestorUv(15, 3, 5, 15, 3, 5)).toEqual({ scale: 1, offsetU: 0, offsetV: 0 });
  });

  it('четверти родителя: x — вправо, y — вниз, v — снизу вверх', () => {
    // Родитель (14, 10, 20); северо-западная четверть — верх-лево снимка, юго-восточная — низ-право.
    expect(ancestorUv(15, 20, 40, 14, 10, 20)).toEqual({ scale: 0.5, offsetU: 0, offsetV: 0.5 });
    expect(ancestorUv(15, 21, 41, 14, 10, 20)).toEqual({ scale: 0.5, offsetU: 0.5, offsetV: 0 });
  });

  it('через три уровня — участок в 1/8 стороны', () => {
    expect(ancestorUv(18, 5 * 8 + 7, 9 * 8, 15, 5, 9)).toEqual({ scale: 0.125, offsetU: 0.875, offsetV: 0.875 });
  });
});

describe('заглушка «нет снимков на этом масштабе»', () => {
  const fill = (r: number, g: number, b: number, pixels = 256) => Array.from({ length: pixels * 4 }, (_, i) => [r, g, b, 255][i % 4]!);

  it('ровно-серая — заглушка', () => {
    expect(isPlaceholderPixels(fill(204, 204, 204))).toBe(true);
  });

  it('снег, ледник, облака — настоящий снимок', () => {
    expect(isPlaceholderPixels(fill(255, 255, 255))).toBe(false);
    expect(isPlaceholderPixels(fill(196, 202, 190))).toBe(false);
  });

  it('хоть один непохожий пиксель — настоящий снимок', () => {
    const p = fill(204, 204, 204);
    p[p.length - 4] = 230;
    expect(isPlaceholderPixels(p)).toBe(false);
    expect(isPlaceholderPixels([])).toBe(false);
  });

  it('пиксели проверяем только у маленьких файлов', () => {
    expect(mayBePlaceholder(2521)).toBe(true);
    expect(mayBePlaceholder(1099)).toBe(true);
    expect(mayBePlaceholder(14_264)).toBe(false);
  });
});
