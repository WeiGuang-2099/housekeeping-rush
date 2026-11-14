/**
 * rules 的单元测试：打扫（service）和路过、停留时看到摘牌。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0。同层每个门位 1 分钟；跨层先走到本层门位 0，乘电梯 4 分钟，再从目标层门位 0 走过去。
 * 打扫分钟：退房房 30，续住房和请勿打扰房 15，乘脏乱系数 0.8、1.0、1.6。敲门被拒花 1 分钟。
 */

import { describe, expect, it } from 'vitest';
import { initial } from '../src/engine/rules';
import type { Place, State, World } from '../src/engine/types';
import {
  act,
  expectIllegal,
  expectLegal,
  freshProgress,
  last,
  numbersIn,
  play,
  progress,
  waitUntil,
} from './helpers/drive';
import { BEFORE_START, controlledWorld, departure, dnd, stayover } from './helpers/world';

/** 服务间：12 楼门位 0。 */
const S: Place = { floor: 12, door: 0 };

describe('service：已标记的退房房', () => {
  const cases: ['tidy' | 'normal' | 'disaster', number][] = [
    ['tidy', 24],
    ['normal', 30],
    ['disaster', 48],
  ];

  it.each(cases)('脏乱 %s：耗时为步行 4 分钟加打扫 %i 分钟，用 2 份布草，开门揭晓脏乱', (mess, total) => {
    const world = controlledWorld({ 1207: departure({ mess }) });
    // 开工先打电话：挂断时刻 2，1207 开工前已退房（-30 <= 2），标为已退。
    let state = play(world, initial(world), act.call());
    expect(progress(state, 1207).flaggedDeparted).toBe(true);
    state = play(world, state, act.service(1207));
    // 服务间 {12, 0} 到 1207 {12, 4} 走 4 分钟，2 + 4 = 6 到门口；已标记，直接进门，不敲门。
    // 打扫 30 × 系数 = total 分钟（24、30、48），6 + total 做完；outcome 的 minutes 不含步行。
    const end = 6 + total;
    expect(last(state)).toEqual({
      start: 2,
      end,
      from: S,
      to: { floor: 12, door: 4 },
      action: act.service(1207),
      outcome: { type: 'cleaned', room: 1207, minutes: total },
      walk: 4,
      noticedLifted: [],
    });
    expect(state.minute).toBe(end);
    expect(state.place).toEqual({ floor: 12, door: 4 });
    expect(state.cart).toBe(8 - 2);
    expect(progress(state, 1207)).toStrictEqual({
      ...freshProgress(1207),
      doneAt: end,
      workDone: total,
      flaggedDeparted: true,
      messRevealed: true,
    });
  });

  it('电话里刚好标记的退房房也直接进门，不会敲门被拒', () => {
    // 1203 在 52 退房。等到 50 打电话，挂断时刻 52，恰好标为已退。
    // 走 2 分钟，54 到门口，直接进门，打扫 30 分钟，84 做完。
    const world = controlledWorld({ 1203: departure({ availableFrom: 52 }) });
    const state = play(world, waitUntil(world, initial(world), 50), act.call(), act.service(1203));
    expect(last(state)).toMatchObject({
      start: 52,
      end: 84,
      walk: 2,
      outcome: { type: 'cleaned', room: 1203, minutes: 30 },
    });
    expect(state.log.some((entry) => entry.outcome.type === 'knockRefused')).toBe(false);
  });
});

