import { describe, expect, it } from 'vitest';
import { FIRE_DIFFICULTY, FireWorld, firePoint, headRateMs, plumeAxis, plumeHeight, plumeRise, type FireSetup } from '../src/game/fire';
import type { Recording } from '../src/game/recorder';
import { buildMission, buildScenarios, forecastWeather, type FireScenario } from '../src/game/scenarios';
import { THERMAL_CAMERA } from '../src/game/search';
import { assessFlight, type AssessInput, type DifficultyId, type FireOutcome } from '../src/game/scoring';
import { fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import type { LocationSpec } from '../src/sim/profile';
import { flatTerrain } from '../src/sim/terrain';
import type { GeoPoint } from '../src/sim/types';

/*
 * Лесопожарный патруль (src/game/fire.ts) на условной зоне: квадрат 8 × 8 км вокруг площадки,
 * ветер западный — огонь и дым идут на восток.
 */

const ORIGIN: GeoPoint = { lat: 55, lon: 60 };
const RECT = [
  { east: -4000, north: -4000 },
  { east: 4000, north: -4000 },
  { east: 4000, north: 4000 },
  { east: -4000, north: 4000 },
];
const AREA = RECT.map((p) => fromLocal(ORIGIN, p.east, p.north));
const WIND = { speedMs: 4, fromDeg: 270 };
const DIFFS: DifficultyId[] = ['train', 'normal', 'hard', 'exam'];

const world = (difficulty: DifficultyId, seed: number, extra: Partial<FireSetup> = {}) =>
  new FireWorld({ origin: ORIGIN, area: AREA, difficulty, seed, wind: WIND, ...extra });

describe('расстановка пожаров', () => {
  it.each(DIFFS)('%s: столько пожаров, огневых точек и ложных целей, сколько положено', (d) => {
    const spec = FIRE_DIFFICULTY[d];
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = world(d, seed);
      expect(w.fires.length).toBeGreaterThanOrEqual(spec.fires[0]);
      expect(w.fires.length).toBeLessThanOrEqual(spec.fires[1]);
      const findable = w.spots.filter((s) => s.kind !== 'edge');
      expect(findable.length).toBeGreaterThanOrEqual(spec.smolders[0] + w.fires.length * spec.embers[0]);
      expect(w.decoys.length).toBeGreaterThanOrEqual(spec.decoys[0]);
      expect(w.decoys.length).toBeLessThanOrEqual(spec.decoys[1]);
      // Пожары — в зоне и не у самой площадки: лететь до них надо.
      for (const f of w.fires) {
        expect(Math.abs(f.east)).toBeLessThanOrEqual(4000);
        expect(Math.abs(f.north)).toBeLessThanOrEqual(4000);
        expect(Math.hypot(f.east, f.north)).toBeGreaterThanOrEqual(1500);
      }
    }
  });

  it('чем сложнее, тем больше огневых точек', () => {
    const count = (d: DifficultyId) => world(d, 7).spots.filter((s) => s.kind !== 'edge').length;
    expect(count('exam')).toBeGreaterThan(count('train'));
  });

  it('один seed — те же пожары; другой — другие', () => {
    const a = world('hard', 21);
    const b = world('hard', 21);
    const c = world('hard', 22);
    expect(b.fires.map((f) => [f.east, f.north])).toEqual(a.fires.map((f) => [f.east, f.north]));
    expect(c.fires.map((f) => [f.east, f.north])).not.toEqual(a.fires.map((f) => [f.east, f.north]));
  });

  it('огонь идёт по ветру: голова дальше тыла и растёт быстрее', () => {
    const w = world('normal', 5);
    const f = w.fires[0]!;
    expect(f.headingDeg).toBeGreaterThan(70);
    expect(f.headingDeg).toBeLessThan(110);
    expect(f.head).toBeGreaterThan(f.back);
    expect(f.headMs).toBeCloseTo(headRateMs(WIND.speedMs), 6);
    const head0 = f.head;
    const back0 = f.back;
    w.step(3600);
    expect(f.head - head0).toBeCloseTo(f.headMs * 3600, 3);
    expect(f.head - head0).toBeGreaterThan(f.back - back0);
  });

  it('кромка держится за гарь: точки кромки расходятся вместе с пожаром', () => {
    const w = world('normal', 9);
    const f = w.fires[0]!;
    const edge = w.spots.find((s) => s.kind === 'edge' && Math.cos(s.phi) > 0.9)!;
    const before = Math.hypot(edge.east - f.east, edge.north - f.north);
    w.step(1800);
    expect(Math.hypot(edge.east - f.east, edge.north - f.north)).toBeGreaterThan(before + 10);
  });
});

