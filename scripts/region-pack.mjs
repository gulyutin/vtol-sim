#!/usr/bin/env node
/*
 * Пакет района для работы без сети: рельеф Terrarium, снимки (только если источник задан явно) и
 * osm.bin района. Формат — src/ui/packFormat.ts; пакет кладётся в папку пакетов настольного
 * приложения или для проверки в браузере — в public/packs/<id>/.
 *
 *   node scripts/region-pack.mjs --region khibiny --out public/packs/khibiny --dry-run
 *   node scripts/region-pack.mjs --region khibiny --out public/packs/khibiny
 *   node scripts/region-pack.mjs --region elbrus --out packs/elbrus \
 *     --imagery-dir ~/ortho/tiles --imagery-tms --imagery-license "Ортофото заказчика, договор № …" \
 *     --imagery-zooms 10-16 --corridor-km 2
 *   node scripts/region-pack.mjs --bounds 67.4,33.1,67.9,33.9 --id test --out packs/test --terrain-zooms 12
 *
 * Область: --region <id> — область района из профиля (location.region) с запасом 3 км, как у
 * рельефа в приложении; либо --bounds south,west,north,east (--id — имя пакета). Районы профиля
 * берутся через vite-node (скрипт перезапускает себя под ним), PROFILE=demo — демо-профиль.
 *
 * Рельеф: --terrain-zooms (по умолчанию 8-12). z12 — сетка высот, по ней считается физика и
 * строятся сетки 3D-рельефа (loadTerrain, terrainLod); z8–11 — только для тонированной карты
 * без сети при отдалении, это около десятой части тайлов.
 *
 * Снимки: источника по умолчанию нет. Esri World Imagery массово скачивать и хранить для работы
 * без сети без лицензии ArcGIS нельзя — такие адреса сборщик не принимает.
 *   --imagery-url 'https://…/{z}/{x}/{y}.jpg'  шаблон сервера, на который есть права ({-y} — TMS);
 *   --imagery-dir <папка>                      готовые тайлы <z>/<x>/<y>.jpg, например из GeoTIFF:
 *                                              gdal2tiles.py --xyz --tiledriver=JPEG -z 10-16 ortho.tif <папка>
 *                                              (без --xyz у gdal2tiles нумерация TMS — добавьте --imagery-tms);
 *   --imagery-license "…"                      обязательно: пишется в manifest.json и видно в приложении;
 *   --imagery-source "…"                       название источника (по умолчанию — сервер или папка);
 *   --imagery-zooms 10-16                      уровни снимков;
 *   --corridor-km 2 [--corridor-from 14]       с уровня corridor-from — только в коридоре ± км вокруг
 *                                              площадок, участков и маршрутов заданий района.
 *
 * OSM: копируется osm.bin района (--osm <файл> — другой, --no-osm — без него).
 *
 * Загрузка: --dry-run — только посчитать тайлы и примерный объём. Иначе — не больше --concurrency
 * (4, до 6) запросов разом и --rate (8) в секунду, повторы с паузой, уважение Retry-After.
 * Прерванная загрузка продолжается той же командой: готовые тайлы не качаются заново.
 * manifest.json пишется последним — без него пакет не считается установленным.
 * --contact <почта или адрес> — контакт в User-Agent (или переменная REGION_PACK_CONTACT).
 *
 * Координаты места в выводе не печатаются: только количества и размеры.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), '..');

// Районы профиля и расчёт тайлов — в TypeScript проекта: перезапуск под vite-node.
if (!process.env.REGION_PACK_INNER) {
  const viteNode = join(root, 'node_modules/vite-node/vite-node.mjs');
  if (!existsSync(viteNode)) {
    console.error('Нет vite-node — сначала npm install');
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [viteNode, self, '--', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, REGION_PACK_INNER: '1' } });
  process.exit(r.status ?? 1);
}

const fmt = await import('../src/ui/packFormat.ts');
const { PACK_FORMAT, REGION_MARGIN_M, expandBounds, parseZooms, planPack, listTiles, corridorAreas, missionGeometry, formatBytes } = fmt;

// --- аргументы ---
const VALUE = ['region', 'bounds', 'id', 'title', 'out', 'terrain-zooms', 'imagery-url', 'imagery-dir', 'imagery-license', 'imagery-source', 'imagery-zooms', 'corridor-km', 'corridor-from', 'osm', 'concurrency', 'rate', 'contact'];
const FLAG = ['dry-run', 'imagery-tms', 'no-osm', 'allow-public', 'help'];
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    const name = a.startsWith('--') ? a.slice(2) : '';
    if (VALUE.includes(name)) {
      if (argv[i + 1] === undefined) fail(`--${name}: нет значения`);
      out[name] = argv[++i];
    } else if (FLAG.includes(name)) out[name] = true;
    else fail(`Неизвестный аргумент: ${a} (--help — справка)`);
  }
  return out;
}
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.region && !args.bounds) || !args.out) {
  const head = readFileSync(self, 'utf8').split('\n').slice(1, 44).join('\n');
  console.log(head.replace(/^ ?\*\/?/gm, '').trim());
  process.exit(args.help ? 0 : 2);
}

// --- район ---
/** Готовые публичные районы (src/game/regions.ts): только их можно класть в public/. */
const PUBLIC_REGIONS = ['elbrus', 'khibiny', 'baikal'];
let id;
let title;
let bounds;
let location = null;
let osmSrc = null;
if (args.region) {
  const { REGION_PRESETS } = await import('../src/game/regions.ts');
  const r = REGION_PRESETS.find((p) => p.id === args.region);
  if (!r) fail(`Нет района «${args.region}». Есть: ${REGION_PRESETS.map((p) => p.id).join(', ')}`);
  id = args.id ?? r.id;
  title = args.title ?? r.title;
  location = r.location;
  bounds = expandBounds(r.location.region, REGION_MARGIN_M);
  if (r.osmUrl) osmSrc = assetPath(r.osmUrl);
} else {
  const v = String(args.bounds).split(',').map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x)) || !(v[0] < v[2] && v[1] < v[3])) fail('--bounds: south,west,north,east (south < north, west < east)');
  bounds = { south: v[0], west: v[1], north: v[2], east: v[3] };
  id = args.id ?? fail('--bounds: задайте --id — имя пакета (латиница)');
  title = args.title ?? id;
}
if (!/^[\w.-]+$/.test(id)) fail('--id: только латиница, цифры, «_», «-» и «.»');
if (args.osm) osmSrc = resolve(args.osm);
if (args['no-osm']) osmSrc = null;
if (osmSrc && !existsSync(osmSrc)) fail(`Нет файла OSM: ${relative(root, osmSrc)}`);

