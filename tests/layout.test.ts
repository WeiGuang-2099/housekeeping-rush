import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allRooms, placeOf, walkMinutes, walkPath } from '../src/engine/layout';
import { PARAMS, type Params } from '../src/engine/params';
import type { Place } from '../src/engine/types';

const params = PARAMS.standard;
const service = params.layout.servicePoint;
const rooms = allRooms(params);

const key = (place: Place): string => `${place.floor}:${place.door}`;

/** 相邻的两项配成对。 */
function consecutive<T>(list: readonly T[]): [T, T][] {
  return list.flatMap((item, i): [T, T][] => {
    const next = list[i + 1];
    return next === undefined ? [] : [[item, next]];
  });
}

/** 列表恰好一项时返回这一项，否则测试失败。 */
function only<T>(list: readonly T[], label: string): T {
  expect(list, label).toHaveLength(1);
  const [item] = list;
  if (item === undefined) throw new Error(`${label}：列表为空`);
  return item;
}

/** 服务间和全部房间门位，去掉重复。 */
function placesOf(p: Params): Place[] {
  const all = [p.layout.servicePoint, ...allRooms(p).map((room) => placeOf(room, p))];
  return [...new Map(all.map((place) => [key(place), place])).values()];
}

/** walkPath 对任意起点和终点都要满足的性质。 */
function expectValidPath(a: Place, b: Place, p: Params): void {
  const { walkMinutesPerDoor, liftMinutes } = p.layout;
  const path = walkPath(a, b, p);
  const label = `${key(a)} 到 ${key(b)}`;

  // 第一项是起点，offset 为 0；最后一项是终点，offset 等于 walkMinutes。
  expect(path[0], label).toEqual({ place: a, offset: 0 });
  expect(path[path.length - 1], label).toEqual({ place: b, offset: walkMinutes(a, b, p) });

  // offset 严格递增，每个门位只出现一次。
  for (const [prev, next] of consecutive(path)) expect(next.offset, label).toBeGreaterThan(prev.offset);
  expect(new Set(path.map((step) => key(step.place))).size, label).toBe(path.length);

  if (a.floor === b.floor) {
    if (a.door === b.door) expect(path, label).toHaveLength(1);
    // 同层：始终在本层，相邻两项门位相差 1，相隔一个门位的步行时间。
    for (const step of path) expect(step.place.floor, label).toBe(a.floor);
    for (const [prev, next] of consecutive(path)) {
      expect(Math.abs(next.place.door - prev.place.door), label).toBe(1);
      expect(next.offset - prev.offset, label).toBe(walkMinutesPerDoor);
    }
    // 不经过门位 0，除非端点就是门位 0。
    if (a.door !== 0 && b.door !== 0) expect(path.some((step) => step.place.door === 0), label).toBe(false);
    return;
  }

  // 跨层：两层的门位 0 各出现一次，两者紧挨着、相隔 liftMinutes；之前都在本层，之后都在目标层。
  const leave = only(path.filter((step) => step.place.floor === a.floor && step.place.door === 0), `${label} 本层电梯厅`);
  const arrive = only(path.filter((step) => step.place.floor === b.floor && step.place.door === 0), `${label} 目标层电梯厅`);
  expect(arrive.offset - leave.offset, label).toBe(liftMinutes);
  const liftAt = path.indexOf(arrive);
  expect(path.indexOf(leave), label).toBe(liftAt - 1);
  expect(path.slice(0, liftAt).every((step) => step.place.floor === a.floor), label).toBe(true);
  expect(path.slice(liftAt).every((step) => step.place.floor === b.floor), label).toBe(true);
  // 除了乘电梯那一段，相邻两项门位相差 1，相隔一个门位的步行时间。
  for (const [prev, next] of consecutive(path)) {
    if (prev === leave) continue;
    expect(Math.abs(next.place.door - prev.place.door), label).toBe(1);
    expect(next.offset - prev.offset, label).toBe(walkMinutesPerDoor);
  }
}

describe('layout', () => {
  it('每两间房对着同一个门位', () => {
    expect(placeOf(1201, params)).toEqual({ floor: 12, door: 1 });
    expect(placeOf(1202, params)).toEqual({ floor: 12, door: 1 });
    expect(placeOf(1208, params)).toEqual({ floor: 12, door: 4 });
    expect(placeOf(1301, params)).toEqual({ floor: 13, door: 1 });
    expect(placeOf(1307, params)).toEqual({ floor: 13, door: 4 });
  });

  it('不存在的房号会报错', () => {
    expect(() => placeOf(1401, params)).toThrow();
  });

  it('同层每个门位 1 分钟', () => {
    expect(walkMinutes(service, placeOf(1201, params), params)).toBe(1);
    expect(walkMinutes(service, placeOf(1208, params), params)).toBe(4);
    expect(walkMinutes(placeOf(1201, params), placeOf(1202, params), params)).toBe(0);
    expect(walkMinutes(placeOf(1203, params), placeOf(1207, params), params)).toBe(2);
  });

  it('跨层要走到电梯，乘 4 分钟，再走到门位', () => {
    expect(walkMinutes(service, placeOf(1301, params), params)).toBe(5);
    expect(walkMinutes(placeOf(1208, params), placeOf(1307, params), params)).toBe(12);
  });

  it('来回一样远，自己到自己是 0', () => {
    const anyRoom = fc.constantFrom(...rooms);
    fc.assert(
      fc.property(anyRoom, anyRoom, (a, b) => {
        const pa = placeOf(a, params);
        const pb = placeOf(b, params);
        expect(walkMinutes(pa, pb, params)).toBe(walkMinutes(pb, pa, params));
        expect(walkMinutes(pa, pa, params)).toBe(0);
      }),
    );
  });

  it('绕路不会更近（三角不等式）', () => {
    const anyRoom = fc.constantFrom(...rooms);
    fc.assert(
      fc.property(anyRoom, anyRoom, anyRoom, (a, b, c) => {
        const [pa, pb, pc] = [placeOf(a, params), placeOf(b, params), placeOf(c, params)];
        expect(walkMinutes(pa, pc, params)).toBeLessThanOrEqual(
          walkMinutes(pa, pb, params) + walkMinutes(pb, pc, params),
        );
      }),
    );
  });
});

