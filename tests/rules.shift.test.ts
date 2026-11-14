/**
 * rules 的单元测试：补货、休息、等待、收工还车，以及 17:00 前后的规则。
 *
 * 标准档的数值：补货 5 分钟，休息 30 分钟，还车 5 分钟，敲门被拒 1 分钟，打电话 2 分钟，单次等待最多 5 分钟。
 * 休息窗口：到达服务间的时刻不早于 10:30（120）才能休息；14:30（360）起还没休息就只能休息。
 * 17:00 是 510。服务间是 12 楼门位 0；从 12 楼门位 d 走回去 d 分钟，从 13 楼门位 d 走回去 d + 4 分钟。
 */

import { describe, expect, it } from 'vitest';
import { placeOf, walkMinutes } from '../src/engine/layout';
import { PARAMS, type Params, type Tier } from '../src/engine/params';
import { apply, initial, legalActions } from '../src/engine/rules';
import type { Place, State, World } from '../src/engine/types';
import { act, expectIllegal, expectLegal, freshProgress, last, play, progress, waitUntil } from './helpers/drive';
import { controlledWorld, departure, dnd, stayover, type RoomSetup } from './helpers/world';

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];

/** 服务间：12 楼门位 0。 */
const S: Place = { floor: 12, door: 0 };

describe('restock', () => {
  it.each(TIERS)('%s 档：从 13 楼门位 4 补货，走回服务间 8 分钟加 5 分钟，补满到该档容量', (tier) => {
    // 布草车容量：标准档 8 份，紧档和周末档 6 份。
    const capacity: Record<Tier, number> = { standard: 8, tight: 6, weekend: 6 };
    const world = controlledWorld({ 1208: departure(), 1307: stayover() }, { tier });
    // 打电话（0 到 2）标记 1208。1208：走 4 分钟，6 到门口，打扫 30 分钟，36 做完，用 2 份。
    // 1307：从 {12, 4} 走 4 + 4 + 电梯 4 = 12 分钟，48 到门口，打扫 15 分钟，63 做完，用 1 份。
    let state = play(world, initial(world), act.call(), act.service(1208), act.service(1307));
    expect(state.minute).toBe(63);
    expect(state.cart).toBe(capacity[tier] - 3);
    state = play(world, state, act.restock());
    // 13 楼门位 4 回服务间：4 + 0 + 电梯 4 = 8 分钟，71 到，补货 5 分钟，76 结束。
    expect(last(state)).toEqual({
      start: 63,
      end: 76,
      from: { floor: 13, door: 4 },
      to: S,
      action: act.restock(),
      outcome: { type: 'restocked' },
      walk: 8,
      noticedLifted: [],
    });
    expect(state.cart).toBe(capacity[tier]);
    expect(state.place).toEqual(S);
  });

  it('车满也可以补货：在服务间耗时 5 分钟，份数不变', () => {
    const world = controlledWorld({});
    const state = initial(world);
    expectLegal(world, state, act.restock());
    const after = play(world, state, act.restock());
    expect(last(after)).toEqual({
      start: 0,
      end: 5,
      from: S,
      to: S,
      action: act.restock(),
      outcome: { type: 'restocked' },
      walk: 0,
      noticedLifted: [],
    });
    expect(after.cart).toBe(8);
    // 补货后的位置是服务间的副本，不与 params 共享。
    expect(after.place).not.toBe(world.params.layout.servicePoint);
  });
});

