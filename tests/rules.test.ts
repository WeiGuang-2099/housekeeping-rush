/**
 * rules 的单元测试：initial、legalActions 与非法动作，以及对外入口。
 * 打扫、打电话、路过见 rules.service.test.ts 和 rules.call.test.ts；
 * 补货、休息、等待、收工和 17:00 见 rules.shift.test.ts；性质测试见 rules.property.test.ts。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0。同层每个门位 1 分钟，跨层先走到门位 0，乘电梯 4 分钟。
 * 时刻从 08:30 起算：120 是 10:30，360 是 14:30，510 是 17:00。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  apply as applyFromIndex,
  cleanMinutes as cleanMinutesFromIndex,
  initial as initialFromIndex,
  legalActions as legalActionsFromIndex,
  walkPath as walkPathFromIndex,
} from '../src/engine';
import { generate } from '../src/engine/generate';
import { allRooms, walkPath } from '../src/engine/layout';
import { PARAMS, type Params, type Tier } from '../src/engine/params';
import { apply, cleanMinutes, initial, legalActions } from '../src/engine/rules';
import type { Action, State, World } from '../src/engine/types';
import {
  act,
  expectIllegal,
  expectLegal,
  freshProgress,
  last,
  play,
  progress,
  serviceTargets,
  waitUntil,
} from './helpers/drive';
import { BEFORE_START, controlledWorld, departure, dnd, patchWorld, stayover, type RoomSetup } from './helpers/world';

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];

describe('initial', () => {
  it.each(TIERS)('%s 档：08:30 开工，人和满载的布草车在服务间，其余字段为初值', (tier) => {
    const params = PARAMS[tier];
    // 布草车容量：标准档 8 份，紧档和周末档 6 份。
    const capacity: Record<Tier, number> = { standard: 8, tight: 6, weekend: 6 };
    for (const seed of ['initial-0', 'initial-1', 'initial-2']) {
      const world = generate(seed, params);
      const state = initial(world);
      // 整个 State 一起比：恰好是这十个字段，没有多余的字段（例如累计步行，步行分钟只记在每条日志的 walk 里）。
      expect(state).toStrictEqual({
        minute: 0,
        place: { floor: 12, door: 0 },
        cart: capacity[tier],
        breakTaken: false,
        rooms: world.rooms.map((room) => freshProgress(room.id)),
        prompt: null,
        firedEvents: [],
        violation: false,
        ended: null,
        log: [],
      });
      expect(state.place).toEqual(params.layout.servicePoint);
      // place 是服务间的副本，不与 params 共享对象。
      expect(state.place).not.toBe(params.layout.servicePoint);
    }
  });

  it.each(TIERS)('%s 档：房间进度与 world.rooms 一一对应、顺序相同，全部为初值', (tier) => {
    let departedBeforeStart = 0;
    for (const seed of ['rooms-0', 'rooms-1', 'rooms-2', 'rooms-3', 'rooms-4']) {
      const world = generate(seed, PARAMS[tier]);
      const state = initial(world);
      expect(state.rooms.map((room) => room.id)).toEqual(world.rooms.map((room) => room.id));
      expect(state.rooms).toStrictEqual(world.rooms.map((room) => freshProgress(room.id)));
      departedBeforeStart += world.rooms.filter((room) => room.kind === 'departure' && room.availableFrom < 0).length;
    }
    // 这几个种子里确实有开工前已退房的退房房，它们也全是初值（没有预先标记）。
    expect(departedBeforeStart).toBeGreaterThan(0);
  });

  it('开工前已退房的退房房也不预先标记，延迟退房房也不预填回来时间', () => {
    // 1201、1305 开工前已退房（availableFrom 为 -30），1203 第 0 分钟退房，1207 延迟到 12:00（210）退房。
    const world = controlledWorld({
      1201: departure({ availableFrom: BEFORE_START }),
      1203: departure({ availableFrom: 0 }),
      1207: departure({ availableFrom: 210, lateCheckout: true }),
      1305: departure({ availableFrom: BEFORE_START, clue: 'threeNightsPlus' }),
    });
    const state = initial(world);
    for (const id of [1201, 1203, 1207, 1305]) expect(progress(state, id)).toStrictEqual(freshProgress(id));
  });
});

describe('initial：自定义 params', () => {
  const standard = PARAMS.standard;
  const tight = PARAMS.tight;
  /** 只有 12 楼 8 间房：3 间退房、4 间续住、1 间请勿打扰，一个贵宾时限（13:00）。 */
  const oneFloor: Params = {
    ...standard,
    layout: { ...standard.layout, floors: [{ floor: 12, rooms: [1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208] }] },
    mix: { departures: 3, stayovers: 4, dnd: 1 },
    vipDeadlines: [270],
  };
  /** 共 6 间房，12 楼和 13 楼各 3 间：2 间退房、3 间续住、1 间请勿打扰，紧档的布草车。 */
  const sixRooms: Params = {
    ...tight,
    layout: {
      ...tight.layout,
      floors: [
        { floor: 12, rooms: [1201, 1202, 1203] },
        { floor: 13, rooms: [1301, 1302, 1303] },
      ],
    },
    mix: { departures: 2, stayovers: 3, dnd: 1 },
    vipDeadlines: [270],
  };

  const cases: [string, Params, number][] = [
    ['只有 12 楼 8 间房', oneFloor, 8],
    ['共 6 间房', sixRooms, 6],
  ];

  for (const [label, params, count] of cases) {
    it(`${label}：房间数从 world.rooms 读，随机合法动作能跑完一整局`, () => {
      fc.assert(
        fc.property(fc.string(), fc.array(fc.nat(), { minLength: 1, maxLength: 40 }), (seed, picks) => {
          const world = generate(seed, params);
          let state = initial(world);
          expect(state.rooms.map((room) => room.id)).toEqual(allRooms(params));
          expect(state.rooms).toHaveLength(count);
          // 每个动作至少推进 1 分钟，所以班次在 hardStop + 事件数 + 1 步之内结束。
          const limit = params.shift.hardStop + world.events.length + 1;
          let steps = 0;
          while (state.ended === null) {
            const legal = legalActions(world, state);
            expect(legal.length).toBeGreaterThan(0);
            for (const id of serviceTargets(legal)) expect(allRooms(params)).toContain(id);
            const pick = picks[steps % picks.length] ?? 0;
            const action = legal[pick % legal.length];
            if (action === undefined) throw new Error('没有合法动作');
            state = apply(world, state, action);
            steps++;
            expect(steps).toBeLessThanOrEqual(limit);
          }
          expect(['returned', 'hardStop']).toContain(state.ended);
          expect(state.rooms).toHaveLength(count);
          expect(legalActions(world, state)).toEqual([]);
        }),
        { numRuns: 30 },
      );
    });
  }
});

