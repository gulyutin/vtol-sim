import { fromLocal, toLocal } from './mission';
import type { GeoPoint } from './types';

/*
 * Запретные зоны и зоны РЭБ: модель и геометрия. Зона — круг или многоугольник, по желанию с
 * нижней и верхней границей (м над уровнем моря). Запретная зона физически ничего не делает —
 * её учитывают предполётная проверка и оценка. Зона РЭБ действует на ГНСС или связь.
 *
 * Сила помех — простая модель: внутри зоны 1, снаружи линейно спадает до 0 на ширине кольца
 * EW_FALLOFF_SHARE · размер зоны (радиус круга; у многоугольника — радиус равновеликого круга).
 * Так у круга помехи кончаются на 1,5 радиуса. Помеха действует с силы EW_EFFECT_THRESHOLD
 * (у круга — до 1,25 радиуса) и отпускает ниже EW_RELEASE_THRESHOLD: на границе не мигает.
 * Расстояния — знаковые: внутри меньше нуля. С высотами зона — призма, расстояние считается
 * в пространстве, поэтому над потолком помехи тоже спадают.
 */

export type ZoneKind = 'nofly' | 'gnss-jam' | 'gnss-spoof' | 'link-jam';

export const ZONE_KINDS: readonly ZoneKind[] = ['nofly', 'gnss-jam', 'gnss-spoof', 'link-jam'];

export const ZONE_TITLE: Record<ZoneKind, string> = {
  nofly: 'Запретная зона',
  'gnss-jam': 'РЭБ: подавление ГНСС',
  'gnss-spoof': 'РЭБ: подмена ГНСС',
  'link-jam': 'РЭБ: подавление связи',
};

/** «Зона подавления ГНСС» и т. п. — для событий: «вход в зону …», «выход из зоны …». */
const KIND_OF: Record<ZoneKind, string> = {
  nofly: 'запрета полётов',
  'gnss-jam': 'подавления ГНСС',
  'gnss-spoof': 'подмены ГНСС',
  'link-jam': 'подавления связи',
};

export interface Zone {
  id: string;
  kind: ZoneKind;
  name?: string;
  /** Круг: центр и радиус, м. */
  center?: GeoPoint;
  radiusM?: number;
  /** Или многоугольник: вершины по порядку, без повтора первой. */
  polygon?: GeoPoint[];
  /** Нижняя и верхняя граница, м над уровнем моря; нет — от земли и без потолка. */
  floorM?: number;
  ceilingM?: number;
}

/** Помеха действует с этой силы: нет решения ГНСС, захват подменой, срыв связи. */
export const EW_EFFECT_THRESHOLD = 0.5;
/** …и отпускает ниже этой. */
export const EW_RELEASE_THRESHOLD = 0.3;
/** Ширина кольца спадания помех — доля размера зоны. */
export const EW_FALLOFF_SHARE = 0.5;

export interface ZoneEffects {
  /** Запретные зоны, в которых точка. */
  nofly: Zone[];
  /** Сила помех 0…1. */
  gnssJam: number;
  gnssSpoof: number;
  linkJam: number;
}

export const isEwZone = (z: Zone): boolean => z.kind !== 'nofly';

/** Подпись зоны: имя или название вида. */
export const zoneLabel = (z: Zone): string => z.name?.trim() || ZONE_TITLE[z.kind];

/** «подавления ГНСС «Имя»» — для событий: «вход в зону …», «выход из зоны …». */
export const zoneKindPhrase = (z: Zone): string => `${KIND_OF[z.kind]}${z.name?.trim() ? ` «${z.name.trim()}»` : ''}`;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isGeo = (p: unknown): p is GeoPoint =>
  typeof p === 'object' && p !== null && finite((p as GeoPoint).lat) && finite((p as GeoPoint).lon) && Math.abs((p as GeoPoint).lat) <= 90 && Math.abs((p as GeoPoint).lon) <= 180;

/** Годная зона: известный вид и круг с радиусом больше нуля или многоугольник от трёх вершин. */
export function isZone(x: unknown): x is Zone {
  if (typeof x !== 'object' || x === null) return false;
  const z = x as Zone;
  if (typeof z.id !== 'string' || !ZONE_KINDS.includes(z.kind)) return false;
  if (z.name !== undefined && typeof z.name !== 'string') return false;
  if (z.floorM !== undefined && !finite(z.floorM)) return false;
  if (z.ceilingM !== undefined && !finite(z.ceilingM)) return false;
  const circle = isGeo(z.center) && finite(z.radiusM) && z.radiusM > 0;
  const poly = Array.isArray(z.polygon) && z.polygon.length >= 3 && z.polygon.every(isGeo);
  return circle || poly;
}

