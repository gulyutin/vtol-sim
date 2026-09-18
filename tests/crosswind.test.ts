import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { fromLocal } from '../src/sim/mission';
import type { MissionPlan, Site, Weather } from '../src/sim/types';
import { NEUTRAL_SHEAR, stabilityShear } from '../src/sim/wind';

/*
 * Боковой ветер на прямой: нос развёрнут против ветра на угол сноса, крылья ровные — плюс
 * постоянный перекос планера (AIRCRAFT.cruiseTrim), с которым аппарат летит и в штиль.
 */

const site: Site = { lat: 55, lon: 37, elevationM: 150 };
const at = (east: number, north: number) => ({ ...fromLocal(site, east, north), altitudeM: 300 });
const plan: MissionPlan = {
  takeoff: site,
  landing: { ...fromLocal(site, 0, 14_000), elevationM: 150 },
  waypoints: [at(0, 1500), at(0, 13_000)],
  iasMs: 21,
  payload: null,
};
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const trim = AIRCRAFT.cruiseTrim ?? { rollDeg: 0, slipDeg: 0 };

function straight(wind: Weather['wind']) {
  const weather: Weather = { groundTemperatureC: 15, wind };
  const f = new LiveFlight({ plan, terrain: { elevationM: () => 150 }, weather, origin: site, seed: 3 });
  f.command('arm');
  f.command('takeoff');
  const acc = { n: 0, bank: 0, crab: 0, track: 0, east: 0, expect: 0 };
  while (f.state.north < 11_000 && f.state.mode !== 'crashed' && f.state.t < 3600) {
    f.step(0.2, controls);
    const s = f.state;
    if (s.mode !== 'auto' || s.north < 5000) continue;
    acc.n++;
    acc.bank += s.bankDeg;
    acc.crab += wrap(s.headingDeg - s.trackDeg);
    acc.track += wrap(s.trackDeg);
    acc.east += Math.abs(s.east);
    acc.expect += (Math.asin((wind.speedMs * Math.sin(((wind.fromDeg - s.trackDeg) * Math.PI) / 180)) / s.tasMs) * 180) / Math.PI;
  }
  const n = acc.n || 1;
  return { n: acc.n, bank: acc.bank / n, crab: acc.crab / n, track: acc.track / n, east: acc.east / n, expect: acc.expect / n };
}

describe('боковой ветер на прямой', () => {
  it('в штиль — только постоянный перекос: крен и нос чуть в сторону, путь прямой', () => {
    const r = straight({ speedMs: 0, fromDeg: 0 });
    expect(r.n).toBeGreaterThan(100);
    expect(r.bank).toBeCloseTo(trim.rollDeg, 0);
    expect(r.crab).toBeCloseTo(trim.slipDeg, 0);
    expect(Math.abs(r.track)).toBeLessThan(1);
    expect(r.east).toBeLessThan(20);
  });

  it('ветер справа: нос вправо на угол сноса, крен тот же, линию пути держит', () => {
    const r = straight({ speedMs: 7, fromDeg: 90 });
    expect(r.n).toBeGreaterThan(100);
    expect(r.expect).toBeGreaterThan(15);
    expect(r.crab).toBeCloseTo(r.expect + trim.slipDeg, 0);
    expect(r.bank).toBeCloseTo(trim.rollDeg, 0);
    expect(Math.abs(r.track)).toBeLessThan(1);
    expect(r.east).toBeLessThan(20);
  });

  it('ветер слева — нос влево', () => {
    const r = straight({ speedMs: 7, fromDeg: 270 });
    expect(r.crab).toBeCloseTo(r.expect + trim.slipDeg, 0);
    expect(r.expect).toBeLessThan(-15);
  });
});

describe('рост ветра с высотой по устойчивости воздуха', () => {
  it('днём ясно и тихо — слабее безразличного, ночью ясно и тихо — сильнее, в сильный ветер — безразличный', () => {
    const day = stabilityShear(45, 0, 2);
    const night = stabilityShear(-20, 0, 2);
    expect(day).toBeLessThan(0.6 * NEUTRAL_SHEAR + 1e-9);
    expect(night).toBeGreaterThan(1.8 * NEUTRAL_SHEAR - 1e-9);
    expect(stabilityShear(45, 0, 12)).toBeCloseTo(NEUTRAL_SHEAR, 6);
    expect(stabilityShear(-20, 0, 12)).toBeCloseTo(NEUTRAL_SHEAR, 6);
    // Сплошная облачность гасит и прогрев, и выхолаживание.
    expect(stabilityShear(-20, 1, 2)).toBeCloseTo(NEUTRAL_SHEAR, 6);
    expect(stabilityShear(45, 1, 2)).toBeGreaterThan(day);
  });
});
