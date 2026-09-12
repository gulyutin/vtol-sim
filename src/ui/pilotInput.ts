import type { Stick } from '../sim/flight';

export type { Stick };

/*
 * Ручки ПДУ для «Фэйлсейфа»: геймпад (стандартная раскладка, режим 2 — левый стик газ и
 * рыскание, правый — тангаж и крен) или, если геймпада нет, клавиатура: W/S — газ, A/D —
 * рыскание, стрелки — тангаж и крен. Самоцентрирующийся стик газа — это «держать высоту»:
 * в симуляторе газ 0 значит держать, а не выключить (Controls.stick в flight.ts).
 */

export interface PilotInputOptions {
  /** Мёртвая зона стиков, доля хода. */
  deadzone?: number;
  /** Экспонента 0…1: больше — мягче у центра, тот же полный ход. */
  expo?: number;
  /** Как быстро клавиша доводит ручку до упора, доля хода в секунду. */
  keyboardRate?: number;
}

type Axis = keyof Stick;

const ZERO: Stick = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
/** Клавиша → ось и направление. Коды физических клавиш: раскладка (русская) не мешает. */
const KEYS: Record<string, [Axis, number]> = {
  KeyW: ['throttle', 1],
  KeyS: ['throttle', -1],
  KeyA: ['yaw', -1],
  KeyD: ['yaw', 1],
  ArrowUp: ['pitch', 1],
  ArrowDown: ['pitch', -1],
  ArrowLeft: ['roll', -1],
  ArrowRight: ['roll', 1],
};

/** Ввод в поле, список, редактор — клавиши его, не пульта. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export class PilotInput {
  private readonly deadzone: number;
  private readonly expo: number;
  private readonly rate: number;
  private readonly pressed = new Set<string>();
  private kbOn = false;
  private kb: Stick = { ...ZERO };
  private lastT: number | null = null;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.kbOn || !(e.code in KEYS) || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    this.pressed.add(e.code);
    // Стрелки иначе прокручивают страницу.
    e.preventDefault();
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.pressed.delete(e.code);
  };
  /** Окно потеряло фокус — отпущенные там клавиши сюда не придут. */
  private readonly onBlur = () => this.pressed.clear();

  constructor(opts: PilotInputOptions = {}) {
    this.deadzone = opts.deadzone ?? 0.08;
    this.expo = opts.expo ?? 0.3;
    this.rate = opts.keyboardRate ?? 2.5;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Подключён ли геймпад. */
  get connected(): boolean {
    return this.pad() !== null;
  }

  /** Откуда сейчас берутся ручки. */
  get source(): 'gamepad' | 'keyboard' | null {
    return this.connected ? 'gamepad' : this.kbOn ? 'keyboard' : null;
  }

  /** Клавиатура как пульт — только когда пилот держит ПДУ, чтобы не отнимать клавиши у интерфейса. */
  enableKeyboard(on: boolean): void {
    this.kbOn = on;
    if (!on) {
      this.pressed.clear();
      this.kb = { ...ZERO };
    }
  }

  /** Положение ручек сейчас — звать раз в кадр. null — пульта нет (ни геймпада, ни клавиатуры). */
  poll(): Stick | null {
    const now = performance.now();
    const dt = this.lastT === null ? 0 : Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    const pad = this.pad();
    if (pad) {
      const ax = (i: number) => this.shape(pad.axes[i] ?? 0);
      // Режим 2; вверх по оси геймпада — минус.
      return { yaw: ax(0), throttle: -ax(1), roll: ax(2), pitch: -ax(3) };
    }
    if (!this.kbOn) return null;
    for (const axis of Object.keys(ZERO) as Axis[]) {
      let goal = 0;
      for (const code of this.pressed) {
        const [a, dir] = KEYS[code]!;
        if (a === axis) goal += dir;
      }
      goal = Math.max(-1, Math.min(1, goal));
      // Клавиша ведёт ручку плавно; отпущенная возвращается к центру вдвое быстрее.
      const step = (goal === 0 ? 2 : 1) * this.rate * dt;
      const v = this.kb[axis];
      this.kb[axis] = v + Math.max(-step, Math.min(step, goal - v));
    }
    return { ...this.kb };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
  }

  private pad(): Gamepad | null {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let any: Gamepad | null = null;
    for (const p of pads) {
      if (!p || !p.connected || p.axes.length < 4) continue;
      if (p.mapping === 'standard') return p;
      any ??= p;
    }
    return any;
  }

  /** Мёртвая зона с перенормировкой хода и экспонента. */
  private shape(x: number): number {
    const a = Math.abs(x);
    if (a <= this.deadzone) return 0;
    const v = Math.min(1, (a - this.deadzone) / (1 - this.deadzone));
    return Math.sign(x) * ((1 - this.expo) * v + this.expo * v * v * v);
  }
}
