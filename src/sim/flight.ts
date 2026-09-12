import { AIRCRAFT } from './aircraft';
import { brakeDecel, climbPowerW, HOVER_TRANSLATE_MS, hoverPowerW, polar, takeoffMassKg } from './aero';
import { airDensity, batteryCapacityWh, G, RHO0, tasFromIas, temperatureAt } from './atmosphere';
import { failureInfo, FIRE_TO_POWER_S, LINK_TIMEOUT_S, RC_RANGE_M, type FailureId } from './failures';
import { fromLocal, toLocal } from './mission';
import { windProcedures } from './procedures';
import { Turbulence, type Gust, type SunDirection } from './turbulence';
import type { MissionPlan, Site, Terrain, Weather, Wind } from './types';
import { windAt, windTriangle } from './wind';

/*
 * Живой полёт: шаг за шагом, с командами оператора, как в НСУ. Физика та же, что
 * у планировщика (aero.ts, atmosphere.ts, wind.ts), только интегрируется по времени:
 * крен и курс меняются с ограниченной скоростью, путь в ветре складывается сам.
 * Взлёт и посадка — по РЛЭ: разгон и заход против ветра, маршевый выключается за 200 м
 * до точки посадки, над точкой — разворот против ветра и снижение в режиме коптера.
 *
 * Особые случаи (failures.ts): отказы вводятся inject(); оператор отвечает по РЛЭ — чаще всего
 * «Фэйлсейф»: внешний пилот ведёт аппарат с ПДУ (Controls.stick) в стабилизированном
 * самолётном или коптерном режиме. Турбулентность (turbulence.ts) — только если она есть
 * в погоде; без неё и без отказов полёт считается ровно так же, как раньше.
 */

const RAD = Math.PI / 180;
const VT = AIRCRAFT.vtol;
/** Заармлен на земле: роторы на холостых — доля загрузки для отрисовки и мощности. */
const ARMED_IDLE_LIFT = 0.08;
/** Установившаяся скорость падения без моторов, м/с. */
const TERMINAL_FALL_MS = 22;
/** Касание без моторов мягче этого — жёсткая посадка, жёстче — авария. */
const SAFE_IMPACT_MS = 2.5;
/** Касание на роторах жёстче этого — «жёсткая посадка» в журнале. */
const HARD_LANDING_MS = 1;
/** Сваливание — ниже этой доли скорости начала перехода (как в fall()). */
const STALL_SHARE = 0.85;

/** Ручной коптер: полный ход ручки крена или тангажа — такая скорость относительно воздуха (наклон ~30°), м/с. */
export const MANUAL_COPTER_MS = 12;
/** …с какой постоянной времени и каким наибольшим ускорением её набирает, с и м/с². */
const FS_COPTER_TAU_S = 1.2;
const FS_COPTER_ACCEL = 3;
/** Ручка рыскания — угловая скорость, °/с; газ — вертикальная, м/с. */
const FS_YAW_RATE_DEG_S = 60;
const FS_CLIMB_MS = 3;
const FS_DESCENT_MS = 3;
/** Ручной самолёт: скорость крена, °/с, и темп изменения вертикальной, м/с². */
const FS_ROLL_RATE_DEG_S = 45;
const FS_VZ_ACCEL = 1.5;
/** Газ в ручном самолёте меняет уставку скорости, м/с². */
const FS_IAS_RATE = 2;
/** Маршевый разгоняет в горизонте до этой доли предельной приборной — выше тяги нет. */
const PUSHER_TOP_IAS_SHARE = 1.15;

/** Тяга подъёмных роторов на максимуме, в долях веса. */
const ROTOR_MAX_LIFT = 1.35;
/**
 * Без одного подъёмного винта: противоположный разгружается ради баланса по крену и тангажу,
 * остальные на пределе — держат меньше веса.
 */
const ROTOR_LOSS_LIFT = 0.8;
/** Реактивный момент без пары — вращение на висении, °/с. */
const ROTOR_SPIN_DEG_S = 120;
/** Сопротивление плашмя при вертикальном движении: CdA ≈ площадь крыла (пластина). */
const VERTICAL_DRAG_AREA_M2 = AIRCRAFT.wingAreaM2 * 1.1;
/** Посадка на брюхо: не круче этой вертикальной и не быстрее этой путевой, м/с; крен — меньше. */
const BELLY_SINK_MS = 1.5;
const BELLY_GROUND_MS = 18;
const BELLY_BANK_DEG = 15;

/** Горизонтальные порывы сносят аппарат с запаздыванием — инерция, с. */
const GUST_LAG_S = 1.5;
/** Крен от боковых порывов, ° на м/с; автопилот парирует медленную часть за GUST_ROLL_TAU_S. */
const GUST_ROLL_DEG = 4;
const GUST_ROLL_TAU_S = 2.5;
/** Доля вертикальных порывов, которую не успевает парировать тяга: самолёт / висение. */
const GUST_VZ_PLANE = 0.6;
const GUST_VZ_HOVER = 0.3;

/** Отказ ПВД: показания уходят к доле истинной (занижение — забит, завышение — вода в трассе). */
const AIRSPEED_LOW = 0.4;
const AIRSPEED_HIGH = 1.8;
const AIRSPEED_TAU_S = 30;
/** Отказ компаса: уход курса на висении, °/с. */
const COMPASS_DRIFT_DEG_S = 3;
/** Без ГНСС: ошибка ветра, измеренного до отказа, м/с. */
const WIND_EST_ERR_MS = 0.6;
/** Заклинивший элерон: остаток управления по крену, ° и °/с. */
const AILERON_AUTH_DEG = 10;
const AILERON_RATE_DEG_S = 8;
/** Заклинивший руль высоты: остаток управления вертикальной, м/с. */
const ELEVATOR_AUTH_MS = 0.4;
/** Нет сигнала ПДУ в «Фэйлсейфе» столько секунд — автопилот забирает управление. */
const RC_LOSS_S = 5;
/** Пожар: лишний разряд батареи, Вт. */
const FIRE_DRAIN_W = 400;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
const bearing = (a: { east: number; north: number }, b: { east: number; north: number }) =>
  norm360(Math.atan2(b.east - a.east, b.north - a.north) / RAD);
/** Куда дует ветер — вектор восток/север, м/с. */
const windVec = (w: Wind) => ({ e: w.speedMs * Math.sin((w.fromDeg + 180) * RAD), n: w.speedMs * Math.cos((w.fromDeg + 180) * RAD) });

function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type LiveMode =
  | 'ground'
  | 'spool'
  | 'climb'
  | 'transition'
  | 'auto'
  | 'guided'
  | 'hold'
  | 'manual'
  | 'rtl'
  | 'backtransition'
  | 'descent'
  | 'final'
  | 'failsafe'
  | 'falling'
  | 'landed'
  | 'crashed';

/** Названия состояний — как в РЛЭ. */
export const MODE_NAMES: Record<LiveMode, string> = {
  ground: 'ГОТОВ',
  spool: 'ВЗЛЁТ · раскрутка',
  climb: 'ВЗЛЁТ · набор',
  transition: 'ВЗЛЁТ · разгон',
  auto: 'МАРШРУТ',
  guided: 'ОПЕРАТИВНАЯ ТОЧКА',
  hold: 'ОЖИДАНИЕ',
  manual: 'РУЧНОЙ',
  rtl: 'ВОЗВРАТ',
  backtransition: 'ПОСАДКА · торможение',
  descent: 'ПОСАДКА · снижение',
  final: 'ПОСАДКА · касание',
  failsafe: 'ФЭЙЛСЕЙФ',
  falling: 'МОТОРЫ ВЫКЛЮЧЕНЫ',
  landed: 'НА ЗЕМЛЕ',
  crashed: 'АВАРИЯ',
};

/** Самолётные режимы, в которых оператор может переключаться. */
const AIRBORNE: LiveMode[] = ['auto', 'guided', 'hold', 'manual', 'rtl'];
/** Команды, которые подаются с ПДУ, — доходят и без связи с НСУ, если борт в зоне пульта. */
const RC_COMMANDS: Command[] = ['failsafe', 'copter', 'disarm', 'auto', 'rtl'];
/** Отказы, после которых аппарат неуправляем. */
const FATAL: FailureId[] = ['power', 'autopilot', 'boom', 'wing'];
const ZERO_STICK: Stick = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };

export interface PathPoint {
  east: number;
  north: number;
  /** Над площадкой-началом координат, м. */
  up: number;
  routeLeg?: number;
}

/**
 * Ручки ПДУ, режим 2, каждая −1…1. roll: +1 — вправо. pitch: +1 — от себя: коптер идёт вперёд,
 * самолёт опускает нос (снижение). yaw: +1 — нос вправо. throttle: +1 — вверх (коптер набирает,
 * самолёт разгоняется), 0 — держать как есть.
 */
export interface Stick {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}

/** Уставки оператора. */
export interface Controls {
  /** Приборная скорость, м/с. */
  iasMs: number;
  /** Высота над рельефом в режимах РУЧНОЙ, ОПЕРАТИВНАЯ ТОЧКА, ОЖИДАНИЕ, м. */
  heightAglM: number;
  /** Путевой угол в режиме РУЧНОЙ, градусы. */
  courseDeg: number;
  /** Центр круга в режиме ОПЕРАТИВНАЯ ТОЧКА, локальные метры. */
  target: { east: number; north: number } | null;
  /** Ручки ПДУ в «Фэйлсейфе»; нет — ручки в центре (аппарат стабилизирован и держит). */
  stick?: Stick | null;
}

/**
 * arm / disarm — «заармить» и «задизармить» по РЛЭ: разрешение моторам работать.
 * failsafe — внешний пилот берёт управление с ПДУ; copter — с ПДУ в режим «квадрокоптер».
 */
export type Command = 'arm' | 'disarm' | 'takeoff' | 'auto' | 'manual' | 'guided' | 'hold' | 'rtl' | 'land' | 'failsafe' | 'copter';

