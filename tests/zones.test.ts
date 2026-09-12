import { describe, expect, it } from 'vitest';
import { blocked, zoneChecks } from '../src/game/preflight';
import { eventKindOf, parseRecording, serialize, type Recording, type RecordingEvent, type Sample } from '../src/game/recorder';
import { assessFlight, type AssessInput } from '../src/game/scoring';
import { parseZonesFile, parseZonesGeoJSON, parseZonesKML, zonesToGeoJSON } from '../src/game/zonesGeoJson';
import { environmentAlerts, LINK_TIMEOUT_S, NAV_MISMATCH_WARN_MS } from '../src/sim/failures';
import { LiveFlight, type Controls, type LiveState } from '../src/sim/flight';
import { fromLocal } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { GeoPoint, MissionPlan, Site, Weather } from '../src/sim/types';
import {
  routeZoneCrossings,
  routeZoneExposure,
  segmentIntersectsZone,
  zoneContains,
  zoneContour,
  zoneDistanceM,
  zoneEffectsAt,
  zoneStrength,
  type Zone,
} from '../src/sim/zones';

/*
 * Запретные зоны и зоны РЭБ: геометрия, файлы зон, живой полёт через помехи, предполётная
 * проверка, оценка. Место условное — ровное поле, маршрут на восток по линии north = 0.
 */

const site: Site = { lat: 45, lon: 10, elevationM: 200 };
const at = (east: number, north: number): GeoPoint => fromLocal(site, east, north);
const circle = (id: string, kind: Zone['kind'], east: number, north: number, radiusM: number, extra: Partial<Zone> = {}): Zone => ({
  id,
  kind,
  center: at(east, north),
  radiusM,
  ...extra,
});
const poly = (id: string, kind: Zone['kind'], pts: [number, number][], extra: Partial<Zone> = {}): Zone => ({ id, kind, polygon: pts.map(([e, n]) => at(e, n)), ...extra });

