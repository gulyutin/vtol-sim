import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Профиль аппарата (src/sim/profile.ts): private/profile, если он есть и не задан PROFILE=demo, иначе демо.
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const usePrivate = process.env.PROFILE !== 'demo' && existsSync(local('./private/profile/index.ts'));

/** Список файлов сборки (offline-assets.json): страница кладёт их в кэш сервис-воркера целиком, чтобы без сети работали и ещё не открытые части. */
const offlineAssets = (): Plugin => ({
  name: 'offline-assets',
  apply: 'build',
  generateBundle(_, bundle) {
    const files = Object.keys(bundle).filter((f) => f.startsWith('assets/'));
    this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(files) });
  },
});

export default defineConfig({
  plugins: [offlineAssets()],
  // Для GitHub Pages сборка лежит в подпапке: BASE=/имя-репозитория/.
  base: process.env.BASE ?? '/',
  resolve: { alias: { '@profile': local(usePrivate ? './private/profile/index.ts' : './src/profile-demo/index.ts') } },
  server: { port: Number(process.env.PORT) || 5173 },
});
