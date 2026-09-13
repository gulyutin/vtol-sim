/*
 * Главный процесс настольного приложения.
 *
 * - Окно симулятора: contextIsolation, sandbox, без nodeIntegration, CSP, запрет навигации
 *   за пределы приложения и новых окон.
 * - Протокол app://: app://app/… — файлы сборки (dist), app://packs/<regionId>/… — пакеты
 *   районов из <userData>/packs, затем из <resources>/packs. Нет файла — 404.
 * - Режим без сети (меню «Файл» или ключ --offline, запоминается): всё, кроме app://,
 *   отменяется в session.webRequest, так что fetch падает сразу, а не висит.
 * - Мост window.vtolDesktop (preload.cts): version, platform, packsBaseUrl, offline.
 * - Размер, положение и полноэкранный режим окна запоминаются в <userData>/settings.json.
 * - Журнал главного процесса и ошибок страницы: <userData>/logs/main.log (--verbose — всё подряд).
 *
 * Разработка: desktop/dev.mjs задаёт VTOL_DEV_URL (сервер Vite) и VTOL_PRODUCT_NAME.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell } from 'electron';
import type { MenuItemConstructorOptions, Rectangle, WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------- константы и пути ----------

const SCHEME = 'app';
const APP_HOST = 'app';
const PACKS_HOST = 'packs';
const APP_ORIGIN = `${SCHEME}://${APP_HOST}`;
const APP_URL = `${APP_ORIGIN}/index.html`;
const PACKS_BASE_URL = `${SCHEME}://${PACKS_HOST}/`;

const DEV_URL = !app.isPackaged ? process.env.VTOL_DEV_URL : undefined;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : undefined;
const VERBOSE = process.argv.includes('--verbose') || process.env.VTOL_VERBOSE === '1';
/** Версия приложения; при разработке Electron со скриптом называет свою — её подменяет dev.mjs. */
const APP_VERSION = !app.isPackaged && process.env.VTOL_APP_VERSION ? process.env.VTOL_APP_VERSION : app.getVersion();

if (DEV_URL && process.env.VTOL_PRODUCT_NAME) {
  // Отдельная папка данных для разработки, чтобы не спорить с установленным приложением.
  const name = `${process.env.VTOL_PRODUCT_NAME} (dev)`;
  app.setName(name);
  app.setPath('userData', path.join(app.getPath('appData'), name));
}

const USER_DATA = app.getPath('userData');
const DIST_DIR = process.env.VTOL_DIST_DIR ? path.resolve(process.env.VTOL_DIST_DIR) : path.join(__dirname, 'dist');
const USER_PACKS_DIR = path.join(USER_DATA, 'packs');
const BUNDLED_PACKS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'packs')
  : path.resolve(process.env.VTOL_BUNDLED_PACKS ?? path.join(__dirname, '..', '..', 'packs')); // desktop/out → packs/ проекта
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');
const LOG_FILE = path.join(USER_DATA, 'logs', 'main.log');

const PLATFORM: 'win' | 'mac' | 'linux' = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

// ---------- журнал ----------

function log(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  const text = parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  (level === 'info' ? process.stdout : process.stderr).write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* журнал не обязателен */
  }
}

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1_000_000) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log'));
} catch {
  /* нет журнала — не беда */
}

process.on('uncaughtException', (e) => log('error', 'uncaughtException', e));
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', e));

// ---------- настройки ----------

interface Settings {
  bounds?: Rectangle;
  maximized?: boolean;
  fullscreen?: boolean;
  offline?: boolean;
}

function loadSettings(): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as unknown;
    return s && typeof s === 'object' ? (s as Settings) : {};
  } catch {
    return {};
  }
}

const settings = loadSettings();

function saveSettings(): void {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    log('warn', 'настройки не сохранены:', e);
  }
}

let offline = settings.offline === true;
if (process.argv.includes('--offline') || process.argv.includes('--online')) {
  offline = process.argv.includes('--offline');
  settings.offline = offline;
  saveSettings();
}

