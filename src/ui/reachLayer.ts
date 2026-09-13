import L from 'leaflet';
import { fromLocal, toLocal } from '../sim/mission';
import type { NoReturn, ReachResult } from '../sim/reach';
import type { GeoPoint } from '../sim/types';

/*
 * Слой «Досягаемость» для карты (Map2D.setReach): заливка градиентом по кольцам запаса, контуры колец
 * с подписями, в полёте — точка невозврата по курсу и пунктир возврата домой.
 * Заливка — в своей панели под радиотенью (320): где связи нет, тёмная радиотень ложится поверх
 * досягаемости. Контуры и подписи — под зонами (350) и маршрутом (400). Щелчков слой не ловит.
 */

const FILL_PANE = 'reach';
const LINE_PANE = 'reachLines';
/** Контуры: запас 25 % и больше, 10 %, впритык, в один конец. */
const RING_COLOR = ['#4fd08a', '#c6e25a', '#ffc24d'];
const ONE_WAY_COLOR = '#ff5d5d';
const PNR_COLOR = '#ff5d5d';

const ll = (p: GeoPoint) => L.latLng(p.lat, p.lon);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtKm = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0).replace('.', ',')} км`;

const label = (text: string, color: string) =>
  L.divIcon({
    className: 'reach-label',
    html: `<span style="display:inline-block;transform:translate(-50%,-50%);white-space:nowrap;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,.6);border:1px solid ${color};color:${color};font:600 11px/1.35 system-ui,sans-serif;pointer-events:none">${esc(text)}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });

/** Цвет заливки по «номеру полосы» q: 0…1 — запас ≥ 25 %, 1…2 → 10 %, 2…3 → впритык, 3…4 — в один конец. */
function rampRgba(q: number): [number, number, number, number] | null {
  const mix = (a: number[], b: number[], f: number) => a.map((x, i) => Math.round(x + (b[i]! - x) * f));
  const green = [79, 208, 138];
  const lime = [198, 226, 90];
  const amber = [255, 194, 77];
  const red = [255, 93, 93];
  let rgb: number[];
  let alpha: number;
  if (q <= 1) [rgb, alpha] = [green, 50 + 20 * q];
  else if (q <= 2) [rgb, alpha] = [mix(green, lime, q - 1), 70];
  else if (q <= 3) [rgb, alpha] = [mix(lime, amber, q - 2), 75];
  else if (q <= 4) [rgb, alpha] = [red, 45 - 30 * (q - 3)];
  else return null;
  return [rgb[0]!, rgb[1]!, rgb[2]!, alpha];
}

export class ReachLayer {
  private readonly group = L.layerGroup();
  private image: L.ImageOverlay | null = null;
  private legend: L.Control | null = null;
  private readonly renderer: L.Renderer;

  constructor(private readonly map: L.Map) {
    for (const [name, z] of [
      [FILL_PANE, '315'],
      [LINE_PANE, '345'],
    ] as const) {
      const pane = map.getPane(name) ?? map.createPane(name);
      pane.style.zIndex = z;
      pane.style.pointerEvents = 'none';
    }
    this.renderer = L.svg({ pane: LINE_PANE, padding: 0.5 });
    this.group.addTo(map);
  }

