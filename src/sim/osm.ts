/*
 * Данные OpenStreetMap для 3D-вида: дома, леса, взлётные полосы. Координаты — локальные метры
 * относительно площадки профиля (восток, север), как toLocal(site, p).
 *
 * Хранятся в двоичном файле профиля (osm.bin; пишет scripts/fetch-osm.mjs), little-endian:
 *   'OSM1'                        магия, 4 байта
 *   u32 buildings, u32 forests, u32 runways
 *   здание:  u8 kind, u16 высота в дм, u16 n, n × (i32 восток в дм, i32 север в дм)
 *   лес:     u8 leaf, u16 колец, по кольцу: u32 n, n × (i32, i32) — первое внешнее, дальше дыры
 *   полоса:  u16 ширина в дм, u8 paved (1 — твёрдое покрытие), u16 n, n × (i32, i32) — осевая
 * Кольца без повтора первой точки. Двоичный формат — ещё и чтобы тысячи чисел координат не
 * давали ложных совпадений в проверке публичной копии.
 */

export type BuildingKind = 'house' | 'apartments' | 'industrial' | 'other';
export type LeafType = 'needle' | 'broad' | 'mixed';

export interface OsmBuilding {
  kind: BuildingKind;
  /** Высота до карниза, м. */
  heightM: number;
  /** Внешнее кольцо [e0, n0, e1, n1, …], м. */
  ring: Float32Array;
}

export interface OsmForest {
  leaf: LeafType;
  /** Внешнее кольцо и дыры (поляны, посёлки внутри леса). */
  rings: Float32Array[];
}

export interface OsmRunway {
  widthM: number;
  paved: boolean;
  /** Осевая линия [e0, n0, e1, n1, …], м. */
  line: Float32Array;
}

export interface OsmData {
  buildings: OsmBuilding[];
  forests: OsmForest[];
  runways: OsmRunway[];
}

export const BUILDING_KINDS: readonly BuildingKind[] = ['house', 'apartments', 'industrial', 'other'];
export const LEAF_TYPES: readonly LeafType[] = ['needle', 'broad', 'mixed'];

/** Разбор osm.bin (формат — в начале файла). Неверная сигнатура или обрезанный файл — исключение. */
export function parseOsm(buf: ArrayBuffer): OsmData {
  const dv = new DataView(buf);
  let o = 0;
  const need = (bytes: number) => {
    if (o + bytes > dv.byteLength) throw new Error(`osm.bin обрезан: нужно ${o + bytes} байт, есть ${dv.byteLength}`);
  };
  need(16);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'OSM1') throw new Error('osm.bin: неверная сигнатура');
  const nb = dv.getUint32(4, true);
  const nf = dv.getUint32(8, true);
  const nr = dv.getUint32(12, true);
  o = 16;
  /** n точек (i32 дм) → метры. */
  const points = (n: number): Float32Array => {
    need(n * 8);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) out[i] = dv.getInt32(o + i * 4, true) / 10;
    o += n * 8;
    return out;
  };

  const buildings: OsmBuilding[] = [];
  for (let i = 0; i < nb; i++) {
    need(5);
    const kind = BUILDING_KINDS[dv.getUint8(o)] ?? 'other';
    const heightM = dv.getUint16(o + 1, true) / 10;
    const n = dv.getUint16(o + 3, true);
    o += 5;
    buildings.push({ kind, heightM, ring: points(n) });
  }

  const forests: OsmForest[] = [];
  for (let i = 0; i < nf; i++) {
    need(3);
    const leaf = LEAF_TYPES[dv.getUint8(o)] ?? 'mixed';
    const nRings = dv.getUint16(o + 1, true);
    o += 3;
    const rings: Float32Array[] = [];
    for (let k = 0; k < nRings; k++) {
      need(4);
      const n = dv.getUint32(o, true);
      o += 4;
      rings.push(points(n));
    }
    forests.push({ leaf, rings });
  }

  const runways: OsmRunway[] = [];
  for (let i = 0; i < nr; i++) {
    need(5);
    const widthM = dv.getUint16(o, true) / 10;
    const paved = dv.getUint8(o + 2) === 1;
    const n = dv.getUint16(o + 3, true);
    o += 5;
    runways.push({ widthM, paved, line: points(n) });
  }

  return { buildings, forests, runways };
}
