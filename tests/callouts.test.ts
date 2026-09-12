import { describe, expect, it } from 'vitest';
import { Callouts, numberWords, plural, type Callout, type CalloutContext, type CalloutState } from '../src/game/callouts';
import { buildMission, forecastWeather, SCENARIOS, type RouteScenario } from '../src/game/scenarios';
import { LiveFlight, type Controls } from '../src/sim/flight';
import { flatTerrain } from '../src/sim/terrain';
import type { Weather } from '../src/sim/types';

/*
 * Голос НСУ: что и когда говорить. Состояния — как телеметрия LiveFlight; время — симуляционное.
 */

const base = (over: Partial<CalloutState> = {}): CalloutState => ({
  mode: 'auto',
  armed: true,
  soc: 0.9,
  linkLost: false,
  failures: [],
  failsafePhase: null,
  aglM: 150,
  iasMs: 21,
  bankDeg: 0,
  routeLeg: null,
  ...over,
});

/** Кадры с шагом dt от from до to; st(t) — состояние в момент t. */
function run(c: Callouts, from: number, to: number, st: (t: number) => CalloutState, ctx: CalloutContext = {}, dt = 0.1): Callout[] {
  const out: Callout[] = [];
  const n = Math.round((to - from) / dt);
  for (let i = 0; i <= n; i++) {
    const t = from + i * dt;
    out.push(...c.update(t, st(t), ctx));
  }
  return out;
}
const texts = (l: Callout[]) => l.map((c) => c.text);
const between = (t: number, a: number, b: number) => t >= a && t < b;

describe('числа словами', () => {
  it('проценты, секунды, номера', () => {
    expect(numberWords(0)).toBe('ноль');
    expect(numberWords(30)).toBe('тридцать');
    expect(numberWords(21)).toBe('двадцать один');
    expect(numberWords(2, true)).toBe('две');
    expect(numberWords(115)).toBe('сто пятнадцать');
    expect(plural(1, 'процент', 'процента', 'процентов')).toBe('процент');
    expect(plural(22, 'процент', 'процента', 'процентов')).toBe('процента');
    expect(plural(12, 'процент', 'процента', 'процентов')).toBe('процентов');
    expect(plural(50, 'процент', 'процента', 'процентов')).toBe('процентов');
  });
});

describe('заряд', () => {
  it('каждый порог — один раз, чем ниже, тем важнее', () => {
    const c = new Callouts();
    // Заряд падает с 1 до 0,05 и дрожит около порогов.
    const said = run(c, 0, 100, (t) => base({ soc: 1 - t * 0.0095 + 0.004 * Math.sin(t * 7) }));
    expect(texts(said)).toEqual(['Заряд пятьдесят процентов', 'Заряд тридцать процентов', 'Заряд двадцать процентов', 'Заряд десять процентов']);
    expect(said.map((x) => x.priority)).toEqual(['info', 'warning', 'warning', 'critical']);
  });

  it('скачок через несколько порогов — только последний; ниже уже бывшего при старте — молчим', () => {
    const c = new Callouts();
    expect(c.update(0, base({ soc: 0.6 }))).toEqual([]);
    expect(texts(c.update(1, base({ soc: 0.15 })))).toEqual(['Заряд двадцать процентов']);
    expect(texts(c.update(2, base({ soc: 0 })))).toEqual(['Батарея разряжена']);
    expect(c.update(3, base({ soc: 0 }))).toEqual([]);

    const d = new Callouts();
    d.update(0, base({ soc: 0.4 }));
    expect(texts(run(d, 1, 10, (t) => base({ soc: 0.4 - t * 0.012 })))).toEqual(['Заряд тридцать процентов']);
  });
});

