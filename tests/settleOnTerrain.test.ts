import { describe, expect, it } from 'vitest';
import { settleOnTerrain } from '../src/game/logRegion';
import type { Recording, Sample } from '../src/game/recorder';

/*
 * Высоты журнала — к рельефу сцены: высота журнала уходит за полёт, земля в точке посадки выше
 * точки взлёта — без поправки аппарат в повторе стоит под землёй.
 */

function sample(t: number, east: number, up: number, mode: string): Sample {
  return { t, east, north: 0, up, headingDeg: 0, pitchDeg: 0, bankDeg: 0, iasMs: 0, gsMs: 0, vzMs: 0, aglM: 0, powerW: 0, energyWh: 0, soc: 1, mode, lift: 0, pusher: 0 };
}

// Рельеф поднимается на восток: 5 м на 1000 м.
const groundAt = (east: number) => east * 0.005;

// Взлёт на 0 (журнал: −1 м), полёт на 100 м над точкой взлёта, посадка в 1000 м восточнее (журнал: −6 м, земля +5 м).
const rec: Recording = {
  version: 1,
  meta: { title: 'журнал', startedAt: '2026-06-20T08:00:00Z', profileTitle: 'п', source: 'log' },
  samples: [
    sample(0, 0, -1, 'ground'),
    sample(10, 0, -0.5, 'spool'),
    sample(20, 0, 20, 'climb'),
    sample(60, 500, 100, 'auto'),
    sample(100, 1000, 3, 'final'),
    sample(110, 1000, -6, 'landed'),
  ],
  events: [],
};

describe('высоты журнала — к рельефу', () => {
  const out = settleOnTerrain(rec, groundAt).samples;

  it('на земле — на рельефе, в том числе в точке посадки выше точки взлёта', () => {
    expect(out[0]!.up).toBeCloseTo(0, 6);
    expect(out[1]!.up).toBeCloseTo(0, 6);
    expect(out[5]!.up).toBeCloseTo(5, 6);
  });

  it('в воздухе — поправка линейно от взлёта к посадке, не ниже рельефа', () => {
    // Поправка: +0,5 м на отрыве (t=10), +11 м на касании (t=110); на t=60 — половина пути.
    expect(out[3]!.up).toBeCloseTo(100 + 0.5 + (11 - 0.5) * 0.5, 6);
    for (const [i, x] of out.entries()) expect(x.up, `отсчёт ${i}`).toBeGreaterThanOrEqual(groundAt(x.east) - 1e-9);
  });

  it('остальное в отсчётах не меняется', () => {
    expect(out.map((x) => x.t)).toEqual(rec.samples.map((x) => x.t));
    expect(out.map((x) => x.mode)).toEqual(rec.samples.map((x) => x.mode));
  });
});
