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
  /** Капель дождя и снежинок вокруг камеры. */
  precipParticles: number;
  /** Объёмные облака: шагов по лучу и шагов самозатенения к Солнцу. */
  cloudSteps: [number, number];
  /** Дальний лес простыми конусами — до этого радиуса, м (0 — нет), и шаг между ними, м. */
  farTreeRadiusM?: number;
  farTreeSpacingM?: number;
  /** Трава и кусты у камеры, когда она низко. */
  groundCover?: boolean;
  /** Отражения в воде: доля разрешения экрана для зеркала (0 или нет — только небо). */
  waterReflections?: number;
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
    precipParticles: 6000, cloudSteps: [18, 1],
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
    farTreeRadiusM: 3500,
    farTreeSpacingM: 34,
    groundCover: true,
    waterReflections: 0.35,
    dustParticles: 400,
    precipParticles: 12000, cloudSteps: [32, 2],
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
    farTreeRadiusM: 6500,
    farTreeSpacingM: 26,
    groundCover: true,
    waterReflections: 0.5,
    dustParticles: 900,
    precipParticles: 20000, cloudSteps: [48, 3],
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