// ---------- до готовности приложения ----------

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- протокол app:// ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.pbf': 'application/x-protobuf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const mimeOf = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

function contentSecurityPolicy(): string {
  const dev = DEV_ORIGIN ? ` ${DEV_ORIGIN} ${DEV_ORIGIN.replace(/^http/, 'ws')}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' app: data: blob: https:",
    `connect-src 'self' app: data: blob: https:${dev}`,
    "media-src 'self' app: data: blob:",
    "font-src 'self' app: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } });
}

/** Путь из URL внутри корня или null (выход за корень, пустые и служебные сегменты). */
function resolveInside(root: string, pathname: string): string | null {
  let segments: string[];
  try {
    segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.some((s) => s === '.' || s === '..' || s.includes('\0') || s.includes('/') || s.includes('\\') || s.includes(':'))) return null;
  const file = path.resolve(root, ...segments);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

async function fileResponse(file: string, method: string): Promise<Response | null> {
  let data: Buffer;
  try {
    data = await fs.promises.readFile(file); // папка — EISDIR, нет файла — ENOENT: оба дают 404
  } catch {
    return null;
  }
  const type = mimeOf(file);
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Length': String(data.length),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...CORS_HEADERS,
  };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = contentSecurityPolicy();
  return new Response(method === 'HEAD' ? null : new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { status: 200, headers });
}

async function handleAppProtocol(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (method !== 'GET' && method !== 'HEAD') return textResponse(405, 'Method not allowed');

    if (url.host === APP_HOST) {
      const pathname = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
      const file = resolveInside(DIST_DIR, pathname);
      const res = file ? await fileResponse(file, method) : null;
      return res ?? textResponse(404, 'Not found');
    }

    if (url.host === PACKS_HOST) {
      for (const root of [USER_PACKS_DIR, BUNDLED_PACKS_DIR]) {
        const file = resolveInside(root, url.pathname);
        const res = file ? await fileResponse(file, method) : null;
        if (res) return res;
      }
      return textResponse(404, 'Not found');
    }

    return textResponse(404, 'Not found');
  } catch (e) {
    log('error', 'app://', request.url, e);
    return textResponse(500, 'Internal error');
  }
}

// ---------- сеть: режим без сети ----------

let blockedCount = 0;

function isAlwaysAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === `${SCHEME}:` || u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'devtools:' || u.protocol === 'chrome-extension:') return true;
  // Сервер Vite при разработке (и его websocket горячей замены).
  if (DEV_ORIGIN) {
    const dev = new URL(DEV_ORIGIN);
    if (u.hostname === dev.hostname && u.port === dev.port) return true;
  }
  return false;
}

function installNetworkGuard(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!offline || isAlwaysAllowed(details.url)) {
      callback({});
      return;
    }
    blockedCount++;
    if (blockedCount <= 20 || VERBOSE) log('info', `без сети: отменён запрос ${details.method} ${details.url.slice(0, 200)}`);
    else if (blockedCount % 100 === 0) log('info', `без сети: отменено запросов — ${blockedCount}`);
    callback({ cancel: true });
  });

  if (DEV_ORIGIN) {
    // Сервер Vite не знает про CSP — добавляем заголовок к его HTML.
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${DEV_ORIGIN}/*`] }, (details, callback) => {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame') headers['Content-Security-Policy'] = [contentSecurityPolicy()];
      callback({ responseHeaders: headers });
    });
  }

  const allowed = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// ---------- окно ----------

let win: BrowserWindow | null = null;

const isAppPage = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    // У схемы app: в URL из Node origin всегда 'null' — сравниваем схему и хост.
    if (u.protocol === `${SCHEME}:` && u.host === APP_HOST) return true;
    return DEV_ORIGIN !== undefined && u.origin === DEV_ORIGIN;
  } catch {
    return false;
  }
};

