import { AIRCRAFT } from '../sim/aircraft';
import { batteryDerate } from '../sim/atmosphere';

/*
 * Аккумуляторы расчёта: несколько АКБ, одна на аппарате, остальные — в машине или на зарядке.
 * У каждой — заряд, температура, число циклов и износ (ёмкость падает с циклами). Зарядка —
 * током до ~80 %, дальше ток спадает (постоянное напряжение); Li-ion заряжают только от 0 до
 * +45 °C: холодную после мороза — сначала отогреть, горячую после полёта — остудить. Ёмкость в
 * полёте — по износу и температуре самой батареи, не воздуха: зимой её держат в тепле.
 */

export type BatteryPlace = 'aircraft' | 'charger' | 'store';

export interface Battery {
  id: string;
  name: string;
  /** Заряд 0…1. */
  soc: number;
  tempC: number;
  /** Полных циклов (сумма разрядов в долях ёмкости). */
  cycles: number;
  /** Остаточная ёмкость от новой 0…1. */
  health: number;
  place: BatteryPlace;
}

export interface BatteryParkState {
  batteries: Battery[];
  /** Хранить запасные в тепле (в машине), а не на улице. */
  warmStore: boolean;
}

/** Мест на зарядном устройстве. */
export const CHARGER_SLOTS = 2;
/** Ток зарядки в долях ёмкости в час (0,8C): полная зарядка — чуть больше часа. */
const CHARGE_C = 0.8;
/** Выше этого заряда ток спадает. */
const CV_FROM = 0.8;
/** Заряжать можно от и до, °C. */
export const CHARGE_MIN_C = 0;
export const CHARGE_MAX_C = 45;
/** Температура: постоянная времени, с; в машине с печкой; нагрев при зарядке и в полёте. */
const TEMP_TAU_S = 1200;
const WARM_STORE_C = 20;
const CHARGE_HEAT_C = 8;
/** Износ: к 500 циклам ёмкость — 80 % от новой. */
const WEAR_PER_CYCLE = 0.2 / 500;

export function newPark(n: number, ambientC: number): BatteryParkState {
  const batteries: Battery[] = Array.from({ length: n }, (_, i) => ({
    id: `b${i + 1}`,
    name: `АКБ-${i + 1}`,
    soc: 1,
    tempC: Math.max(ambientC, WARM_STORE_C),
    cycles: 20 + 37 * i,
    health: 1 - WEAR_PER_CYCLE * (20 + 37 * i),
    place: i === 0 ? 'aircraft' : 'store',
  }));
  return { batteries, warmStore: true };
}

export const installed = (p: BatteryParkState): Battery | null => p.batteries.find((b) => b.place === 'aircraft') ?? null;

/** Доступная ёмкость батареи при её температуре, Вт·ч. */
export function capacityWh(b: Battery): number {
  return (AIRCRAFT.batteryWh * b.health * batteryDerate(b.tempC)) / batteryDerate(AIRCRAFT.batteryRefTemperatureC);
}

/** Почему батарею сейчас не заряжают (или null — заряжается). */
export function chargeBlock(b: Battery): string | null {
  if (b.soc >= 0.99) return 'заряжена';
  if (b.tempC < CHARGE_MIN_C) return `холодная (${Math.round(b.tempC)} °C) — ниже ${CHARGE_MIN_C} °C не заряжают, отогреть`;
  if (b.tempC > CHARGE_MAX_C) return `горячая (${Math.round(b.tempC)} °C) — остынет и начнёт заряжаться`;
  return null;
}

/** Сколько секунд до полной зарядки при нынешней температуре (грубо). */
export function chargeEtaS(b: Battery): number {
  const rate = CHARGE_C / 3600;
  const cc = Math.max(0, CV_FROM - b.soc) / rate;
  // Спадающий ток: недозаряд уменьшается экспоненциально; зарядное отключается у 99 %.
  const cv = b.soc < 0.99 ? (Math.log((1 - Math.max(b.soc, CV_FROM)) / 0.01) * (1 - CV_FROM)) / rate : 0;
  return cc + Math.max(0, cv);
}