describe('service：客人还在房内', () => {
  const cases: [number, number][] = [
    [60, 60],
    [61, 75],
    [74, 75],
  ];

  it.each(cases)('续住房客人 %i 出门：敲门被拒，耗时为步行加 1，回来时间 %i', (leaves, comeBack) => {
    // 回来时间 = ceil(出门时刻 / 15) × 15：60 / 15 = 4 得 60；61 / 15 和 74 / 15 都向上取整到 5，得 75。
    const world = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: leaves }) });
    const state = play(world, initial(world), act.service(1201));
    // 服务间到 1201（门位 1）走 1 分钟，第 1 分钟到门口，早于出门时刻；敲门被拒再花 1 分钟，第 2 分钟结束。
    expect(last(state)).toEqual({
      start: 0,
      end: 2,
      from: S,
      to: { floor: 12, door: 1 },
      action: act.service(1201),
      outcome: { type: 'knockRefused', room: 1201, comeBackAt: comeBack },
      walk: 1,
      noticedLifted: [],
    });
    expect(state.minute).toBe(2);
    expect(state.place).toEqual({ floor: 12, door: 1 });
    // 不扣布草，不揭晓脏乱，房间仍未完成。
    expect(state.cart).toBe(8);
    expect(progress(state, 1201)).toStrictEqual({ ...freshProgress(1201), knownAvailableFrom: comeBack });
  });

  it('日志里没有客人出门的真实时刻', () => {
    // 61 和 74 出门都得到回来时间 75：两个世界敲门之后的状态（含日志）完全相同，日志里也找不到 61 或 74。
    const early = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 61 }) });
    const late = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 74 }) });
    const a = play(early, initial(early), act.service(1201));
    const b = play(late, initial(late), act.service(1201));
    expect(b).toStrictEqual(a);
    expect(numbersIn(a.log)).not.toContain(61);
    expect(numbersIn(b.log)).not.toContain(74);
  });

  it('已摘牌的请勿打扰房，客人还在：敲门被拒并得知回来时间，到时再去就能进', () => {
    // 1203 在 150 摘牌，但客人 200 才出门（长住）：摘牌不等于客人已出门，实际最早 max(150, 200) = 200 能进。
    const world = controlledWorld({ 1203: dnd({ clue: 'longStay', availableFrom: 200, dndLiftsAt: 150 }) });
    // 等到 148 打电话，挂断时刻 150 得知摘牌。走 2 分钟，152 到门口，152 < 200，被拒，153 结束。
    // 回来时间 ceil(200 / 15) × 15 = 14 × 15 = 210。
    let state = play(world, waitUntil(world, initial(world), 148), act.call(), act.service(1203));
    expect(last(state)).toEqual({
      start: 150,
      end: 153,
      from: S,
      to: { floor: 12, door: 2 },
      action: act.service(1203),
      outcome: { type: 'knockRefused', room: 1203, comeBackAt: 210 },
      walk: 2,
      noticedLifted: [],
    });
    expect(state.cart).toBe(8);
    expect(progress(state, 1203)).toStrictEqual({ ...freshProgress(1203), knownAvailableFrom: 210, dndLiftKnown: true });
    // 在门口等到 209：209 < 210，不合法。等到 210：合法，进门打扫 15 分钟，225 做完。
    state = waitUntil(world, state, 209);
    expectIllegal(world, state, act.service(1203));
    state = waitUntil(world, state, 210);
    expectLegal(world, state, act.service(1203));
    state = play(world, state, act.service(1203));
    expect(last(state)).toMatchObject({
      start: 210,
      end: 225,
      walk: 0,
      outcome: { type: 'cleaned', room: 1203, minutes: 15 },
    });
    expect(state.cart).toBe(7);
  });
});

