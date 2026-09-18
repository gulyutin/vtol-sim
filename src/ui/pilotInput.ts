import { axisValue, defaultMapping, type AxisMap, type RcMapping } from '../game/rcMapping';
import type { Stick } from '../sim/flight';

export { axisValue, defaultMapping, type AxisMap, type RcMapping };

export type { Stick };

/*
 * Ручки ПДУ для «Фэйлсейфа»: геймпад или настоящий пульт по USB (EdgeTX/OpenTX в режиме
 * джойстика), если его нет — клавиатура: W/S — газ, A/D — рыскание, стрелки — тангаж и крен.
 * Какая ось пульта — какая ручка, инверсия и калибровка хода — раскладка (RcMapping), своя у
 * каждого пульта, хранится в браузере. По умолчанию: у геймпада стандартной раскладки — режим 2
 * (левый стик газ и рыскание, правый — тангаж и крен), у пульта — AETR (крен, тангаж, газ,
 * рыскание — оси 0…3). Середина хода газа — это «держать высоту»: в симуляторе газ 0 значит
 * держать, а не выключить (Controls.stick в flight.ts).
 */

const STORE = 'vtol-rc-mapping:';

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
  private map: { id: string; m: RcMapping } | null = null;

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
      const m = this.mappingFor(pad);
      const ax = (a: AxisMap) => this.shape(axisValue(pad.axes[a.index] ?? 0, a), m);
      return { roll: ax(m.roll), pitch: ax(m.pitch), yaw: ax(m.yaw), throttle: ax(m.throttle) };
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

  /** Пульт сейчас: имя, сырые оси, стандартная ли раскладка; null — не подключён. */
  device(): { id: string; axes: readonly number[]; standard: boolean } | null {
    const p = this.pad();
    return p ? { id: p.id, axes: p.axes, standard: p.mapping === 'standard' } : null;
  }

  /** Раскладка подключённого пульта (сохранённая или по умолчанию); null — пульта нет. */
  mapping(): RcMapping | null {
    const p = this.pad();
    return p ? this.mappingFor(p) : null;
  }

  /** Сохранить раскладку подключённого пульта; null — вернуть раскладку по умолчанию. */
  setMapping(m: RcMapping | null): void {
    const p = this.pad();
    if (!p) return;
    try {
      if (m) localStorage.setItem(STORE + p.id, JSON.stringify(m));
      else localStorage.removeItem(STORE + p.id);
    } catch {
      // Хранилище недоступно — раскладка живёт до перезагрузки.
    }
    this.map = { id: p.id, m: m ?? defaultMapping(p.mapping === 'standard') };
  }

  private mappingFor(p: Gamepad): RcMapping {
    if (this.map?.id === p.id) return this.map.m;
    let m = defaultMapping(p.mapping === 'standard');
    try {
      const s = localStorage.getItem(STORE + p.id);
      if (s) m = { ...m, ...(JSON.parse(s) as Partial<RcMapping>) };
    } catch {
      // Нет хранилища или испорчено — по умолчанию.
    }
    this.map = { id: p.id, m };
    return m;
  }

  /** Мёртвая зона с перенормировкой хода и экспонента. */
  private shape(x: number, m?: { deadzone: number; expo: number }): number {
    const dz = m?.deadzone ?? this.deadzone;
    const ex = m?.expo ?? this.expo;
    const a = Math.abs(x);
    if (a <= dz) return 0;
    const v = Math.min(1, (a - dz) / (1 - dz));
    return Math.sign(x) * ((1 - ex) * v + ex * v * v * v);
  }
}
