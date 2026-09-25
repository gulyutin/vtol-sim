import { describe, expect, it } from 'vitest';
import { parseOsm } from '../src/sim/osm';
import { buildOsm, corridorRects, createOverpass, encodeOsm, planOsm, rectTrackDist, type OverpassElement, type OverpassPoint, type Rect } from '../src/sim/osmBuild';

/*
 * Сборка osm.bin из ответов Overpass (src/sim/osmBuild.ts) без сети: отбор квадратов коридора
 * вокруг траектории, запись → parseOsm на синтетических элементах, повторы запросов.
 * Координаты условные: площадка в точке (10°, 20°), всё остальное — метры от неё.
 */

const SITE = { lat: 10, lon: 20 };
const R = 6371000;
const RAD = Math.PI / 180;
/** Локальные метры → широта и долгота (обратно toLocal). */
const geo = (e: number, n: number): OverpassPoint => ({ lat: SITE.lat + n / R / RAD, lon: SITE.lon + e / (R * Math.cos(SITE.lat * RAD)) / RAD });
const boundsOf = (e0: number, n0: number, e1: number, n1: number) => {
  const a = geo(e0, n0);
  const b = geo(e1, n1);
  return { south: a.lat, west: a.lon, north: b.lat, east: b.lon };
};
const line = (pts: [number, number][]) => pts.map(([e, n]) => geo(e, n));
/** Замкнутая линия — с повтором первой точки, как в OSM. */
const closed = (pts: [number, number][]) => line([...pts, pts[0]!]);
/** Прямоугольник против часовой стрелки. */
const box = (e: number, n: number, w: number, h: number): [number, number][] => [
  [e, n],
  [e + w, n],
  [e + w, n + h],
  [e, n + h],
];
const numbered = (label: string, k: number) => Array.from({ length: k }, (_, i) => `${label} ${i + 1}/${k}`);
const inside = (r: Rect, e: number, n: number) => e >= r[0] && e <= r[2] && n >= r[1] && n <= r[3];

