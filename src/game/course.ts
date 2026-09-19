import type { DifficultyId, FailureEvent } from './scoring';
import type { ScenarioKind, Settings } from './scenarios';

/*
 * Курс подготовки оператора: упражнения по порядку, от знакомства с НСУ до зачёта. У каждого —
 * цель, короткая теория, вопросы допуска (без правильных ответов на все — к полёту не допускает),
 * задание (вид задания района, режим, погода, заданные отказы) и условие зачёта. Следующее
 * упражнение открывается, когда сдано предыдущее. Без DOM: прогресс и журнал — в хранилище
 * через globalThis (как итоги полётов).
 */

export interface QuizQuestion {
  q: string;
  options: string[];
  /** Индекс правильного варианта. */
  answer: number;
  /** Почему так — показывается после ответа. */
  why: string;
}

export interface Exercise {
  id: string;
  module: string;
  title: string;
  /** Чему учит — одной фразой. */
  goal: string;
  /** Теория перед полётом — абзацы. */
  theory: string[];
  quiz: QuizQuestion[];
  scenario: ScenarioKind;
  difficulty: DifficultyId;
  /** Поверх настроек задания района: ветер, время, погода в полёте. */
  settings?: Partial<Settings>;
  /** Заданные отказы (секунды от начала полёта) вместо случайных режима. */
  failures?: FailureEvent[];
  pass: {
    minScore: number;
    /** Пункты оценки, которые должны быть выполнены не меньше чем на долю (0…1). */
    items?: { title: string; minShare: number }[];
  };
}

const LINK_Q: QuizQuestion = {
  q: 'Связь с НСУ пропала. Что делает автопилот?',
  options: ['Сразу садится на месте', 'Продолжает режим, а через заданное время без связи выполняет действие из настроек задания (по умолчанию — ВОЗВРАТ)', 'Зависает в режиме коптера до восстановления связи'],
  answer: 1,
  why: 'Действие и время ожидания задаются в задании («Потеря связи»): ВОЗВРАТ, продолжать задание или посадка на месте.',
};