describe('геометрия зон', () => {
  const c = circle('c', 'nofly', 0, 0, 1000);
  const L = poly('l', 'nofly', [
    [0, 0],
    [2000, 0],
    [2000, 500],
    [500, 500],
    [500, 2000],
    [0, 2000],
  ]);

  it('круг: внутри, снаружи, знаковое расстояние', () => {
    expect(zoneContains(c, at(500, 0))).toBe(true);
    expect(zoneContains(c, at(1100, 0))).toBe(false);
    expect(zoneDistanceM(c, at(1500, 0))).toBeCloseTo(500, 0);
    expect(zoneDistanceM(c, at(0, 0))).toBeCloseTo(-1000, 0);
  });

  it('невыпуклый многоугольник: вырез снаружи', () => {
    expect(zoneContains(L, at(250, 1000))).toBe(true);
    expect(zoneContains(L, at(1000, 250))).toBe(true);
    expect(zoneContains(L, at(1000, 1000))).toBe(false);
    expect(zoneDistanceM(L, at(1000, 1000))).toBeCloseTo(500, 0);
  });

  it('пол и потолок: зона — призма', () => {
    const band = circle('b', 'nofly', 0, 0, 1000, { floorM: 500, ceilingM: 1000 });
    expect(zoneContains(band, at(0, 0), 700)).toBe(true);
    expect(zoneContains(band, at(0, 0), 1200)).toBe(false);
    expect(zoneContains(band, at(0, 0), 300)).toBe(false);
    expect(zoneDistanceM(band, at(0, 0), 1200)).toBeCloseTo(200, 0);
    // Без высоты — только план.
    expect(zoneContains(band, at(0, 0))).toBe(true);
  });

  it('сила помех: внутри 1, на 1,25 радиуса 0,5, с 1,5 радиуса 0; у запретной — только внутри', () => {
    const j = circle('j', 'gnss-jam', 0, 0, 1000);
    expect(zoneStrength(j, at(300, 0))).toBe(1);
    expect(zoneStrength(j, at(1250, 0))).toBeCloseTo(0.5, 2);
    expect(zoneStrength(j, at(1500, 0))).toBeCloseTo(0, 2);
    expect(zoneStrength(j, at(1700, 0))).toBe(0);
    expect(zoneStrength(c, at(1100, 0))).toBe(0);
    const fx = zoneEffectsAt([c, j, circle('s', 'gnss-spoof', 3000, 0, 500), circle('k', 'link-jam', 0, 0, 2000)], at(900, 0), 400);
    expect(fx.nofly.map((z) => z.id)).toEqual(['c']);
    expect(fx.gnssJam).toBe(1);
    expect(fx.gnssSpoof).toBe(0);
    expect(fx.linkJam).toBe(1);
  });

  it('пересечение отрезка: насквозь, мимо, с запасом, срезанный угол, по высоте', () => {
    expect(segmentIntersectsZone(c, at(-3000, 0), at(3000, 0))).toBe(true);
    expect(segmentIntersectsZone(c, at(-3000, 1500), at(3000, 1500))).toBe(false);
    expect(segmentIntersectsZone(c, at(-3000, 1500), at(3000, 1500), 600)).toBe(true);
    // Угол L у (2000, 0) срезан на ~70 м.
    expect(segmentIntersectsZone(L, at(1800, -100), at(2100, 200))).toBe(true);
    expect(segmentIntersectsZone(L, at(2100, -100), at(2300, 100))).toBe(false);
    const low = circle('low', 'nofly', 0, 0, 1000, { ceilingM: 1000 });
    expect(segmentIntersectsZone(low, { ...at(-3000, 0), altitudeM: 1200 }, { ...at(3000, 0), altitudeM: 1200 })).toBe(false);
    expect(segmentIntersectsZone(low, { ...at(-3000, 0), altitudeM: 1200 }, { ...at(3000, 0), altitudeM: 800 })).toBe(true);
  });

  it('маршрут: входы по порядку пути и длина под помехами', () => {
    const route = [at(-5000, 0), at(5000, 0)];
    const hits = routeZoneCrossings([circle('b', 'nofly', 2000, 0, 500), circle('a', 'nofly', -2000, 0, 500)], route);
    expect(hits.map((h) => h.zone.id)).toEqual(['a', 'b']);
    expect(hits[0]!.atM).toBeCloseTo(2500, -1);
    expect(hits[1]!.atM).toBeCloseTo(6500, -1);
    const exp = routeZoneExposure([circle('j', 'gnss-jam', 0, 0, 1000), c], route);
    expect(exp).toHaveLength(1);
    expect(exp[0]!.lengthM).toBeGreaterThan(2450);
    expect(exp[0]!.lengthM).toBeLessThan(2550);
  });

  it('контур кольца спадания лежит на заданном расстоянии от границы', () => {
    const lines = zoneContour(L, 300);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) for (const p of line) expect(Math.abs(zoneDistanceM(L, p) - 300)).toBeLessThan(40);
    const ring = zoneContour(c, 500)[0]!;
    for (const p of ring) expect(zoneDistanceM(c, p)).toBeCloseTo(500, 0);
  });
});

