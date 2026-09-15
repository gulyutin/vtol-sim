import { describe, expect, it } from 'vitest';
import type { Recording, RecordingEvent, Sample } from '../src/game/recorder';
import { buildMission, buildScenarios, forecastWeather, type SearchScenario } from '../src/game/scenarios';
import { assessFlight, type AssessInput, type DifficultyId, type SearchOutcome } from '../src/game/scoring';
import {
  canopyGap,
  CoverageGrid,
  coverageOfTrack,
  detectability,
  detectionRangeM,
  distanceOutside,
  footprint,
  generateBodies,
  GROUP_SIZE,
  johnsonP,
  NADIR_TILT_DEG,
  projectToImage,
  SEARCH_DIFFICULTY,
  searchPattern,
  SearchWorld,
  swathOf,
  THERMAL_CAMERA,
  thermalContrastK,
  type AnimalWeights,
  type CameraPose,
  type LocalPoint,
  type SearchBody,
  type ThermalEnv,
} from '../src/game/search';
import { fromLocal, simulateMission, toLocal } from '../src/sim/mission';
import type { LocationSpec } from '../src/sim/profile';
import { flatTerrain } from '../src/sim/terrain';
import type { GeoPoint, Terrain } from '../src/sim/types';

/*
 * Поиск людей тепловизором (src/game/search.ts) на условном районе: прямоугольник 1200 × 900 м
 * к северо-востоку от площадки, данные — синтетические.
 */

const ORIGIN: GeoPoint = { lat: 55, lon: 60 };
const RECT: LocalPoint[] = [
  { east: 400, north: 300 },
  { east: 1600, north: 300 },
  { east: 1600, north: 1200 },
  { east: 400, north: 1200 },
];
const AREA = RECT.map((p) => fromLocal(ORIGIN, p.east, p.north));
const DIFFS: DifficultyId[] = ['train', 'normal', 'hard', 'exam'];
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

const world = (difficulty: DifficultyId, seed: number, extra: { animals?: AnimalWeights; terrain?: Terrain } = {}) =>
  new SearchWorld({ origin: ORIGIN, area: AREA, difficulty, seed, ...extra });

