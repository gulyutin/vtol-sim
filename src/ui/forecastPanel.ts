import { localTime, type ForecastHour, type ForecastPlan, type SiteWind, type Verdict } from '../game/forecastPlan';

/*
 * Окно «Прогноз вылета»: выбор окна (сегодня, завтра, 48 ч, свой диапазон), лента часов
 * «лететь / с оговорками / не лететь» с ветром и зарядом, детали часа, лучшее время, окна и
 * «Применить этот час». Сеть и расчёт — снаружи (onRequest → setProgress → setResult).
 */

export type ForecastRangeKind = 'today' | 'tomorrow' | '48h' | 'custom';

/** Окно вылетов: часы с from (UTC), числом hours. */
export interface ForecastRange {
  kind: ForecastRangeKind;
  from: Date;
  hours: number;
  label: string;
}

export interface ForecastPanelOptions {
  /** Часовой пояс района, ч — для местного времени. */
  utcOffsetH: number;
  /** Текущий момент (для тестов). */
  now?: () => Date;
}

const HOUR_MS = 3_600_000;
const VERDICT: Record<Verdict, [title: string, cls: string]> = {
  go: ['Лететь', 'good'],
  caution: ['Можно с оговорками', 'warn'],
  nogo: ['Не лететь', 'bad'],
};
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

const fmt = (x: number, d = 0) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const km = (m: number) => (m < 1000 ? `${fmt(Math.round(m / 10) * 10)} м` : `${fmt(m / 1000, m < 10_000 ? 1 : 0)} км`);
/** «пн 14 сен» по местной дате ГГГГ-ММ-ДД. */
const dayName = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const offsetName = (h: number) => `UTC${h >= 0 ? '+' : '−'}${fmt(Math.abs(h), h % 1 ? 1 : 0)}`;

