import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createHeatModel, HEAT_KINDS, HEAT_SIZE, HeatBodies, heatRig, limbAngles, marchToGround, type HeatKind } from '../src/ui/heat';

const box = (o: THREE.Object3D) => {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o, true);
};

/** Высота в холке: верх неподвижной части между передними и задними шарнирами ног. */
function withers(kind: HeatKind): number {
  const rig = heatRig(kind);
  const zs = rig.limbs.map((l) => l.pivot.z);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);
  const pos = rig.body.getAttribute('position');
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) >= z0 && pos.getZ(i) <= z1) top = Math.max(top, pos.getY(i));
  return top;
}

describe('тёплые тела: размеры моделей', () => {
  it('человек стоя — 1.75 м, в плечах 0.5 м, стоит на земле', () => {
    const b = box(createHeatModel('person'));
    const s = b.getSize(new THREE.Vector3());
    expect(s.y).toBeCloseTo(1.75, 1);
    expect(Math.abs(s.x - 0.5)).toBeLessThan(0.04);
    expect(Math.abs(b.min.y)).toBeLessThan(0.01);
  });

  it.each(HEAT_KINDS.filter((k) => k !== 'person'))('%s: длина и высота в холке — натуральные', (kind) => {
    const size = HEAT_SIZE[kind];
    const b = box(createHeatModel(kind));
    const s = b.getSize(new THREE.Vector3());
    expect(Math.abs(s.z / size.lengthM - 1)).toBeLessThan(0.06);
    expect(Math.abs(withers(kind) / size.heightM - 1)).toBeLessThan(0.06);
    // Голова и рога выше холки, но не намного.
    expect(s.y).toBeGreaterThanOrEqual(size.heightM * 0.99);
    expect(s.y).toBeLessThan(size.heightM * 1.6);
    expect(Math.abs(b.min.y)).toBeLessThan(0.01);
  });

  it('человек сидя и лёжа — ниже, на земле; лёжа — во весь рост вдоль курса', () => {
    const sit = box(createHeatModel('person', 'sitting'));
    expect(sit.getSize(new THREE.Vector3()).y).toBeGreaterThan(0.8);
    expect(sit.getSize(new THREE.Vector3()).y).toBeLessThan(1.05);
    expect(Math.abs(sit.min.y)).toBeLessThan(0.01);
    const lie = box(createHeatModel('person', 'lying'));
    const s = lie.getSize(new THREE.Vector3());
    expect(s.y).toBeLessThan(0.45);
    expect(s.z).toBeGreaterThan(1.6);
    expect(Math.abs(lie.min.y)).toBeLessThan(0.01);
    // Голова — по курсу (к −Z), ступни у начала.
    expect(lie.min.z).toBeLessThan(-1.6);
    expect(lie.max.z).toBeLessThan(0.3);
  });

  it('лежащий зверь ниже стоящего', () => {
    for (const kind of ['bear', 'moose', 'deer', 'wolf'] as const) {
      const up = box(createHeatModel(kind)).getSize(new THREE.Vector3()).y;
      const down = box(createHeatModel(kind, 'lying')).getSize(new THREE.Vector3()).y;
      expect(down).toBeLessThan(up * 0.8);
    }
  });

  it('у вершин есть цвет и нагрев 0…1, лицо горячее одежды', () => {
    for (const kind of HEAT_KINDS) {
      const heat = heatRig(kind).body.getAttribute('heat');
      expect(heatRig(kind).body.getAttribute('color')).toBeTruthy();
      for (let i = 0; i < heat.count; i++) {
        expect(heat.getX(i)).toBeGreaterThan(0);
        expect(heat.getX(i)).toBeLessThanOrEqual(1);
      }
    }
    const heat = heatRig('person').body.getAttribute('heat');
    let max = 0;
    for (let i = 0; i < heat.count; i++) max = Math.max(max, heat.getX(i));
    expect(max).toBe(1);
  });
});