export interface LiveState {
  t: number;
  mode: LiveMode;
  /** Заармлен: моторам разрешено работать. Взлёт — только заармленным. */
  armed: boolean;
  /** Сколько длится текущий режим, с. */
  modeT: number;
  east: number;
  north: number;
  up: number;
  headingDeg: number;
  trackDeg: number;
  driftDeg: number;
  bankDeg: number;
  /** Истинная приборная скорость (что на самом деле), м/с; показания ПВД — iasReadingMs. */
  iasMs: number;
  tasMs: number;
  groundSpeedMs: number;
  vzMs: number;
  aglM: number;
  wind: Wind;
  /** Мощность с нагрузкой, Вт. */
  powerW: number;
  energyWh: number;
  soc: number;
  distanceM: number;
  /** Номер точки маршрута, к которой идём в МАРШРУТЕ. */
  wp: number;
  /** Участок исходного маршрута (галс, разворот), на котором находится аппарат. */
  routeLeg: number | null;
  /** Загрузка подъёмных роторов и маршевого винта 0…1 — для отрисовки. */
  lift: number;
  pusher: number;
  reason: string | null;
  /** Введённые отказы, по порядку. */
  failures: FailureId[];
  /** Нет связи с НСУ: команды не доходят, телеметрия замерла (см. telemetry). */
  linkLost: boolean;
  /** Место по навигации автопилота — его и показывает НСУ; без ГНСС уходит от истинного. */
  estimate: { east: number; north: number };
  /** Показания ПВД, м/с: с порывами и при отказе ПВД — не то, что на самом деле. */
  iasReadingMs: number;
  /** Сила порыва сейчас, м/с — для смаза камеры и индикации. */
  gustMs: number;
  /** В «Фэйлсейфе»: самолётом или коптером ведёт пилот; вне его — null. */
  failsafePhase: 'plane' | 'copter' | null;
}

export interface FlightSetup {
  plan: MissionPlan;
  terrain: Terrain;
  weather: Weather;
  /** Ёмкость АКБ, Вт·ч; по умолчанию — по температуре у земли. */
  capacityWh?: number;
  /** Начало локальных координат; по умолчанию — площадка взлёта этого полёта. */
  origin?: Site;
  /** Куда уходить по команде ВОЗВРАТ; по умолчанию — площадка посадки этого полёта. */
  home?: Site;
  /** Время и израсходованная энергия к началу полёта — для второго полёта на той же батарее. */
  startT?: number;
  initialEnergyWh?: number;
  /** Случайность турбулентности и отказов (какой элерон заклинило и т. п.); по умолчанию 1. */
  seed?: number;
  /** Солнце — для термиков над склонами (turbulence.ts). */
  sun?: SunDirection | ((t: number) => SunDirection);
}

export class LiveFlight {
  state: LiveState;
  path: PathPoint[];
  /** Площадка посадки этого полёта (конец задания в МАРШРУТЕ). */
  readonly landing: PathPoint;
  /** Куда идёт ВОЗВРАТ. */
  readonly home: PathPoint;
  readonly capacityWh: number;
  readonly usableWh: number;
  readonly events: { t: number; text: string }[] = [];
  /** Дальность ПДУ от площадок взлёта, посадки и дома, м. */
  rcRangeM = RC_RANGE_M;
  private readonly site: Site;
  private readonly homeSite: Site;
  private readonly mass: number;
  private readonly payloadW: number;
  private readonly terrain: Terrain;
  private readonly weather: Weather;
  private readonly takeoffPt: PathPoint;
  private afterTransition: LiveMode = 'auto';
  private landAt: { east: number; north: number } | null = null;
  /** Почему моторы остановились в воздухе — для сообщения об ударе. */
  private fallCause = '';
  /** Курс для висения над точкой посадки — против ветра. */
  private hoverHeadingDeg = 0;
  /** Посадочный маршрут для ВОЗВРАТА: две точки захода и этап. */
  private rtlApproach: PathPoint[] = [];
  private rtlStage = 0;
  private finalLeg: number | undefined;

  private readonly rand: () => number;
  private readonly turb: Turbulence | null;
  /** Порыв сейчас и он же, сглаженный инерцией аппарата. */
  private gust: Gust = { e: 0, n: 0, u: 0 };
  private gustLp: Gust = { e: 0, n: 0, u: 0 };
  private rollLp = 0;
  private prevAlong = NaN;
  /** Добавки порывов к крену и вертикальной на прошлом шаге — регуляторы их не видят. */
  private bankGust = 0;
  private vzGust = 0;
  /** Путевая скорость по перемещению за прошлый шаг. */
  private lastVel = { e: 0, n: 0 };

  private readonly failed = new Set<FailureId>();
  private readonly failT: Partial<Record<FailureId, number>> = {};
  private airspeedK = 1;
  private airspeedGoal = 1;
  private compassErrDeg = 0;
  private compassSign = 1;
  private radaltErrM = 0;
  private aileronBiasDeg = 0;
  private elevatorBiasMs = 0;
  private rotorSpinSign = 1;
  private payloadOff = false;
  private noGlide = false;
  private overspeedWarned = false;
  private stalled = false;
  private stallSide = 1;
  /** Без ГНСС: ветер, известный автопилоту, ошибка навигации и неучтённый за шаг снос. */
  private windEst: { e: number; n: number } | null = null;
  private navErr = { e: 0, n: 0 };
  private unknownE = 0;
  private unknownN = 0;
  /** Последний кадр телеметрии, дошедший до НСУ. */
  private frozen: LiveState | null = null;
  /** Ручной коптер: скорость относительно воздуха; ручной самолёт: уставка приборной. */
  private vAir = { e: 0, n: 0 };
  private iasHold = 0;
  private rcLostS = 0;

  constructor(setup: FlightSetup) {
    const { plan } = setup;
    this.site = setup.origin ?? plan.takeoff;
    this.homeSite = setup.home ?? plan.landing;
    this.terrain = setup.terrain;
    this.weather = setup.weather;
    this.mass = takeoffMassKg(plan.payload?.massKg ?? 0);
    this.payloadW = plan.payload?.powerW ?? 0;
    this.capacityWh = setup.capacityWh ?? batteryCapacityWh(setup.weather.groundTemperatureC);
    this.usableWh = this.capacityWh * (1 - AIRCRAFT.reserve);
    const takeoff = this.local(plan.takeoff, plan.takeoff.elevationM - this.site.elevationM);
    this.takeoffPt = takeoff;
    this.landing = this.local(plan.landing, plan.landing.elevationM - this.site.elevationM);
    this.home = this.local(this.homeSite, this.homeSite.elevationM - this.site.elevationM);
    this.path = this.buildPath(plan);
    const heading = this.path.length > 1 ? bearing(this.path[0]!, this.path[1]!) : 0;
    const energy = setup.initialEnergyWh ?? 0;
    const seed = setup.seed ?? 1;
    this.rand = rng(seed);
    this.turb = (setup.weather.turbulenceMs ?? 0) > 0 ? new Turbulence(seed, setup.weather, setup.terrain, this.site, setup.sun) : null;
    this.state = {
      t: setup.startT ?? 0,
      mode: 'ground',
      armed: false,
      modeT: 0,
      east: takeoff.east,
      north: takeoff.north,
      up: takeoff.up,
      headingDeg: heading,
      trackDeg: heading,
      driftDeg: 0,
      bankDeg: 0,
      iasMs: 0,
      tasMs: 0,
      groundSpeedMs: 0,
      vzMs: 0,
      aglM: 0,
      wind: windAt(setup.weather, 5),
      powerW: 0,
      energyWh: energy,
      soc: (this.capacityWh - energy) / this.capacityWh,
      distanceM: 0,
      wp: 1,
      routeLeg: null,
      lift: 0,
      pusher: 0,
      reason: null,
      failures: [],
      linkLost: false,
      estimate: { east: takeoff.east, north: takeoff.north },
      iasReadingMs: 0,
      gustMs: 0,
      failsafePhase: null,
    };
  }

  private local(p: { lat: number; lon: number }, up: number, routeLeg?: number): PathPoint {
    return { ...toLocal(this.site, p), up, ...(routeLeg === undefined ? {} : { routeLeg }) };
  }

  private buildPath(plan: MissionPlan): PathPoint[] {
    // Номер последнего участка — посадочная прямая к точке посадки.
    this.finalLeg = plan.waypoints[plan.waypoints.length - 1]?.routeLeg;
    const takeoff = this.local(plan.takeoff, plan.takeoff.elevationM - this.site.elevationM);
    const landing = this.local(plan.landing, plan.landing.elevationM - this.site.elevationM);
    return [
      { ...takeoff, up: takeoff.up + VT.transitionHeightM },
      ...plan.waypoints.map((w) => this.local(w, w.altitudeM - this.site.elevationM, w.routeLeg)),
      { ...landing, up: landing.up + VT.backTransitionHeightM },
    ];
  }

  /**
   * Новый маршрут на лету (оператор поправил точки). Автопилот продолжает участок с тем же
   * номером, что и сейчас, — к точке с тем же номером, как в НСУ; если её удалили, идёт к следующей.
   */
  replacePlan(plan: MissionPlan) {
    const s = this.state;
    const leg = s.routeLeg;
    this.path = this.buildPath(plan);
    if (['ground', 'spool', 'climb', 'transition'].includes(s.mode) || leg === null) {
      s.wp = 1;
      return;
    }
    const p = this.navPos();
    const ahead = (i: number) => {
      const a = this.path[i]!;
      const q = this.path[i - 1]!;
      return (a.east - q.east) * (a.east - p.east) + (a.north - q.north) * (a.north - p.north) > 0;
    };
    let wp = -1;
    for (let i = 1; i < this.path.length; i++) {
      const r = this.path[i]!.routeLeg;
      if (r !== undefined && r >= leg && ahead(i)) {
        wp = i;
        break;
      }
    }
    s.wp = wp > 0 ? wp : this.path.length - 1;
    this.events.push({ t: s.t, text: 'Маршрут изменён — продолжаю по новому' });
  }

  /** Радиус разворота при предельном крене на истинной скорости tas. */
  turnRadiusM(tas = this.state.tasMs): number {
    return Math.max(tas, 10) ** 2 / (G * Math.tan(AIRCRAFT.maxBankDeg * RAD));
  }

  /** Высота рельефа под точкой относительно начала координат. */
  groundUp(east: number, north: number): number {
    return this.terrain.elevationM(fromLocal(this.site, east, north)) - this.site.elevationM;
  }

  /** Развернуть аппарат на площадке (предполётная подготовка: носом против ветра). Только на земле. */
  setGroundHeading(deg: number) {
    const s = this.state;
    if (s.mode !== 'ground') return;
    s.headingDeg = norm360(deg);
    s.trackDeg = s.headingDeg;
  }

