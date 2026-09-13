#!/usr/bin/env node
/*
 * Дома, леса, взлётные полосы, дороги и вода из OpenStreetMap (Overpass API) → двоичный osm.bin профиля.
 *
 *   node scripts/fetch-osm.mjs --site <lat>,<lon> --bounds <south>,<west>,<north>,<east> --out <file.bin> [--cache <папка>]
 *
 * site — площадка профиля (location.site), bounds — область профиля (location.region).
 * Дома — в радиусе 14 км от площадки, полосы — в области; леса, дороги и вода — в области с
 * запасом 3 км, как рельеф: expandBounds(region, 3000) из src/ui/terrainData.ts.
 * Координаты — локальные метры относительно площадки (как toLocal в src/sim/mission.ts).
 * Формат файла описан в src/sim/osm.ts. Координаты места в скрипте не хранятся и не печатаются:
 * в выводе только количества и размеры. --cache — папка для ответов Overpass (повторный запуск
 * без сети; имя файла — по тексту запроса); в ней координаты места, поэтому держать её рядом с
 * приватным профилем и удалять.
 *
 * --buildings-radius — радиус домов от площадки, м (по умолчанию 14 000). --heights — таблица
 * поправок по id OSM, JSON: {"w123": 25} или {"w123": {"height": 25, "roof": "pyramidal",
 * "kind": "other", "levels": 5}} — высоты знаковых зданий и сооружений, которых нет в OSM.
 * Знаковое (храмы, достопримечательности, памятники, высотки, трубы, башни и мачты) не
 * отбрасывается по площади (--min-building-area) и упрощается мягче.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const USER_AGENT = 'vtol-sim/1.0 (fetch-osm.mjs: buildings, forests, roads and water for a 3D flight simulator view)';
const R = 6371000;
const RAD = Math.PI / 180;
/** Дома — в этом радиусе от площадки, м (--buildings-radius). */
const BUILDINGS_RADIUS_DEFAULT_M = 14000;
/** Выше — ошибка в теге: у самых высоких зданий и труб меньше. */
const MAX_HEIGHT_M = 500;
/** Леса, дороги и вода — в области, расширенной на столько, м (как рельеф). */
const MARGIN_M = 3000;

// --- аргументы ---
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--site', '--bounds', '--out', '--min-building-area', '--cache', '--buildings-radius', '--heights'].includes(a)) out[a.slice(2)] = argv[++i];
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
  console.error('Использование: node scripts/fetch-osm.mjs --site <lat>,<lon> --bounds <south>,<west>,<north>,<east> --out <file.bin> [--min-building-area м²] [--buildings-radius м] [--heights файл.json] [--cache папка]');
  process.exit(2);
}
const [lat0, lon0] = nums(args.site, 2, 'site');
const [south, west, north, east] = nums(args.bounds, 4, 'bounds');
if (!(south < north && west < east)) throw new Error('--bounds: south < north и west < east');
const minBuildingArea = args['min-building-area'] ? Number(args['min-building-area']) : 0;
const buildingsRadiusM = args['buildings-radius'] ? Number(args['buildings-radius']) : BUILDINGS_RADIUS_DEFAULT_M;
if (!(buildingsRadiusM > 0)) throw new Error('--buildings-radius: ожидается число метров');
/** Поправки по id OSM: «w123», «n45», «r6» → высота или {height, roof, kind, levels}. */
const OVERRIDES = args.heights ? JSON.parse(readFileSync(args.heights, 'utf8')) : {};
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
/** Область профиля в локальных метрах — для полос. */
const [REG_E0, REG_N0] = toLocal(south, west);
const [REG_E1, REG_N1] = toLocal(north, east);
/** Область с запасом — та же формула, что у expandBounds для рельефа. */
const dLat = MARGIN_M / 111_195;
const dLon = MARGIN_M / (111_195 * Math.cos((((south + north) / 2) * Math.PI) / 180));
const [AREA_E0, AREA_N0] = toLocal(south - dLat, west - dLon);
const [AREA_E1, AREA_N1] = toLocal(north + dLat, east + dLon);