/** Адрес ассета из vite (`?url`) → файл на диске. */
function assetPath(url) {
  const clean = decodeURIComponent(String(url).split('?')[0]);
  if (clean.startsWith('/@fs/')) return clean.slice(4);
  return join(root, clean.replace(/^\//, ''));
}

const out = resolve(args.out);
// Конфиденциальность: в public/ — только готовые публичные районы (или демо-профиль).
const publicDir = join(root, 'public') + sep;
if ((out + sep).startsWith(publicDir)) {
  const ok = args.region ? PUBLIC_REGIONS.includes(args.region) || (process.env.PROFILE === 'demo' && args.region === 'home') : !!args['allow-public'];
  if (!ok) fail(`В public/ можно класть только пакеты публичных районов (${PUBLIC_REGIONS.join(', ')}). Соберите в packs/${id} — папка не публикуется.`);
}

// --- снимки ---
let imagery = null;
if (args['imagery-url'] || args['imagery-dir']) {
  if (args['imagery-url'] && args['imagery-dir']) fail('Снимки: либо --imagery-url, либо --imagery-dir');
  if (!args['imagery-license']) fail('Снимки: --imagery-license "…" обязателен — на каких условиях снимки можно хранить и возить. Он пишется в manifest.json.');
  if (args['imagery-url']) {
    const url = String(args['imagery-url']);
    if (!/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{-?y\}/.test(url)) fail('--imagery-url: шаблон с {z}, {x} и {y} (или {-y} для TMS)');
    if (/arcgisonline\.com|\/World_Imagery\//i.test(url))
      fail('Esri World Imagery массово скачивать и хранить для работы без сети без лицензии ArcGIS нельзя. Нужен свой источник снимков — сервер с правами или готовые тайлы (--imagery-dir).');
    imagery = { kind: 'url', url, source: args['imagery-source'] ?? new URL(url.replace(/\{[^}]*\}/g, '0')).host };
  } else {
    const dir = resolve(args['imagery-dir']);
    if (!existsSync(dir)) fail(`Нет папки снимков: ${dir}`);
    imagery = { kind: 'dir', dir, source: args['imagery-source'] ?? `тайлы заказчика (${basename(dir)})` };
  }
  imagery.license = String(args['imagery-license']);
  imagery.tms = !!args['imagery-tms'];
} else if (args['imagery-zooms'] || args['corridor-km'] || args['imagery-license']) {
  fail('Снимки: задайте источник — --imagery-url или --imagery-dir (источника по умолчанию нет)');
}

const terrainZooms = parseZooms(args['terrain-zooms'] ?? '8-12');
const imageryZooms = imagery ? parseZooms(args['imagery-zooms'] ?? '10-16') : null;
let corridor = null;
if (imagery && args['corridor-km']) {
  const km = Number(args['corridor-km']);
  if (!(km > 0)) fail('--corridor-km: ширина коридора в км, больше нуля');
  if (!location) fail('--corridor-km — только с --region: коридор строится по площадкам и маршрутам заданий района');
  const fromZoom = Number(args['corridor-from'] ?? 14);
  corridor = { spec: { km, fromZoom }, areas: corridorAreas(missionGeometry(location), km) };
}
const plan = planPack({ bounds, terrainZooms, imageryZooms, corridor });

const concurrency = Math.max(1, Math.min(6, Number(args.concurrency ?? 4) || 4));
const rate = Math.max(0.5, Number(args.rate ?? 8) || 8);
const contact = args.contact ?? process.env.REGION_PACK_CONTACT ?? '';
const USER_AGENT = `vtol-sim-region-pack/1.0 (offline region packs for a flight training simulator${contact ? `; contact: ${contact}` : ''})`;
const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// --- задания ---
const jobs = [
  ...listTiles(plan.terrain.levels).map(([z, x, y]) => ({ layer: 'terrain', z, x, y, dest: join(out, 'terrain', String(z), String(x), `${y}.png`) })),
  ...(plan.imagery ? listTiles(plan.imagery.levels).map(([z, x, y]) => ({ layer: 'imagery', z, x, y, dest: join(out, 'imagery', String(z), String(x), `${y}.jpg`) })) : []),
];
const have = (f) => existsSync(f) && statSync(f).size > 0;
const already = jobs.filter((j) => have(j.dest)).length;
const perZoom = (p) =>
  Object.entries(p)
    .map(([z, n]) => `z${z}: ${n}`)
    .join(', ');
const osmBytes = osmSrc ? statSync(osmSrc).size : 0;

console.log(`Пакет «${id}» (${title}) → ${relative(root, out) || out}`);
console.log(`  рельеф Terrarium ${zoomText(terrainZooms)}: ${plan.terrain.total} тайлов (${perZoom(plan.terrain.perZoom)}) ≈ ${formatBytes(plan.terrain.bytes)}`);
if (plan.imagery)
  console.log(
    `  снимки ${zoomText(imageryZooms)}${corridor ? `, с z${corridor.spec.fromZoom} — коридор ±${corridor.spec.km} км (${corridor.areas.length} участков)` : ', вся область'}: ${plan.imagery.total} тайлов (${perZoom(plan.imagery.perZoom)}) ≈ ${formatBytes(plan.imagery.bytes)}; источник: ${imagery.source}`,
  );
else console.log('  снимки: нет (источник не задан) — без сети 3D и карта в цветах рельефа');
console.log(`  OSM: ${osmSrc ? `osm.bin, ${formatBytes(osmBytes)}` : 'нет'}`);
console.log(`  всего: ${plan.tiles} тайлов ≈ ${formatBytes(plan.bytes + osmBytes)} (оценка по среднему тайлу); уже есть: ${already}`);
if (args['dry-run']) process.exit(0);

function zoomText(z) {
  return z.length > 1 ? `z${z[0]}–${z[z.length - 1]}` : `z${z[0]}`;
}

// --- загрузка ---
mkdirSync(out, { recursive: true });
// Пакет без манифеста не считается установленным: старый — прочь до конца сборки.
rmSync(join(out, 'manifest.json'), { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
/** Не чаще rate запросов в секунду на все потоки. */
async function slot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / rate;
  if (at > now) await sleep(at - now);
}

const MAGIC = { terrain: [0x89, 0x50, 0x4e, 0x47], imagery: [0xff, 0xd8, 0xff] };
const isKind = (buf, layer) => MAGIC[layer].every((b, i) => buf[i] === b);

function save(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
}

function tileUrl(j) {
  if (j.layer === 'terrain') return TERRARIUM(j.z, j.x, j.y);
  const yTms = 2 ** j.z - 1 - j.y;
  return imagery.url.replace('{z}', j.z).replace('{x}', j.x).replace('{-y}', yTms).replace('{y}', imagery.tms ? yTms : j.y);
}

/** Тайл по сети: 'ok' | 'missing' (нет у источника) | исключение после всех попыток. */
async function download(j) {
  const url = tileUrl(j);
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    await slot();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404 || res.status === 410 || res.status === 204) return 'missing';
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (!isKind(buf, j.layer)) throw new Error(`${j.layer === 'terrain' ? 'не PNG' : 'не JPEG'} (${res.headers.get('content-type') ?? '?'})`);
        save(j.dest, buf);
        return 'ok';
      }
      last = new Error(`HTTP ${res.status}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      if ((res.status === 429 || res.status === 503) && retryAfter > 0) {
        await sleep(Math.min(120, retryAfter) * 1000);
        continue;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (e) {
      last = e;
      if (String(e?.message).startsWith('не ')) break;
    }
    await sleep(1000 * 2 ** attempt * (0.8 + 0.4 * Math.random()));
  }
  throw new Error(`${j.layer} ${j.z}/${j.x}/${j.y}: ${last?.message ?? last}`);
}

/** Тайл из папки заказчика. */
function copyFromDir(j) {
  const y = imagery.tms ? 2 ** j.z - 1 - j.y : j.y;
  const base = join(imagery.dir, String(j.z), String(j.x), String(y));
  const src = ['.jpg', '.jpeg', '.JPG', '.JPEG'].map((e) => base + e).find(existsSync);
  if (!src) {
    if (existsSync(base + '.png') || existsSync(base + '.webp')) throw new Error(`${relative(imagery.dir, base)}: тайлы не JPEG — пересоберите с --tiledriver=JPEG (gdal2tiles) или переведите в JPEG`);
    return 'missing';
  }
  const buf = readFileSync(src);
  if (!isKind(buf, 'imagery')) throw new Error(`${relative(imagery.dir, src)}: не JPEG`);
  save(j.dest, buf);
  return 'ok';
}

const stat = { done: 0, skipped: 0, fetched: 0, missing: { terrain: 0, imagery: 0 }, failed: [], bytes: 0 };
const started = Date.now();
let lastPrint = 0;
function progress(final = false) {
  const now = Date.now();
  if (!final && now - lastPrint < 1000) return;
  lastPrint = now;
  const s = (now - started) / 1000;
  const line = `  ${stat.done}/${jobs.length} тайлов · скачано ${stat.fetched} (${formatBytes(stat.bytes)}) · было ${stat.skipped} · нет у источника ${stat.missing.terrain + stat.missing.imagery} · ошибок ${stat.failed.length} · ${s.toFixed(0)} с`;
  process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
}

let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    try {
      if (have(j.dest)) stat.skipped++;
      else {
        const r = j.layer === 'imagery' && imagery.kind === 'dir' ? copyFromDir(j) : await download(j);
        if (r === 'missing') stat.missing[j.layer]++;
        else {
          stat.fetched++;
          stat.bytes += statSync(j.dest).size;
        }
      }
    } catch (e) {
      stat.failed.push(e.message);
    }
    stat.done++;
    progress();
  }
}
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  next = jobs.length;
  console.log('\nОстанавливаюсь после текущих запросов; продолжить — той же командой.');
});
await Promise.all(Array.from({ length: concurrency }, worker));
progress(true);
console.log('');
if (interrupted) process.exit(130);
if (stat.failed.length) {
  console.error(`Не скачано ${stat.failed.length} тайлов, например:\n  ${stat.failed.slice(0, 5).join('\n  ')}\nЗапустите ту же команду ещё раз — готовое не качается заново. manifest.json не записан.`);
  process.exit(1);
}

// --- OSM и манифест ---
if (osmSrc) copyFileSync(osmSrc, join(out, 'osm.bin'));
else rmSync(join(out, 'osm.bin'), { force: true });

const layerStat = (layer) => {
  let tiles = 0;
  let bytes = 0;
  for (const j of jobs) if (j.layer === layer && have(j.dest)) (tiles++, (bytes += statSync(j.dest).size));
  return { tiles, bytes };
};
const t = layerStat('terrain');
const i = plan.imagery ? layerStat('imagery') : null;
const manifest = {
  format: PACK_FORMAT,
  id,
  title,
  bounds,
  created: new Date().toISOString(),
  bytes: t.bytes + (i?.bytes ?? 0) + osmBytes,
  tiles: t.tiles + (i?.tiles ?? 0),
  terrain: {
    encoding: 'terrarium',
    zooms: terrainZooms,
    levels: plan.terrain.levels,
    tiles: t.tiles,
    bytes: t.bytes,
    missing: stat.missing.terrain,
    source: 'AWS Terrain Tiles (Terrarium, s3://elevation-tiles-prod)',
    license: 'AWS Open Data: SRTM, GMTED2010, ETOPO1 и др. — с указанием источников, https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  },
  imagery: plan.imagery
    ? {
        format: 'jpg',
        zooms: imageryZooms,
        levels: plan.imagery.levels,
        tiles: i.tiles,
        bytes: i.bytes,
        missing: stat.missing.imagery,
        source: imagery.source,
        license: imagery.license,
        ...(corridor ? { corridorKm: corridor.spec.km } : {}),
      }
    : null,
  osm: osmSrc ? { file: 'osm.bin', bytes: osmBytes, source: 'OpenStreetMap (Overpass API, scripts/fetch-osm.mjs)', license: 'ODbL 1.0 — © участники OpenStreetMap, https://www.openstreetmap.org/copyright' } : null,
  generator: 'scripts/region-pack.mjs',
};
// Проверка тем же разбором, что в приложении.
fmt.parseManifest(JSON.parse(JSON.stringify(manifest)));
writeFileSync(
  join(out, 'ATTRIBUTION.txt'),
  [
    `Пакет района «${title}» (${id}), собран ${manifest.created}.`,
    `Рельеф: ${manifest.terrain.source}. ${manifest.terrain.license}`,
    manifest.imagery ? `Снимки: ${manifest.imagery.source}. Лицензия: ${manifest.imagery.license}` : 'Снимков в пакете нет.',
    manifest.osm ? `Дома, дороги, вода и лес: ${manifest.osm.license}` : 'OSM в пакете нет.',
    '',
  ].join('\n'),
);
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
const missing = stat.missing.terrain + stat.missing.imagery;
console.log(`Готово: ${manifest.tiles} тайлов, ${formatBytes(manifest.bytes)}${missing ? `; у источника не нашлось ${missing} тайлов — там «нет данных»` : ''}.`);