describe('legalActions：打扫目标', () => {
  it('没打过电话时，所有退房房都不合法，包括开工前已退房的', () => {
    // 1201、1301 开工前已退房，1203 第 0 分钟退房，1207 延迟退房（210）；1205 是客人开工前已出门的续住房。
    const world = controlledWorld({
      1201: departure({ availableFrom: BEFORE_START }),
      1203: departure({ availableFrom: 0 }),
      1205: stayover(),
      1207: departure({ availableFrom: 210, lateCheckout: true }),
      1301: departure({ availableFrom: BEFORE_START }),
    });
    const departures = [1201, 1203, 1207, 1301];
    let state = initial(world);
    // 开工时只有续住房 1205 能打扫。
    expect(serviceTargets(legalActions(world, state))).toEqual([1205]);
    for (const id of departures) expectIllegal(world, state, act.service(id));
    // 在服务间等到 310：四间都已经退房（-30、0、210 都不晚于 310），但没打电话，仍然都不合法。
    state = waitUntil(world, state, 310);
    expect(serviceTargets(legalActions(world, state))).toEqual([1205]);
    for (const id of departures) expectIllegal(world, state, act.service(id));
  });

  it('续住房只要没做完、布草够、来得及到门口就合法，不管客人此刻在不在', () => {
    // 1201 的客人 200 才出门（长住），1208 的客人 100 出门（游客），1301 的客人开工前已出门。
    const world = controlledWorld({
      1201: stayover({ clue: 'longStay', availableFrom: 200 }),
      1208: stayover({ clue: 'tourist', availableFrom: 100 }),
      1301: stayover(),
    });
    const state = initial(world);
    // 三间都合法，按 world.rooms 的顺序：1201、1208、1301。
    expect(serviceTargets(legalActions(world, state))).toEqual([1201, 1208, 1301]);
    // 去 1201：第 1 分钟到门口，客人还在（1 < 200），敲门被拒；动作本身合法，不抛错。
    // 回来时间 ceil(200 / 15) × 15 = 14 × 15 = 210。
    const after = play(world, state, act.service(1201));
    expect(last(after).outcome).toEqual({ type: 'knockRefused', room: 1201, comeBackAt: 210 });
  });

  it('布草边界（紧档，容量 6）：剩 1 份时已标记的退房房不合法，续住房和已摘牌的请勿打扰房合法；剩 0 份时都不合法', () => {
    const world = controlledWorld(
      {
        1201: departure(),
        1202: departure(),
        1203: stayover(),
        1204: stayover(),
        1205: stayover(),
        1206: stayover(),
        1207: stayover(),
        1208: dnd({ dndLiftsAt: 150 }),
      },
      { tier: 'tight' },
    );
    // 在服务间等到 148 打电话，挂断时刻 150：1201、1202 标为已退，1208 得知摘牌（150 <= 150）。
    let state = play(world, waitUntil(world, initial(world), 148), act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [1201, 1202], newlyLifted: [1208] });
    expect(state.cart).toBe(6);
    // 1201 用 2 份，1203、1204、1205 各用 1 份：6 - 2 - 3 = 1。
    state = play(world, state, act.service(1201), act.service(1203), act.service(1204), act.service(1205));
    expect(state.cart).toBe(1);
    expect(serviceTargets(legalActions(world, state))).toEqual([1206, 1207, 1208]);
    expectIllegal(world, state, act.service(1202));
    // 再做 1206：剩 0 份，所有打扫都不合法。
    state = play(world, state, act.service(1206));
    expect(state.cart).toBe(0);
    expect(serviceTargets(legalActions(world, state))).toEqual([]);
    for (const id of [1202, 1207, 1208]) expectIllegal(world, state, act.service(id));
    // 补满之后又都合法。
    state = play(world, state, act.restock());
    expect(state.cart).toBe(6);
    expect(serviceTargets(legalActions(world, state))).toEqual([1202, 1207, 1208]);
  });

  it('已做完的房间和不存在的房号不合法，apply 收到时抛错', () => {
    const world = controlledWorld({ 1201: stayover() });
    let state = initial(world);
    expectIllegal(world, state, act.service(1499));
    // 1201：第 1 分钟到门口，打扫 15 分钟，第 16 分钟做完。
    state = play(world, state, act.service(1201));
    expect(progress(state, 1201).doneAt).toBe(16);
    expectIllegal(world, state, act.service(1201));
    expectIllegal(world, state, act.service(1499));
  });

  it('还没得知摘牌的请勿打扰房不合法，得知后合法', () => {
    // 1203 在 150 摘牌，客人开工前已出门。
    const world = controlledWorld({ 1203: dnd({ dndLiftsAt: 150 }) });
    let state = initial(world);
    expectIllegal(world, state, act.service(1203));
    // 一直待在服务间（门位 0 没有房间，看不到摘牌），等到 160：已经摘牌，但玩家不知道，仍不合法。
    state = waitUntil(world, state, 160);
    expect(progress(state, 1203).dndLiftKnown).toBe(false);
    expectIllegal(world, state, act.service(1203));
    // 160 打电话，挂断时刻 162 >= 150，得知摘牌，之后合法。
    state = play(world, state, act.call());
    expect(progress(state, 1203).dndLiftKnown).toBe(true);
    expectLegal(world, state, act.service(1203));
    // 服务间到 1203（门位 2）2 分钟，164 到门口，客人不在，打扫 15 分钟，179 做完。
    state = play(world, state, act.service(1203));
    expect(last(state).outcome).toEqual({ type: 'cleaned', room: 1203, minutes: 15 });
    expect(state.minute).toBe(179);
  });

  it('贵宾时限已过的房间仍然合法，时限不改变打扫耗时', () => {
    // 1201 是 13:00（270）的贵宾房，1202 是普通退房房，同一门位，都开工前已退房，都是普通脏乱。
    const world = controlledWorld({ 1201: departure({ vipDeadline: 270 }), 1202: departure() });
    // 等到 280（已过时限）打电话，挂断时刻 282，两间都标为已退，都合法。
    let state = play(world, waitUntil(world, initial(world), 280), act.call());
    expect(serviceTargets(legalActions(world, state))).toEqual([1201, 1202]);
    // 1201：走 1 分钟，283 到门口，打扫 30 分钟，313 做完。
    state = play(world, state, act.service(1201));
    expect(last(state)).toMatchObject({ start: 282, end: 313, outcome: { type: 'cleaned', room: 1201, minutes: 30 } });
    // 1202 对着同一个门位：313 进门，同样打扫 30 分钟，343 做完。
    state = play(world, state, act.service(1202));
    expect(last(state)).toMatchObject({ start: 313, end: 343, outcome: { type: 'cleaned', room: 1202, minutes: 30 } });
  });
});

