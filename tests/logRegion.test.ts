import { describe, expect, it } from 'vitest';
import { inBounds, placeRecording, regionFromRecording } from '../src/game/logRegion';
import type { Recording, Sample } from '../src/game/recorder';
import { LOG_REGION_ID } from '../src/game/regions';
import { buildScenarios } from '../src/game/scenarios';
import { distanceM, fromLocal } from '../src/sim/mission';
import type { GeoPoint } from '../src/sim/types';

/* Место полёта из журнала → район заданий: площадка, область, время, маршрут повтора полёта. */

const ORIGIN = { lat: 55.1, lon: 38.2 };

function sample(t: number, east: number, north: number, up: number, mode: string): Sample {
  return { t, east, north, up, headingDeg: 0, pitchDeg: 0, bankDeg: 0, iasMs: mode === 'auto' ? 21 : 0, gsMs: 0, vzMs: 0, aglM: up, powerW: 800, energyWh: 0, soc: 1, mode, lift: 0, pusher: 0 };
}

/** Взлёт, квадрат 4 × 4 км на 150 м самолётом и посадка — дома или в точке (landE, landN). */
function flight(landE = 0, landN = 0): Recording {
  const s: Sample[] = [sample(0, 0, 0, 0, 'ground'), sample(10, 0, 0, 20, 'climb'), sample(30, 0, 0, 50, 'transition')];
  let t = 30;
  let e = 0;
  let n = 0;
  for (const [ce, cn] of [[0, 4000], [4000, 4000], [4000, 0], [landE, landN]] as const) {
    for (let k = 1; k <= 20; k++) s.push(sample((t += 10), e + ((ce - e) * k) / 20, n + ((cn - n) * k) / 20, 150, 'auto'));
    e = ce;
    n = cn;
  }
  s.push(sample(t + 30, landE, landN, 5, 'final'), sample(t + 40, landE, landN, 0, 'landed'));
  return {
    version: 1,
    meta: { title: 'журнал', startedAt: '2026-06-20T08:00:00.000Z', profileTitle: 'тест', source: 'log', origin: ORIGIN, wind: { speedMs: 4.2, fromDeg: 250 } },
    samples: s,
    events: [],
  };
}

const near = (a: GeoPoint, b: GeoPoint, m: number) => distanceM(a, b) < m;

describe('место полёта из бортового журнала', () => {
  it('площадка — точка взлёта, область вмещает траекторию, дата, час и ветер — по журналу', () => {
    const rec = flight();
    const r = regionFromRecording(rec);
    const L = r.location;
    expect(r.id).toBe(LOG_REGION_ID);
    expect(near(L.site, ORIGIN, 1)).toBe(true);
    for (const x of rec.samples) expect(inBounds(L.region, fromLocal(ORIGIN, x.east, x.north))).toBe(true);
    // Долгота 38° — UTC+3: взлёт в 08:00 UTC — 11:00 местного.
    expect(L.utcOffsetH).toBe(3);
    expect(L.date).toBe('2026-06-20');
    expect(L.localHour).toBe(11);
    expect(L.windSpeedMs).toBe(4);
    expect(L.windFromDeg).toBe(250);
  });

  it('маршрут — углы траектории, без точек у площадки; высоты над рельефом по журналу', () => {
    // Рельеф поднимается к северу на 1 %: на 4 км севернее — на 40 м выше площадки.
    const terrain = { elevationM: (p: GeoPoint) => 100 + (p.lat - ORIGIN.lat) * 111_320 * 0.01 };
    const route = regionFromRecording(flight(), terrain).location.route.route;
    expect(route.length).toBeGreaterThanOrEqual(3);
    expect(route.length).toBeLessThanOrEqual(24);
    for (const p of route) {
      expect(distanceM(p, ORIGIN)).toBeGreaterThan(250);
      expect(p.heightAglM).toBeGreaterThanOrEqual(60);
    }
    const ne = route.find((p) => near(p, fromLocal(ORIGIN, 4000, 4000), 150));
    const se = route.find((p) => near(p, fromLocal(ORIGIN, 4000, 0), 150));
    expect(ne?.heightAglM).toBe(110);
    expect(se?.heightAglM).toBe(150);
  });

  it('сел в стороне — перелёт в точку посадки; сел дома — в дальнюю точку полёта', () => {
    const away = regionFromRecording(flight(2000, -1500)).location.transfer;
    expect(near(away.destination, fromLocal(ORIGIN, 2000, -1500), 5)).toBe(true);
    const home = regionFromRecording(flight()).location.transfer;
    expect(near(home.destination, fromLocal(ORIGIN, 4000, 4000), 5)).toBe(true);
  });

  it('из района собираются все задания', () => {
    const L = regionFromRecording(flight()).location;
    const sc = buildScenarios(L);
    expect(sc.map((s) => s.id)).toEqual(expect.arrayContaining(['route', 'transfer', 'survey', 'delivery']));
    expect(sc.find((s) => s.id === 'route')!.defaults.localHour).toBe(11);
  });

  it('запись переносится к другой площадке со сдвигом по высоте', () => {
    const rec = flight();
    const site = fromLocal(ORIGIN, -1000, -2000);
    const moved = placeRecording(rec, site, 12);
    expect(moved.samples[5]!.east).toBeCloseTo(rec.samples[5]!.east + 1000, 0);
    expect(moved.samples[5]!.north).toBeCloseTo(rec.samples[5]!.north + 2000, 0);
    expect(moved.samples[5]!.up).toBeCloseTo(rec.samples[5]!.up + 12, 6);
    expect(near(moved.meta.origin!, site, 0.01)).toBe(true);
  });

  it('без места полёта — понятная ошибка', () => {
    const rec = flight();
    delete rec.meta.origin;
    expect(() => regionFromRecording(rec)).toThrow(/места полёта/);
  });

  it('полёт кончился аварией — пункт Б не место падения', () => {
    const rec = flight(2000, -1500);
    rec.samples[rec.samples.length - 1]!.mode = 'crashed';
    const t = regionFromRecording(rec).location.transfer;
    expect(near(t.destination, fromLocal(ORIGIN, 4000, 4000), 5)).toBe(true);
  });
});
