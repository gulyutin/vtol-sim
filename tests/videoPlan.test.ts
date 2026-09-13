import { describe, expect, it } from 'vitest';
import {
  avcCodecs,
  chooseEncoder,
  clock,
  fadeAlpha,
  frameAt,
  outroLines,
  overlayCells,
  overlayLayout,
  pickSpeed,
  planFrames,
  VIDEO_SIZES,
  videoBitrate,
  videoFileName,
  type Box,
} from '../src/ui/videoPlan';

describe('скорость повтора по длительности', () => {
  it('короткий полёт — 1×, длинный — быстрее, но не больше 8×', () => {
    expect(pickSpeed(45)).toBe(1);
    expect(pickSpeed(90)).toBe(1);
    expect(pickSpeed(91)).toBe(2);
    expect(pickSpeed(300)).toBe(4);
    expect(pickSpeed(600)).toBe(8);
    expect(pickSpeed(3600)).toBe(8);
  });

  it('полёт от 30 с до 12 мин укладывается в видео 30–90 с', () => {
    for (let span = 30; span <= 720; span += 7) {
      const v = span / pickSpeed(span);
      expect(v, `полёт ${span} с`).toBeGreaterThanOrEqual(30);
      expect(v, `полёт ${span} с`).toBeLessThanOrEqual(90);
    }
  });
});

describe('времена кадров', () => {
  it('кадр k — момент t0 + k / fps × скорость, последний — ровно конец участка', () => {
    const p = planFrames(10, 20, 2, 30);
    expect(p.flightFrames).toBe(151);
    expect(frameAt(p, 0).t).toBe(10);
    expect(frameAt(p, 15).t).toBeCloseTo(11, 9);
    expect(frameAt(p, 150).t).toBeCloseTo(20, 9);
    expect(frameAt(p, 150).outro).toBe(false);
    expect(p.durationS).toBeCloseTo(151 / 30, 9);
  });

  it('итог в конце держит последний момент записи', () => {
    const p = planFrames(0, 60, 4, 30, 4);
    expect(p.outroFrames).toBe(120);
    expect(p.total).toBe(p.flightFrames + 120);
    const f = frameAt(p, p.flightFrames + 30);
    expect(f.outro).toBe(true);
    expect(f.t).toBe(60);
    expect(f.outroS).toBeCloseTo(1, 9);
  });

  it('отметки кадров идут подряд без щелей, в микросекундах', () => {
    const p = planFrames(0, 7, 1, 30, 1);
    let end = 0;
    for (let k = 0; k < p.total; k++) {
      const f = frameAt(p, k);
      expect(f.timestampUs).toBe(end);
      expect(f.durationUs).toBeGreaterThanOrEqual(33_333);
      expect(f.durationUs).toBeLessThanOrEqual(33_334);
      end = f.timestampUs + f.durationUs;
    }
    expect(end).toBe(Math.round((p.total * 1e6) / 30));
  });

  it('пустой участок — один кадр; нулевая скорость — ошибка', () => {
    expect(planFrames(5, 5, 1).flightFrames).toBe(1);
    expect(() => planFrames(0, 10, 0)).toThrow();
  });

  it('титр: сразу виден, гаснет в конце', () => {
    expect(fadeAlpha(0, 2, 0, 0.5)).toBe(1);
    expect(fadeAlpha(1.75, 2, 0, 0.5)).toBeCloseTo(0.5, 9);
    expect(fadeAlpha(2.1, 2, 0, 0.5)).toBe(0);
    expect(fadeAlpha(0.15, 4, 0.3, 0)).toBeCloseTo(0.5, 9);
    expect(fadeAlpha(4, 4, 0.3, 0)).toBe(1);
  });
});

