import type { Check } from '../game/preflight';
import type { AltitudeRef, RoutePoint, Scenario, ScenarioKind, Settings } from '../game/scenarios';
import { SEASONS, type SeasonId } from '../game/season';
import { WEATHER_EVENTS, type WeatherEventKind } from '../sim/weatherEvent';
import { EMERGENCY_COMMANDS, MODE_NAMES, type Command, type Controls, type LiveState } from '../sim/flight';
import { CAMERAS } from '../sim/payload';
import { loadQuality, QUALITY, type Quality } from './quality';
import { PREP_STEPS, type Preparation, type PrepStepId } from '../game/preparation';
import { DIFFICULTY } from '../game/scoring';
import { FAILURES, LINK_LOSS_ACTIONS, type LinkLossAction } from '../sim/failures';
import { footprintM, type Coverage, type Frame, type SurveyCamera, type SurveyPlan } from '../sim/survey';
import type { MissionResult, Wind } from '../sim/types';
import { drawAttitude, drawProfile, type ProfileData } from './instruments';
import type { CameraMode } from './scene';
import logoUrl from './brand/pp-logo-horizontal.svg';
import logoInverseUrl from './brand/pp-logo-horizontal-inverse.svg';
import markUrl from './brand/pp-mark.svg';

/*
 * Интерфейс в духе НСУ: строка состояния сверху, кнопки по краям карты, плавающие окна.
 * Слева карта, справа 3D-вид; граница двигается.
 */

export type GcsCommand = Command | 'target' | 'unload';

export interface GcsHandlers {
  onScenario(id: string): void;
  onSettings(s: Settings): void;
  onForecastError(on: boolean): void;
  /** Билет занятия: «номер» или «номер/день» — повторить; null — случайный на каждую попытку. */
  onTicket?(text: string | null): void;
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
  /** Нарисовать участок съёмки заново на карте. */
  onAreaDraw(): void;
  /** Район полётов. Переключение — перезагрузка страницы (делает main.ts). */
  onRegion?(id: string): void;
  /** Окно «Районы и карты»: пакеты районов для работы без сети. */
  onPacks?(): void;
  /** Окно «Курс подготовки». */
  onCourse?(): void;
  /** Линейка на карте: два щелчка — профиль и видимость. */
  onRuler?(): void;
  /** Пульт инструктора в отдельном окне; true — открыт. */
  onStation?(): boolean;
  /** Окно «Прогноз вылета»: задание по часам на реальный прогноз. */
  onForecast?(): void;
  /** Слой «Досягаемость» на карте: куда долетит и вернётся. */
  onReach?(on: boolean): void;
  /** Инструмент рисования зоны на карте; null — отмена. */
  onZoneTool?(kind: ZoneKind | null): void;
  onZonesImport?(text: string, fileName: string): void;
  onZonesExport?(): void;
  onZonesClear?(): void;
  onZoneDelete?(id: string): void;
  /** Поставить ретранслятор щелчком по карте: мачта или аппарат-ретранслятор; null — отмена. */
  onRelayTool?(kind: RelayKind | null): void;
  onRelayDelete?(index: number): void;
  /** Речевые сообщения НСУ: вкл/выкл. */
  onVoice?(on: boolean): void;
  /** Выбран голос из списка; «Прослушать» — пробная фраза. */
  /** Тема: авто (по Солнцу), тёмная, светлая. */
  onTheme?(mode: 'auto' | 'dark' | 'light'): void;
  /** Второй монитор: видео подвеса или 3D-вид в отдельном окне. */
  onSecondScreen?(): void;
  /** Кнопка «Пульт»: показать или спрятать пульт; вернуть — показан ли. */
  onSticks?(): boolean;
  onVoicePick?(uri: string): void;
  onVoicePreview?(): void;
}

/** Виды зон — тот же набор, что в модели зон; объявлены здесь, чтобы интерфейс от неё не зависел. */
export type ZoneKind = 'nofly' | 'gnss-jam' | 'gnss-spoof' | 'link-jam';
/** Ретранслятор: наземная мачта или аппарат-ретранслятор. */
export type RelayKind = 'ground' | 'air';
const ZONE_TITLES: Record<ZoneKind, string> = {
  nofly: 'Запретная зона',
  'gnss-jam': 'РЭБ: подавление ГНСС',
  'gnss-spoof': 'РЭБ: подмена ГНСС',
  'link-jam': 'РЭБ: подавление связи',
};
const ZONE_KINDS = Object.keys(ZONE_TITLES) as ZoneKind[];

/** Строка списка зон: detail — размер («R 1,2 км», «6 вершин, 2,4 км²»). */
export interface ZoneItem {
  id: string;
  kind: ZoneKind;
  title: string;
  detail: string;
}

export interface RegionItem {
  id: string;
  title: string;
  /** Подсказка к пункту списка. */
  hint: string;
}

