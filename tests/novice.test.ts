/**
 * 新手（src/policies/novice.ts）的单元测试。性质测试（契约、行为不泄露、对照新手规则）见 novice.property.test.ts。
 *
 * 每个用例用受控世界写明几间房，起始状态一律由 initial 加一串合法动作推出来。交给新手的和驱动函数约定的一样：
 * observe 的结果（深度冻结）和 world.params。没写到的房间是整班不摘牌的请勿打扰房（见 tests/helpers/world.ts），
 * 新手永远不知道它们摘牌，所以它们一直算"打电话可能问出新消息"；要排除这一点的用例用只有四间房、没有请勿打扰房的 SMALL。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0。同层每个门位 1 分钟，跨层先走到门位 0，乘电梯 4 分钟。
 * 打扫分钟：退房房 30，续住房和请勿打扰房 15（普通脏乱）；退房房要 2 份布草，续住房 1 份。敲门被拒花 1 分钟，
 * 回来时间按 15 分钟向上取整。打电话 2 分钟，补货和收工还车是走回服务间再加 5 分钟，休息是走回服务间再加 30 分钟。
 * 时刻从 08:30 起算：120 是 10:30，240 是 12:30（新手的休息时刻），360 是 14:30，510 是 17:00。
 */

import { describe, expect, it } from 'vitest';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { initial, legalActions } from '../src/engine/rules';
import type { Action, State, World } from '../src/engine/types';
import { novice } from '../src/policies/novice';
import { act, errorOf, last, play, progress, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { at, deepFreeze } from './helpers/play';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

/** 中文字符，用来确认报错消息是中文。 */
const CHINESE = /[一-鿿]/;

/** 交给新手的和驱动函数约定的一样：observe(world, state) 的结果（深度冻结）和 world.params。 */
function decide(world: World, state: State): Action {
  return novice(deepFreeze(observe(world, state)), world.params);
}

/** 标准档，布草车只装 3 份：做两间续住房就只剩 1 份，不够一间退房房。 */
const CART3: Params = { ...PARAMS.standard, cart: { ...PARAMS.standard.cart, capacity: 3 } };

/**
 * 只有 12 楼的四间房：1201、1202 在门位 1，1203、1204 在门位 2。两间退房房、两间续住房，没有请勿打扰房，没有贵宾。
 * 退房房都标记了以后，打电话就问不出任何新消息。
 */
const SMALL: Params = {
  ...PARAMS.standard,
  layout: { ...PARAMS.standard.layout, floors: [{ floor: 12, rooms: [1201, 1202, 1203, 1204] }] },
  mix: { departures: 2, stayovers: 2, dnd: 0 },
  vipDeadlines: [],
};

/**
 * 标准档，只把 12 楼同在门位 2 的 1203、1204 在楼层平面里对调：几何不变，view.rooms 里 1204 排在 1203 前面。
 * 用来区分"按 view.rooms 的顺序"和"按房号大小"。
 */
const SWAPPED_12: Params = {
  ...PARAMS.standard,
  layout: {
    ...PARAMS.standard.layout,
    floors: [
      { floor: 12, rooms: [1201, 1202, 1204, 1203, 1205, 1206, 1207, 1208] },
      at(PARAMS.standard.layout.floors, 1),
    ],
  },
};

describe('新手：挑最近的、看起来能进的房间', () => {
  it('开工去最近的续住房：没被标记的退房房、还不知道摘牌的请勿打扰房看起来进不去，再近也不算；有房可做就不打电话', () => {
    // 1201 的退房房开工前就退了，1202 是整班不摘牌的请勿打扰房，都在门位 1（走 1 分钟），但新手不知道能进。
    // 能进的是 1203（门位 2，走 2 分钟）和 1301（13 楼门位 1，走 0 + 1 + 4 = 5 分钟）。
    const world = controlledWorld({ 1201: departure(), 1203: stayover(), 1301: stayover() });
    const start = initial(world);
    // 打电话合法，也能问出 1201 已退，但有房可做时新手不打。
    expect(legalActions(world, start)).toContainEqual(act.call());
    expect(decide(world, start)).toStrictEqual(act.service(1203));
  });

  it('客人在不在不猜：没有回来时间的续住房都算能进，客人其实还在房里也照样去敲门', () => {
    // 1203 的客人 200 分钟才出门，新手看不到，照样去，被拒以后才知道回来时间。
    const world = controlledWorld({ 1203: stayover({ availableFrom: 200 }) });
    expect(decide(world, initial(world))).toStrictEqual(act.service(1203));
  });

  it('最近按步行的分钟数算，跨层要算上电梯：从服务间先去 12 楼，在 13 楼门位 1 时先去 13 楼门位 4', () => {
    // 从服务间：1201 走 1 分钟，1301 走 0 + 1 + 4 = 5 分钟，1307 走 0 + 4 + 4 = 8 分钟。
    const world = controlledWorld({ 1201: stayover(), 1301: stayover(), 1307: stayover() });
    expect(decide(world, initial(world))).toStrictEqual(act.service(1201));
    // 做完 1301 人在 13 楼门位 1：1307 走 3 分钟，1201 走 1 + 1 + 4 = 6 分钟。
    const state = play(world, initial(world), act.service(1301));
    expect(state.place).toStrictEqual({ floor: 13, door: 1 });
    expect(decide(world, state)).toStrictEqual(act.service(1307));
  });

  it('ODD_PARAMS：步行分钟按 params 算（每个门位 2 分钟，电梯 3 分钟），从服务间（5 楼门位 0）去 3 楼门位 1 比去 5 楼门位 3 近', () => {
    // 301 在 3 楼门位 1：(0 + 1) × 2 + 3 = 5 分钟；505 在 5 楼门位 3：3 × 2 = 6 分钟。
    // 按标准档的数值（每个门位 1 分钟，电梯 4 分钟）算，就成了 5 和 3，会先去 505。
    const world = controlledWorld({ 301: stayover(), 505: stayover() }, { params: ODD_PARAMS });
    expect(decide(world, initial(world))).toStrictEqual(act.service(301));
  });

  it('一样近时取 view.rooms 里排在前面的那间：同一门位的两间，以及左右各隔一个门位的两间', () => {
    // 1203、1204 同在门位 2，都走 2 分钟，取排在前面的 1203。
    const sameDoor = controlledWorld({ 1203: stayover(), 1204: stayover() });
    expect(decide(sameDoor, initial(sameDoor))).toStrictEqual(act.service(1203));
    // 做完 1203 人在门位 2：1202（门位 1）和 1205（门位 3）都走 1 分钟，取排在前面的 1202。
    const sides = controlledWorld({ 1203: stayover(), 1202: stayover(), 1205: stayover() });
    const atDoor2 = play(sides, initial(sides), act.service(1203));
    expect(decide(sides, atDoor2)).toStrictEqual(act.service(1202));
  });

  it('一样近时看的是 view.rooms 的顺序，不是房号大小：楼层平面里 1204 列在 1203 前面时取 1204', () => {
    const world = controlledWorld({ 1203: stayover(), 1204: stayover() }, { params: SWAPPED_12 });
    const view = observe(world, initial(world));
    // 前提：view.rooms 里 1204 排在 1203 前面，两间在同一个门位。
    expect(view.rooms.map((room) => room.id).slice(0, 4)).toEqual([1201, 1202, 1204, 1203]);
    expect(at(view.rooms, 2).place).toStrictEqual(at(view.rooms, 3).place);
    expect(decide(world, initial(world))).toStrictEqual(act.service(1204));
  });

  it('不看线索，不看时限：电话问出三间已退的退房房以后，先去最近的普通房，同门位的贵宾房和更远的贵宾房都不先去', () => {
    // 1201 是聚会或家庭（多半是灾难档），1202 是 30 分钟时限的贵宾房，1207 是 60 分钟时限的贵宾房。
    const world = controlledWorld({
      1201: departure({ clue: 'partyOrFamily' }),
      1202: departure({ vipDeadline: 30 }),
      1207: departure({ vipDeadline: 60 }),
    });
    // 开工时退房房都还没被标记，没房可做，先打电话。
    expect(decide(world, initial(world))).toStrictEqual(act.call());
    const called = play(world, initial(world), act.call());
    expect(last(called).outcome).toStrictEqual({ type: 'called', newlyDeparted: [1201, 1202, 1207], newlyLifted: [] });
    expect(decide(world, called)).toStrictEqual(act.service(1201));
  });
});

describe('新手：布草', () => {
  it('布草不够这一间要用的份数：先回服务间补货，哪怕更远的那间布草够；补完货从服务间重新挑最近的', () => {
    const world = controlledWorld(
      { 1201: stayover(), 1202: stayover(), 1203: departure(), 1207: stayover() },
      { params: CART3 },
    );
    // 做完 1201、1202（各 1 份）只剩 1 份，人在门位 1；打电话得知 1203 已退。
    const state = play(world, initial(world), act.service(1201), act.service(1202), act.call());
    expect(state.cart).toBe(1);
    expect(progress(state, 1203).flaggedDeparted).toBe(true);
    // 最近的是 1203（走 1 分钟），要 2 份，不够；更远的 1207（走 3 分钟）只要 1 份，够，但新手先补货。
    expect(decide(world, state)).toStrictEqual(act.restock());
    // 补完货在服务间，车满：1203 走 2 分钟，1207 走 4 分钟，去 1203。
    const restocked = play(world, state, act.restock());
    expect(restocked.cart).toBe(3);
    expect(decide(world, restocked)).toStrictEqual(act.service(1203));
  });

  it('布草正好够这一间要用的份数（车里 2 份，退房房要 2 份）：直接去，不补货', () => {
    const world = controlledWorld({ 1201: stayover(), 1203: departure() }, { params: CART3 });
    const state = play(world, initial(world), act.service(1201), act.call());
    expect(state.cart).toBe(2);
    expect(decide(world, state)).toStrictEqual(act.service(1203));
  });

  describe('布草不够、补货又来不及在 17:00 前做完的房间，这班做不成', () => {
    /**
     * 车装 3 份。10:30 休息，做完 1201（门位 1）和 1208（门位 4）只剩 1 份，人在门位 4；打电话得知 1207（门位 4）已退，
     * 然后原地等到 minute。从门位 4 补货要走 4 分钟再加 5 分钟：501 开始正好 510 做完，502 开始就来不及了。
     */
    function nearHardStop(rooms: Parameters<typeof controlledWorld>[0], minute: number): [World, State] {
      const world = controlledWorld(rooms, { params: CART3 });
      let state = waitUntil(world, initial(world), 120);
      state = play(world, state, act.break(), act.service(1201), act.service(1208), act.call());
      expect(state.cart).toBe(1);
      expect(state.place).toStrictEqual({ floor: 12, door: 4 });
      expect(progress(state, 1207).flaggedDeparted).toBe(true);
      return [world, waitUntil(world, state, minute)];
    }

    const rooms = { 1201: stayover(), 1208: stayover(), 1207: departure(), 1205: stayover() };

    it('16:51（501）补货还来得及：1207 就在门口但布草不够，先补货', () => {
      const [world, state] = nearHardStop(rooms, 501);
      expect(legalActions(world, state)).toContainEqual(act.restock());
      expect(decide(world, state)).toStrictEqual(act.restock());
    });

    it('16:52（502）补货来不及：1207 不算能做的房间，去布草够的 1205（门位 3）', () => {
      const [world, state] = nearHardStop(rooms, 502);
      const legal = legalActions(world, state);
      expect(legal).not.toContainEqual(act.restock());
      expect(legal).not.toContainEqual(act.service(1207));
      expect(decide(world, state)).toStrictEqual(act.service(1205));
    });

    it('16:52（502），没有布草够的房间：按没房可做处理，这里还有不知道摘牌的请勿打扰房，打电话', () => {
      // 1205 没写，是整班不摘牌的请勿打扰房。
      const [world, state] = nearHardStop({ 1201: stayover(), 1208: stayover(), 1207: departure() }, 502);
      expect(decide(world, state)).toStrictEqual(act.call());
    });
  });
});

describe('新手：没房可做', () => {
  it('打电话可能问出新消息就打给主管；打完还是没房可做，先等一次，等完再打', () => {
    // 1201 在 60 分钟才退房；没写的房间是不知道摘牌的请勿打扰房。
    const world = controlledWorld({ 1201: departure({ availableFrom: 60 }) });
    expect(decide(world, initial(world))).toStrictEqual(act.call());
    const called = play(world, initial(world), act.call());
    expect(last(called).outcome).toStrictEqual({ type: 'called', newlyDeparted: [], newlyLifted: [] });
    // 不连着打两次：等列出的那一档，5 分钟。
    expect(decide(world, called)).toStrictEqual(act.wait(5));
    const waited = play(world, called, act.wait(5));
    expect(decide(world, waited)).toStrictEqual(act.call());
  });

  it('没有请勿打扰房时，还有没被标记的退房房也算可能问出新消息：续住房都做完了就打电话', () => {
    const world = controlledWorld(
      { 1201: departure(), 1202: departure(), 1203: stayover(), 1204: stayover() },
      { params: SMALL },
    );
    // 做完两间续住房，两间退房房还没被标记，也没有请勿打扰房。
    const state = play(world, initial(world), act.service(1203), act.service(1204));
    expect(decide(world, state)).toStrictEqual(act.call());
  });

  it('上一个动作是不是打电话只从 view.log 推，新手自己不记：交错着问三个局面，答案只看各自的 View', () => {
    // 1201 在 60 分钟才退房；没写的房间是不知道摘牌的请勿打扰房。三个局面都没房可做。
    const world = controlledWorld({ 1201: departure({ availableFrom: 60 }) });
    // 5 分钟的局面，上一个动作是等待：打电话。新手要是自己记着"这通电话 7 分钟打完"，下面两问就会答错。
    expect(decide(world, waitUntil(world, initial(world), 5))).toStrictEqual(act.call());
    // 另一个 7 分钟的局面，上一个动作也是等待，不是打电话：照样打。
    expect(decide(world, waitUntil(world, initial(world), 7))).toStrictEqual(act.call());
    // 这通电话是驱动的人替它打的，不是新手选的；打完是 22 分钟，上一个动作是打电话：先等一次。
    const called = play(world, waitUntil(world, initial(world), 20), act.call());
    expect(called.minute).toBe(22);
    expect(decide(world, called)).toStrictEqual(act.wait(5));
  });

  it('打电话问不出新消息就不打：退房房都标记了，没有请勿打扰房，只剩要等回来时间的续住房，原地等，到达不早于回来时间就提前出发', () => {
    // 1203 的客人 100 分钟才出门，回来时间是 105。
    const world = controlledWorld(
      { 1201: departure(), 1202: departure(), 1203: stayover({ availableFrom: 100 }), 1204: stayover() },
      { params: SMALL },
    );
    // 打电话（2）；1203 被拒（走 2 分钟，敲门 1 分钟，到 5）；做完 1204（20）、1201（走 1 分钟，51）、1202（81），人在门位 1。
    const state = play(
      world,
      initial(world),
      act.call(),
      act.service(1203),
      act.service(1204),
      act.service(1201),
      act.service(1202),
    );
    expect(progress(state, 1203).knownAvailableFrom).toBe(105);
    expect(state.minute).toBe(81);
    expect(state.place).toStrictEqual({ floor: 12, door: 1 });
    // 打电话合法，但问不出任何新消息，新手不打；还没休息，不能收工；等列出的那一档。
    expect(legalActions(world, state)).toContainEqual(act.call());
    expect(decide(world, state)).toStrictEqual(act.wait(5));
    // 去 1203 要走 1 分钟：103 出发 104 到，还早；104 出发正好 105 到，可以去了。
    expect(decide(world, waitUntil(world, state, 103))).toStrictEqual(act.wait(5));
    expect(decide(world, waitUntil(world, state, 104))).toStrictEqual(act.service(1203));
  });

  it('房间都做完、还没到 12:30：还没休息不能收工，问不出新消息也不打电话，原地等；到 12:30 去休息，休息完收工', () => {
    const world = controlledWorld(
      { 1201: departure(), 1202: departure(), 1203: stayover(), 1204: stayover() },
      { params: SMALL },
    );
    const done = play(
      world,
      initial(world),
      act.call(),
      act.service(1201),
      act.service(1202),
      act.service(1203),
      act.service(1204),
    );
    expect(done.rooms.every((room) => room.doneAt !== null)).toBe(true);
    expect(done.minute).toBeLessThan(240);
    expect(decide(world, done)).toStrictEqual(act.wait(5));
    const noon = waitUntil(world, done, 240);
    expect(decide(world, noon)).toStrictEqual(act.break());
    expect(decide(world, play(world, noon, act.break()))).toStrictEqual(act.finish());
  });

  it('休息过、房间都做完，还有不知道摘牌的请勿打扰房：收工前先打一次电话，问不出摘牌再收工', () => {
    const world = controlledWorld({ 1201: stayover() });
    let state = waitUntil(world, initial(world), 120);
    state = play(world, state, act.break(), act.service(1201));
    // 已经能收工了，但没写的房间是不知道摘牌的请勿打扰房，先打电话。
    expect(legalActions(world, state)).toContainEqual(act.finish());
    expect(decide(world, state)).toStrictEqual(act.call());
    const called = play(world, state, act.call());
    expect(decide(world, called)).toStrictEqual(act.finish());
  });

  it('收工前那通电话问出了摘牌：先去做这间请勿打扰房，不收工', () => {
    const world = controlledWorld({ 1201: stayover(), 1305: dnd({ dndLiftsAt: 150 }) });
    let state = waitUntil(world, initial(world), 120);
    state = play(world, state, act.break(), act.service(1201));
    expect(decide(world, state)).toStrictEqual(act.call());
    const called = play(world, state, act.call());
    expect(last(called).outcome).toStrictEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1305] });
    expect(decide(world, called)).toStrictEqual(act.service(1305));
  });
});