describe('оверлей', () => {
  const sample = { aglM: 123.4, iasMs: 21.26, gsMs: 18.04, soc: 0.456, mode: 'auto' };
  const cells = overlayCells(sample, 'АВТО');
  const weights = cells.map((c) => c.weight);

  it('значения как в НСУ: запятая, единицы, режим словами', () => {
    expect(cells.map((c) => [c.label, c.value, c.unit])).toEqual([
      ['ВЫСОТА', '123', 'м'],
      ['ПРИБОРНАЯ', '21,3', 'м/с'],
      ['ПУТЕВАЯ', '18,0', 'м/с'],
      ['РЕЖИМ', 'АВТО', ''],
      ['ЗАРЯД', '46', '%'],
    ]);
    const low = overlayCells({ ...sample, aglM: -0.3, soc: 0.12, mode: 'crashed' }, 'АВАРИЯ');
    expect(low[0]!.value).toBe('0');
    expect(low[3]!.tone).toBe('bad');
    expect(low[4]!.tone).toBe('warn');
    expect(overlayCells({ ...sample, mode: 'rtl' }, 'ВОЗВРАТ')[3]!.tone).toBe('warn');
  });

  const inside = (b: Box, w: number, h: number) => b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h;
  const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  for (const id of ['720p', '1080p', 'vertical'] as const) {
    const { width: W, height: H } = VIDEO_SIZES[id];
    it(`${id}: всё в кадре и ничего не накладывается`, () => {
      const L = overlayLayout(W, H, weights);
      const boxes = [L.mission, L.clock, ...L.cells];
      for (const b of [...boxes, L.card]) expect(inside(b, W, H), JSON.stringify(b)).toBe(true);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!), `${i}×${j}`).toBe(false);
      // Верх — над ячейками, карточка — по центру.
      expect(Math.max(L.mission.y + L.mission.h, L.clock.y + L.clock.h)).toBeLessThan(Math.min(...L.cells.map((c) => c.y)));
      expect(L.card.x + L.card.w / 2).toBeCloseTo(W / 2, -1);
      expect(L.card.y + L.card.h / 2).toBeCloseTo(H / 2, -1);
    });
  }

  it('горизонталь — одна строка ячеек, масштаб по высоте кадра', () => {
    const L = overlayLayout(1920, 1080, weights);
    expect(L.scale).toBe(1.5);
    expect(new Set(L.cells.map((c) => c.y)).size).toBe(1);
    expect(L.font.value).toBe(Math.round(25 * 1.5));
    expect(overlayLayout(1280, 720, weights).scale).toBe(1);
  });

  it('вертикаль — ячейки поровну в две строки на всю ширину, выше подписей соцсетей', () => {
    const L = overlayLayout(1080, 1920, weights);
    expect(L.portrait).toBe(true);
    const rows = [...new Set(L.cells.map((c) => c.y))].sort((a, b) => a - b);
    expect(rows.length).toBe(2);
    expect(L.cells.filter((c) => c.y === rows[0]).length).toBe(3);
    const pad = L.cells[0]!.x;
    for (const i of [2, 4]) expect(L.cells[i]!.x + L.cells[i]!.w).toBe(1080 - pad);
    expect(Math.max(...L.cells.map((c) => c.y + c.h))).toBeLessThan(1920 * 0.86);
  });
});

describe('кодировщик', () => {
  it('H.264: уровень по размеру кадра, сначала High', () => {
    expect(avcCodecs(1280, 720)).toEqual(['avc1.640028', 'avc1.4d0028', 'avc1.42e028']);
    expect(avcCodecs(1080, 1920)[0]).toBe('avc1.640028');
    expect(avcCodecs(3840, 2160)[0]).toBe('avc1.640033');
  });

  it('битрейт: ~4,5 Мбит/с для 720p и 10 — для 1080p', () => {
    expect(videoBitrate(1280, 720)).toBe(4.5e6);
    expect(videoBitrate(1920, 1080)).toBe(10e6);
    expect(videoBitrate(1080, 1920)).toBe(10e6);
  });

  it('MP4, если есть WebCodecs и H.264; иначе честно WebM; иначе ничего', () => {
    expect(chooseEncoder({ webCodecs: true, avcCodec: 'avc1.640028', webmType: 'video/webm;codecs=vp9' })).toMatchObject({ kind: 'mp4', codec: 'avc1.640028' });
    const noAvc = chooseEncoder({ webCodecs: true, avcCodec: null, webmType: 'video/webm;codecs=vp9' });
    expect(noAvc).toMatchObject({ kind: 'webm', mimeType: 'video/webm;codecs=vp9' });
    expect(noAvc.label).toMatch(/^WebM/);
    expect(chooseEncoder({ webCodecs: false, avcCodec: 'avc1.640028', webmType: 'video/webm' }).kind).toBe('webm');
    expect(chooseEncoder({ webCodecs: false, avcCodec: null, webmType: null }).kind).toBe('none');
  });
});

describe('имя файла и итог', () => {
  const at = new Date(2026, 8, 12, 14, 30).toISOString();

  it('полёт-<задание>-<дата>.mp4', () => {
    expect(videoFileName('Облёт по маршруту', at, 'mp4')).toBe('полёт-Облёт-по-маршруту-2026-09-12.mp4');
    expect(videoFileName('Перелёт А → Б', at, 'webm')).toBe('полёт-Перелёт-А-Б-2026-09-12.webm');
    expect(videoFileName('a/b: "c"?', at, 'mp4')).toBe('полёт-a-b-c-2026-09-12.mp4');
    expect(videoFileName('Съёмка', 'не дата', 'mp4')).toBe('полёт-Съёмка.mp4');
    expect(videoFileName('   ', at, 'mp4')).toBe('полёт-2026-09-12.mp4');
    expect(videoFileName('x'.repeat(200), at, 'mp4').length).toBeLessThan(90);
  });

  it('время и итог оценки', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(75.9)).toBe('1:15');
    expect(clock(3725)).toBe('1:02:05');
    const o = outroLines({ total: 87, grade: 'хорошо' }, { durationS: 860, distanceM: 12340, energyWh: 181.4 });
    expect(o).toEqual({ title: 'Оценка: 87 из 100', grade: 'хорошо', tone: 'good', detail: '14:20 · 12,3 км · 181 Вт·ч' });
    expect(outroLines({ total: 40, grade: 'плохо' }, { durationS: 60, distanceM: 800, energyWh: 5 }).tone).toBe('bad');
  });
});