describe('legalActions：列表的顺序和内容', () => {
  it('打扫按 world.rooms 的顺序在前，然后依次是补货、打电话、休息、等待；同一状态调用两次结果相同', () => {
    // 1201 续住，1203 退房（60 退房），1305 请勿打扰（150 摘牌），1307 续住；客人都已出门。
    const world = controlledWorld({
      1201: stayover(),
      1203: departure({ availableFrom: 60 }),
      1305: dnd({ dndLiftsAt: 150 }),
      1307: stayover(),
    });
    // 等到 148 打电话，挂断时刻 150：1203 标为已退，1305 得知摘牌。现在 150，在服务间，没休息。
    const state = play(world, waitUntil(world, initial(world), 148), act.call());
    // 补货 150 + 0 + 5 <= 510；打电话 150 + 2 <= 510；休息 150 + 0 >= 120；等待 min(5, 510 - 150) = 5；
    // 还有房间没做、也没休息，不能收工。
    expect(legalActions(world, state)).toEqual([
      act.service(1201),
      act.service(1203),
      act.service(1305),
      act.service(1307),
      act.restock(),
      act.call(),
      act.break(),
      act.wait(5),
    ]);
    expect(legalActions(world, state)).toStrictEqual(legalActions(world, state));
  });

  it('全部做完并已休息：补货、打电话、等待、收工', () => {
    const world = controlledWorld({ 1201: stayover() });
    // 1201 在 16 做完，停在门位 1。等到 119 休息：119 + 1 = 120 到服务间，不早于 10:30，150 休息完。
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break());
    expect(state.minute).toBe(150);
    expect(legalActions(world, state)).toEqual([act.restock(), act.call(), act.wait(5), act.finish()]);
    expect(legalActions(world, state)).toStrictEqual(legalActions(world, state));
  });

  it('恰好有一个等待，分钟数为 min(waitStepMinutes, hardStop - minute)；507 时是 wait(3)', () => {
    const world = controlledWorld({});
    const waitsIn = (state: State): Action[] => legalActions(world, state).filter((action) => action.type === 'wait');
    let state = initial(world);
    expect(waitsIn(state)).toEqual([act.wait(5)]);
    // 120 在服务间休息，150 休息完，再等到 505：min(5, 510 - 505) = 5。
    state = play(world, waitUntil(world, state, 120), act.break());
    state = waitUntil(world, state, 505);
    expect(waitsIn(state)).toEqual([act.wait(5)]);
    // 506、507、508、509：上限分别是 510 减去它们，即 4、3、2、1。
    const expected: [number, number][] = [
      [506, 4],
      [507, 3],
      [508, 2],
      [509, 1],
    ];
    for (const [minute, max] of expected) {
      state = waitUntil(world, state, minute);
      expect(waitsIn(state)).toEqual([act.wait(max)]);
    }
    // 510 之后只能还车，没有等待。
    state = waitUntil(world, state, 510);
    expect(waitsIn(state)).toEqual([]);
  });

  it('班次结束后 legalActions 为空，之后任何 apply 都抛错', () => {
    const world = controlledWorld({ 1201: stayover() });
    // 1201 在 16 做完；在门位 1 等到 119 休息，150 休息完；在服务间收工：步行 0，还车 5 分钟，155 结束。
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break(), act.finish());
    expect(state.ended).toBe('returned');
    expect(state.minute).toBe(155);
    expect(legalActions(world, state)).toEqual([]);
    const everything = [
      act.service(1201),
      act.service(1202),
      act.restock(),
      act.call(),
      act.break(),
      act.wait(1),
      act.respond('continue'),
      act.finish(),
    ];
    for (const action of everything) expectIllegal(world, state, action);
  });

  it('respond 永远不在列表里，apply 收到 respond 时抛错', () => {
    // 阶段 0 没有事件，prompt 恒为 null。沿途几个状态都检查一遍。
    const world = controlledWorld({ 1201: stayover(), 1203: departure(), 1205: stayover({ clue: 'tourist', availableFrom: 100 }) });
    const states: State[] = [initial(world)];
    const steps = [act.call(), act.service(1203), act.service(1205), act.service(1201), act.restock()];
    for (const action of steps) {
      const previous = states[states.length - 1];
      if (previous === undefined) throw new Error('没有状态');
      states.push(apply(world, previous, action));
    }
    for (const state of states) {
      expect(state.prompt).toBeNull();
      expect(legalActions(world, state).some((action) => action.type === 'respond')).toBe(false);
      expectIllegal(world, state, act.respond('continue'));
      expectIllegal(world, state, act.respond(''));
    }
  });
});

