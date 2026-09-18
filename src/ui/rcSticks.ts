import type { Stick } from '../sim/flight';

/*
 * Экранный пульт: два стика по «моде 2» — левый: газ (вверх — набор или быстрее) и курс,
 * правый: тангаж (вверх — ручка от себя) и крен. Стик тянут мышью (или пальцем); отпущенный —
 * возвращается в центр. Когда стики не держат, пульт показывает, куда их отклоняют клавиатура
 * или геймпад. Работает только в ФЭЙЛСЕЙФе — ручном управлении с пульта.
 */

type Side = 'left' | 'right';

const PAD_PX = 110;

/** Захват указателя; указатель уже отпущен — без захвата. */
const capture = (el: Element, id: number) => {
  try {
    el.setPointerCapture(id);
  } catch {
    // Нечего захватывать.
  }
};

export class RcSticks {
  readonly el: HTMLElement;
  private readonly knobs: Record<Side, HTMLElement>;
  private readonly held: Record<Side, { x: number; y: number } | null> = { left: null, right: null };

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'rc-sticks';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="rc-title">Пульт · ФЭЙЛСЕЙФ</div>
      <div class="rc-pads">
        <div class="rc-pad" data-side="left" title="Газ (вверх — набор) и курс"><i></i><b></b><span>газ · курс</span></div>
        <div class="rc-pad" data-side="right" title="Тангаж (вверх — от себя) и крен"><i></i><b></b><span>тангаж · крен</span></div>
      </div>
      <div class="rc-hint">мышью — тянуть стик · клавиатура: W/S газ, A/D курс, стрелки — тангаж и крен</div>`;
    parent.appendChild(this.el);
    const pad = (side: Side) => this.el.querySelector<HTMLElement>(`.rc-pad[data-side="${side}"]`)!;
    this.knobs = { left: pad('left').querySelector('b')!, right: pad('right').querySelector('b')! };
    for (const side of ['left', 'right'] as const) {
      const p = pad(side);
      const at = (e: PointerEvent) => {
        const b = p.getBoundingClientRect();
        const clamp = (v: number) => Math.max(-1, Math.min(1, v));
        return { x: clamp(((e.clientX - b.left) / b.width) * 2 - 1), y: clamp(-(((e.clientY - b.top) / b.height) * 2 - 1)) };
      };
      p.addEventListener('pointerdown', (e) => {
        capture(p, e.pointerId);
        this.held[side] = at(e);
        e.preventDefault();
      });
      p.addEventListener('pointermove', (e) => {
        if (this.held[side]) this.held[side] = at(e);
      });
      const release = () => (this.held[side] = null);
      p.addEventListener('pointerup', release);
      p.addEventListener('pointercancel', release);
    }
  }

  show(on: boolean) {
    this.el.hidden = !on;
    if (!on) this.held.left = this.held.right = null;
  }

  /** Стик с учётом мыши: оси удерживаемого мышью стика заменяют клавиатуру и геймпад. */
  merge(base: Stick | null): Stick {
    const s: Stick = base ? { ...base } : { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    const l = this.held.left;
    const r = this.held.right;
    if (l) {
      s.yaw = l.x;
      s.throttle = l.y;
    }
    if (r) {
      s.roll = r.x;
      s.pitch = r.y;
    }
    return s;
  }

  /** Положение ручек на экране. */
  display(s: Stick) {
    const put = (el: HTMLElement, x: number, y: number) => {
      const half = PAD_PX / 2 - 13;
      el.style.transform = `translate(${(x * half).toFixed(1)}px, ${(-y * half).toFixed(1)}px)`;
    };
    put(this.knobs.left, s.yaw, s.throttle);
    put(this.knobs.right, s.roll, s.pitch);
  }

  dispose() {
    this.el.remove();
  }
}