describe('дым', () => {
  it('чем сильнее очаг, тем выше и быстрее столб', () => {
    const weak = plumeRise(0.1);
    const strong = plumeRise(2);
    expect(strong.w0).toBeGreaterThan(weak.w0);
    expect(plumeHeight(strong, 300)).toBeGreaterThan(plumeHeight(weak, 300) * 3);
    // Подъём замедляется: за вторые пять минут прибавка меньше, чем за первые.
    expect(plumeHeight(strong, 600) - plumeHeight(strong, 300)).toBeLessThan(plumeHeight(strong, 300));
  });

  it('столб сносит по ветру, а дымки есть и над перебросами, и над тлеющими деревьями', () => {
    const w = world('exam', 3);
    const plumes = w.plumes();
    expect(plumes.filter((p) => p.fireId !== null).length).toBeGreaterThanOrEqual(w.fires.length);
    const axis = plumeAxis(plumes[0]!, (h) => ({ east: h > 10 ? 5 : 4, north: 0 }));
    expect(axis[axis.length - 1]!.up).toBeGreaterThan(200);
    expect(axis[axis.length - 1]!.east - axis[0]!.east).toBeGreaterThan(500);
    expect(w.plumes().some((p) => p.key.startsWith('smolder'))).toBe(true);
  });
});

describe('отметки тепловизором', () => {
  it('огневая точка — находка, повтор — повтор, гарь — подтверждённый очаг, курумник — ложная', () => {
    const w = world('hard', 4);
    const smolder = w.spots.find((s) => s.kind === 'smolder')!;
    const found = w.mark({ east: smolder.east + 5, north: smolder.north }, 100);
    expect(found.result).toBe('found');
    expect(found.text).toContain('Огневая точка найдена');
    expect(w.mark({ east: smolder.east, north: smolder.north }, 110).result).toBe('repeat');

    // Внутри гари, но не по углям: они тлеют в тыловой половине.
    const f = w.fires[0]!;
    const burn = firePoint(f, -Math.PI / 4, 0.5);
    const located = w.mark(burn, 120);
    expect(located.result).toBe('located');
    expect(located.fireId).toBe(f.id);
    expect(f.located).toBe(true);
    expect(w.mark(burn, 130).result).toBe('repeat');

    const d = w.decoys[0]!;
    const wrong = w.mark({ east: d.east, north: d.north + 3 }, 140);
    expect(wrong.result).toBe('false');
    expect(wrong.text).toContain('Ложная отметка');

    expect(w.mark({ east: 3999, north: -3999 }, 150).result).toBe('empty');
  });

  it('уголь в гари — и огневая точка найдена, и очаг подтверждён', () => {
    const w = world('hard', 6);
    const ember = w.spots.find((s) => s.kind === 'ember')!;
    const m = w.mark({ east: ember.east, north: ember.north }, 60);
    expect(m.result).toBe('found');
    expect(w.fires.find((f) => f.id === ember.fireId)!.located).toBe(true);
  });
});

