import * as THREE from 'three';

/*
 * Атмосфера одной моделью рассеяния — Рэлей (воздух, синий) и Ми (аэрозоль, дымка вокруг
 * Солнца): небо, цвет и сила прямого солнечного света, рассеянный свет неба и дымка по
 * дальности и высоте над рельефом. Небо и дымка считаются одними формулами, поэтому дальние
 * горы уходят в горизонт без шва, а на закате и дымка, и свет, и небо теплеют вместе.
 *
 * Модель дешёвая, однократное рассеяние в однородной по горизонтали атмосфере: оптическая толща
 * по лучу — через воздушную массу (Кастен и Янг), свет Солнца до точки рассеяния — по его высоте.
 * Сумерки — отдельным слагаемым: Солнце за горизонтом, а небо ещё светится.
 *
 * Дымка встраивается в стандартные куски шейдеров three.js (fog_*): её получают все материалы
 * с туманом — рельеф, лес, дома, вода, дым и осадки. Тепловизор рисует без тумана и её не видит.
 * Сцена: x — восток, y — вверх (над уровнем площадки), z — минус север.
 */

const DEG = Math.PI / 180;

/** Рэлеевское рассеяние у земли, 1/м, для красного, зелёного и синего (680, 550, 440 нм). */
export const RAYLEIGH: readonly [number, number, number] = [5.8e-6, 13.5e-6, 33.1e-6];
export const RAYLEIGH_H_M = 8000;
/** Аэрозоль ясного неба (оптическая толща ~0,03) и его высота однородной атмосферы, м; дымка у земли — отдельно. */
export const MIE_SKY = 2.5e-5;
export const MIE_SKY_H_M = 1200;
/** Асимметрия рассеяния на аэрозоле: ореол вокруг Солнца в небе и, мягче, в дымке у земли. */
export const MIE_G = 0.76;
export const HAZE_G = 0.6;
/** Яркость Солнца в условных единицах кадра (до экспозиции). */
export const SUN_E = 24;
/** Дымка у земли: высота, на которой её плотность падает в e раз, над уровнем площадки, м. */
export const HAZE_H_M = 1200;
/**
 * Воздушная масса луча взгляда для неба — не больше этой: у горизонта свет, рассеянный далеко,
 * гаснет по дороге к глазу, и однородная модель без ограничения выбеливает горизонт.
 */
export const SKY_AIRMASS_MAX = 12;
/** Ночное небо без Луны: слабый синеватый фон. */
export const NIGHT_SKY: readonly [number, number, number] = [0.0012, 0.0018, 0.0036];

