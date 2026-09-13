import { AIRCRAFT } from './aircraft';
import { climbPowerW, takeoffMassKg } from './aero';
import { airDensity, batteryCapacityWh, G, tasFromIas, temperatureAt } from './atmosphere';
import { bearingDeg, destination, distanceM, landingPhases, takeoffPhases, toLocal, transitionPhase } from './mission';
import { flatTerrain, followTerrain, terrainEndAltitudes, type TerrainFollowing } from './terrain';
import type { GeoPoint, PayloadLoad, Site, Terrain, Weather, Wind } from './types';
import { windAt, windTriangle } from './wind';

/*
 * Карта досягаемости: куда аппарат долетит и вернётся на базу с посадкой, не трогая резерв АКБ по РЛЭ.
 *
 * Модель — та же, что у simulateMission (mission.ts), только по лучам:
 *  - из точки старта — rays лучей; вдоль каждого профиль с огибанием рельефа (followTerrain) на высоте
 *    полёта, набор и снижение не круче 90 % предельных — как строится маршрут задания;
 *  - на каждом отрезке — плотность по высоте и температуре, истинная из приборной, ветер на высоте
 *    над рельефом (сдвиг по высоте), треугольник скоростей, мощность climbPowerW;
 *  - обратно — «поле возврата» от дома: те же лучи, но полёт к дому и посадка (снижение к высоте
 *    обратного перехода, вертикальные фазы). Цена возврата из любой точки — интерполяция по полю;
 *  - на планировании — вертикальный взлёт и переход (takeoffPhases, transitionPhase; у крутого
 *    рельефа — выше, terrainEndAltitudes), в полёте — от текущей высоты;
 *  - при ветре — лишний путь взлётного и посадочного маршрутов по РЛЭ (разгон и заход против ветра);
 *  - разворот в дальней точке — с предельным креном; нагрузка — по времени полёта.
 * Запас m — доля доступной энергии (сверх резерва), которая останется после посадки дома.
 * В этой модели снижение возвращает энергию набора с тем же КПД (climbPowerW), поэтому гряда на пути
 * туда-обратно почти бесплатна; «в один конец» на возвышенность — дороже на набор.
 */

const VT = AIRCRAFT.vtol;
const RAD = Math.PI / 180;
/** Как в scenarios.ts: набор и снижение маршрута — 90 % предельных. */
const CLIMB = () => AIRCRAFT.planeClimbRateMaxMs * 0.9;
const DESCENT = () => AIRCRAFT.planeDescentRateMaxMs * 0.9;
const MAX_EXTRA_VERTICAL_M = 200;
const BETWEEN_SAMPLES_M = 15;
/** Участок у площадки, по которому решается, не поднять ли переход выше (крутой рельеф), м. */
const PAD_CHECK_M = 3000;
/** Слабее этого ветер направления взлёта и захода не задаёт (procedures.ts). */
const CALM_MS = 1;

export interface ReachOptions {
  weather: Weather;
  /** Без рельефа — ровная земля на высоте дома. */
  terrain?: Terrain;
  /** Уставка приборной, м/с. */
  iasMs: number;
  payload: PayloadLoad | null;
  /** Высота полёта над рельефом, м. */
  cruiseHeightAglM: number;
  /** Число лучей: на планировании 72, в полёте 36. */
  rays?: number;
  /** Шаг профиля вдоль луча, м: на планировании 150, в полёте 400. */
  stepM?: number;
  /** Наибольшая длина луча, м. По умолчанию — из энергии, не больше 150 км. */
  maxRangeM?: number;
  /** Кольца запаса, доли доступной энергии. По умолчанию 0,25, 0,1 и 0. */
  margins?: readonly number[];
}

export interface ReachRing {
  /** Запас на посадке дома — доля доступной энергии; для «в один конец» — NaN. */
  margin: number;
  label: string;
  /** Дальность по каждому лучу, м. */
  distanceM: number[];
  /** Контур: точка на каждом луче. */
  polygon: GeoPoint[];
}

