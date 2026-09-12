import { describe, expect, it } from 'vitest';
import { linkCheck } from '../src/game/preflight';
import { REGION_PRESETS } from '../src/game/regions';
import { buildScenarios, withRelays } from '../src/game/scenarios';
import { LINK_TIMEOUT_S } from '../src/sim/failures';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { fromLocal } from '../src/sim/mission';
import {
  bestLink,
  coverageGrid,
  coverageSteps,
  JAM_FULL_DB,
  LINK_LOSS_S,
  LinkMonitor,
  LinkNetwork,
  linkAlongPath,
  linkBudget,
  linkJamDb,
  minLinkAltitudeM,
  packetLoss,
  RADIO,
  RadioLink,
  type Relay,
  type Station,
} from '../src/sim/radio';
import { flatTerrain, GridTerrain, mercatorPixel } from '../src/sim/terrain';
import type { MissionPlan, Terrain, Weather } from '../src/sim/types';

/*
 * Радиолиния НСУ ↔ борт: дальность на ровном, радиотень за хребтом, ретранслятор,
 * гистерезис состояния связи, вдоль маршрута и сетка покрытия.
 */

const GCS0 = { lat: 55, lon: 37 };
const gcs: Station = { ...GCS0, altitudeM: 203 };
/** Условная дальность для синтетического рельефа — не зависит от профиля. */
const R50 = { rangeM: 50_000 };
/** Точка southM к югу и eastM к востоку от НСУ на высоте altitudeM над морем. */
const at = (southM: number, altitudeM: number, eastM = 0): Station => ({ ...fromLocal(GCS0, eastM, -southM), altitudeM });
const southOf = (p: { lat: number }) => ((GCS0.lat - p.lat) * Math.PI * 6371000) / 180;
/** Ровно 200 м, в 10 км к югу — хребет с запада на восток: гребень 800 м, склоны по 1 км. */
const ridge: Terrain = { elevationM: (p) => 200 + 600 * Math.max(0, 1 - Math.abs(southOf(p) - 10_000) / 1000) };
const flat = flatTerrain(200);