export const COURSE: readonly Exercise[] = [
  {
    id: 'c01',
    module: '1. Основы',
    title: 'Знакомство с НСУ',
    goal: 'Пройти полный цикл: задание, АРМ, взлёт, полёт по плану, посадка — без ветра и отказов.',
    theory: [
      'Слева — задание и настройки, в центре — карта, справа — 3D и приборы. Полёт идёт по миссии: автопилот взлетает вертикально, переходит в самолётный режим, выполняет маршрут и садится вертикально в точке посадки.',
      'Оператор следит за высотой, скоростью, зарядом и связью, вмешивается командами НСУ, если что-то идёт не по плану. Перед АРМ проверьте прогноз расхода: остаток после посадки должен быть не меньше запаса.',
    ],
    quiz: [
      {
        q: 'Как взлетает и садится аппарат 4+1?',
        options: ['С разбега, как самолёт', 'Вертикально на четырёх подъёмных роторах; маршевый винт — для полёта по маршруту', 'С катапульты, посадка на парашюте'],
        answer: 1,
        why: '«4+1» — четыре подъёмных ротора для висения и один маршевый винт для самолётного режима.',
      },
      {
        q: 'Что нужно проверить до АРМ?',
        options: ['Только погоду', 'Прогноз расхода энергии и остаток после посадки, миссию с точкой посадки, погоду', 'Ничего — автопилот всё проверит сам'],
        answer: 1,
        why: 'Предполётные проверки показывают расход и остаток; без точки посадки миссия не передаётся.',
      },
    ],
    scenario: 'transfer',
    difficulty: 'train',
    settings: { windSpeedMs: 0, localHour: 11 },
    pass: { minScore: 60 },
  },
  {
    id: 'c02',
    module: '1. Основы',
    title: 'Предполётная подготовка',
    goal: 'Выполнить подготовку по порядку РЛЭ и слетать в штатном режиме.',
    theory: [
      'В штатном режиме АРМ недоступен, пока не пройдена подготовка: питание, связь, сервоприводы, воздушные сигналы, регуляторы подъёмных роторов, огни, маршевый двигатель, передача миссии, ориентация против ветра, пульт, опрос перед взлётом.',
      'Проверки с движением видны на модели. Пропуск шага снимает баллы в пункте «Порядок по РЛЭ».',
    ],
    quiz: [
      {
        q: 'Как ориентируют аппарат перед взлётом?',
        options: ['Носом по ветру', 'Носом против ветра — туда, откуда дует', 'Неважно'],
        answer: 1,
        why: 'Против ветра — меньше сносит на висении и в переходе.',
      },
      {
        q: 'Что проверяют, дуя в ПВД?',
        options: ['Воздушные сигналы: приборная скорость в телеметрии растёт и возвращается к нулю', 'Компас', 'Связь с НСУ'],
        answer: 0,
        why: 'ПВД — приёмник воздушного давления, по нему считается приборная скорость.',
      },
    ],
    scenario: 'transfer',
    difficulty: 'normal',
    settings: { windSpeedMs: 3 },
    failures: [],
    pass: { minScore: 70, items: [{ title: 'Порядок по РЛЭ', minShare: 0.8 }] },
  },
  {
    id: 'c03',
    module: '2. Маршрут и ветер',
    title: 'Облёт по маршруту в ветер',
    goal: 'Выполнить маршрут при умеренном ветре, удержать высоту и линию пути.',
    theory: [
      'В ветер аппарат держит линию пути, разворачивая нос против ветра — идёт «крабом»; угол сноса тем больше, чем сильнее боковой ветер и меньше воздушная скорость.',
      'Против ветра путевая скорость падает, расход на километр растёт — проверяйте прогноз остатка с ветром на высоте полёта, а не у земли: наверху ветер сильнее.',
    ],
    quiz: [
      {
        q: 'Почему на карте нос аппарата смотрит мимо линии пути?',
        options: ['Отказ компаса', 'Боковой ветер: аппарат держит путь, разворачиваясь против ветра (снос)', 'Ошибка карты'],
        answer: 1,
        why: 'Угол сноса ≈ arcsin(боковой ветер / воздушная скорость).',
      },
      {
        q: 'Где ветер обычно сильнее?',
        options: ['У земли', 'На высоте полёта — трение о землю ослабляет ветер у поверхности', 'Одинаково'],
        answer: 1,
        why: 'Сдвиг ветра с высотой — сильнее в устойчивую погоду (ночью, утром).',
      },
    ],
    scenario: 'route',
    difficulty: 'normal',
    settings: { windSpeedMs: 7 },
    failures: [],
    pass: { minScore: 70 },
  },
  {
    id: 'c04',
    module: '2. Маршрут и ветер',
    title: 'Посадка при боковом ветре',
    goal: 'Посадить аппарат в точку при сильном ветре, выбрав курс захода.',
    theory: [
      'Заход на посадку по умолчанию — против ветра. Курс захода можно задать вручную (задание → «Заход на посадку», снять галочку «против ветра»), например из-за препятствий; тогда ветер будет боковым и сносить на висении.',
      'На висении аппарат держит точку роторами, но порыв сносит его — точность посадки хуже, расход на висении выше. Запас энергии в сильный ветер берите больше.',
    ],
    quiz: [
      {
        q: 'Какой курс захода даёт наименьший снос на посадке?',
        options: ['По ветру', 'Против ветра', 'Поперёк ветра'],
        answer: 1,
        why: 'Против ветра — меньше путевая скорость на снижении и меньше боковой снос.',
      },
    ],
    scenario: 'transfer',
    difficulty: 'normal',
    settings: { windSpeedMs: 10 },
    failures: [],
    pass: { minScore: 70, items: [{ title: 'Точность посадки', minShare: 0.6 }] },
  },
  {
    id: 'c05',
    module: '3. Особые случаи',
    title: 'Потеря связи',
    goal: 'Настроить действие при потере связи и проконтролировать, как автопилот его выполнил.',
    theory: [
      'В задании задаются действие при потере связи и время ожидания. Связь пропадает за рельефом, далеко от НСУ и в зонах помех; ретранслятор на высоте продлевает связь.',
      'Когда связь вернулась, проверьте режим: если автопилот уже на ВОЗВРАТЕ, решите — продолжать задание или вернуть аппарат.',
    ],
    quiz: [LINK_Q],
    scenario: 'route',
    difficulty: 'normal',
    settings: { windSpeedMs: 4 },
    failures: [{ t: 200, id: 'link' }],
    pass: { minScore: 65 },
  },
  {
    id: 'c06',
    module: '3. Особые случаи',
    title: 'Потеря ГНСС',
    goal: 'Распознать уход оценки места без ГНСС и посадить аппарат.',
    theory: [
      'Без ГНСС автопилот считает место по воздушной скорости, курсу и ветру, измеренному до отказа: оценка на НСУ уходит от истинного положения, маршрут выполняется со сносом, на висении точку не держит.',
      'Действия по РЛЭ: доложить, перевести в «Фэйлсейф», посадить вручную. Чем раньше заметили — тем ближе к точке посадки.',
    ],
    quiz: [
      {
        q: 'Что происходит на висении без ГНСС?',
        options: ['Аппарат точно держит точку', 'Точку не держит — сносит ветром', 'Автоматически садится'],
        answer: 1,
        why: 'Без спутников нет измерения положения, а снос ветром на висении ничем не компенсируется.',
      },
      {
        q: 'Первое действие при отказе по РЛЭ?',
        options: ['Выключить НСУ', 'Доложить руководителю полётов о неисправности', 'Продолжать задание, ничего не меняя'],
        answer: 1,
        why: 'Доклад — первый пункт у всех особых случаев.',
      },
    ],
    scenario: 'route',
    difficulty: 'normal',
    settings: { windSpeedMs: 5 },
    failures: [{ t: 240, id: 'gnss' }],
    pass: { minScore: 65, items: [{ title: 'Действия при отказах', minShare: 0.5 }] },
  },
  {
    id: 'c07',
    module: '3. Особые случаи',
    title: 'Отказ маршевого винта',
    goal: 'Перейти в коптер и сесть, пока хватает высоты и энергии.',
    theory: [
      'Без маршевого винта в самолётном режиме — только планирование со снижением. Подъёмные роторы работают: переход в коптер и посадка — на месте или на ближайшей площадке.',
      '«Запуск маршевого» не поможет — винта нет. Висение дорого по энергии: не тяните с посадкой.',
    ],
    quiz: [
      {
        q: 'Маршевый винт оторвался в самолётном режиме. Что делать?',
        options: ['Запустить маршевый снова', 'Перейти в режим коптера и посадить аппарат', 'Продолжать маршрут на планировании'],
        answer: 1,
        why: 'Подъёмные роторы целы — аппарат можно посадить вертикально.',
      },
    ],
    scenario: 'transfer',
    difficulty: 'normal',
    settings: { windSpeedMs: 4 },
    failures: [{ t: 300, id: 'pusher' }],
    pass: { minScore: 55, items: [{ title: 'Действия при отказах', minShare: 0.5 }] },
  },
  {
    id: 'c08',
    module: '4. Задачи',
    title: 'Аэрофотосъёмка участка',
    goal: 'Спланировать съёмку (разрешение, перекрытия, выдержка) и покрыть участок годными кадрами.',
    theory: [
      'Разрешение на земле (GSD) задаёт высоту съёмки; продольное и поперечное перекрытие — шаг кадров и галсов. Для сшивки нужно не меньше 60–80 % вдоль и 40–70 % поперёк.',
      'Смаз: за выдержку аппарат пролетает больше пикселя — кадр негоден. Короче выдержка — темнее кадр; утром и вечером света мало. После полёта — ортофотоплан и кадры для Metashape.',
    ],
    quiz: [
      {
        q: 'Как уменьшить смаз кадров?',
        options: ['Увеличить выдержку', 'Сократить выдержку или скорость, снимать при хорошем освещении', 'Уменьшить перекрытие'],
        answer: 1,
        why: 'Смаз = путевая скорость × выдержка / размер пикселя на земле.',
      },
      {
        q: 'Что происходит при слишком малом перекрытии?',
        options: ['Ничего', 'Между кадрами остаются пропуски — ортофотоплан с дырами', 'Кадры темнеют'],
        answer: 1,
        why: 'Программа сшивки находит общие точки только на перекрывающихся частях кадров.',
      },
    ],
    scenario: 'survey',
    difficulty: 'normal',
    settings: { windSpeedMs: 4, localHour: 12 },
    failures: [],
    pass: { minScore: 70 },
  },
  {
    id: 'c09',
    module: '4. Задачи',
    title: 'Поиск человека',
    goal: 'Найти людей тепловизором, отметить их и навести спасательную группу.',
    theory: [
      'Тепловизор видит тёплые тела под редким пологом и в сумерках; в плотном ельнике и на солнечном склоне контраст хуже. Отметка — щелчок по цели в окне подвеса; ложные отметки снимают баллы.',
      'Задержка видеоканала: картинка приходит с опозданием — не спешите со щелчком, наводите по центру кадра.',
    ],
    quiz: [
      {
        q: 'Почему цель на видео «убегает» от курсора?',
        options: ['Отказ подвеса', 'Задержка видеоканала: картинка приходит с опозданием', 'Слишком высоко'],
        answer: 1,
        why: 'Кадр показывает, что было доли секунды назад; аппарат и подвес уже сдвинулись.',
      },
    ],
    scenario: 'search',
    difficulty: 'normal',
    failures: [],
    pass: { minScore: 65, items: [{ title: 'Найдены люди', minShare: 0.5 }] },
  },
  {
    id: 'c10',
    module: '4. Задачи',
    title: 'Пожарный патруль',
    goal: 'Обнаружить очаги по дыму и тепловизору, доложить координаты и навести расчёт.',
    theory: [
      'Дым виден издалека в обычной камере, очаг — в тепловизоре. Донесение даёт координаты: чем точнее отметка, тем быстрее расчёт найдёт огонь.',
    ],
    quiz: [
      {
        q: 'Чем точнее всего определить место очага?',
        options: ['По дыму на горизонте', 'Отметкой по очагу в тепловизоре, когда он в центре кадра', 'По карте на глаз'],
        answer: 1,
        why: 'Дым сносит ветром; очаг в тепловизоре — там, где горит.',
      },
    ],
    scenario: 'fire',
    difficulty: 'normal',
    failures: [],
    pass: { minScore: 65 },
  },
  {
    id: 'c11',
    module: '5. Сложные условия',
    title: 'Смена погоды в полёте',
    goal: 'Заметить приближение фронта и принять решение: продолжать, сократить маршрут или вернуться.',
    theory: [
      'Холодный фронт приносит поворот и усиление ветра, порывы, ливень; гроза — сильные нисходящие потоки и молнии. Прогноз и небо впереди подскажут — не входите в грозовое облако.',
      'Решение о возврате принимайте, пока хватает энергии на обратный путь против усилившегося ветра.',
    ],
    quiz: [
      {
        q: 'Впереди по маршруту грозовое облако. Что делать?',
        options: ['Пролететь под ним', 'Обойти или вернуться — в грозе сильные нисходящие потоки и порывы', 'Набрать высоту и пройти сверху'],
        answer: 1,
        why: 'Гроза опасна потоками, ливнем и молниями на всех высотах, доступных аппарату.',
      },
    ],
    scenario: 'route',
    difficulty: 'hard',
    settings: { weatherEvent: 'front' },
    failures: [],
    pass: { minScore: 60 },
  },
  {
    id: 'c12',
    module: '5. Сложные условия',
    title: 'Отказ в сложных условиях',
    goal: 'Справиться со случайным отказом при порывистом ветре — без предупреждения.',
    theory: ['Отказ и время неизвестны заранее. Следите за тревогами и телеметрией; действуйте по РЛЭ — действия перечислены в тревоге об отказе.'],
    quiz: [
      {
        q: 'Отказ компаса в самолётном режиме. Можно ли продолжать?',
        options: ['Нет, сразу садиться', 'Да: в самолётном режиме курс берётся по ГНСС; в точке посадки — «Фэйлсейф» и ручная посадка', 'Да, и садиться в автомате'],
        answer: 1,
        why: 'На висении без компаса курс уплывает — аппарат уходит по спирали.',
      },
      LINK_Q,
    ],
    scenario: 'route',
    difficulty: 'hard',
    pass: { minScore: 60 },
  },
  {
    id: 'c13',
    module: '6. Зачёт',
    title: 'Зачётный полёт',
    goal: 'Выполнить задание в дождь и низкую облачность с серьёзными отказами — оценка как у инструктора.',
    theory: ['Зачёт: подготовка обязательна, отказы серьёзные и без предупреждения. Проходной балл — 70, без аварии и грубых нарушений.'],
    quiz: [
      {
        q: 'Возгорание на борту. Сколько времени до отказа питания?',
        options: ['Около минуты — садиться нужно раньше', 'Час', 'Питание не откажет'],
        answer: 0,
        why: 'Горит батарея: она разряжается быстрее, а примерно через минуту борт обесточивается.',
      },
      {
        q: 'Отказ подъёмных роторов (СВВП). Как садиться?',
        options: ['Вертикально', 'Самолётом на брюхо — на малой скорости и полого', 'Ждать восстановления'],
        answer: 1,
        why: 'Без роторов висеть нельзя — только посадка по-самолётному.',
      },
    ],
    scenario: 'transfer',
    difficulty: 'exam',
    pass: { minScore: 70 },
  },
];

