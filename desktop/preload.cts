/*
 * Preload окна симулятора (sandbox): только мост window.vtolDesktop, только для чтения.
 * Тип для страницы — src/desktop.d.ts.
 */
import { contextBridge, ipcRenderer } from 'electron';

interface VtolDesktopInfo {
  version: string;
  platform: 'win' | 'mac' | 'linux';
  packsBaseUrl: string;
  offline: boolean;
}

const info = ipcRenderer.sendSync('vtol:info') as VtolDesktopInfo | null;

if (info) {
  const bridge: VtolDesktopInfo = {
    version: String(info.version),
    platform: info.platform,
    packsBaseUrl: String(info.packsBaseUrl),
    offline: info.offline === true,
  };
  if (typeof contextBridge.executeInMainWorld === 'function') {
    // Замороженный объект в неперезаписываемом свойстве window: ни поля, ни сам мост страница
    // не подменит. Функция выполняется в мире страницы до её скриптов; данные — только примитивы.
    contextBridge.executeInMainWorld({
      func: (api: VtolDesktopInfo) => {
        Object.defineProperty(globalThis, 'vtolDesktop', { value: Object.freeze({ ...api }), enumerable: true, writable: false, configurable: false });
      },
      args: [bridge],
    });
  } else {
    contextBridge.exposeInMainWorld('vtolDesktop', bridge);
  }
}
