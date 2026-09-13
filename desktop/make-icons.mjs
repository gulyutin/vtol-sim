#!/usr/bin/env node
/*
 * Значки приложения из desktop/icon.svg — без внешних программ и зависимостей.
 *
 *   node desktop/make-icons.mjs [папка]     — по умолчанию desktop/build
 *
 * Результат: icon.png (1024), icons/<N>x<N>.png (для Linux), icon.ico (Windows), icon.icns (macOS).
 * Растеризатор понимает только подмножество SVG, которым нарисован значок (см. комментарий
 * в icon.svg); незнакомый элемент — ошибка, чтобы значок не собрался молча неправильным.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));

// ---------- разбор SVG ----------

const DRAWN = new Set(['rect', 'circle', 'ellipse', 'polygon']);
const IGNORED = new Set(['svg', 'title', 'desc', 'g']);

function parseColor(v) {
  if (!v || v === 'none' || v === 'transparent') return null;
  const named = { white: '#ffffff', black: '#000000' }[v];
  const s = named ?? v;
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  throw new Error(`Цвет не поддерживается: ${v}`);
}

function parseSvg(text) {
  const src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/g, '');
  const vb = /viewBox="([^"]+)"/.exec(src);
  if (!vb) throw new Error('В SVG нет viewBox');
  const [vx, vy, vw, vh] = vb[1].trim().split(/[\s,]+/).map(Number);
  const shapes = [];
  for (const m of src.matchAll(/<([a-zA-Z]+)\b([^>]*?)\/?>/g)) {
    const tag = m[1];
    const a = Object.fromEntries([...m[2].matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (IGNORED.has(tag)) {
      if (a.transform) throw new Error('transform не поддерживается');
      continue;
    }
    if (!DRAWN.has(tag)) throw new Error(`Элемент <${tag}> не поддерживается`);
    if (a.transform) throw new Error('transform не поддерживается');
    shapes.push({ tag, a });
  }
  return { box: [vx, vy, vw, vh], shapes };
}

// ---------- контуры (многоугольники в координатах viewBox) ----------

function ellipsePts(cx, cy, rx, ry, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

function roundRectPts(x, y, w, h, rx, ry, n) {
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  if (rx <= 0 || ry <= 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= n; i++) {
      const t = a0 + (Math.PI / 2) * (i / n);
      pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
  };
  corner(x + w - rx, y + ry, -Math.PI / 2);
  corner(x + w - rx, y + h - ry, 0);
  corner(x + rx, y + h - ry, Math.PI / 2);
  corner(x + rx, y + ry, Math.PI);
  return pts;
}

/** Слои для закраски: { contours, color, alpha } — контуры закрашиваются по правилу чёт-нечет. */
function layers(shapes) {
  const out = [];
  const num = (a, k, d = 0) => (a[k] === undefined ? d : Number(a[k]));
  for (const { tag, a } of shapes) {
    const opacity = num(a, 'opacity', 1);
    const fill = parseColor(a.fill ?? '#000000');
    const stroke = parseColor(a.stroke);
    const sw = num(a, 'stroke-width', 1);
    const fa = num(a, 'fill-opacity', 1) * opacity;
    const sa = num(a, 'stroke-opacity', 1) * opacity;
    if (tag === 'rect') {
      if (stroke) throw new Error('stroke у rect не поддерживается');
      const rx = num(a, 'rx', num(a, 'ry'));
      const ry = num(a, 'ry', rx);
      if (fill) out.push({ contours: [roundRectPts(num(a, 'x'), num(a, 'y'), num(a, 'width'), num(a, 'height'), rx, ry, 32)], color: fill, alpha: fa });
    } else if (tag === 'polygon') {
      if (stroke) throw new Error('stroke у polygon не поддерживается');
      const v = a.points.trim().split(/[\s,]+/).map(Number);
      const pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      if (fill) out.push({ contours: [pts], color: fill, alpha: fa });
    } else {
      const cx = num(a, 'cx');
      const cy = num(a, 'cy');
      const rx = tag === 'circle' ? num(a, 'r') : num(a, 'rx');
      const ry = tag === 'circle' ? num(a, 'r') : num(a, 'ry');
      const n = 256;
      if (fill) out.push({ contours: [ellipsePts(cx, cy, rx, ry, n)], color: fill, alpha: fa });
      if (stroke && sw > 0) {
        const outer = ellipsePts(cx, cy, rx + sw / 2, ry + sw / 2, n);
        const inner = ellipsePts(cx, cy, Math.max(0, rx - sw / 2), Math.max(0, ry - sw / 2), n);
        out.push({ contours: [outer, inner], color: stroke, alpha: sa });
      }
    }
  }
  return out;
}

