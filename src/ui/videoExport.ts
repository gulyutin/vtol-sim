import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { stateAt, summarize, type Recording, type Sample } from '../game/recorder';
import type { Assessment } from '../game/scoring';
import { MODE_NAMES } from '../sim/flight';
import {
  avcCodecs,
  chooseEncoder,
  clock,
  fadeAlpha,
  frameAt,
  KEYFRAME_S,
  OUTRO_S,
  outroLines,
  overlayCells,
  overlayLayout,
  planFrames,
  TITLE_S,
  VIDEO_FPS,
  VIDEO_SIZES,
  videoBitrate,
  videoFileName,
  WEBM_TYPES,
  type Box,
  type EncoderChoice,
  type FrameInfo,
  type OverlayLayout,
  type VideoCamera,
  type VideoSizeId,
} from './videoPlan';

/*
 * Видео полёта из записи — покадрово, не в реальном времени: для каждого кадра хозяин ставит
 * повтор на момент t (seek) и рисует 3D-кадр нужного размера (renderFrame), сверху ложится
 * оверлей в стиле НСУ, кадр уходит в кодировщик. Поэтому видео плавное на любом компьютере —
 * слабый просто дольше пишет. Кодирование: WebCodecs H.264 + mp4-muxer → MP4; без них —
 * MediaRecorder → WebM (тогда уже в реальном времени). Кадры идут порциями с await между
 * ними: окно не зависает, прогресс виден, запись можно отменить.
 */

/** Хозяин 3D-повтора: всё, что видео просит у сцены. */
export interface VideoHost {
  /** Поставить повтор на момент t записи: поза, Солнце, камера. dtS — шаг видео (1 / fps) для камеры и винтов; 0 — без движения. */
  seek(t: number, dtS: number): void;
  /** 3D-кадр ровно width × height (World.renderTo). Снимается сразу, до следующего вызова. */
  renderFrame(width: number, height: number, dtS: number): CanvasImageSource;
  /** Перед записью: остановить основной цикл, поставить ракурс. */
  begin?(camera: VideoCamera): void;
  /** После записи — и при отмене, и при ошибке: вернуть ракурс и размер, пустить основной цикл. */
  end?(): void;
  /** Сцена ещё грузит рельеф и снимки — кадр немного подождёт. */
  busy?(): boolean;
  /** Район для оверлея: «Приэльбрусье». */
  region?: string;
}

export interface VideoOptions {
  size: VideoSizeId;
  /** Скорость повтора: 1, 2, 4, 8. */
  speed: number;
  camera: VideoCamera;
  /** Участок записи по часам записи (Sample.t), с. */
  from: number;
  to: number;
  fps?: number;
}

export interface VideoProgress {
  phase: 'prepare' | 'encode' | 'finish';
  frame: number;
  total: number;
  /** 0…1. */
  fraction: number;
  /** Момент записи в последнем кадре, с. */
  t: number;
}

export interface VideoResult {
  blob: Blob;
  fileName: string;
  container: 'mp4' | 'webm';
  mimeType: string;
  /** avc1.… или тип MediaRecorder. */
  codec: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationS: number;
  speed: number;
  /** Сколько шла запись, мс. */
  elapsedMs: number;
}

export interface RecordExtras {
  assessment?: Assessment;
  signal?: AbortSignal;
  onProgress?: (p: VideoProgress) => void;
  /** Уже выбранный кодировщик (probeEncoder) — чтобы не проверять ещё раз. */
  encoder?: EncoderChoice;
}

/** Кадры повтора перед записью (не в файл): камера доезжает до ракурса. */
const WARMUP_FRAMES = 24;
/** Сколько ждать рельеф перед первым кадром и на каждом кадре, мс. */
const WARMUP_WAIT_MS = 5000;
const FRAME_WAIT_MS = 100;
/** Порция работы между передышками для окна, мс. */
const SLICE_MS = 40;
/** Больше кадров в очереди кодировщика — ждать: память не растёт. */
const MAX_QUEUE = 4;

