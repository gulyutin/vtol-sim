import type { GeoPoint } from '../sim/types';
import { isZone, type Zone, type ZoneKind } from '../sim/zones';

/*
 * Зоны из файла и в файл: GeoJSON (FeatureCollection, Feature или голая геометрия) и простой KML.
 * Многоугольник — зона по внешнему контуру (отверстия не учитываются), мультимногоугольник —
 * несколько зон, точка с радиусом — круг. Вид — properties.kind (наши значения или синонимы);
 * без вида — запретная. Непонятное пропускается с предупреждением, разбор не падает.
 */

export interface ZonesParseResult {
  zones: Zone[];
  warnings: string[];
}

/** Синонимы вида зоны; ключи — в нижнем регистре, пробелы и подчёркивания — дефисы. */
const KIND_SYNONYMS: Record<string, ZoneKind> = {
  nofly: 'nofly',
  'no-fly': 'nofly',
  'no-fly-zone': 'nofly',
  nfz: 'nofly',
  prohibited: 'nofly',
  restricted: 'nofly',
  danger: 'nofly',
  forbidden: 'nofly',
  запрет: 'nofly',
  запретная: 'nofly',
  'запретная-зона': 'nofly',
  'gnss-jam': 'gnss-jam',
  'gps-jam': 'gnss-jam',
  gpsjam: 'gnss-jam',
  jam: 'gnss-jam',
  jammer: 'gnss-jam',
  jamming: 'gnss-jam',
  ew: 'gnss-jam',
  рэб: 'gnss-jam',
  'gnss-spoof': 'gnss-spoof',
  'gps-spoof': 'gnss-spoof',
  spoof: 'gnss-spoof',
  spoofing: 'gnss-spoof',
  'link-jam': 'link-jam',
  'comm-jam': 'link-jam',
  'radio-jam': 'link-jam',
  'c2-jam': 'link-jam',
  'datalink-jam': 'link-jam',
  'rc-jam': 'link-jam',
};

type Props = Record<string, unknown>;
const isObj = (x: unknown): x is Props => typeof x === 'object' && x !== null && !Array.isArray(x);
const pick = (p: Props, keys: string[]): unknown => {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
  return undefined;
};

/** Число метров: число или строка «1500», «1500 м», «1500m». */
function meters(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:m|м)?\s*$/iu.exec(v);
  return m ? Number(m[1]!.replace(',', '.')) : undefined;
}

class Builder {
  readonly zones: Zone[] = [];
  readonly warnings: string[] = [];
  private readonly ids = new Set<string>();
  private auto = 0;

  uniqueId(want: unknown): string {
    let base = typeof want === 'string' && want.trim() ? want.trim() : typeof want === 'number' && Number.isFinite(want) ? String(want) : '';
    if (!base) {
      do base = `zone-${++this.auto}`;
      while (this.ids.has(base));
    }
    let id = base;
    for (let k = 2; this.ids.has(id); k++) id = `${base}-${k}`;
    this.ids.add(id);
    return id;
  }

  /** Общие свойства: вид, имя, пол и потолок. */
  props(p: Props, label: string): Omit<Zone, 'id'> {
    const out: Omit<Zone, 'id'> = { kind: 'nofly' };
    const rawKind = pick(p, ['kind', 'zoneKind', 'zone_kind', 'category', 'type']);
    if (rawKind === undefined) this.warnings.push(`${label}: вид зоны не указан — считаю запретной`);
    else {
      const k = KIND_SYNONYMS[String(rawKind).toLowerCase().trim().replace(/[\s_]+/g, '-')];
      if (k) out.kind = k;
      else this.warnings.push(`${label}: вид «${String(rawKind)}» непонятен — считаю запретной`);
    }
    const name = pick(p, ['name', 'title', 'Name', 'NAME']);
    if (typeof name === 'string' && name.trim()) out.name = name.trim();
    for (const [key, keys] of [
      ['floorM', ['floorM', 'floor', 'floor_m', 'lower', 'bottom']],
      ['ceilingM', ['ceilingM', 'ceiling', 'ceiling_m', 'upper', 'top']],
    ] as const) {
      const raw = pick(p, [...keys]);
      if (raw === undefined) continue;
      const v = meters(raw);
      if (v === undefined) this.warnings.push(`${label}: ${key === 'floorM' ? 'нижняя' : 'верхняя'} граница «${String(raw)}» — не число метров, пропущена`);
      else out[key] = v;
    }
    if (out.floorM !== undefined && out.ceilingM !== undefined && out.floorM >= out.ceilingM) {
      this.warnings.push(`${label}: нижняя граница не ниже верхней — границы по высоте пропущены`);
      delete out.floorM;
      delete out.ceilingM;
    }
    return out;
  }