// ---------- растеризация: построчно, 8 подстрок на пиксель, точное покрытие по горизонтали ----------

function rasterize(svg, size) {
  const [vx, vy, vw, vh] = svg.box;
  const sx = size / vw;
  const sy = size / vh;
  const SUB = 8;
  const img = new Float32Array(size * size * 4); // premultiplied RGBA
  const cov = new Float32Array(size + 1);
  for (const layer of layers(svg.shapes)) {
    const edges = [];
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of layer.contours) {
      for (let i = 0; i < c.length; i++) {
        const p = c[i];
        const q = c[(i + 1) % c.length];
        const a = [(p[0] - vx) * sx, (p[1] - vy) * sy];
        const b = [(q[0] - vx) * sx, (q[1] - vy) * sy];
        if (a[1] === b[1]) continue;
        edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]]);
        y0 = Math.min(y0, a[1], b[1]);
        y1 = Math.max(y1, a[1], b[1]);
      }
    }
    const rowFrom = Math.max(0, Math.floor(y0));
    const rowTo = Math.min(size - 1, Math.ceil(y1));
    const [r, g, bl] = layer.color;
    for (let py = rowFrom; py <= rowTo; py++) {
      cov.fill(0);
      let minX = size;
      let maxX = -1;
      for (let k = 0; k < SUB; k++) {
        const y = py + (k + 0.5) / SUB;
        const xs = [];
        for (const e of edges) if (y >= e[1] && y < e[3]) xs.push(e[0] + ((y - e[1]) / (e[3] - e[1])) * (e[2] - e[0]));
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const xa = Math.max(0, xs[i]);
          const xb = Math.min(size, xs[i + 1]);
          if (xb <= xa) continue;
          const ia = Math.floor(xa);
          const ib = Math.min(size - 1, Math.floor(xb));
          minX = Math.min(minX, ia);
          maxX = Math.max(maxX, ib);
          if (ia === ib) cov[ia] += (xb - xa) / SUB;
          else {
            cov[ia] += (ia + 1 - xa) / SUB;
            for (let ix = ia + 1; ix < ib; ix++) cov[ix] += 1 / SUB;
            cov[ib] += (xb - ib) / SUB;
          }
        }
      }
      for (let px = minX; px <= maxX; px++) {
        const a = Math.min(1, cov[px]) * layer.alpha;
        if (a <= 0) continue;
        const o = (py * size + px) * 4;
        img[o] = r * a + img[o] * (1 - a);
        img[o + 1] = g * a + img[o + 1] * (1 - a);
        img[o + 2] = bl * a + img[o + 2] * (1 - a);
        img[o + 3] = a + img[o + 3] * (1 - a);
      }
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = img[i * 4 + 3];
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = a > 0 ? Math.round(Math.min(1, img[i * 4 + c] / a) * 255) : 0;
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  return rgba;
}

// ---------- PNG / ICO / ICNS ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** ICO с PNG внутри (Windows Vista и новее). */
function encodeIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // плоскости
    head.writeUInt16LE(32, e + 6); // бит на пиксель
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(([, d]) => d)]);
}
/** ICNS из PNG-элементов (macOS 10.7 и новее). */
function encodeIcns(entries) {
  const parts = entries.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

export function makeIcons(outDir = join(here, 'build'), svgPath = join(here, 'icon.svg')) {
  const svg = parseSvg(readFileSync(svgPath, 'utf8'));
  const png = new Map();
  const get = (s) => {
    if (!png.has(s)) png.set(s, encodePng(rasterize(svg, s), s));
    return png.get(s);
  };
  mkdirSync(join(outDir, 'icons'), { recursive: true });
  writeFileSync(join(outDir, 'icon.png'), get(1024));
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(join(outDir, 'icons', `${s}x${s}.png`), get(s));
  writeFileSync(join(outDir, 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 128, 256].map((s) => [s, get(s)])));
  const icns = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 512], ['ic14', 1024]];
  writeFileSync(join(outDir, 'icon.icns'), encodeIcns(icns.map(([t, s]) => [t, get(s)])));
  return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = makeIcons(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`Значки → ${out}`);
}
