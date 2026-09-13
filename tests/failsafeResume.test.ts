import { describe, expect, it } from 'vitest';
import { Callouts } from '../src/game/callouts';
import { buildMission, forecastWeather, SCENARIOS } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import {
  AIR_START_ROTORS_S,
  EMERGENCY_COMMANDS,
  isRcCommand,
  LiveFlight,
  PUSHER_START_S,
  TUMBLE_LEVEL_S,
  type Controls,
  type Stick,
} from '../src/sim/flight';
import { flatTerrain } from '../src/sim/terrain';
import type { Weather } from '../src/sim/types';

/*
 * После «Фэйлсейфа» и остановки моторов в воздухе: запуск маршевого, аварийный АРМ в воздухе
 * и возврат в самолётный режим — с разгоном, с ближайшего участка маршрута, с пульта без связи.
 */

const sc = SCENARIOS.find((s) => s.kind === 'survey')!;
const terrain = flatTerrain(320);
const weather: Weather = { ...forecastWeather(sc, sc.defaults), wind: { speedMs: 5, fromDeg: 250 } };
const plan = buildMission(sc, sc.defaults, terrain, weather).stages[0]!;
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const over = (f: LiveFlight) => f.state.mode === 'landed' || f.state.mode === 'crashed';
const dist = (a: { east: number; north: number }, b: { east: number; north: number }) => Math.hypot(a.east - b.east, a.north - b.north);
const said = (f: LiveFlight, re: RegExp) => f.events.some((e) => re.test(e.text));

/** Взлёт и МАРШРУТ: крейсер выше 100 м над землёй. Пульт достаёт везде, если тест не сузит. */
function cruising(minT = 300): LiveFlight {
  const f = new LiveFlight({ plan, terrain, weather });
  f.rcRangeM = Infinity;
  f.command('arm');
  f.command('takeoff');
  while (!(f.state.mode === 'auto' && f.state.aglM > 100 && f.state.t > minT) && f.state.t < 3600) f.step(0.5, controls);
  expect(f.state.mode).toBe('auto');
  return f;
}

function run(f: LiveFlight, until: (f: LiveFlight) => boolean, limitS: number, c: Controls | ((f: LiveFlight) => Controls) = controls, dt = 0.1) {
  const t0 = f.state.t;
  while (!until(f) && f.state.t < t0 + limitS) f.step(dt, typeof c === 'function' ? c(f) : c);
}

/** Пилот самолёта: курс креном, вертикальная тангажом, скорость газом. */
function planeStick(f: LiveFlight, headingDeg: number, vzMs: number, iasMs: number): Stick {
  const s = f.state;
  const pitch = vzMs < 0 ? -vzMs / (2 * AIRCRAFT.planeDescentRateMaxMs) : -vzMs / AIRCRAFT.planeClimbRateMaxMs;
  return {
    roll: Math.max(-1, Math.min(1, wrap(headingDeg - s.headingDeg) / 40)),
    pitch: Math.max(-1, Math.min(1, pitch)),
    yaw: 0,
    throttle: Math.max(-1, Math.min(1, (iasMs - s.iasMs) / 3)),
  };
}

/** Точка пути i впереди по своему участку (как считает автопилот при продолжении маршрута). */
function ahead(f: LiveFlight, i: number): boolean {
  const a = f.path[i]!;
  const q = f.path[i - 1]!;
  const p = f.state.estimate;
  return (a.east - q.east) * (a.east - p.east) + (a.north - q.north) * (a.north - p.north) > 0;
}

/** В «Фэйлсейфе» коптером, ручки в центре, пока воздушная скорость не погаснет. */
function copterHover(f: LiveFlight) {
  expect(f.command('failsafe')).toBeNull();
  expect(f.command('copter')).toBeNull();
  expect(f.state.failsafePhase).toBe('copter');
  f.step(20, { ...controls, stick: null });
  expect(f.state.tasMs).toBeLessThan(1);
}

