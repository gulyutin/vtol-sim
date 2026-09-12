import 'leaflet/dist/leaflet.css';
import * as THREE from 'three';
import './ui/style.css';
import { PROFILE } from '@profile';
import { parseOsm } from './sim/osm';
import { loadQuality, QUALITY, saveQuality } from './ui/quality';
import { Preparation, PREP_STEPS, type GroundTest, type PrepStepId } from './game/preparation';
import { buildMission, departure, forecastWeather, REGION, SCENARIOS, type Mission, type Scenario, type Settings } from './game/scenarios';
import { blocked, preflightChecks, type Check } from './game/preflight';
import { actualWeather, PRECIPITATION_NAME, weatherPreset, type WeatherPresetKind } from './game/weather';
import { fetchLiveWeather, type LiveWeather } from './game/liveWeather';
import { Sound, type SoundState } from './ui/audio';
import { FlightRecorder, poseOf, stateAt, type Recording } from './game/recorder';
import { assessFlight, FAILURE_TITLES, findDifficulty, planFailures, saveResult, type Assessment, type DifficultyId, type FailureEvent } from './game/scoring';
import { Debrief } from './ui/debrief';
import { PilotInput } from './ui/pilotInput';
import { failureInfo, LINK_TIMEOUT_S, type FailureId } from './sim/failures';
import type { Alert } from './ui/gcs';
import { AIRCRAFT } from './sim/aircraft';
import { LiveFlight, MODE_NAMES, type Controls } from './sim/flight';
import { combineResults, distanceM, fromLocal, simulateMission, toLocal } from './sim/mission';
import { sunPosition } from './sim/sun';
import { captureFrames, coverageOf, FrameTrigger, illuminanceLux, type Frame } from './sim/survey';
import { buildTimeline } from './sim/timeline';
import type { GeoPoint, MissionResult, Site, Terrain, Weather } from './sim/types';
import { windAt } from './sim/wind';
import { loadAircraft } from './ui/aircraftModel';
import { createGcs, fmt, fmtTime, fmtWind, type GcsCommand, type SurveyInfo } from './ui/gcs';
import type { ProfileData } from './ui/instruments';
import { Map2D, type LegLabel, type Pin } from './ui/map2d';
import { World } from './ui/scene';
import { expandBounds, loadTerrain, type Bounds } from './ui/terrainData';

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
  loading.remove();
  run(terrain, bounds);
}

