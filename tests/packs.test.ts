import { describe, expect, it } from 'vitest';
import { mercatorPixel } from '../src/sim/terrain';
import {
  chooseSources,
  corridorAreas,
  countTiles,
  expandBounds,
  layerCovers,
  levelsFor,
  missionGeometry,
  packCoversBounds,
  parseManifest,
  parseZooms,
  planPack,
  AVG_IMAGERY_TILE_BYTES,
  AVG_TERRAIN_TILE_BYTES,
  PACK_FORMAT,
  type PackManifest,
} from '../src/ui/packFormat';

/*
 * Пакеты районов для работы без сети (src/ui/packFormat.ts): выбор источника тайла, покрытие
 * тайла пакетом, число тайлов для --dry-run сборщика и разбор manifest.json.
 */

/** Хибины (публичный район): область и она же с запасом 3 км, как у рельефа. */
const REGION = { south: 67.5, west: 33.25, north: 67.8, east: 33.75 };
const AREA = expandBounds(REGION, 3000);

/** Число тайлов области на уровне z — по той же формуле, что loadTerrain. */
function loadTerrainTiles(b: typeof AREA, z: number) {
  const nw = mercatorPixel({ lat: b.north, lon: b.west }, z);
  const se = mercatorPixel({ lat: b.south, lon: b.east }, z);
  const x0 = Math.floor(nw.x / 256);
  const y0 = Math.floor(nw.y / 256);
  return { x0, y0, cols: Math.floor(se.x / 256) - x0 + 1, rows: Math.floor(se.y / 256) - y0 + 1 };
}

function manifest(over: Partial<PackManifest> = {}): Record<string, unknown> {
  return {
    format: PACK_FORMAT,
    id: 'khibiny',
    title: 'Хибины',
    bounds: AREA,
    created: '2026-09-13T10:00:00.000Z',
    bytes: 1234,
    tiles: 10,
    terrain: { encoding: 'terrarium', levels: levelsFor([8, 9, 10, 11, 12], [AREA]), tiles: 10, bytes: 1000, missing: 0, source: 'AWS Terrain Tiles', license: 'AWS Open Data' },
    imagery: null,
    osm: { file: 'osm.bin', bytes: 234, source: 'OpenStreetMap', license: 'ODbL 1.0' },
    ...over,
  };
}

describe('выбор источника тайла', () => {
  it('с сетью: сначала пакет, потом кэш рельефа, потом сеть', () => {
    expect(chooseSources({ inPack: true, offline: false, persistentCache: true })).toEqual(['pack', 'cache', 'net']);
    expect(chooseSources({ inPack: false, offline: false, persistentCache: true })).toEqual(['cache', 'net']);
  });

  it('снимки — без постоянного кэша: пакет, иначе сеть', () => {
    expect(chooseSources({ inPack: true, offline: false })).toEqual(['pack', 'net']);
    expect(chooseSources({ inPack: false, offline: false })).toEqual(['net']);
  });

  it('без сети — только пакет и кэш; вне пакета снимков нет вовсе, без запросов', () => {
    expect(chooseSources({ inPack: true, offline: true, persistentCache: true })).toEqual(['pack', 'cache']);
    expect(chooseSources({ inPack: true, offline: true })).toEqual(['pack']);
    expect(chooseSources({ inPack: false, offline: true })).toEqual([]);
  });
});

