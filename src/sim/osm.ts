/*
 * Данные OpenStreetMap для 3D-вида: дома, леса, взлётные полосы, дороги, вода. Координаты —
 * локальные метры относительно площадки профиля (восток, север), как toLocal(site, p).
 *
 * Хранятся в двоичном файле профиля (osm.bin; пишет scripts/fetch-osm.mjs), little-endian.
 *
 * Версия 2 (текущая):
 *   'OSM2'                        магия, 4 байта
 *   u32 × 6: buildings, forests, runways, roads, waters, waterways
 *   точки:   varint n, n × (zz Δвосток, zz Δсевер) в дм — разности с предыдущей точкой, первая от (0, 0)
 *   здание:  u8 kind, u8 levels (0 — неизвестно), u8 roof, varint высота в дм, точки
 *   лес:     u8 leaf, varint колец, по кольцу точки — первое внешнее, дальше дыры
 *   полоса:  u8 paved (1 — твёрдое покрытие), varint ширина в дм, точки — осевая
 *   дорога:  u8 класс, u8 флаги (1 — твёрдое покрытие, 2 — мост, 4 — освещена), varint ширина в дм, точки — осевая
 *   вода:    u8 kind, varint колец, по кольцу точки — первое внешнее, дальше дыры
 *   река:    u8 kind, varint ширина в дм, точки — осевая (только вне площадей воды)
 * varint — беззнаковый LEB128, zz — zigzag (0, −1, 1, −2, … → 0, 1, 2, 3, …). Разности вдвое
 * короче абсолютных i32: в том же объёме помещаются дороги и вода.
 *
 * Версия 1 (читается для совместимости): 'OSM1', u32 buildings, forests, runways;
 *   здание: u8 kind, u16 высота в дм, u16 n, n × (i32 восток, i32 север) в дм;
 *   лес: u8 leaf, u16 колец, по кольцу u32 n и точки; полоса: u16 ширина в дм, u8 paved, u16 n, точки.
 *
 * Кольца без повтора первой точки. Двоичный формат — ещё и чтобы тысячи чисел координат не
 * давали ложных совпадений в проверке публичной копии.
 */

export type BuildingKind = 'house' | 'apartments' | 'industrial' | 'other';
export type LeafType = 'needle' | 'broad' | 'mixed';
/** Форма крыши из roof:shape; auto — по типу и контуру дома. */
export type RoofShape = 'auto' | 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'skillion';
/** Класс дороги (highway=*, railway=* — rail). Порядок — от главных к второстепенным. */
export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential' | 'service' | 'track' | 'rail';
export type WaterKind = 'lake' | 'river' | 'reservoir' | 'basin';
export type WaterwayKind = 'river' | 'stream' | 'canal';