describe('файлы зон', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'p1',
        properties: { kind: 'prohibited', name: 'Полигон', floor: '0', ceiling: '1500 м' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [10, 45],
              [10.01, 45],
              [10.01, 45.01],
              [10, 45],
            ],
            [
              [10.002, 45.001],
              [10.004, 45.001],
              [10.004, 45.002],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { kind: 'jamming' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [10.1, 45],
                [10.11, 45],
                [10.11, 45.01],
              ],
            ],
            [
              [
                [10.2, 45],
                [10.21, 45],
                [10.21, 45.01],
              ],
            ],
          ],
        },
      },
      { type: 'Feature', properties: { kind: 'Spoofing', radius: '1500 м', name: 'Подмена' }, geometry: { type: 'Point', coordinates: [10.3, 45] } },
      { type: 'Feature', properties: { kind: 'link_jam', radiusM: 800 }, geometry: { type: 'Point', coordinates: [10.4, 45] } },
      { type: 'Feature', properties: { kind: 'nofly' }, geometry: { type: 'Point', coordinates: [10.5, 45] } },
      { type: 'Feature', properties: { kind: 'nofly' }, geometry: { type: 'LineString', coordinates: [[10, 45], [10.1, 45]] } },
      { type: 'Feature', properties: { type: 'CTR' }, geometry: { type: 'Polygon', coordinates: [[[10, 46], [10.01, 46], [10.01, 46.01]]] } },
      { type: 'Feature', properties: { kind: 'nofly' }, geometry: { type: 'Polygon', coordinates: [[[10, 46], [999, 46], [10.01, 46.01]]] } },
      'мусор',
    ],
  };

  it('GeoJSON: многоугольник, мультимногоугольник, круги, синонимы; непонятное — в предупреждения', () => {
    const { zones, warnings } = parseZonesGeoJSON(JSON.stringify(fc));
    expect(zones.map((z) => z.kind)).toEqual(['nofly', 'gnss-jam', 'gnss-jam', 'gnss-spoof', 'link-jam', 'nofly']);
    const p1 = zones[0]!;
    expect(p1).toMatchObject({ id: 'p1', name: 'Полигон', floorM: 0, ceilingM: 1500 });
    expect(p1.polygon).toHaveLength(3);
    expect(new Set(zones.map((z) => z.id)).size).toBe(zones.length);
    expect(zones[3]).toMatchObject({ name: 'Подмена', radiusM: 1500, center: { lat: 45, lon: 10.3 } });
    const w = warnings.join('\n');
    expect(w).toMatch(/отверстия/);
    expect(w).toMatch(/без радиуса/);
    expect(w).toMatch(/LineString/);
    expect(w).toMatch(/«CTR» непонятен/);
    expect(w).toMatch(/трёх годных вершин/);
    expect(w).toMatch(/не объект/);
  });

  it('GeoJSON: не JSON и пустое — не падает', () => {
    expect(parseZonesGeoJSON('{ это не json')).toEqual({ zones: [], warnings: ['Файл не разобран: это не JSON'] });
    expect(parseZonesGeoJSON('42').zones).toEqual([]);
    expect(parseZonesGeoJSON('{"type":"FeatureCollection","features":[]}').warnings).toEqual(['В файле нет зон']);
    const bare = parseZonesGeoJSON(JSON.stringify({ type: 'Polygon', coordinates: [[[10, 45], [10.01, 45], [10.01, 45.01]]] }));
    expect(bare.zones).toHaveLength(1);
    expect(bare.zones[0]!.kind).toBe('nofly');
  });

  it('сборка и разбор обратно дают те же зоны', () => {
    const zones: Zone[] = [
      circle('a', 'gnss-spoof', 1000, 0, 700, { name: 'А', ceilingM: 2000 }),
      poly('b', 'nofly', [
        [0, 0],
        [500, 0],
        [0, 500],
      ], { floorM: 100 }),
      circle('c', 'link-jam', -2000, 300, 1200),
    ];
    const back = parseZonesGeoJSON(zonesToGeoJSON(zones));
    expect(back.warnings).toEqual([]);
    expect(back.zones).toEqual(zones);
  });

  it('простой KML: многоугольник с видом в ExtendedData', () => {
    const kml = `<?xml version="1.0"?><kml><Document>
      <Placemark id="k1"><name>Связь &amp; помехи</name>
        <ExtendedData><Data name="kind"><value>link-jam</value></Data><Data name="ceiling"><value>900</value></Data></ExtendedData>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>10,45,0 10.01,45,0 10.01,45.01,0 10,45,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
      </Placemark>
      <Placemark><name>Круг</name><ExtendedData><Data name="radiusM"><value>500</value></Data></ExtendedData><Point><coordinates>10.2,45</coordinates></Point></Placemark>
      <Placemark><name>Линия</name><LineString><coordinates>10,45 10.1,45</coordinates></LineString></Placemark>
    </Document></kml>`;
    const { zones, warnings } = parseZonesFile(kml);
    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({ id: 'k1', kind: 'link-jam', name: 'Связь & помехи', ceilingM: 900 });
    expect(zones[0]!.polygon).toHaveLength(3);
    expect(zones[1]).toMatchObject({ kind: 'nofly', radiusM: 500 });
    expect(warnings.join('\n')).toMatch(/нет многоугольника или точки/);
    expect(parseZonesKML('<kml></kml>').warnings).toEqual(['В KML нет объектов Placemark']);
  });
});

