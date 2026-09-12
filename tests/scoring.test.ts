import { afterEach, describe, expect, it } from 'vitest';
import type { Recording, RecordingEvent, Sample } from '../src/game/recorder';
import { assessFlight, DIFFICULTY, findDifficulty, gradeOf, loadResults, planFailures, saveResult, type AssessInput } from '../src/game/scoring';

/*
 * Оценка полёта на синтетической записи: взлёт, маршрут, возврат, посадка. Чистый полёт —
 * высокий балл; посадка мимо, опоздание с реакцией на отказ — штраф.
 */

const LANDING = { east: 0, north: 0 };

interface FlightOpts {
  landAt?: { east: number; north: number };
  crash?: boolean;
  /** Через сколько после касания ДИЗАРМ; null — не задизармлен. */
  disarmAfterS?: number | null;
  arm?: boolean;
  extraEvents?: RecordingEvent[];
  energyWh?: number;
  /** Режимы, начиная с t (с): для реакции на отказ по отсчётам. */
  modeOverride?: { from: number; mode: string };
}

function flight(o: FlightOpts = {}): Recording {
  const land = o.landAt ?? LANDING;
  const samples: Sample[] = [];
  const events: RecordingEvent[] = [];
  const E = o.energyWh ?? 500;
  const TD = 700;
  const phase = (t: number): string => {
    if (t < 10) return 'ground';
    if (t < 20) return 'spool';
    if (t < 40) return 'climb';
    if (t < 50) return 'transition';
    if (o.modeOverride && t >= o.modeOverride.from && t < 620) return o.modeOverride.mode;
    if (t < 620) return 'auto';
    if (t < 640) return 'backtransition';
    if (t < 680) return 'descent';
    if (t < TD) return 'final';
    return o.crash ? 'crashed' : 'landed';
  };
  const disarmT = o.disarmAfterS === null ? Infinity : TD + (o.disarmAfterS ?? 5);
  let prev = '';
  for (let t = 0; t <= 760; t += 0.5) {
    const mode = phase(t);
    const k = Math.min(1, t / TD);
    const out = Math.sin(Math.PI * k);
    const s: Sample = {
      t,
      east: land.east * k + 3000 * out,
      north: land.north * k,
      up: mode === 'ground' || mode === 'landed' ? 0 : 100,
      headingDeg: 90,
      pitchDeg: 0,
      bankDeg: t > 100 && t < 110 ? 20 : 0,
      iasMs: mode === 'auto' ? 21 : 0,
      gsMs: mode === 'auto' ? 22 : 0,
      vzMs: 0,
      aglM: mode === 'ground' || mode === 'landed' ? 0 : 100,
      powerW: 800,
      energyWh: E * k,
      soc: 1 - (E * k) / 1000,
      mode,
      lift: mode === 'landed' ? (t < disarmT ? 0.08 : 0) : 0.5,
      pusher: 0.5,
    };
    samples.push(s);
    if (mode !== prev) events.push({ t, text: mode, kind: 'info' });
    prev = mode;
  }
  if (o.arm !== false) events.push({ t: 5, text: 'АРМ: моторы на холостых', kind: 'info' });
  if (Number.isFinite(disarmT) && !o.crash) events.push({ t: disarmT, text: 'ДИЗАРМ', kind: 'info' });
  events.push(...(o.extraEvents ?? []));
  events.sort((a, b) => a.t - b.t);
  return { version: 1, meta: { title: 'т', startedAt: '2026-01-01T00:00:00Z', profileTitle: 'т', source: 'sim' }, samples, events };
}

function input(rec: Recording, over: Partial<AssessInput> = {}): AssessInput {
  return {
    rec,
    scenarioKind: 'route',
    landing: LANDING,
    landingZoneRadiusM: 20,
    usableWh: 900,
    capacityWh: 1000,
    plannedWh: 480,
    plannedS: 650,
    prepRequired: true,
    prepDone: true,
    failures: [],
    ...over,
  };
}