export const findExercise = (id: string | null | undefined): Exercise | undefined => COURSE.find((e) => e.id === id);

/* ------------------------------ Оценка упражнения ------------------------------ */

export interface ExerciseResult {
  passed: boolean;
  /** Почему не сдано — по пунктам; пусто, если сдано. */
  reasons: string[];
}

/** Сдано ли упражнение по оценке полёта. */
export function judgeExercise(ex: Exercise, a: { total: number; items: readonly { title: string; points: number; max: number }[] }, crashed: boolean): ExerciseResult {
  const reasons: string[] = [];
  if (crashed) reasons.push('авария');
  if (a.total < ex.pass.minScore) reasons.push(`${a.total} баллов — нужно ${ex.pass.minScore}`);
  for (const need of ex.pass.items ?? []) {
    const it = a.items.find((i) => i.title === need.title);
    if (!it || it.max <= 0) continue;
    const share = it.points / it.max;
    if (share < need.minShare) reasons.push(`«${need.title}»: ${Math.round(share * 100)} % — нужно ${Math.round(need.minShare * 100)} %`);
  }
  return { passed: reasons.length === 0, reasons };
}

/** Прошёл ли тест допуска: все ответы верны. */
export function quizPassed(ex: Exercise, answers: readonly (number | null)[]): boolean {
  return ex.quiz.every((q, i) => answers[i] === q.answer);
}