  /** null — убрать. center — начало лучей (по умолчанию result.origin); noReturn — в полёте. */
  set(result: ReachResult | null, center?: GeoPoint, noReturn?: NoReturn | null) {
    this.group.clearLayers();
    this.image?.remove();
    this.image = null;
    this.legend?.remove();
    this.legend = null;
    if (!result) return;
    const origin = center ?? result.origin;
    this.drawFill(result, origin);

    const rings = result.rings;
    const style = (color: string, extra: L.PolylineOptions = {}): L.PolylineOptions => ({ renderer: this.renderer, pane: LINE_PANE, color, weight: 2, opacity: 0.9, interactive: false, ...extra });
    L.polygon(result.oneWay.polygon.map(ll), { ...style(ONE_WAY_COLOR, { weight: 1.5, dashArray: '6 5' }), fill: false }).addTo(this.group);
    rings.forEach((r, i) => {
      L.polygon(r.polygon.map(ll), { ...style(RING_COLOR[Math.min(i, RING_COLOR.length - 1)]!, { weight: r.margin <= 0 ? 2.5 : 1.5 }), fill: false }).addTo(this.group);
    });

    // Подписи — по направлению наибольшей дальности: там кольца дальше всего друг от друга.
    const k = result.bearingsDeg.indexOf(result.stats.maxBearingDeg);
    const at = (d: number) => {
      const b = (result.stats.maxBearingDeg * Math.PI) / 180;
      const l = toLocal(origin, result.origin);
      return fromLocal(origin, l.east + Math.sin(b) * d, l.north + Math.cos(b) * d);
    };
    rings.forEach((r, i) => {
      const color = RING_COLOR[Math.min(i, RING_COLOR.length - 1)]!;
      L.marker(ll(at(r.distanceM[k]!)), { pane: LINE_PANE, interactive: false, keyboard: false, icon: label(`${r.label} · ${fmtKm(r.distanceM[k]!)}`, color) }).addTo(this.group);
    });
    const one = result.oneWay.distanceM[k]!;
    if (one > rings[rings.length - 1]!.distanceM[k]! + 500) {
      L.marker(ll(at(one)), { pane: LINE_PANE, interactive: false, keyboard: false, icon: label(`${result.oneWay.label}${result.stats.clipped ? ' (дальше края)' : ''}`, ONE_WAY_COLOR) }).addTo(this.group);
    }

    if (noReturn) this.drawNoReturn(result, noReturn);
    this.drawLegend(result, noReturn ?? null);
  }

  /** Градиент: для каждой клетки — где она между кольцами на своём луче (интерполяция по углу). */
  private drawFill(result: ReachResult, origin: GeoPoint) {
    const o = toLocal(origin, result.origin);
    const n = result.bearingsDeg.length;
    const outer = result.oneWay.distanceM.map((d, i) => Math.max(d, result.rings[result.rings.length - 1]!.distanceM[i]!));
    let e0 = Infinity;
    let e1 = -Infinity;
    let n0 = Infinity;
    let n1 = -Infinity;
    outer.forEach((d, i) => {
      const b = (result.bearingsDeg[i]! * Math.PI) / 180;
      const x = o.east + Math.sin(b) * d;
      const y = o.north + Math.cos(b) * d;
      e0 = Math.min(e0, x);
      e1 = Math.max(e1, x);
      n0 = Math.min(n0, y);
      n1 = Math.max(n1, y);
    });
    if (!(e1 > e0 && n1 > n0)) return;
    const cell = Math.max(e1 - e0, n1 - n0) / 480;
    const cols = Math.max(1, Math.ceil((e1 - e0) / cell));
    const rows = Math.max(1, Math.ceil((n1 - n0) / cell));
    const bands = [...result.rings.map((r) => r.distanceM), result.oneWay.distanceM];
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(cols, rows);
    const radii = new Float64Array(bands.length);
    for (let j = 0; j < rows; j++) {
      const y = n1 - (j + 0.5) * cell - o.north;
      for (let i = 0; i < cols; i++) {
        const x = e0 + (i + 0.5) * cell - o.east;
        const r = Math.hypot(x, y);
        const f = ((((Math.atan2(x, y) * 180) / Math.PI + 360) % 360) / 360) * n;
        const a = Math.floor(f) % n;
        const b = (a + 1) % n;
        const u = f - Math.floor(f);
        let prev = 0;
        for (let q = 0; q < bands.length; q++) {
          // Кольца вложены: следующее не ближе предыдущего.
          prev = Math.max(prev, bands[q]![a]! * (1 - u) + bands[q]![b]! * u);
          radii[q] = prev;
        }
        let q = 0;
        let lo = 0;
        while (q < radii.length && r > radii[q]!) lo = radii[q++]!;
        if (q >= radii.length) continue;
        const hi = radii[q]!;
        const rgba = rampRgba(q + (hi > lo ? (r - lo) / (hi - lo) : 1));
        if (rgba) img.data.set(rgba, (j * cols + i) * 4);
      }
    }
    g.putImageData(img, 0, 0);
    const sw = fromLocal(origin, e0, n1 - rows * cell);
    const ne = fromLocal(origin, e0 + cols * cell, n1);
    this.image = L.imageOverlay(canvas.toDataURL(), L.latLngBounds(ll(sw), ll(ne)), { pane: FILL_PANE, interactive: false, className: 'reach-fill' }).addTo(this.map);
  }

