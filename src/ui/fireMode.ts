import * as THREE from 'three';
import { FireWorld, type FireMark, type SmokeReport } from '../game/fire';
import type { FireScenario } from '../game/scenarios';
import type { DifficultyId, FireOutcome } from '../game/scoring';
import { fromLocal } from '../sim/mission';
import type { Site } from '../sim/types';
import type { Gimbal, Point3 } from './gimbal';
import type { HeatBody } from './heat';
import type { Map2D } from './map2d';
import type { World } from './scene';

/*
 * Режим «Лесопожарный патруль» в полёте: пожары растут по времени полёта (src/game/fire.ts), над
 * ними стоят дымы (src/ui/smoke.ts), окно тепловизора показывает кадр подвеса. Щелчок по окну
 * ставит отметку на земле — «здесь огонь»; кнопка «Дым» и щелчок по столбу в 3D-виде — донесение
 * о пожаре. На зачёте, что под отметкой, пилот узнаёт только в разборе.
 */

export interface FireHost {
  world: World;
  map: Map2D;
  site: Site;
  /** Окно тепловизора под 3D-видом (.pip) и сам 3D-вид — по нему указывают дым. */
  pipEl: HTMLElement;
  viewEl: HTMLElement;
  /** Подвес: азимут, наклон, зум и сопровождение (gimbal.ts). */
  gimbal: Gimbal;
  /** Ветер на высоте над землёй: куда дует, м/с. */
  windAt(heightAglM: number): { east: number; north: number };
  onMark(m: FireMark, reveal: boolean): void;
  onReport(r: SmokeReport, reveal: boolean): void;
}

/** Состояние борта, которое нужно тепловизору. */
export interface FireAircraft {
  t: number;
  east: number;
  north: number;
  up: number;
  aglM: number;
  headingDeg: number;
}

/** Дымы к началу полёта уже стоят: прокрутка столбов при постановке задания, с. */
const PREWARM_S = 360;
/** Щелчок с протяжкой дальше этого — вращение камеры, а не указание, px. */
const DRAG_PX = 6;

/** Вертикальное поле зрения камеры по матрице и объективу, °. */
const fovOf = (cam: { heightPx: number; pixelPitchUm: number; focalLengthMm: number }) =>
  (2 * Math.atan((cam.heightPx * cam.pixelPitchUm * 1e-3) / (2 * cam.focalLengthMm)) * 180) / Math.PI;

