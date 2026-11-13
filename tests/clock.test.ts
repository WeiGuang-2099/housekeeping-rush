import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromClock, toClock } from '../src/engine/clock';

describe('clock', () => {
  it('开工后的分钟数换算成钟点', () => {
    expect(toClock(0)).toBe('08:30');
    expect(toClock(120)).toBe('10:30');
    expect(toClock(270)).toBe('13:00');
    expect(toClock(450)).toBe('16:00');
    expect(toClock(510)).toBe('17:00');
  });

  it('钟点换算成开工后的分钟数', () => {
    expect(fromClock('08:30')).toBe(0);
    expect(fromClock('14:30')).toBe(360);
    expect(fromClock('8:00')).toBe(-30);
  });

  it('来回换算不丢信息', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 510 }), (minute) => {
        expect(fromClock(toClock(minute))).toBe(minute);
      }),
    );
  });

  it('格式不对会报错', () => {
    expect(() => fromClock('下午一点')).toThrow();
    expect(() => fromClock('25:00')).toThrow();
    expect(() => fromClock('12:60')).toThrow();
  });
});
