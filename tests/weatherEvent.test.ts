import { describe, expect, it } from 'vitest';
import { plainLocalWind, WeatherEvent } from '../src/sim/weatherEvent';
import type { Weather } from '../src/sim/types';

const base: Weather = { groundTemperatureC: 15, wind: { speedMs: 5, fromDeg: 270 }, windProfile: { referenceHeightM: 10, shearExponent: 0.14 }, cloudBaseM: 1500, cloudCover: 0.3 };
const target = { east: 3000, north: 2000 };
const fromDeg = (w: { eastMs: number; northMs: number }) => (((Math.atan2(-w.eastMs, -w.northMs) * 180) / Math.PI) % 360 + 360) % 360;

describe('погода меняется в полёте', () => {
  it('холодный фронт приходит к цели в заданное время; за ним ветер сильнее и правее, дождь и низкие облака', () => {
    const ev = new WeatherEvent('front', base, { seed: 3, target, arriveS: 1200 });
    const lw = plainLocalWind(base, 150);
    const before = ev.apply(lw, target.east, target.north, 150, 600);
    expect(before.eastMs).toBeCloseTo(lw.eastMs, 6);
    expect(ev.approach(target.east, target.north, 600).etaS).toBeCloseTo(600, 3);
    const after = ev.apply(lw, target.east, target.north, 150, 1800);
    const sp = (w: { eastMs: number; northMs: number }) => Math.hypot(w.eastMs, w.northMs);
    expect(sp(after) / sp(lw)).toBeGreaterThan(1.5);
    const veer = ((fromDeg(after) - fromDeg(lw) + 540) % 360) - 180;
    expect(veer).toBeGreaterThan(35);
    expect(veer).toBeLessThan(75);
    const w = ev.weatherAt(target.east, target.north, 1600);
    expect(w.precipitation?.kind).toBe('rain');
    expect(w.cloudBaseM!).toBeLessThan(900);
    // На линии — шквал: болтанка сильнее.
    const t0 = ev.approach(target.east, target.north, 0).etaS!;
    expect(ev.apply(lw, target.east, target.north, 150, t0).turbulenceAddMs).toBeGreaterThan(3);
  });

  it('гроза: под ядром — ливень и нисходящий поток, вокруг — ветер от ячейки, на карте — ячейка', () => {
    const ev = new WeatherEvent('storm', base, { seed: 5, target, arriveS: 1200 });
    const h = ev.hazard(1200, 0);
    expect(h?.kind).toBe('storm');
    if (h?.kind !== 'storm') return;
    const lw = plainLocalWind(base, 150);
    const core = ev.apply(lw, h.center.east, h.center.north, 150, 1200);
    expect(core.upMs).toBeLessThan(-3);
    expect(core.turbulenceAddMs).toBeGreaterThan(3);
    expect(ev.weatherAt(h.center.east, h.center.north, 1200).precipitation!.mmPerH).toBeGreaterThan(20);
    // В 2 км от кромки ядра ветер дует от ячейки.
    const p = { east: h.center.east + 3500, north: h.center.north };
    const out = ev.apply({ ...lw, eastMs: 0, northMs: 0 }, p.east, p.north, 50, 1200);
    expect(out.eastMs).toBeGreaterThan(5);
    // Далеко от ячейки — ничего.
    const far = ev.apply(lw, h.center.east + 30000, h.center.north, 150, 1200);
    expect(far).toBe(lw);
  });
});
