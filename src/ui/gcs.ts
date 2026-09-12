import type { Check } from '../game/preflight';
import type { RoutePoint, Scenario, ScenarioKind, Settings } from '../game/scenarios';
import { MODE_NAMES, type Command, type Controls, type LiveState } from '../sim/flight';
import { CAMERAS } from '../sim/payload';
import { loadQuality, QUALITY, type Quality } from './quality';
import { PREP_STEPS, type Preparation, type PrepStepId } from '../game/preparation';
import { DIFFICULTY } from '../game/scoring';
import { FAILURES } from '../sim/failures';
import { footprintM, type Coverage, type Frame, type SurveyCamera, type SurveyPlan } from '../sim/survey';
import type { MissionResult, Wind } from '../sim/types';
import { drawAttitude, drawProfile, type ProfileData } from './instruments';
import type { CameraMode } from './scene';

/*
 * Интерфейс в духе НСУ: строка состояния сверху, кнопки по краям карты, плавающие окна.
 * Слева карта, справа 3D-вид; граница двигается.
 */

export type GcsCommand = Command | 'target' | 'unload';

export interface GcsHandlers {
  onScenario(id: string): void;
  onSettings(s: Settings): void;
  onForecastError(on: boolean): void;
  onNewDay(): void;
  onCommand(c: GcsCommand): void;
  onControls(c: Partial<Controls>): void;
  onRate(): void;
  onPause(): void;
  onRestart(): void;
  onClearTrail(): void;
  onFollow(on: boolean): void;
  onZoom(delta: number): void;
  onCamera(m: CameraMode): void;
  onQuality(q: Quality): void;
  /** Источник погоды: 'scenario' — ползунки задания, 'live' — Open-Meteo сейчас, иначе пресет weatherPreset. */
  onWeatherSource(src: string): void;
  onSound(): void;
  /** Режим: тренировка, штатный полёт, сложные условия, зачёт (DIFFICULTY). */
  onDifficulty(id: string): void;
  onDebrief(): void;
  /** Инструктор: ввести отказ / восстановить связь или ГНСС. */
  onInject(id: string): void;
  onRestore(id: 'link' | 'gnss'): void;
  onPrepStep(id: PrepStepId): void;
  onPrepRequired(on: boolean): void;
  onResize(): void;
  onRouteEdit(points: RoutePoint[]): void;
}

export interface SurveyInfo {
  camera: SurveyCamera;
  plan: SurveyPlan;
  frames: Frame[];
  coverage: Coverage;
  minFrames: number;
  minCoverage: number;
  windAtHeight: Wind;
}

export interface PlanInfo {
  kind: ScenarioKind;
  /** Всё задание по прогнозу — то, что известно до вылета. */
  combined: MissionResult;
  stages: { name: string; result: MissionResult }[];
  temperatureC: number;
  survey: SurveyInfo | null;
  /** Стоянка между полётами, с. */
  groundS: number;
}

export interface Telemetry {
  state: LiveState;
  frames: { total: number; ok: number };
  altitudeMslM: number;
  voltageV: number;
  rate: number;
  paused: boolean;
  capacityWh: number;
  usableWh: number;
  stageName: string;
  canUnload: boolean;
  /** Предполётные проверки не пройдены — статус «НЕ ГОТОВ», взлёт запрещён. */
  notReady: boolean;
  /** Тревоги поверх 3D: нет связи, отказы с порядком действий по РЛЭ, «Фэйлсейф». */
  alerts: Alert[];
}

export interface Alert {
  level: 'bad' | 'warn' | 'info';
  text: string;
  /** Порядок действий оператора (РЛЭ). */
  actions?: string[];
}

export interface Gcs {
  mapEl: HTMLElement;
  viewEl: HTMLElement;
  loadScenario(sc: Scenario, s: Settings, forecastError: boolean): void;
  setRoute(points: RoutePoint[] | null, first: string, last: string, editable: boolean): void;
  showPlan(info: PlanInfo): void;
  showPreflight(checks: Check[]): void;
  /** Предполётная подготовка: состояние шагов, обязательна ли перед АРМ, что показывает идущая проверка. */
  showPreparation(p: Preparation, required: boolean, live: string | null): void;
  /** keepRoute — точки маршрута остаются редактируемыми и в полёте. */
  lockPlanning(locked: boolean, keepRoute?: boolean): void;
  update(tm: Telemetry): void;
  profile(data: ProfileData, aircraft: { dist: number; alt: number } | null): void;
  log(t: number, text: string, kind?: 'info' | 'warn' | 'bad'): void;
  toast(html: string, kind: 'good' | 'warn' | 'bad'): void;
  hideToast(): void;
  pip(label: string | null): void;
  flash(): void;
  setControls(c: Controls): void;
  targetMode(on: boolean): void;
  /** Строка под выбором погоды: откуда погода и что в ней. */
  setWeatherSummary(text: string): void;
  setSoundMuted(muted: boolean): void;
  /** Выбрать источник погоды в списке (режим задаёт свою погоду). */
  setWeatherSource(src: string): void;
}

