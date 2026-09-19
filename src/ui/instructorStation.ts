/*
 * Пульт инструктора — отдельное окно браузера (второй монитор): карта с планом, истинным местом
 * аппарата и тем, что видит НСУ (без ГНСС они расходятся), состояние борта, лента событий; отказы —
 * сразу, через время или по условию (переход в самолёт, заход на посадку, низко на посадке);
 * восстановить связь и ГНСС; сообщения оператору от руководителя полётов; замечания со временем —
 * в разбор и протокол. Логика в этом окне (окне НСУ), всплывающее — только разметка.
 */

export interface StationStatus {
  /** Время полёта (часы записи), с. */
  t: number;
  airborne: boolean;
  mode: string;
  modeName: string;
  aglM: number;
  iasMs: number;
  groundSpeedMs: number;
  soc: number;
  linkLost: boolean;
  linkQuality: number;
  failures: string[];
  /** Истинное место и курс, локальные метры. */
  truth: { east: number; north: number; headingDeg: number };
  /** Где аппарат по телеметрии НСУ. */
  gcs: { east: number; north: number };
  windMs: number;
  windFromDeg: number;
  task: string;
  mode2: string;
  exercise: string | null;
  student: string | null;
  plan: { east: number; north: number }[][];
  home: { east: number; north: number };
  landing: { east: number; north: number };
  events: { t: number; text: string; kind?: string }[];
}

export interface StationHost {
  status(): StationStatus;
  failures: readonly { id: string; title: string }[];
  inject(id: string): void;
  restore(id: 'link' | 'gnss'): void;
  /** Сообщение оператору от руководителя полётов: тревогой на НСУ и в консоль. */
  message(text: string): void;
  remark(text: string, level: 'good' | 'warn' | 'bad'): void;
}

type Trigger = { kind: 'now' } | { kind: 'after'; s: number } | { kind: 'plane' } | { kind: 'landing' } | { kind: 'low' };

interface Scheduled {
  n: number;
  id: string;
  title: string;
  trigger: Trigger;
  /** Когда назначен, с (для «через»). */
  at: number;
}

const TRIGGERS: { v: string; title: string; make: () => Trigger }[] = [
  { v: 'now', title: 'сейчас', make: () => ({ kind: 'now' }) },
  { v: '30', title: 'через 30 с', make: () => ({ kind: 'after', s: 30 }) },
  { v: '60', title: 'через 1 мин', make: () => ({ kind: 'after', s: 60 }) },
  { v: '180', title: 'через 3 мин', make: () => ({ kind: 'after', s: 180 }) },
  { v: '300', title: 'через 5 мин', make: () => ({ kind: 'after', s: 300 }) },
  { v: 'plane', title: 'когда перейдёт в самолёт', make: () => ({ kind: 'plane' }) },
  { v: 'landing', title: 'на заходе на посадку', make: () => ({ kind: 'landing' }) },
  { v: 'low', title: 'ниже 50 м на посадке', make: () => ({ kind: 'low' }) },
];

const MESSAGES = [
  'Доложите остаток заряда и время до посадки',
  'Сократите маршрут — возвращайтесь на точку посадки',
  'На площадке посадки люди — ожидание до команды',
  'Посадка разрешена',
  'Работы в районе прекратить, возврат',
];

const PLANE_MODES = new Set(['auto', 'guided', 'hold', 'manual', 'rtl']);
const LANDING_MODES = new Set(['backtransition', 'descent', 'final']);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const clock = (t: number) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
const trigText = (tr: Trigger, at: number) =>
  tr.kind === 'now' ? 'сейчас' : tr.kind === 'after' ? `в T+${clock(at + tr.s)}` : tr.kind === 'plane' ? 'при переходе в самолёт' : tr.kind === 'landing' ? 'на заходе на посадку' : 'ниже 50 м на посадке';

export class InstructorStation {
  private win: Window | null = null;
  private timer = 0;
  private scheduled: Scheduled[] = [];
  private seq = 1;
  private track: { east: number; north: number }[] = [];
  private lastMode = '';

  constructor(private readonly host: StationHost) {}

  get open(): boolean {
    return !!this.win && !this.win.closed;
  }

