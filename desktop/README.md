# Desktop app

The simulator in its own Electron window, with installers for macOS, Windows and Linux. The page is the same as in the browser (Vite build); the main process adds the `app://` protocol, region packs, offline mode, a menu and window state persistence.

## Commands

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Vite (current profile) with Electron on top; `PROFILE=demo npm run desktop:dev` — demo |
| `npm run desktop:build` | installer of the current profile for this OS |
| `npm run desktop:build:demo` | the same for the demo profile |
| `npm run desktop:icons` | icons only, from `desktop/icon.svg` → `desktop/build/` |

Build flags can be added after `--`: `--mac`, `--win`, `--linux` (platform), `--x64`, `--arm64`, `--universal` (architecture), `--dir` (no installer, just the unpacked app — quick for testing). Example: `npm run desktop:build:demo -- --mac --arm64 --dir`.

Installers go to `release/demo/` and `release/private/` (the folder is in `.gitignore`):

- macOS — `*.dmg` for arm64 and x64;
- Windows — `*-win-x64.exe`, a Russian-language NSIS installer with a choice of folder and shortcuts on the desktop and in the Start menu;
- Linux — `*.AppImage` and `*.deb` for x64.

The app name comes from the profile (`PROFILE.title`) at build time. **Installers of a private profile are built locally only and are never uploaded**; only the demo may be published. Before packaging, the demo build is checked against `private/export/forbidden.txt` (if present) — any match stops the build.

## Layout

| File | Purpose |
| --- | --- |
| `main.cts` | main process: window, `app://` protocol, network, menu, settings, log file |
| `preload.cts` | the `window.vtolDesktop` bridge (type in `src/desktop.d.ts`) |
| `build.mjs` | build: profile → Vite → `desktop/.stage/<demo\|private>/app` → electron-builder |
| `dev.mjs` | development mode |
| `icon.svg`, `make-icons.mjs` | the app icon and a rasteriser to PNG / ICO / ICNS without external tools |

**The `app://` protocol.** The page opens as `app://app/index.html`; files come from `dist` inside `app.asar` (Vite builds with `base: '/'`). Region packs are served as `app://packs/<regionId>/…`: first from `<userData>/packs/`, then from `<resources>/packs/` (bundled with the installer). A missing file is a 404. MIME types are set by extension; every response has `Access-Control-Allow-Origin: *`.

**Bundled packs.** The private-profile installer bundles everything in the project's `packs/` folder (`scripts/region-pack.mjs --out packs/<id>`; the folder is in `.gitignore`) into `<resources>/packs/`. Another folder can be set with the `VTOL_BUNDLED_PACKS` variable. The demo installer bundles packs **only** from `VTOL_BUNDLED_PACKS`: `packs/` may hold private-profile regions, and their `manifest.json` files are checked against the forbidden list during a demo build. Packs in `public/packs/` (the browser layout) do not go into the app. In development, packs from the project's `packs/` count as bundled.

**The bridge.** `window.vtolDesktop = { version, platform: 'win' | 'mac' | 'linux', packsBaseUrl: 'app://packs/', offline }` — a frozen, read-only object. It does not exist in the browser.

**Offline mode.** The menu item «Файл → Работать без сети» (File → Work offline) or the `--offline` launch flag (`--online` turns it off); the choice is remembered. The main process cancels everything in `session.webRequest` except `app://`, `data:` and `blob:`, so `fetch` fails immediately with `net::ERR_BLOCKED_BY_CLIENT`. Switching reloads the page so that `offline` in the bridge matches what actually happens.

**Security.** `contextIsolation`, `sandbox` (for all windows — `app.enableSandbox()`), no `nodeIntegration`; a CSP header on the page: only own scripts; images and `fetch` — own, `app:` and `https:` (maps, terrain, weather). Navigating to other origins and opening new windows is blocked (`https:` links open in the browser, and not at all in offline mode), `<webview>` is blocked, and the page may only request fullscreen, pointer lock and clipboard write.