describe('команды для НСУ', () => {
  it('аварийное меню: имена, подписи, какие команды доходят с пульта', () => {
    expect(EMERGENCY_COMMANDS.map((c) => c.cmd)).toEqual(['pusherStart', 'armAir', 'auto']);
    expect(EMERGENCY_COMMANDS.map((c) => c.label)).toEqual(['ЗАПУСК МАРШЕВОГО', 'АРМ В ВОЗДУХЕ — аварийный запуск моторов', 'В САМОЛЁТНЫЙ РЕЖИМ — продолжить маршрут']);
    expect(isRcCommand('armAir')).toBe(true);
    expect(isRcCommand('auto')).toBe(true);
    expect(isRcCommand('pusherStart')).toBe(false);
    expect(isRcCommand('hold')).toBe(false);
  });

  it('вне своих случаев команды отказывают с причиной', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    expect(f.command('pusherStart')).toMatch(/самолётном режиме/);
    expect(f.command('armAir')).toMatch(/обычный АРМ/);
    const g = cruising();
    expect(g.state.pusherState).toBe('run');
    expect(g.command('pusherStart')).toMatch(/Маршевый работает/);
    expect(g.command('armAir')).toMatch(/Моторы работают/);
  });
});

describe('«Фэйлсейф» → запуск маршевого → самолётный режим', () => {
  it('из коптера: ЗАПУСК МАРШЕВОГО, затем МАРШРУТ — разгон, маршрут с того же участка, посадка в точке', () => {
    const f = cruising();
    const wp0 = f.state.wp;
    copterHover(f);
    expect(f.state.pusherState).toBe('off');
    expect(f.command('pusherStart')).toBeNull();
    expect(f.state.pusherState).toBe('starting');
    expect(f.command('pusherStart')).toMatch(/раскручивается/);
    f.step(PUSHER_START_S + 0.5, { ...controls, stick: null });
    expect(f.state.pusherState).toBe('run');
    expect(said(f, /^Маршевый запущен$/)).toBe(true);
    expect(f.state.mode).toBe('failsafe');

    expect(f.command('auto')).toBeNull();
    expect(f.state.mode).toBe('transition');
    // Маршевый уже раскручен — разгон сразу.
    f.step(2, controls);
    expect(f.state.iasMs).toBeGreaterThan(1);
    run(f, (x) => x.state.mode !== 'transition', 60);
    expect(f.state.mode).toBe('auto');
    expect(said(f, /продолжаю с ближайшего участка|^МАРШРУТ$/)).toBe(true);
    expect(f.state.wp).toBeGreaterThanOrEqual(wp0);
    expect(ahead(f, f.state.wp)).toBe(true);
    run(f, over, 3 * 3600, controls, 0.5);
    expect(f.state.mode).toBe('landed');
    expect(dist(f.state, f.landing)).toBeLessThan(15);
  });

  it('из коптера сразу МАРШРУТ: маршевый раскручивается в переходе, роторы держат высоту, потом разгон', () => {
    const f = cruising();
    copterHover(f);
    const up = f.state.up;
    const t0 = f.state.t;
    expect(f.command('auto')).toBeNull();
    expect(f.state.mode).toBe('transition');
    expect(f.state.pusherState).toBe('starting');
    let maxIas = 0;
    run(f, (x) => x.state.t > t0 + PUSHER_START_S - 0.3, 10, (x) => {
      maxIas = Math.max(maxIas, x.state.iasMs);
      return controls;
    });
    // Пока маршевый раскручивается — разгона нет, висение на роторах.
    expect(maxIas).toBeLessThan(1);
    expect(f.state.lift).toBeGreaterThan(0.95);
    expect(Math.abs(f.state.up - up)).toBeLessThan(3);
    run(f, (x) => x.state.mode !== 'transition', 60);
    expect(f.state.mode).toBe('auto');
    expect(f.state.t - t0).toBeGreaterThan(PUSHER_START_S + AIRCRAFT.vtol.transitionS - 0.5);
    expect(f.state.pusherState).toBe('run');
    f.step(30, controls);
    expect(f.state.mode).toBe('auto');
    expect(f.state.iasMs).toBeGreaterThan(AIRCRAFT.transitionLowIasMs);
  });

  it('из коптера ниже 20 м разгон запрещён', () => {
    const f = new LiveFlight({ plan, terrain, weather });
    f.rcRangeM = Infinity;
    f.command('arm');
    f.command('takeoff');
    while (!(f.state.mode === 'climb' && f.state.aglM > 12) && f.state.t < 120) f.step(0.1, controls);
    expect(f.command('failsafe')).toBeNull();
    expect(f.state.failsafePhase).toBe('copter');
    expect(f.command('auto')).toMatch(/не ниже 20 м/);
    expect(f.state.mode).toBe('failsafe');
  });

  it('самолётом: пилот увёл с маршрута — МАРШРУТ сразу, с ближайшего непройденного участка', () => {
    const f = cruising();
    const wp0 = f.state.wp;
    expect(f.command('failsafe')).toBeNull();
    expect(f.state.failsafePhase).toBe('plane');
    // Две минуты прямо тем же курсом — проходим точки маршрута стороной.
    const course = f.state.headingDeg;
    run(f, () => false, 120, (x) => ({ ...controls, stick: planeStick(x, course, 0, 21) }));
    expect(f.state.mode).toBe('failsafe');
    expect(f.command('auto')).toBeNull();
    expect(f.state.mode).toBe('auto');
    expect(said(f, /МАРШРУТ — продолжаю с ближайшего участка/)).toBe(true);
    // Точка, к которой идём, — впереди; предыдущая, если её пропустили, — уже позади.
    expect(ahead(f, f.state.wp)).toBe(true);
    if (f.state.wp > wp0) expect(ahead(f, f.state.wp - 1)).toBe(false);
    run(f, over, 3 * 3600, controls, 0.5);
    expect(f.state.mode).toBe('landed');
    expect(dist(f.state, f.landing)).toBeLessThan(15);
  });

  it('самолётом на малой скорости — через переход: роторы помогают крылу, пока маршевый разгоняет', () => {
    const f = cruising();
    expect(f.command('failsafe')).toBeNull();
    const course = f.state.headingDeg;
    const slow = AIRCRAFT.transitionLowIasMs - 1.2;
    run(f, (x) => x.state.iasReadingMs < slow + 0.2, 60, (x) => ({ ...controls, stick: planeStick(x, course, 0, slow) }));
    f.step(3, { ...controls, stick: planeStick(f, course, 0, slow) });
    expect(f.state.iasReadingMs).toBeLessThan(AIRCRAFT.transitionLowIasMs);
    const ias0 = f.state.iasMs;
    expect(ias0).toBeGreaterThan(5);
    expect(f.command('rtl')).toBeNull();
    expect(f.state.mode).toBe('transition');
    f.step(0.5, controls);
    // Разгон — с той скорости, что была, а не с нуля; часть веса — на роторах.
    expect(f.state.iasMs).toBeGreaterThanOrEqual(ias0);
    expect(f.state.lift).toBeGreaterThan(0);
    expect(f.state.lift).toBeLessThan(0.8);
    run(f, (x) => x.state.mode !== 'transition', 60);
    expect(f.state.mode).toBe('rtl');
  });
});

