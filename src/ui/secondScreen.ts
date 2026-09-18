import { osdText, type OsdData } from './videoLink';

/*
 * Второй монитор, как на рабочем месте расчёта: отдельное окно браузера с видео подвеса (в полном
 * разрешении, с задержкой и помехами радиолинии и служебной информацией) или с 3D-видом. Окно
 * перетаскивают на второй экран и разворачивают двойным щелчком. Кадр копируется с холста
 * 3D-вида сразу после отрисовки (в том же кадре — буфер холста ещё цел).
 */

export type ScreenMode = 'gimbal' | 'view';

export class SecondScreen {
  private win: Window | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private note: HTMLElement | null = null;
  mode: ScreenMode = 'gimbal';

  get open(): boolean {
    return !!this.win && !this.win.closed;
  }

  toggle(): void {
    if (this.open) {
      this.win!.close();
      this.win = null;
      return;
    }
    const w = window.open('', 'vtol-screen2', 'popup,width=1280,height=760');
    if (!w) {
      alert('Браузер не дал открыть окно — разрешите всплывающие окна для этого сайта.');
      return;
    }
    this.win = w;
    const d = w.document;
    d.title = 'Второй экран — видео подвеса';
    d.body.innerHTML = `
      <style>
        html, body { margin: 0; height: 100%; background: #0b0d10; overflow: hidden; font: 13px system-ui, sans-serif; color: #d7dde4; }
        canvas { display: block; width: 100vw; height: 100vh; }
        .bar { position: fixed; top: 8px; left: 8px; display: flex; gap: 6px; opacity: 0.25; transition: opacity 0.2s; }
        .bar:hover { opacity: 1; }
        button { padding: 3px 10px; border: 1px solid #46505c; border-radius: 4px; background: rgba(30, 36, 43, 0.9); color: inherit; font: inherit; cursor: pointer; }
        button.on { border-color: #ffd43b; color: #ffd43b; }
        .note { position: fixed; inset: 0; display: grid; place-items: center; color: #8b97a3; pointer-events: none; }
      </style>
      <canvas></canvas>
      <div class="note">Видео подвеса появится, когда аппарат в воздухе и окно камеры включено</div>
      <div class="bar"><button data-m="gimbal">Видео подвеса</button><button data-m="view">3D-вид</button><button data-m="full">Во весь экран</button></div>`;
    this.canvas = d.querySelector('canvas');
    this.ctx = this.canvas!.getContext('2d');
    this.note = d.querySelector('.note');
    const sync = () => {
      d.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === this.mode));
      d.title = this.mode === 'gimbal' ? 'Второй экран — видео подвеса' : 'Второй экран — 3D-вид';
    };
    d.querySelector('.bar')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-m]');
      if (!b) return;
      if (b.dataset.m === 'full') void d.documentElement.requestFullscreen?.();
      else this.mode = b.dataset.m as ScreenMode;
      sync();
    });
    this.canvas!.addEventListener('dblclick', () => (d.fullscreenElement ? void d.exitFullscreen() : void d.documentElement.requestFullscreen?.()));
    sync();
  }

  /** Нечего показать (подвес выключен): надпись вместо кадра. */
  idle(text: string): void {
    if (!this.open || !this.note) return;
    this.note.hidden = false;
    this.note.textContent = text;
    this.ctx?.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
  }

  /**
   * Кадр с холста src: rect — CSS-пиксели от левого верхнего угла холста; вписывается в окно
   * с сохранением пропорций; osd — служебная информация видео (для 3D-вида — null).
   */
  present(src: HTMLCanvasElement, rect: { x: number; y: number; width: number; height: number }, osd: OsdData | null): void {
    const w = this.win;
    const c = this.canvas;
    const g = this.ctx;
    if (!w || w.closed || !c || !g) return;
    if (this.note) this.note.hidden = true;
    const dpr = w.devicePixelRatio || 1;
    const W = Math.round(w.innerWidth * dpr);
    const H = Math.round(w.innerHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const k = src.width / Math.max(1, src.clientWidth);
    const sw = rect.width * k;
    const sh = rect.height * k;
    const s = Math.min(W / sw, H / sh);
    const dw = sw * s;
    const dh = sh * s;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    g.fillStyle = '#0b0d10';
    g.fillRect(0, 0, W, H);
    g.drawImage(src, rect.x * k, rect.y * k, sw, sh, dx, dy, dw, dh);
    if (!osd) return;
    // Служебная информация — белым с тенью по углам кадра, как вшивает борт.
    const t = osdText(osd);
    const fs = Math.max(12, Math.round(dh / 40));
    g.font = `600 ${fs}px ui-monospace, Menlo, monospace`;
    g.fillStyle = '#f4fff4';
    g.shadowColor = '#000';
    g.shadowBlur = 3;
    const pad = fs * 0.8;
    const lines = (text: string, x: number, y: number, align: CanvasTextAlign, fromBottom: boolean) => {
      const ls = text.split('\n');
      g.textAlign = align;
      ls.forEach((l, i) => g.fillText(l, x, fromBottom ? y - (ls.length - 1 - i) * fs * 1.3 : y + i * fs * 1.3));
    };
    lines(t.tl, dx + pad, dy + pad + fs, 'left', false);
    lines(t.tr, dx + dw - pad, dy + pad + fs, 'right', false);
    lines(t.bl, dx + pad, dy + dh - pad, 'left', true);
    lines(t.br, dx + dw - pad, dy + dh - pad, 'right', true);
    // Перекрестие в центре.
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255, 70, 70, 0.9)';
    g.lineWidth = Math.max(1, dpr);
    const cx = dx + dw / 2;
    const cy = dy + dh / 2;
    const r = fs * 1.2;
    g.strokeRect(cx - r, cy - r, 2 * r, 2 * r);
    if (osd.frozen) {
      g.font = `700 ${fs * 1.6}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = '#ff8787';
      g.fillText('НЕТ ВИДЕО', cx, cy - r * 2);
    }
    g.shadowBlur = 0;
  }
}
