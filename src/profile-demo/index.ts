import type { Profile } from '../sim/profile';
import osmUrl from './osm.bin?url';

/*
 * Демо-профиль: условный VTOL-самолёт схемы «4 + 1» массой около 15 кг. Числа правдоподобные,
 * но не относятся к конкретному аппарату. Свой профиль подключается как private/profile/index.ts
 * с тем же типом Profile.
 */

const TAKEOFF_MASS_REF_KG = 15;
const PAYLOAD_REF_KG = 1.0;

export const PROFILE: Profile = {
  title: 'VTOL-симулятор миссии',
  modelName: 'aircraft',
  osmUrl,

  cruiseReference: { iasMs: 22, powerW: 950, massKg: TAKEOFF_MASS_REF_KG, air: { altitudeM: 300, temperatureC: 15 } },
  hoverReference: { rotorPowerW: 2600, massKg: TAKEOFF_MASS_REF_KG, air: { altitudeM: 150, temperatureC: 15 } },

  aircraft: {
    wingSpanM: 3.0,
    wingAreaM2: 0.62,
    oswald: 0.8,
    /** calibrateCd0(cruiseReference). */
    cd0: 0.1209,

    takeoffMassRefKg: TAKEOFF_MASS_REF_KG,
    payloadRefKg: PAYLOAD_REF_KG,
    emptyMassKg: TAKEOFF_MASS_REF_KG - PAYLOAD_REF_KG,
    payloadMaxKg: 2.5,

    batteryWh: 1000,
    batteryRefTemperatureC: 20,
    voltageFullV: 50,
    voltage10PctV: 40,
    reserve: 0.1,
    batteryTemperatureDerate: [
      [-30, 0.6],
      [-20, 0.72],
      [-10, 0.82],
      [0, 0.91],
      [25, 1.0],
    ],

    etaDrive: 0.6,
    etaElec: 0.9,
    idlePowerPlaneW: 70,
    etaClimb: 0.5,
    planeClimbRateMaxMs: 2.5,
    planeDescentRateMaxMs: 2,
    minClearanceM: 30,
    maxBankDeg: 28,

    rotorCount: 4,
    rotorDiameterM: 0.4,
    /** calibrateFigureOfMerit(hoverReference). */
    figureOfMerit: 0.6932,
    auxPowerHoverW: 500,

    transitionLowIasMs: 14,
    transitionHighIasMs: 18,
    cruiseIasMs: 22,

    limits: {
      mtowKg: 16.5,
      maxIasMs: 110 / 3.6,
      maxGroundSpeedMs: 150 / 3.6,
      maxBankDeg: 35,
      maxPitchDeg: 30,
      maxAltitudeM: 3000,
      windMaxMs: 12,
      gustMaxMs: 15,
      takeoffAnyWindMs: 5,
      minCloudBaseM: 250,
      temperatureMinC: -30,
      temperatureMaxC: 40,
      failsafeBankDeg: 60,
      failsafePitchDeg: 35,
      failsafeVzMs: 8,
      radioRangeM: 50_000,
      landingZoneRadiusM: 20,
    },

    procedures: {
      departureDistanceM: 300,
      minHoverHeightM: 35,
      approachLegM: 550,
      pusherOffBeforeLandingM: 200,
    },

    vtol: {
      spoolUpS: 8,
      spoolUpFactor: 0.45,
      transitionHeightM: 40,
      climbRateMs: 2.0,
      climbFactor: 1.1,
      transitionS: 8,
      transitionFactor: 1.08,
      backTransitionHeightM: 45,
      descentRateMs: 1.2,
      descentFactor: 0.97,
      finalHeightM: 5,
      finalS: 10,
    },
  },

  camera: {
    id: 'std24',
    name: 'Штатная камера 24 Мп, 21 мм',
    massKg: 1.0,
    powerW: 30,
    focalLengthMm: 21,
    pixelPitchUm: 3.9,
    widthPx: 6000,
    heightPx: 4000,
    fNumber: 5.6,
    isoMax: 3200,
    minIntervalS: 1.0,
    frameMB: 25,
    stabilizedYaw: true,
  },

  location: {
    site: { lat: 54.7878, lon: 37.6458 },
    siteName: 'аэродром Большое Грызлово',
    region: { south: 54.64, west: 37.4, north: 54.96, east: 37.9 },
    date: '2026-06-20',
    utcOffsetH: 3,
    windSpeedMs: 4,
    windFromDeg: 250,
    temperatureC: 20,
    survey: {
      title: 'Аэрофотосъёмка склона',
      briefing: 'Ортофотоплан участка 1,6 × 1,1 км на склоне долины Оки штатной камерой. Нужно GSD не хуже 4 см и не меньше 5 годных кадров на 95 % участка.',
      area: [
        { lat: 54.812, lon: 37.68 },
        { lat: 54.822, lon: 37.68 },
        { lat: 54.822, lon: 37.7 },
        { lat: 54.818, lon: 37.706 },
        { lat: 54.812, lon: 37.706 },
      ],
    },
    delivery: {
      title: 'Доставка за Оку',
      briefing: 'Отвезти груз с аэродрома в пункт доставки за долиной Оки. Сесть, разгрузиться и вернуться. Обратно аппарат легче на массу груза.',
      destination: { lat: 54.9, lon: 37.55 },
      destinationName: 'пункт доставки',
      route: [{ lat: 54.85, lon: 37.6, heightAglM: 150 }],
    },
    transfer: {
      title: 'Перелёт А → Б',
      briefing:
        'Перелёт с аэродрома (А) на площадку Б к северо-востоку, за долиной Оки: взлёт в А, промежуточные точки — свои, посадка в Б. Точку Б можно перетащить на карте.',
      destination: { lat: 54.905, lon: 37.8 },
      destinationName: 'площадка Б',
      route: [{ lat: 54.85, lon: 37.72, heightAglM: 150 }],
    },
    route: {
      briefing:
        'Свободный маршрут от аэродрома: поставьте точки на карте и задайте высоту над рельефом для каждой. Маршрут можно менять и в полёте. Посадка — на аэродроме.',
      route: [
        { lat: 54.84, lon: 37.6, heightAglM: 150 },
        { lat: 54.87, lon: 37.7, heightAglM: 150 },
        { lat: 54.83, lon: 37.8, heightAglM: 200 },
        { lat: 54.76, lon: 37.75, heightAglM: 150 },
      ],
    },
  },
};
