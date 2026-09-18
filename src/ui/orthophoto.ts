import * as THREE from 'three';
import type { Frame, SurveyCamera } from '../sim/survey';
import type { World } from './scene';

/*
 * Ортофотоплан по кадрам полёта. Каждый кадр — снимок сцены камерой нагрузки из точки и на курсе
 * кадра, отвесно вниз; он проецируется на рельеф и ложится на общую подложку (вид сверху, север
 * вверху). Смаз за выдержку размывает кадр вдоль полёта, недодержанный кадр темнее, пересвеченный —
 * светлее; где кадров не было, остаётся пусто — сразу видно, где не хватило перекрытия и где провал.
 */

export interface OrthoResult {
  canvas: HTMLCanvasElement;
  /** Границы подложки, локальные метры. */
  bounds: { e0: number; n0: number; e1: number; n1: number };
  /** Размер пикселя подложки на земле, м. */
  pixelM: number;
  /** Доля участка без единого кадра. */
  gapShare: number;
}

/** Кадр для проекции: тот, что снят на земле, в пикселях (с учётом отношения сторон камеры). */
const FRAME_W = 480;
const MARGIN_M = 60;
const GRID = 10;

const VERT = /* glsl */ `
uniform mat4 uFrameVP;
varying vec4 vFrame;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vFrame = uFrameVP * world;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAG = /* glsl */ `
uniform sampler2D tFrame;
uniform vec2 uBlur;
uniform float uGain;
varying vec4 vFrame;
void main() {
  if (vFrame.w <= 0.0) discard;
  vec2 uv = vFrame.xy / vFrame.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  // Смаз за выдержку — вдоль полёта (вдоль кадра): среднее по отрезку.
  vec3 c = vec3(0.0);
  for (int i = 0; i < 9; i++) c += texture2D(tFrame, uv + uBlur * (float(i) / 8.0 - 0.5)).rgb;
  c = min(vec3(1.0), c / 9.0 * uGain);
  // Края кадра — мягко: соседние кадры сшиваются без шва.
  vec2 e = min(uv, 1.0 - uv);
  float a = smoothstep(0.0, 0.06, min(e.x, e.y));
  gl_FragColor = vec4(c, a);
}`;

/** Вертикальное поле зрения камеры нагрузки, °. */
export const cameraFovDeg = (cam: SurveyCamera) => (2 * Math.atan((cam.heightPx * cam.pixelPitchUm * 1e-3) / (2 * cam.focalLengthMm)) * 180) / Math.PI;

/**
 * Собрать ортофотоплан. world — 3D-мир (основной цикл на это время остановлен: рендер идёт на его
 * холст); area — участок, локальные метры; maxPx — наибольшая сторона подложки.
 */
export async function buildOrthophoto(
  world: World,
  frames: readonly Frame[],
  area: readonly { east: number; north: number }[],
  cam: SurveyCamera,
  opts: { maxPx?: number; onProgress?: (share: number) => void } = {},
): Promise<OrthoResult> {
  const r = world.renderer;
  const ground = (e: number, n: number) => world.groundAt(e, n);
  // Границы — участок и все кадры над ним, с запасом.
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const p of area) {
    e0 = Math.min(e0, p.east);
    e1 = Math.max(e1, p.east);
    n0 = Math.min(n0, p.north);
    n1 = Math.max(n1, p.north);
  }
  e0 -= MARGIN_M;
  n0 -= MARGIN_M;
  e1 += MARGIN_M;
  n1 += MARGIN_M;
  const maxPx = opts.maxPx ?? 3072;
  const pixelM = Math.max(e1 - e0, n1 - n0) / maxPx;
  const MW = Math.max(16, Math.round((e1 - e0) / pixelM));
  const MH = Math.max(16, Math.round((n1 - n0) / pixelM));
  const ce = (e0 + e1) / 2;
  const cn = (n0 + n1) / 2;

  // Рельеф и снимки — с детальностью над участком: камера вида повисает над его серединой.
  const mean = frames.length ? frames.reduce((a, f) => a + f.aglM, 0) / frames.length : 150;
  const view = world.camera;
  const saved = { pos: view.position.clone(), quat: view.quaternion.clone(), fov: view.fov, aspect: view.aspect };
  const place = () => {
    view.position.set(ce, ground(ce, cn) + mean + 80, -cn);
    view.up.set(0, 0, -1);
    view.lookAt(ce, ground(ce, cn), -cn);
    view.updateMatrixWorld();
  };
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  for (let i = 0; i < 400; i++) {
    place();
    world.render(0.016, false);
    await sleep(20);
    if (i > 30 && world.tilesLoading() === 0) break;
  }
  opts.onProgress?.(0.05);

  const aspect = cam.widthPx / cam.heightPx;
  const FW = FRAME_W;
  const FH = Math.round(FW / aspect);
  const frameCam = new THREE.PerspectiveCamera(cameraFovDeg(cam), aspect, 1, 20000);
  const scratch = new THREE.FramebufferTexture(Math.round(FW * r.getPixelRatio()), Math.round(FH * r.getPixelRatio()));
  scratch.colorSpace = THREE.NoColorSpace;
  scratch.minFilter = THREE.LinearFilter;
  scratch.magFilter = THREE.LinearFilter;
  const target = new THREE.WebGLRenderTarget(MW, MH, { depthBuffer: false });
  target.texture.colorSpace = THREE.NoColorSpace;
  const mosaicCam = new THREE.OrthographicCamera(e0 - ce, e1 - ce, n1 - cn, n0 - cn, 1, 20000);
  mosaicCam.position.set(ce, 10000, -cn);
  mosaicCam.up.set(0, 0, -1);
  mosaicCam.lookAt(ce, 0, -cn);
  mosaicCam.updateMatrixWorld();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { tFrame: { value: scratch }, uFrameVP: { value: new THREE.Matrix4() }, uBlur: { value: new THREE.Vector2() }, uGain: { value: 1 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mosaicScene = new THREE.Scene();
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array((GRID + 1) * (GRID + 1) * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx: number[] = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * (GRID + 1) + i;
      idx.push(a, a + 1, a + GRID + 1, a + 1, a + GRID + 2, a + GRID + 1);
    }
  }
  geo.setIndex(idx);
  const quad = new THREE.Mesh(geo, mat);
  quad.frustumCulled = false;
  mosaicScene.add(quad);

  const prevTarget = r.getRenderTarget();
  const prevAuto = r.autoClear;
  const prevTone = r.toneMapping;
  const size = r.getSize(new THREE.Vector2());
  const hidden = world.hideOverlays();
  try {
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.setRenderTarget(null);
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k]!;
      const g = ground(f.east, f.north);
      const h = (f.headingDeg * Math.PI) / 180;
      frameCam.position.set(f.east, g + f.aglM, -f.north);
      frameCam.up.set(Math.sin(h), 0, -Math.cos(h));
      frameCam.lookAt(f.east, g, -f.north);
      frameCam.updateMatrixWorld();
      // Кадр — на холст (там тоновая компрессия и цвета как на экране), оттуда — в текстуру.
      r.setRenderTarget(null);
      r.toneMapping = prevTone;
      r.setViewport(0, 0, FW, FH);
      r.setScissor(0, 0, FW, FH);
      r.setScissorTest(true);
      r.autoClear = true;
      r.render(world.scene, frameCam);
      r.setScissorTest(false);
      r.setViewport(0, 0, size.x, size.y);
      r.copyFramebufferToTexture(scratch, new THREE.Vector2(0, 0));
      // Проекция кадра на рельеф под ним: сетка по углам кадра, высоты — с рельефа.
      const c = f.corners;
      const at = (u: number, v: number, i: 0 | 1) => {
        const a = c[0]![i] + (c[1]![i] - c[0]![i]) * u;
        const b = c[3]![i] + (c[2]![i] - c[3]![i]) * u;
        return a + (b - a) * v;
      };
      for (let j = 0; j <= GRID; j++) {
        for (let i = 0; i <= GRID; i++) {
          // Углы кадра — с запасом наружу: проекция сама отсечёт лишнее.
          const u = -0.1 + (1.2 * i) / GRID;
          const v = -0.1 + (1.2 * j) / GRID;
          const e = at(u, v, 0);
          const n = at(u, v, 1);
          const o = (j * (GRID + 1) + i) * 3;
          pos[o] = e;
          pos[o + 1] = ground(e, n);
          pos[o + 2] = -n;
        }
      }
      geo.attributes['position']!.needsUpdate = true;
      const u = mat.uniforms;
      (u['uFrameVP']!.value as THREE.Matrix4).multiplyMatrices(frameCam.projectionMatrix, frameCam.matrixWorldInverse);
      // Смаз — вдоль полёта, т. е. вдоль вертикали кадра (верх кадра — курс).
      (u['uBlur']!.value as THREE.Vector2).set(0, f.blurPx / cam.heightPx);
      u['uGain']!.value = f.reason?.includes('недодерж') ? 0.45 : f.reason?.includes('пересвет') ? 1.6 : 1;
      r.setRenderTarget(target);
      r.toneMapping = THREE.NoToneMapping;
      r.autoClear = false;
      r.render(mosaicScene, mosaicCam);
      if (k % 12 === 11) {
        opts.onProgress?.(0.05 + (0.9 * (k + 1)) / frames.length);
        r.setRenderTarget(null);
        await sleep(0);
      }
    }
    // Подложку — в картинку; строки WebGL идут снизу вверх.
    const px = new Uint8Array(MW * MH * 4);
    r.readRenderTargetPixels(target, 0, 0, MW, MH, px);
    const canvas = document.createElement('canvas');
    canvas.width = MW;
    canvas.height = MH;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(MW, MH);
    let empty = 0;
    let inside = 0;
    const inArea = pointInPolygon(area);
    for (let y = 0; y < MH; y++) {
      const src = (MH - 1 - y) * MW * 4;
      img.data.set(px.subarray(src, src + MW * 4), y * MW * 4);
      for (let x = 0; x < MW; x += 4) {
        if (!inArea(e0 + (x + 0.5) * pixelM, n1 - (y + 0.5) * pixelM)) continue;
        inside++;
        if (px[src + x * 4 + 3]! < 40) empty++;
      }
    }
    ctx.fillStyle = '#20252b';
    ctx.fillRect(0, 0, MW, MH);
    const tmp = document.createElement('canvas');
    tmp.width = MW;
    tmp.height = MH;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    // Граница участка.
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = Math.max(2, MW / 700);
    ctx.setLineDash([MW / 90, MW / 140]);
    ctx.beginPath();
    area.forEach((p, i) => {
      const x = (p.east - e0) / pixelM;
      const y = (n1 - p.north) / pixelM;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    opts.onProgress?.(1);
    return { canvas, bounds: { e0, n0, e1, n1 }, pixelM, gapShare: inside ? empty / inside : 0 };
  } finally {
    world.restoreOverlays(hidden);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.toneMapping = prevTone;
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    view.position.copy(saved.pos);
    view.quaternion.copy(saved.quat);
    view.up.set(0, 1, 0);
    view.updateMatrixWorld();
    target.dispose();
    scratch.dispose();
    mat.dispose();
    geo.dispose();
  }
}

function pointInPolygon(poly: readonly { east: number; north: number }[]): (e: number, n: number) => boolean {
  return (e, n) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.north > n !== b.north > n && e < ((b.east - a.east) * (n - a.north)) / (b.north - a.north) + a.east) inside = !inside;
    }
    return inside;
  };
}
