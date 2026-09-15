import L from 'leaflet';
import type { RoutePoint } from '../game/scenarios';
import { fromLocal } from '../sim/mission';
import type { Coverage, Frame } from '../sim/survey';
import type { GeoPoint, Site } from '../sim/types';
import { makeZoneId, prepareZones, ZONE_TITLE, zoneContour, zoneLabel, type Zone, type ZoneKind } from '../sim/zones';
import { LINK_GOOD_DB, LINK_LOST_DB, RADIO, type LinkStatus, type RadioCoverage, type Relay } from '../sim/radio';
import type { WindFieldGrid, WindHazard } from '../sim/terrainWind';
import { mercatorToGeo } from '../sim/terrain';
import { layerCovers } from './packFormat';
import { contourStepM, hillshade, reliefRgb } from './reliefTint';
import { decodeTerrarium } from './terrainData';
import { activePack, activePackNow, attribution, imageryFallback, imagerySource, packImageryUrl, packImageryZooms, terrainTile, tileEnv } from './tileSource';
import type { NoReturn, ReachResult } from '../sim/reach';
import { ReachLayer } from './reachLayer';

/** Площадка с оценкой ветра у рельефа (terrainWind.ts windHazardAt) — кружок по уровню опасности. */
export interface WindSiteMark {
  position: GeoPoint;
  label: string;
  hazard: WindHazard;
}
/** Уровень опасности у площадки: спокойно, внимание, опасно. */
const HAZARD_COLOR = (level: number) => (level < 0.3 ? '#4fd08a' : level < 0.6 ? '#ffc24d' : '#ff5d5d');

/** Ретранслятор без места: наземный на мачте или на аппарате-ретрансляторе на высоте над морем. */
export type RelayTemplate = { kind: 'ground'; antennaM?: number } | { kind: 'air'; altitudeM: number };
/** Линия НСУ → борт по состоянию связи. */
export const LINK_COLOR: Record<LinkStatus, string> = { good: '#4fd08a', poor: '#ffc24d', lost: '#ff5d5d' };
const RELAY_COLOR = '#35d0ff';

const relayText = (r: Relay | RelayTemplate) => (r.kind === 'air' ? `на аппарате, ${Math.round(r.altitudeM)} м над морем` : `мачта ${Math.round(r.antennaM ?? RADIO.groundAntennaM)} м`);

