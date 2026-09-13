import { PROFILE } from '@profile';
import { parseRecording, serialize, stateAt, summarize, type Recording, type Sample } from '../game/recorder';
import type { Assessment } from '../game/scoring';
import { flightConclusion, type ConclusionContext } from '../game/flightSummary';
import { MODE_NAMES } from '../sim/flight';
import { downloadBlob, isAbortError, probeEncoder, recordVideo, type VideoHost, type VideoResult } from './videoExport';
import {
  clock,
  OUTRO_S,
  pickSpeed,
  planFrames,
  REPLAY_SPEEDS,
  VIDEO_CAMERAS,
  VIDEO_FPS,
  VIDEO_SIZES,
  type EncoderChoice,
  type VideoCamera,
  type VideoSizeId,
} from './videoPlan';
import './debrief.css';

/*
 * Окно разбора полёта в стиле окон НСУ: шкала времени с прокруткой и воспроизведением,
 * графики высоты, скоростей, мощности и заряда с полосами режимов и отметками событий,
 * текущие значения, итоги и оценка. 3D-повтор делает хозяин окна: onSeek(t) приходит
 * при любой смене времени изнутри окна (прокрутка, клик по событию, воспроизведение),
 * а позу он берёт из stateAt(rec, t) (poseOf в recorder.ts).
 *
 * Графики рисуются один раз в невидимый холст с учётом devicePixelRatio; на каждый кадр
 * воспроизведения поверх копируется готовая картинка и дорисовывается только курсор.
 */

const RATES = [1, 4, 16, 64] as const;

type Group = 'vtol' | 'trans' | 'plane' | 'rtl' | 'emerg';
const GROUP_OF: Record<string, Group | undefined> = {
  spool: 'vtol',
  climb: 'vtol',
  descent: 'vtol',
  final: 'vtol',
  transition: 'trans',
  backtransition: 'trans',
  auto: 'plane',
  guided: 'plane',
  hold: 'plane',
  manual: 'plane',
  rtl: 'rtl',
  falling: 'emerg',
  crashed: 'emerg',
};
const GROUP_COLOR: Record<Group, string> = {
  vtol: '#7aa7ff',
  trans: '#b18cff',
  plane: '#5cc787',
  rtl: '#ffb347',
  emerg: '#ff6b6b',
};
const GROUP_TITLE: Record<Group, string> = {
  vtol: 'вертикальный',
  trans: 'переход',
  plane: 'самолётный',
  rtl: 'возврат',
  emerg: 'авария',
};
const EVENT_COLOR: Record<string, string> = { bad: '#d64545', warn: '#b7791f', cmd: '#ff8a1a' };

type NumKey = { [K in keyof Sample]: Sample[K] extends number ? K : never }[keyof Sample];
interface PaneDef {
  title: string;
  unit: string;
  series: { key: NumKey; color: string; label: string; k: number }[];
  fixedMax?: number;
  digits: number;
}
const PANES: PaneDef[] = [
  { title: 'Высота', unit: 'м', series: [{ key: 'aglM', color: '#2563eb', label: '', k: 1 }], digits: 0 },
  {
    title: 'Скорость',
    unit: 'м/с',
    series: [
      { key: 'iasMs', color: '#d9480f', label: 'приборная', k: 1 },
      { key: 'gsMs', color: '#2b8a3e', label: 'путевая', k: 1 },
    ],
    digits: 0,
  },
  { title: 'Мощность', unit: 'кВт', series: [{ key: 'powerW', color: '#7048e8', label: '', k: 0.001 }], digits: 1 },
  { title: 'Заряд', unit: '%', series: [{ key: 'soc', color: '#0b7285', label: '', k: 100 }], fixedMax: 100, digits: 0 },
];

const fmt = (x: number, digits = 0) => x.toFixed(digits).replace('.', ',').replace('-', '−');
export function fmtClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Верх шкалы: ближайшее «круглое» сверху — 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  for (const n of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f <= n + 1e-9) return n * e;
  return 10 * e;
}

/** Шаг подписей времени: не чаще чем через ~60 px. */
function timeStep(spanS: number, px: number): number {
  for (const s of [5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200]) if ((s / spanS) * px >= 60) return s;
  return 14400;
}

/** Открыть файл: запись симулятора (JSON) или, если профиль умеет, бортовой журнал аппарата. */
export async function openRecordingFile(file: File): Promise<Recording> {
  const head = new Uint8Array(await file.slice(0, 1).arrayBuffer());
  if (head[0] === 0x7b) return parseRecording(await file.text());
  if (!PROFILE.importLog) throw new Error('Это не запись симулятора (JSON), а импорт бортовых журналов в этой сборке недоступен');
  return PROFILE.importLog(await file.arrayBuffer(), file.name);
}