describe('линия НСУ ↔ борт', () => {
  it('ровная местность, чистая зона Френеля: предел — ровно дальность из профиля', () => {
    const R = RADIO.rangeM;
    const m = (d: number) => linkBudget(flat, gcs, at(d, 2200)).marginDb;
    expect(Math.abs(m(R))).toBeLessThan(0.3);
    expect(m(0.95 * R)).toBeGreaterThan(0.3);
    expect(m(1.05 * R)).toBeLessThan(-0.3);
    expect(linkBudget(flat, gcs, at(R, 2200)).los).toBe(true);
    expect(linkBudget(flat, gcs, at(R / 2, 2200)).diffractionDb).toBe(0);
    // Рядом с НСУ сигнал полный.
    expect(linkBudget(flat, gcs, at(1000, 500)).quality).toBe(1);
  });

  it('у самой земли за радиогоризонтом связи нет, на малой высоте зона Френеля у мачты съедает часть дальности', () => {
    const low = linkBudget(flat, gcs, at(40_000, 250), { radio: R50 });
    expect(low.los).toBe(false);
    expect(low.marginDb).toBeLessThan(0);
    const d = 0.9 * R50.rangeM;
    expect(linkBudget(flat, gcs, at(d, 350), { radio: R50 }).marginDb).toBeLessThan(linkBudget(flat, gcs, at(d, 2200), { radio: R50 }).marginDb - 1);
  });

  it('хребет: ниже гребня связи нет, с набором высоты появляется', () => {
    // Луч от антенны НСУ через гребень приходит в 20 км на высоту ~1410 м.
    const below = linkBudget(ridge, gcs, at(20_000, 1000), { radio: R50 });
    expect(below.los).toBe(false);
    expect(below.marginDb).toBeLessThan(-10);
    expect(below.obstruction!.distanceM).toBeGreaterThan(9800);
    expect(below.obstruction!.distanceM).toBeLessThan(10_200);
    expect(below.obstruction!.heightM).toBeGreaterThan(200);
    const above = linkBudget(ridge, gcs, at(20_000, 1700), { radio: R50 });
    expect(above.los).toBe(true);
    expect(above.marginDb).toBeGreaterThan(0);
    // Связь появляется чуть выше касания луча — там гребень закрывает меньше половины зоны Френеля.
    const min = minLinkAltitudeM(new LinkNetwork(ridge, gcs, [], R50), at(20_000, 0))!;
    expect(min).toBeGreaterThan(1380);
    expect(min).toBeLessThan(1500);
  });

  it('в полёте: за хребтом связь теряется через пару секунд, с набором высоты возвращается', () => {
    const link = new RadioLink(ridge, gcs, [], R50);
    const fly = (s: number, p: Station) => {
      for (let t = 0; t < s - 1e-9; t += 0.1) link.update(0.1, p);
      return link.status;
    };
    expect(fly(3, at(20_000, 1700))).not.toBe('lost');
    expect(fly(LINK_LOSS_S - 0.3, at(20_000, 1000))).toBe('poor');
    expect(link.monitor.telemetryHz).toBeLessThan(5);
    expect(fly(0.5, at(20_000, 1000))).toBe('lost');
    expect(link.monitor.telemetryHz).toBeLessThan(2);
    expect(fly(0.5, at(20_000, 1700))).toBe('lost');
    expect(fly(1, at(20_000, 1700))).not.toBe('lost');
    // Расчёт по рельефу — не каждый шаг.
    expect(link.periodS).toBeGreaterThanOrEqual(0.2);
  });

  it('ретранслятор на гребне восстанавливает связь, в поле перед хребтом — нет', () => {
    const target = at(20_000, 1000);
    const onRidge: Relay = { kind: 'ground', ...fromLocal(GCS0, 0, -10_000), antennaM: 10 };
    const r = bestLink(ridge, gcs, target, { relays: [onRidge], radio: R50 });
    expect(r.marginDb).toBeGreaterThan(0);
    expect(r.via).toEqual([0]);
    expect(r.hops).toHaveLength(2);
    expect(r.marginDb).toBe(Math.min(...r.hops.map((h) => h.marginDb)));

    const inField: Relay = { kind: 'ground', ...fromLocal(GCS0, 0, -5000), antennaM: 10 };
    expect(bestLink(ridge, gcs, target, { relays: [inField], radio: R50 }).marginDb).toBeLessThan(0);

    // Аппарат-ретранслятор над хребтом; из двух ретрансляторов выбирается лучший.
    const air: Relay = { kind: 'air', ...fromLocal(GCS0, 2000, -10_000), altitudeM: 1500 };
    const both = bestLink(ridge, gcs, target, { relays: [inField, air], radio: R50 });
    expect(both.marginDb).toBeGreaterThan(0);
    expect(both.via).toEqual([1]);

    // Вблизи НСУ прямая линия лучше цепочки.
    expect(bestLink(ridge, gcs, at(3000, 500), { relays: [onRidge], radio: R50 }).via).toEqual([]);
  });

  it('подавление связи помехой', () => {
    const target = at(10_000, 700);
    const clean = linkBudget(flat, gcs, target, { radio: R50 }).marginDb;
    expect(linkBudget(flat, gcs, target, { radio: R50, jamDb: linkJamDb(0.5) }).marginDb).toBeCloseTo(clean - JAM_FULL_DB / 2, 6);
    // Помеха у НСУ глушит телеметрию: действует на звенья от НСУ, но не на ретранслятор → борт.
    const relay: Relay = { kind: 'air', ...fromLocal(GCS0, 3000, -5000), altitudeM: 700 };
    expect(bestLink(flat, gcs, target, { radio: R50, relays: [relay] }).via).toEqual([]);
    const jammed = new LinkNetwork(flat, gcs, [], R50, linkJamDb(1)).link(target);
    expect(jammed.marginDb).toBeLessThan(0);
    expect(linkBudget(flat, gcs, target, { radio: R50, jamDb: linkJamDb(1) }).marginDb).toBeLessThan(0);
    expect(linkJamDb(0)).toBe(0);
  });
});