/* --------------------------------- Живой полёт --------------------------------- */

const terrain = flatTerrain(site.elevationM);
const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 3, fromDeg: 200 } };
const LENGTH_M = 16000;
const plan: MissionPlan = {
  takeoff: site,
  landing: { ...at(LENGTH_M, 0), elevationM: site.elevationM },
  waypoints: [1500, 4000, 8000, 12000, LENGTH_M - 1500].map((e) => ({ ...at(e, 0), altitudeM: site.elevationM + 150 })),
  iasMs: 21,
  payload: null,
};
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 90, target: null };
const over = (f: LiveFlight) => f.state.mode === 'landed' || f.state.mode === 'crashed';
const gap = (a: { east: number; north: number }, b: { east: number; north: number }) => Math.hypot(a.east - b.east, a.north - b.north);

function flight(zones?: Zone[], seed = 1): LiveFlight {
  const f = new LiveFlight({ plan, terrain, weather, seed, ...(zones ? { zones } : {}) });
  f.rcRangeM = Infinity;
  f.command('arm');
  f.command('takeoff');
  return f;
}

function run(f: LiveFlight, until: (f: LiveFlight) => boolean, limitS: number, onTick?: (s: LiveState) => void) {
  const t0 = f.state.t;
  while (!until(f) && f.state.t < t0 + limitS) f.step(0.5, controls, onTick);
}