describe('покрытие тайла пакетом', () => {
  const layer = { levels: levelsFor([8, 9, 10, 11, 12], [AREA]) };
  const t = loadTerrainTiles(AREA, 12);

  it('покрыты все тайлы, которые берёт loadTerrain, и только они', () => {
    for (let j = 0; j < t.rows; j++) for (let i = 0; i < t.cols; i++) expect(layerCovers(layer, 12, t.x0 + i, t.y0 + j)).toBe(true);
    expect(layerCovers(layer, 12, t.x0 - 1, t.y0)).toBe(false);
    expect(layerCovers(layer, 12, t.x0 + t.cols, t.y0)).toBe(false);
    expect(layerCovers(layer, 12, t.x0, t.y0 + t.rows)).toBe(false);
  });

  it('уровня нет в пакете — не покрыт; нет слоя — не покрыт', () => {
    expect(layerCovers(layer, 13, t.x0 * 2, t.y0 * 2)).toBe(false);
    expect(layerCovers(layer, 7, t.x0 >> 5, t.y0 >> 5)).toBe(false);
    expect(layerCovers(null, 12, t.x0, t.y0)).toBe(false);
  });

  it('коридор: детальные уровни — только у площадки и маршрута', () => {
    const site = { lat: 67.577, lon: 33.5804 };
    const far = { lat: 67.79, lon: 33.27 };
    const plan = planPack({ bounds: AREA, terrainZooms: [12], imageryZooms: parseZooms('10-16'), corridor: { spec: { km: 1, fromZoom: 14 }, areas: corridorAreas({ points: [site], lines: [] }, 1) } });
    const imagery = { levels: plan.imagery!.levels };
    const tile = (p: { lat: number; lon: number }, z: number) => {
      const m = mercatorPixel(p, z);
      return [Math.floor(m.x / 256), Math.floor(m.y / 256)] as const;
    };
    expect(layerCovers(imagery, 16, ...tile(site, 16))).toBe(true);
    expect(layerCovers(imagery, 16, ...tile(far, 16))).toBe(false);
    // Ниже коридорного уровня — вся область.
    expect(layerCovers(imagery, 13, ...tile(far, 13))).toBe(true);
  });

  it('пакет покрывает район, если рельеф z12 есть на всей его области', () => {
    const m = parseManifest(manifest());
    expect(packCoversBounds(m, AREA)).toBe(true);
    expect(packCoversBounds(m, expandBounds(AREA, 20_000))).toBe(false);
  });
});

describe('число тайлов для --dry-run', () => {
  it('z12 — ровно столько, сколько грузит loadTerrain', () => {
    const t = loadTerrainTiles(AREA, 12);
    expect(countTiles(levelsFor([12], [AREA])).total).toBe(t.cols * t.rows);
  });

  it('по уровням — сумма, каждый уровень — прямоугольник тайлов области', () => {
    const c = countTiles(levelsFor(parseZooms('8-12'), [AREA]));
    let sum = 0;
    for (let z = 8; z <= 12; z++) {
      const t = loadTerrainTiles(AREA, z);
      expect(c.perZoom[z]).toBe(t.cols * t.rows);
      sum += t.cols * t.rows;
    }
    expect(c.total).toBe(sum);
  });

  it('перекрывающиеся области не считаются дважды', () => {
    const one = countTiles(levelsFor([12], [AREA])).total;
    expect(countTiles(levelsFor([12], [AREA, REGION, AREA])).total).toBe(one);
  });

  it('объём — тайлы на средний размер; коридор меньше всей области', () => {
    const zooms = parseZooms('10-16');
    const full = planPack({ bounds: AREA, terrainZooms: parseZooms('8-12'), imageryZooms: zooms });
    const geom = missionGeometry({ site: { lat: 67.577, lon: 33.5804 }, delivery: { destination: { lat: 67.5548, lon: 33.3359 }, route: [{ lat: 67.57, lon: 33.47 }] } });
    const near = planPack({ bounds: AREA, terrainZooms: parseZooms('8-12'), imageryZooms: zooms, corridor: { spec: { km: 2, fromZoom: 14 }, areas: corridorAreas(geom, 2) } });
    expect(full.bytes).toBe(full.terrain.total * AVG_TERRAIN_TILE_BYTES + full.imagery!.total * AVG_IMAGERY_TILE_BYTES);
    expect(near.terrain.total).toBe(full.terrain.total);
    expect(near.imagery!.total).toBeLessThan(full.imagery!.total / 3);
    // Уровни ниже коридорного одинаковы.
    for (const z of [10, 11, 12, 13]) expect(near.imagery!.perZoom[z]).toBe(full.imagery!.perZoom[z]);
    expect(planPack({ bounds: AREA, terrainZooms: [12] }).imagery).toBeNull();
  });

  it('уровни zoom из строки', () => {
    expect(parseZooms('10-12')).toEqual([10, 11, 12]);
    expect(parseZooms('8,10-11,8')).toEqual([8, 10, 11]);
    expect(() => parseZooms('12-10')).toThrow();
    expect(() => parseZooms('a')).toThrow();
  });
});

