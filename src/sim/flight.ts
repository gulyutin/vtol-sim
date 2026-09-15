import { AIRCRAFT, ASPECT_RATIO } from './aircraft';
import { brakeDecel, climbPowerW, HOVER_TRANSLATE_MS, hoverPowerW, polar, takeoffMassKg } from './aero';
import { airDensity, batteryCapacityWh, G, RHO0, tasFromIas, temperatureAt } from './atmosphere';
import { failureInfo, FIRE_TO_POWER_S, LINK_TIMEOUT_S, RC_RANGE_M, type FailureId, type LinkLossAction } from './failures';
import { backTransitionAltitudeM, fromLocal, toLocal, transitionAltitudeM } from './mission';
import { windProcedures } from './procedures';
import { BOARD_ANTENNA_M, linkJamDb, RADIO, RadioLink, TELEMETRY_HZ, type LinkNetwork, type LinkState, type RadioParams, type Relay, type Station } from './radio';
import type { LocalWind, TerrainWind } from './terrainWind';
import { Turbulence, type Gust, type SunDirection } from './turbulence';
import type { MissionPlan, Site, Terrain, Weather, Wind } from './types';
import { windAt, windTriangle } from './wind';
import {
  EW_EFFECT_THRESHOLD,
  EW_RELEASE_THRESHOLD,
  localEffects,
  localSignedDistance,
  prepareZones,
  zoneKindPhrase,
  type LocalEffects,
  type LocalZone,
  type Zone,
} from './zones';

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

/*
 * Запуск моторов в воздухе. Остановленный мотор регулятор запускает без датчиков: синхронизация и
 * раскрутка до рабочих оборотов. Роторы лёгкие — AIR_START_ROTORS_S; маршевый с большим винтом
 * автопилот раскручивает плавнее (винт в потоке крутится ветряком, рывок срывает синхронизацию) —
 * PUSHER_START_S. Из кувырка сначала надо выровняться: пока тяга роторов не вверх, она не держит —
 * TUMBLE_LEVEL_S. Всё это время аппарат падает дальше: высоту на выход считает физика шага.
 */
export const AIR_START_ROTORS_S = 1.5;
export const PUSHER_START_S = 3;
export const TUMBLE_LEVEL_S = 1;
/** Маршевый работает без тяги (висение, коптер) — обороты для отрисовки. */
const PUSHER_IDLE = 0.1;
/** Из коптера разгон — не ниже этой высоты над землёй, м. */
const TRANSITION_MIN_AGL_M = 20;

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
/**
 * Отклик на порывы, с: крен — инерция по крену и размах (вихри мельче крыла усредняются), вертикальные —
 * инерция по высоте. Без них каждый шаг крен и Vz повторяли бы мелкие вихри — поза дрожала.
 */
const GUST_ROLL_LAG_S = 0.4;
const GUST_HEAVE_LAG_S = 0.5;
/** Нос в вертикальный порыв (флюгерная устойчивость): восходящий — нос вниз, ° на м/с; медленную часть парирует автопилот. */
const GUST_PITCH_DEG = 1.5;

/*
 * Роторы: ускорения ограничены, как у настоящего коптера, — никаких мгновенных скачков скорости при
 * смене режима. Подход к точке и к высоте — с торможением, чтобы встать без рывка.
 */
/** Вертикальное ускорение на роторах и торможение к высоте перехода, м/с². */
const ROTOR_VZ_ACCEL = 1.5;
const ROTOR_VZ_BRAKE = 1.2;
/** Горизонтальное ускорение на роторах, торможение к точке, м/с², и коэффициент подхода, 1/с (HOVER_BRAKE < HOVER_ACCEL / 2). */
const HOVER_ACCEL = 1.5;
const HOVER_BRAKE = 0.7;
const HOVER_GAIN = 0.6;
/** Крен в самолёте: подход к уставке и инерция по крену (разгон скорости крена), с. */
const ROLL_TAU_S = 0.3;
const ROLL_LAG_S = 0.12;
/** Торможение перед посадкой — не больше этого, м/с²: сопротивление и наклон роторов назад. */
const BRAKE_DECEL_MAX = 3;
/** Разворот на висении: не быстрее, °/с; подход к курсу и разгон вращения, с. */
const HOVER_YAW_DEG_S = 20;
const HOVER_YAW_TAU_S = 1;
const HOVER_YAW_LAG_S = 0.3;
/**
 * Наклон коптера: горизонтальную силу роторов дают наклоном — разгон, торможение, сопротивление в потоке
 * (CdA корпуса, крыла и роторов, м²). Углы коптер держит быстро: постоянная времени, с, предел скорости, °/с.
 */
const COPTER_DRAG_AREA_M2 = 0.5;
const COPTER_TILT_MAX_DEG = 30;
const COPTER_TILT_TAU_S = 0.3;
const COPTER_TILT_RATE_DEG_S = 90;
/**
 * Тангаж корпуса на крыле: угол пути относительно воздуха + угол атаки. Угол атаки — PITCH_TRIM_DEG на
 * крейсерской приборной, дальше по CL (медленнее, тяжелее, в вираже — нос выше), в пределах.
 */
const PITCH_TRIM_DEG = 2;
const PITCH_ALPHA_MIN_DEG = -3;
const PITCH_ALPHA_MAX_DEG = 12;
/** dCL/dα крыла конечного размаха (Гельмбольд), 1/°. */
const CL_ALPHA_DEG = ((2 * Math.PI * ASPECT_RATIO) / (2 + Math.sqrt(ASPECT_RATIO ** 2 + 4))) * (Math.PI / 180);
/** Инерция корпуса по тангажу: два звена по столько секунд и предельная скорость, °/с. */
const ATTITUDE_LAG_S = 0.15;
const PITCH_RATE_DEG_S = 30;
/** После касания корпус ложится на опоры, с. */
const SETTLE_S = 0.2;

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

/*
 * Зоны РЭБ (zones.ts) — условие среды, а не отказ: вышел из зоны — прошло. Механизмы те же, что
 * у отказов ГНСС и связи: счисление по ПВД и ветру, замершая телеметрия, ВОЗВРАТ по таймауту.
 */
/** Повторный захват ГНСС после помех: от 5 с после короткого перерыва до ~35 с после долгого, с. */
const GNSS_REACQ_MIN_S = 5;
const GNSS_REACQ_LONG_S = 25;
const GNSS_REACQ_LONG_OUTAGE_S = 600;
const GNSS_REACQ_JITTER_S = 5;
/** Подмена захватывает приёмник, если ложный сигнал сильнее настоящего столько секунд. */
const SPOOF_CAPTURE_S = 4;
/** Увод места подменой: ускорение и предельная скорость — медленно, чтобы автопилот не счёл скачком. */
const SPOOF_ACCEL = 0.04;
const SPOOF_MAX_MS = 10;
/** Достоверное решение вернулось — оценка места сходится к истинному с такой постоянной времени, с. */
const NAV_CONVERGE_S = 8;
/** Ветер, известный автопилоту, сглаживается за столько; расхождение с ним — за столько, с. */
const WIND_REF_TAU_S = 180;
const MISMATCH_TAU_S = 3;
/** Запретная зона ближе — предупреждение на НСУ, м. */
const NOFLY_NEAR_M = 1000;

/*
 * ВОЗВРАТ по РЛЭ — не ниже безопасной высоты над рельефом по всему пути домой: запас RTL_CLEARANCE_M,
 * набор закладывается не круче RTL_CLIMB_SHARE предельного (нисходящие потоки, запас). Ниже нужной
 * высоты больше чем на RTL_ORBIT_SLACK_M — сначала набор по кругу над местом; снижение — только когда путь чист.
 */
const RTL_CLEARANCE_M = Math.max(60, 2 * AIRCRAFT.minClearanceM);
const RTL_CLIMB_SHARE = 0.7;
const RTL_ORBIT_SLACK_M = 25;
/** Шаг выборки рельефа по пути домой, м; пересчёт нужной высоты — раз в столько секунд. */
const RTL_STEP_M = 100;
const RTL_NEED_PERIOD_S = 1;
/**
 * Задание: насколько вперёд по маршруту смотреть на рельеф, м, и насколько можно отстать от нужной
 * высоты, прежде чем уйти в набор по кругу, м.
 */
const AUTO_LOOKAHEAD_M = 2000;
const AUTO_ORBIT_SLACK_M = 15;
/** Над точкой посадки выше высоты обратного перехода больше чем на столько, м, — снижение по кругу на маршевом. */
const DESCENT_ORBIT_SLACK_M = 40;

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
/** Команды, которые подаются с ПДУ, — доходят и без связи с НСУ, если борт в зоне пульта. АРМ — тумблер на пульте, как и ДИЗАРМ. */
const RC_COMMANDS: Command[] = ['failsafe', 'copter', 'disarm', 'armAir', 'auto', 'rtl'];

/** Команда подаётся и с ПДУ — без связи с НСУ доходит, если борт в зоне пульта. */
export const isRcCommand = (c: Command): boolean => RC_COMMANDS.includes(c);

/**
 * Аварийные команды восстановления — для меню «Аварийная»: cmd — что передать в command(),
 * title — как назвать в журнале, label — подпись кнопки, hint — подсказка.
 * «В САМОЛЁТНЫЙ РЕЖИМ» — это МАРШРУТ из «Фэйлсейфа» (ВОЗВРАТ, ОЖИДАНИЕ, РУЧНОЙ работают так же).
 */
export const EMERGENCY_COMMANDS = [
  {
    cmd: 'pusherStart',
    title: 'ЗАПУСК МАРШЕВОГО',
    label: 'ЗАПУСК МАРШЕВОГО',
    hint: `Маршевый остановлен («квадрокоптер», ДИЗАРМ в полёте): раскрутка ${PUSHER_START_S} с. Только с НСУ`,
  },
  {
    cmd: 'armAir',
    title: 'АРМ В ВОЗДУХЕ',
    label: 'АРМ В ВОЗДУХЕ — аварийный запуск моторов',
    hint: 'Моторы остановлены в полёте: роторы и маршевый. Из планирования — сразу самолётом, из кувырка — на роторах, если хватит высоты',
  },
  {
    cmd: 'auto',
    title: 'МАРШРУТ',
    label: 'В САМОЛЁТНЫЙ РЕЖИМ — продолжить маршрут',
    hint: 'Из «Фэйлсейфа»: из коптера — разгон на маршевом, из самолёта — сразу; маршрут — с ближайшего участка',
  },
] as const satisfies readonly { cmd: Command; title: string; label: string; hint: string }[];
/** Отказы, после которых аппарат неуправляем. */
const FATAL: FailureId[] = ['power', 'autopilot', 'boom', 'wing'];
const ZERO_STICK: Stick = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
/** Режимы на земле: запретная зона под площадкой — ещё не нарушение. */
const ON_GROUND: LiveMode[] = ['ground', 'spool', 'landed', 'crashed'];

/**
 * Обстановка по зонам (zones.ts). В state — как на самом деле (для инструктора); в telemetry —
 * что знает борт: подмены он не видит (gnssSpoof, spoofed, spoofOffsetM — нули), запретные
 * зоны — по месту, где себя считает.
 */
export interface EwState {
  /** Уровень помех ГНСС и радиоканалу 0…1 — на борту его показывают индикаторы помех приёмника и модема. */
  gnssJam: number;
  gnssSpoof: number;
  linkJam: number;
  /** Запретные зоны, в которых борт (в воздухе). */
  noflyIds: string[];
  /** Ближайшая запретная зона ближе 1 км, если борт не в ней. */
  noflyNear: { id: string; distanceM: number } | null;
  /** Решение ГНСС: есть; нет (помехи или отказ); повторный захват после помех. */
  gnss: 'ok' | 'lost' | 'acquiring';
  /** Приёмник захвачен подменой; на сколько уведено место, м. */
  spoofed: boolean;
  spoofOffsetM: number;
  /**
   * Расхождение навигации, м/с: ветер «путевая по ГНСС − воздушная по курсу» против того же
   * ветра, сглаженного за 3 мин. В ровном полёте — около нуля, в болтанку — 1–2 м/с, при
   * подмене растёт со скоростью увода: по нему (и по «ветру», которого нет) её и замечают.
   */
  navMismatchMs: number;
}

const emptyEw = (): EwState => ({
  gnssJam: 0,
  gnssSpoof: 0,
  linkJam: 0,
  noflyIds: [],
  noflyNear: null,
  gnss: 'ok',
  spoofed: false,
  spoofOffsetM: 0,
  navMismatchMs: 0,
});