/** Значок ретранслятора: вышка и номер. */
const relayIcon = (label: string) =>
  L.divIcon({
    className: 'relay-pin',
    html: `<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;pointer-events:auto"><span style="padding:0 4px;border-radius:3px;background:rgba(0,0,0,.65);border:1px solid ${RELAY_COLOR};color:${RELAY_COLOR};font:700 11px/1.4 system-ui,sans-serif">${esc(label)}</span><svg width="18" height="20" viewBox="0 0 18 20"><path d="M9 3 4 19M9 3l5 16M6 13h6M9 3v0" stroke="${RELAY_COLOR}" stroke-width="2" fill="none"/><circle cx="9" cy="3" r="2.5" fill="${RELAY_COLOR}"/></svg></div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });

/** Идёт установка ретранслятора. */
interface RelayPlace {
  template: RelayTemplate;
  onDone: (relay: Relay) => void;
  onCancel?: () => void;
  hint: L.Marker | null;
}

/** Цвета зон: запретная — красная, РЭБ — фиолетовая, пурпурная, жёлтая. */
export const ZONE_COLOR: Record<ZoneKind, string> = {
  nofly: '#ff3b3b',
  'gnss-jam': '#a45cff',
  'gnss-spoof': '#ff5fd2',
  'link-jam': '#ffc933',
};
/** Круг меньше — второй щелчок не принимается (случайный двойной щелчок). */
const MIN_ZONE_RADIUS_M = 30;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtM = (m: number) => (m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1).replace('.', ',')} км`);
const geo = (p: L.LatLng): GeoPoint => ({ lat: p.lat, lon: p.lng });

/** Подпись поверх карты без стилей из style.css: всё внутри. */
const labelIcon = (text: string, color: string) =>
  L.divIcon({
    className: 'zone-label',
    html: `<span style="display:inline-block;transform:translate(-50%,-50%);white-space:nowrap;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,.6);border:1px solid ${color};color:${color};font:600 11px/1.35 system-ui,sans-serif;pointer-events:none">${esc(text)}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });

function zoneTooltip(z: Zone): string {
  const h = z.floorM !== undefined || z.ceilingM !== undefined ? `<br>${z.floorM !== undefined ? `от ${Math.round(z.floorM)} м` : 'от земли'} ${z.ceilingM !== undefined ? `до ${Math.round(z.ceilingM)} м` : 'без потолка'} над уровнем моря` : '';
  const size = z.center && z.radiusM ? `<br>радиус ${fmtM(z.radiusM)}` : '';
  return `<b>${esc(zoneLabel(z))}</b>${z.name ? `<br>${ZONE_TITLE[z.kind]}` : ''}${size}${h}<br><i>правый щелчок — действия</i>`;
}

function centroid(pts: GeoPoint[]): GeoPoint {
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
}

/** Штриховка запретной зоны — узор в defs того же SVG, что рисует зоны. */
function hatch(path: L.Path, color: string) {
  const el = path.getElement() as SVGPathElement | undefined;
  const svg = el?.ownerSVGElement;
  if (!el || !svg) return;
  const id = `zone-hatch-${color.replace(/[^0-9a-z]/gi, '')}`;
  if (!svg.querySelector(`#${id}`)) {
    const NS = 'http://www.w3.org/2000/svg';
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(NS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    const pat = document.createElementNS(NS, 'pattern');
    pat.setAttribute('id', id);
    pat.setAttribute('patternUnits', 'userSpaceOnUse');
    pat.setAttribute('width', '10');
    pat.setAttribute('height', '10');
    pat.setAttribute('patternTransform', 'rotate(45)');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', '10');
    bg.setAttribute('height', '10');
    bg.setAttribute('fill', color);
    bg.setAttribute('fill-opacity', '0.1');
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', '0');
    line.setAttribute('y2', '10');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '3');
    line.setAttribute('stroke-opacity', '0.5');
    pat.append(bg, line);
    defs.appendChild(pat);
  }
  el.setAttribute('fill', `url(#${id})`);
  el.setAttribute('fill-opacity', '1');
}

/** Идёт рисование зоны. */
interface ZoneDraw {
  kind: ZoneKind;
  shape: 'circle' | 'polygon';
  onDone: (zone: Zone) => void;
  onCancel?: () => void;
  pts: L.LatLng[];
  preview: L.LayerGroup;
  dblZoom: boolean;
}

// Снимки — с двух серверов Esri: по HTTP/1.1 браузер держит 6 соединений на сервер, и с одним
// сервером карта отнимала бы их у рельефа 3D-вида (terrainLod.ts грузит с тех же двух).
const IMAGERY = 'https://{s}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS = 'https://{s}.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_HOSTS = ['server', 'services'];
const ll = (p: GeoPoint) => L.latLng(p.lat, p.lon);

/**
 * Подложка-снимки: тайл из пакета района, если пакет его покрывает, иначе Esri по сети. Без сети —
 * тайлы только из пакета; где своего нет — участок ближайшего предка из пакета, а где нет и его —
 * прозрачно (под ним тонированный рельеф).
 */
class ImageryLayer extends L.TileLayer {
  constructor(options: L.TileLayerOptions) {
    super(IMAGERY, { ...options, subdomains: ESRI_HOSTS });
    // Тайла в пакете не оказалось — один раз в сеть, если она есть.
    this.on('tileerror', (e: L.TileErrorEvent) => {
      const img = e.tile as HTMLImageElement;
      if (img.dataset['pack'] && imageryFallback()) {
        delete img.dataset['pack'];
        img.src = L.Util.template(IMAGERY, { s: ESRI_HOSTS[hostOf(e.coords)], x: e.coords.x, y: e.coords.y, z: e.coords.z });
      }
    });
  }

  override getTileUrl(c: L.Coords): string {
    return imagerySource(c.z, c.x, c.y) === 'pack' ? packImageryUrl(c.z, c.x, c.y) : super.getTileUrl(c);
  }

  override createTile(c: L.Coords, done: L.DoneCallback): HTMLElement {
    const src = imagerySource(c.z, c.x, c.y);
    if (src) {
      const img = super.createTile(c, done) as HTMLImageElement;
      if (src === 'pack') img.dataset['pack'] = '1';
      return img;
    }
    return ancestorTile(c, done);
  }
}

const hostOf = (c: L.Coords) => (c.x + c.y) % ESRI_HOSTS.length;

/** Без сети, тайла в пакете нет: участок снимка ближайшего предка из пакета или пусто. */
function ancestorTile(c: L.Coords, done: L.DoneCallback): HTMLElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const zs = packImageryZooms();
  let found: { z: number; x: number; y: number; k: number } | null = null;
  for (let z = Math.min(c.z - 1, zs?.max ?? -1); zs && z >= zs.min; z--) {
    const k = 2 ** (c.z - z);
    const x = Math.floor(c.x / k);
    const y = Math.floor(c.y / k);
    if (imagerySource(z, x, y) === 'pack') {
      found = { z, x, y, k };
      break;
    }
  }
  if (!found) {
    setTimeout(() => done(undefined, canvas));
    return canvas;
  }
  const a = found;
  const img = new Image();
  img.onload = () => {
    const s = 256 / a.k;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (c.x - a.x * a.k) * s, (c.y - a.y * a.k) * s, s, s, 0, 0, 256, 256);
    done(undefined, canvas);
  };
  img.onerror = () => done(undefined, canvas);
  img.src = packImageryUrl(a.z, a.x, a.y);
  return canvas;
}

/** Высоты тайлов рельефа для карты: последние декодированные (по 256 КБ). */
const reliefHeights = new Map<string, Promise<Float32Array | null>>();
function heightsOf(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = reliefHeights.get(key);
  if (p) reliefHeights.delete(key);
  else
    p = terrainTile(z, x, y)
      .then((t) => decodeTerrarium(t.blob))
      .then((h) => (h.length === 256 * 256 ? h : null))
      .catch(() => null);
  reliefHeights.set(key, p);
  if (reliefHeights.size > 64) reliefHeights.delete(reliefHeights.keys().next().value!);
  return p;
}

/**
 * Тонированный рельеф тайла карты (z, x, y) из высот пакета: цвет по высоте и склону, отмывка
 * с северо-запада, горизонтали. Крупнее уровней пакета — участок его тайла с билинейной
 * интерполяцией. null — рельефа здесь нет.
 */