describe('состояние связи для оператора', () => {
  it('потери пакетов по запасу', () => {
    expect(packetLoss(20)).toBeLessThan(0.001);
    expect(packetLoss(6)).toBeLessThan(0.05);
    expect(packetLoss(0)).toBeGreaterThan(0.8);
  });

  it('гистерезис: на границе не мигает, короткий провал — не потеря связи', () => {
    const mon = new LinkMonitor();
    const run = (s: number, m: number | ((t: number) => number)) => {
      const seen = new Set<string>();
      for (let t = 0; t < s - 1e-9; t += 0.1) seen.add(mon.update(0.1, typeof m === 'number' ? m : m(t)));
      return seen;
    };
    expect(run(2, 20)).toEqual(new Set(['good']));
    expect(mon.telemetryHz).toBeGreaterThan(9.9);
    // Запас гуляет ±0,5 дБ у границы «хорошая / плохая» — состояние одно.
    expect(run(5, (t) => 6 + 0.5 * Math.sin(7 * t))).toEqual(new Set(['good']));
    expect(run(1, 4)).toEqual(new Set(['poor']));
    expect(run(5, (t) => 6 + 0.5 * Math.sin(7 * t))).toEqual(new Set(['poor']));
    // Провал ниже нуля на 1,5 с — связь плохая, но не потеряна.
    expect(run(1.5, -3)).toEqual(new Set(['poor']));
    expect(run(0.5, 3)).toEqual(new Set(['poor']));
    // Дольше LINK_LOSS_S — потеряна; запас +1 дБ её не возвращает, +3 дБ дольше секунды — возвращает.
    expect(run(LINK_LOSS_S + 0.2, -3).has('lost')).toBe(true);
    expect(mon.lost).toBe(true);
    expect(run(3, 1)).toEqual(new Set(['lost']));
    expect(run(0.8, 3)).toEqual(new Set(['lost']));
    expect(run(0.4, 3).has('poor')).toBe(true);
    // Мигание запаса вокруг нуля (то −1, то +1 дБ) не накапливает время до потери.
    const mon2 = new LinkMonitor();
    for (let t = 0; t < 10; t += 0.1) mon2.update(0.1, Math.round(t * 10) % 20 < 15 ? -1 : 1);
    expect(mon2.lost).toBe(false);
  });
});

