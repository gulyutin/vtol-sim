import L from 'leaflet';
import type { RoutePoint } from '../game/scenarios';
import { fromLocal } from '../sim/mission';
import type { Coverage, Frame } from '../sim/survey';
import type { GeoPoint, Site } from '../sim/types';

const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ll = (p: GeoPoint) => L.latLng(p.lat, p.lon);

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
  private readonly renderer = L.canvas({ padding: 0.5 });
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
    L.tileLayer(IMAGERY, { maxZoom: 19, maxNativeZoom: 19, attribution: 'Снимки © Esri, Maxar, Earthstar Geographics' }).addTo(this.map);
    L.tileLayer(LABELS, { maxZoom: 19, maxNativeZoom: 19 }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(this.map);
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
    this.map.on('click', (e: L.LeafletMouseEvent) => this.onClick?.({ lat: e.latlng.lat, lon: e.latlng.lng }));
    this.map.on('zoomend', () => this.updateMarks());
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

  zoom(delta: number) {
    this.map.setZoom(this.map.getZoom() + delta);
  }
}