  /**
   * Что видит НСУ: место — по навигации автопилота, приборная — по ПВД; без связи — последний
   * дошедший кадр (время в нём — время потери связи).
   */
  get telemetry(): LiveState {
    return this.state.linkLost && this.frozen ? this.frozen : this.snapshot();
  }

  /** Борт в зоне действия ПДУ: пилот стоит у площадки взлёта, посадки или дома. */
  rcInRange(): boolean {
    const s = this.state;
    const d = Math.min(...[this.takeoffPt, this.landing, this.home].map((p) => Math.hypot(s.east - p.east, s.north - p.north)));
    return d <= this.rcRangeM;
  }

  private snapshot(): LiveState {
    const s = this.state;
    return {
      ...s,
      east: s.estimate.east,
      north: s.estimate.north,
      iasMs: s.iasReadingMs,
      wind: { ...s.wind },
      estimate: { ...s.estimate },
      failures: [...s.failures],
    };
  }

  /** Команда оператора. Возвращает причину отказа или null. */
  command(c: Command): string | null {
    const s = this.state;
    if (s.linkLost && !(RC_COMMANDS.includes(c) && this.rcInRange())) return 'Нет связи с НСУ — команда не доставлена';
    const fs = s.mode === 'failsafe';
    const airborne = AIRBORNE.includes(s.mode) || (fs && s.failsafePhase === 'plane');
    switch (c) {
      case 'arm':
        if (s.mode !== 'ground') return 'АРМ — только на земле перед взлётом';
        if (s.armed) return 'Уже заармлен';
        if (this.dead()) return 'Борт не отвечает — АРМ невозможен';
        s.armed = true;
        this.events.push({ t: s.t, text: 'АРМ: моторы на холостых' });
        return null;
      case 'disarm':
        if (!s.armed) return 'Уже задизармлен';
        if (s.mode === 'ground' || s.mode === 'landed') {
          this.disarm('ДИЗАРМ');
          return null;
        }
        // В воздухе моторы останавливаются по-настоящему — для отработки аварийной ситуации.
        this.fallCause = 'моторы были выключены (ДИЗАРМ в полёте)';
        this.disarm('ДИЗАРМ в полёте: моторы остановлены');
        this.setMode('falling');
        return null;
      case 'takeoff':
        if (s.mode !== 'ground') return 'Взлёт — только с земли';
        if (!s.armed) return 'Сначала АРМ';
        if (this.failed.has('vtol') || this.failed.has('rotor')) return 'Подъёмные роторы неисправны — взлёт запрещён';
        this.setMode('spool');
        return null;
      case 'auto':
      case 'manual':
      case 'guided':
      case 'hold':
        if (s.mode === 'transition') {
          this.afterTransition = c;
          return null;
        }
        if (fs && s.failsafePhase === 'copter') return this.resumeFromCopter(c);
        if (!airborne) return 'Режим доступен только в самолётном полёте';
        this.setMode(c);
        return null;
      case 'rtl':
        if (s.mode === 'spool' || s.mode === 'climb') {
          this.landHere();
          return null;
        }
        if (s.mode === 'transition') {
          this.afterTransition = 'rtl';
          return null;
        }
        if (fs && s.failsafePhase === 'copter') return this.resumeFromCopter('rtl');
        if (!airborne) return 'Возврат — только в полёте';
        this.startRtl();
        return null;
      case 'land':
        if (s.mode === 'spool' || s.mode === 'climb') {
          this.landHere();
          return null;
        }
        if (this.failed.has('vtol')) return 'Отказ СВВП: вертикальная посадка невозможна — «Фэйлсейф» и посадка на брюхо';
        if (fs && s.failsafePhase === 'copter') {
          this.landHere();
          return null;
        }
        if (!airborne) return 'Посадка — только в полёте';
        // Посадка на месте: гасим скорость прямо по курсу, над точкой — носом против ветра.
        this.landAt = null;
        this.hoverHeadingDeg = s.wind.fromDeg;
        this.setMode('backtransition');
        return null;
      case 'failsafe':
        if (fs) return 'Уже «Фэйлсейф»';
        return this.enterFailsafe('ФЭЙЛСЕЙФ: управление с ПДУ');
      case 'copter': {
        if (this.failed.has('vtol')) return 'Отказ СВВП: режим «квадрокоптер» невозможен';
        if (!fs) {
          const err = this.enterFailsafe('ФЭЙЛСЕЙФ: «квадрокоптер» с ПДУ');
          if (err) return err;
        } else if (s.failsafePhase === 'copter') return 'Уже «квадрокоптер»';
        if (s.failsafePhase === 'plane') this.toCopter();
        return null;
      }
    }
  }

  /** Отказ в полёте (failures.ts). Повторный ввод того же отказа ничего не меняет. */
  inject(id: FailureId, variant?: 'low' | 'high'): void {
    const s = this.state;
    if (this.failed.has(id)) return;
    this.failed.add(id);
    s.failures.push(id);
    this.failT[id] = s.t;
    this.events.push({ t: s.t, text: `ОТКАЗ: ${failureInfo(id).title}` });
    const side = () => (this.rand() < 0.5 ? -1 : 1);
    switch (id) {
      case 'link':
        s.linkLost = true;
        this.frozen = this.snapshot();
        break;
      case 'gnss': {
        // Автопилот продолжает по ПВД и ветру, измеренному до отказа (автономная навигация).
        const w = windVec(windAt(this.weather, Math.max(0, s.aglM)));
        const a = 2 * Math.PI * this.rand();
        const err = WIND_EST_ERR_MS * (0.5 + this.rand());
        this.windEst = { e: w.e + err * Math.sin(a), n: w.n + err * Math.cos(a) };
        break;
      }
      case 'airspeed':
        this.airspeedGoal = (variant ?? (this.rand() < 0.5 ? 'low' : 'high')) === 'low' ? AIRSPEED_LOW : AIRSPEED_HIGH;
        break;
      case 'compass':
        this.compassSign = side();
        break;
      case 'radalt':
        // Больше нуля — автопилот думает, что выше, чем на самом деле.
        this.radaltErrM = side() * (3 + 3 * this.rand());
        break;
      case 'aileron':
        this.aileronBiasDeg = side() * (4 + 4 * this.rand());
        break;
      case 'elevator':
        this.elevatorBiasMs = side() * (0.8 + 0.8 * this.rand());
        break;
      case 'tail':
        this.elevatorBiasMs = -(2 + this.rand());
        break;
      case 'rotor':
        this.rotorSpinSign = side();
        break;
      case 'vtol':
        if (s.mode === 'spool') {
          s.lift = 0;
          this.setMode('ground', 'Отказ СВВП — взлёт прекращён');
        }
        break;
      case 'power':
        this.payloadOff = true;
        this.loseControl('отказ источника электроэнергии');
        break;
      case 'autopilot':
        this.loseControl('отказ САУ');
        break;
      case 'boom':
        this.noGlide = true;
        this.loseControl('отрыв балки');
        break;
      case 'wing':
        this.noGlide = true;
        this.loseControl('отрыв консоли крыла');
        break;
      case 'fire':
      case 'pusher':
      case 'stabilization':
        break;
    }
  }

  /** Связь или ГНСС вернулись. Остальные отказы в полёте не проходят — возвращает false. */
  restore(id: 'link' | 'gnss'): boolean {
    const s = this.state;
    if (!this.failed.delete(id)) return false;
    s.failures = s.failures.filter((x) => x !== id);
    if (id === 'link') {
      s.linkLost = false;
      this.frozen = null;
      this.events.push({ t: s.t, text: 'Связь с НСУ восстановлена' });
    } else {
      this.windEst = null;
      this.navErr = { e: 0, n: 0 };
      s.estimate.east = s.east;
      s.estimate.north = s.north;
      this.events.push({ t: s.t, text: 'Сигнал ГНСС восстановлен' });
    }
    return true;
  }

  /** Продвинуть полёт на dt секунд (внутри — шаги не длиннее 0.1 с); onTick — после каждого шага. */
  step(dt: number, c: Controls, onTick?: (s: LiveState) => void) {
    if (!(dt > 0)) return;
    const n = Math.max(1, Math.ceil(dt / 0.1));
    for (let i = 0; i < n; i++) {
      if (this.state.mode === 'landed' || this.state.mode === 'crashed') {
        this.state.t += dt / n;
        // После касания роторы на холостых, пока оператор не задизармит (по РЛЭ — сразу после касания).
        if (this.state.armed && this.state.mode === 'landed') this.idle(dt / n);
        continue;
      }
      this.tick(dt / n, c);
      onTick?.(this.state);
    }
  }

  private dead(): boolean {
    return FATAL.some((f) => this.failed.has(f));
  }

  private payloadNow(): number {
    return this.payloadOff ? 0 : this.payloadW;
  }

  private disarm(text: string) {
    this.state.armed = false;
    this.state.lift = 0;
    this.state.pusher = 0;
    this.state.powerW = 0;
    this.events.push({ t: this.state.t, text });
  }

  /** Мощность заармленного аппарата на земле: роторы на холостых, моторы под питанием, Вт. */
  private idlePowerW(): number {
    return AIRCRAFT.idlePowerPlaneW + 0.5 * ARMED_IDLE_LIFT * hoverPowerW(this.mass, this.rho(this.state.up));
  }

  /** Заармлен на земле после посадки: холостые обороты и расход (шаг вне tick). */
  private idle(h: number) {
    const s = this.state;
    s.lift = ARMED_IDLE_LIFT;
    s.powerW = this.idlePowerW() + this.payloadNow();
    s.energyWh += (s.powerW * h) / 3600;
    s.soc = (this.capacityWh - s.energyWh) / this.capacityWh;
  }

  /** Неуправляемый аппарат: по РЛЭ — зафиксировать координаты и искать. */
  private loseControl(cause: string) {
    const s = this.state;
    const p = fromLocal(this.site, s.east, s.north);
    this.events.push({ t: s.t, text: `Зафиксировать координаты БВС: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` });
    if (s.mode === 'ground' || s.mode === 'landed' || s.mode === 'crashed' || s.mode === 'falling') {
      if (s.armed) this.disarm(`${cause}: моторы остановлены`);
      return;
    }
    if (s.mode === 'spool') {
      this.disarm(`${cause}: моторы остановлены`);
      this.setMode('ground', MODE_NAMES.ground);
      return;
    }
    this.fallCause = cause;
    this.disarm(`${cause}: моторы остановлены`);
    this.setMode('falling');
  }