describe('области запросов', () => {
  it('без траектории — прежние квадраты и подписи', () => {
    const plan = planOsm({ site: SITE, bounds: boundsOf(-15000, -15000, 15000, 15000) });
    expect(plan.corridor).toBe(false);
    expect(plan.jobs.map((j) => j.label)).toEqual([
      ...numbered('дома', 4),
      'сооружения',
      ...numbered('леса', 4),
      'полосы',
      ...numbered('дороги', 9),
      ...numbered('вода', 4),
      'реки',
      ...numbered('площадки', 4),
    ]);
    // Запас 3 км вокруг области.
    const [e0, n0, e1, n1] = plan.area;
    for (const [v, want] of [[e0, -18000], [n0, -18000], [e1, 18000], [n1, 18000]] as const) expect(Math.abs(v - want)).toBeLessThan(20);
    // Дома — четыре квадранта по 14 км вокруг площадки.
    expect(plan.jobs.filter((j) => j.kind === 'buildings').map((j) => j.rect)).toEqual([
      [-14000, -14000, 0, 0],
      [-14000, 0, 0, 14000],
      [0, -14000, 14000, 0],
      [0, 0, 14000, 14000],
    ]);
  });

  it('коридор вдоль прямой: всё в 6 км от траектории покрыто, дальше 8 км — нет', () => {
    const area: Rect = [-10000, -5000, 10000, 95000];
    const track = [0, 0, 0, 90000];
    const rects = corridorRects(area, track, { bufferM: 6000, cellM: 2000, blockM: 20000 });
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length).toBeLessThanOrEqual(5);
    for (const r of rects) expect(rectTrackDist(r, track)).toBeLessThanOrEqual(6000);
    for (let n = -5000; n <= 95000; n += 1000) {
      for (let e = -10000; e <= 10000; e += 500) {
        const d = n < 0 ? Math.hypot(e, n) : n > 90000 ? Math.hypot(e, n - 90000) : Math.abs(e);
        const covered = rects.some((r) => inside(r, e, n));
        if (d <= 6000) expect(covered, `${e},${n}`).toBe(true);
        if (Math.abs(e) >= 8500) expect(covered, `${e},${n}`).toBe(false);
      }
    }
  });

  it('коридор по диагонали квадрата не тянет дальние углы', () => {
    const area: Rect = [0, 0, 60000, 60000];
    const track = [0, 0, 60000, 60000];
    const rects = corridorRects(area, track, { bufferM: 6000, cellM: 2000, blockM: 20000 });
    for (const r of rects) expect(rectTrackDist(r, track)).toBeLessThanOrEqual(6000);
    const covered = (e: number, n: number) => rects.some((r) => inside(r, e, n));
    expect(covered(30000, 30000)).toBe(true);
    expect(covered(33000, 27000)).toBe(true);
    expect(covered(58000, 2000)).toBe(false);
    expect(covered(2000, 58000)).toBe(false);
    const sum = rects.reduce((s, r) => s + (r[2] - r[0]) * (r[3] - r[1]), 0);
    expect(sum).toBeLessThan(0.7 * 60000 * 60000);
  });

  it('одна точка вместо траектории — круг вокруг неё', () => {
    const rects = corridorRects([-20000, -20000, 20000, 20000], [5000, 5000], { bufferM: 3000, cellM: 1000, blockM: 14000 });
    expect(rects.some((r) => inside(r, 5000, 5000))).toBe(true);
    expect(rects.some((r) => inside(r, -5000, -5000))).toBe(false);
    for (const r of rects) expect(rectTrackDist(r, [5000, 5000])).toBeLessThanOrEqual(3000);
  });

  it('с траекторией — леса, дороги и вода в 6 км, дома в 3 км и у площадки', () => {
    const path: [number, number][] = [
      [0, 0],
      [1500, 30000],
      [-2000, 60000],
      [0, 80000],
    ];
    const local = path.flat();
    const plan = planOsm({ site: SITE, bounds: boundsOf(-10500, -8000, 10500, 88000), track: path.map(([e, n]) => geo(e, n)) });
    expect(plan.corridor).toBe(true);
    const labels = plan.jobs.map((j) => j.label);
    expect(labels).not.toContain('реки');
    expect(labels).toContain('сооружения');
    expect(labels).toContain('полосы');
    for (const kind of ['forests', 'roads', 'water'] as const) {
      const jobs = plan.jobs.filter((j) => j.kind === kind);
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) expect(rectTrackDist(j.rect, local)).toBeLessThanOrEqual(6000 + 1);
      // Конец перелёта покрыт.
      expect(jobs.some((j) => inside(j.rect, 0, 80000))).toBe(true);
    }
    const houses = plan.jobs.filter((j) => j.kind === 'buildings');
    expect(houses.slice(0, 4).map((j) => j.rect)).toEqual([
      [-14000, -14000, 0, 0],
      [-14000, 0, 0, 14000],
      [0, -14000, 14000, 0],
      [0, 0, 14000, 14000],
    ]);
    expect(houses.length).toBeGreaterThan(4);
    for (const j of houses.slice(4)) {
      expect(rectTrackDist(j.rect, local)).toBeLessThanOrEqual(3000 + 1);
      // Целиком внутри квадрата у площадки — уже запрошено.
      expect(j.rect[0] >= -14000 && j.rect[2] <= 14000 && j.rect[1] >= -14000 && j.rect[3] <= 14000).toBe(false);
    }
    expect(houses.some((j) => inside(j.rect, 0, 80000))).toBe(true);
    expect(labels.filter((l) => l.startsWith('дома '))).toEqual(numbered('дома', houses.length));
  });
});

// --- синтетические ответы Overpass ---