function run(terrain: Terrain, bounds: Bounds) {
  const siteA: Site = { ...SCENARIOS[0]!.site, elevationM: terrain.elevationM(SCENARIOS[0]!.site) };
  const local = (p: GeoPoint) => toLocal(siteA, p);

  let scenario: Scenario = cloneScenario(SCENARIOS[0]!);
  let settings: Settings = { ...scenario.defaults };
  let forecastError = true;
  let daySeed = 1;
  let forecast!: Weather;
  let actual!: Weather;
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
  const wakeSound = () => void sound.resume().then(() => sound.setMuted(mutedPref));
  document.addEventListener('pointerdown', wakeSound);
  document.addEventListener('keydown', wakeSound);

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
  let lastAssessment: { rec: Recording; a: Assessment } | null = null;
  const prepNeeded = () => prepRequired || findDifficulty(difficultyId).prepRequired;
  // Разбор: пока открыт, живой полёт стоит, а 3D показывает запись в момент replayT.
  const debrief = new Debrief(app);
  let replayT = 0;
  let pausedBeforeDebrief = false;
  debrief.onSeek = (t) => (replayT = t);
  debrief.onClose = () => (paused = pausedBeforeDebrief);
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
    onSettings(s) {
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
      const text = id === 'link' ? 'Связь с НСУ восстановлена' : 'Сигнал ГНСС восстановлен';
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
      openDebrief(lastAssessment?.rec ?? currentRecording(), lastAssessment?.a);
    },
    onWeatherSource(src) {
      weatherSource = src;
      if (src === 'live') return loadLiveWeather();
      liveFetch?.abort();
      liveFetch = null;
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
  });

  document.title = PROFILE.title;
  const quality = QUALITY[loadQuality()];
  const world = new World(gcs.viewEl, { terrain, site: siteA, bounds, area: [], maxImageryZoom: quality.maxImageryZoom, cloudBaseM: 1500, cloudCover: 0.3, quality });
  // По умолчанию камера за хвостом: аппарат на экране смотрит туда же, куда летит.
  world.setCameraMode('chase');
  // Модель аппарата — из профиля; ?model=… в адресе или VITE_MODEL при сборке её заменяют.
  const modelName = new URLSearchParams(location.search).get('model') ?? import.meta.env.VITE_MODEL ?? PROFILE.modelName;
  loadAircraft(`${import.meta.env.BASE_URL}models/${modelName.replace(/[^a-z0-9-]/gi, '')}.glb`)
    .then((model) => world.setAircraft(model))
    .catch((e) => console.warn('CAD-модель аппарата не загрузилась, остаётся упрощённая:', e));
  // Дома, леса и полосы из OpenStreetMap — если они есть в профиле.
  if (PROFILE.osmUrl) {
    fetch(PROFILE.osmUrl)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => world.setOsm(parseOsm(buf)))
      .catch((e) => console.warn('Дома и лес не загрузились:', e));
  }

  const map = new Map2D(gcs.mapEl, siteA);
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
    if (started || (scenario.kind !== 'delivery' && scenario.kind !== 'transfer')) return;
    if (!inRegion(p)) return gcs.log(0, 'Пункт Б вне загруженного рельефа', 'warn');
    scenario = { ...scenario, destination: p };
    replan();
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
    scenario = { ...scenario, route: [...scenario.route, { ...p, heightAglM: last?.heightAglM ?? 150 }] };
    if (started) replanInFlight();
    else replan();
  };

  function command(c: GcsCommand) {
    const s = flight.state;
    if (c === 'arm' && prep.running) return gcs.log(s.t, 'Идёт проверка подготовки — дождитесь окончания', 'warn');
    if (c === 'arm' && prepNeeded() && !prep.done) return gcs.log(s.t, 'Сначала предполётная подготовка — окно «Подготовка»', 'warn');
    if (c === 'target') {
      if (!airborne()) return gcs.log(s.t, 'ЦЕЛЬ — только в полёте', 'warn');
      targetMode = !targetMode;
      gcs.targetMode(targetMode);
      if (targetMode) gcs.log(s.t, 'Укажите точку на карте');
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
    if (c === 'arm') sound.alarm('arm');
    if (c === 'disarm') sound.alarm('disarm');
    rec.event(s.t, `Команда: ${COMMAND_TITLE[c] ?? c}`, 'cmd');
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
    gcs.loadScenario(scenario, settings, forecastError);
    world.setArea(scenario.kind === 'survey' ? scenario.area : []);
    replan();
    map.fit(extent());
  }

  function replan() {
    if (started) return;
    forecast = forecastWeather(scenario, settings);
    if (weatherSource === 'live' && live) forecast = { ...live.weather };
    else if (weatherSource !== 'scenario' && weatherSource !== 'live') forecast = weatherPreset(weatherSource as WeatherPresetKind, forecast);
    actual = forecastError ? actualWeather(forecast, daySeed) : forecast;
    world.setWeather(actual);
    gcs.setWeatherSummary(
      weatherSource === 'scenario' ? '' : weatherSource === 'live' ? (live ? `${live.summary} · ${live.attribution}` : 'Загружаю погоду…') : `Факт: ${weatherText(actual)}`,
    );
    try {
      mission = buildMission(scenario, settings, terrain, forecast);
    } catch (e) {
      gcs.log(0, e instanceof Error ? e.message : String(e), 'bad');
      return;
    }
    parts = mission.stages.map((p) => simulateMission(p, forecast));
    planned = combineResults(parts, groundS());
    checks = preflightChecks({ stages: mission.stages, weather: forecast, procedures: mission.procedures, cloudBaseM: scenario.cloudBaseM, terrain, gcs: siteA });
    gcs.showPreflight(checks);

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
    map.setArea(scenario.kind === 'survey' ? scenario.area : null);
    map.setEditableRoute(scenario.kind === 'survey' ? null : scenario.route);
    map.setDestination(destinationOf(scenario));
    map.setEditing({ area: !started, route: true, destination: !started });

    world.setRoute(
      mission.stages.flatMap((p) => [
        { ...local(p.takeoff), up: p.takeoff.elevationM - siteA.elevationM + AIRCRAFT.vtol.transitionHeightM },
        ...p.waypoints.map((w) => ({ ...local(w), up: w.altitudeM - siteA.elevationM })),
        { ...local(p.landing), up: p.landing.elevationM - siteA.elevationM + AIRCRAFT.vtol.backTransitionHeightM },
      ]),
    );
    world.setPads(mission.destination ? [local(mission.destination)] : []);
    world.setMarkers(
      scenario.kind === 'survey'
        ? []
        : scenario.route.map((p, i) => ({ ...local(p), up: terrain.elevationM(p) + p.heightAglM - siteA.elevationM, label: String(i + 1) })),
    );
    gcs.setRoute(
      scenario.kind === 'survey' ? null : scenario.route,
      scenario.siteName,
      destinationNameOf(scenario),
      true,
    );
  }

  function startStage(i: number, t0: number, e0: number) {
    stage = i;
    stageLanded = false;
    atDestination = false;
    fallS = 0;
    eventsShown = 0;
    flight = new LiveFlight({
      plan: mission.stages[i]!,
      terrain,
      weather: actual,
      origin: siteA,
      home: siteA,
      startT: t0,
      initialEnergyWh: e0,
      // Порывы — свои для дня и полёта; термики — от Солнца над склонами.
      seed: daySeed * 100 + i + 1,
      sun: (t) => sunPosition(new Date(departure(scenario, settings).getTime() + t * 1000), siteA),
    });
    trigger = mission.survey && mission.camera && mission.params ? new FrameTrigger(mission.camera, mission.params, captureContext()) : null;
    updateProfile();
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
    };
    gcs.profile(profile, null);
  }

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
    announced = false;
    pastDistanceM = 0;
    lastTrailT = -Infinity;
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
      delivered: scenario.kind === 'delivery' ? stage >= 1 : undefined,
    });
    lastAssessment = { rec: r, a };
    saveResult({ at: recStartedAt, scenarioId: scenario.id, scenarioTitle: scenario.title, difficulty: difficultyId, total: a.total, grade: a.grade, durationS: s.t });
    gcs.log(s.t, `Оценка: ${a.total} из 100 — ${a.grade}`, a.total >= 60 ? 'info' : 'warn');
    openDebrief(r, a);
  }

  function openDebrief(r: Recording, a?: Assessment) {
    if (!debrief.visible) pausedBeforeDebrief = paused;
    paused = true;
    debrief.show(r, a);
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
        return { ok: true, text: 'Автопилот загружен' };
      case 'link':
        return { ok: true, text: 'Связь есть; крен, тангаж и координаты в норме' };
      case 'servos':
        return { ok: true, text: 'Элероны ходят в обе стороны без заеданий' };
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
      world.setSun(sunPosition(new Date(departure(scenario, settings).getTime() + smp.t * 1000), siteA));
      world.setPose(pose);
      world.aircraft.animate(dt, smp.lift, smp.pusher, null);
      world.aircraft.setLandingLight(0);
      world.updateDust(dt, pose.position, smp.lift * Math.max(0, 1 - smp.aglM / 12));
      world.updateCamera(dt, pose);
      return;
    }
    world.setSun(sunPosition(new Date(departure(scenario, settings).getTime() + s.t * 1000), siteA));
    // «Фэйлсейф» — ручное управление с ПДУ: стик каждый кадр, время без ускорения.
    const manual = flight.state.mode === 'failsafe';
    pilot.enableKeyboard(manual);
    controls = { ...controls, stick: manual ? pilot.poll() : null };
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
      rec.event(e.t, e.text, /^(АВАРИЯ|ОТКАЗ)/.test(e.text) ? 'bad' : 'info');
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
      pitchDeg: plane && s.groundSpeedMs > 3 ? (Math.atan2(s.vzMs, s.groundSpeedMs) * 180) / Math.PI + 2 : 0,
      bankDeg: s.bankDeg,
    };
    if (s.mode === 'crashed') {
      // Двигатели встали — аппарат падает.
      fallS += dt;
      const floor = world.groundAt(s.east, s.north);
      pose.position.up = Math.max(floor, s.up - 0.5 * 9.81 * fallS * fallS);
      pose.pitchDeg = pose.position.up > floor ? -35 : -8;
    }
    world.setPose(pose);
    // Предполётная подготовка: проверки на земле видны на модели; разворот носом против ветра — плавно.
    const test = s.mode === 'ground' && !s.armed ? prep.update(performance.now() / 1000, evaluatePrep) : null;
    if (test && test.turnToWind !== null) {
      const w = windAt(actual, 10);
      const d = ((((w.fromDeg - s.headingDeg + 180) % 360) + 360) % 360) - 180;
      if (w.speedMs >= 1) flight.setGroundHeading(s.headingDeg + Math.max(-60 * dt, Math.min(60 * dt, d)));
    }
    world.aircraft.animate(dt, s.lift, s.pusher, prep.running ? test : null);
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
      if (s.linkLost) alerts.push({ level: 'bad', text: `НЕТ СВЯЗИ с бортом ${fmtTime(s.t - tele.t)} — через ${LINK_TIMEOUT_S} с без связи автопилот уходит на ВОЗВРАТ` });
      for (const id of s.failures) {
        const f = failureInfo(id);
        alerts.push({ level: 'bad', text: `ОТКАЗ: ${f.title}`, actions: f.rleActions });
      }
      if (s.mode === 'failsafe') {
        const src = pilot.source === 'gamepad' ? 'геймпад' : pilot.source === 'keyboard' ? 'клавиатура: W/S — газ, A/D — курс, стрелки — тангаж и крен' : 'подключите геймпад или нажмите клавишу';
        alerts.push({ level: 'warn', text: `ФЭЙЛСЕЙФ · ${s.failsafePhase === 'copter' ? 'коптер' : 'самолёт'} · пульт: ${src}${flight.rcInRange() ? '' : ' · ПДУ НЕ ДОСТАЁТ'}` });
      }
      const soc = Math.max(0, tele.soc);
      gcs.update({
        state: tele,
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
        pip
          ? lastFrame
            ? `Кадр ${frames.length} · ${fmt(lastFrame.aglM)} м · GSD ${fmt(lastFrame.gsdM * 100, 2)} см · смаз ${fmt(lastFrame.blurPx, 2)} px · ISO ${fmt(lastFrame.iso)}${lastFrame.ok ? '' : ` · БРАК: ${lastFrame.reason}`}`
            : `${MODE_NAMES[s.mode]} · камера ждёт галс`
          : null,
      );
    }
  }

  function draw(dt: number) {
    world.render(dt);
    if (pip && mission.camera) {
      const w = Math.round(Math.min(260, gcs.viewEl.clientWidth * 0.4));
      const r = { right: 12, bottom: 12, width: w, height: Math.round((w * 2) / 3) };
      const pipEl = gcs.viewEl.parentElement!.querySelector<HTMLElement>('.pip')!;
      Object.assign(pipEl.style, { width: `${r.width}px`, height: `${r.height}px` });
      const cam = mission.camera;
      const fov = (2 * Math.atan((cam.heightPx * cam.pixelPitchUm * 1e-3) / (2 * cam.focalLengthMm)) * 180) / Math.PI;
      world.renderPip(r, pip.eye, pip.look, fov, pip.up);
    }
  }

  gcs.setSoundMuted(mutedPref);
  loadScenario(SCENARIOS[0]!);

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    updateSound(dt);
    draw(dt);
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