export class ForecastPanel {
  readonly el: HTMLElement;
  private readonly q: <T extends HTMLElement>(k: string) => T;
  private plan: ForecastPlan | null = null;
  private selected: number | null = null;
  private placed = false;
  private requestFn: ((r: ForecastRange) => void) | null = null;
  private applyFn: ((h: ForecastHour) => void) | null = null;
  private closeFn: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: ForecastPanelOptions,
  ) {
    const el = document.createElement('div');
    el.className = 'win fc';
    el.dataset.win = 'forecast';
    el.hidden = true;
    el.innerHTML = `
      <div class="win-title"><span>Прогноз вылета</span><button class="x" data-fc="close" title="Закрыть">✕</button></div>
      <div class="win-body">
        <div class="fc-range">
          <select data-fc="kind" title="Какие часы вылета проверить">
            <option value="today">Сегодня — до конца дня</option>
            <option value="tomorrow">Завтра</option>
            <option value="48h" selected>Ближайшие 48 часов</option>
            <option value="custom">Свой диапазон</option>
          </select>
          <span class="fc-custom" data-fc="custom" hidden>
            <select data-fc="day"></select>
            <label>с <input type="number" data-fc="h0" min="0" max="23" step="1" value="8"></label>
            <label>до <input type="number" data-fc="h1" min="1" max="24" step="1" value="14"> ч</label>
          </span>
          <button class="small fc-run" data-fc="run">Рассчитать</button>
        </div>
        <div class="fc-status hint" data-fc="status">Задание — тот же маршрут и настройки — прогонится на каждый час реального прогноза для площадки.</div>
        <div class="fc-ribbon" data-fc="ribbon" tabindex="0"></div>
        <div class="fc-sum" data-fc="sum"></div>
        <div class="fc-detail" data-fc="detail"></div>
        <div class="fc-common" data-fc="common"></div>
        <div class="fc-foot">
          <span class="hint" data-fc="attr">Погода: Open-Meteo.com</span>
          <button class="small fc-apply" data-fc="apply" disabled title="Задание перепланируется на погоду, дату и время этого часа">Применить этот час</button>
        </div>
      </div>`;
    root.appendChild(el);
    this.el = el;
    this.q = <T extends HTMLElement>(k: string) => el.querySelector<T>(`[data-fc="${k}"]`)!;

    this.q('close').addEventListener('click', () => {
      this.hide();
      this.closeFn?.();
    });
    const kind = this.q<HTMLSelectElement>('kind');
    kind.addEventListener('change', () => (this.q('custom').hidden = kind.value !== 'custom'));
    this.q('run').addEventListener('click', () => this.request());
    this.q('ribbon').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (b) this.select(+b.dataset.i!);
    });
    this.q('ribbon').addEventListener('keydown', (e) => {
      if (this.selected === null || !this.plan) return;
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      this.select(Math.max(0, Math.min(this.plan.hours.length - 1, this.selected + d)));
    });
    this.q('sum').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
      if (b) this.select(+b.dataset.pick!);
    });
    this.q('apply').addEventListener('click', () => {
      const h = this.selected !== null ? this.plan?.hours[this.selected] : undefined;
      if (h) this.applyFn?.(h);
    });
    this.dragByTitle();
    // Окно выросло (пришёл результат, выбран другой час) — не дать ему уйти за нижний край.
    new ResizeObserver(() => {
      if (this.visible) this.keepIn();
    }).observe(el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** Показать поверх остальных окон; в первый раз — посередине. */
  show(): void {
    this.fillDays();
    this.el.hidden = false;
    const z = Math.max(1003, ...[...this.root.querySelectorAll<HTMLElement>('.win')].map((w) => +w.style.zIndex || 0));
    this.el.style.zIndex = String(z + 1);
    if (!this.placed) {
      this.placed = true;
      const r = this.root.getBoundingClientRect();
      this.move(r.left + (r.width - this.el.offsetWidth) / 2, r.top + Math.max(50, (r.height - this.el.offsetHeight) / 3));
    } else this.keepIn();
  }

  hide(): void {
    this.el.hidden = true;
  }

  /** Запросить расчёт: окно вылетов выбрано. */
  onRequest(fn: (r: ForecastRange) => void): void {
    this.requestFn = fn;
  }

  /** «Применить этот час». */
  onApply(fn: (h: ForecastHour) => void): void {
    this.applyFn = fn;
  }

  onClose(fn: () => void): void {
    this.closeFn = fn;
  }

  /** Часовой пояс района (после смены задания или района). */
  setUtcOffset(h: number): void {
    this.opts.utcOffsetH = h;
  }

  /** Строка состояния; kind = 'bad' — ошибка. */
  setStatus(text: string, kind: 'info' | 'bad' = 'info'): void {
    const s = this.q('status');
    s.textContent = text;
    s.classList.toggle('bad', kind === 'bad');
  }

  /** Идёт загрузка или расчёт: кнопка «Рассчитать» недоступна. */
  setBusy(on: boolean, text?: string): void {
    this.q<HTMLButtonElement>('run').disabled = on;
    if (text !== undefined) this.setStatus(text);
  }

  setProgress(done: number, total: number): void {
    this.setStatus(`Считаю задание на каждый час: ${done} из ${total}…`);
  }

  /** Результат расчёта; null — очистить. Выбирается лучший час. */
  setResult(plan: ForecastPlan | null): void {
    this.plan = plan;
    this.setBusy(false);
    if (!plan) {
      this.selected = null;
      for (const k of ['ribbon', 'sum', 'detail', 'common']) this.q(k).innerHTML = '';
      this.q<HTMLButtonElement>('apply').disabled = true;
      return;
    }
    this.selected = plan.best ?? (plan.hours.length ? 0 : null);
    const n = plan.hours.length;
    this.setStatus(n ? `«${plan.mission}»: ${n} ч прогноза, расчёт ${fmt(plan.computeMs / 1000, 1)} с. Время — местное (${offsetName(plan.utcOffsetH)}).` : 'В прогнозе нет ни одного часа из выбранного окна.', n ? 'info' : 'bad');
    this.q('attr').textContent = plan.attribution;
    this.renderSummary();
    this.renderCommon();
    this.render();
  }

  /** Выбрать час по индексу в плане. */
  select(i: number): void {
    if (!this.plan?.hours[i]) return;
    this.selected = i;
    this.render();
    this.q('ribbon').querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Окно вылетов по выбору в окне; null — диапазон пустой. */
  range(): ForecastRange | null {
    const off = this.opts.utcOffsetH;
    const now = (this.opts.now ?? (() => new Date()))().getTime();
    const hourNow = Math.floor(now / HOUR_MS) * HOUR_MS;
    const midnight = (days: number) => {
      const l = new Date(now + off * HOUR_MS);
      return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + days) - off * HOUR_MS;
    };
    const kind = this.q<HTMLSelectElement>('kind').value as ForecastRangeKind;
    switch (kind) {
      case 'today':
        return { kind, from: new Date(hourNow), hours: Math.max(1, Math.round((midnight(1) - hourNow) / HOUR_MS)), label: 'сегодня' };
      case 'tomorrow':
        return { kind, from: new Date(midnight(1)), hours: 24, label: 'завтра' };
      case '48h':
        return { kind, from: new Date(hourNow), hours: 48, label: 'ближайшие 48 ч' };
      case 'custom': {
        const day = +this.q<HTMLSelectElement>('day').value || 0;
        const h0 = Math.round(+this.q<HTMLInputElement>('h0').value);
        const h1 = Math.round(+this.q<HTMLInputElement>('h1').value);
        if (!(h0 >= 0 && h1 <= 24 && h1 > h0)) return null;
        const from = Math.max(midnight(day) + h0 * HOUR_MS, hourNow);
        const hours = Math.round((midnight(day) + h1 * HOUR_MS - from) / HOUR_MS);
        if (hours < 1) return null;
        const date = localTime(new Date(midnight(day)), off).date;
        return { kind, from: new Date(from), hours, label: `${dayName(date)} с ${h0} до ${h1} ч` };
      }
    }
  }

  private request(): void {
    const r = this.range();
    if (!r) return this.setStatus('Диапазон пустой или уже прошёл: «до» должно быть позже «с» и позже текущего часа', 'bad');
    if (!this.requestFn) return this.setStatus('Расчёт прогноза не подключён', 'bad');
    this.setBusy(true, `Загружаю прогноз Open-Meteo: ${r.label}…`);
    this.requestFn(r);
  }

  /** Дни для своего диапазона: сегодня и шесть следующих, по местному времени. */
  private fillDays(): void {
    const sel = this.q<HTMLSelectElement>('day');
    const keep = sel.value || '1';
    const now = (this.opts.now ?? (() => new Date()))().getTime();
    sel.innerHTML = Array.from({ length: 7 }, (_, d) => {
      const date = localTime(new Date(now + d * 24 * HOUR_MS), this.opts.utcOffsetH).date;
      return `<option value="${d}">${d === 0 ? 'сегодня' : d === 1 ? 'завтра' : dayName(date)}</option>`;
    }).join('');
    sel.value = keep;
  }

  private time(t: Date, withDay = true): string {
    const lt = localTime(t, this.opts.utcOffsetH);
    return withDay ? `${dayName(lt.date)}, ${lt.hhmm}` : lt.hhmm;
  }

  private renderSummary(): void {
    const p = this.plan!;
    const box = this.q('sum');
    if (!p.hours.length) return void (box.innerHTML = '');
    const b = p.best !== null ? p.hours[p.best]! : null;
    const best = b
      ? `<div class="fc-best">Лучшее время вылета: <b>${this.time(b.time)}</b> — ${VERDICT[b.verdict][0].toLowerCase()}; заряд на посадке ${fmt(b.energy.socAtLanding * 100)} % (${b.energy.marginWh >= 0 ? '+' : '−'}${fmt(Math.abs(b.energy.marginWh))} Вт·ч сверх резерва), ветер ${this.windShort(b)} м/с <button class="small" data-pick="${p.best}">Показать</button></div>`
      : '<div class="verdict bad">Лететь нельзя ни в один час окна — причины в деталях часа.</div>';
    const multiDay = new Set(p.hours.map((h) => localTime(h.time, this.opts.utcOffsetH).date)).size > 1;
    const windows = p.windows.length
      ? `<div class="fc-windows"><span class="hint">Окна вылета:</span> ${p.windows
          .map((w) => {
            const same = localTime(w.from, this.opts.utcOffsetH).date === localTime(w.last, this.opts.utcOffsetH).date;
            const span = w.hours === 1 ? this.time(w.from, multiDay) : `${this.time(w.from, multiDay)}–${this.time(w.last, multiDay && !same)}`;
            return `<button class="small" data-pick="${w.best}" data-v="${w.verdict}" title="${w.verdict === 'go' ? 'Все часы — лететь' : 'Есть часы с оговорками'}; лучший — ${this.time(p.hours[w.best]!.time, multiDay)}">${span} · ${w.hours} ч</button>`;
          })
          .join(' ')}</div>`
      : '';
    box.innerHTML = best + windows;
  }

  private renderCommon(): void {
    const p = this.plan!;
    const rows = [p.link, ...p.route].map((c) => `<li class="${c.ok ? 'ok' : c.level}">${esc(c.text)}</li>`).join('');
    this.q('common').innerHTML = `<h4 class="zsub">По маршруту — от погоды не зависит</h4><ul class="fc-reasons">${rows}</ul>`;
  }

  private windShort(h: ForecastHour): string {
    return `${fmt(h.wind.groundMs)}${h.wind.gustMs !== undefined ? `/${fmt(h.wind.gustMs)}` : ''}`;
  }

  /** Лента часов и детали выбранного. */
  private render(): void {
    const p = this.plan;
    if (!p) return;
    let day = '';
    this.q('ribbon').innerHTML = p.hours
      .map((h, i) => {
        const lt = localTime(h.time, this.opts.utcOffsetH);
        const sep = lt.date !== day ? `<span class="fc-day">${dayName(lt.date)}</span>` : '';
        day = lt.date;
        const soc = h.energy.feasible ? `${fmt(h.energy.socAtLanding * 100)}%` : '—';
        const why = h.reasons[0]?.text ?? 'все проверки пройдены';
        const cls = `fc-h${i === p.best ? ' best' : ''}${i === this.selected ? ' sel' : ''}`;
        return `${sep}<button class="${cls}" data-i="${i}" data-v="${h.verdict}" title="${esc(`${lt.hhmm} — ${VERDICT[h.verdict][0]}: ${why}`)}"><b>${lt.hhmm.slice(0, 2)}</b><span>${this.windShort(h)}</span><span>${soc}</span></button>`;
      })
      .join('');
    const h = this.selected !== null ? p.hours[this.selected] : undefined;
    this.q<HTMLButtonElement>('apply').disabled = !h;
    this.q('detail').innerHTML = h ? this.detail(h) : '';
  }

  private detail(h: ForecastHour): string {
    const [title, cls] = VERDICT[h.verdict];
    const e = h.energy;
    const reasons = h.reasons.length
      ? `<ul class="fc-reasons">${h.reasons.map((c) => `<li class="${c.level}">${esc(c.text)}</li>`).join('')}</ul>`
      : '<p class="hint">Все проверки пройдены.</p>';
    const rows: [string, string, string?][] = [];
    rows.push([
      'Заряд на посадке',
      e.feasible || Number.isFinite(e.marginWh)
        ? `${fmt(e.socAtLanding * 100)} % · ${e.marginWh >= 0 ? '+' : '−'}${fmt(Math.abs(e.marginWh))} Вт·ч сверх резерва`
        : 'задание невыполнимо',
      e.marginWh >= 0 && e.feasible ? 'good' : 'bad',
    ]);
    if (e.durationS > 0) rows.push(['Полёт', `${fmt(e.durationS / 60)} мин · ${km(e.distanceM)}`]);
    const w = h.wind;
    rows.push(['Ветер у земли (10 м)', `${fmt(w.groundMs, 1)} м/с с ${fmt(w.fromDeg)}° (${COMPASS[Math.round(w.fromDeg / 45) % 8]})${w.gustMs !== undefined ? `, порывы ${fmt(w.gustMs, 1)}` : ''}`]);
    rows.push([`Ветер на ${fmt(w.routeHeightAglM)} м над рельефом`, `${fmt(w.routeMs, 1)} м/с${w.routeMaxMs > w.routeMs + 0.2 ? `, на участках до ${fmt(w.routeMaxMs, 1)}` : ''}`]);
    const site = (x: SiteWind, what: string) =>
      [
        `${what}${x.name.replace(/^(взлёта|посадки)/, '')}, курс ${fmt(x.headingDeg)}°`,
        `${x.headwindMs >= 0 ? 'встречный' : 'попутный'} ${fmt(Math.abs(x.headwindMs), 1)}, боковой ${fmt(x.crosswindMs, 1)} м/с${x.gustMs !== undefined ? ` · порывы ${fmt(x.gustMs, 1)}` : ''}`,
      ] as [string, string];
    h.takeoff.forEach((x) => rows.push(site(x, 'Разгон')));
    h.landing.forEach((x) => rows.push(site(x, 'Посадка')));
    const s = h.sky;
    rows.push(['Осадки', s.thunder ? `гроза${s.precipitation ? `, ${s.precipitation}` : ''}` : (s.precipitation ?? 'нет'), s.precipitation || s.thunder ? 'bad' : undefined]);
    if (s.visibilityM !== undefined) rows.push(['Видимость', km(s.visibilityM), s.visibilityM < 1000 ? 'bad' : undefined]);
    rows.push(['Облачность', `${s.cloudCover !== undefined ? `${fmt(s.cloudCover * 100)} %, ` : ''}нижняя граница ${s.cloudBaseM !== undefined ? `≈ ${fmt(s.cloudBaseM)} м` : '—'}`]);
    if (s.freezingLevelM !== undefined) rows.push(['Нулевая изотерма', `${h.hourly.freezingLevelEstimated ? '≈ ' : ''}${fmt(s.freezingLevelM)} м над морем${h.hourly.freezingLevelEstimated ? ' (оценка по температуре у земли)' : ''}`]);
    rows.push(['Обледенение', s.icing ? 'опасно' : 'нет', s.icing ? 'bad' : 'good']);
    for (const x of [...h.takeoff, ...h.landing]) if (x.hazardText && x.hazard >= 0.3) rows.push([`У площадки ${x.name}`, esc(x.hazardText), 'bad']);
    rows.push(['Солнце', `${fmt(h.sun.takeoffDeg)}° на вылете, ${fmt(h.sun.landingDeg)}° на посадке`]);
    const table = `<table class="kv">${rows.map(([k, v, c]) => `<tr${c ? ` class="${c}"` : ''}><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`;
    const all = h.checks.map((c) => `<li class="${c.ok ? 'ok' : c.level}">${esc(c.text)}</li>`).join('');
    return `<div class="fc-dh"><b>${this.time(h.time)}</b> <span class="hint">${offsetName(this.opts.utcOffsetH)}</span></div>
      <div class="verdict ${cls}">${title}</div>${reasons}${table}
      <p class="hint">${esc(h.hourly.summary)}</p>
      <details><summary>Все проверки часа</summary><ul class="fc-reasons">${all}</ul></details>`;
  }

  private move(x: number, y: number): void {
    const g = this.root.getBoundingClientRect();
    const cx = Math.max(g.left + 8, Math.min(x, g.right - 8 - this.el.offsetWidth));
    const cy = Math.max(g.top + 8, Math.min(y, g.bottom - 8 - this.el.offsetHeight));
    Object.assign(this.el.style, { left: `${Math.round(cx - g.left)}px`, top: `${Math.round(cy - g.top)}px`, right: 'auto', bottom: 'auto' });
  }

  private keepIn(): void {
    const r = this.el.getBoundingClientRect();
    this.move(r.left, r.top);
  }

  private dragByTitle(): void {
    const t = this.el.querySelector<HTMLElement>('.win-title')!;
    t.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const z = Math.max(1003, ...[...this.root.querySelectorAll<HTMLElement>('.win')].map((w) => +w.style.zIndex || 0));
      if ((+this.el.style.zIndex || 0) < z) this.el.style.zIndex = String(z + 1);
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev: PointerEvent) => this.move(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}