const way = (id: number, geometry: OverpassPoint[], tags: Record<string, string>): OverpassElement => ({ type: 'way', id, geometry, tags });
const BUILDINGS: OverpassElement[] = [
  way(1, closed(box(100, 200, 20, 10)), { building: 'apartments', 'building:levels': '5' }),
  way(2, closed(box(300, 300, 8, 8)), { building: 'church' }),
  way(3, closed(box(50, 50, 2, 3)), { building: 'shed' }),
  way(4, closed(box(20000, 0, 10, 10)), { building: 'house' }),
  {
    type: 'relation',
    id: 5,
    tags: { building: 'yes', type: 'multipolygon', height: '12', 'roof:height': '2', 'roof:shape': 'gabled' },
    members: [
      { type: 'way', role: 'outer', geometry: line([[500, 500], [530, 500], [530, 530]]) },
      { type: 'way', role: 'outer', geometry: line([[530, 530], [500, 530], [500, 500]]) },
    ],
  },
  way(6, closed(box(700, 0, 10, 10)), { building: 'house' }),
  // Далеко от площадки, но у траектории (для коридора).
  way(7, closed(box(500, 60000, 12, 12)), { building: 'house' }),
  way(8, closed(box(9000, 60000, 12, 12)), { building: 'house' }),
];
const STRUCTURES: OverpassElement[] = [
  { type: 'node', id: 10, ...geo(1000, 1000), tags: { man_made: 'mast', height: '60' } },
  { ...BUILDINGS[0]!, tags: { man_made: 'tower' } },
  { type: 'node', id: 11, ...geo(1200, 1000), tags: { man_made: 'tower', 'tower:type': 'lighting' } },
  { type: 'node', id: 12, ...geo(-800, 70000), tags: { man_made: 'chimney' } },
];
const FORESTS: OverpassElement[] = [
  {
    type: 'relation',
    id: 20,
    tags: { landuse: 'forest', leaf_type: 'needleleaved', type: 'multipolygon' },
    members: [
      { type: 'way', role: 'outer', geometry: closed(box(-2000, -2000, 1000, 1000)) },
      { type: 'way', role: 'inner', geometry: closed(box(-1700, -1700, 300, 300)) },
    ],
  },
  way(21, closed(box(0, -3000, 10, 10)), { landuse: 'forest' }),
  way(22, closed(box(3000, 3000, 500, 500)), { natural: 'wood', leaf_type: 'broadleaved' }),
];
const RUNWAYS: OverpassElement[] = [way(30, line([[-500, 1000], [500, 1000]]), { aeroway: 'runway', surface: 'asphalt', width: '45' })];
const ROADS: OverpassElement[] = [
  way(40, line([[0, -100], [1000, -100]]), { highway: 'primary', bridge: 'yes', lit: 'yes' }),
  way(41, line([[0, -150], [300, -150]]), { highway: 'service', service: 'driveway' }),
  way(42, line([[0, -200], [800, -200]]), { highway: 'track' }),
  way(43, line([[0, -300], [900, -300]]), { railway: 'rail' }),
  way(44, line([[0, -400], [900, -400]]), { highway: 'residential', tunnel: 'yes' }),
];
const LAKE = box(2000, -1000, 400, 400);
const WATER: OverpassElement[] = [way(50, closed(LAKE), { natural: 'water' }), way(51, closed(box(5000, 5000, 100, 100)), { natural: 'water', intermittent: 'yes' })];
// Река через озеро зигзагом — точки не выпадают при упрощении и не лежат на берегу.
const RIVER = Array.from({ length: 9 }, (_, i): [number, number] => [1850 + i * 100, -800 + (i % 2) * 20]);
const WATERWAYS: OverpassElement[] = [way(60, line(RIVER), { waterway: 'river' })];
const PAVED: OverpassElement[] = [
  way(70, closed(box(300, 300, 60, 40)), { amenity: 'parking', surface: 'asphalt' }),
  way(71, closed(box(400, 300, 60, 40)), { amenity: 'parking', parking: 'underground' }),
  way(72, closed(box(500, 300, 60, 40)), { amenity: 'parking', surface: 'grass' }),
  way(73, closed(box(600, 300, 5, 5)), { amenity: 'parking' }),
  way(74, closed(box(700, 300, 80, 80)), { place: 'square' }),
];

