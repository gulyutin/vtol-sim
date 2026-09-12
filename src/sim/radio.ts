import { AIRCRAFT } from './aircraft';
import { distanceM, fromLocal, toLocal } from './mission';
import type { GeoPoint, Terrain } from './types';

/** Эквивалентный радиус Земли для радиоволн при стандартной рефракции (4/3 R). */
const EFFECTIVE_EARTH_RADIUS_M = (6371000 * 4) / 3;

export interface LineOfSight {
  clear: boolean;
  /** Наименьший просвет между лучом и рельефом, м; отрицательный — луч упирается в рельеф. */
  clearanceM: number;
  distanceM: number;
}

/**
 * Прямая видимость между антенной НСУ и бортом: рельеф и кривизна Земли (4/3 R), без учёта
 * зоны Френеля. По РЛЭ нужна прямая видимость с самой дальней точкой маршрута.
 */
export function lineOfSight(
  terrain: Terrain,
  antenna: GeoPoint & { altitudeM: number },
  target: GeoPoint & { altitudeM: number },
  samples = 80,
): LineOfSight {
  const d = distanceM(antenna, target);
  let clearanceM = Infinity;
  for (let i = 1; i < samples; i++) {
    const f = i / samples;
    const p = { lat: antenna.lat + (target.lat - antenna.lat) * f, lon: antenna.lon + (target.lon - antenna.lon) * f };
    const x = d * f;
    const ray = antenna.altitudeM + (target.altitudeM - antenna.altitudeM) * f;
    // Выпуклость Земли над хордой между антенной и бортом.
    const bulge = (x * (d - x)) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    clearanceM = Math.min(clearanceM, ray - terrain.elevationM(p) - bulge);
  }
  return { clear: clearanceM > 0, clearanceM, distanceM: d };
}

/*
 * Радиолиния НСУ ↔ борт с учётом рельефа.
 *
 * Запас линии, дБ: M = 20·lg(R / r) − Lдифр − Lпом, где r — наклонная дальность,
 * R — дальность связи из профиля. Потери в свободном пространстве растут как 20·lg r, поэтому
 * при чистой зоне Френеля запас обращается в ноль ровно на дальности R — энергетику линии
 * (мощность, усиления антенн, чувствительность) задавать не нужно.
 * Lдифр — дифракция на рельефе по Буллингтону (МСЭ-R P.526): профиль между антеннами с шагом,
 * выпуклость Земли с k = 4/3, одно эквивалентное клиновидное препятствие; препятствие, лишь
 * задевающее первую зону Френеля, даёт 0…6 дБ, касание луча — 6 дБ.
 * Lпом — подавление связи помехой (РЭБ).
 * Параметры условные: частота, высота мачты, пороги и частота телеметрии — не паспортные.
 */

/** Антенна: точка и высота над уровнем моря, м. */
export type Station = GeoPoint & { altitudeM: number };

export interface RadioParams {
  /** Дальность связи при прямой видимости и чистой зоне Френеля, м: здесь запас — ноль. */
  rangeM: number;
  frequencyMHz: number;
  /** Антенна НСУ и наземного ретранслятора над землёй, м. */
  groundAntennaM: number;
  /** Коэффициент эквивалентного радиуса Земли. */
  k: number;
  /** Шаг профиля рельефа, м. */
  stepM: number;
  /** Точек профиля не больше — на дальних трассах шаг растёт. */
  maxSamples: number;
}

/** Условные параметры линии; дальность — из профиля аппарата. */
export const RADIO: RadioParams = {
  rangeM: AIRCRAFT.limits.radioRangeM,
  frequencyMHz: 900,
  groundAntennaM: 3,
  k: 4 / 3,
  stepM: 50,
  maxSamples: 1200,
};

/** Уровень сигнала при нулевом запасе, дБм (условная чувствительность приёмника). */
export const SENSITIVITY_DBM = -100;
/** Запас, при котором индикатор силы сигнала полный, дБ. */
export const QUALITY_FULL_DB = 20;
/** Частота телеметрии на НСУ без потерь, Гц. */
export const TELEMETRY_HZ = 10;
/**
 * Подавление связи помехой полной силы (внутри зоны РЭБ), дБ: дальность падает в 10⁴ раз.
 * На половине силы (граница действия зоны) — 40 дБ: связь держится только в сотой доле дальности.
 */
