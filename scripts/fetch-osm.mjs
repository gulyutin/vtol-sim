#!/usr/bin/env node
/*
 * Дома, леса и взлётные полосы из OpenStreetMap (Overpass API) → двоичный osm.bin профиля.
 *
 *   node scripts/fetch-osm.mjs --site <lat>,<lon> --bounds <south>,<west>,<north>,<east> --out <file.bin>
 *
 * Координаты — локальные метры относительно площадки (как toLocal в src/sim/mission.ts).
 * Формат файла описан в src/sim/osm.ts. Координаты места в скрипте не хранятся и не печатаются:
 * в выводе только количества и размер файла.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'vtol-sim/1.0 (fetch-osm.mjs: buildings, forests and runways for a 3D flight simulator view)';
const R = 6371000;
const RAD = Math.PI / 180;
/** Дома — в этом радиусе от площадки, м. */
const BUILDINGS_RADIUS_M = 14000;
/** Леса — в границах, расширенных на столько, м. */
const FOREST_MARGIN_M = 3000;

// --- аргументы ---
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site' || a === '--bounds' || a === '--out' || a === '--min-building-area') out[a.slice(2)] = argv[++i];
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return out;
}
const nums = (s, n, name) => {
  const v = String(s ?? '').split(',').map(Number);
  if (v.length !== n || v.some((x) => !Number.isFinite(x))) throw new Error(`--${name}: ожидается ${n} чисел через запятую`);
  return v;
};
const args = parseArgs(process.argv.slice(2));
if (!args.site || !args.bounds || !args.out) {
  console.error('Использование: node scripts/fetch-osm.mjs --site <lat>,<lon> --bounds <south>,<west>,<north>,<east> --out <file.bin> [--min-building-area м²]');
  process.exit(2);
}
const [lat0, lon0] = nums(args.site, 2, 'site');
const [south, west, north, east] = nums(args.bounds, 4, 'bounds');
if (!(south < north && west < east)) throw new Error('--bounds: south < north и west < east');
const minBuildingArea = args['min-building-area'] ? Number(args['min-building-area']) : 0;
const cosLat0 = Math.cos(lat0 * RAD);

/** Как toLocal: восток, север, м. */
const toLocal = (lat, lon) => [(lon - lon0) * RAD * R * cosLat0, (lat - lat0) * RAD * R];
/** Прямоугольник вокруг площадки в локальных метрах → строка bbox Overpass. */
function bboxLocal(e0, n0, e1, n1) {
  const s = lat0 + n0 / R / RAD;
  const nn = lat0 + n1 / R / RAD;
  const w = lon0 + e0 / (R * cosLat0) / RAD;
  const e = lon0 + e1 / (R * cosLat0) / RAD;
  return `${s.toFixed(6)},${w.toFixed(6)},${nn.toFixed(6)},${e.toFixed(6)}`;
}