describe('отказ маршевого', () => {
  it('ЗАПУСК МАРШЕВОГО без винта: раскрутка, «не удался»; в самолётный режим не пустят', () => {
    const f = cruising();
    f.inject('pusher');
    expect(f.command('failsafe')).toBeNull();
    expect(f.command('pusherStart')).toBeNull();
    expect(f.state.pusherState).toBe('starting');
    f.step(PUSHER_START_S + 0.5, controls);
    expect(said(f, /Запуск маршевого не удался/)).toBe(true);
    expect(said(f, /^Маршевый запущен$/)).toBe(false);
    expect(f.state.pusherState).toBe('off');
    expect(f.state.pusher).toBe(0);
    // Повторный — то же самое: винта нет.
    expect(f.command('pusherStart')).toBeNull();
    f.step(PUSHER_START_S + 0.5, controls);
    expect(f.events.filter((e) => /не удался/.test(e.text))).toHaveLength(2);
    expect(f.command('auto')).toMatch(/Маршевый не работает/);
    expect(f.command('copter')).toBeNull();
    expect(f.command('auto')).toMatch(/только посадка/);
    expect(f.command('rtl')).toMatch(/только посадка/);
  });

  it('в МАРШРУТЕ при отказе маршевого попытка тоже неудачна — аппарат планирует дальше', () => {
    const f = cruising();
    f.inject('pusher');
    expect(f.command('pusherStart')).toBeNull();
    f.step(PUSHER_START_S + 0.5, controls);
    expect(said(f, /не удался/)).toBe(true);
    expect(f.state.mode).toBe('auto');
    expect(f.state.vzMs).toBeLessThan(-0.5);
  });
});