describe('service：客人不在房内', () => {
  it('到达时刻恰好等于出门时刻：进门打扫，不另加敲门的 1 分钟', () => {
    // 1201 的客人 45 出门。在服务间等到 44，走 1 分钟，45 到门口，45 >= 45，进门；打扫 15 分钟，60 做完。
    const world = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 45 }) });
    const state = play(world, waitUntil(world, initial(world), 44), act.service(1201));
    expect(last(state)).toEqual({
      start: 44,
      end: 60,
      from: S,
      to: { floor: 12, door: 1 },
      action: act.service(1201),
      outcome: { type: 'cleaned', room: 1201, minutes: 15 },
      walk: 1,
      noticedLifted: [],
    });
    expect(state.cart).toBe(7);
    expect(progress(state, 1201)).toStrictEqual({ ...freshProgress(1201), doneAt: 60, workDone: 15, messRevealed: true });
  });

  it('早 1 分钟到门口就被拒', () => {
    // 客人 46 出门，45 到门口：45 < 46，被拒，46 结束；回来时间 ceil(46 / 15) × 15 = 4 × 15 = 60。
    const world = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 46 }) });
    const state = play(world, waitUntil(world, initial(world), 44), act.service(1201));
    expect(last(state)).toMatchObject({
      start: 44,
      end: 46,
      outcome: { type: 'knockRefused', room: 1201, comeBackAt: 60 },
    });
  });

  it('客人开工前已出门（availableFrom 为负数）：第一次去就能进，耗时只有步行加打扫', () => {
    // 1303（13 楼门位 2）：服务间到这里 0 + 2 + 电梯 4 = 6 分钟，6 到门口，打扫 15 分钟，21 做完。
    const world = controlledWorld({ 1303: stayover({ availableFrom: BEFORE_START }) });
    const state = play(world, initial(world), act.service(1303));
    expect(last(state)).toMatchObject({
      start: 0,
      end: 21,
      walk: 6,
      outcome: { type: 'cleaned', room: 1303, minutes: 15 },
    });
  });
});

describe('service：续住房和已摘牌的请勿打扰房', () => {
  const cases: ['tidy' | 'normal' | 'disaster', number][] = [
    ['tidy', 12],
    ['normal', 15],
    ['disaster', 24],
  ];

  it.each(cases)('续住房，脏乱 %s：耗时为步行加 %i 分钟，用 1 份布草', (mess, total) => {
    // 服务间到 1301（13 楼门位 1）：0 + 1 + 电梯 4 = 5 分钟。打扫 15 × 系数 = total（12、15、24）。
    const world = controlledWorld({ 1301: stayover({ mess }) });
    const state = play(world, initial(world), act.service(1301));
    expect(last(state)).toMatchObject({
      start: 0,
      end: 5 + total,
      walk: 5,
      outcome: { type: 'cleaned', room: 1301, minutes: total },
    });
    expect(state.cart).toBe(7);
    expect(progress(state, 1301)).toStrictEqual({
      ...freshProgress(1301),
      doneAt: 5 + total,
      workDone: total,
      messRevealed: true,
    });
  });

  it.each(cases)('已摘牌的请勿打扰房，脏乱 %s：按续住房算，耗时为步行加 %i 分钟，用 1 份布草', (mess, total) => {
    // 1303 在 150 摘牌，客人开工前已出门。等到 148 打电话，挂断时刻 150 得知摘牌。
    // 服务间到 1303（13 楼门位 2）：0 + 2 + 4 = 6 分钟，156 到门口，打扫 15 × 系数 = total。
    const world = controlledWorld({ 1303: dnd({ mess, dndLiftsAt: 150 }) });
    const state = play(world, waitUntil(world, initial(world), 148), act.call(), act.service(1303));
    expect(last(state)).toMatchObject({
      start: 150,
      end: 156 + total,
      walk: 6,
      outcome: { type: 'cleaned', room: 1303, minutes: total },
    });
    expect(state.cart).toBe(7);
    expect(progress(state, 1303)).toStrictEqual({
      ...freshProgress(1303),
      doneAt: 156 + total,
      workDone: total,
      messRevealed: true,
      dndLiftKnown: true,
    });
  });
});