describe('вдоль маршрута и покрытие', () => {
  it('маршрут за хребет на постоянной высоте: где связи нет и с какой высоты она есть', () => {
    const path = [at(0, 1000), at(25_000, 1000)];
    const r = linkAlongPath(ridge, gcs, path, { radio: R50, stepM: 250, minAltitude: true });
    expect(r.lengthM).toBeCloseTo(25_000, -1);
    // Луч через гребень поднимается выше 1000 м дальше ~13 км.
    expect(r.lostM).toBeGreaterThan(10_000);
    expect(r.lostM).toBeLessThan(13_000);
    expect(r.points.filter((p) => p.alongM < 10_000).every((p) => p.marginDb > 0)).toBe(true);
    const last = r.points[r.points.length - 1]!;
    expect(last.marginDb).toBeLessThan(0);
    expect(last.minAltitudeM!).toBeGreaterThan(1500);
    expect(r.farthestM).toBeCloseTo(25_000, -1);
    // С ретранслятором на гребне связь по всему пути.
    const relayed = linkAlongPath(ridge, gcs, path, { radio: R50, relays: [{ kind: 'ground', ...fromLocal(GCS0, 0, -10_000), antennaM: 10 }] });
    expect(relayed.lostM).toBe(0);
  });

  it('сетка покрытия показывает тень за хребтом, ретранслятор её снимает', () => {
    const o = { origin: GCS0, e0: -15_000, n0: -30_000, e1: 15_000, n1: 10_000, heightAglM: 100, cellM: 250, radio: R50 };
    const t0 = Date.now();
    const cov = coverageGrid(ridge, gcs, o);
    const ms = Date.now() - t0;
    expect(cov.cols).toBe(120);
    expect(cov.rows).toBe(160);
    const cell = (c: typeof cov, east: number, north: number) => c.marginDb[Math.floor((north - c.n0) / c.cellM) * c.cols + Math.floor((east - c.e0) / c.cellM)]!;
    expect(cell(cov, 0, -5000)).toBeGreaterThan(0);
    expect(cell(cov, 5000, 5000)).toBeGreaterThan(0);
    expect(cell(cov, 0, -12_000)).toBeLessThan(0);
    expect(cell(cov, 10_000, -25_000)).toBeLessThan(0);
    // Сетка с упрощённым профилем близка к точному расчёту.
    const p = at(4875, 300, 125);
    expect(Math.abs(cell(cov, 0, -5000) - linkBudget(ridge, gcs, p, { radio: R50 }).marginDb)).toBeLessThan(1);

    const withRelay = coverageGrid(ridge, gcs, { ...o, relays: [{ kind: 'ground', ...fromLocal(GCS0, 0, -10_000), antennaM: 10 }] });
    expect(cell(withRelay, 0, -12_000)).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });

  it('сетка на горном рельефе считается быстро и по частям', () => {
    // Горный рельеф из синусоид в сетке высот того же вида, что тайлы: 12-й уровень, ~22 м.
    const zoom = 12;
    const nw = mercatorPixel({ lat: 55.2, lon: 36.7 }, zoom);
    const se = mercatorPixel({ lat: 54.7, lon: 37.3 }, zoom);
    const x0 = Math.floor(nw.x);
    const y0 = Math.floor(nw.y);
    const w = Math.ceil(se.x) - x0;
    const hgt = Math.ceil(se.y) - y0;
    const heights = new Float32Array(w * hgt);
    for (let j = 0; j < hgt; j++) {
      for (let i = 0; i < w; i++) heights[j * w + i] = 1500 + 600 * Math.sin(i / 37) * Math.cos(j / 53) + 250 * Math.sin((i + 2 * j) / 11);
    }
    const mountains = new GridTerrain(heights, w, hgt, zoom, x0, y0);
    const station = { ...GCS0, altitudeM: mountains.elevationM(GCS0) + 3 };

    let t0 = Date.now();
    const n = 200;
    for (let k = 0; k < n; k++) linkBudget(mountains, station, at(30_000, 3000, k * 50), { radio: R50 });
    const perLinkMs = (Date.now() - t0) / n;
    expect(perLinkMs).toBeLessThan(5);

    t0 = Date.now();
    const steps = coverageSteps(mountains, station, { origin: GCS0, e0: -15_000, n0: -20_000, e1: 15_000, n1: 20_000, heightAglM: 150, radio: R50 });
    let chunks = 0;
    let longest = 0;
    let last = Date.now();
    for (let r = steps.next(); !r.done; r = steps.next()) {
      chunks++;
      longest = Math.max(longest, Date.now() - last);
      last = Date.now();
    }
    const gridMs = Date.now() - t0;
    expect(chunks).toBeGreaterThan(100);
    expect(gridMs).toBeLessThan(5000);
    // Порция — одна строка сетки: интерфейс успевает между ними.
    expect(longest).toBeLessThan(100);
  });
});