describe('зоны в живом полёте', () => {
  it('запретная зона на аппарат не действует, но вход и выход записаны; пустой список зон ничего не меняет', () => {
    const zones = [circle('nf', 'nofly', 6000, 0, 800, { name: 'Полигон' })];
    const plain = flight();
    const empty = flight([]);
    const withZone = flight(zones);
    let seen = false;
    while (!over(plain) && plain.state.t < 3600) {
      for (const f of [plain, empty, withZone]) f.step(0.5, controls);
      expect(withZone.state.east).toBe(plain.state.east);
      expect(empty.state.north).toBe(plain.state.north);
      if (withZone.state.ew.noflyIds.includes('nf')) seen = true;
    }
    expect(plain.state.mode).toBe('landed');
    expect(withZone.state.energyWh).toBe(plain.state.energyWh);
    expect(seen).toBe(true);
    expect(withZone.envEvents.map((e) => e.text)).toEqual(['ЗАПРЕТНАЯ ЗОНА: вход в «Полигон»', 'ЗАПРЕТНАЯ ЗОНА: выход из «Полигон»']);
    expect(plain.envEvents).toEqual([]);
  });

  it('подавление ГНСС: счисление в зоне, повторный захват с задержкой после выхода, оценка сходится', () => {
    const zones = [circle('j', 'gnss-jam', 6000, 300, 1200)];
    const f = flight(zones);
    let lostAt = NaN;
    let acqAt = NaN;
    let okAt = NaN;
    let maxErr = 0;
    let alert = false;
    run(f, (x) => !Number.isNaN(okAt) && x.state.t > okAt + 60, 3600, (s) => {
      if (s.ew.gnss === 'lost' && Number.isNaN(lostAt)) lostAt = s.t;
      if (s.ew.gnss === 'acquiring' && Number.isNaN(acqAt)) acqAt = s.t;
      if (s.ew.gnss === 'ok' && !Number.isNaN(acqAt) && Number.isNaN(okAt)) okAt = s.t;
      maxErr = Math.max(maxErr, gap(s.estimate, s));
    });
    expect(Number.isNaN(okAt)).toBe(false);
    expect(okAt - acqAt).toBeGreaterThanOrEqual(5);
    expect(okAt - acqAt).toBeLessThanOrEqual(40);
    expect(maxErr).toBeGreaterThan(10);
    expect(gap(f.state.estimate, f.state)).toBeLessThan(1);
    expect(f.state.failures).toEqual([]);
    const texts = f.events.map((e) => e.text);
    expect(texts.some((t) => t.startsWith('ГНСС: нет решения'))).toBe(true);
    expect(texts.some((t) => t.startsWith('ГНСС: повторный захват'))).toBe(true);
    expect(f.envEvents.map((e) => e.text)).toEqual(['РЭБ: вход в зону подавления ГНСС', 'РЭБ: выход из зоны подавления ГНСС']);
    // Тревога на НСУ — посреди зоны.
    const g = flight(zones);
    run(g, (x) => x.state.ew.gnss === 'lost', 3600);
    const a = environmentAlerts(g.telemetry, zones);
    alert = a.some((x) => x.level === 'bad' && x.text.startsWith('ГНСС: НЕТ РЕШЕНИЯ') && (x.actions?.length ?? 0) > 2);
    expect(alert).toBe(true);
    expect(lostAt).toBeGreaterThan(0);
    run(f, over, 3600);
    expect(f.state.mode).toBe('landed');
    expect(gap(f.state, f.landing)).toBeLessThan(30);
  });

  it('подмена ГНСС: на карте всё ровно, а трасса уходит вбок; признак — расхождение навигации; после выхода место сходится', () => {
    const zones = [circle('s', 'gnss-spoof', 7000, 0, 2500)];
    const f = flight(zones);
    let trueXte = 0;
    let estXte = 0;
    let offset = 0;
    let mismatch = 0;
    let seenWind = 0;
    let leakedToBoard = false;
    let navAlert = false;
    let releasedAt = NaN;
    // Уведённое место сходится к истинному после повторного захвата с постоянной времени 8 с.
    run(f, (x) => !Number.isNaN(releasedAt) && x.state.ew.gnss === 'ok' && x.state.t > releasedAt + 100, 3600, (s) => {
      if (s.ew.spoofed) {
        trueXte = Math.max(trueXte, Math.abs(s.north));
        estXte = Math.max(estXte, Math.abs(s.estimate.north));
        offset = Math.max(offset, s.ew.spoofOffsetM);
        const tele = f.telemetry;
        mismatch = Math.max(mismatch, tele.ew.navMismatchMs);
        seenWind = Math.max(seenWind, tele.wind.speedMs - s.wind.speedMs);
        if (tele.ew.spoofed || tele.ew.gnssSpoof > 0 || tele.ew.spoofOffsetM > 0) leakedToBoard = true;
        if (environmentAlerts(tele).some((a) => a.text.startsWith('НАВИГАЦИЯ НЕ СХОДИТСЯ'))) navAlert = true;
      } else if (offset > 0 && Number.isNaN(releasedAt)) releasedAt = s.t;
    });
    expect(offset).toBeGreaterThan(500);
    expect(trueXte).toBeGreaterThan(300);
    expect(estXte).toBeLessThan(60);
    expect(mismatch).toBeGreaterThan(NAV_MISMATCH_WARN_MS);
    expect(navAlert).toBe(true);
    expect(seenWind).toBeGreaterThan(3);
    expect(leakedToBoard).toBe(false);
    // Оценка сошлась, аппарат возвращается на трассу.
    expect(gap(f.state.estimate, f.state)).toBeLessThan(1);
    expect(f.envEvents.some((e) => /^РЭБ: подмена ГНСС прекратилась — место было уведено на \d+ м$/.test(e.text))).toBe(true);
    run(f, over, 3600);
    expect(f.state.mode).toBe('landed');
  });

  it('подмена детерминирована: тот же seed — тот же полёт', () => {
    const zones = [circle('s', 'gnss-spoof', 7000, 0, 2500)];
    const a = flight(zones, 7);
    const b = flight(zones, 7);
    run(a, (x) => x.state.t > 500, 600);
    run(b, (x) => x.state.t > 500, 600);
    expect(b.state.east).toBe(a.state.east);
    expect(b.state.north).toBe(a.state.north);
    expect(a.envEvents.some((e) => e.text.startsWith('РЭБ: подмена ГНСС — приёмник захвачен'))).toBe(true);
    expect(b.envEvents).toEqual(a.envEvents);
  });

  it('подавление связи: связи нет, пока борт в зоне; через таймаут — ВОЗВРАТ; вышел — связь вернулась', () => {
    const zones = [circle('k', 'link-jam', 6000, 0, 1500)];
    const f = flight(zones);
    run(f, (x) => x.state.linkLost, 3600);
    expect(f.state.linkLost).toBe(true);
    expect(f.rcInRange()).toBe(false);
    const frozen = f.telemetry.t;
    f.step(5, controls);
    expect(f.telemetry.t).toBe(frozen);
    expect(f.command('hold')).toBe('Нет связи с НСУ — команда не доставлена');
    run(f, (x) => x.state.mode === 'rtl', LINK_TIMEOUT_S + 5);
    expect(f.state.mode).toBe('rtl');
    expect(f.state.t - frozen).toBeGreaterThanOrEqual(LINK_TIMEOUT_S - 0.2);
    run(f, (x) => !x.state.linkLost, 600);
    expect(f.state.linkLost).toBe(false);
    expect(f.telemetry.t).toBe(f.state.t);
    expect(f.state.failures).toEqual([]);
    const texts = f.events.map((e) => e.text);
    expect(texts).toContain('Нет связи с НСУ: помехи в радиоканале');
    expect(texts).toContain(`Нет связи ${LINK_TIMEOUT_S} с — ВОЗВРАТ`);
    expect(texts[texts.length - 1]).toBe('Связь с НСУ восстановлена');
    run(f, over, 3600);
    expect(f.state.mode).toBe('landed');
    expect(gap(f.state, f.home)).toBeLessThan(30);
  });

  it('отказ связи и помехи вместе: снятый отказ не возвращает связь в зоне', () => {
    const zones = [circle('k', 'link-jam', 6000, 0, 1500)];
    const f = flight(zones);
    run(f, (x) => x.state.east > 3000, 3600);
    f.inject('link');
    run(f, (x) => x.state.ew.linkJam >= 0.5, 600);
    expect(f.restore('link')).toBe(true);
    expect(f.state.linkLost).toBe(true);
  });

  it('зона, нарисованная вокруг борта в полёте: не вход, но борт в ней и тревога на НСУ', () => {
    const f = flight();
    run(f, (x) => x.state.mode === 'auto' && x.state.t > 200, 3600);
    const p = at(f.state.east, f.state.north);
    const zones = [{ id: 'new', kind: 'nofly' as const, name: 'Новая', center: p, radiusM: 500 }];
    f.setZones(zones);
    expect(f.envEvents.map((e) => e.text)).toEqual(['ЗАПРЕТНАЯ ЗОНА: борт внутри новой зоны «Новая»']);
    expect(f.state.ew.noflyIds).toEqual(['new']);
    const a = environmentAlerts(f.telemetry, zones);
    expect(a[0]).toMatchObject({ level: 'bad', text: 'ЗАПРЕТНАЯ ЗОНА «Новая» — немедленно покинуть' });
    run(f, (x) => x.state.ew.noflyIds.length === 0, 600);
    expect(f.envEvents.map((e) => e.text)).toEqual(['ЗАПРЕТНАЯ ЗОНА: борт внутри новой зоны «Новая»', 'ЗАПРЕТНАЯ ЗОНА: выход из «Новая»']);
    f.setZones([]);
    expect(f.state.ew.noflyIds).toEqual([]);
  });

  it('отказ ГНСС в зоне помех — одна тревога отказа, без тревоги РЭБ', () => {
    const f = flight();
    run(f, (x) => x.state.mode === 'auto' && x.state.t > 200, 3600);
    f.inject('gnss');
    expect(f.state.ew.gnss).toBe('lost');
    expect(environmentAlerts(f.telemetry).some((a) => a.text.startsWith('ГНСС: НЕТ РЕШЕНИЯ'))).toBe(false);
  });
});

