import { describe, expect, it } from 'vitest';
import { SHIFT_START_OF_DAY, toClock } from '../src/engine/clock';
import { allRooms, placeOf, walkMinutes } from '../src/engine/layout';
import { PARAMS, tierForWeekday, type MessDistribution, type Tier } from '../src/engine/params';
import { cleanMinutes } from '../src/engine/rules';
import type { MessLevel, RoomKind } from '../src/engine/types';
import { objectsIn } from './helpers/play';

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];
const KINDS: RoomKind[] = ['departure', 'stayover', 'dnd'];
const MESS_LEVELS: MessLevel[] = ['tidy', 'normal', 'disaster'];

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const messTotal = (mess: MessDistribution): number => mess.tidy + mess.normal + mess.disaster;

describe.each(TIERS)('params：%s 档', (tier) => {
  const params = PARAMS[tier];

  it('档位名和键一致', () => {
    expect(params.tier).toBe(tier);
  });

  it('三种房型的数量加起来等于房间总数', () => {
    const { departures, stayovers, dnd } = params.mix;
    expect(departures + stayovers + dnd).toBe(allRooms(params).length);
    expect(allRooms(params).length).toBe(15);
  });

  it('房号不重复', () => {
    const rooms = allRooms(params);
    expect(new Set(rooms).size).toBe(rooms.length);
  });

  it('退房时间分布的比例之和为 1', () => {
    const { beforeStart, early, late, lateCheckout } = params.checkout;
    expect(sum([beforeStart.share, early.share, late.share, lateCheckout.share])).toBeCloseTo(1, 10);
  });

  it('线索的出现比例之和为 1', () => {
    expect(sum(Object.values(params.stayClues).map((clue) => clue.share))).toBeCloseTo(1, 10);
    expect(sum(Object.values(params.departureClues).map((clue) => clue.share))).toBeCloseTo(1, 10);
  });

  it('每条线索的脏乱概率之和为 1', () => {
    for (const clue of Object.values(params.stayClues)) expect(messTotal(clue.mess)).toBeCloseTo(1, 10);
    for (const clue of Object.values(params.departureClues)) expect(messTotal(clue.mess)).toBeCloseTo(1, 10);
  });

  it('休息窗口在班次之内，贵宾时限在强制下班之前', () => {
    const { breakEarliest, breakLatest, breakMinutes, targetFinish, hardStop } = params.shift;
    expect(breakEarliest).toBeGreaterThan(0);
    expect(breakLatest).toBeGreaterThan(breakEarliest);
    expect(breakLatest + breakMinutes).toBeLessThan(hardStop);
    expect(targetFinish).toBeLessThan(hardStop);
    for (const deadline of params.vipDeadlines) expect(deadline).toBeLessThan(hardStop);
  });

  it('开工前的时刻是负整数，生成用到的时间窗都是不早于开工的非空整数区间', () => {
    const { shift, checkout, stayClues, guests, dnd } = params;
    expect(Number.isInteger(shift.beforeStart)).toBe(true);
    expect(shift.beforeStart).toBeLessThan(0);
    expect(Number.isInteger(checkout.lateCheckout.at)).toBe(true);
    expect(checkout.lateCheckout.at).toBeGreaterThanOrEqual(0);

    // 时间窗 [from, to) 左闭右开。出门时间窗要算上周末档的整体推迟。
    const windows: [string, number, number][] = [
      ['退房早段', checkout.early.from, checkout.early.to],
      ['退房晚段', checkout.late.from, checkout.late.to],
      ['摘牌', dnd.liftFrom, dnd.liftTo],
      ...Object.entries(stayClues).map(
        ([clue, { leaveFrom, leaveTo }]): [string, number, number] => [
          `${clue} 出门`,
          leaveFrom + guests.leaveDelay,
          leaveTo + guests.leaveDelay,
        ],
      ),
    ];
    for (const [label, from, to] of windows) {
      expect(Number.isInteger(from) && Number.isInteger(to), label).toBe(true);
      expect(from, label).toBeGreaterThanOrEqual(0);
      expect(to, label).toBeGreaterThan(from);
    }
  });

  it('贵宾房不多于退房房，布草车至少装得下一间退房房', () => {
    expect(params.vipDeadlines.length).toBeLessThanOrEqual(params.mix.departures);
    expect(params.cart.capacity).toBeGreaterThanOrEqual(params.rooms.departure.linen);
  });
});

