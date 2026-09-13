#!/usr/bin/env node
/*
 * Разработка: сервер Vite (текущий профиль, PROFILE=demo — демо) и Electron поверх него.
 *
 *   npm run desktop:dev [-- --offline|--online|--verbose]
 *
 * Главный процесс и preload компилируются tsc в desktop/out; изменения страницы подхватываются
 * Vite на лету, изменения main/preload — перезапуском команды.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(here, 'tsconfig.json')], { stdio: 'inherit' });

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), clearScreen: false });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('Vite не сообщил адрес сервера');
const { PROFILE } = await server.ssrLoadModule('@profile');
server.printUrls();

const electron = require('electron'); // путь к исполняемому файлу Electron
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const child = spawn(electron, [join(here, 'out', 'main.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  // Версия — как в build.mjs; без неё Electron, запущенный со скриптом, называет свою.
  env: { ...process.env, VTOL_DEV_URL: url, VTOL_PRODUCT_NAME: String(PROFILE.title), VTOL_APP_VERSION: version && version !== '0.0.0' ? version : '0.1.0' },
});
const stop = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
child.on('exit', (code) => void stop(code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