/* ----------------------------- Курсанты и журнал ----------------------------- */

export interface ExerciseProgress {
  attempts: number;
  best: number;
  passed: boolean;
  quiz: boolean;
  /** ISO-время последней попытки. */
  lastAt?: string;
}

export interface LogEntry {
  at: string;
  exerciseId?: string;
  task: string;
  region: string;
  difficulty: string;
  airborneS: number;
  distanceKm: number;
  landings: number;
  failures: string[];
  score: number | null;
  passed: boolean | null;
  crashed: boolean;
}

export interface Student {
  id: string;
  name: string;
  progress: Record<string, ExerciseProgress>;
  log: LogEntry[];
}

export interface CourseStore {
  active: string | null;
  students: Student[];
}

const KEY = 'vtol-sim:course';
type KeyValueStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const ls = () => (globalThis as { localStorage?: KeyValueStore }).localStorage;

export function loadCourse(): CourseStore {
  try {
    const raw = JSON.parse(ls()?.getItem(KEY) ?? 'null') as CourseStore | null;
    if (raw && Array.isArray(raw.students)) return { active: raw.active ?? null, students: raw.students.filter((s) => s && typeof s.id === 'string') };
  } catch {
    // Повреждённое хранилище — начинаем с чистого.
  }
  return { active: null, students: [] };
}

