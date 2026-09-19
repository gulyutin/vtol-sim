/*
 * Окно «Районы и карты»: какие пакеты районов установлены (район, размер, снимки — есть ли, их
 * источник и лицензия, дата), есть ли сейчас сеть, покрыт ли пакетом активный район и откуда
 * берутся рельеф, снимки и OSM. Пакеты ставит установщик настольного приложения или сборщик
 * scripts/region-pack.mjs; в браузере район скачивается здесь же («Работа без сети»: рельеф,
 * снимки Sentinel-2, OSM — в память браузера).
 */
import './packsPanel.css';
import { activeRegion, REGION_PRESETS } from '../game/regions';
import { expandBounds, formatBytes, packCoversBounds, REGION_MARGIN_M, type PackManifest } from './packFormat';
import { activePack, attribution, clearSaved, probePack, S2_ATTRIBUTION, tileEnv, viewedCacheTiles, type PackProbe, type TileEnv } from './tileSource';
import { autoDownload, downloadableRegions, offlineQueue, regionPlan, regionSaved, setAutoDownload, storageUse } from './regionDownload';

/** Что показывает окно — и для значка в интерфейсе (например, «без сети» на верхней панели). */
export interface PacksStatus {
  env: TileEnv;
  active: {
    id: string;
    title: string;
    probe: PackProbe;
    /** Пакет покрывает рельеф всей области района (с запасом 3 км). */
    covered: boolean;
    terrain: 'pack' | 'net' | 'cache' | 'none';
    imagery: 'pack' | 'pack+net' | 'net' | 'none';
    osm: 'pack' | 'app' | 'none';
  };
  regions: { id: string; title: string; probe: PackProbe }[];
  /** Тайлов рельефа в кэше просмотренного; null — кэша нет. */
  viewedTiles: number | null;
}

/** Сведения о пакетах и сети. Запросы manifest.json — по одному на район за сеанс. */
export async function packsStatus(): Promise<PacksStatus> {
  const env = tileEnv();
  const region = activeRegion();
  await activePack();
  const regions = await Promise.all(REGION_PRESETS.map(async (r) => ({ id: r.id, title: r.title, probe: await probePack(r.id) })));
  const probe = regions.find((r) => r.id === region.id)?.probe ?? (await probePack(region.id));
  const m = probe.pack?.manifest;
  const covered = !!m && packCoversBounds(m, expandBounds(region.location.region, REGION_MARGIN_M));
  const viewedTiles = await viewedCacheTiles();
  return {
    env,
    active: {
      id: region.id,
      title: region.title,
      probe,
      covered,
      terrain: covered ? 'pack' : !env.offline ? 'net' : viewedTiles ? 'cache' : m ? 'pack' : 'none',
      imagery: m?.imagery ? (env.offline ? 'pack' : 'pack+net') : env.offline ? 'none' : 'net',
      osm: m?.osm ? 'pack' : region.osmUrl ? 'app' : 'none',
    },
    regions,
    viewedTiles,
  };
}

export interface PacksPanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Перечитать сведения (пакеты с диска не перечитываются до перезагрузки страницы). */
  refresh(): Promise<void>;
  /** Окно закрыто крестиком или Esc. */
  onClose: (() => void) | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const zooms = (z: number[]) => (z.length ? (z.length > 1 ? `z${z[0]}–${z[z.length - 1]}` : `z${z[0]}`) : '—');
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

function imageryCell(m: PackManifest): string {
  if (!m.imagery) return '<span class="warn">нет</span> — рельеф без снимков';
  const i = m.imagery;
  const corridor = i.corridorKm ? `, детальные — коридор ±${String(i.corridorKm).replace('.', ',')} км` : '';
  return `<span class="ok">есть</span> ${zooms(i.zooms)}${corridor}<br>${esc(i.source)}<br><i>${esc(i.license)}</i>`;
}