describe.each(TIERS)('params 的时间：%s 档', (tier) => {
  const params = PARAMS[tier];

  it('各项动作耗时和步行时间都是正整数', () => {
    const durations: [string, number][] = [
      ['callMinutes', params.callMinutes],
      ['knockRefusedMinutes', params.knockRefusedMinutes],
      ['restockMinutes', params.cart.restockMinutes],
      ['returnCartMinutes', params.shift.returnCartMinutes],
      ['waitStepMinutes', params.waitStepMinutes],
      ['breakMinutes', params.shift.breakMinutes],
      ['walkMinutesPerDoor', params.layout.walkMinutesPerDoor],
      ['liftMinutes', params.layout.liftMinutes],
    ];
    for (const [name, minutes] of durations) {
      expect(Number.isInteger(minutes), name).toBe(true);
      expect(minutes, name).toBeGreaterThan(0);
    }
  });

  it('每种房型的基础时间乘最小的脏乱系数不小于 1', () => {
    // 最小的系数是整洁的 0.8：退房房 30 × 0.8 = 24，续住房 15 × 0.8 = 12（请勿打扰房用续住房的）。
    const smallest = Math.min(...MESS_LEVELS.map((mess) => params.messMultiplier[mess]));
    expect(params.rooms.departure.baseMinutes * smallest).toBeGreaterThanOrEqual(1);
    expect(params.rooms.stayover.baseMinutes * smallest).toBeGreaterThanOrEqual(1);
    for (const kind of KINDS) {
      for (const mess of MESS_LEVELS) expect(cleanMinutes(kind, mess, params), `${kind} ${mess}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('每种房型乘每档脏乱系数都得到整数分钟', () => {
    for (const kind of KINDS) {
      for (const mess of MESS_LEVELS) {
        expect(() => cleanMinutes(kind, mess, params), `${kind} ${mess}`).not.toThrow();
        expect(Number.isInteger(cleanMinutes(kind, mess, params)), `${kind} ${mess}`).toBe(true);
      }
    }
  });

  it('固定时刻都是整数分钟，回来时间的取整步长是正整数', () => {
    // 引擎只用整数分钟，这些时刻和步长也都应当是整数。例如 hardStop 为 509.5 时，509 分钟的等待上限变成 0.5，
    // 这时还有房间没做就什么都做不了。generate 不检查它们，三档参数由这里检查。
    const { hardStop, breakEarliest, breakLatest, targetFinish } = params.shift;
    const moments: [string, number][] = [
      ['hardStop', hardStop],
      ['breakEarliest', breakEarliest],
      ['breakLatest', breakLatest],
      ['targetFinish', targetFinish],
      ...params.vipDeadlines.map((deadline, index): [string, number] => [`vipDeadlines[${index}]`, deadline]),
    ];
    for (const [name, minute] of moments) expect(Number.isInteger(minute), name).toBe(true);
    expect(Number.isInteger(params.comeBackRounding), 'comeBackRounding').toBe(true);
    expect(params.comeBackRounding, 'comeBackRounding').toBeGreaterThan(0);
  });

  it('开工时刻能被回来时间的取整步长整除，按开工后的分钟取整和按钟点取整一致', () => {
    // 08:30 是当天第 510 分钟，510 = 34 × 15。
    expect(SHIFT_START_OF_DAY % params.comeBackRounding).toBe(0);
  });

  it('新手 12:30 固定休息：休息时刻是 240，是整数分钟，不早于 10:30、早于 14:30，到了它就一定能休息', () => {
    const { breakAt } = params.novice;
    const { breakEarliest, breakLatest } = params.shift;
    expect(breakAt).toBe(240);
    expect(toClock(breakAt)).toBe('12:30');
    expect(Number.isInteger(breakAt)).toBe(true);
    // 到了 breakAt，到达服务间的时刻不早于它，也就不早于 breakEarliest，休息合法；
    // 早于 breakLatest，所以 14:30 起只能休息的时候，新手早就该休息了，两条规则不会打架。
    expect(breakAt).toBeGreaterThanOrEqual(breakEarliest);
    expect(breakAt).toBeLessThan(breakLatest);
  });

  it('最晚的强制休息也在 17:00 之前结束：按现有参数是 457（16:07）', () => {
    const { breakLatest, breakMinutes, hardStop } = params.shift;
    const service = params.layout.servicePoint;
    const roomPlaces = allRooms(params).map((room) => placeOf(room, params));
    // 人能停留的位置：服务间和各个房间门位。
    const positions = [service, ...roomPlaces];
    const max = (values: number[]): number => Math.max(...values);
    // 任意位置到任意房间的最远步行：12 楼门位 4 到 13 楼门位 4，(4 + 4) × 1 + 4 = 12。
    const farthestToRoom = max(positions.flatMap((from) => roomPlaces.map((to) => walkMinutes(from, to, params))));
    // 回服务间的最远步行：13 楼门位 4，(4 + 0) × 1 + 4 = 8。
    const farthestToService = max(positions.map((from) => walkMinutes(from, service, params)));
    // 最长的打扫：灾难级退房房 30 × 1.6 = 48。
    const longestClean = max(KINDS.flatMap((kind) => MESS_LEVELS.map((mess) => cleanMinutes(kind, mess, params))));
    // 最长的单个非休息动作：max(12 + 48, 12 + 1, 8 + 5, 2, 5) = 60。
    const longestAction = max([
      farthestToRoom + longestClean,
      farthestToRoom + params.knockRefusedMinutes,
      farthestToService + params.cart.restockMinutes,
      params.callMinutes,
      params.waitStepMinutes,
    ]);
    // 14:29 开始最长的动作，做完再从最远处走回服务间休息：(360 - 1) + 60 + 8 + 30 = 457。
    const latestBreakEnd = breakLatest - 1 + longestAction + farthestToService + breakMinutes;
    expect(latestBreakEnd).toBeLessThan(hardStop);
    expect(latestBreakEnd).toBe(457);
    expect(toClock(latestBreakEnd)).toBe('16:07');
  });
});

describe('难度档之间的差别', () => {
  it('紧档只比标准档少两份布草', () => {
    expect(PARAMS.standard.cart.capacity).toBe(8);
    expect(PARAMS.tight.cart.capacity).toBe(6);
    expect(PARAMS.tight.vipDeadlines).toEqual(PARAMS.standard.vipDeadlines);
  });

  it('周末档多一个贵宾，客人出门晚 30 分钟', () => {
    expect(PARAMS.weekend.cart.capacity).toBe(6);
    expect(PARAMS.weekend.vipDeadlines).toHaveLength(3);
    expect(PARAMS.weekend.guests.leaveDelay).toBe(30);
    expect(PARAMS.standard.guests.leaveDelay).toBe(0);
  });

  it('新手的数值三档相同：紧档和周末档共用标准档的那个对象', () => {
    expect(PARAMS.tight.novice).toBe(PARAMS.standard.novice);
    expect(PARAMS.weekend.novice).toBe(PARAMS.standard.novice);
  });

  it('难度随星期递增', () => {
    expect([1, 2, 3].map(tierForWeekday)).toEqual(['standard', 'standard', 'standard']);
    expect([4, 5].map(tierForWeekday)).toEqual(['tight', 'tight']);
    expect([6, 0].map(tierForWeekday)).toEqual(['weekend', 'weekend']);
  });
});

describe('PARAMS 深度冻结', () => {
  it('从 PARAMS 能走到的每个对象和数组都冻结了', () => {
    const objects = objectsIn(PARAMS);
    // 先确认确实走到了各层的对象和数组，免得什么都没收集到时空过：
    // 三档共用的子对象（紧档和周末档由标准档展开）、各档自己的子对象、楼层和房号的数组、最深处的脏乱概率。
    const samples: object[] = [
      PARAMS,
      PARAMS.standard,
      PARAMS.tight,
      PARAMS.weekend,
      PARAMS.standard.shift,
      PARAMS.tight.cart,
      PARAMS.weekend.guests,
      PARAMS.weekend.vipDeadlines,
      PARAMS.standard.layout.floors,
      PARAMS.standard.layout.servicePoint,
      ...PARAMS.standard.layout.floors.map((plan) => plan.rooms),
      PARAMS.standard.stayClues.family.mess,
      PARAMS.standard.events.rushRequest,
      PARAMS.weekend.novice,
    ];
    for (const sample of samples) expect(objects.has(sample)).toBe(true);
    expect([...objects].filter((object) => !Object.isFrozen(object))).toEqual([]);
  });

  it('给一个字段赋值抛 TypeError，值不变', () => {
    // 测试文件是 ES 模块，在严格模式下运行：给冻结对象的字段赋值会抛 TypeError。
    const { cart } = PARAMS.tight;
    const capacity = cart.capacity;
    try {
      expect(() => {
        cart.capacity = capacity + 1;
      }).toThrow(TypeError);
    } finally {
      // 没冻结时上面的赋值会成功：改回原值，免得影响同一文件里的其他用例。冻结时值没变，不会走到这里的赋值。
      if (cart.capacity !== capacity) cart.capacity = capacity;
    }
    // 紧档的布草车仍是 6 份。
    expect(PARAMS.tight.cart.capacity).toBe(6);
  });
});