**Settings and log.** `<userData>/settings.json` — window size, position, maximised and fullscreen state, offline mode. `<userData>/logs/main.log` — startup, loading, page errors and warnings, cancelled requests; the `--verbose` flag logs everything. `<userData>` is:

- macOS — `~/Library/Application Support/<app name>`;
- Windows — `%APPDATA%\<app name>`;
- Linux — `~/.config/<app name>`.

For testing, `--remote-debugging-port=9222` exposes the DevTools protocol on `localhost`.

## Windows and Linux

On a Mac (electron-builder 26, Apple Silicon) `npm run desktop:build:demo -- --mac --linux --win` builds all installers by itself — NSIS, AppImage and deb, without Wine or Docker: electron-builder downloads the tools it needs into its cache. The Windows and Linux builds cannot be run on a Mac; test them on their own systems.

The fallback is the `.github/workflows/desktop.yml` workflow in the public repository: manual runs only (Actions → "Desktop app" → Run workflow), a macOS / Windows / Ubuntu matrix, the demo profile, installers kept as run artifacts for 14 days. No releases are published and no secrets are used.

Linux: make the AppImage executable before running it (`chmod +x`); on Ubuntu 22.04 and newer it needs the `libfuse2` package. If the AppImage does not start because of the Chromium sandbox (Ubuntu 24.04), install the deb.

## Code signing

Without certificates the installers are **unsigned**. On macOS the app is signed ad-hoc (otherwise it does not start on Apple Silicon at all), but that is not a developer signature.

### What users will see

**macOS (Gatekeeper).** On the first launch of a downloaded app: "cannot verify the developer" / "Apple could not verify the app is free of malware".

- macOS 14 and older: right-click (or Control-click) the app in Applications → Open → Open.
- macOS 15 and newer removed that path: try to open the app, then System Settings → Privacy & Security → "Open Anyway" at the bottom → enter your password.
- Advanced: `xattr -dr com.apple.quarantine "/Applications/<app name>.app"`.

**Windows (SmartScreen).** "Windows protected your PC", unknown publisher. Click "More info" → "Run anyway". An antivirus may also scan the installer.

**Linux.** No signature prompts.

### What signing requires

**macOS:**

1. Apple Developer Program membership ($99 a year).
2. A **Developer ID Application** certificate exported to a password-protected `.p12`.
3. For notarisation — an App Store Connect API key (`.p8`, Key ID, Issuer ID) or an Apple ID with an app-specific password and Team ID.

With signing enabled, `build.mjs` turns on the hardened runtime, and electron-builder submits the app for notarisation and staples the ticket — then Gatekeeper stays silent.

**Windows:** a code signing certificate (OV or EV) from a certificate authority. Since 2023 the key is issued only on a hardware token or in a cloud HSM, so there are two options:

- a `.pfx` (if the CA issues one) or a token on the build machine;
- Azure Trusted Signing — then `win.azureSignOptions` is added to `build.mjs` (publisher name, endpoint, certificate profile, signing account — none of these are secrets), and the secrets are passed as `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

Signing removes "unknown publisher", but SmartScreen may keep warning until the certificate builds up reputation.

### Where the keys go

**Only into electron-builder environment variables** on the build machine or into CI secrets. Never commit certificates, passwords or `.env` files with them.

| Variable | Purpose |
| --- | --- |
| `CSC_LINK` | path to the `.p12` (or its base64 content) — macOS |
| `CSC_KEY_PASSWORD` | password of the `.p12` |
| `CSC_NAME` | instead of `CSC_LINK`: name of a certificate already in the keychain |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | notarisation with an API key (path to the `.p8`, Key ID, Issuer ID) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | or notarisation with an Apple ID |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | `.pfx` and password for Windows (when building on another OS) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Azure Trusted Signing |

Example for macOS:

```sh
export CSC_LINK=~/keys/developer-id.p12 CSC_KEY_PASSWORD=…
export APPLE_API_KEY=~/keys/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=…
npm run desktop:build:demo
```

In GitHub Actions, use Settings → Secrets and variables → Actions and an `env:` block on the build step in `desktop.yml` (`CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}` and so on; then remove the `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` line). The workflow currently uses no secrets.
