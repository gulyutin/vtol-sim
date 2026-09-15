import { PROFILE } from '@profile';
import type { LocationSpec, RegionSpec } from '../sim/profile';
import type { GeoPoint } from '../sim/types';
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
  search: {
    title: 'Поиск туриста у Чегета',
    briefing:
      'Турист отстал от группы на спуске с Чегета и не вышел к Терсколу. Вероятный район — сосняк на склоне над долиной Баксана у Терскола, около 0,9 × 0,9 км. Облететь район с тепловизором и отметить найденного человека. Медведи, волки и олени тоже тёплые — отличайте их по размеру, форме и повадке.',
    area: [
      { lat: 43.2535, lon: 42.5145 },
      { lat: 43.2615, lon: 42.5145 },
      { lat: 43.2615, lon: 42.5255 },
      { lat: 43.2535, lon: 42.5255 },
    ],
    animals: { bear: 1, wolf: 2, deer: 2 },
  },
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
  search: {
    title: 'Поиск туриста у Вудъявра',
    briefing:
      'Турист не вернулся с маршрута у озера Большой Вудъявр. Вероятный район — редколесье на склоне между Кировском и озером, около 0,9 × 0,9 км. Облететь район с тепловизором и отметить найденного человека. Медведи, волки, лоси и северные олени тоже тёплые — отличайте их по размеру, форме и повадке.',
    area: [
      { lat: 67.5935, lon: 33.6494 },
      { lat: 67.6015, lon: 33.6494 },
      { lat: 67.6015, lon: 33.6706 },
      { lat: 67.5935, lon: 33.6706 },
    ],
    animals: { bear: 1, wolf: 1, moose: 2, deer: 3 },
  },
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
  search: {
    title: 'Поиск туриста на Ольхоне',
    briefing:
      'Турист ушёл от Харанцов в лес на восточных склонах острова и не вернулся. Вероятный район — лиственничный лес к востоку от аэродрома, около 0,9 × 0,9 км. Облететь район с тепловизором и отметить найденного человека. Косули тоже тёплые — отличайте их по размеру и форме.',
    area: [
      { lat: 53.216, lon: 107.4198 },
      { lat: 53.224, lon: 107.4198 },
      { lat: 53.224, lon: 107.4333 },
      { lat: 53.216, lon: 107.4333 },
    ],
    // Остров: крупных хищников нет — косули.
    animals: { deer: 1 },
  },
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

const STORAGE_KEY = 'vtol-sim.region';

/** Ядро собирается без DOM-типов: адрес и хранилище берём через globalThis, если они есть. */
interface Env {
  location?: { search: string };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}
const env = () => globalThis as unknown as Env;

/** Место полёта из бортового журнала (src/game/logRegion.ts): район строится по записи и хранится в браузере. */
export const LOG_REGION_ID = 'log';
const LOG_REGION_KEY = 'vtol-sim.logRegion';

/** Запас рельефа и снимков вокруг траектории журнала и наименьшая сторона области, м — как у готовых районов. */
const LOG_MARGIN_M = 8000;
const LOG_MIN_SIZE_M = 30_000;

/**
 * Область места полёта для сцены: траектория (область из журнала) с запасом, не меньше LOG_MIN_SIZE_M
 * по стороне. С высоты полёта видно на десятки километров: иначе за краем области — плоская заглушка.
 */
function sceneBounds(b: LocationSpec['region']): LocationSpec['region'] {
  const lat0 = (b.south + b.north) / 2;
  const lon0 = (b.west + b.east) / 2;
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const halfLat = Math.max((b.north - b.south) / 2 + LOG_MARGIN_M / mLat, LOG_MIN_SIZE_M / 2 / mLat);
  const halfLon = Math.max((b.east - b.west) / 2 + LOG_MARGIN_M / mLon, LOG_MIN_SIZE_M / 2 / mLon);
  return { south: lat0 - halfLat, north: lat0 + halfLat, west: lon0 - halfLon, east: lon0 + halfLon };
}

function storedLogRegion(): RegionPreset | null {
  try {
    const raw = env().localStorage?.getItem(LOG_REGION_KEY);
    const r = raw ? (JSON.parse(raw) as RegionPreset) : null;
    if (!(r && r.id === LOG_REGION_ID && typeof r.location?.site?.lat === 'number' && r.location.region)) return null;
    return { ...r, location: { ...r.location, region: sceneBounds(r.location.region) } };
  } catch {
    return null;
  }
}

/** Запомнить место полёта из журнала как район; переходит туда setRegion(LOG_REGION_ID). */
export function saveLogRegion(r: RegionPreset): void {
  env().localStorage?.setItem(LOG_REGION_KEY, JSON.stringify(r));
}

const LOG_REGION = storedLogRegion();

/**
 * Кутурчинское Белогорье (Восточный Саян): тайга по склонам и гольцы до ~1640 м (по плиткам высот
 * Terrarium). Площадка — у посёлка Кутурчин в долине одноимённой реки, ~540 м. Готового файла OSM
 * нет: дома и лес собираются в браузере (src/ui/placeOsm.ts).
 */
