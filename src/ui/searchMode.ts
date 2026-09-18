import * as THREE from 'three';
import type { SearchScenario } from '../game/scenarios';
import type { DifficultyId, SearchOutcome } from '../game/scoring';
import { SearchWorld, type SearchMark } from '../game/search';
import { fromLocal } from '../sim/mission';
import type { Site, Terrain } from '../sim/types';
import type { Gimbal, Point3 } from './gimbal';
import type { HeatBody } from './heat';
import type { Map2D } from './map2d';
import type { World } from './scene';

/*
 * Режим «Поиск людей» в полёте: люди и звери ходят по времени полёта (src/game/search.ts), 3D-вид
 * показывает их моделями, окно тепловизора — картинку подвеса (World.renderThermal), щелчок по
 * окну ставит отметку на земле, отметки — на карте. На зачёте что под отметкой, пилот узнаёт
 * только в разборе.
 */

export interface SearchHost {
  world: World;
  map: Map2D;
  site: Site;
  terrain: Terrain;
  /** Окно картинки подвеса под 3D-видом (.pip). */
  pipEl: HTMLElement;
  /** Подвес: азимут, наклон, зум и сопровождение (gimbal.ts). */
  gimbal: Gimbal;
  /** Отметка поставлена: reveal — можно ли сказать пилоту, что под ней. */
  onMark(m: SearchMark, reveal: boolean): void;
}

/** Состояние борта, которое нужно тепловизору. */
export interface SearchAircraft {
  t: number;
  east: number;
  north: number;
  up: number;
  aglM: number;
  headingDeg: number;
}

/** Щелчок ближе этого к человеку или зверю — сопровождать его, а не точку на земле, м. */
const TRACK_BODY_M = 20;

/** Вертикальное поле зрения камеры по матрице и объективу, °. */
const fovOf = (cam: { heightPx: number; pixelPitchUm: number; focalLengthMm: number }) =>
  (2 * Math.atan((cam.heightPx * cam.pixelPitchUm * 1e-3) / (2 * cam.focalLengthMm)) * 180) / Math.PI;

export class SearchMode {
  readonly world: SearchWorld;
  private readonly reveal: boolean;
  private camera: { eye: Point3; look: Point3; up: THREE.Vector3; fovDeg: number } | null = null;
  /** Номера тел для 3D: у логики поиска — строки («wolf-3»), у моделей — числа. */
  private readonly ids = new Map<string, number>();
  private tNow = 0;

  constructor(
    private readonly sc: SearchScenario,
    private readonly host: SearchHost,
    opts: { difficulty: DifficultyId; seed: number },
  ) {
    this.world = new SearchWorld({ origin: sc.site, area: sc.area, difficulty: opts.difficulty, seed: opts.seed, animals: sc.animals, terrain: host.terrain, camera: sc.camera });
    this.reveal = opts.difficulty !== 'exam';
    host.world.setHeatBodies(this.bodies());
    host.map.setSearchMarks(null);
  }

  /** Время полёта для отметок. */
  setTime(t: number) {
    this.tNow = t;
  }

  /**
   * Шаг: люди и звери идут dtSim секунд полёта; в воздухе тепловизор смотрит вперёд-вниз под
   * наклоном подвеса и отмечает просмотренное.
   */
  update(dtSim: number, a: SearchAircraft, airborne: boolean) {
    if (dtSim > 0) this.world.step(dtSim);
    this.host.world.setHeatBodies(this.bodies());
    if (!airborne) {
      this.camera = null;
      return;
    }
    const cam = this.sc.camera;
    const f = this.host.gimbal.frame(a, fovOf(cam), (id) => this.bodyAt(id));
    // Покрытие района — по оси подвеса и с зумом (поле зрения уже).
    this.world.observe({ east: a.east, north: a.north, aglM: a.aglM, headingDeg: f.headingDeg, tiltDeg: f.tiltDeg, altitudeM: a.up + this.host.site.elevationM }, { ...cam, focalLengthMm: cam.focalLengthMm * f.zoom });
    this.camera = { eye: f.eye, look: f.look, up: f.up, fovDeg: f.fovDeg };
  }

  /** Окно тепловизора открыто: борт в воздухе. */
  get active(): boolean {
    return this.camera !== null;
  }