  add(z: Zone, label: string) {
    if (isZone(z)) this.zones.push(z);
    else this.warnings.push(`${label}: зона негодная — пропущена`);
  }
}

const position = (c: unknown): GeoPoint | null => {
  if (!Array.isArray(c) || c.length < 2) return null;
  const [lon, lat] = c as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
};

/** Кольцо вершин без повтора первой; null — меньше трёх годных. */
function ring(coords: GeoPoint[] | null): GeoPoint[] | null {
  if (!coords) return null;
  const pts = coords.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (pts.length > 1 && a && b && a.lat === b.lat && a.lon === b.lon) pts.pop();
  return pts.length >= 3 ? pts : null;
}

function geoRing(raw: unknown): GeoPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const pts = raw.map(position);
  return pts.every((p): p is GeoPoint => p !== null) ? ring(pts) : null;
}

function addGeometry(b: Builder, g: unknown, p: Props, id: unknown, label: string) {
  if (!isObj(g)) {
    b.warnings.push(`${label}: нет геометрии — пропущено`);
    return;
  }
  const coords = g.coordinates;
  switch (g.type) {
    case 'Polygon': {
      const outer = Array.isArray(coords) ? geoRing(coords[0]) : null;
      if (!outer) return void b.warnings.push(`${label}: многоугольник без трёх годных вершин — пропущено`);
      if (Array.isArray(coords) && coords.length > 1) b.warnings.push(`${label}: отверстия в многоугольнике не учитываются`);
      b.add({ id: b.uniqueId(id), ...b.props(p, label), polygon: outer }, label);
      return;
    }
    case 'MultiPolygon': {
      if (!Array.isArray(coords)) return void b.warnings.push(`${label}: пустой мультимногоугольник — пропущено`);
      const common = b.props(p, label);
      const base = b.uniqueId(id);
      coords.forEach((poly, k) => {
        const outer = Array.isArray(poly) ? geoRing(poly[0]) : null;
        if (!outer) return void b.warnings.push(`${label}, часть ${k + 1}: без трёх годных вершин — пропущено`);
        if (Array.isArray(poly) && poly.length > 1) b.warnings.push(`${label}, часть ${k + 1}: отверстия не учитываются`);
        b.add({ id: k === 0 ? base : b.uniqueId(`${base}-${k + 1}`), ...common, polygon: outer }, label);
      });
      return;
    }
    case 'Point': {
      const c = position(coords);
      const rawR = pick(p, ['radiusM', 'radius', 'radius_m']);
      const r = meters(rawR);
      if (!c) return void b.warnings.push(`${label}: точка с негодными координатами — пропущено`);
      if (r === undefined || r <= 0) return void b.warnings.push(`${label}: точка без радиуса (properties.radiusM, м) — пропущено`);
      b.add({ id: b.uniqueId(id), ...b.props(p, label), center: c, radiusM: r }, label);
      return;
    }
    case 'GeometryCollection': {
      const list = Array.isArray(g.geometries) ? g.geometries : [];
      list.forEach((x, k) => addGeometry(b, x, p, list.length > 1 ? `${String(id ?? 'zone')}-${k + 1}` : id, `${label}, часть ${k + 1}`));
      return;
    }
    default:
      b.warnings.push(`${label}: геометрия «${String(g.type)}» не поддерживается — пропущено`);
  }
}

/** Зоны из GeoJSON: FeatureCollection, Feature или геометрия. */
export function parseZonesGeoJSON(text: string): ZonesParseResult {
  const b = new Builder();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    b.warnings.push('Файл не разобран: это не JSON');
    return { zones: b.zones, warnings: b.warnings };
  }
  if (!isObj(raw)) {
    b.warnings.push('Файл не разобран: нет объекта GeoJSON');
    return { zones: b.zones, warnings: b.warnings };
  }
  const features: unknown[] = raw.type === 'FeatureCollection' ? (Array.isArray(raw.features) ? raw.features : []) : raw.type === 'Feature' ? [raw] : [{ type: 'Feature', geometry: raw, properties: {} }];
  if (raw.type === 'FeatureCollection' && !Array.isArray(raw.features)) b.warnings.push('В FeatureCollection нет списка features');
  features.forEach((f, i) => {
    const label = `Объект ${i + 1}`;
    if (!isObj(f)) return void b.warnings.push(`${label}: не объект — пропущено`);
    const p = isObj(f.properties) ? f.properties : {};
    const name = pick(p, ['name', 'title', 'Name', 'NAME']);
    addGeometry(b, f.geometry, p, f.id ?? p.id, typeof name === 'string' && name.trim() ? `${label} «${name.trim()}»` : label);
  });
  if (!b.zones.length && !b.warnings.length) b.warnings.push('В файле нет зон');
  return { zones: b.zones, warnings: b.warnings };
}

