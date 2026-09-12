import { describe, expect, it } from 'vitest';
import { buildMission, forecastWeather, SCENARIOS } from '../src/game/scenarios';
import { AIRCRAFT } from '../src/sim/aircraft';
import { FAILURES, FIRE_TO_POWER_S, LINK_TIMEOUT_S, type FailureId } from '../src/sim/failures';
import { LiveFlight, MANUAL_COPTER_MS, type Controls, type Stick } from '../src/sim/flight';
import { flatTerrain } from '../src/sim/terrain';
import type { Weather } from '../src/sim/types';

/*
 * Отказы в полёте (таблица неисправностей РЛЭ) и ответ оператора: «Фэйлсейф», ручной коптер,
 * посадка на брюхо. Пилоты здесь — простые регуляторы, какими мог бы быть человек с пультом.
 */

const RAD = Math.PI / 180;
const sc = SCENARIOS.find((s) => s.kind === 'survey')!;
const terrain = flatTerrain(320);
const weather: Weather = { ...forecastWeather(sc, sc.defaults), wind: { speedMs: 5, fromDeg: 250 } };
const plan = buildMission(sc, sc.defaults, terrain, weather).stages[0]!;
const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const over = (f: LiveFlight) => f.state.mode === 'landed' || f.state.mode === 'crashed';
const dist = (a: { east: number; north: number }, b: { east: number; north: number }) => Math.hypot(a.east - b.east, a.north - b.north);