const item = (a: ReturnType<typeof assessFlight>, title: string) => a.items.find((i) => i.title === title)!;

describe('assessFlight', () => {
  it('чистый полёт — отлично, баллы складываются в итог', () => {
    const a = assessFlight(input(flight()));
    expect(a.total).toBeGreaterThanOrEqual(95);
    expect(a.grade).toBe('отлично');
    expect(a.items.reduce((s, i) => s + i.points, 0)).toBeCloseTo(a.total, 0);
    expect(a.items.reduce((s, i) => s + i.max, 0)).toBe(100);
  });

  it('посадка в 300 м от точки без отказов — неудовлетворительно', () => {
    const a = assessFlight(input(flight({ landAt: { east: 300, north: 0 } })));
    expect(a.total).toBeLessThan(50);
    expect(a.grade).toBe('неудовлетворительно');
    expect(item(a, 'Точность посадки').points).toBe(0);
  });

  it('посадка чуть мимо района — не выше «удовлетворительно»', () => {
    const a = assessFlight(input(flight({ landAt: { east: 35, north: 0 } })));
    expect(a.total).toBeLessThan(70);
  });

  it('авария — неудовлетворительно', () => {
    const a = assessFlight(input(flight({ crash: true })));
    expect(a.total).toBeLessThanOrEqual(20);
    expect(a.grade).toBe('неудовлетворительно');
  });

  it('съёмка с неполным покрытием и недоставленный груз снижают балл', () => {
    const full = assessFlight(input(flight(), { scenarioKind: 'survey', surveyCoverage: 0.97 }));
    const half = assessFlight(input(flight(), { scenarioKind: 'survey', surveyCoverage: 0.5 }));
    expect(half.total).toBeLessThan(full.total - 8);
    const lost = assessFlight(input(flight(), { scenarioKind: 'delivery', delivered: false }));
    expect(item(lost, 'Задание выполнено, посадка в точке').points).toBe(0);
  });

  it('резерв АКБ израсходован — штраф за энергию', () => {
    const a = assessFlight(input(flight({ energyWh: 950 })));
    expect(item(a, 'Запас энергии').points).toBeLessThan(6);
  });

  it('РЛЭ: без подготовки, без АРМ и без ДИЗАРМ после посадки — баллы за порядок теряются', () => {
    const clean = item(assessFlight(input(flight())), 'Порядок по РЛЭ').points;
    expect(clean).toBe(15);
    expect(item(assessFlight(input(flight(), { prepDone: false })), 'Порядок по РЛЭ').points).toBe(10);
    expect(item(assessFlight(input(flight({ arm: false }))), 'Порядок по РЛЭ').points).toBe(12);
    expect(item(assessFlight(input(flight({ disarmAfterS: 200 }))), 'Порядок по РЛЭ').points).toBe(10);
    expect(item(assessFlight(input(flight({ disarmAfterS: null }))), 'Порядок по РЛЭ').points).toBe(8);
  });

  it('предупреждения и крен за пределом — штраф за ограничения', () => {
    const warn = assessFlight(input(flight({ extraEvents: [{ t: 300, text: 'Крен за пределом', kind: 'warn' }] })));
    expect(item(warn, 'Ограничения').points).toBe(12);
  });

  it('отказ: быстрая реакция — полный балл, поздняя — меньше, никакой — ноль', () => {
    const failures = [{ t: 300, id: 'pusher' }];
    const failEv: RecordingEvent = { t: 300, text: 'Отказ маршевого двигателя', kind: 'bad' };
    const react = (dt: number | null) =>
      assessFlight(
        input(flight({ extraEvents: dt === null ? [failEv] : [failEv, { t: 300 + dt, text: 'Команда: ВОЗВРАТ', kind: 'cmd' }] }), {
          failures,
        }),
      );
    const fast = react(10);
    const late = react(100);
    const none = react(null);
    expect(item(fast, 'Действия при отказах').points).toBe(15);
    expect(item(late, 'Действия при отказах').points).toBeLessThan(8);
    expect(item(none, 'Действия при отказах').points).toBe(0);
    expect(fast.total).toBeGreaterThan(late.total);
    expect(late.total).toBeGreaterThan(none.total);
    // Сообщение о самом отказе нарушением не считается.
    expect(item(fast, 'Ограничения').points).toBe(15);
  });

  it('без команд в записи реакцией считается уход в ВОЗВРАТ по отсчётам', () => {
    const a = assessFlight(input(flight({ modeOverride: { from: 315, mode: 'rtl' } }), { failures: [{ t: 300, id: 'gnss' }] }));
    expect(item(a, 'Действия при отказах').points).toBe(15);
  });

  it('вынужденная посадка вне района после отказа итог не обрезает', () => {
    const rec = flight({
      landAt: { east: 800, north: 0 },
      extraEvents: [{ t: 320, text: 'Команда: ПОСАДКА', kind: 'cmd' }],
    });
    const a = assessFlight(input(rec, { failures: [{ t: 310, id: 'fire' }] }));
    expect(a.items.some((i) => i.title === 'Итог ограничен')).toBe(false);
    expect(a.total).toBeGreaterThanOrEqual(50);
  });

  it('оценки по порогам', () => {
    expect(gradeOf(85)).toBe('отлично');
    expect(gradeOf(84)).toBe('хорошо');
    expect(gradeOf(50)).toBe('удовлетворительно');
    expect(gradeOf(49)).toBe('неудовлетворительно');
  });
});