  private landHere() {
    const s = this.state;
    const p = this.navPos();
    this.landAt = { east: p.east, north: p.north };
    this.hoverHeadingDeg = s.headingDeg;
    this.setMode('descent');
  }

  /** ВОЗВРАТ: посадочный маршрут к дому строится по фактическому ветру (как у автопилота). */
  private startRtl() {
    const p = this.navPos();
    const wind10 = windAt(this.weather, 10);
    const here = fromLocal(this.site, p.east, p.north);
    const proc = windProcedures(this.homeSite, this.homeSite, wind10, null, here);
    this.rtlApproach = proc.approach.map((q) => this.local(q, 0));
    this.rtlStage = 0;
    this.hoverHeadingDeg = proc.landingHeadingDeg;
    this.setMode('rtl');
  }

  private setMode(m: LiveMode, text?: string) {
    if (m !== 'failsafe') this.state.failsafePhase = null;
    if (m === 'rtl' && this.state.mode !== 'rtl' && this.rtlApproach.length === 0) {
      // На ВОЗВРАТ из перехода — посадочный маршрут строим при входе.
      this.state.mode = m;
      this.startRtl();
      return;
    }
    this.state.mode = m;
    this.state.modeT = 0;
    this.events.push({ t: this.state.t, text: text ?? MODE_NAMES[m] });
  }

  /**
   * «Фэйлсейф» по РЛЭ: управление у внешнего пилота с ПДУ. Самолётом — если крыло держит,
   * иначе коптером. auto — переход самим автопилотом по предельным крену, тангажу, Vz: пульт тогда не спрашиваем.
   */
  private enterFailsafe(text: string, auto = false): string | null {
    const s = this.state;
    if (this.dead()) return 'Аппарат неуправляем';
    if (['ground', 'spool', 'falling', 'landed', 'crashed'].includes(s.mode)) return '«Фэйлсейф» — только в полёте';
    if (!auto && !this.rcInRange()) return `ПДУ не достаёт: борт дальше ${fmtKm(this.rcRangeM)} км от пилота`;
    const rho = this.rho(s.up);
    const plane = AIRBORNE.includes(s.mode) || ((s.mode === 'transition' || s.mode === 'backtransition') && s.tasMs > this.stallTas(rho));
    const w = windVec(windAt(this.weather, Math.max(0, s.aglM)));
    this.vAir = { e: this.lastVel.e - w.e, n: this.lastVel.n - w.n };
    this.iasHold = s.iasMs;
    this.rcLostS = 0;
    this.landAt = null;
    this.setMode('failsafe', text);
    s.failsafePhase = plane ? 'plane' : 'copter';
    if (!plane) {
      s.iasMs = 0;
      s.pusher = 0;
    }
    return null;
  }

  /** «Квадрокоптер» из ручного самолёта: маршевый выключен, роторы гасят скорость, крыло пока держит. */
  private toCopter() {
    const s = this.state;
    const psi = s.headingDeg * RAD;
    this.vAir = { e: s.tasMs * Math.sin(psi), n: s.tasMs * Math.cos(psi) };
    s.failsafePhase = 'copter';
    s.pusher = 0;
    this.events.push({ t: s.t, text: '«Квадрокоптер»: маршевый выключен, роторы на висение' });
  }

  /** Из ручного коптера автопилоту: разгон и дальше заданный режим. */
  private resumeFromCopter(c: LiveMode): string | null {
    const s = this.state;
    if (this.failed.has('pusher')) return 'Маршевый не работает: из коптера — только посадка';
    if (s.aglM < 20) return 'Разгон — не ниже 20 м над землёй';
    this.afterTransition = c;
    this.setMode('transition');
    return null;
  }

  private rho(up: number): number {
    const alt = this.site.elevationM + up;
    return airDensity({ altitudeM: alt, temperatureC: temperatureAt(alt, this.weather.groundTemperatureC, this.site.elevationM) });
  }

  private stallTas(rho: number): number {
    return STALL_SHARE * tasFromIas(AIRCRAFT.transitionLowIasMs, rho);
  }

  /** Где аппарат по мнению автопилота: с ГНСС — где есть, без — счисление. */
  private navPos(): { east: number; north: number } {
    const s = this.state;
    return this.windEst ? { east: s.east + this.navErr.e, north: s.north + this.navErr.n } : s;
  }

  /** Тяга подъёмных роторов на максимуме в долях веса. */
  private rotorAuthority(): number {
    return this.failed.has('vtol') ? 0 : this.failed.has('rotor') ? ROTOR_LOSS_LIFT : ROTOR_MAX_LIFT;
  }

  /**
   * Высота для полёта над рельефом с упреждением: заглядываем вперёд по курсу и начинаем
   * набор заранее, чтобы с предельной вертикальной скоростью успеть к высокому рельефу.
   */
  private terrainFollow(heightAglM: number, trackDeg: number, tas: number): number {
    const grad = (AIRCRAFT.planeClimbRateMaxMs * 0.9) / Math.max(tas, 10);
    const s = this.navPos();
    const ue = Math.sin(trackDeg * RAD);
    const un = Math.cos(trackDeg * RAD);
    let alt = -Infinity;
    for (const d of [0, 100, 200, 400, 700, 1000, 1500]) {
      alt = Math.max(alt, this.groundUp(s.east + ue * d, s.north + un * d) + heightAglM - grad * d);
    }
    return alt;
  }

  /** Путевой угол для кругов по часовой вокруг center радиусом r. */
  private orbitTrack(center: { east: number; north: number }, r: number): number {
    const s = this.navPos();
    const d = Math.hypot(s.east - center.east, s.north - center.north);
    if (d > 1.8 * r) return norm360(bearing(s, center) - Math.asin(r / d) / RAD);
    return norm360(bearing(center, s) + 90 + clamp(((d - r) / r) * 60, -60, 60));
  }

  private tick(h: number, c: Controls) {
    const s = this.state;
    s.t += h;
    s.modeT += h;
    // Добавки порывов прошлого шага снимаем: регуляторы работают с «чистыми» креном и Vz.
    s.bankDeg -= this.bankGust;
    s.vzMs -= this.vzGust;
    this.bankGust = 0;
    this.vzGust = 0;
    const e0 = s.east;
    const n0 = s.north;
    const ground = this.groundUp(s.east, s.north);
    s.aglM = s.up - ground;
    this.sampleGust(h);
    if (this.failed.size > 0) this.failureTick(h);
    const rho = this.rho(s.up);
    const hover = hoverPowerW(this.mass, rho);
    let power = 0;

    // Без подъёмных роторов висеть нечем.
    if (this.failed.has('vtol') && (['climb', 'descent', 'final'].includes(s.mode) || (s.mode === 'transition' && s.tasMs < this.stallTas(rho)))) {
      this.fallCause = 'отказ СВВП на висении';
      s.lift = 0;
      this.setMode('falling');
    }
    // Маршевый не тянет — разгон не выйдет, автопилот садится на месте.
    if (this.failed.has('pusher') && s.mode === 'transition' && s.tasMs < this.stallTas(rho)) {
      this.landHere();
      this.events.push({ t: s.t, text: 'Маршевый не тянет — разгон прекращён, посадка на месте' });
    }

    switch (s.mode) {
      case 'spool':
        power = VT.spoolUpFactor * hover;
        s.lift = Math.min(1, (s.modeT / VT.spoolUpS) * 1.5);
        s.pusher = 0.15;
        if (s.modeT >= VT.spoolUpS) this.setMode('climb');
        break;

      case 'climb':
        // Висение носом на первую точку взлётного маршрута — против ветра.
        power = VT.climbFactor * hover;
        s.lift = 1;
        this.hoverMove(h, this.takeoffPt);
        this.spin(h);
        s.vzMs = this.rotorVz(h, VT.climbRateMs * Math.min(1, s.modeT / 1.5));
        s.up += s.vzMs * h;
        if (s.up >= this.path[0]!.up) {
          s.up = this.path[0]!.up;
          s.vzMs = 0;
          s.headingDeg = this.path.length > 1 ? bearing(this.path[0]!, this.path[1]!) : s.headingDeg;
          this.setMode('transition');
        } else if (s.up <= this.groundUp(s.east, s.north) && s.modeT > 1) this.touchdown('отрыв винта подъёмного двигателя');
        break;

      case 'transition': {
        power = VT.transitionFactor * hover;
        const f = Math.min(1, s.modeT / VT.transitionS);
        s.lift = 1 - f * f;
        s.pusher = 1;
        s.iasMs = c.iasMs * f;
        this.fly(h, s.headingDeg, s.up, rho, f);
        if (f >= 1) {
          if (this.afterTransition === 'rtl') this.startRtl();
          else this.setMode(this.afterTransition);
        }
        break;
      }

      case 'ground':
        // Заармлен — роторы на холостых, моторы под питанием, пока не взлетели или не задизармили.
        s.lift = s.armed ? ARMED_IDLE_LIFT : 0;
        power = s.armed ? this.idlePowerW() : 0;
        break;

      case 'falling':
        power = 0;
        this.fall(h, rho);
        break;

      case 'auto':
      case 'guided':
      case 'hold':
      case 'manual':
      case 'rtl':
        power = this.airplane(h, c, rho);
        break;

      case 'backtransition':
        power = this.brake(h, rho, hover);
        break;

      case 'descent': {
        s.lift = 1;
        s.pusher = 0.1;
        this.hoverYaw(h);
        const target = this.landAt ?? this.navPos();
        this.hoverMove(h, target);
        this.spin(h);
        // Снижение — над точкой; до неё аппарат идёт на роторах, держа высоту.
        const nav = this.navPos();
        const over = Math.hypot(target.east - nav.east, target.north - nav.north) < 5;
        power = (over ? VT.descentFactor : 1) * hover;
        s.vzMs = this.rotorVz(h, over ? -VT.descentRateMs : 0);
        s.up += s.vzMs * h;
        const g = this.groundUp(s.east, s.north);
        // Высоту над землёй автопилот знает по радиовысотомеру.
        if (s.up - g + this.radaltErrM <= VT.finalHeightM) this.setMode('final');
        if (s.up <= g) this.touchdown(this.failed.has('rotor') ? 'отрыв винта подъёмного двигателя' : 'отказ радиовысотомера');
        break;
      }

      case 'final': {
        power = hover;
        s.lift = 1;
        s.pusher = 0.1;
        this.hoverYaw(h);
        if (this.landAt) this.hoverMove(h, this.landAt);
        this.spin(h);
        s.vzMs = this.rotorVz(h, -VT.finalHeightM / VT.finalS);
        s.up += s.vzMs * h;
        if (s.up <= this.groundUp(s.east, s.north)) this.touchdown('отрыв винта подъёмного двигателя');
        break;
      }

      case 'failsafe':
        power = s.failsafePhase === 'copter' ? this.manualCopter(h, this.stickNow(c), rho, hover) : this.manualPlane(h, this.stickNow(c), rho);
        break;

      default:
        break;
    }

    power = this.applyDisturbance(h, power);
    if (this.failed.has('fire') && s.armed && s.mode !== 'falling') power += FIRE_DRAIN_W;
    s.powerW = s.mode === 'landed' ? 0 : power + this.payloadNow();
    s.energyWh += (s.powerW * h) / 3600;
    s.soc = (this.capacityWh - s.energyWh) / this.capacityWh;
    s.aglM = s.up - this.groundUp(s.east, s.north);
    this.lastVel = { e: (s.east - e0) / h, n: (s.north - n0) / h };
    this.updateNavigation();
    const powered = s.mode !== 'falling' && s.mode !== 'crashed' && s.mode !== 'landed';
    if (s.energyWh >= this.capacityWh) s.energyWh = this.capacityWh;
    if (s.energyWh >= this.capacityWh && powered && (s.mode !== 'ground' || s.armed)) {
      // Батарея села — моторы встают. На земле просто дизарм, в воздухе — планирование или падение до удара.
      if (s.mode === 'ground') this.disarm('Батарея разряжена: моторы остановлены');
      else {
        this.fallCause = 'батарея разряжена';
        this.disarm('Батарея разряжена: моторы остановлены');
        this.setMode('falling');
      }
    } else if ((AIRBORNE.includes(s.mode) || s.mode === 'backtransition') && s.aglM < 0.5) this.crash('Столкновение с рельефом');
    else if (AIRBORNE.includes(s.mode)) this.checkAttitudeLimits();
  }

