/*
 * Окраска рельефа без снимков — по высоте и крутизне склона: низины — приглушённая зелень,
 * выше — бурое и серое, крутые склоны — скала, выше 3,5 км — снег. Одна и та же для 3D
 * (цвета вершин) и 2D-карты (тонированный рельеф с отмывкой). Без DOM.
 */

/** Высота, м → цвет sRGB 0…255. Приглушённо: это земля под светом сцены, а не легенда карты. */
const STOPS: readonly [number, number, number, number][] = [
  [-200, 88, 106, 82],
  [0, 96, 114, 84],
  [200, 108, 122, 86],
  [500, 128, 130, 94],
  [900, 146, 138, 108],
  [1400, 154, 146, 128],
  [2200, 158, 154, 146],
  [3200, 190, 190, 188],
  [3800, 232, 234, 238],
];
const ROCK: readonly [number, number, number] = [124, 119, 112];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Цвет рельефа: высота над морем, м, и уклон — модуль градиента высоты, м/м (0 — ровно, 1 — 45°).
 * out — массив [r, g, b] 0…255 (sRGB); возвращается он же.
 */
export function reliefRgb(elevationM: number, slope: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  let i = 0;
  while (i < STOPS.length - 2 && elevationM > STOPS[i + 1]![0]) i++;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  const t = Math.max(0, Math.min(1, (elevationM - a[0]) / (b[0] - a[0])));
  // Круче ~25° — скала; снег на крутизне не держится.
  const snow = smooth(3200, 3800, elevationM);
  const rock = smooth(0.45, 1.0, slope) * (1 - 0.6 * snow);
  for (let k = 0; k < 3; k++) {
    const base = a[k + 1]! + (b[k + 1]! - a[k + 1]!) * t;
    out[k] = base + (ROCK[k]! - base) * rock;
  }
  return out;
}

/**
 * Отмывка: освещённость склона светом с северо-запада под 45°, 0…1 (ровное место — ≈0,71).
 * dzdx — уклон на восток, dzdy — на юг, м/м.
 */
export function hillshade(dzdx: number, dzdy: number): number {
  // Свет с азимута 315° (северо-запад), высота 45°: вектор (−0,5; +0,5 на север; 0,707 вверх).
  const nx = -dzdx;
  const ny = dzdy; // на север
  const nz = 1;
  const len = Math.hypot(nx, ny, nz);
  const l = (nx * -0.5 + ny * 0.5 + nz * Math.SQRT1_2) / len;
  return Math.max(0, l);
}

/** Шаг горизонталей на карте по уровню zoom, м. */
export function contourStepM(zoom: number): number {
  return zoom >= 15 ? 20 : zoom >= 13 ? 50 : zoom >= 11 ? 100 : 200;
}
