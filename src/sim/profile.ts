// Только тип: записи живут в src/game, но во время выполнения профиль от них не зависит.
import type { Recording } from '../game/recorder';
import type { Relay } from './radio';
import type { SurveyCamera } from './survey';
import type { AirState, GeoPoint } from './types';

/*
 * Профиль — всё, что относится к конкретному аппарату и месту: константы, опорные точки
 * калибровки, штатная камера, район заданий. Код симулятора от профиля не зависит.
 * Модуль @profile указывает на private/profile, если такая папка есть, иначе на демо-профиль
 * src/profile-demo (vite.config.ts, tsconfig.json). PROFILE=demo принудительно берёт демо.
 */

/** Опорная точка крейсера: мощность в установившемся горизонтальном полёте. */
export interface CruiseReference {
  /** Приборная скорость, м/с. */
  iasMs: number;
  powerW: number;
  massKg: number;
  air: AirState;
}

/** Опорная точка висения: мощность подъёмных роторов. */
export interface HoverReference {
  rotorPowerW: number;
  massKg: number;
  air: AirState;
}

export interface AircraftSpec {
  wingSpanM: number;
  wingAreaM2: number;
  oswald: number;
  /** Должен совпадать с calibrateCd0(cruiseReference) — проверяется тестом. */
  cd0: number;

  takeoffMassRefKg: number;
  /** Нагрузка в опорных точках; её потребление уже внутри опорных мощностей. */
  payloadRefKg: number;
  /** Планер с АКБ, без нагрузки. */
  emptyMassKg: number;
  payloadMaxKg: number;

  /** Доступная ёмкость АКБ при batteryRefTemperatureC, Вт·ч. */
  batteryWh: number;
  batteryRefTemperatureC: number;
  voltageFullV: number;
  voltage10PctV: number;
  reserve: number;
  /** Доля доступной ёмкости по температуре: [°C, доля]; между точками — линейно. */
  batteryTemperatureDerate: readonly (readonly [number, number])[];

  /** КПД тракта «батарея → тяга» в самолётном режиме. */
  etaDrive: number;
  etaElec: number;
  /** Мощность в самолётном режиме на планировании с убранным газом, Вт. */
  idlePowerPlaneW: number;
  /** КПД набора и снижения в самолётном режиме: ΔP = m·g·Vz / η_climb. */
  etaClimb: number;
  planeClimbRateMaxMs: number;
  planeDescentRateMaxMs: number;
  /** Минимальный запас высоты над рельефом на маршруте, м. */
  minClearanceM: number;
  /** Предельный крен автопилота в развороте, °. */
  maxBankDeg: number;

  rotorCount: number;
  rotorDiameterM: number;
  /** Должен совпадать с calibrateFigureOfMerit(hoverReference) — проверяется тестом. */
  figureOfMerit: number;
  /** Маршевый винт и бортовое питание на висении, Вт. */
  auxPowerHoverW: number;

  /** Уставки автопилота по приборной скорости, м/с. */
  transitionLowIasMs: number;
  transitionHighIasMs: number;
  cruiseIasMs: number;

  /** Лётные и эксплуатационные ограничения. */
  limits: {
    mtowKg: number;
    maxIasMs: number;
    maxGroundSpeedMs: number;
    maxBankDeg: number;
    maxPitchDeg: number;
    maxAltitudeM: number;
    /** Постоянный ветер, в том числе в порывах при взлёте и посадке. */
    windMaxMs: number;
    gustMaxMs: number;
    /** Взлёт при ветре с любого направления — до этой скорости, сильнее — только против ветра. */
    takeoffAnyWindMs: number;
    minCloudBaseM: number;
    temperatureMinC: number;
    temperatureMaxC: number;
    /** Переход в «Фэйлсейф». */
    failsafeBankDeg: number;
    failsafePitchDeg: number;
    failsafeVzMs: number;
    /** Дальность связи с НСУ при прямой видимости. */
    radioRangeM: number;
    /** Район посадки — окружность вокруг точки посадки. */
    landingZoneRadiusM: number;
  };

  /** Взлётный и посадочный маршруты. */
  procedures: {
    /** Первая точка взлётного маршрута — против ветра, не ближе. */
    departureDistanceM: number;
    /** Высота зависания перед разгоном — не ниже. */
    minHoverHeightM: number;
    /** Шаг точек посадочного маршрута. */
    approachLegM: number;
    /** Маршевый выключается за столько до точки посадки, дальше торможение сопротивлением. */
    pusherOffBeforeLandingM: number;
  };

  /** Фазы вертикального режима. Мощности — доли висения по батарее. */
  vtol: {
    spoolUpS: number;
    spoolUpFactor: number;
    transitionHeightM: number;
    climbRateMs: number;
    climbFactor: number;
    transitionS: number;
    transitionFactor: number;
    backTransitionHeightM: number;
    descentRateMs: number;
    descentFactor: number;
    finalHeightM: number;
    finalS: number;
  };
}

/** Точка маршрута, которую ставит оператор: положение и высота над рельефом. */
export interface RoutePoint extends GeoPoint {
  heightAglM: number;
}

/** Район заданий: площадка, область рельефа и снимков, точки заданий. */
export interface LocationSpec {
  /** Название района для выбора в интерфейсе: «Подмосковье — долина Оки». */
  regionName?: string;
  site: GeoPoint;
  /** Название площадки в именительном падеже: «аэродром …». */
  siteName: string;
  /** Область рельефа и снимков, на которой строятся все задания. */
  region: { south: number; west: number; north: number; east: number };
  /** Дата заданий (Солнце и освещённость) и часовой пояс. */
  date: string;
  utcOffsetH: number;
  /** Прогноз по умолчанию: ветер на 10 м и температура у земли. */
  windSpeedMs: number;
  windFromDeg: number;
  temperatureC: number;
  survey: { title: string; briefing: string; area: GeoPoint[] };
  delivery: { title: string; briefing: string; destination: GeoPoint; destinationName: string; route: RoutePoint[] };
  route: { briefing: string; route: RoutePoint[] };
  /** Перелёт из А в Б: взлёт на площадке, посадка в другой точке. */
  transfer: { title: string; briefing: string; destination: GeoPoint; destinationName: string; route: RoutePoint[] };
  /**
   * Ретрансляторы связи района (radio.ts) — для всех заданий: чтобы задания по умолчанию не теряли
   * связь за рельефом дольше таймаута и борт на земле в пункте Б был на связи.
   */
  relays?: Relay[];
}

export interface Profile {
  /** Заголовок окна. */
  title: string;
  /** Модель аппарата: public/models/<modelName>.glb. */
  modelName: string;
  /** Дома, леса и полосы района (src/sim/osm.ts): адрес файла, `import url from './osm.bin?url'`. */
  osmUrl?: string;
  aircraft: AircraftSpec;
  cruiseReference: CruiseReference;
  hoverReference: HoverReference;
  /** Штатная камера — первая в списке. */
  camera: SurveyCamera;
  location: LocationSpec;
  /**
   * Бортовой журнал аппарата → запись для разбора (src/game/recorder.ts). Формат журнала —
   * дело профиля; без этого поля разбор открывает только записи симулятора.
   */
  importLog?: (buf: ArrayBuffer, fileName: string) => Promise<Recording>;
}