/** Ответ по тексту запроса; каждый квадрат получает всё — повторы на стыках убирает сборка. */
function fake(q: string): OverpassElement[] {
  if (q.includes('way["building"]')) return BUILDINGS;
  if (q.includes('"amenity"="parking"')) return PAVED;
  if (q.includes('nwr["man_made"')) return STRUCTURES;
  if (q.includes('"landuse"="forest"')) return FORESTS;
  if (q.includes('"aeroway"="runway"')) return RUNWAYS;
  if (q.includes('way["highway"')) return ROADS;
  const rivers = q.includes('way["waterway"~');
  if (q.includes('"natural"="water"')) return rivers ? [...WATER, ...WATERWAYS] : WATER;
  if (rivers) return WATERWAYS;
  throw new Error(`неизвестный запрос: ${q}`);
}

describe('сборка и запись', () => {
  it('ответы Overpass → osm.bin → parseOsm', async () => {
    const progress: string[] = [];
    const { data, stats } = await buildOsm(
      { site: SITE, bounds: boundsOf(-15000, -15000, 15000, 15000), minBuildingArea: 10, overrides: { w6: { height: 30, roof: 'hipped', kind: 'industrial', levels: 7 } } },
      async (q) => fake(q),
      (done, total, label) => progress.push(`${done}/${total} ${label}`),
    );
    expect(progress[0]).toBe('0/28 дома 1/4');
    expect(progress.at(-1)).toBe('28/28 готово');
    expect(stats).toEqual({ dropped: 1, landmarks: 1, structures: 1, roadsDropped: 1, inside: 3 });

    const { bytes, sizes } = encodeOsm(data);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('OSM2');
    expect(Object.values(sizes).reduce((a, b) => a + b, 0)).toBe(bytes.length);
    const osm = parseOsm(bytes.buffer);

    // Дома: сарай отброшен по площади, дальние (вне 14 км, без траектории) не взяты; мачта — последней.
    expect(osm.buildings.map((b) => [b.kind, b.heightM, b.levels, b.roof])).toEqual([
      ['apartments', 16, 5, 'auto'],
      ['other', 14, 0, 'pyramidal'],
      ['other', 10, 0, 'gabled'],
      ['industrial', 30, 7, 'hipped'],
      ['other', 60, 0, 'flat'],
    ]);
    const ring = Array.from(osm.buildings[0]!.ring);
    [100, 200, 120, 200, 120, 210, 100, 210].forEach((v, i) => expect(ring[i]).toBeCloseTo(v, 1));
    expect(osm.buildings[2]!.ring.length).toBe(8);
    const mast = osm.buildings[4]!.ring;
    expect(mast.length).toBe(16);
    let ce = 0;
    let cn = 0;
    for (let i = 0; i < 8; i++) {
      ce += mast[2 * i]! / 8;
      cn += mast[2 * i + 1]! / 8;
    }
    expect(ce).toBeCloseTo(1000, 0);
    expect(cn).toBeCloseTo(1000, 0);

    // Леса: мелкий отброшен, у хвойного — поляна.
    expect(osm.forests.map((f) => [f.leaf, f.rings.length])).toEqual([
      ['needle', 2],
      ['broad', 1],
    ]);
    expect(osm.runways).toHaveLength(1);
    expect(osm.runways[0]).toMatchObject({ paved: true, widthM: 45 });
    Array.from(osm.runways[0]!.line).forEach((v, i) => expect(v).toBeCloseTo([-500, 1000, 500, 1000][i]!, 1));

    // Дороги: проезд к дому и тоннель пропущены.
    expect(osm.roads.map((r) => [r.cls, r.widthM, r.paved, r.bridge, r.lit])).toEqual([
      ['primary', 8, true, true, true],
      ['track', 3, false, false, false],
      ['rail', 4, true, false, false],
    ]);

    // Вода: пересыхающий пруд пропущен; река разрезана озером на два куска вне воды.
    expect(osm.water.map((w) => [w.kind, w.rings.length])).toEqual([['lake', 1]]);
    expect(osm.waterways.map((w) => [w.kind, w.widthM])).toEqual([
      ['river', 10],
      ['river', 10],
    ]);
    for (const w of osm.waterways) {
      for (let i = 0; i + 3 < w.line.length; i += 2) {
        const me = (w.line[i]! + w.line[i + 2]!) / 2;
        expect(me > 2050 && me < 2350).toBe(false);
      }
    }

    // Асфальт площадями: подземная, травяная и крошечная парковки пропущены.
    expect(osm.paved).toHaveLength(2);
    const r = osm.paved[0]!.rings[0]!;
    for (let i = 0; i < r.length; i += 2) expect(r[i]! >= 299.9 && r[i]! <= 360.1 && r[i + 1]! >= 299.9 && r[i + 1]! <= 340.1).toBe(true);
  });

  it('коридор: дома у траектории далеко от площадки остаются, в стороне — нет; реки — с водой', async () => {
    const labels: string[] = [];
    const { data } = await buildOsm(
      { site: SITE, bounds: boundsOf(-10500, -8000, 10500, 88000), track: [geo(0, 0), geo(0, 80000)] },
      async (q, label) => {
        labels.push(label);
        return fake(q);
      },
    );
    expect(labels).not.toContain('реки');
    const osm = parseOsm(encodeOsm(data).bytes.buffer);
    const centre = (r: Float32Array) => {
      let e = 0;
      let n = 0;
      for (let i = 0; i < r.length; i += 2) {
        e += (2 * r[i]!) / r.length;
        n += (2 * r[i + 1]!) / r.length;
      }
      return [Math.round(e / 100) * 100, Math.round(n / 100) * 100];
    };
    const centres = osm.buildings.map((b) => centre(b.ring));
    expect(centres).toContainEqual([500, 60000]);
    expect(centres).not.toContainEqual([9000, 60000]);
    // Труба у траектории в 70 км от площадки.
    expect(centres).toContainEqual([-800, 70000]);
    // Дом в 20 км от площадки и в 20 км от траектории — нет.
    expect(centres).not.toContainEqual([20000, 0]);
    expect(osm.waterways).toHaveLength(2);
    expect(osm.water).toHaveLength(1);
  });
});

