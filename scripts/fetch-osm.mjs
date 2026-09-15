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
 *
 * Запросы, сборка контуров, упрощение, классы и запись — в src/sim/osmBuild.ts: тот же код
 * собирает дома и лес места полёта в браузере (src/ui/placeOsm.ts). Здесь — аргументы, кэш
 * ответов в папке, сеть с User-Agent и запись файла. Node запускает .ts напрямую (снятие типов).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILDINGS_RADIUS_DEFAULT_M, buildOsm, createOverpass, encodeOsm, lineLengthDm } from '../src/sim/osmBuild.ts';

const USER_AGENT = 'vtol-sim/1.0 (fetch-osm.mjs: buildings, forests, roads and water for a 3D flight simulator view)';

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
const overrides = args.heights ? JSON.parse(readFileSync(args.heights, 'utf8')) : {};

// --- Overpass: сеть и кэш ответов ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const network = createOverpass({
  post: (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(300_000),
    }),
  sleep,
  warn: (m) => console.warn(m),
});
/** Ответ из --cache (имя файла — по подписи и тексту запроса) или из сети с записью в кэш. */
async function overpass(query, label) {
  const key = createHash('sha1').update(query).digest('hex').slice(0, 12);
  const cacheFile = args.cache ? join(args.cache, `${label.replace(/[^\p{L}\d]+/gu, '_')}_${key}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const els = await network(query, label);
  if (cacheFile) {
    mkdirSync(args.cache, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(els));
  }
  return els;
}

// --- сборка и запись ---
const { data, stats } = await buildOsm({ site: { lat: lat0, lon: lon0 }, bounds: { south, west, north, east }, minBuildingArea, buildingsRadiusM, overrides }, overpass);
const { buildings, forests, runways, roads, water, waterways } = data;
const { bytes, sizes } = encodeOsm(data);
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, bytes);
const count = (arr, names, key) => names.map((k, i) => `${k} ${arr.filter((x) => x[key] === i).length}`).join(', ');
const holes = forests.reduce((s, f) => s + f.rings.length - 1, 0);
const km = (arr) => (arr.reduce((s, r) => s + lineLengthDm(r.line), 0) / 1000).toFixed(0);
console.log(`Дома: ${buildings.length} (${count(buildings, ['house', 'apartments', 'industrial', 'other'], 'kind')})${stats.dropped ? `, отброшено мелких: ${stats.dropped}` : ''}; знаковых: ${stats.landmarks}, труб, башен и мачт отдельно: ${stats.structures}`);
console.log(`Леса: ${forests.length} (дыр: ${holes})`);
console.log(`Полосы: ${runways.length} (с твёрдым покрытием: ${runways.filter((r) => r.paved).length})`);
console.log(`Дороги: ${roads.length}, ${km(roads)} км (${count(roads, ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track', 'rail'], 'cls')}), мостов: ${roads.filter((r) => r.flags & 2).length}, отброшено: ${stats.roadsDropped}`);
console.log(`Вода: ${water.length} (${count(water, ['lake', 'river', 'reservoir', 'basin'], 'kind')})`);
console.log(`Реки и ручьи: ${waterways.length}, ${km(waterways)} км (${count(waterways, ['river', 'stream', 'canal'], 'kind')}), отрезков внутри площадей воды: ${stats.inside}`);
console.log(`Разделы, КБ: ${Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}`).join(', ')}`);
console.log(`Файл: ${args.out}, ${(bytes.length / 1024 / 1024).toFixed(2)} МБ`);