describe('связь', () => {
  it('потеря и восстановление — с выдержкой: короткие пропадания не озвучиваются', () => {
    const c = new Callouts();
    const lost = (t: number) => between(t, 5, 5.5) || between(t, 10, 50) || between(t, 50.5, 51);
    const said = run(c, 0, 60, (t) => base({ linkLost: lost(t) }));
    expect(texts(said)).toEqual(['Потеря связи', 'Нет связи тридцать секунд', 'Связь восстановлена']);
    expect(said[0]!.priority).toBe('critical');
    expect(said[0]!.t).toBeCloseTo(11, 5);
    expect(said[1]!.t).toBeCloseTo(40, 5);
    expect(said[2]!.t).toBeCloseTo(53, 5);
  });

  it('без связи телеметрия замерла: что изменилось — после «Связь восстановлена»', () => {
    const c = new Callouts();
    const st = (t: number) => (t < 10 ? base({ soc: 0.6 }) : t < 45 ? base({ soc: 0.6, linkLost: true }) : base({ soc: 0.25, mode: 'rtl' }));
    const said = run(c, 0, 50, st);
    expect(texts(said)).toEqual(['Потеря связи', 'Нет связи тридцать секунд', 'Связь восстановлена', 'Возврат', 'Заряд тридцать процентов']);
  });

  it('слабый сигнал — если модель связи его даёт; повтор — только после уверенного приёма', () => {
    const c = new Callouts();
    const q = (t: number) => (between(t, 5, 12) || between(t, 13, 20) ? 0.2 : between(t, 12, 13) ? 0.8 : between(t, 40, 50) ? 0.1 : 0.9);
    const said = run(c, 0, 60, (t) => base({ linkQuality: q(t) }));
    expect(texts(said)).toEqual(['Слабый сигнал связи', 'Слабый сигнал связи']);
    expect(said[1]!.t).toBeGreaterThan(40);
  });
});

describe('приоритеты и ускорение', () => {
  it('в одном кадре важное — первым', () => {
    const c = new Callouts();
    c.update(0, base());
    const said = c.update(1, base({ mode: 'hold', failures: ['fire'], soc: 0.45 }));
    expect(texts(said)).toEqual(['Пожар на борту', 'Ожидание', 'Заряд пятьдесят процентов']);
    expect(said.map((x) => x.priority)).toEqual(['critical', 'info', 'info']);
  });

  it('при ускорении от ×10 — только критическое, пропущенное потом не говорится', () => {
    const c = new Callouts();
    c.update(0, base());
    expect(texts(c.update(1, base({ mode: 'hold', failures: ['fire'] }), { rate: 10 }))).toEqual(['Пожар на борту']);
    expect(c.update(2, base({ mode: 'hold', failures: ['fire'] }), { rate: 1 })).toEqual([]);
    expect(texts(c.update(3, base({ mode: 'rtl', failures: ['fire'] }), { rate: 5 }))).toEqual(['Возврат']);
  });

  it('на паузе и в разборе — молчим, и задним числом тоже', () => {
    const c = new Callouts();
    c.update(0, base());
    expect(c.update(1, base({ failures: ['fire'] }), { paused: true })).toEqual([]);
    expect(c.update(2, base({ failures: ['fire'], mode: 'rtl' }), { replay: true })).toEqual([]);
    expect(c.update(3, base({ failures: ['fire'], mode: 'rtl' }))).toEqual([]);
  });

  it('время назад — новый полёт: всё с начала, без сообщений на первом кадре', () => {
    const c = new Callouts();
    run(c, 0, 10, (t) => base({ soc: 0.9 - t * 0.05 }));
    expect(c.update(0, base({ mode: 'ground', armed: false, soc: 1 }))).toEqual([]);
    expect(texts(c.update(1, base({ mode: 'ground', armed: false, soc: 0.45 })))).toEqual(['Заряд пятьдесят процентов']);
  });
});

