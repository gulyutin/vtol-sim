import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../src/sim/aircraft';
import { G } from '../src/sim/atmosphere';
import { dubins, samplePath } from '../src/sim/dubins';
import { fromLocal, simulateMission } from '../src/sim/mission';
import { CAMERAS } from '../src/sim/payload';
import {
  captureFrames,
  coverageOf,
  footprintM,
  heightForGsdM,
  illuminanceLux,
  isoNeeded,
  lineSpacingM,
  planSurvey,
  triggerBaseM,
  type SurveyParams,
} from '../src/sim/survey';
import { flatTerrain, followTerrain } from '../src/sim/terrain';
import { buildTimeline } from '../src/sim/timeline';
import type { Site, Weather } from '../src/sim/types';

const SITE: Site = { lat: 55, lon: 60, elevationM: 300 };
const cam = CAMERAS.find((c) => c.id === 'ff61')!;
const P: SurveyParams = { gsdM: 0.03, forwardOverlap: 0.75, sideOverlap: 0.65, directionDeg: 90, shutterS: 1 / 1600, leadInM: 60 };
/** Прямоугольник 1200 × 800 м восточнее площадки. */
const AREA = [
  [500, -400],
  [1700, -400],
  [1700, 400],
  [500, 400],
].map(([e, n]) => fromLocal(SITE, e!, n!));
const RADIUS = (1.1 * 22 ** 2) / (G * Math.tan((AIRCRAFT.maxBankDeg * Math.PI) / 180));
const NOON = () => illuminanceLux(55, 0);

function fly(params: SurveyParams, weather: Weather) {
  const survey = planSurvey(AREA, SITE, cam, params, RADIUS);
  const terrain = flatTerrain(300);
  const waypoints = followTerrain([SITE, ...survey.route, SITE], terrain, 345, 350, 20, 20, { heightAglM: survey.heightAglM, groundSpeedMs: () => 22 });
  const plan = { takeoff: SITE, landing: SITE, waypoints, iasMs: 21, payload: cam, terrain, legLabels: survey.legLabels };
  const tl = buildTimeline(plan, simulateMission(plan, weather));
  return { survey, tl, terrain };
}

describe('развороты Дубинса', () => {
  it('разворот на 180° на соседний галс в двух радиусах — полуокружность', () => {
    const p = dubins({ x: 0, y: 0, theta: 0 }, { x: 0, y: 200, theta: Math.PI }, 100);
    expect(p.length).toBeCloseTo(Math.PI * 100, 6);
  });

  it('путь приходит в заданную точку с заданным курсом', () => {
    const goal = { x: 120, y: -40, theta: 2.5 };
    const pts = samplePath(dubins({ x: 0, y: 0, theta: 0.3 }, goal, 50), 5);
    const end = pts[pts.length - 1]!;
    expect(end.x).toBeCloseTo(goal.x, 6);
    expect(end.y).toBeCloseTo(goal.y, 6);
    expect(Math.cos(end.theta - goal.theta)).toBeCloseTo(1, 9);
  });
});

describe('фотограмметрия', () => {
  it('высота, кадр, шаг галсов и базис из GSD и перекрытий', () => {
    const h = heightForGsdM(cam, 0.03);
    expect(h).toBeCloseTo((0.03 * 0.035) / 3.76e-6, 6);
    expect(footprintM(cam, h).acrossM).toBeCloseTo(0.03 * 9504, 6);
    expect(lineSpacingM(cam, P)).toBeCloseTo(0.03 * 9504 * 0.35, 6);
    expect(triggerBaseM(cam, P)).toBeCloseTo(0.03 * 6336 * 0.25, 6);
  });

  it('освещённость и ISO: при Солнце на 60° и 1/1600 с на f/5.6 хватает ISO 100–300', () => {
    expect(illuminanceLux(60, 0)).toBeGreaterThan(90_000);
    expect(illuminanceLux(60, 0)).toBeLessThan(120_000);
    expect(illuminanceLux(10, 0)).toBeGreaterThan(8_000);
    expect(illuminanceLux(10, 0)).toBeLessThan(20_000);
    const iso = isoNeeded(cam, 1 / 1600, illuminanceLux(60, 0));
    expect(iso).toBeGreaterThan(100);
    expect(iso).toBeLessThan(300);
  });

  it('галсы покрывают участок, развороты не круче минимального радиуса', () => {
    const s = planSurvey(AREA, SITE, cam, P, RADIUS);
    expect(s.lineCount).toBe(Math.ceil(800 / lineSpacingM(cam, P)));
    expect(s.linesLengthM).toBeCloseTo(s.lineCount * (1200 + 2 * P.leadInM), -1);
    const turnLegs = s.legLabels.map((l, i) => (l.startsWith('Разворот') ? i : -1)).filter((i) => i > 0);
    for (const i of turnLegs.slice(1)) {
      const [a, b, c] = [s.route[i - 2]!, s.route[i - 1]!, s.route[i]!];
      const h1 = Math.atan2(b.lat - a.lat, (b.lon - a.lon) * Math.cos((55 * Math.PI) / 180));
      const h2 = Math.atan2(c.lat - b.lat, (c.lon - b.lon) * Math.cos((55 * Math.PI) / 180));
      const turn = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
      expect(turn).toBeLessThanOrEqual(15 / RADIUS + 0.02);
    }
  });
});