export interface OsmBuilding {
  kind: BuildingKind;
  /** Высота до карниза, м. */
  heightM: number;
  /** Этажей по building:levels; 0 — неизвестно. */
  levels: number;
  roof: RoofShape;
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

export interface OsmRoad {
  cls: RoadClass;
  /** Ширина проезжей части (у железной дороги — насыпи), м. */
  widthM: number;
  paved: boolean;
  bridge: boolean;
  /** lit=yes — фонари по всей длине. */
  lit: boolean;
  /** Осевая линия, м. */
  line: Float32Array;
}

export interface OsmWater {
  kind: WaterKind;
  /** Внешнее кольцо и острова. */
  rings: Float32Array[];
}

export interface OsmWaterway {
  kind: WaterwayKind;
  widthM: number;
  /** Осевая линия, м. */
  line: Float32Array;
}

export interface OsmData {
  buildings: OsmBuilding[];
  forests: OsmForest[];
  runways: OsmRunway[];
  roads: OsmRoad[];
  water: OsmWater[];
  waterways: OsmWaterway[];
}

export const BUILDING_KINDS: readonly BuildingKind[] = ['house', 'apartments', 'industrial', 'other'];
export const LEAF_TYPES: readonly LeafType[] = ['needle', 'broad', 'mixed'];
export const ROOF_SHAPES: readonly RoofShape[] = ['auto', 'flat', 'gabled', 'hipped', 'pyramidal', 'skillion'];
export const ROAD_CLASSES: readonly RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track', 'rail'];
export const WATER_KINDS: readonly WaterKind[] = ['lake', 'river', 'reservoir', 'basin'];
export const WATERWAY_KINDS: readonly WaterwayKind[] = ['river', 'stream', 'canal'];

export const ROAD_PAVED = 1;
export const ROAD_BRIDGE = 2;
export const ROAD_LIT = 4;

/**
 * Высоты концов настила мостов, м: [начало, конец] у каждой дороги-моста, null — не мост.
 *
 * Мост в OSM часто разрезан на несколько линий (пролёты, смена числа полос), и стык лежит над
 * водой: рельеф под ним — русло, настил по нему лёг бы на воду. Берег — конец, где мост кончается
 * или продолжается обычной дорогой; высота там — рельеф. Стыки — между берегами своей цепочки,
 * с весами, обратными пути по мосту: у цепочки с двумя берегами высота меняется линейно по длине.
 */
export function bridgeDeckEnds(roads: readonly OsmRoad[], groundAt: (east: number, north: number) => number): ([number, number] | null)[] {
  interface Node {
    e: number;
    n: number;
    edges: number[];
    shore: boolean;
    h: number;
  }
  // Общие точки линий в файле совпадают до дециметра.
  const key = (e: number, n: number) => `${Math.round(e * 10)},${Math.round(n * 10)}`;
  const nodes = new Map<string, Node>();
  const node = (e: number, n: number): Node => {
    const k = key(e, n);
    let v = nodes.get(k);
    if (!v) nodes.set(k, (v = { e, n, edges: [], shore: false, h: NaN }));
    return v;
  };
  const edges: { a: Node; b: Node; len: number; road: number }[] = [];
  roads.forEach((r, i) => {
    const L = r.line;
    if (!r.bridge || L.length < 4) return;
    const a = node(L[0]!, L[1]!);
    const b = node(L[L.length - 2]!, L[L.length - 1]!);
    let len = 0;
    for (let k = 0; k + 3 < L.length; k += 2) len += Math.hypot(L[k + 2]! - L[k]!, L[k + 3]! - L[k + 1]!);
    a.edges.push(edges.length);
    b.edges.push(edges.length);
    edges.push({ a, b, len, road: i });
  });
  const out: ([number, number] | null)[] = roads.map(() => null);
  if (!edges.length) return out;
  for (const r of roads) {
    const L = r.line;
    if (r.bridge || L.length < 4) continue;
    for (const [e, n] of [
      [L[0]!, L[1]!],
      [L[L.length - 2]!, L[L.length - 1]!],
    ] as const) {
      const v = nodes.get(key(e, n));
      if (v) v.shore = true;
    }
  }
  const all = [...nodes.values()];
  for (const v of all) if (v.edges.length === 1) v.shore = true;
  const shores = all.filter((v) => v.shore);
  for (const v of shores) v.h = groundAt(v.e, v.n);
  // От каждого берега — кратчайшие пути по мосту до стыков (через другой берег не идём).
  const sumW = new Map<Node, number>();
  const sumH = new Map<Node, number>();
  for (const s of shores) {
    const dist = new Map<Node, number>([[s, 0]]);
    const queue: Node[] = [s];
    while (queue.length) {
      // Цепочки короткие — ближайший узел линейным поиском.
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (dist.get(queue[i]!)! < dist.get(queue[bi]!)!) bi = i;
      const u = queue.splice(bi, 1)[0]!;
      if (u !== s && u.shore) continue;
      const du = dist.get(u)!;
      for (const ei of u.edges) {
        const ed = edges[ei]!;
        const w = ed.a === u ? ed.b : ed.a;
        const d = du + ed.len;
        if (d < (dist.get(w) ?? Infinity)) {
          if (!dist.has(w)) queue.push(w);
          dist.set(w, d);
        }
      }
    }
    for (const [v, d] of dist) {
      if (v.shore || !(d > 0)) continue;
      sumW.set(v, (sumW.get(v) ?? 0) + 1 / d);
      sumH.set(v, (sumH.get(v) ?? 0) + s.h / d);
    }
  }
  // Кольцо без берегов — по рельефу.
  for (const v of all) if (!v.shore) v.h = sumW.has(v) ? sumH.get(v)! / sumW.get(v)! : groundAt(v.e, v.n);
  for (const ed of edges) out[ed.road] = [ed.a.h, ed.b.h];
  return out;
}

/** Разбор osm.bin (формат — в начале файла). Неверная сигнатура или обрезанный файл — исключение. */
export function parseOsm(buf: ArrayBuffer): OsmData {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 4) throw new Error(`osm.bin обрезан: нужно 4 байта, есть ${bytes.length}`);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic === 'OSM1') return parseV1(buf);
  if (magic === 'OSM2') return parseV2(bytes);
  throw new Error('osm.bin: неверная сигнатура');
}

