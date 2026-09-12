import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Профиль аппарата (src/sim/profile.ts): private/profile, если он есть и не задан PROFILE=demo, иначе демо.
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const usePrivate = process.env.PROFILE !== 'demo' && existsSync(local('./private/profile/index.ts'));

export default defineConfig({
  // Для GitHub Pages сборка лежит в подпапке: BASE=/имя-репозитория/.
  base: process.env.BASE ?? '/',
  resolve: { alias: { '@profile': local(usePrivate ? './private/profile/index.ts' : './src/profile-demo/index.ts') } },
  server: { port: Number(process.env.PORT) || 5173 },
});
