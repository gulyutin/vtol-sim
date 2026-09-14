import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls, type LiveState } from '../src/sim/flight';
import { fromLocal, toLocal } from '../src/sim/mission';
import { terrainWind, type TerrainWind } from '../src/sim/terrainWind';
import type { MissionPlan, Site, Terrain, Weather } from '../src/sim/types';

/*
 * Плавность позы в 3D: полёт по заданию кадрами по 1/60 с, как в main.ts, при ускорении времени
 * 1 и 10. Поза — ровно та, что строит main.ts (положение, курс, крен, тангаж). По ней — наибольшие
 * изменения за кадр в пересчёте на секунду полёта (°/с, м/с) и ускорения по вторым разностям:
 * мгновенные скачки состояния при смене режима и шум каждого шага видны как всплески.
 * SMOOTH_REPORT=1 — печать таблицы и худших кадров.
 */

const site: Site = { lat: 45, lon: 40, elevationM: 200 };
const at = (east: number, north: number, altitudeM: number) => ({ ...fromLocal(site, east, north), altitudeM });
const flat: Terrain = { elevationM: () => 200 };
/** Холмы для поля ветра рельефа: гряда поперёк ветра между галсами. */
const hills: Terrain = {
  elevationM: (p) => {
    const { east, north } = toLocal(site, p);
    return 200 + 150 * Math.exp(-((east - 1200) ** 2) / (2 * 500 ** 2)) * Math.exp(-((north - 1800) ** 2) / (2 * 1500 ** 2));
  },
};

/** Взлёт, галсы с разворотами на 90–120°, посадочная прямая к точке взлёта. */
const plan = (terrain: Terrain): MissionPlan => ({
  takeoff: { ...site, elevationM: terrain.elevationM(site) },
  landing: { ...fromLocal(site, 0, 300), elevationM: terrain.elevationM(fromLocal(site, 0, 300)) },
  waypoints: [at(0, 1500, 330), at(2000, 2500, 400), at(2600, 800, 380), at(1200, -800, 330), at(0, -1200, 300)],
  iasMs: 22,
  payload: null,
});

const controls: Controls = { iasMs: 22, heightAglM: 120, courseDeg: 0, target: null };