export interface GcsOptions {
  regions?: RegionItem[];
  regionId?: string;
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
  /** Содержимое окна «Линейка» (рисует main.ts). */
  rulerEl: HTMLElement;
  viewEl: HTMLElement;
  loadScenario(sc: Scenario, s: Settings, forecastError: boolean): void;
  /** alt — как показывать и править высоту точек (система высот задания); без него — над рельефом. */
  setRoute(points: RoutePoint[] | null, first: string, last: string, editable: boolean, alt?: RouteAltitude): void;
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
  /** Подпись кнопки темы (сохранённый выбор). */
  setTheme(mode: 'auto' | 'dark' | 'light'): void;
  /** Выбрать источник погоды в списке (режим задаёт свою погоду). */
  setWeatherSource(src: string): void;
  /** Режим (тренировка, штатный, сложные, зачёт) — выставить из кода, как будто выбрали в списке. */
  setDifficulty(id: string): void;
  /** Идёт упражнение курса: строка над заданием; null — убрать. */
  setExercise(text: string | null): void;
  /** Билет текущей попытки («номер/день»). */
  setTicket(text: string): void;
  /** Открыть окно (task, prep, …), как кнопкой. */
  openWindow(id: string): void;
  /** Список районов; при одном районе и меньше выбор скрыт. */
  setRegions(list: RegionItem[], currentId: string): void;
  setZones(list: ZoneItem[]): void;
  /** Подсветить активный инструмент зон (null — рисования нет). Обработчик onZoneTool не вызывается. */
  setZoneTool(kind: ZoneKind | null): void;
  /** Ретрансляторы в окне «Зоны» по порядку (Р1, Р2…). */
  setRelays(list: { title: string; detail: string }[]): void;
  /** Подсветить инструмент ретранслятора (null — не ставится). Обработчик onRelayTool не вызывается. */
  setRelayTool(kind: RelayKind | null): void;
  /** Голос: available = false — переключатель неактивен, hint — почему (в подсказке). */
  setVoice(on: boolean, available: boolean, hint?: string): void;
  /** Русские голоса для выбора (пусто — выбор скрыт) и подсказка, где взять голос лучше. */
  setVoiceOptions(list: { uri: string; label: string; selected: boolean }[], hint: string | null): void;
  /** Качество радиосвязи 0..1 (null — скрыть); text — подсказка («Связь: запас 12 дБ, прямая видимость»). */
  setLink(quality: number | null, text: string): void;
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
  sticks: '<rect x="2" y="6" width="20" height="12" rx="4"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/>',
  arm: '<path d="M12 3v8"/><path d="M6.8 6.8a7.5 7.5 0 1 0 10.4 0"/>',
  debrief: '<path d="M4 20V4M4 20h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  instructor: '<circle cx="12" cy="7" r="3.2"/><path d="M5 20c1.2-4 3.8-6 7-6s5.8 2 7 6"/><path d="M12 14l-1.5 3 1.5 3 1.5-3z"/>',
  course: '<path d="M3 8l9-4 9 4-9 4z"/><path d="M7 10v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5"/><path d="M21 8v6"/>',
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
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3M6 10.5v3M10 10.5v3M14 10.5v3"/>',
  control: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  forecast: '<path d="M7 15a4 4 0 0 1-.6-8A5 5 0 0 1 16 7a3.5 3.5 0 0 1 1 7H7z"/><path d="M8 18l-1 2M12 18l-1 2M16 18l-1 2"/>',
  reach: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  zones: '<path d="M4 7l7-4 9 4-2 11-8 3-6-6z"/><path d="M9 9l6 6M15 9l-6 6"/>',
  ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  clear: '<path d="M3 18c2-5 5-1 7-5s4-5 7-6" stroke-dasharray="2 3"/><path d="M15 14l6 6M21 14l-6 6"/>',
};
const icon = (k: string) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
/** Источник погоды: задание, фактическая сейчас или пресет (weatherPreset в game/weather.ts). */
const WEATHER_SOURCES: [string, string][] = [
  ['scenario', 'По заданию — ползунки ниже'],
  ['live', 'Сейчас на площадке — Open-Meteo'],
  ['forecast', 'Прогноз на час вылета — Open-Meteo'],
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
/** Группа кнопок с подписью. low — прижата к низу колонки. */
const group = (cls: string, title: string, ...buttons: string[]) => `<div class="grp ${cls}"><i>${title}</i>${buttons.join('')}</div>`;
/** Кнопки, открывающие одноимённые окна. */
const WINDOWS = ['task', 'profile', 'prep', 'instructor', 'zones', 'telemetry', 'horizon', 'control', 'console', 'rc', 'batteries', 'ruler'];
const ZONE_HINT = 'Выберите вид и нарисуйте на карте. Зона РЭБ — круг: щелчок — центр, второй щелчок — граница. Запретная зона — многоугольник: щелчки по вершинам, двойной щелчок — завершить. Правый щелчок по зоне — удалить.';

/** Высота точек в таблице маршрута: показ и правка в системе высот задания. */
export interface RouteAltitude {
  unit: string;
  min: number;
  max: number;
  value(p: RoutePoint): number;
  apply(p: RoutePoint, v: number): RoutePoint;
}

/** Над рельефом — как было: высота точки и есть heightAglM. */
const AGL_ALTITUDE: RouteAltitude = { unit: 'м над рельефом', min: 20, max: 3000, value: (p) => p.heightAglM, apply: (p, v) => ({ ...p, heightAglM: v }) };

export const ALTITUDE_REFS: readonly { id: AltitudeRef; title: string }[] = [
  { id: 'agl', title: 'над рельефом' },
  { id: 'msl', title: 'над морем (абсолютная)' },
  { id: 'takeoff', title: 'от точки взлёта' },
];

type NumKey = Exclude<keyof Settings, 'cameraId' | 'shutter' | 'linkLossAction' | 'altitudeRef' | 'season' | 'weatherEvent'>;
const FORMAT: Record<NumKey, (v: number) => string> = {
  linkLossTimeoutS: (v) => `${v} с`,
  gsdCm: (v) => `${fmt(v, 2)} см`,
  forwardOverlapPct: (v) => `${v} %`,
  sideOverlapPct: (v) => `${v} %`,
  directionDeg: (v) => `${v}°`,
  cargoKg: (v) => `${fmt(v, 1)} кг`,
  iasMs: (v) => `${fmt(v, 1)} м/с`,
  windSpeedMs: (v) => `${fmt(v, 1)} м/с`,
  windFromDeg: (v) => `${v}° · ${COMPASS[Math.round(v / 45) % 8]}`,
  approachDeg: (v) => `${v}° · на ${COMPASS[Math.round(v / 45) % 8]}`,
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


/**
 * Крутилка курса, как у компаса: шкала через 10°, стороны света, стрелка — заданный курс,
 * треугольник снаружи — фактический путевой угол. Размер — в единицах viewBox, центр в нуле.
 */
function courseDial(): string {
  const r = (a: number, rad: number) => [Math.sin((a * Math.PI) / 180) * rad, -Math.cos((a * Math.PI) / 180) * rad].map((x) => x.toFixed(1));
  const ticks: string[] = [];
  for (let a = 0; a < 360; a += 10) {
    const major = a % 30 === 0;
    const [x0, y0] = r(a, major ? 42 : 46);
    const [x1, y1] = r(a, 50);
    ticks.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="${major ? 'maj' : ''}"/>`);
  }
  const labels = [
    [0, 'С'],
    [90, 'В'],
    [180, 'Ю'],
    [270, 'З'],
    [30, '3'],
    [60, '6'],
    [120, '12'],
    [150, '15'],
    [210, '21'],
    [240, '24'],
    [300, '30'],
    [330, '33'],
  ] as const;
  const text = labels.map(([a, t]) => {
    const [x, y] = r(a, 33);
    return `<text x="${x}" y="${y}" class="${a % 90 === 0 ? 'card' : ''}" dy="0.35em">${t}</text>`;
  });
  return `<svg class="dial" viewBox="-62 -62 124 124" tabindex="0" role="slider" aria-label="Курс, градусы" aria-valuemin="0" aria-valuemax="359">
    <circle r="50" class="ring"/>${ticks.join('')}${text.join('')}
    <g class="trk"><path d="M0,-52 L5,-60 L-5,-60 Z"/></g>
    <g class="cmd"><line x1="0" y1="10" x2="0" y2="-40"/><path d="M0,-50 L6,-38 L-6,-38 Z"/></g>
    <path class="plane" d="M0,-9 L2,-2 L9,1 L9,3 L2,2 L1,7 L4,9 L4,10 L-4,10 L-4,9 L-1,7 L-2,2 L-9,3 L-9,1 L-2,-2 Z"/>
  </svg>`;
}

const CTL_FORMAT: Record<'iasMs' | 'heightAglM' | 'courseDeg', (v: number) => string> = {
  iasMs: (v) => `${fmt(v, 1)} м/с`,
  heightAglM: (v) => `${v} м`,
  courseDeg: (v) => `${v}° · ${COMPASS[Math.round(v / 45) % 8]}`,
};

export function createGcs(root: HTMLElement, scenarios: readonly Scenario[], h: GcsHandlers, opts: GcsOptions = {}): Gcs {
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
    <div class="course"><span>Курс (РУЧНОЙ)</span><output data-c="courseDeg"></output>${courseDial()}<input type="hidden" data-ctl="courseDeg" value="0">
      <p class="hint">Тяните стрелку или щёлкните по шкале; колёсико и стрелки клавиатуры — по 5°. Треугольник снаружи — путевой угол.</p></div>
    <p class="hint">В МАРШРУТЕ меняется только скорость. РУЧНОЙ держит курс и высоту над рельефом с упреждением. ОЖИДАНИЕ — круг над аэродромом.</p>`;

  el.innerHTML = `
  <header class="topbar">
    <a class="brand" href="https://praktikapoleta.ru" target="_blank" rel="noopener" title="Практика полета — сайт школы">
      <img class="brand-logo brand-light" src="${logoUrl}" alt="Практика полета" height="28">
      <img class="brand-logo brand-dark" src="${logoInverseUrl}" alt="Практика полета" height="28">
      <img class="brand-mark" src="${markUrl}" alt="Практика полета" height="24">
      <span class="brand-product">Тренажёр VTOL</span>
    </a>
    <div class="tb-group tb-mission">
      <select class="tb scen" title="Задание">${scenarios.map((s) => `<option value="${s.id}">${s.title}</option>`).join('')}</select>
      <select class="tb region" hidden></select>
      <button class="tb" data-a="packs" title="Районы и карты: скачать район для работы без сети" ${h.onPacks ? '' : 'hidden'}>🗺</button>
      <button class="tb" data-a="restart" title="Сбросить полёт и начать это задание сначала">⟲<span class="lbl">Начать заново</span></button>
    </div>
    <div class="tb-group tb-sim">
      <button class="tb field" data-a="rate" title="Ускорение времени">1x</button>
      <button class="tb field" data-a="pause" title="Пауза (пробел)">❚❚</button>
      <div class="status" data-v="status">ГОТОВ</div>
    </div>
    <div class="tb-right">
      <span class="photo" title="Снято кадров" hidden>📷 <b data-v="photos">0</b></span>
      <span class="link" data-level="good" data-bars="4" hidden><i></i><i></i><i></i><i></i></span>
      <span class="batt" title="Заряд и напряжение (оценка без просадки)">🔋 <b data-v="soc">100%</b> <small data-v="volt">50,4 В</small></span>
      <span class="power" title="Мощность">⚡ <b data-v="power">0</b> Вт</span>
      <span class="time" data-v="time">T+0:00</span>
      <button class="tb" data-a="settings" title="Настройки: графика, звук, голос">⚙</button>
    </div>
  </header>
  <div class="menu settings" data-menu="settings" hidden>
    <label class="select"><span>Графика</span><select class="quality" title="Качество графики: дома, деревья, тени, сглаживание">${(Object.keys(QUALITY) as Quality[])
      .map((k) => `<option value="${k}" ${k === loadQuality() ? 'selected' : ''}>${QUALITY[k].label}</option>`)
      .join('')}</select></label>
    <button data-a="sound">🔊 Звук включён</button>
    <button data-a="rc" title="Пульт по USB или геймпад: оси, инверсия, калибровка">🎮 Пульт ДУ…</button>
    <button data-a="theme" title="Тёмная тема для ночных полётов; авто — тёмная, когда Солнце село">🌓 Тема: авто</button>
    <button data-a="screen2" title="Второй монитор: видео с подвеса или 3D-вид — в отдельном окне браузера">🖥 Второй экран…</button>
    <button data-a="voice" ${h.onVoice ? '' : 'hidden'}>🗣 Голос: выкл</button>
    <label class="select voice-pick" hidden><span>Голос</span><select data-voice-pick title="Русские голоса браузера: нейросетевые звучат естественнее"></select></label>
    <button data-a="voice-preview" hidden>▶ Прослушать</button>
    <p class="hint voice-hint" hidden></p>
  </div>
  <main class="split">
    <section class="map-pane">
      <div class="map"></div>
      <!-- Слева — по порядку работы: план, подготовка и полёт. Справа — карта, тренажёр и приборы. -->
      <div class="col left">
        ${group(
          'plan',
          'План',
          button('task', 'Задача', icon('task'), 'title="Задание, маршрут, погода, бюджет энергии"'),
          button('profile', 'Рельеф', icon('terrain'), 'title="Профиль рельефа вдоль маршрута"'),
          button('forecast', 'Прогноз', icon('forecast'), `title="Прогноз на реальный вылет: задание по часам на погоду Open-Meteo" ${h.onForecast ? '' : 'hidden'}`),
          button('batteries', 'АКБ', icon('battery'), 'title="Аккумуляторы: на аппарате, на зарядке, в машине — заряд, температура, износ"'),
        )}
        ${group(
          'flight',
          'Полёт',
          button('prep', 'Подготовка', icon('prep'), 'title="Предполётная подготовка (РЛЭ) — до АРМ"'),
          button('arm', 'АРМ', icon('arm')),
          button('takeoff', 'Взлёт', icon('takeoff')),
          button('mode', 'Режим', icon('mode'), 'title="Режим полёта"'),
          button('emergency', 'Аварийная', icon('emergency'), 'title="Возврат, посадка, фэйлсейф"'),
          button('sticks', 'Пульт', icon('sticks'), 'title="Пульт ДУ: показать ручки (экранные, пульт по USB, клавиатура); управление с пульта — в ФЭЙЛСЕЙФе"'),
          button('unload', 'Разгрузка', icon('unload'), 'hidden'),
        )}
      </div>
      <div class="col right">
        ${group(
          'maptools',
          'Карта',
          button('follow', 'Навигация', icon('nav'), 'title="Карта следует за аппаратом"'),
          button('target', 'Облёт точки', icon('target'), 'title="ОПЕР. ТОЧКА: щёлкните по карте — аппарат уйдёт к точке и будет кружить над ней. Esc — отмена"'),
          button('reach', 'Досягаемость', icon('reach'), `title="Куда долетит и вернётся: запас 25 %, 10 %, впритык, в один конец" ${h.onReach ? '' : 'hidden'}`),
          button('ruler', 'Линейка', icon('ruler'), `title="Расстояние, азимут, профиль рельефа и прямая видимость между двумя точками" ${h.onRuler ? '' : 'hidden'}`),
          button('clear', 'Очистить', icon('clear'), 'title="Очистить траекторию на карте и в 3D"'),
        )}
        ${group(
          'trainer',
          'Тренажёр',
          button('course', 'Курс', icon('course'), `title="Курс подготовки: упражнения с теорией и допуском, журнал налёта курсанта" ${h.onCourse ? '' : 'hidden'}`),
          button('instructor', 'Инструктор', icon('instructor'), 'title="Ввести особый случай"'),
          button('zones', 'Зоны', icon('zones'), `title="Запретные зоны и РЭБ" ${h.onZoneTool ? '' : 'hidden'}`),
          button('debrief', 'Разбор', icon('debrief'), 'title="Разбор полёта"'),
        )}
        ${group(
          'instruments low',
          'Приборы',
          button('telemetry', 'Телеметрия', icon('telemetry')),
          button('horizon', 'Авиагоризонт', icon('horizon')),
          button('control', 'Управление', icon('control'), 'title="Скорость, высота, курс"'),
          button('console', 'Консоль', icon('console'), 'title="Журнал событий"'),
        )}
      </div>
      <div class="menu" data-menu="mode" hidden>
        ${(['auto', 'manual', 'target', 'hold', 'rtl', 'land'] as const).map((m) => `<button data-cmd="${m}">${{ auto: 'МАРШРУТ — по заданию', manual: 'РУЧНОЙ — курс и высота', target: 'ОПЕРАТИВНАЯ ТОЧКА — круг над точкой', hold: 'ОЖИДАНИЕ — круг над аэродромом', rtl: 'ВОЗВРАТ на аэродром', land: 'ПОСАДКА на месте' }[m]}</button>`).join('')}
      </div>
      <div class="menu" data-menu="emergency" hidden>
        <button data-cmd="rtl">Возврат на аэродром</button>
        <button data-cmd="land">Посадка на месте</button>
        <button data-cmd="failsafe">ФЭЙЛСЕЙФ — ручное управление с ПДУ</button>
        <button data-cmd="copter">КОПТЕР — в фэйлсейфе перейти на роторы</button>
        ${EMERGENCY_COMMANDS.map((c) => `<button data-cmd="${c.cmd}" title="${c.hint.replace(/"/g, '&quot;')}">${c.label}</button>`).join('')}
      </div>
    </section>
    <div class="splitter" title="Потяните, чтобы изменить доли"></div>
    <section class="view-pane">
      <div class="view"><div class="view-attr" hidden></div></div>
      <div class="cam-dock" hidden><canvas></canvas></div>
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
  ${win('task', 'Задача', '<div class="task-body"></div>', 'width:330px', true)}
  ${win(
    'prep',
    'Предполётная подготовка (РЛЭ, прил. А)',
    `<label class="prep-req"><input type="checkbox" data-prep-req> Требовать подготовку перед АРМ</label>
    <ol class="prep">${PREP_STEPS.map((s) => `<li data-step="${s.id}" data-status="todo"><button class="small" data-prep="${s.id}">Выполнить</button><div><b>${s.title}</b><small>${s.hint}</small><em></em></div></li>`).join('')}</ol>`,
    'width:380px',
  )}
  ${win(
    'instructor',
    'Инструктор — особые случаи',
    `<div class="row"><button class="small" data-a="station" title="Отдельное окно для второго монитора: карта с истинным местом и тем, что видит НСУ, отказы по условию, сообщения оператору, замечания в разбор">🖥 Пульт инструктора в отдельном окне…</button></div>
    <p class="hint">Отказ вводится сразу — как в таблице особых случаев РЛЭ. Оператор действует по порядку, разбор оценит реакцию.</p>
    <ul class="inject">${FAILURES.map((f) => `<li><button class="small" data-inject="${f.id}">Ввести</button><div><b>${f.title}</b><small>${f.effect}</small></div></li>`).join('')}</ul>
    <div class="row"><button class="small" data-restore="link">Восстановить связь</button><button class="small" data-restore="gnss">Восстановить ГНСС</button></div>`,
    'width:380px',
  )}
  ${win(
    'zones',
    'Зоны — запреты, РЭБ и связь',
    `<div class="zone-tools">${ZONE_KINDS.map((k) => `<button class="small" data-zone="${k}" title="Нарисовать на карте; повторное нажатие или Esc — отмена"><i class="zk" data-kind="${k}"></i>${ZONE_TITLES[k]}</button>`).join('')}</div>
    <p class="hint zhint">${ZONE_HINT}</p>
    <ul class="zones"></ul>
    <div class="row zone-io"><button class="small" data-za="import" title="Файл GeoJSON или KML">Импорт GeoJSON…</button><button class="small" data-za="export">Экспорт</button><button class="small" data-za="clear">Очистить все</button></div>
    <input type="file" accept=".geojson,.json,.kml" data-zfile hidden>
    <h4 class="zsub">Ретрансляторы связи</h4>
    <div class="zone-tools"><button class="small" data-relay="ground" title="Щелчок по карте — поставить мачту 10 м; повторное нажатие или Esc — отмена"><i class="zk rk"></i>Мачта 10 м</button><button class="small" data-relay="air" title="Аппарат-ретранслятор над точкой: около 1000 м над площадкой, не ниже 300 м над рельефом"><i class="zk rk"></i>Аппарат-ретранслятор</button></div>
    <ul class="zones rlist"></ul>
    <p class="hint">За хребтом связь пропадает — ретранслятор на гребне её держит. Правый щелчок по значку на карте — убрать.</p>`,
    'width:350px',
  )}
  ${win('control', 'Управление', controlBody, 'width:250px')}
  ${win('telemetry', 'Телеметрия', '<dl class="tm"></dl>', 'width:220px')}
  ${win('horizon', 'Авиагоризонт', '<canvas class="adi" width="150" height="150"></canvas><dl class="tm adi-tm"></dl>', 'width:170px')}
  ${win('console', 'Консоль', '<ul class="log"></ul>', 'width:320px')}
  ${win('rc', 'Пульт ДУ', '<div class="rc-setup"></div>', 'width:340px')}
  ${win('batteries', 'Аккумуляторы', '<div class="bat-panel"></div>', 'width:420px')}
  ${win('ruler', 'Линейка — профиль и видимость', '<div class="ruler-body"><p class="hint">Щёлкните на карте начало и конец линии.</p></div>', 'width:460px')}
  ${win('profile', 'Рельеф вдоль маршрута', '<canvas class="prof" width="440" height="130"></canvas>', 'width:460px')}
  <div class="toast" hidden></div>`;
  root.appendChild(el);

  const q = <T extends Element>(sel: string) => el.querySelector<T>(sel)!;
  const mapPane = q<HTMLElement>('.map-pane');
  const taskBody = q<HTMLElement>('.task-body');

  // Окна открываются у своей кнопки и не закрывают другие окна, кнопки и выбор ракурса.
  // Сдвинутое оператором окно остаётся где было, только не уходит за край.
  type Box = { l: number; t: number; r: number; b: number };
  const GAP = 8;
  const boxOf = (x: Element): Box => {
    const r = x.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(x, hi));
  const area = (): Box => ({ ...boxOf(el), t: boxOf(q('.topbar')).b });
  const moveTo = (w: HTMLElement, x: number, y: number) => {
    const g = el.getBoundingClientRect();
    Object.assign(w.style, { left: `${Math.round(x - g.left)}px`, top: `${Math.round(y - g.top)}px`, right: 'auto', bottom: 'auto' });
  };
  const keepIn = (w: HTMLElement, x: number, y: number) => {
    const a = area();
    moveTo(w, clamp(x, a.l + GAP, a.r - GAP - w.offsetWidth), clamp(y, a.t + GAP, a.b - GAP - w.offsetHeight));
  };
  // Окно выросло (загрузилось задание, пришла телеметрия). Не сдвинутое оператором — поставить заново
  // по настоящему размеру, если только что открыто или теперь налезает на другое окно; иначе — не
  // дать ему уйти за нижний край.
  const overlapsOther = (w: HTMLElement) => {
    const b = boxOf(w);
    return openWins().some((o) => {
      if (o === w) return false;
      const c = boxOf(o);
      return Math.min(b.r, c.r) - Math.max(b.l, c.l) > 4 && Math.min(b.b, c.b) - Math.max(b.t, c.t) > 4;
    });
  };
  const grown = new ResizeObserver((entries) => {
    const a = area();
    for (const { target } of entries) {
      const w = target as HTMLElement;
      if (w.hidden) continue;
      const b = boxOf(w);
      const changed = Math.abs(b.b - b.t - +(w.dataset.placedH ?? 0)) > 12;
      const fresh = Date.now() - +(w.dataset.openedAt ?? 0) < 2000;
      if (!w.dataset.moved && changed && (fresh || overlapsOther(w))) place(w);
      else if (b.b > a.b - GAP) keepIn(w, b.l, b.t);
    }
  });
  el.querySelectorAll('.win').forEach((w) => grown.observe(w));
  const place = (w: HTMLElement) => {
    // Окно не выше экрана под верхней строкой: длинное — с прокруткой внутри.
    const a = area();
    w.style.maxHeight = `${Math.round(a.b - a.t - 2 * GAP)}px`;
    const r = boxOf(w);
    if (w.dataset.moved) return keepIn(w, r.l, r.t);
    const wd = r.r - r.l;
    const ht = r.b - r.t;
    // Желаемое место — напротив своей кнопки: справа от левой колонки, слева от правой.
    const btn = el.querySelector(`.gbtn[data-a="${w.dataset.win}"]`);
    const grp = btn?.closest('.grp');
    let px = a.l + GAP;
    let py = a.t + GAP;
    if (btn && grp) {
      const g = boxOf(grp);
      const m = boxOf(mapPane);
      px = g.l < (m.l + m.r) / 2 ? g.r + GAP : g.l - GAP - wd;
      py = boxOf(btn).t;
    }
    px = clamp(px, a.l + GAP, a.r - GAP - wd);
    py = clamp(py, a.t + GAP, a.b - GAP - ht);
    // Занято: окна, кнопки, кнопки и окна поверх 3D-вида; сам 3D-вид — чуть дороже карты.
    const busy = [...root.querySelectorAll<HTMLElement>('.win, .grp, .view-pane .camera, .gimbal-btn, .smoke-btn, .pip, .rc-sticks, .view-pane')]
      .filter((x) => x !== w && x.offsetParent !== null && !x.hidden)
      .map((x) => ({ ...boxOf(x), k: x.classList.contains('view-pane') ? 0.05 : x.classList.contains('win') ? 1 : 4 }));
    // Цена места: сколько закрыто (кнопки — вчетверо дороже окон), затем — удалённость от желаемого.
    const cost = (x: number, y: number) => {
      let s = 0;
      for (const b of busy) {
        const dx = Math.min(x + wd, b.r + GAP) - Math.max(x, b.l - GAP);
        const dy = Math.min(y + ht, b.b + GAP) - Math.max(y, b.t - GAP);
        if (dx > 0 && dy > 0) s += dx * dy * b.k;
      }
      return s * 1e4 + (x - px) ** 2 + (y - py) ** 2;
    };
    let best: [number, number] = [px, py];
    let c = cost(px, py);
    // Желаемое место занято — лучшее по сетке 12 px: свободное и ближайшее, иначе наименее закрывающее.
    if (c > 0)
      for (let y = a.t + GAP; y <= a.b - GAP - ht; y += 12)
        for (let x = a.l + GAP; x <= a.r - GAP - wd; x += 12) {
          const cc = cost(x, y);
          if (cc < c) {
            c = cc;
            best = [x, y];
          }
        }
    moveTo(w, ...best);
    w.dataset.placedH = String(ht);
  };
  /** Окно поверх остальных; порядок — через z-index, чтобы не сбрасывать прокрутку. */
  const front = (w: HTMLElement) => {
    const z = (x: HTMLElement) => +x.style.zIndex || 0;
    [...root.querySelectorAll<HTMLElement>('.win')]
      .filter((x) => x !== w)
      .sort((a, b) => z(a) - z(b))
      .concat(w)
      .forEach((x, i) => (x.style.zIndex = String(1003 + i)));
  };
  const openWins = () =>
    [...el.querySelectorAll<HTMLElement>('.win')].filter((w) => !w.hidden).sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
  /** После изменения размеров: окна у кнопок — заново, сдвинутые — только в пределы экрана. */
  const relayout = () => openWins().forEach((w) => (w.dataset.moved ? keepIn(w, boxOf(w).l, boxOf(w).t) : place(w)));

  // Окна: открыть/закрыть, перетаскивание за заголовок.
  const toggle = (id: string, show?: boolean) => {
    const w = q<HTMLElement>(`[data-win="${id}"]`);
    w.hidden = show === undefined ? !w.hidden : !show;
    el.querySelector(`.gbtn[data-a="${id}"]`)?.classList.toggle('open', !w.hidden);
    if (!w.hidden) {
      w.dataset.openedAt = String(Date.now());
      front(w);
      place(w);
    } else if (id === 'zones') {
      setTool(null, true);
      setRelayMode(null, true);
    }
  };
  el.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.close!, false)));
  el.querySelectorAll<HTMLElement>('.win-title').forEach((t) => {
    t.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const w = t.parentElement!;
      front(w);
      const r = w.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev: PointerEvent) => {
        w.dataset.moved = '1';
        keepIn(w, ev.clientX - dx, ev.clientY - dy);
      };
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
    m.hidden = false;
    // Меню строки состояния — под кнопкой, меню колонки — справа от кнопки, не ниже края.
    const r = anchor.getBoundingClientRect();
    const pr = (m.offsetParent ?? el).getBoundingClientRect();
    if (anchor.closest('.topbar')) Object.assign(m.style, { left: `${Math.max(8, r.right - pr.left - m.offsetWidth)}px`, top: `${r.bottom - pr.top + 4}px` });
    else Object.assign(m.style, { left: `${r.right - pr.left + 8}px`, top: `${Math.max(8, Math.min(r.top - pr.top, pr.height - m.offsetHeight - 8))}px` });
  };
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element).closest?.('.menu, [data-a="mode"], [data-a="emergency"], [data-a="settings"]')) closeMenus();
  });

  let voiceOn = false;
  const showVoice = () => (q<HTMLButtonElement>('[data-a="voice"]').textContent = `🗣 Голос: ${voiceOn ? 'вкл' : 'выкл'}`);
  let follow = false;
  let reach = false;
  let weatherSource = 'scenario';
  let weatherSummary = '';
  let difficulty = 'train';
  let exerciseText: string | null = null;
  let ticketText = '';
  let ticketFixed = false;
  let alertsKey = '';
  let armed = false;
  el.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.a!;
      if (a === 'arm') h.onCommand(armed ? 'disarm' : 'arm');
      else if (a === 'takeoff') h.onCommand('takeoff');
      else if (a === 'unload') h.onCommand('unload');
      else if (a === 'mode' || a === 'emergency' || a === 'settings') openMenu(a, b);
      else if (a === 'packs') h.onPacks?.();
      else if (a === 'course') h.onCourse?.();
      else if (a === 'ruler') h.onRuler?.();
      else if (a === 'station') h.onStation?.();
      else if (a === 'forecast') h.onForecast?.();
      else if (a === 'sticks') b.classList.toggle('open', h.onSticks?.() ?? false);
      else if (a === 'theme') {
        const order = ['auto', 'dark', 'light'] as const;
        const next = order[(order.indexOf((b.dataset.mode as (typeof order)[number]) ?? 'auto') + 1) % order.length]!;
        b.dataset.mode = next;
        b.textContent = `🌓 Тема: ${{ auto: 'авто', dark: 'тёмная', light: 'светлая' }[next]}`;
        h.onTheme?.(next);
      } else if (a === 'screen2') h.onSecondScreen?.();
      else if (a === 'reach') {
        reach = !reach;
        b.classList.toggle('on', reach);
        h.onReach?.(reach);
      }
      else if (WINDOWS.includes(a)) toggle(a);
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
      else if (a === 'voice') {
        voiceOn = !voiceOn;
        showVoice();
        h.onVoice?.(voiceOn);
      } else if (a === 'voice-preview') h.onVoicePreview?.();
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
    if (e.key === 'Escape') {
      closeMenus();
      if (zoneTool) setTool(null, true);
      // Выбор точки облёта на карте — отмена.
      if (el.classList.contains('picking')) h.onCommand('target');
      return;
    }
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
  // Крутилка курса.
  const dial = q<SVGSVGElement>('.course .dial');
  const dragging = new Set<number>();
  const capture = (el: Element, id: number) => {
    dragging.add(id);
    try {
      el.setPointerCapture(id);
    } catch {
      // Указатель уже отпущен — перетаскивание дойдёт и без захвата.
    }
  };
  dial.addEventListener('pointerup', (e) => dragging.delete(e.pointerId));
  dial.addEventListener('pointercancel', (e) => dragging.delete(e.pointerId));
  const setCourse = (deg: number, fromUser: boolean) => {
    const v = ((Math.round(deg) % 360) + 360) % 360;
    dial.querySelector('.cmd')!.setAttribute('transform', `rotate(${v})`);
    dial.setAttribute('aria-valuenow', String(v));
    q<HTMLInputElement>('[data-ctl="courseDeg"]').value = String(v);
    q<HTMLOutputElement>('[data-c="courseDeg"]').textContent = CTL_FORMAT.courseDeg(v);
    if (fromUser) h.onControls({ courseDeg: v });
  };
  const courseAt = (e: PointerEvent) => {
    const b = dial.getBoundingClientRect();
    return (Math.atan2(e.clientX - (b.left + b.width / 2), -(e.clientY - (b.top + b.height / 2))) * 180) / Math.PI;
  };
  dial.addEventListener('pointerdown', (e) => {
    capture(dial, e.pointerId);
    dial.focus();
    setCourse(courseAt(e), true);
  });
  dial.addEventListener('pointermove', (e) => {
    if (dragging.has(e.pointerId)) setCourse(courseAt(e), true);
  });
  const courseNow = () => +q<HTMLInputElement>('[data-ctl="courseDeg"]').value;
  dial.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setCourse(Math.round(courseNow() / 5) * 5 + (e.deltaY > 0 ? 5 : -5), true);
    },
    { passive: false },
  );
  dial.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    setCourse(Math.round(courseNow() / 5) * 5 + d, true);
  });
  q<HTMLSelectElement>('.camera').addEventListener('change', (e) => h.onCamera((e.target as HTMLSelectElement).value as CameraMode));
  q<HTMLSelectElement>('.quality').addEventListener('change', (e) => h.onQuality((e.target as HTMLSelectElement).value as Quality));
  q<HTMLSelectElement>('[data-voice-pick]').addEventListener('change', (e) => h.onVoicePick?.((e.target as HTMLSelectElement).value));
  el.querySelectorAll<HTMLButtonElement>('[data-prep]').forEach((b) => b.addEventListener('click', () => h.onPrepStep(b.dataset.prep as PrepStepId)));
  q<HTMLInputElement>('[data-prep-req]').addEventListener('change', (e) => h.onPrepRequired((e.target as HTMLInputElement).checked));
  el.querySelectorAll<HTMLButtonElement>('[data-inject]').forEach((b) => b.addEventListener('click', () => h.onInject(b.dataset.inject!)));
  el.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((b) => b.addEventListener('click', () => h.onRestore(b.dataset.restore as 'link' | 'gnss')));

  // Район полётов: выбор скрыт, пока район один.
  const regionSel = q<HTMLSelectElement>('.region');
  const setRegions = (list: RegionItem[], currentId: string) => {
    regionSel.replaceChildren(
      ...list.map((r) => {
        const o = new Option(r.title, r.id, false, r.id === currentId);
        o.title = r.hint;
        return o;
      }),
    );
    regionSel.hidden = list.length < 2;
    const cur = list.find((r) => r.id === currentId);
    regionSel.title = cur ? `Район: ${cur.hint}` : 'Район полётов';
  };
  setRegions(opts.regions ?? [], opts.regionId ?? '');
  regionSel.addEventListener('change', () => h.onRegion?.(regionSel.value));

  // Зоны: инструмент рисования, список, импорт и экспорт. Сами зоны — в main.ts и на карте.
  let zoneTool: ZoneKind | null = null;
  const setTool = (k: ZoneKind | null, notify: boolean) => {
    if (k === zoneTool) return;
    zoneTool = k;
    el.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach((b) => b.classList.toggle('on', b.dataset.zone === k));
    q('.gbtn[data-a="zones"]').classList.toggle('on', k !== null);
    el.classList.toggle('zone-drawing', k !== null);
    q('.zhint').textContent =
      k === null
        ? ZONE_HINT
        : k === 'nofly'
          ? `${ZONE_TITLES[k]}: щелчки по вершинам, двойной щелчок или щелчок по первой вершине — завершить. Esc — отмена.`
          : `${ZONE_TITLES[k]}: щелчок — центр, второй щелчок — граница. Esc — отмена.`;
    if (k !== null) setRelayMode(null, true);
    if (notify) h.onZoneTool?.(k);
  };
  // Ретрансляторы: поставить щелчком по карте, убрать — крестиком в списке или правым щелчком по значку.
  let relayTool: RelayKind | null = null;
  const setRelayMode = (k: RelayKind | null, notify: boolean) => {
    if (k === relayTool) return;
    relayTool = k;
    el.querySelectorAll<HTMLButtonElement>('[data-relay]').forEach((b) => b.classList.toggle('on', b.dataset.relay === k));
    if (k !== null) setTool(null, true);
    if (notify) h.onRelayTool?.(k);
  };
  el.querySelectorAll<HTMLButtonElement>('[data-relay]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.relay as RelayKind;
      setRelayMode(relayTool === k ? null : k, true);
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.zone as ZoneKind;
      setTool(zoneTool === k ? null : k, true);
    }),
  );
  const zoneFile = q<HTMLInputElement>('[data-zfile]');
  el.querySelectorAll<HTMLButtonElement>('[data-za]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.za;
      if (a === 'import') zoneFile.click();
      else if (a === 'export') h.onZonesExport?.();
      else if (a === 'clear' && window.confirm('Удалить все зоны?')) h.onZonesClear?.();
    }),
  );
  zoneFile.addEventListener('change', () => {
    const f = zoneFile.files?.[0];
    zoneFile.value = '';
    if (f)
      f.text().then(
        (text) => h.onZonesImport?.(text, f.name),
        () => api.log(0, `Не удалось прочитать файл ${f.name}`, 'warn'),
      );
  });

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
      relayout();
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
  let isSurvey = false;
  let locked = false;
  let keepRouteOpen = false;

  // Настройки задания — поля зависят от вида задания.
  const read = (): Settings => {
    const s = { ...current! };
    taskBody.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((i) => {
      const k = i.dataset.k as keyof Settings;
      if (k === 'cameraId') s.cameraId = i.value;
      else if (k === 'linkLossAction') s.linkLossAction = i.value as LinkLossAction;
      else if (k === 'altitudeRef') s.altitudeRef = i.value as AltitudeRef;
      else if (k === 'season') s.season = i.value as SeasonId;
      else if (k === 'weatherEvent') s.weatherEvent = i.value as WeatherEventKind;
      else if (k === 'approachDeg') s.approachDeg = approachIntoWind() ? null : +i.value;
      else (s as Record<string, number | string>)[k] = +i.value;
    });
    return s;
  };
  // Курс захода: галочка «против ветра» — ползунок следует за ветром и не трогается.
  const approachIntoWind = () => taskBody.querySelector<HTMLInputElement>('[data-a="approach-wind"]')?.checked ?? true;
  const syncApproach = () => {
    const range = taskBody.querySelector<HTMLInputElement>('[data-k="approachDeg"]');
    if (!range) return;
    range.disabled = locked || approachIntoWind();
    if (!approachIntoWind()) return;
    range.value = taskBody.querySelector<HTMLInputElement>('[data-k="windFromDeg"]')?.value ?? range.value;
    taskBody.querySelector<HTMLOutputElement>('[data-o="approachDeg"]')!.textContent = FORMAT.approachDeg(+range.value);
  };
  let pending = 0;
  const bindSettings = () => {
    taskBody.querySelectorAll<HTMLInputElement>('[data-k]').forEach((input) =>
      input.addEventListener('input', () => {
        const k = input.dataset.k as keyof Settings;
        if (k in FORMAT) taskBody.querySelector<HTMLOutputElement>(`[data-o="${k}"]`)!.textContent = FORMAT[k as NumKey](+input.value);
        if (k === 'windFromDeg') syncApproach();
        // Пересчёт тяжёлый — не чаще раза в 150 мс.
        window.clearTimeout(pending);
        pending = window.setTimeout(() => {
          current = read();
          h.onSettings(current);
        }, 150);
      }),
    );
    const approach = taskBody.querySelector<HTMLInputElement>('[data-a="approach-wind"]')!;
    approach.addEventListener('change', () => {
      syncApproach();
      current = read();
      h.onSettings(current);
    });
    syncApproach();
    const tk = taskBody.querySelector<HTMLInputElement>('[data-a="ticket"]')!;
    const tkRandom = taskBody.querySelector<HTMLButtonElement>('[data-a="ticket-random"]')!;
    tk.addEventListener('change', () => {
      ticketFixed = true;
      tkRandom.disabled = false;
      h.onTicket?.(tk.value);
    });
    tkRandom.addEventListener('click', () => {
      ticketFixed = false;
      tkRandom.disabled = true;
      h.onTicket?.(null);
    });
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

  const api: Gcs = {
    mapEl: q<HTMLElement>('.map'),
    rulerEl: q<HTMLElement>('.ruler-body'),
    viewEl: q<HTMLElement>('.view'),

    loadScenario(sc, s, forecastError) {
      current = { ...s };
      scen.value = sc.id;
      q<HTMLElement>('[data-win="task"] .win-title span').textContent = `Задача — ${sc.title}`;
      const survey = sc.kind === 'survey';
      isSurvey = survey;
      taskBody.innerHTML = `
        <div class="exercise" ${exerciseText ? '' : 'hidden'}>${exerciseText ?? ''}</div>
        <div class="brief"><b>${sc.title}</b><p>${sc.briefing}</p></div>
        <label class="select"><span>Режим</span><select data-a="diff">
          ${DIFFICULTY.map((d) => `<option value="${d.id}" ${d.id === difficulty ? 'selected' : ''}>${d.title}</option>`).join('')}
        </select></label>
        <p class="hint dsum">${DIFFICULTY.find((d) => d.id === difficulty)?.description ?? ''}</p>
        <div class="ticket-row" ${h.onTicket ? '' : 'hidden'}><label class="select"><span>Билет</span><input data-a="ticket" value="${ticketText}" title="Номер билета задаёт отказы, людей и очаги, погоду в полёте. Введите номер (или «номер/день») из протокола — занятие повторится" inputmode="numeric"></label><button class="small" data-a="ticket-random" title="Случайный билет на каждую попытку" ${ticketFixed ? '' : 'disabled'}>Случайный</button></div>
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
          <div class="row"><button class="small" data-a="area-draw" title="Щелчки по карте — вершины, двойной щелчок — готово, Esc — отмена">Нарисовать участок</button></div>
          <p class="hint">До взлёта участок правится на карте: вершины перетаскиваются, правый щелчок по вершине — удалить, «+» на стороне — добавить вершину. «Нарисовать участок» — новый участок с нуля.</p>
        </details>`
            : ''
        }
        ${sc.kind === 'transfer' ? '<details open><summary>Пункт «Б»</summary><p class="hint">Точку «Б» можно перетащить на карте до взлёта; посадка — в «Б». Промежуточные точки — в маршруте ниже, заход на посадку строится по ветру.</p></details>' : ''}
        ${sc.kind === 'delivery' ? `<details open><summary>Груз</summary>${range('cargoKg', 'Масса груза', 0, 2, 0.1, s.cargoKg)}<p class="hint">Пункт «Б» можно перетащить на карте. Обратный путь — те же точки в обратном порядке.</p></details>` : ''}
        ${sc.kind === 'search' ? '<details open><summary>Поиск тепловизором</summary><p class="hint">Галсы над районом поиска построены по полосе тепловизора; точки маршрута можно менять. В полёте внизу 3D-вида — окно тепловизора: щелчок по тёплому пятну ставит на земле отметку «здесь человек». Звери тоже тёплые: медведь крупный и приземистый, волки ходят стаей, лось высокий, на длинных ногах.</p></details>' : ''}
        ${
          sc.kind === 'fire'
            ? '<details open><summary>Лесопожарный патруль</summary><p class="hint">Маршрут облёта зоны можно менять. Дым виден в 3D-виде за километры: нажмите «Дым» под видом и щёлкните по столбу — это донесение о пожаре. Подойдя, найдите очаг в окне тепловизора: дым он просвечивает, видно горящую кромку. Щелчок по пятну — отметка «здесь огонь». Огневые точки — тлеющие места в гари, очаги переброса за кромкой и одиночные тлеющие деревья почти без дыма. Нагретый солнцем курумник и зимовье с печью — ложные цели.</p></details>'
            : ''
        }
        ${
          survey
            ? ''
            : `<details open><summary>Маршрут</summary>
          <label class="select"><span>Высота точек</span><select data-k="altitudeRef">
            ${ALTITUDE_REFS.map((a) => `<option value="${a.id}" ${a.id === s.altitudeRef ? 'selected' : ''}>${a.title}</option>`).join('')}
          </select></label>
          <p class="hint">Над рельефом — автопилот огибает рельеф на этой высоте. Над морем и от точки взлёта — между точками прямая по высоте, рельеф не огибается: следите за запасом в проверках.</p>
          <div class="route-box"></div></details>`
        }
        <details open><summary>Полёт</summary>
          ${range('iasMs', 'Скорость (приборная)', 15, 28, 0.5, s.iasMs)}
          ${range('localHour', 'Время вылета (местное)', 0, 23.75, 0.25, s.localHour)}
          <label class="select"><span>Время года</span><select data-k="season">
            ${SEASONS.map((x) => `<option value="${x.id}" ${x.id === (s.season ?? 'region') ? 'selected' : ''}>${x.title}</option>`).join('')}
          </select></label>
        </details>
        <details ${s.approachDeg == null ? '' : 'open'}><summary>Заход на посадку</summary>
          <label class="check"><input type="checkbox" data-a="approach-wind" ${s.approachDeg == null ? 'checked' : ''}> Против ветра</label>
          ${range('approachDeg', 'Курс захода', 0, 355, 5, s.approachDeg ?? s.windFromDeg)}
          <p class="hint">По РЛЭ заход — против ветра. Если к площадке можно подойти только с одной стороны (лес, склон, строения), снимите галочку и задайте курс на посадочной прямой: две точки посадочного маршрута встанут по нему. Попутный и боковой ветер на этом курсе покажут проверки. Возврат садится дома тем же курсом.</p>
        </details>
        <details><summary>Потеря связи</summary>
          <label class="select"><span>Без связи</span><select data-k="linkLossAction">
            ${LINK_LOSS_ACTIONS.map((a) => `<option value="${a.id}" ${a.id === s.linkLossAction ? 'selected' : ''}>${a.title}</option>`).join('')}
          </select></label>
          ${range('linkLossTimeoutS', 'Через', 5, 120, 5, s.linkLossTimeoutS)}
          <p class="hint">Что делает автопилот, если связи с НСУ нет дольше заданного. Задание уже на борту: «Продолжать задание» доводит его до конца и садится по плану, «Посадка на месте» — вертикально там, где застала потеря связи.</p>
        </details>
        <details ${survey ? '' : 'open'}><summary>Погода — прогноз</summary>
          <label class="select"><span>Погода</span><select data-a="wsrc">
            ${WEATHER_SOURCES.map(([v, t]) => `<option value="${v}" ${v === weatherSource ? 'selected' : ''}>${t}</option>`).join('')}
          </select></label>
          <p class="hint wsum">${weatherSummary}</p>
          ${range('windSpeedMs', 'Ветер на 10 м', 0, 12, 0.5, s.windSpeedMs)}
          ${range('windFromDeg', 'Откуда дует', 0, 355, 5, s.windFromDeg)}
          ${range('temperatureC', 'Температура', -35, 35, 1, s.temperatureC)}
          <label class="select"><span>В полёте погода</span><select data-k="weatherEvent">
            ${WEATHER_EVENTS.map((x) => `<option value="${x.id}" ${x.id === (s.weatherEvent ?? 'none') ? 'selected' : ''}>${x.title}</option>`).join('')}
          </select></label>
          <p class="hint">Фронт или гроза в прогнозе, по которому строится план, не учтены: где они, видно на карте, сводки метеослужбы — в консоли. Продолжать задание или возвращаться — решать вам.</p>
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
      taskBody.querySelector<HTMLButtonElement>('[data-a="area-draw"]')?.addEventListener('click', () => h.onAreaDraw());
      this.lockPlanning(locked, keepRouteOpen);
    },

    setRoute(points, first, last, editable, alt = AGL_ALTITUDE) {
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
              <td><input type="number" min="${alt.min}" max="${alt.max}" step="10" value="${Math.round(alt.value(p))}" data-rh="${i}" ${editable ? '' : 'disabled'}> ${alt.unit}</td>
              <td><button class="x" data-rdel="${i}" title="Удалить точку" ${editable ? '' : 'disabled'}>✕</button></td></tr>`,
            )
            .join('')}
          <tr class="end"><td>${last === first ? 'А' : 'Б'}</td><td colspan="2">${last}</td></tr>
        </tbody></table>
        <div class="row"><span class="hint">Точек: ${points.length}</span><button class="small" data-a="route-clear" ${editable ? '' : 'disabled'}>Очистить маршрут</button></div>`;
      box.querySelectorAll<HTMLInputElement>('[data-rh]').forEach((input) =>
        input.addEventListener('change', () => {
          const i = +input.dataset.rh!;
          const raw = Number(input.value);
          const v = Math.min(alt.max, Math.max(alt.min, Number.isFinite(raw) && input.value !== '' ? raw : alt.value(points[i]!)));
          h.onRouteEdit(points.map((p, k) => (k === i ? alt.apply(p, v) : { ...p })));
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

    setTicket(text) {
      ticketText = text;
      const i = taskBody.querySelector<HTMLInputElement>('[data-a="ticket"]');
      if (i && document.activeElement !== i) i.value = text;
    },

    openWindow(id) {
      toggle(id, true);
    },

    setDifficulty(id) {
      difficulty = id;
      const sel = taskBody.querySelector<HTMLSelectElement>('[data-a="diff"]');
      if (sel) sel.value = id;
      const sum = taskBody.querySelector<HTMLElement>('.dsum');
      if (sum) sum.textContent = DIFFICULTY.find((d) => d.id === id)?.description ?? '';
    },

    setExercise(text) {
      exerciseText = text;
      const b = taskBody.querySelector<HTMLElement>('.exercise');
      if (b) {
        b.hidden = !text;
        b.textContent = text ?? '';
      }
    },

    setWeatherSource(src) {
      weatherSource = src;
      const sel = taskBody.querySelector<HTMLSelectElement>('[data-a="wsrc"]');
      if (sel) sel.value = src;
    },

    setTheme(mode) {
      const b = q<HTMLButtonElement>('[data-a="theme"]');
      b.dataset.mode = mode;
      b.textContent = `🌓 Тема: ${{ auto: 'авто', dark: 'тёмная', light: 'светлая' }[mode]}`;
    },

    setSoundMuted(muted) {
      const b = q<HTMLButtonElement>('[data-a="sound"]');
      b.textContent = muted ? '🔇 Звук выключен' : '🔊 Звук включён';
      b.title = muted ? 'Включить звук' : 'Выключить звук';
      // Звук спрятан в меню настроек — выключенный виден на кнопке ⚙.
      q<HTMLButtonElement>('[data-a="settings"]').textContent = muted ? '⚙ 🔇' : '⚙';
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
      taskBody.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-k], [data-a="error"], [data-a="day"], [data-a="wsrc"], [data-a="diff"], [data-a="approach-wind"]').forEach((i) => (i.disabled = on));
      syncApproach();
      taskBody.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-rh], [data-rdel], [data-a="route-clear"]').forEach((i) => (i.disabled = on && !keepRoute));
      scen.disabled = on;
      regionSel.disabled = on;
      el.classList.toggle('flying', on);
    },

    update(tm) {
      const s = tm.state;
      dial.querySelector('.trk')!.setAttribute('transform', `rotate(${Math.round(s.trackDeg)})`);
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
      q<HTMLElement>('.tb-right .photo').hidden = !isSurvey && tm.frames.total === 0;
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
        // Угол сноса — путевой минус курс: плюс — сносит вправо (ветер слева), минус — влево.
        ['Угол сноса / крен', `${fmt(Math.abs(s.driftDeg), 1)}°${s.driftDeg > 0.5 ? ' вправо' : s.driftDeg < -0.5 ? ' влево' : ''} / ${fmt(s.bankDeg, 1)}°`],
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
      for (const k of ['iasMs', 'heightAglM'] as const) {
        q<HTMLInputElement>(`[data-ctl="${k}"]`).value = String(c[k]);
        q<HTMLOutputElement>(`[data-c="${k}"]`).textContent = CTL_FORMAT[k](c[k]);
      }
      setCourse(c.courseDeg, false);
    },

    targetMode(on) {
      el.classList.toggle('picking', on);
      q<HTMLButtonElement>('[data-a="target"]').classList.toggle('on', on);
    },

    setRegions,

    setZones(list) {
      const ul = q<HTMLUListElement>('ul.zones');
      ul.replaceChildren(
        ...list.map((z) => {
          const li = document.createElement('li');
          li.innerHTML = '<i class="zk"></i><div><b></b><small></small></div><button class="x" title="Удалить зону">✕</button>';
          li.querySelector<HTMLElement>('.zk')!.dataset.kind = z.kind;
          // Название и размер приходят и из импортированных файлов — только как текст.
          li.querySelector('b')!.textContent = z.title;
          li.querySelector('small')!.textContent = [z.title === ZONE_TITLES[z.kind] ? '' : ZONE_TITLES[z.kind], z.detail].filter(Boolean).join(' · ');
          li.querySelector('button')!.addEventListener('click', () => h.onZoneDelete?.(z.id));
          return li;
        }),
      );
      if (list.length === 0) ul.innerHTML = '<li class="empty">Зон нет</li>';
      el.querySelectorAll<HTMLButtonElement>('[data-za="export"], [data-za="clear"]').forEach((b) => (b.disabled = list.length === 0));
      q('.gbtn[data-a="zones"] span').textContent = list.length ? `Зоны ${list.length}` : 'Зоны';
    },

    setZoneTool(kind) {
      setTool(kind, false);
    },

    setRelays(list) {
      const ul = q<HTMLUListElement>('ul.rlist');
      ul.replaceChildren(
        ...list.map((r, i) => {
          const li = document.createElement('li');
          li.innerHTML = '<i class="zk rk"></i><div><b></b><small></small></div><button class="x" title="Убрать ретранслятор">✕</button>';
          li.querySelector('b')!.textContent = `Р${i + 1} · ${r.title}`;
          li.querySelector('small')!.textContent = r.detail;
          li.querySelector('button')!.addEventListener('click', () => h.onRelayDelete?.(i));
          return li;
        }),
      );
      if (list.length === 0) ul.innerHTML = '<li class="empty">Ретрансляторов нет</li>';
    },

    setRelayTool(kind) {
      setRelayMode(kind, false);
    },

    setVoice(on, available, hint) {
      voiceOn = on;
      showVoice();
      const b = q<HTMLButtonElement>('[data-a="voice"]');
      b.disabled = !available;
      b.title = hint ?? (available ? 'Речевые сообщения НСУ' : 'Голос недоступен');
    },

    setVoiceOptions(list, hint) {
      const sel = q<HTMLSelectElement>('[data-voice-pick]');
      // Названия голосов приходят из браузера — только как текст.
      sel.replaceChildren(
        ...list.map((v) => {
          const o = document.createElement('option');
          o.value = v.uri;
          o.textContent = v.label;
          o.selected = v.selected;
          return o;
        }),
      );
      q<HTMLElement>('.voice-pick').hidden = list.length === 0;
      q<HTMLButtonElement>('[data-a="voice-preview"]').hidden = list.length === 0;
      const p = q<HTMLElement>('.voice-hint');
      p.hidden = !hint;
      p.textContent = hint ?? '';
    },

    setLink(quality, text) {
      const s = q<HTMLElement>('.tb-right .link');
      s.hidden = quality === null;
      if (quality === null) return;
      const k = Math.max(0, Math.min(1, quality));
      // Палочки: 0 — нет связи; хоть какая-то связь — не меньше одной.
      s.dataset.bars = String(k <= 0 ? 0 : Math.max(1, Math.round(k * 4)));
      s.dataset.level = k <= 0 ? 'lost' : k < 0.4 ? 'weak' : 'good';
      s.title = text;
    },
  };

  api.setZones([]);
  // Окно «Задача» открыто с начала — у своей кнопки.
  place(q<HTMLElement>('[data-win="task"]'));
  q('.gbtn[data-a="task"]').classList.add('open');
  window.addEventListener('resize', relayout);
  return api;
}
