import { toLocal } from '../sim/mission';
import type { GeoPoint } from '../sim/types';
import type { DifficultyId, FireOutcome } from './scoring';
import { centroid, insidePolygon, mulberry32, type LocalPoint } from './search';

/*
 * Лесопожарный патруль. Оператор идёт по зоне патрулирования и ищет дымы: столб видно за
 * километры в 3D-виде, и по нему даётся донесение. Подойдя, он подтверждает очаг тепловизором и
 * отмечает огневые точки — тлеющие места внутри гари, очаги переброса за кромкой и одиночные
 * тлеющие деревья после грозы: дыма у них почти нет, их видно только в тепловом кадре. Ложные
 * цели — нагретый солнцем курумник и зимовье с топящейся печью.
 * Здесь без DOM: пожары, их рост по ветру, дым, отметки и донесения. Координаты — локальные
 * метры от площадки, как у полёта: восток, север; up — над уровнем площадки.
 */

const RAD = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** Точка с высотой: локальные метры от площадки. */
export interface LocalPoint3 extends LocalPoint {
  up: number;
}

/** Кромка (горит), угли внутри гари, переброс за кромку, одиночное тлеющее место. */
export type HotSpotKind = 'edge' | 'ember' | 'spot' | 'smolder';
export type DecoyKind = 'rocks' | 'hut';
/** Модель для сцены (src/ui/heat.ts). */
export type FireHeatKind = 'flame' | 'ember' | 'rocks' | 'hut';

export interface FireHeatBody {
  id: string;
  kind: FireHeatKind;
  east: number;
  north: number;
  headingDeg: number;
}

export interface FireDifficulty {
  /** Сколько пожаров, углей и перебросов на пожар, одиночных тлеющих мест и ложных целей. */
  fires: [number, number];
  embers: [number, number];
  spots: [number, number];
  smolders: [number, number];
  decoys: [number, number];
  /** Сколько пожар горит к началу полёта, мин: от этого его размер. */
  ageMin: [number, number];
}

/** Чем сложнее — тем больше пожаров, огневых точек и ложных целей и тем моложе (меньше) очаги. */
export const FIRE_DIFFICULTY: Readonly<Record<DifficultyId, FireDifficulty>> = {
  train: { fires: [1, 1], embers: [1, 1], spots: [0, 0], smolders: [1, 1], decoys: [2, 2], ageMin: [60, 90] },
  normal: { fires: [2, 2], embers: [1, 2], spots: [0, 1], smolders: [1, 2], decoys: [3, 4], ageMin: [40, 80] },
  hard: { fires: [2, 3], embers: [2, 3], spots: [1, 1], smolders: [2, 3], decoys: [5, 6], ageMin: [30, 60] },
  exam: { fires: [3, 3], embers: [2, 3], spots: [1, 2], smolders: [3, 4], decoys: [7, 8], ageMin: [20, 45] },
};

/** Скорость головы низового пожара, м/с: в штиль ~0,25 м/мин, при 8 м/с — ~3 м/мин. */
export const headRateMs = (windMs: number) => 0.004 + 0.006 * Math.max(0, windMs);
/** Фланги и тыл — доли от скорости головы. */
const FLANK_SHARE = 0.35;
const BACK_SHARE = 0.12;
/** Очаг в начале — столько метров от точки возникновения. */
const IGNITION_M = 5;
/** Точек по кромке у пожара. */
const EDGE_POINTS = 12;
/** Ближе этого к отметке — она об этой огневой точке, м. */
export const FIRE_MARK_RADIUS_M = 20;
/** Пожары и одиночные тлеющие места — не ближе, м. */
const FIRE_SPACING_M = 1200;
const SMOLDER_SPACING_M = 500;
/**
 * Донесение о дыме: допуск по лучу — не меньше этого и не меньше доли дальности, м. Оператор
 * показывает на столб, а не на ось: попадание в любую его часть — донесение.
 */
const SMOKE_TOL_M = 150;
const SMOKE_TOL_SHARE = 0.05;
/** Дальше этого от очага точка рельефа под указателем — не место пожара, а земля за дымом, м. */
const SMOKE_PLACE_M = 1500;

export interface Fire {
  id: number;
  /** Место возникновения, локальные метры. */
  east: number;
  north: number;
  /** Куда идёт огонь (по ветру), °. */
  headingDeg: number;
  /** Скорости фронта: голова, фланг, тыл, м/с. */
  headMs: number;
  flankMs: number;
  backMs: number;
  /** Насколько кромка ушла от места возникновения сейчас, м. */
  head: number;
  flank: number;
  back: number;
  /** Дым доложен оператором; очаг подтверждён тепловизором. */
  reported: boolean;
  located: boolean;
}