export interface ReachStats {
  /** Наибольший радиус «туда и обратно впритык», м, и его направление. */
  maxRadiusM: number;
  maxBearingDeg: number;
  /** Наименьший — обычно против ветра. */
  minRadiusM: number;
  minBearingDeg: number;
  meanRadiusM: number;
  /** Наибольшая дальность в один конец, м. */
  oneWayMaxM: number;
  /** Кольцо упёрлось в конец луча — на карте оно обрезано. */
  clipped: boolean;
  /** Энергия на возврат с посадкой из точки старта, Вт·ч (в полёте — «домой отсюда»). */
  returnNowWh: number;
  computeMs: number;
}

export interface ReachResult {
  mode: 'plan' | 'flight';
  origin: GeoPoint;
  home: GeoPoint;
  /** Направления лучей, градусы. */
  bearingsDeg: number[];
  /** Длина луча, м. */
  rangeM: number;
  /** Доступно сверх резерва РЛЭ, Вт·ч. */
  energyWh: number;
  /** Туда и обратно — по убыванию запаса: 25 %, 10 %, впритык. */
  rings: ReachRing[];
  oneWay: ReachRing;
  stats: ReachStats;
}

export interface NoReturn {
  /** Энергии на возврат уже не хватает — точка невозврата пройдена. */
  passed: boolean;
  /** Точка невозврата по курсу; null — по курсу её нет в пределах луча (например, курс на дом). */
  position: GeoPoint | null;
  distanceM: number;
  /** Сколько лететь до неё текущим курсом, с. */
  timeS: number;
  /** Нужно на возврат с посадкой отсюда и сколько сверх этого, Вт·ч. */
  returnNowWh: number;
  spareWh: number;
  /** Для пунктира возврата: точка невозврата → дом. */
  returnPath: GeoPoint[];
}

const now = () => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Всё, что не зависит от луча. */
interface Ctx {
  terrain: Terrain;
  weather: Weather;
  massKg: number;
  payloadW: number;
  iasMs: number;
  aglM: number;
  stepM: number;
  refElevationM: number;
  tasCruise: number;
  rhoCruise: number;
  windCruise: Wind;
  follow: TerrainFollowing;
  /** Лишний путь процедур при ветре: Вт·ч и с на метр (половина по ветру, половина против). */
  detourWhPerM: number;
  detourSPerM: number;
  /** Разворот на 180°: Вт·ч и с. */
  turnWh: number;
  turnS: number;
}

function makeCtx(o: ReachOptions, ref: Site, stepM: number): Ctx {
  const terrain = o.terrain ?? flatTerrain(ref.elevationM);
  const massKg = takeoffMassKg(o.payload?.massKg ?? 0);
  const altC = ref.elevationM + o.cruiseHeightAglM;
  const rhoCruise = airDensity({ altitudeM: altC, temperatureC: temperatureAt(altC, o.weather.groundTemperatureC, ref.elevationM) });
  const tasCruise = tasFromIas(o.iasMs, rhoCruise);
  const windCruise = windAt(o.weather, o.cruiseHeightAglM);
  const level = climbPowerW(massKg, tasCruise, rhoCruise, 0);
  let detourWhPerM = 0;
  let detourSPerM = 0;
  if (windAt(o.weather, 10).speedMs >= CALM_MS) {
    const up = windTriangle(tasCruise, windCruise.fromDeg, windCruise)?.groundSpeedMs ?? 0;
    const down = windTriangle(tasCruise, windCruise.fromDeg + 180, windCruise)?.groundSpeedMs ?? tasCruise;
    detourSPerM = up > 0 ? (1 / up + 1 / down) / 2 : Infinity;
    detourWhPerM = (level * detourSPerM) / 3600;
  }
  const bank = AIRCRAFT.maxBankDeg * RAD;
  const turnS = (Math.PI * tasCruise) / (G * Math.tan(bank));
  return {
    terrain,
    weather: o.weather,
    massKg,
    payloadW: o.payload?.powerW ?? 0,
    iasMs: o.iasMs,
    aglM: o.cruiseHeightAglM,
    stepM,
    refElevationM: ref.elevationM,
    tasCruise,
    rhoCruise,
    windCruise,
    follow: { heightAglM: o.cruiseHeightAglM, groundSpeedMs: (track) => windTriangle(tasCruise, track, windCruise)?.groundSpeedMs ?? tasCruise, stepM },
    detourWhPerM,
    detourSPerM,
    turnWh: (climbPowerW(massKg, tasCruise, rhoCruise, 0, 1 / Math.cos(bank)) * turnS) / 3600,
    turnS,
  };
}