describe('service：被拒之后再去', () => {
  /** 1207（12 楼门位 4）的客人在 leaves 出门。第一次去：4 到门口被拒，5 结束。 */
  function refusedAt1207(leaves: number): { world: World; state: State } {
    const world = controlledWorld({ 1207: stayover({ clue: 'tourist', availableFrom: leaves }) });
    const state = play(world, initial(world), act.service(1207));
    expect(state.minute).toBe(5);
    return { world, state };
  }

  it('留在门口：到达时刻早于回来时间不合法，等于时合法，并且一定能进门', () => {
    // 客人 61 出门，回来时间 75。
    const { world, state: refused } = refusedAt1207(61);
    expect(last(refused).outcome).toEqual({ type: 'knockRefused', room: 1207, comeBackAt: 75 });
    // 在门口等到 74，步行 0：74 < 75，不合法。
    let state = waitUntil(world, refused, 74);
    expectIllegal(world, state, act.service(1207));
    // 等到 75：75 >= 75，合法；75 >= 61，进门，打扫 15 分钟，90 做完。
    state = waitUntil(world, state, 75);
    expectLegal(world, state, act.service(1207));
    state = play(world, state, act.service(1207));
    expect(last(state)).toMatchObject({
      start: 75,
      end: 90,
      walk: 0,
      outcome: { type: 'cleaned', room: 1207, minutes: 15 },
    });
  });

  it('提前出发：minute 加步行恰好等于回来时间时合法', () => {
    const { world, state: refused } = refusedAt1207(61);
    // 回服务间补货：走 4 分钟加 5 分钟，14 结束。之后从服务间去 1207 要走 4 分钟。
    let state = play(world, refused, act.restock());
    expect(state.minute).toBe(14);
    // 70 + 4 = 74 < 75，不合法。
    state = waitUntil(world, state, 70);
    expectIllegal(world, state, act.service(1207));
    // 71 + 4 = 75，合法；75 到门口，进门，打扫 15 分钟，90 做完。
    state = waitUntil(world, state, 71);
    expectLegal(world, state, act.service(1207));
    state = play(world, state, act.service(1207));
    expect(last(state)).toMatchObject({
      start: 71,
      end: 90,
      walk: 4,
      outcome: { type: 'cleaned', room: 1207, minutes: 15 },
    });
  });

  it('客人恰好在回来时间出门：到回来时间去也能进', () => {
    // 客人 75 出门：75 / 15 = 5，回来时间就是 75。75 到门口，75 >= 75，进门，90 做完。
    const { world, state: refused } = refusedAt1207(75);
    expect(last(refused).outcome).toEqual({ type: 'knockRefused', room: 1207, comeBackAt: 75 });
    const state = play(world, waitUntil(world, refused, 75), act.service(1207));
    expect(last(state)).toMatchObject({ start: 75, end: 90, outcome: { type: 'cleaned', room: 1207, minutes: 15 } });
  });

  it('晚于回来时间再去也合法，并且一定能进门', () => {
    // 客人 74 出门，回来时间 75。在门口等到 80：80 >= 75，合法；80 >= 74，进门，打扫 15 分钟，95 做完。
    const { world, state: refused } = refusedAt1207(74);
    expect(last(refused).outcome).toEqual({ type: 'knockRefused', room: 1207, comeBackAt: 75 });
    let state = waitUntil(world, refused, 80);
    expectLegal(world, state, act.service(1207));
    state = play(world, state, act.service(1207));
    expect(last(state)).toMatchObject({
      start: 80,
      end: 95,
      walk: 0,
      outcome: { type: 'cleaned', room: 1207, minutes: 15 },
    });
  });
});

