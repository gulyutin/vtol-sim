/*
 * Режим «во весь экран» для работы у НСУ: страница на весь экран без адресной строки и вкладок
 * браузера (Fullscreen API) и экран не гаснет (Screen Wake Lock API). Блокировка гашения держится,
 * пока режим включён: браузер снимает её, когда вкладку скрыли, — при возврате берём снова.
 * Выход — Esc (браузер) или та же кнопка. Safari на iPad — через webkit-префикс; на iPhone
 * страница во весь экран не разворачивается, но экран всё равно не гаснет.
 */

interface WebkitDocument {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface WebkitElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

const doc = () => document as Document & WebkitDocument;
const fullElement = () => doc().fullscreenElement ?? doc().webkitFullscreenElement ?? null;

export interface FullscreenMode {
  /** Включён ли режим (для кнопки). */
  readonly on: boolean;
  toggle(): void;
}

/**
 * Режим во весь экран; onChange — режим включили или выключили (в том числе Esc) и держится ли
 * экран: awake = false, если браузер блокировку гашения не дал, null — ещё не спрашивали.
 */
export function createFullscreenMode(onChange: (on: boolean, awake: boolean | null) => void): FullscreenMode {
  let wanted = false;
  let lock: WakeLockSentinelLike | null = null;
  /** Спрашивали ли блокировку гашения в этом включении. */
  let asked = false;

  const awake = () => !!lock && !lock.released;
  const notify = () => onChange(wanted, awake() || (asked ? false : null));

  async function keepAwake() {
    const wl = (navigator as Navigator & WakeLockNavigator).wakeLock;
    if (awake() || document.visibilityState !== 'visible') return;
    asked = true;
    if (!wl) return notify();
    try {
      lock = await wl.request('screen');
      lock.addEventListener('release', notify);
      // Режим успели выключить, пока ждали блокировку.
      if (!wanted) void lock.release();
    } catch {
      // Нет разрешения (энергосбережение, iframe без allow) — экран погаснет по настройкам системы.
      lock = null;
    }
    notify();
  }

  function leave() {
    wanted = false;
    const l = lock;
    lock = null;
    if (l && !l.released) void l.release().catch(() => undefined);
    notify();
  }

  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible') void keepAwake();
  });
  const onFsChange = () => {
    // Вышли из полноэкранного по Esc — выключаем и блокировку гашения.
    if (wanted && !fullElement() && canFullscreen()) leave();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  function canFullscreen(): boolean {
    const el = document.documentElement as HTMLElement & WebkitElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }

  async function enter() {
    wanted = true;
    asked = false;
    // Кнопка отвечает сразу: браузер может думать над полноэкранным режимом.
    notify();
    const el = document.documentElement as HTMLElement & WebkitElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else await el.webkitRequestFullscreen?.();
    } catch {
      // Браузер не дал (не по нажатию, iPhone) — хотя бы экран не гаснет.
    }
    // Пока ждали, режим выключили — выйти из развёрнутого.
    if (!wanted) return exitFull();
    await keepAwake();
  }

  function exitFull() {
    if (!fullElement()) return;
    const d = doc();
    void Promise.resolve(d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.()).catch(() => undefined);
  }

  return {
    get on() {
      return wanted;
    },
    toggle() {
      if (!wanted) {
        void enter();
        return;
      }
      exitFull();
      leave();
    },
  };
}
