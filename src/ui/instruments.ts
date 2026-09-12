import { LINK_GOOD_DB, LINK_LOST_DB } from '../sim/radio';

/** Авиагоризонт: небо и земля по тангажу и крену, шкала крена, силуэт аппарата. */
export function drawAttitude(ctx: CanvasRenderingContext2D, size: number, pitchDeg: number, bankDeg: number, headingDeg: number) {
  const r = size / 2;
  const pxPerDeg = size / 60;
  const bank = (bankDeg * Math.PI) / 180;
  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(r, r);
  ctx.rotate(-bank);
  const off = pitchDeg * pxPerDeg;
  ctx.fillStyle = '#3f8fd8';
  ctx.fillRect(-size, off - 2 * size, 2 * size, 2 * size);
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(-size, off, 2 * size, 2 * size);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-size, off);
  ctx.lineTo(size, off);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.round(size * 0.055)}px system-ui, sans-serif`;
  for (let p = -30; p <= 30; p += 5) {
    if (p === 0) continue;
    const y = off - p * pxPerDeg;
    const w = size * (p % 10 ? 0.06 : 0.14);
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    if (p % 10 === 0) ctx.fillText(String(Math.abs(p)), w + 4, y + 4);
  }
  ctx.restore();

  ctx.save();
  ctx.translate(r, r);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const t = ((a - 90) * Math.PI) / 180;
    const inner = r - (a % 30 === 0 ? 16 : 10);
    ctx.beginPath();
    ctx.moveTo(Math.cos(t) * (r - 4), Math.sin(t) * (r - 4));
    ctx.lineTo(Math.cos(t) * inner, Math.sin(t) * inner);
    ctx.stroke();
  }
  ctx.rotate(-bank);
  ctx.fillStyle = '#ffd23d';
  ctx.beginPath();
  ctx.moveTo(0, -r + 18);
  ctx.lineTo(-7, -r + 30);
  ctx.lineTo(7, -r + 30);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(r, r);
  ctx.strokeStyle = '#ffd23d';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-r * 0.55, 0);
  ctx.lineTo(-r * 0.18, 0);
  ctx.lineTo(-r * 0.1, r * 0.08);
  ctx.moveTo(r * 0.55, 0);
  ctx.lineTo(r * 0.18, 0);
  ctx.lineTo(r * 0.1, r * 0.08);
  ctx.stroke();
  ctx.fillStyle = '#ffd23d';
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(-30, r - 30, 60, 20);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(size * 0.07)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`${String(Math.round(((headingDeg % 360) + 360) % 360)).padStart(3, '0')}°`, 0, r - 15);
  ctx.restore();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.stroke();
}

export interface ProfileData {
  /** Расстояние вдоль маршрута, м. */
  dist: number[];
  /** Рельеф под маршрутом, м над морем. */
  terrain: number[];
  /** Плановая высота, м над морем. */
  plan: number[];
  /** Запас связи с НСУ на плановой высоте, дБ (radio.ts linkProfile) — плановая линия в цвете связи. */
  link?: number[];
  /** Наименьшая высота связи с НСУ, м над морем; null — не набирается. */
  minLinkAlt?: (number | null)[];
}

/** Цвет плановой высоты по запасу связи: хорошая, плохая, нет. */
const linkColor = (m: number | undefined) => (m === undefined || m >= LINK_GOOD_DB ? '#ff8a1a' : m >= LINK_LOST_DB ? '#d9a400' : '#e02020');

/** Профиль маршрута: рельеф, плановая высота и положение аппарата. */
export function drawProfile(ctx: CanvasRenderingContext2D, w: number, h: number, d: ProfileData, aircraft: { dist: number; alt: number } | null) {
  ctx.clearRect(0, 0, w, h);
  if (d.dist.length < 2) return;
  const pad = { l: 44, r: 8, t: 8, b: 20 };
  const total = d.dist[d.dist.length - 1]!;
  const lo = Math.min(...d.terrain) - 20;
  const base = Math.max(...d.plan, ...d.terrain, aircraft?.alt ?? -Infinity) + 30;
  // Высота связи тянет шкалу вверх не больше чем на 60 % — выше линия уходит за край.
  const linkTop = Math.max(-Infinity, ...(d.minLinkAlt ?? []).filter((a): a is number => a !== null)) + 30;
  const hi = Math.max(base, Math.min(linkTop, base + 0.6 * (base - lo)));
  const x = (m: number) => pad.l + ((w - pad.l - pad.r) * m) / total;
  const y = (a: number) => h - pad.b - ((h - pad.t - pad.b) * (a - lo)) / (hi - lo);

  ctx.fillStyle = '#f3f3f3';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ddd';
  ctx.fillStyle = '#666';
  ctx.font = '10px system-ui, sans-serif';
  const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / 3)));
  for (let a = Math.ceil(lo / step) * step; a <= hi; a += step) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(a));
    ctx.lineTo(w - pad.r, y(a));
    ctx.stroke();
    ctx.fillText(`${a} м`, 4, y(a) + 3);
  }
  ctx.fillText(`${(total / 1000).toFixed(1)} км`, w - 44, h - 5);

  ctx.fillStyle = '#9c7b55';
  ctx.beginPath();
  ctx.moveTo(x(0), h - pad.b);
  d.dist.forEach((m, i) => ctx.lineTo(x(m), y(d.terrain[i]!)));
  ctx.lineTo(x(total), h - pad.b);
  ctx.closePath();
  ctx.fill();

  // Наименьшая высота связи с НСУ — пунктир; ниже него связи нет.
  if (d.minLinkAlt?.some((a) => a !== null)) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
    ctx.clip();
    ctx.strokeStyle = '#2f7de1';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let open = false;
    d.dist.forEach((m, i) => {
      const a = d.minLinkAlt![i];
      if (a === null || a === undefined) return void (open = false);
      if (open) ctx.lineTo(x(m), y(a));
      else ctx.moveTo(x(m), y(a));
      open = true;
    });
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#2f7de1';
    ctx.fillText('┄ связь с НСУ выше', pad.l + 4, pad.t + 10);
  }

  // Плановая высота в цвете связи: оранжевая — хорошая, жёлтая — плохая, красная — нет.
  ctx.lineWidth = 2;
  for (let i = 1; i < d.dist.length; i++) {
    ctx.strokeStyle = linkColor(d.link?.[i - 1]);
    ctx.beginPath();
    ctx.moveTo(x(d.dist[i - 1]!), y(d.plan[i - 1]!));
    ctx.lineTo(x(d.dist[i]!), y(d.plan[i]!));
    ctx.stroke();
  }

  if (aircraft) {
    ctx.fillStyle = '#e02020';
    ctx.beginPath();
    ctx.arc(x(Math.min(total, aircraft.dist)), y(aircraft.alt), 5, 0, Math.PI * 2);
    ctx.fill();
  }
}
