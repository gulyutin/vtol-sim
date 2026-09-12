import { describe, expect, it } from 'vitest';
import { terrainWindChecks } from '../src/game/preflight';
import { AIRCRAFT } from '../src/sim/aircraft';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { fromLocal, toLocal } from '../src/sim/mission';
import { terrainWind, type TerrainWind } from '../src/sim/terrainWind';
import type { MissionPlan, Site, Terrain, Weather } from '../src/sim/types';

const site: Site = { lat: 45, lon: 40, elevationM: 200 };
const at = (east: number, north: number, altitudeM: number) => ({ ...fromLocal(site, east, north), altitudeM });
const local = (f: (east: number, north: number) => number): Terrain => ({
  elevationM: (p) => {
    const { east, north } = toLocal(site, p);
    return f(east, north);
  },
});

describe('ветер у рельефа в полёте', () => {
  /** Гряда 400 м вдоль меридиана, гребень — east = 0; ветер 8 м/с с запада. */
  const ridge = local((e) => 200 + 400 * Math.exp(-(e * e) / (2 * 1000 ** 2)));
  const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 8, fromDeg: 270 } };
  const area = { east0: -6000, north0: -4000, east1: 6000, north1: 14_000 };
  const controls: Controls = { iasMs: 22, heightAglM: 120, courseDeg: 0, target: null };
  /** На север вдоль гряды на 120 м над землёй в east от гребня; энергия на участке 3…8 км. */
  const alongRidge = (east: number, terrain: Terrain, w: Weather, tw?: TerrainWind) => {
    const g = terrain.elevationM(fromLocal(site, east, 0));
    const plan: MissionPlan = {
      takeoff: { ...fromLocal(site, east, 0), elevationM: g },
      landing: { ...fromLocal(site, east, 11_000), elevationM: g },
      waypoints: [at(east, 1500, g + 120), at(east, 9500, g + 120)],
      iasMs: 22,
      payload: null,
    };
    // НСУ над гребнем — связь по обе стороны гряды.
    const f = new LiveFlight({ plan, terrain, weather: w, origin: site, terrainWind: tw, seed: 3, gcs: { ...site, elevationM: 620 } });
    f.command('arm');
    f.command('takeoff');
    let e0 = NaN;
    let up = 0;
    let n = 0;
    let gust = 0;
    while (f.state.north < 8000 && f.state.mode !== 'crashed' && f.state.t < 3600) {
      f.step(0.5, controls);
      if (f.state.mode !== 'auto' || f.state.north < 3000) continue;
      if (Number.isNaN(e0)) e0 = f.state.energyWh;
      up += f.upflowMs;
      n++;
      gust = Math.max(gust, f.state.gustMs);
    }
    return { f, energyWh: f.state.energyWh - e0, upflowMs: up / n, gustMs: gust };
  };

  it('над ровным местом с полем — ровно тот же полёт, что без него', () => {
    const flat = local(() => 200);
    const w = { ...weather, turbulenceMs: 1 };
    const tw = terrainWind(flat, site, w, { area });
    const a = alongRidge(0, flat, w);
    const b = alongRidge(0, flat, w, tw);
    expect(b.f.state).toEqual(a.f.state);
  });

  it('предполётная: площадка посадки за грядой — предупреждение, на ровном месте проверки нет', () => {
    const tw = terrainWind(ridge, site, weather, { area });
    const plan = (east: number): MissionPlan => ({
      takeoff: { ...fromLocal(site, -5000, 0), elevationM: 200 },
      landing: { ...fromLocal(site, east, 0), elevationM: ridge.elevationM(fromLocal(site, east, 0)) },
      waypoints: [],
      iasMs: 22,
      payload: null,
    });
    const lee = terrainWindChecks([plan(1500)], tw);
    expect(lee).toHaveLength(2);
    expect(lee[0]!.ok).toBe(true);
    expect(lee[1]).toMatchObject({ ok: false, level: 'warn' });
    expect(lee[1]!.text).toMatch(/^Ветер у площадки посадки: подветренная сторона хребта .*нисходящие потоки до/);
    // Туда и обратно с одной площадки — одна строка на площадку.
    const both = terrainWindChecks([plan(1500), { ...plan(1500), takeoff: plan(1500).landing, landing: plan(1500).takeoff }], tw);
    expect(both.map((c) => c.text.split(':')[0])).toEqual(['Ветер у площадки взлёта и посадки', 'Ветер у площадки посадки и взлёта']);
    expect(terrainWindChecks([plan(1500)], terrainWind(local(() => 200), site, weather, { area }))).toEqual([]);
  });

  it('на подветренной стороне нисходящий поток и роторы: расход больше, чем на наветренной', () => {
    const tw = terrainWind(ridge, site, weather, { area });
    const windward = alongRidge(-1000, ridge, weather, tw);
    const lee = alongRidge(1000, ridge, weather, tw);
    expect(windward.f.state.mode).toBe('auto');
    expect(lee.f.state.mode).toBe('auto');
    expect(windward.upflowMs).toBeGreaterThan(0.8);
    expect(lee.upflowMs).toBeLessThan(-1);
    expect(lee.energyWh).toBeGreaterThan(1.2 * windward.energyWh);
    // Турбулентности в погоде нет — болтанка только от роторов за грядой.
    expect(lee.gustMs).toBeGreaterThan(0.5);
    expect(windward.gustMs).toBe(0);
  });
});

