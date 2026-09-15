import { describe, expect, it } from 'vitest';
import type { LinkLossAction } from '../src/sim/failures';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { fromLocal } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import type { MissionPlan, Site, Weather } from '../src/sim/types';

/* Реакция на потерю связи с НСУ — по настройке задания: ВОЗВРАТ, продолжать задание, посадка на месте. */

const site: Site = { lat: 45, lon: 40, elevationM: 200 };
const at = (east: number, north: number, altitudeM: number) => ({ ...fromLocal(site, east, north), altitudeM });
const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 0, fromDeg: 0 } };
const controls: Controls = { iasMs: 22, heightAglM: 120, courseDeg: 0, target: null };

/** Маршрут на север 8 км и обратно; на 3-й минуте задания — отказ связи; ещё 40 с полёта. */
function fly(linkLoss?: { action: LinkLossAction; timeoutS: number }) {
  const plan: MissionPlan = {
    takeoff: { ...site },
    landing: { ...site },
    waypoints: [at(0, 1500, 320), at(0, 8000, 320), at(500, 8000, 320), at(500, 1500, 320)],
    iasMs: 22,
    payload: null,
  };
  const f = new LiveFlight({ plan, terrain: flatTerrain(200), weather, origin: site, seed: 2, ...(linkLoss ? { linkLoss } : {}) });
  f.command('arm');
  f.command('takeoff');
  let autoT = NaN;
  while (f.state.t < 1200) {
    f.step(0.5, controls);
    if (f.state.mode === 'auto' && Number.isNaN(autoT)) autoT = f.state.t;
    if (!Number.isNaN(autoT) && f.state.t >= autoT + 120) break;
  }
  f.inject('link');
  const t0 = f.state.t;
  while (f.state.t < t0 + 40) f.step(0.5, controls);
  return { f, texts: f.events.map((e) => e.text) };
}

describe('потеря связи: реакция по настройке', () => {
  it('по умолчанию — ВОЗВРАТ через 30 с', () => {
    const { f, texts } = fly();
    expect(texts).toContain('Нет связи 30 с — ВОЗВРАТ');
    expect(f.state.mode).toBe('rtl');
  });

  it('продолжать задание — остаётся в задании, одна запись о решении', () => {
    const { f, texts } = fly({ action: 'continue', timeoutS: 10 });
    expect(texts.filter((t) => t === 'Нет связи 10 с — продолжаю задание')).toHaveLength(1);
    expect(f.state.mode).toBe('auto');
  });

  it('посадка на месте — торможение и вертикальная посадка там, где застала потеря связи', () => {
    const { f, texts } = fly({ action: 'land', timeoutS: 10 });
    expect(texts).toContain('Нет связи 10 с — посадка на месте');
    expect(['backtransition', 'descent', 'final', 'landed']).toContain(f.state.mode);
  });
});