export function saveCourse(c: CourseStore): void {
  try {
    ls()?.setItem(KEY, JSON.stringify(c));
  } catch {
    // Переполнено или запрещено — прогресс останется только в этом сеансе.
  }
}

export function addStudent(c: CourseStore, name: string): Student {
  const s: Student = { id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name: name.trim() || 'Курсант', progress: {}, log: [] };
  c.students.push(s);
  c.active = s.id;
  return s;
}

export const activeStudent = (c: CourseStore): Student | undefined => c.students.find((s) => s.id === c.active);

/** Открыто ли упражнение: первое — всегда, дальше — если сдано предыдущее. */
export function unlocked(s: Student | undefined, ex: Exercise): boolean {
  const i = COURSE.indexOf(ex);
  if (i <= 0) return true;
  return !!s?.progress[COURSE[i - 1]!.id]?.passed;
}

/** Записать попытку: журнал (всегда) и прогресс упражнения (если полёт — упражнение курса). */
export function recordFlight(s: Student, e: LogEntry): void {
  s.log.unshift(e);
  if (s.log.length > 500) s.log.length = 500;
  if (!e.exerciseId) return;
  const p = (s.progress[e.exerciseId] ??= { attempts: 0, best: 0, passed: false, quiz: false });
  p.attempts++;
  p.best = Math.max(p.best, e.score ?? 0);
  p.passed ||= !!e.passed;
  p.lastAt = e.at;
}

