import 'leaflet/dist/leaflet.css';
import * as THREE from 'three';
import './ui/style.css';
import { PROFILE } from '@profile';
import { buildMission, departure, forecastWeather, REGION, SCENARIOS, type Mission, type Scenario, type Settings } from './game/scenarios';
import { blocked, preflightChecks, type Check } from './game/preflight';
import { actualWeather } from './game/weather';
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
    case 'route':
      return { ...sc, route: sc.route.map((p) => ({ ...p })), defaults: { ...sc.defaults } };
  }
}

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

  const luxAt = (t: number) =>
    illuminanceLux(sunPosition(new Date(departure(scenario, settings).getTime() + t * 1000), siteA).elevationDeg, scenario.cloudCover);
  const airborne = () => !['ground', 'landed', 'crashed'].includes(flight.state.mode);
  const groundS = () => (scenario.kind === 'delivery' ? scenario.unloadS : 0);
  const captureContext = () => ({ site: siteA, terrain, lineLegs: mission.survey!.lineLegs, luxAt });
  const extent = (): GeoPoint[] => [
    siteA,
    ...(scenario.kind === 'survey' ? scenario.area : scenario.route),
    ...(scenario.kind === 'delivery' ? [scenario.destination] : []),
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
  const world = new World(gcs.viewEl, { terrain, site: siteA, bounds, area: [], maxImageryZoom: 18, cloudBaseM: 1500, cloudCover: 0.3 });
  // По умолчанию камера за хвостом: аппарат на экране смотрит туда же, куда летит.
  world.setCameraMode('chase');
  // Модель аппарата — из профиля; ?model=… в адресе или VITE_MODEL при сборке её заменяют.
  const modelName = new URLSearchParams(location.search).get('model') ?? import.meta.env.VITE_MODEL ?? PROFILE.modelName;
  loadAircraft(`${import.meta.env.BASE_URL}models/${modelName.replace(/[^a-z0-9-]/gi, '')}.glb`)
    .then((model) => world.setAircraft(model))
    .catch((e) => console.warn('CAD-модель аппарата не загрузилась, остаётся упрощённая:', e));

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
    if (started || scenario.kind !== 'delivery') return;
    if (!inRegion(p)) return gcs.log(0, 'Пункт доставки вне загруженного рельефа', 'warn');
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
    if (c === 'takeoff' && s.mode === 'ground' && blocked(checks)) {
      return gcs.log(s.t, 'НЕ ГОТОВ: РЛЭ запрещает взлёт — см. предполётные проверки', 'warn');
    }
    const err = flight.command(c);
    if (err) return gcs.log(s.t, err, 'warn');
    if (c === 'takeoff') {
      started = true;
      // В полёте закрыты все настройки, кроме точек маршрута.
      gcs.lockPlanning(true, scenario.kind !== 'survey');
      map.setEditing({ area: false, route: scenario.kind !== 'survey', destination: false });
      gcs.hideToast();
    }
  }

  function loadScenario(sc: Scenario) {
    started = false;
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
    actual = forecastError ? actualWeather(forecast, daySeed) : forecast;
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
      const pts: GeoPoint[] = [siteA, ...scenario.route, scenario.kind === 'delivery' ? scenario.destination : siteA];
      for (let i = 1; i < pts.length; i++) leg(pts[i - 1]!, pts[i]!);
    }
    map.setRoute(path, pins, labels);
    map.setArea(scenario.kind === 'survey' ? scenario.area : null);
    map.setEditableRoute(scenario.kind === 'survey' ? null : scenario.route);
    map.setDestination(scenario.kind === 'delivery' ? scenario.destination : null);
    map.setEditing({ area: !started, route: true, destination: !started });

    world.setRoute(
      mission.stages.flatMap((p) => [
        { ...local(p.takeoff), up: p.takeoff.elevationM - siteA.elevationM + AIRCRAFT.vtol.transitionHeightM },
        ...p.waypoints.map((w) => ({ ...local(w), up: w.altitudeM - siteA.elevationM })),
        { ...local(p.landing), up: p.landing.elevationM - siteA.elevationM + AIRCRAFT.vtol.backTransitionHeightM },
      ]),
    );
    world.setPads(mission.destination ? [local(mission.destination)] : []);
    gcs.setRoute(
      scenario.kind === 'survey' ? null : scenario.route,
      scenario.siteName,
      scenario.kind === 'delivery' ? scenario.destinationName : scenario.siteName,
      true,
    );
  }

  function startStage(i: number, t0: number, e0: number) {
    stage = i;
    stageLanded = false;
    atDestination = false;
    fallS = 0;
    eventsShown = 0;
    flight = new LiveFlight({ plan: mission.stages[i]!, terrain, weather: actual, origin: siteA, home: siteA, startT: t0, initialEnergyWh: e0 });
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

  function step(dt: number) {
    const s = flight.state;
    world.setSun(sunPosition(new Date(departure(scenario, settings).getTime() + s.t * 1000), siteA));
    if (!paused) {
      flight.step(dt * rate, controls, (st) => {
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
        }
      });
    }
    for (; eventsShown < flight.events.length; eventsShown++) {
      const e = flight.events[eventsShown]!;
      gcs.log(e.t, e.text, e.text.startsWith('АВАРИЯ') ? 'bad' : 'info');
    }

    const plane = ['transition', 'auto', 'guided', 'manual', 'rtl', 'backtransition'].includes(s.mode);
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
    world.aircraft.animate(dt, s.lift, s.pusher);
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
          `<b>Посадка: ${scenario.destinationName}</b>Израсходовано ${fmt(s.energyWh)} Вт·ч, заряд ${fmt(s.soc * 100)} %. Нажмите «Разгрузка», затем «Взлёт».`,
          'good',
        );
      } else announce();
    }
    if (s.mode === 'crashed') announce();

    hudTimer += dt;
    if (hudTimer > 0.1) {
      hudTimer = 0;
      // Вектор путевой скорости на 30 с вперёд: нос по курсу, линия — куда реально летит.
      const ahead = s.groundSpeedMs * 30;
      const tr = (s.trackDeg * Math.PI) / 180;
      map.setAircraft(
        fromLocal(siteA, s.east, s.north),
        s.headingDeg,
        airborne() && s.groundSpeedMs > 3 ? fromLocal(siteA, s.east + Math.sin(tr) * ahead, s.north + Math.cos(tr) * ahead) : undefined,
      );
      const soc = Math.max(0, s.soc);
      gcs.update({
        state: s,
        frames: { total: frames.length, ok: frames.filter((f) => f.ok).length },
        altitudeMslM: s.up + siteA.elevationM,
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

  loadScenario(SCENARIOS[0]!);

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    draw(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    // Для проверки в скрытой вкладке, где requestAnimationFrame не вызывается.
    Object.assign(window, {
      sim: {
        world,
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