const truncated = (need: number, have: number) => new Error(`osm.bin обрезан: нужно ${need} байт, есть ${have}`);

function parseV2(b: Uint8Array): OsmData {
  const len = b.length;
  let o = 4;
  const u8 = (): number => {
    if (o >= len) throw truncated(o + 1, len);
    return b[o++]!;
  };
  const u32 = (): number => {
    if (o + 4 > len) throw truncated(o + 4, len);
    const v = (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;
    o += 4;
    return v;
  };
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (o >= len) throw truncated(o + 1, len);
      const c = b[o++]!;
      v += (c & 0x7f) * mul;
      if (c < 0x80) return v;
      mul *= 128;
      if (mul > 2 ** 49) throw new Error('osm.bin: слишком длинное число');
    }
  };
  const zz = (): number => {
    const v = varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  /** Точки → метры. */
  const points = (): Float32Array => {
    const n = varint();
    if (n * 2 > len - o) throw truncated(o + n * 2, len);
    const out = new Float32Array(n * 2);
    let e = 0;
    let nn = 0;
    for (let i = 0; i < n; i++) {
      e += zz();
      nn += zz();
      out[2 * i] = e / 10;
      out[2 * i + 1] = nn / 10;
    }
    return out;
  };
  const rings = (): Float32Array[] => {
    const k = varint();
    const out: Float32Array[] = [];
    for (let i = 0; i < k; i++) out.push(points());
    return out;
  };

  const counts = [u32(), u32(), u32(), u32(), u32(), u32()] as const;
  const [nb, nf, nr, nd, nw, nl] = counts;

  const buildings: OsmBuilding[] = [];
  for (let i = 0; i < nb; i++) {
    const kind = BUILDING_KINDS[u8()] ?? 'other';
    const levels = u8();
    const roof = ROOF_SHAPES[u8()] ?? 'auto';
    const heightM = varint() / 10;
    buildings.push({ kind, heightM, levels, roof, ring: points() });
  }
  const forests: OsmForest[] = [];
  for (let i = 0; i < nf; i++) {
    const leaf = LEAF_TYPES[u8()] ?? 'mixed';
    forests.push({ leaf, rings: rings() });
  }
  const runways: OsmRunway[] = [];
  for (let i = 0; i < nr; i++) {
    const paved = u8() === 1;
    const widthM = varint() / 10;
    runways.push({ widthM, paved, line: points() });
  }
  const roads: OsmRoad[] = [];
  for (let i = 0; i < nd; i++) {
    const cls = ROAD_CLASSES[u8()] ?? 'service';
    const flags = u8();
    const widthM = varint() / 10;
    roads.push({ cls, widthM, paved: (flags & ROAD_PAVED) !== 0, bridge: (flags & ROAD_BRIDGE) !== 0, lit: (flags & ROAD_LIT) !== 0, line: points() });
  }
  const water: OsmWater[] = [];
  for (let i = 0; i < nw; i++) {
    const kind = WATER_KINDS[u8()] ?? 'lake';
    water.push({ kind, rings: rings() });
  }
  const waterways: OsmWaterway[] = [];
  for (let i = 0; i < nl; i++) {
    const kind = WATERWAY_KINDS[u8()] ?? 'stream';
    const widthM = varint() / 10;
    waterways.push({ kind, widthM, line: points() });
  }
  return { buildings, forests, runways, roads, water, waterways };
}

function parseV1(buf: ArrayBuffer): OsmData {
  const dv = new DataView(buf);
  let o = 0;
  const need = (bytes: number) => {
    if (o + bytes > dv.byteLength) throw truncated(o + bytes, dv.byteLength);
  };
  need(16);
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
    buildings.push({ kind, heightM, levels: 0, roof: 'auto', ring: points(n) });
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

  return { buildings, forests, runways, roads: [], water: [], waterways: [] };
}
