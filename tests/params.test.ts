import { describe, expect, it } from 'vitest';
import { allRooms } from '../src/engine/layout';
import { PARAMS, tierForWeekday, type MessDistribution, type Tier } from '../src/engine/params';

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];

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

  it('贵宾房不多于退房房，布草车至少装得下一间退房房', () => {
    expect(params.vipDeadlines.length).toBeLessThanOrEqual(params.mix.departures);
    expect(params.cart.capacity).toBeGreaterThanOrEqual(params.rooms.departure.linen);
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

  it('难度随星期递增', () => {
    expect([1, 2, 3].map(tierForWeekday)).toEqual(['standard', 'standard', 'standard']);
    expect([4, 5].map(tierForWeekday)).toEqual(['tight', 'tight']);
    expect([6, 0].map(tierForWeekday)).toEqual(['weekend', 'weekend']);
  });
});
