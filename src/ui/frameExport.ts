import { fromLocal } from '../sim/mission';
import type { Frame, SurveyCamera } from '../sim/survey';
import type { GeoPoint } from '../sim/types';
import { withExif } from '../game/exif';
import { zipParts, type ZipEntry } from '../game/zip';
import { cameraFovDeg } from './orthophoto';
import type { World } from './scene';

/*
 * Кадры съёмки для фотограмметрии (Agisoft Metashape, Pix4D, OpenDroneMap): каждый кадр — снимок
 * сцены камерой нагрузки из точки кадра, отвесно вниз, верх кадра — по курсу; в EXIF — координаты,
 * высота, фокусное расстояние и размер матрицы; рядом — reference.csv для «Импорта привязки»
 * Metashape и памятка. Смаз и недодержка — как у кадра: негодный кадр и в программе негодный.
 */

/** Ширина кадра, пикселей: для сшивки хватает, архив остаётся разумным (≈ 0,3–0,6 МБ на кадр). */
const FRAME_W = 2000;

export interface FrameExportInput {
  world: World;
  frames: readonly Frame[];
  cam: SurveyCamera;
  site: GeoPoint & { elevationM: number };
  /** Время начала полёта — для даты съёмки в EXIF. */
  startedAt: Date;
  make: string;
  onProgress?: (share: number) => void;
}

const csvNum = (v: number, d: number) => v.toFixed(d);