  /** Ручки ПДУ доходят до борта только в зоне действия пульта. */
  private stickNow(c: Controls): Stick {
    if (!this.rcInRange()) return ZERO_STICK;
    const k = c.stick;
    if (!k) return ZERO_STICK;
    return { roll: clamp(k.roll, -1, 1), pitch: clamp(k.pitch, -1, 1), yaw: clamp(k.yaw, -1, 1), throttle: clamp(k.throttle, -1, 1) };
  }

  /** Порыв в точке; сглаженный — то, что успевает сдвинуть аппарат с его инерцией. */
  private sampleGust(h: number) {
    if (!this.turb) return;
    const s = this.state;
    const g = this.turb.sample(s.t, s.east, s.north, Math.max(0, s.aglM));
    this.gust = g;
    const a = 1 - Math.exp(-h / GUST_LAG_S);
    this.gustLp = { e: this.gustLp.e + (g.e - this.gustLp.e) * a, n: this.gustLp.n + (g.n - this.gustLp.n) * a, u: this.gustLp.u + (g.u - this.gustLp.u) * a };
    s.gustMs = Math.hypot(g.e, g.n, g.u);
  }

  /**
   * Порывы и раскачка без стабилизации: вертикальные несут аппарат вместе с воздухом (регулятор
   * высоты догоняет), боковые кренят — автопилот парирует медленную часть. Возвращает мощность с
   * добавкой на работу против порывов.
   */
  private applyDisturbance(h: number, power: number): number {
    const stab = this.failed.has('stabilization');
    if (!this.turb && !stab) return power;
    const s = this.state;
    const planePhase = AIRBORNE.includes(s.mode) || s.mode === 'transition' || s.mode === 'backtransition' || (s.mode === 'failsafe' && s.failsafePhase === 'plane');
    const rotorPhase = s.mode === 'climb' || s.mode === 'descent' || s.mode === 'final' || (s.mode === 'failsafe' && s.failsafePhase === 'copter');
    if (!planePhase && !rotorPhase) return power;
    let bank = 0;
    let vz = 0;
    if (this.turb) {
      vz = (planePhase ? GUST_VZ_PLANE : GUST_VZ_HOVER) * this.gust.u;
      if (planePhase) {
        const psi = s.headingDeg * RAD;
        const lateral = this.gust.e * Math.cos(psi) - this.gust.n * Math.sin(psi);
        this.rollLp += (lateral - this.rollLp) * (1 - Math.exp(-h / GUST_ROLL_TAU_S));
        bank = GUST_ROLL_DEG * (lateral - this.rollLp);
      } else {
        // Висение: тяга против порывов, чем сильнее болтанка — тем больше.
        power *= 1 + 0.03 * s.gustMs;
      }
    }
    if (stab && planePhase) {
      // Контур стабилизации самолёта раскачивается всё сильнее; коптерный работает.
      const since = s.t - (this.failT.stabilization ?? s.t);
      const amp = Math.min(80, 3 * Math.exp(since / 20));
      bank += amp * Math.sin(2 * Math.PI * 0.35 * since);
      vz += (amp / 15) * Math.sin(2 * Math.PI * 0.2 * since + 1);
    }
    this.bankGust = bank;
    this.vzGust = vz;
    s.bankDeg += bank;
    s.vzMs += vz;
    s.up += vz * h;
    if (bank !== 0 && s.tasMs > 5) s.headingDeg = norm360(s.headingDeg + ((G * Math.tan(clamp(bank, -80, 80) * RAD)) / s.tasMs / RAD) * h);
    return power;
  }

  /** Таймеры и медленные последствия отказов. */
  private failureTick(h: number) {
    const s = this.state;
    const since = (id: FailureId) => s.t - (this.failT[id] ?? s.t);
    if (this.failed.has('fire') && !this.failed.has('power') && since('fire') >= FIRE_TO_POWER_S) {
      this.events.push({ t: s.t, text: 'Пожар: отказ питания' });
      this.inject('power');
    }
    if (s.linkLost && since('link') >= LINK_TIMEOUT_S) {
      // Типовая реакция автопилота на потерю связи — ВОЗВРАТ.
      if (['auto', 'guided', 'hold', 'manual'].includes(s.mode)) {
        this.events.push({ t: s.t, text: `Нет связи ${LINK_TIMEOUT_S} с — ВОЗВРАТ` });
        this.startRtl();
      } else if (s.mode === 'transition') this.afterTransition = 'rtl';
    }
    if (this.failed.has('airspeed')) this.airspeedK += (this.airspeedGoal - this.airspeedK) * (1 - Math.exp(-h / AIRSPEED_TAU_S));
    if (this.failed.has('compass')) {
      // На висении курс только по компасу; в самолёте — по путевому углу ГНСС.
      const hovering = s.mode === 'climb' || s.mode === 'descent' || s.mode === 'final' || (s.mode === 'failsafe' && s.failsafePhase === 'copter');
      if (hovering) this.compassErrDeg = clamp(this.compassErrDeg + this.compassSign * COMPASS_DRIFT_DEG_S * h, -180, 180);
      else this.compassErrDeg *= Math.exp(-h / 5);
    }
    if (s.mode === 'failsafe') {
      if (this.rcInRange()) this.rcLostS = 0;
      else if ((this.rcLostS += h) >= RC_LOSS_S && !(this.failed.has('stabilization') && s.failsafePhase === 'plane')) {
        this.events.push({ t: s.t, text: 'Нет сигнала ПДУ — управление у автопилота' });
        if (s.failsafePhase === 'plane') this.startRtl();
        else this.landHere();
      }
    }
  }

  /** Ограничения РЛЭ: крен, тангаж или вертикальная больше предельных — автопилот сам в «Фэйлсейф». */
  private checkAttitudeLimits() {
    const s = this.state;
    const L = AIRCRAFT.limits;
    const pitch = s.tasMs > 10 ? Math.atan2(s.vzMs, s.tasMs) / RAD : 0;
    const why = Math.abs(s.bankDeg) > L.failsafeBankDeg ? 'крен' : Math.abs(pitch) > L.failsafePitchDeg ? 'тангаж' : Math.abs(s.vzMs) > L.failsafeVzMs ? 'вертикальная скорость' : null;
    if (why) this.enterFailsafe(`ФЭЙЛСЕЙФ: ${why} больше предельного`, true);
  }

  /** Счисление без ГНСС: неучтённый автопилотом снос копится в ошибке места. */
  private updateNavigation() {
    const s = this.state;
    if (this.windEst) {
      this.navErr.e -= this.unknownE;
      this.navErr.n -= this.unknownN;
    }
    this.unknownE = 0;
    this.unknownN = 0;
    s.estimate.east = s.east + this.navErr.e;
    s.estimate.north = s.north + this.navErr.n;
    // Показания ПВД: при отказе — доля истинной; порывы вдоль курса дёргают стрелку.
    let reading = s.iasMs * this.airspeedK;
    if (this.turb && s.iasMs > 0) {
      const psi = s.headingDeg * RAD;
      const along = (this.gust.e - this.gustLp.e) * Math.sin(psi) + (this.gust.n - this.gustLp.n) * Math.cos(psi);
      reading = Math.max(0, reading - along * Math.sqrt(this.rho(s.up) / RHO0));
    }
    s.iasReadingMs = reading;
  }

