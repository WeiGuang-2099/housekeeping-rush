import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allRooms, placeOf, walkMinutes } from '../src/engine/layout';
import { PARAMS } from '../src/engine/params';

const params = PARAMS.standard;
const service = params.layout.servicePoint;
const rooms = allRooms(params);

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
