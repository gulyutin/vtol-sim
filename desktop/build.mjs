#!/usr/bin/env node
/*
 * Сборка установщиков настольного приложения (electron-builder).
 *
 *   node desktop/build.mjs                  — текущий профиль, установщик для этой ОС
 *   node desktop/build.mjs --demo           — демо-профиль (как PROFILE=demo)
 *   node desktop/build.mjs --mac|--win|--linux [--x64|--arm64|--universal] [--dir]
 *
 * Шаги: название и модель берутся из профиля (@profile, как в vite.config.ts); Vite собирает
 * страницу с base '/' в desktop/.stage/app/dist; туда же — скомпилированные main/preload и
 * package.json приложения (без зависимостей: всё уже в бандле). Значки — из desktop/icon.svg.
 * Демо-сборка перед упаковкой проверяется по private/export/forbidden.txt, если он есть.
 * Установщики — в release/demo или release/private; ничего не публикуется (publish: never).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './make-icons.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

if (flag('--demo')) process.env.PROFILE = 'demo';
const demo = process.env.PROFILE === 'demo' || !existsSync(join(root, 'private/profile/index.ts'));
const kind = demo ? 'demo' : 'private';
const stage = join(here, '.stage', kind);
const appDir = join(stage, 'app');
const buildRes = join(here, 'build');
const outDir = join(root, 'release', kind);
// Вшиваемые пакеты районов: папка packs/ проекта (scripts/region-pack.mjs --out packs/<id>) или
// VTOL_BUNDLED_PACKS. Демо — только явно через VTOL_BUNDLED_PACKS: в packs/ могут лежать районы
// закрытого профиля.
const bundledPacks = process.env.VTOL_BUNDLED_PACKS ?? (demo ? null : join(root, 'packs'));

const step = (s) => console.log(`\n▶ ${s}`);

// ---------- профиль ----------

step(`профиль: ${demo ? 'демо' : 'закрытый (private/profile)'}`);
const vite = await import('vite');
const configFile = join(root, 'vite.config.ts');
const server = await vite.createServer({
  root,
  configFile,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
});
let PROFILE;
try {
  ({ PROFILE } = await server.ssrLoadModule('@profile'));
} finally {
  await server.close();
}
const title = String(PROFILE?.title ?? '').trim();
const modelName = String(PROFILE?.modelName ?? '').replace(/[^a-z0-9-]/gi, '');
if (!title) throw new Error('В профиле нет title');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPkg.version && rootPkg.version !== '0.0.0' ? rootPkg.version : '0.1.0';
const slug = demo ? 'vtol-sim-demo' : 'vtol-sim-local';
console.log(`  название: ${demo ? title : '(из профиля)'}; версия ${version}; модель ${demo ? modelName : '(из профиля)'}`);

// ---------- страница ----------

step('сборка страницы (Vite, base /)');
rmSync(stage, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
await vite.build({
  root,
  configFile,
  base: '/',
  logLevel: 'warn',
  build: { outDir: join(appDir, 'dist'), emptyOutDir: true },
});

// Лишнее из public/: служебные файлы Finder и модели других профилей.
const walk = (dir, fn) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p, name);
  }
};
walk(join(appDir, 'dist'), (p, name) => {
  if (name === '.DS_Store' || name === 'Thumbs.db') rmSync(p);
});
// Пакеты районов из public/packs (раскладка для браузера) в asar не кладём: приложение читает
// их по app://packs/ из <userData>/packs и <resources>/packs (см. bundledPacks).
rmSync(join(appDir, 'dist', 'packs'), { recursive: true, force: true });
const modelsDir = join(appDir, 'dist', 'models');
if (existsSync(modelsDir)) {
  for (const name of readdirSync(modelsDir)) if (name !== `${modelName}.glb`) rmSync(join(modelsDir, name), { recursive: true });
}

// ---------- главный процесс, preload, значки ----------

step('главный процесс и preload (tsc)');
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(here, 'tsconfig.json')], { stdio: 'inherit' });
for (const f of ['main.cjs', 'preload.cjs']) cpSync(join(here, 'out', f), join(appDir, f));

step('значки из desktop/icon.svg');
makeIcons(buildRes);
cpSync(join(buildRes, 'icons', '512x512.png'), join(appDir, 'icon.png'));

writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: slug,
      productName: title,
      version,
      description: 'Тренажёр оператора: симулятор миссии VTOL-самолёта',
      author: { name: 'vtol-sim' },
      homepage: 'https://github.com/gulyutin/vtol-sim', // обязателен для deb
      desktopName: `${slug}.desktop`, // Linux: окно связывается с ярлыком (WM_CLASS)
      main: 'main.cjs',
    },
    null,
    2,
  ) + '\n',
);

// ---------- проверка демо-сборки по списку запрещённого ----------

const hasPacks = bundledPacks !== null && existsSync(bundledPacks) && readdirSync(bundledPacks).some((n) => !n.startsWith('.'));
if (hasPacks) console.log(`  вшиваются пакеты районов из ${relative(root, bundledPacks) || bundledPacks}: ${readdirSync(bundledPacks).filter((n) => !n.startsWith('.')).join(', ')}`);
const forbiddenFile = join(root, 'private/export/forbidden.txt');
if (demo && existsSync(forbiddenFile)) {
  step('проверка демо-сборки по private/export/forbidden.txt');
  const patterns = readFileSync(forbiddenFile, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => new RegExp(s, 'iu'));
  // Допустимые фрагменты бандла (имена из шейдеров three.js и т. п.) лежат рядом со списком —
  // private/export/bundle-allow.txt: регулярные выражения с учётом регистра, только для .js.
  const allowFile = join(root, 'private/export/bundle-allow.txt');
  const ALLOW = existsSync(allowFile)
    ? readFileSync(allowFile, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
        .map((s) => new RegExp(s, 'gu'))
    : [];
  const hits = [];
  const scan = (dir, only) =>
    walk(dir, (p, name) => {
      if (only && !only(name)) return;
      const rel = relative(root, p);
      const binary = /\.(glb|bin|png|jpe?g|webp|ico|icns|mp3|ogg|wav|m4a|woff2?)$/i.test(name);
      let text = readFileSync(p, binary ? 'latin1' : 'utf8');
      if (/\.js$/.test(name)) for (const re of ALLOW) text = text.replace(re, '');
      text.split('\n').forEach((line, i) => {
        for (const re of patterns) if (re.test(line)) hits.push(`${rel}:${i + 1}: /${re.source}/  ${line.trim().slice(0, 100)}`);
      });
      if (!/^[\w./@-]+$/.test(rel.split(sep).join('/'))) hits.push(`${rel}: имя файла не латиницей`);
    });
  // Сжатые медиафайлы проверяются только по имени: случайные байты дают ложные «совпадения» с числами.
  scan(appDir, (name) => !/\.(mp3|ogg|wav|m4a|png|jpe?g|webp|ico)$/i.test(name));
  if (hasPacks) scan(bundledPacks, (name) => name === 'manifest.json');
  if (hits.length) {
    console.error(`НАЙДЕНО ${hits.length} совпадений — демо-установщик собирать нельзя:\n${hits.slice(0, 50).join('\n')}`);
    process.exit(1);
  }
  console.log('  запрещённого не найдено');
}

// ---------- electron-builder ----------

const platforms = ['--mac', '--win', '--linux'].filter(flag);
step(`упаковка (electron-builder): ${platforms.length ? platforms.join(' ') : 'текущая ОС'} → ${relative(root, outDir)}`);
const hasMacCert = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: demo ? 'ru.vtolsim.demo' : 'ru.vtolsim.local',
  productName: title,
  electronVersion,
  directories: { app: appDir, output: outDir, buildResources: buildRes },
  // Зависимости уже в бандле Vite. Без исключения electron-builder, не найдя node_modules
  // у приложения, берёт производственные зависимости корневого package.json.
  files: ['**/*', '!node_modules{,/**/*}'],
  asar: true,
  npmRebuild: false,
  electronLanguages: ['ru', 'en', 'en-US'],
  extraResources: hasPacks ? [{ from: bundledPacks, to: 'packs', filter: ['**/*', '!**/.DS_Store'] }] : [],
  artifactName: `${slug}-\${version}-\${os}-\${arch}.\${ext}`,
  publish: null,
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: join(buildRes, 'icon.icns'),
    category: 'public.app-category.simulation-games',
    darkModeSupport: true,
    // Без сертификата — подпись ad-hoc (иначе на Apple Silicon приложение «повреждено»);
    // hardened runtime нужен только для нотаризации, с ad-hoc он мешает запуску.
    identity: hasMacCert ? undefined : '-',
    hardenedRuntime: hasMacCert,
    gatekeeperAssess: false,
  },
  dmg: { writeUpdateInfo: false },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: join(buildRes, 'icon.ico'),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: title,
    uninstallDisplayName: title,
    language: '1049',
    installerLanguages: ['ru_RU'],
    multiLanguageInstaller: false,
    unicode: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    installerIcon: join(buildRes, 'icon.ico'),
    uninstallerIcon: join(buildRes, 'icon.ico'),
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    icon: join(buildRes, 'icons'),
    category: 'Education',
    executableName: slug,
    synopsis: 'Симулятор миссии VTOL-самолёта',
    maintainer: 'vtol-sim',
  },
};

const builder = require('electron-builder');
const archFlags = Object.fromEntries(['x64', 'arm64', 'universal'].filter((a) => flag(`--${a}`)).map((a) => [a, true]));
const files = await builder.build({
  projectDir: root,
  publish: 'never',
  config,
  ...(flag('--mac') ? { mac: [] } : {}),
  ...(flag('--win') ? { win: [] } : {}),
  ...(flag('--linux') ? { linux: [] } : {}),
  ...(flag('--dir') ? { dir: true } : {}),
  ...archFlags,
});

step('готово');
for (const f of files.filter((f) => !f.endsWith('.blockmap') && existsSync(f))) {
  console.log(`  ${relative(root, f)}  ${(statSync(f).size / 1048576).toFixed(1)} МБ`);
}