describe('新手：休息', () => {
  it('还没休息，到了 12:30（240）就去休息，手上有能做的房间也先休息；12:29（239）还不去', () => {
    const world = controlledWorld({ 1201: stayover() });
    const before = waitUntil(world, initial(world), 239);
    expect(decide(world, before)).toStrictEqual(act.service(1201));
    expect(decide(world, waitUntil(world, before, 240))).toStrictEqual(act.break());
  });

  it('ODD_PARAMS：休息时刻从 params.novice.breakAt 读，是 200，不是写死的 240，也不是休息窗口的两端 100、300', () => {
    expect(ODD_PARAMS.novice.breakAt).toBe(200);
    const world = controlledWorld({ 501: stayover() }, { params: ODD_PARAMS });
    // 100 到 199 之间就能休息（10:30 以后），但还没到新手的休息时刻，先去做房间。
    const at100 = waitUntil(world, initial(world), 100);
    expect(legalActions(world, at100)).toContainEqual(act.break());
    expect(decide(world, at100)).toStrictEqual(act.service(501));
    const at199 = waitUntil(world, at100, 199);
    expect(decide(world, at199)).toStrictEqual(act.service(501));
    expect(decide(world, waitUntil(world, at199, 200))).toStrictEqual(act.break());
  });

  it('14:30 起还没休息：只能休息，新手就去休息', () => {
    const world = controlledWorld({ 1201: stayover() });
    const state = waitUntil(world, initial(world), 360);
    expect(legalActions(world, state)).toStrictEqual([act.break()]);
    expect(decide(world, state)).toStrictEqual(act.break());
  });
});

