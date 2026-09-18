/*
 * Раскладка пульта ДУ: какая ось — какая ручка, инверсия и калибровка хода (src/ui/pilotInput.ts,
 * окно «Пульт ДУ» — src/ui/rcSetup.ts).
 */

/** Ось пульта для ручки: номер, инверсия и калибровка хода (упоры и середина в сырых значениях). */
export interface AxisMap {
  index: number;
  invert: boolean;
  min: number;
  center: number;
  max: number;
}

export interface RcMapping {
  roll: AxisMap;
  pitch: AxisMap;
  yaw: AxisMap;
  throttle: AxisMap;
  deadzone: number;
  expo: number;
}

const axisMap = (index: number, invert = false): AxisMap => ({ index, invert, min: -1, center: 0, max: 1 });

/** Раскладка по умолчанию: геймпад — режим 2, пульт — AETR. */
export function defaultMapping(standard: boolean): RcMapping {
  return standard
    ? { roll: axisMap(2), pitch: axisMap(3, true), yaw: axisMap(0), throttle: axisMap(1, true), deadzone: 0.08, expo: 0.3 }
    : { roll: axisMap(0), pitch: axisMap(1), yaw: axisMap(3), throttle: axisMap(2), deadzone: 0.03, expo: 0.2 };
}

/** Сырое значение оси → −1…1 по калибровке (середина — 0), с инверсией. */
export function axisValue(raw: number, m: AxisMap): number {
  const v = raw >= m.center ? (raw - m.center) / Math.max(1e-3, m.max - m.center) : (raw - m.center) / Math.max(1e-3, m.center - m.min);
  const c = Math.max(-1, Math.min(1, v));
  return m.invert ? -c : c;
}
