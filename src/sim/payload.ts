import { PROFILE } from '@profile';
import type { SurveyCamera } from './survey';

/**
 * Камеры для АФС: первая — штатная из профиля, дальше типовые картографические камеры.
 * Классы и порядок характеристик — как у типовых камер (матрица, шаг пикселя,
 * скорострельность); конкретные модели не подразумеваются.
 */
export const CAMERAS: readonly SurveyCamera[] = [
  PROFILE.camera,
  {
    id: 'ff61',
    name: 'Полный кадр 61 Мп, 35 мм',
    massKg: 0.95,
    powerW: 12,
    focalLengthMm: 35,
    pixelPitchUm: 3.76,
    widthPx: 9504,
    heightPx: 6336,
    fNumber: 5.6,
    isoMax: 3200,
    minIntervalS: 1.0,
    frameMB: 60,
  },
  {
    id: 'mf100',
    name: 'Средний формат 100 Мп, 50 мм',
    massKg: 1.3,
    powerW: 18,
    focalLengthMm: 50,
    pixelPitchUm: 3.76,
    widthPx: 11664,
    heightPx: 8750,
    fNumber: 5.6,
    isoMax: 6400,
    minIntervalS: 0.7,
    frameMB: 100,
  },
  {
    id: 'aps24',
    name: 'APS-C 24 Мп, 25 мм',
    massKg: 0.5,
    powerW: 7,
    focalLengthMm: 25,
    pixelPitchUm: 3.9,
    widthPx: 6000,
    heightPx: 4000,
    fNumber: 5.6,
    isoMax: 3200,
    minIntervalS: 0.8,
    frameMB: 25,
  },
];
