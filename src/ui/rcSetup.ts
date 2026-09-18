import { axisValue, type AxisMap, type PilotInput, type RcMapping } from './pilotInput';

/*
 * Окно «Пульт ДУ»: какой пульт подключён, все его оси вживую, какая ось — какая ручка (с инверсией),
 * калибровка хода, мёртвая зона и экспонента. Настоящий пульт подключается по USB в режиме
 * джойстика (EdgeTX/OpenTX: USB → Joystick; у каналов в модели — CH1…CH4 на стики). Раскладка
 * сохраняется в браузере для этого пульта.
 */

type Fn = 'roll' | 'pitch' | 'yaw' | 'throttle';
const FNS: readonly [Fn, string][] = [
  ['roll', 'Крен (элероны)'],
  ['pitch', 'Тангаж (руль высоты)'],
  ['yaw', 'Рыскание (руль направления)'],
  ['throttle', 'Газ'],
];

const bar = (v: number) => `<span class="rcs-bar"><i style="left:${50 + Math.min(1, Math.max(-1, v)) * 50}%"></i></span>`;

export class RcSetup {
  private raf = 0;
  private lastId = '';
  private lastAxes = -1;
  /** Калибровка: 'range' — двигать стики до упоров, 'center' — отпустить в середину. */
  private cal: { step: 'range' | 'center'; min: number[]; max: number[]; timer: number } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly pilot: PilotInput,
  ) {
    el.addEventListener('change', (e) => this.onChange(e));
    el.addEventListener('input', (e) => this.onChange(e));
    el.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('gamepadconnected', () => this.build());
    window.addEventListener('gamepaddisconnected', () => this.build());
    this.build();
    // Окно видно — оси обновляются каждый кадр.
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (this.el.offsetParent === null) return;
      this.update();
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }

  private build() {
    const d = this.pilot.device();
    const m = this.pilot.mapping();
    this.lastId = d?.id ?? '';
    this.lastAxes = d?.axes.length ?? -1;
    if (!d || !m) {
      this.el.innerHTML = `<p class="hint">Пульт не найден. Подключите пульт по USB в режиме джойстика (EdgeTX/OpenTX: при подключении выберите «USB Joystick»; каналы CH1…CH4 — на стики) или геймпад и пошевелите стиками — браузер показывает пульт только после первого движения.</p>`;
      return;
    }
    const opts = (sel: number) => d.axes.map((_, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>ось ${i + 1}</option>`).join('');
    this.el.innerHTML = `
      <p class="rcs-dev"><b>${escapeHtml(d.id)}</b>${d.standard ? ' · геймпад' : ' · пульт'}</p>
      <div class="rcs-axes">${d.axes.map((_, i) => `<span>ось ${i + 1}</span>${bar(0)}`).join('')}</div>
      <table class="rcs-map"><tbody>
        ${FNS.map(
          ([f, title]) => `<tr data-fn="${f}"><td>${title}</td>
            <td><select data-rc="index">${opts(m[f].index)}</select></td>
            <td><label class="check"><input type="checkbox" data-rc="invert" ${m[f].invert ? 'checked' : ''}> инв.</label></td>
            <td class="rcs-out">${bar(0)}</td></tr>`,
        ).join('')}
      </tbody></table>
      <label class="range"><span>Мёртвая зона</span><output data-rco="deadzone">${Math.round(m.deadzone * 100)} %</output><input type="range" data-rc="deadzone" min="0" max="0.2" step="0.01" value="${m.deadzone}"></label>
      <label class="range"><span>Экспонента</span><output data-rco="expo">${Math.round(m.expo * 100)} %</output><input type="range" data-rc="expo" min="0" max="0.8" step="0.05" value="${m.expo}"></label>
      <p class="hint rcs-cal-hint">Режим 2: левый стик — газ и рыскание, правый — тангаж и крен. Середина газа — держать высоту. Если ручка идёт не в ту сторону — «инв.»</p>
      <div class="row"><button class="small" data-rca="cal">Калибровка</button><button class="small" data-rca="reset">По умолчанию</button></div>`;
  }

  private update() {
    const d = this.pilot.device();
    if ((d?.id ?? '') !== this.lastId || (d?.axes.length ?? -1) !== this.lastAxes) return this.build();
    const m = this.pilot.mapping();
    if (!d || !m) return;
    const raw = this.el.querySelectorAll<HTMLElement>('.rcs-axes .rcs-bar i');
    d.axes.forEach((v, i) => {
      const b = raw[i];
      if (b) b.style.left = `${50 + Math.max(-1, Math.min(1, v)) * 50}%`;
    });
    for (const [f] of FNS) {
      const b = this.el.querySelector<HTMLElement>(`tr[data-fn="${f}"] .rcs-out i`);
      if (b) b.style.left = `${50 + axisValue(d.axes[m[f].index] ?? 0, m[f]) * 50}%`;
    }
  }

  /** Калибровка: упоры осей — по таймеру, чтобы не пропустить быстрый ход стика между кадрами. */
  private sampleRange() {
    const c = this.cal;
    const d = this.pilot.device();
    if (c?.step !== 'range' || !d) return;
    d.axes.forEach((v, i) => {
      c.min[i] = Math.min(c.min[i] ?? v, v);
      c.max[i] = Math.max(c.max[i] ?? v, v);
    });
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.rc;
    const m = this.pilot.mapping();
    if (!k || !m) return;
    const next: RcMapping = { ...m, roll: { ...m.roll }, pitch: { ...m.pitch }, yaw: { ...m.yaw }, throttle: { ...m.throttle } };
    const fn = t.closest('tr')?.dataset.fn as Fn | undefined;
    if (k === 'index' && fn) next[fn].index = +t.value;
    else if (k === 'invert' && fn) next[fn].invert = (t as HTMLInputElement).checked;
    else if (k === 'deadzone' || k === 'expo') {
      next[k] = +t.value;
      const o = this.el.querySelector(`[data-rco="${k}"]`);
      if (o) o.textContent = `${Math.round(+t.value * 100)} %`;
    }
    this.pilot.setMapping(next);
  }

  private onClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-rca]');
    if (!b) return;
    const d = this.pilot.device();
    const m = this.pilot.mapping();
    if (!d || !m) return;
    const hint = this.el.querySelector<HTMLElement>('.rcs-cal-hint')!;
    if (b.dataset.rca === 'reset') {
      if (this.cal) clearInterval(this.cal.timer);
      this.cal = null;
      this.pilot.setMapping(null);
      return this.build();
    }
    if (!this.cal) {
      this.cal = { step: 'range', min: [], max: [], timer: window.setInterval(() => this.sampleRange(), 20) };
      b.textContent = 'Дальше';
      hint.textContent = 'Двигайте оба стика по кругу до упоров, газ — от низа до верха. Потом «Дальше».';
      return;
    }
    if (this.cal.step === 'range') {
      this.sampleRange();
      clearInterval(this.cal.timer);
      this.cal.step = 'center';
      b.textContent = 'Готово';
      hint.textContent = 'Отпустите стики в середину, газ поставьте в середину хода — и «Готово».';
      return;
    }
    // Середина — сейчас; упоры — что намерили (ось без хода — как было).
    const c = this.cal;
    const fix = (a: AxisMap): AxisMap => {
      const lo = c.min[a.index];
      const hi = c.max[a.index];
      const mid = d.axes[a.index] ?? 0;
      if (lo === undefined || hi === undefined || hi - lo < 0.2) return a;
      return { ...a, min: lo, max: hi, center: Math.min(hi - 0.05, Math.max(lo + 0.05, mid)) };
    };
    this.pilot.setMapping({ ...m, roll: fix(m.roll), pitch: fix(m.pitch), yaw: fix(m.yaw), throttle: fix(m.throttle) });
    this.cal = null;
    b.textContent = 'Калибровка';
    hint.textContent = 'Калибровка сохранена для этого пульта.';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
