import { PROFILE } from '@profile';
import type { LocationSpec, RegionSpec } from '../sim/profile';
import baikalOsm from '../regions/baikal.osm.bin?url';
import elbrusOsm from '../regions/elbrus.osm.bin?url';
import khibinyOsm from '../regions/khibiny.osm.bin?url';

/*
 * Районы заданий: «домашний» из профиля, дополнительные районы профиля (PROFILE.regions) и
 * готовые районы с разным рельефом. Рельеф и снимки грузятся для любого места; к району
 * привязаны площадка, задания и файл OSM.
 * Выбор района — ?region=<id> в адресе или последний выбор (localStorage); смена — перезагрузкой.
 */

export type RegionPreset = RegionSpec;

const HOME: RegionPreset = {
  id: 'home',
  title: PROFILE.location.regionName ?? 'Район профиля',
  hint: `Район профиля: ${PROFILE.location.siteName}`,
  location: PROFILE.location,
  osmUrl: PROFILE.osmUrl,
};

/** Приэльбрусье: верховья Баксана, вертолётная площадка Тегенекли. */
const ELBRUS: LocationSpec = {
  regionName: 'Приэльбрусье',
  site: { lat: 43.247, lon: 42.6 },
  siteName: 'площадка Тегенекли',
  region: { south: 43.15, west: 42.35, north: 43.45, east: 42.85 },
  date: '2026-07-10',
  utcOffsetH: 3,
  // Днём ветер тянет вверх по долине; разгон и заход — вдоль неё.
  windSpeedMs: 3,
  windFromDeg: 85,
  temperatureC: 14,
  // Долина Баксана петляет: вниз к Верхнему Баксану и вверх к Нарзанам борт уходит за склоны.
  relays: [
    { kind: 'ground', lat: 43.2579, lon: 42.628, antennaM: 10, name: 'на гребне между Тегенекли и посёлком Эльбрус' },
    { kind: 'ground', lat: 43.259, lon: 42.4694, antennaM: 10, name: 'на гребне Азаучегеткарабаши над поляной Азау' },
  ],
  survey: {
    title: 'Аэрофотосъёмка поймы Баксана',
    briefing: 'Ортофотоплан полосы поймы 1,6 × 0,2 км между Чегетом и поляной Нарзанов штатной камерой. Нужно GSD не хуже 4 см и не меньше 5 годных кадров на 95 % участка.',
    area: [
      { lat: 43.2465, lon: 42.53 },
      { lat: 43.2485, lon: 42.53 },
      { lat: 43.2485, lon: 42.55 },
      { lat: 43.2465, lon: 42.55 },
    ],
  },
  delivery: {
    title: 'Доставка на поляну Нарзанов',
    briefing: 'Отвезти груз вверх по долине Баксана на поляну Нарзанов — площадка там на сотню метров выше. Сесть, разгрузиться и вернуться. Обратно аппарат легче на массу груза.',
    destination: { lat: 43.2468, lon: 42.558 },
    destinationName: 'поляна Нарзанов',
    route: [{ lat: 43.2485, lon: 42.578, heightAglM: 150 }],
  },
  transfer: {
    title: 'Перелёт А → Б',
    briefing: 'Перелёт с площадки Тегенекли (А) вниз по долине Баксана, мимо посёлка Эльбрус, на площадку Б у Верхнего Баксана: взлёт в А, промежуточные точки — свои, посадка в Б. Точку Б можно перетащить на карте.',
    destination: { lat: 43.3058, lon: 42.7468 },
    destinationName: 'площадка Б',
    route: [
      { lat: 43.2505, lon: 42.628, heightAglM: 150 },
      { lat: 43.262, lon: 42.655, heightAglM: 150 },
      { lat: 43.282, lon: 42.694, heightAglM: 150 },
      { lat: 43.2965, lon: 42.718, heightAglM: 150 },
    ],
  },
  route: {
    briefing: 'Свободный маршрут по долине Баксана: поставьте точки на карте и задайте высоту над рельефом для каждой. Долина узкая — развороты ставьте там, где она шире. Маршрут можно менять и в полёте. Посадка — на площадке.',
    route: [
      { lat: 43.2495, lon: 42.628, heightAglM: 150 },
      { lat: 43.262, lon: 42.655, heightAglM: 200 },
      { lat: 43.2495, lon: 42.62, heightAglM: 150 },
      { lat: 43.2485, lon: 42.575, heightAglM: 150 },
      { lat: 43.2475, lon: 42.53, heightAglM: 150 },
    ],
  },
};

