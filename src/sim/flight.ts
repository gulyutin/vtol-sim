import { AIRCRAFT } from './aircraft';
import { brakeDecel, climbPowerW, HOVER_TRANSLATE_MS, hoverPowerW, polar, takeoffMassKg } from './aero';
import { airDensity, batteryCapacityWh, G, RHO0, tasFromIas, temperatureAt } from './atmosphere';
import { fromLocal, toLocal } from './mission';
import { windProcedures } from './procedures';
import type { MissionPlan, Site, Terrain, Weather, Wind } from './types';
import { windAt, windTriangle } from './wind';

/*
 * Живой полёт: шаг за шагом, с командами оператора, как в НСУ. Физика та же, что
 * у планировщика (aero.ts, atmosphere.ts, wind.ts), только интегрируется по времени:
 * крен и курс меняются с ограниченной скоростью, путь в ветре складывается сам.
 * Взлёт и посадка — по РЛЭ: разгон и заход против ветра, маршевый выключается за 200 м
 * до точки посадки, над точкой — разворот против ветра и снижение в режиме коптера.
 */

const RAD = Math.PI / 180;
const VT = AIRCRAFT.vtol;
/** Заармлен на земле: роторы на холостых — доля загрузки для отрисовки и мощности. */
const ARMED_IDLE_LIFT = 0.08;
/** Установившаяся скорость падения без моторов, м/с. */
const TERMINAL_FALL_MS = 22;
/** Касание без моторов мягче этого — жёсткая посадка, жёстче — авария. */
const SAFE_IMPACT_MS = 2.5;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
const bearing = (a: { east: number; north: number }, b: { east: number; north: number }) =>
  norm360(Math.atan2(b.east - a.east, b.north - a.north) / RAD);

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
  falling: 'МОТОРЫ ВЫКЛЮЧЕНЫ',
  landed: 'НА ЗЕМЛЕ',
  crashed: 'АВАРИЯ',
};

/** Самолётные режимы, в которых оператор может переключаться. */
const AIRBORNE: LiveMode[] = ['auto', 'guided', 'hold', 'manual', 'rtl'];

export interface PathPoint {
  east: number;
  north: number;
  /** Над площадкой-началом координат, м. */
  up: number;
  routeLeg?: number;
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
}

