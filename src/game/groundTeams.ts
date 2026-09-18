/*
 * Наземные группы: по отметке оператора (поиск) или донесению о дыме (патруль) от лагеря
 * выезжает машина, останавливается в DRIVE_SHORT_M от точки (дальше — лес), группа идёт пешком
 * и докладывает о прибытии. Плюс расчёт у НСУ. Положения — по времени полёта; для 3D и тепловизора
 * — тела людей и машины, для карты — где группа.
 */

export interface Pt {
  east: number;
  north: number;
}

export interface GroundTeam {
  id: number;
  name: string;
  from: Pt;
  to: Pt;
  /** Когда выехали, с по часам полёта. */
  t0: number;
  members: number;
}

export interface CrewBody {
  id: number;
  east: number;
  north: number;
  headingDeg: number;
  pose: 'standing' | 'sitting' | 'walking';
  phase: number;
}

export interface CrewVehicle {
  id: number;
  east: number;
  north: number;
  headingDeg: number;
}

const DRIVE_MS = 7;
const WALK_MS = 1.2;
/** Машина не доезжает до точки: дальше — пешком. */
const DRIVE_SHORT_M = 700;
/** Люди в колонне — через столько метров. */
const SPACING_M = 3;
/** Расчёт у НСУ — рядом со столом и машиной лагеря (scene.ts createCamp). */
const CAMP: readonly (CrewBody & { pose: 'standing' | 'sitting' })[] = [
  { id: 900_001, east: -12.8, north: -10.3, headingDeg: 330, pose: 'sitting', phase: 0 },
  { id: 900_002, east: -10.6, north: -10.9, headingDeg: 20, pose: 'standing', phase: 0 },
  { id: 900_003, east: -19.5, north: -12.4, headingDeg: 120, pose: 'standing', phase: 0 },
];

const headingOf = (a: Pt, b: Pt) => ((((Math.atan2(b.east - a.east, b.north - a.north) * 180) / Math.PI) % 360) + 360) % 360;

/** Где на пути группа в момент t: машина — до высадки, люди — после. */
function progress(team: GroundTeam, t: number) {
  const d = Math.hypot(team.to.east - team.from.east, team.to.north - team.from.north);
  const drive = Math.max(0, d - DRIVE_SHORT_M);
  const walk = d - drive;
  const dt = Math.max(0, t - team.t0);
  const driveS = drive / DRIVE_MS;
  const along = dt < driveS ? dt * DRIVE_MS : Math.min(d, drive + (dt - driveS) * WALK_MS);
  return { d, drive, along, onFoot: dt >= driveS, arrived: dt >= driveS + walk / WALK_MS };
}

const at = (team: GroundTeam, s: number): Pt => {
  const d = Math.hypot(team.to.east - team.from.east, team.to.north - team.from.north) || 1;
  const f = Math.max(0, Math.min(1, s / d));
  return { east: team.from.east + (team.to.east - team.from.east) * f, north: team.from.north + (team.to.north - team.from.north) * f };
};

export class GroundTeams {
  readonly teams: GroundTeam[] = [];
  private readonly reported = new Set<number>();
  private next = 1;

  /** Отправить группу от лагеря к точке; name — «Спасательная группа 1», «Пожарный расчёт 1». */
  dispatch(to: Pt, t: number, kind: 'rescue' | 'fire', from: Pt = { east: -21, north: -15 }): GroundTeam {
    const n = this.teams.filter((x) => x.name.startsWith(kind === 'rescue' ? 'Спас' : 'Пож')).length + 1;
    const team: GroundTeam = { id: this.next++, name: kind === 'rescue' ? `Спасательная группа ${n}` : `Пожарный расчёт ${n}`, from, to, t0: t, members: kind === 'rescue' ? 3 : 2 };
    this.teams.push(team);
    return team;
  }

  clear() {
    this.teams.length = 0;
    this.reported.clear();
    this.next = 1;
  }

  /** Люди: расчёт у НСУ и группы (в машине не видны — едут). */
  bodies(t: number): CrewBody[] {
    const out: CrewBody[] = CAMP.map((c) => ({ ...c }));
    for (const team of this.teams) {
      const p = progress(team, t);
      if (!p.onFoot) continue;
      const h = headingOf(team.from, team.to);
      for (let i = 0; i < team.members; i++) {
        const pos = at(team, Math.max(p.drive, p.along - i * SPACING_M));
        out.push({ id: 910_000 + team.id * 10 + i, east: pos.east + (i % 2 ? 0.8 : -0.4), north: pos.north, headingDeg: h, pose: p.arrived ? 'standing' : 'walking', phase: ((t * 1.6 + i * 0.37) % 1 + 1) % 1 });
      }
    }
    return out;
  }

  /** Машины групп: едут, потом стоят у места высадки. */
  vehicles(t: number): CrewVehicle[] {
    return this.teams.map((team) => {
      const p = progress(team, t);
      const pos = at(team, Math.min(p.along, p.drive));
      return { id: team.id, east: pos.east, north: pos.north, headingDeg: headingOf(team.from, team.to) };
    });
  }

  /** Где группы для карты: голова колонны или машина, и прибыли ли. */
  positions(t: number): { name: string; at: Pt; arrived: boolean }[] {
    return this.teams.map((team) => {
      const p = progress(team, t);
      return { name: team.name, at: at(team, p.along), arrived: p.arrived };
    });
  }

  /** Только что прибывшие (каждая — один раз): для доклада в консоли. */
  arrivals(t: number): GroundTeam[] {
    const out: GroundTeam[] = [];
    for (const team of this.teams) {
      if (this.reported.has(team.id) || !progress(team, t).arrived) continue;
      this.reported.add(team.id);
      out.push(team);
    }
    return out;
  }

  /** Сколько идти группе до точки, с (для сводки при отправке). */
  static etaS(from: Pt, to: Pt): number {
    const d = Math.hypot(to.east - from.east, to.north - from.north);
    const drive = Math.max(0, d - DRIVE_SHORT_M);
    return drive / DRIVE_MS + (d - drive) / WALK_MS;
  }
}