describe('break', () => {
  it('耗时为走回服务间的时间加 30；布草不变；休息过后不能再休息', () => {
    // 1307：等到 100 出发，走 8 分钟，108 到门口，打扫 15 分钟，123 做完，用 1 份布草。
    const world = controlledWorld({ 1307: stayover() });
    let state = play(world, waitUntil(world, initial(world), 100), act.service(1307));
    expect(state.minute).toBe(123);
    // 123 + 8 = 131 >= 120，可以休息；131 到服务间，休息 30 分钟，161 结束。
    expectLegal(world, state, act.break());
    state = play(world, state, act.break());
    expect(last(state)).toEqual({
      start: 123,
      end: 161,
      from: { floor: 13, door: 4 },
      to: S,
      action: act.break(),
      outcome: { type: 'breakTaken' },
      walk: 8,
      noticedLifted: [],
    });
    expect(state.breakTaken).toBe(true);
    expect(state.place).toEqual(S);
    expect(state.cart).toBe(7);
    expectIllegal(world, state, act.break());
  });

  it('下界，在服务间：119 不能休息，120 可以', () => {
    const world = controlledWorld({});
    let state = waitUntil(world, initial(world), 119);
    // 119 + 0 = 119 < 120。
    expectIllegal(world, state, act.break());
    state = waitUntil(world, state, 120);
    // 120 + 0 = 120，合法；休息 30 分钟，150 结束，休息开始时刻 150 - 30 = 120。
    expectLegal(world, state, act.break());
    state = play(world, state, act.break());
    expect(last(state)).toMatchObject({ start: 120, end: 150, walk: 0 });
  });

  it('下界，在 12 楼门位 4：115 不能休息（115 + 4 = 119），116 可以（116 + 4 = 120）', () => {
    // 1208：等到 96 出发，走 4 分钟，100 到门口，打扫 15 分钟，115 做完。
    const world = controlledWorld({ 1208: stayover() });
    let state = play(world, waitUntil(world, initial(world), 96), act.service(1208));
    expect(state.minute).toBe(115);
    expectIllegal(world, state, act.break());
    state = waitUntil(world, state, 116);
    expectLegal(world, state, act.break());
    // 116 出发，120 到服务间，休息 30 分钟，150 结束；休息开始时刻 150 - 30 = 120，恰好是 10:30。
    state = play(world, state, act.break());
    expect(last(state)).toEqual({
      start: 116,
      end: 150,
      from: { floor: 12, door: 4 },
      to: S,
      action: act.break(),
      outcome: { type: 'breakTaken' },
      walk: 4,
      noticedLifted: [],
    });
  });

  it('还没休息时，240 及以后从任何位置都可以休息', () => {
    // 每个门位放一间整洁的续住房（12 分钟），从 240 起依次去做，每到一个门位都检查一次。
    const doors = [1201, 1203, 1205, 1207, 1301, 1303, 1305, 1307];
    const rooms: Record<number, RoomSetup> = {};
    for (const id of doors) rooms[id] = stayover({ mess: 'tidy' });
    const world = controlledWorld(rooms);
    let state = waitUntil(world, initial(world), 240);
    expectLegal(world, state, act.break());
    for (const id of doors) {
      state = play(world, state, act.service(id));
      expect(state.place).toEqual(placeOf(id, world.params));
      expectLegal(world, state, act.break());
      // 休息耗时为走回服务间的时间加 30。
      const rested = apply(world, state, act.break());
      expect(rested.minute).toBe(state.minute + walkMinutes(state.place, S, world.params) + 30);
    }
    // 240 起：1201 在 253、1203 在 266、1205 在 279、1207 在 292 做完；
    // 1207 到 1301 走 4 + 1 + 4 = 9 分钟，313 做完；1303 在 326、1305 在 339、1307 在 352 做完，仍早于 14:30。
    expect(state.minute).toBe(352);
  });
});

describe('强制休息', () => {
  it('还没休息，到 14:30（360）整点：只能休息，其他动作都抛错', () => {
    const world = controlledWorld({ 1201: stayover() });
    // 359：还不到 14:30，打扫、补货、打电话、休息、等待都合法。
    let state = waitUntil(world, initial(world), 359);
    expect(legalActions(world, state)).toEqual([
      act.service(1201),
      act.restock(),
      act.call(),
      act.break(),
      act.wait(5),
    ]);
    // 360：只能休息。
    state = waitUntil(world, state, 360);
    expect(legalActions(world, state)).toEqual([act.break()]);
    for (const action of [act.service(1201), act.restock(), act.call(), act.wait(1), act.finish()]) {
      expectIllegal(world, state, action);
    }
    // 在服务间休息：360 开始，390 结束；之后又可以打扫。
    state = play(world, state, act.break());
    expect(state.minute).toBe(390);
    expect(state.breakTaken).toBe(true);
    expectLegal(world, state, act.service(1201));
  });

  it('14:20（340）开始打扫、做完已过 14:30：下一步只能休息，而且休息合法', () => {
    // 1201 是灾难级退房房（30 × 1.6 = 48 分钟）。开工打电话标记；等到 340 出发，341 到门口，389 做完。
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }) });
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, 340), act.service(1201));
    expect(last(state)).toMatchObject({ start: 340, end: 389 });
    expect(legalActions(world, state)).toEqual([act.break()]);
    for (const action of [act.restock(), act.call(), act.wait(1), act.finish()]) expectIllegal(world, state, action);
    // 走 1 分钟回服务间，390 开始休息（晚于 14:30 也可以），420 结束。
    state = play(world, state, act.break());
    expect(last(state)).toEqual({
      start: 389,
      end: 420,
      from: { floor: 12, door: 1 },
      to: S,
      action: act.break(),
      outcome: { type: 'breakTaken' },
      walk: 1,
      noticedLifted: [],
    });
    expect(state.breakTaken).toBe(true);
  });
});

