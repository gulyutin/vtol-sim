import type { Sample } from '../game/recorder';

/*
 * Видео полёта — логика без DOM: размер кадра, скорость повтора, времена кадров, раскладка и
 * тексты оверлея, имя файла, выбор кодировщика. Рисование и кодирование — videoExport.ts.
 */

export type VideoSizeId = '720p' | '1080p' | 'vertical';
export const VIDEO_SIZES: Record<VideoSizeId, { width: number; height: number; title: string }> = {
  '720p': { width: 1280, height: 720, title: '720p' },
  '1080p': { width: 1920, height: 1080, title: '1080p' },
  vertical: { width: 1080, height: 1920, title: '9:16' },
};

/** Ракурсы видео — режимы камеры World (scene.ts). */
export type VideoCamera = 'chase' | 'cinema' | 'tail';
export const VIDEO_CAMERAS: readonly { id: VideoCamera; title: string }[] = [
  { id: 'chase', title: 'За хвостом' },
  { id: 'cinema', title: 'Кино' },
  { id: 'tail', title: 'Камера на хвосте' },
];

export const VIDEO_FPS = 30;
export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
/** Титр в начале (поверх первых секунд повтора) и итог оценки в конце (на последнем кадре), с. */
export const TITLE_S = 2;
export const OUTRO_S = 4;
/** Длинный полёт сжимается так, чтобы видео было не длиннее этого, с. */
export const VIDEO_MAX_S = 90;
/** Опорный кадр — раз в столько секунд: перемотка в плеере и соцсети. */
export const KEYFRAME_S = 2;

/**
 * Скорость повтора по длительности участка: наименьшая из 1×, 2×, 4×, 8×, при которой видео не
 * длиннее maxS. Для полёта длиннее 8 × maxS — 8×.
 */
export function pickSpeed(spanS: number, maxS = VIDEO_MAX_S): number {
  for (const s of REPLAY_SPEEDS) if (spanS / s <= maxS + 1e-9) return s;
  return REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1]!;
}

export interface FramePlan {
  t0: number;
  t1: number;
  speed: number;
  fps: number;
  /** Кадров повтора: от t0 до t1 включительно. */
  flightFrames: number;
  /** Кадров итога на последнем моменте записи. */
  outroFrames: number;
  total: number;
  durationS: number;
}

/** Раскадровка участка t0…t1 записи при скорости speed: кадр k повтора — момент t0 + k / fps × speed. */
export function planFrames(t0: number, t1: number, speed: number, fps = VIDEO_FPS, outroS = 0): FramePlan {
  if (!(speed > 0) || !(fps > 0)) throw new Error('Скорость повтора и частота кадров должны быть больше нуля');
  const span = Math.max(0, t1 - t0);
  const flightFrames = Math.floor((span / speed) * fps + 1e-6) + 1;
  const outroFrames = Math.max(0, Math.round(outroS * fps));
  const total = flightFrames + outroFrames;
  return { t0, t1: t0 + span, speed, fps, flightFrames, outroFrames, total, durationS: total / fps };
}

export interface FrameInfo {
  k: number;
  /** Момент записи, с. */
  t: number;
  /** Время от начала видео, с. */
  videoS: number;
  /** Отметка кадра и его длительность для кодировщика, мкс. */
  timestampUs: number;
  durationUs: number;
  /** Кадр итога (после конца повтора) и время от его начала, с. */
  outro: boolean;
  outroS: number;
}

export function frameAt(plan: FramePlan, k: number): FrameInfo {
  const videoS = k / plan.fps;
  const timestampUs = Math.round((k * 1e6) / plan.fps);
  const durationUs = Math.round(((k + 1) * 1e6) / plan.fps) - timestampUs;
  const outro = k >= plan.flightFrames;
  const t = outro ? plan.t1 : Math.min(plan.t1, plan.t0 + videoS * plan.speed);
  return { k, t, videoS, timestampUs, durationUs, outro, outroS: outro ? (k - plan.flightFrames) / plan.fps : 0 };
}

/** Прозрачность титра: появляется за fadeIn, держится, гаснет за fadeOut к концу dur. Вне 0…dur — 0. */
export function fadeAlpha(x: number, dur: number, fadeIn = 0.3, fadeOut = 0.4): number {
  if (!(x >= 0) || x > dur) return 0;
  const a = fadeIn > 0 ? x / fadeIn : 1;
  const b = fadeOut > 0 ? (dur - x) / fadeOut : 1;
  return Math.max(0, Math.min(1, a, b));
}

