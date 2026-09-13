/**
 * Мост настольного приложения (desktop/preload.cts). В браузере его нет — window.vtolDesktop
 * равен undefined.
 */
interface VtolDesktop {
  /** Версия приложения. */
  readonly version: string;
  readonly platform: 'win' | 'mac' | 'linux';
  /** Корень пакетов районов, например app://packs/ — дальше <regionId>/manifest.json и т. д. */
  readonly packsBaseUrl: string;
  /** Режим без сети: все запросы, кроме app://, отменяются главным процессом. */
  readonly offline: boolean;
}

interface Window {
  readonly vtolDesktop?: VtolDesktop;
}