describe('ДИЗАРМ в полёте → аварийный АРМ в воздухе', () => {
  it('из планирования: роторы и маршевый запущены — снова МАРШРУТ, высоты потеряно немного', () => {
    const f = cruising();
    const up0 = f.state.up;
    expect(f.command('disarm')).toBeNull();
    expect(f.state.mode).toBe('falling');
    expect(f.state.pusherState).toBe('off');
    f.step(3, controls);
    expect(f.command('armAir')).toBeNull();
    expect(f.state.armed).toBe(true);
    expect(f.command('armAir')).toMatch(/уже запускаются/);
    run(f, (x) => x.state.mode !== 'falling', 20);
    expect(f.state.mode).toBe('auto');
    expect(said(f, /АРМ В ВОЗДУХЕ: аварийный запуск/)).toBe(true);
    expect(said(f, /^Маршевый запущен$/)).toBe(true);
    expect(said(f, /крыло держит, маршевый тянет/)).toBe(true);
    // Планирует и в раскрутку — снижение по поляре, несколько метров в секунду самое большее.
    expect(up0 - f.state.up).toBeGreaterThan(1);
    expect(up0 - f.state.up).toBeLessThan(40);
    f.step(90, controls);
    expect(f.state.mode).toBe('auto');
    expect(f.state.pusher).toBeGreaterThan(0);
  });

  it('из планирования ЗАПУСК МАРШЕВОГО тоже выводит: АРМ, только маршевый', () => {
    const f = cruising();
    expect(f.command('disarm')).toBeNull();
    f.step(2, controls);
    expect(f.command('pusherStart')).toBeNull();
    expect(said(f, /АРМ, роторы не запускаются/)).toBe(true);
    expect(f.state.armed).toBe(true);
    run(f, (x) => x.state.mode !== 'falling', 20);
    expect(f.state.mode).toBe('auto');
    expect(f.state.lift).toBe(0);
  });

  it('из кувырка на высоте: роторы гасят падение — «Фэйлсейф» коптером, затем МАРШРУТ через переход', () => {
    const f = cruising();
    copterHover(f);
    expect(f.command('disarm')).toBeNull();
    f.step(1, controls);
    expect(f.state.vzMs).toBeLessThan(-5);
    const upArm = f.state.up;
    const tArm = f.state.t;
    expect(f.command('armAir')).toBeNull();
    // Всё время раскрутки и выравнивания — падение.
    run(f, (x) => x.state.mode !== 'falling', 10);
    expect(f.state.mode).toBe('failsafe');
    expect(f.state.failsafePhase).toBe('copter');
    expect(f.state.t - tArm).toBeGreaterThanOrEqual(AIR_START_ROTORS_S + TUMBLE_LEVEL_S - 0.15);
    let low = f.state.up;
    run(f, (x) => x.state.vzMs > -0.5 && x.state.t > tArm + 3, 30, (x) => {
      low = Math.min(low, x.state.up);
      return { ...controls, stick: null };
    });
    expect(over(f)).toBe(false);
    expect(said(f, /Падение остановлено: высота потеряна \d+ м/)).toBe(true);
    const lost = upArm - low;
    // Честно: и раскрутку, и торможение аппарат падает — десятки метров, но не больше, чем было.
    expect(lost).toBeGreaterThan(15);
    expect(lost).toBeLessThan(upArm - f.groundUp(f.state.east, f.state.north) + lost);
    expect(lost).toBeLessThan(90);
    f.step(3, { ...controls, stick: null });
    expect(f.state.pusherState).toBe('run');
    expect(f.command('auto')).toBeNull();
    run(f, (x) => x.state.mode !== 'transition', 60);
    expect(f.state.mode).toBe('auto');
  });

  it('из кувырка низко: раскрутиться и выровняться не успевает — авария', () => {
    const f = new LiveFlight({ plan, terrain, weather: { ...weather, wind: { speedMs: 0, fromDeg: 0 } } });
    f.command('arm');
    f.command('takeoff');
    while (!(f.state.mode === 'climb' && f.state.aglM > 25) && f.state.t < 120) f.step(0.1, controls);
    expect(f.command('disarm')).toBeNull();
    expect(f.command('armAir')).toBeNull();
    run(f, over, 60);
    expect(f.state.mode).toBe('crashed');
    expect(f.state.reason).toMatch(/не успел|не хватило высоты/);
  });

  it('одним маршевым из кувырка не выйти — подсказка «АРМ В ВОЗДУХЕ», и он спасает', () => {
    const f = cruising();
    copterHover(f);
    expect(f.command('disarm')).toBeNull();
    expect(f.command('pusherStart')).toBeNull();
    f.step(PUSHER_START_S + 0.3, controls);
    expect(f.state.mode).toBe('falling');
    expect(said(f, /одним маршевым не выйти/)).toBe(true);
    expect(f.command('armAir')).toBeNull();
    run(f, (x) => x.state.mode !== 'falling', 10);
    expect(f.state.mode).toBe('failsafe');
    run(f, (x) => x.state.vzMs > -0.5, 30, { ...controls, stick: null });
    expect(over(f)).toBe(false);
  });

  it('при неуправляемом аппарате и разряженной батарее — не запустить', () => {
    const f = cruising();
    f.inject('autopilot');
    expect(f.command('armAir')).toMatch(/неуправляем/);
    expect(f.command('pusherStart')).toMatch(/неуправляем/);
  });
});