/** Хибины: аэродром между Апатитами и Кировском, долина Вудъявра, озеро Имандра. */
const KHIBINY: LocationSpec = {
  regionName: 'Хибины',
  site: { lat: 67.577, lon: 33.5804 },
  siteName: 'аэродром Кировск',
  region: { south: 67.5, west: 33.25, north: 67.8, east: 33.75 },
  date: '2026-06-24',
  utcOffsetH: 3,
  windSpeedMs: 4,
  windFromDeg: 10,
  temperatureC: 13,
  // Долина Вудъявра закрыта от аэродрома отрогами Айкуайвенчорра.
  relays: [
    { kind: 'ground', lat: 67.6199, lon: 33.7206, antennaM: 10, name: 'на вершине над Северным склоном у Кировска' },
    { kind: 'ground', lat: 67.6565, lon: 33.6473, antennaM: 10, name: 'на отроге у дороги в Ботанический цирк' },
  ],
  survey: {
    title: 'Аэрофотосъёмка участка',
    briefing: 'Ортофотоплан участка 1,6 × 1,1 км между Апатитами и аэродромом штатной камерой. Нужно GSD не хуже 4 см и не меньше 5 годных кадров на 95 % участка.',
    area: [
      { lat: 67.5823, lon: 33.5122 },
      { lat: 67.5922, lon: 33.5122 },
      { lat: 67.5922, lon: 33.55 },
      { lat: 67.5823, lon: 33.55 },
    ],
  },
  delivery: {
    title: 'Доставка на Имандру',
    briefing: 'Отвезти груз с аэродрома в Тик-Губу на берегу Имандры, мимо Апатитов. Сесть, разгрузиться и вернуться. Обратно аппарат легче на массу груза.',
    destination: { lat: 67.5548, lon: 33.3359 },
    destinationName: 'Тик-Губа',
    route: [{ lat: 67.57, lon: 33.47, heightAglM: 150 }],
  },
  transfer: {
    title: 'Перелёт А → Б',
    briefing: 'Перелёт с аэродрома (А) мимо Кировска и озера Большой Вудъявр на площадку Б в долине между горами. Точку Б можно перетащить на карте.',
    destination: { lat: 67.668, lon: 33.645 },
    destinationName: 'площадка Б',
    route: [{ lat: 67.632, lon: 33.672, heightAglM: 150 }],
  },
  route: {
    briefing: 'Свободный маршрут от аэродрома: поставьте точки на карте и задайте высоту над рельефом для каждой. Маршрут можно менять и в полёте. Посадка — на аэродроме.',
    route: [
      { lat: 67.55, lon: 33.45, heightAglM: 150 },
      { lat: 67.6, lon: 33.36, heightAglM: 150 },
      { lat: 67.645, lon: 33.47, heightAglM: 200 },
      { lat: 67.62, lon: 33.62, heightAglM: 200 },
    ],
  },
};