describe('донесение о дыме', () => {
  /** Луч из точки в 3 км к западу от очага на столб, снесённый по ветру. */
  const aim = (w: FireWorld) => {
    const plume = w.plumes().find((p) => p.fireId !== null)!;
    const o = { east: plume.east - 3000, north: plume.north, up: 400 };
    const target = plumeAxis(plume, (h) => ({ east: h > 10 ? 5.2 : 4, north: 0 }))[3]!;
    return { o, dir: { east: target.east - o.east, north: target.north - o.north, up: target.up - o.up }, plume };
  };

  it('щелчок по столбу — пожар доложен; второй раз — повтор', () => {
    const w = world('normal', 8);
    const { o, dir, plume } = aim(w);
    const r = w.reportSmoke(o, dir, { east: plume.east, north: plume.north }, 200);
    expect(r.result).toBe('reported');
    expect(r.fireId).toBe(plume.fireId);
    expect(r.text).toContain('Дым доложен');
    expect(w.fires.find((f) => f.id === plume.fireId)!.reported).toBe(true);
    expect(w.reportSmoke(o, dir, null, 220).result).toBe('repeat');
  });

  it('мимо дыма — донесение не подтвердилось', () => {
    const w = world('normal', 8);
    const { o } = aim(w);
    expect(w.reportSmoke(o, { east: 0, north: -1, up: -0.2 }, null, 200).result).toBe('false');
  });

  it('итог: доложенные дымы, подтверждённые очаги, найденные точки и время первого донесения', () => {
    const w = world('train', 12);
    const { o, dir } = aim(w);
    w.reportSmoke(o, dir, null, 300);
    const smolder = w.spots.find((s) => s.kind === 'smolder')!;
    w.mark({ east: smolder.east, north: smolder.north }, 500);
    w.mark({ east: 3999, north: 3999 }, 600);
    const r = w.result(60);
    expect(r.fires).toBe(1);
    expect(r.reported).toBe(1);
    expect(r.spotsFound).toBe(1);
    expect(r.falseMarks).toBe(1);
    expect(r.firstReportS).toBe(240);
  });
});

/* -------------------------------- Оценка -------------------------------- */

function recording(): Recording {
  const samples = [];
  const TD = 700;
  for (let t = 0; t <= 760; t += 0.5) {
    const mode = t < 10 ? 'ground' : t < 50 ? 'climb' : t < 620 ? 'auto' : t < TD ? 'descent' : 'landed';
    const k = Math.min(1, t / TD);
    const air = mode !== 'ground' && mode !== 'landed';
    samples.push({
      t,
      east: 0,
      north: 0,
      up: air ? 250 : 0,
      headingDeg: 90,
      pitchDeg: 0,
      bankDeg: 0,
      iasMs: mode === 'auto' ? 21 : 0,
      gsMs: mode === 'auto' ? 22 : 0,
      vzMs: 0,
      aglM: air ? 250 : 0,
      powerW: 800,
      energyWh: 500 * k,
      soc: 1 - (500 * k) / 1000,
      mode,
      lift: mode === 'landed' ? (t < TD + 5 ? 0.08 : 0) : 0.5,
      pusher: 0.5,
    });
  }
  return {
    version: 1,
    meta: { title: 'т', startedAt: '2026-01-01T00:00:00Z', profileTitle: 'т', source: 'sim' },
    samples,
    events: [
      { t: 5, text: 'АРМ: моторы на холостых', kind: 'info' },
      { t: TD + 5, text: 'ДИЗАРМ', kind: 'info' },
    ],
  };
}

const REC = recording();
const assess = (over: Partial<AssessInput>) =>
  assessFlight({
    rec: REC,
    scenarioKind: 'fire',
    landing: { east: 0, north: 0 },
    landingZoneRadiusM: 20,
    usableWh: 900,
    capacityWh: 1000,
    plannedWh: 480,
    plannedS: 650,
    prepRequired: true,
    prepDone: true,
    failures: [],
    ...over,
  });
const item = (a: ReturnType<typeof assessFlight>, title: string) => a.items.find((i) => i.title === title)!;
const ALL: FireOutcome = { fires: 2, reported: 2, located: 2, spots: 4, spotsFound: 4, falseMarks: 0, firstReportS: 100 };