/** Длина луча: в один конец по ветру с 15 % запаса, но не больше maxRangeM. */
function rangeFor(ctx: Ctx, energyWh: number, maxRangeM = 150_000): number {
  const p = climbPowerW(ctx.massKg, ctx.tasCruise, ctx.rhoCruise, 0) + ctx.payloadW;
  const r = (1.15 * Math.max(0, energyWh) * 3600 * (ctx.tasCruise + 1.3 * ctx.windCruise.speedMs)) / p;
  return Math.max(4 * ctx.stepM, Math.min(maxRangeM, r));
}

/** Профиль по прямой from → to: высоты и нарастающие энергия (без нагрузки) и время от from. */
interface Profile {
  n: number;
  points: GeoPoint[];
  alt: Float64Array;
  e: Float64Array;
  t: Float64Array;
  se: Float64Array;
  st: Float64Array;
}

function profile(ctx: Ctx, from: GeoPoint, to: GeoPoint, startAlt: number, endAlt: number): Profile {
  const wps = followTerrain([from, to], ctx.terrain, startAlt, endAlt, CLIMB(), DESCENT(), ctx.follow);
  const points: GeoPoint[] = [from, ...wps, to];
  const n = points.length - 1;
  const alt = new Float64Array(n + 1);
  const ground = new Float64Array(n + 1);
  alt[0] = startAlt;
  alt[n] = endAlt;
  for (let i = 0; i <= n; i++) {
    if (i > 0 && i < n) alt[i] = wps[i - 1]!.altitudeM;
    ground[i] = ctx.terrain.elevationM(points[i]!);
  }
  // По отрезкам: se[i], st[i] — отрезок i → i + 1; непроходимый (ветер) — Infinity.
  const se = new Float64Array(n);
  const st = new Float64Array(n);
  const track = bearingDeg(from, to);
  const T0 = ctx.weather.groundTemperatureC;
  for (let i = 0; i < n; i++) {
    const dist = distanceM(points[i]!, points[i + 1]!);
    const mid = (alt[i]! + alt[i + 1]!) / 2;
    const rho = airDensity({ altitudeM: mid, temperatureC: temperatureAt(mid, T0, ctx.refElevationM) });
    const tas = tasFromIas(ctx.iasMs, rho);
    const tri = windTriangle(tas, track, windAt(ctx.weather, mid - (ground[i]! + ground[i + 1]!) / 2));
    if (!tri) {
      se[i] = st[i] = Infinity;
      continue;
    }
    if (dist < 1e-6) continue;
    const dur = dist / tri.groundSpeedMs;
    se[i] = (climbPowerW(ctx.massKg, tas, rho, (alt[i + 1]! - alt[i]!) / dur) * dur) / 3600;
    st[i] = dur;
  }
  const e = new Float64Array(n + 1);
  const t = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    e[i] = e[i - 1]! + se[i - 1]!;
    t[i] = t[i - 1]! + st[i - 1]!;
  }
  return { n, points, alt, e, t, se, st };
}

/** Встречная на заходе: по РЛЭ заход против ветра — вся скорость ветра на высоте обратного перехода. */
function landing(ctx: Ctx, site: Site, descentM: number): { e: number; t: number } {
  const rho = airDensity({ altitudeM: site.elevationM, temperatureC: temperatureAt(site.elevationM, ctx.weather.groundTemperatureC, ctx.refElevationM) });
  const w = windAt(ctx.weather, VT.backTransitionHeightM).speedMs;
  const ph = landingPhases(ctx.massKg, rho, { tasMs: tasFromIas(ctx.iasMs, rho), headwindMs: w >= CALM_MS ? w : 0 }, descentM);
  return { e: ph.reduce((a, p) => a + p.energyWh, 0), t: ph.reduce((a, p) => a + p.durationS, 0) };
}