// --- Overpass ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function overpass(query, label) {
  const attempts = 7;
  let wait = 8000;
  for (let i = 0; i < attempts; i++) {
    const url = ENDPOINTS[i % ENDPOINTS.length];
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(300_000),
      });
      if (res.ok) {
        const json = await res.json();
        // Тайм-аут или нехватка памяти на сервере приходят с кодом 200 и пометкой remark.
        if (typeof json.remark === 'string' && /runtime error|timed out|out of memory/i.test(json.remark)) {
          console.warn(`  ${label}: ${host} — ошибка выполнения запроса, повтор`);
        } else return json.elements ?? [];
      } else if (res.status === 429 || res.status >= 500) {
        console.warn(`  ${label}: ${host} — HTTP ${res.status}, повтор`);
        if (res.status === 429) wait = Math.max(wait, 30000);
      } else {
        throw new Error(`${label}: ${host} — HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && /HTTP 4\d\d/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
      console.warn(`  ${label}: ${host} — ${err instanceof Error ? err.name : 'ошибка'}, повтор`);
    }
    if (i < attempts - 1) {
      await sleep(wait);
      wait = Math.min(wait * 2, 90000);
    }
  }
  throw new Error(`${label}: Overpass не ответил после ${attempts} попыток`);
}

// --- геометрия ---
/** Ориентированная площадь кольца [e0,n0,e1,n1,…] (без повтора первой точки), м², > 0 — против часовой. */
function signedArea(r) {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return s / 2;
}
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}
/** Дуглас — Пекер для открытой ломаной, возвращает флаги оставленных точек. */
function dpMark(pts, i0, i1, tol2, keep) {
  const stack = [[i0, i1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[2 * i], pts[2 * i + 1], pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
}
/** Упрощение замкнутого кольца: делим в точке, самой далёкой от первой. */
function simplifyRing(r, tol) {
  const n = r.length / 2;
  if (n <= 3) return r;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[2 * i] - r[0]) ** 2 + (r[2 * i + 1] - r[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const pts = new Float64Array(2 * (n + 1));
  pts.set(r);
  pts[2 * n] = r[0];
  pts[2 * n + 1] = r[1];
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  dpMark(pts, 0, far, tol * tol, keep);
  dpMark(pts, far, n, tol * tol, keep);
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  return out;
}
/** Округление до дециметров и удаление подряд идущих совпадений. */
function quantize(r, closed) {
  const out = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const e = Math.round(r[2 * i] * 10);
    const nn = Math.round(r[2 * i + 1] * 10);
    const k = out.length;
    if (k && out[k - 2] === e && out[k - 1] === nn) continue;
    out.push(e, nn);
  }
  if (closed) while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}
/** Отсечение кольца полуплоскостью a·e + b·n ≤ c (Сазерленд — Ходжмен). */
function clipHalf(r, a, b, c) {
  const out = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pe = r[2 * i], pn = r[2 * i + 1], qe = r[2 * j], qn = r[2 * j + 1];
    const fp = a * pe + b * pn - c;
    const fq = a * qe + b * qn - c;
    if (fp <= 0) out.push(pe, pn);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push(pe + t * (qe - pe), pn + t * (qn - pn));
    }
  }
  return out;
}
function clipRect(r, e0, n0, e1, n1) {
  let o = clipHalf(r, -1, 0, -e0);
  o = clipHalf(o, 1, 0, e1);
  o = clipHalf(o, 0, -1, -n0);
  return clipHalf(o, 0, 1, n1);
}
function pointInRing(px, py, r) {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** geometry Overpass [{lat, lon}] → [e, n, …]; замкнутость отдельно. */
function geomToLocal(geom) {
  const out = [];
  for (const g of geom) {
    if (!g) continue;
    const [e, n] = toLocal(g.lat, g.lon);
    out.push(e, n);
  }
  return out;
}
const samePt = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
/** Кольцо из замкнутой линии без повтора первой точки, или null. */
function closedRing(geom) {
  if (!geom || geom.length < 4 || !samePt(geom[0], geom[geom.length - 1])) return null;
  return geomToLocal(geom.slice(0, -1));
}
/** Сборка колец мультиполигона из линий-членов: стыкуем концы. */
function assembleRings(ways) {
  const pool = ways.filter((g) => g && g.length >= 2).map((g) => g.slice());
  const rings = [];
  while (pool.length) {
    let cur = pool.pop();
    let guard = 0;
    while (!samePt(cur[0], cur[cur.length - 1]) && guard++ < 100000) {
      const end = cur[cur.length - 1];
      let idx = pool.findIndex((g) => samePt(g[0], end) || samePt(g[g.length - 1], end));
      if (idx < 0) {
        // Начало тоже может стыковаться — переворачиваем текущую и пробуем с другого конца.
        const start = cur[0];
        idx = pool.findIndex((g) => samePt(g[0], start) || samePt(g[g.length - 1], start));
        if (idx < 0) break;
        cur.reverse();
        continue;
      }
      let next = pool.splice(idx, 1)[0];
      if (!samePt(next[0], end)) next = next.reverse();
      cur = cur.concat(next.slice(1));
    }
    // Незамкнутое кольцо — замыкаем как есть, если в нём достаточно точек.
    if (!samePt(cur[0], cur[cur.length - 1])) cur.push(cur[0]);
    if (cur.length >= 4) rings.push(geomToLocal(cur.slice(0, -1)));
  }
  return rings;
}
/** Внешние и внутренние кольца мультиполигона: [{outer, holes}]. */
function multipolygon(rel) {
  const outerWays = [];
  const innerWays = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    (m.role === 'inner' ? innerWays : outerWays).push(m.geometry);
  }
  const outers = assembleRings(outerWays).map((outer) => ({ outer, holes: [] }));
  for (const inner of assembleRings(innerWays)) {
    const host = outers.find((o) => pointInRing(inner[0], inner[1], o.outer));
    if (host) host.holes.push(inner);
  }
  return outers;
}
function ccw(r) {
  if (signedArea(r) >= 0) return r;
  const out = [];
  for (let i = r.length / 2 - 1; i >= 0; i--) out.push(r[2 * i], r[2 * i + 1]);
  return out;
}
const parseNum = (s) => {
  if (s == null) return NaN;
  const str = String(s).replace(',', '.').trim();
  const v = parseFloat(str);
  if (!Number.isFinite(v)) return NaN;
  return /ft|'/.test(str) ? v * 0.3048 : v;
};

// --- здания ---
const KIND = { house: 0, apartments: 1, industrial: 2, other: 3 };
const HOUSE = new Set(['house', 'detached', 'residential', 'semidetached_house', 'terrace', 'bungalow', 'cabin']);
const APARTMENTS = new Set(['apartments', 'dormitory']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'commercial', 'retail', 'office', 'hangar', 'farm_auxiliary', 'barn']);
const SMALL = new Set(['garage', 'garages', 'shed', 'roof', 'hut']);
function buildingKind(tags, area) {
  const b = tags.building;
  let kind;
  let h;
  if (HOUSE.has(b)) [kind, h] = ['house', 6];
  else if (APARTMENTS.has(b)) [kind, h] = ['apartments', 15];
  else if (INDUSTRIAL.has(b)) [kind, h] = ['industrial', 8];
  else if (SMALL.has(b)) [kind, h] = ['other', 3];
  else [kind, h] = area < 250 ? ['house', 6] : ['other', 6];
  const height = parseNum(tags.height);
  const levels = parseNum(tags['building:levels']);
  if (height > 0) h = height;
  else if (levels > 0) h = levels * 3 + 1;
  return { kind, height: Math.min(80, Math.max(2, h)) };
}

async function fetchBuildings() {
  const r = BUILDINGS_RADIUS_M;
  const parts = [];
  // Четыре квадранта — меньше нагрузка на сервер за один запрос.
  for (const [e0, e1] of [[-r, 0], [0, r]]) for (const [n0, n1] of [[-r, 0], [0, r]]) parts.push(bboxLocal(e0, n0, e1, n1));
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (let p = 0; p < parts.length; p++) {
    const bb = parts[p];
    const q = `[out:json][timeout:180];(way["building"]["building"!="no"](${bb});relation["building"]["building"!="no"]["type"="multipolygon"](${bb}););out geom;`;
    const els = await overpass(q, `дома ${p + 1}/${parts.length}`);
    for (const el of els) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = el.tags ?? {};
      let rings = [];
      if (el.type === 'way') {
        const ring = closedRing(el.geometry);
        if (ring) rings = [ring];
      } else if (el.type === 'relation') rings = multipolygon(el).map((o) => o.outer);
      for (const raw of rings) {
        let ring = simplifyRing(ccw(raw), 0.5);
        ring = quantize(ring, true);
        const n = ring.length / 2;
        if (n < 3 || n > 65535) continue;
        const m = ring.map((v) => v / 10);
        const area = signedArea(m);
        if (area < 4) continue;
        let ce = 0;
        let cn = 0;
        for (let i = 0; i < n; i++) {
          ce += m[2 * i];
          cn += m[2 * i + 1];
        }
        ce /= n;
        cn /= n;
        if (ce * ce + cn * cn > r * r) continue;
        const { kind, height } = buildingKind(tags, area);
        if (kind === 'other' && area < minBuildingArea) {
          dropped++;
          continue;
        }
        out.push({ kind: KIND[kind], heightDm: Math.round(height * 10), ring });
      }
    }
  }
  return { buildings: out, dropped };
}

// --- леса ---
async function fetchForests() {
  const m = FOREST_MARGIN_M;
  const [e0, n0] = toLocal(south, west);
  const [e1, n1] = toLocal(north, east);
  const bb = bboxLocal(e0 - m, n0 - m, e1 + m, n1 + m);
  const q =
    `[out:json][timeout:180];(` +
    `way["landuse"="forest"](${bb});way["natural"="wood"](${bb});` +
    `relation["landuse"="forest"]["type"="multipolygon"](${bb});relation["natural"="wood"]["type"="multipolygon"](${bb});` +
    `);out geom;`;
  const els = await overpass(q, 'леса');
  const clip = (r) => clipRect(r, e0 - m, n0 - m, e1 + m, n1 + m);
  const prep = (raw) => {
    const r = quantize(simplifyRing(clip(raw), 6), true);
    if (r.length / 2 < 3) return null;
    const area = Math.abs(signedArea(r.map((v) => v / 10)));
    return area >= 400 ? r : null;
  };
  const out = [];
  for (const el of els) {
    const tags = el.tags ?? {};
    const lt = tags.leaf_type;
    const leaf = lt === 'needleleaved' ? 0 : lt === 'broadleaved' ? 1 : 2;
    let polys = [];
    if (el.type === 'way') {
      const ring = closedRing(el.geometry);
      if (ring) polys = [{ outer: ring, holes: [] }];
    } else if (el.type === 'relation') polys = multipolygon(el);
    for (const p of polys) {
      const outer = prep(p.outer);
      if (!outer) continue;
      const rings = [outer];
      for (const h of p.holes) {
        const hole = prep(h);
        if (hole) rings.push(hole);
      }
      if (rings.length > 65535) rings.length = 65535;
      out.push({ leaf, rings });
    }
  }
  return out;
}

// --- полосы ---
/** Ось и ширина полосы, нарисованной площадью: длинная сторона наименьшего описанного прямоугольника. */
function axisOfArea(r) {
  const n = r.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = r[2 * j] - r[2 * i];
    const dy = r[2 * j + 1] - r[2 * i + 1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ax = dx / len, ay = dy / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = r[2 * k] * ax + r[2 * k + 1] * ay;
      const v = -r[2 * k] * ay + r[2 * k + 1] * ax;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ax, ay, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ax, ay, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) {
    // Длинная сторона поперёк выбранного ребра — меняем оси.
    [ax, ay] = [-ay, ax];
    [u0, u1, v0, v1] = [v0, v1, -u1, -u0];
  }
  const vm = (v0 + v1) / 2;
  const pt = (u) => [u * ax - vm * ay, u * ay + vm * ax];
  return { line: [...pt(u0), ...pt(u1)], width: v1 - v0 };
}

async function fetchRunways() {
  const [e0, n0] = toLocal(south, west);
  const [e1, n1] = toLocal(north, east);
  const bb = bboxLocal(e0, n0, e1, n1);
  const els = await overpass(`[out:json][timeout:180];way["aeroway"="runway"](${bb});out geom;`, 'полосы');
  const out = [];
  for (const el of els) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const paved = ['asphalt', 'concrete', 'paved', 'concrete:plates'].includes(tags.surface);
    let width = parseNum(tags.width);
    let line;
    const closed = el.geometry.length >= 4 && samePt(el.geometry[0], el.geometry[el.geometry.length - 1]);
    if (closed || tags.area === 'yes') {
      const a = axisOfArea(geomToLocal(closed ? el.geometry.slice(0, -1) : el.geometry));
      if (!a) continue;
      line = a.line;
      if (!(width > 0)) width = a.width;
    } else line = geomToLocal(el.geometry);
    if (!(width > 0)) width = paved ? 30 : 20;
    const q = quantize(line, false);
    if (q.length < 4 || q.length / 2 > 65535) continue;
    out.push({ widthDm: Math.min(65535, Math.round(width * 10)), paved: paved ? 1 : 0, line: q });
  }
  return out;
}

// --- запись ---
function encode(buildings, forests, runways) {
  let size = 4 + 12;
  for (const b of buildings) size += 1 + 2 + 2 + b.ring.length * 4;
  for (const f of forests) {
    size += 1 + 2;
    for (const r of f.rings) size += 4 + r.length * 4;
  }
  for (const r of runways) size += 2 + 1 + 2 + r.line.length * 4;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  for (const c of 'OSM1') dv.setUint8(o++, c.charCodeAt(0));
  dv.setUint32(o, buildings.length, true);
  dv.setUint32(o + 4, forests.length, true);
  dv.setUint32(o + 8, runways.length, true);
  o += 12;
  const pts = (arr) => {
    for (const v of arr) {
      dv.setInt32(o, v, true);
      o += 4;
    }
  };
  for (const b of buildings) {
    dv.setUint8(o, b.kind);
    dv.setUint16(o + 1, Math.min(65535, b.heightDm), true);
    dv.setUint16(o + 3, b.ring.length / 2, true);
    o += 5;
    pts(b.ring);
  }
  for (const f of forests) {
    dv.setUint8(o, f.leaf);
    dv.setUint16(o + 1, f.rings.length, true);
    o += 3;
    for (const r of f.rings) {
      dv.setUint32(o, r.length / 2, true);
      o += 4;
      pts(r);
    }
  }
  for (const r of runways) {
    dv.setUint16(o, r.widthDm, true);
    dv.setUint8(o + 2, r.paved);
    dv.setUint16(o + 3, r.line.length / 2, true);
    o += 5;
    pts(r.line);
  }
  if (o !== size) throw new Error('Ошибка размера при записи');
  return new Uint8Array(buf);
}

const { buildings, dropped } = await fetchBuildings();
const forests = await fetchForests();
const runways = await fetchRunways();
const bytes = encode(buildings, forests, runways);
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, bytes);
const kinds = ['house', 'apartments', 'industrial', 'other'].map((k, i) => `${k} ${buildings.filter((b) => b.kind === i).length}`).join(', ');
const holes = forests.reduce((s, f) => s + f.rings.length - 1, 0);
console.log(`Дома: ${buildings.length} (${kinds})${dropped ? `, отброшено мелких: ${dropped}` : ''}`);
console.log(`Леса: ${forests.length} (дыр: ${holes})`);
console.log(`Полосы: ${runways.length} (с твёрдым покрытием: ${runways.filter((r) => r.paved).length})`);
console.log(`Файл: ${args.out}, ${(bytes.length / 1024 / 1024).toFixed(2)} МБ`);