/* ------------------------------ Локальная геометрия ------------------------------ */

interface XY {
  e: number;
  n: number;
}

/** Зона в локальных метрах вокруг начала координат — для частых проверок (живой полёт). */
export interface LocalZone {
  zone: Zone;
  circle: { e: number; n: number; r: number } | null;
  poly: XY[] | null;
  /** Габарит: запад, юг, восток, север, м. */
  box: [number, number, number, number];
  /** Размер: радиус круга или равновеликого круга, м. */
  sizeM: number;
  /** Ширина кольца спадания помех; у запретной зоны 0. */
  falloffM: number;
}

/** Зоны в локальных метрах вокруг origin; негодные пропускаются. */
export function prepareZones(zones: readonly Zone[], origin: GeoPoint): LocalZone[] {
  const out: LocalZone[] = [];
  for (const z of zones) {
    const lz = prepareZone(z, origin);
    if (lz) out.push(lz);
  }
  return out;
}

function prepareZone(z: Zone, origin: GeoPoint): LocalZone | null {
  if (!isZone(z)) return null;
  const falloff = (size: number) => (z.kind === 'nofly' ? 0 : EW_FALLOFF_SHARE * size);
  if (z.center && z.radiusM && z.radiusM > 0) {
    const c = toLocal(origin, z.center);
    const r = z.radiusM;
    return { zone: z, circle: { e: c.east, n: c.north, r }, poly: null, box: [c.east - r, c.north - r, c.east + r, c.north + r], sizeM: r, falloffM: falloff(r) };
  }
  const poly = z.polygon!.map((p) => {
    const q = toLocal(origin, p);
    return { e: q.east, n: q.north };
  });
  let area = 0;
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    area += a.e * b.n - b.e * a.n;
    box[0] = Math.min(box[0], b.e);
    box[1] = Math.min(box[1], b.n);
    box[2] = Math.max(box[2], b.e);
    box[3] = Math.max(box[3], b.n);
  }
  const size = Math.sqrt(Math.abs(area) / 2 / Math.PI);
  return { zone: z, circle: null, poly, box, sizeM: size, falloffM: falloff(size) };
}

function segDist2(e: number, n: number, a: XY, b: XY): number {
  const de = b.e - a.e;
  const dn = b.n - a.n;
  const l2 = de * de + dn * dn;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((e - a.e) * de + (n - a.n) * dn) / l2)) : 0;
  const x = a.e + de * t - e;
  const y = a.n + dn * t - n;
  return x * x + y * y;
}

/** Знаковое расстояние до границы в плане, м: внутри меньше нуля. */
function horizontalSigned(z: LocalZone, e: number, n: number): number {
  if (z.circle) return Math.hypot(e - z.circle.e, n - z.circle.n) - z.circle.r;
  const poly = z.poly!;
  let inside = false;
  let d2 = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    if (b.n > n !== a.n > n && e < ((a.e - b.e) * (n - b.n)) / (a.n - b.n) + b.e) inside = !inside;
    d2 = Math.min(d2, segDist2(e, n, a, b));
  }
  const d = Math.sqrt(d2);
  return inside ? -d : d;
}

/**
 * Знаковое расстояние до границы зоны, м (внутри меньше нуля). С высотой alt (м над уровнем
 * моря) учитываются пол и потолок: зона — призма; без высоты — только план.
 */
export function localSignedDistance(z: LocalZone, e: number, n: number, alt?: number): number {
  const dh = horizontalSigned(z, e, n);
  if (alt === undefined || (z.zone.floorM === undefined && z.zone.ceilingM === undefined)) return dh;
  const dv = Math.max((z.zone.floorM ?? -Infinity) - alt, alt - (z.zone.ceilingM ?? Infinity));
  if (dh <= 0 && dv <= 0) return Math.max(dh, dv);
  return Math.hypot(Math.max(dh, 0), Math.max(dv, 0));
}

/** Сила помех по знаковому расстоянию: внутри 1, в кольце спадания — линейно до 0. */
export function strengthAtDistance(z: LocalZone, d: number): number {
  if (d <= 0) return 1;
  return z.falloffM > 0 ? Math.max(0, 1 - d / z.falloffM) : 0;
}