  /**
   * Моторы остановлены (ДИЗАРМ в воздухе). Пока скорость выше сваливания, крыло держит: аппарат
   * планирует без тяги, скорость держится снижением, Vz = −D·V / (m·g) по поляре. Медленнее —
   * падение с кувырком: вертикальная скорость растёт до установившейся, горизонтальная гаснет.
   */
  private fall(h: number, rho: number) {
    const s = this.state;
    s.lift = 0;
    s.pusher = 0;
    const wind = windAt(this.weather, Math.max(0, s.aglM));
    s.wind = wind;
    const to = (wind.fromDeg + 180) * RAD;
    const tas = Math.max(0, s.tasMs);
    const stall = this.stallTas(rho);
    let ve: number;
    let vn: number;
    if (tas > stall && !this.noGlide) {
      const sink = -(polar(this.mass, tas, rho).dragN * tas) / (this.mass * G);
      s.vzMs += clamp(sink - s.vzMs, -2 * h, 2 * h);
      s.bankDeg += clamp(-s.bankDeg, -15 * h, 15 * h);
      // Без тяги скорость понемногу уходит: автопилот не успевает разменивать высоту.
      s.tasMs = tas - 0.15 * h;
      ve = s.tasMs * Math.sin(s.headingDeg * RAD) + wind.speedMs * Math.sin(to);
      vn = s.tasMs * Math.cos(s.headingDeg * RAD) + wind.speedMs * Math.cos(to);
    } else {
      s.vzMs += (-G + (G * s.vzMs * s.vzMs) / (TERMINAL_FALL_MS * TERMINAL_FALL_MS)) * h;
      s.tasMs = Math.max(0, tas - 4 * h);
      s.bankDeg = wrap180(s.bankDeg + 70 * h);
      s.headingDeg = norm360(s.headingDeg + 35 * h);
      // Горизонтально — остаток скорости и снос ветром.
      const along = s.groundSpeedMs * Math.exp(-h / 1.5);
      ve = along * Math.sin(s.trackDeg * RAD) + 0.7 * wind.speedMs * Math.sin(to) * (1 - Math.exp(-h));
      vn = along * Math.cos(s.trackDeg * RAD) + 0.7 * wind.speedMs * Math.cos(to) * (1 - Math.exp(-h));
    }
    s.iasMs = s.tasMs * Math.sqrt(rho / RHO0);
    s.east += ve * h;
    s.north += vn * h;
    s.up += s.vzMs * h;
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.distanceM += s.groundSpeedMs * h;
    const g = this.groundUp(s.east, s.north);
    if (s.up <= g) {
      const impact = Math.hypot(s.vzMs, s.groundSpeedMs);
      s.up = g;
      if (-s.vzMs < SAFE_IMPACT_MS && s.groundSpeedMs < 3) {
        s.vzMs = 0;
        s.groundSpeedMs = 0;
        s.bankDeg = 0;
        this.setMode('landed', 'Жёсткая посадка без моторов');
      } else {
        this.crash(`Удар о землю на ${Math.round(impact)} м/с — ${this.fallCause}`);
      }
    }
  }

  private crash(reason: string) {
    const s = this.state;
    s.reason = reason;
    s.armed = false;
    s.lift = 0;
    s.pusher = 0;
    s.powerW = 0;
    this.setMode('crashed', `АВАРИЯ: ${reason}`);
  }

  /** Касание на роторах: мягко — посадка, быстро вниз или вбок — авария. */
  private touchdown(cause: string) {
    const s = this.state;
    const sink = -s.vzMs;
    s.up = this.groundUp(s.east, s.north);
    if (sink < SAFE_IMPACT_MS && s.groundSpeedMs < 3) {
      s.vzMs = 0;
      s.lift = 0;
      s.pusher = 0;
      s.groundSpeedMs = 0;
      s.bankDeg = 0;
      s.iasMs = 0;
      s.tasMs = 0;
      this.setMode('landed', sink > HARD_LANDING_MS ? `Жёсткая посадка: касание ${sink.toFixed(1)} м/с` : 'Посадка выполнена');
    } else this.crash(`Удар о землю на ${Math.round(Math.hypot(sink, s.groundSpeedMs))} м/с — ${cause}`);
  }

  /** Разворот на висении к курсу посадки (против ветра), не быстрее 20°/с. Без компаса — к ложному курсу. */
  private hoverYaw(h: number) {
    const s = this.state;
    const e = wrap180(this.hoverHeadingDeg + this.compassErrDeg - s.headingDeg);
    s.headingDeg = norm360(s.headingDeg + clamp(e, -20 * h, 20 * h));
    s.bankDeg = 0;
  }

  /** Без одного подъёмного винта реактивный момент не уравновешен — аппарат вращается; ветер (флюгер) немного гасит. */
  private spin(h: number) {
    if (!this.failed.has('rotor')) return;
    const s = this.state;
    const k = 1 - clamp(s.wind.speedMs / 8, 0, 0.7);
    s.headingDeg = norm360(s.headingDeg + this.rotorSpinSign * ROTOR_SPIN_DEG_S * k * h);
  }

  /**
   * Вертикальная на роторах: уставка vzCmd, пока тяги хватает. Без винта тяги меньше веса —
   * аппарат проседает, пока сопротивление плашмя не уравновесит недостачу. wing — доля веса на крыле.
   */
  private rotorVz(h: number, vzCmd: number, wing = 0): number {
    if (!this.failed.has('rotor') && !this.failed.has('vtol')) return vzCmd;
    const s = this.state;
    const aUp = G * (this.rotorAuthority() + wing - 1);
    const aDown = -G * (1 - wing);
    const drag = (0.5 * this.rho(s.up) * VERTICAL_DRAG_AREA_M2 * s.vzMs * Math.abs(s.vzMs)) / this.mass;
    return s.vzMs + (clamp(2 * (vzCmd - s.vzMs), Math.min(aDown, aUp), aUp) - drag) * h;
  }

  /**
   * Горизонтальное перемещение на висении к точке, не быстрее HOVER_TRANSLATE_MS. Автопилот ведёт
   * по своей навигации: без ГНСС точку не держит — сносит ветром; без компаса путает направление.
   */
  private hoverMove(h: number, target: { east: number; north: number }) {
    const s = this.state;
    const p = this.navPos();
    const de = target.east - p.east;
    const dn = target.north - p.north;
    const d = Math.hypot(de, dn);
    let v = Math.min(HOVER_TRANSLATE_MS, d / Math.max(h, 1e-6), d);
    // Вращающийся аппарат точку держит плохо.
    if (this.failed.has('rotor')) v *= 0.3;
    let me = 0;
    let mn = 0;
    if (d > 0.01) {
      const ue = de / d;
      const un = dn / d;
      const a = this.compassErrDeg * RAD;
      if (a === 0) {
        me = ue * v * h;
        mn = un * v * h;
      } else {
        // Смещение в связанных осях по ложному курсу: на деле — повёрнуто на ошибку компаса.
        me = (ue * Math.cos(a) + un * Math.sin(a)) * v * h;
        mn = (un * Math.cos(a) - ue * Math.sin(a)) * v * h;
        this.unknownE += me - ue * v * h;
        this.unknownN += mn - un * v * h;
      }
      s.east += me;
      s.north += mn;
    }
    s.groundSpeedMs = d > 0.01 ? v : 0;
    s.iasMs = 0;
    s.tasMs = 0;
    let we = 0;
    let wn = 0;
    if (this.windEst) {
      const w = windVec(windAt(this.weather, Math.max(0, s.aglM)));
      we += 0.9 * w.e * h;
      wn += 0.9 * w.n * h;
    }
    if (this.turb) {
      we += this.gustLp.e * h;
      wn += this.gustLp.n * h;
    }
    if (we !== 0 || wn !== 0) {
      s.east += we;
      s.north += wn;
      this.unknownE += we;
      this.unknownN += wn;
      // Путевая — по фактическому перемещению: поправка к точке вместе со сносом.
      s.groundSpeedMs = Math.hypot(me + we, mn + wn) / h;
    }
  }

  /**
   * Торможение перед посадкой: маршевый выключен, скорость гасит сопротивление по поляре;
   * ниже 12 м/с подхватывают роторы и дотормаживают так, чтобы встать над точкой.
   */
  private brake(h: number, rho: number, hover: number): number {
    const s = this.state;
    const p = this.navPos();
    const target = this.landAt ?? { east: p.east + Math.sin(s.trackDeg * RAD) * 150, north: p.north + Math.cos(s.trackDeg * RAD) * 150 };
    this.landAt ??= target;
    const d = Math.hypot(target.east - p.east, target.north - p.north);
    const tas = Math.max(0, s.tasMs);
    // Путевая скорость к точке: при встречном ветре гаснет раньше воздушной.
    const toward = (q: { east: number; north: number }) => s.groundSpeedMs * Math.cos((s.trackDeg - bearing(q, target)) * RAD);
    // Роторы наклоняют аппарат и дотормаживают к точке.
    let { decel, lift } = brakeDecel(this.mass, tas, rho, toward(p), d);
    if (this.failed.has('vtol')) {
      // Роторов нет — тормозит только сопротивление, а ниже сваливания крыло не держит.
      lift = 0;
      decel = tas > 1 ? polar(this.mass, tas, rho).dragN / this.mass : 0;
      if (tas < this.stallTas(rho)) {
        this.fallCause = 'отказ СВВП: скорость ниже сваливания';
        this.setMode('falling');
        return 0;
      }
    }
    const tasNew = Math.max(0, tas - decel * h);
    s.iasMs = tasNew * Math.sqrt(rho / RHO0);
    // С выключенным маршевым аппарат планирует к высоте обратного перехода над точкой (как в плане),
    // но не набирает: тяги для набора нет.
    const alt = Math.min(s.up, this.groundUp(target.east, target.north) + VT.backTransitionHeightM);
    this.fly(h, d > 5 ? bearing(p, target) : s.trackDeg, alt, rho, 1 - 0.8 * lift, tasNew > 5);
    s.lift = lift;
    s.pusher = 0;
    // Над точкой — или путевая к ней погасла (встречный ветер): остаток пути на роторах.
    if (tasNew < 1.5 || d < 3 || toward(this.navPos()) <= 1) this.setMode('descent');
    return AIRCRAFT.idlePowerPlaneW + lift * hover;
  }

