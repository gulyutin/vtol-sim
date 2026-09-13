import { describe, expect, it } from 'vitest';
import type { Callout, CalloutPriority } from '../src/game/callouts';
import {
  pickVoice,
  REC_SAMPLE,
  Voice,
  VOICE_KEY,
  VOICE_LOADING,
  VOICE_NO_API,
  VOICE_NO_RUSSIAN,
  VOICE_SAMPLE,
  voiceQuality,
  type ClipPlayer,
  type Platform,
  type Synth,
  type SynthUtterance,
  type SynthVoice,
} from '../src/ui/voice';

/* Голос НСУ: выбор голоса, очередь, записанная озвучка — на поддельных синтезаторе и аудио, без браузера. */

const voice = (name: string, lang = 'ru-RU', localService = true, voiceURI = name): SynthVoice => ({ name, lang, voiceURI, localService });
const MILENA = voice('Milena');
const GOOGLE = voice('Google русский', 'ru-RU', false);
const EDGE = [
  voice('Microsoft Irina - Russian (Russia)'),
  voice('Microsoft Dmitry Online (Natural) - Russian (Russia)', 'ru-RU', false),
  voice('Microsoft Svetlana Online (Natural) - Russian (Russia)', 'ru-RU', false),
];

class FakeSynth implements Synth {
  speaking = false;
  pending = false;
  spoken: string[] = [];
  utterances: SynthUtterance[] = [];
  cancels = 0;
  /** Браузер требует жест пользователя. */
  block = false;
  private cur: SynthUtterance | null = null;
  private cbs: (() => void)[] = [];
  constructor(public list: SynthVoice[] = []) {}
  speak(u: SynthUtterance) {
    this.spoken.push(u.text);
    this.utterances.push(u);
    if (u.text.trim() === '') return;
    if (this.block) return u.onerror?.({ error: 'not-allowed' });
    this.cur = u;
    this.speaking = true;
    u.onstart?.();
  }
  cancel() {
    this.cancels++;
    const u = this.cur;
    this.cur = null;
    this.speaking = false;
    u?.onerror?.({ error: 'interrupted' });
  }
  /** Фраза договорена. */
  end() {
    const u = this.cur;
    this.cur = null;
    this.speaking = false;
    u?.onend?.();
  }
  getVoices() {
    return this.list;
  }
  addEventListener(_type: 'voiceschanged', cb: () => void) {
    this.cbs.push(cb);
  }
  load(list: SynthVoice[]) {
    this.list = list;
    for (const cb of this.cbs) cb();
  }
  get current() {
    return this.cur?.text ?? null;
  }
  get last() {
    return this.utterances[this.utterances.length - 1]!;
  }
}

/** Поддельное аудио: загрузка мгновенная (или с ошибкой), конец записи — end(). */
class FakeClips implements ClipPlayer {
  ready = false;
  unlocks = 0;
  loads: string[] = [];
  played: string[] = [];
  stopped: string[] = [];
  fail = new Set<string>();
  private have = new Set<string>();
  private cur: { url: string; onend: () => void } | null = null;
  unlock() {
    this.unlocks++;
    this.ready = true;
  }
  load(url: string) {
    this.loads.push(url);
    if (this.fail.has(url)) return Promise.reject(new Error('404'));
    this.have.add(url);
    return Promise.resolve();
  }
  loaded(url: string) {
    return this.have.has(url);
  }
  play(url: string, _volume: number, onend: () => void) {
    this.played.push(url);
    const me = { url, onend };
    this.cur = me;
    return {
      stop: () => {
        this.stopped.push(url);
        if (this.cur === me) this.cur = null;
      },
    };
  }
  end() {
    const c = this.cur;
    this.cur = null;
    c?.onend();
  }
  get current() {
    return this.cur?.url ?? null;
  }
}