/** Далеко за габаритом с кольцом спадания — точно не действует. */
const outsideBox = (z: LocalZone, e: number, n: number) =>
  e < z.box[0] - z.falloffM || e > z.box[2] + z.falloffM || n < z.box[1] - z.falloffM || n > z.box[3] + z.falloffM;

export interface LocalEffects extends ZoneEffects {
  /** Все зоны, внутри которых точка (для событий входа и выхода). */
  inside: Zone[];
}

export function localEffects(zones: readonly LocalZone[], e: number, n: number, alt?: number): LocalEffects {
  const out: LocalEffects = { nofly: [], gnssJam: 0, gnssSpoof: 0, linkJam: 0, inside: [] };
  for (const z of zones) {
    if (outsideBox(z, e, n)) continue;
    const d = localSignedDistance(z, e, n, alt);
    if (d <= 0) out.inside.push(z.zone);
    if (z.zone.kind === 'nofly') {
      if (d <= 0) out.nofly.push(z.zone);
      continue;
    }
    const k = strengthAtDistance(z, d);
    if (z.zone.kind === 'gnss-jam') out.gnssJam = Math.max(out.gnssJam, k);
    else if (z.zone.kind === 'gnss-spoof') out.gnssSpoof = Math.max(out.gnssSpoof, k);
    else out.linkJam = Math.max(out.linkJam, k);
  }
  return out;
}

/* --------------------------------- По координатам --------------------------------- */

/** Точка внутри зоны; с высотой — с учётом пола и потолка. */
export function zoneContains(z: Zone, p: GeoPoint, altitudeM?: number): boolean {
  return zoneDistanceM(z, p, altitudeM) <= 0;
}

/** Знаковое расстояние до границы зоны, м: внутри меньше нуля; негодная зона — Infinity. */
export function zoneDistanceM(z: Zone, p: GeoPoint, altitudeM?: number): number {
  const lz = prepareZone(z, p);
  return lz ? localSignedDistance(lz, 0, 0, altitudeM) : Infinity;
}

/** Сила помех зоны в точке 0…1 (у запретной — 1 внутри, 0 снаружи). */
export function zoneStrength(z: Zone, p: GeoPoint, altitudeM?: number): number {
  const lz = prepareZone(z, p);
  return lz ? strengthAtDistance(lz, localSignedDistance(lz, 0, 0, altitudeM)) : 0;
}

/** Что делают зоны в точке pos на высоте altitudeM (м над уровнем моря). */
export function zoneEffectsAt(zones: readonly Zone[], pos: GeoPoint, altitudeM?: number): ZoneEffects {
  const { nofly, gnssJam, gnssSpoof, linkJam } = localEffects(prepareZones(zones, pos), 0, 0, altitudeM);
  return { nofly, gnssJam, gnssSpoof, linkJam };
}

/* ------------------------------------ Маршрут ------------------------------------ */

/** Точка маршрута; altitudeM — над уровнем моря, нет — проверка только в плане. */
export interface RoutePoint3D extends GeoPoint {
  altitudeM?: number;
}

interface P3 {
  e: number;
  n: number;
  alt?: number;
}

/**
 * Первая точка отрезка a→b, где знаковое расстояние не больше margin: доля 0…1 или null.
 * Расстояние меняется вдоль пути не быстрее самого пути, поэтому участок, где даже в лучшем
 * случае до зоны не дотянуться, отбрасывается целиком, остальное делится пополам.
 */