async function reliefImage(z: number, x: number, y: number): Promise<ImageData | null> {
  const terrain = activePackNow()?.manifest.terrain;
  if (!terrain) return null;
  let tz = -1;
  for (const q of terrain.zooms) if (q <= z) tz = q;
  if (tz < 0) return null;
  const k = 2 ** (z - tz);
  const px = Math.floor(x / k);
  const py = Math.floor(y / k);
  if (!layerCovers(terrain, tz, px, py)) return null;
  const src = await heightsOf(tz, px, py);
  if (!src) return null;
  const S = 256;
  const W = S + 2;
  const H = new Float32Array(W * W);
  const ox = ((x - px * k) * S) / k;
  const oy = ((y - py * k) * S) / k;
  const at = (i: number, j: number) => src[Math.max(0, Math.min(S - 1, j)) * S + Math.max(0, Math.min(S - 1, i))]!;
  for (let j = -1; j <= S; j++) {
    const v = oy + (j + 0.5) / k - 0.5;
    const j0 = Math.floor(v);
    const fv = v - j0;
    for (let i = -1; i <= S; i++) {
      const u = ox + (i + 0.5) / k - 0.5;
      const i0 = Math.floor(u);
      const fu = u - i0;
      const top = at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu;
      const bottom = at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu;
      H[(j + 1) * W + i + 1] = top * (1 - fv) + bottom * fv;
    }
  }
  const lat = mercatorToGeo((x + 0.5) * 256, (y + 0.5) * 256, z).lat;
  const mpp = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);
  const step = contourStepM(z);
  const img = new ImageData(S, S);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const c = (j + 1) * W + i + 1;
      const e = H[c]!;
      const dzdx = (H[c + 1]! - H[c - 1]!) / (2 * mpp);
      const dzdy = (H[c + W]! - H[c - W]!) / (2 * mpp);
      reliefRgb(e, Math.hypot(dzdx, dzdy), rgb);
      let f = 0.3 + 0.98 * hillshade(dzdx, dzdy);
      // Горизонталь — где соседний пиксель справа или снизу уже в другом слое; каждая пятая — жирнее.
      const band = Math.floor(e / step);
      const right = Math.floor(H[c + 1]! / step);
      const below = Math.floor(H[c + W]! / step);
      if (band !== right || band !== below) f *= Math.max(band, right, below) % 5 === 0 ? 0.62 : 0.8;
      const o = (j * S + i) * 4;
      img.data[o] = rgb[0] * f;
      img.data[o + 1] = rgb[1] * f;
      img.data[o + 2] = rgb[2] * f;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

/** Без сети и без рельефа: ровный фон и сетка по границам тайлов. */
function emptyTile(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#e3e5e0';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#c3c7bf';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 256, 256);
}

/** Тонированный рельеф пакета — подложка карты без сети. */
class ReliefLayer extends L.GridLayer {
  override createTile(c: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    void reliefImage(c.z, c.x, c.y).then((img) => {
      const ctx = canvas.getContext('2d')!;
      if (img) ctx.putImageData(img, 0, 0);
      else emptyTile(ctx);
      done(undefined, canvas);
    });
    return canvas;
  }
}

/** Точка маршрута с подписью высоты — как в НСУ. */
export interface Pin {
  position: GeoPoint;
  label: string;
  altitudeM: number | null;
}

export interface LegLabel {
  position: GeoPoint;
  text: string;
}

const pinIcon = (label: string, altitudeM: number | null, cls = '') =>
  L.divIcon({
    className: `wp-pin ${cls}`,
    html: `${altitudeM === null ? '' : `<span class="alt">${Math.round(altitudeM)} м</span>`}<b>${label}</b>`,
    iconSize: [30, 44],
    iconAnchor: [15, 42],
  });

/**
 * Карта со спутниковой подложкой: участок, маршрут, точки оператора, пункт доставки,
 * борт, след, кадры, покрытие. Пока editing включён, участок, точки и пункт доставки
 * можно двигать.
 */
export class Map2D {
  readonly map: L.Map;
  follow = false;
  onAreaChange: ((area: GeoPoint[]) => void) | null = null;
  onClick: ((p: GeoPoint) => void) | null = null;
  onRouteChange: ((points: RoutePoint[]) => void) | null = null;
  onDestinationChange: ((p: GeoPoint) => void) | null = null;
  /** Правый щелчок по зоне (не во время рисования): id зоны — удалить или изменить. */
  onZoneContext: ((id: string) => void) | null = null;
  /** Правый щелчок по ретранслятору: его номер в списке setRelays — удалить. */
  onRelayContext: ((index: number) => void) | null = null;
  private readonly relayLayer = L.layerGroup();
  private relayPlace: RelayPlace | null = null;
  private radioShadow: L.ImageOverlay | null = null;
  /** Ветер у рельефа: заливка, стрелки (своя панель) и площадки. */
  private windImage: L.ImageOverlay | null = null;
  private readonly windLayer = L.layerGroup();
  private readonly windRenderer: L.Renderer;
  private readonly linkLine: L.Polyline;
  private linkBlock: L.CircleMarker | null = null;
  private readonly renderer = L.canvas({ padding: 0.5 });
  /** Зоны — в своей панели под маршрутом, в SVG (для штриховки). */
  private readonly zoneRenderer: L.Renderer;
  private readonly zoneLayer = L.layerGroup();
  private zonesShown: Zone[] = [];
  private draw: ZoneDraw | null = null;
  private area: L.Polygon | null = null;
  private vertices: L.Marker[] = [];
  private readonly route = L.layerGroup();
  private readonly marks = L.layerGroup();
  private readonly editLayer = L.layerGroup();
  private readonly frames = L.layerGroup();
  private coverage: L.ImageOverlay | null = null;
  private readonly trail: L.Polyline;
  private readonly trackVector: L.Polyline;
  private readonly aircraft: L.Marker;
  private target: L.Marker | null = null;
  private dest: L.Marker | null = null;
  private editPoints: RoutePoint[] = [];
  private routeMarkers: L.Marker[] = [];
  private edit = { area: true, route: true, destination: true };