/* ------------------------------ Поле возврата ------------------------------ */

/** Цена возврата домой с посадкой из точек лучей от дома: [луч][шаг от дома]. */
interface ReturnField {
  key: string;
  terrain: Terrain;
  home: Site;
  rays: number;
  n: number;
  stepM: number;
  lengthM: number;
  e: Float64Array[];
  t: Float64Array[];
  alt: Float64Array[];
}

let lastField: ReturnField | null = null;

function fieldKey(home: Site, o: ReachOptions, rays: number, stepM: number, lengthM: number): string {
  return JSON.stringify([home, o.weather.wind, o.weather.windProfile, o.weather.groundTemperatureC, o.iasMs, o.payload, o.cruiseHeightAglM, rays, stepM, Math.round(lengthM)]);
}

function returnField(ctx: Ctx, home: Site, o: ReachOptions, rays: number, lengthM: number): ReturnField {
  const key = fieldKey(home, o, rays, ctx.stepM, lengthM);
  if (lastField && lastField.key === key && lastField.terrain === ctx.terrain) return lastField;
  const e: Float64Array[] = [];
  const t: Float64Array[] = [];
  const alt: Float64Array[] = [];
  let n = 0;
  for (let j = 0; j < rays; j++) {
    const b = (j * 360) / rays;
    const far = destination(home, b, lengthM);
    const near = destination(home, b, Math.min(lengthM, PAD_CHECK_M));
    const back = terrainEndAltitudes(
      [near, home],
      ctx.terrain,
      ctx.terrain.elevationM(near) + ctx.aglM,
      home.elevationM + VT.backTransitionHeightM,
      CLIMB(),
      DESCENT(),
      ctx.follow,
      AIRCRAFT.minClearanceM + BETWEEN_SAMPLES_M,
      MAX_EXTRA_VERTICAL_M,
    ).endAltitudeM;
    const p = profile(ctx, far, home, ctx.terrain.elevationM(far) + ctx.aglM, back);
    const land = landing(ctx, home, back - home.elevationM);
    n = p.n;
    // Шаг k от дома — точка n − k профиля; цена до дома — сумма отрезков от неё до дома и посадка.
    const ej = new Float64Array(n + 1);
    const tj = new Float64Array(n + 1);
    const aj = new Float64Array(n + 1);
    ej[0] = land.e;
    tj[0] = land.t;
    aj[0] = p.alt[n]!;
    for (let k = 1; k <= n; k++) {
      ej[k] = ej[k - 1]! + p.se[n - k]!;
      tj[k] = tj[k - 1]! + p.st[n - k]!;
      aj[k] = p.alt[n - k]!;
    }
    e.push(ej);
    t.push(tj);
    alt.push(aj);
  }
  lastField = { key, terrain: ctx.terrain, home, rays, n, stepM: lengthM / n, lengthM, e, t, alt };
  return lastField;
}

/** Цена возврата из точки p: билинейно по лучам и шагам поля. */
function fieldAt(f: ReturnField, p: GeoPoint): { e: number; t: number; alt: number; trackDeg: number } {
  const l = toLocal(f.home, p);
  const r = Math.hypot(l.east, l.north);
  const brg = ((Math.atan2(l.east, l.north) / RAD) % 360 + 360) % 360;
  const trackDeg = (brg + 180) % 360;
  if (r > f.lengthM) return { e: Infinity, t: Infinity, alt: NaN, trackDeg };
  const fj = brg / (360 / f.rays);
  const j0 = Math.floor(fj) % f.rays;
  const j1 = (j0 + 1) % f.rays;
  const u = fj - Math.floor(fj);
  const fk = Math.min(f.n, r / f.stepM);
  const k0 = Math.min(f.n - 1, Math.floor(fk));
  const v = fk - k0;
  const mix = (a: Float64Array[]) => {
    let s = 0;
    for (const [w, x] of [
      [(1 - u) * (1 - v), a[j0]![k0]!],
      [(1 - u) * v, a[j0]![k0 + 1]!],
      [u * (1 - v), a[j1]![k0]!],
      [u * v, a[j1]![k0 + 1]!],
    ] as const) {
      if (w > 1e-9) s += w * x;
    }
    return s;
  };
  return { e: mix(f.e), t: mix(f.t), alt: mix(f.alt), trackDeg };
}

