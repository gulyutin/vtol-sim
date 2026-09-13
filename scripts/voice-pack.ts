/*
 * Записанная озвучка НСУ: все фразы каталога src/game/callouts.ts (номера точек и галсов — до 60)
 * целыми фразами, голосом Silero TTS (модель v5_5_ru, диктор xenia) →
 *   public/voice/xenia/<ключ>.mp3 — моно, 64 кбит/с;
 *   public/voice/xenia/index.json — манифест: текст фразы → файл, критические — для предзагрузки;
 *   public/voice/LICENSE.txt      — CC BY-NC-SA 4.0, авторство Silero, что изменено.
 *
 * Пересобрать (нужны Python 3.10+, ffmpeg; при первом запуске — сеть: модель с models.silero.ai):
 *   python3 -m venv ~/.venvs/silero && ~/.venvs/silero/bin/pip install torch numpy omegaconf
 *   brew install ffmpeg                                        # Linux: apt install ffmpeg
 *   PYTHON=~/.venvs/silero/bin/python npx vite-node scripts/voice-pack.ts
 * Модель кэширует torch.hub (TORCH_HOME, по умолчанию ~/.cache/torch).
 *
 * Произношение — словарь STRESS: ударение знаком «+» перед ударной гласной, сокращения словами,
 * как говорят операторы (РЭБ — «рэб», ГНСС — «гэ эн эс эс», ПДУ — «пэ дэ у», ДИЗАРМ — «дизарм»).
 * Слова, которых нет в словаре, скрипт перечислит: ударение в них ставит сам Silero — послушайте
 * и добавьте в словарь. Обработка: тишина в начале и конце обрезается, громкость выравнивается
 * (RMS звучащей части −18 дБ, пик не выше −1 дБ), края — 5 мс затухания.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calloutCatalog } from '../src/game/callouts';

const MODEL = 'v5_5_ru';
const SPEAKER = 'xenia';
const NAME = 'Ксения (запись)';
const MAX_N = 60;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public/voice', SPEAKER);

/** Ударения и сокращения. Ключ — слово строчными; «ё» ударная сама. */
const STRESS: Record<string, string> = {
  // сокращения и жаргон
  рэб: 'рэб',
  гнсс: 'гэ эн эс +эс',
  пду: 'пэ дэ +у',
  арм: '+арм',
  дизарм: 'диз+арм',
  фэйлсейф: 'ф+эйлсейф',
  коптер: 'к+оптер',
  коптера: 'к+оптера',
  // связь, навигация, зоны
  потеря: 'пот+еря',
  связи: 'св+язи',
  связь: 'св+язь',
  восстановлена: 'восстан+овлена',
  слабый: 'сл+абый',
  сигнал: 'сигн+ал',
  подмена: 'подм+ена',
  секунд: 'сек+унд',
  зону: 'з+ону',
  зоны: 'з+оны',
  выход: 'в+ыход',
  запретную: 'запр+етную',
  запретной: 'запр+етной',
  // заряд и ограничения
  заряд: 'зар+яд',
  процентов: 'проц+ентов',
  батарея: 'батар+ея',
  разряжена: 'разр+яжена',
  малая: 'м+алая',
  высота: 'высот+а',
  сваливание: 'св+аливание',
  превышение: 'превыш+ение',
  скорости: 'ск+орости',
  большой: 'больш+ой',
  пульта: 'п+ульта',
  // режимы
  переход: 'перех+од',
  режим: 'реж+им',
  самолётный: 'самолётный',
  маршевый: 'м+аршевый',
  запущен: 'запущ+ен',
  запуск: 'з+апуск',
  удался: 'уд+ался',
  маршрут: 'маршр+ут',
  оперативная: 'операт+ивная',
  точка: 'т+очка',
  ожидание: 'ожид+ание',
  ручной: 'ручн+ой',
  возврат: 'возвр+ат',
  посадка: 'пос+адка',
  управление: 'управл+ение',
  моторы: 'мот+оры',
  остановлены: 'остан+овлены',
  касание: 'кас+ание',
  авария: 'ав+ария',
  пройдена: 'пр+ойдена',
  последний: 'посл+едний',
  // отказы
  отказ: 'отк+аз',
  отрыв: 'отр+ыв',
  датчика: 'д+атчика',
  компаса: 'к+омпаса',
  радиовысотомера: 'радиовысотом+ера',
  элерона: 'элер+она',
  руля: 'рул+я',
  высоты: 'высот+ы',
  стабилизатора: 'стабилиз+атора',
  маршевого: 'м+аршевого',
  винта: 'винт+а',
  роторов: 'р+оторов',
  питания: 'пит+ания',
  автопилота: 'автопил+ота',
  пожар: 'пож+ар',
  борту: 'борт+у',
  балки: 'б+алки',
  консоли: 'конс+оли',
  стабилизации: 'стабилиз+ации',
  // числа
  один: 'од+ин',
  четыре: 'чет+ыре',
  восемь: 'в+осемь',
  девять: 'д+евять',
  десять: 'д+есять',
  одиннадцать: 'од+иннадцать',
  двенадцать: 'двен+адцать',
  тринадцать: 'трин+адцать',
  четырнадцать: 'чет+ырнадцать',
  пятнадцать: 'пятн+адцать',
  шестнадцать: 'шестн+адцать',
  семнадцать: 'семн+адцать',
  восемнадцать: 'восемн+адцать',
  девятнадцать: 'девятн+адцать',
  двадцать: 'дв+адцать',
  тридцать: 'тр+идцать',
  сорок: 'с+орок',
  пятьдесят: 'пятьдес+ят',
  шестьдесят: 'шестьдес+ят',
};