function groups(bodies: readonly SearchBody[]): SearchBody[][] {
  const m = new Map<number, SearchBody[]>();
  for (const b of bodies) m.set(b.group, [...(m.get(b.group) ?? []), b]);
  return [...m.values()];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('расстановка людей и зверей', () => {
  it('число людей и зверей — по сложности; волки стаей 3–6, медведь один, лоси до 3, олени до 5', () => {
    for (const d of DIFFS) {
      const spec = SEARCH_DIFFICULTY[d];
      for (const seed of SEEDS) {
        const w = world(d, seed);
        const people = w.bodies.filter((b) => b.kind === 'person');
        const animals = w.bodies.filter((b) => b.kind !== 'person');
        expect(people.length).toBeGreaterThanOrEqual(spec.people[0]);
        expect(people.length).toBeLessThanOrEqual(spec.people[1]);
        expect(animals.length).toBeGreaterThanOrEqual(spec.animals[0]);
        expect(animals.length).toBeLessThanOrEqual(spec.animals[1]);
        for (const g of groups(w.bodies)) {
          const kind = g[0]!.kind;
          expect(g.every((b) => b.kind === kind)).toBe(true);
          if (kind === 'person') expect(g).toHaveLength(1);
          else if (kind === 'wolf') expect(g.length).toBeGreaterThanOrEqual(GROUP_SIZE.wolf[0]);
          if (kind !== 'person') expect(g.length).toBeLessThanOrEqual(GROUP_SIZE[kind][1]);
        }
        // Травмированные лежат или сидят; на тренировке бредущих нет.
        for (const p of people) if (!p.mobile) expect(['lying', 'sitting']).toContain(p.pose);
        if (d === 'train') expect(people.every((p) => !p.mobile)).toBe(true);
        for (const b of w.bodies) expect(distanceOutside(b, RECT)).toBe(0);
      }
    }
  });

  it('сложнее — больше людей и зверей, гуще лес над ними, больше бредущих', () => {
    const stats = DIFFS.map((d) => {
      const ws = SEEDS.map((s) => world(d, s));
      return {
        people: mean(ws.map((w) => w.people.length)),
        animals: mean(ws.map((w) => w.bodies.length - w.people.length)),
        canopy: mean(ws.flatMap((w) => w.bodies.map((b) => b.canopy))),
        walking: mean(ws.flatMap((w) => w.people.map((p) => (p.mobile ? 1 : 0)))),
      };
    });
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i]!.people).toBeGreaterThanOrEqual(stats[i - 1]!.people);
      expect(stats[i]!.animals).toBeGreaterThan(stats[i - 1]!.animals);
      expect(stats[i]!.canopy).toBeGreaterThan(stats[i - 1]!.canopy);
      expect(stats[i]!.walking).toBeGreaterThanOrEqual(stats[i - 1]!.walking);
    }
    expect(stats[0]!.canopy).toBeLessThan(0.3);
    expect(stats[3]!.canopy).toBeGreaterThan(0.5);
  });

  it('звери района: вида нет в весах или вес 0 — такого зверя нет; число по-прежнему по сложности', () => {
    const cases: [AnimalWeights, string[]][] = [
      [{ moose: 2, deer: 3 }, ['moose', 'deer']],
      [{ deer: 1 }, ['deer']],
      [{ bear: 0, wolf: 2, moose: 1 }, ['wolf', 'moose']],
      [{ bear: 2, wolf: 2, moose: 2, deer: 2 }, ['bear', 'wolf', 'moose', 'deer']],
    ];
    for (const [animals, allowed] of cases)
      for (const d of DIFFS)
        for (const seed of SEEDS) {
          const w = world(d, seed, { animals });
          const beasts = w.bodies.filter((b) => b.kind !== 'person');
          for (const b of beasts) expect(allowed).toContain(b.kind);
          expect(beasts.length).toBeGreaterThanOrEqual(SEARCH_DIFFICULTY[d].animals[0]);
          expect(beasts.length).toBeLessThanOrEqual(SEARCH_DIFFICULTY[d].animals[1]);
          for (const g of groups(beasts)) if (g[0]!.kind === 'wolf') expect(g.length).toBeGreaterThanOrEqual(3);
        }
    // Все веса нулевые — зверей нет вовсе.
    expect(world('exam', 1, { animals: { bear: 0 } }).bodies.every((b) => b.kind === 'person')).toBe(true);
    // Без весов — обычная тайга: за 30 зачётных районов встречаются все четыре вида.
    const kinds = new Set(SEEDS.flatMap((s) => world('exam', s).bodies.map((b) => b.kind)));
    expect([...kinds].sort()).toEqual(['bear', 'deer', 'moose', 'person', 'wolf']);
  });

  it('полог по месту (canopyAt) заменяет случайный', () => {
    const bodies = generateBodies(RECT, { difficulty: 'hard', seed: 3, canopyAt: () => 0.85 });
    expect(bodies.every((b) => b.canopy === 0.85 && b.canopyClass === 'dense')).toBe(true);
  });
});

describe('детерминизм', () => {
  it('один seed и те же шаги — те же тела; другой seed — другие', () => {
    const a = world('exam', 42);
    const b = world('exam', 42);
    const c = world('exam', 43);
    expect(a.heatBodies()).toEqual(b.heatBodies());
    expect(a.heatBodies()).not.toEqual(c.heatBodies());
    for (let k = 0; k < 1200; k++) {
      a.step(k % 3 === 0 ? 0.1 : 0.5);
      b.step(k % 3 === 0 ? 0.1 : 0.5);
    }
    expect(a.heatBodies()).toEqual(b.heatBodies());
    expect(generateBodies(RECT, { difficulty: 'normal', seed: 5 })).toEqual(generateBodies(RECT, { difficulty: 'normal', seed: 5 }));
  });

  it('тела — в форме HeatBody: id, вид, место, курс, поза, фаза 0…1', () => {
    const w = world('hard', 9);
    w.step(30);
    for (const h of w.heatBodies()) {
      expect(Object.keys(h).sort()).toEqual(['east', 'headingDeg', 'id', 'kind', 'north', 'phase', 'pose']);
      expect(h.phase).toBeGreaterThanOrEqual(0);
      expect(h.phase).toBeLessThan(1);
      expect(h.headingDeg).toBeGreaterThanOrEqual(0);
      expect(h.headingDeg).toBeLessThan(360);
    }
    expect(new Set(w.heatBodies().map((h) => h.id)).size).toBe(w.bodies.length);
  });
});