export interface HotSpot {
  id: string;
  kind: HotSpotKind;
  /** Пожар, к которому относится точка; null — одиночное тлеющее место. */
  fireId: number | null;
  /** Кромка и угли держатся за эллипс гари: угол от направления ветра и доля радиуса. */
  phi: number;
  k: number;
  east: number;
  north: number;
  found: boolean;
}

export interface Decoy {
  id: string;
  kind: DecoyKind;
  east: number;
  north: number;
  headingDeg: number;
}

/** Источник дыма для сцены: сила — площадь горения, radiusM — размер источника. */
export interface FirePlume {
  key: string;
  fireId: number | null;
  east: number;
  north: number;
  strength: number;
  radiusM: number;
}

/** Пламя для сцены: где горит и какого размера огонь, м. */
export interface FireFlame {
  east: number;
  north: number;
  sizeM: number;
}

export type FireMarkResult = 'found' | 'located' | 'repeat' | 'false' | 'empty';

export interface FireMark extends LocalPoint {
  t: number;
  result: FireMarkResult;
  fireId: number | null;
  spotId: string | null;
  decoy: DecoyKind | null;
  text: string;
}

export type SmokeReportResult = 'reported' | 'repeat' | 'false';

export interface SmokeReport extends LocalPoint {
  t: number;
  result: SmokeReportResult;
  fireId: number | null;
  /** На сколько метров место по донесению разошлось с очагом; дальность до очага, м. */
  errorM: number | null;
  rangeM: number | null;
  text: string;
}

export interface FireSetup {
  /** Начало локальных координат — площадка задания, как у полёта. */
  origin: GeoPoint;
  /** Зона патрулирования — многоугольник. */
  area: readonly GeoPoint[];
  difficulty: DifficultyId;
  seed: number;
  /** Ветер у земли: куда идёт огонь и куда сносит дым. */
  wind?: { speedMs: number; fromDeg: number };
  /** Ветер по высоте для оси дымового столба: куда дует, м/с. */
  windAt?: (heightAglM: number) => LocalPoint;
  /** Высота рельефа над уровнем площадки, м — курумник ставится выше, зимовья ниже. */
  groundAt?: (east: number, north: number) => number;
  markRadiusM?: number;
  /** Пожары не ближе этого к площадке, м. */
  minSiteDistanceM?: number;
}

/* --------------------------------- Дым --------------------------------- */

/** Дым: скорость подъёма у очага и время её спада — по силе горения. */
export function plumeRise(strength: number): { w0: number; tauS: number } {
  const s = clamp(strength, 0.02, 3);
  return { w0: 1.6 + 4.2 * Math.sqrt(s), tauS: 25 + 55 * Math.min(1, s) };
}

/** Высота дыма над очагом через ageS секунд после схода, м. */
export const plumeHeight = (r: { w0: number; tauS: number }, ageS: number) => r.w0 * r.tauS * (1 - Math.exp(-ageS / r.tauS));

/** Радиус дымового клуба на высоте h над очагом, м: чем выше, тем шире. */
export const plumeRadius = (p: { radiusM: number }, h: number) => p.radiusM + 10 + 0.35 * h;

/**
 * Ось дымового столба над очагом: точки через stepS секунд подъёма, снесённые ветром на своей
 * высоте. up — над землёй у очага.
 */
export function plumeAxis(p: FirePlume, windAt: (heightAglM: number) => LocalPoint, topS = 420, stepS = 20): LocalPoint3[] {
  const r = plumeRise(p.strength);
  const out: LocalPoint3[] = [];
  let east = p.east;
  let north = p.north;
  for (let a = 0; a <= topS; a += stepS) {
    const up = plumeHeight(r, a);
    out.push({ east, north, up });
    const w = windAt(up);
    east += w.east * stepS;
    north += w.north * stepS;
  }
  return out;
}

/* ------------------------------ Геометрия гари ------------------------------ */

/** Точка на кромке (k = 1) или внутри гари: угол phi от направления ветра, доля радиуса k. */
export function firePoint(f: Fire, phi: number, k = 1): LocalPoint {
  const c = Math.cos(phi);
  const along = (c >= 0 ? f.head : f.back) * c * k;
  const cross = f.flank * Math.sin(phi) * k;
  const h = f.headingDeg * RAD;
  return { east: f.east + along * Math.sin(h) + cross * Math.cos(h), north: f.north + along * Math.cos(h) - cross * Math.sin(h) };
}