/* --------------------------------- Лучи --------------------------------- */

interface RayNeeds {
  d: Float64Array;
  /** Туда и обратно с посадкой дома, Вт·ч. */
  back: Float64Array;
  /** В один конец с посадкой в точке, Вт·ч. */
  one: Float64Array;
  /** Время полёта от старта до точки, с. */
  t: Float64Array;
  points: GeoPoint[];
}

interface Start {
  point: GeoPoint;
  altitudeM: number;
  /** Взлёт и переход (на планировании), Вт·ч и с; в полёте — нули. */
  fixedWh: number;
  fixedS: number;
  takeoff: boolean;
}

function rayNeeds(ctx: Ctx, field: ReturnField, start: Start, trackDeg: number, lengthM: number, landOne: { e: number; t: number }): RayNeeds {
  const far = destination(start.point, trackDeg, lengthM);
  const out = profile(ctx, start.point, far, start.altitudeM, ctx.terrain.elevationM(far) + ctx.aglM);
  const n = out.n;
  const d = new Float64Array(n + 1);
  const back = new Float64Array(n + 1);
  const one = new Float64Array(n + 1);
  const w = ctx.windCruise.fromDeg;
  // Взлётный маршрут: разгон против ветра — лишний путь, если луч не против ветра.
  const depM = start.takeoff && ctx.detourWhPerM > 0 ? AIRCRAFT.procedures.departureDistanceM * (1 - Math.cos((trackDeg - w) * RAD)) : 0;
  const climbWhPerM = (ctx.massKg * G) / AIRCRAFT.etaClimb / 3600;
  for (let k = 0; k <= n; k++) {
    d[k] = (lengthM * k) / n;
    const outWh = start.fixedWh + out.e[k]! + depM * ctx.detourWhPerM;
    const outS = start.fixedS + out.t[k]! + depM * ctx.detourSPerM;
    one[k] = outWh + landOne.e + (ctx.payloadW * (outS + landOne.t)) / 3600;
    const r = fieldAt(field, out.points[k]!);
    // Разворот к дому, лишний путь посадочного маршрута (заход против ветра), добор высоты до профиля возврата.
    const turn = k === 0 ? 0 : Math.abs(wrap180(r.trackDeg - trackDeg)) / 180;
    const appM = ctx.detourWhPerM > 0 ? 2 * AIRCRAFT.procedures.approachLegM * (1 - Math.cos((r.trackDeg - w) * RAD)) : 0;
    const climb = Number.isFinite(r.alt) ? Math.max(0, r.alt - out.alt[k]!) * climbWhPerM : 0;
    const s = outS + r.t + turn * ctx.turnS + appM * ctx.detourSPerM;
    back[k] = outWh + r.e + turn * ctx.turnWh + appM * ctx.detourWhPerM + climb + (ctx.payloadW * s) / 3600;
  }
  return { d, back, one, t: out.t, points: out.points };
}

/** Наибольшая дальность, до которой need не больше limit без перерыва от старта; линейно между шагами. */
function reachDistance(d: Float64Array, need: Float64Array, limit: number): number {
  if (!(need[0]! <= limit)) return 0;
  for (let k = 1; k < d.length; k++) {
    if (need[k]! <= limit) continue;
    const a = need[k - 1]!;
    const b = need[k]!;
    const f = Number.isFinite(b) && b > a ? (limit - a) / (b - a) : 0;
    return d[k - 1]! + (d[k]! - d[k - 1]!) * f;
  }
  return d[d.length - 1]!;
}

/**
 * Длина поля возврата в полёте: чтобы покрыть все концы лучей от борта. Округлена вверх до 10 км —
 * пока борт летит и энергия убывает, поле берётся из памяти, а не считается заново.
 */