describe('wait', () => {
  /** 120 在服务间休息、150 休息完，再等到 507：单次等待上限 min(5, 510 - 507) = 3。 */
  function at507(): { world: World; state: State } {
    const world = controlledWorld({});
    const rested = play(world, waitUntil(world, initial(world), 120), act.break());
    return { world, state: waitUntil(world, rested, 507) };
  }

  it('原地不动，时间加 n，步行为 0', () => {
    const world = controlledWorld({ 1205: stayover() });
    // 1205：3 到门口，18 做完，停在 {12, 3}；等 3 分钟到 21。
    const state = play(world, initial(world), act.service(1205), act.wait(3));
    expect(last(state)).toEqual({
      start: 18,
      end: 21,
      from: { floor: 12, door: 3 },
      to: { floor: 12, door: 3 },
      action: act.wait(3),
      outcome: { type: 'waited', minutes: 3 },
      walk: 0,
      noticedLifted: [],
    });
    expect(state.minute).toBe(21);
    expect(state.place).toEqual({ floor: 12, door: 3 });
  });

  it('1 到上限之间的任意整数都接受', () => {
    // 开工时上限 min(5, 510 - 0) = 5。
    const world = controlledWorld({});
    const start = initial(world);
    for (let n = 1; n <= 5; n++) expect(apply(world, start, act.wait(n)).minute).toBe(n);
    // 507：上限 3。
    const late = at507();
    for (let n = 1; n <= 3; n++) expect(apply(late.world, late.state, act.wait(n)).minute).toBe(507 + n);
  });

  it('0、负数、小数、超过上限都抛错', () => {
    const world = controlledWorld({});
    const start = initial(world);
    for (const n of [0, -1, -5, 0.5, 2.5, 6, 10, Number.NaN]) expectIllegal(world, start, act.wait(n));
    // 507：上限 3，4 和 5 都抛错。
    const late = at507();
    for (const n of [4, 5]) expectIllegal(late.world, late.state, act.wait(n));
  });

  it('需要强制休息时等待抛错', () => {
    // 在服务间等到 360，还没休息。
    const world = controlledWorld({});
    const state = waitUntil(world, initial(world), 360);
    for (const n of [1, 5]) expectIllegal(world, state, act.wait(n));
  });
});

describe('finish：收工条件', () => {
  it('房间都做完但还没休息：不能收工；休息后可以', () => {
    const world = controlledWorld({ 1201: stayover() });
    // 1201 在 16 做完。
    let state = play(world, initial(world), act.service(1201));
    expectIllegal(world, state, act.finish());
    // 在门位 1 等到 119 休息：120 到服务间，150 休息完。
    state = play(world, waitUntil(world, state, 119), act.break());
    expectLegal(world, state, act.finish());
  });

  it('还有没做完的退房房：不能收工', () => {
    // 1201 退房（开工前已退），1203 续住。120 在服务间休息到 150，再做 1203：152 到门口，167 做完。
    const world = controlledWorld({ 1201: departure(), 1203: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break(), act.service(1203));
    expect(state.minute).toBe(167);
    // 1201 没标记也没做：不能收工。
    expectIllegal(world, state, act.finish());
    // 打电话（167 到 169）标记 1201，但还没做：仍不能收工。
    state = play(world, state, act.call());
    expectIllegal(world, state, act.finish());
    // 1201：从门位 2 走 1 分钟，170 到门口，200 做完，可以收工。
    state = play(world, state, act.service(1201));
    expect(state.minute).toBe(200);
    expectLegal(world, state, act.finish());
  });

  it('还有没做完的续住房：不能收工', () => {
    // 1201 的客人 200 才出门（长住）。120 休息到 150；151 到门口被拒，152 结束，回来时间 ceil(200 / 15) × 15 = 210。
    const world = controlledWorld({ 1201: stayover({ clue: 'longStay', availableFrom: 200 }) });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    expectIllegal(world, state, act.finish());
    state = play(world, state, act.service(1201));
    expect(last(state).outcome).toEqual({ type: 'knockRefused', room: 1201, comeBackAt: 210 });
    expectIllegal(world, state, act.finish());
    // 在门口等到 210 再做：225 做完，可以收工。
    state = play(world, waitUntil(world, state, 210), act.service(1201));
    expect(state.minute).toBe(225);
    expectLegal(world, state, act.finish());
  });

  it('玩家不知道已摘牌的请勿打扰房不挡收工；得知以后要先做完', () => {
    // 1201 续住；1205 请勿打扰，150 摘牌。1201 在 16 做完，在门位 1 等到 119 休息，150 休息完回到服务间。
    const world = controlledWorld({ 1201: stayover(), 1205: dnd({ dndLiftsAt: 150 }) });
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break());
    expect(state.minute).toBe(150);
    // 150 时 1205 已经摘牌（150 <= 150），但玩家不知道：可以收工。
    expect(progress(state, 1205).dndLiftKnown).toBe(false);
    expectLegal(world, state, act.finish());
    expect(play(world, state, act.finish()).ended).toBe('returned');
    // 换一条路：先打电话（挂断 152，得知 1205 摘牌），就要先做完它才能收工。
    state = play(world, state, act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1205] });
    expectIllegal(world, state, act.finish());
    // 1205：走 3 分钟，155 到门口，170 做完，可以收工。
    state = play(world, state, act.service(1205));
    expect(state.minute).toBe(170);
    expectLegal(world, state, act.finish());
  });
});