/** Битрейт H.264 по размеру кадра: ~0.16 бита на пиксель, с округлением до 0,5 Мбит/с. */
export function videoBitrate(width: number, height: number, fps = VIDEO_FPS): number {
  return Math.max(1, Math.round((width * height * fps * 0.16) / 5e5)) * 5e5;
}

/** Строки кодека H.264 (avc1) по убыванию качества: High, Main, Constrained Baseline; уровень — по размеру кадра. */
export function avcCodecs(width: number, height: number): string[] {
  const mb = Math.ceil(width / 16) * Math.ceil(height / 16);
  // 4.0 — до 8192 макроблоков (1920×1088 и 1088×1920) при 30 к/с; больше — 5.1.
  const level = mb <= 8192 ? '28' : '33';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}

/** Типы MediaRecorder для запасной записи, по убыванию предпочтения. */
export const WEBM_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const;

export interface EncoderCaps {
  /** Есть VideoEncoder (WebCodecs). */
  webCodecs: boolean;
  /** Первая строка avc1, которую VideoEncoder принял для этого кадра; null — H.264 не умеет. */
  avcCodec: string | null;
  /** Первый тип из WEBM_TYPES, который умеет MediaRecorder; null — нет MediaRecorder или WebM. */
  webmType: string | null;
}

export type EncoderChoice =
  | { kind: 'mp4'; codec: string; label: string }
  | { kind: 'webm'; mimeType: string; label: string }
  | { kind: 'none'; label: string };

/** MP4 (WebCodecs H.264 + mp4-muxer) — если можно; иначе WebM через MediaRecorder; иначе ничего. */
export function chooseEncoder(c: EncoderCaps): EncoderChoice {
  if (c.webCodecs && c.avcCodec) return { kind: 'mp4', codec: c.avcCodec, label: 'MP4 · H.264' };
  if (c.webmType) {
    const why = c.webCodecs ? 'H.264 в этом браузере недоступен' : 'нет WebCodecs';
    return { kind: 'webm', mimeType: c.webmType, label: `WebM — ${why}; запись идёт в реальном времени` };
  }
  return { kind: 'none', label: 'Запись видео в этом браузере недоступна' };
}

