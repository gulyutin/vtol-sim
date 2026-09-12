import { describe, expect, it } from 'vitest';
import { parseOsm } from '../src/sim/osm';

/*
 * Разбор osm.bin: файл собирается вручную по описанию формата в src/sim/osm.ts.
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
  /** Точки в метрах → i32 дм. */
  pts(m: number[]) {
    for (const v of m) this.i32(Math.round(v * 10));
  }
  magic(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }
  buffer(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }
}

const HOUSE = [-12.5, 3.2, 0.4, 3.2, 0.4, 14.1, -12.5, 14.1];
const OUTER = [-1000, -800, 1200, -800, 1200, 950.5, -1000, 950.5];
const HOLE = [-100, -100, 100, -100, 0, 150];
const AXIS = [-600, -20, 1400.3, 35.7];

function sample(): ArrayBuffer {
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

const close = (a: Float32Array, b: number[]) => {
  expect(a).toHaveLength(b.length);
  b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 3));
};

describe('parseOsm', () => {
  it('читает здание, лес с дырой и полосу', () => {
    const d = parseOsm(sample());
    expect(d.buildings).toHaveLength(1);
    expect(d.forests).toHaveLength(1);
    expect(d.runways).toHaveLength(1);

    const b = d.buildings[0]!;
    expect(b.kind).toBe('apartments');
    expect(b.heightM).toBeCloseTo(15.5, 5);
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

  it('пустой файл — пустые списки', () => {
    const w = new Writer();
    w.magic('OSM1');
    w.u32(0);
    w.u32(0);
    w.u32(0);
    expect(parseOsm(w.buffer())).toEqual({ buildings: [], forests: [], runways: [] });
  });

  it('неверная сигнатура и обрезанный файл — исключение', () => {
    const bad = new Uint8Array(sample());
    bad[3] = '2'.charCodeAt(0);
    expect(() => parseOsm(bad.buffer)).toThrow(/сигнатура/);
    expect(() => parseOsm(sample().slice(0, 40))).toThrow(/обрезан/);
  });
});