const smoothstep = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Воздушная масса по высоте Солнца (или направления), °: 1 в зените, ~38 у горизонта; за горизонтом растёт дальше. */
export function airmass(elDeg: number): number {
  const e = Math.max(0, elDeg);
  const z = 90 - e;
  const m = 1 / (Math.cos(z * DEG) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
  return elDeg >= 0 ? m : Math.min(120, m * (1 + -elDeg * 0.6));
}

/** Пропускание по толще с воздушной массой m, RGB. */
function transmittanceFor(m: number, out: THREE.Vector3): THREE.Vector3 {
  const mie = MIE_SKY * MIE_SKY_H_M * 1.1;
  return out.set(Math.exp(-(RAYLEIGH[0] * RAYLEIGH_H_M + mie) * m), Math.exp(-(RAYLEIGH[1] * RAYLEIGH_H_M + mie) * m), Math.exp(-(RAYLEIGH[2] * RAYLEIGH_H_M + mie) * m));
}

/** Пропускание атмосферы для солнечного луча, RGB: низкое Солнце краснеет, за горизонтом гаснет. */
export function sunTransmittance(elDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  return transmittanceFor(airmass(elDeg), out).multiplyScalar(smoothstep(elDeg, -9, 1));
}

const phaseR = (mu: number) => 0.0597 * (1 + mu * mu);
const phaseM = (mu: number, g = MIE_G) => (1 - g * g) / (12.566 * Math.pow(Math.max(1e-4, 1 + g * g - 2 * g * mu), 1.5));

/** Сумерки: насколько светится небо без прямого Солнца, 0…1. */
export const twilight = (elDeg: number) => smoothstep(elDeg, -14, -1) * (1 - smoothstep(elDeg, 2, 12));
/** Заря: тёплая полоса у горизонта со стороны Солнца, пока оно низко или только село. */
export const dawnGlow = (elDeg: number) => smoothstep(elDeg, -9, -1) * (1 - smoothstep(elDeg, 3, 14));

/**
 * Яркость неба по направлению (y — синус высоты, mu — косинус угла до Солнца), RGB.
 * sunLight — Солнце за атмосферой (SUN_E × пропускание).
 */
export function skyRadiance(y: number, mu: number, sunLight: THREE.Vector3, elDeg: number, out = new THREE.Vector3(), towardSun = 0): THREE.Vector3 {
  const m = Math.min(SKY_AIRMASS_MAX, airmass(Math.asin(Math.max(0, Math.min(1, y))) / DEG));
  const tM = MIE_SKY * MIE_SKY_H_M;
  const pr = phaseR(mu);
  const pm = phaseM(mu);
  const ch = (i: 0 | 1 | 2, light: number) => {
    const tR = RAYLEIGH[i] * RAYLEIGH_H_M;
    return light * ((tR * pr + tM * pm) / (tR + tM)) * (1 - Math.exp(-(tR + tM) * m));
  };
  out.set(ch(0, sunLight.x), ch(1, sunLight.y), ch(2, sunLight.z));
  // Сумеречное небо: рассеянный свет с освещённых верхних слоёв, синеватый.
  const tw = twilight(elDeg) * SUN_E * 0.012;
  out.add(new THREE.Vector3(0.28, 0.4, 0.75).multiplyScalar(tw * (1 - 0.5 * Math.max(0, y))));
  const glow = dawnGlow(elDeg) * SUN_E * 0.05 * Math.pow(Math.max(0, towardSun), 4) * Math.exp(-Math.max(0, y) * 9);
  out.add(new THREE.Vector3(1, 0.42, 0.18).multiplyScalar(glow));
  return out.add(new THREE.Vector3(NIGHT_SKY[0], NIGHT_SKY[1], NIGHT_SKY[2]));
}

/** Те же формулы для шейдеров: небо и дымка. */
export const ATMOSPHERE_GLSL = /* glsl */ `
const vec3 ATMO_BR = vec3(${RAYLEIGH.map((x) => x.toExponential(3)).join(', ')});
const float ATMO_HR = ${RAYLEIGH_H_M.toFixed(1)};
const float ATMO_BM = ${MIE_SKY.toExponential(3)};
const float ATMO_HM = ${MIE_SKY_H_M.toFixed(1)};
const float ATMO_G = ${MIE_G.toFixed(3)};
const float ATMO_SKY_AIRMASS_MAX = ${SKY_AIRMASS_MAX.toFixed(1)};
const vec3 ATMO_NIGHT = vec3(${NIGHT_SKY.map((x) => x.toFixed(5)).join(', ')});
float atmoAirmass(float y) {
  float z = 90.0 - degrees(asin(clamp(y, 0.0, 1.0)));
  return 1.0 / (cos(radians(z)) + 0.50572 * pow(96.07995 - z, -1.6364));
}
float atmoPhaseR(float mu) { return 0.0597 * (1.0 + mu * mu); }
float atmoPhaseM(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1e-4, 1.0 + g2 - 2.0 * g * mu), 1.5)); }
`;

/* ------------------------------- Дымка ------------------------------- */

/**
 * Общие для всех материалов униформы дымки. Значения — типизированные массивы: three.js копирует
 * униформы материала при сборке программы, а массивы оставляет по ссылке, — поэтому одно
 * обновление за кадр доходит до всех материалов.
 */
export const fogUniforms = {
  /** Вторая строка матрицы камеры (мир ← вид): высота точки по её положению в системе вида. */
  fogCamRow: { value: new Float32Array(4) },
  /** Направление на Солнце в системе вида и асимметрия ореола. */
  fogSunView: { value: new Float32Array([0, 1, 0, HAZE_G]) },
  /** Рэлеевское ослабление у земли, 1/м, и высота слоя дымки, м. */
  fogExtR: { value: new Float32Array([RAYLEIGH[0], RAYLEIGH[1], RAYLEIGH[2], HAZE_H_M]) },
  /** Свет Солнца для дымки, RGB, и аэрозоль у земли, 1/м. */
  fogSun: { value: new Float32Array([1, 1, 1, 1e-4]) },
};

const FOG_PARS_VERTEX = /* glsl */ `#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif`;

const FOG_VERTEX = /* glsl */ `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif`;

const FOG_PARS_FRAGMENT = /* glsl */ `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform vec4 fogCamRow;
  uniform vec4 fogSunView;
  uniform vec4 fogExtR;
  uniform vec4 fogSun;
#endif`;

/**
 * Воздушная перспектива: ослабление по лучу от камеры до точки с экспоненциальной по высоте
 * плотностью дымки (интеграл берётся точно) и подсветка — рассеянный свет неба (fogColor) плюс
 * Солнце через рассеяние Рэлея и Ми по углу к Солнцу.
 */
const FOG_FRAGMENT = /* glsl */ `#ifdef USE_FOG
  float fogDist = length( vFogView );
  vec3 fogDir = vFogView / max( fogDist, 1e-4 );
  float fogH = fogExtR.w;
  float fogY0 = clamp( fogCamRow.w, -1000.0, 30000.0 );
  float fogY1 = clamp( dot( fogCamRow, vec4( vFogView, 1.0 ) ), -1000.0, 30000.0 );
  float fogK = ( fogY1 - fogY0 ) / fogH;
  float fogE0 = exp( - fogY0 / fogH );
  float fogShape = abs( fogK ) > 1e-3 ? fogE0 * ( 1.0 - exp( - fogK ) ) / fogK : fogE0;
  // Рэлей почти не убывает на высотах полёта; аэрозоль — по слою дымки.
  vec3 fogOD = ( fogExtR.rgb + vec3( fogSun.w * fogShape ) ) * fogDist;
  vec3 fogT = exp( - fogOD );
  float fogMu = dot( fogDir, fogSunView.xyz );
  float fogG = fogSunView.w;
  float fogPM = ( 1.0 - fogG * fogG ) / ( 12.566 * pow( max( 1e-4, 1.0 + fogG * fogG - 2.0 * fogG * fogMu ), 1.5 ) );
  float fogPR = 0.0597 * ( 1.0 + fogMu * fogMu );
  vec3 fogBeta = fogExtR.rgb + vec3( fogSun.w );
  vec3 fogIn = fogColor + fogSun.rgb * ( fogExtR.rgb * fogPR + vec3( fogSun.w * fogPM ) ) / fogBeta;
  gl_FragColor.rgb = fogIn + ( gl_FragColor.rgb - fogIn ) * fogT;
#endif`;

let installed = false;

/**
 * Встроить дымку в стандартные куски шейдеров. Звать до сборки первых материалов (при загрузке
 * модуля сцены): униформы добавляются в библиотеки three.js, откуда материалы их копируют.
 */
export function installAtmosphereFog(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks['fog_pars_vertex'] = FOG_PARS_VERTEX;
  chunks['fog_vertex'] = FOG_VERTEX;
  chunks['fog_pars_fragment'] = FOG_PARS_FRAGMENT;
  chunks['fog_fragment'] = FOG_FRAGMENT;
  Object.assign(THREE.UniformsLib.fog, fogUniforms);
  for (const lib of Object.values(THREE.ShaderLib) as { uniforms?: Record<string, unknown> }[]) {
    if (lib.uniforms && 'fogColor' in lib.uniforms) Object.assign(lib.uniforms, fogUniforms);
  }
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/** Для каждой камеры, которой рисуется сцена: высота точек и Солнце — в системе этой камеры. */
export function updateFogCamera(camera: THREE.Camera, sunDir: THREE.Vector3): void {
  const e = camera.matrixWorld.elements;
  const row = fogUniforms.fogCamRow.value;
  row[0] = e[1]!;
  row[1] = e[5]!;
  row[2] = e[9]!;
  row[3] = e[13]!;
  _m.copy(camera.matrixWorldInverse);
  _v.copy(sunDir).transformDirection(_m);
  const s = fogUniforms.fogSunView.value;
  s[0] = _v.x;
  s[1] = _v.y;
  s[2] = _v.z;
}

/* --------------------------- Свет по времени суток --------------------------- */

export interface AtmosphereState {
  /** Солнце за атмосферой: цвет × яркость (для неба и дымки). */
  sunLight: THREE.Vector3;
  /** Пропускание по прямому лучу Солнца, RGB. */
  transmittance: THREE.Vector3;
  /** Прямой свет: цвет (нормированный) и множитель яркости 0…1. */
  sunColor: THREE.Color;
  sunStrength: number;
  /** Небо в зените и средний горизонт, RGB (для рассеянного света и дымки). */
  zenith: THREE.Vector3;
  horizon: THREE.Vector3;
  /** Сумерки 0…1 и ночь 0…1. */
  twilight: number;
  night: number;
}

/**
 * Всё, что зависит от высоты Солнца: свет за атмосферой, прямой свет, небо в зените и у горизонта.
 * overcast 0…1 гасит прямой свет и серит небо.
 */
export function atmosphereFor(elDeg: number, overcast: number): AtmosphereState {
  const t = sunTransmittance(elDeg);
  // Рассеивает в основном воздух выше наблюдателя: свет Солнца к нему проходит примерно половину
  // толщи — небо в зените не рыжеет вместе с низким Солнцем.
  const half = transmittanceFor(airmass(Math.max(elDeg, 0)) / 2, new THREE.Vector3());
  const sunLight = half.multiplyScalar(SUN_E * smoothstep(elDeg, -9, 1));
  const zenith = skyRadiance(1, Math.sin(elDeg * DEG), sunLight, elDeg);
  // Горизонт по кругу: со стороны Солнца теплее, напротив — синее; для дымки — среднее.
  const horizon = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const ce = Math.cos(elDeg * DEG);
  for (let k = 0; k < 8; k++) {
    const c = Math.cos((k * Math.PI) / 4);
    horizon.add(skyRadiance(0.03, ce * c * 0.999, sunLight, elDeg, tmp, c));
  }
  horizon.multiplyScalar(1 / 8);
  // Пасмурно: небо серое и тусклее, прямого Солнца почти нет.
  const grey = (v: THREE.Vector3, keep: number) => {
    const l = 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
    v.lerp(new THREE.Vector3(l, l, l * 1.04), overcast * 0.85).multiplyScalar(keep);
  };
  grey(zenith, 1 - 0.35 * overcast);
  grey(horizon, 1 - 0.25 * overcast);
  const max = Math.max(t.x, t.y, t.z, 1e-6);
  const sunColor = new THREE.Color(t.x / max, t.y / max, t.z / max);
  const sunStrength = max * smoothstep(elDeg, -1, 4) * (1 - 0.8 * overcast);
  return { sunLight, transmittance: t, sunColor, sunStrength, zenith, horizon, twilight: twilight(elDeg), night: 1 - smoothstep(elDeg, -12, -2) };
}