/** Имя файла: полёт-<задание>-<дата>.mp4. Недопустимые в именах файлов знаки убираются, пробелы — дефисы. */
export function videoFileName(title: string, startedAt: string, ext: 'mp4' | 'webm'): string {
  const name = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|→\u0000-\u001f]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/gu, '');
  const d = new Date(startedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${['полёт', name, date].filter(Boolean).join('-')}.${ext}`;
}

const fmt = (x: number, digits = 0) => x.toFixed(digits).replace('.', ',').replace(/^-(?=0(,0*)?$)/u, '').replace('-', '−');

/** Время записи: 0:05, 12:34, 1:02:03. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface OverlayCell {
  label: string;
  value: string;
  unit: string;
  /** Доля ширины ячейки: у режима подпись длиннее. */
  weight: number;
  tone?: 'accent' | 'warn' | 'bad';
}

const WARN_MODES = new Set(['rtl', 'failsafe', 'backtransition']);
const BAD_MODES = new Set(['falling', 'crashed']);

/** Ячейки нижней строки: высота, приборная, путевая, режим, заряд. modeName — название режима как в НСУ. */
export function overlayCells(s: Pick<Sample, 'aglM' | 'iasMs' | 'gsMs' | 'soc' | 'mode'>, modeName: string): OverlayCell[] {
  return [
    { label: 'ВЫСОТА', value: fmt(Math.max(0, s.aglM)), unit: 'м', weight: 1 },
    { label: 'ПРИБОРНАЯ', value: fmt(Math.max(0, s.iasMs), 1), unit: 'м/с', weight: 1 },
    { label: 'ПУТЕВАЯ', value: fmt(Math.max(0, s.gsMs), 1), unit: 'м/с', weight: 1 },
    {
      label: 'РЕЖИМ',
      value: modeName,
      unit: '',
      weight: 1.9,
      tone: BAD_MODES.has(s.mode) ? 'bad' : WARN_MODES.has(s.mode) ? 'warn' : 'accent',
    },
    { label: 'ЗАРЯД', value: fmt(Math.max(0, Math.min(1, s.soc)) * 100), unit: '%', weight: 0.9, tone: s.soc < 0.2 ? 'warn' : undefined },
  ];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayLayout {
  /** Масштаб относительно кадра 720 px по короткой стороне. */
  scale: number;
  portrait: boolean;
  /** Задание и район — сверху слева. */
  mission: Box;
  /** T+ — сверху справа. */
  clock: Box;
  /** Ячейки снизу, в том же порядке, что weights. */
  cells: Box[];
  /** Титр и итог — по центру. */
  card: Box;
  /** Размеры шрифтов, px. */
  font: { label: number; value: number; unit: number; title: number; sub: number; cardTitle: number; cardSub: number };
}

/**
 * Раскладка оверлея. Горизонтальный кадр: ячейки одной строкой слева снизу. Вертикальный: ячейки
 * в несколько строк на всю ширину и выше нижнего края — там у соцсетей подписи и кнопки.
 */
export function overlayLayout(width: number, height: number, weights: readonly number[]): OverlayLayout {
  const portrait = height > width;
  const s = Math.min(width, height) / 720;
  const pad = Math.round(24 * s);
  const gap = Math.round(6 * s);
  const top = portrait ? Math.round(height * 0.07) : pad;
  const bottom = portrait ? Math.round(height * 0.16) : pad;
  const unit = 118 * s;
  const cellH = Math.round(60 * s);
  const avail = width - 2 * pad;

  // Сколько строк нужно, чтобы ячейки влезли в ширину, — и ячейки поровну по строкам (3 + 2, а не 4 + 1).
  let nRows = 1;
  let rowW = 0;
  let inRow = 0;
  for (const wt of weights) {
    const w = wt * unit;
    if (inRow && rowW + gap + w > avail) {
      nRows++;
      rowW = 0;
      inRow = 0;
    }
    rowW += (inRow ? gap : 0) + w;
    inRow++;
  }
  const perRow = Math.ceil(weights.length / nRows);
  const rows: number[][] = [];
  for (let i = 0; i < weights.length; i += perRow) rows.push(weights.slice(i, i + perRow).map((_, j) => i + j));
  const stretch = rows.length > 1;
  const cells: Box[] = new Array(weights.length);
  rows.forEach((r, ri) => {
    const y = height - bottom - (rows.length - ri) * cellH - (rows.length - 1 - ri) * gap;
    const sum = r.reduce((a, i) => a + weights[i]!, 0);
    const k = stretch ? (avail - gap * (r.length - 1)) / sum : unit;
    let x = pad;
    for (const i of r) {
      const w = Math.round(weights[i]! * k);
      cells[i] = { x, y, w, h: cellH };
      x += w + gap;
    }
    // Последняя ячейка растянутой строки — точно до края, без ошибки округления.
    if (stretch) {
      const last = cells[r[r.length - 1]!]!;
      last.w = width - pad - last.x;
    }
  });

  const clockW = Math.round(150 * s);
  const topH = Math.round(54 * s);
  const cardW = Math.min(width - 2 * pad, Math.round(660 * s));
  const cardH = Math.round(190 * s);
  return {
    scale: s,
    portrait,
    mission: { x: pad, y: top, w: width - 2 * pad - clockW - gap, h: topH },
    clock: { x: width - pad - clockW, y: top, w: clockW, h: topH },
    cells,
    card: { x: Math.round((width - cardW) / 2), y: Math.round((height - cardH) / 2), w: cardW, h: cardH },
    font: {
      label: Math.round(11 * s),
      value: Math.round(25 * s),
      unit: Math.round(13 * s),
      title: Math.round(19 * s),
      sub: Math.round(13 * s),
      cardTitle: Math.round(34 * s),
      cardSub: Math.round(17 * s),
    },
  };
}

/** Итог в конце видео: оценка и коротко о полёте. */
export function outroLines(
  a: { total: number; grade: string },
  s: { durationS: number; distanceM: number; energyWh: number },
): { title: string; grade: string; tone: 'good' | 'warn' | 'bad'; detail: string } {
  const dist = s.distanceM >= 1000 ? `${fmt(s.distanceM / 1000, 1)} км` : `${fmt(s.distanceM)} м`;
  return {
    title: `Оценка: ${a.total} из 100`,
    grade: a.grade,
    tone: a.total >= 85 ? 'good' : a.total >= 50 ? 'warn' : 'bad',
    detail: `${clock(s.durationS)} · ${dist} · ${fmt(s.energyWh)} Вт·ч`,
  };
}