export const JAM_FULL_DB = 80;
/** Антенна борта над его точкой, м — важно только на земле. */
export const BOARD_ANTENNA_M = 0.5;
/** Связь хорошая — запас не меньше, дБ (потери пакетов ~3 %). */
export const LINK_GOOD_DB = 6;
/** Связи нет — запас ниже, дБ (потери пакетов больше 80 %). */
export const LINK_LOST_DB = 0;
/** Гистерезис границы «хорошая / плохая», ± дБ; хорошей связь снова становится, продержавшись LINK_GOOD_DWELL_S. */
export const LINK_HYSTERESIS_DB = 1;
export const LINK_GOOD_DWELL_S = 2;
/** Связь теряется, если запас ниже LINK_LOST_DB дольше, с. */
export const LINK_LOSS_S = 2;
/** Связь восстанавливается, если запас не ниже LINK_LOST_DB + LINK_RESTORE_DB дольше, с. */
export const LINK_RESTORE_S = 1;
export const LINK_RESTORE_DB = 2;
/** Период расчёта линии в полёте, с. */
export const LINK_PERIOD_S = 0.25;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lambdaM = (r: RadioParams) => 299.792458 / r.frequencyMHz;
const aeM = (r: RadioParams) => 6371000 * r.k;

/** Потери на клиновидном препятствии, дБ (МСЭ-R P.526); ν — параметр дифракции Френеля — Кирхгофа. */
export function knifeEdgeDb(nu: number): number {
  if (nu <= -0.78) return 0;
  const v = nu - 0.1;
  return 6.9 + 20 * Math.log10(Math.sqrt(v * v + 1) + v);
}

/** Доля потерянных пакетов при запасе marginDb: 50 % при +2 дБ, 3 % при +6 дБ. */
export function packetLoss(marginDb: number): number {
  return 1 / (1 + Math.exp((marginDb - 2) / 1.2));
}

/**
 * Цена звена для выбора цепочки — ожидаемое число передач пакета (ETX, как в mesh-сетях):
 * 1/(1 − потери). Хорошее звено стоит ~1, поэтому лишний ретранслятор без нужды не берётся.
 */
export function hopCost(marginDb: number): number {
  return 1 + Math.min(1e12, Math.exp(-(marginDb - 2) / 1.2));
}

/** Подавление связи, дБ, по силе помехи 0…1 (state.ew.linkJam). */
export function linkJamDb(jam: number): number {
  return clamp01(jam) * JAM_FULL_DB;
}

interface Diffraction {
  lossDb: number;
  los: boolean;
  /** Точка профиля с наибольшим ν — главное препятствие. */
  i: number;
  nu: number;
  /** Насколько рельеф в этой точке выше луча, м (с выпуклостью Земли). */
  aboveM: number;
}

/**
 * Дифракция по Буллингтону. h[1…n−1] — рельеф над морем в точках x = d·i/n, антенны
 * на высотах ha (x = 0) и hb (x = d) над морем.
 */
function bullington(h: Float64Array, xs: Float64Array, n: number, d: number, ha: number, hb: number, lambda: number, ae: number): Diffraction {
  if (n < 2 || !(d > 0)) return { lossDb: 0, los: true, i: 0, nu: -Infinity, aboveM: -Infinity };
  const str = (hb - ha) / d;
  let stim = -Infinity;
  let srim = -Infinity;
  let nuMax = -Infinity;
  let iMax = 0;
  let above = -Infinity;
  for (let i = 1; i < n; i++) {
    const x = xs[i]!;
    const y = d - x;
    const hi = h[i]! + (x * y) / (2 * ae);
    const st = (hi - ha) / x;
    if (st > stim) stim = st;
    const sr = (hi - hb) / y;
    if (sr > srim) srim = sr;
    const a = hi - (ha * y + hb * x) / d;
    const nu = a * Math.sqrt((2 * d) / (lambda * x * y));
    if (nu > nuMax) {
      nuMax = nu;
      iMax = i;
      above = a;
    }
  }
  const los = stim < str;
  let nu = nuMax;
  if (!los && stim + srim > 1e-12) {
    // Эквивалентное препятствие — пересечение лучей к горизонтам обеих антенн.
    const xb = Math.min(xs[n - 1]!, Math.max(xs[1]!, (hb - ha + srim * d) / (stim + srim)));
    const yb = d - xb;
    nu = (ha + stim * xb - (ha * yb + hb * xb) / d) * Math.sqrt((2 * d) / (lambda * xb * yb));
  }
  return { lossDb: knifeEdgeDb(nu), los, i: iMax, nu: nuMax, aboveM: above };
}

let scratchH = new Float64Array(2048);
let scratchX = new Float64Array(2048);
function buffers(n: number): [Float64Array, Float64Array] {
  if (scratchH.length <= n) {
    scratchH = new Float64Array(2 * n + 1);
    scratchX = new Float64Array(2 * n + 1);
  }
  return [scratchH, scratchX];
}

