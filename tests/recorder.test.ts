import { describe, expect, it } from 'vitest';
import { FlightRecorder, parseRecording, serialize, stateAt, summarize, type Recording, type Sample } from '../src/game/recorder';
import type { LiveMode, LiveState } from '../src/sim/flight';

/*
 * Запись полёта: прореживание по времени без потери смен режима, интерполяция для повтора
 * (курс через север), файл туда и обратно без искажений.
 */

// Только поля, которые читает запись: новые поля LiveState (отказы и т. п.) тесту не нужны.
function state(t: number, over: Partial<LiveState> = {}): LiveState {
  return ({
    t,
    mode: 'auto',
    armed: true,
    modeT: 0,
    east: t * 20,
    north: 0,
    up: 100,
    headingDeg: 90,
    trackDeg: 90,
    driftDeg: 0,
    bankDeg: 0,
    iasMs: 21,
    tasMs: 22,
    groundSpeedMs: 20,
    vzMs: 0,
    aglM: 100,
    wind: { speedMs: 3, fromDeg: 270 },
    powerW: 800,
    energyWh: t * 0.2,
    soc: 1 - t * 0.0002,
    distanceM: t * 20,
    wp: 1,
    routeLeg: null,
    lift: 0,
    pusher: 0.6,
    reason: null,
    ...over,
  }) as LiveState;
}

const META = { title: 'Проверка', startedAt: '2026-01-01T00:00:00.000Z', profileTitle: 'Демо', source: 'sim' as const };

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    east: 0,
    north: 0,
    up: 0,
    headingDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    iasMs: 0,
    gsMs: 0,
    vzMs: 0,
    aglM: 0,
    powerW: 0,
    energyWh: 0,
    soc: 1,
    mode: 'auto',
    lift: 0,
    pusher: 0,
    ...over,
  };
}

const rec = (samples: Sample[], events: Recording['events'] = []): Recording => ({ version: 1, meta: META, samples, events });

describe('FlightRecorder', () => {
  it('2 Гц по времени полёта: шаги по 0.1 с за 10 с — 21 отсчёт', () => {
    const r = new FlightRecorder();
    for (let i = 0; i <= 100; i++) r.sample(state(i * 0.1));
    const s = r.toRecording(META).samples;
    expect(s).toHaveLength(21);
    expect(s[1]!.t).toBeCloseTo(0.5, 6);
    expect(s[20]!.t).toBeCloseTo(10, 6);
  });

  it('частота настраивается', () => {
    const r = new FlightRecorder({ hz: 5 });
    for (let i = 0; i <= 100; i++) r.sample(state(i * 0.1));
    expect(r.length).toBe(51);
  });

  it('смена режима между отсчётами пишется всегда', () => {
    const r = new FlightRecorder();
    const modes: [number, LiveMode][] = [];
    for (let i = 0; i <= 30; i++) {
      const t = i * 0.1;
      const mode: LiveMode = t < 1.25 ? 'auto' : t < 1.35 ? 'rtl' : 'backtransition';
      modes.push([t, mode]);
      r.sample(state(t, { mode }));
    }
    const s = r.toRecording(META).samples;
    const rtl = s.find((x) => x.mode === 'rtl');
    expect(rtl?.t).toBeCloseTo(1.3, 6);
    expect(s.find((x) => x.mode === 'backtransition')?.t).toBeCloseTo(1.4, 6);
  });

  it('тот же момент не дублируется; время назад — запись заново', () => {
    const r = new FlightRecorder();
    r.sample(state(0));
    r.sample(state(0));
    r.sample(state(0, { mode: 'hold' }));
    expect(r.toRecording(META).samples.map((s) => s.mode)).toEqual(['hold']);
    r.sample(state(5));
    r.sample(state(1));
    expect(r.toRecording(META).samples.map((s) => s.t)).toEqual([1]);
  });

  it('события сортируются по времени; reset очищает всё', () => {
    const r = new FlightRecorder();
    r.event(5, 'позже', 'warn');
    r.event(1, 'раньше');
    const e = r.toRecording(META).events;
    expect(e.map((x) => x.text)).toEqual(['раньше', 'позже']);
    expect(e[0]!.kind).toBe('info');
    r.reset();
    expect(r.toRecording(META).events).toEqual([]);
    expect(r.length).toBe(0);
  });

  it('тангаж по наклону траектории в самолётном режиме, на висении — ноль', () => {
    const r = new FlightRecorder();
    r.sample(state(0, { vzMs: 2, groundSpeedMs: 20 }));
    r.sample(state(1, { mode: 'climb', vzMs: 2, groundSpeedMs: 0 }));
    const [a, b] = r.toRecording(META).samples;
    expect(a!.pitchDeg).toBeCloseTo((Math.atan2(2, 20) * 180) / Math.PI + 2, 1);
    expect(b!.pitchDeg).toBe(0);
  });
});

