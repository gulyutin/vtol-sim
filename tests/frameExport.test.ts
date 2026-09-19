import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exifSegment, withExif, type FrameExif } from '../src/game/exif';
import { crc32, zip } from '../src/game/zip';

const X: FrameExif = {
  lat: 55.7512,
  lon: -37.6184,
  altM: 312.4,
  focalMm: 16,
  sensorWidthMm: 23.5,
  sensorHeightMm: 15.6,
  widthPx: 2000,
  heightPx: 1328,
  make: 'VTOL-sim',
  model: 'Камера 24 Мп',
  date: new Date(2026, 5, 1, 12, 30, 15),
  headingDeg: 275.5,
};

/** Разбор TIFF из сегмента: значения тегов IFD по смещению. */
function readIfd(tiff: DataView, at: number): Map<number, { type: number; count: number; off: number }> {
  const n = tiff.getUint16(at, false);
  const m = new Map<number, { type: number; count: number; off: number }>();
  for (let i = 0; i < n; i++) {
    const o = at + 2 + i * 12;
    const type = tiff.getUint16(o + 2, false);
    const count = tiff.getUint32(o + 4, false);
    const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 } as Record<number, number>)[type]! * count;
    m.set(tiff.getUint16(o, false), { type, count, off: size <= 4 ? o + 8 : tiff.getUint32(o + 8, false) });
  }
  return m;
}
const rat = (d: DataView, off: number, i = 0) => d.getUint32(off + i * 8, false) / d.getUint32(off + i * 8 + 4, false);

describe('EXIF кадра съёмки', () => {
  const seg = exifSegment(X);
  const tiff = new DataView(seg.buffer, 10);
  it('сегмент APP1 Exif с верной длиной', () => {
    expect([seg[0], seg[1]]).toEqual([0xff, 0xe1]);
    expect((seg[2]! << 8) | seg[3]!).toBe(seg.length - 2);
    expect(new TextDecoder().decode(seg.subarray(4, 8))).toBe('Exif');
  });
  it('GPS: широта, долгота, высота; фокус и матрица', () => {
    const ifd0 = readIfd(tiff, 8);
    const gps = readIfd(tiff, tiff.getUint32(ifd0.get(0x8825)!.off, false));
    const exif = readIfd(tiff, tiff.getUint32(ifd0.get(0x8769)!.off, false));
    const deg = (t: number) => {
      const o = gps.get(t)!.off;
      return rat(tiff, o, 0) + rat(tiff, o, 1) / 60 + rat(tiff, o, 2) / 3600;
    };
    expect(deg(0x0002)).toBeCloseTo(55.7512, 6);
    expect(deg(0x0004)).toBeCloseTo(37.6184, 6);
    expect(String.fromCharCode(tiff.getUint8(gps.get(0x0003)!.off))).toBe('W');
    expect(rat(tiff, gps.get(0x0006)!.off)).toBeCloseTo(312.4, 2);
    expect(rat(tiff, exif.get(0x920a)!.off)).toBeCloseTo(16, 3);
    // Точек на сантиметр матрицы: 2000 пикселей на 2,35 см.
    expect(rat(tiff, exif.get(0xa20e)!.off)).toBeCloseTo(2000 / 2.35, 2);
    expect(tiff.getUint16(exif.get(0xa210)!.off, false)).toBe(3);
  });
  it('вставляется в JPEG вместо JFIF и читается Pillow', () => {
    // Настоящий JPEG 8×8 — от Pillow, если он есть; иначе проверяем только разметку.
    const dir = mkdtempSync(join(tmpdir(), 'exif-'));
    const src = join(dir, 'a.jpg');
    try {
      execFileSync('python3', ['-c', `from PIL import Image; Image.new('RGB',(8,8),(90,120,60)).save(${JSON.stringify(src)})`]);
    } catch {
      return;
    }
    const jpeg = new Uint8Array(execFileSync('cat', [src]));
    const out = withExif(jpeg, X);
    expect([out[0], out[1], out[2], out[3]]).toEqual([0xff, 0xd8, 0xff, 0xe1]);
    writeFileSync(join(dir, 'b.jpg'), out);
    const r = execFileSync('python3', [
      '-c',
      `from PIL import Image; g=Image.open(${JSON.stringify(join(dir, 'b.jpg'))}).getexif().get_ifd(0x8825); print(g[1], float(g[2][0])+float(g[2][1])/60+float(g[2][2])/3600, float(g[6]))`,
    ])
      .toString()
      .trim()
      .split(' ');
    expect(r[0]).toBe('N');
    expect(Number(r[1])).toBeCloseTo(55.7512, 5);
    expect(Number(r[2])).toBeCloseTo(312.4, 2);
  });
});

describe('ZIP без сжатия', () => {
  it('CRC-32 по эталону', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('архив проверяется unzip, имена по-русски сохраняются', () => {
    const data = zip([
      { name: 'images/IMG_0001.JPG', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'Памятка.txt', data: new TextEncoder().encode('кадры') },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const f = join(dir, 'a.zip');
    writeFileSync(f, data);
    let out: string;
    try {
      out = execFileSync('unzip', ['-t', f]).toString();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    expect(out).toMatch(/No errors detected/);
    expect(execFileSync('unzip', ['-l', f]).toString()).toMatch(/images\/IMG_0001\.JPG/);
  });
});