describe('非法动作的报错写明玩家已知的原因', () => {
  // 只查关键内容（房号、钟点、原因的关键词），不查整句，改措辞不用改测试。

  it('不存在的房号：报错里有这个房号', () => {
    const world = controlledWorld({});
    expectIllegal(world, initial(world), act.service(1499), '1499');
  });

  it('没标记的退房房：报错里有房号和"标记"', () => {
    // 1204 开工前已退房，但还没打电话，玩家不知道。
    const world = controlledWorld({ 1204: departure() });
    expectIllegal(world, initial(world), act.service(1204), /1204.*标记/);
  });

  it('客人说过回来时间：报错里用钟点写出回来时间，不写原始分钟数', () => {
    // 1201 的客人 61 出门：第 1 分钟到门口被拒，第 2 分钟结束，回来时间 ceil(61 / 15) × 15 = 75。
    // 第 2 分钟站在门口再去：2 < 75，不合法。75 分钟是 09:45（clock.toClock）。
    const world = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 61 }) });
    const state = play(world, initial(world), act.service(1201));
    expect(state.minute).toBe(2);
    expectIllegal(world, state, act.service(1201), '09:45');
  });

  it('布草不够：报错里有"布草"', () => {
    // 紧档，布草车 6 份。开工打电话（0 到 2），标记开工前已退房的 1201。
    // 再做 1203 到 1207 五间续住房：1203 在 4 到门口、19 做完，1204 在 34、1205 在 50、1206 在 65、1207 在 81 做完，
    // 各用 1 份，剩 6 - 5 = 1 份；1201 要 2 份，不够。
    const world = controlledWorld(
      {
        1201: departure(),
        1203: stayover(),
        1204: stayover(),
        1205: stayover(),
        1206: stayover(),
        1207: stayover(),
      },
      { tier: 'tight' },
    );
    const state = play(
      world,
      initial(world),
      act.call(),
      act.service(1203),
      act.service(1204),
      act.service(1205),
      act.service(1206),
      act.service(1207),
    );
    expect(state.minute).toBe(81);
    expect(state.cart).toBe(1);
    expectIllegal(world, state, act.service(1201), '布草');
  });

  it('14:30 起还没休息：等待的报错里有"只能休息"', () => {
    // 在服务间等到 360，还没休息。
    const world = controlledWorld({});
    const state = waitUntil(world, initial(world), 360);
    expectIllegal(world, state, act.wait(1), '只能休息');
  });

  it('17:00 以后：打电话的报错写明 17:00 已过、只能还车', () => {
    // 120 在服务间休息，150 休息完，再等到 510。
    const world = controlledWorld({});
    const rested = play(world, waitUntil(world, initial(world), 120), act.break());
    const state = waitUntil(world, rested, 510);
    expectIllegal(world, state, act.call(), /17:00.*还车/);
  });

  it('班次结束以后：报错里有"班次已经结束"', () => {
    // 没写到的房间都是整班不摘牌的请勿打扰房，不挡收工。120 休息到 150，在服务间收工，155 还完车。
    const world = controlledWorld({});
    const state = play(world, waitUntil(world, initial(world), 120), act.break(), act.finish());
    expect(state.ended).toBe('returned');
    expectIllegal(world, state, act.wait(1), '班次已经结束');
  });
});

