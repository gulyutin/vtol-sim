import { describe, expect, it } from 'vitest';
import { toLocal } from '../src/sim/mission';
import { flatTerrain, GridTerrain, mercatorPixel } from '../src/sim/terrain';
import { TerrainRelief, TerrainWind, terrainWind, type WindArea } from '../src/sim/terrainWind';
import { Turbulence } from '../src/sim/turbulence';
import type { Site, Terrain, Weather } from '../src/sim/types';
import { windAt } from '../src/sim/wind';

const RAD = Math.PI / 180;
const site: Site = { lat: 45, lon: 40, elevationM: 800 };
const area: WindArea = { east0: -8000, north0: -8000, east1: 8000, north1: 8000 };
/** Ветер 8 м/с с запада — поперёк гряды вдоль меридиана. */
const west: Weather = { groundTemperatureC: 15, wind: { speedMs: 8, fromDeg: 270 }, turbulenceMs: 1 };

const local = (f: (east: number, north: number) => number): Terrain => ({
  elevationM: (p) => {
    const { east, north } = toLocal(site, p);
    return site.elevationM + f(east, north);
  },
});
/** Гряда высотой 400 м вдоль меридиана, σ = 1 км; гребень — east = 0. */
const ridge = local((e) => 400 * Math.exp(-(e * e) / (2 * 1000 ** 2)));
/** Та же гряда с седловиной глубиной 200 м у north = 0. */
const saddle = local((e, n) => 400 * Math.exp(-(e * e) / (2 * 1000 ** 2)) * (1 - 0.5 * Math.exp(-(n * n) / (2 * 1000 ** 2))));
/** Долина вдоль меридиана: борта поднимаются на 300 м за ~1.5 км. */
const valley = local((e) => 300 * (1 - Math.exp(-((e / 1500) ** 2))));
/** Склон 20° к югу от north = 0 до 6 км, дальше плато; южнее — ровно. */
const southSlope = local((_, n) => Math.tan(20 * RAD) * Math.min(6000, Math.max(0, n)));

const vec = (w: { speedMs: number; fromDeg: number }) => ({ e: w.speedMs * Math.sin((w.fromDeg + 180) * RAD), n: w.speedMs * Math.cos((w.fromDeg + 180) * RAD) });
const speed = (w: { eastMs: number; northMs: number }) => Math.hypot(w.eastMs, w.northMs);
/** Куда дует, ° от севера. */
const toDeg = (w: { eastMs: number; northMs: number }) => (Math.atan2(w.eastMs, w.northMs) / RAD + 360) % 360;
/** Угол между направлениями по модулю 180° (ось долины без знака). */
const axisDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 180) + 180) % 180);
  return Math.min(d, 180 - d);
};