describe('ВОЗВРАТ над рельефом', () => {
  // Хребет вдоль меридиана в 6 км к востоку от дома: гребень 700 м, склоны по 600 м (~40°).
  const ridge = local((e) => 200 + 500 * Math.max(0, 1 - Math.abs(e - 6000) / 600));
  const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 3, fromDeg: 270 } };
  // Через хребет с запасом, за ним — снижение и полёт низко обратно к хребту.
  const plan: MissionPlan = {
    takeoff: site,
    landing: { ...fromLocal(site, 12_000, 3000), elevationM: 200 },
    waypoints: [at(2500, 2500, 560), at(5000, 0, 800), at(8000, 0, 800), at(12_000, 0, 330), at(9500, 3000, 330)],
    iasMs: 22,
    payload: null,
  };
  const controls: Controls = { iasMs: 22, heightAglM: 150, courseDeg: 0, target: null };

  it('связь пропала низко за хребтом: борт набирает высоту, переходит хребет и садится дома', () => {
    // НСУ на гребне — связь есть везде, пропадает только по отказу.
    const f = new LiveFlight({ plan, terrain: ridge, weather, home: site, gcs: { ...fromLocal(site, 6000, 0), elevationM: 700 } });
    f.command('arm');
    f.command('takeoff');
    let injected = false;
    let minRtlAgl = Infinity;
    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 3 * 3600) {
      f.step(0.5, controls);
      const s = f.state;
      // Последний участок: низко, в 3–4 км за хребтом.
      if (!injected && s.mode === 'auto' && s.wp === 5 && s.east < 10_500 && s.aglM < 200) {
        f.inject('link');
        injected = true;
      }
      if (s.mode === 'rtl') minRtlAgl = Math.min(minRtlAgl, s.aglM);
    }
    expect(injected).toBe(true);
    expect(f.state.reason).toBeNull();
    expect(f.state.mode).toBe('landed');
    expect(Math.hypot(f.state.east - f.home.east, f.state.north - f.home.north)).toBeLessThan(20);
    expect(minRtlAgl).toBeGreaterThanOrEqual(AIRCRAFT.minClearanceM);
    expect(f.events.some((e) => /ВОЗВРАТ: набор высоты/.test(e.text))).toBe(true);
  });

  it('ВОЗВРАТ сразу после разгона низко на склоне, дом — за гребнем: круг набора под уклон, не в склон', () => {
    // Гряда 400 м, взлёт на наветренном склоне (уклон ~24 %), ветер 8 м/с в склон, дом за гребнем.
    const hill = local((e) => 200 + 400 * Math.exp(-(e * e) / (2 * 1000 ** 2)));
    const w: Weather = { groundTemperatureC: 15, wind: { speedMs: 8, fromDeg: 270 } };
    const g = hill.elevationM(fromLocal(site, -1000, 0));
    const home: Site = { ...fromLocal(site, 5000, 0), elevationM: 200 };
    const p: MissionPlan = {
      takeoff: { ...fromLocal(site, -1000, 0), elevationM: g },
      landing: home,
      waypoints: [at(-1000, 2000, g + 120), at(-1000, 6000, g + 120)],
      iasMs: 22,
      payload: null,
    };
    const f = new LiveFlight({ plan: p, terrain: hill, weather: w, origin: site, home, gcs: { ...site, elevationM: 620 } });
    f.command('arm');
    f.command('takeoff');
    while (f.state.mode !== 'auto' && f.state.t < 600) f.step(0.5, controls);
    expect(f.command('rtl')).toBeNull();
    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 3600) f.step(0.5, controls);
    expect(f.state.reason).toBeNull();
    expect(f.state.mode).toBe('landed');
    expect(Math.hypot(f.state.east - f.home.east, f.state.north - f.home.north)).toBeLessThan(20);
    expect(f.events.some((e) => /ВОЗВРАТ: набор высоты/.test(e.text))).toBe(true);
  });
});