function encoderConfig(codec: string, width: number, height: number, fps: number): VideoEncoderConfig {
  return { codec, width, height, bitrate: videoBitrate(width, height, fps), framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' };
}

/** Что умеет браузер для кадра width × height: MP4 (H.264), WebM или ничего. */
export async function probeEncoder(width: number, height: number, fps = VIDEO_FPS): Promise<EncoderChoice> {
  const webCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  let avcCodec: string | null = null;
  if (webCodecs) {
    for (const codec of avcCodecs(width, height)) {
      try {
        if ((await VideoEncoder.isConfigSupported(encoderConfig(codec, width, height, fps))).supported) {
          avcCodec = codec;
          break;
        }
      } catch {
        // Строку кодека браузер не знает — следующая.
      }
    }
  }
  const canRecord = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const webmType = canRecord ? (WEBM_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null) : null;
  return chooseEncoder({ webCodecs, avcCodec, webmType });
}

/** Скачать файл через Blob и <a download>. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const isAbortError = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Запись видео отменена', 'AbortError');
}

/** Передышка для окна. В фоновой вкладке таймеры спят до секунды — там через MessageChannel. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (document.hidden) {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } else setTimeout(resolve, 0);
  });
}

async function sleep(ms: number): Promise<void> {
  if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
  const end = performance.now() + ms;
  while (performance.now() < end) await yieldToUi();
}

interface Sink {
  add(canvas: HTMLCanvasElement, f: FrameInfo): Promise<void>;
  finish(): Promise<Blob>;
  abort(): void;
}

/** WebCodecs H.264 → mp4-muxer. Метаданные в начале файла (fast start) — видео сразу играет в браузере и соцсетях. */
function mp4Sink(codec: string, width: number, height: number, fps: number): Sink {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure: unknown = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  enc.configure(encoderConfig(codec, width, height, fps));
  const keyEvery = Math.max(1, Math.round(KEYFRAME_S * fps));
  const drained = () =>
    new Promise<void>((resolve) => {
      enc.addEventListener('dequeue', () => resolve(), { once: true });
      setTimeout(resolve, 50);
    });
  return {
    async add(canvas, f) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, { timestamp: f.timestampUs, duration: f.durationUs, alpha: 'discard' });
      enc.encode(frame, { keyFrame: f.k % keyEvery === 0 });
      frame.close();
      while (enc.encodeQueueSize > MAX_QUEUE && !failure) await drained();
    },
    async finish() {
      await enc.flush();
      if (failure) throw failure;
      muxer.finalize();
      enc.close();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
    abort() {
      if (enc.state !== 'closed') enc.close();
    },
  };
}

/** Запасной путь: MediaRecorder снимает холст. Он пишет по часам, поэтому кадры идут в реальном времени. */
function webmSink(mimeType: string, canvas: HTMLCanvasElement, width: number, height: number, fps: number): Sink {
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate(width, height, fps) });
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  mr.start(1000);
  let start = 0;
  return {
    async add(_canvas, f) {
      if (!start) start = performance.now();
      track.requestFrame();
      const wait = start + ((f.k + 1) * 1000) / fps - performance.now();
      if (wait > 0) await sleep(wait);
    },
    finish() {
      return new Promise<Blob>((resolve, reject) => {
        mr.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
        mr.onerror = () => reject(new Error('Запись WebM прервалась'));
        mr.stop();
        track.stop();
      });
    },
    abort() {
      if (mr.state !== 'inactive') mr.stop();
      track.stop();
    },
  };
}

// ——— Оверлей ———

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, "Roboto Mono", monospace';
/** Цвета окон НСУ (style.css). */
const C = {
  panel: 'rgba(246, 246, 246, 0.88)',
  card: 'rgba(246, 246, 246, 0.96)',
  line: 'rgba(0, 0, 0, 0.14)',
  text: '#1f2328',
  muted: '#5f6b76',
  accent: '#ff8a1a',
  mode: '#c05a00',
  good: '#1f9d55',
  warn: '#b7791f',
  bad: '#d64545',
};

interface OverlayInfo {
  title: string;
  region: string;
  date: string;
  caption: string;
  t0: number;
  outro: ReturnType<typeof outroLines> | null;
}