interface Pose {
  t: number;
  mode: string;
  e: number;
  n: number;
  up: number;
  heading: number;
  bank: number;
  pitch: number;
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const PLANE = ['transition', 'auto', 'guided', 'manual', 'rtl', 'backtransition', 'falling'];

/** Поза, как её строит main.ts: тангаж и крен — из полей физики, если они есть, иначе по-старому. */
function poseOf(s: LiveState): Pose {
  const x = s as LiveState & { pitchDeg?: number; rollDeg?: number };
  const plane = PLANE.includes(s.mode) || (s.mode === 'failsafe' && s.failsafePhase === 'plane');
  const oldPitch = plane && s.groundSpeedMs > 3 ? (Math.atan2(s.vzMs, s.groundSpeedMs) * 180) / Math.PI + 2 : 0;
  return {
    t: s.t,
    mode: s.mode,
    e: s.east,
    n: s.north,
    up: s.up,
    heading: s.headingDeg,
    bank: x.rollDeg ?? s.bankDeg,
    pitch: x.pitchDeg ?? oldPitch,
  };
}

interface Spike {
  value: number;
  t: number;
  mode: string;
  from: string;
}

interface Metrics {
  /** Изменение за кадр в пересчёте на секунду полёта: °/с и м/с. */
  bankRate: Spike;
  pitchRate: Spike;
  headingRate: Spike;
  upRate: Spike;
  /** Наибольшее изменение за кадр как есть, ° и м. */
  bankJump: number;
  pitchJump: number;
  headingJump: number;
  upJump: number;
  /** Вторые разности: вертикальное и горизонтальное ускорение, м/с²; угловые ускорения крена и тангажа, °/с². */
  vAccel: Spike;
  hAccel: Spike;
  rollAccel: Spike;
  pitchAccel: Spike;
  modes: string[];
  final: LiveState;
  /** По режимам: наибольшие крен °/с, тангаж °/с, курс °/с, верт. и гор. ускорение — для отчёта. */
  byMode: Map<string, number[]>;
}

interface Run {
  rate: number;
  weather: Weather;
  terrain?: Terrain;
  tw?: TerrainWind;
  /** Нос на площадке — сюда (предполётная: против ветра), а не на первую точку. */
  groundHeadingDeg?: number;
  seed?: number;
}

function fly(r: Run): Metrics {
  const terrain = r.terrain ?? flat;
  const f = new LiveFlight({ plan: plan(terrain), terrain, weather: r.weather, origin: site, terrainWind: r.tw, seed: r.seed ?? 3 });
  if (r.groundHeadingDeg !== undefined) f.setGroundHeading(r.groundHeadingDeg);
  f.command('arm');
  f.command('takeoff');
  const frame = 1 / 60;
  const dt = frame * r.rate;
  const poses: Pose[] = [poseOf(f.state)];
  const modes: string[] = [f.state.mode];
  while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 3600) {
    f.step(dt, controls);
    const p = poseOf(f.state);
    poses.push(p);
    if (modes[modes.length - 1] !== p.mode) modes.push(p.mode);
  }
  const zero = (): Spike => ({ value: 0, t: 0, mode: '', from: '' });
  const m: Metrics = {
    bankRate: zero(),
    pitchRate: zero(),
    headingRate: zero(),
    upRate: zero(),
    bankJump: 0,
    pitchJump: 0,
    headingJump: 0,
    upJump: 0,
    vAccel: zero(),
    hAccel: zero(),
    rollAccel: zero(),
    pitchAccel: zero(),
    modes,
    final: f.state,
    byMode: new Map(),
  };
  const row = (i: number, k: number, v: number) => {
    const key = poses[i - 1]!.mode === poses[i]!.mode ? poses[i]!.mode : `${poses[i - 1]!.mode}→${poses[i]!.mode}`;
    const r = m.byMode.get(key) ?? [0, 0, 0, 0, 0];
    r[k] = Math.max(r[k]!, v);
    m.byMode.set(key, r);
  };
  const put = (k: keyof Metrics, v: number, i: number) => {
    const s = m[k] as Spike;
    if (v > s.value) Object.assign(s, { value: v, t: poses[i]!.t, mode: poses[i]!.mode, from: poses[Math.max(0, i - 2)]!.mode });
  };
  for (let i = 1; i < poses.length; i++) {
    const a = poses[i - 1]!;
    const b = poses[i]!;
    // Касание: дальше поза на земле, её рисует не физика полёта.
    if (b.mode === 'landed' || b.mode === 'crashed') break;
    const db = Math.abs(b.bank - a.bank);
    const dp = Math.abs(b.pitch - a.pitch);
    const dh = Math.abs(wrap(b.heading - a.heading));
    const du = Math.abs(b.up - a.up);
    m.bankJump = Math.max(m.bankJump, db);
    m.pitchJump = Math.max(m.pitchJump, dp);
    m.headingJump = Math.max(m.headingJump, dh);
    m.upJump = Math.max(m.upJump, du);
    put('bankRate', db / dt, i);
    put('pitchRate', dp / dt, i);
    put('headingRate', dh / dt, i);
    put('upRate', du / dt, i);
    row(i, 0, db / dt);
    row(i, 1, dp / dt);
    row(i, 2, dh / dt);
    if (i < 2) continue;
    const z = poses[i - 2]!;
    put('vAccel', Math.abs(b.up - 2 * a.up + z.up) / dt ** 2, i);
    put('hAccel', Math.hypot(b.e - 2 * a.e + z.e, b.n - 2 * a.n + z.n) / dt ** 2, i);
    put('rollAccel', Math.abs(b.bank - 2 * a.bank + z.bank) / dt ** 2, i);
    put('pitchAccel', Math.abs(b.pitch - 2 * a.pitch + z.pitch) / dt ** 2, i);
    row(i, 3, Math.abs(b.up - 2 * a.up + z.up) / dt ** 2);
    row(i, 4, Math.hypot(b.e - 2 * a.e + z.e, b.n - 2 * a.n + z.n) / dt ** 2);
  }
  return m;
}

