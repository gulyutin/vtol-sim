import 'leaflet/dist/leaflet.css';
import * as THREE from 'three';
import './ui/style.css';
import { PROFILE } from '@profile';
import { parseOsm } from './sim/osm';
import { loadQuality, QUALITY, saveQuality } from './ui/quality';
import { Preparation, PREP_STEPS, type GroundTest, type PrepStepId } from './game/preparation';
import { ACTIVE_REGION, buildMission, departure, forecastWeather, REGION, SCENARIOS, type Mission, type RoutePoint, type Scenario, type Settings } from './game/scenarios';
import { LOG_REGION_ID, osmRegionFor, REGIONS, saveLogRegion, setRegion } from './game/regions';
import { inBounds, placeRecording, regionFromRecording, settleOnTerrain } from './game/logRegion';
import { SurfaceMotion } from './game/surfaces';
import { FireMode } from './ui/fireMode';
import { Gimbal, GimbalWindow } from './ui/gimbal';
import { RcSticks } from './ui/rcSticks';
import { SearchMode } from './ui/searchMode';
import { loadLastLog, saveLastLog } from './ui/logStore';
import { placeOsm } from './ui/placeOsm';
import { osmUrlFor } from './ui/tileSource';
import { createPacksPanel } from './ui/packsPanel';
import { blocked, preflightChecks, type Check } from './game/preflight';
import { actualWeather, PRECIPITATION_NAME, weatherPreset, type WeatherPresetKind } from './game/weather';
import { fetchForecast, fetchLiveWeather, type LiveWeather } from './game/liveWeather';
import { applyForecastHour, FORECAST_LOOKAHEAD_H, planForecastAsync, type ForecastHour } from './game/forecastPlan';
import { ForecastPanel } from './ui/forecastPanel';
import { planReach, pointOfNoReturn, reachFrom, weatherWithMeasuredWind, type ReachOptions } from './sim/reach';
import { Sound, type SoundState } from './ui/audio';
import { FlightRecorder, poseOf, stateAt, type Recording } from './game/recorder';
import { assessFlight, FAILURE_TITLES, findDifficulty, planFailures, saveResult, type Assessment, type DifficultyId, type FailureEvent } from './game/scoring';
import { Debrief, openRecordingFiles } from './ui/debrief';
import { PilotInput } from './ui/pilotInput';
import { failureInfo, linkLossText, type FailureId } from './sim/failures';
import type { Alert } from './ui/gcs';
import { AIRCRAFT } from './sim/aircraft';
import { LiveFlight, MODE_NAMES, type Controls } from './sim/flight';
import { backTransitionAltitudeM, combineResults, distanceM, fromLocal, simulateMission, toLocal, transitionAltitudeM } from './sim/mission';
import { sunPosition } from './sim/sun';
import { TerrainRelief, TerrainWind } from './sim/terrainWind';
import { captureFrames, coverageOf, FrameTrigger, illuminanceLux, type Frame } from './sim/survey';
import { buildTimeline } from './sim/timeline';
import type { GeoPoint, MissionResult, Site, Terrain, Weather } from './sim/types';
import { windAt } from './sim/wind';
import { loadAircraft } from './ui/aircraftModel';
import { createGcs, fmt, fmtTime, fmtWind, type GcsCommand, type RouteAltitude, type SurveyInfo } from './ui/gcs';
import type { ProfileData } from './ui/instruments';
import { Map2D, type LegLabel, type Pin, type WindSiteMark } from './ui/map2d';
import { World, type CameraMode } from './ui/scene';
import { expandBounds, loadTerrain, type Bounds } from './ui/terrainData';
import type { ConclusionContext } from './game/flightSummary';
import { Callouts, type RouteInfo } from './game/callouts';
import { Voice } from './ui/voice';
import { EW_EFFECT_THRESHOLD, isZone, makeZoneId, zoneLabel, type Zone } from './sim/zones';
import { coverageSteps, linkProfile, type Relay } from './sim/radio';
import { parseZonesFile, zonesToGeoJSON } from './game/zonesGeoJson';
import { environmentAlerts } from './sim/failures';
import { eventKindOf } from './game/recorder';

const app = document.getElementById('app')!;
const RATES = [1, 2, 5, 10, 30, 60];

function cloneScenario(sc: Scenario): Scenario {
  switch (sc.kind) {
    case 'survey':
      return { ...sc, area: sc.area.map((p) => ({ ...p })), defaults: { ...sc.defaults } };
    case 'delivery':
      return { ...sc, destination: { ...sc.destination }, route: sc.route.map((p) => ({ ...p })), defaults: { ...sc.defaults } };
    case 'transfer':
      return { ...sc, destination: { ...sc.destination }, route: sc.route.map((p) => ({ ...p })), defaults: { ...sc.defaults } };
    case 'route':
      return { ...sc, route: sc.route.map((p) => ({ ...p })), defaults: { ...sc.defaults } };
    case 'search':
    case 'fire':
      return { ...sc, area: sc.area.map((p) => ({ ...p })), route: sc.route.map((p) => ({ ...p })), defaults: { ...sc.defaults } };
  }
}

/** Пункт Б у доставки и перелёта; у остальных заданий посадка там же, где взлёт. */
const destinationOf = (sc: Scenario): GeoPoint | null => (sc.kind === 'delivery' || sc.kind === 'transfer' ? sc.destination : null);
const destinationNameOf = (sc: Scenario): string => (sc.kind === 'delivery' || sc.kind === 'transfer' ? sc.destinationName : sc.siteName);

/** Команды оператора в записи полёта — по ним разбор считает время реакции. */
const COMMAND_TITLE: Record<string, string> = {
  arm: 'АРМ',
  disarm: 'ДИЗАРМ',
  takeoff: 'ВЗЛЁТ',
  auto: 'МАРШРУТ',
  manual: 'РУЧНОЙ',
  guided: 'ОПЕРАТИВНАЯ ТОЧКА',
  hold: 'ОЖИДАНИЕ',
  rtl: 'ВОЗВРАТ',
  land: 'ПОСАДКА',
  failsafe: 'ФЭЙЛСЕЙФ',
  copter: 'КОПТЕР',
  pusherStart: 'ЗАПУСК МАРШЕВОГО',
  armAir: 'АРМ В ВОЗДУХЕ',
  unload: 'РАЗГРУЗКА',
};

const inRegion = (p: GeoPoint) => p.lat > REGION.south && p.lat < REGION.north && p.lon > REGION.west && p.lon < REGION.east;

async function start() {
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Загружаю рельеф…';
  app.appendChild(loading);
  const bounds = expandBounds(REGION, 3000);
  const terrain = await loadTerrain(bounds, 12, (done, total) => (loading.textContent = `Загружаю рельеф: ${done} из ${total}`));
  // Рельеф для ветра у склонов — один раз на район, порциями, чтобы не подвешивать страницу.
  const o = SCENARIOS[0]!.site;
  const sw = toLocal(o, { lat: bounds.south, lon: bounds.west });
  const ne = toLocal(o, { lat: bounds.north, lon: bounds.east });
  const relief = await TerrainRelief.buildAsync(
    terrain,
    { ...o, elevationM: terrain.elevationM(o) },
    { area: { east0: sw.east, north0: sw.north, east1: ne.east, north1: ne.north } },
    (f) => (loading.textContent = `Считаю ветер у рельефа: ${Math.round(f * 100)} %`),
  );
  loading.remove();
  run(terrain, bounds, relief);
}