export async function exportFrames(o: FrameExportInput): Promise<{ blob: Blob; fileName: string; count: number }> {
  const { world, frames, cam } = o;
  const canvas = world.renderer.domElement;
  const aspect = cam.widthPx / cam.heightPx;
  // Кадр рисуется на холст 3D-вида (там тоновая компрессия и цвета как на экране); буфер холста на
  // время выгрузки — размером с кадр, как при записи видео (renderTo), на странице его не видно.
  const W = FRAME_W;
  const H = Math.round(W / aspect);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;
  const sensorW = (cam.widthPx * cam.pixelPitchUm) / 1000;
  const sensorH = (cam.heightPx * cam.pixelPitchUm) / 1000;
  const entries: ZipEntry[] = [];
  const csv = ['# label,longitude,latitude,altitude,yaw,pitch,roll,accuracy_xy,accuracy_z,ok,note'];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  // Снимает камера 3D-вида, поставленная в точку кадра: подробность рельефа, деревья и дома
  // подбираются вокруг неё. Её положение и угол зрения — вернуть после выгрузки.
  const view = world.camera;
  const saved = { pos: view.position.clone(), quat: view.quaternion.clone(), up: view.up.clone(), fov: view.fov, near: view.near };
  const hidden = world.hideOverlays();
  let pose = () => {};
  const shoot = () => {
    pose();
    world.render(0.016, false);
  };
  world.renderTo(W, H);
  try {
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k]!;
      const g = world.groundAt(f.east, f.north);
      const h = (f.headingDeg * Math.PI) / 180;
      pose = () => {
        view.fov = cameraFovDeg(cam);
        view.aspect = aspect;
        view.near = 1;
        view.updateProjectionMatrix();
        view.position.set(f.east, g + f.aglM, -f.north);
        view.up.set(Math.sin(h), 0, -Math.cos(h));
        view.lookAt(f.east, g, -f.north);
        view.updateMatrixWorld();
      };
      // Рельеф и снимки под кадром — детальные: несколько кадров подряд, пока тайлы догружаются.
      for (let i = 0; i < 40; i++) {
        shoot();
        if (i >= 2 && world.tilesLoading() === 0) break;
        await sleep(30);
      }
      // Холст без сохранения буфера: копия — сразу после отрисовки.
      shoot();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.drawImage(canvas, 0, 0, W, H);
      // Смаз вдоль полёта (вверх по кадру) — среднее сдвинутых копий; недодержка и пересвет — яркостью.
      const blur = (f.blurPx / cam.heightPx) * H;
      if (blur > 0.7) {
        const src = document.createElement('canvas');
        src.width = W;
        src.height = H;
        src.getContext('2d')!.drawImage(out, 0, 0);
        const n = 8;
        for (let i = 1; i <= n; i++) {
          ctx.globalAlpha = 1 / (i + 1);
          ctx.drawImage(src, 0, blur * (i / n - 0.5));
        }
        ctx.globalAlpha = 1;
      }
      const gain = f.reason?.includes('недодерж') ? 0.45 : f.reason?.includes('пересвет') ? 1.6 : 1;
      if (gain !== 1) {
        const src = document.createElement('canvas');
        src.width = W;
        src.height = H;
        src.getContext('2d')!.drawImage(out, 0, 0);
        ctx.filter = `brightness(${gain})`;
        ctx.drawImage(src, 0, 0);
        ctx.filter = 'none';
      }
      const jpeg = new Uint8Array(await (await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('кадр не закодировался'))), 'image/jpeg', 0.9))).arrayBuffer());
      const geo = fromLocal(o.site, f.east, f.north);
      const alt = g + o.site.elevationM + f.aglM;
      const name = `IMG_${String(k + 1).padStart(4, '0')}.JPG`;
      const date = new Date(o.startedAt.getTime() + f.t * 1000);
      entries.push({
        name: `images/${name}`,
        date,
        data: withExif(jpeg, {
          lat: geo.lat,
          lon: geo.lon,
          altM: alt,
          focalMm: cam.focalLengthMm,
          sensorWidthMm: sensorW,
          sensorHeightMm: sensorH,
          widthPx: W,
          heightPx: H,
          make: o.make,
          model: cam.name,
          date,
          headingDeg: f.headingDeg,
        }),
      });
      csv.push([name, csvNum(geo.lon, 8), csvNum(geo.lat, 8), csvNum(alt, 2), csvNum(((f.headingDeg % 360) + 360) % 360, 1), '0', '0', '3', '5', f.ok ? '1' : '0', (f.reason ?? '').replace(/[,\n]/g, ';')].join(','));
      o.onProgress?.((k + 1) / frames.length);
      if (k % 4 === 3) await sleep(0);
    }
  } finally {
    world.restoreOverlays(hidden);
    view.position.copy(saved.pos);
    view.quaternion.copy(saved.quat);
    view.up.copy(saved.up);
    view.fov = saved.fov;
    view.near = saved.near;
    world.endRenderTo();
    view.updateProjectionMatrix();
  }
  const enc = new TextEncoder();
  entries.push({ name: 'reference.csv', data: enc.encode(`${csv.join('\n')}\n`) });
  entries.push({
    name: 'README.txt',
    data: enc.encode(
      [
        'Кадры съёмки из тренажёра — для Agisoft Metashape, Pix4D, OpenDroneMap.',
        '',
        `Камера: ${cam.name}, фокус ${cam.focalLengthMm} мм, матрица ${sensorW.toFixed(2)} × ${sensorH.toFixed(2)} мм, кадр ${W} × ${H} пикселей.`,
        'Координаты и высота (над уровнем моря, WGS 84) — в EXIF каждого кадра и в reference.csv.',
        '',
        'Metashape: Workflow → Add Photos (папка images) — положение кадров берётся из EXIF.',
        'Уточнить привязку: Reference → Import Reference → reference.csv (запятая, столбцы: метка, долгота, широта, высота, yaw, pitch, roll; pitch 0 — отвесно вниз).',
        'Дальше — Align Photos, Build Point Cloud / DEM, Build Orthomosaic.',
        '',
        'Столбец ok = 0 — кадр негоден (смаз, недодержка, пересвет — см. note); его можно исключить.',
      ].join('\n'),
    ),
  });
  const stamp = o.startedAt.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { blob: new Blob(zipParts(entries) as BlobPart[], { type: 'application/zip' }), fileName: `survey-frames-${stamp}.zip`, count: frames.length };
}