function panel(ctx: CanvasRenderingContext2D, b: Box, r: number, fill = C.panel) {
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Текст не шире maxW: иначе обрезается с многоточием. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

function spacing(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

function drawHud(ctx: CanvasRenderingContext2D, L: OverlayLayout, s: Sample, info: OverlayInfo) {
  const k = L.scale;
  const r = 6 * k;
  const padX = 12 * k;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // Задание и район — слева сверху, панель по ширине текста, оранжевая черта как у окон НСУ.
  const m = L.mission;
  ctx.font = `600 ${L.font.title}px ${SANS}`;
  const title = fit(ctx, info.title, m.w - 2 * padX - 4 * k);
  let tw = ctx.measureText(title).width;
  ctx.font = `${L.font.sub}px ${SANS}`;
  const region = info.region ? fit(ctx, info.region, m.w - 2 * padX - 4 * k) : '';
  tw = Math.max(tw, region ? ctx.measureText(region).width : 0);
  const mb = { ...m, w: Math.min(m.w, tw + 2 * padX + 4 * k) };
  panel(ctx, mb, r);
  ctx.fillStyle = C.accent;
  ctx.fillRect(mb.x, mb.y + r * 0.5, 4 * k, mb.h - r);
  ctx.fillStyle = C.text;
  ctx.font = `600 ${L.font.title}px ${SANS}`;
  ctx.fillText(title, mb.x + padX + 4 * k, region ? mb.y + mb.h * 0.47 : mb.y + mb.h / 2 + L.font.title * 0.35);
  if (region) {
    ctx.fillStyle = C.muted;
    ctx.font = `${L.font.sub}px ${SANS}`;
    ctx.fillText(region, mb.x + padX + 4 * k, mb.y + mb.h * 0.8);
  }

  // Время полёта — справа сверху.
  const c = L.clock;
  panel(ctx, c, r);
  ctx.fillStyle = C.muted;
  ctx.font = `600 ${L.font.label}px ${SANS}`;
  spacing(ctx, 0.8 * k);
  ctx.fillText('T+', c.x + padX, c.y + c.h * 0.36);
  spacing(ctx, 0);
  ctx.fillStyle = C.text;
  ctx.font = `600 ${L.font.value}px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(clock(s.t), c.x + c.w - padX, c.y + c.h * 0.78);
  ctx.textAlign = 'left';

  // Ячейки снизу.
  const cells = overlayCells(s, MODE_NAMES[s.mode as keyof typeof MODE_NAMES] ?? s.mode);
  cells.forEach((cell, i) => {
    const b = L.cells[i];
    if (!b) return;
    panel(ctx, b, r);
    ctx.fillStyle = C.muted;
    ctx.font = `600 ${L.font.label}px ${SANS}`;
    spacing(ctx, 0.8 * k);
    ctx.fillText(cell.label, b.x + padX, b.y + 17 * k);
    spacing(ctx, 0);
    const y = b.y + b.h - 13 * k;
    const maxW = b.w - 2 * padX;
    if (!cell.unit) {
      // Режим — словами: жирно и цветом; длинное название — мельче, потом многоточие.
      ctx.fillStyle = cell.tone === 'bad' ? C.bad : cell.tone === 'warn' ? C.warn : C.mode;
      let size = L.font.value * 0.8;
      ctx.font = `700 ${size}px ${SANS}`;
      while (size > L.font.value * 0.55 && ctx.measureText(cell.value).width > maxW) {
        size *= 0.92;
        ctx.font = `700 ${size}px ${SANS}`;
      }
      ctx.fillText(fit(ctx, cell.value, maxW), b.x + padX, y);
      return;
    }
    ctx.fillStyle = cell.tone === 'warn' ? C.warn : C.text;
    ctx.font = `600 ${L.font.value}px ${MONO}`;
    ctx.fillText(cell.value, b.x + padX, y);
    const vw = ctx.measureText(cell.value).width;
    ctx.fillStyle = C.muted;
    ctx.font = `${L.font.unit}px ${SANS}`;
    ctx.fillText(cell.unit, b.x + padX + vw + 5 * k, y);
  });
}

/** Карточка по центру: титр в начале и итог в конце. lines — [текст, размер, цвет, жирность, отступ сверху]. */
function drawCard(ctx: CanvasRenderingContext2D, L: OverlayLayout, alpha: number, lines: [string, number, string, number, number][]) {
  if (alpha <= 0) return;
  const k = L.scale;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(12, 14, 17, 0.38)';
  ctx.fillRect(0, 0, W, H);
  const b = L.card;
  panel(ctx, b, 8 * k, C.card);
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, 6 * k, [8 * k, 8 * k, 0, 0]);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const [text, size, color, weight, y] of lines) {
    if (!text) continue;
    ctx.font = `${weight} ${size}px ${SANS}`;
    ctx.fillStyle = color;
    ctx.fillText(fit(ctx, text, b.w - 40 * k), b.x + b.w / 2, b.y + y * k);
  }
  ctx.restore();
}

function drawOverlay(ctx: CanvasRenderingContext2D, L: OverlayLayout, s: Sample, info: OverlayInfo, f: FrameInfo) {
  drawHud(ctx, L, s, info);
  const F = L.font;
  const title = fadeAlpha(f.videoS, TITLE_S, 0, 0.5);
  if (title > 0) {
    const place = [info.region, info.date].filter(Boolean).join(' · ');
    drawCard(ctx, L, title, [
      [info.caption.toUpperCase(), F.label * 1.25, C.muted, 600, 50],
      [info.title, F.cardTitle, C.text, 700, 104],
      [place, F.cardSub, C.muted, 400, 148],
    ]);
  }
  const o = info.outro;
  if (o && f.outro) {
    drawCard(ctx, L, fadeAlpha(f.outroS, OUTRO_S, 0.4, 0), [
      [info.title, F.cardSub, C.muted, 600, 40],
      [o.title, F.cardTitle, C.text, 700, 92],
      [o.grade, F.cardSub * 1.1, C[o.tone], 700, 130],
      [o.detail, F.cardSub, C.muted, 400, 164],
    ]);
  }
}

/**
 * Записать видео участка opts.from…opts.to записи rec. Хозяин на время записи отдаёт сцену
 * (begin … end). Результат — файл в памяти; скачать — downloadBlob.
 */
export async function recordVideo(rec: Recording, host: VideoHost, opts: VideoOptions, extra: RecordExtras = {}): Promise<VideoResult> {
  if (!rec.samples.length) throw new Error('Запись пуста');
  const { signal, onProgress } = extra;
  const { width, height } = VIDEO_SIZES[opts.size];
  const fps = opts.fps ?? VIDEO_FPS;
  const dt = 1 / fps;
  const first = rec.samples[0]!.t;
  const last = rec.samples[rec.samples.length - 1]!.t;
  const t0 = Math.min(last, Math.max(first, opts.from));
  const t1 = Math.min(last, Math.max(t0, opts.to));
  const choice = extra.encoder ?? (await probeEncoder(width, height, fps));
  if (choice.kind === 'none') throw new Error(choice.label);
  const plan = planFrames(t0, t1, opts.speed, fps, extra.assessment ? OUTRO_S : 0);

  const d = new Date(rec.meta.startedAt);
  const info: OverlayInfo = {
    title: rec.meta.title,
    region: host.region ?? '',
    date: Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
    caption: rec.meta.profileTitle || 'VTOL-симулятор миссии',
    t0,
    outro: extra.assessment ? outroLines(extra.assessment, summarize(rec)) : null,
  };
  const L = overlayLayout(width, height, overlayCells(rec.samples[0]!, '').map((c) => c.weight));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const started = performance.now();
  const report = (phase: VideoProgress['phase'], frame: number, t: number) =>
    onProgress?.({ phase, frame, total: plan.total, fraction: plan.total ? frame / plan.total : 1, t });
  let sink: Sink | null = null;
  host.begin?.(opts.camera);
  try {
    // Подготовка: камера доезжает до ракурса, рельеф под ней догружается.
    report('prepare', 0, t0);
    await yieldToUi();
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      host.seek(t0, dt);
      host.renderFrame(width, height, dt);
    }
    const ready = performance.now() + WARMUP_WAIT_MS;
    while (host.busy?.() && performance.now() < ready) {
      checkAbort(signal);
      await sleep(40);
      host.seek(t0, 0);
      host.renderFrame(width, height, 0);
    }
    checkAbort(signal);

    sink = choice.kind === 'mp4' ? mp4Sink(choice.codec, width, height, fps) : webmSink(choice.mimeType, canvas, width, height, fps);
    let slice = performance.now();
    for (let k = 0; k < plan.total; k++) {
      checkAbort(signal);
      const f = frameAt(plan, k);
      host.seek(f.t, dt);
      let src = host.renderFrame(width, height, dt);
      if (host.busy?.()) {
        const until = performance.now() + FRAME_WAIT_MS;
        while (host.busy() && performance.now() < until) {
          await sleep(10);
          src = host.renderFrame(width, height, 0);
        }
      }
      ctx.drawImage(src, 0, 0, width, height);
      drawOverlay(ctx, L, stateAt(rec, f.t), info, f);
      await sink.add(canvas, f);
      if (performance.now() - slice > SLICE_MS) {
        report('encode', k + 1, f.t);
        await yieldToUi();
        slice = performance.now();
      }
    }
    report('finish', plan.total, t1);
    await yieldToUi();
    const blob = await sink.finish();
    sink = null;
    const container = choice.kind === 'mp4' ? 'mp4' : 'webm';
    return {
      blob,
      fileName: videoFileName(rec.meta.title, rec.meta.startedAt, container),
      container,
      mimeType: blob.type,
      codec: choice.kind === 'mp4' ? choice.codec : choice.mimeType,
      width,
      height,
      fps,
      frames: plan.total,
      durationS: plan.durationS,
      speed: opts.speed,
      elapsedMs: performance.now() - started,
    };
  } finally {
    sink?.abort();
    host.end?.();
  }
}
