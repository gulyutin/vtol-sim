import { describe, expect, it } from 'vitest';
import { parseOsm } from '../src/sim/osm';

/*
 * Разбор osm.bin: файлы собираются вручную по описанию формата в src/sim/osm.ts —
 * текущей версии 2 (разности varint) и прежней 1 (абсолютные i32).
 */

/** Последовательная запись little-endian. */
class Writer {
  private readonly bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  i32(v: number) {
    this.u32(v >>> 0);
  }
  varint(v: number) {
    while (v >= 128) {
      this.u8((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }
  zz(v: number) {
    this.varint(v >= 0 ? 2 * v : -2 * v - 1);
  }
  /** Точки в метрах → i32 дм (версия 1). */
  pts(m: number[]) {
    for (const v of m) this.i32(Math.round(v * 10));
  }
  /** Точки в метрах → число и разности в дм (версия 2). */
  pts2(m: number[]) {
    this.varint(m.length / 2);
    let pe = 0;
    let pn = 0;
    for (let i = 0; i < m.length; i += 2) {
      const e = Math.round(m[i]! * 10);
      const n = Math.round(m[i + 1]! * 10);
      this.zz(e - pe);
      this.zz(n - pn);
      pe = e;
      pn = n;
    }
  }
  magic(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }
  get length() {
    return this.bytes.length;
  }
  buffer(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }
}

const HOUSE = [-12.5, 3.2, 0.4, 3.2, 0.4, 14.1, -12.5, 14.1];
const OUTER = [-1000, -800, 1200, -800, 1200, 950.5, -1000, 950.5];
const HOLE = [-100, -100, 100, -100, 0, 150];
const AXIS = [-600, -20, 1400.3, 35.7];
const ROAD = [-14000.4, 9000, -13950, 9012.5, -13000.1, 9400];
const LAKE = [300, 300, 900, 280, 950, 700, 320, 760];
const ISLAND = [500, 450, 600, 450, 550, 550];
const STREAM = [2000, -3000, 2010.5, -2950, 2040, -2900.2];

function sampleV1(): ArrayBuffer {
  const w = new Writer();
  w.magic('OSM1');
  w.u32(1);
  w.u32(1);
  w.u32(1);
  // здание: apartments, 15.5 м
  w.u8(1);
  w.u16(155);
  w.u16(HOUSE.length / 2);
  w.pts(HOUSE);
  // лес: хвойный, внешнее кольцо и дыра
  w.u8(0);
  w.u16(2);
  w.u32(OUTER.length / 2);
  w.pts(OUTER);
  w.u32(HOLE.length / 2);
  w.pts(HOLE);
  // полоса: 30 м, твёрдое покрытие
  w.u16(300);
  w.u8(1);
  w.u16(AXIS.length / 2);
  w.pts(AXIS);
  return w.buffer();
}

function sampleV2(): ArrayBuffer {
  const w = new Writer();
  w.magic('OSM2');
  for (const n of [1, 1, 1, 2, 1, 1]) w.u32(n);
  // здание: apartments, 5 этажей, вальмовая крыша, 15.5 м
  w.u8(1);
  w.u8(5);
  w.u8(3);
  w.varint(155);
  w.pts2(HOUSE);
  // лес: хвойный, внешнее кольцо и дыра
  w.u8(0);
  w.varint(2);
  w.pts2(OUTER);
  w.pts2(HOLE);
  // полоса: твёрдое покрытие, 30 м
  w.u8(1);
  w.varint(300);
  w.pts2(AXIS);
  // дороги: вторичная асфальтовая освещённая 7 м; железная дорога — мост, 4 м
  w.u8(3);
  w.u8(1 | 4);
  w.varint(70);
  w.pts2(ROAD);
  w.u8(9);
  w.u8(2);
  w.varint(40);
  w.pts2(AXIS);
  // вода: водохранилище с островом
  w.u8(2);
  w.varint(2);
  w.pts2(LAKE);
  w.pts2(ISLAND);
  // ручей 3 м
  w.u8(1);
  w.varint(30);
  w.pts2(STREAM);
  return w.buffer();
}

const close = (a: Float32Array, b: number[]) => {
  expect(a).toHaveLength(b.length);
  b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 3));
};

describe('parseOsm, версия 2', () => {
  it('читает дом, лес с дырой, полосу, дороги, воду с островом и ручей', () => {
    const d = parseOsm(sampleV2());
    expect(d.buildings).toHaveLength(1);
    expect(d.forests).toHaveLength(1);
    expect(d.runways).toHaveLength(1);
    expect(d.roads).toHaveLength(2);
    expect(d.water).toHaveLength(1);
    expect(d.waterways).toHaveLength(1);

    const b = d.buildings[0]!;
    expect(b.kind).toBe('apartments');
    expect(b.heightM).toBeCloseTo(15.5, 5);
    expect(b.levels).toBe(5);
    expect(b.roof).toBe('hipped');
    close(b.ring, HOUSE);

    const f = d.forests[0]!;
    expect(f.leaf).toBe('needle');
    expect(f.rings).toHaveLength(2);
    close(f.rings[0]!, OUTER);
    close(f.rings[1]!, HOLE);

    const r = d.runways[0]!;
    expect(r.widthM).toBeCloseTo(30, 5);
    expect(r.paved).toBe(true);
    close(r.line, AXIS);

    const [road, rail] = d.roads as [(typeof d.roads)[0], (typeof d.roads)[0]];
    expect(road).toMatchObject({ cls: 'secondary', paved: true, bridge: false, lit: true });
    expect(road.widthM).toBeCloseTo(7, 5);
    close(road.line, ROAD);
    expect(rail).toMatchObject({ cls: 'rail', paved: false, bridge: true, lit: false });
    expect(rail.widthM).toBeCloseTo(4, 5);
    close(rail.line, AXIS);

    const lake = d.water[0]!;
    expect(lake.kind).toBe('reservoir');
    expect(lake.rings).toHaveLength(2);
    close(lake.rings[0]!, LAKE);
    close(lake.rings[1]!, ISLAND);

    const s = d.waterways[0]!;
    expect(s.kind).toBe('stream');
    expect(s.widthM).toBeCloseTo(3, 5);
    close(s.line, STREAM);
  });

  it('пустой файл — пустые списки', () => {
    const w = new Writer();
    w.magic('OSM2');
    for (let i = 0; i < 6; i++) w.u32(0);
    expect(parseOsm(w.buffer())).toEqual({ buildings: [], forests: [], runways: [], roads: [], water: [], waterways: [], paved: [] });
  });

  it('раздел площадок в конце — необязательный', () => {
    const w = new Writer();
    w.magic('OSM2');
    for (let i = 0; i < 6; i++) w.u32(0);
    w.u32(1);
    w.varint(1); // колец
    w.varint(3); // точек
    for (const v of [0, 0, 100, 0, 0, 50]) w.zz(v); // разности в дм: (0, 0), (+10 м, 0), (0, +5 м)
    const d = parseOsm(w.buffer());
    expect(d.paved).toHaveLength(1);
    expect(Array.from(d.paved[0]!.rings[0]!)).toEqual([0, 0, 10, 0, 10, 5]);
  });

  it('большие разности и отрицательные координаты — без потери точности', () => {
    const w = new Writer();
    w.magic('OSM2');
    for (const n of [0, 0, 0, 1, 0, 0]) w.u32(n);
    const far = [-250000.7, 180000.3, 250000.1, -180000.9];
    w.u8(8);
    w.u8(0);
    w.varint(30);
    w.pts2(far);
    const road = parseOsm(w.buffer()).roads[0]!;
    expect(road).toMatchObject({ cls: 'track', paved: false });
    // Метры во Float32: на 250 км шаг ~1.6 см.
    expect(road.line).toHaveLength(far.length);
    far.forEach((v, i) => expect(road.line[i]).toBeCloseTo(v, 1));
  });

  it('обрезанный файл — исключение', () => {
    const buf = sampleV2();
    expect(() => parseOsm(buf.slice(0, 20))).toThrow(/обрезан/);
    expect(() => parseOsm(buf.slice(0, buf.byteLength - 1))).toThrow(/обрезан/);
  });
});

describe('parseOsm, версия 1', () => {
  it('читает здание, лес с дырой и полосу; новых разделов нет', () => {
    const d = parseOsm(sampleV1());
    expect(d.buildings).toHaveLength(1);
    expect(d.forests).toHaveLength(1);
    expect(d.runways).toHaveLength(1);
    expect(d.roads).toEqual([]);
    expect(d.water).toEqual([]);
    expect(d.waterways).toEqual([]);

    const b = d.buildings[0]!;
    expect(b.kind).toBe('apartments');
    expect(b.heightM).toBeCloseTo(15.5, 5);
    expect(b.levels).toBe(0);
    expect(b.roof).toBe('auto');
    close(b.ring, HOUSE);

    const f = d.forests[0]!;
    expect(f.leaf).toBe('needle');
    expect(f.rings).toHaveLength(2);
    close(f.rings[0]!, OUTER);
    close(f.rings[1]!, HOLE);

    const r = d.runways[0]!;
    expect(r.widthM).toBeCloseTo(30, 5);
    expect(r.paved).toBe(true);
    close(r.line, AXIS);
  });

  it('неверная сигнатура и обрезанный файл — исключение', () => {
    const bad = new Uint8Array(sampleV1());
    bad[3] = '9'.charCodeAt(0);
    expect(() => parseOsm(bad.buffer)).toThrow(/сигнатура/);
    expect(() => parseOsm(sampleV1().slice(0, 40))).toThrow(/обрезан/);
    expect(() => parseOsm(new ArrayBuffer(2))).toThrow(/обрезан/);
  });
});