  constructor(el: HTMLElement, site: Site) {
    this.map = L.map(el, { zoomControl: false, preferCanvas: true, maxZoom: 19 }).setView(ll(site), 13);
    // Подложка — когда известно, есть ли пакет района (к этому времени обычно уже известно).
    void activePack().then(() => this.addBaseLayers());
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(this.map);
    this.map.createPane('zones').style.zIndex = '350';
    this.zoneRenderer = L.svg({ pane: 'zones', padding: 0.5 });
    this.zoneLayer.addTo(this.map);
    // Радиотень — под зонами, над подложкой.
    this.map.createPane('radioShadow').style.zIndex = '320';
    // Ветер у рельефа — над радиотенью, под зонами; щелчков не ловит.
    const windPane = this.map.createPane('wind');
    windPane.style.zIndex = '330';
    windPane.style.pointerEvents = 'none';
    this.windRenderer = L.canvas({ pane: 'wind', padding: 0.5 });
    this.windLayer.addTo(this.map);
    this.linkLine = L.polyline([], { renderer: this.renderer, weight: 2, opacity: 0.9, interactive: false }).addTo(this.map);
    this.relayLayer.addTo(this.map);
    this.frames.addTo(this.map);
    this.route.addTo(this.map);
    this.editLayer.addTo(this.map);
    this.trail = L.polyline([], { color: '#00e5ff', weight: 2, renderer: this.renderer, interactive: false }).addTo(this.map);
    this.trackVector = L.polyline([], { color: '#ffffff', weight: 2, dashArray: '4 4', renderer: this.renderer, interactive: false }).addTo(this.map);
    L.marker(ll(site), {
      icon: L.divIcon({ className: 'home-pin', html: '<div>А</div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
      interactive: false,
    }).addTo(this.map);
    this.aircraft = L.marker(ll(site), {
      icon: L.divIcon({
        className: 'ac-icon',
        html: '<div class="ac"><svg viewBox="0 0 24 24"><path d="M12 1 20 21 12 16 4 21Z"/></svg></div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(this.map);
    // Пока рисуется зона или ставится ретранслятор, щелчки идут им, а не маршруту.
    this.map.on('click', (e: L.LeafletMouseEvent) =>
      this.draw ? this.drawClick(e.latlng) : this.relayPlace ? this.relayClick(e.latlng) : this.onClick?.({ lat: e.latlng.lat, lon: e.latlng.lng }),
    );
    this.map.on('zoomend', () => this.updateMarks());
  }

  /**
   * С сетью — снимки (из пакета, где он их покрывает, иначе Esri) и подписи Esri, как прежде.
   * Без сети — тонированный рельеф пакета (вне его — пусто с сеткой) и поверх снимки пакета, если есть.
   */
  private addBaseLayers() {
    const offline = tileEnv().offline;
    const a = attribution();
    if (offline) new ReliefLayer({ maxZoom: 19, attribution: a.terrain }).addTo(this.map);
    const zs = packImageryZooms();
    if (!offline || zs) new ImageryLayer({ maxZoom: 19, maxNativeZoom: offline ? zs!.max : 19, attribution: a.imagery ?? '' }).addTo(this.map);
    if (!offline) L.tileLayer(LABELS, { maxZoom: 19, maxNativeZoom: 19, subdomains: ESRI_HOSTS }).addTo(this.map);
  }

  invalidate() {
    this.map.invalidateSize();
  }

  fit(points: GeoPoint[]) {
    if (points.length) this.map.fitBounds(L.latLngBounds(points.map(ll)).pad(0.15), { maxZoom: 15 });
  }

/** Можно ли двигать участок, точки маршрута и пункт доставки (маршрут — и в полёте). */
  setEditing(on: boolean | { area: boolean; route: boolean; destination: boolean }) {
    this.edit = typeof on === 'boolean' ? { area: on, route: on, destination: on } : { ...on };
    const toggle = (m: L.Marker, ok: boolean) => (ok ? m.dragging?.enable() : m.dragging?.disable());
    for (const m of this.vertices) toggle(m, this.edit.area);
    for (const m of this.routeMarkers) toggle(m, this.edit.route);
    if (this.dest) toggle(this.dest, this.edit.destination);
  }

  /** Участок съёмки; null — участка нет. */
  setArea(area: GeoPoint[] | null) {
    this.area?.remove();
    this.area = null;
    for (const m of this.vertices) m.remove();
    this.vertices = [];
    if (!area) return;
    this.area = L.polygon(area.map(ll), {
      color: '#ffffff',
      weight: 2,
      dashArray: '6 4',
      fillColor: '#3aa0ff',
      fillOpacity: 0.12,
      renderer: this.renderer,
      interactive: false,
    }).addTo(this.map);
    for (const p of area) {
      const m = L.marker(ll(p), {
        draggable: true,
        icon: L.divIcon({ className: 'vertex', iconSize: [14, 14], iconAnchor: [7, 7] }),
        title: 'Перетащите, чтобы изменить участок',
      }).addTo(this.map);
      if (!this.edit.area) m.dragging?.disable();
      m.on('drag', () => this.area?.setLatLngs(this.vertices.map((v) => v.getLatLng())));
      m.on('dragend', () => this.onAreaChange?.(this.vertices.map((v) => ({ lat: v.getLatLng().lat, lon: v.getLatLng().lng }))));
      this.vertices.push(m);
    }
  }

  /** Точки маршрута оператора: перетаскивание — сдвиг, правый щелчок — удалить. */
  setEditableRoute(points: RoutePoint[] | null) {
    this.editLayer.clearLayers();
    this.routeMarkers = [];
    this.editPoints = points ? points.map((p) => ({ ...p })) : [];
    if (!points) return;
    points.forEach((p, i) => {
      const m = L.marker(ll(p), {
        draggable: true,
        icon: pinIcon(String(i + 1), p.heightAglM, 'edit'),
        title: 'Перетащите — сдвинуть, правый щелчок — удалить',
        zIndexOffset: 400,
      }).addTo(this.editLayer);
      if (!this.edit.route) m.dragging?.disable();
      m.on('dragend', () => {
        const q = m.getLatLng();
        this.editPoints[i] = { ...this.editPoints[i]!, lat: q.lat, lon: q.lng };
        this.onRouteChange?.(this.editPoints.map((x) => ({ ...x })));
      });
      m.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        if (!this.edit.route) return;
        this.onRouteChange?.(this.editPoints.filter((_, k) => k !== i).map((x) => ({ ...x })));
      });
      this.routeMarkers.push(m);
    });
  }

  /** Пункт доставки «Б»; его можно перетащить. */
  setDestination(p: GeoPoint | null) {
    this.dest?.remove();
    this.dest = null;
    if (!p) return;
    const m = L.marker(ll(p), {
      draggable: true,
      icon: L.divIcon({ className: 'dest-pin', html: '<div>Б</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: 'Пункт доставки — можно перетащить',
      zIndexOffset: 500,
    }).addTo(this.map);
    if (!this.edit.destination) m.dragging?.disable();
    m.on('dragend', () => this.onDestinationChange?.({ lat: m.getLatLng().lat, lon: m.getLatLng().lng }));
    this.dest = m;
  }

  setRoute(path: GeoPoint[], pins: Pin[], labels: LegLabel[]) {
    this.route.clearLayers();
    this.marks.clearLayers();
    L.polyline(path.map(ll), { color: '#ff9a1a', weight: 3, opacity: 0.95, renderer: this.renderer, interactive: false }).addTo(this.route);
    for (const p of pins) L.marker(ll(p.position), { icon: pinIcon(p.label, p.altitudeM), interactive: false }).addTo(this.marks);
    for (const l of labels) {
      L.marker(ll(l.position), {
        icon: L.divIcon({ className: 'leg-label', html: `<span>${l.text}</span>`, iconSize: [64, 18], iconAnchor: [32, 9] }),
        interactive: false,
      }).addTo(this.marks);
    }
    this.updateMarks();
  }

  /** Номера точек и длины участков — только при крупном масштабе, иначе они слипаются. */
  private updateMarks() {
    const show = this.map.getZoom() >= 13;
    if (show && !this.map.hasLayer(this.marks)) this.marks.addTo(this.map);
    if (!show && this.map.hasLayer(this.marks)) this.marks.remove();
  }

  clearFrames() {
    this.frames.clearLayers();
  }

  addFrame(f: Frame, site: GeoPoint) {
    L.polygon(
      f.corners.map(([e, n]) => ll(fromLocal(site, e, n))),
      { color: f.ok ? '#7dffa8' : '#ff5d5d', weight: 1, fill: false, renderer: this.renderer, interactive: false },
    ).addTo(this.frames);
  }

  /** Карта покрытия поверх участка; null — убрать. */
  setCoverage(cov: Coverage | null, site?: GeoPoint) {
    this.coverage?.remove();
    this.coverage = null;
    if (!cov || !site) return;
    const canvas = document.createElement('canvas');
    canvas.width = cov.cols;
    canvas.height = cov.rows;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(cov.cols, cov.rows);
    for (let j = 0; j < cov.rows; j++) {
      for (let i = 0; i < cov.cols; i++) {
        const k = j * cov.cols + i;
        if (!cov.inside[k]) continue;
        const c = cov.counts[k]!;
        const rgb = c >= 5 ? [79, 208, 138] : c >= 3 ? [255, 194, 77] : c >= 1 ? [255, 93, 93] : [130, 20, 20];
        img.data.set([rgb[0]!, rgb[1]!, rgb[2]!, 160], ((cov.rows - 1 - j) * cov.cols + i) * 4);
      }
    }
    g.putImageData(img, 0, 0);
    const sw = fromLocal(site, cov.e0, cov.n0);
    const ne = fromLocal(site, cov.e0 + cov.cols * cov.cellM, cov.n0 + cov.rows * cov.cellM);
    this.coverage = L.imageOverlay(canvas.toDataURL(), L.latLngBounds(ll(sw), ll(ne)), { opacity: 0.85, interactive: false, className: 'coverage' }).addTo(this.map);
  }

  /** Борт: значок по курсу, линия — вектор путевой скорости на 30 с вперёд (виден снос). */
  setAircraft(p: GeoPoint, headingDeg: number, trackAhead?: GeoPoint) {
    this.trackVector.setLatLngs(trackAhead ? [ll(p), ll(trackAhead)] : []);
    this.aircraft.setLatLng(ll(p));
    const el = this.aircraft.getElement()?.querySelector<HTMLElement>('.ac');
    if (el) el.style.transform = `rotate(${headingDeg}deg)`;
    if (this.follow) this.map.panTo(ll(p), { animate: false });
  }

  resetTrail() {
    this.trail.setLatLngs([]);
  }

  appendTrail(p: GeoPoint) {
    this.trail.addLatLng(ll(p));
  }

  setTarget(p: GeoPoint | null) {
    this.target?.remove();
    this.target = null;
    if (!p) return;
    this.target = L.marker(ll(p), {
      icon: L.divIcon({ className: 'target-pin', html: '<div></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      interactive: false,
    }).addTo(this.map);
  }

  private searchLayer: L.LayerGroup | null = null;

  /**
   * Отметки поиска людей: человек найден — зелёная, зверь (ложная тревога) — оранжевая, пусто —
   * серый ромб; подпись — во всплывающей подсказке. Пусто или null — убрать.
   */
  setSearchMarks(marks: readonly { lat: number; lon: number; result: 'person' | 'animal' | 'empty'; label: string }[] | null) {
    this.searchLayer?.remove();
    this.searchLayer = null;
    if (!marks?.length) return;
    this.searchLayer = L.layerGroup(
      marks.map((m) =>
        L.marker(ll(m), {
          icon: L.divIcon({ className: `search-mark ${m.result}`, html: '<div></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
          keyboard: false,
        }).bindTooltip(m.label, { direction: 'top', offset: [0, -8] }),
      ),
    ).addTo(this.map);
  }

  zoom(delta: number) {
    this.map.setZoom(this.map.getZoom() + delta);
  }

  /* --------------------------------- Связь --------------------------------- */

  /**
   * Радиотень (radio.ts coverageSteps): где на высоте сетки связи с НСУ нет — тёмная заливка,
   * где плохая — жёлтая, где хорошая — ничего. null — убрать. origin — начало локальных координат сетки.
   */
  setRadioShadow(cov: RadioCoverage | null, origin?: GeoPoint) {
    this.radioShadow?.remove();
    this.radioShadow = null;
    if (!cov || !origin) return;
    const canvas = document.createElement('canvas');
    canvas.width = cov.cols;
    canvas.height = cov.rows;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(cov.cols, cov.rows);
    for (let j = 0; j < cov.rows; j++) {
      for (let i = 0; i < cov.cols; i++) {
        const m = cov.marginDb[j * cov.cols + i]!;
        if (m >= LINK_GOOD_DB) continue;
        const rgba = m < LINK_LOST_DB ? [20, 16, 40, 150] : [255, 190, 60, 70];
        img.data.set(rgba, ((cov.rows - 1 - j) * cov.cols + i) * 4);
      }
    }
    g.putImageData(img, 0, 0);
    const sw = fromLocal(origin, cov.e0, cov.n0);
    const ne = fromLocal(origin, cov.e0 + cov.cols * cov.cellM, cov.n0 + cov.rows * cov.cellM);
    this.radioShadow = L.imageOverlay(canvas.toDataURL(), L.latLngBounds(ll(sw), ll(ne)), { pane: 'radioShadow', interactive: false, className: 'radio-shadow' }).addTo(this.map);
  }

  /* ------------------------------ Досягаемость ------------------------------ */

  private reach: ReachLayer | null = null;

  /**
   * Досягаемость (reach.ts): заливка градиентом «с запасом → впритык → в один конец», кольца
   * с подписями; в полёте noReturn — точка невозврата по курсу и пунктир возврата. Заливка — под
   * радиотенью (где нет связи, она темнее), контуры — под зонами и маршрутом (reachLayer.ts).
   * null — убрать. origin — начало лучей, по умолчанию result.origin.
   */
  setReach(result: ReachResult | null, origin?: GeoPoint, noReturn?: NoReturn | null) {
    if (!result && !this.reach) return;
    this.reach ??= new ReachLayer(this.map);
    this.reach.set(result, origin, noReturn);
  }

  /* ------------------------------ Ветер у рельефа ------------------------------ */

  /**
   * Поле ветра у рельефа на высоте полёта (TerrainWind.fieldGrid): заливка по вертикальному потоку —
   * опускание синим, подъём красным, болтанка сильнее — фиолетовым; стрелки — куда дует; кружки —
   * площадки по уровню опасности, в подсказке — что ждать. null — убрать. origin — начало координат сетки.
   */
  setWindField(grid: WindFieldGrid | null, origin?: GeoPoint, sites: readonly WindSiteMark[] = []) {
    this.windImage?.remove();
    this.windImage = null;
    this.windLayer.clearLayers();
    if (!grid || !origin) return;
    const { nx, ny, stepM } = grid;
    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(nx, ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const w = grid.upMs[k]!;
        const turb = Math.min(1, Math.max(0, (grid.turbulenceScale[k]! - 1) / 1.5));
        // Поток сильнее 3 м/с — полная заливка; слабее 0,3 м/с и без болтанки — ничего.
        const a = Math.min(1, Math.abs(w) / 3);
        if (a < 0.1 && turb < 0.2) continue;
        const base = w < 0 ? [60, 120, 255] : [255, 90, 60];
        const rgb = base.map((c, q) => Math.round(c * (1 - 0.6 * turb) + [190, 80, 255][q]! * 0.6 * turb));
        img.data.set([rgb[0]!, rgb[1]!, rgb[2]!, Math.round(150 * Math.max(a, 0.8 * turb))], ((ny - 1 - j) * nx + i) * 4);
      }
    }
    g.putImageData(img, 0, 0);
    // Узел — центр пикселя: картинка шире сетки на полшага с каждой стороны.
    const sw = fromLocal(origin, grid.east0 - stepM / 2, grid.north0 - stepM / 2);
    const ne = fromLocal(origin, grid.east0 + (nx - 0.5) * stepM, grid.north0 + (ny - 0.5) * stepM);
    this.windImage = L.imageOverlay(canvas.toDataURL(), L.latLngBounds(ll(sw), ll(ne)), { pane: 'wind', opacity: 0.8, interactive: false, className: 'wind-field' }).addTo(this.map);

    // Стрелки: ~14 по ширине, длина — по скорости (самая сильная — 0,7 шага стрелок).
    const stride = Math.max(1, Math.round(nx / 14));
    let top = 0;
    for (let k = 0; k < nx * ny; k++) top = Math.max(top, Math.hypot(grid.eastMs[k]!, grid.northMs[k]!));
    const scale = top > 0 ? (0.7 * stride * stepM) / top : 0;
    const style = { renderer: this.windRenderer, pane: 'wind', color: '#ffffff', weight: 1.5, opacity: 0.75, interactive: false };
    for (let j = Math.floor(stride / 2); j < ny; j += stride) {
      for (let i = Math.floor(stride / 2); i < nx; i += stride) {
        const k = j * nx + i;
        const ve = grid.eastMs[k]! * scale;
        const vn = grid.northMs[k]! * scale;
        const len = Math.hypot(ve, vn);
        if (len < stepM / 4) continue;
        const e0 = grid.east0 + i * stepM - ve / 2;
        const n0 = grid.north0 + j * stepM - vn / 2;
        const e1 = e0 + ve;
        const n1 = n0 + vn;
        // Оперение — две черты под 25° назад, треть длины.
        const head = (sgn: number) => {
          const c = Math.cos(Math.PI - sgn * 0.44);
          const s = Math.sin(Math.PI - sgn * 0.44);
          return ll(fromLocal(origin, e1 + ((ve * c - vn * s) / 3), n1 + ((ve * s + vn * c) / 3)));
        };
        L.polyline([head(1), ll(fromLocal(origin, e1, n1)), head(-1)], style).addTo(this.windLayer);
        L.polyline([ll(fromLocal(origin, e0, n0)), ll(fromLocal(origin, e1, n1))], style).addTo(this.windLayer);
      }
    }

    for (const p of sites) {
      const color = HAZARD_COLOR(p.hazard.level);
      L.circleMarker(ll(p.position), { renderer: this.renderer, radius: 11, color, weight: 3, fill: false })
        .bindTooltip(`<b>${esc(p.label)}</b><br>${esc(p.hazard.text)}`, { direction: 'top', offset: [0, -10] })
        .addTo(this.windLayer);
    }
  }

  /** Ретрансляторы: значок с номером (Р1, Р2…), подсказка, правый щелчок — onRelayContext. */
  setRelays(relays: readonly Relay[]) {
    this.relayLayer.clearLayers();
    relays.forEach((r, i) => {
      const m = L.marker(ll(r), { icon: relayIcon(`Р${i + 1}`), zIndexOffset: 600, keyboard: false }).addTo(this.relayLayer);
      m.bindTooltip(`<b>Ретранслятор ${i + 1}</b><br>${relayText(r)}<br><i>правый щелчок — удалить</i>`, { direction: 'top', offset: [0, -24] });
      m.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        L.DomEvent.stopPropagation(e);
        if (!this.draw && !this.relayPlace) this.onRelayContext?.(i);
      });
    });
  }

  /** Идёт установка ретранслятора: щелчки по карте не добавляют точки маршрута. */
  get placingRelay(): boolean {
    return this.relayPlace !== null;
  }

  /** Поставить ретранслятор щелчком по карте; Esc — отмена. Готовый — в onDone, на карту его кладёт setRelays. */
  startRelayPlace(template: RelayTemplate, onDone: (relay: Relay) => void, opts: { onCancel?: () => void } = {}) {
    this.cancelZoneDraw();
    this.cancelRelayPlace();
    this.relayPlace = { template, onDone, onCancel: opts.onCancel, hint: null };
    this.map.getContainer().style.cursor = 'crosshair';
    this.map.on('mousemove', this.relayMove);
    document.addEventListener('keydown', this.relayKey);
  }

  cancelRelayPlace() {
    const p = this.relayPlace;
    if (!p) return;
    this.relayPlace = null;
    p.hint?.remove();
    this.map.getContainer().style.cursor = '';
    this.map.off('mousemove', this.relayMove);
    document.removeEventListener('keydown', this.relayKey);
  }

  private readonly relayMove = (e: L.LeafletMouseEvent) => {
    const p = this.relayPlace;
    if (!p) return;
    const at = this.map.containerPointToLatLng(this.map.latLngToContainerPoint(e.latlng).add([0, -22]));
    const icon = labelIcon(`Ретранслятор, ${relayText(p.template)} · щелчок — поставить, Esc — отмена`, RELAY_COLOR);
    if (p.hint) p.hint.setLatLng(at);
    else p.hint = L.marker(at, { interactive: false, keyboard: false, icon }).addTo(this.map);
  };

  private readonly relayKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.relayPlace) return;
    const cancel = this.relayPlace.onCancel;
    this.cancelRelayPlace();
    cancel?.();
  };

  private relayClick(p: L.LatLng) {
    const place = this.relayPlace!;
    this.cancelRelayPlace();
    place.onDone({ ...place.template, lat: p.lat, lon: p.lng });
  }

  /**
   * Линия связи: НСУ → ретрансляторы (state.link.via) → борт, в цвете состояния (пунктир — связи
   * нет); obstruction — главное препятствие (state.link.obstruction.at). null — убрать.
   */
  setLinkLine(path: readonly GeoPoint[] | null, status: LinkStatus | null, obstruction?: GeoPoint | null) {
    this.linkBlock?.remove();
    this.linkBlock = null;
    if (!path || !status) {
      this.linkLine.setLatLngs([]);
      return;
    }
    this.linkLine.setLatLngs(path.map(ll));
    this.linkLine.setStyle({ color: LINK_COLOR[status], dashArray: status === 'lost' ? '6 6' : status === 'poor' ? '10 4' : undefined });
    if (obstruction && status !== 'good') {
      this.linkBlock = L.circleMarker(ll(obstruction), { renderer: this.renderer, radius: 6, color: LINK_COLOR.lost, weight: 2, fillColor: '#000', fillOpacity: 0.5, interactive: false }).addTo(this.map);
    }
  }

  /* --------------------------------- Зоны --------------------------------- */

  /**
   * Запретные зоны и зоны РЭБ: контур (запретная — пунктир со штриховкой), у РЭБ — кольцо, где
   * помехи кончаются, подпись вида. Правый щелчок по зоне — onZoneContext.
   */
  setZones(zones: readonly Zone[]) {
    this.zoneLayer.clearLayers();
    this.zonesShown = zones.slice();
    for (const z of zones) {
      const color = ZONE_COLOR[z.kind];
      const nofly = z.kind === 'nofly';
      const style: L.PathOptions = {
        renderer: this.zoneRenderer,
        pane: 'zones',
        color,
        weight: 2,
        opacity: 0.95,
        dashArray: nofly ? '8 5' : undefined,
        fillColor: color,
        fillOpacity: nofly ? 0.2 : 0.14,
      };
      let shape: L.Path;
      if (z.center && z.radiusM && z.radiusM > 0) shape = L.circle(ll(z.center), { ...style, radius: z.radiusM });
      else if (z.polygon && z.polygon.length >= 3) shape = L.polygon(z.polygon.map(ll), style);
      else continue;
      if (nofly) shape.on('add', () => hatch(shape, color));
      shape.bindTooltip(zoneTooltip(z), { sticky: true, direction: 'top' });
      shape.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        L.DomEvent.stopPropagation(e);
        if (!this.draw) this.onZoneContext?.(z.id);
      });
      shape.addTo(this.zoneLayer);
      if (!nofly) {
        const origin = z.center ?? z.polygon![0]!;
        const falloff = prepareZones([z], origin)[0]?.falloffM ?? 0;
        for (const line of zoneContour(z, falloff)) {
          L.polyline(line.map(ll), { renderer: this.zoneRenderer, pane: 'zones', color, weight: 1, opacity: 0.75, dashArray: '2 6', interactive: false }).addTo(this.zoneLayer);
        }
      }
      L.marker(ll(z.center ?? centroid(z.polygon!)), { pane: 'zones', interactive: false, keyboard: false, icon: labelIcon(zoneLabel(z), color) }).addTo(this.zoneLayer);
    }
  }

  /** Идёт рисование зоны: щелчки по карте не добавляют точки маршрута. */
  get drawingZone(): boolean {
    return this.draw !== null;
  }

  /**
   * Рисование зоны инструктором. Круг: щелчок — центр, второй щелчок — граница (радиус тянется
   * за мышью). Многоугольник: щелчки по вершинам, конец — двойной щелчок или щелчок по первой
   * вершине. Esc — отмена (onCancel). Готовая зона — в onDone, с новым id; на карту её кладёт
   * setZones.
   */
  startZoneDraw(kind: ZoneKind, onDone: (zone: Zone) => void, opts: { shape?: 'circle' | 'polygon'; onCancel?: () => void } = {}) {
    this.cancelZoneDraw();
    this.cancelRelayPlace();
    this.draw = {
      kind,
      shape: opts.shape ?? 'circle',
      onDone,
      onCancel: opts.onCancel,
      pts: [],
      preview: L.layerGroup().addTo(this.map),
      dblZoom: this.map.doubleClickZoom.enabled(),
    };
    this.map.doubleClickZoom.disable();
    this.map.getContainer().style.cursor = 'crosshair';
    this.map.on('mousemove', this.drawMove);
    this.map.on('dblclick', this.drawDouble);
    document.addEventListener('keydown', this.drawKey);
  }

  cancelZoneDraw() {
    const d = this.draw;
    if (!d) return;
    this.draw = null;
    d.preview.remove();
    if (d.dblZoom) this.map.doubleClickZoom.enable();
    this.map.getContainer().style.cursor = '';
    this.map.off('mousemove', this.drawMove);
    this.map.off('dblclick', this.drawDouble);
    document.removeEventListener('keydown', this.drawKey);
  }

  private readonly drawMove = (e: L.LeafletMouseEvent) => this.drawPreview(e.latlng);

  private readonly drawDouble = () => {
    if (this.draw?.shape === 'polygon') this.finishPolygon();
  };

  private readonly drawKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.draw) return;
    const cancel = this.draw.onCancel;
    this.cancelZoneDraw();
    cancel?.();
  };

  private drawClick(p: L.LatLng) {
    const d = this.draw!;
    if (d.shape === 'circle') {
      if (!d.pts.length) {
        d.pts.push(p);
        this.drawPreview(p);
        return;
      }
      const r = this.map.distance(d.pts[0]!, p);
      if (r >= MIN_ZONE_RADIUS_M) this.finishZone({ center: geo(d.pts[0]!), radiusM: Math.round(r) });
      return;
    }
    if (d.pts.length >= 3 && this.nearPx(p, d.pts[0]!, 10)) return this.finishPolygon();
    // Второй щелчок двойного — та же точка.
    if (d.pts.length && this.nearPx(p, d.pts[d.pts.length - 1]!, 4)) return;
    d.pts.push(p);
    this.drawPreview(p);
  }

  private nearPx(a: L.LatLng, b: L.LatLng, px: number): boolean {
    return this.map.latLngToContainerPoint(a).distanceTo(this.map.latLngToContainerPoint(b)) <= px;
  }

  private finishPolygon() {
    const d = this.draw;
    if (d && d.pts.length >= 3) this.finishZone({ polygon: d.pts.map(geo) });
  }

  private finishZone(shape: Pick<Zone, 'center' | 'radiusM' | 'polygon'>) {
    const d = this.draw!;
    const zone: Zone = { id: makeZoneId(this.zonesShown.map((z) => z.id)), kind: d.kind, ...shape };
    this.cancelZoneDraw();
    d.onDone(zone);
  }

  /** Предпросмотр: круг с радиусом до мыши или многоугольник с ребром к мыши, и подсказка. */
  private drawPreview(mouse: L.LatLng) {
    const d = this.draw;
    if (!d) return;
    const g = d.preview;
    g.clearLayers();
    const color = ZONE_COLOR[d.kind];
    const opts: L.PathOptions = { renderer: this.zoneRenderer, pane: 'zones', color, weight: 2, dashArray: '4 4', fillColor: color, fillOpacity: 0.1, interactive: false };
    let hint: string;
    if (d.shape === 'circle') {
      const c = d.pts[0];
      if (c) {
        const r = this.map.distance(c, mouse);
        L.circle(c, { ...opts, radius: r }).addTo(g);
        L.polyline([c, mouse], { ...opts, weight: 1 }).addTo(g);
        hint = `${ZONE_TITLE[d.kind]} · радиус ${fmtM(r)} · щелчок — граница, Esc — отмена`;
      } else hint = `${ZONE_TITLE[d.kind]} · щелчок — центр, Esc — отмена`;
    } else {
      if (d.pts.length) {
        L.polygon([...d.pts, mouse], opts).addTo(g);
        L.circleMarker(d.pts[0]!, { renderer: this.zoneRenderer, pane: 'zones', radius: 6, color, weight: 2, fillColor: '#000', fillOpacity: 0.5, interactive: false }).addTo(g);
      }
      hint =
        d.pts.length < 3
          ? `${ZONE_TITLE[d.kind]} · щелчки — вершины, Esc — отмена`
          : `${ZONE_TITLE[d.kind]} · двойной щелчок или первая вершина — готово, Esc — отмена`;
    }
    const at = this.map.containerPointToLatLng(this.map.latLngToContainerPoint(mouse).add([0, -22]));
    L.marker(at, { pane: 'zones', interactive: false, keyboard: false, icon: labelIcon(hint, color) }).addTo(g);
  }
}