function run(terrain: Terrain, bounds: Bounds, relief: TerrainRelief) {
  const siteA: Site = { ...SCENARIOS[0]!.site, elevationM: terrain.elevationM(SCENARIOS[0]!.site) };
  const local = (p: GeoPoint) => toLocal(siteA, p);

  let scenario: Scenario = cloneScenario(SCENARIOS[0]!);
  let settings: Settings = { ...scenario.defaults };
  let forecastError = true;
  let daySeed = 1;
  let forecast!: Weather;
  let actual!: Weather;
  // Ветер у рельефа: по прогнозу — для проверок и карты, фактический — для полёта.
  let windForecast: TerrainWind | null = null;
  let windActual: TerrainWind | null = null;
  const sunAt = (t: number) => sunPosition(new Date(departure(scenario, settings).getTime() + t * 1000), siteA);
  let mission!: Mission;
  let parts: MissionResult[] = [];
  let planned!: MissionResult;
  let stage = 0;
  let flight!: LiveFlight;
  let trigger: FrameTrigger | null = null;
  let frames: Frame[] = [];
  let controls: Controls = { iasMs: 21, heightAglM: 150, courseDeg: 0, target: null };
  let rate = 1;
  let paused = false;
  let targetMode = false;
  let started = false;
  let announced = false;
  let stageLanded = false;
  let atDestination = false;
  let fallS = 0;
  let eventsShown = 0;
  /** События среды (зоны, подмена) — только в запись для разбора: оператор о подмене не знает. */
  let envShown = 0;
  let lastTrailT = -Infinity;
  let pastDistanceM = 0;
  let profile: ProfileData = { dist: [], terrain: [], plan: [] };
  let checks: Check[] = [];
  // Предполётная подготовка (РЛЭ, прил. А); по желанию оператора — обязательна перед АРМ.
  const PREP_KEY = 'vtol-sim.prepRequired';
  const prep = new Preparation();
  let prepRequired = (() => {
    try {
      return localStorage.getItem(PREP_KEY) === '1';
    } catch {
      return false;
    }
  })();
  let prepView = '';
  let prepDoneCount = 0;
  /** Проверка подготовки, которая сейчас идёт, — для звука роторов по одному. */
  let lastTest: GroundTest | null = null;
  // Рули на 3D-модели по движению: в полёте и в повторе записей без команд автопилота.
  const motion = new SurfaceMotion();
  const replayMotion = new SurfaceMotion();

  // Звук: браузер разрешает его только после щелчка или клавиши. Выключенный звук запоминается.
  const SOUND_KEY = 'vtol-sim.muted';
  const sound = new Sound();
  let mutedPref = (() => {
    try {
      return localStorage.getItem(SOUND_KEY) === '1';
    } catch {
      return false;
    }
  })();
  // Голос НСУ — отдельно от звука: выключенный звук голос не глушит. Речь приглушает звук.
  const callouts = new Callouts();
  const voice = new Voice();
  voice.onSpeaking = (on) => sound.duck(on ? 0.35 : 1);
  const wakeSound = () => {
    voice.unlock();
    void sound.resume().then(() => sound.setMuted(mutedPref));
  };
  document.addEventListener('pointerdown', wakeSound);
  document.addEventListener('keydown', wakeSound);

  // Ретрансляторы связи: района (из задания) и поставленные инструктором.
  let relays: Relay[] = [];

  // Запретные зоны и зоны РЭБ инструктора — запоминаются в браузере для района.
  const ZONES_KEY = `vtol-sim.zones.${siteA.lat.toFixed(3)},${siteA.lon.toFixed(3)}`;
  let zones: Zone[] = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(ZONES_KEY) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter(isZone) : [];
    } catch {
      return [];
    }
  })();

  // Погода: по заданию (ползунки), фактическая сейчас (Open-Meteo) или пресет.
  let weatherSource = 'scenario';
  let live: LiveWeather | null = null;
  let liveFetch: AbortController | null = null;

  // Запись полёта — с начала задания (подготовка и АРМ тоже), для разбора и оценки.
  const rec = new FlightRecorder();
  let recStartedAt = new Date().toISOString();
  // Режим: тренировка, штатный, сложный, зачёт — погода, обязательная подготовка, отказы.
  let difficultyId: DifficultyId = 'train';
  let failurePlan: FailureEvent[] = [];
  let injected: FailureEvent[] = [];
  let takeoffT = 0;
  let endT: number | null = null;
  let assessed = false;
  let lastAssessment: { rec: Recording; a: Assessment; ctx: ConclusionContext } | null = null;
  const prepNeeded = () => prepRequired || findDifficulty(difficultyId).prepRequired;
  // Разбор: пока открыт, живой полёт стоит, а 3D показывает запись в момент replayT.
  const debrief = new Debrief(app);

  // Прогноз на реальный вылет: окно, расчёт задания по часам, применённый час.
  const forecastPanel = new ForecastPanel(app, { utcOffsetH: scenario.utcOffsetH });
  let applied: { hour: ForecastHour; weather: Weather; summary: string } | null = null;
  let forecastRun: AbortController | null = null;
  forecastPanel.onRequest((r) => {
    forecastRun?.abort();
    const ctrl = new AbortController();
    forecastRun = ctrl;
    const sc = scenario;
    const s = settings;
    fetchForecast(siteA, r.from, r.hours + FORECAST_LOOKAHEAD_H, ctrl.signal)
      .then((hours) =>
        planForecastAsync(
          { scenario: sc, settings: s, terrain, relief, zones, relays, gcs: siteA, hours, window: r },
          { signal: ctrl.signal, onProgress: (d, n) => void (forecastRun === ctrl && forecastPanel.setProgress(d, n)) },
        ),
      )
      .then((plan) => {
        if (forecastRun === ctrl) forecastPanel.setResult(plan);
      })
      .catch((e: unknown) => {
        if (forecastRun !== ctrl) return;
        forecastPanel.setBusy(false);
        forecastPanel.setStatus(e instanceof Error ? e.message : String(e), 'bad');
      });
  });
  forecastPanel.onApply((h) => {
    if (started) return gcs.log(0, 'В полёте погоду не меняют — сначала «Начать заново»', 'warn');
    const a = applyForecastHour(scenario, settings, h);
    scenario = a.scenario;
    settings = a.settings;
    applied = { hour: h, weather: a.weather, summary: a.summary };
    weatherSource = 'forecast';
    gcs.setWeatherSource('forecast');
    gcs.loadScenario(scenario, settings, forecastError);
    gcs.log(0, a.summary);
    replan();
  });
  let replayT = 0;
  let pausedBeforeDebrief = false;
  debrief.onSeek = (t) => (replayT = t);
  debrief.onClose = () => (paused = pausedBeforeDebrief);
  // Бортовой журнал — на месте полёта. Внутри района — у площадки со сдвигом; иначе район строится
  // по журналу (рельеф, снимки, маршрут повтора полёта) и страница перезагружается туда.
  debrief.onImport = (files) => {
    debrief.showError(null);
    // Открытая запись — чтобы служебный журнал можно было добавить к уже открытому основному.
    openRecordingFiles(files, debrief.recording)
      .then(async (rec) => {
        const origin = rec.meta.origin;
        if (!origin) return openDebrief(rec);
        if (inBounds(ACTIVE_REGION.location.region, origin)) {
          // На месте полёта из журнала — запомнить, что открыто сейчас: после перезагрузки откроется оно.
          if (ACTIVE_REGION.id === LOG_REGION_ID) void saveLastLog(rec).catch((e: unknown) => console.warn('Журнал не сохранился в браузере:', e));
          return openDebrief(onTerrain(placeRecording(rec, siteA, terrain.elevationM(origin) - siteA.elevationM)));
        }
        if (started) {
          gcs.toast('<b>Журнал записан в другом месте</b>Показываю его у площадки. Чтобы увидеть полёт на месте, нажмите «Начать заново» и откройте журнал снова.', 'warn');
          return openDebrief(onTerrain(placeRecording(rec, siteA, 0)));
        }
        gcs.toast('<b>Переношу сцену на место полёта</b>Журнал записан вне района — загружаю рельеф и снимки там, где летал аппарат.', 'good');
        // Высоты маршрута повтора — над рельефом места полёта; без сети — над точкой взлёта.
        let ground: Terrain | undefined;
        try {
          ground = await loadTerrain(regionFromRecording(rec).location.region, 11);
        } catch (e) {
          console.warn('Рельеф места полёта не загрузился, высоты маршрута — над точкой взлёта:', e);
        }
        const region = regionFromRecording(rec, ground);
        try {
          await saveLastLog(rec);
        } catch (e) {
          console.warn('Журнал не сохранился в браузере — после перезагрузки откройте его снова:', e);
        }
        saveLogRegion(region);
        setRegion(LOG_REGION_ID);
      })
      .catch((e: unknown) => debrief.showError(e instanceof Error ? e.message : String(e)));
  };
  // Пульт (ПДУ) для «Фэйлсейфа»: геймпад, без него — клавиатура.
  const pilot = new PilotInput();

  const luxAt = (t: number) =>
    illuminanceLux(sunPosition(new Date(departure(scenario, settings).getTime() + t * 1000), siteA).elevationDeg, scenario.cloudCover);
  const airborne = () => !['ground', 'landed', 'crashed'].includes(flight.state.mode);
  const groundS = () => (scenario.kind === 'delivery' ? scenario.unloadS : 0);
  const captureContext = () => ({ site: siteA, terrain, lineLegs: mission.survey!.lineLegs, luxAt });
  const extent = (): GeoPoint[] => [
    siteA,
    ...(scenario.kind === 'survey' ? scenario.area : scenario.route),
    ...(destinationOf(scenario) ? [destinationOf(scenario)!] : []),
  ];

  const gcs = createGcs(app, SCENARIOS, {
    onScenario(id) {
      const sc = SCENARIOS.find((x) => x.id === id);
      if (sc && !started) loadScenario(sc);
    },
    onAreaDraw: () => drawSurveyArea(),
    onSettings(s) {
      // Другая система высот точек — точки остаются на тех же высотах, меняется только отсчёт.
      if (s.altitudeRef !== settings.altitudeRef && scenario.kind !== 'survey') {
        const toAbs = s.altitudeRef !== 'agl';
        scenario = {
          ...scenario,
          route: scenario.route.map((p) =>
            toAbs ? { ...p, altitudeM: Math.round(p.altitudeM ?? terrain.elevationM(p) + p.heightAglM) } : { ...p, heightAglM: Math.max(20, Math.round((p.altitudeM ?? terrain.elevationM(p) + p.heightAglM) - terrain.elevationM(p))) },
          ),
        };
      }
      settings = s;
      replan();
    },
    onForecastError(on) {
      forecastError = on;
      replan();
    },
    onNewDay() {
      daySeed++;
      replan();
    },
    onCommand: command,
    onControls(c) {
      controls = { ...controls, ...c };
    },
    onRate() {
      rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!;
    },
    onPause() {
      paused = !paused;
    },
    onRestart() {
      started = false;
      prep.reset();
      targetMode = false;
      gcs.targetMode(false);
      replan();
      gcs.log(0, 'Начинаем заново');
    },
    onClearTrail() {
      map.resetTrail();
      world.resetTrail();
    },
    onFollow(on) {
      map.follow = on;
    },
    onZoom(d) {
      map.zoom(d);
    },
    onCamera(m) {
      world.setCameraMode(m);
    },
    onQuality(q) {
      saveQuality(q);
      world.setQuality(QUALITY[q]);
    },
    onPrepStep(id) {
      const s = flight.state;
      if (s.mode !== 'ground' || s.armed) return gcs.log(s.t, 'Подготовка — на земле, до АРМ', 'warn');
      const err = prep.start(id, performance.now() / 1000);
      if (err) gcs.log(s.t, err, 'warn');
    },
    onInject(id) {
      const s = flight.state;
      flight.inject(id as FailureId);
      injected.push({ t: s.t, id });
      rec.event(s.t, `Отказ (инструктор): ${failureInfo(id as FailureId).title}`, 'bad');
    },
    onRestore(id) {
      const s = flight.state;
      if (!flight.restore(id)) return;
      // В зоне помех отказ снят, но связь или ГНСС вернутся только после выхода из неё.
      const jammed = (id === 'link' ? s.ew.linkJam : s.ew.gnssJam) >= EW_EFFECT_THRESHOLD;
      const text = `${id === 'link' ? 'Отказ связи снят' : 'Отказ ГНСС снят'}${jammed ? ' — но борт в зоне помех: восстановится после выхода из неё' : ''}`;
      gcs.log(s.t, text);
      rec.event(s.t, text, 'info');
    },
    onDifficulty(id) {
      const d = findDifficulty(id);
      difficultyId = d.id;
      // Тренировка — погода как в задании; остальные режимы задают свою.
      weatherSource = d.id === 'train' ? 'scenario' : d.weather;
      gcs.setWeatherSource(weatherSource);
      replan();
    },
    onDebrief() {
      openDebrief(lastAssessment?.rec ?? currentRecording(), lastAssessment?.a, lastAssessment?.ctx);
    },
    onWeatherSource(src) {
      weatherSource = src;
      if (src === 'live') return loadLiveWeather();
      liveFetch?.abort();
      liveFetch = null;
      if (src === 'forecast' && !applied) forecastPanel.show();
      replan();
    },
    onSound() {
      mutedPref = !mutedPref;
      void sound.resume().then(() => sound.setMuted(mutedPref));
      try {
        localStorage.setItem(SOUND_KEY, mutedPref ? '1' : '0');
      } catch {
        // Не сохранится — не страшно.
      }
      gcs.setSoundMuted(mutedPref);
    },
    onVoice(on) {
      voice.setEnabled(on);
    },
    onVoicePick(uri) {
      voice.setVoice(uri);
      voice.preview(uri);
      showVoice();
    },
    onVoicePreview() {
      voice.unlock();
      voice.preview();
    },
    onZoneTool(kind) {
      if (!kind) return map.cancelZoneDraw();
      // Запретная зона — многоугольником (как границы на картах), зона РЭБ — кругом вокруг станции помех.
      map.startZoneDraw(
        kind,
        (z) => {
          applyZones([...zones, z]);
          gcs.setZoneTool(null);
        },
        { shape: kind === 'nofly' ? 'polygon' : 'circle', onCancel: () => gcs.setZoneTool(null) },
      );
    },
    onZonesImport(text, fileName) {
      const { zones: loaded, warnings } = parseZonesFile(text);
      const ids = new Set(zones.map((z) => z.id));
      const fresh = loaded.map((z) => {
        const id = ids.has(z.id) ? makeZoneId(ids) : z.id;
        ids.add(id);
        return { ...z, id };
      });
      applyZones([...zones, ...fresh]);
      gcs.log(flight.state.t, `Зоны из «${fileName}»: ${fresh.length}${warnings.length ? ` · ${warnings.join('; ')}` : ''}`, warnings.length ? 'warn' : 'info');
    },
    onZonesExport() {
      downloadText('zones.geojson', zonesToGeoJSON(zones), 'application/geo+json');
    },
    onZonesClear() {
      applyZones([]);
    },
    onZoneDelete(id) {
      applyZones(zones.filter((z) => z.id !== id));
    },
    onRelayTool(kind) {
      if (!kind) return map.cancelRelayPlace();
      map.startRelayPlace(
        kind === 'ground' ? { kind: 'ground', antennaM: 10 } : { kind: 'air', altitudeM: siteA.elevationM + 1000 },
        (r) => {
          // Аппарат-ретранслятор — не ниже 300 м над рельефом под ним.
          applyRelays([...relays, r.kind === 'air' ? { ...r, altitudeM: Math.max(r.altitudeM, terrain.elevationM(r) + 300) } : r]);
          gcs.setRelayTool(null);
        },
        { onCancel: () => gcs.setRelayTool(null) },
      );
    },
    onRelayDelete(i) {
      applyRelays(relays.filter((_, k) => k !== i));
    },
    onPrepRequired(on) {
      prepRequired = on;
      try {
        localStorage.setItem(PREP_KEY, on ? '1' : '0');
      } catch {
        // Не сохранится — не страшно.
      }
    },
    onResize() {
      world.resize();
      map.invalidate();
    },
    onRouteEdit(points) {
      if (scenario.kind === 'survey') return;
      scenario = { ...scenario, route: points };
      if (started) replanInFlight();
      else replan();
    },
    // Другой район — другой рельеф, снимки и дома: проще и надёжнее перезагрузить страницу.
    onRegion(id) {
      if (id !== ACTIVE_REGION.id && !started) setRegion(id);
    },
    onPacks() {
      packsPanel.toggle();
    },
    onForecast() {
      if (forecastPanel.visible) forecastPanel.hide();
      else forecastPanel.show();
    },
    onReach(on) {
      reachOn = on;
      reachAt = -Infinity;
      if (on && started && airborne()) drawReachFlight();
      else drawReachPlan();
    },
  }, { regions: [...REGIONS], regionId: ACTIVE_REGION.id });

  document.title = PROFILE.title;
  const quality = QUALITY[loadQuality()];
  // Экранный пульт — поверх 3D-вида, виден в ФЭЙЛСЕЙФе.
  const rc = new RcSticks(gcs.viewEl.parentElement!);
  // Камера на подвесе: в поиске и патруле — тепловизор, в перелёте, облёте и доставке — дневная по кнопке.
  const pipEl = gcs.viewEl.parentElement!.querySelector<HTMLElement>('.pip')!;
  const gimbal = new Gimbal();
  const gwin = new GimbalWindow(pipEl, gcs.viewEl, gimbal, { onClick: (x, y, shift) => gimbalClick(x, y, shift) });
  /** Поле зрения дневной камеры подвеса без зума, °. */
  const DAY_FOV_DEG = 40;
  let gimbalLabelFrame = 0;
  const world = new World(gcs.viewEl, { terrain, site: siteA, bounds, area: [], maxImageryZoom: quality.maxImageryZoom, cloudBaseM: 1500, cloudCover: 0.3, quality });
  // По умолчанию камера за хвостом: аппарат на экране смотрит туда же, куда летит.
  world.setCameraMode('chase');

  // Видео полёта из разбора: на время записи основной цикл стоит, кадры рисует запись.
  let videoBusy = false;
  let videoDt = 0;
  let cameraBeforeVideo: CameraMode = 'chase';
  debrief.setVideoHost({
    region: ACTIVE_REGION.title,
    begin(camera) {
      videoBusy = true;
      cameraBeforeVideo = world.currentCameraMode;
      world.setCameraMode(camera);
    },
    seek(t, dt) {
      replayT = t;
      videoDt = dt;
      step(dt); // ветка повтора: Солнце, поза, винты, пыль, камера
    },
    renderFrame: (w, h) => world.renderTo(w, h, videoDt),
    busy: () => world.tilesLoading() > 0,
    end() {
      world.setCameraMode(cameraBeforeVideo);
      world.endRenderTo();
      videoBusy = false;
    },
  });
  // Модель аппарата — из профиля; ?model=… в адресе или VITE_MODEL при сборке её заменяют.
  const modelName = new URLSearchParams(location.search).get('model') ?? import.meta.env.VITE_MODEL ?? PROFILE.modelName;
  loadAircraft(`${import.meta.env.BASE_URL}models/${modelName.replace(/[^a-z0-9-]/gi, '')}.glb`)
    .then((model) => world.setAircraft(model))
    .catch((e) => console.warn('CAD-модель аппарата не загрузилась, остаётся упрощённая:', e));
  // Дома, леса и полосы из OpenStreetMap — из пакета района (работа без сети) или файл района.
  // Нет файла (место полёта из журнала вне готовых районов, район без готового файла) — собираем
  // из OpenStreetMap в браузере вдоль маршрута и района поиска и запоминаем.
  const osmRegion = ACTIVE_REGION.id === LOG_REGION_ID ? osmRegionFor(siteA) : ACTIVE_REGION;
  void (osmRegion ? osmUrlFor(osmRegion) : Promise.resolve(undefined))
    .then((url) =>
      url
        ? fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((buf) => world.setOsm(parseOsm(buf)))
        : buildPlaceOsm(),
    )
    .catch((e) => console.warn('Дома и лес не загрузились:', e));

  /** Дома, лес, дороги и вода места без готового файла — из OpenStreetMap в браузере (src/ui/placeOsm.ts). */
  function buildPlaceOsm(): Promise<void> {
    const loc = ACTIVE_REGION.location;
    const what = ACTIVE_REGION.id === LOG_REGION_ID ? 'места полёта' : 'района';
    let building = false;
    return placeOsm(
      { site: siteA, bounds: loc.region, track: [loc.site, ...(loc.search?.area ?? []), ...(loc.fire?.area ?? []), ...loc.route.route, loc.transfer.destination] },
      {
        // Прогресс приходит, только когда собираем заново; из кэша — сразу готово. Без всплывающего
        // окна — одной строкой в консоли: сборка идёт в фоне и летать не мешает.
        onProgress: () => {
          if (building) return;
          building = true;
          gcs.log(0, `Дома, лес, дороги и вода ${what} собираются из OpenStreetMap в фоне — один раз для места, дальше из памяти браузера`);
        },
      },
    )
      .then((buf) => {
        world.setOsm(parseOsm(buf));
        if (building) gcs.log(0, `Дома, лес, дороги и вода ${what} загружены из OpenStreetMap`);
      })
      .catch((e: unknown) => {
        console.warn(`Дома и лес ${what} не собрались:`, e);
        if (building) gcs.log(0, `Дома и лес не загрузились: ${e instanceof Error ? e.message : String(e)}. Снимки и рельеф — на месте; при следующем открытии попробую снова`, 'warn');
      });
  }

  const map = new Map2D(gcs.mapEl, siteA);
  map.onZoneContext = (id) => applyZones(zones.filter((z) => z.id !== id));
  map.onRelayContext = (i) => applyRelays(relays.filter((_, k) => k !== i));
  // Окно «Районы и карты»: пакеты для работы без сети.
  const packsPanel = createPacksPanel();
  map.setZones(zones);
  world.setZones(zones);
  gcs.setZones(zoneItems());
  /** Участок съёмки заново — щелчками по карте. */
  function drawSurveyArea() {
    if (scenario.kind !== 'survey') return;
    if (started) return gcs.log(flight.state.t, 'Участок меняется только до взлёта', 'warn');
    gcs.log(0, 'Участок съёмки: щелчки по карте — вершины, двойной щелчок или первая вершина — готово, Esc — отмена');
    map.startAreaDraw((area) => {
      if (scenario.kind !== 'survey' || area.length < 3) return;
      if (!area.every(inRegion)) return gcs.log(0, 'Участок выходит за загруженный рельеф — нарисуйте ближе к площадке', 'warn');
      scenario = { ...scenario, area };
      world.setArea(area);
      replan();
    });
  }

  map.onAreaChange = (area) => {
    if (started || scenario.kind !== 'survey') return;
    scenario = { ...scenario, area };
    world.setArea(area);
    replan();
  };
  map.onRouteChange = (points) => {
    if (scenario.kind === 'survey') return;
    scenario = { ...scenario, route: points };
    if (started) replanInFlight();
    else replan();
  };
  map.onDestinationChange = (p) => {
    if (scenario.kind !== 'delivery' && scenario.kind !== 'transfer') return;
    const s = flight.state;
    const keep = (text: string) => {
      map.setDestination(destinationOf(scenario));
      gcs.log(s.t, text, 'warn');
    };
    if (!inRegion(p)) return keep('Пункт Б вне загруженного рельефа');
    if (!started) {
      scenario = { ...scenario, destination: p };
      return replan();
    }
    // В полёте Б можно перенести, пока аппарат не на посадке и не летит обратно: посадочный маршрут перестраивается.
    if (stage > 0 || ['backtransition', 'descent', 'final', 'landed', 'crashed', 'falling'].includes(s.mode)) return keep('Пункт Б уже не перенести — аппарат на посадке или летит обратно');
    scenario = { ...scenario, destination: p };
    rec.event(s.t, 'Пункт Б перенесён — посадочный маршрут перестроен', 'cmd');
    gcs.log(s.t, 'Пункт Б перенесён — посадочный маршрут перестроен');
    replanInFlight();
  };
  map.onClick = (p) => {
    if (targetMode) {
      targetMode = false;
      gcs.targetMode(false);
      controls = { ...controls, target: local(p), heightAglM: Math.round(Math.max(60, flight.state.aglM) / 5) * 5 };
      gcs.setControls(controls);
      map.setTarget(p);
      const err = flight.command('guided');
      if (err) gcs.log(flight.state.t, err, 'warn');
      return;
    }
    if (scenario.kind === 'survey') return;
    if (!inRegion(p)) return gcs.log(0, 'Точка вне загруженного рельефа', 'warn');
    const last = scenario.route[scenario.route.length - 1];
    // Новая точка — на высоте последней: над рельефом — той же высоты над ним, иначе — той же над морем.
    const next: RoutePoint = { ...p, heightAglM: last?.heightAglM ?? 150 };
    if (settings.altitudeRef !== 'agl') next.altitudeM = last?.altitudeM ?? Math.round(terrain.elevationM(p) + next.heightAglM);
    scenario = { ...scenario, route: [...scenario.route, next] };
    if (started) replanInFlight();
    else replan();
  };

  function command(c: GcsCommand) {
    const s = flight.state;
    if (c === 'arm' && prep.running) return gcs.log(s.t, 'Идёт проверка подготовки — дождитесь окончания', 'warn');
    if (c === 'arm' && prepNeeded() && !prep.done) return gcs.log(s.t, 'Сначала предполётная подготовка — окно «Подготовка»', 'warn');
    if (c === 'target') {
      if (!airborne() && !targetMode) return gcs.log(s.t, 'Облёт точки — только в полёте', 'warn');
      targetMode = !targetMode;
      gcs.targetMode(targetMode);
      if (targetMode) gcs.log(s.t, 'Облёт точки: щёлкните по карте — аппарат уйдёт к ней и будет кружить (Esc — отмена)');
      return;
    }
    if (c === 'unload') {
      if (scenario.kind !== 'delivery' || stage !== 0 || s.mode !== 'landed' || !atDestination) {
        return gcs.log(s.t, 'Разгрузка — только после посадки в пункте доставки', 'warn');
      }
      if (s.armed) return gcs.log(s.t, 'Сначала ДИЗАРМ: разгружать при работающих моторах нельзя', 'warn');
      pastDistanceM += s.distanceM;
      startStage(1, s.t + scenario.unloadS, s.energyWh);
      gcs.log(flight.state.t, `Груз ${fmt(settings.cargoKg, 1)} кг снят за ${scenario.unloadS} с. Можно взлетать обратно`);
      gcs.hideToast();
      return;
    }
    if (c === 'manual') {
      controls = { ...controls, courseDeg: Math.round(s.trackDeg / 5) * 5, heightAglM: Math.round(Math.max(40, s.aglM) / 5) * 5 };
      gcs.setControls(controls);
    }
    if (c === 'arm' && s.mode === 'ground' && blocked(checks)) {
      return gcs.log(s.t, 'НЕ ГОТОВ: РЛЭ запрещает АРМ — см. предполётные проверки', 'warn');
    }
    if (c === 'takeoff' && s.mode === 'ground' && blocked(checks)) {
      return gcs.log(s.t, 'НЕ ГОТОВ: РЛЭ запрещает взлёт — см. предполётные проверки', 'warn');
    }
    const err = flight.command(c);
    if (err) return gcs.log(s.t, err, 'warn');
    if (c === 'arm' || c === 'armAir') sound.alarm('arm');
    if (c === 'disarm') sound.alarm('disarm');
    rec.event(s.t, `Команда: ${COMMAND_TITLE[c] ?? c}`, 'cmd');
    callouts.command(c, s.t);
    if (c === 'takeoff') {
      started = true;
      if (stage === 0) takeoffT = s.t;
      // В полёте закрыты все настройки, кроме точек маршрута.
      gcs.lockPlanning(true, scenario.kind !== 'survey');
      map.setEditing({ area: false, route: scenario.kind !== 'survey', destination: false });
      gcs.hideToast();
    }
  }

  function loadScenario(sc: Scenario) {
    started = false;
    prep.reset();
    scenario = cloneScenario(sc);
    settings = { ...scenario.defaults };
    if (weatherSource === 'forecast' && applied) ({ scenario, settings } = applyForecastHour(scenario, settings, applied.hour));
    relays = [...scenario.relays];
    gcs.loadScenario(scenario, settings, forecastError);
    world.setArea(scenario.kind === 'survey' || scenario.kind === 'search' || scenario.kind === 'fire' ? scenario.area : []);
    replan();
    map.setRelays(relays);
    gcs.setRelays(relayItems());
    recomputeShadow();
    map.fit(extent());
  }

  function replan() {
    if (started) return;
    forecast = forecastWeather(scenario, settings);
    if (weatherSource === 'live' && live) forecast = { ...live.weather };
    else if (weatherSource === 'forecast') {
      // Прогноз на час вылета — из окна «Прогноз вылета»; пока час не выбран — погода задания.
      if (applied) forecast = { ...applied.weather };
    } else if (weatherSource !== 'scenario' && weatherSource !== 'live') forecast = weatherPreset(weatherSource as WeatherPresetKind, forecast);
    actual = forecastError ? actualWeather(forecast, daySeed) : forecast;
    windForecast = new TerrainWind(relief, forecast, { sun: sunAt });
    windActual = new TerrainWind(relief, actual, { sun: sunAt, seed: daySeed });
    world.setWeather(actual);
    gcs.setWeatherSummary(
      weatherSource === 'scenario'
        ? ''
        : weatherSource === 'live'
          ? live
            ? `${live.summary} · ${live.attribution}`
            : 'Загружаю погоду…'
          : weatherSource === 'forecast'
            ? (applied?.summary ?? 'Выберите час в окне «Прогноз вылета»')
            : `Факт: ${weatherText(actual)}`,
    );
    try {
      mission = buildMission(scenario, settings, terrain, forecast);
    } catch (e) {
      gcs.log(0, e instanceof Error ? e.message : String(e), 'bad');
      return;
    }
    parts = mission.stages.map((p) => simulateMission(p, forecast));
    planned = combineResults(parts, groundS());
    checks = preflightChecks({ stages: mission.stages, weather: forecast, procedures: mission.procedures, cloudBaseM: scenario.cloudBaseM, terrain, gcs: siteA, zones, relays, terrainWind: windForecast ?? undefined });
    gcs.showPreflight(checks);
    drawWind();
    drawReachPlan();

    let survey: SurveyInfo | null = null;
    if (scenario.kind === 'survey' && mission.survey && mission.camera && mission.params) {
      let fr: Frame[] = [];
      try {
        fr = captureFrames(buildTimeline(mission.stages[0]!, parts[0]!), mission.camera, mission.params, captureContext());
      } catch {
        fr = [];
      }
      survey = {
        camera: mission.camera,
        plan: mission.survey,
        frames: fr,
        coverage: coverageOf(fr, scenario.area, siteA),
        minFrames: scenario.minFrames,
        minCoverage: scenario.minCoverage,
        windAtHeight: windAt(forecast, mission.survey.heightAglM),
      };
    }
    world.setWind(windAt(actual, 5).speedMs, actual.wind.fromDeg, windAt(actual, 1500).speedMs);
    drawPlan();
    gcs.showPlan({
      kind: mission.kind,
      combined: planned,
      stages: mission.stages.map((_, i) => ({ name: mission.stageNames[i]!, result: parts[i]! })),
      temperatureC: settings.temperatureC,
      survey,
      groundS: groundS(),
    });
    resetFlight();
  }

  /**
   * Маршрут изменили в полёте: пересчитать задание по тому же прогнозу, передать новый маршрут
   * автопилоту текущего полёта и оценить, хватит ли энергии от текущей точки до посадки.
   */
  function replanInFlight() {
    try {
      mission = buildMission(scenario, settings, terrain, forecast);
    } catch (e) {
      gcs.log(flight.state.t, e instanceof Error ? e.message : String(e), 'bad');
      return;
    }
    parts = mission.stages.map((p) => simulateMission(p, forecast));
    planned = combineResults(parts, groundS());
    drawPlan();
    flight.replacePlan(mission.stages[stage]!);
    callouts.setRoute(routeInfo(stage));
    updateProfile();
    const current = parts[stage]!;
    const rest = current.segments.slice(Math.max(0, flight.state.wp - 1));
    const payloadW = mission.stages[stage]!.payload?.powerW ?? 0;
    const needWh =
      rest.reduce((a, x) => a + x.energyWh + (payloadW * x.durationS) / 3600, 0) +
      current.landingPhases.reduce((a, p) => a + p.energyWh, 0) +
      parts.slice(stage + 1).reduce((a, p) => a + p.budget.totalWh, 0);
    const leftWh = flight.capacityWh - flight.state.energyWh;
    const reserveWh = flight.capacityWh - flight.usableWh;
    const short = needWh > leftWh - reserveWh;
    gcs.log(
      flight.state.t,
      `Маршрут изменён: до посадки ≈ ${fmt(needWh)} Вт·ч, в батарее ${fmt(leftWh)} Вт·ч${short ? ' — С ЗАПАСОМ НЕ ХВАТИТ' : ''}`,
      short ? 'bad' : 'info',
    );
  }

  function drawPlan() {
    const path: GeoPoint[] = [];
    mission.stages.forEach((p, i) => {
      if (i === 0) path.push(p.takeoff);
      path.push(...p.waypoints, p.landing);
    });
    const pins: Pin[] = [];
    const labels: LegLabel[] = [];
    const leg = (a: GeoPoint, b: GeoPoint) => labels.push({ position: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }, text: `${fmt(distanceM(a, b) / 1000, 1)} км` });
    if (scenario.kind === 'survey') {
      const sp = mission.survey;
      let n = 1;
      for (const k of sp ? [...sp.lineLegs].sort((a, b) => a - b) : []) {
        const a = sp!.route[k - 1];
        const b = sp!.route[k];
        if (!a || !b) continue;
        pins.push({ position: a, label: String(n++), altitudeM: sp!.heightAglM }, { position: b, label: String(n++), altitudeM: sp!.heightAglM });
        leg(a, b);
      }
    } else {
      const pts: GeoPoint[] = [siteA, ...scenario.route, destinationOf(scenario) ?? siteA];
      for (let i = 1; i < pts.length; i++) leg(pts[i - 1]!, pts[i]!);
    }
    map.setRoute(path, pins, labels);
    // Участок съёмки правится на карте; район поиска и зона патруля — только показываются.
    map.setArea(scenario.kind === 'survey' || scenario.kind === 'search' || scenario.kind === 'fire' ? scenario.area : null, scenario.kind === 'survey');
    map.setEditableRoute(scenario.kind === 'survey' ? null : scenario.route, (p) => routeAltitude().label(p));
    map.setDestination(destinationOf(scenario));
    map.setEditing({ area: !started, route: true, destination: !started });

    world.setRoute(
      mission.stages.flatMap((p) => [
        { ...local(p.takeoff), up: transitionAltitudeM(p) - siteA.elevationM },
        ...p.waypoints.map((w) => ({ ...local(w), up: w.altitudeM - siteA.elevationM })),
        { ...local(p.landing), up: backTransitionAltitudeM(p) - siteA.elevationM },
      ]),
    );
    world.setPads(mission.destination ? [local(mission.destination)] : []);
    world.setMarkers(
      scenario.kind === 'survey'
        ? []
        : scenario.route.map((p, i) => ({ ...local(p), up: pointAltitude(p) - siteA.elevationM, label: String(i + 1) })),
    );
    gcs.setRoute(scenario.kind === 'survey' ? null : scenario.route, scenario.siteName, destinationNameOf(scenario), true, routeAltitude());
  }

  /** Высота точки маршрута над морем, м: над рельефом — по рельефу, иначе — заданная. */
  function pointAltitude(p: RoutePoint): number {
    return settings.altitudeRef !== 'agl' && p.altitudeM !== undefined ? p.altitudeM : terrain.elevationM(p) + p.heightAglM;
  }

  /** Как показывать и править высоту точек в системе высот задания. */
  function routeAltitude(): RouteAltitude & { label(p: RoutePoint): string } {
    const site = siteA.elevationM;
    const ground = (p: RoutePoint) => terrain.elevationM(p);
    const withAbs = (p: RoutePoint, abs: number): RoutePoint => ({ ...p, altitudeM: abs, heightAglM: Math.max(20, Math.round(abs - ground(p))) });
    switch (settings.altitudeRef) {
      case 'msl':
        return { unit: 'м над морем', min: -100, max: 8000, value: pointAltitude, apply: withAbs, label: (p) => `${Math.round(pointAltitude(p))} м абс.` };
      case 'takeoff':
        return {
          unit: 'м от точки взлёта',
          min: -2000,
          max: 5000,
          value: (p) => pointAltitude(p) - site,
          apply: (p, v) => withAbs(p, v + site),
          label: (p) => `${pointAltitude(p) - site >= 0 ? '+' : '−'}${Math.abs(Math.round(pointAltitude(p) - site))} м`,
        };
      default:
        return { unit: 'м над рельефом', min: 20, max: 3000, value: (p) => p.heightAglM, apply: (p, v) => ({ ...p, heightAglM: v }), label: (p) => `${Math.round(p.heightAglM)} м` };
    }
  }

  function startStage(i: number, t0: number, e0: number) {
    stage = i;
    stageLanded = false;
    atDestination = false;
    fallS = 0;
    eventsShown = 0;
    envShown = 0;
    flight = new LiveFlight({
      plan: mission.stages[i]!,
      terrain,
      weather: actual,
      origin: siteA,
      home: siteA,
      // Заданный курс захода — и для ВОЗВРАТА, если задание и так садится дома.
      ...(settings.approachDeg != null && distanceM(mission.stages[mission.stages.length - 1]!.landing, siteA) < 50 ? { homeApproachDeg: settings.approachDeg } : {}),
      startT: t0,
      initialEnergyWh: e0,
      // Порывы — свои для дня и полёта; термики — от Солнца над склонами.
      seed: daySeed * 100 + i + 1,
      sun: (t) => sunPosition(new Date(departure(scenario, settings).getTime() + t * 1000), siteA),
      zones,
      gcs: siteA,
      relays,
      terrainWind: windActual ?? undefined,
      linkLoss: { action: settings.linkLossAction, timeoutS: settings.linkLossTimeoutS },
    });
    trigger = mission.survey && mission.camera && mission.params ? new FrameTrigger(mission.camera, mission.params, captureContext()) : null;
    callouts.setRoute(routeInfo(i));
    updateProfile();
  }

  /** Точки и галсы для голоса; обратный полёт доставки идёт по маршруту задом наперёд. */
  function routeInfo(i: number): RouteInfo {
    if (scenario.kind === 'survey') return { lineLegs: mission.survey?.lineLegs ?? [] };
    return { points: scenario.route.length, reversed: scenario.kind === 'delivery' && i === 1 };
  }

  /** Профиль рельефа и плановой высоты вдоль маршрута текущего полёта. */
  function updateProfile() {
    const pts = flight.path;
    const dist = [0];
    for (let k = 1; k < pts.length; k++) dist.push(dist[k - 1]! + Math.hypot(pts[k]!.east - pts[k - 1]!.east, pts[k]!.north - pts[k - 1]!.north));
    profile = {
      dist,
      terrain: pts.map((p) => terrain.elevationM(fromLocal(siteA, p.east, p.north))),
      plan: pts.map((p) => p.up + siteA.elevationM),
      // Связь вдоль маршрута: цвет плановой линии и «связь с НСУ выше» пунктиром.
      ...linkProfile(flight.radioNetwork, pts.map((p) => ({ ...fromLocal(siteA, p.east, p.north), altitudeM: p.up + siteA.elevationM })), { maxPoints: 80 }),
    };
    gcs.profile(profile, null);
  }

  // Поиск людей тепловизором: люди и звери, окно тепловизора, отметки (src/ui/searchMode.ts).
  let searchMode: SearchMode | null = null;
  // Лесопожарный патруль: пожары, дымы, отметки и донесения (src/ui/fireMode.ts).
  let fireMode: FireMode | null = null;
  /** Ветер на высоте над землёй: куда дует, м/с — для дыма и его сноса. */
  const windTo = (heightAglM: number) => {
    const w = windAt(actual, heightAglM);
    const to = ((w.fromDeg + 180) * Math.PI) / 180;
    return { east: Math.sin(to) * w.speedMs, north: Math.cos(to) * w.speedMs };
  };

  function resetFlight() {
    rec.reset();
    recStartedAt = new Date().toISOString();
    assessed = false;
    endT = null;
    injected = [];
    lastAssessment = null;
    // Отказы разыгрываются заново на каждую попытку — зачёт не выучить наизусть.
    failurePlan = planFailures(findDifficulty(difficultyId), Math.floor(Math.random() * 2 ** 31), planned.durationS);
    frames = [];
    // Подвес — к началу задания: в поиске и патруле тепловизор под наклоном задания, иначе — вперёд-вниз.
    const thermal = scenario.kind === 'search' || scenario.kind === 'fire';
    gimbal.reset(scenario.kind === 'search' || scenario.kind === 'fire' ? scenario.tiltDeg : 25);
    gwin.configure({ ir: thermal, marks: thermal, launcher: !thermal && scenario.kind !== 'survey' });
    // Люди и звери — заново на каждую попытку, как отказы.
    searchMode?.dispose();
    searchMode =
      scenario.kind === 'search'
        ? new SearchMode(
            scenario,
            {
              world,
              map,
              site: siteA,
              terrain,
              pipEl,
              gimbal,
              onMark: (m, reveal) => {
                const t = flight.state.t;
                rec.event(t, `Отметка: ${m.text}`, m.result === 'found' ? 'info' : 'warn');
                gcs.log(t, reveal ? m.text : 'Отметка поставлена — что под ней, покажет разбор', reveal && m.result !== 'found' ? 'warn' : 'info');
                sound.alarm(reveal && m.result === 'found' ? 'prepStep' : 'shutter');
              },
            },
            { difficulty: difficultyId, seed: Math.floor(Math.random() * 2 ** 31) },
          )
        : null;
    // Пожары — тоже заново на каждую попытку.
    fireMode?.dispose();
    fireMode =
      scenario.kind === 'fire'
        ? new FireMode(
            scenario,
            {
              world,
              map,
              site: siteA,
              pipEl,
              gimbal,
              viewEl: gcs.viewEl,
              windAt: windTo,
              onMark: (m, reveal) => {
                const t = flight.state.t;
                const good = m.result === 'found' || m.result === 'located';
                rec.event(t, `Отметка: ${m.text}`, good ? 'info' : 'warn');
                gcs.log(t, reveal ? m.text : 'Отметка поставлена — что под ней, покажет разбор', reveal && !good ? 'warn' : 'info');
                sound.alarm(reveal && good ? 'prepStep' : 'shutter');
              },
              onReport: (r, reveal) => {
                const t = flight.state.t;
                const good = r.result === 'reported';
                rec.event(t, `Донесение: ${r.text}`, good ? 'info' : 'warn');
                gcs.log(t, reveal ? r.text : 'Донесение отправлено — разбор покажет, был ли там дым', reveal && !good ? 'warn' : 'info');
                sound.alarm(reveal && good ? 'prepStep' : 'shutter');
              },
            },
            { difficulty: difficultyId, seed: Math.floor(Math.random() * 2 ** 31), wind: windAt(actual, 10) },
          )
        : null;
    announced = false;
    pastDistanceM = 0;
    lastTrailT = -Infinity;
    callouts.reset();
    voice.clear();
    startStage(0, 0, 0);
    controls = {
      iasMs: settings.iasMs,
      heightAglM: mission.survey ? Math.round(mission.survey.heightAglM / 5) * 5 : 150,
      courseDeg: 0,
      target: null,
    };
    gcs.setControls(controls);
    gcs.lockPlanning(false);
    gcs.hideToast();
    map.clearFrames();
    map.resetTrail();
    map.setTarget(null);
    map.setCoverage(null);
    map.setEditing(true);
    world.resetFrames();
    world.resetTrail();
    world.setCoverage(null);
    gcs.log(0, `«${scenario.title}»: ${fmt(planned.distanceM / 1000, 1)} км, по прогнозу остаток ${Number.isFinite(planned.socAtLanding) ? fmt(planned.socAtLanding * 100) : '—'} %`);
  }

  function announce() {
    if (announced) return;
    announced = true;
    const s = flight.state;
    const underReserve = s.energyWh > flight.usableWh ? ' — ниже аварийного запаса' : '';
    const atLanding = Math.hypot(s.east - flight.landing.east, s.north - flight.landing.north) < 30;
    const km = fmt((pastDistanceM + s.distanceM) / 1000, 1);
    const note = forecastError
      ? `<small>Факт: ветер на 10 м ${fmtWind(actual.wind)}, ${fmt(actual.groundTemperatureC, 1)} °C (прогноз ${fmtWind(forecast.wind)}). По прогнозу остаток был ${fmt(planned.socAtLanding * 100)} %.</small>`
      : '';
    let coverageText = '';
    if (scenario.kind === 'survey') {
      const cov = coverageOf(frames, scenario.area, siteA);
      map.setCoverage(cov, siteA);
      world.setCoverage(cov);
      const ok = frames.filter((f) => f.ok).length;
      const blur = frames.filter((f) => f.reason?.includes('смаз')).length;
      const dark = frames.filter((f) => f.reason?.includes('недодержка')).length;
      coverageText = ` Кадров ${frames.length}, годных ${ok}${blur ? `, смаз ${blur}` : ''}${dark ? `, недодержка ${dark}` : ''}. ≥ ${scenario.minFrames} кадров на ${fmt(cov.atLeast5 * 100)} % участка.`;
      if (s.mode !== 'crashed') {
        const done = cov.atLeast5 >= scenario.minCoverage;
        return gcs.toast(
          `<b>${done ? 'Съёмка выполнена' : 'Посадка — съёмка не полная'}</b>Остаток ${fmt(s.soc * 100)} %${underReserve}, время ${fmtTime(s.t)}, ${km} км.${coverageText}${note}`,
          done && !underReserve ? 'good' : 'warn',
        );
      }
    }
    if (s.mode === 'crashed') {
      return gcs.toast(`<b>Авария: ${s.reason}</b>Время ${fmtTime(s.t)}, пройдено ${km} км.${coverageText}${note}`, 'bad');
    }
    if (scenario.kind === 'transfer') {
      const title = atLanding ? `Перелёт выполнен: посадка — ${scenario.destinationName}` : 'Посадка не в пункте Б';
      return gcs.toast(`<b>${title}</b>Остаток ${fmt(s.soc * 100)} %${underReserve}, время ${fmtTime(s.t)}, ${km} км.${note}`, atLanding && !underReserve ? 'good' : 'warn');
    }
    if (scenario.kind === 'delivery') {
      const delivered = stage >= 1;
      const title = delivered ? (atLanding ? 'Груз доставлен, борт на аэродроме' : 'Груз доставлен, посадка вне аэродрома') : 'Посадка не в пункте доставки — груз не доставлен';
      return gcs.toast(`<b>${title}</b>Остаток ${fmt(s.soc * 100)} %${underReserve}, время ${fmtTime(s.t)}, ${km} км.${note}`, delivered && atLanding && !underReserve ? 'good' : 'warn');
    }
    gcs.toast(
      `<b>${atLanding ? 'Маршрут пройден' : 'Посадка вне аэродрома'}</b>Остаток ${fmt(s.soc * 100)} %${underReserve}, время ${fmtTime(s.t)}, ${km} км.${note}`,
      atLanding && !underReserve ? 'good' : 'warn',
    );
  }

  let hudTimer = 0;
  let pip: { eye: { east: number; north: number; up: number }; look: { east: number; north: number; up: number }; up: THREE.Vector3 } | null = null;

  /** Итог шага подготовки: что показала проверка. Миссия, ориентация и опрос зависят от обстановки. */
  /** Ретрансляторы поменялись: полёт, карта, список, радиотень, график связи и предполётные проверки. */
  function applyRelays(r: Relay[]) {
    relays = r;
    flight.setRelays(r);
    map.setRelays(r);
    gcs.setRelays(relayItems());
    recomputeShadow();
    updateProfile();
    replan();
  }

  function relayItems() {
    return relays.map((r) => ({
      title: r.name ?? (r.kind === 'air' ? 'аппарат-ретранслятор' : 'мачта'),
      detail: r.kind === 'air' ? `аппарат на ${fmt(r.altitudeM)} м над морем` : `мачта ${fmt(r.antennaM ?? 10)} м`,
    }));
  }

  // Досягаемость: куда долетит и вернётся. На планировании — от площадки с полной АКБ,
  // в полёте — от борта по телеметрии, раз в 5 с реального времени.
  let reachOn = false;
  let reachAt = -Infinity;
  const cruiseAgl = () => (mission.survey ? mission.survey.heightAglM : scenario.kind === 'survey' ? 150 : (scenario.route[0]?.heightAglM ?? 150));

  function drawReachPlan() {
    if (!reachOn) return map.setReach(null);
    const o: ReachOptions = { weather: forecast, terrain, iasMs: settings.iasMs, payload: mission.stages[0]!.payload, cruiseHeightAglM: cruiseAgl() };
    map.setReach(planReach(siteA, { ...o, usableWh: planned.usableWh }));
  }

  function drawReachFlight() {
    const tele = flight.telemetry;
    // Ветер — измеренный у борта; энергия — сверх резерва АКБ.
    const weather = tele.aglM > 20 ? weatherWithMeasuredWind(forecast, tele.wind, tele.aglM) : forecast;
    const o: ReachOptions = { weather, terrain, iasMs: controls.iasMs, payload: mission.stages[stage]!.payload, cruiseHeightAglM: cruiseAgl() };
    const pos = { ...fromLocal(siteA, tele.east, tele.north), altitudeM: tele.up + siteA.elevationM };
    const energyWh = flight.usableWh - tele.energyWh;
    map.setReach(reachFrom(pos, energyWh, siteA, o), undefined, pointOfNoReturn(pos, tele.trackDeg, energyWh, siteA, o));
  }

  /** Поле ветра на карте на плановой высоте и опасность у площадок — по прогнозу. */
  function drawWind() {
    if (!windForecast?.active) return map.setWindField(null);
    const heightAglM = mission.survey ? mission.survey.heightAglM : scenario.kind === 'survey' ? 150 : (scenario.route[0]?.heightAglM ?? 150);
    const sites: WindSiteMark[] = [];
    mission.stages.forEach((st, i) => {
      for (const [p, name] of [
        [st.takeoff, 'Взлёт'],
        [st.landing, 'Посадка'],
      ] as const) {
        if (sites.some((x) => distanceM(x.position, p) < 50)) continue;
        sites.push({ position: p, label: mission.stages.length > 1 ? `${name} (полёт ${i + 1})` : name, hazard: windForecast!.windHazardAtPoint(p) });
      }
    });
    map.setWindField(windForecast.fieldGrid(heightAglM, 0, 400), siteA, sites);
  }

  /** Радиотень на карте — на плановой высоте над рельефом; считается порциями, чтобы не подвешивать интерфейс. */
  let shadowJob = 0;
  function recomputeShadow() {
    const job = ++shadowJob;
    const heightAglM = mission.survey ? mission.survey.heightAglM : scenario.kind === 'survey' ? 150 : (scenario.route[0]?.heightAglM ?? 150);
    const a = toLocal(siteA, { lat: bounds.south, lon: bounds.west });
    const b = toLocal(siteA, { lat: bounds.north, lon: bounds.east });
    const steps = coverageSteps(terrain, flight.gcsAntenna, { origin: siteA, e0: a.east, n0: a.north, e1: b.east, n1: b.north, heightAglM, cellM: 250, relays, gcsJamDb: flight.radioNetwork.gcsJamDb });
    const tick = () => {
      if (job !== shadowJob) return;
      const t0 = performance.now();
      let r = steps.next();
      while (!r.done && performance.now() - t0 < 8) r = steps.next();
      if (r.done) map.setRadioShadow(r.value, siteA);
      else setTimeout(tick, 0);
    };
    tick();
  }

  /** Зоны поменялись: полёт, карта, 3D, список, предполётные проверки и память браузера. */
  function applyZones(z: Zone[]) {
    zones = z;
    try {
      localStorage.setItem(ZONES_KEY, JSON.stringify(z));
    } catch {
      // Не сохранится — не страшно.
    }
    flight.setZones(z);
    map.setZones(z);
    world.setZones(z);
    gcs.setZones(zoneItems());
    replan();
  }

  function zoneItems() {
    return zones.map((z) => {
      const size = z.radiusM !== undefined ? `радиус ${fmt(z.radiusM / 1000, 1)} км` : `${z.polygon?.length ?? 0} вершин`;
      const height = z.floorM !== undefined || z.ceilingM !== undefined ? ` · ${fmt(z.floorM ?? 0)}–${z.ceilingM !== undefined ? fmt(z.ceilingM) : '∞'} м` : '';
      return { id: z.id, kind: z.kind, title: zoneLabel(z), detail: size + height };
    });
  }

  function downloadText(fileName: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Запись текущего полёта как есть — для разбора в любой момент. */
  function currentRecording(): Recording {
    return rec.toRecording({
      title: scenario.title,
      scenarioId: scenario.id,
      startedAt: recStartedAt,
      profileTitle: PROFILE.title,
      source: 'sim',
      landing: { east: flight.landing.east, north: flight.landing.north },
      difficulty: difficultyId,
      zones,
    });
  }

  /** Оценка полёта по окончании задания: сохраняется в итогах и открывается в разборе. */
  function showAssessment() {
    const s = flight.state;
    rec.sample(s);
    const r = currentRecording();
    const a = assessFlight({
      rec: r,
      scenarioKind: scenario.kind,
      landing: { east: flight.landing.east, north: flight.landing.north },
      landingZoneRadiusM: AIRCRAFT.limits.landingZoneRadiusM,
      usableWh: flight.usableWh,
      capacityWh: flight.capacityWh,
      plannedWh: planned.budget.totalWh,
      plannedS: planned.durationS,
      prepRequired: prepNeeded(),
      prepDone: prep.done,
      failures: injected,
      surveyCoverage: scenario.kind === 'survey' ? coverageOf(frames, scenario.area, siteA).atLeast5 : undefined,
      search: searchMode ? searchMode.result(takeoffT) : undefined,
      fire: fireMode ? fireMode.result(takeoffT) : undefined,
      delivered: scenario.kind === 'delivery' ? stage >= 1 : undefined,
      zones,
    });
    const ctx: ConclusionContext = { plannedWh: planned.budget.totalWh, usableWh: flight.usableWh, capacityWh: flight.capacityWh };
    lastAssessment = { rec: r, a, ctx };
    // Итоги — по району и заданию; у домашнего района прежние id, чтобы история не потерялась.
    const home = ACTIVE_REGION.id === 'home';
    saveResult({
      at: recStartedAt,
      scenarioId: home ? scenario.id : `${ACTIVE_REGION.id}:${scenario.id}`,
      scenarioTitle: home ? scenario.title : `${scenario.title} · ${ACTIVE_REGION.title}`,
      difficulty: difficultyId,
      total: a.total,
      grade: a.grade,
      durationS: s.t,
    });
    gcs.log(s.t, `Оценка: ${a.total} из 100 — ${a.grade}`, a.total >= 60 ? 'info' : 'warn');
    openDebrief(r, a, ctx);
  }

  function openDebrief(r: Recording, a?: Assessment, ctx?: ConclusionContext) {
    if (!debrief.visible) pausedBeforeDebrief = paused;
    paused = true;
    debrief.show(r, a, ctx);
  }

  /** Коротко о погоде: ветер, порывы, видимость, осадки, облака, температура. */
  function weatherText(w: Weather): string {
    const parts = [`ветер ${fmt(w.wind.speedMs, 1)} м/с с ${Math.round(w.wind.fromDeg)}°`];
    if (w.gustMs !== undefined) parts.push(`порывы ${fmt(w.gustMs, 1)} м/с`);
    if (w.visibilityM !== undefined) parts.push(`видимость ${w.visibilityM < 1000 ? `${fmt(w.visibilityM)} м` : `${fmt(w.visibilityM / 1000, 1)} км`}`);
    if (w.precipitation) parts.push(`${PRECIPITATION_NAME[w.precipitation.kind]} ${fmt(w.precipitation.mmPerH, 1)} мм/ч`);
    if (w.cloudBaseM !== undefined && (w.cloudCover ?? 0) >= 0.5) parts.push(`облака от ${fmt(w.cloudBaseM)} м`);
    parts.push(`${fmt(w.groundTemperatureC)} °C`);
    return parts.join(', ');
  }

  /** Фактическая погода сейчас на площадке (Open-Meteo); время вылета и Солнце — тоже как сейчас. */
  function loadLiveWeather() {
    liveFetch?.abort();
    const ctrl = new AbortController();
    liveFetch = ctrl;
    gcs.setWeatherSummary('Загружаю погоду с Open-Meteo…');
    fetchLiveWeather(siteA, new Date(), ctrl.signal)
      .then((lw) => {
        if (liveFetch !== ctrl || weatherSource !== 'live') return;
        live = lw;
        const local = new Date(Date.now() + scenario.utcOffsetH * 3_600_000);
        scenario = { ...scenario, date: local.toISOString().slice(0, 10) };
        settings = { ...settings, localHour: Math.round((local.getUTCHours() + local.getUTCMinutes() / 60) * 4) / 4 };
        gcs.log(0, `Погода сейчас: ${lw.summary}`);
        replan();
      })
      .catch((e: unknown) => {
        if (liveFetch !== ctrl) return;
        const text = e instanceof Error ? e.message : String(e);
        gcs.setWeatherSummary(text);
        gcs.log(0, text, 'warn');
      });
  }

  // Звук каждый кадр: роторы (на проверке — по одному), маршевый, обтекание, где аппарат относительно камеры.
  const soundState: SoundState = { rotors: [0, 0, 0, 0], pusher: 0, tasMs: 0, gustMs: 0, listenerDistanceM: 10, listenerBearingDeg: 0, armed: false };
  const toAircraft = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  /** Голос НСУ: на паузе и в разборе молчит, при большом ускорении — только критическое. */
  function updateVoice() {
    const s = flight.state;
    const replay = debrief.visible;
    voice.setSuspended(paused || replay);
    voice.say(callouts.update(s.t, flight.telemetry, { paused, replay, rate: s.mode === 'failsafe' ? 1 : rate, rcInRange: flight.rcInRange() }));
    voice.update();
  }

  function updateSound(dt: number) {
    const s = flight.state;
    for (let i = 0; i < 4; i++) soundState.rotors[i] = paused ? 0 : lastTest ? lastTest.rotors[i]! : s.lift;
    soundState.pusher = paused ? 0 : lastTest ? lastTest.pusher : s.pusher;
    soundState.tasMs = paused ? 0 : s.tasMs;
    soundState.gustMs = (s as { gustMs?: number }).gustMs ?? 0;
    const cam = world.camera;
    toAircraft.subVectors(world.aircraft.group.position, cam.position);
    soundState.listenerDistanceM = toAircraft.length();
    cam.getWorldDirection(camForward);
    camRight.crossVectors(camForward, WORLD_UP);
    soundState.listenerBearingDeg = (Math.atan2(toAircraft.dot(camRight), toAircraft.dot(camForward)) * 180) / Math.PI;
    soundState.armed = s.armed;
    sound.update(dt, soundState);
  }

  function evaluatePrep(id: PrepStepId): { ok: boolean; text: string } {
    switch (id) {
      case 'power':
        return { ok: true, text: 'Автопилот загружен, БАНО горят' };
      case 'link':
        return { ok: true, text: 'Связь есть; крен, тангаж и координаты в норме' };
      case 'servos':
        return { ok: true, text: 'Элероны и рули V-оперения ходят в обе стороны без заеданий' };
      case 'airdata':
        return { ok: true, text: 'Приборная растёт при обдуве ПВД и возвращается к нулю' };
      case 'vtol':
        return { ok: true, text: 'Роторы 1–4 раскручиваются, каждый в свою сторону' };
      case 'lights':
        return { ok: true, text: 'Огни и строб работают' };
      case 'pusher':
        return { ok: true, text: 'Маршевый раскручивается и останавливается' };
      case 'mission': {
        const points = mission.stages.reduce((n, p) => n + p.waypoints.length, 0);
        return { ok: true, text: `Миссия принята бортом: ${points} точек, посадочная точка есть` };
      }
      case 'heading': {
        const w = windAt(actual, 10);
        if (w.speedMs < 1) return { ok: true, text: 'Штиль — нос на первую точку маршрута' };
        flight.setGroundHeading(w.fromDeg);
        return { ok: true, text: `Нос на ${fmt(w.fromDeg)}° — против ветра` };
      }
      case 'rc':
        return { ok: true, text: 'Пульт в автоматическом режиме' };
      case 'poll': {
        const bad = checks.find((c) => !c.ok && c.level === 'block');
        return bad ? { ok: false, text: `Не готов: ${bad.text}` } : { ok: true, text: 'Чек-лист выполнен — можно АРМ' };
      }
    }
  }

  function step(dt: number) {
    const s = flight.state;
    // Разбор открыт — 3D показывает запись, живой полёт стоит.
    const replayRec = debrief.visible ? debrief.recording : null;
    if (replayRec) {
      const smp = stateAt(replayRec, replayT);
      const pose = poseOf(smp);
      // Солнце — на время полёта: у журнала — от включения автопилота, у записи симулятора — от вылета задания.
      const logStart = replayRec.meta.source === 'log' ? Date.parse(replayRec.meta.startedAt) : NaN;
      const t0 = Number.isNaN(logStart) ? departure(scenario, settings).getTime() : logStart;
      world.setSun(sunPosition(new Date(t0 + smp.t * 1000), siteA));
      if (smp.mode === 'ground' || smp.mode === 'spool' || smp.mode === 'landed') standOnSlope(pose);
      world.setPose(pose);
      // Рули: у журнала — команды автопилота, у записи симулятора — по движению.
      const surfaces =
        smp.ailL !== undefined && smp.ailR !== undefined && smp.tailL !== undefined && smp.tailR !== undefined
          ? { ailL: smp.ailL, ailR: smp.ailR, tailL: smp.tailL, tailR: smp.tailR }
          : replayMotion.update(smp.t, smp.bankDeg, smp.pitchDeg, ['transition', 'auto', 'guided', 'manual', 'hold', 'rtl', 'backtransition', 'falling'].includes(smp.mode));
      world.aircraft.setLights(true);
      world.aircraft.animate(dt, smp.lift, smp.pusher, null, surfaces);
      world.aircraft.setLandingLight(0);
      world.updateDust(dt, pose.position, smp.lift * Math.max(0, 1 - smp.aglM / 12));
      world.updateCamera(dt, pose);
      return;
    }
    world.setSun(sunPosition(new Date(departure(scenario, settings).getTime() + s.t * 1000), siteA));
    // «Фэйлсейф» — ручное управление с ПДУ: стик каждый кадр, время без ускорения.
    const manual = flight.state.mode === 'failsafe';
    pilot.enableKeyboard(manual);
    rc.show(manual);
    const stick = manual ? rc.merge(pilot.poll()) : null;
    if (stick) rc.display(stick);
    controls = { ...controls, stick };
    if (!paused) {
      flight.step(dt * (manual ? 1 : rate), controls, (st) => {
        if (!trigger) return;
        const f = trigger.offer(
          { t: st.t, position: { east: st.east, north: st.north, up: st.up }, groundSpeedMs: st.groundSpeedMs, headingDeg: st.headingDeg, trackDeg: st.trackDeg },
          st.mode === 'auto' ? st.routeLeg : null,
          st.distanceM,
        );
        if (f) {
          frames.push(f);
          map.addFrame(f, siteA);
          world.addFrame(f);
          gcs.flash();
          sound.alarm('shutter');
        }
      });
    }
    for (; eventsShown < flight.events.length; eventsShown++) {
      const e = flight.events[eventsShown]!;
      gcs.log(e.t, e.text, e.text.startsWith('АВАРИЯ') ? 'bad' : 'info');
      if (e.text.startsWith('АВАРИЯ')) sound.alarm('crash');
      else if (e.text.startsWith('ОТКАЗ')) sound.alarm('failure');
      rec.event(e.t, e.text, eventKindOf(e.text));
    }
    for (; envShown < flight.envEvents.length; envShown++) {
      const e = flight.envEvents[envShown]!;
      rec.event(e.t, e.text, eventKindOf(e.text));
    }
    if (!paused) rec.sample(flight.state);

    // Зачётные отказы — по плану от взлёта, только в воздухе.
    if (started && injected.length < failurePlan.length && airborne()) {
      const f = failurePlan[injected.length]!;
      if (s.t - takeoffT >= f.t) {
        flight.inject(f.id as FailureId);
        injected.push({ t: s.t, id: f.id });
        rec.event(s.t, `Отказ: ${FAILURE_TITLES[f.id] ?? f.id}`, 'bad');
      }
    }

    // Конец задания: авария — сразу; посадка — после ДИЗАРМ (по РЛЭ) или через минуту.
    const finished = s.mode === 'crashed' || (s.mode === 'landed' && stage === mission.stages.length - 1);
    if (started && finished && !assessed) {
      endT ??= s.t;
      if (s.mode === 'crashed' || !s.armed || s.t - endT > 60) {
        assessed = true;
        showAssessment();
      }
    }

    const plane = ['transition', 'auto', 'guided', 'manual', 'rtl', 'backtransition', 'falling'].includes(s.mode) || (s.mode === 'failsafe' && s.failsafePhase === 'plane');
    const pose = {
      position: { east: s.east, north: s.north, up: s.up },
      headingDeg: s.headingDeg,
      // Тангаж — из физики: на крыле — наклон траектории и угол атаки, на роторах — наклон коптера.
      pitchDeg: s.pitchDeg,
      bankDeg: s.bankDeg,
    };
    if (s.mode === 'crashed') {
      // Двигатели встали — аппарат падает.
      fallS += dt;
      const floor = world.groundAt(s.east, s.north);
      pose.position.up = Math.max(floor, s.up - 0.5 * 9.81 * fallS * fallS);
      pose.pitchDeg = pose.position.up > floor ? -35 : -8;
    }
    if (s.mode === 'ground' || s.mode === 'spool' || s.mode === 'landed') standOnSlope(pose);
    world.setPose(pose);
    // Поиск: люди и звери идут по времени полёта, тепловизор смотрит из-под фюзеляжа.
    if (searchMode) {
      searchMode.setTime(s.t);
      searchMode.update(paused ? 0 : dt * (manual ? 1 : rate), s, airborne());
    }
    // Патруль: пожары растут, дым идёт по ветру, тепловизор смотрит из-под фюзеляжа.
    if (fireMode) {
      fireMode.setTime(s.t);
      fireMode.update(paused ? 0 : dt * (manual ? 1 : rate), paused ? 0 : dt, s, airborne());
    }
    // Предполётная подготовка: проверки на земле видны на модели; разворот носом против ветра — плавно.
    const test = s.mode === 'ground' && !s.armed ? prep.update(performance.now() / 1000, evaluatePrep) : null;
    if (test && test.turnToWind !== null) {
      const w = windAt(actual, 10);
      const d = ((((w.fromDeg - s.headingDeg + 180) % 360) + 360) % 360) - 180;
      if (w.speedMs >= 1) flight.setGroundHeading(s.headingDeg + Math.max(-60 * dt, Math.min(60 * dt, d)));
    }
    // БАНО — только при поданном питании: после шага «Подать питание», заармленный или в полёте.
    world.aircraft.setLights(prep.powered || s.armed || s.mode !== 'ground');
    // Рули: в самолётном режиме — по движению, на висении и на земле — в нейтрали.
    const surfaces = motion.update(s.t, pose.bankDeg, pose.pitchDeg, plane && s.mode !== 'falling');
    world.aircraft.animate(dt, s.lift, s.pusher, prep.running ? test : null, surfaces);
    // Посадочная фара — ночью на взлёте, заходе, посадке и низко над землёй.
    const lowOrVertical = ['spool', 'climb', 'transition', 'backtransition', 'descent', 'final'].includes(s.mode) || s.failsafePhase === 'copter' || (s.armed && s.aglM < 150);
    world.aircraft.setLandingLight(lowOrVertical ? Math.min(1, world.nightFactor * 1.4) : 0);
    const live =
      test && prep.running === 'airdata'
        ? `ПВД: приборная ${fmt(test.airspeedMs, 1)} м/с`
        : test && prep.running === 'vtol'
          ? `Ротор ${test.rotors.findIndex((v) => v > 0.02) + 1 || '…'}`
          : null;
    const view = `${prep.running}|${PREP_STEPS.map((x) => prep.status[x.id]).join()}|${live}|${prepNeeded()}|${s.mode}|${s.armed}`;
    lastTest = prep.running ? test : null;
    const prepDone = PREP_STEPS.filter((x) => prep.status[x.id] === 'done').length;
    if (prepDone > prepDoneCount) sound.alarm('prepStep');
    prepDoneCount = prepDone;
    sound.setLoop('lowBattery', airborne() && s.soc < 0.25);
    sound.setLoop('failure', ((s as { failures?: unknown[] }).failures?.length ?? 0) > 0);
    if (view !== prepView) {
      prepView = view;
      gcs.showPreparation(prep, prepNeeded(), live);
    }
    world.updateDust(dt, pose.position, s.lift * Math.max(0, 1 - s.aglM / 12));
    world.updateCamera(dt, pose);

    if (s.t - lastTrailT > 1 && airborne()) {
      lastTrailT = s.t;
      world.appendTrail(pose.position);
      map.appendTrail(fromLocal(siteA, s.east, s.north));
    }

    if (trigger && plane) {
      const h = (s.headingDeg * Math.PI) / 180;
      const eye = { east: s.east, north: s.north, up: s.up - 0.5 };
      pip = { eye, look: { ...eye, up: eye.up - 10 }, up: new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)) };
    } else pip = null;

    if (s.mode === 'landed' && !stageLanded) {
      stageLanded = true;
      const last = stage === mission.stages.length - 1;
      const d = Math.hypot(s.east - flight.landing.east, s.north - flight.landing.north);
      if (!last && d < 30 && scenario.kind === 'delivery') {
        atDestination = true;
        gcs.toast(
          `<b>Посадка: ${scenario.destinationName}</b>Израсходовано ${fmt(s.energyWh)} Вт·ч, заряд ${fmt(s.soc * 100)} %. Задизармьте, нажмите «Разгрузка», затем АРМ и «Взлёт».`,
          'good',
        );
      } else announce();
    }
    if (s.mode === 'crashed') announce();

    hudTimer += dt;
    if (hudTimer > 0.1) {
      hudTimer = 0;
      if (reachOn && airborne() && performance.now() - reachAt > 5000) {
        reachAt = performance.now();
        drawReachFlight();
      }
      // Вектор путевой скорости на 30 с вперёд: нос по курсу, линия — куда реально летит.
      // НСУ видит телеметрию: при отказе ГНСС — оценку места, без связи — последний принятый кадр.
      const tele = flight.telemetry;
      const ahead = tele.groundSpeedMs * 30;
      const tr = (tele.trackDeg * Math.PI) / 180;
      map.setAircraft(
        fromLocal(siteA, tele.east, tele.north),
        tele.headingDeg,
        airborne() && tele.groundSpeedMs > 3 ? fromLocal(siteA, tele.east + Math.sin(tr) * ahead, tele.north + Math.cos(tr) * ahead) : undefined,
      );
      const alerts: Alert[] = [];
      if (s.linkLost) alerts.push({ level: 'bad', text: `НЕТ СВЯЗИ с бортом ${fmtTime(s.t - tele.t)} — ${linkLossText(settings.linkLossAction, settings.linkLossTimeoutS)}` });
      for (const id of s.failures) {
        const f = failureInfo(id);
        alerts.push({ level: 'bad', text: `ОТКАЗ: ${f.title}`, actions: f.rleActions });
      }
      // Зоны — по тому, что знает борт: подмена ГНСС оператору видна только по косвенным признакам.
      alerts.push(...environmentAlerts(tele, zones));
      // Связь: НСУ знает свой приём и без телеметрии; линия на карте — через ретрансляторы.
      const L = s.link;
      if (!s.linkLost && L.status === 'poor') {
        const why = L.cause === 'terrain' ? 'рельеф закрывает НСУ: набрать высоту или ретранслятор' : L.cause === 'jam' ? 'помехи в радиоканале' : 'предел дальности';
        alerts.push({ level: 'warn', text: `СВЯЗЬ СЛАБАЯ, запас ${fmt(L.marginDb)} дБ — ${why}` });
      }
      gcs.setLink(
        s.linkQuality,
        s.linkLost
          ? `Нет связи ${fmtTime(s.t - tele.t)}`
          : `${L.status === 'good' ? 'Связь' : 'Связь слабая'} · ${Math.round(L.rssiDbm)} дБм · запас ${fmt(L.marginDb)} дБ · телеметрия ${fmt(L.telemetryHz)} Гц${L.via.length ? ` · через Р${L.via.map((i) => i + 1).join('→Р')}` : ''}`,
      );
      map.setLinkLine([siteA, ...L.via.map((i) => relays[i]!), fromLocal(siteA, s.east, s.north)], s.linkLost ? 'lost' : L.status, L.obstruction?.at);
      if (s.mode === 'failsafe') {
        const src = pilot.source === 'gamepad' ? 'геймпад' : pilot.source === 'keyboard' ? 'клавиатура: W/S — газ, A/D — курс, стрелки — тангаж и крен' : 'подключите геймпад или нажмите клавишу';
        alerts.push({ level: 'warn', text: `ФЭЙЛСЕЙФ · ${s.failsafePhase === 'copter' ? 'коптер' : 'самолёт'} · пульт: ${src}${flight.rcInRange() ? '' : ' · ПДУ НЕ ДОСТАЁТ'}` });
      }
      const soc = Math.max(0, tele.soc);
      // Продув ПВД на проверке СВС: приборная в телеметрии растёт и возвращается к нулю.
      const pitotMs = lastTest && prep.running === 'airdata' ? lastTest.airspeedMs : null;
      gcs.update({
        state: pitotMs !== null ? { ...tele, iasMs: pitotMs, tasMs: pitotMs } : tele,
        alerts,
        frames: { total: frames.length, ok: frames.filter((f) => f.ok).length },
        altitudeMslM: tele.up + siteA.elevationM,
        // Напряжение по заряду (без просадки под нагрузкой): 50,4 В полная, 39,9 В на 10 %.
        voltageV: AIRCRAFT.voltage10PctV + (AIRCRAFT.voltageFullV - AIRCRAFT.voltage10PctV) * Math.min(1, Math.max(0, (soc - 0.1) / 0.9)),
        rate,
        paused,
        capacityWh: flight.capacityWh,
        usableWh: flight.usableWh,
        stageName: mission.stages.length > 1 ? mission.stageNames[stage]! : '',
        canUnload: scenario.kind === 'delivery' && stage === 0 && s.mode === 'landed' && atDestination,
        notReady: blocked(checks),
      });
      // Место на профиле — по ближайшей точке маршрута рядом с текущей.
      let best = 0;
      let bestD = Infinity;
      for (let i = Math.max(0, s.wp - 8); i <= Math.min(flight.path.length - 1, s.wp + 8); i++) {
        const p = flight.path[i]!;
        const d = Math.hypot(p.east - s.east, p.north - s.north);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      gcs.profile(profile, airborne() ? { dist: profile.dist[best] ?? 0, alt: s.up + siteA.elevationM } : null);
      const lastFrame = frames[frames.length - 1];
      gcs.pip(
        searchMode?.active
          ? channelLabel(searchMode.label())
          : fireMode?.active
          ? channelLabel(fireMode.label())
          : dayGimbal()
          ? 'Камера подвеса · тянуть — поворот, колёсико — зум, щелчок — сопровождение'
          : pip
          ? lastFrame
            ? `Кадр ${frames.length} · ${fmt(lastFrame.aglM)} м · GSD ${fmt(lastFrame.gsdM * 100, 2)} см · смаз ${fmt(lastFrame.blurPx, 2)} px · ISO ${fmt(lastFrame.iso)}${lastFrame.ok ? '' : ` · БРАК: ${lastFrame.reason}`}`
            : `${MODE_NAMES[s.mode]} · камера ждёт галс`
          : null,
      );
    }
  }

  function draw(dt: number) {
    world.render(dt);
    // Поиск и патруль: окно подвеса с тепловизором вместо окна фотокамеры.
    const thermalMode = searchMode?.active ? searchMode : fireMode?.active ? fireMode : null;
    const day = dayGimbal();
    gwin.setActive(!!thermalMode || !!day);
    // Углы подвеса меняются и сами — при сопровождении: подписи — раз в несколько кадров.
    if ((thermalMode || day) && ++gimbalLabelFrame % 6 === 0) gwin.sync();
    if (thermalMode) {
      gwin.lastFovDeg = thermalMode.fovDeg;
      thermalMode.render(gwin.rect(thermalMode.aspect), gwin.ir);
    } else if (day) {
      const r = gwin.rect(4 / 3);
      Object.assign(pipEl.style, { width: `${r.width}px`, height: `${r.height}px` });
      gwin.lastFovDeg = day.fovDeg;
      world.renderPip(r, day.eye, day.look, day.fovDeg, day.up);
    } else if (pip && mission.camera) {
      const w = Math.round(Math.min(260, gcs.viewEl.clientWidth * 0.4));
      const r = { right: 12, bottom: 12, width: w, height: Math.round((w * 2) / 3) };
      Object.assign(pipEl.style, { width: `${r.width}px`, height: `${r.height}px` });
      const cam = mission.camera;
      const fov = (2 * Math.atan((cam.heightPx * cam.pixelPitchUm * 1e-3) / (2 * cam.focalLengthMm)) * 180) / Math.PI;
      world.renderPip(r, pip.eye, pip.look, fov, pip.up);
    }
  }

  /** Подпись окна поиска и патруля — по каналу подвеса: тепловизор или дневная камера. */
  function channelLabel(text: string): string {
    return gwin.ir ? text : text.replace(/^Тепловизор/, 'Дневная камера');
  }

  /** Кадр дневной камеры подвеса — если её окно включено кнопкой «Подвес» и аппарат в воздухе. */
  function dayGimbal() {
    if (!gwin.dayShown || !airborne() || searchMode || fireMode || scenario.kind === 'survey') return null;
    return gimbal.frame(flight.state, DAY_FOV_DEG);
  }

  /** Щелчок по кадру подвеса: в поиске и патруле — отметка, с «Сопровождением» или Shift — взять цель. */
  function gimbalClick(x: number, y: number, shift: boolean) {
    const mode = searchMode ?? fireMode;
    if (mode && !gwin.trackMode && !shift) {
      mode.markAt(x, y, gwin.ir);
      return;
    }
    const box = pipEl.getBoundingClientRect();
    const p = mode && gwin.ir ? world.thermalPick(x - box.left, y - box.top) : world.pipPick(x - box.left, y - box.top);
    if (!p) return;
    const body = searchMode?.bodyNear(p) ?? null;
    gimbal.track = body ? { kind: 'body', id: body } : { kind: 'point', p: { east: p.east, north: p.north, up: p.up } };
    gwin.sync();
    gcs.log(flight.state.t, body ? 'Подвес: сопровождение цели' : 'Подвес: сопровождение точки на земле');
  }

  gcs.setSoundMuted(mutedPref);
  // Голоса браузер отдаёт не сразу — переключатель обновляется, когда они появятся.
  const showVoice = () => {
    gcs.setVoice(voice.enabled, voice.available, voice.reason || undefined);
    gcs.setVoiceOptions(
      voice.voices().map((v) => ({ uri: v.uri, label: `${v.name} — ${v.qualityLabel}${v.local ? '' : ', онлайн'}`, selected: v.selected })),
      voice.upgradeHint,
    );
  };
  voice.onChange = showVoice;
  showVoice();
  // Место полёта из журнала: задание по умолчанию — повтор полёта по траектории журнала, разбор журнала открывается сам.
  const logHere = ACTIVE_REGION.id === LOG_REGION_ID;
  loadScenario((logHere && SCENARIOS.find((x) => x.id === 'route')) || SCENARIOS[0]!);
  if (logHere)
    void loadLastLog()
      .then((r) => {
        if (r?.meta.origin) openDebrief(onTerrain(placeRecording(r, siteA, terrain.elevationM(r.meta.origin) - siteA.elevationM)));
      })
      .catch((e: unknown) => console.warn('Журнал места полёта не открылся:', e));

  /** Журнал — на рельеф сцены: высота журнала за полёт уходит на метры, и без поправки аппарат стоит под землёй. */
  function onTerrain(r: Recording): Recording {
    return r.meta.source === 'log' ? settleOnTerrain(r, (e, n) => world.groundAt(e, n)) : r;
  }

  /**
   * На земле аппарат стоит по склону: тангаж и крен — по рельефу под опорами (±0,6 м вдоль,
   * ±0,42 м поперёк), центр — на земле. Горизонтально стоящий на склоне аппарат уходит опорой под рельеф.
   */
  function standOnSlope(pose: { position: { east: number; north: number; up: number }; headingDeg: number; pitchDeg: number; bankDeg: number }) {
    const h = (pose.headingDeg * Math.PI) / 180;
    const fe = Math.sin(h);
    const fn = Math.cos(h);
    const { east, north } = pose.position;
    // a — вперёд, l — вправо.
    const g = (a: number, l: number) => world.groundAt(east + fe * a + fn * l, north + fn * a - fe * l);
    pose.position.up = world.groundAt(east, north);
    pose.pitchDeg = (Math.atan2(g(0.6, 0) - g(-0.6, 0), 1.2) * 180) / Math.PI;
    pose.bankDeg = (Math.atan2(g(0, -0.42) - g(0, 0.42), 0.84) * 180) / Math.PI;
  }

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!videoBusy) {
      step(dt);
      updateSound(dt);
      updateVoice();
      draw(dt);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    // Для проверки в скрытой вкладке, где requestAnimationFrame не вызывается.
    Object.assign(window, {
      sim: {
        world,
        debrief,
        openDebrief,
        map,
        get flight() {
          return flight;
        },
        get search() {
          return searchMode;
        },
        get fire() {
          return fireMode;
        },
        command,
        scenario(id: string) {
          const sc = SCENARIOS.find((x) => x.id === id);
          if (sc) loadScenario(sc);
        },
        setRate: (r: number) => (rate = r),
        run(seconds: number, fps = 30) {
          for (let i = 0; i < seconds * fps; i++) {
            step(1 / fps);
            world.render(1 / fps);
          }
          hudTimer = 1;
          step(0);
          draw(0);
          const st = flight.state;
          return { t: Math.round(st.t), mode: st.mode, stage, agl: Math.round(st.aglM), frames: frames.length, soc: +st.soc.toFixed(3) };
        },
      },
    });
  }
}

start().catch((e: unknown) => {
  app.innerHTML = `<div class="loading">Не удалось запустить: ${e instanceof Error ? e.message : String(e)}</div>`;
  console.error(e);
});