function render(s: PacksStatus): string {
  const { env, active } = s;
  const net = env.offline
    ? `<span class="bad">нет</span> — ${env.offlineReason === 'debug' ? 'проверка без сети (?offline=1 в адресе)' : env.offlineReason === 'desktop' ? 'сеть отключена в приложении' : 'браузер без подключения'}: всё берётся из пакетов`
    : '<span class="ok">есть</span>';
  const where = env.desktop ? `настольное приложение ${esc(env.desktop.version)} (${esc(env.desktop.platform)})` : 'браузер';
  const m = active.probe.pack?.manifest;
  const packLine =
    active.probe.status === 'broken'
      ? `<span class="bad">испорчен</span>: ${esc(active.probe.error ?? '')}`
      : !m
        ? `<span class="${env.offline ? 'bad' : 'warn'}">нет пакета</span>${env.offline ? ' — без сети рельеф и снимки взять неоткуда' : ' — всё по сети'}`
        : active.covered
          ? `<span class="ok">установлен, покрывает район</span> (${formatBytes(m.bytes)}, ${date(m.created)})`
          : `<span class="warn">установлен, но покрывает район не целиком</span> — вне пакета ${env.offline ? '«нет данных»' : 'по сети'}`;
  const terrain = { pack: 'из пакета', net: 'по сети (Terrarium), просмотренное — в кэш', cache: 'из кэша просмотренного (пакета нет)', none: '<span class="bad">нет данных</span>' }[active.terrain];
  const a = attribution();
  const imagery = {
    pack: `из пакета: ${esc(a.imagery ?? '')}`,
    'pack+net': `из пакета, вне него — Esri по сети`,
    net: 'Esri по сети; без сети — сохранённые снимки Sentinel-2 (если район скачан)',
    none: '<span class="warn">нет</span> — 3D и карта в цветах рельефа',
  }[active.imagery];
  const osm = { pack: 'из пакета', app: 'с приложением', none: 'нет у района' }[active.osm];
  const rows = s.regions
    .map(({ id, title, probe }) => {
      const pm = probe.pack?.manifest;
      const cls = id === active.id ? ' class="active"' : '';
      if (probe.status === 'broken') return `<tr${cls}><td>${esc(title)}</td><td colspan="5"><span class="bad">пакет испорчен</span>: ${esc(probe.error ?? '')}</td></tr>`;
      if (!pm) return `<tr${cls}><td>${esc(title)}</td><td colspan="5" class="note">не установлен</td></tr>`;
      return `<tr${cls}><td>${esc(title)}</td><td>${formatBytes(pm.bytes)}<br><span class="note">${pm.tiles} тайлов</span></td><td>${zooms(pm.terrain.zooms)}</td><td>${imageryCell(pm)}</td><td>${pm.osm ? 'есть' : '—'}</td><td>${date(pm.created)}</td></tr>`;
    })
    .join('');
  const cache = s.viewedTiles === null ? 'недоступен' : `${s.viewedTiles} тайлов рельефа`;
  return `
    <h4>Сейчас</h4>
    <dl>
      <dt>Запуск</dt><dd>${where}</dd>
      <dt>Сеть</dt><dd>${net}</dd>
      <dt>Район</dt><dd>${esc(active.title)}</dd>
      <dt>Пакет района</dt><dd>${packLine}</dd>
      <dt>Рельеф</dt><dd>${terrain}</dd>
      <dt>Снимки</dt><dd>${imagery}</dd>
      <dt>Дома и дороги</dt><dd>${osm}</dd>
      <dt>Кэш рельефа</dt><dd>${cache}</dd>
    </dl>
    <h4>Пакеты районов</h4>
    <div class="tbl"><table>
      <thead><tr><th>Район</th><th>Размер</th><th>Рельеф</th><th>Снимки</th><th>OSM</th><th>Собран</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">Пакеты: <code>${esc(env.packsBaseUrl)}&lt;район&gt;/</code>${env.desktop ? '' : ' — в браузере это папка public/packs/ проекта'}. ${esc(a.terrain)} · OSM ${esc(a.osm)}.</p>`;
}