describe('режимы, отказы, ограничения', () => {
  it('«Фэйлсейф» по команде — предупреждение, сам автопилот — критическое', () => {
    const a = new Callouts();
    a.update(0, base());
    expect(a.update(1, base({ mode: 'failsafe', failsafePhase: 'plane' }))).toEqual([{ text: 'Фэйлсейф, управление с пульта', priority: 'critical', key: 'mode', t: 1 }]);

    const b = new Callouts();
    b.update(0, base());
    b.command('failsafe', 1);
    expect(b.update(1.2, base({ mode: 'failsafe', failsafePhase: 'plane' }))[0]).toMatchObject({ text: 'Фэйлсейф, самолёт', priority: 'warning' });
    expect(texts(b.update(2, base({ mode: 'failsafe', failsafePhase: 'copter' })))).toEqual(['Режим коптера']);
  });

  it('отказы — по одному разу, ГНСС — с потерей и восстановлением', () => {
    const c = new Callouts();
    const f = (t: number): string[] => [...(t >= 5 ? ['gnss'] : []), ...(t >= 8 ? ['compass', 'rotor'] : [])].filter((id) => !(id === 'gnss' && t >= 20));
    const said = run(c, 0, 30, (t) => base({ failures: f(t) }));
    expect(texts(said)).toEqual(['Потеря спутниковой навигации', 'Отказ компаса', 'Отрыв подъёмного винта', 'Навигация восстановлена']);
  });

  it('малая высота, сваливание, крен, скорость — в самолётном режиме, с гистерезисом', () => {
    const c = new Callouts();
    // Подъём до 30 м — ещё не выход из малой высоты; снова предупредить — только после набора.
    const agl = (t: number) => (between(t, 5, 40) || between(t, 41, 45) || t >= 50 ? 10 : between(t, 40, 41) ? 30 : 150);
    const low = run(c, 0, 55, (t) => base({ aglM: agl(t) }));
    expect(texts(low)).toEqual(['Малая высота', 'Малая высота']);
    expect(low.map((x) => x.priority)).toEqual(['critical', 'critical']);
    expect(low[1]!.t).toBeGreaterThan(50);

    const d = new Callouts();
    const said = run(d, 0, 30, (t) => base({ iasMs: between(t, 5, 8) ? 8 : between(t, 15, 20) ? 40 : 21, bankDeg: between(t, 22, 25) ? 50 : 0 }));
    expect(texts(said)).toEqual(['Сваливание', 'Превышение скорости', 'Большой крен']);

    // На посадке и при отказе ПВД — молчим: низко по плану, а о ПВД уже сказано.
    const e = new Callouts();
    expect(texts(run(e, 0, 10, (t) => base({ mode: t < 1 ? 'auto' : 'descent', aglM: 10 })))).toEqual(['Посадка']);
    const g = new Callouts();
    expect(texts(run(g, 0, 10, (t) => base({ failures: t > 1 ? ['airspeed'] : [], iasMs: t > 1 ? 6 : 21 })))).toEqual(['Отказ датчика скорости']);
  });
});

describe('маршрут', () => {
  const legs = (seq: (number | null)[]) => (t: number) => base({ routeLeg: seq[Math.min(seq.length - 1, Math.floor(t))]! });

  it('пройденные точки оператора — по номерам участков, каждая один раз', () => {
    const c = new Callouts();
    c.setRoute({ points: 3 });
    expect(texts(run(c, 0, 10, legs([0, 1, 1, 2, 3, 3, 4, 5, 6, null])))).toEqual(['Пройдена точка один', 'Пройдена точка два', 'Пройдена точка три']);

    const back = new Callouts();
    back.setRoute({ points: 3, reversed: true });
    expect(texts(run(back, 0, 10, legs([1, 2, 4, 5])))).toEqual(['Пройдена точка три', 'Пройдена точка один']);

    const none = new Callouts();
    expect(run(none, 0, 10, legs([0, 1, 2, 3, 4]))).toEqual([]);
  });

  it('съёмка: галсы', () => {
    const c = new Callouts();
    c.setRoute({ lineLegs: [2, 4, 6] });
    expect(texts(run(c, 0, 10, legs([1, 2, 3, 4, 5, 6, 7])))).toEqual(['Галс один', 'Галс два', 'Последний галс']);
  });
});