describe('движение', () => {
  it('за два часа звери и бредущие не уходят из района дальше 150 м, травмированные на месте, волки срываются на рысь', () => {
    for (const seed of [1, 2, 3]) {
      const w = world('exam', seed);
      const start = new Map(w.bodies.map((b) => [b.id, { east: b.east, north: b.north }]));
      const path = new Map(w.bodies.map((b) => [b.id, 0]));
      let worst = 0;
      const maxSpeed = new Map<string, number>();
      for (let k = 0; k < 7200; k++) {
        const before = w.bodies.map((b) => ({ east: b.east, north: b.north }));
        w.step(1);
        w.bodies.forEach((b, i) => {
          const d = Math.hypot(b.east - before[i]!.east, b.north - before[i]!.north);
          path.set(b.id, path.get(b.id)! + d);
          maxSpeed.set(b.kind, Math.max(maxSpeed.get(b.kind) ?? 0, d));
          worst = Math.max(worst, distanceOutside(b, RECT));
        });
      }
      expect(worst).toBeLessThan(150);
      for (const b of w.bodies) {
        if (b.kind === 'person' && !b.mobile) {
          expect(b.east).toBe(start.get(b.id)!.east);
          expect(b.north).toBe(start.get(b.id)!.north);
        } else expect(path.get(b.id)!).toBeGreaterThan(100);
      }
      if (w.bodies.some((b) => b.kind === 'wolf')) expect(maxSpeed.get('wolf')!).toBeGreaterThan(2.5);
      for (const k of ['person', 'bear'] as const) if (maxSpeed.has(k)) expect(maxSpeed.get(k)!).toBeLessThan(2);
    }
  });

  it('бредущий человек спускается под уклон', () => {
    // Склон к северу: 10 м на 100 м.
    const slope: Terrain = { elevationM: (p) => 500 - 0.1 * toLocal(ORIGIN, p).north };
    const shifts = { slope: [] as number[], flat: [] as number[] };
    for (const seed of SEEDS) {
      for (const [key, terrain] of [
        ['slope', slope],
        ['flat', flatTerrain(500)],
      ] as const) {
        const w = world('exam', seed, { terrain });
        const walkers = w.people.filter((p) => p.mobile);
        const n0 = walkers.map((p) => p.north);
        w.step(1800);
        walkers.forEach((p, i) => shifts[key].push(p.north - n0[i]!));
      }
    }
    expect(shifts.slope.length).toBeGreaterThan(5);
    expect(mean(shifts.slope)).toBeGreaterThan(100);
    expect(mean(shifts.slope)).toBeGreaterThan(mean(shifts.flat) + 100);
  });
});