/** Событие среды: вход, выход, зона появилась вокруг борта. */
function zoneEvent(z: Zone, what: 'in' | 'out' | 'new'): string {
  if (z.kind === 'nofly') {
    const name = z.name?.trim();
    const verb = what === 'in' ? 'вход' : what === 'out' ? 'выход' : 'борт внутри новой зоны';
    return `ЗАПРЕТНАЯ ЗОНА: ${verb}${name ? `${what === 'in' ? ' в' : what === 'out' ? ' из' : ''} «${name}»` : ''}`;
  }
  const verb = what === 'in' ? 'вход в зону' : what === 'out' ? 'выход из зоны' : 'борт внутри новой зоны';
  return `РЭБ: ${verb} ${zoneKindPhrase(z)}`;
}

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
 * pusherStart — запуск остановленного маршевого в полёте; armAir — аварийный АРМ в воздухе
 * после остановки моторов (роторы и маршевый).
 */
export type Command =
  | 'arm'
  | 'disarm'
  | 'takeoff'
  | 'auto'
  | 'manual'
  | 'guided'
  | 'hold'
  | 'rtl'
  | 'land'
  | 'failsafe'
  | 'copter'
  | 'pusherStart'
  | 'armAir';

/** Маршевый: работает; остановлен («квадрокоптер», моторы остановлены в воздухе, не запустился); раскручивается. */
export type PusherState = 'run' | 'off' | 'starting';
/** Самолётные режимы автопилота. */
type PlaneMode = 'auto' | 'guided' | 'hold' | 'manual' | 'rtl';
/** Куда вернуться после запуска моторов в воздухе. */
type Resume = PlaneMode | 'failsafe' | 'land';

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
  /**
   * Крен корпуса, °: + вправо. В самолёте — крен, по которому идёт разворот (g·tg(крен)/V); на роторах —
   * наклон коптера вбок (боковое ускорение, боковой ветер).
   */
  bankDeg: number;
  /**
   * Тангаж корпуса, °: + нос вверх. На крыле — угол пути относительно воздуха плюс балансировочный угол
   * атаки; на роторах — наклон коптера (разгон, торможение, ветер); на переходах — по доле веса на крыле.
   * Сглажен инерцией корпуса — для 3D, авиагоризонта и записи.
   */
  pitchDeg: number;
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
  /** Радиолиния (radio.ts): запас, сила сигнала, потери, частота телеметрии, через что, почему плохо. */
  link: LinkState;
  /** Сила сигнала 0…1 для индикатора и голоса; 0 — связи нет (и по отказу). */
  linkQuality: number;
  /** Место по навигации автопилота — его и показывает НСУ; без ГНСС уходит от истинного. */
  estimate: { east: number; north: number };
  /** Показания ПВД, м/с: с порывами и при отказе ПВД — не то, что на самом деле. */
  iasReadingMs: number;
  /** Сила порыва сейчас, м/с — для смаза камеры и индикации. */
  gustMs: number;
  /** В «Фэйлсейфе»: самолётом или коптером ведёт пилот; вне его — null. */
  failsafePhase: 'plane' | 'copter' | null;
  /** Маршевый двигатель: работает, остановлен или раскручивается («ЗАПУСК МАРШЕВОГО», «АРМ В ВОЗДУХЕ», переход из коптера). */
  pusherState: PusherState;
  /** Помехи и запретные зоны (zones.ts): для тревог на НСУ и окна инструктора. */
  ew: EwState;
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
  /**
   * Ветер у рельефа (terrainWind.ts) для этой погоды, от того же начала координат (origin): местный
   * ветер, нисходящие и восходящие потоки, роторы за грядами, термики. Без него — ветер погоды.
   */
  terrainWind?: TerrainWind;
  /** Запретные зоны и зоны РЭБ; менять в полёте — setZones(). */
  zones?: readonly Zone[];
  /** Площадка НСУ (антенна — RADIO.groundAntennaM над ней); по умолчанию — origin. */
  gcs?: Site;
  /** Ретрансляторы; менять в полёте — setRelays(). */
  relays?: readonly Relay[];
  /** Параметры радиолинии вместо RADIO (для тестов). */
  radio?: Partial<RadioParams>;
  /** Реакция на потерю связи с НСУ; по умолчанию — ВОЗВРАТ через LINK_TIMEOUT_S. */
  linkLoss?: { action: LinkLossAction; timeoutS: number };
}

export class LiveFlight {
  state: LiveState;
  path: PathPoint[];
  /** Площадка посадки этого полёта (конец задания в МАРШРУТЕ). */
  /** Точка посадки; новый план (пункт Б перенесли в полёте) её меняет. */
  landing: PathPoint;
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
  private afterTransition: PlaneMode = 'auto';
  private landAt: { east: number; north: number } | null = null;
  /** Почему моторы остановились в воздухе — для сообщения об ударе. */
  private fallCause = '';
  /** Курс для висения над точкой посадки — против ветра. */
  private hoverHeadingDeg = 0;
  /** Посадочный маршрут для ВОЗВРАТА: две точки захода и этап. */
  private rtlApproach: PathPoint[] = [];
  private rtlStage = 0;
  /** ВОЗВРАТ: высота, нужная в каждой точке захода до дома; наклон набора; набор по кругу над местом. */
  private rtlRest: number[] = [];
  private rtlGrad = 0.1;
  private rtlClimb: { east: number; north: number } | null = null;
  private rtlNeedCache = { t: -Infinity, stage: -1, up: 0 };
  private finalLeg: number | undefined;

  private readonly rand: () => number;
  private readonly turb: Turbulence | null;
  /** Поле ветра у рельефа и ветер у борта на этом шаге (null — ветер погоды). */
  private readonly tw: TerrainWind | null;
  private lw: LocalWind | null = null;
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
  /** Порыв через отклик аппарата: боковой (для крена) и вертикальный (для Vz); медленная часть вертикального — её парирует автопилот. */
  private gustSide = 0;
  private gustHeave = 0;
  private heaveLp = 0;
  /** На роторах: скорость, которую держит автопилот (в своих осях навигации), и её ускорение на шаге; на роторах ли были шагом раньше. */
  private hoverVel = { e: 0, n: 0 };
  private hoverAcc = { e: 0, n: 0 };
  private hoverOn = false;
  private hoverWas = false;
  /** Кинематика самолёта (fly): была ли на прошлом шаге; остаток путевой скорости из прошлого режима, м/с. */
  private flyOn = false;
  private flyWas = false;
  private carry = { e: 0, n: 0 };
  /** Скорость крена в самолёте, °/с. */
  private rollRate = 0;
  /** Vz в состоянии — относительно воздуха (самолёт, падение) или земли (роторы держат по баро и ГНСС). */
  private vzIsAir = false;
  /** Угловая скорость рыскания, °/с: на висении — своя, вне висения — измеренная (с неё и начинается разворот). */
  private yawRate = 0;
  private yawOn = false;
  /** Замедление, которое дают роторы на торможении перед посадкой (сверх сопротивления), м/с². */
  private rotorBrake = 0;
  /** Доля веса на крыле в ручном коптере. */
  private copterWing = 0;
  /** Первые звенья сглаживания тангажа и крена коптера; CL на крейсерской приборной — от него угол атаки. */
  private pitchLag = 0;
  private rollLag = 0;
  private readonly clRef: number;

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

  /** Маршевый остановлен: в «квадрокоптере» (по РЛЭ), после остановки моторов в воздухе, после неудачного запуска. */
  private pusherOff = false;
  /** Запуск в полёте: сколько ещё раскручивается маршевый; роторы (0 — раскручены); выравнивание из кувырка, с. */
  private pusherSpin: number | null = null;
  private rotorSpin: number | null = null;
  private levelLeft: number | null = null;
  /** Моторы запускаются в падении: куда вернуться, с какой высоты начали; сказано ли, что одним маршевым не выйти. */
  private restart: { to: Resume; up: number; told: boolean } | null = null;
  /** В каком режиме остановились моторы — туда и вернуться после запуска в воздухе. */
  private stoppedFrom: Resume = 'auto';
  /** Выход из падения на роторах: высота, на которой подана команда запуска. */
  private catching: { up: number } | null = null;
  /** Переход: время разгона (идёт, пока маршевый тянет), с какой приборной; МАРШРУТ после него — с ближайшего участка. */
  private trT = 0;
  private trFromIas = 0;
  private resumeAuto = false;

  /** События среды для инструктора и разбора — по истинному месту: вход и выход из зон, подмена. */
  readonly envEvents: { t: number; text: string }[] = [];
  private zones: LocalZone[] = [];
  /** Зоны, в которых борт сейчас (запретные — только в воздухе), по id. */
  private inside = new Map<string, Zone>();
  /** Своя случайность у среды: полёт без зон идёт ровно так же, как без этой модели. */
  private readonly ewRand: () => number;
  private ewGnss: 'ok' | 'lost' | 'acquiring' = 'ok';
  private gnssLostT = 0;
  private acquireLeft = 0;
  private spoofHold = 0;
  private spoofT = 0;
  private spoofDir = { e: 0, n: 0 };
  /** Увод места подменой и его скорость, м и м/с. */
  private spoof = { e: 0, n: 0 };
  private spoofVel = { e: 0, n: 0 };
  /** Оценка места сходится к истинной после помех. */
  private converging = false;
  /** Радиолиния НСУ ↔ борт; кадр телеметрии, дошедший последним при больших потерях, и фаза приёма. */
  private readonly radio: RadioLink;
  private rxFrame: LiveState | null = null;
  private rxPhase = 0;
  private linkLostT = 0;
  private windRef: { e: number; n: number } | null = null;
  private mismatch = 0;