  /**
   * Самолётный режим: наведение даёт путевой угол и высоту, дальше — поправка на снос,
   * крен с ограниченной скоростью, разворот g·tg(крен)/V, вертикаль с ограничением Vz.
   * Автопилот ведёт по своей навигации (navPos) и по показаниям ПВД.
   */
  private airplane(h: number, c: Controls, rho: number): number {
    const s = this.state;
    const tas = tasFromIas(Math.max(s.iasMs, 1), rho);
    const nav = this.navPos();
    let track = s.trackDeg;
    let alt = s.up;
    const R = this.turnRadiusM(tas);
    const pusherOff = AIRCRAFT.procedures.pusherOffBeforeLandingM;

    if (s.mode === 'auto') {
      let a = this.path[s.wp - 1]!;
      let b = this.path[s.wp]!;
      for (;;) {
        const len = Math.hypot(b.east - a.east, b.north - a.north);
        const along = len > 0 ? ((nav.east - a.east) * (b.east - a.east) + (nav.north - a.north) * (b.north - a.north)) / len : 0;
        const next = this.path[s.wp + 1];
        if (!next) break;
        const turn = Math.abs(wrap180(bearing(b, next) - bearing(a, b))) * RAD;
        const anticipate = Math.min(R * Math.tan(turn / 2), 0.5 * len, 0.5 * Math.hypot(next.east - b.east, next.north - b.north));
        if (along < len - anticipate) break;
        s.wp++;
        a = b;
        b = this.path[s.wp]!;
      }
      const len = Math.hypot(b.east - a.east, b.north - a.north);
      const de = (b.east - a.east) / (len || 1);
      const dn = (b.north - a.north) / (len || 1);
      const along = (nav.east - a.east) * de + (nav.north - a.north) * dn;
      // Посадочная прямая (последний участок посадочного маршрута, нарезанный огибанием рельефа
      // на отрезки): за pusherOffBeforeLandingM до точки посадки выключаем маршевый (по РЛЭ).
      const lastIdx = this.path.length - 1;
      const onFinal = s.wp === lastIdx || (this.finalLeg !== undefined && b.routeLeg === this.finalLeg);
      const toLanding = Math.hypot(this.landing.east - nav.east, this.landing.north - nav.north);
      if (onFinal && (toLanding <= pusherOff || (s.wp === lastIdx && along >= len))) {
        this.landAt = { east: this.landing.east, north: this.landing.north };
        this.hoverHeadingDeg = bearing(this.path[lastIdx - 1] ?? a, this.path[lastIdx]!);
        this.setMode('backtransition', 'Посадочная прямая — маршевый выключен');
        return this.brake(h, rho, hoverPowerW(this.mass, rho));
      }
      // Боковое уклонение: положительное — левее линии пути.
      const xte = de * (nav.north - a.north) - dn * (nav.east - a.east);
      track = norm360(bearing(a, b) + clamp(Math.atan2(xte, 60) / RAD, -45, 45));
      alt = a.up + (b.up - a.up) * clamp(along / (len || 1), 0, 1);
      s.routeLeg = b.routeLeg ?? null;
    } else if (s.mode === 'guided' || s.mode === 'hold') {
      const center = s.mode === 'hold' ? this.home : (c.target ?? { east: nav.east, north: nav.north });
      track = this.orbitTrack(center, Math.max(1.3 * R, 150));
      alt = this.terrainFollow(c.heightAglM, track, tas);
      s.routeLeg = null;
    } else if (s.mode === 'manual') {
      track = c.courseDeg;
      alt = this.terrainFollow(c.heightAglM, track, tas);
      s.routeLeg = null;
    } else if (s.mode === 'rtl') {
      s.routeLeg = null;
      // Посадочный маршрут по ветру: выравнивание → фиксация направления → точка посадки.
      const pts = [...this.rtlApproach, this.home];
      let target = pts[this.rtlStage]!;
      let d = Math.hypot(target.east - nav.east, target.north - nav.north);
      if (this.rtlStage < 2 && d < 150) {
        this.rtlStage++;
        target = pts[this.rtlStage]!;
        d = Math.hypot(target.east - nav.east, target.north - nav.north);
      }
      track = bearing(nav, target);
      const approachAgl = [Math.min(c.heightAglM, 150), 100, VT.backTransitionHeightM][this.rtlStage]!;
      const floor = this.rtlStage === 2 ? VT.backTransitionHeightM - 5 : 60;
      alt = Math.max(this.groundUp(target.east, target.north) + approachAgl, this.terrainFollow(floor, track, tas));
      if (this.rtlStage === 2 && d <= pusherOff) {
        this.landAt = { east: this.home.east, north: this.home.north };
        this.setMode('backtransition', 'Посадочная прямая — маршевый выключен');
        return this.brake(h, rho, hoverPowerW(this.mass, rho));
      }
    }

    // Автопилот держит уставку по показаниям ПВД: при отказе — не ту скорость, что задана.
    const iasTarget = Math.min(clamp(c.iasMs, AIRCRAFT.transitionLowIasMs, AIRCRAFT.limits.maxIasMs) / this.airspeedK, AIRCRAFT.limits.maxIasMs * PUSHER_TOP_IAS_SHARE);
    const iasBefore = s.iasMs;
    s.iasMs += clamp(iasTarget - s.iasMs, -1.2 * h, 1.0 * h);
    const accel = (tasFromIas(s.iasMs, rho) - tasFromIas(iasBefore, rho)) / h;
    const glide = this.failed.has('pusher');
    this.fly(h, track, alt, rho, 1, true, glide, true);
    if (s.iasMs > AIRCRAFT.limits.maxIasMs && !this.overspeedWarned) {
      this.overspeedWarned = true;
      this.events.push({ t: s.t, text: 'Превышение предельной приборной скорости' });
    }

    const tasNow = Math.max(s.tasMs, 1);
    s.lift = 0;
    if (glide) {
      // Винта нет — только питание борта; скорость держится снижением.
      s.pusher = 0;
      return AIRCRAFT.idlePowerPlaneW;
    }
    let p = climbPowerW(this.mass, tasNow, rho, s.vzMs, 1 / Math.cos(s.bankDeg * RAD));
    p = Math.max(AIRCRAFT.idlePowerPlaneW, p + (this.mass * tasNow * accel) / AIRCRAFT.etaDrive);
    if (this.turb) {
      // Попутный порыв роняет воздушную скорость — автопилот разгоняет аппарат снова.
      const psi = s.headingDeg * RAD;
      const along = this.gustLp.e * Math.sin(psi) + this.gustLp.n * Math.cos(psi);
      if (!Number.isNaN(this.prevAlong)) p += (Math.max(0, along - this.prevAlong) / h) * ((this.mass * tasNow) / AIRCRAFT.etaDrive);
      this.prevAlong = along;
    }
    s.pusher = Math.min(1, p / 1600);
    return p;
  }

  /** Вертикальная при заклинившем руле высоты: уставка почти не слушается, аппарат уводит с раскачкой. */
  private pitchFailure(vzCmd: number): number {
    const tail = this.failed.has('tail');
    if (!tail && !this.failed.has('elevator')) return vzCmd;
    const since = this.state.t - (this.failT[tail ? 'tail' : 'elevator'] ?? this.state.t);
    return this.elevatorBiasMs + clamp(vzCmd, -ELEVATOR_AUTH_MS, ELEVATOR_AUTH_MS) + (tail ? 2 : 1) * Math.sin((2 * Math.PI * since) / 25);
  }

  /** Крен при заклинившем элероне: второй работает — управления вдвое меньше, и тянет в сторону заклинившего. */
  private rollLimit(bankCmd: number): number {
    return this.failed.has('aileron') ? clamp(bankCmd, this.aileronBiasDeg - AILERON_AUTH_DEG, this.aileronBiasDeg + AILERON_AUTH_DEG) : bankCmd;
  }

  /**
   * Кинематика в воздухе: курс на заданный путевой угол с поправкой на снос, крен с
   * ограничением скорости крена, вертикаль к высоте alt. windShare — доля ветра,
   * сносящего аппарат (на переходе роторы ещё держат точку). tas берётся из s.iasMs.
   * glide — тяги нет, набирать нечем; stall — крыло может свалиться (только самолётный режим автопилота).
   */
  private fly(h: number, trackCmd: number, alt: number, rho: number, windShare: number, steer = false, glide = false, stall = false) {
    const s = this.state;
    const tas = tasFromIas(s.iasMs, rho);
    s.tasMs = tas;
    const wind = windAt(this.weather, Math.max(0, s.aglM));
    s.wind = wind;
    const aileron = this.failed.has('aileron');
    if (steer && tas > 5) {
      const tri = windTriangle(tas, trackCmd, wind);
      const headingCmd = trackCmd + (tri ? tri.driftDeg : 0);
      const bankCmd = this.rollLimit(clamp(wrap180(headingCmd - s.headingDeg) * 1.2, -AIRCRAFT.maxBankDeg, AIRCRAFT.maxBankDeg));
      const rate = aileron ? AILERON_RATE_DEG_S : 20;
      s.bankDeg += clamp(bankCmd - s.bankDeg, -rate * h, rate * h);
      s.headingDeg = norm360(s.headingDeg + ((G * Math.tan(s.bankDeg * RAD)) / tas / RAD) * h);
    } else {
      s.bankDeg += clamp((aileron ? this.aileronBiasDeg : 0) - s.bankDeg, -20 * h, 20 * h);
    }
    const stallIas = STALL_SHARE * AIRCRAFT.transitionLowIasMs;
    if (stall && (s.iasMs < stallIas || (this.stalled && s.iasMs < 1.15 * stallIas))) {
      // Сваливание: срыв на одном крыле — аппарат валится на крыло и опускает нос, вертикальная растёт,
      // скорость набирается снижением. Выходит, только разогнавшись заметно выше скорости сваливания.
      if (!this.stalled) this.stallSide = this.rand() < 0.5 ? -1 : 1;
      this.stalled = true;
      s.bankDeg += this.stallSide * 40 * h;
      s.vzMs -= G * 0.5 * h;
      s.iasMs += ((-G * s.vzMs) / Math.max(tas, 5)) * 0.3 * h * Math.sqrt(rho / RHO0);
    } else {
      this.stalled = false;
      let vzCmd = this.pitchFailure(clamp(0.3 * (alt - s.up), -AIRCRAFT.planeDescentRateMaxMs, AIRCRAFT.planeClimbRateMaxMs));
      // Без тяги скорость держится только снижением: Vz = −D·V / (m·g).
      if (glide) vzCmd = Math.min(vzCmd, -(polar(this.mass, Math.max(tas, 5), rho).dragN * tas) / (this.mass * G));
      s.vzMs += clamp(vzCmd - s.vzMs, -0.6 * h, 0.6 * h);
    }
    const to = (wind.fromDeg + 180) * RAD;
    let ve = tas * Math.sin(s.headingDeg * RAD) + windShare * wind.speedMs * Math.sin(to);
    let vn = tas * Math.cos(s.headingDeg * RAD) + windShare * wind.speedMs * Math.cos(to);
    if (this.turb) {
      ve += windShare * this.gustLp.e;
      vn += windShare * this.gustLp.n;
    }
    if (this.windEst) {
      // Счисление по ПВД: автопилот знает свою воздушную скорость и ветер, измеренный до отказа ГНСС.
      this.unknownE += (ve - tas * Math.sin(s.headingDeg * RAD) - windShare * this.windEst.e) * h;
      this.unknownN += (vn - tas * Math.cos(s.headingDeg * RAD) - windShare * this.windEst.n) * h;
    }
    s.east += ve * h;
    s.north += vn * h;
    s.up += s.vzMs * h;
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.driftDeg = wrap180(s.headingDeg - s.trackDeg);
    s.distanceM += s.groundSpeedMs * h;
  }