const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
export const fmt = (x: number, d = 0) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtWind = (w: Wind) => `${fmt(w.speedMs, 1)} м/с с ${Math.round(w.fromDeg)}° (${COMPASS[Math.round(w.fromDeg / 45) % 8]})`;
export function fmtTime(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const ICON: Record<string, string> = {
  takeoff: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  mode: '<path d="M5 3v18M12 3v18M19 3v18"/><circle cx="5" cy="9" r="2.2"/><circle cx="12" cy="15" r="2.2"/><circle cx="19" cy="7" r="2.2"/>',
  emergency: '<path d="M12 3 22 21H2Z"/><path d="M12 10v5M12 18v.5"/>',
  arm: '<path d="M12 3v8"/><path d="M6.8 6.8a7.5 7.5 0 1 0 10.4 0"/>',
  debrief: '<path d="M4 20V4M4 20h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  instructor: '<circle cx="12" cy="7" r="3.2"/><path d="M5 20c1.2-4 3.8-6 7-6s5.8 2 7 6"/><path d="M12 14l-1.5 3 1.5 3 1.5-3z"/>',
  prep: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>',
  task: '<path d="M4 20 20 12 4 4v6l10 2-10 2z"/>',
  unload: '<rect x="4" y="11" width="16" height="9" rx="1"/><path d="M12 2v10M8 8l4 4 4-4"/>',
  telemetry: '<path d="M2 12h4l3-7 4 14 3-7h6"/>',
  nav: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
  zoomIn: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  zoomOut: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8"/>',
  terrain: '<path d="M2 20 8 9l4 6 3-4 7 9z"/>',
  console: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  horizon: '<circle cx="12" cy="12" r="9"/><path d="M3 13h18M8 9h8"/>',
  control: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};
const icon = (k: string) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
/** Источник погоды: задание, фактическая сейчас или пресет (weatherPreset в game/weather.ts). */
const WEATHER_SOURCES: [string, string][] = [
  ['scenario', 'По заданию — ползунки ниже'],
  ['live', 'Сейчас на площадке — Open-Meteo'],
  ['calm', 'Штиль'],
  ['breezy', 'Ветрено'],
  ['gusty', 'Порывистый ветер'],
  ['rain', 'Дождь'],
  ['snow', 'Снег'],
  ['fog', 'Туман'],
  ['lowcloud', 'Низкая облачность'],
  ['storm', 'Гроза'],
];

const button = (a: string, label: string, ic: string, extra = '') => `<button class="gbtn" data-a="${a}" ${extra}>${ic}<span>${label}</span></button>`;

type NumKey = Exclude<keyof Settings, 'cameraId' | 'shutter'>;
const FORMAT: Record<NumKey, (v: number) => string> = {
  gsdCm: (v) => `${fmt(v, 2)} см`,
  forwardOverlapPct: (v) => `${v} %`,
  sideOverlapPct: (v) => `${v} %`,
  directionDeg: (v) => `${v}°`,
  cargoKg: (v) => `${fmt(v, 1)} кг`,
  iasMs: (v) => `${fmt(v, 1)} м/с`,
  windSpeedMs: (v) => `${fmt(v, 1)} м/с`,
  windFromDeg: (v) => `${v}° · ${COMPASS[Math.round(v / 45) % 8]}`,
  temperatureC: (v) => `${v > 0 ? '+' : ''}${v} °C`,
  localHour: (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
};

function range(key: NumKey, label: string, min: number, max: number, step: number, value: number): string {
  return `<label class="range"><span>${label}</span><output data-o="${key}">${FORMAT[key](value)}</output>
    <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
}

function win(id: string, title: string, body: string, pos: string, open = false): string {
  return `<div class="win" data-win="${id}" style="${pos}" ${open ? '' : 'hidden'}>
    <div class="win-title"><span>${title}</span><button class="x" data-close="${id}">✕</button></div>
    <div class="win-body">${body}</div></div>`;
}

const CTL_FORMAT: Record<'iasMs' | 'heightAglM' | 'courseDeg', (v: number) => string> = {
  iasMs: (v) => `${fmt(v, 1)} м/с`,
  heightAglM: (v) => `${v} м`,
  courseDeg: (v) => `${v}° · ${COMPASS[Math.round(v / 45) % 8]}`,
};

export function createGcs(root: HTMLElement, scenarios: readonly Scenario[], h: GcsHandlers): Gcs {
  const el = document.createElement('div');
  el.className = 'gcs';

  const controlBody = `
    <div class="modes">
      ${(['auto', 'manual', 'target', 'hold', 'rtl', 'land'] as const)
        .map((m) => `<button class="small" data-cmd="${m}">${{ auto: 'МАРШРУТ', manual: 'РУЧНОЙ', target: 'ОПЕР. ТОЧКА', hold: 'ОЖИДАНИЕ', rtl: 'ВОЗВРАТ', land: 'ПОСАДКА' }[m]}</button>`)
        .join('')}
    </div>
    <label class="range"><span>Скорость</span><output data-c="iasMs"></output><input type="range" data-ctl="iasMs" min="15" max="28" step="0.5"></label>
    <label class="range"><span>Высота над рельефом</span><output data-c="heightAglM"></output><input type="range" data-ctl="heightAglM" min="40" max="500" step="5"></label>
    <label class="range"><span>Курс (РУЧНОЙ)</span><output data-c="courseDeg"></output><input type="range" data-ctl="courseDeg" min="0" max="355" step="5"></label>
    <p class="hint">В МАРШРУТЕ меняется только скорость. РУЧНОЙ держит курс и высоту над рельефом с упреждением. ОЖИДАНИЕ — круг над аэродромом.</p>`;

  el.innerHTML = `
  <header class="topbar">
    <button class="tb" data-a="menu" title="Задача">≡</button>
    <select class="tb scen" title="Задание">${scenarios.map((s) => `<option value="${s.id}">${s.title}</option>`).join('')}</select>
    <button class="tb" data-a="restart" title="Сбросить полёт и начать это задание сначала">⟲ Начать заново</button>
    <div class="tb field photo">📷 Фото <b data-v="photos">0</b></div>
    <button class="tb field" data-a="rate" title="Ускорение времени">1x</button>
    <button class="tb field" data-a="pause" title="Пауза (пробел)">❚❚</button>
    <select class="tb quality" title="Качество графики: дома, деревья, тени, сглаживание">${(Object.keys(QUALITY) as Quality[])
      .map((k) => `<option value="${k}" ${k === loadQuality() ? 'selected' : ''}>Графика: ${QUALITY[k].label.toLowerCase()}</option>`)
      .join('')}</select>
    <button class="tb field" data-a="sound" title="Звук: вкл/выкл">🔊</button>
    <div class="status" data-v="status">ГОТОВ</div>
    <div class="tb-right">
      <span class="batt" title="Заряд и напряжение (оценка без просадки)">🔋 <b data-v="soc">100%</b> <small data-v="volt">50,4 В</small></span>
      <span title="Мощность">⚡ <b data-v="power">0</b> Вт</span>
      <span class="time" data-v="time">T+0:00</span>
    </div>
  </header>
  <main class="split">
    <section class="map-pane">
      <div class="map"></div>
      <div class="map-top"><button class="small" data-a="clear">Очистить траекторию</button></div>
      <div class="col left top">
        ${button('arm', 'АРМ', icon('arm'))}
        ${button('takeoff', 'Взлёт', icon('takeoff'))}
        ${button('mode', 'Режим', icon('mode'))}
        ${button('emergency', 'Аварийная', icon('emergency'))}
        ${button('unload', 'Разгрузка', icon('unload'), 'hidden')}
      </div>
      <div class="col left mid">${button('task', 'Задача', icon('task'))}${button('prep', 'Подготовка', icon('prep'))}${button('debrief', 'Разбор', icon('debrief'))}${button('instructor', 'Инструктор', icon('instructor'))}</div>
      <div class="col right top">${button('telemetry', 'Телеметрия', icon('telemetry'))}</div>
      <div class="col right mid">
        ${button('follow', 'Навигация', icon('nav'))}
        ${button('target', 'Цель', icon('target'))}
        ${button('zoomIn', 'Зум +', icon('zoomIn'))}
        ${button('zoomOut', 'Зум −', icon('zoomOut'))}
      </div>
      <div class="col bottom left">
        ${button('profile', 'Рельеф', icon('terrain'))}
        ${button('console', 'Консоль', icon('console'))}
      </div>
      <div class="col bottom right">
        ${button('horizon', 'Авиагоризонт', icon('horizon'))}
        ${button('control', 'Управление', icon('control'))}
      </div>
      <div class="menu" data-menu="mode" hidden>
        ${(['auto', 'manual', 'target', 'hold', 'rtl', 'land'] as const).map((m) => `<button data-cmd="${m}">${{ auto: 'МАРШРУТ — по заданию', manual: 'РУЧНОЙ — курс и высота', target: 'ОПЕРАТИВНАЯ ТОЧКА — круг над точкой', hold: 'ОЖИДАНИЕ — круг над аэродромом', rtl: 'ВОЗВРАТ на аэродром', land: 'ПОСАДКА на месте' }[m]}</button>`).join('')}
      </div>
      <div class="menu" data-menu="emergency" hidden>
        <button data-cmd="rtl">Возврат на аэродром</button>
        <button data-cmd="land">Посадка на месте</button>
        <button data-cmd="failsafe">ФЭЙЛСЕЙФ — ручное управление с ПДУ</button>
        <button data-cmd="copter">КОПТЕР — в фэйлсейфе перейти на роторы</button>
      </div>
    </section>
    <div class="splitter" title="Потяните, чтобы изменить доли"></div>
    <section class="view-pane">
      <div class="view"></div>
      <div class="alerts" hidden></div>
      <select class="camera">
        <option value="chase" title="Мышь — повернуть, колёсико — ближе/дальше, двойной щелчок — сброс">3D: за хвостом</option>
        <option value="tail" title="Камера на оперении смотрит вперёд — горизонт кренится вместе с аппаратом">3D: камера на хвосте</option>
        <option value="follow">3D: облёт мышью</option>
        <option value="pad">3D: с площадки</option>
        <option value="cinema">3D: кино</option>
      </select>
      <div class="pip" hidden><i></i><span></span></div>
    </section>
  </main>
  ${win('task', 'Задача', '<div class="task-body"></div>', 'left:80px;top:52px;width:330px', true)}
  ${win(
    'prep',
    'Предполётная подготовка (РЛЭ, прил. А)',
    `<label class="prep-req"><input type="checkbox" data-prep-req> Требовать подготовку перед АРМ</label>
    <ol class="prep">${PREP_STEPS.map((s) => `<li data-step="${s.id}" data-status="todo"><button class="small" data-prep="${s.id}">Выполнить</button><div><b>${s.title}</b><small>${s.hint}</small><em></em></div></li>`).join('')}</ol>`,
    'left:80px;top:52px;width:380px',
  )}
  ${win(
    'instructor',
    'Инструктор — особые случаи',
    `<p class="hint">Отказ вводится сразу — как в таблице особых случаев РЛЭ. Оператор действует по порядку, разбор оценит реакцию.</p>
    <ul class="inject">${FAILURES.map((f) => `<li><button class="small" data-inject="${f.id}">Ввести</button><div><b>${f.title}</b><small>${f.effect}</small></div></li>`).join('')}</ul>
    <div class="row"><button class="small" data-restore="link">Восстановить связь</button><button class="small" data-restore="gnss">Восстановить ГНСС</button></div>`,
    'right:calc(45% + 84px);top:52px;width:380px',
  )}
  ${win('control', 'Управление', controlBody, 'right:calc(45% + 84px);bottom:78px;width:250px')}
  ${win('telemetry', 'Телеметрия', '<dl class="tm"></dl>', 'right:calc(45% + 84px);top:52px;width:220px')}
  ${win('horizon', 'Авиагоризонт', '<canvas class="adi" width="150" height="150"></canvas><dl class="tm adi-tm"></dl>', 'right:calc(45% + 84px);top:330px;width:170px')}
  ${win('console', 'Консоль', '<ul class="log"></ul>', 'left:80px;bottom:78px;width:320px')}
  ${win('profile', 'Рельеф вдоль маршрута', '<canvas class="prof" width="440" height="130"></canvas>', 'left:80px;bottom:78px;width:460px')}
  <div class="toast" hidden></div>`;
  root.appendChild(el);

  const q = <T extends Element>(sel: string) => el.querySelector<T>(sel)!;
  const mapPane = q<HTMLElement>('.map-pane');
  const taskBody = q<HTMLElement>('.task-body');

  // Окна: открыть/закрыть, перетаскивание за заголовок.
  const toggle = (id: string, show?: boolean) => {
    const w = q<HTMLElement>(`[data-win="${id}"]`);
    w.hidden = show === undefined ? !w.hidden : !show;
  };
  el.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.close!, false)));
  el.querySelectorAll<HTMLElement>('.win-title').forEach((t) => {
    t.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const w = t.parentElement!;
      const r = w.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev: PointerEvent) => Object.assign(w.style, { left: `${ev.clientX - dx}px`, top: `${ev.clientY - dy}px`, right: 'auto', bottom: 'auto' });
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });

  const menus = el.querySelectorAll<HTMLElement>('[data-menu]');
  const closeMenus = () => menus.forEach((m) => (m.hidden = true));
  const openMenu = (id: string, anchor: HTMLElement) => {
    const m = q<HTMLElement>(`[data-menu="${id}"]`);
    const wasHidden = m.hidden;
    closeMenus();
    if (!wasHidden) return;
    const r = anchor.getBoundingClientRect();
    const pr = mapPane.getBoundingClientRect();
    Object.assign(m.style, { left: `${r.right - pr.left + 8}px`, top: `${r.top - pr.top}px` });
    m.hidden = false;
  };

  let follow = false;
  let weatherSource = 'scenario';
  let weatherSummary = '';
  let difficulty = 'train';
  let alertsKey = '';
  let armed = false;
  el.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.a!;
      if (a === 'arm') h.onCommand(armed ? 'disarm' : 'arm');
      else if (a === 'takeoff') h.onCommand('takeoff');
      else if (a === 'unload') h.onCommand('unload');
      else if (a === 'mode' || a === 'emergency') openMenu(a, b);
      else if (a === 'task' || a === 'menu') toggle('task');
      else if (['telemetry', 'horizon', 'console', 'profile', 'control', 'prep', 'instructor'].includes(a)) toggle(a);
      else if (a === 'follow') {
        follow = !follow;
        b.classList.toggle('on', follow);
        h.onFollow(follow);
      } else if (a === 'target') h.onCommand('target');
      else if (a === 'zoomIn') h.onZoom(1);
      else if (a === 'zoomOut') h.onZoom(-1);
      else if (a === 'rate') h.onRate();
      else if (a === 'pause') h.onPause();
      else if (a === 'sound') h.onSound();
      else if (a === 'debrief') h.onDebrief();
      else if (a === 'restart') h.onRestart();
      else if (a === 'clear') h.onClearTrail();
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => {
      closeMenus();
      h.onCommand(b.dataset.cmd as GcsCommand);
    }),
  );
  const scen = q<HTMLSelectElement>('.scen');
  scen.addEventListener('change', () => h.onScenario(scen.value));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      h.onPause();
    }
  });

  el.querySelectorAll<HTMLInputElement>('[data-ctl]').forEach((input) =>
    input.addEventListener('input', () => {
      const k = input.dataset.ctl as keyof typeof CTL_FORMAT;
      q<HTMLOutputElement>(`[data-c="${k}"]`).textContent = CTL_FORMAT[k](+input.value);
      h.onControls({ [k]: +input.value });
    }),
  );
  q<HTMLSelectElement>('.camera').addEventListener('change', (e) => h.onCamera((e.target as HTMLSelectElement).value as CameraMode));
  q<HTMLSelectElement>('.quality').addEventListener('change', (e) => h.onQuality((e.target as HTMLSelectElement).value as Quality));
  el.querySelectorAll<HTMLButtonElement>('[data-prep]').forEach((b) => b.addEventListener('click', () => h.onPrepStep(b.dataset.prep as PrepStepId)));
  q<HTMLInputElement>('[data-prep-req]').addEventListener('change', (e) => h.onPrepRequired((e.target as HTMLInputElement).checked));
  el.querySelectorAll<HTMLButtonElement>('[data-inject]').forEach((b) => b.addEventListener('click', () => h.onInject(b.dataset.inject!)));
  el.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((b) => b.addEventListener('click', () => h.onRestore(b.dataset.restore as 'link' | 'gnss')));

  // Граница карта | 3D.
  q<HTMLElement>('.splitter').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const main = q<HTMLElement>('.split').getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      mapPane.style.flexBasis = `${Math.min(0.85, Math.max(0.2, (ev.clientX - main.left) / main.width)) * 100}%`;
      h.onResize();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      h.onResize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const toastEl = q<HTMLDivElement>('.toast');
  const pipEl = q<HTMLDivElement>('.pip');
  const adi = q<HTMLCanvasElement>('.adi').getContext('2d')!;
  const prof = q<HTMLCanvasElement>('.prof').getContext('2d')!;
  const logEl = q<HTMLUListElement>('.log');
  let current: Settings | null = null;
  let locked = false;
  let keepRouteOpen = false;

  // Настройки задания — поля зависят от вида задания.
  const read = (): Settings => {
    const s = { ...current! };
    taskBody.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((i) => {
      const k = i.dataset.k as keyof Settings;
      if (k === 'cameraId') s.cameraId = i.value;
      else (s as Record<string, number | string>)[k] = +i.value;
    });
    return s;
  };
  let pending = 0;
  const bindSettings = () => {
    taskBody.querySelectorAll<HTMLInputElement>('[data-k]').forEach((input) =>
      input.addEventListener('input', () => {
        const k = input.dataset.k as keyof Settings;
        if (k in FORMAT) taskBody.querySelector<HTMLOutputElement>(`[data-o="${k}"]`)!.textContent = FORMAT[k as NumKey](+input.value);
        // Пересчёт тяжёлый — не чаще раза в 150 мс.
        window.clearTimeout(pending);
        pending = window.setTimeout(() => {
          current = read();
          h.onSettings(current);
        }, 150);
      }),
    );
    const err = taskBody.querySelector<HTMLInputElement>('[data-a="error"]')!;
    err.addEventListener('change', () => h.onForecastError(err.checked));
    const diff = taskBody.querySelector<HTMLSelectElement>('[data-a="diff"]')!;
    diff.addEventListener('change', () => {
      difficulty = diff.value;
      taskBody.querySelector<HTMLElement>('.dsum')!.textContent = DIFFICULTY.find((d) => d.id === difficulty)?.description ?? '';
      h.onDifficulty(diff.value);
    });
    const wsrc = taskBody.querySelector<HTMLSelectElement>('[data-a="wsrc"]')!;
    wsrc.addEventListener('change', () => {
      weatherSource = wsrc.value;
      h.onWeatherSource(wsrc.value);
    });
    taskBody.querySelector<HTMLButtonElement>('[data-a="day"]')!.addEventListener('click', () => h.onNewDay());
  };

  const rows = (list: [string, string, string?][]) => list.map(([k, v, c]) => `<tr class="${c ?? ''}"><td>${k}</td><td>${v}</td></tr>`).join('');

  return {
    mapEl: q<HTMLElement>('.map'),
    viewEl: q<HTMLElement>('.view'),

    loadScenario(sc, s, forecastError) {
      current = { ...s };
      scen.value = sc.id;
      q<HTMLElement>('[data-win="task"] .win-title span').textContent = `Задача — ${sc.title}`;
      const survey = sc.kind === 'survey';
      taskBody.innerHTML = `
        <div class="brief"><b>${sc.title}</b><p>${sc.briefing}</p></div>
        <label class="select"><span>Режим</span><select data-a="diff">
          ${DIFFICULTY.map((d) => `<option value="${d.id}" ${d.id === difficulty ? 'selected' : ''}>${d.title}</option>`).join('')}
        </select></label>
        <p class="hint dsum">${DIFFICULTY.find((d) => d.id === difficulty)?.description ?? ''}</p>
        ${
          survey
            ? `<details open><summary>Съёмка</summary>
          <label class="select"><span>Камера</span><select data-k="cameraId">
            ${CAMERAS.map((c) => `<option value="${c.id}" ${c.id === s.cameraId ? 'selected' : ''}>${c.name} · ${fmt(c.massKg, 2)} кг</option>`).join('')}
          </select></label>
          ${range('gsdCm', 'GSD', 1.5, 6, 0.25, s.gsdCm)}
          ${range('forwardOverlapPct', 'Продольное перекрытие', 60, 90, 5, s.forwardOverlapPct)}
          ${range('sideOverlapPct', 'Поперечное перекрытие', 40, 80, 5, s.sideOverlapPct)}
          ${range('directionDeg', 'Направление галсов', 0, 175, 5, s.directionDeg)}
          <label class="select"><span>Выдержка</span><select data-k="shutter">
            ${[500, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000].map((d) => `<option value="${d}" ${d === s.shutter ? 'selected' : ''}>1/${d} с</option>`).join('')}
          </select></label>
          <p class="hint">Вершины участка можно двигать на карте до взлёта.</p>
        </details>`
            : ''
        }
        ${sc.kind === 'transfer' ? '<details open><summary>Пункт «Б»</summary><p class="hint">Точку «Б» можно перетащить на карте до взлёта; посадка — в «Б». Промежуточные точки — в маршруте ниже, заход на посадку строится по ветру.</p></details>' : ''}
        ${sc.kind === 'delivery' ? `<details open><summary>Груз</summary>${range('cargoKg', 'Масса груза', 0, 2, 0.1, s.cargoKg)}<p class="hint">Пункт «Б» можно перетащить на карте. Обратный путь — те же точки в обратном порядке.</p></details>` : ''}
        ${survey ? '' : '<details open><summary>Маршрут</summary><div class="route-box"></div></details>'}
        <details open><summary>Полёт</summary>
          ${range('iasMs', 'Скорость (приборная)', 15, 28, 0.5, s.iasMs)}
          ${range('localHour', 'Время вылета (местное)', 5, 21, 0.25, s.localHour)}
        </details>
        <details ${survey ? '' : 'open'}><summary>Погода — прогноз</summary>
          <label class="select"><span>Погода</span><select data-a="wsrc">
            ${WEATHER_SOURCES.map(([v, t]) => `<option value="${v}" ${v === weatherSource ? 'selected' : ''}>${t}</option>`).join('')}
          </select></label>
          <p class="hint wsum">${weatherSummary}</p>
          ${range('windSpeedMs', 'Ветер на 10 м', 0, 12, 0.5, s.windSpeedMs)}
          ${range('windFromDeg', 'Откуда дует', 0, 355, 5, s.windFromDeg)}
          ${range('temperatureC', 'Температура', -35, 35, 1, s.temperatureC)}
          <div class="row">
            <label class="check"><input type="checkbox" data-a="error" ${forecastError ? 'checked' : ''}> Факт отличается от прогноза</label>
            <button class="small" data-a="day">Другой день</button>
          </div>
        </details>
        ${survey ? '<details open><summary>Съёмочные параметры</summary><table class="kv survey"></table></details>' : ''}
        ${sc.kind === 'delivery' ? '<details open><summary>Полёты по прогнозу</summary><table class="kv stages"></table></details>' : ''}
        <details ${survey ? '' : 'open'}><summary>Бюджет энергии по прогнозу</summary><table class="kv budget"></table></details>
        <details open><summary>Предполётные проверки (РЛЭ)</summary><ul class="checks"></ul></details>
        <div class="verdict"></div>`;
      bindSettings();
      this.lockPlanning(locked, keepRouteOpen);
    },

    setRoute(points, first, last, editable) {
      const box = taskBody.querySelector<HTMLElement>('.route-box');
      if (!box) return;
      if (!points) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = `
        <p class="hint">Щелчок по карте — новая точка в конец, перетаскивание — сдвиг, правый щелчок по точке — удалить.</p>
        <table class="route"><tbody>
          <tr class="end"><td>А</td><td colspan="2">${first}</td></tr>
          ${points
            .map(
              (p, i) => `<tr><td>${i + 1}</td>
              <td><input type="number" min="40" max="800" step="10" value="${p.heightAglM}" data-rh="${i}" ${editable ? '' : 'disabled'}> м над рельефом</td>
              <td><button class="x" data-rdel="${i}" title="Удалить точку" ${editable ? '' : 'disabled'}>✕</button></td></tr>`,
            )
            .join('')}
          <tr class="end"><td>${last === first ? 'А' : 'Б'}</td><td colspan="2">${last}</td></tr>
        </tbody></table>
        <div class="row"><span class="hint">Точек: ${points.length}</span><button class="small" data-a="route-clear" ${editable ? '' : 'disabled'}>Очистить маршрут</button></div>`;
      box.querySelectorAll<HTMLInputElement>('[data-rh]').forEach((input) =>
        input.addEventListener('change', () => {
          const i = +input.dataset.rh!;
          const v = Math.min(800, Math.max(40, +input.value || 150));
          h.onRouteEdit(points.map((p, k) => (k === i ? { ...p, heightAglM: v } : { ...p })));
        }),
      );
      box.querySelectorAll<HTMLButtonElement>('[data-rdel]').forEach((b) =>
        b.addEventListener('click', () => h.onRouteEdit(points.filter((_, k) => k !== +b.dataset.rdel!).map((p) => ({ ...p })))),
      );
      box.querySelector<HTMLButtonElement>('[data-a="route-clear"]')!.addEventListener('click', () => h.onRouteEdit([]));
    },

    showPlan(info) {
      const r = info.combined;
      const b = r.budget;
      const finite = (x: number, d = 0) => (Number.isFinite(x) ? fmt(x, d) : '∞');
      const surveyTable = taskBody.querySelector<HTMLTableElement>('.survey');
      let coverageOk = true;
      let why = '';
      if (info.survey && surveyTable) {
        const { plan: sp, camera: cam, coverage: cov } = info.survey;
        const ok = info.survey.frames.filter((f) => f.ok);
        const maxBlur = Math.max(0, ...info.survey.frames.map((f) => f.blurPx));
        const maxIso = Math.max(0, ...info.survey.frames.map((f) => f.iso));
        const fp = footprintM(cam, sp.heightAglM);
        coverageOk = cov.atLeast5 >= info.survey.minCoverage;
        why = maxBlur > 1 ? 'смаз — короче выдержка или ниже скорость' : maxIso > cam.isoMax ? 'недодержка — длиннее выдержка или светлее время' : 'мало перекрытия — больше перекрытия или другое направление';
        surveyTable.innerHTML = rows([
          ['Высота над рельефом', `${fmt(sp.heightAglM)} м`],
          ['Кадр на земле', `${fmt(fp.acrossM)} × ${fmt(fp.alongM)} м`],
          ['Галсов, шаг', `${sp.lineCount} через ${fmt(sp.spacingM)} м`],
          ['Длина галсов', `${fmt(sp.linesLengthM / 1000, 1)} км`],
          ['Базис кадров', `${fmt(sp.baseM, 1)} м (не чаще ${fmt(cam.minIntervalS, 1)} с)`],
          ['Радиус разворота', `${fmt(sp.turnRadiusM)} м`],
          [`Ветер на ${fmt(sp.heightAglM)} м`, fmtWind(info.survey.windAtHeight)],
          ['Кадров по прогнозу', `${info.survey.frames.length}, годных ${ok.length} · ${fmt((info.survey.frames.length * cam.frameMB) / 1024, 1)} ГБ`, ok.length < info.survey.frames.length ? 'bad' : ''],
          ['Смаз, худший кадр', `${fmt(maxBlur, 2)} px`, maxBlur > 1 ? 'bad' : 'good'],
          ['ISO, худший кадр', `${fmt(maxIso)} (предел ${cam.isoMax})`, maxIso > cam.isoMax ? 'bad' : 'good'],
          [`≥ ${info.survey.minFrames} годных кадров`, `${fmt(cov.atLeast5 * 100)} % участка`, coverageOk ? 'good' : 'bad'],
        ]);
      }
      const stagesTable = taskBody.querySelector<HTMLTableElement>('.stages');
      if (stagesTable) {
        stagesTable.innerHTML = rows([
          ...info.stages.map(({ name, result: s }): [string, string] => [name, `${finite(s.budget.totalWh)} Вт·ч · ${fmt(s.distanceM / 1000, 1)} км · ${fmtTime(s.durationS)}`]),
          ['Стоянка на разгрузку', fmtTime(info.groundS)],
        ]);
      }
      taskBody.querySelector<HTMLTableElement>('.budget')!.innerHTML = rows([
        ['Взлёты: раскрутка и набор', `${fmt(b.takeoffWh)} Вт·ч`],
        ['Переходы', `${fmt(b.transitionWh)} Вт·ч`],
        ['Полёт по маршруту', `${finite(b.cruiseWh)} Вт·ч`],
        ...(b.payloadWh > 0 ? ([['Нагрузка', `${fmt(b.payloadWh)} Вт·ч`]] as [string, string][]) : []),
        ['Посадки', `${fmt(b.landingWh)} Вт·ч`],
        ['Итого', `${finite(b.totalWh)} Вт·ч`, 'total'],
        [`Ёмкость при ${FORMAT.temperatureC(info.temperatureC)}`, `${fmt(r.capacityWh)} Вт·ч`],
        ['Остаток на посадке', Number.isFinite(r.socAtLanding) ? `${fmt(r.socAtLanding * 100)} %` : '—', r.socAtLanding < 1 - r.usableWh / r.capacityWh ? 'bad' : 'good'],
        ['Путь', Number.isFinite(r.durationS) ? `${fmt(r.distanceM / 1000, 1)} км · ${fmtTime(r.durationS)}` : '—'],
        ['Меньше всего над рельефом', Number.isFinite(r.minClearanceM) ? `${fmt(r.minClearanceM)} м` : '—'],
      ]);
      const verdict = taskBody.querySelector<HTMLDivElement>('.verdict')!;
      const soc = Number.isFinite(r.socAtLanding) ? `остаток ${fmt(r.socAtLanding * 100)} %` : '';
      if (r.issues.length > 0) {
        verdict.className = 'verdict bad';
        verdict.innerHTML = r.issues.map((x) => `<div>${x}</div>`).join('');
      } else if (!coverageOk && info.survey) {
        verdict.className = 'verdict warn';
        verdict.textContent = `Долетим (${soc}), но ≥ ${info.survey.minFrames} кадров только на ${fmt(info.survey.coverage.atLeast5 * 100)} % участка: ${why}.`;
      } else {
        verdict.className = 'verdict good';
        verdict.textContent =
          info.stages.length > 1
            ? `По прогнозу выполнимо: ${info.stages.map((s) => `${s.name.toLowerCase()} — ${fmt(s.result.budget.totalWh)} Вт·ч`).join(', ')}; ${soc}.`
            : `По прогнозу выполнимо: ${soc}.`;
      }
    },

    showPreflight(checks) {
      const ul = taskBody.querySelector<HTMLUListElement>('.checks');
      if (!ul) return;
      ul.innerHTML = checks
        .map((c) => `<li class="${c.ok ? 'ok' : c.level}"><i>${c.ok ? '✓' : c.level === 'block' ? '✕' : '!'}</i>${c.text}</li>`)
        .join('');
    },

    setWeatherSummary(text) {
      weatherSummary = text;
      const p = taskBody.querySelector<HTMLElement>('.wsum');
      if (p) p.textContent = text;
    },

    setWeatherSource(src) {
      weatherSource = src;
      const sel = taskBody.querySelector<HTMLSelectElement>('[data-a="wsrc"]');
      if (sel) sel.value = src;
    },

    setSoundMuted(muted) {
      const b = q<HTMLButtonElement>('[data-a="sound"]');
      b.textContent = muted ? '🔇' : '🔊';
      b.title = muted ? 'Звук выключен — включить' : 'Звук включён — выключить';
    },

    showPreparation(p, required, live) {
      q<HTMLInputElement>('[data-prep-req]').checked = required;
      for (const s of PREP_STEPS) {
        const li = q<HTMLLIElement>(`[data-step="${s.id}"]`);
        const st = p.status[s.id];
        li.dataset.status = st;
        const btn = li.querySelector('button')!;
        const why = p.blocker(s.id);
        btn.disabled = why !== null;
        btn.title = why ?? '';
        btn.textContent = st === 'running' ? '…' : st === 'done' ? 'Повтор' : 'Выполнить';
        li.querySelector('em')!.textContent = st === 'running' ? (live ?? 'Выполняется…') : (p.result[s.id] ?? '');
      }
    },

    lockPlanning(on, keepRoute = false) {
      locked = on;
      keepRouteOpen = keepRoute;
      taskBody.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-k], [data-a="error"], [data-a="day"], [data-a="wsrc"], [data-a="diff"]').forEach((i) => (i.disabled = on));
      taskBody.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-rh], [data-rdel], [data-a="route-clear"]').forEach((i) => (i.disabled = on && !keepRoute));
      scen.disabled = on;
      el.classList.toggle('flying', on);
    },

    update(tm) {
      const s = tm.state;
      const status = q<HTMLDivElement>('[data-v="status"]');
      const notReady = s.mode === 'ground' && tm.notReady;
      const armedOnGround = s.armed && (s.mode === 'ground' || s.mode === 'landed') ? ' · АРМ' : '';
      status.textContent = s.mode === 'crashed' ? `АВАРИЯ: ${s.reason ?? ''}` : notReady ? 'НЕ ГОТОВ' : `${MODE_NAMES[s.mode]}${armedOnGround}${tm.stageName ? ` · ${tm.stageName}` : ''}`;
      status.dataset.mode = notReady ? 'crashed' : s.mode;
      const soc = Math.max(0, s.soc);
      q<HTMLElement>('[data-v="soc"]').textContent = `${fmt(soc * 100)}%`;
      q<HTMLElement>('[data-v="soc"]').parentElement!.classList.toggle('low', s.energyWh > tm.usableWh);
      q<HTMLElement>('[data-v="volt"]').textContent = `${fmt(tm.voltageV, 1)} В`;
      q<HTMLElement>('[data-v="power"]').textContent = fmt(s.powerW);
      q<HTMLElement>('[data-v="photos"]').textContent = String(tm.frames.total);
      q<HTMLElement>('[data-v="time"]').textContent = `T+${fmtTime(s.t)}`;
      q<HTMLButtonElement>('[data-a="rate"]').textContent = `${tm.rate}x`;
      q<HTMLButtonElement>('[data-a="pause"]').textContent = tm.paused ? '▶' : '❚❚';
      q<HTMLButtonElement>('[data-a="takeoff"]').disabled = s.mode !== 'ground' || tm.notReady || !s.armed;
      // АРМ ↔ ДИЗАРМ. ДИЗАРМ доступен и в полёте — для отработки отказа моторов.
      armed = s.armed;
      const armBtn = q<HTMLButtonElement>('[data-a="arm"]');
      armBtn.classList.toggle('on', s.armed);
      armBtn.querySelector('span')!.textContent = s.armed ? 'ДИЗАРМ' : 'АРМ';
      armBtn.title = s.armed ? 'Задизармить: моторы остановятся (в полёте — падение)' : 'Заармить: разрешить моторам работать';
      armBtn.disabled = !s.armed && (s.mode !== 'ground' || tm.notReady);
      q<HTMLButtonElement>('[data-a="unload"]').hidden = !tm.canUnload;
      // Тревоги перерисовываются только при изменении — таймер «нет связи» идёт по секундам.
      const key = JSON.stringify(tm.alerts);
      if (key !== alertsKey) {
        alertsKey = key;
        const box = q<HTMLDivElement>('.alerts');
        box.hidden = tm.alerts.length === 0;
        box.innerHTML = tm.alerts
          .map((a) => `<div class="al ${a.level}"><b>${a.text}</b>${a.actions ? `<ol>${a.actions.map((x) => `<li>${x}</li>`).join('')}</ol>` : ''}</div>`)
          .join('');
      }

      const tmRows: [string, string][] = [
        ['Над рельефом', `${fmt(s.aglM)} м`],
        ['Над морем', `${fmt(tm.altitudeMslM)} м`],
        ['Вертикальная', `${s.vzMs >= 0 ? '+' : ''}${fmt(s.vzMs, 1)} м/с`],
        ['Приборная / ист.', `${fmt(s.iasMs, 1)} / ${fmt(s.tasMs, 1)} м/с`],
        ['Путевая', `${fmt(s.groundSpeedMs, 1)} м/с`],
        ['Курс / ПУ', `${fmt(s.headingDeg)}° / ${fmt(s.trackDeg)}°`],
        ['Снос / крен', `${fmt(s.driftDeg, 1)}° / ${fmt(s.bankDeg, 1)}°`],
        ['Ветер', fmtWind(s.wind)],
        ['Мощность', `${fmt(s.powerW)} Вт`],
        ['Энергия', `${fmt(s.energyWh)} / ${fmt(tm.capacityWh)} Вт·ч`],
        ['Пройдено', `${fmt(s.distanceM / 1000, 2)} км`],
        ...(tm.frames.total ? ([['Кадров (годных)', `${tm.frames.total} (${tm.frames.ok})`]] as [string, string][]) : []),
      ];
      q<HTMLDListElement>('.win[data-win="telemetry"] .tm').innerHTML = tmRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      const pitch = s.groundSpeedMs > 3 ? (Math.atan2(s.vzMs, s.groundSpeedMs) * 180) / Math.PI : 0;
      drawAttitude(adi, 150, pitch, s.bankDeg, s.headingDeg);
      q<HTMLDListElement>('.adi-tm').innerHTML = [
        ['V', `${fmt(s.iasMs, 1)} м/с`],
        ['H', `${fmt(s.aglM)} м`],
        ['Vy', `${fmt(s.vzMs, 1)} м/с`],
      ]
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join('');
    },

    profile(data, aircraft) {
      drawProfile(prof, 440, 130, data, aircraft);
    },

    log(t, text, kind = 'info') {
      const li = document.createElement('li');
      li.className = kind;
      li.textContent = `T+${fmtTime(t)}  ${text}`;
      logEl.prepend(li);
      while (logEl.children.length > 200) logEl.lastElementChild!.remove();
    },

    toast(html, kind) {
      toastEl.className = `toast ${kind}`;
      toastEl.innerHTML = `${html}<button class="small" data-x>Закрыть</button>`;
      toastEl.hidden = false;
      toastEl.querySelector('[data-x]')!.addEventListener('click', () => (toastEl.hidden = true));
    },

    hideToast() {
      toastEl.hidden = true;
    },

    pip(label) {
      pipEl.hidden = label === null;
      if (label !== null) pipEl.querySelector('span')!.textContent = label;
    },

    flash() {
      pipEl.classList.remove('flash');
      void pipEl.offsetWidth;
      pipEl.classList.add('flash');
    },

    setControls(c) {
      for (const k of ['iasMs', 'heightAglM', 'courseDeg'] as const) {
        q<HTMLInputElement>(`[data-ctl="${k}"]`).value = String(c[k]);
        q<HTMLOutputElement>(`[data-c="${k}"]`).textContent = CTL_FORMAT[k](c[k]);
      }
    },

    targetMode(on) {
      el.classList.toggle('picking', on);
      q<HTMLButtonElement>('[data-a="target"]').classList.toggle('on', on);
    },
  };
}