/** Зоны в GeoJSON: круг — Point с properties.radiusM, многоугольник — Polygon. */
export function zonesToGeoJSON(zones: readonly Zone[]): string {
  const features = zones.filter(isZone).map((z) => {
    const properties: Props = { kind: z.kind };
    if (z.name) properties.name = z.name;
    if (z.center && z.radiusM) properties.radiusM = z.radiusM;
    if (z.floorM !== undefined) properties.floorM = z.floorM;
    if (z.ceilingM !== undefined) properties.ceilingM = z.ceilingM;
    const geometry =
      z.center && z.radiusM
        ? { type: 'Point', coordinates: [z.center.lon, z.center.lat] }
        : { type: 'Polygon', coordinates: [[...z.polygon!, z.polygon![0]!].map((p) => [p.lon, p.lat])] };
    return { type: 'Feature', id: z.id, properties, geometry };
  });
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

/* ------------------------------------- KML ------------------------------------- */

const unxml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

function kmlCoords(s: string): GeoPoint[] | null {
  const pts = s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => position(t.split(',').map(Number)));
  return pts.length && pts.every((p): p is GeoPoint => p !== null) ? pts : null;
}

/** Простой KML: Placemark с Polygon (внешний контур) или Point с радиусом в ExtendedData. */
export function parseZonesKML(text: string): ZonesParseResult {
  const b = new Builder();
  const marks = [...text.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g)];
  if (!marks.length) b.warnings.push('В KML нет объектов Placemark');
  marks.forEach((m, i) => {
    const body = m[1]!;
    const props: Props = {};
    const name = /<name>([\s\S]*?)<\/name>/.exec(body);
    if (name) props.name = unxml(name[1]!);
    for (const d of body.matchAll(/<Data\s+name="([^"]+)"\s*>\s*<value>([\s\S]*?)<\/value>/g)) props[d[1]!] = unxml(d[2]!);
    for (const d of body.matchAll(/<SimpleData\s+name="([^"]+)"\s*>([\s\S]*?)<\/SimpleData>/g)) props[d[1]!] = unxml(d[2]!);
    const idAttr = /<Placemark\b[^>]*\bid="([^"]+)"/.exec(m[0]);
    const label = `Объект ${i + 1}${typeof props.name === 'string' && props.name ? ` «${props.name}»` : ''}`;
    const polys = [...body.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/g)];
    const point = /<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body);
    if (polys.length) {
      polys.forEach((pm, k) => {
        const outer = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(pm[0]);
        const pts = ring(outer ? kmlCoords(outer[1]!) : null);
        if (!pts) return void b.warnings.push(`${label}: многоугольник без трёх годных вершин — пропущено`);
        if (/<innerBoundaryIs>/.test(pm[0])) b.warnings.push(`${label}: отверстия в многоугольнике не учитываются`);
        b.add({ id: b.uniqueId(k === 0 ? (idAttr?.[1] ?? props.id) : `${idAttr?.[1] ?? 'zone'}-${k + 1}`), ...b.props(props, label), polygon: pts }, label);
      });
    } else if (point) {
      addGeometry(b, { type: 'Point', coordinates: kmlCoords(point[1]!)?.map((p) => [p.lon, p.lat])[0] }, props, idAttr?.[1] ?? props.id, label);
    } else b.warnings.push(`${label}: нет многоугольника или точки — пропущено`);
  });
  return { zones: b.zones, warnings: b.warnings };
}

/** Файл зон: KML (начинается с «<») или GeoJSON. */
export function parseZonesFile(text: string): ZonesParseResult {
  return text.trimStart().startsWith('<') ? parseZonesKML(text) : parseZonesGeoJSON(text);
}