  /** Тяга маршевого на максимуме: в горизонте разгоняет до PUSHER_TOP_IAS_SHARE предельной приборной, Н. */
  private maxThrustN(rho: number): number {
    return polar(this.mass, tasFromIas(AIRCRAFT.limits.maxIasMs * PUSHER_TOP_IAS_SHARE, rho), rho).dragN;
  }

  /**
   * «Фэйлсейф», самолётом: стабилизированный самолёт. Ручка крена — заданный крен, тангажа —
   * вертикальная (от себя — снижение), газ меняет уставку скорости, которую держит тяга маршевого.
   * Скорость — по энергии: dV/dt = (T − D)/m − g·Vz/V; без тяги держится только снижением,
   * ниже сваливания крыло не держит. Касание — посадка на брюхо, если полого и небыстро.
   */
  private manualPlane(h: number, st: Stick, rho: number): number {
    const s = this.state;
    const L = AIRCRAFT.limits;
    const tas = Math.max(1, tasFromIas(s.iasMs, rho));
    const aileron = this.failed.has('aileron');
    const bankCmd = this.rollLimit(st.roll * L.maxBankDeg);
    const rollRate = aileron ? AILERON_RATE_DEG_S : FS_ROLL_RATE_DEG_S;
    s.bankDeg += clamp(bankCmd - s.bankDeg, -rollRate * h, rollRate * h);
    this.iasHold = clamp(this.iasHold + st.throttle * FS_IAS_RATE * h, 0, L.maxIasMs);
    const n = 1 / Math.cos(clamp(s.bankDeg, -80, 80) * RAD);
    const drag = polar(this.mass * n, tas, rho).dragN;
    const stallTas = this.stallTas(rho);
    if (tas < stallTas) {
      // Сваливание: ручка не помогает, аппарат проседает и набирает скорость снижением.
      s.vzMs -= G * (1 - (tas / stallTas) ** 2) * 0.8 * h;
    } else {
      const vzCmd = this.pitchFailure(st.pitch > 0 ? -st.pitch * 2 * AIRCRAFT.planeDescentRateMaxMs : -st.pitch * AIRCRAFT.planeClimbRateMaxMs);
      s.vzMs += clamp(vzCmd - s.vzMs, -FS_VZ_ACCEL * h, FS_VZ_ACCEL * h);
    }
    // Тяга — сколько нужно на уставку (сопротивление, набор, разгон ~1 м/с²), в пределах маршевого.
    const want = drag + (this.mass * G * s.vzMs) / tas + this.mass * clamp(tasFromIas(this.iasHold, rho) - tas, -1, 1);
    const thrust = this.failed.has('pusher') ? 0 : clamp(want, 0, this.maxThrustN(rho));
    const tasNew = Math.max(1, tas + ((thrust - drag) / this.mass - (G * s.vzMs) / tas) * h);
    s.tasMs = tasNew;
    s.iasMs = tasNew * Math.sqrt(rho / RHO0);
    s.headingDeg = norm360(s.headingDeg + ((G * Math.tan(clamp(s.bankDeg, -80, 80) * RAD)) / tasNew / RAD) * h);
    const wind = windAt(this.weather, Math.max(0, s.aglM));
    s.wind = wind;
    const w = windVec(wind);
    const psi = s.headingDeg * RAD;
    const ve = tasNew * Math.sin(psi) + w.e + this.gustLp.e;
    const vn = tasNew * Math.cos(psi) + w.n + this.gustLp.n;
    if (this.windEst) {
      this.unknownE += (w.e + this.gustLp.e - this.windEst.e) * h;
      this.unknownN += (w.n + this.gustLp.n - this.windEst.n) * h;
    }
    s.east += ve * h;
    s.north += vn * h;
    s.up += s.vzMs * h;
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.driftDeg = wrap180(s.headingDeg - s.trackDeg);
    s.distanceM += s.groundSpeedMs * h;
    s.lift = 0;
    s.pusher = thrust / this.maxThrustN(rho);
    const power = thrust > 0 ? Math.max(AIRCRAFT.idlePowerPlaneW, (thrust * tasNew) / AIRCRAFT.etaDrive) : AIRCRAFT.idlePowerPlaneW;
    const g = this.groundUp(s.east, s.north);
    if (s.up <= g) {
      s.up = g;
      const sink = -s.vzMs;
      const gs = s.groundSpeedMs;
      if (sink <= BELLY_SINK_MS && gs <= BELLY_GROUND_MS && Math.abs(s.bankDeg) < BELLY_BANK_DEG) {
        s.vzMs = 0;
        s.groundSpeedMs = 0;
        s.bankDeg = 0;
        s.iasMs = 0;
        s.tasMs = 0;
        s.pusher = 0;
        this.setMode('landed', `Посадка на брюхо: снижение ${sink.toFixed(1)} м/с, путевая ${Math.round(gs)} м/с`);
      } else {
        this.crash(`Удар о землю при посадке самолётом: снижение ${sink.toFixed(1)} м/с, путевая ${Math.round(gs)} м/с`);
      }
    }
    return power;
  }

  /**
   * «Фэйлсейф», коптером (стабилизация углов): ручки крена и тангажа — скорость относительно
   * воздуха в связанных осях, рыскания — угловая скорость, газ — вертикальная. Точку никто не
   * держит: отпущенные ручки — аппарат уходит с ветром, пилот парирует сам. С поступательной
   * скоростью часть веса берёт крыло — так садятся без одного подъёмного винта.
   */
  private manualCopter(h: number, st: Stick, rho: number, hover: number): number {
    const s = this.state;
    const wind = windAt(this.weather, Math.max(0, s.aglM));
    s.wind = wind;
    const w = windVec(wind);
    const rotorLost = this.failed.has('rotor');
    const airspeed = Math.hypot(this.vAir.e, this.vAir.n);
    let yaw = st.yaw * FS_YAW_RATE_DEG_S;
    if (rotorLost) yaw = 0.3 * yaw + this.rotorSpinSign * ROTOR_SPIN_DEG_S * (1 - clamp(airspeed / 8, 0, 1));
    s.headingDeg = norm360(s.headingDeg + yaw * h);
    const psi = s.headingDeg * RAD;
    const fe = Math.sin(psi);
    const fn = Math.cos(psi);
    // Вправо от курса: (cos ψ, −sin ψ).
    const vmax = MANUAL_COPTER_MS * (rotorLost ? 0.85 : 1);
    const ce = (st.pitch * fe + st.roll * fn) * vmax;
    const cn = (st.pitch * fn - st.roll * fe) * vmax;
    let ae = (ce - this.vAir.e) / FS_COPTER_TAU_S;
    let an = (cn - this.vAir.n) / FS_COPTER_TAU_S;
    const am = Math.hypot(ae, an);
    if (am > FS_COPTER_ACCEL) {
      ae *= FS_COPTER_ACCEL / am;
      an *= FS_COPTER_ACCEL / am;
    }
    this.vAir = { e: this.vAir.e + ae * h, n: this.vAir.n + an * h };
    // Наклон для отрисовки — по боковому ускорению.
    s.bankDeg = clamp(Math.atan2(ae * fn - an * fe, G) / RAD, -30, 30);
    const ve = this.vAir.e + w.e + this.gustLp.e;
    const vn = this.vAir.n + w.n + this.gustLp.n;
    if (this.windEst) {
      this.unknownE += (w.e + this.gustLp.e - this.windEst.e) * h;
      this.unknownN += (w.n + this.gustLp.n - this.windEst.n) * h;
    }
    s.east += ve * h;
    s.north += vn * h;
    // Крыло: доля веса по скорости вперёд относительно сваливания.
    const forward = Math.max(0, this.vAir.e * fe + this.vAir.n * fn);
    const wing = clamp((forward / this.stallTas(rho)) ** 2, 0, 1);
    const vzCmd = st.throttle >= 0 ? st.throttle * FS_CLIMB_MS : st.throttle * FS_DESCENT_MS;
    const auth = this.rotorAuthority();
    const drag = (0.5 * rho * VERTICAL_DRAG_AREA_M2 * s.vzMs * Math.abs(s.vzMs)) / this.mass;
    const aUp = G * (auth + wing - 1);
    const acc = clamp(2 * (vzCmd - s.vzMs), Math.min(-G * (1 - wing), aUp), aUp);
    s.vzMs += (acc - drag) * h;
    s.up += s.vzMs * h;
    const rotorFrac = clamp(1 - wing + acc / G, 0, auth);
    s.lift = Math.min(1, rotorFrac);
    s.pusher = 0;
    s.tasMs = Math.hypot(this.vAir.e, this.vAir.n);
    s.iasMs = s.tasMs * Math.sqrt(rho / RHO0);
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.driftDeg = 0;
    s.distanceM += s.groundSpeedMs * h;
    const aux = AIRCRAFT.auxPowerHoverW;
    const power = aux + (hover - aux) * rotorFrac ** 1.5 * (1 + ((VT.climbFactor - 1) * Math.max(0, s.vzMs)) / VT.climbRateMs);
    if (s.up <= this.groundUp(s.east, s.north)) this.touchdown(rotorLost ? 'ручная посадка без подъёмного винта' : 'ручная посадка');
    return power;
  }
}

function fmtKm(m: number): string {
  return (m / 1000).toFixed(m % 1000 === 0 ? 0 : 1);
}