/** Окно «Районы и карты». parent — куда вставить (по умолчанию body); показ — open(). */
export function createPacksPanel(parent: HTMLElement = document.body): PacksPanel {
  const el = document.createElement('div');
  el.className = 'win packs-win';
  el.dataset['win'] = 'packs';
  el.hidden = true;
  el.innerHTML = `<div class="win-title"><span>Районы и карты</span><button class="x" title="Закрыть">✕</button></div><div class="win-body"><div class="offline"></div><div class="info">Проверяю пакеты…</div></div>`;
  parent.appendChild(el);
  const body = el.querySelector<HTMLElement>('.info')!;
  const off = el.querySelector<HTMLElement>('.offline')!;
  const offline = offlineSection(off);
  const title = el.querySelector<HTMLElement>('.win-title')!;

  const panel: PacksPanel = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    open() {
      el.hidden = false;
      void panel.refresh();
      void offline.refresh();
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      panel.onClose?.();
    },
    toggle() {
      if (el.hidden) panel.open();
      else panel.close();
    },
    async refresh() {
      try {
        body.innerHTML = render(await packsStatus());
      } catch (e) {
        body.textContent = `Не удалось проверить пакеты: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    onClose: null,
  };

  el.querySelector('.x')!.addEventListener('click', () => panel.close());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) panel.close();
  });
  // Перетаскивание за заголовок — как у остальных окон.
  title.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      el.style.transform = 'none';
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return panel;
}

const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace('.', ',')} МБ`;

/**
 * «Работа без сети»: скачать открытый район или все, ход загрузки, сколько уже сохранено,
 * занятое место, фоновая докачка, очистка. Обновляется по ходу загрузки, пока окно открыто.
 */
function offlineSection(root: HTMLElement): { refresh(): Promise<void> } {
  const region = activeRegion();
  root.innerHTML = `
    <h4>Работа без сети</h4>
    <p class="note">Рельеф, снимки Sentinel-2 (10 м на пиксель, без облаков) и дома с лесом района сохраняются в памяти браузера — тогда тренажёр работает и без интернета. В сети снимки по-прежнему детальные (Esri); без сети — сохранённые.</p>
    <div class="off-row">
      <button data-a="one">Скачать район «${esc(region.title)}»</button>
      <button data-a="all">Скачать все районы</button>
      <button data-a="stop" hidden>Остановить</button>
      <label><input type="checkbox" data-a="auto"> докачивать открытый район в фоне</label>
    </div>
    <div class="off-progress" hidden><progress max="1" value="0"></progress> <span></span></div>
    <dl class="off-info">
      <dt>Этот район</dt><dd data-f="saved">…</dd>
      <dt>Занято браузером</dt><dd data-f="storage">…</dd>
    </dl>
    <p class="note">${esc(S2_ATTRIBUTION)}. <button class="linkish" data-a="clear">Удалить сохранённое</button></p>`;
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const auto = q<HTMLInputElement>('[data-a="auto"]');
  auto.checked = autoDownload();
  auto.addEventListener('change', () => {
    setAutoDownload(auto.checked);
    if (auto.checked) offlineQueue.add([region]);
  });
  const plan = regionPlan(region);
  let savedText = '…';
  const refresh = async () => {
    const [saved, use] = await Promise.all([regionSaved(region), storageUse()]);
    const full = saved.have === saved.total;
    savedText = full ? `<span class="ok">сохранён</span> (${saved.total} тайлов)` : saved.have ? `<span class="warn">сохранён частично</span>: ${saved.have} из ${saved.total} тайлов` : `не сохранён — около ${mb(plan.bytes)}`;
    q('[data-f="saved"]').innerHTML = savedText;
    q('[data-f="storage"]').innerHTML = use ? `${mb(use.usage)} из ${mb(use.quota)}${use.persisted ? ' · браузер не сотрёт при нехватке места' : ''}` : 'браузер не сообщает';
    q<HTMLButtonElement>('[data-a="one"]').textContent = full ? `Проверить район «${region.title}»` : saved.have ? `Докачать район «${region.title}»` : `Скачать район «${region.title}» (~${mb(plan.bytes)})`;
  };
  const show = () => {
    const s = offlineQueue.state;
    const net = !tileEnv().offline;
    q<HTMLButtonElement>('[data-a="one"]').disabled = !net || s.running;
    q<HTMLButtonElement>('[data-a="all"]').disabled = !net || s.running;
    q<HTMLButtonElement>('[data-a="stop"]').hidden = !s.running;
    const bar = q('.off-progress');
    const p = s.progress;
    bar.hidden = !p && !s.last;
    q<HTMLProgressElement>('progress').hidden = !p;
    if (p) q<HTMLProgressElement>('progress').value = p.total ? p.done / p.total : 0;
    q('.off-progress span').textContent = p
      ? `${p.region}: ${p.done} из ${p.total}${p.bytes ? ` · ${mb(p.bytes)}` : ''}${p.failed ? ` · ошибок ${p.failed}` : ''}${s.queued.length ? ` · дальше: ${s.queued.join(', ')}` : ''}`
      : s.last
        ? `${s.last.region}: ${s.last.text}`
        : '';
    if (!net && !s.running) q('.off-progress span').textContent = 'Нет сети — скачать нельзя; работают уже сохранённые районы.';
    if (!net) bar.hidden = false;
  };
  let wasRunning = false;
  offlineQueue.onChange(() => {
    show();
    if (wasRunning && !offlineQueue.state.running && !root.closest('[hidden]')) void refresh();
    wasRunning = offlineQueue.state.running;
  });
  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset['a'];
    if (a === 'one') offlineQueue.add([region]);
    else if (a === 'all') offlineQueue.add([region, ...downloadableRegions().filter((r) => r.id !== region.id)]);
    else if (a === 'stop') offlineQueue.cancel();
    else if (a === 'clear' && confirm('Удалить сохранённые рельеф и снимки всех районов? Без сети они станут недоступны.')) {
      offlineQueue.cancel();
      void clearSaved().then(refresh);
    }
  });
  show();
  return {
    refresh: async () => {
      show();
      await refresh().catch(() => undefined);
    },
  };
}
