import { fillVoids, GridTerrain, mercatorPixel } from '../sim/terrain';
import type { PackBounds } from './packFormat';
import { activePack, fetchWithRetry, terrainTile, tileEnv } from './tileSource';

/* Тайлы высот Terrarium (Mapzen / AWS Open Data): высота = R·256 + G + B/256 − 32768. Откуда
 * брать тайл — пакет района, кэш просмотренного или сеть — решает tileSource.ts. */

export type Bounds = PackBounds;
export { expandBounds } from './packFormat';
export { fetchWithRetry };

/** Высоты тайла Terrarium 256×256 из PNG, м, строками сверху вниз. */
export async function decodeTerrarium(blob: Blob): Promise<Float32Array> {
  // Цвета здесь — закодированные числа: никакой цветокоррекции при декодировании.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4]! * 256 + data[i * 4 + 1]! + data[i * 4 + 2]! / 256 - 32768;
  return out;
}

/** Сетка высот для области на уровне zoom (z12 ≈ 22 м на пиксель на 55° с. ш.). */
export async function loadTerrain(b: Bounds, zoom = 12, onProgress?: (done: number, total: number) => void): Promise<GridTerrain> {
  // Сначала — есть ли пакет района: от него зависит, откуда брать тайлы.
  const pack = await activePack();
  const nw = mercatorPixel({ lat: b.north, lon: b.west }, zoom);
  const se = mercatorPixel({ lat: b.south, lon: b.east }, zoom);
  const tx0 = Math.floor(nw.x / 256);
  const ty0 = Math.floor(nw.y / 256);
  const cols = Math.floor(se.x / 256) - tx0 + 1;
  const rows = Math.floor(se.y / 256) - ty0 + 1;
  const width = cols * 256;
  const heights = new Float32Array(width * rows * 256);
  let done = 0;
  let failed = 0;
  const origins = { pack: 0, cache: 0, net: 0 };
  const tiles: [number, number][] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) tiles.push([i, j]);
  await Promise.all(
    tiles.map(async ([i, j]) => {
      let h: Float32Array;
      try {
        const t = await terrainTile(zoom, tx0 + i, ty0 + j);
        h = await decodeTerrarium(t.blob);
        if (h.length !== 256 * 256) throw new Error(`тайл ${zoom}/${tx0 + i}/${ty0 + j} не 256×256`);
        origins[t.origin]++;
      } catch (e) {
        // Тайл так и не пришёл — его клетки станут пустотой и заполнятся по соседям (fillVoids).
        if (!tileEnv().offline) console.warn('Тайл рельефа не загрузился:', e);
        failed++;
        for (let y = 0; y < 256; y++) heights.fill(-1e4, (j * 256 + y) * width + i * 256, (j * 256 + y) * width + i * 256 + 256);
        onProgress?.(++done, tiles.length);
        return;
      }
      for (let y = 0; y < 256; y++) heights.set(h.subarray(y * 256, y * 256 + 256), (j * 256 + y) * width + i * 256);
      onProgress?.(++done, tiles.length);
    }),
  );
  console.info(`Рельеф: ${tiles.length} тайлов — из пакета ${origins.pack}, из кэша ${origins.cache}, из сети ${origins.net}, нет данных ${failed}`);
  if (failed === tiles.length) {
    const env = tileEnv();
    throw new Error(
      !env.offline
        ? 'Рельеф не загрузился — проверьте подключение к интернету'
        : pack
          ? 'Без сети: в пакете района нет рельефа этой области — пересоберите пакет'
          : 'Без сети: пакета этого района нет, а рельеф раньше не просматривался — установите пакет района',
    );
  }
  if (failed > 0 && tileEnv().offline) console.warn(`Без сети: рельефа нет для ${failed} из ${tiles.length} тайлов — там высоты достроены по соседним`);
  const voids = fillVoids(heights, width, rows * 256);
  if (voids > 0) console.info(`Рельеф: заполнено пустот в данных — ${voids} клеток`);
  return new GridTerrain(heights, width, rows * 256, zoom, tx0 * 256, ty0 * 256);
}
