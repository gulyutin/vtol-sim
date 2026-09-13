# Настольное приложение

Симулятор в отдельном окне на Electron, с установщиками для macOS, Windows и Linux. Страница та
же, что в браузере (сборка Vite), главный процесс добавляет к ней протокол `app://`, пакеты
районов, режим без сети, меню и запоминание окна.

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run desktop:dev` | Vite (текущий профиль) и Electron поверх него; `PROFILE=demo npm run desktop:dev` — демо |
| `npm run desktop:build` | установщик текущего профиля для этой ОС |
| `npm run desktop:build:demo` | то же для демо-профиля |
| `npm run desktop:icons` | только значки из `desktop/icon.svg` → `desktop/build/` |

К сборке можно добавить ключи после `--`: `--mac`, `--win`, `--linux` (платформа), `--x64`,
`--arm64`, `--universal` (архитектура), `--dir` (без установщика, только распакованное приложение —
быстро для проверки). Пример: `npm run desktop:build:demo -- --mac --arm64 --dir`.

Установщики складываются в `release/demo/` и `release/private/` (папка в `.gitignore`):

- macOS — `*.dmg` для arm64 и x64;
- Windows — `*-win-x64.exe`, установщик NSIS на русском, с выбором папки и ярлыками на рабочем
  столе и в меню «Пуск»;
- Linux — `*.AppImage` и `*.deb` для x64.

Название приложения берётся из профиля (`PROFILE.title`) во время сборки. **Установщики закрытого
профиля собираются только локально и никуда не загружаются**; публиковать можно только демо.
Демо-сборка перед упаковкой проверяется по `private/export/forbidden.txt` (если он есть) — нашлось
совпадение, и сборка останавливается.

## Устройство

| Файл | Назначение |
| --- | --- |
| `main.cts` | главный процесс: окно, протокол `app://`, сеть, меню, настройки, журнал |
| `preload.cts` | мост `window.vtolDesktop` (тип — `src/desktop.d.ts`) |
| `build.mjs` | сборка: профиль → Vite → `desktop/.stage/<demo\|private>/app` → electron-builder |
| `dev.mjs` | режим разработки |
| `icon.svg`, `make-icons.mjs` | собственный значок и растеризатор в PNG / ICO / ICNS без внешних программ |

**Протокол `app://`.** Страница открывается как `app://app/index.html`, файлы — из `dist` внутри
`app.asar` (Vite собирает с `base: '/'`). Пакеты районов — `app://packs/<regionId>/…`: сначала
`<userData>/packs/`, затем `<resources>/packs/` (вшитые в установщик). Нет файла — 404. MIME-типы
выставляются по расширению, заголовок `Access-Control-Allow-Origin: *` — у всех ответов.

**Вшитые пакеты.** В установщик закрытого профиля попадает всё, что лежит в папке `packs/` проекта
(`scripts/region-pack.mjs --out packs/<id>`; папка в `.gitignore`), — в `<resources>/packs/`. Другую
папку можно задать переменной `VTOL_BUNDLED_PACKS`. Демо-установщик вшивает пакеты **только** из
`VTOL_BUNDLED_PACKS`: в `packs/` могут лежать районы закрытого профиля; их `manifest.json` при
демо-сборке проверяются по списку запрещённого. Пакеты из `public/packs/` (раскладка для браузера)
в приложение не попадают. При разработке вшитыми считаются пакеты из `packs/` проекта.

**Мост.** `window.vtolDesktop = { version, platform: 'win' | 'mac' | 'linux', packsBaseUrl:
'app://packs/', offline }` — замороженный объект, только для чтения. В браузере его нет.

**Режим без сети.** «Файл → Работать без сети» или ключ запуска `--offline` (`--online` —
выключить); выбор запоминается. Главный процесс отменяет в `session.webRequest` всё, кроме `app://`,
`data:` и `blob:` — `fetch` падает сразу с `net::ERR_BLOCKED_BY_CLIENT`. При переключении
страница перезагружается, чтобы `offline` в мосте совпадал с тем, что происходит на самом деле.

**Безопасность.** `contextIsolation`, `sandbox` (для всех окон — `app.enableSandbox()`), без
`nodeIntegration`; CSP в заголовке страницы: скрипты только свои, картинки и `fetch` — свои,
`app:` и `https:` (карты, рельеф, погода). Переход на чужие адреса и новые окна запрещены (ссылки
`https:` открываются в браузере, в режиме без сети — никак), `<webview>` запрещён, из разрешений
страницы — только полноэкранный режим, захват указателя и запись в буфер обмена.

**Настройки и журнал.** `<userData>/settings.json` — размер, положение, развёрнутость и
полноэкранный режим окна, режим без сети. `<userData>/logs/main.log` — запуск, загрузка,
ошибки и предупреждения страницы, отменённые запросы; ключ `--verbose` пишет всё. `<userData>`:

- macOS — `~/Library/Application Support/<название>`;
- Windows — `%APPDATA%\<название>`;
- Linux — `~/.config/<название>`.

Для проверки подойдёт `--remote-debugging-port=9222`: DevTools-протокол на `localhost`.

## Windows и Linux

На Mac (electron-builder 26, Apple Silicon) `npm run desktop:build:demo -- --mac --linux --win`
собирает все установщики сам — NSIS, AppImage и deb, без Wine и Docker: нужные инструменты
electron-builder скачивает в свой кэш. Запустить Windows- и Linux-версии на Mac нельзя — их
проверяют на своих ОС.

Запасной путь — workflow `.github/workflows/desktop.yml` в публичном репозитории: запуск только
вручную (Actions → «Настольное приложение» → Run workflow), матрица macOS / Windows / Ubuntu,
демо-профиль, установщики — артефакты запуска на 14 дней. Релизы не публикуются, секретов нет.

Linux: AppImage перед запуском нужно сделать исполняемым (`chmod +x`); на Ubuntu 22.04 и новее
ему нужен пакет `libfuse2`. Если AppImage не запускается из-за песочницы Chromium (Ubuntu 24.04),
ставьте deb.

## Подпись

Без сертификатов установщики **не подписаны**. На macOS приложение подписывается ad-hoc (иначе на
Apple Silicon оно не запустится вовсе), но это не подпись разработчика.

### Что увидит пользователь

**macOS (Gatekeeper).** При первом запуске скачанного приложения — «Не удаётся проверить
разработчика» / «Apple не может проверить приложение на наличие вредоносного ПО».

- macOS 14 и старше: правой кнопкой (или Control-щелчок) по приложению в «Программах» →
  «Открыть» → «Открыть».
- macOS 15 и новее этот путь убрали: попробовать открыть, затем «Системные настройки →
  Конфиденциальность и безопасность» → внизу «Всё равно открыть» → ввести пароль.
- Для опытных: `xattr -dr com.apple.quarantine "/Applications/<название>.app"`.

**Windows (SmartScreen).** «Windows защитила ваш компьютер», издатель неизвестен. Нажать
«Подробнее» → «Выполнить в любом случае». Антивирус может дополнительно проверить установщик.

**Linux.** Подписи не спрашивает.

### Что нужно для подписи

**macOS:**

1. Членство в Apple Developer Program (99 $ в год).
2. Сертификат **Developer ID Application**, выгруженный в `.p12` с паролем.
3. Для нотаризации — ключ App Store Connect API (`.p8`, Key ID, Issuer ID) или Apple ID с паролем
   приложения и Team ID.

С подписью `build.mjs` включает hardened runtime, а electron-builder сам отправляет приложение на
нотаризацию и прикрепляет к нему «печать» (staple) — тогда Gatekeeper молчит.

**Windows:** сертификат подписи кода (OV или EV) от удостоверяющего центра. С 2023 года ключ
выдают только на токене или в облачном HSM, поэтому варианта два:

- `.pfx` (если УЦ его выдаёт) или токен на машине сборки;
- облачная подпись Azure Trusted Signing — тогда в `build.mjs` добавляется `win.azureSignOptions`
  (имя издателя, endpoint, профиль сертификата, учётная запись подписи — это не секреты), а
  секреты передаются переменными `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

Подпись убирает «неизвестного издателя», но SmartScreen может предупреждать и дальше, пока у
сертификата не накопится репутация.

### Куда вписать ключи

**Только в переменные окружения** electron-builder на машине сборки или в секреты CI. В
репозиторий — ни сертификатов, ни паролей, ни `.env` с ними.

| Переменная | Для чего |
| --- | --- |
| `CSC_LINK` | путь к `.p12` (или base64 его содержимого) — macOS |
| `CSC_KEY_PASSWORD` | пароль к `.p12` |
| `CSC_NAME` | вместо `CSC_LINK`: имя сертификата, уже лежащего в связке ключей |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | нотаризация по ключу API (путь к `.p8`, Key ID, Issuer ID) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | или нотаризация по Apple ID |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | `.pfx` и пароль для Windows (при сборке не на Windows) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Azure Trusted Signing |

Пример для macOS:

```sh
export CSC_LINK=~/keys/developer-id.p12 CSC_KEY_PASSWORD=…
export APPLE_API_KEY=~/keys/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=…
npm run desktop:build:demo
```

В GitHub Actions — через «Settings → Secrets and variables → Actions» и блок `env:` у шага сборки
в `desktop.yml` (`CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}` и т. д.; строку
`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` тогда убрать). Сейчас workflow секретов не использует.
