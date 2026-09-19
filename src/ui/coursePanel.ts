/*
 * Окно «Курс подготовки»: курсанты (выбор, новый, перенос файлом), упражнения по модулям со
 * статусом (закрыто, открыто, сдано, лучший балл), у выбранного — цель, теория, вопросы допуска и
 * «Начать»; журнал налёта курсанта с итогами и выгрузкой в CSV. Логика — src/game/course.ts.
 */
import './coursePanel.css';
import {
  activeStudent,
  addStudent,
  COURSE,
  exportStudents,
  findExercise,
  importStudents,
  loadCourse,
  localStamp,
  logbookCsv,
  quizPassed,
  saveCourse,
  totals,
  unlocked,
  type CourseStore,
  type Exercise,
} from '../game/course';

export interface CoursePanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Хранилище курса изменилось (после полёта) — перечитать и перерисовать. */
  refresh(): void;
  onClose: (() => void) | null;
}

export interface CourseHandlers {
  /** Начать упражнение: тест пройден, упражнение открыто. */
  onStart(ex: Exercise): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hours = (s: number) => `${Math.floor(s / 3600)} ч ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} мин`;

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function createCoursePanel(h: CourseHandlers, parent: HTMLElement = document.body): CoursePanel {
  const el = document.createElement('div');
  el.className = 'win course-win';
  el.dataset['win'] = 'course';
  el.hidden = true;
  el.innerHTML = `<div class="win-title"><span>Курс подготовки</span><button class="x" title="Закрыть">✕</button></div>
    <div class="win-body">
      <div class="cw-top">
        <label>Курсант <select data-c="student"></select></label>
        <button data-c="add">Новый…</button>
        <button data-c="export" title="Курсант с журналом и прогрессом — файлом, для инструктора или другого компьютера">Сохранить файл</button>
        <button data-c="import">Загрузить файл…</button>
        <input type="file" accept=".json,application/json" data-c="file" hidden>
        <span class="cw-tabs"><button data-tab="ex" class="on">Упражнения</button><button data-tab="log">Журнал</button></span>
      </div>
      <div class="cw-totals"></div>
      <div class="cw-pane" data-pane="ex"><div class="cw-list"></div><div class="cw-detail"></div></div>
      <div class="cw-pane" data-pane="log" hidden></div>
    </div>`;
  parent.appendChild(el);
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  let store: CourseStore = loadCourse();
  let selected: string = COURSE[0]!.id;
  let tab: 'ex' | 'log' = 'ex';
  /** Ответы на вопросы выбранного упражнения (до проверки). */
  let answers: (number | null)[] = [];
  let checked = false;

  const render = () => {
    const s = activeStudent(store);
    q<HTMLSelectElement>('[data-c="student"]').innerHTML = store.students.length
      ? store.students.map((x) => `<option value="${esc(x.id)}" ${x.id === store.active ? 'selected' : ''}>${esc(x.name)}</option>`).join('')
      : '<option value="">— добавьте курсанта —</option>';
    q('[data-c="export"]').toggleAttribute('disabled', !s);
    const t = s ? totals(s) : null;
    q('.cw-totals').innerHTML = t
      ? `Сдано упражнений: <b>${t.passed} из ${COURSE.length}</b> · налёт <b>${hours(t.airborneS)}</b> · полётов ${t.flights} · посадок ${t.landings} · ${t.distanceKm.toFixed(0)} км · отказов отработано ${t.failures}${t.crashes ? ` · <span class="bad">аварий ${t.crashes}</span>` : ''}`
      : 'Прогресс и журнал ведутся на курсанта: добавьте его кнопкой «Новый…». Без курсанта упражнения можно пройти, но они не засчитываются.';
    el.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset['tab'] === tab));
    el.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset['pane'] !== tab));
    if (tab === 'ex') renderExercises();
    else renderLog();
  };

  const renderExercises = () => {
    const s = activeStudent(store);
    let module = '';
    q('.cw-list').innerHTML = COURSE.map((ex) => {
      const p = s?.progress[ex.id];
      const open = unlocked(s, ex) || !s;
      const status = p?.passed ? `<span class="ok">✓ ${p.best}</span>` : !open ? '<span class="lock">🔒</span>' : p?.attempts ? `<span class="warn">${p.best}</span>` : '';
      const head = ex.module !== module ? `<div class="cw-mod">${esc((module = ex.module))}</div>` : '';
      return `${head}<button class="cw-ex ${ex.id === selected ? 'sel' : ''} ${open ? '' : 'locked'}" data-ex="${ex.id}"><span>${esc(ex.title)}</span>${status}</button>`;
    }).join('');
    const ex = findExercise(selected)!;
    const p = s?.progress[ex.id];
    const open = unlocked(s, ex) || !s;
    const quizOk = !!p?.quiz || (checked && quizPassed(ex, answers));
    const quiz = ex.quiz
      .map((qq, i) => {
        const opts = qq.options
          .map((o, j) => {
            const mark = checked ? (j === qq.answer ? ' right' : answers[i] === j ? ' wrong' : '') : '';
            return `<label class="cw-opt${mark}"><input type="radio" name="q${i}" value="${j}" ${answers[i] === j ? 'checked' : ''} ${p?.quiz ? 'disabled' : ''}> ${esc(o)}</label>`;
          })
          .join('');
        return `<div class="cw-q"><div class="cw-qt">${i + 1}. ${esc(qq.q)}</div>${opts}${checked || p?.quiz ? `<div class="cw-why">${esc(qq.why)}</div>` : ''}</div>`;
      })
      .join('');
    q('.cw-detail').innerHTML = `
      <div class="cw-mod">${esc(ex.module)}</div>
      <h3>${esc(ex.title)}</h3>
      <p class="cw-goal">${esc(ex.goal)}</p>
      ${ex.theory.map((t) => `<p>${esc(t)}</p>`).join('')}
      <p class="cw-pass">Зачёт: не меньше ${ex.pass.minScore} баллов, без аварии${(ex.pass.items ?? []).map((i) => `; «${esc(i.title)}» — от ${Math.round(i.minShare * 100)} %`).join('')}.${
        p ? ` Попыток: ${p.attempts}, лучший результат ${p.best}${p.passed ? ' — сдано' : ''}.` : ''
      }</p>
      <h4>Допуск к полёту${p?.quiz ? ' — пройден' : ''}</h4>
      ${quiz}
      <div class="cw-actions">
        ${p?.quiz ? '' : `<button data-c="check">Проверить ответы</button>`}
        <button data-c="start" class="primary" ${open && quizOk ? '' : 'disabled'}>Начать упражнение</button>
        <span class="cw-note">${!open ? 'Сначала сдайте предыдущее упражнение.' : quizOk ? 'Задание, режим и погода выставятся сами; АРМ — как обычно.' : checked ? 'Есть ошибки — прочитайте пояснения и ответьте ещё раз.' : 'Ответьте на вопросы, чтобы получить допуск.'}</span>
      </div>`;
  };

  const renderLog = () => {
    const s = activeStudent(store);
    const pane = q('[data-pane="log"]');
    if (!s) {
      pane.innerHTML = '<p class="cw-note">Журнал ведётся на курсанта.</p>';
      return;
    }
    const rows = s.log
      .map(
        (e) =>
          `<tr><td>${esc(localStamp(e.at))}</td><td>${esc(e.exerciseId ? (findExercise(e.exerciseId)?.title ?? e.exerciseId) : '—')}</td><td>${esc(e.task)}<br><span class="cw-note">${esc(e.region)} · ${esc(e.difficulty)}</span></td><td>${(e.airborneS / 60).toFixed(1)}</td><td>${e.distanceKm.toFixed(1)}</td><td>${e.landings}</td><td>${esc(e.failures.join(', '))}</td><td>${e.score ?? '—'}</td><td>${e.crashed ? '<span class="bad">авария</span>' : e.passed === null ? '' : e.passed ? '<span class="ok">сдано</span>' : '<span class="warn">не сдано</span>'}</td></tr>`,
      )
      .join('');
    pane.innerHTML = `<div class="cw-log-actions"><button data-c="csv">Журнал в CSV (Excel)</button></div>
      <div class="tbl"><table><thead><tr><th>Дата</th><th>Упражнение</th><th>Задание</th><th>Мин</th><th>Км</th><th>Пос.</th><th>Отказы</th><th>Баллы</th><th>Итог</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="cw-note">Полётов пока нет</td></tr>'}</tbody></table></div>`;
  };

  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset['c'] === 'student') {
      store.active = t.value || null;
      saveCourse(store);
      answers = [];
      checked = false;
      render();
    } else if (t.name?.startsWith('q')) {
      answers[+t.name.slice(1)] = +t.value;
      checked = false;
    } else if (t.dataset['c'] === 'file' && t.files?.[0]) {
      void t.files[0].text().then((txt) => {
        try {
          const n = importStudents(store, txt);
          saveCourse(store);
          render();
          alert(`Загружено курсантов: ${n}`);
        } catch (err) {
          alert(`Файл не подходит: ${err instanceof Error ? err.message : String(err)}`);
        }
        t.value = '';
      });
    }
  });

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button, [data-ex]');
    if (!b) return;
    if (b.dataset['ex']) {
      selected = b.dataset['ex'];
      answers = [];
      checked = false;
      renderExercises();
      return;
    }
    if (b.dataset['tab']) {
      tab = b.dataset['tab'] as 'ex' | 'log';
      render();
      return;
    }
    const s = activeStudent(store);
    const ex = findExercise(selected)!;
    switch (b.dataset['c']) {
      case 'add': {
        const name = prompt('Фамилия и инициалы курсанта');
        if (name?.trim()) {
          addStudent(store, name);
          saveCourse(store);
          render();
        }
        break;
      }
      case 'export':
        if (s) download(exportStudents(store, [s.id]), `курсант-${s.name.replace(/[^\p{L}\p{N}]+/gu, '_')}.json`, 'application/json');
        break;
      case 'import':
        q<HTMLInputElement>('[data-c="file"]').click();
        break;
      case 'csv':
        if (s) download(logbookCsv(s), `журнал-${s.name.replace(/[^\p{L}\p{N}]+/gu, '_')}.csv`, 'text/csv');
        break;
      case 'check':
        checked = true;
        if (quizPassed(ex, answers) && s) {
          (s.progress[ex.id] ??= { attempts: 0, best: 0, passed: false, quiz: false }).quiz = true;
          saveCourse(store);
        }
        renderExercises();
        break;
      case 'start':
        panel.close();
        h.onStart(ex);
        break;
    }
  });

  const panel: CoursePanel = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    open() {
      store = loadCourse();
      el.hidden = false;
      render();
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      panel.onClose?.();
    },
    toggle() {
      if (el.hidden) panel.open();
      else panel.close();
    },
    refresh() {
      store = loadCourse();
      if (!el.hidden) render();
    },
    onClose: null,
  };
  q('.x').addEventListener('click', () => panel.close());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) panel.close();
  });
  const title = q('.win-title');
  title.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      el.style.transform = 'none';
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return panel;
}
