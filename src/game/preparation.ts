import { mixSurfaces, neutralSurfaces, type Surfaces } from './surfaces';

/*
 * Предполётная подготовка по РЛЭ (прил. А.3–А.4): питание, связь, проверки СП, СВС, регуляторов
 * СВВП, БАНО, МЭД, миссия, ориентация против ветра, ПДУ, опрос перед взлётом. Проверки с
 * движением видны на модели: элероны и рули оперения, роторы по очереди, огни, маршевый. Без DOM.
 */

export type PrepStepId = 'power' | 'link' | 'servos' | 'airdata' | 'vtol' | 'lights' | 'pusher' | 'mission' | 'heading' | 'rc' | 'poll';

export interface PrepStepDef {
  id: PrepStepId;
  title: string;
  /** Что происходит и что проверить. */
  hint: string;
  durationS: number;
}

export const PREP_STEPS: readonly PrepStepDef[] = [
  { id: 'power', title: 'Подать питание на БВС', hint: 'Дождаться загрузки автопилота; загораются БАНО', durationS: 6 },
  { id: 'link', title: 'Связь с НСУ, телеметрия', hint: 'Крен, тангаж и координаты на авиагоризонте', durationS: 2 },
  { id: 'servos', title: 'СП — сервоприводы', hint: 'Элероны, затем рули V-оперения: вместе (руль высоты) и врозь (руль направления)', durationS: 9 },
  { id: 'airdata', title: 'СВС — воздушные сигналы', hint: 'Подуть в ПВД: приборная скорость в телеметрии растёт и возвращается к нулю', durationS: 4 },
  { id: 'vtol', title: 'Регуляторы СВВП', hint: 'Роторы 1–4 раскручиваются по очереди', durationS: 10 },
  { id: 'lights', title: 'БАНО — бортовые огни', hint: 'Огни и строб мигают', durationS: 3 },
  { id: 'pusher', title: 'МЭД — маршевый двигатель', hint: 'Маршевый винт раскручивается и останавливается', durationS: 4 },
  { id: 'mission', title: 'Передать миссию, контрольный запрос', hint: 'В миссии должна быть посадочная точка', durationS: 3 },
  { id: 'heading', title: 'Сориентировать БВС против ветра', hint: 'Носом туда, откуда дует', durationS: 3 },
  { id: 'rc', title: 'ПДУ: управление через пульт, автоматический режим', hint: 'Пульт включён и в автоматическом режиме', durationS: 1 },
  { id: 'poll', title: 'Опрос перед взлётом', hint: 'Погода, батарея, ГНСС, помехи — по предполётным проверкам', durationS: 1 },
];

export type PrepStatus = 'todo' | 'running' | 'done' | 'failed';

/** Что делает аппарат на земле во время проверки. */
export interface GroundTest {
  /** Загрузка роторов 1–4 (передний левый, передний правый, задний левый, задний правый) 0…1. */
  rotors: [number, number, number, number];
  pusher: number;
  /** Отклонения рулей −1…1 (src/game/surfaces.ts). */
  surfaces: Surfaces;
  /** Огни мигают часто. */
  lights: boolean;
  /** Приборная скорость на СВС, м/с. */
  airspeedMs: number;
  /** Идёт разворот носом против ветра: доля 0…1. */
  turnToWind: number | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const bump = (x: number) => Math.sin(Math.PI * clamp01(x));

export function idleTest(): GroundTest {
  return { rotors: [0, 0, 0, 0], pusher: 0, surfaces: neutralSurfaces(), lights: false, airspeedMs: 0, turnToWind: null };
}

export class Preparation {
  readonly status = Object.fromEntries(PREP_STEPS.map((s) => [s.id, 'todo'])) as Record<PrepStepId, PrepStatus>;
  /** Итог шага: что показала проверка или почему не прошла. */
  readonly result: Partial<Record<PrepStepId, string>> = {};
  private active: { id: PrepStepId; t0: number } | null = null;

  get done(): boolean {
    return PREP_STEPS.every((s) => this.status[s.id] === 'done');
  }

  get running(): PrepStepId | null {
    return this.active?.id ?? null;
  }

  /** Питание на борт подано: шаг «Подать питание» выполнен. */
  get powered(): boolean {
    return this.status.power === 'done';
  }

  /** Причина, по которой шаг сейчас начать нельзя, или null. Питание — первым, опрос — последним. */
  blocker(id: PrepStepId): string | null {
    if (this.active) return 'Идёт другая проверка';
    if (id !== 'power' && this.status.power !== 'done') return 'Сначала подать питание';
    if (id === 'poll' && PREP_STEPS.some((s) => s.id !== 'poll' && this.status[s.id] !== 'done')) return 'Сначала остальные пункты';
    return null;
  }

  start(id: PrepStepId, t: number): string | null {
    const why = this.blocker(id);
    if (why) return why;
    this.status[id] = 'running';
    delete this.result[id];
    this.active = { id, t0: t };
    return null;
  }

  /**
   * Шаг времени t: что показывает аппарат. По окончании шага evaluate даёт итог:
   * { ok, text } — например, для миссии и опроса перед взлётом, которые зависят от обстановки.
   */
  update(t: number, evaluate: (id: PrepStepId) => { ok: boolean; text: string }): GroundTest {
    const test = idleTest();
    if (!this.active) return test;
    const { id, t0 } = this.active;
    const def = PREP_STEPS.find((s) => s.id === id)!;
    const tau = (t - t0) / def.durationS;
    switch (id) {
      case 'servos': {
        // Элероны, потом руль высоты (оба руля оперения вместе), потом руль направления (врозь): вверх-вниз.
        const k = Math.min(2, Math.floor(clamp01(tau) * 3));
        const x = Math.sin(clamp01(clamp01(tau) * 3 - k) * Math.PI * 2);
        test.surfaces = mixSurfaces(k === 0 ? x : 0, k === 1 ? x : 0, k === 2 ? x : 0);
        break;
      }
      case 'airdata':
        test.airspeedMs = 9 * bump(tau);
        break;
      case 'vtol': {
        const k = Math.min(3, Math.floor(clamp01(tau) * 4));
        test.rotors[k] = 0.35 * bump(clamp01(tau) * 4 - k);
        break;
      }
      case 'lights':
        test.lights = true;
        break;
      case 'pusher':
        test.pusher = 0.3 * bump(tau);
        break;
      case 'heading':
        test.turnToWind = clamp01(tau);
        break;
      default:
        break;
    }
    if (tau >= 1) {
      const r = evaluate(id);
      this.status[id] = r.ok ? 'done' : 'failed';
      this.result[id] = r.text;
      this.active = null;
    }
    return test;
  }

  reset() {
    for (const s of PREP_STEPS) this.status[s.id] = 'todo';
    for (const k of Object.keys(this.result)) delete this.result[k as PrepStepId];
    this.active = null;
  }
}