describe('обнаружимость', () => {
  const night: ThermalEnv = { airTemperatureC: 10, sunElevationDeg: -20, cloudCover: 0 };
  const hotNoon: ThermalEnv = { airTemperatureC: 25, sunElevationDeg: 50, cloudCover: 0 };
  /** Цель под углом 45° от вертикали на наклонной дальности h·√2. */
  const at45 = (h: number, canopy = 0, env = night) =>
    detectability({ kind: 'person', east: 0, north: h, canopy, pose: 'lying' }, { east: 0, north: 0, aglM: h, headingDeg: 0, tiltDeg: 45 }, THERMAL_CAMERA, env);

  it('критерии Джонсона: ровно N50 циклов — 50 %, больше — выше', () => {
    expect(johnsonP(4, 4)).toBeCloseTo(0.5, 9);
    expect(johnsonP(8, 4)).toBeCloseTo(0.945, 2);
    expect(johnsonP(2, 4)).toBeCloseTo(0.108, 2);
    expect(johnsonP(0, 1)).toBe(0);
    // Человек 0,8 м штатной камерой (0,92 мрад): обнаружить — ~430 м, распознать — ~110 м.
    expect(detectionRangeM(THERMAL_CAMERA)).toBeCloseTo(433, -1);
    expect(detectionRangeM(THERMAL_CAMERA, 0.8, 'recognise')).toBeCloseTo(108, -1);
  });

  it('дальше — хуже; опознать труднее, чем распознать, распознать — труднее, чем обнаружить', () => {
    const ds = [30, 60, 120, 240, 480].map((h) => at45(h));
    for (const d of ds) {
      expect(d.inView).toBe(true);
      expect(d.pIdentify).toBeLessThanOrEqual(d.pRecognise);
      expect(d.pRecognise).toBeLessThanOrEqual(d.pDetect);
    }
    for (let i = 1; i < ds.length; i++) {
      expect(ds[i]!.pixels).toBeLessThan(ds[i - 1]!.pixels);
      expect(ds[i]!.pDetect).toBeLessThanOrEqual(ds[i - 1]!.pDetect);
      expect(ds[i]!.pRecognise).toBeLessThan(ds[i - 1]!.pRecognise + 1e-12);
    }
    expect(ds[0]!.level).toBe('identify');
    expect(ds[ds.length - 1]!.pRecognise).toBeLessThan(0.05);
  });

  it('гуще полог — хуже; в густом лесу взгляд отвесно вниз лучше наклона', () => {
    const ps = [0, 0.3, 0.6, 0.9].map((c) => at45(100, c).pDetect);
    for (let i = 1; i < ps.length; i++) expect(ps[i]!).toBeLessThan(ps[i - 1]!);
    expect(canopyGap(0.8, 0)).toBeCloseTo(0.2, 9);
    expect(canopyGap(0.8, 45)).toBeLessThan(0.11);
    const nadir = detectability({ kind: 'person', east: 0, north: 0, canopy: 0.8, pose: 'lying' }, { east: 0, north: 0, aglM: 100, headingDeg: 0, tiltDeg: NADIR_TILT_DEG }, THERMAL_CAMERA, night);
    expect(nadir.pDetect).toBeGreaterThan(at45(100 / Math.SQRT2, 0.8).pDetect);
  });

  it('контраст: в жаркий солнечный день слабый, ночью и в холод сильный', () => {
    expect(Math.abs(thermalContrastK('person', hotNoon))).toBeLessThan(2);
    expect(thermalContrastK('person', night)).toBeGreaterThan(10);
    expect(thermalContrastK('person', { airTemperatureC: -15, sunElevationDeg: 15, cloudCover: 0 })).toBeGreaterThan(10);
    // Пасмурно гасит прогрев Солнцем.
    expect(thermalContrastK('person', { ...hotNoon, cloudCover: 1 })).toBeGreaterThan(thermalContrastK('person', hotNoon) + 3);
    expect(at45(100, 0, hotNoon).pRecognise).toBeLessThan(at45(100, 0, night).pRecognise);
  });

  it('вне кадра — не видно; прямо под камерой отвесно вниз — в центре кадра', () => {
    const pose: CameraPose = { east: 0, north: 0, aglM: 100, headingDeg: 0, tiltDeg: 45 };
    expect(detectability({ kind: 'moose', east: 0, north: -200, canopy: 0 }, pose, THERMAL_CAMERA, night).pDetect).toBe(0);
    const c = projectToImage({ ...pose, tiltDeg: NADIR_TILT_DEG }, THERMAL_CAMERA, { east: 0, north: 0 });
    expect(c.inView).toBe(true);
    expect(Math.abs(c.x)).toBeLessThan(1e-9);
    expect(Math.abs(c.y)).toBeLessThan(1e-9);
    expect(c.zenithDeg).toBeCloseTo(0, 6);
  });
});

