/** Уровень качества графики: что включено и насколько далеко. */
export type Quality = 'low' | 'medium' | 'high';

export interface QualitySettings {
  label: string;
  /** Предел devicePixelRatio. */
  pixelRatio: number;
  shadowMapSize: number;
  /** Композитор с MSAA и выходным проходом; без него — прямой рендер. */
  postprocess: boolean;
  /** Свечение ярких мест (Солнце, огни). Только при postprocess. */
  bloom: boolean;
  /** Тайл рельефа делится, если камера ближе lodSplit его размеров. */
  lodSplit: number;
  maxImageryZoom: number;
  /** Мелкая текстура травы и пашни вблизи, поверх снимков. */
  detailTexture: boolean;
  /** Тени облаков на земле. */
  cloudShadows: boolean;
  /** Дома из OpenStreetMap — в этом радиусе от камеры, м; 0 — без домов. */
  buildingsRadiusM: number;
  /** Деревья в лесах — в этом радиусе от камеры, м; 0 — без деревьев. */
  treeRadiusM: number;
  /** Средний шаг между деревьями, м. */
  treeSpacingM: number;
  /** Частиц пыли от роторов. */
  dustParticles: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  low: {
    label: 'Низкое',
    pixelRatio: 1,
    shadowMapSize: 1024,
    postprocess: false,
    bloom: false,
    lodSplit: 2.0,
    maxImageryZoom: 17,
    detailTexture: false,
    cloudShadows: false,
    buildingsRadiusM: 3000,
    treeRadiusM: 0,
    treeSpacingM: 14,
    dustParticles: 150,
  },
  medium: {
    label: 'Среднее',
    pixelRatio: 1.5,
    shadowMapSize: 2048,
    postprocess: true,
    bloom: false,
    lodSplit: 2.6,
    maxImageryZoom: 18,
    detailTexture: true,
    cloudShadows: true,
    buildingsRadiusM: 8000,
    treeRadiusM: 700,
    treeSpacingM: 11,
    dustParticles: 400,
  },
  high: {
    label: 'Высокое',
    pixelRatio: 2,
    shadowMapSize: 4096,
    postprocess: true,
    bloom: true,
    lodSplit: 3.4,
    maxImageryZoom: 19,
    detailTexture: true,
    cloudShadows: true,
    buildingsRadiusM: 14000,
    treeRadiusM: 1400,
    treeSpacingM: 8,
    dustParticles: 900,
  },
};

const KEY = 'vtol-sim.quality';

/** Сохранённый выбор, иначе — по устройству: на телефонах низкое, иначе среднее. */
export function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(KEY);
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch {
    // Хранилище недоступно — берём по устройству.
  }
  return matchMedia('(pointer: coarse)').matches ? 'low' : 'medium';
}

export function saveQuality(q: Quality) {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    // Не сохранится — не страшно.
  }
}