const radioOf = (r?: Partial<RadioParams>): RadioParams => (r ? { ...RADIO, ...r } : RADIO);
const freeSpaceMarginDb = (r: RadioParams, slantM: number) => 20 * Math.log10(r.rangeM / Math.max(1, slantM));

export interface LinkBudget {
  /** Запас линии, дБ: ниже LINK_LOST_DB связи нет. */
  marginDb: number;
  /** Сила сигнала для индикатора 0…1. */
  quality: number;
  /** Уровень сигнала, дБм (условный). */
  rssiDbm: number;
  /** Прямая видимость — луч не задевает рельеф (зона Френеля не в счёт). */
  los: boolean;
  /**
   * Главное препятствие, если оно задевает первую зону Френеля: расстояние от первой антенны, м,
   * насколько рельеф выше луча, м (отрицательно — ниже луча, но в зоне Френеля), высота рельефа, где.
   */
  obstruction?: { distanceM: number; heightM: number; elevationM: number; at: GeoPoint };
  /** Потери на рельефе, дБ. */
  diffractionDb: number;
  /** Горизонтальная дальность, м. */
  distanceM: number;
}

function budgetOf(marginDb: number, los: boolean, diffractionDb: number, d: number, obstruction?: LinkBudget['obstruction']): LinkBudget {
  const b: LinkBudget = { marginDb, quality: clamp01(marginDb / QUALITY_FULL_DB), rssiDbm: SENSITIVITY_DBM + marginDb, los, diffractionDb, distanceM: d };
  if (obstruction) b.obstruction = obstruction;
  return b;
}