describe('тёплые тела: позы', () => {
  it('стоя конечности прямые', () => {
    for (const kind of HEAT_KINDS) {
      const a = limbAngles(kind, 'standing', 0.3);
      expect([...a.legs, ...a.arms].every((x) => x === 0)).toBe(true);
    }
  });

  it('ходьба: зверь — рысью по диагонали, человек — ноги в противофазе, руки против ног', () => {
    const q = limbAngles('wolf', 'walking', 0.25);
    const [fl, fr, rl, rr] = q.legs as [number, number, number, number];
    expect(fl).toBeGreaterThan(0.2);
    expect(rr).toBeCloseTo(fl);
    expect(fr).toBeCloseTo(-fl);
    expect(rl).toBeCloseTo(-fl);
    expect(limbAngles('wolf', 'walking', 0.75).legs[0]).toBeCloseTo(-fl);
    const p = limbAngles('person', 'walking', 0.25);
    expect(p.legs[0]).toBeCloseTo(-p.legs[1]!);
    expect(Math.sign(p.arms[0]!)).toBe(-Math.sign(p.legs[0]!));
  });

  it('сидя ноги вытянуты вперёд', () => {
    const a = limbAngles('person', 'sitting');
    expect(a.legs.every((x) => x > 1.2 && x < Math.PI / 2 + 0.01)).toBe(true);
  });
});

describe('тёплые тела: в сцене', () => {
  const flat = () => 5;

  it('создаёт, обновляет и убирает по id; ставит на рельеф', () => {
    const bodies = new HeatBodies(flat);
    bodies.set([
      { id: 1, kind: 'person', east: 10, north: 20, headingDeg: 90 },
      { id: 2, kind: 'bear', east: -5, north: 0, headingDeg: 0, pose: 'walking', phase: 0.2 },
    ]);
    expect(bodies.count).toBe(2);
    const person = bodies.group.children.find((c) => c.name === 'heat-person')!;
    expect(person.position.toArray()).toEqual([10, 5, -20]);
    // Курс 90° — лицом на восток (+x).
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(person.quaternion);
    expect(dir.x).toBeCloseTo(1);
    bodies.set([{ id: 2, kind: 'wolf', east: 0, north: 0, headingDeg: 0 }]);
    expect(bodies.count).toBe(1);
    expect(bodies.group.children.map((c) => c.name)).toEqual(['heat-wolf']);
  });

  it('зверь на склоне наклоняется по склону, стоящий человек — нет', () => {
    const slope = (_e: number, n: number) => n * 0.3;
    const bodies = new HeatBodies(slope);
    bodies.set([
      { id: 1, kind: 'moose', east: 0, north: 0, headingDeg: 0 },
      { id: 2, kind: 'person', east: 0, north: 0, headingDeg: 0 },
    ]);
    const [moose, person] = bodies.group.children as [THREE.Object3D, THREE.Object3D];
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(moose.quaternion);
    expect(nose.y).toBeCloseTo(Math.sin(Math.atan(0.3)), 2);
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(person.quaternion).y).toBeCloseTo(1);
  });

  it('прячет дальние', () => {
    const bodies = new HeatBodies(flat);
    bodies.set([
      { id: 1, kind: 'deer', east: 100, north: 0, headingDeg: 0 },
      { id: 2, kind: 'deer', east: 3000, north: 0, headingDeg: 0 },
    ]);
    bodies.cull(new THREE.Vector3(0, 100, 0), 2000);
    expect(bodies.group.children.map((c) => c.visible)).toEqual([true, false]);
  });
});

describe('луч на рельеф', () => {
  it('на ровную землю под углом 45°', () => {
    const p = marchToGround({ east: 0, north: 0, up: 100 }, { east: 0, north: 1, up: -1 }, () => 0)!;
    expect(p.north).toBeCloseTo(100, 2);
    expect(p.east).toBeCloseTo(0, 6);
    expect(p.up).toBe(0);
  });

  it('горизонтально в склон', () => {
    const p = marchToGround({ east: 0, north: 0, up: 50 }, { east: 1, north: 0, up: 0 }, (e) => 0.5 * e)!;
    expect(p.east).toBeCloseTo(100, 2);
    expect(p.up).toBeCloseTo(50, 2);
  });

  it('в небо — null; из-под земли — точка под началом', () => {
    expect(marchToGround({ east: 0, north: 0, up: 100 }, { east: 1, north: 0, up: 0.2 }, () => 0)).toBeNull();
    expect(marchToGround({ east: 3, north: 4, up: -1 }, { east: 0, north: 0, up: -1 }, () => 0)).toEqual({ east: 3, north: 4, up: 0 });
  });
});