function report(name: string, m: Metrics) {
  if (!process.env.SMOOTH_REPORT) return;
  const f = (s: Spike, d = 1) => `${s.value.toFixed(d)} @${s.t.toFixed(1)}s ${s.from}→${s.mode}`;
  console.log(
    [
      `── ${name}: ${m.modes.join(' → ')}`,
      `  за кадр: крен ${m.bankJump.toFixed(2)}°, тангаж ${m.pitchJump.toFixed(2)}°, курс ${m.headingJump.toFixed(2)}°, высота ${m.upJump.toFixed(3)} м`,
      `  крен °/с      ${f(m.bankRate)}`,
      `  тангаж °/с    ${f(m.pitchRate)}`,
      `  курс °/с      ${f(m.headingRate)}`,
      `  высота м/с    ${f(m.upRate, 2)}`,
      `  верт. уск.    ${f(m.vAccel, 2)}`,
      `  гор. уск.     ${f(m.hAccel, 2)}`,
      `  крен °/с²     ${f(m.rollAccel)}`,
      `  тангаж °/с²   ${f(m.pitchAccel)}`,
      '  режим                      крен°/с тангаж°/с курс°/с  верт.уск гор.уск',
      ...[...m.byMode].map(([k, r]) => `  ${k.padEnd(26)} ${r.map((v) => v.toFixed(1).padStart(8)).join(' ')}`),
    ].join('\n'),
  );
}

const calm: Weather = { groundTemperatureC: 15, wind: { speedMs: 6, fromDeg: 250 } };
const rough: Weather = { ...calm, turbulenceMs: 1.5 };
const area = { east0: -3000, north0: -3000, east1: 5000, north1: 5000 };
let twCache: TerrainWind | null = null;
const tw = () => (twCache ??= terrainWind(hills, site, rough, { area }));

const RUNS: [string, () => Run][] = [
  ['штиль-ветер, ×1', () => ({ rate: 1, weather: calm, groundHeadingDeg: 250 })],
  ['штиль-ветер, ×10', () => ({ rate: 10, weather: calm, groundHeadingDeg: 250 })],
  ['болтанка 1.5, ×1', () => ({ rate: 1, weather: rough, groundHeadingDeg: 250 })],
  ['болтанка 1.5, ×10', () => ({ rate: 10, weather: rough, groundHeadingDeg: 250 })],
  ['ветер рельефа, ×1', () => ({ rate: 1, weather: rough, terrain: hills, tw: tw(), groundHeadingDeg: 250 })],
  ['ветер рельефа, ×10', () => ({ rate: 10, weather: rough, terrain: hills, tw: tw(), groundHeadingDeg: 250 })],
];

/*
 * Пределы — в секундах полёта, одни для ×1 и ×10. До исправлений здесь было: курс 6600°/с (разворот
 * носа на курс взлёта одним шагом), крен и тангаж ~550°/с (порывы каждый шаг, тангаж по шумной Vz),
 * горизонтальное ускорение ~400 м/с² и вертикальное 60 м/с² (скачки скорости при смене режима).
 * Разворот 28° на 22 м/с — это ~5 м/с² бокового ускорения; крен самолёта — до 20°/с, коптера — быстрее.
 */
const LIMITS = { bank: 45, pitch: 35, heading: 25, up: 3.5, vAccel: 3, hAccel: 7 };