/** Точка внутри гари с запасом margin по кромке. */
function inBurn(f: Fire, p: LocalPoint, margin = 0): boolean {
  const h = f.headingDeg * RAD;
  const de = p.east - f.east;
  const dn = p.north - f.north;
  const along = de * Math.sin(h) + dn * Math.cos(h);
  const cross = de * Math.cos(h) - dn * Math.sin(h);
  const a = (along >= 0 ? f.head : f.back) + margin;
  const b = f.flank + margin;
  return (along / Math.max(1, a)) ** 2 + (cross / Math.max(1, b)) ** 2 <= 1;
}

/** Сила дыма: чем больше горящая кромка, тем выше и гуще столб. */
const fireStrength = (f: Fire) => clamp((f.head + 2 * f.flank) / 120, 0.35, 2.4);

/** Расстояние от луча (o, dir) до точки и дальность точки по лучу, м. */
function rayDistance(o: LocalPoint3, dir: LocalPoint3, p: LocalPoint3): { distM: number; rangeM: number } {
  const len = Math.hypot(dir.east, dir.north, dir.up) || 1;
  const de = dir.east / len;
  const dn = dir.north / len;
  const du = dir.up / len;
  const t = Math.max(0, (p.east - o.east) * de + (p.north - o.north) * dn + (p.up - o.up) * du);
  return { distM: Math.hypot(o.east + de * t - p.east, o.north + dn * t - p.north, o.up + du * t - p.up), rangeM: t };
}

/* ---------------------------------- Мир ---------------------------------- */

type Rng = () => number;
const uniform = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const DECOY_NAMES: Record<DecoyKind, string> = { rocks: 'нагретый солнцем курумник', hut: 'зимовье, топится печь' };
const SPOT_NAMES: Record<HotSpotKind, string> = { edge: 'кромка', ember: 'тлеющее место в гари', spot: 'очаг переброса за кромкой', smolder: 'тлеющее дерево' };

/**
 * Мир патруля: пожары района и их рост, огневые точки, ложные цели, отметки тепловизором и
 * донесения о дымах. Каждый кадр — step(dt); heatBodies(), plumes() и flames() — в сцену;
 * mark() и reportSmoke() — действия оператора; result() — в оценку (AssessInput.fire).
 * Один seed — один и тот же набор пожаров.
 */
export class FireWorld {
  readonly origin: GeoPoint;
  readonly area: LocalPoint[];
  readonly fires: Fire[] = [];
  readonly spots: HotSpot[] = [];
  readonly decoys: Decoy[] = [];
  readonly marks: FireMark[] = [];
  readonly reports: SmokeReport[] = [];
  readonly markRadiusM: number;
  t = 0;
  private readonly windAt: (heightAglM: number) => LocalPoint;
  private readonly groundAt: (east: number, north: number) => number;

  constructor(setup: FireSetup) {
    this.origin = setup.origin;
    this.area = setup.area.map((g) => toLocal(setup.origin, g));
    this.markRadiusM = setup.markRadiusM ?? FIRE_MARK_RADIUS_M;
    this.groundAt = setup.groundAt ?? (() => 0);
    const wind = setup.wind ?? { speedMs: 0, fromDeg: 0 };
    const to = norm360(wind.fromDeg + 180);
    this.windAt = setup.windAt ?? ((h: number) => ({ east: Math.sin(to * RAD) * wind.speedMs * (h > 10 ? 1.3 : 1), north: Math.cos(to * RAD) * wind.speedMs * (h > 10 ? 1.3 : 1) }));
    this.populate(setup, mulberry32(setup.seed), to, wind.speedMs);
  }