/** Имя файла записи по времени начала: запись-2026-09-12-1430.json. */
export function recordingFileName(rec: Recording): string {
  const d = new Date(rec.meta.startedAt);
  const ok = !Number.isNaN(d.getTime());
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = ok ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` : 'полёт';
  return `запись-${stamp}.json`;
}

/** Сохранить запись файлом. */
export function downloadRecording(rec: Recording, fileName = recordingFileName(rec)): void {
  const url = URL.createObjectURL(new Blob([serialize(rec)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface Geometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  gap: number;
  pw: number;
  ph: number;
  w: number;
  h: number;
}

export class Debrief {
  /** Время сменилось изнутри окна: прокрутка, клик по событию, воспроизведение. Не вызывается из setTime. */
  onSeek?: (t: number) => void;
  onPlayback?: (playing: boolean, rate: number) => void;
  onClose?: () => void;
  /** Не задан — запись скачивается файлом (downloadRecording). */
  onExport?: () => void;
  /** Не задан — файл открывается здесь же (openRecordingFile) и показывается без оценки. */
  onImport?: (file: File) => void;
  /** Готовое видео. Не задан — скачивается файлом (downloadBlob). */
  onVideo?: (video: VideoResult) => void;

  private readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly slider: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private rec: Recording | null = null;
  private t = 0;
  private t0 = 0;
  private t1 = 1;
  private isPlaying = false;
  private rateX = 1;
  private raf = 0;
  private lastFrame = 0;
  private layer: HTMLCanvasElement | null = null;
  private layerKey = '';
  private ranges: { min: number; max: number; y0: number; y1: number }[] = [];
  private nowEvent = -1;
  private assessment: Assessment | undefined;
  // Видео: хозяин 3D-повтора, параметры, проверенные кодировщики по размеру кадра, текущая запись.
  private videoHost: VideoHost | null = null;
  private readonly video = { size: '720p' as VideoSizeId, speed: 1, speedAuto: true, camera: 'chase' as VideoCamera, range: 'all' as 'all' | 'cursor' };
  private readonly encoders = new Map<VideoSizeId, EncoderChoice>();
  private videoAbort: AbortController | null = null;

  constructor(root: HTMLElement) {
    const el = document.createElement('div');
    this.el = el;
    el.className = 'win debrief';
    el.hidden = true;
    el.tabIndex = -1;
    const importTitle = PROFILE.importLog ? 'Открыть запись / журнал…' : 'Открыть запись…';
    el.innerHTML = `
      <div class="win-title"><span class="db-title">Разбор полёта</span><button class="x" data-db="close" title="Закрыть">✕</button></div>
      <div class="win-body">
        <div class="db-meta"></div>
        <p class="db-conclusion"></p>
        <div class="db-player">
          <button class="db-btn db-play" data-db="play" title="Пуск / пауза (пробел)">▶</button>
          <span class="db-time">T+0:00 / 0:00</span>
          <span class="db-rates">${RATES.map((r) => `<button data-rate="${r}" title="Скорость воспроизведения">${r}×</button>`).join('')}</span>
        </div>
        <input type="range" class="db-slider" min="0" max="1" step="any" value="0" aria-label="Время записи">
        <canvas class="db-chart" aria-label="Графики полёта"></canvas>
        <div class="db-legend"></div>
        <dl class="db-now"></dl>
        <details class="db-sec" open><summary>Итоги</summary><dl class="db-sum"></dl></details>
        <details class="db-sec db-assess-sec" open><summary>Оценка</summary><div class="db-assess"></div></details>
        <details class="db-sec"><summary>События <span class="db-evn"></span></summary><ul class="log db-events"></ul></details>
        <div class="db-actions">
          <button class="db-btn" data-db="export">Сохранить запись</button>
          <button class="db-btn" data-db="video" hidden>Сохранить видео…</button>
          <button class="db-btn" data-db="import">${importTitle}</button>
          <input type="file" class="db-file" hidden>
        </div>
        <div class="db-video" hidden>
          <div class="dv-grid">
            <span class="dv-k">Кадр</span><span class="dv-seg" data-group="size">${(Object.keys(VIDEO_SIZES) as VideoSizeId[])
              .map((id) => `<button data-v="${id}" title="${VIDEO_SIZES[id].width}×${VIDEO_SIZES[id].height}">${VIDEO_SIZES[id].title}</button>`)
              .join('')}</span>
            <span class="dv-k">Скорость</span><span class="dv-seg" data-group="speed">${REPLAY_SPEEDS.map((s) => `<button data-v="${s}">${s}×</button>`).join('')}</span>
            <span class="dv-k">Ракурс</span><span class="dv-seg" data-group="camera">${VIDEO_CAMERAS.map((c) => `<button data-v="${c.id}">${c.title}</button>`).join('')}</span>
            <span class="dv-k">Участок</span><span class="dv-seg" data-group="range"><button data-v="all">Весь полёт</button><button data-v="cursor">От ползунка до конца</button></span>
          </div>
          <div class="dv-info"></div>
          <div class="dv-progress" hidden><div class="dv-bar"><i></i></div><span class="dv-pct"></span></div>
          <div class="dv-buttons">
            <button class="db-btn dv-go" data-db="video-go">Записать</button>
            <button class="db-btn" data-db="video-cancel" hidden>Отмена</button>
          </div>
          <div class="dv-status" hidden></div>
        </div>
        <div class="db-error" hidden></div>
      </div>`;
    root.appendChild(el);
    this.canvas = this.q<HTMLCanvasElement>('.db-chart');
    this.slider = this.q<HTMLInputElement>('.db-slider');
    this.fileInput = this.q<HTMLInputElement>('.db-file');

    el.addEventListener('click', (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLElement>('.dv-seg > [data-v]');
      if (opt) return this.setVideoOption(opt.parentElement!.dataset.group!, opt.dataset.v!);
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-db],[data-rate]');
      if (!b) return;
      if (b.dataset.rate) return this.setRate(Number(b.dataset.rate));
      switch (b.dataset.db) {
        case 'close':
          this.hide();
          this.onClose?.();
          break;
        case 'play':
          if (this.isPlaying) this.pause();
          else this.play();
          break;
        case 'export':
          if (this.onExport) this.onExport();
          else if (this.rec) downloadRecording(this.rec);
          break;
        case 'import':
          this.fileInput.click();
          break;
        case 'video': {
          const p = this.q<HTMLElement>('.db-video');
          p.hidden = !p.hidden;
          if (!p.hidden) this.updateVideoPanel();
          break;
        }
        case 'video-go':
          void this.saveVideo();
          break;
        case 'video-cancel':
          this.videoAbort?.abort();
          break;
      }
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (!file) return;
      if (this.onImport) return this.onImport(file);
      this.error(null);
      openRecordingFile(file).then(
        (rec) => this.show(rec),
        (e: unknown) => this.error(e instanceof Error ? e.message : String(e)),
      );
    });
    this.slider.addEventListener('input', () => this.seek(Number(this.slider.value)));
    this.q<HTMLUListElement>('.db-events').addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
      const ev = li && this.rec?.events[Number(li.dataset.i)];
      if (ev) this.seek(ev.t);
    });

    // Прокрутка мышью или пальцем прямо по графикам.
    const scrub = (e: PointerEvent) => {
      const g = this.geometry();
      const r = this.canvas.getBoundingClientRect();
      this.seek(this.t0 + ((e.clientX - r.left - g.left) / g.pw) * (this.t1 - this.t0));
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      scrub(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) scrub(e);
    });

    el.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'INPUT' && !this.videoAbort) {
        e.preventDefault();
        if (this.isPlaying) this.pause();
        else this.play();
      }
    });

    // Перетаскивание за заголовок — как у остальных окон НСУ.
    const title = this.q<HTMLElement>('.win-title');
    title.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = el.getBoundingClientRect();
      const pr = (el.offsetParent ?? document.body).getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev: PointerEvent) =>
        Object.assign(el.style, { left: `${ev.clientX - dx - pr.left}px`, top: `${ev.clientY - dy - pr.top}px`, right: 'auto', bottom: 'auto' });
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.setRate(1, false);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  get time(): number {
    return this.t;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get rate(): number {
    return this.rateX;
  }

  get recording(): Recording | null {
    return this.rec;
  }

  /** Показать запись (и оценку). Время — в начало записи, onSeek сообщает его хозяину. ctx — план и ёмкость для вывода. */
  show(rec: Recording, assessment?: Assessment, ctx?: ConclusionContext): void {
    if (!rec.samples.length) throw new Error('Запись пуста');
    this.videoAbort?.abort();
    this.pause();
    this.rec = rec;
    this.assessment = assessment;
    this.t0 = rec.samples[0]!.t;
    this.t1 = Math.max(this.t0 + 1e-3, rec.samples[rec.samples.length - 1]!.t);
    this.slider.min = String(this.t0);
    this.slider.max = String(this.t1);
    this.layer = null;
    this.nowEvent = -1;
    this.error(null);
    this.renderText(rec, assessment, ctx);
    this.el.hidden = false;
    this.seek(this.t0);
    this.video.speedAuto = true;
    this.videoStatus(null);
    this.updateVideoPanel();
  }

  hide(): void {
    this.videoAbort?.abort();
    this.pause();
    this.el.hidden = true;
  }

  /**
   * Хозяин 3D-повтора для «Сохранить видео…» (videoExport.ts): seek ставит повтор на момент t,
   * renderFrame рисует кадр нужного размера, begin / end отдают сцену на время записи.
   * null — кнопки видео нет.
   */
  setVideoHost(host: VideoHost | null): void {
    this.videoHost = host;
    this.q<HTMLElement>('[data-db="video"]').hidden = !host;
    if (!host) {
      this.videoAbort?.abort();
      this.q<HTMLElement>('.db-video').hidden = true;
    }
  }

  /** Идёт запись видео. */
  get recordingVideo(): boolean {
    return !!this.videoAbort;
  }

  private setVideoOption(group: string, v: string) {
    if (this.videoAbort) return;
    const o = this.video;
    if (group === 'size' && v in VIDEO_SIZES) o.size = v as VideoSizeId;
    else if (group === 'speed') {
      o.speed = Number(v);
      o.speedAuto = false;
    } else if (group === 'camera') o.camera = v as VideoCamera;
    else if (group === 'range') {
      o.range = v === 'cursor' ? 'cursor' : 'all';
      o.speedAuto = true;
    }
    this.updateVideoPanel();
  }

  /** Участок для видео: весь полёт или от ползунка до конца. */
  private videoRange(): { from: number; to: number } {
    return { from: this.video.range === 'cursor' ? this.t : this.t0, to: this.t1 };
  }

  /** Отметки выбранного, скорость по длительности, формат и длина видео. Кодировщик проверяется один раз на размер. */
  private updateVideoPanel() {
    const p = this.q<HTMLElement>('.db-video');
    if (p.hidden || !this.rec) return;
    const o = this.video;
    const { from, to } = this.videoRange();
    if (o.speedAuto) o.speed = pickSpeed(to - from);
    const chosen: Record<string, string> = { size: o.size, speed: String(o.speed), camera: o.camera, range: o.range };
    p.querySelectorAll<HTMLElement>('.dv-seg').forEach((seg) =>
      seg.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === chosen[seg.dataset.group!])),
    );
    const size = VIDEO_SIZES[o.size];
    const enc = this.encoders.get(o.size);
    if (!enc) {
      void probeEncoder(size.width, size.height).then(
        (c) => {
          this.encoders.set(o.size, c);
          this.updateVideoPanel();
        },
        () => {
          this.encoders.set(o.size, { kind: 'none', label: 'Запись видео в этом браузере недоступна' });
          this.updateVideoPanel();
        },
      );
    }
    const plan = planFrames(from, to, o.speed, VIDEO_FPS, this.assessment ? OUTRO_S : 0);
    const empty = to - from < 0.5;
    this.q<HTMLElement>('.dv-info').textContent = empty
      ? 'Ползунок в конце записи — видео не из чего'
      : `${enc?.label ?? 'Проверяю кодировщик…'} · ${size.width}×${size.height} · ${VIDEO_FPS} к/с · видео ${clock(plan.durationS)}`;
    this.q<HTMLButtonElement>('.dv-go').disabled = !enc || enc.kind === 'none' || empty || !!this.videoAbort;
  }

  private videoStatus(text: string | null, bad = false) {
    const s = this.q<HTMLElement>('.dv-status');
    s.hidden = !text;
    s.textContent = text ?? '';
    s.classList.toggle('bad', bad);
  }

  /** Записать видео по выбранным параметрам. Плеер на паузе; по окончании повтор возвращается на прежний момент. */
  private async saveVideo() {
    const host = this.videoHost;
    const rec = this.rec;
    if (!host || !rec || this.videoAbort) return;
    const o = this.video;
    const { from, to } = this.videoRange();
    const back = this.t;
    this.pause();
    const ctrl = new AbortController();
    this.videoAbort = ctrl;
    const enc = this.encoders.get(o.size);
    const verb = enc?.kind === 'webm' ? 'Записываю' : 'Кодирую';
    const bar = this.q<HTMLElement>('.dv-bar > i');
    const pct = this.q<HTMLElement>('.dv-pct');
    this.el.classList.add('db-rec');
    this.q<HTMLElement>('.dv-progress').hidden = false;
    this.q<HTMLElement>('[data-db="video-cancel"]').hidden = false;
    this.q<HTMLButtonElement>('.dv-go').disabled = true;
    this.videoStatus(null);
    try {
      const v = await recordVideo(
        rec,
        host,
        { size: o.size, speed: o.speed, camera: o.camera, from, to },
        {
          assessment: this.assessment,
          signal: ctrl.signal,
          encoder: enc,
          onProgress: (p) => {
            const n = Math.floor(p.fraction * 100);
            bar.style.width = `${n}%`;
            pct.textContent = p.phase === 'prepare' ? 'Готовлю сцену…' : p.phase === 'finish' ? 'Собираю файл…' : `${verb}… ${n} %`;
            this.setTime(p.t);
          },
        },
      );
      if (this.onVideo) this.onVideo(v);
      else downloadBlob(v.blob, v.fileName);
      const mb = fmt(v.blob.size / 1048576, 1);
      this.videoStatus(`Готово: ${v.fileName} · ${mb} МБ · ${clock(v.durationS)} видео · записано за ${clock(v.elapsedMs / 1000)}`);
    } catch (e) {
      if (isAbortError(e)) this.videoStatus('Запись видео отменена');
      else this.videoStatus(`Видео не записалось: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.videoAbort = null;
      this.el.classList.remove('db-rec');
      this.q<HTMLElement>('.dv-progress').hidden = true;
      this.q<HTMLElement>('[data-db="video-cancel"]').hidden = true;
      bar.style.width = '0';
      // Повтор — на прежний момент (хозяин узнаёт его через onSeek).
      if (this.rec === rec && !this.el.hidden) this.seek(back);
      this.updateVideoPanel();
    }
  }

  /** Время снаружи (например, хозяин сам ведёт повтор). onSeek не вызывается. */
  setTime(t: number): void {
    if (!this.rec) return;
    this.t = Math.min(this.t1, Math.max(this.t0, t));
    this.update();
  }

  play(): void {
    if (!this.rec || this.isPlaying) return;
    if (this.t >= this.t1 - 1e-6) this.seek(this.t0);
    this.isPlaying = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.q<HTMLButtonElement>('.db-play').textContent = '⏸';
    this.onPlayback?.(true, this.rateX);
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    cancelAnimationFrame(this.raf);
    this.q<HTMLButtonElement>('.db-play').textContent = '▶';
    this.onPlayback?.(false, this.rateX);
  }

  setRate(rate: number, notify = true): void {
    this.rateX = rate;
    this.el.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === rate));
    if (notify) this.onPlayback?.(this.isPlaying, rate);
  }

  private readonly frame = (now: number) => {
    if (!this.isPlaying) return;
    // Длинный кадр (вкладка в фоне) не должен перепрыгивать полёт.
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const t = this.t + dt * this.rateX;
    if (t >= this.t1) {
      this.seek(this.t1);
      this.pause();
      return;
    }
    this.seek(t);
    this.raf = requestAnimationFrame(this.frame);
  };

  private seek(t: number) {
    this.setTime(t);
    if (this.rec) this.onSeek?.(this.t);
  }

  private q<T extends Element>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  private error(text: string | null) {
    const e = this.q<HTMLElement>('.db-error');
    e.hidden = !text;
    e.textContent = text ?? '';
  }

  /** Текстовые части окна: заголовок, вывод, итоги, оценка, события, легенда. */
  private renderText(rec: Recording, a?: Assessment, ctx?: ConclusionContext) {
    const m = rec.meta;
    this.q<HTMLElement>('.db-title').textContent = `Разбор полёта — ${m.title}`;
    const d = new Date(m.startedAt);
    const when = Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
    this.q<HTMLElement>('.db-meta').textContent = [m.source === 'log' ? 'бортовой журнал' : 'симулятор', m.profileTitle, when]
      .filter(Boolean)
      .join(' · ');
    this.q<HTMLElement>('.db-conclusion').textContent = flightConclusion({ rec, assessment: a, ...ctx });

    const s = summarize(rec);
    const dist = s.distanceM >= 1000 ? `${fmt(s.distanceM / 1000, 1)} км` : `${fmt(s.distanceM)} м`;
    const td = s.touchdown;
    const landing = !td
      ? 'не было'
      : td.crashed
        ? `авария на T+${fmtClock(td.t)}`
        : s.landingMissM !== null
          ? `промах ${fmt(s.landingMissM)} м`
          : `T+${fmtClock(td.t)}`;
    const rows: [string, string][] = [
      ['Длительность', `${fmtClock(s.durationS)}${s.airborneS ? ` · в воздухе ${fmtClock(s.airborneS)}` : ''}`],
      ['Путь', dist],
      ['Энергия', `${fmt(s.energyWh)} Вт·ч`],
      ['Мин. заряд', `${fmt(s.minSoc * 100)} %`],
      ['Макс. крен', `${fmt(s.maxBankDeg)}°`],
      ['Макс. высота', `${fmt(s.maxAglM)} м`],
      ['Макс. приборная', `${fmt(s.maxIasMs, 1)} м/с`],
      ['Посадка', landing],
    ];
    this.q<HTMLElement>('.db-sum').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');

    const sec = this.q<HTMLElement>('.db-assess-sec');
    sec.hidden = !a;
    if (a) {
      const cls = a.total >= 85 ? 'good' : a.total >= 50 ? 'warn' : 'bad';
      const pts = (x: number) => fmt(x, Number.isInteger(x) ? 0 : 1);
      this.q<HTMLElement>('.db-assess').innerHTML = `
        <div class="verdict ${cls}"><b>${a.total} из 100</b> — ${esc(a.grade)}</div>
        <table class="kv db-items">${a.items
          .map((i) => {
            const c = i.max === 0 ? 'bad' : i.points >= 0.8 * i.max ? 'good' : i.points < 0.5 * i.max ? 'bad' : '';
            return `<tr class="${c}"><td>${esc(i.title)}<small>${esc(i.note)}</small></td><td>${pts(i.points)}${i.max ? ` / ${i.max}` : ''}</td></tr>`;
          })
          .join('')}</table>`;
    }

    this.q<HTMLElement>('.db-evn').textContent = `(${rec.events.length})`;
    this.q<HTMLElement>('.db-events').innerHTML = rec.events
      .map((e, i) => `<li class="${esc(e.kind ?? 'info')}" data-i="${i}">T+${fmtClock(e.t)}  ${esc(e.text)}</li>`)
      .join('');

    const groups = new Set(rec.samples.map((x) => GROUP_OF[x.mode]).filter((g): g is Group => !!g));
    this.q<HTMLElement>('.db-legend').innerHTML = (Object.keys(GROUP_TITLE) as Group[])
      .filter((g) => groups.has(g))
      .map((g) => `<span><i style="background:${GROUP_COLOR[g]}"></i>${GROUP_TITLE[g]}</span>`)
      .join('');
  }

  /** Всё, что зависит от текущего времени. */
  private update() {
    const rec = this.rec;
    if (!rec) return;
    this.slider.value = String(this.t);
    this.q<HTMLElement>('.db-time').textContent = `T+${fmtClock(this.t)} / ${fmtClock(this.t1)}`;
    const s = stateAt(rec, this.t);
    const e0 = rec.samples[0]!.energyWh;
    const vz = `${s.vzMs > 0.05 ? '+' : ''}${fmt(s.vzMs, 1)}`;
    this.q<HTMLElement>('.db-now').innerHTML = `
      <dt>Режим</dt><dd class="mode">${esc(MODE_NAMES[s.mode as keyof typeof MODE_NAMES] ?? s.mode)}</dd>
      <dt>Высота</dt><dd>${fmt(s.aglM)} м</dd><dt>Верт.</dt><dd>${vz} м/с</dd>
      <dt>Приборная</dt><dd>${fmt(s.iasMs, 1)} м/с</dd><dt>Путевая</dt><dd>${fmt(s.gsMs, 1)} м/с</dd>
      <dt>Мощность</dt><dd>${fmt(s.powerW)} Вт</dd><dt>Заряд</dt><dd>${fmt(s.soc * 100)} %</dd>
      <dt>Расход</dt><dd>${fmt(s.energyWh - e0)} Вт·ч</dd><dt>Крен / курс</dt><dd>${fmt(s.bankDeg)}° / ${fmt(s.headingDeg)}°</dd>`;

    // Подсветить последнее событие до текущего момента.
    let i = -1;
    rec.events.forEach((e, k) => {
      if (e.t <= this.t + 1e-6) i = k;
    });
    if (i !== this.nowEvent) {
      const list = this.q<HTMLElement>('.db-events');
      list.querySelector('li.now')?.classList.remove('now');
      if (i >= 0) list.querySelector(`li[data-i="${i}"]`)?.classList.add('now');
      this.nowEvent = i;
    }
    this.draw();
  }

  private geometry(): Geometry {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const left = 34;
    const right = 8;
    const top = 12;
    const bottom = 16;
    const gap = 5;
    const n = PANES.length;
    return { left, right, top, bottom, gap, w, h, pw: Math.max(10, w - left - right), ph: Math.max(10, (h - top - bottom - gap * (n - 1)) / n) };
  }

  private xOf(t: number, g: Geometry) {
    return g.left + ((t - this.t0) / (this.t1 - this.t0)) * g.pw;
  }

  private draw() {
    const rec = this.rec;
    if (!rec || this.el.hidden) return;
    const g = this.geometry();
    if (g.w < 20 || g.h < 60) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(g.w * dpr);
    const H = Math.round(g.h * dpr);
    const key = `${W}×${H}@${dpr}`;
    if (!this.layer || key !== this.layerKey) {
      this.layer = this.renderStatic(rec, g, dpr, W, H);
      this.layerKey = key;
    }
    const c = this.canvas;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Курсор и точки текущих значений.
    const crisp = (v: number, lw: number) => {
      const dev = Math.round(v * dpr);
      return (Math.round(lw * dpr) % 2 ? dev + 0.5 : dev) / dpr;
    };
    const x = crisp(this.xOf(this.t, g), 1);
    ctx.strokeStyle = '#ff8a1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, g.h - g.bottom);
    ctx.stroke();
    const s = stateAt(rec, this.t);
    PANES.forEach((p, i) => {
      const r = this.ranges[i];
      if (!r) return;
      for (const ser of p.series) {
        const v = s[ser.key] * ser.k;
        const y = r.y1 - ((v - r.min) / (r.max - r.min)) * (r.y1 - r.y0);
        ctx.beginPath();
        ctx.arc(x, Math.min(r.y1, Math.max(r.y0, y)), 2.6, 0, Math.PI * 2);
        ctx.fillStyle = ser.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  }

  /** Неподвижная часть графиков: панели, полосы режимов, ряды, события, шкала времени. */
  private renderStatic(rec: Recording, g: Geometry, dpr: number, W: number, H: number): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const crisp = (v: number, lw: number) => {
      const dev = Math.round(v * dpr);
      return (Math.round(lw * dpr) % 2 ? dev + 0.5 : dev) / dpr;
    };
    const samples = rec.samples;
    const x = (t: number) => this.xOf(t, g);
    const bottomY = g.top + PANES.length * g.ph + (PANES.length - 1) * g.gap;

    // Участки режимов.
    const runs: { group: Group; a: number; b: number }[] = [];
    for (let i = 0; i < samples.length; i++) {
      const gr = GROUP_OF[samples[i]!.mode];
      const tA = samples[i]!.t;
      const tB = samples[i + 1]?.t ?? tA;
      const last = runs[runs.length - 1];
      if (!gr) continue;
      if (last && last.group === gr && Math.abs(last.b - tA) < 1e-6) last.b = tB;
      else runs.push({ group: gr, a: tA, b: tB });
    }
    for (const r of runs) {
      c.fillStyle = GROUP_COLOR[r.group];
      c.fillRect(x(r.a), 2, Math.max(1 / dpr, x(r.b) - x(r.a)), 6);
    }

    c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    this.ranges = [];
    // Прореживание рядов: не больше двух точек (минимум и максимум) на экранный пиксель.
    const step = Math.max(1, Math.floor(samples.length / (g.pw * dpr)));
    PANES.forEach((p, i) => {
      const y0 = g.top + i * (g.ph + g.gap);
      const y1 = y0 + g.ph;
      let dataMax = 0;
      let dataMin = 0;
      for (const s of samples)
        for (const ser of p.series) {
          const v = s[ser.key] * ser.k;
          if (v > dataMax) dataMax = v;
          if (v < dataMin) dataMin = v;
        }
      const max = p.fixedMax ?? niceMax(dataMax);
      const min = dataMin < 0 ? -niceMax(-dataMin) : 0;
      this.ranges.push({ min, max, y0, y1 });
      const y = (v: number) => y1 - ((v - min) / (max - min)) * g.ph;

      c.fillStyle = '#fff';
      c.fillRect(g.left, y0, g.pw, g.ph);
      c.globalAlpha = 0.14;
      for (const r of runs) {
        c.fillStyle = GROUP_COLOR[r.group];
        c.fillRect(x(r.a), y0, Math.max(1 / dpr, x(r.b) - x(r.a)), g.ph);
      }
      c.globalAlpha = 1;

      // Середина шкалы и ноль, если шкала уходит в минус.
      c.strokeStyle = '#e4e4e4';
      c.lineWidth = 1;
      c.beginPath();
      for (const v of [(min + max) / 2, ...(min < 0 ? [0] : [])]) {
        const yy = crisp(y(v), 1);
        c.moveTo(g.left, yy);
        c.lineTo(g.left + g.pw, yy);
      }
      c.stroke();

      c.save();
      c.beginPath();
      c.rect(g.left, y0, g.pw, g.ph);
      c.clip();
      c.lineWidth = 1.4;
      c.lineJoin = 'round';
      for (const ser of p.series) {
        c.strokeStyle = ser.color;
        c.beginPath();
        for (let k = 0; k < samples.length; k += step) {
          const end = Math.min(samples.length, k + step);
          let lo = k;
          let hi = k;
          for (let j = k; j < end; j++) {
            if (samples[j]![ser.key] < samples[lo]![ser.key]) lo = j;
            if (samples[j]![ser.key] > samples[hi]![ser.key]) hi = j;
          }
          for (const j of lo <= hi ? [lo, hi] : [hi, lo]) {
            const px = x(samples[j]!.t);
            const py = y(samples[j]![ser.key] * ser.k);
            if (k === 0 && j === (lo <= hi ? lo : hi)) c.moveTo(px, py);
            else c.lineTo(px, py);
          }
        }
        c.stroke();
      }
      c.restore();

      c.strokeStyle = '#c4c4c4';
      c.lineWidth = 1;
      c.strokeRect(crisp(g.left, 1), crisp(y0, 1), Math.round(g.pw * dpr) / dpr, Math.round(g.ph * dpr) / dpr);

      // Шкала слева, название и легенда внутри панели.
      c.fillStyle = '#5f6b76';
      c.textAlign = 'right';
      c.textBaseline = 'top';
      c.fillText(fmt(max, max < 10 && !Number.isInteger(max) ? 1 : 0), g.left - 4, y0);
      c.textBaseline = 'bottom';
      c.fillText(fmt(min, 0), g.left - 4, y1 + 1);
      c.textAlign = 'left';
      c.textBaseline = 'top';
      const label = `${p.title}, ${p.unit}`;
      let lx = g.left + 4;
      const put = (text: string, color: string, bold: boolean) => {
        c.font = `${bold ? '600 ' : ''}10px system-ui, -apple-system, "Segoe UI", sans-serif`;
        const w = c.measureText(text).width;
        c.fillStyle = 'rgba(255,255,255,0.82)';
        c.fillRect(lx - 2, y0 + 1, w + 4, 12);
        c.fillStyle = color;
        c.fillText(text, lx, y0 + 2);
        lx += w + 8;
      };
      put(label, '#1f2328', true);
      if (p.series.length > 1) for (const ser of p.series) put(ser.label, ser.color, false);
    });
    c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';

    // События: предупреждения, отказы и команды — линией через все панели, прочие — риской в полосе режимов.
    for (const e of rec.events) {
      const xx = crisp(x(e.t), 1);
      const color = EVENT_COLOR[e.kind ?? ''];
      c.lineWidth = 1;
      c.beginPath();
      if (color) {
        c.strokeStyle = color;
        c.globalAlpha = 0.85;
        c.moveTo(xx, 1);
        c.lineTo(xx, bottomY);
      } else {
        c.strokeStyle = '#1f2328';
        c.globalAlpha = 0.35;
        c.moveTo(xx, 0);
        c.lineTo(xx, 10);
      }
      c.stroke();
      c.globalAlpha = 1;
    }

    // Шкала времени.
    const span = this.t1 - this.t0;
    const ts = timeStep(span, g.pw);
    c.fillStyle = '#5f6b76';
    c.strokeStyle = '#9aa3ab';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.beginPath();
    for (let t = Math.ceil(this.t0 / ts) * ts; t <= this.t1 + 1e-6; t += ts) {
      const xx = crisp(x(t), 1);
      c.moveTo(xx, bottomY);
      c.lineTo(xx, bottomY + 3);
      c.fillText(fmtClock(t), Math.min(g.w - 14, Math.max(g.left + 10, xx)), bottomY + 4);
    }
    c.stroke();
    return cv;
  }
}