describe('ветер у рельефа', () => {
  it('над ровным местом ничего не меняет — ровно фоновый ветер', () => {
    const w: Weather = { ...west, windProfile: { referenceHeightM: 10, shearExponent: 0.2 }, cloudCover: 0 };
    const tw = terrainWind(flatTerrain(300), site, w, { area, sun: { elevationDeg: 50, azimuthDeg: 180 } });
    expect(tw.active).toBe(false);
    for (const [e, n, agl, t] of [
      [0, 0, 0, 0],
      [1234, -567, 35, 100],
      [-7000, 7000, 400, 5000],
      [50_000, 0, 80, 1],
    ] as const) {
      const v = vec(windAt(w, agl));
      expect(tw.localWind(e, n, agl, t)).toEqual({ eastMs: v.e, northMs: v.n, upMs: 0, turbulenceScale: 1, turbulenceAddMs: 0 });
    }
    // И пульсации с таким полем — те же, что без рельефа.
    const plain = new Turbulence(3, w);
    const withField = new Turbulence(3, w, undefined, undefined, undefined, tw);
    for (const t of [0, 17.5, 300]) expect(withField.sample(t, 100, -200, 40)).toEqual(plain.sample(t, 100, -200, 40));
  });

  describe('гряда поперёк ветра', () => {
    const tw = terrainWind(ridge, site, west, { area });
    const at = (e: number, agl: number) => tw.windFieldSample(e, 0, agl, 0);

    it('на наветренном склоне — восходящий поток', () => {
      expect(at(-1000, 50).upMs).toBeGreaterThan(0.8);
      expect(at(-1000, 50).lee).toBe(0);
    });

    it('на подветренном — нисходящий поток, болтанка сильнее, ветер слабее', () => {
      const s = at(1000, 50);
      expect(s.upMs).toBeLessThan(-1);
      expect(s.lee).toBeGreaterThan(0.8);
      expect(s.turbulenceScale).toBeGreaterThan(2);
      expect(s.turbulenceAddMs).toBeGreaterThan(0.5);
      expect(s.speedFactor).toBeLessThan(0.8);
      // Над дном за грядой, в ~7 её высотах — ещё тень.
      const far = at(3000, 50);
      expect(far.upMs).toBeLessThan(-0.3);
      expect(far.turbulenceScale).toBeGreaterThan(1.5);
      // Дальше ~10 высот тени нет.
      const gone = at(6500, 50);
      expect(Math.abs(gone.upMs)).toBeLessThan(0.1);
      expect(gone.turbulenceScale).toBeLessThan(1.05);
    });

    it('подножие одиночной гряды — не долина: ветер не поворачивает', () => {
      for (const e of [-2500, -2000, 2000, 2500]) {
        const s = at(e, 20);
        expect(s.valley).toBeLessThan(0.05);
        expect(Math.abs(s.northMs)).toBeLessThan(0.1);
        expect(s.speedFactor).toBeGreaterThan(0.35);
      }
    });

    it('высоко над гребнем тени нет', () => {
      const s = at(1000, 900);
      expect(s.lee).toBe(0);
      expect(s.turbulenceScale).toBeLessThan(1.1);
      expect(Math.abs(s.upMs)).toBeLessThan(0.5);
    });

    it('над гребнем ветер сильнее', () => {
      expect(at(0, 30).speedFactor).toBeGreaterThan(1.2);
      expect(at(0, 30).speedFactor).toBeGreaterThan(at(-7000, 30).speedFactor + 0.2);
      // С высотой усиление слабеет.
      expect(at(0, 1500).speedFactor).toBeLessThan(at(0, 30).speedFactor);
    });

    it('площадка за грядой — опасна, в поле перед ней — нет', () => {
      const lee = tw.windHazardAt(1500, 0);
      expect(lee.level).toBeGreaterThan(0.5);
      expect(lee.sinkMs).toBeGreaterThan(1);
      expect(lee.text).toMatch(/^Подветренная сторона хребта/);
      expect(lee.text).toMatch(/нисходящие потоки до/);
      const open = tw.windHazardAt(-6500, 0);
      expect(open.level).toBeLessThan(0.15);
      expect(open.text).toBe('Местных эффектов рельефа не ожидается');
    });

    it('пульсации: роторы за грядой есть и без турбулентности в погоде', () => {
      const calm = { ...west, turbulenceMs: 0 };
      const f = new TerrainWind(tw.relief, calm);
      const tb = new Turbulence(5, calm, undefined, undefined, undefined, f);
      expect(tb.active).toBe(true);
      const rms = (e: number) => Math.sqrt(Array.from({ length: 2000 }, (_, i) => tb.sample(i * 0.5, e, 0, 50)).reduce((s, g) => s + g.e * g.e + g.n * g.n, 0) / 2000);
      expect(rms(1500)).toBeGreaterThan(0.5);
      expect(rms(-6500)).toBe(0);
    });
  });

  it('в седловине ветер сильнее', () => {
    const tw = terrainWind(saddle, site, west, { area });
    const s = tw.windFieldSample(0, 0, 30, 0);
    expect(s.gap).toBeGreaterThan(0.05);
    expect(s.speedFactor).toBeGreaterThan(1.2);
    expect(tw.windHazardAt(0, 0).text).toMatch(/^Седловина: ветер у земли сильнее/);
  });

  it('в долине у земли ветер поворачивает вдоль её оси, с высотой — к фоновому', () => {
    const w: Weather = { ...west, wind: { speedMs: 6, fromDeg: 240 } };
    const tw = terrainWind(valley, site, w, { area });
    const low = tw.windFieldSample(0, 0, 10, 0);
    expect(low.valley).toBeGreaterThan(0.7);
    expect(axisDiff(low.valleyAxisDeg, 0)).toBeLessThan(5);
    // Фоновый — под 60° к оси; у дна — почти вдоль неё.
    const bg = vec(w.wind);
    expect(axisDiff(toDeg({ eastMs: bg.e, northMs: bg.n }), 0)).toBeCloseTo(60, 0);
    expect(axisDiff(toDeg(low), 0)).toBeLessThan(15);
    const high = tw.windFieldSample(0, 0, 1500, 0);
    expect(axisDiff(toDeg(high), 60)).toBeLessThan(3);
    expect(tw.windHazardAt(0, 0).text).toMatch(/долина: у земли ветер вдоль долины/);
  });

  describe('Солнце', () => {
    const calm: Weather = { groundTemperatureC: 20, wind: { speedMs: 2, fromDeg: 90 }, turbulenceMs: 0.5, cloudCover: 0 };
    const noon = { elevationDeg: 45, azimuthDeg: 180 };
    const night = { elevationDeg: -10, azimuthDeg: 0 };
    const relief = TerrainRelief.build(southSlope, site, { area });
    /** Вертикальный поток по сетке точек на склоне. */
    const ups = (tw: TerrainWind, agl: number, t = 0, shiftE = 0) => {
      const out: number[] = [];
      for (let e = -4000; e <= 4000; e += 100) for (let n = 1000; n <= 5000; n += 100) out.push(tw.localWind(e + shiftE, n, agl, t).upMs);
      return out;
    };

    it('днём над склоном к Солнцу — пятна термиков, над ровным местом — нет', () => {
      const tw = new TerrainWind(relief, calm, { sun: noon, seed: 4 });
      const u = ups(tw, 200);
      expect(Math.max(...u)).toBeGreaterThan(1.5);
      const share = u.filter((x) => x > 0.5).length / u.length;
      expect(share).toBeGreaterThan(0.005);
      expect(share).toBeLessThan(0.3);
      // Между пятнами — слабое опускание, не сильнее термиков.
      expect(Math.min(...u)).toBeGreaterThan(-1);
      for (let e = -4000; e <= 4000; e += 250) expect(tw.localWind(e, -5000, 200, 0).upMs).toBe(0);
      expect(tw.windHazardAt(0, 3000).text).toMatch(/термики до/);
    });

    it('пятна сносит ветром', () => {
      const tw = new TerrainWind(relief, calm, { sun: noon, seed: 4 });
      const dt = 60;
      const drift = -2 * dt; // ветер с востока — на запад
      const a = ups(tw, 200, 1000);
      const same = ups(tw, 200, 1000 + dt);
      const moved = ups(tw, 200, 1000 + dt, drift);
      const diff = (x: number[], y: number[]) => x.reduce((s, v, i) => s + Math.abs(v - y[i]!), 0);
      expect(diff(a, moved)).toBeLessThan(0.5 * diff(a, same));
    });

    it('ночью термиков нет, по склону стекает ветер', () => {
      const tw = new TerrainWind(relief, calm, { sun: night, seed: 4 });
      expect(Math.max(...ups(tw, 200))).toBeLessThanOrEqual(0);
      const s = tw.windFieldSample(0, 3000, 20, 0);
      expect(s.katabaticMs).toBeGreaterThan(0.5);
      // Фоновый дует на запад; сток — вниз по склону, на юг.
      expect(s.northMs).toBeLessThan(-0.5);
      expect(s.upMs).toBeLessThan(0);
      expect(tw.windFieldSample(0, -5000, 20, 0).katabaticMs).toBe(0);
    });
  });

  it('детерминирован по seed и времени, не зависит от порядка опроса', () => {
    const sun = (t: number) => ({ elevationDeg: 40 + t / 600, azimuthDeg: 170 + t / 100 });
    const relief = TerrainRelief.build(southSlope, site, { area });
    const w: Weather = { ...west, wind: { speedMs: 3, fromDeg: 200 } };
    const a = new TerrainWind(relief, w, { sun, seed: 7 });
    const b = new TerrainWind(TerrainRelief.build(southSlope, site, { area }), w, { sun, seed: 7 });
    const c = new TerrainWind(relief, w, { sun, seed: 8 });
    b.localWind(10, 10, 10, 10);
    let differs = false;
    for (let k = 0; k < 400; k++) {
      const p = [((k * 733) % 8000) - 4000, 1000 + ((k * 421) % 4000), 50 + (k % 7) * 40, k * 13.7] as const;
      expect(a.localWind(...p)).toEqual(b.localWind(...p));
      if (a.localWind(...p).upMs !== c.localWind(...p).upMs) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('порциями — то же, что сразу', async () => {
    let calls = 0;
    const r = await TerrainRelief.buildAsync(ridge, site, { area }, () => calls++, 0, () => Promise.resolve());
    expect(calls).toBeGreaterThan(10);
    const a = new TerrainWind(r, west);
    const b = terrainWind(ridge, site, west, { area });
    expect(a.localWind(700, 300, 60, 0)).toEqual(b.localWind(700, 300, 60, 0));
  });

  it('быстро: предрасчёт области 30×40 км по сетке высот и вызов на шаге полёта', () => {
    // Сетка высот как у тайлов Terrarium (zoom 12): горы с перепадами до ~1.5 км.
    const zoom = 12;
    const c = mercatorPixel(site, zoom);
    const width = 1400;
    const height = 1800;
    const x0 = Math.floor(c.x - width / 2);
    const y0 = Math.floor(c.y - height / 2);
    const heights = new Float32Array(width * height);
    for (let j = 0; j < height; j++)
      for (let i = 0; i < width; i++)
        heights[j * width + i] = 1500 + 600 * Math.sin(i / 90) * Math.cos(j / 130) + 250 * Math.sin((i + 2 * j) / 37) + 80 * Math.cos((3 * i - j) / 11);
    const grid = new GridTerrain(heights, width, height, zoom, x0, y0);
    const t0 = Date.now();
    const relief = TerrainRelief.build(grid, site);
    const t1 = Date.now();
    const tw = new TerrainWind(relief, { ...west, windProfile: { referenceHeightM: 10, shearExponent: 0.15 } }, { sun: (t) => ({ elevationDeg: 35, azimuthDeg: 150 + t / 240 }) });
    const t2 = Date.now();
    const n = 100_000;
    let sum = 0;
    for (let k = 0; k < n; k++) sum += tw.localWind(-12_000 + (k % 1000) * 24, -16_000 + k * 0.32, 20 + (k % 300), k * 0.05).upMs;
    const t3 = Date.now();
    expect(Number.isFinite(sum)).toBe(true);
    const callUs = ((t3 - t2) * 1000) / n;
    // В tsconfig нет типов среды — console берём так.
    (globalThis as unknown as { console: { log(s: string): void } }).console.log(`рельеф ${relief.nx}×${relief.ny} узлов: ${t1 - t0} мс; поправки для ветра: ${t2 - t1} мс; вызов: ${callUs.toFixed(2)} мкс`);
    expect(t1 - t0).toBeLessThan(3000);
    expect(t2 - t1).toBeLessThan(2000);
    expect(callUs).toBeLessThan(50);
  });
});