/** Взлёт и МАРШРУТ: аппарат в крейсере выше 100 м. Пульт достаёт везде — кроме теста на дальность ПДУ. */
function cruising(w: Weather = weather, minT = 300): LiveFlight {
  const f = new LiveFlight({ plan, terrain, weather: w });
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

/**
 * Пилот коптера: держит точку по путевой скорости — интегратор в уставке воздушной скорости сам
 * находит поправку на ветер, — и снижается, когда встал над точкой.
 */
class CopterPilot {
  private vCmd = { e: 0, n: 0 };
  private prev: { e: number; n: number } | null = null;
  constructor(
    private readonly target: { east: number; north: number },
    private readonly land: boolean,
  ) {}

  stick(f: LiveFlight, dt: number): Stick {
    const s = f.state;
    const vel = this.prev ? { e: (s.east - this.prev.e) / dt, n: (s.north - this.prev.n) / dt } : { e: 0, n: 0 };
    this.prev = { e: s.east, n: s.north };
    const ee = s.east - this.target.east;
    const en = s.north - this.target.north;
    const d = Math.hypot(ee, en);
    const k = Math.min(0.3, 3 / Math.max(d, 1e-9));
    this.vCmd.e += (-k * ee - vel.e) * 0.8 * dt;
    this.vCmd.n += (-k * en - vel.n) * 0.8 * dt;
    const V = MANUAL_COPTER_MS;
    const m = Math.hypot(this.vCmd.e, this.vCmd.n);
    if (m > V) {
      this.vCmd.e *= V / m;
      this.vCmd.n *= V / m;
    }
    const psi = s.headingDeg * RAD;
    const pitch = (this.vCmd.e * Math.sin(psi) + this.vCmd.n * Math.cos(psi)) / V;
    const roll = (this.vCmd.e * Math.cos(psi) - this.vCmd.n * Math.sin(psi)) / V;
    // Высоко ветер сильнее — сначала вниз до 30 м, дальше снижение только над точкой.
    let vz = 0;
    if (this.land && s.aglM > 30) vz = -2;
    else if (this.land && d < 8 && Math.hypot(vel.e, vel.n) < 1.5) vz = s.aglM > 6 ? -2 : -0.5;
    return { roll, pitch, yaw: 0, throttle: vz / 3 };
  }
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

describe('перечень отказов', () => {
  it('каждый отказ описан один раз, с порядком действий', () => {
    const ids = FAILURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FAILURES) {
      expect(f.title.length).toBeGreaterThan(3);
      expect(f.effect.length).toBeGreaterThan(10);
      expect(f.rleActions.length).toBeGreaterThan(0);
    }
    expect(FAILURES.find((f) => f.id === 'vtol')!.rleActions.join(' ')).toMatch(/Фэйлсейф.*текущей точке/);
    expect(FAILURES.find((f) => f.id === 'power')!.rleActions.join(' ')).toMatch(/координаты.*поиску/);
    expect(FAILURES.find((f) => f.id === 'stabilization')!.rleActions.join(' ')).toMatch(/квадрокоптер/);
  });

  it('отказ пишется в журнал и в состояние, повторный — не дублируется', () => {
    const f = cruising();
    f.inject('gnss');
    f.inject('gnss');
    expect(f.state.failures).toEqual(['gnss']);
    expect(f.events.filter((e) => /^ОТКАЗ: Потеря сигнала ГНСС/.test(e.text))).toHaveLength(1);
  });
});

describe('связь и навигация', () => {
  it('потеря связи: команды НСУ не доходят, телеметрия замирает, через 30 с — ВОЗВРАТ и посадка дома', () => {
    const f = cruising();
    f.inject('link');
    const frozen = f.telemetry.t;
    expect(f.state.linkLost).toBe(true);
    expect(f.command('guided')).toMatch(/Нет связи/);
    f.step(LINK_TIMEOUT_S - 2, controls);
    expect(f.state.mode).toBe('auto');
    expect(f.telemetry.t).toBe(frozen);
    f.step(4, controls);
    expect(f.state.mode).toBe('rtl');
    run(f, over, 3 * 3600, controls, 0.5);
    expect(f.state.mode).toBe('landed');
    expect(dist(f.state, f.home)).toBeLessThan(AIRCRAFT.limits.landingZoneRadiusM);
  });

  it('потеря связи: с пульта в его зоне «Фэйлсейф» доступен, связь возвращается', () => {
    const f = cruising();
    f.inject('link');
    expect(f.command('failsafe')).toBeNull();
    expect(f.state.mode).toBe('failsafe');
    expect(f.restore('link')).toBe(true);
    expect(f.state.linkLost).toBe(false);
    expect(f.telemetry.t).toBe(f.state.t);
  });

  it('вне зоны ПДУ «Фэйлсейф» не включить', () => {
    const f = cruising();
    f.rcRangeM = 1;
    expect(f.command('failsafe')).toMatch(/ПДУ/);
  });

  it('без ГНСС оценка места уходит от истинного, на висении сносит ветром', () => {
    const f = cruising();
    f.inject('gnss');
    f.step(300, controls);
    expect(dist(f.state.estimate, f.state)).toBeGreaterThan(20);
    expect(f.telemetry.east).toBeCloseTo(f.state.estimate.east, 6);
    expect(f.command('land')).toBeNull();
    run(f, over, 600);
    // Автопилот думает, что сел в точку; на деле его снесло.
    expect(dist(f.state.estimate, f.state)).toBeGreaterThan(50);
  });

  it('отказ компаса: в самолёте незаметен, на висении курс уплывает', () => {
    const f = cruising();
    f.inject('compass');
    f.step(120, controls);
    expect(f.state.mode).toBe('auto');
    expect(dist(f.state.estimate, f.state)).toBe(0);
    const hoverHeading = f.state.wind.fromDeg;
    expect(f.command('land')).toBeNull();
    let dev = 0;
    run(f, over, 600, (x) => {
      if (x.state.mode === 'descent' || x.state.mode === 'final') dev = Math.max(dev, Math.abs(wrap(x.state.headingDeg - hoverHeading)));
      return controls;
    });
    expect(dev).toBeGreaterThan(45);
  });

  it('отказ радиовысотомера: посадка через НСУ всё равно выполняется', () => {
    const f = cruising();
    f.inject('radalt');
    expect(f.command('land')).toBeNull();
    run(f, over, 600);
    expect(f.state.mode).toBe('landed');
  });
});

describe('ПВД и рули', () => {
  it('ПВД занижает — автопилот разгоняется выше заданной', () => {
    const f = cruising();
    f.inject('airspeed', 'low');
    f.step(150, controls);
    expect(f.state.iasReadingMs).toBeLessThan(0.75 * f.state.iasMs);
    expect(f.state.iasMs).toBeGreaterThan(controls.iasMs + 4);
    expect(f.events.some((e) => /Превышение/.test(e.text))).toBe(true);
  });

  it('ПВД завышает — автопилот теряет скорость, сваливание, «Фэйлсейф» по пределам РЛЭ', () => {
    const f = cruising();
    f.inject('airspeed', 'high');
    const slow = { ...controls, iasMs: 15 };
    run(f, (x) => x.state.mode !== 'auto', 400, slow);
    expect(f.state.mode).toBe('failsafe');
    expect(f.events.some((e) => /больше предельного/.test(e.text))).toBe(true);
    expect(f.state.iasReadingMs).toBeGreaterThan(f.state.iasMs);
  });

  it('заклинил элерон — крен ограничен, но аппарат летит', () => {
    const f = cruising();
    f.inject('aileron');
    let bank = 0;
    run(f, () => false, 300, (x) => {
      bank = Math.max(bank, Math.abs(x.state.bankDeg));
      return controls;
    });
    expect(bank).toBeLessThan(AIRCRAFT.maxBankDeg);
    expect(bank).toBeLessThanOrEqual(18.01);
    expect(over(f)).toBe(false);
  });

  it('заклинил руль высоты — высоту не держит', () => {
    const f = cruising();
    const up0 = f.state.up;
    f.inject('elevator');
    let dev = 0;
    run(f, over, 90, (x) => {
      dev = Math.max(dev, Math.abs(x.state.up - up0));
      return controls;
    });
    expect(dev).toBeGreaterThan(15);
  });
});

describe('силовая установка', () => {
  it('маршевый отказал — только планирование, без действий аппарат упирается в землю', () => {
    const f = cruising();
    f.inject('pusher');
    f.step(15, controls);
    expect(f.state.pusher).toBe(0);
    expect(f.state.vzMs).toBeLessThan(-1);
    expect(f.state.powerW).toBeLessThanOrEqual(AIRCRAFT.idlePowerPlaneW + (plan.payload?.powerW ?? 0) + 1e-9);
    run(f, over, 600);
    expect(f.state.reason).toBe('Столкновение с рельефом');
  });

  it('маршевый отказал — пилот берёт «Фэйлсейф», «квадрокоптер» и садится в выбранную точку', () => {
    const f = cruising();
    f.inject('pusher');
    expect(f.command('failsafe')).toBeNull();
    expect(f.state.failsafePhase).toBe('plane');
    expect(f.command('copter')).toBeNull();
    expect(f.state.failsafePhase).toBe('copter');
    const psi = f.state.headingDeg * RAD;
    const target = { east: f.state.east + 70 * Math.sin(psi), north: f.state.north + 70 * Math.cos(psi) };
    const pilot = new CopterPilot(target, true);
    run(f, over, 600, (x) => ({ ...controls, stick: pilot.stick(x, 0.1) }));
    expect(f.state.mode).toBe('landed');
    expect(dist(f.state, target)).toBeLessThan(10);
  });

  it('оторвало винт подъёмного — автопилот на висении не удержит: вращение и удар', () => {
    const f = cruising();
    f.inject('rotor');
    f.step(30, controls);
    expect(f.state.mode).toBe('auto');
    expect(f.command('land')).toBeNull();
    let turned = 0;
    let prev = f.state.headingDeg;
    run(f, over, 600, (x) => {
      if (x.state.mode === 'descent' || x.state.mode === 'final') turned += Math.abs(wrap(x.state.headingDeg - prev));
      prev = x.state.headingDeg;
      return controls;
    });
    expect(f.state.mode).toBe('crashed');
    expect(f.state.reason).toMatch(/подъёмного/);
    expect(turned).toBeGreaterThan(180);
  });

  it('отказ СВВП: вертикальная посадка запрещена, пилот садит на брюхо против ветра', () => {
    const f = cruising();
    f.inject('vtol');
    expect(f.command('land')).toMatch(/СВВП/);
    expect(f.command('copter')).toMatch(/СВВП/);
    expect(f.command('failsafe')).toBeNull();
    run(f, over, 900, (x) => ({ ...controls, stick: planeStick(x, weather.wind.fromDeg, x.state.aglM > 4 ? -1.5 : -0.6, 15) }));
    expect(f.state.mode).toBe('landed');
    expect(f.events.at(-1)!.text).toMatch(/брюхо/);
  });

  it('отказ СВВП: круто и быстро к земле — авария', () => {
    const f = cruising();
    f.inject('vtol');
    f.command('failsafe');
    run(f, over, 900, (x) => ({ ...controls, stick: { roll: 0, pitch: 1, yaw: 0, throttle: 1 } }));
    expect(f.state.mode).toBe('crashed');
    expect(f.state.reason).toMatch(/посадке самолётом/);
  });

  it('отказ СВВП: автопилот на посадке тормозит до сваливания и падает', () => {
    const f = cruising();
    f.inject('vtol');
    f.command('rtl');
    run(f, over, 3 * 3600, controls, 0.5);
    expect(f.state.mode).toBe('crashed');
    expect(f.state.reason).toMatch(/СВВП/);
  });
});

describe('неуправляемый аппарат', () => {
  for (const [id, cause] of [
    ['power', /электроэнергии/],
    ['autopilot', /САУ/],
  ] as [FailureId, RegExp][]) {
    it(`${id}: моторы встают, координаты в журнал, «Фэйлсейф» не поможет`, () => {
      const f = cruising();
      f.inject(id);
      expect(f.state.mode).toBe('falling');
      expect(f.events.some((e) => /Зафиксировать координаты БВС: \d+\.\d+, \d+\.\d+/.test(e.text))).toBe(true);
      expect(f.command('failsafe')).not.toBeNull();
      run(f, over, 900);
      expect(f.state.mode).toBe('crashed');
      expect(f.state.reason).toMatch(cause);
    });
  }

  it('отказ питания обесточивает и нагрузку', () => {
    const f = cruising();
    f.inject('power');
    f.step(1, controls);
    expect(f.state.powerW).toBe(0);
  });

  it('отрыв консоли: не планирует — падает рядом', () => {
    const f = cruising();
    const start = { east: f.state.east, north: f.state.north };
    const agl = f.state.aglM;
    f.inject('wing');
    run(f, over, 300);
    expect(f.state.mode).toBe('crashed');
    expect(dist(f.state, start)).toBeLessThan(agl);
  });

  it(`пожар: через ${FIRE_TO_POWER_S} с отказывает питание`, () => {
    const f = cruising();
    f.inject('fire');
    f.step(FIRE_TO_POWER_S - 5, controls);
    expect(f.state.mode).toBe('auto');
    f.step(10, controls);
    expect(['falling', 'crashed']).toContain(f.state.mode);
    expect(f.state.failures).toContain('power');
  });

  it('потеря стабилизации: раскачка до предела — «Фэйлсейф», в «квадрокоптере» ровно', () => {
    const f = cruising();
    f.inject('stabilization');
    run(f, (x) => x.state.mode !== 'auto', 180);
    expect(f.state.mode).toBe('failsafe');
    expect(f.events.some((e) => /крен больше предельного/.test(e.text))).toBe(true);
    expect(f.command('copter')).toBeNull();
    f.step(2, controls);
    let bank = 0;
    run(f, () => false, 20, (x) => {
      bank = Math.max(bank, Math.abs(x.state.bankDeg));
      return controls;
    });
    expect(f.state.failsafePhase).toBe('copter');
    expect(bank).toBeLessThanOrEqual(30);
    expect(over(f)).toBe(false);
  });
});

describe('«Фэйлсейф»: ручной коптер', () => {
  const windy: Weather = { ...weather, wind: { speedMs: 6, fromDeg: 270 } };

  function hovering(): LiveFlight {
    const f = new LiveFlight({ plan, terrain, weather: windy });
    f.rcRangeM = Infinity;
    f.command('arm');
    f.command('takeoff');
    while (!(f.state.mode === 'climb' && f.state.aglM > 30) && f.state.t < 120) f.step(0.1, controls);
    expect(f.command('failsafe')).toBeNull();
    expect(f.state.failsafePhase).toBe('copter');
    return f;
  }

  it('ручки в центре — высота держится, аппарат уходит по ветру', () => {
    const f = hovering();
    const start = { east: f.state.east, north: f.state.north, up: f.state.up };
    f.step(20, { ...controls, stick: null });
    // Западный ветер сносит на восток.
    expect(f.state.east - start.east).toBeGreaterThan(60);
    expect(Math.abs(f.state.north - start.north)).toBeLessThan(0.2 * (f.state.east - start.east));
    expect(Math.abs(f.state.up - start.up)).toBeLessThan(2);
  });

  it('пилот парирует ветер и держит точку, потом садится в неё', () => {
    const f = hovering();
    const target = { east: f.state.east, north: f.state.north };
    const hold = new CopterPilot(target, false);
    let dev = 0;
    run(f, () => false, 60, (x) => {
      if (x.state.t > 40) dev = Math.max(dev, dist(x.state, target));
      return { ...controls, stick: hold.stick(x, 0.1) };
    });
    expect(dev).toBeLessThan(5);
    const land = new CopterPilot(target, true);
    run(f, over, 300, (x) => ({ ...controls, stick: land.stick(x, 0.1) }));
    expect(f.state.mode).toBe('landed');
    expect(dist(f.state, target)).toBeLessThan(5);
  });

  it('с пульта обратно автопилоту: разгон и МАРШРУТ', () => {
    const f = hovering();
    f.step(3, controls);
    expect(f.command('auto')).toBeNull();
    expect(f.state.mode).toBe('transition');
    run(f, (x) => x.state.mode === 'auto', 60);
    expect(f.state.mode).toBe('auto');
  });
});