const flightFieldM = (lengthM: number, from: GeoPoint, home: GeoPoint) => Math.ceil((lengthM + distanceM(from, home)) / 10_000) * 10_000;

const ringLabel = (m: number) => (m <= 0 ? 'впритык' : `запас ${Math.round(m * 100)} %`);

function solve(mode: 'plan' | 'flight', ctx: Ctx, start: Start, home: Site, energyWh: number, o: ReachOptions, rays: number, t0: number): ReachResult {
  const lengthM = rangeFor(ctx, energyWh, o.maxRangeM);
  const field = returnField(ctx, home, o, rays, mode === 'plan' ? lengthM : flightFieldM(lengthM, start.point, home));
  const landOne = landing(ctx, { ...home, elevationM: ctx.refElevationM }, VT.backTransitionHeightM);
  const margins = [...(o.margins ?? [0.25, 0.1, 0])].sort((a, b) => b - a);
  const bearingsDeg = Array.from({ length: rays }, (_, i) => (i * 360) / rays);
  const dist = margins.map(() => [] as number[]);
  const oneWay: number[] = [];
  let returnNowWh = NaN;
  for (const b of bearingsDeg) {
    const r = rayNeeds(ctx, field, start, b, lengthM, landOne);
    if (Number.isNaN(returnNowWh)) returnNowWh = r.back[0]!;
    margins.forEach((m, i) => dist[i]!.push(reachDistance(r.d, r.back, energyWh * (1 - m))));
    oneWay.push(reachDistance(r.d, r.one, energyWh));
  }
  const ring = (margin: number, label: string, ds: number[]): ReachRing => ({
    margin,
    label,
    distanceM: ds,
    polygon: ds.map((x, i) => destination(start.point, bearingsDeg[i]!, x)),
  });
  const rings = margins.map((m, i) => ring(m, ringLabel(m), dist[i]!));
  const zero = rings[rings.length - 1]!.distanceM;
  let iMax = 0;
  let iMin = 0;
  zero.forEach((x, i) => {
    if (x > zero[iMax]!) iMax = i;
    if (x < zero[iMin]!) iMin = i;
  });
  const top = Math.max(...oneWay);
  return {
    mode,
    origin: start.point,
    home,
    bearingsDeg,
    rangeM: lengthM,
    energyWh,
    rings,
    oneWay: ring(NaN, 'в один конец', oneWay),
    stats: {
      maxRadiusM: zero[iMax]!,
      maxBearingDeg: bearingsDeg[iMax]!,
      minRadiusM: zero[iMin]!,
      minBearingDeg: bearingsDeg[iMin]!,
      meanRadiusM: zero.reduce((a, x) => a + x, 0) / zero.length,
      oneWayMaxM: top,
      clipped: top >= lengthM - 1,
      returnNowWh,
      computeMs: now() - t0,
    },
  };
}

/* ---------------------------------- API ---------------------------------- */

/**
 * На планировании: от площадки взлёта с полной батареей (usableWh — по умолчанию ёмкость при
 * температуре у земли за вычетом резерва РЛЭ), вертикальный взлёт и переход, посадка там же.
 */
export function planReach(site: Site, o: ReachOptions & { usableWh?: number }): ReachResult {
  const t0 = now();
  const rays = o.rays ?? 72;
  const ctx = makeCtx(o, site, o.stepM ?? 150);
  const rho = airDensity({ altitudeM: site.elevationM, temperatureC: o.weather.groundTemperatureC });
  // Переход выше у крутого рельефа — по худшему направлению разгона (как terrainEndAltitudes в задании).
  let transAlt = site.elevationM + VT.transitionHeightM;
  for (let b = 0; b < 360; b += 45) {
    const near = destination(site, b, PAD_CHECK_M);
    const ends = terrainEndAltitudes([site, near], ctx.terrain, site.elevationM + VT.transitionHeightM, ctx.terrain.elevationM(near) + ctx.aglM, CLIMB(), DESCENT(), ctx.follow, AIRCRAFT.minClearanceM + BETWEEN_SAMPLES_M, MAX_EXTRA_VERTICAL_M);
    transAlt = Math.max(transAlt, ends.startAltitudeM);
  }
  const phases = [...takeoffPhases(ctx.massKg, rho, transAlt - site.elevationM), transitionPhase(ctx.massKg, rho)];
  const start: Start = {
    point: site,
    altitudeM: transAlt,
    fixedWh: phases.reduce((a, p) => a + p.energyWh, 0),
    fixedS: phases.reduce((a, p) => a + p.durationS, 0),
    takeoff: true,
  };
  const usableWh = o.usableWh ?? batteryCapacityWh(o.weather.groundTemperatureC) * (1 - AIRCRAFT.reserve);
  return solve('plan', ctx, start, site, usableWh, o, rays, t0);
}

