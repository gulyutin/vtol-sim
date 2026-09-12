import { describe, expect, it } from 'vitest';
import { fromLocal, toLocal } from '../src/sim/mission';
import { flatTerrain } from '../src/sim/terrain';
import { drydenScales, Turbulence } from '../src/sim/turbulence';
import type { Site, Terrain, Weather } from '../src/sim/types';

const site: Site = { lat: 55, lon: 37, elevationM: 200 };
const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 6, fromDeg: 270 }, turbulenceMs: 1.5 };

/** Ряд пульсаций в точке, летящей с путевой скоростью (ve, vn) на высоте agl. */
function series(tb: Turbulence, n: number, dt: number, agl: number, ve = 0, vn = 0, e0 = 0, n0 = 0) {
  const out: { e: number; n: number; u: number }[] = [];
  for (let i = 0; i < n; i++) out.push(tb.sample(i * dt, e0 + ve * i * dt, n0 + vn * i * dt, agl));
  return out;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const rms = (a: number[]) => Math.sqrt(mean(a.map((x) => x * x)));

/** Время, за которое автокорреляция падает до 1/e, с. */
function correlationTimeS(x: number[], dt: number): number {
  const m = mean(x);
  const y = x.map((v) => v - m);
  const r0 = mean(y.map((v) => v * v));
  for (let lag = 1; lag < y.length / 4; lag++) {
    let s = 0;
    for (let i = 0; i + lag < y.length; i++) s += y[i]! * y[i + lag]!;
    if (s / (y.length - lag) / r0 < 1 / Math.E) return lag * dt;
  }
  return Infinity;
}

describe('турбулентность', () => {
  it('детерминирована по seed и не зависит от порядка опроса', () => {
    const a = new Turbulence(7, weather);
    const b = new Turbulence(7, weather);
    const c = new Turbulence(8, weather);
    const p = [123.4, 500, -300, 80] as const;
    b.sample(10, 0, 0, 30);
    expect(a.sample(...p)).toEqual(b.sample(...p));
    expect(a.sample(...p)).not.toEqual(c.sample(...p));
  });

  it('без турбулентности в погоде — нули', () => {
    const tb = new Turbulence(1, { ...weather, turbulenceMs: undefined });
    expect(tb.active).toBe(false);
    expect(tb.sample(100, 50, 50, 100)).toEqual({ e: 0, n: 0, u: 0 });
  });

  it('среднее ноль, СКО горизонтальных на 10 м — заданное', () => {
    const tb = new Turbulence(3, weather);
    // Крейсер 20 м/с два часа — сотни масштабов вихрей.
    const s = series(tb, 36_000, 0.2, 10, 20, 0);
    for (const k of ['e', 'n', 'u'] as const) expect(Math.abs(mean(s.map((g) => g[k])))).toBeLessThan(0.15 * weather.turbulenceMs!);
    const horizontal = Math.sqrt((rms(s.map((g) => g.e)) ** 2 + rms(s.map((g) => g.n)) ** 2) / 2);
    expect(horizontal / weather.turbulenceMs!).toBeGreaterThan(0.85);
    expect(horizontal / weather.turbulenceMs!).toBeLessThan(1.15);
    // Вертикальные у земли слабее горизонтальных (Драйден).
    const sc = drydenScales(10);
    expect(rms(s.map((g) => g.u)) / horizontal).toBeGreaterThan(0.7 * (sc.vertical / sc.horizontal));
    expect(rms(s.map((g) => g.u)) / horizontal).toBeLessThan(1.3 * (sc.vertical / sc.horizontal));
  });

  it('с высотой горизонтальные пульсации слабее, вихри крупнее', () => {
    const low = drydenScales(10);
    const high = drydenScales(300);
    expect(high.horizontal).toBeLessThan(low.horizontal);
    expect(high.lengthHM).toBeGreaterThan(low.lengthHM);
    const tb = new Turbulence(4, weather);
    const s = series(tb, 20_000, 0.5, 300, 20, 0);
    const h = Math.sqrt((rms(s.map((g) => g.e)) ** 2 + rms(s.map((g) => g.n)) ** 2) / 2);
    expect(h / (weather.turbulenceMs! * high.horizontal)).toBeGreaterThan(0.8);
    expect(h / (weather.turbulenceMs! * high.horizontal)).toBeLessThan(1.2);
  });

  it('время корреляции правдоподобное: на висении — порядка L/U, в полёте — L/V', () => {
    const tb = new Turbulence(5, weather);
    const L = drydenScales(50).lengthHM;
    const hover = correlationTimeS(series(tb, 20_000, 0.5, 50).map((g) => g.e), 0.5);
    const cruise = correlationTimeS(series(tb, 20_000, 0.1, 50, 0, 20).map((g) => g.e), 0.1);
    expect(hover).toBeGreaterThan(0.3 * (L / 6));
    expect(hover).toBeLessThan(3 * (L / 6));
    expect(cruise).toBeGreaterThan(0.3 * (L / 20));
    expect(cruise).toBeLessThan(3 * (L / 20));
    expect(cruise).toBeLessThan(hover);
  });

  it('за грядой по ветру пульсации сильнее, чем перед ней', () => {
    // Гряда высотой 120 м в 600 м к западу от площадки; ветер западный.
    const ridgeEast = -600;
    const ridge: Terrain = {
      elevationM: (p) => {
        const { east } = toLocal(site, p);
        return site.elevationM + 120 * Math.exp(-(((east - ridgeEast) / 150) ** 2));
      },
    };
    const tb = new Turbulence(6, weather, ridge, site);
    const flat = new Turbulence(6, weather, flatTerrain(site.elevationM), site);
    // Точка в 400 м за гребнем, на 40 м над землёй; и такая же — далеко перед грядой.
    const lee = series(tb, 8000, 0.5, 40, 0, 0, ridgeEast + 400, 0);
    const windward = series(tb, 8000, 0.5, 40, 0, 0, ridgeEast - 2500, 0);
    const ref = series(flat, 8000, 0.5, 40, 0, 0, ridgeEast + 400, 0);
    const h = (s: typeof lee) => Math.hypot(rms(s.map((g) => g.e)), rms(s.map((g) => g.n)));
    expect(h(lee) / h(windward)).toBeGreaterThan(1.4);
    expect(h(windward) / h(ref)).toBeGreaterThan(0.6);
    expect(h(windward) / h(ref)).toBeLessThan(1.6);
    // Нисходящий поток за грядой.
    expect(mean(lee.map((g) => g.u))).toBeLessThan(-0.3);
    // Высоко над гребнем тени уже нет.
    const above = series(tb, 8000, 0.5, 600, 0, 0, ridgeEast + 400, 0);
    const aboveRef = series(flat, 8000, 0.5, 600, 0, 0, ridgeEast + 400, 0);
    expect(h(above) / h(aboveRef)).toBeLessThan(1.1);
    void fromLocal;
  });

  it('термики над склоном, повёрнутым к Солнцу', () => {
    // Севернее площадки — склон 20°, обращённый на юг, к Солнцу (юг, высота 40°); южнее — ровное место.
    const slope: Terrain = {
      elevationM: (p) => {
        const { north } = toLocal(site, p);
        return site.elevationM + Math.max(0, north) * Math.tan((20 * Math.PI) / 180);
      },
    };
    const tb = new Turbulence(9, weather, slope, site, { elevationDeg: 40, azimuthDeg: 180 });
    const onSlope = series(tb, 4000, 0.5, 150, 0, 0, 0, 500);
    const onFlat = series(tb, 4000, 0.5, 150, 0, 0, 0, -500);
    expect(mean(onSlope.map((g) => g.u))).toBeGreaterThan(0.3);
    expect(Math.abs(mean(onFlat.map((g) => g.u)))).toBeLessThan(0.25);
  });
});
