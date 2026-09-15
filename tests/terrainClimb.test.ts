import { describe, expect, it } from 'vitest';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { fromLocal, toLocal } from '../src/sim/mission';
import type { MissionPlan, Site, Terrain, Weather } from '../src/sim/types';

/*
 * Склон впереди круче, чем аппарат успевает набрать (план без запаса, нисходящий поток у склона):
 * автопилот набирает высоту по кругу над местом, а не летит в склон.
 */

const site: Site = { lat: 45, lon: 40, elevationM: 200 };
const at = (east: number, north: number, altitudeM: number) => ({ ...fromLocal(site, east, north), altitudeM });
const local = (f: (east: number, north: number) => number): Terrain => ({
  elevationM: (p) => {
    const { east, north } = toLocal(site, p);
    return f(east, north);
  },
});
const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 0, fromDeg: 0 } };
const controls: Controls = { iasMs: 22, heightAglM: 120, courseDeg: 0, target: null };

/** На север по плану, где от 3,5 до 6,5 км набор 690 м — 23 %, втрое круче предельных 2 м/с. */
function fly(terrain: Terrain, topM: number) {
  const plan: MissionPlan = {
    takeoff: { ...fromLocal(site, 0, 0), elevationM: 200 },
    landing: { ...fromLocal(site, 0, 11_000), elevationM: topM },
    waypoints: [at(0, 1500, 320), at(0, 3500, 330), at(0, 6500, topM + 120), at(0, 9500, topM + 120)],
    iasMs: 22,
    payload: null,
  };
  // НСУ высоко — связь не пропадает за склоном.
  const f = new LiveFlight({ plan, terrain, weather, origin: site, seed: 5, gcs: { ...site, elevationM: 3000 } });
  f.command('arm');
  f.command('takeoff');
  while (f.state.north < 8500 && f.state.mode !== 'crashed' && f.state.t < 3600) f.step(0.5, controls);
  return f;
}

describe('склон впереди круче, чем успеваем набрать', () => {
  it('набор высоты по кругу над местом, потом дальше по маршруту — без столкновения', () => {
    // С 4 до 6 км на север рельеф поднимается с 200 до 900 м — 35 %.
    const f = fly(local((_, n) => 200 + 700 * Math.min(1, Math.max(0, (n - 4000) / 2000))), 900);
    expect(f.state.mode).not.toBe('crashed');
    expect(f.state.north).toBeGreaterThanOrEqual(8500);
    const texts = f.events.map((e) => e.text);
    expect(texts.some((t) => t.startsWith('Набор высоты по кругу'))).toBe(true);
    expect(texts).toContain('Высота набрана — продолжаю маршрут');
  });

  it('над ровным местом по тому же плану — без кругов', () => {
    const f = fly(local(() => 200), 200);
    expect(f.state.mode).not.toBe('crashed');
    expect(f.events.some((e) => e.text.startsWith('Набор высоты по кругу'))).toBe(false);
  });
});