/* ------------------------------ Предполётная проверка ------------------------------ */

describe('предполётная проверка по зонам', () => {
  it('маршрут через запретную зону — взлёт запрещён', () => {
    const checks = zoneChecks([plan], [circle('nf', 'nofly', 6000, 0, 800, { name: 'Полигон' })]);
    expect(blocked(checks)).toBe(true);
    expect(checks.find((c) => !c.ok)!.text).toMatch(/заходит в запретную зону «Полигон» в 5,2 км от взлёта/);
  });

  it('над потолком зоны — можно; рядом с зоной — предупреждение', () => {
    // Маршрут на 150 м над землёй, потолок зоны — 100 м: не заходит, но в 50 м над ней — предупреждение.
    const under = zoneChecks([plan], [circle('nf', 'nofly', 6000, 0, 800, { ceilingM: site.elevationM + 100 })]);
    expect(blocked(under)).toBe(false);
    expect(under).toContainEqual({ ok: true, level: 'block', text: 'Запретные зоны (1): маршрут в них не заходит' });
    expect(under.some((c) => !c.ok && c.level === 'warn' && /ближе 200 м/.test(c.text))).toBe(true);
    const high = zoneChecks([plan], [circle('nf', 'nofly', 6000, 0, 800, { ceilingM: site.elevationM - 100 })]);
    expect(high).toEqual([{ ok: true, level: 'block', text: 'Запретные зоны (1): маршрут в них не заходит' }]);
    const near = zoneChecks([plan], [circle('nf', 'nofly', 6000, 900, 800)]);
    expect(blocked(near)).toBe(false);
    expect(near.some((c) => !c.ok && c.level === 'warn' && /ближе 200 м/.test(c.text))).toBe(true);
  });

  it('зоны РЭБ на маршруте — предупреждения с последствиями; НСУ в зоне подавления связи', () => {
    const checks = zoneChecks(
      [plan],
      [circle('j', 'gnss-jam', 6000, 0, 1000), circle('s', 'gnss-spoof', 11000, 0, 500), circle('k', 'link-jam', 0, 0, 400)],
      site,
    );
    expect(blocked(checks)).toBe(false);
    const warn = checks.filter((c) => !c.ok).map((c) => c.text);
    expect(warn.some((t) => /через зону подавления ГНСС: 2,5 км .*ГНСС будет подавлен/.test(t))).toBe(true);
    expect(warn.some((t) => /через зону подмены ГНСС/.test(t))).toBe(true);
    expect(warn.some((t) => /через зону подавления связи/.test(t))).toBe(true);
    expect(warn).toContain('НСУ в зоне подавления связи — связи с бортом не будет');
  });
});