describe('walkPath', () => {
  it('服务间到 1207：同层逐个门位走，每个门位 1 分钟', () => {
    // 1207 在 12 楼门位 4，walkMinutes 为 4。
    expect(walkPath(service, placeOf(1207, params), params)).toEqual([
      { place: { floor: 12, door: 0 }, offset: 0 },
      { place: { floor: 12, door: 1 }, offset: 1 },
      { place: { floor: 12, door: 2 }, offset: 2 },
      { place: { floor: 12, door: 3 }, offset: 3 },
      { place: { floor: 12, door: 4 }, offset: 4 },
    ]);
  });

  it('{12, 3} 到 {13, 2}：先走到本层电梯厅，乘电梯 4 分钟，再从 13 楼电梯厅走到门位 2', () => {
    // 12 楼走 3 个门位到电梯厅（第 3 分钟），电梯到 13 楼（3 + 4 = 7），再走 2 个门位（9）。
    // walkMinutes 为 (3 + 2) × 1 + 4 = 9。
    expect(walkPath({ floor: 12, door: 3 }, { floor: 13, door: 2 }, params)).toEqual([
      { place: { floor: 12, door: 3 }, offset: 0 },
      { place: { floor: 12, door: 2 }, offset: 1 },
      { place: { floor: 12, door: 1 }, offset: 2 },
      { place: { floor: 12, door: 0 }, offset: 3 },
      { place: { floor: 13, door: 0 }, offset: 7 },
      { place: { floor: 13, door: 1 }, offset: 8 },
      { place: { floor: 13, door: 2 }, offset: 9 },
    ]);
  });

  it('起点和终点相同时只有起点一项', () => {
    expect(walkPath(service, service, params)).toEqual([{ place: service, offset: 0 }]);
    const door = placeOf(1305, params);
    expect(walkPath(door, door, params)).toEqual([{ place: door, offset: 0 }]);
  });

  it('服务间和全部房间门位的任意组合都满足路径的性质', () => {
    const places = placesOf(params);
    const anyPlace = fc.constantFrom(...places);
    // examples 先把全部组合各跑一遍，随机部分再补抽。
    const everyPair = places.flatMap((a) => places.map((b): [Place, Place] => [a, b]));
    fc.assert(
      fc.property(anyPlace, anyPlace, (a, b) => expectValidPath(a, b, params)),
      { examples: everyPair },
    );
  });

  it('每个门位的步行时间和电梯时间都从 params 读', () => {
    // 每个门位 2 分钟，电梯 3 分钟，再加一层 14 楼（5 间房，门位 1 到 3）。
    const slow: Params = {
      ...params,
      layout: {
        ...params.layout,
        floors: [...params.layout.floors, { floor: 14, rooms: [1401, 1402, 1403, 1404, 1405] }],
        walkMinutesPerDoor: 2,
        liftMinutes: 3,
      },
    };
    // {12, 3} 到 {14, 2}：12 楼走 3 个门位到电梯厅（6），电梯 3 分钟（9），14 楼走 2 个门位（13）。
    // walkMinutes 为 (3 + 2) × 2 + 3 = 13。
    expect(walkPath({ floor: 12, door: 3 }, { floor: 14, door: 2 }, slow)).toEqual([
      { place: { floor: 12, door: 3 }, offset: 0 },
      { place: { floor: 12, door: 2 }, offset: 2 },
      { place: { floor: 12, door: 1 }, offset: 4 },
      { place: { floor: 12, door: 0 }, offset: 6 },
      { place: { floor: 14, door: 0 }, offset: 9 },
      { place: { floor: 14, door: 1 }, offset: 11 },
      { place: { floor: 14, door: 2 }, offset: 13 },
    ]);
    const places = placesOf(slow);
    for (const a of places) for (const b of places) expectValidPath(a, b, slow);
  });

  it('返回的门位都是新对象，不与入参共享', () => {
    const target = placeOf(1307, params);
    const path = walkPath(service, target, params);
    expect(path.length).toBeGreaterThan(1);
    expect(path[0]?.place).not.toBe(service);
    expect(path[path.length - 1]?.place).not.toBe(target);
    expect(only(walkPath(service, service, params), '原地').place).not.toBe(service);
  });
});