/**
 * Время на земле dtS: зарядка на местах зарядного, температура стремится к месту хранения
 * (в машине с печкой — к +20 °C, на улице — к воздуху), на зарядке батарея немного греется.
 * Батарея на аппарате, пока он стоит (onGround), — на улице; в полёте её ведёт полёт.
 */
export function tickPark(p: BatteryParkState, dtS: number, ambientC: number, onGround = true): void {
  if (!(dtS > 0)) return;
  // Долгое ожидание — по минуте: батарея успевает отогреться и начать заряжаться.
  if (dtS > 60) {
    for (let left = dtS; left > 0; left -= 60) tickPark(p, Math.min(60, left), ambientC, onGround);
    return;
  }
  const k = 1 - Math.exp(-dtS / TEMP_TAU_S);
  for (const b of p.batteries) {
    if (b.place === 'aircraft') {
      if (onGround) b.tempC += (ambientC - b.tempC) * k;
      continue;
    }
    const charging = b.place === 'charger' && chargeBlock(b) === null;
    const base = p.warmStore ? WARM_STORE_C : ambientC;
    const target = base + (charging ? CHARGE_HEAT_C : 0);
    b.tempC += (target - b.tempC) * k;
    if (charging) {
      const rate = CHARGE_C / 3600;
      if (b.soc < CV_FROM) b.soc = Math.min(1, b.soc + rate * dtS);
      else b.soc = 1 - (1 - b.soc) * Math.exp((-rate * dtS) / (1 - CV_FROM));
      if (b.soc >= 0.99) b.soc = 1;
    }
  }
}

/** Батарею на аппарат: прежняя уходит на хранение. На земле, без АРМ. */
export function install(p: BatteryParkState, id: string): void {
  const b = p.batteries.find((x) => x.id === id);
  if (!b || b.place === 'aircraft') return;
  for (const x of p.batteries) if (x.place === 'aircraft') x.place = 'store';
  b.place = 'aircraft';
}

/** На зарядку или снять с неё (в машину); мест на зарядном — CHARGER_SLOTS. */
export function toggleCharger(p: BatteryParkState, id: string): void {
  const b = p.batteries.find((x) => x.id === id);
  if (!b || b.place === 'aircraft') return;
  if (b.place === 'charger') {
    b.place = 'store';
    return;
  }
  if (p.batteries.filter((x) => x.place === 'charger').length >= CHARGER_SLOTS) return;
  b.place = 'charger';
}

/**
 * Итог полёта для батареи на аппарате: заряд по израсходованному, циклы и износ; нагрев — от
 * нагрузки (сильнее, чем дольше и тяжелее летели); после аварии — ёмкость под вопросом.
 */
export function afterFlight(p: BatteryParkState, usedWh: number, capWh: number, airborneS: number, crashed: boolean): void {
  const b = installed(p);
  if (!b || !(usedWh > 0)) return;
  const share = Math.min(b.soc, usedWh / Math.max(1, capWh));
  b.soc = Math.max(0, b.soc - share);
  b.cycles += share;
  b.health = Math.max(0.5, b.health - WEAR_PER_CYCLE * share - (crashed ? 0.1 : 0));
  b.tempC += Math.min(25, 12 * share + airborneS / 240);
}

const STORE = 'vtol-battery-park';

export function loadPark(ambientC: number): BatteryParkState {
  try {
    const s = globalThis.localStorage?.getItem(STORE);
    if (s) {
      const p = JSON.parse(s) as BatteryParkState;
      if (Array.isArray(p.batteries) && p.batteries.length && p.batteries.some((b) => b.place === 'aircraft')) return p;
    }
  } catch {
    // Нет хранилища или испорчено — новый парк.
  }
  return newPark(3, ambientC);
}

export function savePark(p: BatteryParkState): void {
  try {
    globalThis.localStorage?.setItem(STORE, JSON.stringify(p));
  } catch {
    // Хранилище недоступно — парк живёт до перезагрузки.
  }
}
