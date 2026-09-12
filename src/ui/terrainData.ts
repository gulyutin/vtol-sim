import { fillVoids, GridTerrain, mercatorPixel } from '../sim/terrain';

/** Тайлы высот Terrarium (Mapzen / AWS Open Data): высота = R·256 + G + B/256 − 32768. */
const terrariumUrl = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Границы, расширенные на marginM метров во все стороны. */
export function expandBounds(b: Bounds, marginM: number): Bounds {
  const dLat = marginM / 111_195;
  const dLon = marginM / (111_195 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLon, east: b.east + dLon };
}

async function pixels(url: string): Promise<Uint8ClampedArray> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // Цвета здесь — закодированные числа: никакой цветокоррекции при декодировании.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/** Сетка высот для области на уровне zoom (z12 ≈ 22 м на пиксель на 55° с. ш.). */
export async function loadTerrain(b: Bounds, zoom = 12, onProgress?: (done: number, total: number) => void): Promise<GridTerrain> {
  const nw = mercatorPixel({ lat: b.north, lon: b.west }, zoom);
  const se = mercatorPixel({ lat: b.south, lon: b.east }, zoom);
  const tx0 = Math.floor(nw.x / 256);
  const ty0 = Math.floor(nw.y / 256);
  const cols = Math.floor(se.x / 256) - tx0 + 1;
  const rows = Math.floor(se.y / 256) - ty0 + 1;
  const width = cols * 256;
  const heights = new Float32Array(width * rows * 256);
  let done = 0;
  const tiles: [number, number][] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) tiles.push([i, j]);
  await Promise.all(
    tiles.map(async ([i, j]) => {
      const data = await pixels(terrariumUrl(zoom, tx0 + i, ty0 + j));
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const k = (y * 256 + x) * 4;
          heights[(j * 256 + y) * width + i * 256 + x] = data[k]! * 256 + data[k + 1]! + data[k + 2]! / 256 - 32768;
        }
      }
      onProgress?.(++done, tiles.length);
    }),
  );
  const voids = fillVoids(heights, width, rows * 256);
  if (voids > 0) console.info(`Рельеф: заполнено пустот в данных — ${voids} клеток`);
  return new GridTerrain(heights, width, rows * 256, zoom, tx0 * 256, ty0 * 256);
}