describe('отметки', () => {
  it('человек — найден один раз, зверь — ложная отметка с видом, пусто — ложная; журнал со временем', () => {
    const w = world('normal', 7);
    const [p1, p2] = w.people;
    const animal = w.bodies.find((b) => b.kind !== 'person' && w.people.every((p) => Math.hypot(p.east - b.east, p.north - b.north) > 30))!;
    expect(p1 && p2 && animal).toBeTruthy();

    const a = w.mark({ east: p1!.east + 15, north: p1!.north }, 100);
    expect(a.result).toBe('found');
    expect(a.bodyId).toBe(p1!.id);
    expect(a.text).toBe('Найден человек: 1 из 2');
    expect(w.mark({ east: p1!.east, north: p1!.north - 5 }, 120).result).toBe('repeat');
    expect(w.people.filter((p) => p.found)).toHaveLength(1);

    const f = w.mark({ east: animal.east, north: animal.north }, 200);
    expect(f.result).toBe('false');
    expect(f.kind).toBe(animal.kind);

    // Пустое место внутри района: до всех тел дальше 60 м.
    let empty: LocalPoint | null = null;
    for (let e = 420; e < 1600 && !empty; e += 20)
      for (let n = 320; n < 1200 && !empty; n += 20) if (w.bodies.every((b) => Math.hypot(b.east - e, b.north - n) > 60)) empty = { east: e, north: n };
    expect(w.mark(empty!, 300).result).toBe('empty');
    expect(w.mark({ east: p2!.east, north: p2!.north + 24 }, 400).result).toBe('found');

    expect(w.marks.map((m) => [m.t, m.result])).toEqual([
      [100, 'found'],
      [120, 'repeat'],
      [200, 'false'],
      [300, 'empty'],
      [400, 'found'],
    ]);
    const r = w.result(40);
    expect(r).toMatchObject({ found: 2, total: 2, falseMarks: 2, firstFoundS: 60 });
    expect(w.mark({ east: p2!.east + 40, north: p2!.north }, 500).result).not.toBe('found');
  });
});

/** Пролёт по точкам маршрута с шагом 5 м: положение камеры на каждом шаге. */
function flyRoute(points: GeoPoint[], aglM: number, tiltDeg: number): CameraPose[] {
  const poses: CameraPose[] = [];
  const loc = points.map((p) => toLocal(ORIGIN, p));
  for (let i = 1; i < loc.length; i++) {
    const a = loc[i - 1]!;
    const b = loc[i]!;
    const len = Math.hypot(b.east - a.east, b.north - a.north);
    const headingDeg = (Math.atan2(b.east - a.east, b.north - a.north) * 180) / Math.PI;
    for (let s = 0; s <= len; s += 5) poses.push({ east: a.east + ((b.east - a.east) * s) / len, north: a.north + ((b.north - a.north) * s) / len, aglM, headingDeg, tiltDeg });
  }
  return poses;
}

describe('галсы поиска', () => {
  it('полоса — по полю зрения и наклону, между галсами — 80 % полосы', () => {
    expect(swathOf(THERMAL_CAMERA, 100, 45).swathM).toBeCloseTo(83.6, 0);
    expect(swathOf(THERMAL_CAMERA, 100, NADIR_TILT_DEG).swathM).toBeCloseTo(59.1, 0);
    expect(swathOf(THERMAL_CAMERA, 100, 45).aheadCenterM).toBeCloseTo(100, 6);
    const p = searchPattern(AREA, ORIGIN, { heightAglM: 100 });
    expect(p.spacingM).toBeCloseTo(0.8 * p.swathM, 9);
    // Район шире, чем выше: галсы с запада на восток, их меньше.
    expect(p.directionDeg).toBe(90);
    expect(p.lineCount).toBe(Math.ceil(900 / p.spacingM));
    expect(p.route).toHaveLength(2 * p.lineCount);
    expect(p.route.every((q) => q.heightAglM === 100)).toBe(true);
  });

  it.each([
    [45, 0],
    [45, 150],
    [NADIR_TILT_DEG, 0],
    [NADIR_TILT_DEG, 150],
  ])('наклон %i°, радиус разворота %i м: галсы покрывают район', (tiltDeg, turnRadiusM) => {
    const p = searchPattern(AREA, ORIGIN, { heightAglM: 100, tiltDeg, turnRadiusM });
    expect(coverageOfTrack(RECT, flyRoute(p.route, 100, tiltDeg))).toBeGreaterThan(0.98);
    // Галсы подряд — только без ипподрома; с ипподромом соседние по порядку галсы далеко.
    const loc = p.route.map((q) => toLocal(ORIGIN, q));
    const gap = Math.hypot(loc[2]!.east - loc[1]!.east, loc[2]!.north - loc[1]!.north);
    if (turnRadiusM > 0) expect(gap).toBeGreaterThan(2 * turnRadiusM);
  });
});