describe('非法动作的报错不泄露隐藏信息', () => {
  /** 两个世界的已知状态完全相同；同一个非法动作在两边都抛错，报错文字完全相同。 */
  function expectSameError(a: World, stateA: State, b: World, stateB: State, action: Action): void {
    expect(stateB).toStrictEqual(stateA);
    expect(legalActions(b, stateB)).toStrictEqual(legalActions(a, stateA));
    expect(expectIllegal(b, stateB, action)).toBe(expectIllegal(a, stateA, action));
  }

  it('未标记退房房的退房时刻不同：打扫它、收工的报错相同', () => {
    // 两个世界只差 1201 的退房时刻：开工前已退，或 140 才退（晚段）。都没打电话，玩家看不出区别。
    const a = controlledWorld({ 1201: departure({ availableFrom: BEFORE_START }), 1203: stayover() });
    const b = patchWorld(a, { 1201: { availableFrom: 140 } });
    let stateA = initial(a);
    let stateB = initial(b);
    expectSameError(a, stateA, b, stateB, act.service(1201));
    expectSameError(a, stateA, b, stateB, act.finish());
    // 在服务间等到 120 休息、150 休息完，再做 1203（152 到门口，167 做完）：两边都只差 1201 还没做。
    const route = (world: World): State =>
      play(world, waitUntil(world, initial(world), 120), act.break(), act.service(1203));
    stateA = route(a);
    stateB = route(b);
    expect(stateA.minute).toBe(167);
    expectSameError(a, stateA, b, stateB, act.service(1201));
    expectSameError(a, stateA, b, stateB, act.finish());
  });

  it('未开门房间的脏乱和客人出门时刻不同、但回来时间相同：再去的报错相同', () => {
    // 1201：甲世界客人 61 出门、整洁；乙世界 74 出门、灾难。第 1 分钟到门口都被拒，回来时间都是 75。
    const a = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 61, mess: 'tidy' }) });
    const b = patchWorld(a, { 1201: { availableFrom: 74, mess: 'disaster' } });
    const stateA = play(a, initial(a), act.service(1201));
    const stateB = play(b, initial(b), act.service(1201));
    // 第 2 分钟站在门口：2 < 75，不合法。
    expectSameError(a, stateA, b, stateB, act.service(1201));
    expectSameError(a, stateA, b, stateB, act.finish());
  });

  it('请勿打扰房的摘牌时刻不同：打扫它的报错相同', () => {
    // 1203：甲世界整班不摘牌，乙世界 150 摘牌。一直待在服务间，玩家不会得知。
    const a = controlledWorld({ 1203: dnd() });
    const b = patchWorld(a, { 1203: { dndLiftsAt: 150 } });
    expectSameError(a, initial(a), b, initial(b), act.service(1203));
    expectSameError(a, waitUntil(a, initial(a), 200), b, waitUntil(b, initial(b), 200), act.service(1203));
  });

  // 下面三种隐藏值已经部分揭晓：玩家只知道它落在某个范围里，确切的值仍然隐藏。

  it('已标记退房房的确切退房时刻不同：做完后再打扫它的报错相同', () => {
    // 1201：甲世界开工前已退房（-30），乙世界 52 才退。两边都等到 50 打电话，挂断时刻 52，都标为已退：
    // 玩家只知道退房时刻不晚于 52。走 1 分钟，53 到门口，直接进门，打扫 30 分钟，83 做完。
    const a = controlledWorld({ 1201: departure({ availableFrom: BEFORE_START }) });
    const b = patchWorld(a, { 1201: { availableFrom: 52 } });
    const route = (world: World): State =>
      play(world, waitUntil(world, initial(world), 50), act.call(), act.service(1201));
    const stateA = route(a);
    const stateB = route(b);
    expect(stateA.minute).toBe(83);
    expectSameError(a, stateA, b, stateB, act.service(1201));
  });

  it('进过门的续住房，客人确切的出门时刻不同：做完后再打扫它的报错相同', () => {
    // 1203：甲世界客人开工前已出门（-30），乙世界第 2 分钟出门。开工直接去：走 2 分钟，第 2 分钟到门口，
    // 两边都不早于出门时刻，直接进门：玩家只知道出门时刻不晚于 2。打扫 15 分钟，17 做完。
    const a = controlledWorld({ 1203: stayover({ availableFrom: BEFORE_START }) });
    const b = patchWorld(a, { 1203: { availableFrom: 2 } });
    const stateA = play(a, initial(a), act.service(1203));
    const stateB = play(b, initial(b), act.service(1203));
    expect(stateA.minute).toBe(17);
    expectSameError(a, stateA, b, stateB, act.service(1203));
  });

  it('已知摘牌的请勿打扰房，确切的摘牌时刻不同：做完后再打扫它的报错相同', () => {
    // 1205：甲世界 150 摘牌，乙世界 165 摘牌，客人都开工前已出门。在服务间（门位 0，看不到摘牌）等到 170 打电话，
    // 挂断时刻 172，两边都得知摘牌：玩家只知道摘牌时刻不晚于 172。走 3 分钟，175 到门口，打扫 15 分钟，190 做完。
    const a = controlledWorld({ 1205: dnd({ dndLiftsAt: 150 }) });
    const b = patchWorld(a, { 1205: { dndLiftsAt: 165 } });
    const route = (world: World): State =>
      play(world, waitUntil(world, initial(world), 170), act.call(), act.service(1205));
    const stateA = route(a);
    const stateB = route(b);
    expect(stateA.minute).toBe(190);
    expectSameError(a, stateA, b, stateB, act.service(1205));
  });
});

