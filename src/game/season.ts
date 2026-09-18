/*
 * Время года на земле: снежный покров, граница снега в горах, лёд на воде, голые лиственные и
 * осенняя листва — по дате, широте, температуре у площадки и высоте площадки. Для сцены (снег на
 * рельефе, деревьях, крышах, лёд на озёрах) и для выбора «Время года» в задании.
 */

export type SeasonId = 'region' | 'winter' | 'spring' | 'summer' | 'autumn';

export const SEASONS: readonly { id: SeasonId; title: string }[] = [
  { id: 'region', title: 'по дате района' },
  { id: 'winter', title: 'зима' },
  { id: 'spring', title: 'весна, сход снега' },
  { id: 'summer', title: 'лето' },
  { id: 'autumn', title: 'осень, жёлтая листва' },
];

/** День сезона (месяц-день) и типичная температура у земли днём, °C, — для средней полосы; севернее холоднее. */
const SEASON_DAY: Record<Exclude<SeasonId, 'region'>, { md: string; tempC: number }> = {
  winter: { md: '01-25', tempC: -12 },
  spring: { md: '04-18', tempC: 5 },
  summer: { md: '07-10', tempC: 21 },
  autumn: { md: '09-28', tempC: 8 },
};

/** Дата задания в выбранное время года: год — из даты района. */
export function seasonDate(regionDate: string, season: SeasonId | undefined): string {
  if (!season || season === 'region') return regionDate;
  return `${regionDate.slice(0, 4)}-${SEASON_DAY[season].md}`;
}

/** Типичная дневная температура у земли в это время года на широте lat, °C. */
export function seasonTemperatureC(season: Exclude<SeasonId, 'region'>, lat: number): number {
  const north = Math.max(0, lat - 55);
  const k = season === 'summer' ? 0.5 : season === 'winter' ? 0.6 : 0.8;
  return Math.round(SEASON_DAY[season].tempC - k * north);
}

export interface GroundSeason {
  /** Снежный покров на равнине у площадки, 0…1: 1 — сплошной, меньше — пятнами (сход или первый снег). */
  snow: number;
  /** Высота границы снега в горах, м над морем: выше — снег при любом покрове внизу. */
  snowLineM: number;
  /** Лёд на озёрах и реках, 0…1. */
  ice: number;
  /** Лиственные без листвы, 0…1. */
  bare: number;
  /** Осенняя листва, 0…1 (желтеет с начала сентября). */
  autumn: number;
}

const DAY_MS = 86_400_000;
const dayOfYear = (d: Date) => (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

/**
 * Земля в этот день. Сезон снега по широте: на 50° — с конца ноября до конца марта, на 62° — с конца
 * октября до конца апреля, за Полярным кругом — с середины октября до середины мая; две недели на
 * установление и сход. Тёплый день подтапливает, мороз держит. Граница снега в горах — там, где
 * средняя температура ниже нуля: от площадки вверх по стандартному градиенту 6,5 °C/км.
 */
export function groundSeason(date: string, lat: number, temperatureC: number, siteElevationM: number): GroundSeason {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return { snow: 0, snowLineM: 1e5, ice: 0, bare: 0, autumn: 0 };
  const doy = dayOfYear(d);
  const n = Math.max(0, lat - 50);
  const start = 330 - 3.2 * n; // первый устойчивый снег
  const end = 88 + 2.4 * n; // сход
  // Внутри сезона (через Новый год): 1, по краям — две недели на установление и сход.
  const settle = ramp(doy, start, start + 14);
  const melt = 1 - ramp(doy, end - 14, end);
  const winter = doy >= start ? settle : doy <= end ? melt : 0;
  // Оттепель съедает покров, мороз его держит.
  const warm = ramp(temperatureC, 1, 9);
  const snow = clamp01(winter * (1 - warm));
  // Лёд встаёт позже снега и сходит позже: нужен устойчивый мороз.
  const ice = clamp01((doy >= start ? ramp(doy, start + 10, start + 30) : doy <= end ? 1 - ramp(doy, end - 5, end + 12) : 0) * (1 - ramp(temperatureC, 3, 8)));
  // Листва: желтеет с начала сентября, облетает с середины октября, распускается в мае (южнее раньше).
  const up = ramp(doy, 243, 271);
  const fall = ramp(doy, 288 - 1.5 * n, 308 - 1.5 * n);
  const leafOut = 1 - ramp(doy, 118 + 2 * n, 140 + 2 * n);
  const bare = doy > 200 ? fall : leafOut;
  const autumn = up * (1 - 0.7 * fall);
  const snowLineM = siteElevationM + (temperatureC + 1) / 0.0065;
  return { snow, snowLineM, ice, bare: clamp01(bare), autumn: clamp01(autumn) };
}