describe('покрытие', () => {
  const strip = (width: number): LocalPoint[] => [
    { east: -width / 2, north: 0 },
    { east: width / 2, north: 0 },
    { east: width / 2, north: 1000 },
    { east: -width / 2, north: 1000 },
  ];
  const pass: CameraPose[] = Array.from({ length: 241 }, (_, i) => ({ east: 0, north: -100 + 5 * i, aglM: 100, headingDeg: 0, tiltDeg: NADIR_TILT_DEG }));

  it('кадр отвесно вниз со 100 м — 59 × 47 м', () => {
    const f = footprint(pass[0]!, THERMAL_CAMERA);
    expect(f).toHaveLength(8);
    const es = f.map((p) => p.east);
    const ns = f.map((p) => p.north);
    expect(Math.max(...es) - Math.min(...es)).toBeCloseTo(59.1, 0);
    expect(Math.max(...ns) - Math.min(...ns)).toBeCloseTo(47.3, 0);
  });

  it('узкая полоса — целиком, широкая — на долю полосы обзора', () => {
    expect(coverageOfTrack(strip(40), pass)).toBeGreaterThan(0.97);
    expect(coverageOfTrack(strip(240), pass)).toBeCloseTo(59.1 / 240, 1);
    expect(coverageOfTrack(strip(240), [])).toBe(0);
  });

  it('мир копит покрытие по кадрам полёта', () => {
    const w = world('train', 1);
    const g = new CoverageGrid(RECT);
    for (const q of flyRoute([fromLocal(ORIGIN, 400, 750), fromLocal(ORIGIN, 1600, 750)], 100, NADIR_TILT_DEG)) {
      w.observe(q);
      g.add(q);
    }
    expect(w.coverage.fraction).toBeCloseTo(59.1 / 900, 1);
    expect(w.coverage.fraction).toBeCloseTo(g.fraction, 2);
    expect(w.result().coverage).toBe(w.coverage.fraction);
  });
});

/* ------------------------------ Оценка поиска ------------------------------ */

/** Чистый полёт: взлёт, 10 минут по маршруту, посадка в точку, ДИЗАРМ. */
function flight(): Recording {
  const samples: Sample[] = [];
  const events: RecordingEvent[] = [];
  const TD = 700;
  const phase = (t: number) => (t < 10 ? 'ground' : t < 50 ? 'climb' : t < 620 ? 'auto' : t < TD ? 'descent' : 'landed');
  for (let t = 0; t <= 760; t += 0.5) {
    const mode = phase(t);
    const k = Math.min(1, t / TD);
    const air = mode !== 'ground' && mode !== 'landed';
    samples.push({
      t,
      east: 3000 * Math.sin(Math.PI * k),
      north: 0,
      up: air ? 100 : 0,
      headingDeg: 90,
      pitchDeg: 0,
      bankDeg: 0,
      iasMs: mode === 'auto' ? 21 : 0,
      gsMs: mode === 'auto' ? 22 : 0,
      vzMs: 0,
      aglM: air ? 100 : 0,
      powerW: 800,
      energyWh: 500 * k,
      soc: 1 - (500 * k) / 1000,
      mode,
      lift: mode === 'landed' ? (t < TD + 5 ? 0.08 : 0) : 0.5,
      pusher: 0.5,
    });
  }
  events.push({ t: 5, text: 'АРМ: моторы на холостых', kind: 'info' }, { t: TD + 5, text: 'ДИЗАРМ', kind: 'info' });
  return { version: 1, meta: { title: 'т', startedAt: '2026-01-01T00:00:00Z', profileTitle: 'т', source: 'sim' }, samples, events };
}