describe('маршруты района для коридора', () => {
  it('площадка, участок, маршруты от площадки к пункту и обратно; область района — не точка', () => {
    const site = { lat: 67.577, lon: 33.5804 };
    const g = missionGeometry({
      site,
      region: REGION,
      survey: { title: '', briefing: '', area: [site, { lat: 67.59, lon: 33.51 }, { lat: 67.59, lon: 33.55 }] },
      transfer: { destination: { lat: 67.668, lon: 33.645 }, route: [{ lat: 67.632, lon: 33.672, heightAglM: 150 }] },
      route: { briefing: '', route: [{ lat: 67.55, lon: 33.45, heightAglM: 150 }] },
    });
    expect(g.lines).toContainEqual([site, { lat: 67.632, lon: 33.672, heightAglM: 150 }, { lat: 67.668, lon: 33.645 }, site]);
    expect(g.lines).toContainEqual([site, { lat: 67.55, lon: 33.45, heightAglM: 150 }, site]);
    expect(g.lines.some((l) => l.length === 4 && l[0] === l[3])).toBe(true);
    expect(g.points.every((p) => p.lat !== REGION.south)).toBe(true);
    const areas = corridorAreas(g, 2);
    const inside = (p: { lat: number; lon: number }) => areas.some((a) => p.lat >= a.south && p.lat <= a.north && p.lon >= a.west && p.lon <= a.east);
    // Середина плеча к пункту Б — в коридоре.
    expect(inside({ lat: (67.632 + 67.668) / 2, lon: (33.672 + 33.645) / 2 })).toBe(true);
    expect(inside({ lat: 67.79, lon: 33.27 })).toBe(false);
  });
});

describe('разбор manifest.json', () => {
  it('правильный манифест: уровни, слои, OSM; снимков нет — null', () => {
    const m = parseManifest(JSON.parse(JSON.stringify(manifest())));
    expect(m.id).toBe('khibiny');
    expect(m.terrain.zooms).toEqual([8, 9, 10, 11, 12]);
    expect(m.imagery).toBeNull();
    expect(m.osm?.license).toBe('ODbL 1.0');
  });

  it('снимки — с источником, лицензией и коридором', () => {
    const imagery = { format: 'jpg', levels: [...levelsFor([10, 11], [AREA]), ...levelsFor([14], [REGION])], tiles: 5, bytes: 50, missing: 1, source: 'Ортофото заказчика', license: 'Договор № 1', corridorKm: 2 };
    const m = parseManifest(manifest({ imagery: imagery as unknown as PackManifest['imagery'] }));
    expect(m.imagery?.zooms).toEqual([10, 11, 14]);
    expect(m.imagery?.license).toBe('Договор № 1');
    expect(m.imagery?.corridorKm).toBe(2);
    expect(m.imagery?.missing).toBe(1);
  });

  it('ошибки — с понятным текстом', () => {
    expect(() => parseManifest(null)).toThrow(/не объект/);
    expect(() => parseManifest(manifest({ format: 2 as 1 }))).toThrow(/версия формата/);
    expect(() => parseManifest({ ...manifest(), id: '../x' })).toThrow(/id/);
    expect(() => parseManifest({ ...manifest(), created: 'вчера' })).toThrow(/created/);
    expect(() => parseManifest({ ...manifest(), bounds: { south: 1, west: 2, north: 0, east: 3 } })).toThrow(/bounds/);
    const noLicense = { format: 'jpg', levels: levelsFor([10], [AREA]), tiles: 1, bytes: 1, source: 'X' };
    expect(() => parseManifest(manifest({ imagery: noLicense as unknown as PackManifest['imagery'] }))).toThrow(/imagery\.license/);
    expect(() => parseManifest({ ...manifest(), terrain: { levels: [{ minZoom: 12, maxZoom: 10, areas: [AREA] }], tiles: 1, bytes: 1, source: 'a', license: 'b' } })).toThrow(/уровни/);
  });
});