/** Линия между двумя антеннами. jamDb — подавление помехой, дБ. */
export function linkBudget(terrain: Terrain, a: Station, b: Station, o: { jamDb?: number; radio?: Partial<RadioParams> } = {}): LinkBudget {
  const r = radioOf(o.radio);
  const d = distanceM(a, b);
  const step = Math.max(r.stepM, d / r.maxSamples);
  const n = Math.max(2, Math.ceil(d / step));
  const [h, xs] = buffers(n);
  // Точки профиля — на постоянных расстояниях от первой антенны: пока борт летит от неё или
  // к ней, гребень берётся в той же точке и запас не скачет от шага выборки.
  for (let i = 1; i < n && d > 0; i++) {
    const f = (i * step) / d;
    xs[i] = i * step;
    h[i] = terrain.elevationM({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
  }
  const df = bullington(h, xs, n, d, a.altitudeM, b.altitudeM, lambdaM(r), aeM(r));
  const margin = freeSpaceMarginDb(r, Math.hypot(d, b.altitudeM - a.altitudeM)) - df.lossDb - (o.jamDb ?? 0);
  const f = d > 0 ? xs[df.i]! / d : 0;
  const obstruction =
    df.nu > -0.78
      ? { distanceM: d * f, heightM: df.aboveM, elevationM: h[df.i]!, at: { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f } }
      : undefined;
  return budgetOf(margin, df.los, df.lossDb, d, obstruction);
}

/** Антенна на мачте над рельефом (НСУ, наземный ретранслятор). */
export function groundStation(terrain: Terrain, p: GeoPoint, antennaM = RADIO.groundAntennaM): Station {
  return { lat: p.lat, lon: p.lon, altitudeM: terrain.elevationM(p) + antennaM };
}

/** Ретранслятор: наземный на мачте над рельефом или на аппарате-ретрансляторе на высоте над морем. */
export type Relay = GeoPoint & ({ kind: 'ground'; antennaM?: number } | { kind: 'air'; altitudeM: number }) & {
  /** Где стоит — для брифинга: «на гребне над посёлком». */
  name?: string;
};

export function relayStation(terrain: Terrain, relay: Relay, radio: Partial<RadioParams> = {}): Station {
  return relay.kind === 'air'
    ? { lat: relay.lat, lon: relay.lon, altitudeM: relay.altitudeM }
    : groundStation(terrain, relay, relay.antennaM ?? radioOf(radio).groundAntennaM);
}

export interface LinkResult extends LinkBudget {
  /** Через какие ретрансляторы (номера в списке) от НСУ; пусто — напрямую. */
  via: number[];
  /**
   * Звенья от НСУ к борту. Запас, сила сигнала и видимость итога — по худшему звену,
   * obstruction — у худшего звена (расстояние от его начала); distanceM — от НСУ до борта напрямую.
   */
  hops: LinkBudget[];
}

/**
 * НСУ и ретрансляторы. Звенья между ними неподвижны и считаются один раз. До борта — цепочка
 * с наименьшей суммой hopCost (прямая линия — тоже цепочка), запас цепочки — по худшему звену.
 */
export class LinkNetwork {
  readonly radio: RadioParams;
  /** 0 — НСУ, дальше ретрансляторы по порядку. */
  readonly stations: Station[];
  /** Цена лучшей цепочки от НСУ до станции (сумма hopCost); у НСУ — 0. */
  readonly cost: number[];
  /** Запас этой цепочки по худшему звену, дБ; у НСУ — +∞. */
  readonly up: number[];
  private readonly prev: number[];
  private readonly hop: (LinkBudget | undefined)[][];
  /** Станции по возрастанию цены — чтобы отбрасывать заведомо худшие цепочки. */
  readonly order: number[];

  /**
   * gcsJamDb — помеха у НСУ: глушит приём телеметрии, действует на звенья от НСУ (линия
   * рвётся, если не проходит в любую сторону, поэтому с помехой у борта — по большей).
   */
  constructor(
    readonly terrain: Terrain,
    gcs: Station,
    readonly relays: readonly Relay[] = [],
    radio?: Partial<RadioParams>,
    readonly gcsJamDb = 0,
  ) {
    this.radio = radioOf(radio);
    this.stations = [gcs, ...relays.map((r) => relayStation(terrain, r, this.radio))];
    const m = this.stations.length;
    this.hop = this.stations.map(() => new Array<LinkBudget | undefined>(m));
    this.cost = this.stations.map((_, i) => (i === 0 ? 0 : Infinity));
    this.up = this.stations.map((_, i) => (i === 0 ? Infinity : -Infinity));
    this.prev = this.stations.map(() => -1);
    // Дейкстра по цене звеньев.
    const done = new Array<boolean>(m).fill(false);
    for (let k = 0; k < m; k++) {
      let i = -1;
      for (let j = 0; j < m; j++) if (!done[j] && (i < 0 || this.cost[j]! < this.cost[i]!)) i = j;
      done[i] = true;
      for (let j = 0; j < m; j++) {
        if (done[j]) continue;
        const b = this.budget(i, j);
        const c = this.cost[i]! + hopCost(b.marginDb);
        if (c < this.cost[j]!) {
          this.cost[j] = c;
          this.up[j] = Math.min(this.up[i]!, b.marginDb);
          this.prev[j] = i;
        }
      }
    }
    this.order = this.stations.map((_, i) => i).sort((a, b) => this.cost[a]! - this.cost[b]!);
  }

  private budget(i: number, j: number): LinkBudget {
    const jamDb = i === 0 || j === 0 ? this.gcsJamDb : 0;
    const b = this.hop[i]![j] ?? linkBudget(this.terrain, this.stations[i]!, this.stations[j]!, { radio: this.radio, jamDb });
    this.hop[i]![j] = b;
    return b;
  }

  /** Лучшая линия до борта. jamDb — подавление на борту: действует на звено, которое к нему приходит. */
  link(target: Station, jamDb = 0): LinkResult {
    let bestCost = Infinity;
    let best = -Infinity;
    let from = 0;
    let last: LinkBudget | null = null;
    for (const s of this.order) {
      // Каждое звено стоит не меньше 1.
      if (last && this.cost[s]! + 1 >= bestCost) break;
      const b = linkBudget(this.terrain, this.stations[s]!, target, { radio: this.radio, jamDb: s === 0 ? Math.max(jamDb, this.gcsJamDb) : jamDb });
      const c = this.cost[s]! + hopCost(b.marginDb);
      if (!last || c < bestCost) {
        bestCost = c;
        best = Math.min(this.up[s]!, b.marginDb);
        from = s;
        last = b;
      }
    }
    const chain: number[] = [];
    for (let s = from; s > 0; s = this.prev[s]!) chain.unshift(s);
    const hops: LinkBudget[] = [];
    let a = 0;
    for (const s of chain) {
      hops.push(this.budget(a, s));
      a = s;
    }
    hops.push(last!);
    const weak = hops.reduce((w, h) => (h.marginDb < w.marginDb ? h : w));
    const res: LinkResult = {
      ...budgetOf(best, hops.every((h) => h.los), weak.diffractionDb, distanceM(this.stations[0]!, target), weak.obstruction),
      via: chain.map((s) => s - 1),
      hops,
    };
    return res;
  }
}

/** Лучшая линия НСУ → борт, напрямую или через ретрансляторы. */
export function bestLink(
  terrain: Terrain,
  gcs: Station,
  target: Station,
  o: { relays?: readonly Relay[]; jamDb?: number; radio?: Partial<RadioParams> } = {},
): LinkResult {
  return new LinkNetwork(terrain, gcs, o.relays, o.radio).link(target, o.jamDb);
}

/**
 * Наименьшая высота над морем в точке p, с которой запас линии не меньше targetDb;
 * null — не набирается и на maxAglM над рельефом.
 */
export function minLinkAltitudeM(net: LinkNetwork, p: GeoPoint, o: { targetDb?: number; maxAglM?: number; jamDb?: number } = {}): number | null {
  const target = o.targetDb ?? LINK_LOST_DB;
  const at = (alt: number) => net.link({ lat: p.lat, lon: p.lon, altitudeM: alt }, o.jamDb).marginDb;
  let lo = net.terrain.elevationM(p);
  let hi = lo + (o.maxAglM ?? 5000);
  if (at(lo) >= target) return lo;
  if (at(hi) < target) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

// --- Для оператора: состояние связи с гистерезисом ---

export type LinkStatus = 'good' | 'poor' | 'lost';

/**
 * Что видит оператор: связь есть / плохая / нет, потери пакетов и частота телеметрии.
 * Граница «хорошая / плохая» — с гистерезисом ±LINK_HYSTERESIS_DB; связь теряется, если запас
 * ниже LINK_LOST_DB дольше LINK_LOSS_S, и возвращается, когда он LINK_RESTORE_S держится
 * не ниже LINK_LOST_DB + LINK_RESTORE_DB — на границе не мигает.
 */
export class LinkMonitor {
  status: LinkStatus = 'good';
  /** Доля потерянных пакетов телеметрии 0…1, сглаженная за ~1 с. */
  loss = 0;
  /** Сколько секунд подряд запас ниже порога потери / выше порога восстановления. */
  private belowS = 0;
  private aboveS = 0;
  private goodS = 0;

  update(dt: number, marginDb: number): LinkStatus {
    if (this.status === 'lost') {
      this.aboveS = marginDb >= LINK_LOST_DB + LINK_RESTORE_DB ? this.aboveS + dt : 0;
      if (this.aboveS >= LINK_RESTORE_S) {
        this.status = marginDb >= LINK_GOOD_DB + LINK_HYSTERESIS_DB ? 'good' : 'poor';
        this.belowS = 0;
        // Модемы синхронизировались — пакеты сразу идут с потерями по запасу.
        this.loss = packetLoss(marginDb);
        return this.status;
      }
    } else {
      this.belowS = marginDb < LINK_LOST_DB ? this.belowS + dt : 0;
      if (this.belowS >= LINK_LOSS_S) {
        this.status = 'lost';
        this.aboveS = 0;
      } else if (this.status === 'good' && marginDb < LINK_GOOD_DB - LINK_HYSTERESIS_DB) {
        this.status = 'poor';
        this.goodS = 0;
      } else if (this.status === 'poor') {
        // Хорошей связь становится, продержавшись: над неровным рельефом запас скачет.
        this.goodS = marginDb >= LINK_GOOD_DB + LINK_HYSTERESIS_DB ? this.goodS + dt : 0;
        if (this.goodS >= LINK_GOOD_DWELL_S) this.status = 'good';
      }
    }
    const goal = this.status === 'lost' ? 1 : packetLoss(marginDb);
    this.loss += (goal - this.loss) * (1 - Math.exp(-dt / 1));
    return this.status;
  }

  get lost(): boolean {
    return this.status === 'lost';
  }

  /** Частота обновления телеметрии на НСУ, Гц. */
  get telemetryHz(): number {
    return TELEMETRY_HZ * (1 - this.loss);
  }
}

/** Связь для НСУ, тревог и голоса (LiveState.link). */
export interface LinkState {
  status: LinkStatus;
  marginDb: number;
  /** Сила сигнала 0…1; 0 — связи нет. */
  quality: number;
  rssiDbm: number;
  /** Потери пакетов 0…1 и частота обновления телеметрии на НСУ, Гц. */
  loss: number;
  telemetryHz: number;
  los: boolean;
  /** Через какие ретрансляторы (номера в списке); пусто — напрямую. */
  via: number[];
  /** Главное препятствие на худшем звене: где и насколько выше луча, м. */
  obstruction: { at: GeoPoint; heightM: number } | null;
  /** Что ослабляет связь: рельеф, дальность, помехи; null — связь хорошая. */
  cause: 'terrain' | 'range' | 'jam' | null;
}

/**
 * Линия в полёте: расчёт по рельефу — раз в periodS (дорого), состояние для оператора — каждый шаг.
 */
export class RadioLink {
  readonly monitor = new LinkMonitor();
  /** Последний расчёт линии; null — ещё не было. */
  last: LinkResult | null = null;
  private net: LinkNetwork;
  private sinceS = 0;
  private jamDb = 0;

  constructor(
    private readonly terrain: Terrain,
    readonly gcs: Station,
    relays: readonly Relay[] = [],
    private readonly radio?: Partial<RadioParams>,
    readonly periodS = LINK_PERIOD_S,
  ) {
    this.net = new LinkNetwork(terrain, gcs, relays, radio);
  }

  get relays(): readonly Relay[] {
    return this.net.relays;
  }

  /** НСУ и ретрансляторы — для графика и покрытия теми же звеньями. */
  get network(): LinkNetwork {
    return this.net;
  }

  /** Поставить или убрать ретрансляторы; следующий шаг пересчитает линию. */
  setRelays(relays: readonly Relay[]): void {
    this.net = new LinkNetwork(this.terrain, this.gcs, relays, this.radio, this.net.gcsJamDb);
    this.last = null;
  }

  /** Помеха у НСУ, дБ (зоны РЭБ меняются редко — сеть пересобирается). */
  setGcsJamDb(db: number): void {
    if (db === this.net.gcsJamDb) return;
    this.net = new LinkNetwork(this.terrain, this.gcs, this.net.relays, this.radio, db);
    this.last = null;
  }

  /** dt — шаг, с; aircraft — антенна борта; jamDb — подавление помехой у борта. */
  update(dt: number, aircraft: Station, jamDb = 0): LinkStatus {
    this.sinceS += dt;
    if (!this.last || this.sinceS >= this.periodS) {
      this.last = this.net.link(aircraft, jamDb);
      this.jamDb = Math.max(jamDb, this.net.gcsJamDb);
      this.sinceS = 0;
    }
    return this.monitor.update(dt, this.last.marginDb);
  }

  get status(): LinkStatus {
    return this.monitor.status;
  }

  /** Состояние для оператора по последнему расчёту. */
  get state(): LinkState {
    const r = this.last;
    const m = this.monitor;
    const lost = m.status === 'lost';
    const margin = r?.marginDb ?? Infinity;
    let cause: LinkState['cause'] = null;
    if (r && m.status !== 'good') {
      if (this.jamDb > 0 && margin + this.jamDb >= LINK_GOOD_DB) cause = 'jam';
      else if (!r.los || r.diffractionDb > 3) cause = 'terrain';
      else cause = 'range';
    }
    return {
      status: m.status,
      marginDb: margin,
      quality: lost ? 0 : (r?.quality ?? 1),
      rssiDbm: r?.rssiDbm ?? SENSITIVITY_DBM + QUALITY_FULL_DB,
      loss: m.loss,
      telemetryHz: m.telemetryHz,
      los: r?.los ?? true,
      via: r ? [...r.via] : [],
      obstruction: r?.obstruction ? { at: { ...r.obstruction.at }, heightM: r.obstruction.heightM } : null,
      cause,
    };
  }
}

// --- Вдоль маршрута ---

export interface PathLinkPoint extends LinkResult {
  /** От начала пути, м. */
  alongM: number;
  point: Station;
  /** Наименьшая высота над морем, с которой здесь есть связь (если просили minAltitude). */
  minAltitudeM?: number | null;
}

export interface PathLink {
  points: PathLinkPoint[];
  lengthM: number;
  minMarginDb: number;
  /** Длина пути, где запас ниже LINK_LOST_DB, м. */
  lostM: number;
  /** Участки без связи: от и до, м от начала пути. */
  lostStretches: { fromM: number; toM: number }[];
  /** Длина пути, где связь есть, но плохая (запас ниже LINK_GOOD_DB), м. */
  poorM: number;
  /** Дальше всего от НСУ, м. */
  farthestM: number;
}

export interface PathLinkOptions {
  relays?: readonly Relay[];
  radio?: Partial<RadioParams>;
  /** Помеха у НСУ, дБ. */
  gcsJamDb?: number;
  stepM?: number;
  maxPoints?: number;
  minAltitude?: boolean;
  jamDb?: number;
}

/**
 * Запас линии по точкам пути (высоты — над морем): путь размечается через stepM, высота между
 * вершинами — линейно. Для предполётной проверки и графика «Рельеф вдоль маршрута».
 */
export function linkAlongPath(terrain: Terrain, gcs: Station, path: readonly Station[], o: PathLinkOptions = {}): PathLink {
  return linkAlongNetwork(new LinkNetwork(terrain, gcs, o.relays, o.radio, o.gcsJamDb), path, o);
}

/** То же по готовой сети (например, LiveFlight.radioNetwork). */
export function linkAlongNetwork(net: LinkNetwork, path: readonly Station[], o: PathLinkOptions = {}): PathLink {
  const cum = [0];
  for (let k = 1; k < path.length; k++) cum.push(cum[k - 1]! + distanceM(path[k - 1]!, path[k]!));
  const length = cum[cum.length - 1] ?? 0;
  const step = Math.max(o.stepM ?? 200, length / (o.maxPoints ?? 1000));
  const at: number[] = [];
  for (let s = 0; s < length; s += step) at.push(s);
  at.push(length);
  const points: PathLinkPoint[] = [];
  let k = 1;
  for (const s of at) {
    if (path.length === 0) break;
    while (k < path.length - 1 && cum[k]! < s) k++;
    const a = path[Math.max(0, k - 1)]!;
    const b = path[Math.min(k, path.length - 1)]!;
    const seg = (cum[k] ?? 0) - (cum[k - 1] ?? 0);
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - cum[k - 1]!) / seg)) : 1;
    const p: Station = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, altitudeM: a.altitudeM + (b.altitudeM - a.altitudeM) * f };
    const res: PathLinkPoint = { ...net.link(p, o.jamDb), alongM: s, point: p };
    if (o.minAltitude) res.minAltitudeM = minLinkAltitudeM(net, p, { jamDb: o.jamDb });
    points.push(res);
  }
  // Точка представляет половину соседних промежутков.
  let lostM = 0;
  let poorM = 0;
  const lostStretches: PathLink['lostStretches'] = [];
  for (let i = 0; i < points.length; i++) {
    const m = points[i]!.marginDb;
    if (m >= LINK_GOOD_DB) continue;
    const l = (points[Math.max(0, i - 1)]!.alongM + points[i]!.alongM) / 2;
    const r = (points[Math.min(points.length - 1, i + 1)]!.alongM + points[i]!.alongM) / 2;
    if (m >= LINK_LOST_DB) {
      poorM += r - l;
      continue;
    }
    lostM += r - l;
    const last = lostStretches[lostStretches.length - 1];
    if (last && last.toM >= l - 1e-6) last.toM = r;
    else lostStretches.push({ fromM: l, toM: r });
  }
  return {
    points,
    lengthM: length,
    minMarginDb: Math.min(...points.map((p) => p.marginDb)),
    lostM,
    lostStretches,
    poorM,
    farthestM: Math.max(0, ...points.map((p) => p.distanceM)),
  };
}