describe('плавность позы в 3D', () => {
  for (const [name, run] of RUNS) {
    it(name, () => {
      const r = run();
      const m = fly(r);
      report(name, m);
      expect(m.final.mode).toBe('landed');
      expect(m.bankRate.value).toBeLessThan(LIMITS.bank);
      expect(m.pitchRate.value).toBeLessThan(LIMITS.pitch);
      expect(m.headingRate.value).toBeLessThan(LIMITS.heading);
      expect(m.upRate.value).toBeLessThan(LIMITS.up);
      expect(m.vAccel.value).toBeLessThan(LIMITS.vAccel);
      expect(m.hAccel.value).toBeLessThan(LIMITS.hAccel);
    });
  }
});

describe('тангаж корпуса (pitchDeg)', () => {
  const trace = (w: Weather) => {
    const f = new LiveFlight({ plan: plan(flat), terrain: flat, weather: w, origin: site, seed: 3 });
    f.command('arm');
    f.command('takeoff');
    const out: { mode: string; pitch: number; bank: number; vz: number; modeT: number; gamma: number; heading: number }[] = [];
    // На крейсерской приборной угол атаки — ровно балансировочный.
    const c = { ...controls, iasMs: AIRCRAFT.cruiseIasMs };
    while (f.state.mode !== 'landed' && f.state.t < 3600) {
      f.step(0.1, c);
      const s = f.state;
      const gamma = s.tasMs > 5 ? (Math.atan2(s.vzMs, s.tasMs) * 180) / Math.PI : 0;
      out.push({ mode: s.mode, pitch: s.pitchDeg, bank: s.bankDeg, vz: s.vzMs, modeT: s.modeT, gamma, heading: s.headingDeg });
    }
    return out;
  };
  const calmTrace = trace(calm);

  it('в самолёте — угол пути плюс ~2° на крейсерской приборной; в наборе нос выше; в вираже угол атаки больше', () => {
    const straight = calmTrace.filter((x) => x.mode === 'auto' && x.modeT > 30 && Math.abs(x.bank) < 1);
    expect(straight.length).toBeGreaterThan(100);
    for (const x of straight) expect(Math.abs(x.pitch - x.gamma - 2)).toBeLessThan(0.7);
    const climb = calmTrace.filter((x) => x.mode === 'auto' && x.vz > 0.5 * AIRCRAFT.planeClimbRateMaxMs && Math.abs(x.bank) < 1);
    expect(climb.length).toBeGreaterThan(10);
    for (const x of climb) expect(x.pitch).toBeGreaterThan(2.5);
    const turn = calmTrace.filter((x) => x.mode === 'auto' && Math.abs(x.bank) > 0.8 * AIRCRAFT.maxBankDeg);
    expect(turn.length).toBeGreaterThan(10);
    for (const x of turn) expect(x.pitch - x.gamma).toBeGreaterThan(2);
  });

  it('на висении — наклон против ветра на несколько градусов; на торможении — нос вверх; на земле — ровно', () => {
    const final = calmTrace.filter((x) => x.mode === 'final' && x.modeT > 3);
    expect(final.length).toBeGreaterThan(10);
    for (const x of final) {
      // Встречная составляющая — нос вниз, попутная — вверх; ветер слева — крен влево.
      const rel = ((calm.wind.fromDeg - x.heading) * Math.PI) / 180;
      expect(x.pitch * Math.cos(rel)).toBeLessThan(0);
      expect(x.bank * Math.sin(rel)).toBeGreaterThan(0);
      expect(Math.hypot(x.pitch, x.bank)).toBeLessThan(10);
    }
    expect(Math.max(...calmTrace.filter((x) => x.mode === 'backtransition').map((x) => x.pitch))).toBeGreaterThan(8);
    for (const x of calmTrace.filter((x) => x.mode === 'spool')) expect(x.pitch).toBe(0);
  });
});