  toggle(): boolean {
    if (this.open) {
      this.win!.close();
      this.stop();
      return false;
    }
    const w = window.open('', 'vtol-instructor', 'popup,width=1200,height=800');
    if (!w) {
      alert('Браузер не дал открыть окно — разрешите всплывающие окна для этого сайта.');
      return false;
    }
    this.win = w;
    this.build(w.document);
    this.timer = window.setInterval(() => this.tick(), 500);
    w.addEventListener('beforeunload', () => this.stop());
    this.tick();
    return true;
  }

  private stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  /** Новая попытка полёта: назначенные отказы и след — заново. */
  reset(): void {
    this.scheduled = [];
    this.track = [];
    this.lastMode = '';
    this.renderScheduled();
  }

  private build(d: Document) {
    d.title = 'Пульт инструктора';
    d.body.innerHTML = `
      <style>
        :root { color-scheme: dark; }
        html, body { margin: 0; height: 100%; background: #111418; color: #d7dde4; font: 13px system-ui, sans-serif; }
        .grid { display: grid; grid-template-columns: 1fr 380px; height: 100vh; }
        .map { position: relative; }
        canvas { display: block; width: 100%; height: 100%; }
        .side { overflow-y: auto; padding: 10px 12px; border-left: 1px solid #2a3139; }
        h3 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #8b97a3; }
        h3:first-child { margin-top: 0; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 2px 4px; vertical-align: top; }
        td:first-child { color: #8b97a3; width: 42%; }
        .bad { color: #ff8787; } .warn { color: #ffd43b; } .ok { color: #69db7c; }
        select, input, button { font: inherit; color: inherit; background: #1d232a; border: 1px solid #3a434d; border-radius: 4px; padding: 4px 6px; }
        button { cursor: pointer; } button:hover { border-color: #5c7cfa; }
        .row { display: flex; gap: 6px; margin: 4px 0; flex-wrap: wrap; }
        .row > select, .row > input { flex: 1; min-width: 0; }
        ul { list-style: none; margin: 0; padding: 0; }
        li { padding: 3px 0; border-bottom: 1px solid #22292f; display: flex; gap: 6px; align-items: baseline; }
        li span { flex: 1; }
        .feed li { font-size: 12px; }
        .legend { position: absolute; left: 8px; bottom: 8px; font-size: 11px; color: #8b97a3; background: rgba(0,0,0,.45); padding: 4px 6px; border-radius: 4px; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin: 0 4px 0 8px; vertical-align: -1px; }
      </style>
      <div class="grid">
        <div class="map"><canvas></canvas><div class="legend"><i style="background:#ff6b6b"></i>где аппарат на самом деле<i style="background:#4dabf7"></i>что видит НСУ<i style="background:#ffd43b"></i>план</div></div>
        <div class="side">
          <h3>Борт</h3><table class="st"></table>
          <h3>Особый случай</h3>
          <div class="row"><select data-f>${this.host.failures.map((f) => `<option value="${f.id}">${esc(f.title)}</option>`).join('')}</select></div>
          <div class="row"><select data-when>${TRIGGERS.map((t) => `<option value="${t.v}">${t.title}</option>`).join('')}</select><button data-a="plan">Назначить</button></div>
          <ul class="sched"></ul>
          <div class="row"><button data-a="restore-link">Восстановить связь</button><button data-a="restore-gnss">Восстановить ГНСС</button></div>
          <h3>Руководитель полётов → оператору</h3>
          <div class="row"><select data-preset><option value="">— готовые —</option>${MESSAGES.map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div class="row"><input data-msg placeholder="Текст сообщения"><button data-a="msg">Передать</button></div>
          <h3>Замечание в разбор</h3>
          <div class="row"><input data-rem placeholder="Что отметить — с временем полёта"><select data-lvl><option value="warn">замечание</option><option value="bad">грубое</option><option value="good">хорошо</option></select><button data-a="rem">Записать</button></div>
          <h3>События</h3><ul class="feed"></ul>
        </div>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => d.querySelector<T>(s)!;
    q<HTMLSelectElement>('[data-preset]').addEventListener('change', (e) => {
      q<HTMLInputElement>('[data-msg]').value = (e.target as HTMLSelectElement).value;
    });
    d.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a], [data-cancel]');
      if (!b) return;
      if (b.dataset['cancel']) {
        this.scheduled = this.scheduled.filter((x) => x.n !== +b.dataset['cancel']!);
        this.renderScheduled();
        return;
      }
      const st = this.host.status();
      switch (b.dataset['a']) {
        case 'plan': {
          const id = q<HTMLSelectElement>('[data-f]').value;
          const tr = TRIGGERS.find((t) => t.v === q<HTMLSelectElement>('[data-when]').value)!.make();
          const title = this.host.failures.find((f) => f.id === id)?.title ?? id;
          if (tr.kind === 'now') this.host.inject(id);
          else this.scheduled.push({ n: this.seq++, id, title, trigger: tr, at: st.t });
          this.renderScheduled();
          break;
        }
        case 'restore-link':
          this.host.restore('link');
          break;
        case 'restore-gnss':
          this.host.restore('gnss');
          break;
        case 'msg': {
          const i = q<HTMLInputElement>('[data-msg]');
          if (i.value.trim()) this.host.message(i.value.trim());
          i.value = '';
          q<HTMLSelectElement>('[data-preset]').value = '';
          break;
        }
        case 'rem': {
          const i = q<HTMLInputElement>('[data-rem]');
          if (i.value.trim()) this.host.remark(i.value.trim(), q<HTMLSelectElement>('[data-lvl]').value as 'good' | 'warn' | 'bad');
          i.value = '';
          break;
        }
      }
    });
    d.querySelector('[data-rem]')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') (d.querySelector('[data-a="rem"]') as HTMLElement).click();
    });
    d.querySelector('[data-msg]')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') (d.querySelector('[data-a="msg"]') as HTMLElement).click();
    });
  }

  private renderScheduled() {
    const ul = this.win && !this.win.closed ? this.win.document.querySelector('.sched') : null;
    if (!ul) return;
    ul.innerHTML = this.scheduled.map((s) => `<li><span>${esc(s.title)} — ${trigText(s.trigger, s.at)}</span><button data-cancel="${s.n}">✕</button></li>`).join('');
  }

  /** Условие назначенного отказа наступило. */
  private due(s: Scheduled, st: StationStatus): boolean {
    if (!st.airborne) return false;
    const tr = s.trigger;
    if (tr.kind === 'after') return st.t >= s.at + tr.s;
    if (tr.kind === 'plane') return PLANE_MODES.has(st.mode) && this.lastMode !== st.mode;
    if (tr.kind === 'landing') return LANDING_MODES.has(st.mode);
    if (tr.kind === 'low') return LANDING_MODES.has(st.mode) && st.aglM < 50;
    return true;
  }

  private tick() {
    if (!this.open) return this.stop();
    const st = this.host.status();
    const fire = this.scheduled.filter((s) => this.due(s, st));
    if (fire.length) {
      for (const s of fire) this.host.inject(s.id);
      this.scheduled = this.scheduled.filter((s) => !fire.includes(s));
      this.renderScheduled();
    }
    this.lastMode = st.mode;
    const last = this.track[this.track.length - 1];
    if (st.airborne && (!last || Math.hypot(st.truth.east - last.east, st.truth.north - last.north) > 15)) this.track.push({ east: st.truth.east, north: st.truth.north });
    const d = this.win!.document;
    const soc = Math.round(st.soc * 100);
    d.querySelector('.st')!.innerHTML = [
      ['Задание', esc(st.task)],
      ['Режим задания', esc(st.mode2)],
      ...(st.exercise ? [['Упражнение', esc(st.exercise)]] : []),
      ...(st.student ? [['Курсант', esc(st.student)]] : []),
      ['Время', `T+${clock(st.t)}`],
      ['Состояние', esc(st.modeName)],
      ['Высота / скорость', `${Math.round(st.aglM)} м · ${Math.round(st.iasMs)} м/с (путевая ${Math.round(st.groundSpeedMs)})`],
      ['Заряд', `<span class="${soc < 20 ? 'bad' : soc < 35 ? 'warn' : ''}">${soc} %</span>`],
      ['Связь', st.linkLost ? '<span class="bad">нет</span>' : `${Math.round(st.linkQuality * 100)} %`],
      ['Ветер', `${Math.round(st.windMs)} м/с с ${Math.round(st.windFromDeg)}°`],
      ['Расхождение НСУ', `${Math.round(Math.hypot(st.truth.east - st.gcs.east, st.truth.north - st.gcs.north))} м`],
      ['Отказы', st.failures.length ? `<span class="bad">${st.failures.map(esc).join('<br>')}</span>` : '<span class="ok">нет</span>'],
    ]
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join('');
    d.querySelector('.feed')!.innerHTML = st.events.map((e) => `<li class="${e.kind === 'bad' ? 'bad' : e.kind === 'warn' ? 'warn' : ''}"><span>T+${clock(e.t)} ${esc(e.text)}</span></li>`).join('');
    this.drawMap(d.querySelector('canvas')!, st);
  }

  private drawMap(c: HTMLCanvasElement, st: StationStatus) {
    const w = this.win!;
    const dpr = w.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d')!;
    g.fillStyle = '#161b21';
    g.fillRect(0, 0, W, H);
    // Масштаб — по плану, следу и аппарату.
    const pts = [...st.plan.flat(), ...this.track, st.truth, st.gcs, st.home, st.landing];
    let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (const p of pts) {
      e0 = Math.min(e0, p.east);
      e1 = Math.max(e1, p.east);
      n0 = Math.min(n0, p.north);
      n1 = Math.max(n1, p.north);
    }
    const pad = 40 * dpr;
    const k = Math.min((W - 2 * pad) / Math.max(200, e1 - e0), (H - 2 * pad) / Math.max(200, n1 - n0));
    const ce = (e0 + e1) / 2;
    const cn = (n0 + n1) / 2;
    const x = (e: number) => W / 2 + (e - ce) * k;
    const y = (n: number) => H / 2 - (n - cn) * k;
    // Сетка 1 км.
    g.strokeStyle = '#222a32';
    g.lineWidth = 1;
    for (let e = Math.floor(e0 / 1000) * 1000 - 5000; e < e1 + 5000; e += 1000) {
      g.beginPath();
      g.moveTo(x(e), 0);
      g.lineTo(x(e), H);
      g.stroke();
    }
    for (let n = Math.floor(n0 / 1000) * 1000 - 5000; n < n1 + 5000; n += 1000) {
      g.beginPath();
      g.moveTo(0, y(n));
      g.lineTo(W, y(n));
      g.stroke();
    }
    const line = (p: { east: number; north: number }[], color: string, width: number, dash: number[] = []) => {
      if (p.length < 2) return;
      g.strokeStyle = color;
      g.lineWidth = width * dpr;
      g.setLineDash(dash.map((v) => v * dpr));
      g.beginPath();
      p.forEach((q, i) => (i ? g.lineTo(x(q.east), y(q.north)) : g.moveTo(x(q.east), y(q.north))));
      g.stroke();
      g.setLineDash([]);
    };
    for (const p of st.plan) line(p, '#ffd43b', 1.5, [6, 5]);
    line(this.track, '#ff6b6b', 2);
    const dot = (p: { east: number; north: number }, color: string, r: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(x(p.east), y(p.north), r * dpr, 0, Math.PI * 2);
      g.fill();
    };
    dot(st.home, '#69db7c', 5);
    g.strokeStyle = '#4dabf7';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.arc(x(st.landing.east), y(st.landing.north), 8 * dpr, 0, Math.PI * 2);
    g.stroke();
    dot(st.gcs, '#4dabf7', 5);
    // Аппарат — треугольник по курсу.
    const h = (st.truth.headingDeg * Math.PI) / 180;
    const ax = x(st.truth.east);
    const ay = y(st.truth.north);
    const s = 9 * dpr;
    g.fillStyle = '#ff6b6b';
    g.beginPath();
    g.moveTo(ax + Math.sin(h) * s * 1.4, ay - Math.cos(h) * s * 1.4);
    g.lineTo(ax + Math.sin(h + 2.5) * s, ay - Math.cos(h + 2.5) * s);
    g.lineTo(ax + Math.sin(h - 2.5) * s, ay - Math.cos(h - 2.5) * s);
    g.closePath();
    g.fill();
    // Масштабная линейка.
    const bar = [100, 200, 500, 1000, 2000, 5000].find((m) => m * k > 80 * dpr) ?? 5000;
    g.strokeStyle = '#d7dde4';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(W - pad - bar * k, H - 16 * dpr);
    g.lineTo(W - pad, H - 16 * dpr);
    g.stroke();
    g.fillStyle = '#d7dde4';
    g.font = `${11 * dpr}px system-ui`;
    g.textAlign = 'right';
    g.fillText(bar >= 1000 ? `${bar / 1000} км` : `${bar} м`, W - pad, H - 22 * dpr);
  }
}