/** arm / disarm — «заармить» и «задизармить» по РЛЭ: разрешение моторам работать. */
export type Command = 'arm' | 'disarm' | 'takeoff' | 'auto' | 'manual' | 'guided' | 'hold' | 'rtl' | 'land';

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
  private readonly site: Site;
  private readonly homeSite: Site;
  private readonly mass: number;
  private readonly payloadW: number;
  private readonly terrain: Terrain;
  private readonly weather: Weather;
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
    this.landing = this.local(plan.landing, plan.landing.elevationM - this.site.elevationM);
    this.home = this.local(this.homeSite, this.homeSite.elevationM - this.site.elevationM);
    this.path = this.buildPath(plan);
    const heading = this.path.length > 1 ? bearing(this.path[0]!, this.path[1]!) : 0;
    const energy = setup.initialEnergyWh ?? 0;
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
    const ahead = (i: number) => {
      const p = this.path[i]!;
      const q = this.path[i - 1]!;
      return (p.east - q.east) * (p.east - s.east) + (p.north - q.north) * (p.north - s.north) > 0;
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

  /** Команда оператора. Возвращает причину отказа или null. */
  command(c: Command): string | null {
    const s = this.state;
    const airborne = AIRBORNE.includes(s.mode);
    switch (c) {
      case 'arm':
        if (s.mode !== 'ground') return 'АРМ — только на земле перед взлётом';
        if (s.armed) return 'Уже заармлен';
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
        if (!airborne) return 'Возврат — только в полёте';
        this.startRtl();
        return null;
      case 'land':
        if (s.mode === 'spool' || s.mode === 'climb') {
          this.landHere();
          return null;
        }
        if (!airborne) return 'Посадка — только в полёте';
        // Посадка на месте: гасим скорость прямо по курсу, над точкой — носом против ветра.
        this.landAt = null;
        this.hoverHeadingDeg = s.wind.fromDeg;
        this.setMode('backtransition');
        return null;
    }
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
    s.powerW = this.idlePowerW() + this.payloadW;
    s.energyWh += (s.powerW * h) / 3600;
    s.soc = (this.capacityWh - s.energyWh) / this.capacityWh;
  }

  private landHere() {
    const s = this.state;
    this.landAt = { east: s.east, north: s.north };
    this.hoverHeadingDeg = s.headingDeg;
    this.setMode('descent');
  }

  /** ВОЗВРАТ: посадочный маршрут к дому строится по фактическому ветру (как у автопилота). */
  private startRtl() {
    const s = this.state;
    const wind10 = windAt(this.weather, 10);
    const here = fromLocal(this.site, s.east, s.north);
    const proc = windProcedures(this.homeSite, this.homeSite, wind10, null, here);
    this.rtlApproach = proc.approach.map((p) => this.local(p, 0));
    this.rtlStage = 0;
    this.hoverHeadingDeg = proc.landingHeadingDeg;
    this.setMode('rtl');
  }

  private setMode(m: LiveMode, text?: string) {
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

  private rho(up: number): number {
    const alt = this.site.elevationM + up;
    return airDensity({ altitudeM: alt, temperatureC: temperatureAt(alt, this.weather.groundTemperatureC, this.site.elevationM) });
  }

  /**
   * Высота для полёта над рельефом с упреждением: заглядываем вперёд по курсу и начинаем
   * набор заранее, чтобы с предельной вертикальной скоростью успеть к высокому рельефу.
   */
  private terrainFollow(heightAglM: number, trackDeg: number, tas: number): number {
    const grad = (AIRCRAFT.planeClimbRateMaxMs * 0.9) / Math.max(tas, 10);
    const s = this.state;
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
    const s = this.state;
    const d = Math.hypot(s.east - center.east, s.north - center.north);
    if (d > 1.8 * r) return norm360(bearing(s, center) - Math.asin(r / d) / RAD);
    return norm360(bearing(center, s) + 90 + clamp(((d - r) / r) * 60, -60, 60));
  }

  private tick(h: number, c: Controls) {
    const s = this.state;
    s.t += h;
    s.modeT += h;
    const ground = this.groundUp(s.east, s.north);
    s.aglM = s.up - ground;
    const rho = this.rho(s.up);
    const hover = hoverPowerW(this.mass, rho);
    let power = 0;

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
        s.vzMs = VT.climbRateMs * Math.min(1, s.modeT / 1.5);
        s.up += s.vzMs * h;
        if (s.up >= this.path[0]!.up) {
          s.up = this.path[0]!.up;
          s.vzMs = 0;
          s.headingDeg = this.path.length > 1 ? bearing(this.path[0]!, this.path[1]!) : s.headingDeg;
          this.setMode('transition');
        }
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
        const target = this.landAt ?? { east: s.east, north: s.north };
        this.hoverMove(h, target);
        // Снижение — над точкой; до неё аппарат идёт на роторах, держа высоту.
        const over = Math.hypot(target.east - s.east, target.north - s.north) < 5;
        power = (over ? VT.descentFactor : 1) * hover;
        s.vzMs = over ? -VT.descentRateMs : 0;
        s.up += s.vzMs * h;
        if (s.up - this.groundUp(s.east, s.north) <= VT.finalHeightM) this.setMode('final');
        break;
      }

      case 'final': {
        power = hover;
        s.lift = 1;
        s.pusher = 0.1;
        this.hoverYaw(h);
        if (this.landAt) this.hoverMove(h, this.landAt);
        s.vzMs = -VT.finalHeightM / VT.finalS;
        s.up += s.vzMs * h;
        const g = this.groundUp(s.east, s.north);
        if (s.up <= g) {
          s.up = g;
          s.vzMs = 0;
          s.lift = 0;
          s.pusher = 0;
          s.groundSpeedMs = 0;
          this.setMode('landed', 'Посадка выполнена');
        }
        break;
      }

      default:
        break;
    }

    s.powerW = s.mode === 'landed' ? 0 : power + this.payloadW;
    s.energyWh += (s.powerW * h) / 3600;
    s.soc = (this.capacityWh - s.energyWh) / this.capacityWh;
    s.aglM = s.up - this.groundUp(s.east, s.north);
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
    const stall = 0.85 * tasFromIas(AIRCRAFT.transitionLowIasMs, rho);
    let ve: number;
    let vn: number;
    if (tas > stall) {
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

  /** Разворот на висении к курсу посадки (против ветра), не быстрее 20°/с. */
  private hoverYaw(h: number) {
    const s = this.state;
    const e = wrap180(this.hoverHeadingDeg - s.headingDeg);
    s.headingDeg = norm360(s.headingDeg + clamp(e, -20 * h, 20 * h));
    s.bankDeg = 0;
  }

  /** Горизонтальное перемещение на висении к точке посадки, не быстрее HOVER_TRANSLATE_MS. */
  private hoverMove(h: number, target: { east: number; north: number }) {
    const s = this.state;
    const de = target.east - s.east;
    const dn = target.north - s.north;
    const d = Math.hypot(de, dn);
    const v = Math.min(HOVER_TRANSLATE_MS, d / Math.max(h, 1e-6), d);
    if (d > 0.01) {
      s.east += (de / d) * v * h;
      s.north += (dn / d) * v * h;
    }
    s.groundSpeedMs = d > 0.01 ? v : 0;
    s.iasMs = 0;
    s.tasMs = 0;
  }

  /**
   * Торможение перед посадкой: маршевый выключен, скорость гасит сопротивление по поляре;
   * ниже 12 м/с подхватывают роторы и дотормаживают так, чтобы встать над точкой.
   */
  private brake(h: number, rho: number, hover: number): number {
    const s = this.state;
    const target = this.landAt ?? { east: s.east + Math.sin(s.trackDeg * RAD) * 150, north: s.north + Math.cos(s.trackDeg * RAD) * 150 };
    this.landAt ??= target;
    const d = Math.hypot(target.east - s.east, target.north - s.north);
    const tas = Math.max(0, s.tasMs);
    // Путевая скорость к точке: при встречном ветре гаснет раньше воздушной.
    const toward = (p: { east: number; north: number }) => s.groundSpeedMs * Math.cos((s.trackDeg - bearing(p, target)) * RAD);
    // Роторы наклоняют аппарат и дотормаживают к точке.
    const { decel, lift } = brakeDecel(this.mass, tas, rho, toward(s), d);
    const tasNew = Math.max(0, tas - decel * h);
    s.iasMs = tasNew * Math.sqrt(rho / RHO0);
    // С выключенным маршевым аппарат планирует к высоте обратного перехода над точкой (как в плане),
    // но не набирает: тяги для набора нет.
    const alt = Math.min(s.up, this.groundUp(target.east, target.north) + VT.backTransitionHeightM);
    this.fly(h, d > 5 ? bearing(s, target) : s.trackDeg, alt, rho, 1 - 0.8 * lift, tasNew > 5);
    s.lift = lift;
    s.pusher = 0;
    // Над точкой — или путевая к ней погасла (встречный ветер): остаток пути на роторах.
    if (tasNew < 1.5 || d < 3 || toward(s) <= 1) this.setMode('descent');
    return AIRCRAFT.idlePowerPlaneW + lift * hover;
  }

  /**
   * Самолётный режим: наведение даёт путевой угол и высоту, дальше — поправка на снос,
   * крен с ограниченной скоростью, разворот g·tg(крен)/V, вертикаль с ограничением Vz.
   */
  private airplane(h: number, c: Controls, rho: number): number {
    const s = this.state;
    const tas = tasFromIas(Math.max(s.iasMs, 1), rho);
    let track = s.trackDeg;
    let alt = s.up;
    const R = this.turnRadiusM(tas);
    const pusherOff = AIRCRAFT.procedures.pusherOffBeforeLandingM;

    if (s.mode === 'auto') {
      let a = this.path[s.wp - 1]!;
      let b = this.path[s.wp]!;
      for (;;) {
        const len = Math.hypot(b.east - a.east, b.north - a.north);
        const along = len > 0 ? ((s.east - a.east) * (b.east - a.east) + (s.north - a.north) * (b.north - a.north)) / len : 0;
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
      const along = (s.east - a.east) * de + (s.north - a.north) * dn;
      // Посадочная прямая (последний участок посадочного маршрута, нарезанный огибанием рельефа
      // на отрезки): за pusherOffBeforeLandingM до точки посадки выключаем маршевый (по РЛЭ).
      const lastIdx = this.path.length - 1;
      const onFinal = s.wp === lastIdx || (this.finalLeg !== undefined && b.routeLeg === this.finalLeg);
      const toLanding = Math.hypot(this.landing.east - s.east, this.landing.north - s.north);
      if (onFinal && (toLanding <= pusherOff || (s.wp === lastIdx && along >= len))) {
        this.landAt = { east: this.landing.east, north: this.landing.north };
        this.hoverHeadingDeg = bearing(this.path[lastIdx - 1] ?? a, this.path[lastIdx]!);
        this.setMode('backtransition', 'Посадочная прямая — маршевый выключен');
        return this.brake(h, rho, hoverPowerW(this.mass, rho));
      }
      // Боковое уклонение: положительное — левее линии пути.
      const xte = de * (s.north - a.north) - dn * (s.east - a.east);
      track = norm360(bearing(a, b) + clamp(Math.atan2(xte, 60) / RAD, -45, 45));
      alt = a.up + (b.up - a.up) * clamp(along / (len || 1), 0, 1);
      s.routeLeg = b.routeLeg ?? null;
    } else if (s.mode === 'guided' || s.mode === 'hold') {
      const center = s.mode === 'hold' ? this.home : (c.target ?? { east: s.east, north: s.north });
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
      let d = Math.hypot(target.east - s.east, target.north - s.north);
      if (this.rtlStage < 2 && d < 150) {
        this.rtlStage++;
        target = pts[this.rtlStage]!;
        d = Math.hypot(target.east - s.east, target.north - s.north);
      }
      track = bearing(s, target);
      const approachAgl = [Math.min(c.heightAglM, 150), 100, VT.backTransitionHeightM][this.rtlStage]!;
      const floor = this.rtlStage === 2 ? VT.backTransitionHeightM - 5 : 60;
      alt = Math.max(this.groundUp(target.east, target.north) + approachAgl, this.terrainFollow(floor, track, tas));
      if (this.rtlStage === 2 && d <= pusherOff) {
        this.landAt = { east: this.home.east, north: this.home.north };
        this.setMode('backtransition', 'Посадочная прямая — маршевый выключен');
        return this.brake(h, rho, hoverPowerW(this.mass, rho));
      }
    }

    const iasTarget = clamp(c.iasMs, AIRCRAFT.transitionLowIasMs, AIRCRAFT.limits.maxIasMs);
    const iasBefore = s.iasMs;
    s.iasMs += clamp(iasTarget - s.iasMs, -1.2 * h, 1.0 * h);
    const accel = (tasFromIas(s.iasMs, rho) - tasFromIas(iasBefore, rho)) / h;
    this.fly(h, track, alt, rho, 1, true);

    const tasNow = Math.max(s.tasMs, 1);
    let p = climbPowerW(this.mass, tasNow, rho, s.vzMs, 1 / Math.cos(s.bankDeg * RAD));
    p = Math.max(AIRCRAFT.idlePowerPlaneW, p + (this.mass * tasNow * accel) / AIRCRAFT.etaDrive);
    s.lift = 0;
    s.pusher = Math.min(1, p / 1600);
    return p;
  }

  /**
   * Кинематика в воздухе: курс на заданный путевой угол с поправкой на снос, крен с
   * ограничением скорости крена, вертикаль к высоте alt. windShare — доля ветра,
   * сносящего аппарат (на переходе роторы ещё держат точку). tas берётся из s.iasMs.
   */
  private fly(h: number, trackCmd: number, alt: number, rho: number, windShare: number, steer = false) {
    const s = this.state;
    const tas = tasFromIas(s.iasMs, rho);
    s.tasMs = tas;
    const wind = windAt(this.weather, Math.max(0, s.aglM));
    s.wind = wind;
    if (steer && tas > 5) {
      const tri = windTriangle(tas, trackCmd, wind);
      const headingCmd = trackCmd + (tri ? tri.driftDeg : 0);
      const bankCmd = clamp(wrap180(headingCmd - s.headingDeg) * 1.2, -AIRCRAFT.maxBankDeg, AIRCRAFT.maxBankDeg);
      s.bankDeg += clamp(bankCmd - s.bankDeg, -20 * h, 20 * h);
      s.headingDeg = norm360(s.headingDeg + ((G * Math.tan(s.bankDeg * RAD)) / tas / RAD) * h);
    } else {
      s.bankDeg += clamp(-s.bankDeg, -20 * h, 20 * h);
    }
    const vzCmd = clamp(0.3 * (alt - s.up), -AIRCRAFT.planeDescentRateMaxMs, AIRCRAFT.planeClimbRateMaxMs);
    s.vzMs += clamp(vzCmd - s.vzMs, -0.6 * h, 0.6 * h);
    const to = (wind.fromDeg + 180) * RAD;
    const ve = tas * Math.sin(s.headingDeg * RAD) + windShare * wind.speedMs * Math.sin(to);
    const vn = tas * Math.cos(s.headingDeg * RAD) + windShare * wind.speedMs * Math.cos(to);
    s.east += ve * h;
    s.north += vn * h;
    s.up += s.vzMs * h;
    s.groundSpeedMs = Math.hypot(ve, vn);
    if (s.groundSpeedMs > 0.5) s.trackDeg = norm360(Math.atan2(ve, vn) / RAD);
    s.driftDeg = wrap180(s.headingDeg - s.trackDeg);
    s.distanceM += s.groundSpeedMs * h;
  }
}