describe('service：步行时间', () => {
  it('服务间到 1301：门位 0 加门位 1，再加电梯 4 分钟，共 5 分钟', () => {
    const world = controlledWorld({ 1301: stayover() });
    const state = play(world, initial(world), act.service(1301));
    // 5 到门口，打扫 15 分钟，20 做完。
    expect(last(state)).toMatchObject({ start: 0, end: 20, from: S, to: { floor: 13, door: 1 }, walk: 5 });
  });

  it('1208 到 1307：门位 4 加门位 4，再加电梯 4 分钟，共 12 分钟', () => {
    const world = controlledWorld({ 1208: stayover(), 1307: stayover() });
    // 1208：走 4 分钟，4 到门口，19 做完。1307：19 出发，走 12 分钟，31 到门口，46 做完。
    const state = play(world, initial(world), act.service(1208), act.service(1307));
    expect(last(state)).toMatchObject({
      start: 19,
      end: 46,
      from: { floor: 12, door: 4 },
      to: { floor: 13, door: 4 },
      walk: 12,
    });
  });

  it('目标就在当前门位：步行 0', () => {
    const world = controlledWorld({ 1201: stayover(), 1202: stayover() });
    // 1201 在 16 做完；1202 对着同一个门位，16 直接进门，31 做完。
    const state = play(world, initial(world), act.service(1201), act.service(1202));
    expect(last(state)).toMatchObject({
      start: 16,
      end: 31,
      from: { floor: 12, door: 1 },
      to: { floor: 12, door: 1 },
      walk: 0,
      outcome: { type: 'cleaned', room: 1202, minutes: 15 },
    });
  });
});

describe('路过', () => {
  it('服务间走到 1207：门位 2 的请勿打扰房在经过门位 2 的那一分钟摘牌就能看到，同一门位的两间都算', () => {
    // 等到 150 出发：151 经过门位 1，152 门位 2，153 门位 3，154 到 1207（门位 4），打扫 15 分钟，169 做完。
    // 1203、1204 都在 152 摘牌：经过门位 2 时 152 <= 152，两间都看到。
    const world = controlledWorld({
      1203: dnd({ dndLiftsAt: 152 }),
      1204: dnd({ dndLiftsAt: 152 }),
      1207: stayover(),
    });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1207));
    expect(last(state)).toMatchObject({ start: 150, end: 169, noticedLifted: [1203, 1204] });
    expect(progress(state, 1203).dndLiftKnown).toBe(true);
    expect(progress(state, 1204).dndLiftKnown).toBe(true);
    // 得知后就是合法的打扫目标。
    expectLegal(world, state, act.service(1203));
  });

  it('晚 1 分钟摘牌就看不到', () => {
    // 1203 在 152 摘牌（看到）；1204 在 153 摘牌，152 经过门位 2 时还没摘，之后没再回来，看不到。
    const world = controlledWorld({
      1203: dnd({ dndLiftsAt: 152 }),
      1204: dnd({ dndLiftsAt: 153 }),
      1207: stayover(),
    });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1207));
    expect(last(state).noticedLifted).toEqual([1203]);
    expect(progress(state, 1204).dndLiftKnown).toBe(false);
    expectIllegal(world, state, act.service(1204));
  });

  it('路过不改变退房房和续住房的已知信息', () => {
    // 1201（门位 1）开工前已退房，1205（门位 3）的客人 100 出门。150 出发去 1207，都路过，但路过只揭晓摘牌。
    const world = controlledWorld({
      1201: departure(),
      1205: stayover({ clue: 'tourist', availableFrom: 100 }),
      1207: stayover(),
    });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1207));
    expect(last(state).noticedLifted).toEqual([]);
    expect(progress(state, 1201)).toStrictEqual(freshProgress(1201));
    expect(progress(state, 1205)).toStrictEqual(freshProgress(1205));
    expectIllegal(world, state, act.service(1201));
  });

  it('noticedLifted 按 world.rooms 的顺序排列，不按经过的先后', () => {
    // 1201（门位 1）和 1205（门位 3）都在 170 摘牌。
    // 150 出发去 1208：151 到 153 经过门位 1 到 3，都还没摘；154 到门口，169 做完。原地等 1 分钟到 170（门位 4 没有请勿打扰房）。
    // 170 回服务间补货：171 经过门位 3 看到 1205，173 经过门位 1 看到 1201，174 到服务间，补货 5 分钟，179 结束。
    const world = controlledWorld({
      1201: dnd({ dndLiftsAt: 170 }),
      1205: dnd({ dndLiftsAt: 170 }),
      1208: stayover(),
    });
    let state = play(world, waitUntil(world, initial(world), 150), act.service(1208));
    expect(last(state)).toMatchObject({ end: 169, noticedLifted: [] });
    state = play(world, state, act.wait(1), act.restock());
    expect(last(state)).toMatchObject({ start: 170, end: 179, walk: 4, noticedLifted: [1201, 1205] });
  });
});