describe('新手：17:00 和班次结束', () => {
  it('17:00 起只能还车：新手收工还车，房间没做完、没休息也一样', () => {
    const world = controlledWorld({ 1201: stayover() });
    // 一直等到 17:00：14:30 起只能休息，先在 14:30 休息（到 390），再等。
    let state = waitUntil(world, initial(world), 360);
    state = waitUntil(world, play(world, state, act.break()), 510);
    expect(decide(world, state)).toStrictEqual(act.finish());
  });

  it('打扫被 17:00 截断以后：只能还车，新手收工还车', () => {
    // 1201 是灾难档的退房房，要 48 分钟：470 出发，471 进门，做到 17:00 截断。
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }) });
    let state = waitUntil(world, initial(world), 120);
    state = play(world, state, act.break(), act.call());
    state = play(world, waitUntil(world, state, 470), act.service(1201));
    expect(last(state).outcome).toStrictEqual({ type: 'interrupted', room: 1201, workDone: 39, reason: 'hardStop' });
    expect(decide(world, state)).toStrictEqual(act.finish());
  });

  it('17:00 起没休息也只能还车：自定义参数把"只能休息"推到 17:00 以后（三档不会这样），新手照样收工还车，不去休息', () => {
    const lateBreak: Params = { ...PARAMS.standard, shift: { ...PARAMS.standard.shift, breakLatest: 600 } };
    const world = controlledWorld({ 1201: stayover() }, { params: lateBreak });
    const state = waitUntil(world, initial(world), 510);
    expect(state.breakTaken).toBe(false);
    expect(legalActions(world, state)).toStrictEqual([act.finish()]);
    expect(decide(world, state)).toStrictEqual(act.finish());
  });

  it('班次结束以后没有合法动作，调用新手抛出中文报错，说明班次已经结束', () => {
    const world = controlledWorld({});
    let state = waitUntil(world, initial(world), 360);
    state = waitUntil(world, play(world, state, act.break()), 510);
    const ended = play(world, state, act.finish());
    expect(ended.ended).toBe('hardStop');
    const message = errorOf(() => decide(world, ended));
    expect(message).toMatch(CHINESE);
    expect(message).toMatch('班次已经结束');
  });
});
