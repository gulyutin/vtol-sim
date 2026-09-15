import * as THREE from 'three';
import type { SearchScenario } from '../game/scenarios';
import type { DifficultyId, SearchOutcome } from '../game/scoring';
import { SearchWorld, type SearchMark } from '../game/search';
import { fromLocal } from '../sim/mission';
import type { Site, Terrain } from '../sim/types';
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

/** Окно тепловизора не шире, px, и доля ширины 3D-вида. */
const WINDOW_MAX_PX = 360;
const WINDOW_SHARE = 0.45;
/** Тепловизор под фюзеляжем — чуть ниже центра аппарата, м. */
const CAMERA_BELOW_M = 0.4;

export class SearchMode {
  readonly world: SearchWorld;
  private readonly reveal: boolean;
  private camera: { eye: { east: number; north: number; up: number }; look: { east: number; north: number; up: number }; up: THREE.Vector3 } | null = null;
  private readonly onClick = (e: MouseEvent) => this.click(e);
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
    host.pipEl.addEventListener('click', this.onClick);
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
    const tilt = (this.sc.tiltDeg * Math.PI) / 180;
    const h = (a.headingDeg * Math.PI) / 180;
    this.world.observe({ east: a.east, north: a.north, aglM: a.aglM, headingDeg: a.headingDeg, tiltDeg: this.sc.tiltDeg, altitudeM: a.up + this.host.site.elevationM });
    const eye = { east: a.east, north: a.north, up: a.up - CAMERA_BELOW_M };
    const d = 100;
    this.camera = {
      eye,
      look: { east: eye.east + Math.sin(h) * Math.cos(tilt) * d, north: eye.north + Math.cos(h) * Math.cos(tilt) * d, up: eye.up - Math.sin(tilt) * d },
      // Почти отвесно вниз — верх кадра по курсу, иначе горизонт горизонтален.
      up: this.sc.tiltDeg > 80 ? new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)) : new THREE.Vector3(0, 1, 0),
    };
  }

  /** Окно тепловизора открыто: борт в воздухе. */
  get active(): boolean {
    return this.camera !== null;
  }

  /** Кадр тепловизора в окне под 3D-видом. */
  render(viewWidthPx: number) {
    const el = this.host.pipEl;
    el.classList.toggle('thermal', !!this.camera);
    if (!this.camera) return;
    const cam = this.sc.camera;
    const w = Math.round(Math.min(WINDOW_MAX_PX, viewWidthPx * WINDOW_SHARE));
    const r = { right: 12, bottom: 12, width: w, height: Math.round((w * cam.heightPx) / cam.widthPx) };
    Object.assign(el.style, { width: `${r.width}px`, height: `${r.height}px` });
    const fov = (2 * Math.atan((cam.heightPx * cam.pixelPitchUm * 1e-3) / (2 * cam.focalLengthMm)) * 180) / Math.PI;
    this.host.world.renderThermal(r, this.camera.eye, this.camera.look, fov, this.camera.up);
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
    this.host.pipEl.removeEventListener('click', this.onClick);
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

  private click(e: MouseEvent) {
    if (!this.camera) return;
    const box = this.host.pipEl.getBoundingClientRect();
    const p = this.host.world.thermalPick(e.clientX - box.left, e.clientY - box.top);
    if (!p) return;
    const m = this.world.mark({ east: p.east, north: p.north }, this.tNow);
    this.host.onMark(m, this.reveal);
    this.drawMarks();
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