describe('按 world.rooms 的顺序，不按房号：楼层倒过来列的自定义布局', () => {
  // 标准档的两层倒过来列：13 楼在前，world.rooms 以 1301 开头，房号顺序和 world.rooms 的顺序不再一致。
  // 几何不变：服务间仍是 12 楼门位 0，从服务间到 13 楼门位 d 要走 d + 4 分钟。
  const reversed: Params = {
    ...PARAMS.standard,
    layout: { ...PARAMS.standard.layout, floors: [...PARAMS.standard.layout.floors].reverse() },
  };

  /** 楼层倒过来的受控世界，并确认 world.rooms 确实先列 13 楼。 */
  function reversedWorld(rooms: Record<number, RoomSetup>): World {
    const world = controlledWorld(rooms, { params: reversed });
    expect(world.rooms.map((room) => room.id).slice(0, 8)).toEqual([1301, 1302, 1303, 1304, 1305, 1306, 1307, 1201]);
    return world;
  }

  it('打扫候选：1301 在 1201 前面', () => {
    // 1201、1301 都是客人开工前已出门的续住房。开工时两间都合法：1201 第 1 分钟到门口，1301 第 5 分钟到门口。
    const world = reversedWorld({ 1201: stayover(), 1301: stayover() });
    expect(serviceTargets(legalActions(world, initial(world)))).toEqual([1301, 1201]);
  });

  it('电话的 newlyDeparted 和 newlyLifted：13 楼的房间在前', () => {
    // 1203、1303 开工前已退房：开工打电话，挂断时刻 2，两间都标为已退。
    const departed = reversedWorld({ 1203: departure(), 1303: departure() });
    const called = play(departed, initial(departed), act.call());
    expect(last(called).outcome).toEqual({ type: 'called', newlyDeparted: [1303, 1203], newlyLifted: [] });
    // 1205、1305 在 150 摘牌：在服务间等到 148 打电话，挂断时刻 150，两间都得知。
    const lifted = reversedWorld({ 1205: dnd({ dndLiftsAt: 150 }), 1305: dnd({ dndLiftsAt: 150 }) });
    const state = play(lifted, waitUntil(lifted, initial(lifted), 148), act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1305, 1205] });
  });

  it('noticedLifted：13 楼的房间在前', () => {
    // 1205、1305 在 150 摘牌，1203、1303 在 170 摘牌，客人都开工前已出门。
    const world = reversedWorld({
      1203: dnd({ dndLiftsAt: 170 }),
      1205: dnd({ dndLiftsAt: 150 }),
      1303: dnd({ dndLiftsAt: 170 }),
      1305: dnd({ dndLiftsAt: 150 }),
    });
    // 在服务间等到 148 打电话，挂断时刻 150：得知 1305、1205 摘牌；1203、1303 还没摘。
    let state = play(world, waitUntil(world, initial(world), 148), act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1305, 1205] });
    // 150 出发去 1305（13 楼门位 3）：154 到 13 楼门位 0，156 经过门位 2（1303 还没摘），157 到门口，172 做完。
    state = play(world, state, act.service(1305));
    expect(last(state)).toMatchObject({ start: 150, end: 172, walk: 7, noticedLifted: [] });
    // 172 从 {13, 3} 去 1205（12 楼门位 3）：173 经过 13 楼门位 2，看到 1303；175 到 13 楼门位 0，乘电梯，
    // 179 到 12 楼门位 0，181 经过门位 2，看到 1203；182 到门口，197 做完。
    // 按房号是 1203 在前，按 world.rooms 是 1303 在前。（按看到的先后排的写法，由 rules.service.test.ts 的路过用例区分。）
    state = play(world, state, act.service(1205));
    expect(last(state)).toMatchObject({ start: 172, end: 197, walk: 10, noticedLifted: [1303, 1203] });
  });
});

describe('对外入口', () => {
  it('能从 src/engine/index.ts 导入 initial、legalActions、apply、cleanMinutes、walkPath', () => {
    expect(initialFromIndex).toBe(initial);
    expect(legalActionsFromIndex).toBe(legalActions);
    expect(applyFromIndex).toBe(apply);
    expect(cleanMinutesFromIndex).toBe(cleanMinutes);
    expect(walkPathFromIndex).toBe(walkPath);
    for (const fn of [initialFromIndex, legalActionsFromIndex, applyFromIndex, cleanMinutesFromIndex, walkPathFromIndex]) {
      expect(typeof fn).toBe('function');
    }
  });
});