  constructor(setup: FlightSetup) {
    const { plan } = setup;
    this.site = setup.origin ?? plan.takeoff;
    if (setup.linkLoss) this.linkLoss = { ...setup.linkLoss };
    this.homeSite = setup.home ?? plan.landing;
    this.terrain = setup.terrain;
    this.weather = setup.weather;
    this.mass = takeoffMassKg(plan.payload?.massKg ?? 0);
    this.clRef = (this.mass * G) / (0.5 * RHO0 * AIRCRAFT.cruiseIasMs ** 2 * AIRCRAFT.wingAreaM2);
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
    this.ewRand = rng(seed ^ 0x2f6b1d3);
    this.tw = setup.terrainWind?.active ? setup.terrainWind : null;
    const o = this.tw?.relief.origin;
    if (o && (Math.abs(o.lat - this.site.lat) > 1e-9 || Math.abs(o.lon - this.site.lon) > 1e-9)) throw new Error('Поле ветра рельефа построено от другого начала координат');
    // С полем рельефа пульсации есть и без турбулентности в погоде — роторы за грядами.
    this.turb =
      (setup.weather.turbulenceMs ?? 0) > 0 || this.tw ? new Turbulence(seed, setup.weather, setup.terrain, this.site, setup.sun, this.tw ?? undefined) : null;
    const gcs = setup.gcs ?? this.site;
    const mast = setup.radio?.groundAntennaM ?? RADIO.groundAntennaM;
    this.radio = new RadioLink(setup.terrain, { lat: gcs.lat, lon: gcs.lon, altitudeM: gcs.elevationM + mast }, setup.relays ?? [], setup.radio);
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
      pitchDeg: 0,
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
      link: this.radio.state,
      linkQuality: 1,
      estimate: { east: takeoff.east, north: takeoff.north },
      iasReadingMs: 0,
      gustMs: 0,
      failsafePhase: null,
      pusherState: 'off',
      ew: emptyEw(),
    };
    if (setup.zones) this.setZones(setup.zones, true);
    this.linkTick(0, this.state.ew.linkJam);
  }

  private local(p: { lat: number; lon: number }, up: number, routeLeg?: number): PathPoint {
    return { ...toLocal(this.site, p), up, ...(routeLeg === undefined ? {} : { routeLeg }) };
  }

  private buildPath(plan: MissionPlan): PathPoint[] {
    // Номер последнего участка — посадочная прямая к точке посадки.
    this.finalLeg = plan.waypoints[plan.waypoints.length - 1]?.routeLeg;
    const takeoff = this.local(plan.takeoff, plan.takeoff.elevationM - this.site.elevationM);
    const landing = this.local(plan.landing, plan.landing.elevationM - this.site.elevationM);
    // Высоты перехода — по плану: у крутого рельефа вертикальный набор и снижение длиннее.
    return [
      { ...takeoff, up: transitionAltitudeM(plan) - this.site.elevationM },
      ...plan.waypoints.map((w) => this.local(w, w.altitudeM - this.site.elevationM, w.routeLeg)),
      { ...landing, up: backTransitionAltitudeM(plan) - this.site.elevationM },
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
    this.landing = this.local(plan.landing, plan.landing.elevationM - this.site.elevationM);
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
    const s = this.state;
    // При больших потерях — последний дошедший кадр; качество связи НСУ знает сама — оно текущее.
    const frame = s.linkLost && this.frozen ? this.frozen : this.rxFrame;
    return frame ? { ...frame, linkLost: s.linkLost, link: s.link, linkQuality: s.linkQuality } : this.snapshot();
  }

  /** Борт в зоне действия ПДУ: пилот стоит у площадки взлёта, посадки или дома. */
  rcInRange(): boolean {
    const s = this.state;
    const d = Math.min(...[this.takeoffPt, this.landing, this.home].map((p) => Math.hypot(s.east - p.east, s.north - p.north)));
    // Пульт — своя линия малой дальности: помеха у борта сокращает её, как и линию НСУ.
    const jamDb = linkJamDb(s.ew.linkJam);
    if (jamDb > 0 && d > Math.min(this.rcRangeM, RC_RANGE_M) * 10 ** (-jamDb / 20)) return false;
    return d <= this.rcRangeM;
  }

  /** Ретрансляторы: поставить или убрать, в полёте тоже — линия пересчитается на следующем шаге. */
  setRelays(relays: readonly Relay[]): void {
    this.radio.setRelays(relays);
  }

  get relays(): readonly Relay[] {
    return this.radio.relays;
  }

  /** Антенна НСУ. */
  get gcsAntenna(): Station {
    return this.radio.gcs;
  }

  /** НСУ, ретрансляторы и помеха у НСУ — для графика связи и радиотени теми же звеньями. */
  get radioNetwork(): LinkNetwork {
    return this.radio.network;
  }

  private snapshot(): LiveState {
    const s = this.state;
    const tele: LiveState = {
      ...s,
      east: s.estimate.east,
      north: s.estimate.north,
      iasMs: s.iasReadingMs,
      wind: { ...s.wind },
      estimate: { ...s.estimate },
      failures: [...s.failures],
      ew: this.boardEw(),
    };
    const v = this.spoofVel;
    if (v.e !== 0 || v.n !== 0) {
      // Подмена: путевая по ГНСС — вместе с уводом; ветер у автопилота — путевая минус воздушная.
      // Курс (компас) и приборная (ПВД) — настоящие: снос и путевая с ними не сходятся.
      const ge = this.lastVel.e + v.e;
      const gn = this.lastVel.n + v.n;
      tele.groundSpeedMs = Math.hypot(ge, gn);
      if (tele.groundSpeedMs > 0.5) tele.trackDeg = norm360(Math.atan2(ge, gn) / RAD);
      tele.driftDeg = wrap180(s.headingDeg - tele.trackDeg);
      const w = windVec(s.wind);
      const we = w.e + v.e;
      const wn = w.n + v.n;
      tele.wind = { speedMs: Math.hypot(we, wn), fromDeg: norm360(Math.atan2(we, wn) / RAD + 180) };
    }
    return tele;
  }

  /** Обстановка, какой её знает борт: без подмены, запретные зоны — по оценке места. */
  private boardEw(): EwState {
    const s = this.state;
    const near = this.noflyAround(s.estimate.east, s.estimate.north);
    return { ...s.ew, gnssSpoof: 0, spoofed: false, spoofOffsetM: 0, noflyIds: near.ids, noflyNear: near.near };
  }

  /** Запретные зоны в точке и ближайшая из тех, что ближе NOFLY_NEAR_M. */
  private noflyAround(e: number, n: number): { ids: string[]; near: EwState['noflyNear'] } {
    const s = this.state;
    const ids: string[] = [];
    let near: EwState['noflyNear'] = null;
    if (ON_GROUND.includes(s.mode)) return { ids, near };
    const alt = this.site.elevationM + s.up;
    for (const z of this.zones) {
      if (z.zone.kind !== 'nofly') continue;
      const d = localSignedDistance(z, e, n, alt);
      if (d <= 0) ids.push(z.zone.id);
      else if (d <= NOFLY_NEAR_M && (!near || d < near.distanceM)) near = { id: z.zone.id, distanceM: d };
    }
    return { ids, near: ids.length ? null : near };
  }

  /**
   * Команда оператора. Возвращает причину отказа или null — команда принята; ход и итог
   * (раскрутка, «Маршевый запущен», «не удался») — в events.
   */
  command(c: Command): string | null {
    const err = this.exec(c);
    this.syncMotors();
    return err;
  }

  private exec(c: Command): string | null {
    const s = this.state;
    // На земле АРМ, ДИЗАРМ и взлёт даёт расчёт на площадке с ПДУ — и без связи с НСУ.
    const padCommand = (s.mode === 'ground' || s.mode === 'landed') && (c === 'arm' || c === 'disarm' || c === 'takeoff');
    if (s.linkLost && !padCommand && !(RC_COMMANDS.includes(c) && this.rcInRange())) return 'Нет связи с НСУ — команда не доставлена';
    const fs = s.mode === 'failsafe';
    const airborne = AIRBORNE.includes(s.mode) || (fs && s.failsafePhase === 'plane');
    switch (c) {
      case 'arm':
        if (s.mode !== 'ground') return 'АРМ — только на земле перед взлётом';
        if (s.armed) return 'Уже заармлен';
        if (this.dead()) return 'Борт не отвечает — АРМ невозможен';
        s.armed = true;
        this.pusherOff = false;
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
        if (fs) return this.leaveFailsafe(c);
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
        if (fs) return this.leaveFailsafe('rtl');
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
      case 'pusherStart':
        return this.pusherStartCmd();
      case 'armAir':
        return this.armAirCmd();
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
        this.updateLink();
        break;
      case 'gnss':
        // Автопилот продолжает по ПВД и ветру, измеренному до отказа (автономная навигация).
        this.updateGnss(this.rand);
        break;
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

  /**
   * Связь или ГНСС вернулись. Остальные отказы в полёте не проходят — возвращает false. Отказ
   * снимается и в зоне помех, но связь или решение ГНСС вернутся только после выхода из неё.
   */
  restore(id: 'link' | 'gnss'): boolean {
    const s = this.state;
    if (!this.failed.delete(id)) return false;
    s.failures = s.failures.filter((x) => x !== id);
    if (id === 'link') this.updateLink();
    else {
      this.updateGnss();
      if (this.windEst) this.events.push({ t: s.t, text: 'Приёмник ГНСС исправен, но решения нет — помехи' });
      else {
        this.navErr = { e: 0, n: 0 };
        this.converging = false;
        s.estimate.east = s.east;
        s.estimate.north = s.north;
        this.events.push({ t: s.t, text: 'Сигнал ГНСС восстановлен' });
      }
    }
    return true;
  }

  /**
   * Зоны на лету (инструктор рисует их и в полёте). Зона, появившаяся вокруг борта, входом не
   * считается — в событиях среды «борт внутри новой зоны». quiet — без событий (начало полёта).
   */
  setZones(zones: readonly Zone[], quiet = false) {
    const s = this.state;
    this.zones = prepareZones(zones, this.site);
    const fx = this.sampleZones();
    const now = this.insideMap(fx);
    if (!quiet) for (const [id, z] of now) if (!this.inside.has(id)) this.envEvents.push({ t: s.t, text: zoneEvent(z, 'new') });
    this.inside = now;
    this.applyZones(fx);
    // Помеха у НСУ глушит приём телеметрии.
    const g = this.radio.gcs;
    const l = toLocal(this.site, g);
    this.radio.setGcsJamDb(this.zones.length ? linkJamDb(localEffects(this.zones, l.east, l.north, g.altitudeM).linkJam) : 0);
  }

  private sampleZones(): LocalEffects {
    const s = this.state;
    if (!this.zones.length) return { nofly: [], gnssJam: 0, gnssSpoof: 0, linkJam: 0, inside: [] };
    return localEffects(this.zones, s.east, s.north, this.site.elevationM + s.up);
  }

  /** Зоны вокруг борта по id; запретные — только в воздухе. */
  private insideMap(fx: LocalEffects): Map<string, Zone> {
    const ground = ON_GROUND.includes(this.state.mode);
    return new Map(fx.inside.filter((z) => !(ground && z.kind === 'nofly')).map((z) => [z.id, z]));
  }

  private applyZones(fx: LocalEffects) {
    const s = this.state;
    const ew = s.ew;
    ew.gnssJam = fx.gnssJam;
    ew.gnssSpoof = fx.gnssSpoof;
    ew.linkJam = fx.linkJam;
    const nf = this.noflyAround(s.east, s.north);
    ew.noflyIds = nf.ids;
    ew.noflyNear = nf.near;
  }

  /** Зоны на шаге: сила помех, вход и выход, ГНСС, подмена, связь, контроль навигации. */
  private environment(h: number) {
    const s = this.state;
    const fx = this.sampleZones();
    const now = this.insideMap(fx);
    for (const [id, z] of now) if (!this.inside.has(id)) this.envEvents.push({ t: s.t, text: zoneEvent(z, 'in') });
    for (const [id, z] of this.inside) if (!now.has(id)) this.envEvents.push({ t: s.t, text: zoneEvent(z, 'out') });
    this.inside = now;
    this.applyZones(fx);
    this.gnssTick(h, fx.gnssJam);
    this.spoofTick(h, fx.gnssSpoof);
    this.linkTick(h, fx.linkJam);
    this.navCheck(h);
  }

  /** Подавление ГНСС: решение пропадает; после выхода — повторный захват с задержкой. */
  private gnssTick(h: number, jam: number) {
    const s = this.state;
    const was = this.ewGnss;
    if (this.ewGnss === 'ok') {
      if (jam >= EW_EFFECT_THRESHOLD) {
        this.ewGnss = 'lost';
        this.gnssLostT = s.t;
        this.events.push({ t: s.t, text: 'ГНСС: нет решения — сильные помехи, место по счислению' });
      }
    } else if (jam >= EW_EFFECT_THRESHOLD) this.ewGnss = 'lost';
    else if (this.ewGnss === 'lost') {
      if (jam < EW_RELEASE_THRESHOLD) {
        this.ewGnss = 'acquiring';
        const outage = Math.min(1, (s.t - this.gnssLostT) / GNSS_REACQ_LONG_OUTAGE_S);
        this.acquireLeft = GNSS_REACQ_MIN_S + GNSS_REACQ_LONG_S * outage + GNSS_REACQ_JITTER_S * this.ewRand();
      }
    } else if ((this.acquireLeft -= h) <= 0) {
      this.ewGnss = 'ok';
      if (!this.failed.has('gnss')) this.events.push({ t: s.t, text: `ГНСС: повторный захват — место снова по ГНСС (перерыв ${Math.round(s.t - this.gnssLostT)} с)` });
    }
    if (this.ewGnss !== was) this.updateGnss(this.ewRand);
  }

  /**
   * Подмена ГНСС: ложный сигнал захватывает приёмник и медленно уводит место вбок от линии пути.
   * Автопилот летит по уведённому месту — на самом деле уходит с трассы в обратную сторону, а
   * на карте НСУ всё ровно. Ослаб ложный сигнал — срыв слежения, повторный захват настоящего, и
   * оценка сходится к истинному месту (не мгновенно).
   */
  private spoofTick(h: number, k: number) {
    const s = this.state;
    const ew = s.ew;
    if (!ew.spoofed) {
      this.spoofHold = !this.windEst && k >= EW_EFFECT_THRESHOLD ? this.spoofHold + h : 0;
      if (this.spoofHold < SPOOF_CAPTURE_S) return;
      ew.spoofed = true;
      this.spoofT = 0;
      const side = this.ewRand() < 0.5 ? -1 : 1;
      const a = (s.trackDeg + side * (60 + 60 * this.ewRand())) * RAD;
      this.spoofDir = { e: Math.sin(a), n: Math.cos(a) };
      this.envEvents.push({ t: s.t, text: 'РЭБ: подмена ГНСС — приёмник захвачен ложным сигналом, место уводится' });
      return;
    }
    if (k < EW_RELEASE_THRESHOLD) {
      this.envEvents.push({ t: s.t, text: `РЭБ: подмена ГНСС прекратилась — место было уведено на ${Math.round(Math.hypot(this.spoof.e, this.spoof.n))} м` });
      this.events.push({ t: s.t, text: 'ГНСС: срыв слежения — нет решения, повторный захват' });
      this.ewGnss = 'acquiring';
      this.gnssLostT = s.t;
      this.acquireLeft = GNSS_REACQ_MIN_S + GNSS_REACQ_JITTER_S * this.ewRand();
      this.updateGnss(this.ewRand);
      return;
    }
    this.spoofT += h;
    const v = Math.min(SPOOF_MAX_MS, SPOOF_ACCEL * this.spoofT);
    this.spoofVel = { e: this.spoofDir.e * v, n: this.spoofDir.n * v };
    this.spoof.e += this.spoofVel.e * h;
    this.spoof.n += this.spoofVel.n * h;
    ew.spoofOffsetM = Math.hypot(this.spoof.e, this.spoof.n);
  }

  /** Увод подмены переходит в ошибку счисления: автопилот продолжает с того места, где себя считал. */
  private releaseSpoof() {
    const ew = this.state.ew;
    this.navErr.e += this.spoof.e;
    this.navErr.n += this.spoof.n;
    this.spoof = { e: 0, n: 0 };
    this.spoofVel = { e: 0, n: 0 };
    this.spoofHold = 0;
    ew.spoofed = false;
    ew.spoofOffsetM = 0;
  }

  /** ГНСС нет — по отказу или из-за помех: автопилот на счислении; вернулся — снова по ГНСС. */
  private updateGnss(r: () => number = this.rand) {
    const s = this.state;
    const out = this.failed.has('gnss') || this.ewGnss !== 'ok';
    s.ew.gnss = this.failed.has('gnss') ? 'lost' : this.ewGnss;
    if (out && !this.windEst) {
      this.releaseSpoof();
      const w = windVec(this.windNow());
      const a = 2 * Math.PI * r();
      const err = WIND_EST_ERR_MS * (0.5 + r());
      this.windEst = { e: w.e + err * Math.sin(a), n: w.n + err * Math.cos(a) };
    } else if (!out && this.windEst) {
      this.windEst = null;
      this.converging = true;
    }
  }

  /**
   * Радиолиния НСУ ↔ борт (radio.ts): рельеф, дальность, ретрансляторы, помеха у борта (сила k
   * 0…1 → linkJamDb). Рельеф считается раз в 0,25 с; связь теряется, если запас ниже порога
   * дольше 2 с, и возвращается с гистерезисом.
   */
  private linkTick(h: number, k: number) {
    const s = this.state;
    const p = fromLocal(this.site, s.east, s.north);
    this.radio.update(h, { ...p, altitudeM: this.site.elevationM + s.up + BOARD_ANTENNA_M }, linkJamDb(k));
    const link = this.radio.state;
    s.link = link;
    const why = link.cause === 'jam' ? 'помехи в радиоканале' : link.cause === 'terrain' ? 'рельеф закрывает НСУ' : 'борт за пределом дальности связи';
    this.updateLink(`Нет связи с НСУ: ${why}`);
    s.linkQuality = s.linkLost ? 0 : link.quality;
    // Потери больше половины — кадры телеметрии доходят заметно реже.
    if (s.linkLost || link.telemetryHz >= TELEMETRY_HZ / 2) {
      this.rxFrame = null;
      this.rxPhase = 0;
    } else if (!this.rxFrame || (this.rxPhase += h * link.telemetryHz) >= 1) {
      this.rxPhase %= 1;
      this.rxFrame = this.snapshot();
    }
  }

  /** Связи нет — по отказу или по радиолинии: телеметрия замирает, идёт отсчёт до ВОЗВРАТА. */
  private updateLink(lostText?: string) {
    const s = this.state;
    const lost = this.failed.has('link') || this.radio.monitor.lost;
    if (lost === s.linkLost) return;
    s.linkLost = lost;
    this.rxFrame = null;
    if (lost) {
      this.frozen = this.snapshot();
      this.linkLostT = s.t;
      if (lostText) this.events.push({ t: s.t, text: lostText });
    } else {
      this.frozen = null;
      this.events.push({ t: s.t, text: 'Связь с НСУ восстановлена' });
    }
  }

  /** Реакция на потерю связи (задаётся в задании) и потеря связи, на которую она уже сработала. */
  private linkLoss: { action: LinkLossAction; timeoutS: number } = { action: 'rtl', timeoutS: LINK_TIMEOUT_S };
  private linkActedAt = -1;

  /**
   * Без связи linkLoss.timeoutS — реакция по настройке, один раз на каждую потерю связи:
   * ВОЗВРАТ; продолжать задание (оно на борту; из ручных режимов — ВОЗВРАТ: задание прервано);
   * посадка на месте (в самолётном режиме — торможение по курсу, над точкой носом против ветра).
   */
  private linkTimeout() {
    const s = this.state;
    const { action, timeoutS } = this.linkLoss;
    if (s.t - this.linkLostT < timeoutS || this.linkActedAt === this.linkLostT) return;
    if (s.mode === 'transition') {
      // Переход не прерывается: после него — ВОЗВРАТ; продолжение и посадка — когда выйдем в самолётный режим.
      if (action === 'rtl') this.afterTransition = 'rtl';
      return;
    }
    const manualModes = ['guided', 'hold', 'manual'];
    if (s.mode !== 'auto' && !manualModes.includes(s.mode)) return;
    this.linkActedAt = this.linkLostT;
    if (action === 'rtl' || (action === 'continue' && manualModes.includes(s.mode))) {
      this.events.push({ t: s.t, text: `Нет связи ${timeoutS} с — ВОЗВРАТ` });
      this.startRtl();
    } else if (action === 'continue') {
      this.events.push({ t: s.t, text: `Нет связи ${timeoutS} с — продолжаю задание` });
    } else {
      this.events.push({ t: s.t, text: `Нет связи ${timeoutS} с — посадка на месте` });
      this.landAt = null;
      this.hoverHeadingDeg = s.wind.fromDeg;
      this.setMode('backtransition');
    }
  }

  /**
   * Контроль навигации, как у автопилота: ветер = путевая по ГНСС − воздушная по курсу. Медленно
   * сглаженный — «известный ветер»; быстрое расхождение с ним — признак подмены (или болтанки).
   */
  private navCheck(h: number) {
    const s = this.state;
    const plane = AIRBORNE.includes(s.mode) || (s.mode === 'failsafe' && s.failsafePhase === 'plane');
    if (!plane || this.windEst || s.tasMs < 5) {
      this.windRef = null;
      this.mismatch *= Math.exp(-h / MISMATCH_TAU_S);
    } else {
      const psi = s.headingDeg * RAD;
      const we = this.lastVel.e + this.spoofVel.e - s.tasMs * Math.sin(psi);
      const wn = this.lastVel.n + this.spoofVel.n - s.tasMs * Math.cos(psi);
      this.windRef ??= { e: we, n: wn };
      const a = 1 - Math.exp(-h / WIND_REF_TAU_S);
      this.windRef.e += (we - this.windRef.e) * a;
      this.windRef.n += (wn - this.windRef.n) * a;
      const r = Math.hypot(we - this.windRef.e, wn - this.windRef.n);
      this.mismatch += (r - this.mismatch) * (1 - Math.exp(-h / MISMATCH_TAU_S));
    }
    s.ew.navMismatchMs = this.mismatch;
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
        if (this.state.mode === 'landed') this.settle(dt / n);
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
    this.pusherSpin = null;
    this.rotorSpin = null;
    this.levelLeft = null;
    this.restart = null;
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

  /**
   * ВОЗВРАТ: посадочный маршрут к дому строится по фактическому ветру (как у автопилота; с полем
   * рельефа — по ветру, измеренному у борта). Сразу — высоты, нужные на пути над рельефом.
   */
  private startRtl() {
    const p = this.navPos();
    const wind10 = this.lw ? this.windNow() : windAt(this.weather, 10);
    const here = fromLocal(this.site, p.east, p.north);
    const proc = windProcedures(this.homeSite, this.homeSite, wind10, null, here);
    this.rtlApproach = proc.approach.map((q) => this.local(q, 0));
    this.rtlStage = 0;
    this.hoverHeadingDeg = proc.landingHeadingDeg;
    this.planRtlClearance();
    this.setMode('rtl');
  }

  /**
   * Высоты для ВОЗВРАТА над рельефом: в каждой точке захода — с какой высоты дальше до дома рельеф
   * проходится с запасом, если набирать не круче rtlGrad. Точки захода от места борта не зависят.
   */
  private planRtlClearance() {
    const s = this.state;
    const tas = Math.max(10, tasFromIas(Math.max(s.iasMs, AIRCRAFT.cruiseIasMs), this.rho(s.up)));
    // Путевая по ветру — наибольшая: чем быстрее над землёй, тем положе набор.
    this.rtlGrad = (RTL_CLIMB_SHARE * AIRCRAFT.planeClimbRateMaxMs) / (tas + windAt(this.weather, 300).speedMs);
    const pts = [...this.rtlApproach, this.home];
    this.rtlRest = pts.map(() => -Infinity);
    for (let k = pts.length - 2; k >= 0; k--) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      this.rtlRest[k] = Math.max(this.legNeed(a, b, k + 1 === pts.length - 1), this.rtlRest[k + 1]! - this.rtlGrad * Math.hypot(b.east - a.east, b.north - a.north));
    }
    this.rtlClimb = null;
    this.rtlNeedCache = { t: -Infinity, stage: -1, up: 0 };
  }

  /** Высота в a, с которой до b рельеф проходится с запасом при наборе не круче rtlGrad. На посадочной прямой запас — до высоты обратного перехода. */
  private legNeed(a: { east: number; north: number }, b: { east: number; north: number }, final: boolean): number {
    const len = Math.hypot(b.east - a.east, b.north - a.north);
    const n = Math.max(1, Math.ceil(len / RTL_STEP_M));
    const margin = final ? Math.max(AIRCRAFT.minClearanceM, VT.backTransitionHeightM - 5) : RTL_CLEARANCE_M;
    let need = -Infinity;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      need = Math.max(need, this.groundUp(a.east + (b.east - a.east) * f, a.north + (b.north - a.north) * f) + margin - this.rtlGrad * f * len);
    }
    return need;
  }

  /** Высота, нужная сейчас: пройти к текущей точке захода и дальше до дома над рельефом с запасом. */
  private rtlNeed(nav: { east: number; north: number }, pts: PathPoint[]): number {
    const c = this.rtlNeedCache;
    const t = this.state.t;
    if (c.stage === this.rtlStage && t - c.t < RTL_NEED_PERIOD_S) return c.up;
    const target = pts[this.rtlStage]!;
    const d = Math.hypot(target.east - nav.east, target.north - nav.north);
    const up = Math.max(this.legNeed(nav, target, this.rtlStage === pts.length - 1), this.rtlRest[this.rtlStage]! - this.rtlGrad * d);
    this.rtlNeedCache = { t, stage: this.rtlStage, up };
    return up;
  }

  /** Наибольшая высота рельефа с запасом margin на отрезке a → b (шаг 25 м). */
  private pathFloor(a: { east: number; north: number }, b: { east: number; north: number }, margin: number): number {
    const n = Math.max(1, Math.ceil(Math.hypot(b.east - a.east, b.north - a.north) / 25));
    let top = -Infinity;
    for (let i = 0; i <= n; i++) top = Math.max(top, this.groundUp(a.east + ((b.east - a.east) * i) / n, a.north + ((b.north - a.north) * i) / n));
    return top + margin;
  }

  /**
   * Задание: набор высоты по кругу над местом — центр круга и высота, до которой набирать. Высота
   * запоминается при входе: на дальней от склона стороне круга нужная высота «уменьшается», и без
   * этого аппарат выходил бы из круга раньше времени.
   */
  private autoClimb: { east: number; north: number; up: number } | null = null;
  private autoNeedCache = { t: -Infinity, up: -Infinity };

  /**
   * Задание: высота, нужная сейчас, чтобы дальше по маршруту (AUTO_LOOKAHEAD_M) пройти рельеф с
   * запасом minClearanceM, если набирать с той скоростью, что выходит на самом деле: предельная
   * Vz минус нисходящий поток у склона, на нынешней путевой. План считает набор без потоков.
   */
  private autoNeed(nav: { east: number; north: number }, credit = 1): number {
    const c = this.autoNeedCache;
    const s = this.state;
    if (credit === 1 && s.t - c.t < RTL_NEED_PERIOD_S) return c.up;
    const climb = Math.max(0.3, AIRCRAFT.planeClimbRateMaxMs + Math.min(0, this.upflowMs));
    const grad = (credit * climb) / Math.max(10, s.groundSpeedMs);
    let need = -Infinity;
    let dist = 0;
    let p = { east: nav.east, north: nav.north };
    for (let k = s.wp; k < this.path.length && dist < AUTO_LOOKAHEAD_M; k++) {
      const q = this.path[k]!;
      const len = Math.hypot(q.east - p.east, q.north - p.north);
      const n = Math.max(1, Math.ceil(len / 50));
      for (let i = 1; i <= n; i++) {
        const x = dist + (len * i) / n;
        if (x > AUTO_LOOKAHEAD_M) break;
        const f = i / n;
        need = Math.max(need, this.groundUp(p.east + (q.east - p.east) * f, p.north + (q.north - p.north) * f) + AIRCRAFT.minClearanceM - grad * x);
      }
      dist += len;
      p = q;
    }
    if (credit === 1) this.autoNeedCache = { t: s.t, up: need };
    return need;
  }

  /** Снижение по кругу над точкой посадки на маршевом — центр круга (точка посадки). */
  private descentOrbit: { east: number; north: number } | null = null;

  /**
   * Над точкой посадки выше высоты обратного перехода больше чем на DESCENT_ORBIT_SLACK_M (пришли
   * из-за хребта, после набора по кругу) — сначала снижение по кругу над ней на маршевом:
   * снижаться на роторах с сотен метров — минуты висения, это батарея. true — ещё снижаемся.
   */
  private descendFirst(p: { east: number; north: number }): boolean {
    const s = this.state;
    const floor = this.groundUp(p.east, p.north) + VT.backTransitionHeightM;
    if (this.descentOrbit) {
      if (s.up > floor + 10) return true;
      this.descentOrbit = null;
      this.events.push({ t: s.t, text: 'Снижение по кругу закончено — посадочная прямая' });
      return false;
    }
    if (s.up <= floor + DESCENT_ORBIT_SLACK_M) return false;
    this.descentOrbit = { east: p.east, north: p.north };
    this.events.push({ t: s.t, text: `Снижение по кругу над точкой посадки до ${Math.round(this.site.elevationM + floor)} м — высоко для обратного перехода` });
    return true;
  }

  /** Центр круга набора — под уклон от места: весь круг над рельефом не выше здешнего, а не в склон. */
  private downslopeCenter(nav: { east: number; north: number }, r: number): { east: number; north: number } {
    const ge = this.groundUp(nav.east + 100, nav.north) - this.groundUp(nav.east - 100, nav.north);
    const gn = this.groundUp(nav.east, nav.north + 100) - this.groundUp(nav.east, nav.north - 100);
    const gl = Math.hypot(ge, gn);
    return gl > 1 ? { east: nav.east - (ge / gl) * r, north: nav.north - (gn / gl) * r } : { east: nav.east, north: nav.north };
  }

  private setMode(m: LiveMode, text?: string) {
    // Набор по кругу — только в задании: ВОЗВРАТ и прочие режимы ведут высоту сами.
    if (m !== 'auto') this.autoClimb = null;
    // Снижение по кругу — до смены режима: обратный переход, ВОЗВРАТ и прочие начинают с чистого листа.
    this.descentOrbit = null;
    // Моторы встали в воздухе: запомнить, откуда, — туда и вернуться после запуска; маршевый стоит.
    if (m === 'falling' && this.state.mode !== 'falling') {
      this.stoppedFrom = this.resumeTarget();
      this.pusherOff = true;
    }
    if (m === 'transition') {
      this.trT = 0;
      this.trFromIas = 0;
      this.resumeAuto = false;
    }
    if (m !== 'failsafe') {
      this.state.failsafePhase = null;
      this.catching = null;
    }
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
    this.toFailsafe(plane ? 'plane' : 'copter', text);
    if (!plane) {
      s.iasMs = 0;
      s.pusher = 0;
      // «Квадрокоптер» по РЛЭ — маршевый выключен.
      this.pusherOff = true;
      this.pusherSpin = null;
    }
    return null;
  }

  /** Управление — пилоту с ПДУ, в стабилизированном самолёте или коптере. */
  private toFailsafe(phase: 'plane' | 'copter', text: string) {
    const s = this.state;
    const w = windVec(this.windNow());
    this.vAir = { e: this.lastVel.e - w.e, n: this.lastVel.n - w.n };
    this.iasHold = s.iasMs;
    this.rcLostS = 0;
    this.landAt = null;
    this.setMode('failsafe', text);
    s.failsafePhase = phase;
  }

  /** «Квадрокоптер» из ручного самолёта: маршевый выключен, роторы гасят скорость, крыло пока держит. */
  private toCopter() {
    const s = this.state;
    const psi = s.headingDeg * RAD;
    this.vAir = { e: s.tasMs * Math.sin(psi), n: s.tasMs * Math.cos(psi) };
    s.failsafePhase = 'copter';
    s.pusher = 0;
    this.pusherOff = true;
    this.pusherSpin = null;
    this.events.push({ t: s.t, text: '«Квадрокоптер»: маршевый выключен, роторы на висение' });
  }

  /**
   * Из «Фэйлсейфа» автопилоту, в самолётный режим. Из коптера — переходом: маршевый раскручивается
   * (в «квадрокоптере» он выключен), роторы держат высоту, затем разгон до скорости перехода. Из
   * самолёта — сразу; если скорость ниже начала перехода — тоже переходом: роторы помогают крылу,
   * пока маршевый разгоняет. Без маршевого самолётом нельзя. МАРШРУТ — с ближайшего непройденного участка.
   */
  private leaveFailsafe(c: PlaneMode): string | null {
    const s = this.state;
    const copter = s.failsafePhase === 'copter';
    if (this.failed.has('pusher'))
      return copter ? 'Маршевый не работает: из коптера — только посадка' : 'Маршевый не работает: самолётом высоту не удержать — посадка коптером или на брюхо с ПДУ';
    if (copter) {
      if (s.aglM < TRANSITION_MIN_AGL_M) return `Разгон — не ниже ${TRANSITION_MIN_AGL_M} м над землёй`;
      return this.startTransition(c);
    }
    // Скорость автопилот знает только по ПВД.
    if (s.iasReadingMs < AIRCRAFT.transitionLowIasMs) {
      if (this.failed.has('vtol')) return `Скорость мала, подъёмные роторы не работают — разгонитесь с ПДУ до ${Math.round(AIRCRAFT.transitionLowIasMs)} м/с`;
      return this.startTransition(c);
    }
    this.enterPlane(c);
    return null;
  }

  /** Переход в самолётный режим в полёте: разгон с той воздушной скорости, что есть вдоль курса. */
  private startTransition(c: PlaneMode): null {
    const s = this.state;
    const psi = s.headingDeg * RAD;
    const fromIas =
      s.failsafePhase === 'copter' ? Math.max(0, this.vAir.e * Math.sin(psi) + this.vAir.n * Math.cos(psi)) * Math.sqrt(this.rho(s.up) / RHO0) : s.iasMs;
    if (this.pusherOff && this.pusherSpin === null) this.startPusher();
    this.afterTransition = c;
    this.setMode('transition', 'ПЕРЕХОД в самолётный режим: разгон на маршевом');
    this.trFromIas = fromIas;
    this.resumeAuto = true;
    return null;
  }

  /** В самолётный режим автопилота из ручного управления: ВОЗВРАТ — с посадочным маршрутом, МАРШРУТ — с ближайшего участка. */
  private enterPlane(c: PlaneMode) {
    if (c === 'rtl') return this.startRtl();
    if (c === 'auto') {
      this.resumeRoute();
      return this.setMode('auto', 'МАРШРУТ — продолжаю с ближайшего участка');
    }
    this.setMode(c);
  }

  /**
   * МАРШРУТ после «Фэйлсейфа» или запуска моторов в воздухе: к той точке, к которой шли, а точки,
   * пройденные за это время (впереди по своему участку их уже нет), пропускаем — как в replacePlan().
   */
  private resumeRoute() {
    const s = this.state;
    const p = this.navPos();
    const last = this.path.length - 1;
    const ahead = (i: number) => {
      const a = this.path[i]!;
      const q = this.path[i - 1]!;
      return (a.east - q.east) * (a.east - p.east) + (a.north - q.north) * (a.north - p.north) > 0;
    };
    let wp = clamp(s.wp, 1, last);
    while (wp < last && !ahead(wp)) wp++;
    s.wp = wp;
  }

  /** Куда вернуться после запуска моторов в воздухе — по режиму, в котором они остановились. */
  private resumeTarget(): Resume {
    const s = this.state;
    if (AIRBORNE.includes(s.mode)) return s.mode as PlaneMode;
    if (s.mode === 'transition') return this.afterTransition;
    if (s.mode === 'failsafe') return 'failsafe';
    return 'land';
  }

  /** Тянет ли маршевый: винт на месте, мотор работает и раскручен. */
  private pusherThrust(): boolean {
    return !this.failed.has('pusher') && !this.pusherOff && this.pusherSpin === null;
  }

  private startPusher(quiet = false) {
    this.pusherSpin = PUSHER_START_S;
    if (!quiet) this.events.push({ t: this.state.t, text: `ЗАПУСК МАРШЕВОГО: раскрутка ${PUSHER_START_S} с` });
  }

  private syncMotors() {
    const s = this.state;
    s.pusherState = this.pusherSpin !== null ? 'starting' : !s.armed || this.pusherOff ? 'off' : 'run';
  }

  /**
   * ЗАПУСК МАРШЕВОГО. Остановлен он в «квадрокоптере» (по РЛЭ), после остановки моторов в воздухе
   * и после неудачного запуска. Исправный раскручивается за PUSHER_START_S и тянет. При отказе
   * «pusher» (по РЛЭ — отрыв винта) мотор крутится, а тяги нет: запуск не удаётся, и повторный
   * не поможет — винта нет, поэтому восстановления «с вероятностью» здесь нет. После ДИЗАРМ
   * в полёте — АРМ и только маршевый: из планирования выйти можно, из кувырка — нет («АРМ В ВОЗДУХЕ»).
   */
  private pusherStartCmd(): string | null {
    const s = this.state;
    const falling = s.mode === 'falling';
    if (!falling && s.mode !== 'failsafe' && !AIRBORNE.includes(s.mode)) return 'Запуск маршевого — в самолётном режиме, в «Фэйлсейфе» или при остановленных моторах';
    if (this.dead()) return 'Аппарат неуправляем — запуск невозможен';
    if (s.energyWh >= this.capacityWh) return 'Батарея разряжена — запуск невозможен';
    if (this.pusherSpin !== null) return 'Маршевый уже раскручивается';
    if (!this.pusherOff && !this.failed.has('pusher')) return 'Маршевый работает';
    if (falling) {
      if (!s.armed) this.events.push({ t: s.t, text: 'ЗАПУСК МАРШЕВОГО в воздухе: АРМ, роторы не запускаются' });
      s.armed = true;
      this.beginRestart();
    }
    this.startPusher();
    return null;
  }

  /**
   * АРМ В ВОЗДУХЕ — аварийный запуск моторов, остановленных в полёте (ДИЗАРМ, одного маршевого не
   * хватило). Роторы раскручиваются за AIR_START_ROTORS_S, маршевый — за PUSHER_START_S; всё это
   * время аппарат падает. Дальше restartTick(): планирует — самолётом, кувыркается — на роторах.
   */
  private armAirCmd(): string | null {
    const s = this.state;
    if (s.mode === 'ground' || s.mode === 'landed') return 'На земле — обычный АРМ';
    if (s.mode === 'crashed') return 'Авария — АРМ невозможен';
    if (s.mode !== 'falling') return 'Моторы работают — АРМ в воздухе не нужен';
    if (this.dead()) return 'Аппарат неуправляем — АРМ невозможен';
    if (s.energyWh >= this.capacityWh) return 'Батарея разряжена — моторы не запустить';
    if (this.failed.has('vtol')) return 'Отказ СВВП: подъёмные роторы не запустить — только «ЗАПУСК МАРШЕВОГО»';
    if (this.rotorSpin !== null) return 'Моторы уже запускаются';
    s.armed = true;
    this.beginRestart();
    this.rotorSpin = AIR_START_ROTORS_S;
    const what = this.failed.has('pusher') ? 'маршевый неисправен — только роторы' : 'роторы и маршевый';
    this.events.push({ t: s.t, text: `АРМ В ВОЗДУХЕ: аварийный запуск моторов — ${what}, раскрутка` });
    if (!this.failed.has('pusher') && this.pusherOff && this.pusherSpin === null) this.startPusher(true);
    return null;
  }

  private beginRestart() {
    this.restart ??= { to: this.stoppedFrom, up: this.state.up, told: false };
    this.levelLeft = null;
  }

  /** Раскрутка моторов, запущенных в полёте; выход из падения. */
  private motorsTick(h: number, rho: number) {
    const s = this.state;
    if (this.pusherSpin !== null) {
      this.pusherSpin -= h;
      s.pusher = Math.max(s.pusher, PUSHER_IDLE * clamp(1 - this.pusherSpin / PUSHER_START_S, 0, 1));
      if (this.pusherSpin <= 0) {
        this.pusherSpin = null;
        // Без винта мотор раскручивается, но тяги нет: автопилот видит это по оборотам и току и выключает его.
        this.pusherOff = this.failed.has('pusher');
        this.events.push({ t: s.t, text: this.pusherOff ? 'Запуск маршевого не удался: тяги нет — винт силовой установки оторван' : 'Маршевый запущен' });
      }
    }
    if (this.rotorSpin !== null && this.rotorSpin > 0) this.rotorSpin = Math.max(0, this.rotorSpin - h);
    if (this.restart) {
      if (s.mode === 'falling') this.restartTick(h, rho);
      else this.restart = null;
    }
    if (this.catching && s.vzMs > -0.5) {
      this.events.push({ t: s.t, text: `Падение остановлено: высота потеряна ${Math.max(0, Math.round(this.catching.up - s.up))} м с команды запуска` });
      this.catching = null;
    }
  }

  /**
   * Моторы запускаются в падении. Крыло держит и маршевый тянет — снова самолёт. Иначе — на роторах,
   * как только раскрутятся (из кувырка — ещё и после выравнивания): стабилизированный коптер гасит
   * падение тягой сверх веса и сопротивлением плашмя — как в manualCopter(), без поблажек.
   */
  private restartTick(h: number, rho: number) {
    const s = this.state;
    const r = this.restart!;
    const rotors = this.rotorSpin;
    if (rotors !== null) s.lift = ARMED_IDLE_LIFT * (1 - rotors / AIR_START_ROTORS_S);
    const flying = s.tasMs > this.stallTas(rho) && !this.noGlide;
    const pusherReady = this.pusherSpin === null && !this.pusherOff;
    if (flying && pusherReady) return this.recoverPlane(r);
    if (rotors === null) {
      if (pusherReady && !r.told) {
        r.told = true;
        this.events.push({ t: s.t, text: 'Маршевый работает, но крыло не держит — из кувырка одним маршевым не выйти: «АРМ В ВОЗДУХЕ»' });
      }
      return;
    }
    if (rotors > 0) return;
    // Крыло держит, маршевый ещё раскручивается — планируем дальше.
    if (flying && this.pusherSpin !== null) return;
    if (!flying) {
      this.levelLeft ??= TUMBLE_LEVEL_S;
      this.levelLeft -= h;
      if (this.levelLeft > 0) return;
    }
    this.catchOnRotors(r);
  }

  /** Запуск в воздухе удался, крыло держит — самолётом, в тот режим, в каком остановились моторы. */
  private recoverPlane(r: { to: Resume; up: number }) {
    const s = this.state;
    this.restart = null;
    this.rotorSpin = null;
    this.levelLeft = null;
    s.lift = 0;
    this.events.push({ t: s.t, text: `Запуск в воздухе: крыло держит, маршевый тянет — самолётный режим; высота потеряна ${Math.max(0, Math.round(r.up - s.up))} м` });
    if (r.to === 'failsafe') return this.toFailsafe('plane', 'ФЭЙЛСЕЙФ: самолётом, управление с ПДУ');
    if (r.to === 'land') {
      if (this.failed.has('vtol')) return this.startRtl();
      // Моторы встали на взлёте или посадке — садимся на месте, как по команде ПОСАДКА.
      this.landAt = null;
      this.hoverHeadingDeg = s.wind.fromDeg;
      return this.setMode('backtransition');
    }
    this.enterPlane(r.to);
  }

  /** Роторы раскручены, аппарат выровнен — выход из падения стабилизированным коптером («Фэйлсейф»). */
  private catchOnRotors(r: { up: number }) {
    this.restart = null;
    this.rotorSpin = null;
    this.levelLeft = null;
    this.state.bankDeg = 0;
    this.toFailsafe('copter', 'АРМ В ВОЗДУХЕ: роторы запущены — выход из падения, «Фэйлсейф» коптером');
    this.catching = { up: r.up };
  }

  /** Ветер у борта: с полем рельефа — местный (посчитан в начале шага), без него — ветер погоды на высоте над землёй. */
  private windNow(): Wind {
    const lw = this.lw;
    if (!lw) return windAt(this.weather, Math.max(0, this.state.aglM));
    return { speedMs: Math.hypot(lw.eastMs, lw.northMs), fromDeg: norm360(Math.atan2(-lw.eastMs, -lw.northMs) / RAD) };
  }

  /** Вертикальный поток воздуха у борта (обтекание склонов, тень за грядой, термики), м/с: + вверх. */
  get upflowMs(): number {
    return this.lw?.upMs ?? 0;
  }

  /**
   * Vz относительно воздуха или земли — смотря кто держит высоту. При смене (набор → разгон, торможение →
   * снижение) пересчитываем через поток воздуха у борта: скорость над землёй не скачет на его величину.
   */
  private vzFrame(air: boolean) {
    if (this.vzIsAir === air) return;
    this.vzIsAir = air;
    this.state.vzMs += air ? -this.upflowMs : this.upflowMs;
  }

  /** Роторы держат вертикальную относительно земли: в нисходящем потоке тяги нужно больше, в восходящем — меньше. */
  private rotorUpflow(): number {
    const w = this.lw?.upMs ?? 0;
    return w === 0 ? 1 : clamp(1 - ((VT.climbFactor - 1) * w) / VT.climbRateMs, 0.85, 1.3);
  }

  private rho(up: number): number {
    const alt = this.site.elevationM + up;
    return airDensity({ altitudeM: alt, temperatureC: temperatureAt(alt, this.weather.groundTemperatureC, this.site.elevationM) });
  }

  private stallTas(rho: number): number {
    return STALL_SHARE * tasFromIas(AIRCRAFT.transitionLowIasMs, rho);
  }

  /** Где аппарат по мнению автопилота: с ГНСС — где есть (или куда увела подмена), без — счисление. */
  private navPos(): { east: number; north: number } {
    const s = this.state;
    const e = this.navErr.e + this.spoof.e;
    const n = this.navErr.n + this.spoof.n;
    return e === 0 && n === 0 ? s : { east: s.east + e, north: s.north + n };
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
    const psi0 = s.headingDeg;
    this.hoverWas = this.hoverOn;
    this.hoverOn = false;
    this.flyWas = this.flyOn;
    this.flyOn = false;
    this.yawOn = false;
    const ground = this.groundUp(s.east, s.north);
    s.aglM = s.up - ground;
    if (this.tw) this.lw = this.tw.localWind(s.east, s.north, s.aglM, s.t);
    this.sampleGust(h);
    if (this.failed.size > 0) this.failureTick(h);
    if (s.linkLost) this.linkTimeout();
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

      case 'climb': {
        // Висение носом на первую точку взлётного маршрута — против ветра: разворот к ней в наборе
        // (нос на площадке мог стоять иначе — например, против ветра по предполётной).
        power = VT.climbFactor * hover * this.rotorUpflow();
        s.lift = 1;
        if (this.path.length > 1) this.hoverYaw(h, bearing(this.path[0]!, this.path[1]!));
        this.hoverMove(h, this.takeoffPt);
        this.spin(h);
        // К высоте перехода — с торможением: встаём на ней без рывка, разгон — с неё.
        const top = this.path[0]!.up;
        s.vzMs = this.rotorVz(h, Math.min(VT.climbRateMs * Math.min(1, s.modeT / 1.5), Math.sqrt(2 * ROTOR_VZ_BRAKE * Math.max(0, top - s.up))));
        s.up += s.vzMs * h;
        if (s.up >= top - 0.01) {
          s.up = Math.min(s.up, top);
          this.setMode('transition');
        } else if (s.up <= this.groundUp(s.east, s.north) && s.modeT > 1) this.touchdown('отрыв винта подъёмного двигателя');
        break;
      }

      case 'transition': {
        power = VT.transitionFactor * hover;
        // Разгон — когда маршевый тянет; пока он раскручивается (из коптера), роторы держат высоту.
        const pushing = !this.pusherOff && this.pusherSpin === null;
        if (pushing) this.trT += h;
        const f = Math.min(1, this.trT / VT.transitionS);
        s.iasMs = this.trFromIas + (c.iasMs - this.trFromIas) * f;
        // Доля скорости перехода: столько веса уже на крыле, столько ветра уже сносит.
        const k = this.trFromIas === 0 ? f : c.iasMs > 0 ? clamp(s.iasMs / c.iasMs, 0, 1) : f;
        s.lift = 1 - k * k;
        if (pushing) s.pusher = 1;
        this.fly(h, s.headingDeg, s.up, rho, k);
        if (f >= 1) {
          const after = this.afterTransition;
          const resume = this.resumeAuto;
          this.resumeAuto = false;
          if (after === 'rtl') this.startRtl();
          else {
            if (after === 'auto' && resume) this.resumeRoute();
            this.setMode(after);
          }
        }
        break;
      }

      case 'ground':
        // Заармлен — роторы на холостых, моторы под питанием, пока не взлетели или не задизармили.
        s.lift = s.armed ? ARMED_IDLE_LIFT : 0;
        power = s.armed ? this.idlePowerW() : 0;
        break;

      case 'falling':
        // Моторы запускаются в воздухе — регуляторы и раскрутка берут немного.
        power = this.restart ? this.idlePowerW() : 0;
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
        power = (over ? VT.descentFactor : 1) * hover * this.rotorUpflow();
        s.vzMs = this.rotorVz(h, over ? -VT.descentRateMs : 0);
        s.up += s.vzMs * h;
        const g = this.groundUp(s.east, s.north);
        // Высоту над землёй автопилот знает по радиовысотомеру.
        if (s.up - g + this.radaltErrM <= VT.finalHeightM) this.setMode('final');
        if (s.up <= g) this.touchdown(this.failed.has('rotor') ? 'отрыв винта подъёмного двигателя' : 'отказ радиовысотомера');
        break;
      }

      case 'final': {
        power = hover * this.rotorUpflow();
        s.lift = 1;
        s.pusher = 0.1;
        this.hoverYaw(h);
        this.hoverMove(h, this.landAt ?? this.navPos());
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

    this.motorsTick(h, rho);
    power = this.applyDisturbance(h, power);
    if (this.failed.has('fire') && s.armed && s.mode !== 'falling') power += FIRE_DRAIN_W;
    s.powerW = s.mode === 'landed' ? 0 : power + this.payloadNow();
    s.energyWh += (s.powerW * h) / 3600;
    s.soc = (this.capacityWh - s.energyWh) / this.capacityWh;
    s.aglM = s.up - this.groundUp(s.east, s.north);
    this.lastVel = { e: (s.east - e0) / h, n: (s.north - n0) / h };
    this.environment(h);
    this.updateNavigation(h);
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
    this.syncMotors();
    // Вне висения скорость рыскания — какая вышла: с неё начнётся разворот на роторах.
    if (!this.yawOn) this.yawRate = wrap180(s.headingDeg - psi0) / h;
    if (s.mode !== 'crashed') this.attitude(h, rho);
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
    const g = this.turb.sample(s.t, s.east, s.north, Math.max(0, s.aglM), this.lw ?? undefined);
    this.gust = g;
    const a = 1 - Math.exp(-h / GUST_LAG_S);
    this.gustLp = { e: this.gustLp.e + (g.e - this.gustLp.e) * a, n: this.gustLp.n + (g.n - this.gustLp.n) * a, u: this.gustLp.u + (g.u - this.gustLp.u) * a };
    // Отклик аппарата — на каждом шаге, в любом режиме: к переходу на крыло фильтры уже в курсе.
    const psi = s.headingDeg * RAD;
    const lateral = g.e * Math.cos(psi) - g.n * Math.sin(psi);
    this.gustSide += (lateral - this.gustSide) * (1 - Math.exp(-h / GUST_ROLL_LAG_S));
    this.gustHeave += (g.u - this.gustHeave) * (1 - Math.exp(-h / GUST_HEAVE_LAG_S));
    const slow = 1 - Math.exp(-h / GUST_ROLL_TAU_S);
    this.rollLp += (this.gustSide - this.rollLp) * slow;
    this.heaveLp += (this.gustHeave - this.heaveLp) * slow;
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
      // Порывы — через отклик аппарата (sampleGust). На переходах кренят и несут тем сильнее, чем больше веса на крыле.
      const w = planePhase ? this.wingShare() : 0;
      vz = (GUST_VZ_PLANE * w + GUST_VZ_HOVER * (1 - w)) * this.gustHeave;
      bank = w * GUST_ROLL_DEG * (this.gustSide - this.rollLp);
      // Висение: тяга против порывов, чем сильнее болтанка — тем больше.
      if (rotorPhase) power *= 1 + 0.03 * s.gustMs;
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

  /** Доля веса на крыле: самолёт — 1, висение — 0, на переходах — сколько не держат роторы. */
  private wingShare(): number {
    const s = this.state;
    if (s.mode === 'transition' || s.mode === 'backtransition') return clamp(1 - s.lift, 0, 1);
    if (s.mode === 'failsafe') return s.failsafePhase === 'copter' ? this.copterWing : 1;
    return AIRBORNE.includes(s.mode) || s.mode === 'falling' ? 1 : 0;
  }

  /** Аппарат держат роторы (висение, ручной коптер): его наклоном и задаётся движение. */
  private rotorBorne(): boolean {
    const s = this.state;
    return s.mode === 'climb' || s.mode === 'descent' || s.mode === 'final' || (s.mode === 'failsafe' && s.failsafePhase === 'copter');
  }

  /**
   * Углы корпуса. Тангаж на крыле — угол пути относительно воздуха плюс угол атаки по CL (медленнее и в
   * вираже — нос выше); на роторах — наклон коптера: горизонтальную силу (разгон, торможение, сопротивление
   * в потоке) роторы дают наклоном тяги; на переходах — смесь по доле веса на крыле. Крен на роторах —
   * тот же наклон вбок (в самолёте крен ведёт fly()). Всё — с инерцией корпуса: без скачков при смене режима.
   */
  private attitude(h: number, rho: number) {
    const s = this.state;
    if (s.mode === 'landed') return this.settle(h);
    const psi = s.headingDeg * RAD;
    const fe = Math.sin(psi);
    const fn = Math.cos(psi);
    const rotor = this.rotorBorne();
    // Горизонтальная сила роторов на единицу массы, м/с².
    let ae = 0;
    let an = 0;
    if (rotor) {
      const w = windVec(this.windNow());
      const air = s.failsafePhase === 'copter' ? this.vAir : { e: this.lastVel.e - w.e - this.gustLp.e, n: this.lastVel.n - w.n - this.gustLp.n };
      const k = (0.5 * rho * COPTER_DRAG_AREA_M2 * Math.hypot(air.e, air.n)) / this.mass;
      ae = this.hoverAcc.e + k * air.e;
      an = this.hoverAcc.n + k * air.n;
    } else if (s.mode === 'backtransition') {
      // Роторы дотормаживают: тяга назад — нос вверх.
      ae = -this.rotorBrake * fe;
      an = -this.rotorBrake * fn;
    }
    const tilt = (a: number) => clamp(Math.atan2(a, G) / RAD, -COPTER_TILT_MAX_DEG, COPTER_TILT_MAX_DEG);
    let target = 0;
    if (s.mode === 'falling' && (s.tasMs <= this.stallTas(rho) || this.noGlide)) {
      // Кувырок: нос по траектории вниз; перед подхватом роторами — выравнивание.
      target = this.levelLeft !== null ? 0 : clamp(Math.atan2(s.vzMs, Math.max(s.tasMs, 1)) / RAD, -80, 10);
    } else if (s.mode !== 'ground' && s.mode !== 'spool') {
      const w = this.wingShare();
      let wing = 0;
      if (w > 0) {
        const tas = Math.max(s.tasMs, 5);
        const n = 1 / Math.cos(clamp(s.bankDeg - this.bankGust, -80, 80) * RAD);
        const cl = (w * n * this.mass * G) / (0.5 * rho * tas * tas * AIRCRAFT.wingAreaM2);
        const alpha = clamp(PITCH_TRIM_DEG + (cl - this.clRef) / CL_ALPHA_DEG, PITCH_ALPHA_MIN_DEG, PITCH_ALPHA_MAX_DEG);
        wing = Math.atan2(s.vzMs - this.vzGust, tas) / RAD + alpha - GUST_PITCH_DEG * (this.gustHeave - this.heaveLp);
      }
      target = w * wing - (1 - w) * tilt(ae * fe + an * fn);
    }
    const a = 1 - Math.exp(-h / ATTITUDE_LAG_S);
    this.pitchLag += (target - this.pitchLag) * a;
    s.pitchDeg += clamp((this.pitchLag - s.pitchDeg) * a, -PITCH_RATE_DEG_S * h, PITCH_RATE_DEG_S * h);
    if (rotor) {
      // Крен — к наклону вбок: коптер держит углы быстро, но не мгновенно (два звена — и скорость крена
      // без скачков); крен самолёта после торможения гасит так же.
      const b = 1 - Math.exp(-h / (COPTER_TILT_TAU_S / 2));
      this.rollLag = wrap180(this.rollLag + wrap180(tilt(ae * fn - an * fe) - this.rollLag) * b);
      const d = wrap180(this.rollLag - s.bankDeg) * b;
      s.bankDeg = wrap180(s.bankDeg + clamp(d, -COPTER_TILT_RATE_DEG_S * h, COPTER_TILT_RATE_DEG_S * h));
    } else this.rollLag = s.bankDeg;
  }

  /** На земле после касания корпус ложится на опоры. */
  private settle(h: number) {
    const s = this.state;
    const k = Math.exp(-h / SETTLE_S);
    s.pitchDeg *= k;
    this.pitchLag = s.pitchDeg;
    s.bankDeg = wrap180(s.bankDeg) * k;
  }

  /** Таймеры и медленные последствия отказов. */
  private failureTick(h: number) {
    const s = this.state;
    const since = (id: FailureId) => s.t - (this.failT[id] ?? s.t);
    if (this.failed.has('fire') && !this.failed.has('power') && since('fire') >= FIRE_TO_POWER_S) {
      this.events.push({ t: s.t, text: 'Пожар: отказ питания' });
      this.inject('power');
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

  /** Счисление без ГНСС: неучтённый автопилотом снос копится в ошибке места; с ГНСС — ошибка уходит. */
  private updateNavigation(h: number) {
    const s = this.state;
    if (this.windEst) {
      this.navErr.e -= this.unknownE;
      this.navErr.n -= this.unknownN;
    } else if (this.converging) {
      const k = Math.exp(-h / NAV_CONVERGE_S);
      this.navErr.e *= k;
      this.navErr.n *= k;
      if (Math.hypot(this.navErr.e, this.navErr.n) < 0.5) {
        this.navErr = { e: 0, n: 0 };
        this.converging = false;
      }
    }
    this.unknownE = 0;
    this.unknownN = 0;
    s.estimate.east = s.east + this.navErr.e + this.spoof.e;
    s.estimate.north = s.north + this.navErr.n + this.spoof.n;
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
    this.vzFrame(true);
    s.lift = 0;
    s.pusher = 0;
    const wind = this.windNow();
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
      if (this.levelLeft !== null) {
        // Выравнивание перед подхватом роторами: крен уходит к нулю ровно к концу, вращение остановлено.
        s.bankDeg = wrap180(s.bankDeg) * (1 - Math.min(1, h / Math.max(this.levelLeft, h)));
      } else {
        s.bankDeg = wrap180(s.bankDeg + 70 * h);
        s.headingDeg = norm360(s.headingDeg + 35 * h);
      }
      // Горизонтально — остаток скорости и снос ветром.
      const along = s.groundSpeedMs * Math.exp(-h / 1.5);
      ve = along * Math.sin(s.trackDeg * RAD) + 0.7 * wind.speedMs * Math.sin(to) * (1 - Math.exp(-h));
      vn = along * Math.cos(s.trackDeg * RAD) + 0.7 * wind.speedMs * Math.cos(to) * (1 - Math.exp(-h));
    }
    s.iasMs = s.tasMs * Math.sqrt(rho / RHO0);
    s.east += ve * h;
    s.north += vn * h;
    // Вертикальная — относительно воздуха; воздух и сам несёт вверх или вниз.
    s.up += (s.vzMs + this.upflowMs) * h;
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.distanceM += s.groundSpeedMs * h;
    const g = this.groundUp(s.east, s.north);
    if (s.up <= g) {
      const impact = Math.hypot(s.vzMs, s.groundSpeedMs);
      s.up = g;
      if (-s.vzMs < SAFE_IMPACT_MS && s.groundSpeedMs < 3) {
        // Крен и тангаж на земле гасит settle() — корпус ложится на опоры.
        s.vzMs = 0;
        s.groundSpeedMs = 0;
        this.setMode('landed', 'Жёсткая посадка без моторов');
      } else {
        this.crash(`Удар о землю на ${Math.round(impact)} м/с — ${this.fallCause}${this.restart ? '; запуск моторов в воздухе не успел' : ''}`);
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
      s.iasMs = 0;
      s.tasMs = 0;
      this.setMode('landed', sink > HARD_LANDING_MS ? `Жёсткая посадка: касание ${sink.toFixed(1)} м/с` : 'Посадка выполнена');
    } else this.crash(`Удар о землю на ${Math.round(Math.hypot(sink, s.groundSpeedMs))} м/с — ${cause}`);
  }

  /**
   * Разворот на висении к курсу (по умолчанию — посадки, против ветра), не быстрее 20°/с: вращение
   * разгоняется и гаснет плавно, без перерегулирования. Без компаса — к ложному курсу.
   */
  private hoverYaw(h: number, targetDeg = this.hoverHeadingDeg) {
    const s = this.state;
    const e = wrap180(targetDeg + this.compassErrDeg - s.headingDeg);
    const cmd = clamp(e / HOVER_YAW_TAU_S, -HOVER_YAW_DEG_S, HOVER_YAW_DEG_S);
    this.yawRate += (cmd - this.yawRate) * (1 - Math.exp(-h / HOVER_YAW_LAG_S));
    s.headingDeg = norm360(s.headingDeg + this.yawRate * h);
    this.yawOn = true;
  }

  /** Без одного подъёмного винта реактивный момент не уравновешен — аппарат вращается; ветер (флюгер) немного гасит. */
  private spin(h: number) {
    if (!this.failed.has('rotor')) return;
    const s = this.state;
    const k = 1 - clamp(s.wind.speedMs / 8, 0, 0.7);
    s.headingDeg = norm360(s.headingDeg + this.rotorSpinSign * ROTOR_SPIN_DEG_S * k * h);
  }

  /**
   * Вертикальная на роторах: к уставке vzCmd с ускорением не больше ROTOR_VZ_ACCEL, пока тяги хватает.
   * Без винта тяги меньше веса — аппарат проседает, пока сопротивление плашмя не уравновесит недостачу.
   * wing — доля веса на крыле.
   */
  private rotorVz(h: number, vzCmd: number, wing = 0): number {
    const s = this.state;
    this.vzFrame(false);
    if (!this.failed.has('rotor') && !this.failed.has('vtol')) return s.vzMs + clamp(vzCmd - s.vzMs, -ROTOR_VZ_ACCEL * h, ROTOR_VZ_ACCEL * h);
    const aUp = G * (this.rotorAuthority() + wing - 1);
    const aDown = -G * (1 - wing);
    const drag = (0.5 * this.rho(s.up) * VERTICAL_DRAG_AREA_M2 * s.vzMs * Math.abs(s.vzMs)) / this.mass;
    return s.vzMs + (clamp(2 * (vzCmd - s.vzMs), Math.min(aDown, aUp), aUp) - drag) * h;
  }

  /**
   * Горизонтальное перемещение на висении к точке: не быстрее HOVER_TRANSLATE_MS, с ускорением не больше
   * HOVER_ACCEL и торможением так, чтобы встать над точкой. Скорость с прошлого режима сохраняется —
   * после торможения или разгона роторы гасят её плавно. Автопилот ведёт по своей навигации: без ГНСС
   * точку не держит — сносит ветром; без компаса путает направление.
   */
  private hoverMove(h: number, target: { east: number; north: number }) {
    const s = this.state;
    const p = this.navPos();
    // Снос, которого автопилот сразу не парирует: без ГНСС — ветер, порывы — с инерцией аппарата.
    let we = 0;
    let wn = 0;
    if (this.windEst) {
      const w = windVec(this.windNow());
      we += 0.9 * w.e;
      wn += 0.9 * w.n;
    }
    if (this.turb) {
      we += this.gustLp.e;
      wn += this.gustLp.n;
    }
    // Только что на роторах: скорость — та, что была (путевая минус снос), без скачка.
    if (!this.hoverWas) this.hoverVel = { e: this.lastVel.e - we, n: this.lastVel.n - wn };
    this.hoverOn = true;
    const de = target.east - p.east;
    const dn = target.north - p.north;
    const d = Math.hypot(de, dn);
    let v = Math.min(HOVER_TRANSLATE_MS, Math.sqrt(2 * HOVER_BRAKE * d), HOVER_GAIN * d);
    // Вращающийся аппарат точку держит плохо.
    if (this.failed.has('rotor')) v *= 0.3;
    const ce = d > 0.01 ? (de / d) * v : 0;
    const cn = d > 0.01 ? (dn / d) * v : 0;
    let ae = (ce - this.hoverVel.e) / h;
    let an = (cn - this.hoverVel.n) / h;
    const am = Math.hypot(ae, an);
    if (am > HOVER_ACCEL) {
      ae *= HOVER_ACCEL / am;
      an *= HOVER_ACCEL / am;
    }
    this.hoverAcc = { e: ae, n: an };
    const ve = this.hoverVel.e + ae * h;
    const vn = this.hoverVel.n + an * h;
    this.hoverVel = { e: ve, n: vn };
    let me = ve * h;
    let mn = vn * h;
    const a = this.compassErrDeg * RAD;
    if (a !== 0) {
      // Смещение в связанных осях по ложному курсу: на деле — повёрнуто на ошибку компаса.
      me = (ve * Math.cos(a) + vn * Math.sin(a)) * h;
      mn = (vn * Math.cos(a) - ve * Math.sin(a)) * h;
      this.unknownE += me - ve * h;
      this.unknownN += mn - vn * h;
    }
    s.east += me + we * h;
    s.north += mn + wn * h;
    this.unknownE += we * h;
    this.unknownN += wn * h;
    // Путевая — по фактическому перемещению: поправка к точке вместе со сносом.
    s.groundSpeedMs = Math.hypot(me + we * h, mn + wn * h) / h;
    s.iasMs = 0;
    s.tasMs = 0;
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
    // Ниже сваливания поляра (весь вес на крыле) даёт индуктивное сопротивление без предела — торможение
    // в несколько g в последние метры. Столько не дадут ни крыло, ни наклон роторов назад.
    decel = Math.min(decel, BRAKE_DECEL_MAX);
    // Крыло больше CLmax не даёт: ниже сваливания его сопротивление — как на сваливании, по скоростному напору.
    const stall = this.stallTas(rho);
    const wingDrag = tas < stall ? (polar(this.mass, stall, rho).dragN * (tas / stall) ** 2) / this.mass : polar(this.mass, tas, rho).dragN / this.mass;
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
    // Что сверх сопротивления — тормозят роторы, наклоном назад (для тангажа).
    this.rotorBrake = Math.max(0, decel - wingDrag);
    const tasNew = Math.max(0, tas - decel * h);
    s.iasMs = tasNew * Math.sqrt(rho / RHO0);
    // С выключенным маршевым аппарат планирует к высоте обратного перехода над точкой (как в плане),
    // но не набирает: тяги для набора нет.
    // Над гребнем по пути к точке — не ниже запаса над рельефом: снижаться, только когда впереди чисто.
    const alt = Math.min(s.up, Math.max(this.groundUp(target.east, target.north) + VT.backTransitionHeightM, this.pathFloor(p, target, AIRCRAFT.minClearanceM)));
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
      // Пока набираем высоту по кругу — точка маршрута та же.
      while (!this.autoClimb) {
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
      if (onFinal && (toLanding <= pusherOff || (s.wp === lastIdx && along >= len)) && !this.descendFirst(this.landing)) {
        this.landAt = { east: this.landing.east, north: this.landing.north };
        this.hoverHeadingDeg = bearing(this.path[lastIdx - 1] ?? a, this.path[lastIdx]!);
        this.setMode('backtransition', 'Посадочная прямая — маршевый выключен');
        return this.brake(h, rho, hoverPowerW(this.mass, rho));
      }
      // Боковое уклонение: положительное — левее линии пути.
      const xte = de * (nav.north - a.north) - dn * (nav.east - a.east);
      track = norm360(bearing(a, b) + clamp(Math.atan2(xte, 60) / RAD, -45, 45));
      alt = a.up + (b.up - a.up) * clamp(along / (len || 1), 0, 1);
      // Не успеваем набрать к склону впереди (нисходящий поток у склона, встречный ветер) — набор
      // высоты по кругу над местом, как на ВОЗВРАТЕ; набрали — дальше по маршруту.
      const orbitR = Math.max(1.3 * R, 150);
      if (!this.autoClimb) {
        const need = this.autoNeed(nav);
        // Ниже нужной для склона впереди не снижаемся: иначе набранное на кругу терялось бы, едва
        // вернувшись на маршрут к высоте плана, — и снова круг, и так до склона.
        alt = Math.max(alt, need);
        if (s.up < need - AUTO_ORBIT_SLACK_M) {
          // Набирать — с запасом вдвое больше допуска: круг под уклон, выход с него не ближе к склону.
          // И до высоты, с которой хватит половины расчётного набора по пути: у склона нисходящий
          // поток бывает сильнее, чем здесь, — иначе круг за кругом по 30 м.
          this.autoClimb = { ...this.downslopeCenter(nav, orbitR), up: Math.max(need, this.autoNeed(nav, 0.5)) + 2 * AUTO_ORBIT_SLACK_M };
          this.events.push({ t: s.t, text: `Набор высоты по кругу до ${Math.round(this.site.elevationM + this.autoClimb.up)} м — впереди склон круче, чем успеваю набрать` });
        }
      } else if (s.up >= this.autoClimb.up) {
        this.autoClimb = null;
        this.autoNeedCache.t = -Infinity;
        this.events.push({ t: s.t, text: 'Высота набрана — продолжаю маршрут' });
      }
      if (this.autoClimb) {
        track = this.orbitTrack(this.autoClimb, orbitR);
        alt = Math.max(this.autoClimb.up + 10, this.terrainFollow(RTL_CLEARANCE_M, track, tas));
      }
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
      // Нужная высота над рельефом на всём пути домой. Ниже её — набор по кругу над местом, пока не наберём.
      const need = this.rtlNeed(nav, pts);
      const orbitR = Math.max(1.3 * R, 150);
      if (!this.rtlClimb && s.up < need - RTL_ORBIT_SLACK_M) {
        // Круг — под уклон от места: весь он над рельефом не выше здешнего, а не в склон.
        const ge = this.groundUp(nav.east + 100, nav.north) - this.groundUp(nav.east - 100, nav.north);
        const gn = this.groundUp(nav.east, nav.north + 100) - this.groundUp(nav.east, nav.north - 100);
        const gl = Math.hypot(ge, gn);
        this.rtlClimb = gl > 1 ? { east: nav.east - (ge / gl) * orbitR, north: nav.north - (gn / gl) * orbitR } : { east: nav.east, north: nav.north };
        this.events.push({ t: s.t, text: `ВОЗВРАТ: набор высоты над местом до ${Math.round(this.site.elevationM + need)} м — впереди рельеф` });
      } else if (this.rtlClimb && s.up >= need + 10) {
        this.rtlClimb = null;
        this.events.push({ t: s.t, text: 'ВОЗВРАТ: высота набрана — иду домой' });
      }
      if (this.rtlClimb) {
        track = this.orbitTrack(this.rtlClimb, orbitR);
        alt = Math.max(need + 20, this.terrainFollow(RTL_CLEARANCE_M, track, tas));
      } else {
        track = bearing(nav, target);
        const approachAgl = [Math.min(c.heightAglM, 150), 100, VT.backTransitionHeightM][this.rtlStage]!;
        const floor = this.rtlStage === 2 ? VT.backTransitionHeightM - 5 : RTL_CLEARANCE_M;
        alt = Math.max(this.groundUp(target.east, target.north) + approachAgl, need, this.terrainFollow(floor, track, tas));
        if (this.rtlStage === 2 && d <= pusherOff && !this.descendFirst(this.home)) {
          this.landAt = { east: this.home.east, north: this.home.north };
          this.setMode('backtransition', 'Посадочная прямая — маршевый выключен');
          return this.brake(h, rho, hoverPowerW(this.mass, rho));
        }
      }
    }
    // Снижение по кругу над точкой посадки на маршевом (descendFirst) — и в задании, и на ВОЗВРАТЕ.
    if (this.descentOrbit && (s.mode === 'auto' || s.mode === 'rtl')) {
      track = this.orbitTrack(this.descentOrbit, Math.max(1.3 * R, 150));
      alt = Math.max(this.groundUp(this.descentOrbit.east, this.descentOrbit.north) + VT.backTransitionHeightM, this.terrainFollow(AIRCRAFT.minClearanceM, track, tas));
    }

    // Автопилот держит уставку по показаниям ПВД: при отказе — не ту скорость, что задана.
    const iasTarget = Math.min(clamp(c.iasMs, AIRCRAFT.transitionLowIasMs, AIRCRAFT.limits.maxIasMs) / this.airspeedK, AIRCRAFT.limits.maxIasMs * PUSHER_TOP_IAS_SHARE);
    const iasBefore = s.iasMs;
    s.iasMs += clamp(iasTarget - s.iasMs, -1.2 * h, 1.0 * h);
    const accel = (tasFromIas(s.iasMs, rho) - tasFromIas(iasBefore, rho)) / h;
    const glide = !this.pusherThrust();
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
    this.vzFrame(true);
    const tas = tasFromIas(s.iasMs, rho);
    s.tasMs = tas;
    const wind = this.windNow();
    s.wind = wind;
    const aileron = this.failed.has('aileron');
    // Крен: к уставке не быстрее rate, а скорость крена набирается и гаснет с инерцией по крену — вход в
    // разворот и выход из него без мгновенного начала вращения. Из другого режима — с нуля.
    if (!this.flyWas) this.rollRate = 0;
    const roll = (cmd: number, rate: number, lo: number, hi: number) => {
      const p = clamp((cmd - s.bankDeg) / ROLL_TAU_S, -rate, rate);
      this.rollRate += (p - this.rollRate) * (1 - Math.exp(-h / ROLL_LAG_S));
      s.bankDeg = clamp(s.bankDeg + this.rollRate * h, Math.min(lo, s.bankDeg), Math.max(hi, s.bankDeg));
    };
    const rate = aileron ? AILERON_RATE_DEG_S : 20;
    const lo = this.rollLimit(-AIRCRAFT.maxBankDeg);
    const hi = this.rollLimit(AIRCRAFT.maxBankDeg);
    if (steer && tas > 5) {
      const tri = windTriangle(tas, trackCmd, wind);
      const headingCmd = trackCmd + (tri ? tri.driftDeg : 0);
      roll(this.rollLimit(clamp(wrap180(headingCmd - s.headingDeg) * 1.2, -AIRCRAFT.maxBankDeg, AIRCRAFT.maxBankDeg)), rate, lo, hi);
      s.headingDeg = norm360(s.headingDeg + ((G * Math.tan(s.bankDeg * RAD)) / tas / RAD) * h);
    } else {
      roll(aileron ? this.aileronBiasDeg : 0, 20, lo, hi);
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
      // Вертикальная относительно воздуха; поток воздуха автопилот видит по баро и ГНСС и парирует.
      let vzCmd = this.pitchFailure(clamp(0.3 * (alt - s.up) - this.upflowMs, -AIRCRAFT.planeDescentRateMaxMs, AIRCRAFT.planeClimbRateMaxMs));
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
    // Из другого режима путевая скорость не скачет: расхождение с этой моделью (снос на висении, скорость
    // коптера) гасится с ускорением роторов.
    if (!this.flyWas) this.carry = { e: this.lastVel.e - ve, n: this.lastVel.n - vn };
    this.flyOn = true;
    const cm = Math.hypot(this.carry.e, this.carry.n);
    if (cm > 0) {
      const k = Math.max(0, cm - HOVER_ACCEL * h) / cm;
      this.carry = { e: this.carry.e * k, n: this.carry.n * k };
      ve += this.carry.e;
      vn += this.carry.n;
    }
    s.east += ve * h;
    s.north += vn * h;
    s.up += (s.vzMs + this.upflowMs) * h;
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
    this.vzFrame(true);
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
    const thrust = this.pusherThrust() ? clamp(want, 0, this.maxThrustN(rho)) : 0;
    const tasNew = Math.max(1, tas + ((thrust - drag) / this.mass - (G * s.vzMs) / tas) * h);
    s.tasMs = tasNew;
    s.iasMs = tasNew * Math.sqrt(rho / RHO0);
    s.headingDeg = norm360(s.headingDeg + ((G * Math.tan(clamp(s.bankDeg, -80, 80) * RAD)) / tasNew / RAD) * h);
    const wind = this.windNow();
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
    s.up += (s.vzMs + this.upflowMs) * h;
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
      const sink = -(s.vzMs + this.upflowMs);
      const gs = s.groundSpeedMs;
      if (sink <= BELLY_SINK_MS && gs <= BELLY_GROUND_MS && Math.abs(s.bankDeg) < BELLY_BANK_DEG) {
        s.vzMs = 0;
        s.groundSpeedMs = 0;
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
    this.vzFrame(false);
    const wind = this.windNow();
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
    // Наклон коптера (крен и тангаж) — по ускорению и сопротивлению в потоке: attitude().
    this.hoverAcc = { e: ae, n: an };
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
    this.copterWing = wing;
    const vzCmd = st.throttle >= 0 ? st.throttle * FS_CLIMB_MS : st.throttle * FS_DESCENT_MS;
    const auth = this.rotorAuthority();
    const drag = (0.5 * rho * VERTICAL_DRAG_AREA_M2 * s.vzMs * Math.abs(s.vzMs)) / this.mass;
    const aUp = G * (auth + wing - 1);
    const acc = clamp(2 * (vzCmd - s.vzMs), Math.min(-G * (1 - wing), aUp), aUp);
    s.vzMs += (acc - drag) * h;
    s.up += s.vzMs * h;
    const rotorFrac = clamp(1 - wing + acc / G, 0, auth);
    s.lift = Math.min(1, rotorFrac);
    s.pusher = this.pusherOff ? 0 : PUSHER_IDLE;
    s.tasMs = Math.hypot(this.vAir.e, this.vAir.n);
    s.iasMs = s.tasMs * Math.sqrt(rho / RHO0);
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.driftDeg = 0;
    s.distanceM += s.groundSpeedMs * h;
    const aux = AIRCRAFT.auxPowerHoverW;
    const power = aux + (hover - aux) * rotorFrac ** 1.5 * (1 + ((VT.climbFactor - 1) * Math.max(0, s.vzMs - this.upflowMs)) / VT.climbRateMs);
    if (s.up <= this.groundUp(s.east, s.north))
      this.touchdown(this.catching ? 'не хватило высоты на выход из падения' : rotorLost ? 'ручная посадка без подъёмного винта' : 'ручная посадка');
    return power;
  }
}

function fmtKm(m: number): string {
  return (m / 1000).toFixed(m % 1000 === 0 ? 0 : 1);
}