/* --------------------------------- Оценка и запись --------------------------------- */

function recording(extra: RecordingEvent[] = [], landEast = 0): Recording {
  const samples: Sample[] = [];
  for (let t = 0; t <= 760; t += 1) {
    const mode =
      t < 10 ? 'ground' : t < 20 ? 'spool' : t < 40 ? 'climb' : t < 50 ? 'transition' : t < 620 ? 'auto' : t < 640 ? 'backtransition' : t < 680 ? 'descent' : t < 700 ? 'final' : 'landed';
    const k = Math.min(1, t / 700);
    const up = mode === 'ground' || mode === 'landed' ? 0 : 100;
    samples.push({
      t,
      east: landEast * k + 3000 * Math.sin(Math.PI * k),
      north: 0,
      up,
      headingDeg: 90,
      pitchDeg: 0,
      bankDeg: 0,
      iasMs: mode === 'auto' ? 21 : 0,
      gsMs: mode === 'auto' ? 22 : 0,
      vzMs: 0,
      aglM: up,
      powerW: 800,
      energyWh: 500 * k,
      soc: 1 - 0.5 * k,
      mode,
      lift: mode === 'landed' ? (t < 705 ? 0.08 : 0) : 0.5,
      pusher: 0.5,
    });
  }
  const events: RecordingEvent[] = [{ t: 5, text: 'АРМ: моторы на холостых', kind: 'info' }, { t: 705, text: 'ДИЗАРМ', kind: 'info' }, ...extra];
  events.sort((a, b) => a.t - b.t);
  return { version: 1, meta: { title: 'т', startedAt: '2026-01-01T00:00:00Z', profileTitle: 'т', source: 'sim' }, samples, events };
}