describe('РЭБ и запретные зоны — необязательные поля', () => {
  it('без полей — ни слова о РЭБ', () => {
    const c = new Callouts();
    const said = run(c, 0, 20, (t) => base({ mode: t < 10 ? 'auto' : 'hold', ew: t > 15 ? null : undefined }));
    expect(texts(said)).toEqual(['Ожидание']);
  });

  it('вход и выход с выдержкой, подмена — критическое', () => {
    const c = new Callouts();
    const jam = (t: number) => (between(t, 5, 20) || between(t, 21, 30) ? 0.8 : between(t, 20, 21) ? 0.03 : 0);
    const said = run(c, 0, 40, (t) => base({ ew: { gnssJam: jam(t), gnssSpoof: between(t, 25, 28) ? 0.7 : 0, linkJam: 0.1 * jam(t), noflyIds: [] } }));
    expect(texts(said)).toEqual(['Вход в зону РЭБ', 'Подмена навигации', 'Выход из зоны РЭБ']);
    expect(said.map((x) => x.priority)).toEqual(['warning', 'critical', 'info']);
    expect(said[2]!.t).toBeCloseTo(33, 5);
  });

  it('запретная зона: дрожь на границе не повторяется, новая зона — снова', () => {
    const c = new Callouts();
    const ids = (t: number): string[] => (between(t, 5, 10) || between(t, 10.5, 15) ? ['z1'] : between(t, 15, 18) ? ['z1', 'z2'] : []);
    const said = run(c, 0, 30, (t) => base({ ew: { noflyIds: ids(t) } }));
    expect(texts(said)).toEqual(['Вход в запретную зону', 'Вход в запретную зону', 'Выход из запретной зоны']);
    expect(said.map((x) => x.priority)).toEqual(['critical', 'critical', 'info']);
  });

  it('РЭБ можно дать в обход телеметрии (ctx.ew)', () => {
    const c = new Callouts();
    const said = run(c, 0, 10, () => base(), { ew: { linkJam: 0.9 } });
    expect(texts(said)).toEqual(['Вход в зону РЭБ']);
  });
});

describe('живой полёт', () => {
  const route = SCENARIOS.find((s): s is RouteScenario => s.kind === 'route')!;
  const terrain = flatTerrain(260);
  const weather: Weather = { ...forecastWeather(route, route.defaults), wind: { speedMs: 0, fromDeg: 0 } };
  const plan = buildMission(route, route.defaults, terrain, weather);
  const controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };

  function start() {
    const f = new LiveFlight({ plan: plan.stages[0]!, terrain, weather, origin: plan.site, home: plan.site });
    const c = new Callouts();
    c.setRoute({ points: route.route.length });
    const said: Callout[] = [];
    const tick = () => said.push(...c.update(f.state.t, f.telemetry));
    const cmd = (x: Parameters<LiveFlight['command']>[0]) => {
      expect(f.command(x)).toBeNull();
      c.command(x, f.state.t);
      tick();
    };
    tick();
    return { f, said, tick, cmd };
  }
  const notBattery = (l: Callout[]) => texts(l).filter((x) => !x.startsWith('Заряд'));

  it('облёт по маршруту: коротко и по делу', () => {
    const { f, said, tick, cmd } = start();
    cmd('arm');
    cmd('takeoff');
    while (f.state.mode !== 'landed' && f.state.mode !== 'crashed' && f.state.t < 4 * 3600) {
      f.step(0.5, controls);
      tick();
    }
    expect(f.state.mode).toBe('landed');
    cmd('disarm');
    const points = Array.from({ length: route.route.length }, (_, i) => `Пройдена точка ${numberWords(i + 1)}`);
    expect(notBattery(said)).toEqual(['Арм', 'Взлёт', 'Переход в самолётный режим', 'Маршрут', ...points, 'Посадка', 'Касание', 'Дизарм']);
    expect(said.filter((x) => x.priority === 'critical')).toEqual([]);
    expect(new Set(texts(said)).size).toBe(said.length);
  });

  it('потеря связи в полёте: автопилот уходит на ВОЗВРАТ, НСУ узнаёт после восстановления', () => {
    const { f, said, tick, cmd } = start();
    cmd('arm');
    cmd('takeoff');
    while (!(f.state.mode === 'auto' && f.state.t > 200)) {
      f.step(0.5, controls);
      tick();
    }
    const n0 = said.length;
    f.inject('link');
    for (let i = 0; i < 90; i++) {
      f.step(0.5, controls);
      tick();
    }
    expect(f.state.mode).toBe('rtl');
    f.restore('link');
    for (let i = 0; i < 10; i++) {
      f.step(0.5, controls);
      tick();
    }
    expect(notBattery(said.slice(n0))).toEqual(['Потеря связи', 'Нет связи тридцать секунд', 'Связь восстановлена', 'Возврат']);
  });
});