  /** Рост пожаров за dt секунд полёта. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    this.t += dt;
    for (const f of this.fires) {
      f.head += f.headMs * dt;
      f.flank += f.flankMs * dt;
      f.back += f.backMs * dt;
    }
    for (const s of this.spots) {
      if (s.kind !== 'edge' && s.kind !== 'ember') continue;
      const f = this.fires.find((x) => x.id === s.fireId);
      if (!f) continue;
      const p = firePoint(f, s.phi, s.k);
      s.east = p.east;
      s.north = p.north;
    }
  }

  /** Тёплые тела для сцены: кромка и огневые точки, курумник и зимовья. */
  heatBodies(): FireHeatBody[] {
    const out: FireHeatBody[] = this.spots.map((s) => {
      const f = this.fires.find((x) => x.id === s.fireId);
      // Горит голова и фланги; тыл за кромкой уже прогорел — там угли.
      const head = s.kind === 'spot' || (s.kind === 'edge' && Math.cos(s.phi) > -0.4);
      return { id: s.id, kind: head ? ('flame' as const) : ('ember' as const), east: s.east, north: s.north, headingDeg: f?.headingDeg ?? 0 };
    });
    for (const d of this.decoys) out.push({ id: d.id, kind: d.kind, east: d.east, north: d.north, headingDeg: d.headingDeg });
    return out;
  }

  /** Дымы: столб над каждым пожаром, слабые дымки над перебросами и тлеющими деревьями. */
  plumes(): FirePlume[] {
    const out: FirePlume[] = this.fires.map((f) => {
      const mid = firePoint(f, 0, 0.5);
      return { key: `fire-${f.id}`, fireId: f.id, east: mid.east, north: mid.north, strength: fireStrength(f), radiusM: Math.max(10, f.flank) };
    });
    for (const s of this.spots) {
      if (s.kind === 'spot') out.push({ key: s.id, fireId: s.fireId, east: s.east, north: s.north, strength: 0.18, radiusM: 4 });
      else if (s.kind === 'smolder') out.push({ key: s.id, fireId: null, east: s.east, north: s.north, strength: 0.05, radiusM: 2 });
    }
    return out;
  }

  /** Пламя для сцены: голова кромки горит сильнее флангов. */
  flames(): FireFlame[] {
    return this.spots
      .filter((s) => s.kind === 'edge' || s.kind === 'spot')
      .map((s) => ({ east: s.east, north: s.north, sizeM: s.kind === 'spot' ? 1.6 : 1.2 + 2.2 * Math.max(0, Math.cos(s.phi)) }));
  }

  /**
   * Отметка тепловизором в точке p: ближайшая ненайденная огневая точка в радиусе — найдена;
   * иначе кромка или гарь — очаг подтверждён; иначе курумник или зимовье — ложная отметка.
   */
  mark(p: LocalPoint, t: number): FireMark {
    const R = this.markRadiusM;
    const near = (q: LocalPoint) => Math.hypot(q.east - p.east, q.north - p.north);
    const nearest = <T extends LocalPoint>(list: T[]) => list.map((x) => ({ x, d: near(x) })).filter((x) => x.d <= R).sort((a, b) => a.d - b.d)[0];
    const findable = this.spots.filter((s) => s.kind !== 'edge');
    const total = findable.length;
    const fresh = nearest(findable.filter((s) => !s.found));
    let m: FireMark;
    if (fresh) {
      fresh.x.found = true;
      const n = findable.filter((s) => s.found).length;
      const fire = this.fires.find((f) => f.id === fresh.x.fireId);
      if (fire) fire.located = true;
      m = { ...p, t, result: 'found', fireId: fresh.x.fireId, spotId: fresh.x.id, decoy: null, text: `Огневая точка найдена (${SPOT_NAMES[fresh.x.kind]}): ${n} из ${total}` };
    } else {
      const edge = this.fires.find((f) => inBurn(f, p, R));
      const again = nearest(findable);
      const decoy = nearest(this.decoys);
      if (edge && !edge.located) {
        edge.located = true;
        m = { ...p, t, result: 'located', fireId: edge.id, spotId: null, decoy: null, text: `Очаг подтверждён: пожар № ${edge.id}, кромка ${Math.round(edge.head + edge.back)} × ${Math.round(2 * edge.flank)} м` };
      } else if (edge) m = { ...p, t, result: 'repeat', fireId: edge.id, spotId: null, decoy: null, text: `Пожар № ${edge.id} уже отмечен` };
      else if (again) m = { ...p, t, result: 'repeat', fireId: again.x.fireId, spotId: again.x.id, decoy: null, text: 'Эта огневая точка уже отмечена' };
      else if (decoy) m = { ...p, t, result: 'false', fireId: null, spotId: null, decoy: decoy.x.kind, text: `Ложная отметка: ${DECOY_NAMES[decoy.x.kind]}` };
      else m = { ...p, t, result: 'empty', fireId: null, spotId: null, decoy: null, text: `Пусто: огня в ${R} м от отметки нет` };
    }
    this.marks.push(m);
    return m;
  }