/**
 * Запас линии и наименьшая высота связи в каждой точке пути — для графика профиля. Считается
 * не больше чем в maxPoints точках, между ними — линейно.
 */
export function linkProfile(
  net: LinkNetwork,
  path: readonly Station[],
  o: { maxPoints?: number; minAltitude?: boolean; jamDb?: number } = {},
): { link: number[]; minLinkAlt: (number | null)[] } {
  const n = path.length;
  const link: number[] = new Array<number>(n);
  const minLinkAlt: (number | null)[] = new Array<number | null>(n).fill(null);
  if (n === 0) return { link, minLinkAlt };
  const m = Math.min(n, Math.max(2, o.maxPoints ?? 150));
  const idx = [...new Set(Array.from({ length: m }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, m - 1))))];
  const withAlt = o.minAltitude ?? true;
  const got = idx.map((i) => ({
    i,
    margin: net.link(path[i]!, o.jamDb).marginDb,
    alt: withAlt ? minLinkAltitudeM(net, path[i]!, { jamDb: o.jamDb }) : null,
  }));
  for (let g = 0; g < got.length; g++) {
    const a = got[g]!;
    const b = got[Math.min(got.length - 1, g + 1)]!;
    for (let i = a.i; i <= b.i; i++) {
      const f = b.i > a.i ? (i - a.i) / (b.i - a.i) : 0;
      link[i] = a.margin + (b.margin - a.margin) * f;
      minLinkAlt[i] = a.alt !== null && b.alt !== null ? a.alt + (b.alt - a.alt) * f : f < 0.5 ? a.alt : b.alt;
    }
  }
  return { link, minLinkAlt };
}

