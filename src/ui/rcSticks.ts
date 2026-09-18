import type { Stick } from '../sim/flight';

/*
 * Экранный пульт: два стика по «моде 2» — левый: газ (вверх — набор или быстрее) и курс,
 * правый: тангаж (вверх — ручка от себя) и крен. Стик тянут мышью (или пальцем); отпущенный —
 * возвращается в центр. Когда стики не держат, пульт показывает, куда их отклоняют клавиатура
 * или геймпад. Работает только в ФЭЙЛСЕЙФе — ручном управлении с пульта. Кнопка «Пульт» на
 * 3D-виде показывает пульт и вне ФЭЙЛСЕЙФа — проверить, как ходят ручки подключённого пульта, и
 * одной кнопкой взять управление.
 */

export interface RcSticksHandlers {
  /** «Взять управление»: перейти в ФЭЙЛСЕЙФ. */
  onTake(): void;
  /** Настройка пульта по USB — окно «Пульт ДУ». */
  onSetup(): void;
}

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
  private readonly launcher: HTMLButtonElement;
  /** Пульт показан кнопкой «Пульт» (не только в ФЭЙЛСЕЙФе). */
  userShown = false;

  constructor(parent: HTMLElement, h: RcSticksHandlers) {
    this.launcher = document.createElement('button');
    this.launcher.className = 'gimbal-btn rc-btn';
    this.launcher.textContent = '🎮 Пульт';
    this.launcher.title = 'Показать пульт: экранные ручки и пульт по USB; управление с пульта — в ФЭЙЛСЕЙФе';
    this.launcher.addEventListener('click', () => {
      this.userShown = !this.userShown;
      this.launcher.classList.toggle('on', this.userShown);
    });
    parent.appendChild(this.launcher);
    this.el = document.createElement('div');
    this.el.className = 'rc-sticks';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="rc-title">Пульт · ФЭЙЛСЕЙФ</div>
      <div class="rc-take"><button data-rc="take" title="Перейти в ФЭЙЛСЕЙФ: управление с пульта">Взять управление</button><button data-rc="setup" title="Пульт по USB: оси, инверсия, калибровка">⚙</button></div>
      <div class="rc-pads">
        <div class="rc-pad" data-side="left" title="Газ (вверх — набор) и курс"><i></i><b></b><span>газ · курс</span></div>
        <div class="rc-pad" data-side="right" title="Тангаж (вверх — от себя) и крен"><i></i><b></b><span>тангаж · крен</span></div>
      </div>
      <div class="rc-hint">мышью — тянуть стик · клавиатура: W/S газ, A/D курс, стрелки — тангаж и крен</div>`;
    parent.appendChild(this.el);
    this.el.querySelector('[data-rc="take"]')!.addEventListener('click', () => h.onTake());
    this.el.querySelector('[data-rc="setup"]')!.addEventListener('click', () => h.onSetup());
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

  /**
   * Показать пульт: manual — идёт ФЭЙЛСЕЙФ (ручки управляют); иначе пульт виден, если его показали
   * кнопкой, ручки только показываются. source — откуда ручки: пульт по USB, клавиатура или мышь.
   */
  show(manual: boolean, source: string | null = null, canTake = false) {
    const on = manual || this.userShown;
    this.el.hidden = !on;
    if (!on) {
      this.held.left = this.held.right = null;
      return;
    }
    this.el.querySelector('.rc-title')!.textContent = manual ? `Пульт · ФЭЙЛСЕЙФ${source ? ` · ${source}` : ''}` : `Пульт · только показ${source ? ` · ${source}` : ''}`;
    const take = this.el.querySelector<HTMLButtonElement>('[data-rc="take"]')!;
    take.hidden = manual;
    take.disabled = !canTake;
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