export class FireMode {
  readonly world: FireWorld;
  private readonly reveal: boolean;
  private camera: { eye: Point3; look: Point3; up: THREE.Vector3; fovDeg: number } | null = null;
  private readonly ids = new Map<string, number>();
  private readonly button: HTMLButtonElement;
  private armed = false;
  private down: { x: number; y: number } | null = null;
  private tNow = 0;
  private readonly onViewDown = (e: MouseEvent) => (this.down = { x: e.clientX, y: e.clientY });
  private readonly onViewClick = (e: MouseEvent) => this.reportHere(e);
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.armed) this.arm(false);
  };

  constructor(
    private readonly sc: FireScenario,
    private readonly host: FireHost,
    opts: { difficulty: DifficultyId; seed: number; wind: { speedMs: number; fromDeg: number } },
  ) {
    this.world = new FireWorld({
      origin: sc.site,
      area: sc.area,
      difficulty: opts.difficulty,
      seed: opts.seed,
      wind: opts.wind,
      windAt: (h) => host.windAt(h),
      groundAt: (e, n) => host.world.groundAt(e, n),
    });
    this.reveal = opts.difficulty !== 'exam';
    this.button = document.createElement('button');
    this.button.className = 'smoke-btn';
    this.button.title = 'Донесение о пожаре: нажмите и щёлкните по столбу дыма в 3D-виде (Esc — отмена)';
    this.button.textContent = 'Дым';
    this.button.addEventListener('click', () => this.arm(!this.armed));
    host.viewEl.parentElement?.appendChild(this.button);
    host.viewEl.addEventListener('pointerdown', this.onViewDown);
    host.viewEl.addEventListener('click', this.onViewClick);
    window.addEventListener('keydown', this.onKey);
    host.world.setHeatBodies(this.bodies());
    host.world.setFire({ plumes: this.world.plumes(), flames: this.world.flames() }, (h) => host.windAt(h), PREWARM_S);
    host.map.setSearchMarks(null);
  }

  setTime(t: number) {
    this.tNow = t;
  }

  /** Шаг: пожары растут dtSim секунд полёта, дым идёт с ними, пламя мерцает по настоящему. */
  update(dtSim: number, dtReal: number, a: FireAircraft, airborne: boolean) {
    if (dtSim > 0) this.world.step(dtSim);
    this.host.world.setHeatBodies(this.bodies());
    this.host.world.setFire({ plumes: this.world.plumes(), flames: this.world.flames() });
    this.host.world.fireTick(dtSim, dtReal, (h) => this.host.windAt(h));
    if (!airborne) {
      this.camera = null;
      return;
    }
    const f = this.host.gimbal.frame(a, fovOf(this.sc.camera));
    this.camera = { eye: f.eye, look: f.look, up: f.up, fovDeg: f.fovDeg };
  }

  get active(): boolean {
    return this.camera !== null;
  }

  /** Кадр подвеса в окне rect: тепловизор или дневная камера (ir = false) — в ней виден и дым. */
  render(rect: { right: number; bottom: number; width: number; height: number }, ir: boolean) {
    const el = this.host.pipEl;
    el.classList.toggle('thermal', !!this.camera && ir);
    if (!this.camera) return;
    Object.assign(el.style, { width: `${rect.width}px`, height: `${rect.height}px` });
    const c = this.camera;
    if (ir) this.host.world.renderThermal(rect, c.eye, c.look, c.fovDeg, c.up);
    else this.host.world.renderPip(rect, c.eye, c.look, c.fovDeg, c.up);
  }

  get fovDeg(): number {
    return this.camera?.fovDeg ?? fovOf(this.sc.camera);
  }

  get aspect(): number {
    return this.sc.camera.widthPx / this.sc.camera.heightPx;
  }

  /** Подпись окна: что подтверждено (на зачёте — только счёт отметок). */
  label(): string {
    const r = this.world.result();
    if (!this.reveal) return `Тепловизор · отметок ${this.world.marks.length} · донесений ${this.world.reports.length} · щелчок по пятну — «здесь огонь»`;
    const bad = r.falseMarks ? ` · ложных ${r.falseMarks}` : '';
    return `Тепловизор · дымы ${r.reported} из ${r.fires} · очаги ${r.located} из ${r.fires} · огневые точки ${r.spotsFound} из ${r.spots}${bad} · щелчок по пятну — «здесь огонь»`;
  }

  result(takeoffT: number): FireOutcome {
    return this.world.result(takeoffT);
  }

  dispose() {
    this.host.viewEl.removeEventListener('pointerdown', this.onViewDown);
    this.host.viewEl.removeEventListener('click', this.onViewClick);
    window.removeEventListener('keydown', this.onKey);
    this.arm(false);
    this.button.remove();
    this.host.pipEl.classList.remove('thermal');
    this.host.world.setHeatBodies([]);
    this.host.world.setFire(null);
    this.host.map.setSearchMarks(null);
  }

  private arm(on: boolean) {
    this.armed = on;
    this.button.classList.toggle('armed', on);
    this.button.textContent = on ? 'Укажите дым' : 'Дым';
    this.host.viewEl.style.cursor = on ? 'crosshair' : '';
  }

  /** Тела для 3D-вида с числовыми номерами. */
  private bodies(): HeatBody[] {
    return this.world.heatBodies().map((b) => {
      let id = this.ids.get(b.id);
      if (id === undefined) this.ids.set(b.id, (id = this.ids.size + 1));
      return { id, kind: b.kind, east: b.east, north: b.north, headingDeg: b.headingDeg };
    });
  }

  /** Отметка огня по щелчку в кадре подвеса (ir — в тепловом кадре). */
  markAt(clientX: number, clientY: number, ir: boolean): FireMark | null {
    if (!this.camera) return null;
    const box = this.host.pipEl.getBoundingClientRect();
    const p = ir ? this.host.world.thermalPick(clientX - box.left, clientY - box.top) : this.host.world.pipPick(clientX - box.left, clientY - box.top);
    if (!p) return null;
    const m = this.world.mark({ east: p.east, north: p.north }, this.tNow);
    this.host.onMark(m, this.reveal);
    this.drawMarks();
    return m;
  }

  /** Щелчок по столбу дыма в 3D-виде — донесение о пожаре. */
  private reportHere(e: MouseEvent) {
    if (!this.armed) return;
    const d = this.down;
    this.down = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) return;
    const pick = this.host.world.viewPick(e.clientX, e.clientY);
    if (!pick) return;
    const ground = pick.ground ? { east: pick.ground.east, north: pick.ground.north } : null;
    const r = this.world.reportSmoke({ ...pick.origin }, { ...pick.dir }, ground, this.tNow);
    this.arm(false);
    this.host.onReport(r, this.reveal);
    this.drawMarks();
  }

  private drawMarks() {
    const site = this.host.site;
    const marks = [
      ...this.world.marks.map((m) => ({
        east: m.east,
        north: m.north,
        result: m.result === 'false' ? ('animal' as const) : m.result === 'empty' ? ('empty' as const) : ('fire' as const),
        label: m.text,
      })),
      ...this.world.reports.map((r) => ({
        east: r.east,
        north: r.north,
        result: r.result === 'false' ? ('empty' as const) : ('smoke' as const),
        label: r.text,
      })),
    ];
    this.host.map.setSearchMarks(
      marks.map((m) => {
        const g = fromLocal(site, m.east, m.north);
        // На зачёте отметки серые: что под ними — в разборе.
        return { lat: g.lat, lon: g.lon, result: this.reveal ? m.result : ('empty' as const), label: this.reveal ? m.label : 'Отметка поставлена' };
      }),
    );
  }
}