describe('оценка патруля', () => {
  it('всё найдено и доложено вовремя — отлично; сотня делится 60 + 40', () => {
    const a = assess({ fire: ALL });
    expect(a.items.reduce((s, i) => s + i.max, 0)).toBeCloseTo(100, 9);
    for (const t of ['Дымы доложены', 'Очаги подтверждены', 'Огневые точки', 'Время до первого донесения', 'Ложные отметки']) {
      expect(item(a, t).points).toBe(item(a, t).max);
    }
    expect(a.total).toBeGreaterThanOrEqual(95);
    expect(a.grade).toBe('отлично');
  });

  it('недостача, опоздание и ложные отметки снижают свои пункты', () => {
    expect(item(assess({ fire: { ...ALL, reported: 1 } }), 'Дымы доложены').points).toBe(5);
    expect(item(assess({ fire: { ...ALL, located: 0 } }), 'Очаги подтверждены').points).toBe(0);
    expect(item(assess({ fire: { ...ALL, spotsFound: 1 } }), 'Огневые точки').points).toBeCloseTo(2.5, 1);
    expect(item(assess({ fire: { ...ALL, firstReportS: null } }), 'Время до первого донесения').points).toBe(0);
    const late = item(assess({ fire: { ...ALL, firstReportS: 400 } }), 'Время до первого донесения').points;
    expect(late).toBeGreaterThan(1);
    expect(late).toBeLessThan(5);
    expect(item(assess({ fire: { ...ALL, falseMarks: 2 } }), 'Ложные отметки').points).toBe(1);
    expect(assess({}).total).toBeLessThan(75);
  });

  it('у других заданий оценка прежняя', () => {
    const a = assess({ scenarioKind: 'route' });
    expect(a.items.find((i) => i.title === 'Дымы доложены')).toBeUndefined();
    expect(a.items.reduce((s, i) => s + i.max, 0)).toBe(100);
  });
});

/* ------------------------------ Задание патруля ------------------------------ */

const pt = (e: number, n: number) => fromLocal(ORIGIN, e, n);
const LOCATION: LocationSpec = {
  site: ORIGIN,
  siteName: 'площадка',
  region: { south: 54.9, west: 59.8, north: 55.1, east: 60.2 },
  date: '2026-08-01',
  utcOffsetH: 5,
  windSpeedMs: 3,
  windFromDeg: 270,
  temperatureC: 12,
  survey: { title: 'Съёмка', briefing: 'Съёмка участка.', area: AREA },
  delivery: { title: 'Доставка', briefing: 'Доставка груза.', destination: pt(3000, 0), destinationName: 'пункт', route: [] },
  route: { briefing: 'Облёт.', route: [{ ...pt(1000, 0), heightAglM: 150 }] },
  transfer: { title: 'Перелёт', briefing: 'Перелёт.', destination: pt(0, 3000), destinationName: 'Б', route: [] },
  fire: {
    title: 'Лесопожарный патруль',
    briefing: 'Найти дымы и очаги.',
    area: AREA,
    route: [
      { ...pt(-2000, 2000), heightAglM: 250 },
      { ...pt(2000, 2000), heightAglM: 250 },
      { ...pt(2000, -2000), heightAglM: 250 },
      { ...pt(-2000, -2000), heightAglM: 250 },
    ],
  },
};

describe('задание патруля', () => {
  it('есть в районе с fire — последним, с зоной и маршрутом облёта', () => {
    const list = buildScenarios(LOCATION);
    expect(list.map((s) => s.kind)).toEqual(['transfer', 'route', 'survey', 'delivery', 'fire']);
    const sc = list[4] as FireScenario;
    expect(sc.area).toBe(AREA);
    expect(sc.route).toHaveLength(4);
    expect(sc.camera).toBe(THERMAL_CAMERA);
    expect(sc.heightAglM).toBe(250);
    const { fire: _, ...noFire } = LOCATION;
    expect(buildScenarios(noFire).some((s) => s.kind === 'fire')).toBe(false);
  });

  it('летится как облёт: один полёт с площадки на площадку, нагрузка — тепловизор, энергии хватает', () => {
    const sc = buildScenarios(LOCATION)[4] as FireScenario;
    const terrain = flatTerrain(300);
    const weather = forecastWeather(sc, sc.defaults);
    const m = buildMission(sc, sc.defaults, terrain, weather);
    expect(m.kind).toBe('fire');
    expect(m.stages).toHaveLength(1);
    const st = m.stages[0]!;
    expect(st.payload).toEqual({ massKg: THERMAL_CAMERA.massKg, powerW: THERMAL_CAMERA.powerW });
    expect(Math.hypot(toLocal(ORIGIN, st.landing).east, toLocal(ORIGIN, st.landing).north)).toBeLessThan(1);
    expect(simulateMission(st, weather).issues).toEqual([]);
    // Пожары этого задания — внутри зоны патрулирования.
    const w = new FireWorld({ origin: sc.site, area: sc.area, difficulty: 'normal', seed: 3, wind: { speedMs: 3, fromDeg: 270 } });
    expect(w.fires.length).toBeGreaterThan(0);
  });
});