describe('порядок галсов', () => {
  const length = (s: ReturnType<typeof planSurvey>) =>
    s.route.slice(1).reduce((sum, b, i) => {
      const a = s.route[i]!;
      return sum + Math.hypot((b.lat - a.lat) * 111_195, (b.lon - a.lon) * 111_195 * Math.cos((55 * Math.PI) / 180));
    }, 0);

  it('если галсы ближе двух радиусов, «ипподром» короче «змейки» и без петель', () => {
    const R = 200;
    const race = planSurvey(AREA, SITE, cam, P, R);
    const snake = planSurvey(AREA, SITE, cam, P, R, { order: 'serpentine' });
    expect(race.lineCount).toBe(snake.lineCount);
    expect(race.linesLengthM).toBeCloseTo(snake.linesLengthM, 3);
    expect(length(race)).toBeLessThan(length(snake) * 0.9);
  });

  it('если галсы дальше двух радиусов, порядок — подряд', () => {
    const R = 40;
    expect(length(planSurvey(AREA, SITE, cam, P, R))).toBeCloseTo(length(planSurvey(AREA, SITE, cam, P, R, { order: 'serpentine' })), 3);
  });
});

describe('спуск затвора и покрытие', () => {
  const CALM: Weather = { groundTemperatureC: 20, wind: { speedMs: 0, fromDeg: 0 } };

  it('в штиль кадры идут через базис, все годные, на 95 % участка не меньше 5 кадров', () => {
    const { survey, tl, terrain } = fly(P, CALM);
    const frames = captureFrames(tl, cam, P, { site: SITE, terrain, lineLegs: survey.lineLegs, luxAt: NOON });
    expect(frames.every((f) => f.ok)).toBe(true);
    const gaps = frames.slice(1).map((f, i) => Math.hypot(f.east - frames[i]!.east, f.north - frames[i]!.north)).filter((d) => d < 2 * survey.baseM);
    for (const d of gaps) expect(Math.abs(d / survey.baseM - 1)).toBeLessThan(0.05);
    expect(coverageOf(frames, AREA, SITE).atLeast5).toBeGreaterThan(0.95);
  });

  it('попутный ветер: камера не успевает, кадры реже базиса', () => {
    const p = { ...P, forwardOverlap: 0.85 };
    const { survey, tl, terrain } = fly(p, { groundTemperatureC: 20, wind: { speedMs: 12, fromDeg: 270 } });
    const frames = captureFrames(tl, cam, p, { site: SITE, terrain, lineLegs: survey.lineLegs, luxAt: NOON });
    // Соседние кадры одного галса на восток — по ветру.
    const gaps = frames
      .slice(1)
      .map((f, i) => ({ f, prev: frames[i]! }))
      .filter(({ f, prev }) => f.east > prev.east && Math.abs(f.north - prev.north) < 5)
      .map(({ f, prev }) => f.east - prev.east);
    expect(gaps.length).toBeGreaterThan(10);
    const sorted = [...gaps].sort((a, b) => a - b);
    // Интервал задаёт скорострельность камеры (путевая · 1 с), а не базис; чаще базиса — никогда.
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeGreaterThan(triggerBaseM(cam, p) * 1.1);
    expect(sorted[0]!).toBeGreaterThanOrEqual(triggerBaseM(cam, p) * 0.98);
  });

  it('низкое Солнце: при 1/1600 не хватает ISO — кадры в брак', () => {
    const { survey, tl, terrain } = fly(P, CALM);
    const frames = captureFrames(tl, cam, P, { site: SITE, terrain, lineLegs: survey.lineLegs, luxAt: () => illuminanceLux(2, 0) });
    expect(frames.every((f) => !f.ok && f.reason === 'недодержка')).toBe(true);
  });

  it('длинная выдержка смазывает кадр', () => {
    const p = { ...P, shutterS: 1 / 250 };
    const { survey, tl, terrain } = fly(p, CALM);
    const frames = captureFrames(tl, cam, p, { site: SITE, terrain, lineLegs: survey.lineLegs, luxAt: NOON });
    expect(frames.every((f) => f.blurPx > 1 && f.reason === 'смаз')).toBe(true);
    expect(coverageOf(frames, AREA, SITE).atLeast1).toBe(0);
  });
});