const input = (rec: Recording, over: Partial<AssessInput> = {}): AssessInput => ({
  rec,
  scenarioKind: 'route',
  landing: { east: 0, north: 0 },
  landingZoneRadiusM: 20,
  usableWh: 900,
  capacityWh: 1000,
  plannedWh: 480,
  plannedS: 650,
  prepRequired: false,
  prepDone: false,
  failures: [],
  ...over,
});

const ev = (t: number, text: string): RecordingEvent => ({ t, text, kind: eventKindOf(text) });

describe('оценка и запись по зонам', () => {
  it('вход в запретную зону — штраф и итог не выше «удовлетворительно»', () => {
    const clean = assessFlight(input(recording()));
    expect(clean.total).toBeGreaterThanOrEqual(85);
    const a = assessFlight(input(recording([ev(200, 'ЗАПРЕТНАЯ ЗОНА: вход в «Полигон»'), ev(260, 'ЗАПРЕТНАЯ ЗОНА: выход из «Полигон»')])));
    const item = a.items.find((i) => i.title === 'Запретные зоны')!;
    expect(item.points).toBe(-18);
    expect(item.note).toBe('вход в запретную зону — 1 раз, впервые на T+3:20; в зоне 1:00');
    expect(a.total).toBeLessThanOrEqual(69);
    expect(a.items.find((i) => i.title === 'Итог ограничен')!.note).toBe('заход в запретную зону');
    // Событие среды не считается ещё и нарушением ограничений.
    expect(a.items.find((i) => i.title === 'Ограничения')!.points).toBe(clean.items.find((i) => i.title === 'Ограничения')!.points);
  });

  it('зоны были, нарушений нет — пункт без штрафа; сумма максимумов по-прежнему 100', () => {
    const a = assessFlight(input(recording(), { zones: [circle('nf', 'nofly', 6000, 0, 800)] }));
    expect(a.items.find((i) => i.title === 'Запретные зоны')).toMatchObject({ points: 0, max: 0, note: 'запретные зоны не нарушены' });
    expect(a.items.reduce((s, i) => s + i.max, 0)).toBe(100);
    expect(a.total).toBe(assessFlight(input(recording())).total);
  });

  it('зоны РЭБ — в разборе; помехи оправдывают вынужденную посадку не в районе', () => {
    const jam = [
      ev(150, 'РЭБ: вход в зону подавления ГНСС «Поле»'),
      ev(152, 'ГНСС: нет решения — сильные помехи, место по счислению'),
      ev(280, 'РЭБ: выход из зоны подавления ГНСС «Поле»'),
      ev(297, 'ГНСС: повторный захват — место снова по ГНСС (перерыв 145 с)'),
    ];
    const a = assessFlight(input(recording(jam)));
    expect(a.items.find((i) => i.title === 'Зоны РЭБ')!.note).toBe('зона подавления ГНСС «Поле» на T+2:30; без ГНСС 2:25');
    expect(a.items.find((i) => i.title === 'Ограничения')!.points).toBe(15);
    const off = assessFlight(input(recording([], 300)));
    const offJam = assessFlight(input(recording(jam, 300)));
    expect(offJam.total).toBeGreaterThan(off.total);
  });

  it('вид события по тексту и зоны в файле записи', () => {
    expect(eventKindOf('ЗАПРЕТНАЯ ЗОНА: вход в «А»')).toBe('bad');
    expect(eventKindOf('ЗАПРЕТНАЯ ЗОНА: выход из «А»')).toBe('warn');
    expect(eventKindOf('РЭБ: вход в зону подмены ГНСС')).toBe('warn');
    expect(eventKindOf('Нет связи 30 с — ВОЗВРАТ')).toBe('info');
    expect(eventKindOf('ОТКАЗ: Отказ ПВД')).toBe('bad');
    const rec = recording();
    rec.meta.zones = [circle('a', 'nofly', 0, 0, 100), { id: 'bad', kind: 'nofly' } as Zone];
    expect(parseRecording(serialize(rec)).meta.zones).toEqual([rec.meta.zones[0]]);
  });
});