/** Байкал: остров Ольхон, аэродром Харанцы, Малое Море. */
const BAIKAL: LocationSpec = {
  regionName: 'Байкал — Малое Море',
  site: { lat: 53.2187, lon: 107.4094 },
  siteName: 'аэродром Харанцы',
  region: { south: 52.98, west: 106.94, north: 53.28, east: 107.44 },
  date: '2026-07-20',
  utcOffsetH: 8,
  windSpeedMs: 4,
  windFromDeg: 300,
  temperatureC: 18,
  // Ялга за сопками Ольхона: с аэродрома её не видно ни в воздухе на подходе, ни на земле.
  relays: [{ kind: 'ground', lat: 53.1689, lon: 107.2503, antennaM: 10, name: 'на сопке у мыса Хужиртуй' }],
  survey: {
    title: 'Аэрофотосъёмка берега',
    briefing: 'Ортофотоплан участка 1,6 × 1,1 км на берегу Малого Моря между Хужиром и Харанцами штатной камерой. Нужно GSD не хуже 4 см и не меньше 5 годных кадров на 95 % участка.',
    area: [
      { lat: 53.212, lon: 107.372 },
      { lat: 53.222, lon: 107.372 },
      { lat: 53.222, lon: 107.396 },
      { lat: 53.212, lon: 107.396 },
    ],
  },
  delivery: {
    title: 'Доставка в Ялгу',
    briefing: 'Отвезти груз с аэродрома вдоль берега Малого Моря мимо Хужира в Ялгу. Сесть, разгрузиться и вернуться. Обратно аппарат легче на массу груза.',
    destination: { lat: 53.1417, lon: 107.17 },
    destinationName: 'Ялга',
    route: [{ lat: 53.185, lon: 107.3, heightAglM: 150 }],
  },
  transfer: {
    title: 'Перелёт А → Б',
    briefing: 'Перелёт с Ольхона (А) через Малое Море на площадку Б на материковом берегу: взлёт в А, промежуточные точки — свои, посадка в Б. Точку Б можно перетащить на карте.',
    destination: { lat: 53.1963, lon: 106.9808 },
    destinationName: 'площадка Б',
    route: [{ lat: 53.21, lon: 107.2, heightAglM: 150 }],
  },
  route: {
    briefing: 'Свободный маршрут над Малым Морем от аэродрома: поставьте точки на карте и задайте высоту над рельефом для каждой. Маршрут можно менять и в полёте. Посадка — на аэродроме.',
    route: [
      { lat: 53.245, lon: 107.3, heightAglM: 150 },
      { lat: 53.21, lon: 107.15, heightAglM: 150 },
      { lat: 53.165, lon: 107.14, heightAglM: 150 },
      { lat: 53.175, lon: 107.28, heightAglM: 150 },
    ],
  },
};

/** Все районы; первый — домашний, за ним — дополнительные районы профиля. */
export const REGION_PRESETS: readonly RegionPreset[] = [
  HOME,
  ...(PROFILE.regions ?? []),
  { id: 'elbrus', title: 'Приэльбрусье', hint: 'Высокогорье: узкая долина Баксана под Эльбрусом, площадка на 1880 м', location: ELBRUS, osmUrl: elbrusOsm },
  { id: 'khibiny', title: 'Хибины', hint: 'Горы до 1200 м за Полярным кругом, полярный день; площадка на 230 м', location: KHIBINY, osmUrl: khibinyOsm },
  { id: 'baikal', title: 'Байкал — Малое Море', hint: 'Ольхон: вода, скалистые берега, степь; площадка на 490 м', location: BAIKAL, osmUrl: baikalOsm },
];

/** Для выбора в интерфейсе. */
export const REGIONS: readonly { id: string; title: string; hint: string }[] = REGION_PRESETS.map(({ id, title, hint }) => ({ id, title, hint }));

const STORAGE_KEY = 'vtol-sim.region';

/** Ядро собирается без DOM-типов: адрес и хранилище берём через globalThis, если они есть. */
interface Env {
  location?: { search: string };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}
const env = () => globalThis as unknown as Env;

export const findRegion = (id: string): RegionPreset | undefined => REGION_PRESETS.find((r) => r.id === id);

/** Выбранный район: ?region=<id> в адресе, иначе последний выбор, иначе домашний. */
export function activeRegion(): RegionPreset {
  let id: string | null = null;
  try {
    const m = /[?&]region=([^&#]*)/.exec(env().location?.search ?? '');
    id = m ? decodeURIComponent(m[1]!) : (env().localStorage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    // Хранилище недоступно (приватный режим) — домашний район.
  }
  return (id && findRegion(id)) || HOME;
}

/** Запомнить выбор и перезагрузить страницу с ?region=<id>. */
export function setRegion(id: string): void {
  const e = env();
  try {
    e.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // Без хранилища выбор держится только в адресе.
  }
  if (!e.location) return;
  const rest = e.location.search
    .replace(/^\?/, '')
    .split('&')
    .filter((p) => p && !p.startsWith('region='));
  e.location.search = '?' + [...rest, `region=${encodeURIComponent(id)}`].join('&');
}