  /**
   * Донесение о дыме: луч из точки o по направлению dir (куда показал оператор в 3D-виде).
   * Засчитывается, если луч проходит по дымовому столбу; ground — точка на рельефе под указателем,
   * по ней считается ошибка места. Отметка ставится там, где луч ближе всего к столбу.
   */
  reportSmoke(o: LocalPoint3, dir: LocalPoint3, ground: LocalPoint | null, t: number): SmokeReport {
    let best: { fire: Fire; plume: FirePlume; distM: number; rangeM: number; at: LocalPoint } | null = null;
    for (const plume of this.plumes()) {
      const fire = this.fires.find((f) => f.id === plume.fireId);
      if (!fire) continue;
      const base = this.groundAt(plume.east, plume.north);
      for (const a of plumeAxis(plume, this.windAt)) {
        const p = { east: a.east, north: a.north, up: base + a.up };
        const { distM, rangeM } = rayDistance(o, dir, p);
        const tol = Math.max(SMOKE_TOL_M, SMOKE_TOL_SHARE * rangeM) + plumeRadius(plume, a.up);
        if (distM > tol) continue;
        const slack = tol - distM;
        if (best && slack <= tol - best.distM) continue;
        best = { fire, plume, distM, rangeM, at: { east: a.east, north: a.north } };
      }
    }
    // Отметка — там, где луч ближе всего к столбу: точка рельефа под указателем уходит за дым на километры.
    const spot = best ? best.at : (ground ?? { east: o.east, north: o.north });
    let r: SmokeReport;
    if (!best) {
      r = { ...spot, t, result: 'false', fireId: null, errorM: null, rangeM: null, text: 'Дыма там нет: донесение не подтвердилось' };
    } else {
      const { fire, rangeM } = best;
      const mid = firePoint(fire, 0, 0.5);
      const errorM = ground ? Math.hypot(ground.east - mid.east, ground.north - mid.north) : null;
      const bearing = Math.round(norm360(Math.atan2(mid.east - o.east, mid.north - o.north) / RAD));
      const where = `${(rangeM / 1000).toFixed(1).replace('.', ',')} км, пеленг ${bearing}°`;
      if (fire.reported) r = { ...spot, t, result: 'repeat', fireId: fire.id, errorM, rangeM, text: `Пожар № ${fire.id} уже доложен` };
      else {
        fire.reported = true;
        // Ошибку места называем, только если оператор показал на землю у очага: щелчок по верху
        // столба уводит точку рельефа на километры за дым, и это не про точность донесения.
        const miss = errorM === null || errorM > SMOKE_PLACE_M ? '' : `, место с ошибкой ${Math.round(errorM)} м`;
        r = { ...spot, t, result: 'reported', fireId: fire.id, errorM, rangeM, text: `Дым доложен: пожар № ${fire.id} — ${where}${miss}` };
      }
    }
    this.reports.push(r);
    return r;
  }

  /** Итог для оценки (AssessInput.fire). */
  result(takeoffT = 0): FireOutcome {
    const findable = this.spots.filter((s) => s.kind !== 'edge');
    const first = [...this.reports.filter((r) => r.result === 'reported'), ...this.marks.filter((m) => m.result === 'located' || m.result === 'found')].sort((a, b) => a.t - b.t)[0];
    return {
      fires: this.fires.length,
      reported: this.fires.filter((f) => f.reported).length,
      located: this.fires.filter((f) => f.located).length,
      spots: findable.length,
      spotsFound: findable.filter((s) => s.found).length,
      falseMarks: this.marks.filter((m) => m.result === 'false' || m.result === 'empty').length + this.reports.filter((r) => r.result === 'false').length,
      firstReportS: first ? Math.max(0, first.t - takeoffT) : null,
    };
  }

  /* ------------------------------ Расстановка ------------------------------ */