describe('stateAt', () => {
  const r = rec([
    sample(0, { east: 0, headingDeg: 350, bankDeg: -10, mode: 'auto', energyWh: 0 }),
    sample(10, { east: 100, headingDeg: 10, bankDeg: 10, mode: 'rtl', energyWh: 5 }),
    sample(20, { east: 100, headingDeg: 90, mode: 'rtl', energyWh: 6 }),
  ]);

  it('числа — линейно, режим — от предыдущего отсчёта', () => {
    const s = stateAt(r, 5);
    expect(s.east).toBeCloseTo(50);
    expect(s.energyWh).toBeCloseTo(2.5);
    expect(s.bankDeg).toBeCloseTo(0);
    expect(s.mode).toBe('auto');
    expect(s.t).toBe(5);
    expect(stateAt(r, 10).mode).toBe('rtl');
  });

  it('курс через север: 350° → 10° посередине даёт 0°, а не 180°', () => {
    const h = stateAt(r, 5).headingDeg;
    expect(Math.min(h, 360 - h)).toBeLessThan(1e-9);
    expect(stateAt(r, 2.5).headingDeg).toBeCloseTo(355);
    expect(stateAt(r, 7.5).headingDeg).toBeCloseTo(5);
  });

  it('за краями — крайние отсчёты', () => {
    expect(stateAt(r, -5).east).toBe(0);
    expect(stateAt(r, 99).headingDeg).toBe(90);
  });

  it('пустая запись — ошибка', () => {
    expect(() => stateAt(rec([]), 0)).toThrow();
  });
});

describe('summarize', () => {
  it('путь, энергия, касание и промах от точки посадки', () => {
    const r = rec([
      sample(0, { mode: 'ground' }),
      sample(10, { mode: 'climb', aglM: 20 }),
      sample(20, { mode: 'auto', east: 300, north: 400, bankDeg: -25, aglM: 100, energyWh: 50 }),
      sample(30, { mode: 'landed', east: 303, north: 404, energyWh: 60 }),
      sample(40, { mode: 'landed', east: 303, north: 404, energyWh: 61 }),
    ]);
    r.meta = { ...META, landing: { east: 300, north: 400 } };
    const s = summarize(r);
    expect(s.durationS).toBe(40);
    expect(s.airborneS).toBe(10);
    expect(s.distanceM).toBeCloseTo(505);
    expect(s.energyWh).toBe(61);
    expect(s.maxBankDeg).toBe(25);
    expect(s.touchdown).toEqual({ t: 30, east: 303, north: 404, crashed: false });
    expect(s.landingMissM).toBeCloseTo(5);
  });
});

describe('файл записи', () => {
  it('serialize → parseRecording без искажений', () => {
    const r = new FlightRecorder();
    for (let i = 0; i <= 50; i++)
      r.sample(state(i * 0.1 + 1 / 3, { headingDeg: (i * 37.3) % 360, bankDeg: -i / 7, mode: i > 25 ? 'rtl' : 'auto', lift: i / 51 }));
    r.event(1.234567, 'АРМ: моторы на холостых');
    r.event(2, 'Команда: ВОЗВРАТ', 'cmd');
    const a = r.toRecording({ ...META, scenarioId: 'route', landing: { east: 1, north: -2 } });
    const text = serialize(a);
    const b = parseRecording(text);
    expect(b).toEqual(a);
    expect(serialize(b)).toBe(text);
  });

  it('принимает отсчёты объектами', () => {
    const r = rec([sample(0), sample(1, { mode: 'rtl' })]);
    const text = JSON.stringify(r);
    expect(parseRecording(text)).toEqual(r);
  });

  it('битые файлы — понятная ошибка', () => {
    expect(() => parseRecording('не json')).toThrow(/JSON/);
    expect(() => parseRecording('{"version":2}')).toThrow(/версия/);
    const good = JSON.parse(serialize(rec([sample(0), sample(1)]))) as { rows: unknown[][] };
    good.rows[1]![0] = 'x';
    expect(() => parseRecording(JSON.stringify(good))).toThrow(/не число/);
    const back = JSON.parse(serialize(rec([sample(5), sample(1)])));
    expect(() => parseRecording(JSON.stringify(back))).toThrow(/назад/);
  });
});