// --- Сетка покрытия («радиотень» на карте) ---

export interface RadioCoverage {
  /** Юго-западный угол сетки, м от origin (как toLocal), шаг и размер — как у Coverage в survey.ts. */
  e0: number;
  n0: number;
  cellM: number;
  cols: number;
  rows: number;
  /** Запас линии в центре клетки на высоте heightAglM над рельефом, дБ; строка 0 — южная. */
  marginDb: Float32Array;
}

export interface CoverageOptions {
  /** Начало локальных координат. */
  origin: GeoPoint;
  /** Область, м от origin: восток e0…e1, север n0…n1. */
  e0: number;
  n0: number;
  e1: number;
  n1: number;
  /** Высота борта над рельефом, м. */
  heightAglM: number;
  /** Шаг сетки и профиля, м. */
  cellM?: number;
  relays?: readonly Relay[];
  radio?: Partial<RadioParams>;
  /** Помеха у НСУ, дБ. */
  gcsJamDb?: number;
}

/**
 * Сетка запаса линии по области — по строкам, чтобы не вешать интерфейс: генератор отдаёт долю
 * готового после каждой строки, результат — в return. Упрощение ради скорости: рельеф берётся
 * один раз в узлах сетки (шаг cellM) и между ними — билинейно, профиль — с тем же шагом.
 */
