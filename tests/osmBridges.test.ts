import { describe, expect, it } from 'vitest';
import { bridgeDeckEnds, type OsmRoad } from '../src/sim/osm';

/*
 * Настил мостов (bridgeDeckEnds): высоты концов — по береговым концам цепочки линий-мостов,
 * а не по рельефу под каждым стыком (стык над руслом тянул бы настил к воде).
 */

const road = (line: number[], bridge: boolean): OsmRoad => ({ cls: 'primary', widthM: 10, paved: true, bridge, lit: false, line: new Float32Array(line) });
/** Берега на 150 и 140 м, между ними русло на 120 м. */
const ground = (e: number) => (e <= 0 ? 150 : e >= 900 ? 140 : 120);

describe('настил мостов', () => {
  it('мост из трёх линий: стыки над руслом — по длине между берегами', () => {
    const roads = [
      road([-100, 0, 0, 0], false),
      road([0, 0, 300, 0], true),
      road([300, 0, 600, 0], true),
      road([600, 0, 900, 0], true),
      road([900, 0, 1000, 0], false),
    ];
    const ends = bridgeDeckEnds(roads, ground);
    expect(ends[0]).toBeNull();
    expect(ends[4]).toBeNull();
    expect(ends[1]![0]).toBeCloseTo(150, 3);
    expect(ends[1]![1]).toBeCloseTo(146.667, 2);
    expect(ends[2]![0]).toBeCloseTo(146.667, 2);
    expect(ends[2]![1]).toBeCloseTo(143.333, 2);
    expect(ends[3]![0]).toBeCloseTo(143.333, 2);
    expect(ends[3]![1]).toBeCloseTo(140, 3);
  });

  it('одна линия — концы по рельефу; без мостов — пусто', () => {
    expect(bridgeDeckEnds([road([0, 0, 900, 0], true)], ground)).toEqual([[150, 140]]);
    expect(bridgeDeckEnds([road([0, 0, 900, 0], false)], ground)).toEqual([null]);
  });

  it('берег — где мост продолжается дорогой, даже если там сходятся две проезжие части', () => {
    const roads = [road([-100, 0, 0, 0], false), road([0, 0, 900, 0], true), road([0, 0, 900, 12], true)];
    const ends = bridgeDeckEnds(roads, ground);
    expect(ends[1]).toEqual([150, 140]);
    expect(ends[2]).toEqual([150, 140]);
  });

  it('кольцо из мостов без берегов — по рельефу', () => {
    const roads = [road([0, 0, 900, 0], true), road([900, 0, 0, 0], true)];
    expect(bridgeDeckEnds(roads, ground)).toEqual([
      [150, 140],
      [140, 150],
    ]);
  });
});
