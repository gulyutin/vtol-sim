import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { OsmBuilding } from '../src/sim/osm';
import { localHourFromSun, sunPosition } from '../src/sim/sun';
import { Landmarks, replacedBuildings } from '../src/ui/landmarks';

describe('башня с часами', () => {
  const site = { lat: 56, lon: 93 };
  const clock = { date: new Date(Date.UTC(2026, 6, 10, 12)), utcOffsetH: 7 };
  const top = (lm: Landmarks) => new THREE.Box3().setFromObject(lm.group).max.y;

  it('по ярусам: до шпиля ровно, основание уходит в землю', () => {
    const lm = new Landmarks(
      [
        {
          kind: 'clockTower',
          ...site,
          tower: {
            tiers: [
              { toM: 33, widthM: 10 },
              { toM: 42, widthM: 9, style: 'ribbed' },
              { toM: 50, widthM: 8 },
            ],
            clock: { centerM: 46, diameterM: 6, panel: { fromM: 43, toM: 49, widthM: 8.4 } },
            top: { kind: 'glassPyramid', wallToM: 52, toM: 60, widthM: 8 },
            spire: { toM: 70, widthM: 0.6 },
          },
        },
      ],
      site,
      () => 0,
      clock,
    );
    expect(top(lm)).toBeCloseTo(70, 1);
    expect(new THREE.Box3().setFromObject(lm.group).min.y).toBeLessThan(0);
    lm.dispose();
  });

  it('со всеми деталями: прорези, карниз с ограждением, рёбра, «корона», цифры, рёбра кровли, флюгер', () => {
    const lm = new Landmarks(
      [
        {
          kind: 'clockTower',
          ...site,
          tower: {
            tiers: [
              { toM: 33, widthM: 10.6, style: 'slotted', slots: { count: 3, widthM: 0.7 }, cornice: { widthM: 11.4, heightM: 0.9 }, balustrade: { heightM: 1.1 } },
              { toM: 41, widthM: 8.2, style: 'ribbed', ribs: 6, glow: 1.2 },
              { toM: 52, widthM: 8.2 },
              { toM: 55, widthM: 8.2, topWidthM: 8.8, style: 'flared', glow: 1 },
            ],
            clock: { centerM: 46.5, diameterM: 6.5, faceColor: '#141414', markColor: '#f2f2f2', rimColor: '#f2f2f2', numerals: true },
            top: { kind: 'tent', toM: 61, widthM: 7.5, ribColor: '#cfc6b3', glow: 0.25 },
            spire: { toM: 70, widthM: 0.35, ball: true, vane: true },
          },
        },
      ],
      site,
      () => 0,
      clock,
    );
    expect(top(lm)).toBeCloseTo(70, 1);
    lm.update(1);
    lm.dispose();
  });

  it('без описания ярусов — классическая башня до heightM', () => {
    const lm = new Landmarks([{ kind: 'clockTower', ...site, heightM: 55, widthM: 9 }], site, () => 0, clock);
    expect(top(lm)).toBeCloseTo(55, 0);
    lm.dispose();
  });
});

/*
 * Ориентиры (src/ui/landmarks.ts): часы идут по местному времени, восстановленному по Солнцу;
 * модель музея заменяет дом OSM, в контур которого попадает, башня — нет.
 */

describe('местное время по Солнцу', () => {
  const site = { lat: 56, lon: 93 };
  const utc = 7;
  it.each([0.5, 5.25, 9, 12, 13.75, 18.5, 22])('%s ч: восстанавливается с точностью до 3 мин', (hour) => {
    const date = new Date(Date.UTC(2026, 6, 10) + (hour - utc) * 3600e3);
    const got = localHourFromSun(sunPosition(date, site), site, date, utc);
    // Ошибка по кругу суток, ч.
    const diff = Math.abs(((got - hour + 36) % 24) - 12);
    expect(diff).toBeLessThan(3 / 60);
  });

  it('зимой тоже (уравнение времени другого знака)', () => {
    const date = new Date(Date.UTC(2026, 10, 3) + (15 - utc) * 3600e3);
    expect(localHourFromSun(sunPosition(date, site), site, date, utc)).toBeCloseTo(15, 1);
  });
});

describe('дом под моделью', () => {
  const square = (e: number, n: number, r: number): OsmBuilding => ({
    kind: 'other',
    heightM: 10,
    levels: 3,
    roof: 'auto',
    ring: new Float32Array([e - r, n - r, e + r, n - r, e + r, n + r, e - r, n + r]),
  });
  const site = { lat: 56, lon: 93 };
  // Точка в 100 м к востоку от площадки.
  const east100 = { lat: 56, lon: 93 + 100 / (6371000 * Math.cos(56 * (Math.PI / 180)) * (Math.PI / 180)) };

  it('музей скрывает дом, в контур которого попадает; соседний остаётся', () => {
    const b = [square(100, 0, 20), square(160, 0, 20)];
    expect([...replacedBuildings(b, [{ kind: 'museum', ...east100 }], site)]).toEqual([0]);
  });

  it('башня с часами встаёт в здание и его не скрывает', () => {
    expect(replacedBuildings([square(100, 0, 20)], [{ kind: 'clockTower', ...east100 }], site).size).toBe(0);
  });
});