function openExternal(url: string): void {
  if (offline || !/^https:\/\//i.test(url)) return;
  void shell.openExternal(url);
}

/** Сохранённые размеры, если окно с ними хоть немного видно на одном из экранов. */
function initialBounds(): Partial<Rectangle> & { width: number; height: number } {
  const def = { width: 1440, height: 900 };
  const b = settings.bounds;
  if (!b || !(b.width > 200) || !(b.height > 200)) return def;
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  const visibleX = Math.min(b.x + width, area.x + area.width) - Math.max(b.x, area.x);
  const visibleY = Math.min(b.y + height, area.y + area.height) - Math.max(b.y, area.y);
  return visibleX > 100 && visibleY > 50 ? { x: b.x, y: b.y, width, height } : { width, height };
}

function rememberWindow(w: BrowserWindow): void {
  settings.bounds = w.getNormalBounds();
  settings.maximized = w.isMaximized();
  settings.fullscreen = w.isFullScreen();
}

function createWindow(): void {
  const iconPng = path.join(__dirname, 'icon.png');
  const w = new BrowserWindow({
    ...initialBounds(),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#10151c',
    title: app.getName(),
    icon: PLATFORM !== 'mac' && fs.existsSync(iconPng) ? iconPng : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win = w;

  w.once('ready-to-show', () => {
    if (settings.maximized) w.maximize();
    w.show();
    if (settings.fullscreen) w.setFullScreen(true);
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const saveSoon = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!w.isDestroyed()) {
        rememberWindow(w);
        saveSettings();
      }
    }, 800);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) w.on(ev as 'resize', saveSoon);
  w.on('close', () => {
    clearTimeout(saveTimer);
    rememberWindow(w);
    saveSettings();
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  w.on('unresponsive', () => log('warn', 'окно не отвечает'));
  w.on('responsive', () => log('info', 'окно снова отвечает'));

  watchContents(w.webContents);
  void w.loadURL(DEV_URL ?? APP_URL);
}

function watchContents(wc: WebContents): void {
  wc.on('did-finish-load', () => log('info', `загружено: ${wc.getURL()} (${offline ? 'без сети' : 'сеть разрешена'})`));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) log('error', `не загрузилось: ${url} — ${code} ${desc}`);
  });
  wc.on('preload-error', (_e, file, error) => log('error', `ошибка preload ${file}:`, error));
  wc.on('render-process-gone', (_e, details) => {
    log('error', `процесс страницы завершился: ${details.reason} (код ${details.exitCode})`);
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
      void dialog
        .showMessageBox(win, { type: 'error', message: 'Симулятор аварийно остановился', detail: 'Перезагрузить окно?', buttons: ['Перезагрузить', 'Закрыть'], defaultId: 0, cancelId: 1 })
        .then(({ response }) => (response === 0 ? win?.reload() : win?.close()));
    }
  });
  wc.on('console-message', (details) => {
    const { level, message, lineNumber, sourceId } = details;
    if (level === 'error' || level === 'warning' || VERBOSE) {
      log(level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'info', `страница: ${message}${sourceId ? ` (${sourceId}:${lineNumber})` : ''}`);
    }
  });
}

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isAppPage(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  wc.on('will-redirect', (e, url) => {
    if (!isAppPage(url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

// ---------- мост для preload ----------

ipcMain.on('vtol:info', (e) => {
  // Во время preload адрес кадра ещё не задан, поэтому проверяется другое: спрашивает главный
  // кадр нашего окна. Чужих страниц в нём не бывает — навигация наружу запрещена.
  const frame = e.senderFrame;
  const url = frame?.url ?? '';
  const sameWindow = win !== null && !win.isDestroyed() && e.sender.id === win.webContents.id;
  const topFrame = frame !== null && frame.frameTreeNodeId === e.sender.mainFrame.frameTreeNodeId;
  const appUrl = url === '' || url === 'about:blank' || isAppPage(url);
  const ours = sameWindow && topFrame && appUrl;
  if (VERBOSE || !ours) {
    log(ours ? 'info' : 'warn', `мост: запрос из «${url || 'адрес ещё не задан'}» — ${ours ? 'выдан' : `отказано (окно ${sameWindow}, главный кадр ${topFrame}, адрес ${appUrl})`}`);
  }
  e.returnValue = ours ? { version: APP_VERSION, platform: PLATFORM, packsBaseUrl: PACKS_BASE_URL, offline } : null;
});

// ---------- меню ----------

function openFolder(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* папки ресурсов может не быть и её не создать — это нормально */
  }
  void shell.openPath(dir).then((err) => {
    if (err) void dialog.showMessageBox({ type: 'info', message: 'Папка недоступна', detail: `${dir}\n${err}` });
  });
}

async function setOffline(on: boolean): Promise<void> {
  if (on === offline) return;
  if (win && !win.isDestroyed()) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: on ? 'Работать без сети?' : 'Снова разрешить сеть?',
      detail: on
        ? 'Приложение будет брать карты и рельеф только из установленных пакетов районов. Симулятор перезагрузится, текущий полёт будет сброшен.'
        : 'Приложение сможет загружать карты и погоду из интернета. Симулятор перезагрузится, текущий полёт будет сброшен.',
      buttons: ['Перезагрузить', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      buildMenu(); // вернуть галочку
      return;
    }
  }
  offline = on;
  settings.offline = on;
  saveSettings();
  blockedCount = 0;
  log('info', on ? 'режим без сети включён' : 'режим без сети выключен');
  buildMenu();
  win?.webContents.reload();
}

function showAbout(): void {
  const detail = [
    `Версия ${APP_VERSION}`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
    `Сеть: ${offline ? 'выключена (режим без сети)' : 'разрешена'}`,
    '',
    'Пакеты районов:',
    USER_PACKS_DIR,
    BUNDLED_PACKS_DIR,
  ].join('\n');
  const opts = { type: 'info' as const, title: 'О программе', message: app.getName(), detail, buttons: ['OK'] };
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

function buildMenu(): void {
  const isMac = PLATFORM === 'mac';
  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: app.getName(),
      submenu: [
        { label: 'О программе', click: showAbout },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: 'Выйти' },
      ],
    });
  }
  template.push({
    label: 'Файл',
    submenu: [
      { label: 'Работать без сети', type: 'checkbox', checked: offline, click: (item) => void setOffline(item.checked) },
      { type: 'separator' },
      { label: 'Открыть папку пакетов районов', click: () => openFolder(USER_PACKS_DIR) },
      { type: 'separator' },
      isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
    ],
  });
  if (isMac) {
    // Без меню «Правка» на macOS не работают Cmd+C / Cmd+V в полях ввода.
    template.push({
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать всё' },
      ],
    });
  }
  template.push({
    label: 'Вид',
    submenu: [
      { role: 'togglefullscreen', label: 'Полноэкранный режим', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Исходный масштаб' },
      { role: 'zoomIn', label: 'Крупнее' },
      { role: 'zoomOut', label: 'Мельче' },
      { type: 'separator' },
      { role: 'reload', label: 'Перезагрузить' },
      { role: 'toggleDevTools', label: 'Инструменты разработчика' },
    ],
  });
  template.push({
    label: 'Справка',
    role: 'help',
    submenu: [
      ...(isMac ? [] : [{ label: 'О программе', click: showAbout }]),
      { label: 'Встроенные пакеты районов', click: () => openFolder(BUNDLED_PACKS_DIR) },
      { label: 'Папка настроек и журнала', click: () => openFolder(USER_DATA) },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- запуск ----------

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (!win) createWindow();
});

void app.whenReady().then(() => {
  log('info', `запуск ${app.getName()} ${APP_VERSION} (${PLATFORM}, Electron ${process.versions.electron}); ${offline ? 'без сети' : 'сеть разрешена'}; данные: ${USER_DATA}`);
  protocol.handle(SCHEME, handleAppProtocol);
  installNetworkGuard();
  buildMenu();
  createWindow();
});