describe('без связи с НСУ — только команды с пульта', () => {
  it('в зоне ПДУ: МАРШРУТ и АРМ в воздухе доходят, ОЖИДАНИЕ и запуск маршевого — нет', () => {
    const f = cruising();
    copterHover(f);
    f.inject('link');
    expect(f.state.linkLost).toBe(true);
    expect(f.command('hold')).toMatch(/Нет связи/);
    expect(f.command('manual')).toMatch(/Нет связи/);
    expect(f.command('pusherStart')).toMatch(/Нет связи/);
    expect(f.command('auto')).toBeNull();
    expect(f.state.mode).toBe('transition');

    const g = cruising();
    g.inject('link');
    expect(g.command('disarm')).toBeNull();
    g.step(2, controls);
    expect(g.command('armAir')).toBeNull();
    run(g, (x) => x.state.mode !== 'falling', 20);
    expect(g.state.mode).not.toBe('falling');
    expect(over(g)).toBe(false);
  });

  it('вне зоны ПДУ без связи ничего не доходит', () => {
    const f = cruising();
    copterHover(f);
    f.inject('link');
    f.rcRangeM = 0;
    expect(f.command('auto')).toMatch(/Нет связи/);
    expect(f.command('rtl')).toMatch(/Нет связи/);
    expect(f.command('armAir')).toMatch(/Нет связи/);
    expect(f.state.mode).toBe('failsafe');
  });
});

describe('голос', () => {
  /** Телеметрия в голос каждый шаг; что сказано. */
  function listen(f: LiveFlight, v: Callouts, until: (f: LiveFlight) => boolean, limitS: number, c: Controls = controls): string[] {
    const out: string[] = [];
    const t0 = f.state.t;
    while (!until(f) && f.state.t < t0 + limitS) {
      f.step(0.1, c);
      out.push(...v.update(f.state.t, f.telemetry, { rcInRange: f.rcInRange() }).map((x) => x.text));
    }
    return out;
  }

  it('«Маршевый запущен», «Самолётный режим»; при отказе — «Запуск не удался»', () => {
    const f = cruising();
    const v = new Callouts();
    v.update(f.state.t, f.telemetry);
    copterHover(f);
    v.update(f.state.t, f.telemetry);
    f.command('pusherStart');
    v.command('pusherStart', f.state.t);
    const a = listen(f, v, (x) => x.state.pusherState === 'run', 10, { ...controls, stick: null });
    f.step(0.5, { ...controls, stick: null });
    a.push(...v.update(f.state.t, f.telemetry).map((x) => x.text));
    expect(a).toContain('Маршевый запущен');
    f.command('auto');
    v.command('auto', f.state.t);
    const b = listen(f, v, (x) => x.state.mode === 'auto' && x.state.modeT > 1, 60);
    expect(b).toEqual(['Переход в самолётный режим', 'Самолётный режим', 'Маршрут']);

    const g = cruising();
    const w = new Callouts();
    w.update(g.state.t, g.telemetry);
    g.inject('pusher');
    g.command('failsafe');
    w.command('failsafe', g.state.t);
    g.command('pusherStart');
    const c = listen(g, w, () => false, PUSHER_START_S + 1, { ...controls, stick: null });
    expect(c).toContain('Запуск не удался');
    expect(c).not.toContain('Маршевый запущен');
  });

  it('после АРМ в воздухе: «Маршевый запущен», «Самолётный режим», «Маршрут»', () => {
    const f = cruising();
    const v = new Callouts();
    v.update(f.state.t, f.telemetry);
    f.command('disarm');
    const a = listen(f, v, () => false, 3);
    expect(a).toContain('Моторы остановлены');
    f.command('armAir');
    v.command('armAir', f.state.t);
    const b = listen(f, v, (x) => x.state.mode === 'auto' && x.state.modeT > 1, 20);
    expect(b).toEqual(['Маршевый запущен', 'Самолётный режим', 'Маршрут']);
  });
});