/** Текст для Silero: слова из словаря с ударением, остальные — как есть; незнакомые многосложные — в unknown. */
function speechOf(text: string, unknown: Set<string>): string {
  return text.replace(/[А-Яа-яЁё]+/g, (w) => {
    const lw = w.toLowerCase();
    const s = STRESS[lw];
    if (s !== undefined) return s;
    if (!lw.includes('ё') && (lw.match(/[аеиоуыэюя]/g)?.length ?? 0) > 1) unknown.add(lw);
    return lw;
  });
}

const TR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
/** Имя файла по тексту: транслитом, через дефис. */
const slug = (text: string) =>
  [...text.toLowerCase()]
    .map((ch) => TR[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Синтез, обработка и сжатие — в Python (torch, numpy) и ffmpeg.
const PY = String.raw`
import json, os, subprocess, sys, wave
import numpy as np
import torch

job = json.load(open(sys.argv[1], encoding='utf-8'))
SR = 48000
torch.set_num_threads(max(1, os.cpu_count() or 1))
model, _ = torch.hub.load('snakers4/silero-models', 'silero_tts', language='ru', speaker=job['model'], trust_repo=True)

def synth(text):
    try:
        return model.apply_tts(text=text, speaker=job['speaker'], sample_rate=SR, put_accent=True, put_yo=True)
    except TypeError:
        return model.apply_tts(text=text, speaker=job['speaker'], sample_rate=SR)

def envelope(a):
    win = SR // 100
    return np.sqrt(np.convolve(a * a, np.ones(win) / win, mode='same'))

def db(x):
    return 20 * np.log10(max(float(x), 1e-9))

def process(a):
    a = np.asarray(a, dtype=np.float64)
    env = envelope(a)
    thr = env.max() * 10 ** (-40 / 20)
    on = np.nonzero(env > thr)[0]
    if len(on) == 0:
        raise RuntimeError('тишина')
    a = a[max(0, on[0] - int(0.02 * SR)): min(len(a), on[-1] + int(0.05 * SR))]
    voiced = envelope(a) > thr
    rms = np.sqrt(np.mean(a[voiced] ** 2))
    a = a * min(10 ** (job['rmsDb'] / 20) / rms, 10 ** (job['peakDb'] / 20) / np.abs(a).max())
    n = int(0.005 * SR)
    a[:n] *= np.linspace(0, 1, n)
    a[-n:] *= np.linspace(1, 0, n)
    return a, db(np.sqrt(np.mean(a[voiced] ** 2))), db(np.abs(a).max())

for e in job['items']:
    a, rms, peak = process(synth(e['speech']).numpy())
    wav = os.path.join(job['tmpDir'], e['key'] + '.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype('<i2').tobytes())
    mp3 = os.path.join(job['outDir'], e['key'] + '.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k',
                    '-map_metadata', '-1', '-id3v2_version', '0', '-write_id3v1', '0', mp3], check=True)
    print(json.dumps({'key': e['key'], 's': round(len(a) / SR, 3), 'rms': round(rms, 1), 'peak': round(peak, 1)}), flush=True)
`;

const LICENSE = `Озвучка НСУ — public/voice/${SPEAKER}/*.mp3

Голос: Silero TTS, модель ${MODEL}, диктор ${SPEAKER}. Авторы — Silero Team,
https://github.com/snakers4/silero-models
Лицензия моделей Silero и этих записей: Creative Commons «Атрибуция — Некоммерческое использование —
На тех же условиях» 4.0 Международная (CC BY-NC-SA 4.0),
https://creativecommons.org/licenses/by-nc-sa/4.0/

Что изменено: фразы синтезированы из текстов тренажёра (src/game/callouts.ts) с расставленными
ударениями и сокращениями, записанными словами; тишина в начале и в конце обрезана, громкость
выровнена, записи сжаты в MP3 (моно, 64 кбит/с). Пересобрать — scripts/voice-pack.ts.

Записи можно использовать только некоммерчески, с указанием авторства; производные — на тех же условиях.
`;

function main() {
  const catalog = calloutCatalog(MAX_N);
  const unknown = new Set<string>();
  const items = catalog.map((p) => ({ ...p, key: slug(p.text), speech: speechOf(p.text, unknown) }));
  const keys = new Set<string>();
  for (const it of items) {
    if (!it.key || keys.has(it.key)) throw new Error(`Имя файла повторяется или пустое: «${it.text}» → ${it.key}`);
    keys.add(it.key);
  }
  if (unknown.size > 0) console.warn(`Нет в словаре ударений (ставит Silero — проверьте на слух): ${[...unknown].sort().join(', ')}`);

  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'voice-pack-'));
  try {
    const job = { model: MODEL, speaker: SPEAKER, outDir: OUT, tmpDir: tmp, rmsDb: -18, peakDb: -1, items: items.map(({ key, speech }) => ({ key, speech })) };
    writeFileSync(join(tmp, 'job.json'), JSON.stringify(job));
    writeFileSync(join(tmp, 'voice_pack.py'), PY);
    console.log(`Синтез ${items.length} фраз: Silero ${MODEL}, ${SPEAKER}…`);
    const r = spawnSync(process.env.PYTHON ?? 'python3', [join(tmp, 'voice_pack.py'), join(tmp, 'job.json')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`Python завершился с кодом ${r.status}${r.error ? `: ${r.error.message}` : ''}`);
    const stats = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { key: string; s: number; rms: number; peak: number });
    if (stats.length !== items.length) throw new Error(`Готово ${stats.length} из ${items.length} фраз`);

    // Старые файлы, которых больше нет в каталоге, — убрать.
    for (const f of readdirSync(OUT)) if (f.endsWith('.mp3') && !keys.has(f.slice(0, -4))) rmSync(join(OUT, f));
    const manifest = {
      voice: SPEAKER,
      name: NAME,
      model: `Silero TTS ${MODEL}, диктор ${SPEAKER}`,
      license: 'CC BY-NC-SA 4.0 — см. ../LICENSE.txt',
      files: Object.fromEntries(items.map((it) => [it.text, `${it.key}.mp3`])),
      preload: items.filter((it) => it.priority === 'critical').map((it) => it.text),
    };
    writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(ROOT, 'public/voice/LICENSE.txt'), LICENSE);

    const bytes = items.reduce((a, it) => a + statSync(join(OUT, `${it.key}.mp3`)).size, 0);
    const secs = stats.map((s) => s.s);
    const rms = stats.map((s) => s.rms);
    console.log(
      `Готово: ${items.length} файлов, ${(bytes / 1024).toFixed(0)} КБ; длительность ${Math.min(...secs).toFixed(2)}…${Math.max(...secs).toFixed(2)} с; ` +
        `RMS ${Math.min(...rms)}…${Math.max(...rms)} дБ, пик не выше ${Math.max(...stats.map((s) => s.peak))} дБ`,
    );
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

main();