function segmentEntry(z: LocalZone, a: P3, b: P3, margin: number): number | null {
  const withAlt = a.alt !== undefined && b.alt !== undefined;
  const L = Math.hypot(b.e - a.e, b.n - a.n, withAlt ? b.alt! - a.alt! : 0);
  const f = (t: number) =>
    localSignedDistance(z, a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t, withAlt ? a.alt! + (b.alt! - a.alt!) * t : undefined);
  const d0 = f(0);
  if (d0 <= margin) return 0;
  if (L < 1e-6) return null;
  const refine = (t0: number, t1: number, v0: number, v1: number, depth: number): number | null => {
    const len = (t1 - t0) * L;
    if ((v0 + v1 - len) / 2 > margin) return null;
    if (len < 0.5 || depth > 48) return v1 <= margin + 0.5 || v0 <= margin + 0.5 ? t1 : null;
    const tm = (t0 + t1) / 2;
    const vm = f(tm);
    if (vm <= margin) return refine(t0, tm, v0, vm, depth + 1) ?? tm;
    return refine(t0, tm, v0, vm, depth + 1) ?? refine(tm, t1, vm, v1, depth + 1);
  };
  const steps = Math.max(1, Math.ceil(L / 200));
  let t0 = 0;
  let v0 = d0;
  for (let i = 1; i <= steps; i++) {
    const t1 = i / steps;
    const v1 = f(t1);
    const hit = v1 <= margin ? (refine(t0, t1, v0, v1, 0) ?? t1) : refine(t0, t1, v0, v1, 0);
    if (hit !== null) return hit;
    t0 = t1;
    v0 = v1;
  }
  return null;
}

const toP3 = (origin: GeoPoint, p: RoutePoint3D): P3 => {
  const q = toLocal(origin, p);
  return { e: q.east, n: q.north, alt: p.altitudeM };
};

/** Отрезок a→b заходит в зону (ближе marginM к ней). */
export function segmentIntersectsZone(z: Zone, a: RoutePoint3D, b: RoutePoint3D, marginM = 0): boolean {
  const lz = prepareZone(z, a);
  return !!lz && segmentEntry(lz, toP3(a, a), toP3(a, b), marginM) !== null;
}

export interface ZoneCrossing {
  zone: Zone;
  /** Номер отрезка маршрута (от точки leg к leg + 1). */
  leg: number;
  /** Путь по маршруту до входа, м. */
  atM: number;
  point: GeoPoint;
}

/** Где маршрут впервые заходит в каждую из зон (ближе marginM к ней); по порядку пути. */
export function routeZoneCrossings(zones: readonly Zone[], route: readonly RoutePoint3D[], marginM = 0): ZoneCrossing[] {
  if (route.length === 0) return [];
  const origin = route[0]!;
  const pts = route.map((p) => toP3(origin, p));
  const out: ZoneCrossing[] = [];
  for (const z of prepareZones(zones, origin)) {
    let along = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1] ?? a;
      const t = segmentEntry(z, a, b, marginM);
      const len = Math.hypot(b.e - a.e, b.n - a.n);
      if (t !== null) {
        out.push({ zone: z.zone, leg: i, atM: along + len * t, point: fromLocal(origin, a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t) });
        break;
      }
      along += len;
      if (!pts[i + 1]) break;
    }
  }
  return out.sort((x, y) => x.atM - y.atM);
}

export interface ZoneExposure {
  zone: Zone;
  /** Длина маршрута, где сила помех не меньше порога, м. */
  lengthM: number;
  /** Путь по маршруту до начала действия, м. */
  atM: number;
}

/** Где на маршруте действуют помехи зон РЭБ (сила не меньше threshold), с шагом stepM. */
export function routeZoneExposure(zones: readonly Zone[], route: readonly RoutePoint3D[], threshold = EW_EFFECT_THRESHOLD, stepM = 25): ZoneExposure[] {
  if (route.length === 0) return [];
  const origin = route[0]!;
  const pts = route.map((p) => toP3(origin, p));
  const out: ZoneExposure[] = [];
  for (const z of prepareZones(zones.filter(isEwZone), origin)) {
    let along = 0;
    let lengthM = 0;
    let atM = -1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const len = Math.hypot(b.e - a.e, b.n - a.n);
      const n = Math.max(1, Math.ceil(len / stepM));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const alt = a.alt !== undefined && b.alt !== undefined ? a.alt + (b.alt - a.alt) * t : undefined;
        const d = localSignedDistance(z, a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t, alt);
        if (strengthAtDistance(z, d) >= threshold) {
          lengthM += len / n;
          if (atM < 0) atM = along + (len * k) / n;
        }
      }
      along += len;
    }
    if (lengthM > 0) out.push({ zone: z.zone, lengthM, atM });
  }
  return out.sort((x, y) => x.atM - y.atM);
}

/* ------------------------------------ Контуры ------------------------------------ */

/**
 * Линия на расстоянии offsetM снаружи от границы зоны — для кольца спадания помех на карте.
 * Круг — окружность; многоугольник с отступом — изолиния знакового расстояния (квадраты
 * cells × cells). Возвращает одну или несколько ломаных.
 */