describe('Overpass: очередь и повторы', () => {
  const ok = (elements: unknown[]) => ({ status: 200, json: async () => ({ elements }) });

  it('429 и ошибка выполнения — повтор на другом сервере с растущим ожиданием; между запросами — пауза', async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const sleeps: number[] = [];
    const replies = [{ status: 429, json: async () => ({}) }, { status: 200, json: async () => ({ remark: 'runtime error: Query timed out' }) }, ok([{ type: 'node', id: 1 }]), ok([])];
    const warns: string[] = [];
    const q = createOverpass({
      post: async (url, body) => {
        urls.push(url);
        bodies.push(body);
        return replies.shift()!;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      warn: (m) => warns.push(m),
    });
    expect(await q('[out:json];node(1);out;', 'проба')).toEqual([{ type: 'node', id: 1 }]);
    expect(urls).toHaveLength(3);
    expect(new Set(urls).size).toBe(3);
    expect(bodies[0]).toBe('data=' + encodeURIComponent('[out:json];node(1);out;'));
    expect(sleeps).toEqual([30000, 60000]);
    expect(warns).toHaveLength(2);
    expect(await q('[out:json];node(2);out;', 'проба 2')).toEqual([]);
    expect(sleeps).toEqual([30000, 60000, 3000]);
  });

  it('400 — сразу ошибка; отмена — без повторов', async () => {
    let calls = 0;
    const bad = createOverpass({
      post: async () => {
        calls++;
        return { status: 400, json: async () => ({}) };
      },
      sleep: async () => undefined,
    });
    await expect(bad('x', 'проба')).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);

    calls = 0;
    const abort = new Error('отменено');
    abort.name = 'AbortError';
    const cancelled = createOverpass({
      post: async () => {
        calls++;
        throw abort;
      },
      sleep: async () => undefined,
      aborted: () => true,
    });
    await expect(cancelled('x', 'проба')).rejects.toBe(abort);
    expect(calls).toBe(1);
  });
});
