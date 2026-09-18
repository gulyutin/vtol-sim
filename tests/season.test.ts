import { describe, expect, it } from 'vitest';
import { groundSeason, seasonDate, seasonTemperatureC } from '../src/game/season';

describe('время года на земле', () => {
  it('зимой в средней полосе — сплошной снег и лёд, летом — ни того ни другого', () => {
    const w = groundSeason('2026-01-25', 55.5, -12, 150);
    expect(w.snow).toBe(1);
    expect(w.ice).toBe(1);
    expect(w.bare).toBe(1);
    const s = groundSeason('2026-07-10', 55.5, 21, 150);
    expect(s.snow).toBe(0);
    expect(s.ice).toBe(0);
    expect(s.bare).toBe(0);
    expect(s.autumn).toBe(0);
  });

  it('в середине апреля в Подмосковье снег сошёл, в Карелии лежит пятнами, в Хибинах — сплошной', () => {
    expect(groundSeason('2026-04-18', 55.5, 5, 150).snow).toBe(0);
    const karelia = groundSeason('2026-04-18', 61.7, 0, 100).snow;
    expect(karelia).toBeGreaterThan(0.2);
    expect(karelia).toBeLessThan(1);
    expect(groundSeason('2026-04-18', 67.6, -3, 230).snow).toBe(1);
  });

  it('оттепель съедает покров; конец сентября — жёлтая листва без снега', () => {
    expect(groundSeason('2026-01-25', 55.5, 8, 150).snow).toBeLessThan(0.2);
    const a = groundSeason('2026-09-28', 55.5, 8, 150);
    expect(a.autumn).toBeGreaterThan(0.9);
    expect(a.snow).toBe(0);
    expect(a.bare).toBe(0);
  });

  it('граница снега в горах — там, где ниже нуля: у Эльбруса летом выше 4000 м', () => {
    expect(groundSeason('2026-07-10', 43.25, 14, 1880).snowLineM).toBeGreaterThan(4000);
    expect(groundSeason('2026-01-25', 43.25, -10, 1880).snowLineM).toBeLessThan(1880);
  });

  it('дата времени года и типичная температура', () => {
    expect(seasonDate('2026-09-20', 'region')).toBe('2026-09-20');
    expect(seasonDate('2026-09-20', 'winter')).toBe('2026-01-25');
    expect(seasonTemperatureC('winter', 67.6)).toBeLessThan(seasonTemperatureC('winter', 55));
  });
});