  private drawNoReturn(result: ReachResult, p: NoReturn) {
    if (p.passed) {
      L.marker(ll(result.origin), { pane: LINE_PANE, interactive: false, keyboard: false, icon: label('точка невозврата пройдена — возврат только из резерва', PNR_COLOR) }).addTo(this.group);
      L.polyline([ll(result.origin), ll(result.home)], { renderer: this.renderer, pane: LINE_PANE, color: PNR_COLOR, weight: 2, dashArray: '6 6', interactive: false }).addTo(this.group);
      return;
    }
    if (!p.position) return;
    L.polyline(p.returnPath.map(ll), { renderer: this.renderer, pane: LINE_PANE, color: '#ffffff', weight: 2, opacity: 0.85, dashArray: '6 6', interactive: false }).addTo(this.group);
    L.polyline([ll(result.origin), ll(p.position)], { renderer: this.renderer, pane: LINE_PANE, color: PNR_COLOR, weight: 1.5, opacity: 0.7, dashArray: '2 5', interactive: false }).addTo(this.group);
    L.circleMarker(ll(p.position), { renderer: this.renderer, pane: LINE_PANE, radius: 10, color: PNR_COLOR, weight: 3, fill: false, interactive: false }).addTo(this.group);
    const min = Math.max(0, Math.floor(p.timeS / 60));
    L.marker(ll(p.position), {
      pane: LINE_PANE,
      interactive: false,
      keyboard: false,
      icon: label(`точка невозврата · запас на возврат ${min} мин · ${fmtKm(p.distanceM)}`, PNR_COLOR),
    }).addTo(this.group);
  }

  private drawLegend(result: ReachResult, p: NoReturn | null) {
    const s = result.stats;
    const rows = [
      `<b>Досягаемость</b> ${result.mode === 'plan' ? 'от площадки, полная АКБ' : 'от борта'} · резерв РЛЭ не тронут`,
      `<i style="background:#4fd08a"></i>туда и обратно с запасом · <i style="background:#ffc24d"></i>впритык · <i style="background:#ff5d5d"></i>в один конец`,
      `радиус ${fmtKm(s.minRadiusM)} (на ${Math.round(s.minBearingDeg)}°) … ${fmtKm(s.maxRadiusM)} (на ${Math.round(s.maxBearingDeg)}°)`,
      'тёмное — нет связи (радиотень)',
    ];
    if (p && !p.passed) rows.push(`на возврат отсюда ${Math.round(p.returnNowWh)} Вт·ч, сверх — ${Math.round(p.spareWh)} Вт·ч`);
    const Legend = L.Control.extend({
      onAdd: () => {
        const el = L.DomUtil.create('div', 'reach-legend');
        el.style.cssText = 'padding:4px 8px;border-radius:4px;background:rgba(0,0,0,.65);color:#e8eef2;font:11px/1.45 system-ui,sans-serif;pointer-events:none';
        // Кнопки НСУ лежат поверх карты слева — легенда правее них.
        const box = this.map.getContainer().getBoundingClientRect();
        const col = this.map.getContainer().parentElement?.querySelector('.col.left')?.getBoundingClientRect();
        if (col && col.right > box.left) el.style.marginLeft = `${Math.round(col.right - box.left + 6)}px`;
        el.innerHTML = rows
          .join('<br>')
          .replace(/<i style="background:([^"]+)"><\/i>/g, '<i style="display:inline-block;width:9px;height:9px;margin:0 4px 0 2px;border-radius:2px;background:$1"></i>');
        return el;
      },
    });
    this.legend = new Legend({ position: 'bottomleft' }).addTo(this.map);
  }
}