describe('planFailures', () => {
  it('один seed — один набор; другой seed — другой', () => {
    const exam = findDifficulty('exam');
    const a = planFailures(exam, 42, 1800);
    expect(planFailures(exam, 42, 1800)).toEqual(a);
    const variants = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(planFailures(exam, i, 1800))));
    expect(variants.size).toBeGreaterThan(10);
  });

  it('тренировка — без отказов, зачёт — 1–2 из пула в окне полёта', () => {
    expect(planFailures(findDifficulty('train'), 1, 1800)).toEqual([]);
    const exam = findDifficulty('exam');
    for (let seed = 0; seed < 50; seed++) {
      const f = planFailures(exam, seed, 900);
      expect(f.length).toBeGreaterThanOrEqual(1);
      expect(f.length).toBeLessThanOrEqual(2);
      expect(new Set(f.map((x) => x.id)).size).toBe(f.length);
      for (const x of f) {
        expect(exam.failures.pool).toContain(x.id);
        expect(x.t).toBeGreaterThanOrEqual(0);
        expect(x.t).toBeLessThanOrEqual(900 * 0.8);
      }
      expect([...f].sort((p, q) => p.t - q.t)).toEqual(f);
    }
  });

  it('все уровни описаны', () => {
    expect(DIFFICULTY.map((d) => d.id)).toEqual(['train', 'normal', 'hard', 'exam']);
    expect(findDifficulty('нет такого').id).toBe('train');
  });
});

describe('итоги полётов', () => {
  const g = globalThis as { localStorage?: unknown };
  afterEach(() => {
    delete g.localStorage;
  });

  it('без localStorage — пусто и без ошибок', () => {
    expect(loadResults()).toEqual([]);
    expect(() => saveResult({ at: 'x', total: 1, grade: 'хорошо' })).not.toThrow();
  });

  it('сохраняются новыми первыми', () => {
    const store = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    saveResult({ at: '1', total: 60, grade: 'удовлетворительно' });
    saveResult({ at: '2', total: 90, grade: 'отлично', scenarioId: 'route' });
    expect(loadResults().map((r) => r.at)).toEqual(['2', '1']);
  });

  it('испорченное хранилище не ломает загрузку', () => {
    g.localStorage = {
      getItem: () => '{испорчено',
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadResults()).toEqual([]);
    expect(() => saveResult({ at: 'x', total: 1, grade: 'хорошо' })).not.toThrow();
  });
});