export function zoneContour(z: Zone, offsetM = 0, cells = 72): GeoPoint[][] {
  const origin = z.center ?? z.polygon?.[0];
  if (!origin) return [];
  const lz = prepareZone(z, origin);
  if (!lz) return [];
  if (lz.circle) {
    const r = lz.circle.r + offsetM;
    const ring: GeoPoint[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (2 * Math.PI * i) / 96;
      ring.push(fromLocal(origin, lz.circle.e + r * Math.sin(a), lz.circle.n + r * Math.cos(a)));
    }
    return [ring];
  }
  if (offsetM <= 0) return [[...z.polygon!, z.polygon![0]!]];
  const pad = offsetM * 1.1 + 1;
  const e0 = lz.box[0] - pad;
  const n0 = lz.box[1] - pad;
  const step = Math.max(lz.box[2] - lz.box[0] + 2 * pad, lz.box[3] - lz.box[1] + 2 * pad) / cells;
  const nx = Math.ceil((lz.box[2] + pad - e0) / step) + 1;
  const ny = Math.ceil((lz.box[3] + pad - n0) / step) + 1;
  const v: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v.push(horizontalSigned(lz, e0 + i * step, n0 + j * step) - offsetM);
  const at = (i: number, j: number) => v[j * nx + i]!;
  // Точка изолинии на ребре сетки; ключ ребра склеивает соседние отрезки.
  const edgePoint = (i0: number, j0: number, i1: number, j1: number): { key: string; p: XY } => {
    const a = at(i0, j0);
    const b = at(i1, j1);
    const t = a === b ? 0.5 : a / (a - b);
    return {
      key: `${i0},${j0},${i1},${j1}`,
      p: { e: e0 + (i0 + (i1 - i0) * t) * step, n: n0 + (j0 + (j1 - j0) * t) * step },
    };
  };
  type End = { key: string; p: XY };
  const segs: [End, End][] = [];
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const mask = (at(i, j) < 0 ? 1 : 0) | (at(i + 1, j) < 0 ? 2 : 0) | (at(i + 1, j + 1) < 0 ? 4 : 0) | (at(i, j + 1) < 0 ? 8 : 0);
      if (mask === 0 || mask === 15) continue;
      const B = () => edgePoint(i, j, i + 1, j);
      const R = () => edgePoint(i + 1, j, i + 1, j + 1);
      const T = () => edgePoint(i, j + 1, i + 1, j + 1);
      const Lf = () => edgePoint(i, j, i, j + 1);
      const centerIn = at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1) < 0;
      switch (mask) {
        case 1:
        case 14:
          segs.push([Lf(), B()]);
          break;
        case 2:
        case 13:
          segs.push([B(), R()]);
          break;
        case 3:
        case 12:
          segs.push([Lf(), R()]);
          break;
        case 4:
        case 11:
          segs.push([R(), T()]);
          break;
        case 6:
        case 9:
          segs.push([B(), T()]);
          break;
        case 7:
        case 8:
          segs.push([Lf(), T()]);
          break;
        case 5:
          if (centerIn) segs.push([B(), R()], [T(), Lf()]);
          else segs.push([Lf(), B()], [R(), T()]);
          break;
        case 10:
          if (centerIn) segs.push([Lf(), B()], [R(), T()]);
          else segs.push([B(), R()], [T(), Lf()]);
          break;
      }
    }
  }
  // Склейка отрезков в ломаные.
  const byKey = new Map<string, number[]>();
  segs.forEach(([a, b], k) => {
    for (const x of [a.key, b.key]) byKey.set(x, [...(byKey.get(x) ?? []), k]);
  });
  const used = new Array<boolean>(segs.length).fill(false);
  const lines: GeoPoint[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const line: End[] = [segs[s]![0], segs[s]![1]];
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? line[line.length - 1]! : line[0]!;
        const next = byKey.get(end.key)?.find((k) => !used[k]);
        if (next === undefined) break;
        used[next] = true;
        const [a, b] = segs[next]!;
        const other = a.key === end.key ? b : a;
        if (forward) line.push(other);
        else line.unshift(other);
      }
    }
    lines.push(line.map((q) => fromLocal(origin, q.p.e, q.p.n)));
  }
  return lines;
}

/** Новый id, которого нет среди existing: z1, z2, … */
export function makeZoneId(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (let i = 1; ; i++) if (!taken.has(`z${i}`)) return `z${i}`;
}