describe('связь в живом полёте и предполётная проверка', () => {
  const site = { ...GCS0, elevationM: 200 };
  const weather: Weather = { groundTemperatureC: 15, wind: { speedMs: 0, fromDeg: 0 } };
  // На юг через хребет на 1000 м; луч через гребень выше 1000 м дальше ~13 км.
  const plan: MissionPlan = {
    takeoff: site,
    landing: { ...at(20_000, 0), elevationM: 200 },
    waypoints: [2000, 8000, 12_000, 18_000].map((s) => at(s, 1000)),
    iasMs: 21,
    payload: null,
  };
  const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 180, target: null };
  const onRidge: Relay = { kind: 'ground', ...fromLocal(GCS0, 0, -10_000), antennaM: 10 };
  const fly = (relays: Relay[] = []) => {
    const f = new LiveFlight({ plan, terrain: ridge, weather, relays, radio: R50, home: site });
    f.command('arm');
    f.command('takeoff');
    return f;
  };
  const run = (f: LiveFlight, until: (f: LiveFlight) => boolean, limitS: number, each?: (f: LiveFlight) => void) => {
    const t0 = f.state.t;
    while (!until(f) && f.state.t < t0 + limitS) {
      f.step(0.5, controls);
      each?.(f);
    }
  };

  it('за хребтом связь пропадает: телеметрия замирает, через таймаут — ВОЗВРАТ', () => {
    const f = fly();
    let poorSeen = false;
    run(f, (x) => x.state.linkLost, 3600, (x) => (poorSeen ||= x.state.link.status === 'poor'));
    expect(f.state.linkLost).toBe(true);
    expect(f.state.linkQuality).toBe(0);
    expect(f.state.link.cause).toBe('terrain');
    expect(f.state.link.los).toBe(false);
    expect(f.state.link.obstruction).not.toBeNull();
    expect(poorSeen).toBe(true);
    expect(f.events.map((e) => e.text)).toContain('Нет связи с НСУ: рельеф закрывает НСУ');
    const frozen = f.telemetry.t;
    f.step(5, controls);
    expect(f.telemetry.t).toBe(frozen);
    // Качество связи НСУ знает сама — в замершей телеметрии оно текущее.
    expect(f.telemetry.link).toBe(f.state.link);
    run(f, (x) => x.state.mode === 'rtl', LINK_TIMEOUT_S + 5);
    expect(f.state.mode).toBe('rtl');
  });

  it('ретранслятор на гребне: связь по всему полёту, через него', () => {
    const f = fly([onRidge]);
    expect(f.relays).toHaveLength(1);
    let lost = false;
    let via = false;
    run(f, (x) => x.state.mode === 'descent' || x.state.mode === 'landed', 3600, (x) => {
      lost ||= x.state.linkLost;
      via ||= x.state.link.via[0] === 0;
    });
    expect(lost).toBe(false);
    expect(via).toBe(true);
  });

  it('ретранслятор можно поставить в полёте — связь возвращается', () => {
    const f = fly();
    run(f, (x) => x.state.linkLost, 3600);
    f.setRelays([onRidge]);
    run(f, (x) => !x.state.linkLost, 10);
    expect(f.state.linkLost).toBe(false);
    expect(f.events[f.events.length - 1]!.text).toBe('Связь с НСУ восстановлена');
    expect(f.telemetry.t).toBe(f.state.t);
    expect(f.state.link.via).toEqual([0]);
  });

  it('предполётная проверка: где связи не будет, что будет и что делать', () => {
    const bad = linkCheck({ stages: [plan], terrain: ridge, gcs: site });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/^Нет связи с НСУ на .* \(рельеф закрывает НСУ\): .*ВОЗВРАТ.*; (связь там — с высоты \d[\d\s]* м над морем или через ретранслятор|нужен ретранслятор)$/);
    const good = linkCheck({ stages: [plan], terrain: ridge, gcs: site, relays: [onRidge] });
    expect(good.ok).toBe(true);
    expect(good.text).toMatch(/^Связь с НСУ по всему маршруту/);
  });
});

describe('ретрансляторы районов по умолчанию', () => {
  it('у горных районов они есть; задания их несут, брифинг называет одной фразой', () => {
    for (const id of ['elbrus', 'khibiny', 'baikal']) {
      const L = REGION_PRESETS.find((r) => r.id === id)!.location;
      expect(L.relays?.length).toBeGreaterThan(0);
      for (const sc of buildScenarios(L)) {
        expect(sc.relays).toEqual(L.relays);
        expect(sc.briefing.match(/Связь за рельефом держ/g)).toHaveLength(1);
      }
    }
    expect(withRelays('Задание.')).toBe('Задание.');
    const two: Relay[] = [
      { kind: 'ground', lat: 0, lon: 0, name: 'на гребне' },
      { kind: 'air', lat: 0, lon: 0, altitudeM: 1500, name: 'над перевалом' },
    ];
    expect(withRelays('Задание.', two)).toBe('Задание. Связь за рельефом держат ретрансляторы: мачта на гребне, аппарат-ретранслятор над перевалом.');
  });
});
