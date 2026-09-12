import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS } from '../src/game/scenarios';
import { destination, simulateMission } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import { buildTimeline, stateAt, timeWhenEnergyReaches } from '../src/sim/timeline';

const sc = SCENARIOS[0]!;
const terrain = flatTerrain(320);
const weather = forecastWeather(sc, sc.defaults);
const mission = buildMission(sc, sc.defaults, terrain, weather);
const plan = mission.stages[0]!;
const survey = mission.survey!;
const result = simulateMission(plan, weather);
const tl = buildTimeline(plan, result);

describe('проигрывание миссии', () => {
  it('демо-задание выполнимо', () => {
    expect(result.issues).toEqual([]);
  });

  it('длительность и энергия совпадают с расчётом миссии', () => {
    expect(tl.durationS).toBeCloseTo(result.durationS, 6);
    const end = stateAt(tl, tl.durationS);
    expect(end.energyWh).toBeCloseTo(result.budget.totalWh, 6);
    expect(end.soc).toBeCloseTo(result.socAtLanding, 9);
  });

  it('траектория непрерывна на стыках участков', () => {
    for (const leg of tl.legs.slice(0, -1)) {
      const a = stateAt(tl, leg.t1 - 1e-7).position;
      const b = stateAt(tl, leg.t1 + 1e-7).position;
      expect(Math.hypot(a.east - b.east, a.north - b.north, a.up - b.up)).toBeLessThan(0.01);
    }
  });

  it('взлетает с площадки и садится на площадку посадки', () => {
    const start = stateAt(tl, 0).position;
    const end = stateAt(tl, tl.durationS).position;
    for (const k of ['east', 'north', 'up'] as const) {
      expect(start[k]).toBeCloseTo(0, 6);
      expect(end[k]).toBeCloseTo(tl.landing[k], 6);
    }
  });

  it('к концу перехода набрана путевая скорость первого сегмента', () => {
    const tr = tl.legs.find((l) => l.kind === 'transition')!;
    expect(stateAt(tl, tr.t1 - 1e-6).groundSpeedMs).toBeCloseTo(tr.segment!.groundSpeedMs, 2);
  });

  it('участки подписаны по плану съёмки: каждый галс — одной строкой', () => {
    const lines = new Set(tl.legs.filter((l) => l.kind === 'cruise' && l.name.startsWith('Галс')).map((l) => l.name));
    expect(lines.size).toBe(survey.lineCount);
  });

  it('маршрут длиннее ёмкости: батарея кончается до посадки', () => {
    expect(timeWhenEnergyReaches(tl, tl.capacityWh)).toBeNull();
    const far = destination(plan.takeoff, 90, 70_000);
    const longPlan = { ...plan, waypoints: [{ ...far, altitudeM: plan.waypoints[0]!.altitudeM }], legLabels: undefined };
    const long = buildTimeline(longPlan, simulateMission(longPlan, weather));
    const empty = timeWhenEnergyReaches(long, long.capacityWh);
    expect(empty).not.toBeNull();
    expect(empty!).toBeLessThan(long.durationS);
    expect(stateAt(long, empty!).soc).toBeCloseTo(0, 6);
  });
});