export function* coverageSteps(terrain: Terrain, gcs: Station, o: CoverageOptions): Generator<number, RadioCoverage> {
  const net = new LinkNetwork(terrain, gcs, o.relays, o.radio, o.gcsJamDb);
  const r = net.radio;
  const cell = o.cellM ?? 250;
  const cols = Math.max(1, Math.ceil((o.e1 - o.e0) / cell));
  const rows = Math.max(1, Math.ceil((o.n1 - o.n0) / cell));
  // Узлы рельефа — в центрах клеток; сетка узлов расширена, чтобы в неё попали все станции.
  const st = net.stations.map((s, i) => {
    const l = toLocal(o.origin, s);
    return { x: (l.east - o.e0) / cell - 0.5, y: (l.north - o.n0) / cell - 0.5, alt: s.altitudeM, up: net.up[i]!, cost: net.cost[i]!, jam: i === 0 ? net.gcsJamDb : 0 };
  });
  const iLo = Math.min(0, ...st.map((s) => Math.floor(s.x))) - 1;
  const jLo = Math.min(0, ...st.map((s) => Math.floor(s.y))) - 1;
  const W = Math.max(cols - 1, ...st.map((s) => Math.ceil(s.x))) + 2 - iLo;
  const H = Math.max(rows - 1, ...st.map((s) => Math.ceil(s.y))) + 2 - jLo;
  const grid = new Float64Array(W * H);
  for (let J = 0; J < H; J++) {
    for (let I = 0; I < W; I++) grid[J * W + I] = terrain.elevationM(fromLocal(o.origin, o.e0 + (I + iLo + 0.5) * cell, o.n0 + (J + jLo + 0.5) * cell));
  }
  yield 0;
  const sample = (x: number, y: number) => {
    const fx = Math.min(W - 1.000001, Math.max(0, x - iLo));
    const fy = Math.min(H - 1.000001, Math.max(0, y - jLo));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const k = j * W + i;
    return (grid[k]! * (1 - u) + grid[k + 1]! * u) * (1 - v) + (grid[k + W]! * (1 - u) + grid[k + W + 1]! * u) * v;
  };
  const stations = net.order.map((i) => st[i]!);
  const lambda = lambdaM(r);
  const ae = aeM(r);
  const h = new Float64Array(r.maxSamples + 1);
  const xs = new Float64Array(r.maxSamples + 1);
  const marginDb = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const hb = grid[(j - jLo) * W + (i - iLo)]! + o.heightAglM;
      let best = -Infinity;
      let bestCost = Infinity;
      for (const s of stations) {
        if (s.cost + 1 >= bestCost) break;
        const dx = i - s.x;
        const dy = j - s.y;
        const d = Math.hypot(dx, dy) * cell;
        const n = Math.min(r.maxSamples, Math.max(2, Math.ceil(d / cell)));
        for (let q = 1; q < n; q++) {
          h[q] = sample(s.x + (dx * q) / n, s.y + (dy * q) / n);
          xs[q] = (d * q) / n;
        }
        const m = freeSpaceMarginDb(r, Math.hypot(d, hb - s.alt)) - bullington(h, xs, n, d, s.alt, hb, lambda, ae).lossDb - s.jam;
        const c = s.cost + hopCost(m);
        if (c < bestCost) {
          bestCost = c;
          best = Math.min(s.up, m);
        }
      }
      marginDb[j * cols + i] = best;
    }
    yield (j + 1) / rows;
  }
  return { e0: o.e0, n0: o.n0, cellM: cell, cols, rows, marginDb };
}

/** Сетка запаса линии целиком (см. coverageSteps). */
export function coverageGrid(terrain: Terrain, gcs: Station, o: CoverageOptions): RadioCoverage {
  const g = coverageSteps(terrain, gcs, o);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
