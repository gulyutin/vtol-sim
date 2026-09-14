/*
 * Рули аппарата для 3D-вида: элероны на крыле и рули V-оперения. Отклонение −1…1, плюс —
 * задняя кромка вниз. В записи бортового журнала рули — команды автопилота; в полёте симулятора и
 * в его записях — по движению: элероны по скорости крена, рули оперения по скорости тангажа и
 * перегрузке в вираже. На висении и на земле рули в нейтрали. Без DOM.
 */

export interface Surfaces {
  /** Элероны крыла, левый и правый. */
  ailL: number;
  ailR: number;
  /** Рули V-оперения, левый и правый: вместе — руль высоты, врозь — руль направления. */
  tailL: number;
  tailR: number;
}

export const SURFACE_KEYS = ['ailL', 'ailR', 'tailL', 'tailR'] as const satisfies readonly (keyof Surfaces)[];

export const neutralSurfaces = (): Surfaces => ({ ailL: 0, ailR: 0, tailL: 0, tailR: 0 });

const clamp1 = (x: number) => Math.min(1, Math.max(-1, x));
const RAD = Math.PI / 180;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Смешение команд в рули; крен вправо, кабрирование и рыскание вправо — плюс. Крен вправо — правый
 * элерон вверх, левый вниз; кабрирование — оба руля оперения вверх; рыскание вправо — правый руль
 * V-оперения вниз, левый вверх (сила на хвосте — влево).
 */
export function mixSurfaces(roll: number, pitch: number, yaw: number): Surfaces {
  return { ailL: clamp1(roll), ailR: clamp1(-roll), tailL: clamp1(-pitch - yaw), tailR: clamp1(-pitch + yaw) };
}

/** Скорость крена, при которой элероны на полном отклонении, °/с. */
const ROLL_RATE_FULL_DEG_S = 40;
/** Скорость тангажа для полного отклонения рулей оперения, °/с. */
const PITCH_RATE_FULL_DEG_S = 15;
/** Кабрирование в вираже на единицу лишней перегрузки. */
const TURN_PITCH = 1.5;
/** Инерция рулевых машинок, с. */
const SERVO_TAU_S = 0.12;

/** Рули по движению аппарата — для полёта симулятора и записей без команд автопилота. */
export class SurfaceMotion {
  private prev: { t: number; bankDeg: number; pitchDeg: number } | null = null;
  private roll = 0;
  private pitch = 0;
  private out = neutralSurfaces();

  /** t — время полёта, с; plane — самолётный режим: рули работают, иначе уходят в нейтраль. */
  update(t: number, bankDeg: number, pitchDeg: number, plane: boolean): Surfaces {
    const p = this.prev;
    this.prev = { t, bankDeg, pitchDeg };
    const dt = p ? t - p.t : 0;
    // Пауза, прыжок по записи или время назад — рули как были.
    if (!p || !(dt > 0) || dt > 2) return this.out;
    let rollCmd = 0;
    let pitchCmd = 0;
    if (plane) {
      rollCmd = wrap180(bankDeg - p.bankDeg) / dt / ROLL_RATE_FULL_DEG_S;
      const n = 1 / Math.cos(Math.min(60, Math.abs(bankDeg)) * RAD);
      pitchCmd = (pitchDeg - p.pitchDeg) / dt / PITCH_RATE_FULL_DEG_S + TURN_PITCH * (n - 1);
    }
    const k = 1 - Math.exp(-dt / SERVO_TAU_S);
    this.roll += (clamp1(rollCmd) - this.roll) * k;
    this.pitch += (clamp1(pitchCmd) - this.pitch) * k;
    // Координация разворота: немного руля направления в сторону крена.
    this.out = mixSurfaces(this.roll, this.pitch, 0.3 * this.roll);
    return this.out;
  }

  reset() {
    this.prev = null;
    this.roll = 0;
    this.pitch = 0;
    this.out = neutralSurfaces();
  }
}