describe('finish：收工还车', () => {
  it('耗时为走回服务间的时间加 5；ended 为 returned；minute 等于这条日志的 end；之后没有合法动作', () => {
    // 120 在服务间休息到 150；1307：走 8 分钟，158 到门口，173 做完。
    const world = controlledWorld({ 1307: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break(), act.service(1307));
    expect(state.minute).toBe(173);
    const before = state.log.length;
    state = play(world, state, act.finish());
    // 13 楼门位 4 回服务间 8 分钟，181 到，还车 5 分钟，186 结束。
    expect(last(state)).toEqual({
      start: 173,
      end: 186,
      from: { floor: 13, door: 4 },
      to: S,
      action: act.finish(),
      outcome: { type: 'finished' },
      walk: 8,
      noticedLifted: [],
    });
    expect(state.log).toHaveLength(before + 1);
    expect(state.ended).toBe('returned');
    expect(state.place).toEqual(S);
    expect(state.minute).toBe(186);
    expect(state.minute).toBe(last(state).end);
    expect(legalActions(world, state)).toEqual([]);
  });

  it('17:00 前开始收工，还完车已过 17:00：仍是 returned，不截断', () => {
    // 120 休息到 150；等到 485 出发去 1307：485 + 8 + 1 = 494 <= 510，合法；493 到门口，508 做完。
    // 508 收工：走 8 分钟，516 到服务间，还车 5 分钟，521 结束。
    const world = controlledWorld({ 1307: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    state = play(world, waitUntil(world, state, 485), act.service(1307));
    expect(state.minute).toBe(508);
    state = play(world, state, act.finish());
    expect(last(state)).toMatchObject({ start: 508, end: 521, walk: 8, outcome: { type: 'finished' } });
    expect(state.ended).toBe('returned');
    expect(state.minute).toBe(521);
  });
});

describe('17:00 之前的时间限制', () => {
  it('到门口加敲门的 1 分钟晚于 17:00 时不能打扫；补货、打电话会在 17:00 之后才结束时也不能做', () => {
    // 四间客人已出门的续住房：从服务间走过去，1201 要 1 分钟，1205 要 3 分钟，1208 要 4 分钟，1301 要 5 分钟。
    const world = controlledWorld({ 1201: stayover(), 1205: stayover(), 1208: stayover(), 1301: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    // 504：1301 是 504 + 5 + 1 = 510，合法；补货 504 + 0 + 5 = 509，合法。
    state = waitUntil(world, state, 504);
    expectLegal(world, state, act.service(1301));
    expectLegal(world, state, act.restock());
    // 505：1301 是 511，不合法；1208 是 505 + 4 + 1 = 510，合法；补货 510，合法。
    state = waitUntil(world, state, 505);
    expectIllegal(world, state, act.service(1301));
    expectLegal(world, state, act.service(1208));
    expectLegal(world, state, act.restock());
    // 506：1208 是 511，不合法；1205 是 506 + 3 + 1 = 510，合法；补货 511，不合法；打电话 508，合法。
    state = waitUntil(world, state, 506);
    expectIllegal(world, state, act.service(1208));
    expectLegal(world, state, act.service(1205));
    expectIllegal(world, state, act.restock());
    expectLegal(world, state, act.call());
    // 508：打电话 510，合法；1201 是 508 + 1 + 1 = 510，合法；1205 是 512，不合法。
    state = waitUntil(world, state, 508);
    expectLegal(world, state, act.call());
    expectLegal(world, state, act.service(1201));
    expectIllegal(world, state, act.service(1205));
    // 509：打电话 511、1201 是 511、补货 514，都不合法；还有房间没做，不能收工；只剩等 1 分钟。
    state = waitUntil(world, state, 509);
    expect(legalActions(world, state)).toEqual([act.wait(1)]);
    for (const action of [act.call(), act.service(1201), act.restock(), act.finish()]) {
      expectIllegal(world, state, action);
    }
  });

  it('敲门被拒改成 3 分钟（自定义参数）：被拒耗时 3 分钟；到门口加 3 分钟不晚于 17:00 才能打扫', () => {
    // 按现有参数（敲门 1 分钟），"到门口加敲门不晚于 17:00"和"17:00 前到门口"分不出来，所以把敲门改成 3 分钟。
    const params: Params = { ...PARAMS.standard, knockRefusedMinutes: 3 };
    // 1201（门位 1）的客人开工前已出门；1203（门位 2）的客人 200 才出门（长住）。
    const world = controlledWorld({ 1201: stayover(), 1203: stayover({ clue: 'longStay', availableFrom: 200 }) }, { params });
    // 120 在服务间休息到 150。去 1203：走 2 分钟，152 到门口，客人还在（152 < 200），被拒 3 分钟，155 结束；
    // 回来时间 ceil(200 / 15) × 15 = 210。
    let state = play(world, waitUntil(world, initial(world), 120), act.break(), act.service(1203));
    expect(last(state)).toMatchObject({
      start: 150,
      end: 155,
      walk: 2,
      outcome: { type: 'knockRefused', room: 1203, comeBackAt: 210 },
    });
    // 在 1203 门口等到 506：走 1 分钟到 1201（门位 1），507 到门口，507 + 3 = 510 <= 510，合法。
    state = waitUntil(world, state, 506);
    expectLegal(world, state, act.service(1201));
    // 507：508 到门口，508 + 3 = 511 > 510，不合法（只看"17:00 前到门口"的话会以为合法）。
    state = waitUntil(world, state, 507);
    expectIllegal(world, state, act.service(1201));
  });
});

describe('17:00 截断', () => {
  it('进门后的打扫跨过 17:00：在 17:00 截断，房间不算完成', () => {
    // 1201 是灾难级退房房（48 分钟）。开工打电话标记，120 休息到 150，等到 500 出发。
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }) });
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, 120), act.break());
    state = play(world, waitUntil(world, state, 500), act.service(1201));
    // 501 到门口（501 + 1 <= 510，合法），开门用 2 份布草；501 + 48 = 549 > 510，在 510 截断，做了 510 - 501 = 9 分钟。
    expect(last(state)).toEqual({
      start: 500,
      end: 510,
      from: S,
      to: { floor: 12, door: 1 },
      action: act.service(1201),
      outcome: { type: 'interrupted', room: 1201, workDone: 9, reason: 'hardStop' },
      walk: 1,
      noticedLifted: [],
    });
    expect(state.minute).toBe(510);
    expect(state.place).toEqual({ floor: 12, door: 1 });
    expect(state.cart).toBe(8 - 2);
    expect(state.ended).toBeNull();
    expect(progress(state, 1201)).toStrictEqual({
      ...freshProgress(1201),
      doneAt: null,
      workDone: 9,
      flaggedDeparted: true,
      messRevealed: true,
    });
  });

  it('续住房差 1 分钟做完也截断', () => {
    // 120 休息到 150；等到 495 出发去 1201：496 到门口，496 + 15 = 511 > 510，截断，做了 14 分钟，布草已用 1 份。
    const world = controlledWorld({ 1201: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    state = play(world, waitUntil(world, state, 495), act.service(1201));
    expect(last(state)).toMatchObject({
      start: 495,
      end: 510,
      outcome: { type: 'interrupted', room: 1201, workDone: 14, reason: 'hardStop' },
    });
    expect(state.cart).toBe(7);
    expect(progress(state, 1201)).toStrictEqual({ ...freshProgress(1201), workDone: 14, messRevealed: true });
  });

  it('恰好在 17:00 做完的算完成', () => {
    // 等到 494 出发去 1201：495 到门口，495 + 15 = 510 <= 510，做完，doneAt 为 510。
    const world = controlledWorld({ 1201: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    state = play(world, waitUntil(world, state, 494), act.service(1201));
    expect(last(state)).toMatchObject({
      start: 494,
      end: 510,
      outcome: { type: 'cleaned', room: 1201, minutes: 15 },
    });
    expect(progress(state, 1201)).toStrictEqual({
      ...freshProgress(1201),
      doneAt: 510,
      workDone: 15,
      messRevealed: true,
    });
    expect(legalActions(world, state)).toEqual([act.finish()]);
  });
});

describe('17:00 之后', () => {
  it('只能还车，即使还有房间没做完；还车后 ended 为 hardStop，日志只多一条', () => {
    // 接上面的截断：510 停在 {12, 1}，1201 做了 9 分钟，1203 一直没做。
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }), 1203: stayover() });
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, 120), act.break());
    state = play(world, waitUntil(world, state, 500), act.service(1201));
    expect(state.minute).toBe(510);
    expect(legalActions(world, state)).toEqual([act.finish()]);
    const others = [act.service(1201), act.service(1203), act.restock(), act.call(), act.wait(1), act.break()];
    for (const action of others) expectIllegal(world, state, action);
    const before = state.log.length;
    state = play(world, state, act.finish());
    // 走 1 分钟回服务间，511 到，还车 5 分钟，516 结束。
    expect(state.log).toHaveLength(before + 1);
    expect(last(state)).toEqual({
      start: 510,
      end: 516,
      from: { floor: 12, door: 1 },
      to: S,
      action: act.finish(),
      outcome: { type: 'finished' },
      walk: 1,
      noticedLifted: [],
    });
    expect(state.ended).toBe('hardStop');
    expect(state.minute).toBe(516);
    expect(state.place).toEqual(S);
    expect(legalActions(world, state)).toEqual([]);
  });

  it('在服务间等到 17:00：只能还车，515 结束', () => {
    const world = controlledWorld({ 1201: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    state = waitUntil(world, state, 510);
    expect(legalActions(world, state)).toEqual([act.finish()]);
    state = play(world, state, act.finish());
    // 步行 0，还车 5 分钟：510 + 0 + 5 = 515。
    expect(last(state)).toMatchObject({ start: 510, end: 515, walk: 0 });
    expect(state.ended).toBe('hardStop');
    expect(state.minute).toBe(515);
  });

  it('17:00 到了还没休息：只能还车，不要求已休息；这条规则排在强制休息之前', () => {
    // 故意把休息窗口的上界改到 16:50（500），才能走到"17:00 到了、还没休息、也过了上界"的状态。
    // 现有参数下走不到这种状态（参数测试保证最晚的强制休息 16:07 就结束）。
    const params: Params = { ...PARAMS.standard, shift: { ...PARAMS.standard.shift, breakLatest: 500 } };
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }) }, { params });
    // 开工打电话标记 1201，在服务间等到 499：还不到 500，不用强制休息，打扫和休息都合法。
    let state = play(world, initial(world), act.call());
    state = waitUntil(world, state, 499);
    expectLegal(world, state, act.break());
    expectLegal(world, state, act.service(1201));
    // 499 出发，500 到门口（500 + 1 <= 510），打扫 48 分钟要到 548，在 510 截断，做了 10 分钟。
    state = play(world, state, act.service(1201));
    expect(last(state)).toMatchObject({
      start: 499,
      end: 510,
      outcome: { type: 'interrupted', room: 1201, workDone: 10, reason: 'hardStop' },
    });
    // 现在既到了 17:00，又过了休息上界还没休息：只能还车，休息不合法。
    expect(state.breakTaken).toBe(false);
    expect(legalActions(world, state)).toEqual([act.finish()]);
    expectIllegal(world, state, act.break());
    // 走 1 分钟回服务间，还车 5 分钟：510 + 1 + 5 = 516。
    state = play(world, state, act.finish());
    expect(state.ended).toBe('hardStop');
    expect(state.breakTaken).toBe(false);
    expect(state.minute).toBe(516);
  });
});