const REC = flight();
const assess = (over: Partial<AssessInput>) =>
  assessFlight({
    rec: REC,
    scenarioKind: 'search',
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
const ALL: SearchOutcome = { found: 3, total: 3, falseMarks: 0, firstFoundS: 120, coverage: 0.95 };

describe('оценка поиска', () => {
  it('все найдены быстро, без ложных отметок, район осмотрен — отлично; сотня делится 60 + 40', () => {
    const a = assess({ search: ALL });
    expect(a.items.reduce((s, i) => s + i.max, 0)).toBeCloseTo(100, 9);
    for (const t of ['Найдены люди', 'Время до первой находки', 'Ложные отметки', 'Покрытие района']) expect(item(a, t).points).toBe(item(a, t).max);
    expect(item(a, 'Найдены люди').max).toBe(20);
    expect(item(a, 'Задание выполнено, посадка в точке').max).toBe(15);
    expect(a.total).toBeGreaterThanOrEqual(95);
    expect(a.grade).toBe('отлично');
  });

  it('недостача, опоздание, ложные отметки и неполное покрытие снижают свои пункты', () => {
    expect(item(assess({ search: { ...ALL, found: 1 } }), 'Найдены люди').points).toBeCloseTo(6.7, 1);
    expect(item(assess({ search: { ...ALL, found: 0, firstFoundS: null } }), 'Время до первой находки').points).toBe(0);
    const late = item(assess({ search: { ...ALL, firstFoundS: 450 } }), 'Время до первой находки').points;
    expect(late).toBeGreaterThan(2);
    expect(late).toBeLessThan(6);
    expect(item(assess({ search: { ...ALL, falseMarks: 2 } }), 'Ложные отметки').points).toBe(2);
    expect(item(assess({ search: { ...ALL, falseMarks: 5 } }), 'Ложные отметки').points).toBe(0);
    expect(item(assess({ search: { ...ALL, coverage: 0.45 } }), 'Покрытие района').points).toBe(3);
    expect(assess({ search: { ...ALL, found: 1, falseMarks: 3 } }).total).toBeLessThan(assess({ search: ALL }).total - 20);
    // Без итога поиска — пункты поиска по нулям, кроме ложных отметок.
    expect(assess({}).total).toBeLessThan(75);
  });

  it('у других заданий оценка прежняя', () => {
    const a = assess({ scenarioKind: 'route' });
    expect(a.items.find((i) => i.title === 'Найдены люди')).toBeUndefined();
    expect(item(a, 'Задание выполнено, посадка в точке').max).toBe(25);
    expect(a.items.reduce((s, i) => s + i.max, 0)).toBe(100);
  });
});

/* ------------------------------ Задание поиска ------------------------------ */

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
  search: { title: 'Поиск людей', briefing: 'Найти пропавших.', area: AREA, animals: { moose: 2, deer: 3 } },
};

describe('задание поиска', () => {
  it('есть в районе с search — последним, с галсами по умолчанию и зверями района', () => {
    const list = buildScenarios(LOCATION);
    expect(list.map((s) => s.kind)).toEqual(['transfer', 'route', 'survey', 'delivery', 'search']);
    const sc = list[4] as SearchScenario;
    expect(sc.area).toBe(AREA);
    expect(sc.animals).toEqual({ moose: 2, deer: 3 });
    expect(sc.route.length).toBeGreaterThanOrEqual(4);
    expect(sc.route.every((q) => q.heightAglM === sc.heightAglM)).toBe(true);
    expect(sc.camera).toBe(THERMAL_CAMERA);
    const { search: _, ...noSearch } = LOCATION;
    expect(buildScenarios(noSearch).some((s) => s.kind === 'search')).toBe(false);
  });

  it('летится как облёт: один полёт с площадки на площадку, нагрузка — тепловизор, энергии хватает', () => {
    const sc = buildScenarios(LOCATION)[4] as SearchScenario;
    const terrain = flatTerrain(300);
    const weather = forecastWeather(sc, sc.defaults);
    const m = buildMission(sc, sc.defaults, terrain, weather);
    expect(m.kind).toBe('search');
    expect(m.stages).toHaveLength(1);
    const st = m.stages[0]!;
    expect(st.payload).toEqual({ massKg: THERMAL_CAMERA.massKg, powerW: THERMAL_CAMERA.powerW });
    expect(Math.hypot(toLocal(ORIGIN, st.landing).east, toLocal(ORIGIN, st.landing).north)).toBeLessThan(1);
    expect(simulateMission(st, weather).issues).toEqual([]);
    // Мир поиска на это задание: люди и звери района внутри района.
    const w = new SearchWorld({ origin: sc.site, area: sc.area, difficulty: 'hard', seed: 11, animals: sc.animals!, terrain });
    expect(w.bodies.every((b) => b.kind === 'person' || b.kind === 'moose' || b.kind === 'deer')).toBe(true);
  });
});
