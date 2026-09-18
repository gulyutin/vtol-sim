import * as THREE from 'three';
import { THERMAL_PALETTES, type ThermalPalette } from './thermal';

/*
 * Камера на подвесе: азимут относительно носа, наклон ниже горизонта и зум; сопровождение —
 * подвес держит точку на земле или движущуюся цель, пока аппарат летит. Окно подвеса — рамка
 * .pip под 3D-видом: перетаскивание поворачивает подвес, колёсико — зум, кнопки — во весь экран,
 * ИК или дневной канал, сопровождение, сброс. Сам кадр рисует World (renderPip / renderThermal).
 * Координаты — локальные метры от площадки: восток, север, up — над уровнем площадки.
 */

const DEG = Math.PI / 180;

/** Захват указателя; указатель уже отпущен — без захвата. */
const capture = (el: Element, id: number) => {
  try {
    el.setPointerCapture(id);
  } catch {
    // Нечего захватывать.
  }
};
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export interface Point3 {
  east: number;
  north: number;
  up: number;
}

/** Сопровождение: точка на земле или цель по номеру (её место спрашивается каждый кадр). */
export type GimbalTrack = { kind: 'point'; p: Point3 } | { kind: 'body'; id: string };

export interface GimbalFrame {
  eye: Point3;
  look: Point3;
  up: THREE.Vector3;
  /** Вертикальное поле зрения с зумом, °. */
  fovDeg: number;
  /** Куда смотрит ось камеры: курс, ° от севера, и наклон ниже горизонта, °. */
  headingDeg: number;
  tiltDeg: number;
  zoom: number;
}

/** Пределы подвеса: наклон от чуть выше горизонта до отвесно вниз, зум. */
export const GIMBAL_TILT: readonly [number, number] = [-10, 90];
export const GIMBAL_ZOOM: readonly [number, number] = [1, 20];
/** Камера под фюзеляжем — чуть ниже центра аппарата, м. */
const CAMERA_BELOW_M = 0.4;

export class Gimbal {
  panDeg = 0;
  tiltDeg = 45;
  zoom = 1;
  track: GimbalTrack | null = null;

  reset(tiltDeg: number) {
    this.panDeg = 0;
    this.tiltDeg = tiltDeg;
    this.zoom = 1;
    this.track = null;
  }

  /** Поворот подвеса на dPan вправо и dTilt вниз, °; ручной поворот снимает сопровождение. */
  turn(dPan: number, dTilt: number) {
    this.track = null;
    this.panDeg = wrap180(this.panDeg + dPan);
    this.tiltDeg = Math.min(GIMBAL_TILT[1], Math.max(GIMBAL_TILT[0], this.tiltDeg + dTilt));
  }

  zoomBy(k: number) {
    this.zoom = Math.min(GIMBAL_ZOOM[1], Math.max(GIMBAL_ZOOM[0], this.zoom * k));
  }

  /**
   * Кадр подвеса для положения аппарата. baseFovDeg — поле зрения без зума; bodyAt — где сейчас
   * сопровождаемая цель (null — пропала: сопровождение снимается).
   */
  frame(a: { east: number; north: number; up: number; headingDeg: number }, baseFovDeg: number, bodyAt?: (id: string) => Point3 | null): GimbalFrame {
    const eye = { east: a.east, north: a.north, up: a.up - CAMERA_BELOW_M };
    const t = this.track;
    const target = t ? (t.kind === 'point' ? t.p : (bodyAt?.(t.id) ?? null)) : null;
    if (t && !target) this.track = null;
    if (target) {
      // Сопровождение: азимут и наклон — на цель, в пределах подвеса.
      const de = target.east - eye.east;
      const dn = target.north - eye.north;
      const horiz = Math.hypot(de, dn);
      this.panDeg = wrap180(Math.atan2(de, dn) / DEG - a.headingDeg);
      this.tiltDeg = Math.min(GIMBAL_TILT[1], Math.max(GIMBAL_TILT[0], Math.atan2(eye.up - target.up, Math.max(horiz, 0.1)) / DEG));
    }
    const heading = a.headingDeg + this.panDeg;
    const h = heading * DEG;
    const tilt = this.tiltDeg * DEG;
    const d = 100;
    const look = { east: eye.east + Math.sin(h) * Math.cos(tilt) * d, north: eye.north + Math.cos(h) * Math.cos(tilt) * d, up: eye.up - Math.sin(tilt) * d };
    // Почти отвесно вниз — верх кадра по оси камеры, иначе горизонт горизонтален.
    const up = this.tiltDeg > 80 ? new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)) : new THREE.Vector3(0, 1, 0);
    const fovDeg = (2 * Math.atan(Math.tan((baseFovDeg * DEG) / 2) / this.zoom)) / DEG;
    return { eye, look, up, fovDeg, headingDeg: ((heading % 360) + 360) % 360, tiltDeg: this.tiltDeg, zoom: this.zoom };
  }
}