describe('停留', () => {
  it('打扫期间同一门位的另一间请勿打扰房摘牌：动作结束时看到，记进这条日志', () => {
    // 150 出发去 1203（门位 2）：152 到门口，此时 1204 还没摘（160）；打扫 15 分钟，167 做完，结束时 160 <= 167，看到。
    const world = controlledWorld({ 1203: stayover(), 1204: dnd({ dndLiftsAt: 160 }) });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1203));
    expect(last(state)).toMatchObject({ start: 150, end: 167, noticedLifted: [1204] });
    expect(progress(state, 1204).dndLiftKnown).toBe(true);
  });

  it('恰好在动作结束的那一分钟摘牌也看到；晚 1 分钟则要等下一个动作结束', () => {
    // 1204 在 167 摘牌：167 <= 167，做完时看到。
    const exact = controlledWorld({ 1203: stayover(), 1204: dnd({ dndLiftsAt: 167 }) });
    const seen = play(exact, waitUntil(exact, initial(exact), 150), act.service(1203));
    expect(last(seen)).toMatchObject({ end: 167, noticedLifted: [1204] });
    // 1204 在 168 摘牌：做完时看不到；原地等 1 分钟到 168，等待结束时看到，记在等待这条日志里。
    const later = controlledWorld({ 1203: stayover(), 1204: dnd({ dndLiftsAt: 168 }) });
    let state = play(later, waitUntil(later, initial(later), 150), act.service(1203));
    expect(last(state)).toMatchObject({ end: 167, noticedLifted: [] });
    expect(progress(state, 1204).dndLiftKnown).toBe(false);
    state = play(later, state, act.wait(1));
    expect(last(state)).toEqual({
      start: 167,
      end: 168,
      from: { floor: 12, door: 2 },
      to: { floor: 12, door: 2 },
      action: act.wait(1),
      outcome: { type: 'waited', minutes: 1 },
      walk: 0,
      noticedLifted: [1204],
    });
    expect(progress(state, 1204).dndLiftKnown).toBe(true);
  });

  it('敲门被拒的那 1 分钟里同一门位的请勿打扰房摘牌：结束时看到', () => {
    // 1203 的客人 200 才出门。150 出发，152 到门口（1204 还没摘），被拒，153 结束；1204 在 153 摘牌，看到。
    const world = controlledWorld({
      1203: stayover({ clue: 'longStay', availableFrom: 200 }),
      1204: dnd({ dndLiftsAt: 153 }),
    });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1203));
    expect(last(state)).toMatchObject({
      start: 150,
      end: 153,
      outcome: { type: 'knockRefused', room: 1203, comeBackAt: 210 },
      noticedLifted: [1204],
    });
  });
});

