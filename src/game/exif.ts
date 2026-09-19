/*
 * EXIF для кадров съёмки: координаты и высота (GPS), фокусное расстояние и размер пикселя матрицы
 * (FocalPlaneResolution), камера, время съёмки и курс. По ним Metashape, Pix4D и OpenDroneMap
 * сами расставляют кадры и считают калибровку — как с кадрами настоящей камеры.
 */

export interface FrameExif {
  lat: number;
  lon: number;
  /** Высота над уровнем моря, м. */
  altM: number;
  focalMm: number;
  /** Ширина и высота матрицы, мм — для FocalPlaneResolution под размер этого кадра. */
  sensorWidthMm: number;
  sensorHeightMm: number;
  widthPx: number;
  heightPx: number;
  make: string;
  model: string;
  date: Date;
  /** Курс съёмки, ° (верх кадра). */
  headingDeg: number;
}

type Tag = { tag: number; type: 2 | 3 | 4 | 5; count: number; value: Uint8Array };

const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5;

const ascii = (s: string): Tag['value'] => new TextEncoder().encode(`${s}\0`);
const u16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, false);
  return b;
};
const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
};
const rationals = (...vs: [number, number][]) => {
  const b = new Uint8Array(vs.length * 8);
  const d = new DataView(b.buffer);
  vs.forEach(([n, q], i) => {
    d.setUint32(i * 8, Math.round(n), false);
    d.setUint32(i * 8 + 4, Math.round(q), false);
  });
  return b;
};
/** Градусы в три рациональных: градусы, минуты, секунды с точностью 1/10000. */
const dms = (deg: number) => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFull = (a - d) * 60;
  const m = Math.floor(mFull);
  const s = (mFull - m) * 60;
  return rationals([d, 1], [m, 1], [s * 10000, 10000]);
};
const exifDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 } as const;

/** Каталог IFD по смещению start (от начала TIFF): записи, ссылка на следующий (0), данные. */
function ifd(tags: Tag[], start: number): Uint8Array {
  tags.sort((a, b) => a.tag - b.tag);
  const head = 2 + tags.length * 12 + 4;
  let dataLen = 0;
  for (const t of tags) if (t.value.length > 4) dataLen += t.value.length + (t.value.length & 1);
  const out = new Uint8Array(head + dataLen);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, tags.length, false);
  let dataAt = head;
  tags.forEach((t, i) => {
    const o = 2 + i * 12;
    dv.setUint16(o, t.tag, false);
    dv.setUint16(o + 2, t.type, false);
    dv.setUint32(o + 4, t.count, false);
    if (t.value.length <= 4) out.set(t.value, o + 8);
    else {
      dv.setUint32(o + 8, start + dataAt, false);
      out.set(t.value, dataAt);
      dataAt += t.value.length + (t.value.length & 1);
    }
  });
  dv.setUint32(2 + tags.length * 12, 0, false);
  return out;
}

const tagSize = (tags: Tag[]) => 2 + tags.length * 12 + 4 + tags.reduce((a, t) => a + (t.value.length > 4 ? t.value.length + (t.value.length & 1) : 0), 0);
const tag = (t: number, type: Tag['type'], value: Uint8Array): Tag => ({ tag: t, type, count: type === ASCII ? value.length : value.length / TYPE_SIZE[type], value });

/** Сегмент APP1 «Exif» (с маркером FFE1 и длиной). */
export function exifSegment(x: FrameExif): Uint8Array {
  const when = exifDate(x.date);
  const heading = ((x.headingDeg % 360) + 360) % 360;
  // Точек на сантиметр матрицы по ширине и высоте этого кадра (единица — 3, см).
  const resX = x.widthPx / (x.sensorWidthMm / 10);
  const resY = x.heightPx / (x.sensorHeightMm / 10);
  const exifTags: Tag[] = [
    tag(0x9003, ASCII, ascii(when)),
    tag(0x920a, RATIONAL, rationals([x.focalMm * 1000, 1000])),
    tag(0xa002, LONG, u32(x.widthPx)),
    tag(0xa003, LONG, u32(x.heightPx)),
    tag(0xa20e, RATIONAL, rationals([resX * 1000, 1000])),
    tag(0xa20f, RATIONAL, rationals([resY * 1000, 1000])),
    tag(0xa210, SHORT, u16(3)),
  ];
  const gpsTags: Tag[] = [
    tag(0x0000, 1 as unknown as 3, new Uint8Array([2, 3, 0, 0])),
    tag(0x0001, ASCII, ascii(x.lat >= 0 ? 'N' : 'S')),
    tag(0x0002, RATIONAL, dms(x.lat)),
    tag(0x0003, ASCII, ascii(x.lon >= 0 ? 'E' : 'W')),
    tag(0x0004, RATIONAL, dms(x.lon)),
    tag(0x0005, 1 as unknown as 3, new Uint8Array([x.altM >= 0 ? 0 : 1, 0, 0, 0])),
    tag(0x0006, RATIONAL, rationals([Math.abs(x.altM) * 100, 100])),
    tag(0x0010, ASCII, ascii('T')),
    tag(0x0011, RATIONAL, rationals([heading * 100, 100])),
  ];
  // GPSVersionID и GPSAltitudeRef — тип BYTE (1): count — число байт, не SHORT.
  for (const t of gpsTags) if (t.tag === 0x0000 || t.tag === 0x0005) {
    t.type = 1 as unknown as 3;
    t.count = t.tag === 0 ? 4 : 1;
  }
  const ifd0Tags: Tag[] = [
    tag(0x010f, ASCII, ascii(x.make)),
    tag(0x0110, ASCII, ascii(x.model)),
    tag(0x0112, SHORT, u16(1)),
    tag(0x0132, ASCII, ascii(when)),
    tag(0x8769, LONG, u32(0)),
    tag(0x8825, LONG, u32(0)),
  ];
  // Смещения — от начала TIFF: заголовок 8, IFD0, Exif IFD, GPS IFD.
  const ifd0At = 8;
  const exifAt = ifd0At + tagSize(ifd0Tags);
  const gpsAt = exifAt + tagSize(exifTags);
  ifd0Tags.find((t) => t.tag === 0x8769)!.value = u32(exifAt);
  ifd0Tags.find((t) => t.tag === 0x8825)!.value = u32(gpsAt);
  const tiff = [new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]), ifd(ifd0Tags, ifd0At), ifd(exifTags, exifAt), ifd(gpsTags, gpsAt)];
  const body = tiff.reduce((a, p) => a + p.length, 0);
  const seg = new Uint8Array(4 + 6 + body);
  const dv = new DataView(seg.buffer);
  dv.setUint16(0, 0xffe1, false);
  dv.setUint16(2, 2 + 6 + body, false);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  let o = 10;
  for (const p of tiff) {
    seg.set(p, o);
    o += p.length;
  }
  return seg;
}

/** Вставить EXIF в JPEG сразу после SOI (и убрать APP0 JFIF — EXIF-файлы идут без него). */
export function withExif(jpeg: Uint8Array, x: FrameExif): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('не JPEG');
  let rest = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) rest = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  const seg = exifSegment(x);
  const out = new Uint8Array(2 + seg.length + jpeg.length - rest);
  out.set([0xff, 0xd8], 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(rest), 2 + seg.length);
  return out;
}