/**
 * В полёте: от текущего места и высоты (над морем) с энергией energyWh сверх резерва РЛЭ
 * (LiveFlight: usableWh − state.energyWh). Возврат — на home, с посадкой. Грубее и дешевле:
 * 36 лучей через 400 м; поле возврата от дома считается один раз и берётся из памяти.
 */
export function reachFrom(position: GeoPoint & { altitudeM: number }, energyWh: number, home: Site, o: ReachOptions): ReachResult {
  const t0 = now();
  const ctx = makeCtx(o, home, o.stepM ?? 400);
  const start: Start = { point: { lat: position.lat, lon: position.lon }, altitudeM: position.altitudeM, fixedWh: 0, fixedS: 0, takeoff: false };
  return solve('flight', ctx, start, home, energyWh, o, o.rays ?? 36, t0);
}

/**
 * Точка невозврата: если лететь дальше курсом trackDeg, где энергии сверх резерва хватит ровно
 * на возврат домой с посадкой. timeS — сколько до неё лететь этим курсом («запас на возврат»).
 */
export function pointOfNoReturn(position: GeoPoint & { altitudeM: number }, trackDeg: number, energyWh: number, home: Site, o: ReachOptions): NoReturn {
  const ctx = makeCtx(o, home, o.stepM ?? 400);
  const rays = o.rays ?? 36;
  const here = { lat: position.lat, lon: position.lon };
  const lengthM = rangeFor(ctx, energyWh, o.maxRangeM);
  const field = returnField(ctx, home, o, rays, flightFieldM(lengthM, here, home));
  const landOne = landing(ctx, { ...home, elevationM: ctx.refElevationM }, VT.backTransitionHeightM);
  const r = rayNeeds(ctx, field, { point: here, altitudeM: position.altitudeM, fixedWh: 0, fixedS: 0, takeoff: false }, trackDeg, lengthM, landOne);
  const returnNowWh = r.back[0]!;
  const base = { returnNowWh, spareWh: energyWh - returnNowWh };
  if (!(returnNowWh <= energyWh)) return { ...base, passed: true, position: here, distanceM: 0, timeS: 0, returnPath: [here, home] };
  const d = reachDistance(r.d, r.back, energyWh);
  if (d >= r.d[r.d.length - 1]! - 1) return { ...base, passed: false, position: null, distanceM: Infinity, timeS: Infinity, returnPath: [] };
  const k = Math.min(r.d.length - 2, Math.floor((d / lengthM) * (r.d.length - 1)));
  const f = (d - r.d[k]!) / (r.d[k + 1]! - r.d[k]!);
  const timeS = r.t[k]! + (r.t[k + 1]! - r.t[k]!) * f;
  const p = destination(here, trackDeg, d);
  return { ...base, passed: false, position: p, distanceM: d, timeS, returnPath: [p, home] };
}

/**
 * Погода с ветром, измеренным у борта на высоте heightAglM, — приведённым к опорной высоте
 * по профилю погоды: в полёте досягаемость считается по тому ветру, что видит НСУ.
 */
export function weatherWithMeasuredWind(weather: Weather, measured: Wind, heightAglM: number): Weather {
  const k = windAt({ ...weather, wind: { speedMs: 1, fromDeg: 0 } }, heightAglM).speedMs;
  return { ...weather, wind: { speedMs: measured.speedMs / k, fromDeg: measured.fromDeg } };
}