describe('跨层路过', () => {
  it('服务间去 1307：13 楼各门位的经过时刻包含乘电梯的 4 分钟', () => {
    // 150 出发：电梯 4 分钟，154 到 13 楼门位 0；155 门位 1，156 门位 2，157 门位 3，158 到 1307（门位 4）。
    // 1301 在 155 摘牌（看到）；1303 在 157 摘牌（156 经过时还没摘，看不到）；1305 在 157 摘牌（看到）。
    const world = controlledWorld({
      1301: dnd({ dndLiftsAt: 155 }),
      1303: dnd({ dndLiftsAt: 157 }),
      1305: dnd({ dndLiftsAt: 157 }),
      1307: stayover(),
    });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1307));
    // 步行 0 + 4 + 4 = 8 分钟，158 到门口，打扫 15 分钟，173 做完；门位 4 只有 1307。
    expect(last(state)).toMatchObject({ start: 150, end: 173, walk: 8, noticedLifted: [1301, 1305] });
    expect(progress(state, 1303).dndLiftKnown).toBe(false);
  });

  it('门位要楼层和门位号都相同：别的楼层同号门位上的房间不算', () => {
    // 1203（12 楼门位 2）在 150 摘牌。150 出发去 1307：12 楼只经过门位 0；156 经过的是 13 楼门位 2，不是 1203 的门位。
    const world = controlledWorld({ 1203: dnd({ dndLiftsAt: 150 }), 1307: stayover() });
    const state = play(world, waitUntil(world, initial(world), 150), act.service(1307));
    expect(last(state).noticedLifted).toEqual([]);
    expect(progress(state, 1203).dndLiftKnown).toBe(false);
  });

  it('{12, 3} 去 1303 {13, 2}：两层的门位各按自己的经过时刻判断', () => {
    // 150 出发去 1205（门位 3，整洁，12 分钟）：151 经过门位 1（1201 要到 167 才摘），153 到门口，165 做完。
    // 165 从 {12, 3} 出发：166 门位 2，167 门位 1，168 门位 0，电梯 4 分钟，172 到 13 楼门位 0，173 门位 1，174 到门位 2。
    // 1201 在 167 摘牌（看到）；1302 在 173 摘牌（看到）；1301 在 174 摘牌（173 经过时还没摘，看不到）。
    const world = controlledWorld({
      1201: dnd({ dndLiftsAt: 167 }),
      1205: stayover({ mess: 'tidy' }),
      1301: dnd({ dndLiftsAt: 174 }),
      1302: dnd({ dndLiftsAt: 173 }),
      1303: stayover(),
    });
    let state = play(world, waitUntil(world, initial(world), 150), act.service(1205));
    expect(last(state)).toMatchObject({ start: 150, end: 165, noticedLifted: [] });
    state = play(world, state, act.service(1303));
    // 步行 3 + 2 + 4 = 9 分钟，174 到门口，打扫 15 分钟，189 做完。
    expect(last(state)).toMatchObject({ start: 165, end: 189, walk: 9, noticedLifted: [1201, 1302] });
    expect(progress(state, 1301).dndLiftKnown).toBe(false);
  });
});

describe('电话和路过', () => {
  it('电话得知的摘牌只记在 called.newlyLifted，不记进 noticedLifted', () => {
    // 140 出发去 1203（门位 2），142 到门口，157 做完；1204 在 160 摘牌，做完时还没摘。原地等 1 分钟到 158。
    // 158 打电话，挂断时刻 160：电话先得知 1204 摘牌，之后在 160 对门位 2 的观察没有新消息。
    const world = controlledWorld({ 1203: stayover(), 1204: dnd({ dndLiftsAt: 160 }) });
    let state = play(world, waitUntil(world, initial(world), 140), act.service(1203), act.wait(1));
    expect(state.minute).toBe(158);
    expect(progress(state, 1204).dndLiftKnown).toBe(false);
    state = play(world, state, act.call());
    expect(last(state)).toEqual({
      start: 158,
      end: 160,
      from: { floor: 12, door: 2 },
      to: { floor: 12, door: 2 },
      action: act.call(),
      outcome: { type: 'called', newlyDeparted: [], newlyLifted: [1204] },
      walk: 0,
      noticedLifted: [],
    });
    expect(progress(state, 1204).dndLiftKnown).toBe(true);
    expect(state.log.some((entry) => entry.noticedLifted.includes(1204))).toBe(false);
  });
});