const utter = (text: string): SynthUtterance => ({ text, lang: '', voice: null, volume: 1, rate: 1, pitch: 1, onstart: null, onend: null, onerror: null });
const co = (text: string, priority: CalloutPriority = 'info', key = text): Callout => ({ text, priority, key, t: 0 });
/** Дождаться обещаний (манифест, загрузка записей) — без таймеров: проверки собираются без DOM. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup(voices: SynthVoice[] = [MILENA], store = new Map<string, string>(), platform: Platform = 'mac') {
  let now = 0;
  const synth = new FakeSynth(voices);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const v = new Voice({ synth, makeUtterance: utter, storage, now: () => now, platform, packUrl: null });
  const advance = (s: number) => {
    now += s;
    v.update();
  };
  return { v, synth, store, advance };
}

const PACK = '/voice/xenia/';
const MANIFEST = {
  voice: 'xenia',
  name: 'Ксения (запись)',
  files: { Маршрут: 'marshrut.mp3', 'Потеря связи': 'poterya-svyazi.mp3', 'Переход в самолётный режим': 'perekhod.mp3', 'Пожар на борту': 'pozhar.mp3' },
  preload: ['Потеря связи', 'Пожар на борту'],
};

async function setupRec(voices: SynthVoice[] = [MILENA], manifest: unknown = MANIFEST) {
  let now = 0;
  const synth = new FakeSynth(voices);
  const clips = new FakeClips();
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const v = new Voice({ synth, makeUtterance: utter, storage, now: () => now, platform: 'mac', packUrl: PACK, fetchJson: async () => manifest, clips });
  await flush();
  const advance = (s: number) => {
    now += s;
    v.update();
  };
  return { v, synth, clips, advance };
}

describe('выбор голоса', () => {
  it('качество по имени и voiceURI', () => {
    expect(voiceQuality(EDGE[2]!)).toBe('neural');
    expect(voiceQuality(GOOGLE)).toBe('neural');
    expect(voiceQuality(voice('Milena (Enhanced)'))).toBe('enhanced');
    expect(voiceQuality(voice('Милена (улучшенный)'))).toBe('enhanced');
    expect(voiceQuality(voice('Milena', 'ru-RU', true, 'com.apple.voice.premium.ru-RU.Milena'))).toBe('enhanced');
    expect(voiceQuality(voice('Milena', 'ru-RU', true, 'com.apple.voice.compact.ru-RU.Milena'))).toBe('compact');
    expect(voiceQuality(MILENA)).toBe('compact');
    expect(voiceQuality(voice('Юрий'))).toBe('compact');
    expect(voiceQuality(EDGE[0]!)).toBe('standard');
  });

  it('нейросетевые онлайн — первыми, улучшенные — затем, компактные — в конце; выбранный раньше — если есть', () => {
    expect(pickVoice([voice('Yuri'), MILENA, GOOGLE, voice('Samantha', 'en-US')])?.name).toBe('Google русский');
    expect(pickVoice([...EDGE, MILENA])?.name).toBe('Microsoft Svetlana Online (Natural) - Russian (Russia)');
    expect(pickVoice([MILENA, voice('Yuri'), voice('Milena (Enhanced)')])?.name).toBe('Milena (Enhanced)');
    expect(pickVoice([voice('Milena', 'ru-RU', true, 'com.apple.voice.enhanced.ru-RU.Milena'), voice('Milena', 'ru-RU', true, 'com.apple.voice.premium.ru-RU.Milena')])?.voiceURI).toContain('premium');
    expect(pickVoice([MILENA, voice('Microsoft Irina - Russian (Russia)')])?.name).toBe('Microsoft Irina - Russian (Russia)');
    expect(pickVoice([MILENA, GOOGLE], 'Milena')?.name).toBe('Milena');
    expect(pickVoice([MILENA, GOOGLE], 'нет такого')?.name).toBe('Google русский');
    expect(pickVoice([voice('Android', 'ru_RU')])?.name).toBe('Android');
    expect(pickVoice([voice('Samantha', 'en-US')])).toBeNull();
  });

  it('список для интерфейса: лучшие первыми, с пометкой качества и выбранным', () => {
    const { v } = setup([MILENA, voice('Milena (Enhanced)'), GOOGLE, voice('Samantha', 'en-US')]);
    expect(v.voices().map((x) => [x.name, x.qualityLabel, x.selected])).toEqual([
      ['Google русский', 'нейросетевой', true],
      ['Milena (Enhanced)', 'улучшенный', false],
      ['Milena', 'компактный', false],
    ]);
    v.setVoice('Milena (Enhanced)');
    expect(v.voiceName).toBe('Milena (Enhanced)');
    expect(v.quality).toBe('enhanced');
    expect(v.voices().find((x) => x.selected)?.name).toBe('Milena (Enhanced)');
  });

  it('только компактный — признак и подсказка по системе; есть получше — подсказки нет', () => {
    const mac = setup([MILENA, voice('Yuri')]);
    expect(mac.v.compactOnly).toBe(true);
    expect(mac.v.upgradeHint).toContain('Универсальный доступ → Устный контент');
    expect(setup([MILENA], new Map(), 'windows').v.upgradeHint).toContain('Edge');
    const good = setup([MILENA, GOOGLE]);
    expect(good.v.compactOnly).toBe(false);
    expect(good.v.upgradeHint).toBeNull();
  });

  it('нет API — выключен с причиной и не падает', () => {
    const v = new Voice({ synth: null, storage: null, packUrl: null });
    expect(v.available).toBe(false);
    expect(v.reason).toBe(VOICE_NO_API);
    expect(v.preview()).toBe(false);
    v.say(co('Потеря связи', 'critical'));
    v.update();
  });

  it('голоса приходят позже (Chrome); нет русского — выключен с причиной', () => {
    const a = setup([]);
    expect(a.v.available).toBe(false);
    expect(a.v.reason).toBe(VOICE_LOADING);
    a.synth.load([GOOGLE]);
    expect(a.v.available).toBe(true);
    expect(a.v.voiceName).toBe('Google русский');

    const b = setup([voice('Samantha', 'en-US')]);
    expect(b.v.available).toBe(false);
    expect(b.v.reason).toBe(VOICE_NO_RUSSIAN);

    const c = setup([]);
    c.advance(4);
    expect(c.v.reason).toBe(VOICE_NO_RUSSIAN);
    c.v.say(co('Маршрут'));
    c.advance(1);
    expect(c.synth.spoken).toEqual([]);
  });
});

describe('темп, тон, «Прослушать»', () => {
  it('темп по голосу: нейросетевой как есть, компактный чуть медленнее; свои значения запоминаются', () => {
    const { v, synth, store, advance } = setup([MILENA, GOOGLE]);
    v.say(co('Маршрут'));
    advance(0);
    expect(synth.last).toMatchObject({ text: 'Маршрут', rate: 1, pitch: 1, voice: GOOGLE, lang: 'ru-RU' });
    synth.end();

    v.setVoice('Milena');
    v.say(co('Ожидание'));
    advance(1);
    expect(synth.last).toMatchObject({ text: 'Ожидание', voice: MILENA });
    expect(synth.last.rate).toBeCloseTo(0.95, 6);
    synth.end();

    v.setTuning('Milena', { rate: 1.1, pitch: 0.9 });
    v.setRate(1.2);
    v.say(co('Возврат'));
    advance(1);
    expect(synth.last.rate).toBeCloseTo(1.32, 6);
    expect(synth.last.pitch).toBeCloseTo(0.9, 6);
    expect(JSON.parse(store.get(VOICE_KEY)!).perVoice).toEqual({ Milena: { rate: 1.1, pitch: 0.9 } });
    const again = setup([MILENA, GOOGLE], store);
    expect(again.v.voices().find((x) => x.uri === 'Milena')?.tuning).toEqual({ rate: 1.1, pitch: 0.9 });
    again.v.setTuning('Milena', null);
    expect(again.v.voices().find((x) => x.uri === 'Milena')?.tuning).toEqual({ rate: 0.95, pitch: 1 });
  });

  it('«Прослушать» — сразу, нужным голосом, перебивает; работает и при выключенном голосе', () => {
    const { v, synth, advance } = setup([MILENA, GOOGLE]);
    v.say(co('Маршрут'));
    advance(0);
    v.setEnabled(false);
    expect(v.preview('Milena')).toBe(true);
    expect(synth.current).toBe(VOICE_SAMPLE);
    expect(synth.last.voice).toBe(MILENA);
    expect(v.preview('нет такого')).toBe(false);
    expect(v.preview(null, 'Проверка')).toBe(true);
    expect(synth.last).toMatchObject({ text: 'Проверка', voice: GOOGLE });
    expect(synth.cancels).toBeGreaterThanOrEqual(2);
  });

  it('сокращения синтез говорит словами', () => {
    const { v, synth, advance } = setup([GOOGLE]);
    v.say(co('Потеря ГНСС', 'critical'));
    advance(0);
    expect(synth.current).toBe('Потеря гэ-эн-эс-эс');
  });
});

describe('очередь', () => {
  it('критическое перебивает информационное; перебитое не повторяется', () => {
    const { v, synth, advance } = setup();
    v.say(co('Маршрут'));
    advance(0);
    expect(synth.current).toBe('Маршрут');
    v.say(co('Потеря связи', 'critical'));
    expect(synth.cancels).toBe(1);
    advance(0.3);
    expect(synth.current).toBe('Потеря связи');
    synth.end();
    advance(2);
    expect(synth.spoken).toEqual(['Маршрут', 'Потеря связи']);
  });

  it('важное — вперёд, равное не перебивает, тот же ключ вытесняет ждущее', () => {
    const { v, synth, advance } = setup();
    v.say(co('Отказ компаса', 'critical'));
    advance(0);
    v.say([co('Переход в самолётный режим', 'info', 'mode'), co('Большой крен', 'warning'), co('Маршрут', 'info', 'mode'), co('Пожар на борту', 'critical')]);
    expect(synth.cancels).toBe(0);
    for (let i = 0; i < 4; i++) {
      synth.end();
      advance(1);
    }
    expect(synth.spoken).toEqual(['Отказ компаса', 'Пожар на борту', 'Большой крен', 'Маршрут']);
  });

  it('устаревшее выбрасывается, одинаковое подряд — один раз', () => {
    const { v, synth, advance } = setup();
    v.say(co('Потеря связи', 'critical'));
    advance(0);
    v.say(co('Ожидание'));
    advance(5.2);
    synth.end();
    advance(1);
    expect(synth.spoken).toEqual(['Потеря связи']);
    v.say([co('Возврат', 'warning'), co('Возврат', 'warning')]);
    advance(0.3);
    synth.end();
    advance(1);
    v.say(co('Возврат', 'warning'));
    advance(1);
    expect(synth.spoken).toEqual(['Потеря связи', 'Возврат']);
  });

  it('зависшая фраза (нет onend) не держит очередь', () => {
    const { v, synth, advance } = setup();
    v.say(co('Заряд тридцать процентов', 'warning'));
    advance(0);
    v.say(co('Возврат', 'warning'));
    advance(7.5);
    advance(0.3);
    expect(synth.current).toBe('Возврат');
  });

  it('пауза и выключение — молчит; настройки запоминаются', () => {
    const { v, synth, store, advance } = setup();
    v.say(co('Маршрут'));
    advance(0);
    v.setSuspended(true);
    expect(synth.cancels).toBe(1);
    v.say(co('Ожидание'));
    advance(1);
    v.setSuspended(false);
    v.setEnabled(false);
    v.setRate(1.4);
    v.say(co('Возврат'));
    advance(1);
    expect(synth.spoken).toEqual(['Маршрут']);
    expect(JSON.parse(store.get(VOICE_KEY)!)).toMatchObject({ enabled: false, rate: 1.4 });
    const again = setup([MILENA], store);
    expect(again.v.enabled).toBe(false);
    expect(again.v.settings.rate).toBe(1.4);
  });

  it('без жеста браузер не говорит — фраза ждёт unlock()', () => {
    const { v, synth, advance } = setup();
    synth.block = true;
    v.say(co('Потеря связи', 'critical'));
    advance(0);
    advance(1);
    expect(synth.current).toBeNull();
    synth.block = false;
    v.unlock();
    advance(0.3);
    expect(synth.current).toBe('Потеря связи');
  });

  it('на время речи звук приглушается', () => {
    const { v, synth, advance } = setup();
    const duck: boolean[] = [];
    v.onSpeaking = (on) => duck.push(on);
    v.say(co('Маршрут'));
    advance(0);
    synth.end();
    advance(0.3);
    advance(0.5);
    expect(duck).toEqual([true, false]);
  });
});

describe('записанная озвучка', () => {
  it('запись — выбор по умолчанию, выше нейросетевого; есть и без голосов синтеза', async () => {
    const { v } = await setupRec([MILENA, GOOGLE]);
    expect(v.voices()[0]).toMatchObject({ uri: 'rec:xenia', name: 'Ксения (запись)', quality: 'recorded', qualityLabel: 'запись', selected: true });
    expect(v.voices().filter((x) => x.selected)).toHaveLength(1);
    expect(v.voiceName).toBe('Ксения (запись)');
    expect(v.quality).toBe('recorded');
    expect(v.recordedReady).toBe(true);
    expect(v.hasRecording('Потеря связи')).toBe(true);

    const bare = await setupRec([]);
    expect(bare.v.available).toBe(true);
    expect(bare.v.reason).toBeNull();
    // С записью подсказка про компактный голос не нужна.
    expect((await setupRec([MILENA])).v.upgradeHint).toBeNull();
    // Негодный манифест — как без записи.
    const bad = await setupRec([MILENA], { files: {} });
    expect(bad.v.recordedReady).toBe(false);
    expect(bad.v.voices()[0]!.name).toBe('Milena');
  });

  it('что записано — играет запись, остальное — синтез; критические загружаются при первом жесте', async () => {
    const { v, synth, clips, advance } = await setupRec();
    v.unlock();
    expect(clips.loads).toEqual([`${PACK}poterya-svyazi.mp3`, `${PACK}pozhar.mp3`]);
    v.say(co('Маршрут'));
    advance(0);
    await flush();
    expect(clips.current).toBe(`${PACK}marshrut.mp3`);
    clips.end();
    advance(1);
    v.say(co('Потеря ГНСС', 'critical'));
    advance(0.3);
    expect(synth.current).toBe('Потеря гэ-эн-эс-эс');
    expect(clips.played).toEqual([`${PACK}marshrut.mp3`]);
  });

  it('до жеста пользователя запись ждёт; после unlock() — играет сразу', async () => {
    const { v, clips, advance } = await setupRec();
    v.say(co('Потеря связи', 'critical'));
    advance(0);
    advance(1);
    expect(clips.played).toEqual([]);
    v.unlock();
    advance(0.3);
    expect(clips.current).toBe(`${PACK}poterya-svyazi.mp3`);
  });

  it('очередь с записями: критическое перебивает, тот же ключ вытесняет, звук приглушается', async () => {
    const { v, synth, clips, advance } = await setupRec();
    const duck: boolean[] = [];
    v.onSpeaking = (on) => duck.push(on);
    v.unlock();
    v.say(co('Маршрут'));
    advance(0);
    await flush();
    v.say(co('Пожар на борту', 'critical'));
    expect(clips.stopped).toEqual([`${PACK}marshrut.mp3`]);
    advance(0.3);
    expect(clips.current).toBe(`${PACK}pozhar.mp3`);
    v.say([co('Ожидание', 'info', 'mode'), co('Переход в самолётный режим', 'info', 'mode')]);
    clips.end();
    advance(1);
    await flush();
    expect(clips.current).toBe(`${PACK}perekhod.mp3`);
    clips.end();
    advance(1);
    advance(1);
    expect(clips.played).toEqual([`${PACK}marshrut.mp3`, `${PACK}pozhar.mp3`, `${PACK}perekhod.mp3`]);
    expect(synth.spoken.filter((t) => t.trim())).toEqual([]);
    expect(duck).toEqual([true, false]);
  });

  it('запись не загрузилась — говорит синтез', async () => {
    const { v, synth, clips, advance } = await setupRec();
    clips.fail.add(`${PACK}marshrut.mp3`);
    v.unlock();
    v.say(co('Маршрут'));
    advance(0);
    await flush();
    expect(synth.current).toBe('Маршрут');
  });

  it('выбран голос синтеза — записи не играют; «Прослушать» — и запись, и синтез', async () => {
    const { v, synth, clips, advance } = await setupRec([MILENA]);
    expect(v.preview()).toBe(true);
    expect(clips.unlocks).toBe(1);
    await flush();
    expect(clips.current).toBe(`${PACK}perekhod.mp3`);
    expect(REC_SAMPLE).toBe('Переход в самолётный режим');
    expect(v.preview('rec:xenia', 'Пожар на борту')).toBe(true);
    expect(clips.current).toBe(`${PACK}pozhar.mp3`);
    expect(v.preview('Milena')).toBe(true);
    expect(clips.current).toBeNull();
    expect(synth.current).toBe(VOICE_SAMPLE);
    synth.end();

    v.setVoice('Milena');
    expect(v.voices().find((x) => x.selected)?.name).toBe('Milena');
    v.say(co('Маршрут'));
    advance(1);
    expect(synth.current).toBe('Маршрут');
    expect(clips.played).toEqual([`${PACK}perekhod.mp3`, `${PACK}pozhar.mp3`]);
  });
});