/** Прямоугольник, разрезанный на k × k частей, — строки bbox Overpass. */
function tiles(e0, n0, e1, n1, k) {
  const out = [];
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < k; i++) {
      out.push(bboxLocal(e0 + ((e1 - e0) * i) / k, n0 + ((n1 - n0) * j) / k, e0 + ((e1 - e0) * (i + 1)) / k, n0 + ((n1 - n0) * (j + 1)) / k));
    }
  }
  return out;
}

// --- Overpass ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
async function overpass(query, label) {
  const key = createHash('sha1').update(query).digest('hex').slice(0, 12);
  const cacheFile = args.cache ? join(args.cache, `${label.replace(/[^\p{L}\d]+/gu, '_')}_${key}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  // Между запросами — пауза: у публичного сервера ограничение на частоту.
  if (requests++ > 0) await sleep(3000);
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
        } else {
          const els = json.elements ?? [];
          if (cacheFile) {
            mkdirSync(args.cache, { recursive: true });
            writeFileSync(cacheFile, JSON.stringify(els));
          }
          return els;
        }
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
/** Упрощение открытой ломаной. */
function simplifyLine(r, tol) {
  const n = r.length / 2;
  if (n <= 2) return r;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  dpMark(r, 0, n - 1, tol * tol, keep);
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
/** Длина ломаной в дм-координатах, м. */
function lineLengthDm(q) {
  let s = 0;
  for (let i = 0; i + 3 < q.length; i += 2) s += Math.hypot(q[i + 2] - q[i], q[i + 3] - q[i + 1]);
  return s / 10;
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
/** Отсечение ломаной прямоугольником (Лян — Барски по отрезкам) → куски внутри. */
function clipLineRect(r, e0, n0, e1, n1) {
  const runs = [];
  let cur = null;
  const n = r.length / 2;
  for (let i = 0; i + 1 < n; i++) {
    const ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * i + 2], by = r[2 * i + 3];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, ax - e0], [dx, e1 - ax], [-dy, ay - n0], [dy, n1 - ay]]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (!ok || t0 > t1) {
      cur = null;
      continue;
    }
    const sx = ax + dx * t0, sy = ay + dy * t0, ex = ax + dx * t1, ey = ay + dy * t1;
    if (!cur || t0 > 0) {
      cur = [sx, sy];
      runs.push(cur);
    }
    cur.push(ex, ey);
    if (t1 < 1) cur = null;
  }
  return runs.filter((c) => c.length >= 4);
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
  const pool = ways.filter((g) => g && g.length >= 2 && g.every(Boolean)).map((g) => g.slice());
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
/** Полигоны элемента Overpass: замкнутая линия или мультиполигон. */
function polygonsOf(el) {
  if (el.type === 'way') {
    const ring = closedRing(el.geometry);
    return ring ? [{ outer: ring, holes: [] }] : [];
  }
  if (el.type === 'relation') return multipolygon(el);
  return [];
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
/** roof:shape → код формы крыши (src/sim/osm.ts ROOF_SHAPES). */
const ROOF = { flat: 1, gabled: 2, saltbox: 2, gambrel: 2, mansard: 2, 'half-hipped': 3, hipped: 3, pyramidal: 4, dome: 4, onion: 4, cone: 4, round: 2, skillion: 5, lean_to: 5 };
/** Храмы: building=* или amenity=place_of_worship. */
const WORSHIP = new Set(['cathedral', 'church', 'chapel', 'mosque', 'synagogue', 'temple', 'shrine', 'monastery', 'bell_tower']);
const isWorship = (tags) => WORSHIP.has(tags.building) || tags.amenity === 'place_of_worship';
/** Знаковое: узнаётся с воздуха по силуэту — не отбрасывается по площади и упрощается мягче. */
function isLandmark(tags) {
  return (
    isWorship(tags) ||
    tags.tourism === 'attraction' ||
    (!!tags.historic && tags.historic !== 'no') ||
    /^(tower|mast|chimney)$/.test(tags.man_made ?? '') ||
    parseNum(tags.height) >= 50 ||
    parseNum(tags['building:levels']) >= 16
  );
}
/** Поправка по id OSM (--heights) или null. */
function overrideOf(el) {
  const o = OVERRIDES[`${el.type[0]}${el.id}`];
  return o == null ? null : typeof o === 'number' ? { height: o } : o;
}
function buildingKind(tags, area, ov = null) {
  const b = tags.building;
  let kind;
  let h;
  // Высота до карниза без тегов: частный дом — одноэтажный (так чаще всего в посёлках).
  if (HOUSE.has(b)) [kind, h] = ['house', 4.5];
  else if (APARTMENTS.has(b)) [kind, h] = ['apartments', 15];
  else if (INDUSTRIAL.has(b)) [kind, h] = ['industrial', 8];
  else if (SMALL.has(b)) [kind, h] = ['other', 3];
  // Храм без высоты: часовня ниже, собор выше.
  else if (isWorship(tags)) [kind, h] = ['other', b === 'cathedral' ? 25 : b === 'chapel' ? 8 : 14];
  else if (tags.man_made === 'chimney' || tags['tower:type'] === 'cooling') [kind, h] = ['industrial', 40];
  else if (tags.man_made === 'tower' || tags.man_made === 'mast') [kind, h] = ['other', 25];
  else [kind, h] = area < 250 ? ['house', 4.5] : ['other', 6];
  const height = parseNum(tags.height);
  const roofHeight = parseNum(tags['roof:height']);
  const levelsTag = ov?.levels > 0 ? ov.levels : parseNum(tags['building:levels']);
  const levels = levelsTag > 0 ? Math.min(60, Math.round(levelsTag)) : 0;
  // height — до верха крыши, в файле — до карниза.
  if (height > 0) h = roofHeight > 0 && roofHeight < height ? height - roofHeight : height;
  else if (levels > 0) h = levels * 3 + 1;
  if (ov?.height > 0) h = ov.height;
  if (ov?.kind in KIND) kind = ov.kind;
  let roof = ROOF[ov?.roof ?? tags['roof:shape']] ?? 0;
  // Купол или шпиль небольшого храма без roof:shape — шатром.
  if (!roof && isWorship(tags) && area < 1500) roof = ROOF.pyramidal;
  return { kind, height: Math.min(MAX_HEIGHT_M, Math.max(2, h)), levels, roof };
}

async function fetchBuildings() {
  const r = buildingsRadiusM;
  const parts = [];
  // Квадраты со стороной до 14 км (при радиусе 14 км — четыре квадранта): меньше нагрузка на
  // сервер за один запрос, и ответ по большому городу не упирается в тайм-аут.
  const k = 2 * Math.ceil(r / 14000);
  const step = (2 * r) / k;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) parts.push(bboxLocal(-r + i * step, -r + j * step, -r + (i + 1) * step, -r + (j + 1) * step));
  const seen = new Set();
  const out = [];
  let dropped = 0;
  let landmarks = 0;
  for (let p = 0; p < parts.length; p++) {
    const bb = parts[p];
    const q = `[out:json][timeout:180];(way["building"]["building"!="no"](${bb});relation["building"]["building"!="no"]["type"="multipolygon"](${bb}););out geom;`;
    const els = await overpass(q, `дома ${p + 1}/${parts.length}`);
    for (const el of els) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = el.tags ?? {};
      const landmark = isLandmark(tags);
      const ov = overrideOf(el);
      for (const { outer: raw } of polygonsOf(el)) {
        let ring = simplifyRing(ccw(raw), landmark ? 0.2 : 0.5);
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
        const { kind, height, levels, roof } = buildingKind(tags, area, ov);
        if (kind === 'other' && area < minBuildingArea && !landmark && !ov) {
          dropped++;
          continue;
        }
        if (landmark) landmarks++;
        out.push({ kind: KIND[kind], heightDm: Math.round(height * 10), levels, roof, ring });
      }
    }
  }
  return { buildings: out, dropped, seen, landmarks };
}

// --- трубы, башни и мачты, не обведённые как здания ---
/** Высота без тега и поперечник точки, м. Мачта — тонкая, у высокой трубы — широкое основание. */
const STRUCTURE = {
  chimney: { kind: 'industrial', height: 40, diameter: (h) => (h >= 150 ? 16 : h >= 60 ? 8 : 4) },
  tower: { kind: 'other', height: 25, diameter: () => 8 },
  mast: { kind: 'other', height: 30, diameter: () => 2.5 },
};

async function fetchStructures(seen) {
  const r = buildingsRadiusM;
  const els = await overpass(`[out:json][timeout:180];nwr["man_made"~"^(chimney|tower|mast)$"](${bboxLocal(-r, -r, r, r)});out geom;`, 'сооружения');
  const out = [];
  for (const el of els) {
    const key = `${el.type}${el.id}`;
    // Обведённые как здания уже взяты вместе с домами.
    if (seen.has(key)) continue;
    seen.add(key);
    const t = el.tags ?? {};
    const s = STRUCTURE[t.man_made];
    const type = t['tower:type'];
    if (!s || type === 'lighting' || t.disused === 'yes' || t['demolished:man_made']) continue;
    const ov = overrideOf(el);
    let height = ov?.height > 0 ? ov.height : parseNum(t.height);
    if (!(height > 0)) height = type === 'cooling' ? 60 : type === 'bell_tower' ? 15 : s.height;
    let ring;
    if (el.type === 'node') {
      const dTag = parseNum(t.diameter);
      const d = dTag > 0 && dTag < 200 ? dTag : type === 'cooling' ? 50 : s.diameter(height);
      const [ce, cn] = toLocal(el.lat, el.lon);
      ring = [];
      for (let i = 0; i < 8; i++) ring.push(ce + (d / 2) * Math.cos((i * Math.PI) / 4), cn + (d / 2) * Math.sin((i * Math.PI) / 4));
    } else {
      const p = polygonsOf(el)[0];
      if (!p) continue;
      ring = simplifyRing(ccw(p.outer), 0.2);
    }
    const q = quantize(ring, true);
    const n = q.length / 2;
    if (n < 3) continue;
    let ce = 0;
    let cn = 0;
    for (let i = 0; i < n; i++) {
      ce += q[2 * i] / 10;
      cn += q[2 * i + 1] / 10;
    }
    if ((ce / n) ** 2 + (cn / n) ** 2 > r * r) continue;
    const kind = ov?.kind in KIND ? ov.kind : type === 'cooling' ? 'industrial' : s.kind;
    out.push({ kind: KIND[kind], heightDm: Math.round(Math.min(MAX_HEIGHT_M, Math.max(2, height)) * 10), levels: 0, roof: ROOF[ov?.roof] ?? ROOF.flat, ring: q });
  }
  return out;
}

// --- леса ---
/**
 * Запрос по квадратам 2 × 2 области с запасом, без повторов на стыках: ответ по всей области
 * с лесами или водой большого района не укладывается в тайм-аут сервера. Геометрия у
 * элемента полная, режется по всей области потом — итог тот же, что одним запросом.
 */
async function overpassTiled(query, label) {
  const parts = tiles(AREA_E0, AREA_N0, AREA_E1, AREA_N1, 2);
  const seen = new Set();
  const out = [];
  for (let p = 0; p < parts.length; p++) {
    for (const el of await overpass(query(parts[p]), `${label} ${p + 1}/${parts.length}`)) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
  }
  return out;
}

async function fetchForests() {
  const [e0, n0, e1, n1] = [AREA_E0, AREA_N0, AREA_E1, AREA_N1];
  const els = await overpassTiled(
    (bb) =>
      `[out:json][timeout:180];(` +
      `way["landuse"="forest"](${bb});way["natural"="wood"](${bb});` +
      `relation["landuse"="forest"]["type"="multipolygon"](${bb});relation["natural"="wood"]["type"="multipolygon"](${bb});` +
      `);out geom;`,
    'леса',
  );
  const prep = (raw) => {
    const r = quantize(simplifyRing(clipRect(raw, e0, n0, e1, n1), 6), true);
    if (r.length / 2 < 3) return null;
    const area = Math.abs(signedArea(r.map((v) => v / 10)));
    return area >= 400 ? r : null;
  };
  const out = [];
  for (const el of els) {
    const tags = el.tags ?? {};
    const lt = tags.leaf_type;
    const leaf = lt === 'needleleaved' ? 0 : lt === 'broadleaved' ? 1 : 2;
    for (const p of polygonsOf(el)) {
      const outer = prep(p.outer);
      if (!outer) continue;
      const rings = [outer];
      for (const h of p.holes) {
        const hole = prep(h);
        if (hole) rings.push(hole);
      }
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
  const bb = bboxLocal(REG_E0, REG_N0, REG_E1, REG_N1);
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
    if (q.length < 4) continue;
    out.push({ widthDm: Math.round(width * 10), paved: paved ? 1 : 0, line: q });
  }
  return out;
}

// --- дороги ---
/** Класс (src/sim/osm.ts ROAD_CLASSES) и ширина по умолчанию, м. */
const HIGHWAY = {
  motorway: [0, 10], motorway_link: [0, 5],
  trunk: [1, 9], trunk_link: [1, 5],
  primary: [2, 8], primary_link: [2, 5],
  secondary: [3, 7], secondary_link: [3, 5],
  tertiary: [4, 5], tertiary_link: [4, 5],
  unclassified: [5, 5], road: [5, 5],
  residential: [6, 5], living_street: [6, 4],
  service: [7, 3],
  track: [8, 3],
};
const RAILWAY = { rail: 4, narrow_gauge: 3, light_rail: 3.5, tram: 3 };
const PAVED = new Set(['asphalt', 'concrete', 'paved', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'chipseal']);
const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'ground', 'earth', 'grass', 'sand', 'compacted', 'mud', 'pebblestone', 'woodchips', 'rock', 'grass_paver', 'dirt/sand', 'clay']);
/** Служебные проезды, которых слишком много и которые с высоты не видны. */
const SERVICE_SKIP = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);
/** Лишние дорожные признаки дают разрывы там, где их нет: мосты — отдельные линии. */

async function fetchRoads() {
  const parts = tiles(AREA_E0, AREA_N0, AREA_E1, AREA_N1, 3);
  const hw = Object.keys(HIGHWAY).join('|');
  const rw = Object.keys(RAILWAY).join('|');
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (let p = 0; p < parts.length; p++) {
    const bb = parts[p];
    const q = `[out:json][timeout:180];(way["highway"~"^(${hw})$"](${bb});way["railway"~"^(${rw})$"](${bb}););out tags geom;`;
    const els = await overpass(q, `дороги ${p + 1}/${parts.length}`);
    for (const el of els) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const key = el.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = el.tags ?? {};
      if (t.area === 'yes' || (t.tunnel && t.tunnel !== 'no') || t.disused === 'yes' || t.abandoned === 'yes') continue;
      if (t.highway === 'service' && SERVICE_SKIP.has(t.service)) {
        dropped++;
        continue;
      }
      let cls;
      let width;
      if (t.highway && HIGHWAY[t.highway]) [cls, width] = HIGHWAY[t.highway];
      else if (t.railway && RAILWAY[t.railway]) [cls, width] = [9, RAILWAY[t.railway]];
      else continue;
      const oneway = t.oneway === 'yes' || t.oneway === '1';
      if (cls <= 2 && oneway) width -= 2;
      const wTag = parseNum(t.width);
      const lanes = parseNum(t.lanes);
      if (cls < 9 && wTag >= 2 && wTag <= 30) width = wTag;
      else if (cls < 8 && lanes >= 1 && lanes <= 8) width = Math.max(width, lanes * 3.5);
      let paved = cls !== 8;
      if (PAVED.has(t.surface)) paved = true;
      else if (UNPAVED.has(t.surface)) paved = false;
      else if (cls === 8 && t.tracktype === 'grade1') paved = true;
      const bridge = !!t.bridge && t.bridge !== 'no';
      const lit = t.lit === 'yes';
      const tol = cls >= 7 ? 1.5 : 1;
      for (const run of clipLineRect(geomToLocal(el.geometry), AREA_E0, AREA_N0, AREA_E1, AREA_N1)) {
        const line = quantize(simplifyLine(run, tol), false);
        if (line.length < 4) continue;
        if (!bridge && lineLengthDm(line) < (cls >= 7 ? 25 : 10)) {
          dropped++;
          continue;
        }
        out.push({ cls, flags: (paved ? 1 : 0) | (bridge ? 2 : 0) | (lit ? 4 : 0), widthDm: Math.round(width * 10), line });
      }
    }
  }
  return { roads: out, dropped };
}

// --- вода ---
function waterKind(t) {
  if (t.waterway === 'riverbank' || ['river', 'canal', 'stream', 'oxbow', 'rapids'].includes(t.water)) return 1;
  if (t.landuse === 'reservoir' || t.water === 'reservoir') return 2;
  if (t.landuse === 'basin' || ['wastewater', 'basin', 'lagoon'].includes(t.water)) return 3;
  return 0;
}

async function fetchWater() {
  const els = await overpassTiled(
    (bb) =>
      `[out:json][timeout:240];(` +
      `way["natural"="water"](${bb});relation["natural"="water"]["type"="multipolygon"](${bb});` +
      `way["waterway"="riverbank"](${bb});relation["waterway"="riverbank"]["type"="multipolygon"](${bb});` +
      `way["landuse"~"^(reservoir|basin)$"](${bb});relation["landuse"~"^(reservoir|basin)$"]["type"="multipolygon"](${bb});` +
      // Не «out tags geom»: без тела у мультиполигона нет членов — реки площадями пропадали бы.
      `);out geom;`,
    'вода',
  );
  const prep = (raw) => {
    const r = quantize(simplifyRing(clipRect(raw, AREA_E0, AREA_N0, AREA_E1, AREA_N1), 1.5), true);
    if (r.length / 2 < 3) return null;
    return Math.abs(signedArea(r.map((v) => v / 10))) >= 150 ? r : null;
  };
  const seen = new Set();
  const out = [];
  for (const el of els) {
    const key = `${el.type}${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = el.tags ?? {};
    // Пересыхающие пруды и болотца с высоты не вода.
    if (t.intermittent === 'yes' || t.seasonal === 'yes' || t.natural === 'wetland') continue;
    const kind = waterKind(t);
    for (const p of polygonsOf(el)) {
      const outer = prep(p.outer);
      if (!outer) continue;
      const rings = [outer];
      for (const h of p.holes) {
        const hole = prep(h);
        if (hole) rings.push(hole);
      }
      out.push({ kind, rings });
    }
  }
  return out;
}

/** Индекс площадей воды по клеткам: точка внутри — true. */
function waterIndex(water) {
  const CELL = 500;
  const grid = new Map();
  const polys = water.map((w) => {
    const rings = w.rings.map((r) => r.map((v) => v / 10));
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    const o = rings[0];
    for (let i = 0; i < o.length; i += 2) {
      e0 = Math.min(e0, o[i]); e1 = Math.max(e1, o[i]);
      n0 = Math.min(n0, o[i + 1]); n1 = Math.max(n1, o[i + 1]);
    }
    return { rings, e0, n0, e1, n1 };
  });
  polys.forEach((p, k) => {
    for (let j = Math.floor(p.n0 / CELL); j <= Math.floor(p.n1 / CELL); j++) {
      for (let i = Math.floor(p.e0 / CELL); i <= Math.floor(p.e1 / CELL); i++) {
        const key = `${i},${j}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(k);
      }
    }
  });
  return (e, n) => {
    for (const k of grid.get(`${Math.floor(e / CELL)},${Math.floor(n / CELL)}`) ?? []) {
      const p = polys[k];
      if (e < p.e0 || e > p.e1 || n < p.n0 || n > p.n1) continue;
      let inside = false;
      for (const r of p.rings) if (pointInRing(e, n, r)) inside = !inside;
      if (inside) return true;
    }
    return false;
  };
}

const WATERWAY = { river: [0, 10], stream: [1, 3], canal: [2, 6] };

async function fetchWaterways(water) {
  const bb = bboxLocal(AREA_E0, AREA_N0, AREA_E1, AREA_N1);
  const els = await overpass(`[out:json][timeout:180];way["waterway"~"^(river|stream|canal)$"](${bb});out tags geom;`, 'реки');
  const inWater = waterIndex(water);
  const out = [];
  let inside = 0;
  for (const el of els) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags ?? {};
    // Трубы под дорогами и пересыхающие ручьи не рисуем.
    if ((t.tunnel && t.tunnel !== 'no') || t.intermittent === 'yes' || t.seasonal === 'yes') continue;
    const [kind, def] = WATERWAY[t.waterway];
    const wTag = parseNum(t.width);
    const width = wTag >= 1 && wTag <= 200 ? wTag : def;
    for (const run of clipLineRect(geomToLocal(el.geometry), AREA_E0, AREA_N0, AREA_E1, AREA_N1)) {
      const line = simplifyLine(run, 1.5);
      // Осевые внутри площадей воды не нужны: режем на куски вне воды.
      const n = line.length / 2;
      const inPt = [];
      for (let i = 0; i < n; i++) inPt.push(inWater(line[2 * i], line[2 * i + 1]));
      let cur = null;
      const pieces = [];
      for (let i = 0; i + 1 < n; i++) {
        const me = (line[2 * i] + line[2 * i + 2]) / 2, mn = (line[2 * i + 1] + line[2 * i + 3]) / 2;
        const drop = inPt[i] && inPt[i + 1] && inWater(me, mn);
        if (drop) {
          inside++;
          cur = null;
          continue;
        }
        if (!cur) {
          cur = [line[2 * i], line[2 * i + 1]];
          pieces.push(cur);
        }
        cur.push(line[2 * i + 2], line[2 * i + 3]);
      }
      for (const piece of pieces) {
        const q = quantize(piece, false);
        if (q.length < 4 || lineLengthDm(q) < 30) continue;
        out.push({ kind, widthDm: Math.round(width * 10), line: q });
      }
    }
  }
  return { waterways: out, inside };
}

// --- запись ---
/** Растущий буфер байтов. */
class Bytes {
  buf = new Uint8Array(1 << 20);
  n = 0;
  room(k) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u8(v) {
    this.room(1);
    this.buf[this.n++] = v & 0xff;
  }
  u32(v) {
    for (let i = 0; i < 4; i++) this.u8(Math.floor(v / 256 ** i));
  }
  varint(v) {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new Error(`varint: ${v}`);
    while (v >= 128) {
      this.u8((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }
  zz(v) {
    this.varint(v >= 0 ? 2 * v : -2 * v - 1);
  }
  /** Точки в дм: число и разности. */
  points(arr) {
    this.varint(arr.length / 2);
    let pe = 0;
    let pn = 0;
    for (let i = 0; i < arr.length; i += 2) {
      this.zz(arr[i] - pe);
      this.zz(arr[i + 1] - pn);
      pe = arr[i];
      pn = arr[i + 1];
    }
  }
  rings(rings) {
    this.varint(rings.length);
    for (const r of rings) this.points(r);
  }
  bytes() {
    return this.buf.slice(0, this.n);
  }
}

function encode(d) {
  const w = new Bytes();
  const sizes = {};
  let mark = 0;
  const section = (name) => {
    sizes[name] = w.n - mark;
    mark = w.n;
  };
  for (const c of 'OSM2') w.u8(c.charCodeAt(0));
  for (const k of ['buildings', 'forests', 'runways', 'roads', 'water', 'waterways']) w.u32(d[k].length);
  section('заголовок');
  for (const b of d.buildings) {
    w.u8(b.kind);
    w.u8(b.levels);
    w.u8(b.roof);
    w.varint(b.heightDm);
    w.points(b.ring);
  }
  section('дома');
  for (const f of d.forests) {
    w.u8(f.leaf);
    w.rings(f.rings);
  }
  section('леса');
  for (const r of d.runways) {
    w.u8(r.paved);
    w.varint(r.widthDm);
    w.points(r.line);
  }
  section('полосы');
  for (const r of d.roads) {
    w.u8(r.cls);
    w.u8(r.flags);
    w.varint(r.widthDm);
    w.points(r.line);
  }
  section('дороги');
  for (const r of d.water) {
    w.u8(r.kind);
    w.rings(r.rings);
  }
  section('вода');
  for (const r of d.waterways) {
    w.u8(r.kind);
    w.varint(r.widthDm);
    w.points(r.line);
  }
  section('реки');
  return { bytes: w.bytes(), sizes };
}

const { buildings, dropped, seen, landmarks } = await fetchBuildings();
const structures = await fetchStructures(seen);
buildings.push(...structures);
const forests = await fetchForests();
const runways = await fetchRunways();
const { roads, dropped: roadsDropped } = await fetchRoads();
const water = await fetchWater();
const { waterways, inside } = await fetchWaterways(water);
const { bytes, sizes } = encode({ buildings, forests, runways, roads, water, waterways });
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, bytes);
const count = (arr, names, key) => names.map((k, i) => `${k} ${arr.filter((x) => x[key] === i).length}`).join(', ');
const holes = forests.reduce((s, f) => s + f.rings.length - 1, 0);
const km = (arr) => (arr.reduce((s, r) => s + lineLengthDm(r.line), 0) / 1000).toFixed(0);
console.log(`Дома: ${buildings.length} (${count(buildings, ['house', 'apartments', 'industrial', 'other'], 'kind')})${dropped ? `, отброшено мелких: ${dropped}` : ''}; знаковых: ${landmarks}, труб, башен и мачт отдельно: ${structures.length}`);
console.log(`Леса: ${forests.length} (дыр: ${holes})`);
console.log(`Полосы: ${runways.length} (с твёрдым покрытием: ${runways.filter((r) => r.paved).length})`);
console.log(`Дороги: ${roads.length}, ${km(roads)} км (${count(roads, ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track', 'rail'], 'cls')}), мостов: ${roads.filter((r) => r.flags & 2).length}, отброшено: ${roadsDropped}`);
console.log(`Вода: ${water.length} (${count(water, ['lake', 'river', 'reservoir', 'basin'], 'kind')})`);
console.log(`Реки и ручьи: ${waterways.length}, ${km(waterways)} км (${count(waterways, ['river', 'stream', 'canal'], 'kind')}), отрезков внутри площадей воды: ${inside}`);
console.log(`Разделы, КБ: ${Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}`).join(', ')}`);
console.log(`Файл: ${args.out}, ${(bytes.length / 1024 / 1024).toFixed(2)} МБ`);
