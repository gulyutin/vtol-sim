import { describe, expect, it } from 'vitest';
import { GroundTeams } from '../src/game/groundTeams';

describe('наземные группы', () => {
  it('машина едет до леса, дальше пешком, доклад о прибытии — один раз', () => {
    const g = new GroundTeams();
    const to = { east: 3000, north: 0 };
    const team = g.dispatch(to, 100, 'rescue', { east: 0, north: 0 });
    expect(team.name).toBe('Спасательная группа 1');
    // Через минуту — машина в пути, людей группы ещё нет.
    expect(g.vehicles(160)[0]!.east).toBeCloseTo(420, 0);
    expect(g.bodies(160).length).toBe(3);
    const eta = GroundTeams.etaS(team.from, team.to);
    expect(eta).toBeCloseTo(2300 / 7 + 700 / 1.2, 0);
    // Посередине пешего пути — трое идут, машина стоит у места высадки.
    const mid = 100 + 2300 / 7 + 300;
    const walkers = g.bodies(mid).filter((b) => b.pose === 'walking');
    expect(walkers.length).toBe(3);
    expect(g.vehicles(mid)[0]!.east).toBeCloseTo(2300, 0);
    expect(g.arrivals(mid)).toEqual([]);
    expect(g.arrivals(100 + eta + 1).map((x) => x.id)).toEqual([team.id]);
    expect(g.arrivals(100 + eta + 5)).toEqual([]);
    expect(g.positions(100 + eta + 5)[0]!.arrived).toBe(true);
  });
});
