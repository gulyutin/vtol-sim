/** Состояние воздуха в точке. */
export interface AirState {
  /** Высота над уровнем моря, м. */
  altitudeM: number;
  /** Температура воздуха на этой высоте, °C. */
  temperatureC: number;
}

/** Ветер. Направление метеорологическое: откуда дует, градусы от севера по часовой. */
export interface Wind {
  speedMs: number;
  fromDeg: number;
}

export interface Weather {
  /** Температура воздуха у земли на площадке взлёта, °C. От неё же — температура АКБ. */
  groundTemperatureC: number;
  /** Ветер на высоте windProfile.referenceHeightM над землёй; без профиля — на любой высоте. */
  wind: Wind;
  /**
   * Рост ветра с высотой по степенному закону V(h) = V_ref · (h / h_ref)^α.
   * Прогнозы дают ветер на 10 м; α ≈ 0.14 над открытой местностью, 0.2–0.3 над лесом.
   */
  windProfile?: { referenceHeightM: number; shearExponent: number };
  /**
   * Турбулентность: СКО пульсаций ветра на 10 м, м/с. Нет или 0 — ровный ветер.
   * Растёт в подветренной тени рельефа и над прогретыми склонами (turbulence.ts).
   */
  turbulenceMs?: number;
  /** Порывы на 10 м, м/с — из прогноза или фактической погоды. */
  gustMs?: number;
  /** Метеорологическая видимость, м. Нет — хорошая, больше 10 км. */
  visibilityM?: number;
  /** Осадки; нет или null — сухо. */
  precipitation?: { kind: 'drizzle' | 'rain' | 'sleet' | 'snow'; mmPerH: number } | null;
  /** Облачность 0…1 и нижняя граница облаков над площадкой, м — если известны из погоды. */
  cloudCover?: number;
  cloudBaseM?: number;
}

/** Рельеф: высота поверхности над уровнем моря. */
export interface Terrain {
  elevationM(p: GeoPoint): number;
}

/** То, что от нагрузки нужно энергетике. */
export interface PayloadLoad {
  massKg: number;
  powerW: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Площадка взлёта или посадки. */
export interface Site extends GeoPoint {
  /** Высота площадки над уровнем моря, м. */
  elevationM: number;
}

/** Точка маршрута в самолётном режиме. */
export interface Waypoint extends GeoPoint {
  /** Высота над уровнем моря, м. */
  altitudeM: number;
  /** Номер участка исходного маршрута, если точка добавлена при огибании рельефа. */
  routeLeg?: number;
}

export interface MissionPlan {
  takeoff: Site;
  landing: Site;
  /** Промежуточные точки. Маршрут: takeoff → waypoints… → landing. */
  waypoints: Waypoint[];
  /**
   * Приборная воздушная скорость — уставка автопилота, м/с. Автопилот держит
   * именно её (см. aircraft.ts), истинная на высоте больше.
   */
  iasMs: number;
  /** null — полёт без нагрузки. */
  payload: PayloadLoad | null;
  /** Рельеф: для ветра на высоте над землёй и проверки запаса высоты. Без него земля — на высоте площадки взлёта. */
  terrain?: Terrain;
  /** Подписи участков маршрута по номеру routeLeg: «Галс 3 из 13», «Разворот». */
  legLabels?: string[];
}

/** Фаза с фиксированной длительностью и мощностью (взлёт, переход, посадка). */
export interface Phase {
  name: string;
  durationS: number;
  powerW: number;
  energyWh: number;
}

export interface SegmentResult {
  from: Waypoint;
  to: Waypoint;
  distanceM: number;
  trackDeg: number;
  trueAirspeedMs: number;
  /** Ветер на высоте сегмента над рельефом. */
  wind: Wind;
  /** Угол сноса, градусы. Положительный — нос вправо от линии пути. */
  driftDeg: number;
  groundSpeedMs: number;
  /** Средняя вертикальная скорость на сегменте, м/с. */
  verticalSpeedMs: number;
  /** Крен по кривизне пути, градусы; не больше предельного. */
  bankDeg: number;
  durationS: number;
  /** Мощность на полёт, без нагрузки, Вт. */
  powerW: number;
  energyWh: number;
  /** Путевая скорость ≤ 0 или боковой ветер ≥ воздушной скорости: время и энергия — Infinity. */
  infeasible: boolean;
}

export interface EnergyBudget {
  /** Раскрутка на земле + вертикальный набор. */
  takeoffWh: number;
  /** Переход в самолётный режим. */
  transitionWh: number;
  cruiseWh: number;
  payloadWh: number;
  /** Вертикальное снижение + финальный участок. */
  landingWh: number;
  totalWh: number;
}

export interface MissionResult {
  takeoffPhases: Phase[];
  transition: Phase;
  segments: SegmentResult[];
  landingPhases: Phase[];
  budget: EnergyBudget;
  distanceM: number;
  durationS: number;
  /** Ёмкость АКБ при температуре у земли, до вычета аварийного запаса, Вт·ч. */
  capacityWh: number;
  /** Доступно на задание: capacityWh · (1 − reserve), Вт·ч. */
  usableWh: number;
  /** usableWh − totalWh. Отрицательный — до посадки не хватит. */
  marginWh: number;
  /** Остаток заряда на посадке, доля от capacityWh. */
  socAtLanding: number;
  /** Наименьшая высота над рельефом на самолётном участке, м; Infinity без рельефа. */
  minClearanceM: number;
  feasible: boolean;
  /** Почему задание невыполнимо; пусто, если feasible. */
  issues: string[];
}