const KUTURCHIN: LocationSpec = {
  regionName: 'Кутурчинское Белогорье',
  site: { lat: 54.9362, lon: 94.2148 },
  siteName: 'площадка у посёлка Кутурчин',
  region: { south: 54.76, west: 94.0, north: 55.08, east: 94.5 },
  // Конец сентября: прохладно — у тепловизора хороший контраст; день ещё длинный.
  date: '2026-09-20',
  utcOffsetH: 7,
  localHour: 10,
  windSpeedMs: 3,
  windFromDeg: 260,
  temperatureC: 8,
  // Склоны за первой грядой из долины не видно: мачта на гольце видит и площадку, и район поиска.
  relays: [{ kind: 'ground', lat: 54.836, lon: 94.165, antennaM: 10, name: 'на гольце к юго-западу' }],
  // Район поиска — на один заряд: при полосе тепловизора ~70 м и перелёте туда-обратно — около 1 км².
  search: {
    title: 'Поиск пропавших в тайге',
    briefing:
      'Двое ушли за ягодой и не вернулись к ночи. Вероятный район — таёжный склон над долиной Кутурчина в 3,5 км к югу от посёлка, около 0,9 × 0,9 км; выше по склонам — курумник и гольцы. Облететь район с тепловизором и отметить найденных людей. Медведи, волки, лоси и олени тоже тёплые — отличайте их по размеру, форме и повадке.',
    // Нижняя часть склона (~650–800 м): к гольцам на 1300–1600 м с подветренными потоками на один
    // заряд не хватает — туда и обратно с кругами набора батарея кончается на посадке.
    area: [
      { lat: 54.901, lon: 94.208 },
      { lat: 54.909, lon: 94.208 },
      { lat: 54.909, lon: 94.222 },
      { lat: 54.901, lon: 94.222 },
    ],
    // Саянская тайга: медведь, волк, лось, марал.
    animals: { bear: 2, wolf: 2, moose: 2, deer: 2 },
  },
  survey: {
    title: 'Аэрофотосъёмка у посёлка',
    briefing: 'Ортофотоплан участка 1,6 × 1,1 км в долине у посёлка Кутурчин штатной камерой. Нужно GSD не хуже 4 см и не меньше 5 годных кадров на 95 % участка.',
    area: [
      { lat: 54.94, lon: 94.23 },
      { lat: 54.95, lon: 94.23 },
      { lat: 54.95, lon: 94.255 },
      { lat: 54.94, lon: 94.255 },
    ],
  },
  delivery: {
    title: 'Доставка в верховья Кутурчина',
    briefing: 'Отвезти груз поисковой группе в верховья реки Кутурчин — 7,5 км на юг, вверх по долине. Сесть, разгрузиться и вернуться. Обратно аппарат легче на массу груза.',
    destination: { lat: 54.8695, lon: 94.2462 },
    destinationName: 'верховья Кутурчина',
    route: [{ lat: 54.905, lon: 94.235, heightAglM: 150 }],
  },
  transfer: {
    title: 'Перелёт А → Б',
    briefing: 'Перелёт от посёлка Кутурчин (А) на площадку Б к юго-востоку, через отроги Белогорья. Точку Б можно перетащить на карте.',
    destination: { lat: 54.86, lon: 94.33 },
    destinationName: 'площадка Б',
    route: [{ lat: 54.9, lon: 94.28, heightAglM: 200 }],
  },
  route: {
    briefing: 'Свободный маршрут от посёлка Кутурчин: поставьте точки на карте и задайте высоту над рельефом для каждой. Склоны крутые — высоту над гольцами берите с запасом. Посадка — на площадке.',
    route: [
      { lat: 54.91, lon: 94.17, heightAglM: 200 },
      { lat: 54.88, lon: 94.14, heightAglM: 250 },
      { lat: 54.87, lon: 94.2, heightAglM: 250 },
      { lat: 54.9, lon: 94.24, heightAglM: 200 },
    ],
  },
};

/** Все районы; первый — домашний, за ним — дополнительные районы профиля, в конце — место полёта из журнала. */
export const REGION_PRESETS: readonly RegionPreset[] = [
  HOME,
  ...(PROFILE.regions ?? []),
  { id: 'elbrus', title: 'Приэльбрусье', hint: 'Высокогорье: узкая долина Баксана под Эльбрусом, площадка на 1880 м', location: ELBRUS, osmUrl: elbrusOsm },
  { id: 'khibiny', title: 'Хибины', hint: 'Горы до 1200 м за Полярным кругом, полярный день; площадка на 230 м', location: KHIBINY, osmUrl: khibinyOsm },
  { id: 'baikal', title: 'Байкал — Малое Море', hint: 'Ольхон: вода, скалистые берега, степь; площадка на 490 м', location: BAIKAL, osmUrl: baikalOsm },
  { id: 'kuturchin', title: 'Кутурчинское Белогорье', hint: 'Тайга и гольцы Восточного Саяна до 1640 м: поиск людей с тепловизором; площадка в долине, 540 м', location: KUTURCHIN },
  ...(LOG_REGION ? [LOG_REGION] : []),
];

/** Для выбора в интерфейсе. */
export const REGIONS: readonly { id: string; title: string; hint: string }[] = REGION_PRESETS.map(({ id, title, hint }) => ({ id, title, hint }));

export const findRegion = (id: string): RegionPreset | undefined => REGION_PRESETS.find((r) => r.id === id);

/**
 * Район с домами и лесом (файл OSM), в который попадает точка, — для места полёта из журнала:
 * если журнал записан внутри готового района, дома и лес берутся оттуда.
 */
export function osmRegionFor(p: GeoPoint): RegionPreset | undefined {
  return REGION_PRESETS.find((r) => {
    const b = r.location.region;
    return r.id !== LOG_REGION_ID && r.osmUrl && p.lat > b.south && p.lat < b.north && p.lon > b.west && p.lon < b.east;
  });
}

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
