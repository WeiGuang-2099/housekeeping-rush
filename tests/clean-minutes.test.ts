import { describe, expect, it } from 'vitest';
import { cleanMinutes, generate, PARAMS, type MessLevel, type Params, type RoomKind, type Tier } from '../src/engine';

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];
const KINDS: RoomKind[] = ['departure', 'stayover', 'dnd'];
const MESS_LEVELS: MessLevel[] = ['tidy', 'normal', 'disaster'];

/** 在标准档的基础上改房型的基础时间和脏乱系数，其余不变。 */
function withTimes(base: { departure?: number; stayover?: number }, multiplier: Partial<Record<MessLevel, number>>): Params {
  const params = PARAMS.standard;
  return {
    ...params,
    rooms: {
      departure: { ...params.rooms.departure, baseMinutes: base.departure ?? params.rooms.departure.baseMinutes },
      stayover: { ...params.rooms.stayover, baseMinutes: base.stayover ?? params.rooms.stayover.baseMinutes },
    },
    messMultiplier: { ...params.messMultiplier, ...multiplier },
  };
}

describe.each(TIERS)('cleanMinutes：%s 档', (tier) => {
  const params = PARAMS[tier];

  it('每种房型乘每档脏乱系数都得到整数分钟', () => {
    // 退房房基础 30 分钟，续住房 15 分钟，请勿打扰房用续住房的；系数 0.8、1.0、1.6。
    // 30 × 0.8 = 24，30 × 1.0 = 30，30 × 1.6 = 48；15 × 0.8 = 12，15 × 1.0 = 15，15 × 1.6 = 24。
    const expected: Record<RoomKind, Record<MessLevel, number>> = {
      departure: { tidy: 24, normal: 30, disaster: 48 },
      stayover: { tidy: 12, normal: 15, disaster: 24 },
      dnd: { tidy: 12, normal: 15, disaster: 24 },
    };
    const seen = new Set<number>();
    for (const kind of KINDS) {
      for (const mess of MESS_LEVELS) {
        const minutes = cleanMinutes(kind, mess, params);
        expect(Number.isInteger(minutes), `${kind} ${mess}`).toBe(true);
        expect(minutes, `${kind} ${mess}`).toBe(expected[kind][mess]);
        seen.add(minutes);
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([12, 15, 24, 30, 48]);
  });
});

describe('cleanMinutes：浮点误差和非整数', () => {
  it('浮点误差会被吸收：基础 45 分钟乘 1.4 得 63', () => {
    // 45 × 1.4 在浮点里是 62.99999999999999，离 63 不到 1e-9。
    expect(45 * 1.4).not.toBe(63);
    expect(cleanMinutes('departure', 'normal', withTimes({ departure: 45 }, { normal: 1.4 }))).toBe(63);
  });

  it('略高于整数的浮点误差也会被吸收：基础 50 分钟乘 1.1 得 55（用 Math.round，不是向上取整）', () => {
    // 50 × 1.1 在浮点里是 55.00000000000001，比 55 略大，离 55 不到 1e-9。向上取整会得到 56，离原值差将近 1，就会误报。
    expect(50 * 1.1).toBeGreaterThan(55);
    expect(cleanMinutes('departure', 'normal', withTimes({ departure: 50 }, { normal: 1.1 }))).toBe(55);
  });

  it('离整数远大于 1e-9 的值会抛错，即使远小于 0.5：基础 15 分钟乘 1.0000001', () => {
    // 15 × 1.0000001 = 15.0000015，离 15 约 1.5e-6：比容差 1e-9 大得多，不是浮点误差，而是真的不是整数分钟。
    expect(() => cleanMinutes('stayover', 'normal', withTimes({ stayover: 15 }, { normal: 1.0000001 }))).toThrow(/整数/);
  });

  it('真正的非整数会抛错：基础 15 分钟乘 1.5 得 22.5', () => {
    const params = withTimes({ stayover: 15 }, { disaster: 1.5 });
    expect(() => cleanMinutes('stayover', 'disaster', params)).toThrow(/整数/);
    // 请勿打扰房用续住房的基础时间，同样抛错。
    expect(() => cleanMinutes('dnd', 'disaster', params)).toThrow(/整数/);
    // 退房房 30 × 1.5 = 45 是整数，不受影响。
    expect(cleanMinutes('departure', 'disaster', params)).toBe(45);
  });

  it('系数不是有限数时也抛错', () => {
    expect(() => cleanMinutes('departure', 'normal', withTimes({}, { normal: Number.NaN }))).toThrow(/整数/);
    expect(() => cleanMinutes('departure', 'normal', withTimes({}, { normal: Number.POSITIVE_INFINITY }))).toThrow(
      /整数/,
    );
  });
});

describe('cleanMinutes：请勿打扰房', () => {
  it('用续住房的基础时间，不用退房房的', () => {
    // 续住房基础改成 20：20 × 0.8 = 16，20 × 1.0 = 20，20 × 1.6 = 32。退房房改成 40，对请勿打扰房没有影响。
    const params = withTimes({ departure: 40, stayover: 20 }, {});
    expect(MESS_LEVELS.map((mess) => cleanMinutes('dnd', mess, params))).toEqual([16, 20, 32]);
    expect(MESS_LEVELS.map((mess) => cleanMinutes('stayover', mess, params))).toEqual([16, 20, 32]);
    expect(cleanMinutes('departure', 'normal', params)).toBe(40);
  });
});

describe('generate 的参数检查：打扫分钟必须是整数', () => {
  it('有一项不是整数时，生成世界前就报错', () => {
    expect(() => generate('x', withTimes({ stayover: 15 }, { disaster: 1.5 }))).toThrow(/整数/);
  });

  it('只有浮点误差时照常生成', () => {
    // 45 × 0.8 = 36，45 × 1.4 = 63，45 × 1.6 = 72；15 × 0.8 = 12，15 × 1.4 = 21，15 × 1.6 = 24，都是整数。
    expect(() => generate('x', withTimes({ departure: 45 }, { normal: 1.4 }))).not.toThrow();
  });

  it('三档参数都能通过检查', () => {
    for (const tier of TIERS) expect(() => generate('x', PARAMS[tier])).not.toThrow();
  });
});