export interface GimbalWindowHandlers {
  /** Щелчок по кадру (не перетаскивание): координаты окна и Shift. */
  onClick(clientX: number, clientY: number, shift: boolean): void;
  /** Переключили канал: ИК или RGB (дневная камера). */
  onChannel?(ir: boolean): void;
}

/**
 * Окно подвеса: управление мышью и панель кнопок поверх кадра. Размер и место кадра — rect():
 * обычно в правом нижнем углу 3D-вида, во весь экран — на весь вид.
 */
export class GimbalWindow {
  full = false;
  ir = true;
  /** Палитра тепловизора. */
  palette: ThermalPalette = 'white';
  /** Щелчок по кадру — сопровождение (иначе — отметка, где отметки есть). */
  trackMode = false;
  private readonly bar: HTMLElement;
  private readonly launcher: HTMLButtonElement;
  private down: { x: number; y: number; id: number; moved: boolean } | null = null;
  private shownDay = false;
  private hasIr = false;
  private marks = false;

  constructor(
    private readonly pip: HTMLElement,
    private readonly view: HTMLElement,
    private readonly gimbal: Gimbal,
    private readonly h: GimbalWindowHandlers,
  ) {
    this.bar = document.createElement('div');
    this.bar.className = 'pip-bar';
    this.bar.innerHTML = `
      <button data-g="full" title="Во весь экран (Esc — обратно)">⤢</button>
      <span class="pip-seg"><button data-g="rgb" title="Дневная камера (RGB)">RGB</button><button data-g="ir" title="Тепловизор">ИК</button></span>
      <button data-g="palette" title="Палитра тепловизора — щелчок переключает">Белый — горячо</button>
      <button data-g="track" title="Щелчок по кадру — сопровождение цели (Shift+щелчок — всегда)">Сопровождение</button>
      <button data-g="reset" title="Подвес вперёд-вниз, зум ×1, без сопровождения">Сброс</button>
      <output></output>`;
    pip.appendChild(this.bar);
    this.bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bar.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      if (b.dataset.g === 'full') this.setFull(!this.full);
      if ((b.dataset.g === 'ir' && !this.ir) || (b.dataset.g === 'rgb' && this.ir)) {
        this.ir = b.dataset.g === 'ir';
        this.h.onChannel?.(this.ir);
      }
      if (b.dataset.g === 'palette') {
        const i = THERMAL_PALETTES.findIndex((p) => p.id === this.palette);
        this.palette = THERMAL_PALETTES[(i + 1) % THERMAL_PALETTES.length]!.id;
      }
      if (b.dataset.g === 'track') this.trackMode = !this.trackMode;
      if (b.dataset.g === 'reset') this.gimbal.reset(this.gimbal.tiltDeg > 60 ? 90 : 30);
      this.sync();
    });
    // Кнопка «Подвес» — показать дневную камеру там, где подвес не включён сам.
    this.launcher = document.createElement('button');
    this.launcher.className = 'gimbal-btn';
    this.launcher.textContent = 'Подвес';
    this.launcher.title = 'Окно камеры на подвесе — дневная (RGB) и тепловизор: поворот — перетаскиванием, зум — колёсиком';
    this.launcher.hidden = true;
    this.launcher.addEventListener('click', () => {
      this.shownDay = !this.shownDay;
      this.sync();
    });
    view.parentElement?.appendChild(this.launcher);

    pip.addEventListener('pointerdown', (e) => {
      if (!pip.classList.contains('gimbal')) return;
      capture(pip, e.pointerId);
      this.down = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    });
    pip.addEventListener('pointermove', (e) => {
      const d = this.down;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      // Градусов на пиксель — по полю зрения кадра: перетаскивание ведёт подвес за курсором.
      const box = pip.getBoundingClientRect();
      const fov = this.lastFovDeg;
      const k = fov / Math.max(1, box.height);
      this.gimbal.turn(dx * k, dy * k);
      d.x = e.clientX;
      d.y = e.clientY;
      this.sync();
    });
    pip.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.id !== e.pointerId || d.moved) return;
      this.h.onClick(e.clientX, e.clientY, e.shiftKey);
    });
    pip.addEventListener(
      'wheel',
      (e) => {
        if (!pip.classList.contains('gimbal')) return;
        e.preventDefault();
        this.gimbal.zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
        this.sync();
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.full) this.setFull(false);
    });
  }

  /** Поле зрения последнего кадра, ° — для перевода перетаскивания в углы. */
  lastFovDeg = 30;

  /**
   * Что доступно в этом задании: ir — есть тепловизор (поиск, патруль), marks — щелчок ставит
   * отметку, launcher — дневная камера по кнопке «Подвес» (перелёт, облёт, доставка).
   */
  configure(o: { ir: boolean; marks: boolean; launcher: boolean }) {
    // Тепловизор на подвесе есть в любом задании; ir — начинать с него (поиск, патруль).
    this.hasIr = true;
    this.ir = o.ir;
    this.marks = o.marks;
    this.trackMode = !o.marks;
    this.launcher.hidden = !o.launcher;
    this.shownDay = false;
    this.setFull(false);
    this.sync();
  }

  /** Показывать ли окно дневной камеры (кнопка «Подвес»). */
  get dayShown(): boolean {
    return this.shownDay;
  }

  /** Окно подвеса активно: рамка принимает мышь и показывает панель. */
  setActive(on: boolean) {
    this.pip.classList.toggle('gimbal', on);
    if (!on && this.full) this.setFull(false);
  }

  /** Место кадра на 3D-виде: обычно — угол, во весь экран — весь вид; aspect — ширина к высоте. */
  rect(aspect: number): { right: number; bottom: number; width: number; height: number } {
    const w = this.view.clientWidth;
    const hgt = this.view.clientHeight;
    if (this.full) return { right: 0, bottom: 0, width: w, height: hgt };
    const width = Math.round(Math.min(360, w * 0.45));
    return { right: 12, bottom: 12, width, height: Math.round(width / aspect) };
  }

  private setFull(on: boolean) {
    this.full = on;
    this.pip.classList.toggle('full', on);
    if (!on) this.pip.style.removeProperty('inset');
    this.sync();
  }

  /** Подписи и состояние кнопок. */
  sync() {
    const g = this.gimbal;
    const q = (k: string) => this.bar.querySelector<HTMLButtonElement>(`[data-g="${k}"]`)!;
    q('full').classList.toggle('on', this.full);
    q('ir').hidden = q('rgb').hidden = !this.hasIr;
    q('ir').classList.toggle('on', this.ir);
    q('rgb').classList.toggle('on', !this.ir);
    q('palette').hidden = !this.ir;
    q('palette').textContent = THERMAL_PALETTES.find((p) => p.id === this.palette)!.title;
    q('track').classList.toggle('on', this.trackMode || !this.marks);
    q('track').hidden = !this.marks;
    this.launcher.classList.toggle('on', this.shownDay);
    const pan = Math.round(g.panDeg);
    const panText = pan === 0 ? 'по носу' : `${Math.abs(pan)}° ${pan > 0 ? 'вправо' : 'влево'}`;
    this.bar.querySelector('output')!.textContent = `${panText} · наклон ${Math.round(g.tiltDeg)}° · ×${g.zoom.toFixed(1).replace('.', ',')}${g.track ? ' · сопровождение' : ''}`;
  }
}