export interface Totals {
  flights: number;
  airborneS: number;
  landings: number;
  distanceKm: number;
  failures: number;
  crashes: number;
  passed: number;
}

export function totals(s: Student): Totals {
  const t: Totals = { flights: s.log.length, airborneS: 0, landings: 0, distanceKm: 0, failures: 0, crashes: 0, passed: 0 };
  for (const e of s.log) {
    t.airborneS += e.airborneS;
    t.landings += e.landings;
    t.distanceKm += e.distanceKm;
    t.failures += e.failures.length;
    if (e.crashed) t.crashes++;
  }
  t.passed = COURSE.filter((ex) => s.progress[ex.id]?.passed).length;
  return t;
}

/** Местные дата и время записи журнала: «2026-09-19 10:48». */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Журнал налёта курсанта — CSV для Excel (разделитель «;», с BOM). */
export function logbookCsv(s: Student, exerciseTitle: (id: string) => string = (id) => findExercise(id)?.title ?? id): string {
  const head = ['Дата', 'Курсант', 'Упражнение', 'Задание', 'Район', 'Режим', 'Налёт, мин', 'Путь, км', 'Посадок', 'Отказы', 'Баллы', 'Сдано', 'Авария'];
  const rows = s.log.map((e) => [
    localStamp(e.at),
    s.name,
    e.exerciseId ? exerciseTitle(e.exerciseId) : '',
    e.task,
    e.region,
    e.difficulty,
    (e.airborneS / 60).toFixed(1).replace('.', ','),
    e.distanceKm.toFixed(1).replace('.', ','),
    e.landings,
    e.failures.join(', '),
    e.score ?? '',
    e.passed === null ? '' : e.passed ? 'да' : 'нет',
    e.crashed ? 'да' : '',
  ]);
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

/** Курсанты целиком — JSON для переноса на другой компьютер (инструктору). */
export const exportStudents = (c: CourseStore, ids?: string[]) => JSON.stringify({ format: 'vtol-sim-course', version: 1, students: c.students.filter((s) => !ids || ids.includes(s.id)) }, null, 1);

/** Добавить курсантов из JSON; тот же id — заменяется. Возвращает число добавленных. */
export function importStudents(c: CourseStore, json: string): number {
  const d = JSON.parse(json) as { format?: string; students?: Student[] };
  if (d.format !== 'vtol-sim-course' || !Array.isArray(d.students)) throw new Error('это не файл курса');
  let n = 0;
  for (const s of d.students) {
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') continue;
    const clean: Student = { id: s.id, name: s.name, progress: s.progress ?? {}, log: Array.isArray(s.log) ? s.log : [] };
    const i = c.students.findIndex((x) => x.id === s.id);
    if (i >= 0) c.students[i] = clean;
    else c.students.push(clean);
    n++;
  }
  return n;
}