  private populate(setup: FireSetup, r: Rng, windToDeg: number, windMs: number): void {
    const d = FIRE_DIFFICULTY[setup.difficulty] ?? FIRE_DIFFICULTY.train;
    const minSite = setup.minSiteDistanceM ?? 1500;
    const taken: LocalPoint[] = [];
    const place = (spacing: number): LocalPoint => {
      const es = this.area.map((p) => p.east);
      const ns = this.area.map((p) => p.north);
      const [e0, e1, n0, n1] = [Math.min(...es), Math.max(...es), Math.min(...ns), Math.max(...ns)];
      let fallback: LocalPoint | null = null;
      for (let k = 0; k < 400; k++) {
        const p = { east: uniform(r, e0, e1), north: uniform(r, n0, n1) };
        if (!insidePolygon(p.east, p.north, this.area)) continue;
        if (Math.hypot(p.east, p.north) < minSite) continue;
        fallback ??= p;
        if (taken.every((q) => Math.hypot(q.east - p.east, q.north - p.north) >= spacing)) {
          taken.push(p);
          return p;
        }
      }
      const p = fallback ?? centroid(this.area);
      taken.push(p);
      return p;
    };
    // Курумник — выше по склонам, зимовья — в распадках: из нескольких мест берём самое высокое (низкое).
    const byHeight = (highest: boolean): LocalPoint => {
      let best: LocalPoint | null = null;
      for (let k = 0; k < 6; k++) {
        const p = place(300);
        const g = this.groundAt(p.east, p.north);
        if (!best || (highest ? g > this.groundAt(best.east, best.north) : g < this.groundAt(best.east, best.north))) best = p;
      }
      return best ?? centroid(this.area);
    };

    const headMs = headRateMs(windMs);
    const fires = int(r, d.fires[0], d.fires[1]);
    for (let i = 1; i <= fires; i++) {
      const p = place(FIRE_SPACING_M);
      const ageS = uniform(r, d.ageMin[0], d.ageMin[1]) * 60;
      const f: Fire = {
        id: i,
        east: p.east,
        north: p.north,
        // Пожар идёт по ветру, но местность его немного разворачивает.
        headingDeg: norm360(windToDeg + uniform(r, -20, 20)),
        headMs,
        flankMs: headMs * FLANK_SHARE,
        backMs: headMs * BACK_SHARE,
        head: IGNITION_M + headMs * ageS,
        flank: IGNITION_M + headMs * FLANK_SHARE * ageS,
        back: IGNITION_M + headMs * BACK_SHARE * ageS,
        reported: false,
        located: false,
      };
      this.fires.push(f);
      for (let k = 0; k < EDGE_POINTS; k++) {
        const phi = (2 * Math.PI * k) / EDGE_POINTS;
        const q = firePoint(f, phi, 1);
        this.spots.push({ id: `edge-${i}-${k}`, kind: 'edge', fireId: i, phi, k: 1, east: q.east, north: q.north, found: false });
      }
      // Угли внутри гари: тлеют там, где огонь уже прошёл, — тыловая половина.
      const embers = int(r, d.embers[0], d.embers[1]);
      for (let k = 0; k < embers; k++) {
        const phi = uniform(r, Math.PI / 2, (3 * Math.PI) / 2);
        const share = uniform(r, 0.3, 0.8);
        const q = firePoint(f, phi, share);
        this.spots.push({ id: `ember-${i}-${k}`, kind: 'ember', fireId: i, phi, k: share, east: q.east, north: q.north, found: false });
      }
      // Переброс искр: очаг за головой кромки, в стороне от неё.
      const spots = int(r, d.spots[0], d.spots[1]);
      for (let k = 0; k < spots; k++) {
        const ahead = f.head + uniform(r, 40, 140);
        const side = uniform(r, -0.6, 0.6) * f.flank;
        const h = f.headingDeg * RAD;
        this.spots.push({
          id: `spot-${i}-${k}`,
          kind: 'spot',
          fireId: i,
          phi: 0,
          k: 0,
          east: f.east + ahead * Math.sin(h) + side * Math.cos(h),
          north: f.north + ahead * Math.cos(h) - side * Math.sin(h),
          found: false,
        });
      }
    }
    // Одиночные тлеющие места после сухих гроз: дыма почти нет, только тепловизор.
    const smolders = int(r, d.smolders[0], d.smolders[1]);
    for (let k = 0; k < smolders; k++) {
      const p = place(SMOLDER_SPACING_M);
      this.spots.push({ id: `smolder-${k}`, kind: 'smolder', fireId: null, phi: 0, k: 0, east: p.east, north: p.north, found: false });
    }
    const decoys = int(r, d.decoys[0], d.decoys[1]);
    for (let k = 0; k < decoys; k++) {
      const rocks = r() < 0.65;
      const p = byHeight(rocks);
      this.decoys.push({ id: `${rocks ? 'rocks' : 'hut'}-${k}`, kind: rocks ? 'rocks' : 'hut', east: p.east, north: p.north, headingDeg: uniform(r, 0, 360) });
    }
  }
}