  /** Кадр подвеса в окне rect: тепловизор или дневная камера (ir = false). */
  render(rect: { right: number; bottom: number; width: number; height: number }, ir: boolean) {
    const el = this.host.pipEl;
    el.classList.toggle('thermal', !!this.camera && ir);
    if (!this.camera) return;
    Object.assign(el.style, { width: `${rect.width}px`, height: `${rect.height}px` });
    const c = this.camera;
    if (ir) this.host.world.renderThermal(rect, c.eye, c.look, c.fovDeg, c.up);
    else this.host.world.renderPip(rect, c.eye, c.look, c.fovDeg, c.up);
  }

  /** Кадр подвеса: откуда и куда смотрит камера; null — аппарат на земле или подвес не включён. */
  get frame(): { eye: Point3; look: Point3 } | null {
    return this.camera;
  }

  /** Поле зрения кадра подвеса, °. */
  get fovDeg(): number {
    return this.camera?.fovDeg ?? fovOf(this.sc.camera);
  }

  /** Отношение сторон матрицы тепловизора. */
  get aspect(): number {
    return this.sc.camera.widthPx / this.sc.camera.heightPx;
  }

  /** Подпись окна: что найдено (на зачёте — только число отметок). */
  label(): string {
    const marks = this.world.marks;
    if (!this.reveal) return `Тепловизор · отметок ${marks.length} · щелчок по пятну — «здесь человек»`;
    const r = this.world.result();
    const falseMarks = marks.filter((m) => m.result === 'false' || m.result === 'empty').length;
    return `Тепловизор · найдено ${r.found} из ${r.total}${falseMarks ? ` · ложных отметок ${falseMarks}` : ''} · щелчок по пятну — «здесь человек»`;
  }

  result(takeoffT: number): SearchOutcome {
    return this.world.result(takeoffT);
  }

  /** Убрать режим: слушатель окна, модели людей и зверей, отметки на карте. */
  dispose() {
    this.host.pipEl.classList.remove('thermal');
    this.host.world.setHeatBodies([]);
    this.host.map.setSearchMarks(null);
  }

  /** Тела для 3D-вида с числовыми номерами. */
  private bodies(): HeatBody[] {
    return this.world.heatBodies().map((b) => {
      let id = this.ids.get(b.id);
      if (id === undefined) this.ids.set(b.id, (id = this.ids.size + 1));
      return { ...b, id };
    });
  }

  /** Отметка по щелчку в кадре подвеса: точка на земле под курсором (ir — в тепловом кадре). */
  markAt(clientX: number, clientY: number, ir: boolean): SearchMark | null {
    if (!this.camera) return null;
    const box = this.host.pipEl.getBoundingClientRect();
    const p = ir ? this.host.world.thermalPick(clientX - box.left, clientY - box.top) : this.host.world.pipPick(clientX - box.left, clientY - box.top);
    if (!p) return null;
    const m = this.world.mark({ east: p.east, north: p.north }, this.tNow);
    this.host.onMark(m, this.reveal);
    this.drawMarks();
    return m;
  }

  /** Человек или зверь рядом с точкой — чтобы сопровождать его, а не место. */
  bodyNear(p: { east: number; north: number }): string | null {
    let best: { id: string; d: number } | null = null;
    for (const b of this.world.bodies) {
      const d = Math.hypot(b.east - p.east, b.north - p.north);
      if (d <= TRACK_BODY_M && (!best || d < best.d)) best = { id: b.id, d };
    }
    return best?.id ?? null;
  }

  /** Где сейчас цель сопровождения. */
  bodyAt(id: string): Point3 | null {
    const b = this.world.bodies.find((x) => x.id === id);
    return b ? { east: b.east, north: b.north, up: this.host.world.groundAt(b.east, b.north) + 0.8 } : null;
  }

  private drawMarks() {
    const site = this.host.site;
    this.host.map.setSearchMarks(
      this.world.marks.map((m) => {
        const g = fromLocal(site, m.east, m.north);
        // На зачёте отметки серые: что под ними — в разборе.
        const result = !this.reveal ? 'empty' : m.result === 'found' || m.result === 'repeat' ? 'person' : m.result === 'false' ? 'animal' : 'empty';
        return { lat: g.lat, lon: g.lon, result, label: this.reveal ? m.text : 'Отметка поставлена' };
      }),
    );
  }
}
