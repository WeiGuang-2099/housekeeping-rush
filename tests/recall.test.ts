/**
 * recall 的单元测试。性质测试见 recall.property.test.ts。
 *
 * recall 从 View 的日志推出两样事实：最近一次打电话的挂断时刻（lastCallAt），以及每间还不知道摘牌的请勿打扰房最近一次
 * 确认仍挂牌的时刻（stillHung 的 confirmedAt：电话的挂断时刻，或者路过、停留在它门位的那一分钟，取最晚的）。
 * 受控世界里没写到的房间都是整班不摘牌的请勿打扰房，玩家永远不知道它们摘牌，所以它们都在 stillHung 里，
 * 正好用来看每个门位最近一次被看到是哪一刻。起始状态一律由 initial 加一串合法动作推出来。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0，没有房间。同层每个门位 1 分钟，跨层先走到门位 0，乘电梯 4 分钟。
 * 续住房打扫 15 分钟（普通），敲门被拒 1 分钟，打电话 2 分钟，等待每次最多 5 分钟。510 是 17:00。
 */

import { describe, expect, it } from 'vitest';
import { recall as recallFromIndex } from '../src/engine';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { recall } from '../src/engine/recall';
import { initial } from '../src/engine/rules';
import type { HungDnd, Minute, Recall, RoomId, State, World } from '../src/engine/types';
import { act, errorOf, last, play, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze, objectsIn } from './helpers/play';
import { controlledWorld, dnd, stayover } from './helpers/world';

/** 中文字符，用来确认报错消息是中文。 */
const CHINESE = /[一-鿿]/;

/** 这一刻的 recall：先 observe，再交给 recall，参数是 world.params。 */
function recallAt(world: World, state: State): Recall {
  return recall(observe(world, state), world.params);
}

/**
 * 预期的 stillHung：world 里的请勿打扰房去掉 lifted 里的（已经得知摘牌），按 world.rooms 的顺序；
 * confirmedAt 取 confirmed 里写的，没写的是 null。confirmed 里写了不在名单里的房间就抛错，免得写错房号还照样通过。
 */
function hung(world: World, confirmed: Record<RoomId, Minute>, lifted: readonly RoomId[] = []): HungDnd[] {
  const list = world.rooms
    .filter((room) => room.kind === 'dnd' && !lifted.includes(room.id))
    .map((room): HungDnd => ({ room: room.id, confirmedAt: confirmed[room.id] ?? null }));
  for (const key of Object.keys(confirmed)) {
    if (!list.some((item) => item.room === Number(key))) throw new Error(`预期里的 ${key} 不是还不知道摘牌的请勿打扰房`);
  }
  return list;
}

/** 每间都写同一个时刻。 */
function allAt(world: World, minute: Minute, lifted: readonly RoomId[] = []): Record<RoomId, Minute> {
  return Object.fromEntries(hung(world, {}, lifted).map((item) => [item.room, minute]));
}

describe('对外入口', () => {
  it('能从 src/engine/index.ts 导入 recall，是同一个函数', () => {
    expect(recallFromIndex).toBe(recall);
  });
});

describe('开工时', () => {
  it('没打过电话，lastCallAt 为 null；每间请勿打扰房都在 stillHung 里，按 world.rooms 的顺序，都还没确认过', () => {
    const world = controlledWorld({ 1207: stayover() });
    const result = recallAt(world, initial(world));
    expect(result).toStrictEqual({ lastCallAt: null, stillHung: hung(world, {}) });
    // 受控世界里除了 1207 都是请勿打扰房。
    expect(result.stillHung).toHaveLength(14);
  });
});

describe('门位观察', () => {
  it('路过：步行途中到达每个门位的那一分钟；停留：到门口和打扫完的那一分钟，取晚的；回服务间补货的路上也算', () => {
    const world = controlledWorld({ 1207: stayover() });
    // 0 从服务间出发去 1207：1 到门位 1，2 到门位 2，3 到门位 3，4 到门位 4（门口），打扫 15 分钟，19 做完。
    let state = play(world, initial(world), act.service(1207));
    expect(last(state)).toMatchObject({ start: 0, end: 19, walk: 4 });
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: null,
      stillHung: hung(world, { 1201: 1, 1202: 1, 1203: 2, 1204: 2, 1205: 3, 1206: 3, 1208: 19 }),
    });

    // 19 回服务间补货：20 到门位 3，21 到门位 2，22 到门位 1，23 到服务间，补货 5 分钟，28 做完。
    state = play(world, state, act.restock());
    expect(last(state)).toMatchObject({ start: 19, end: 28 });
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: null,
      stillHung: hung(world, { 1201: 22, 1202: 22, 1203: 21, 1204: 21, 1205: 20, 1206: 20, 1208: 19 }),
    });
  });

  it('跨层：先在本层走到门位 0，乘电梯，再从目标层的门位 0 走过去；没走过的门位还是 null', () => {
    const world = controlledWorld({ 1205: stayover(), 1303: stayover() });
    // 0 去 1205：门位 1、2、3 在 1、2、3，打扫到 18。
    // 18 去 1303：19 到 12 楼门位 2，20 到门位 1，21 到门位 0，乘电梯 4 分钟，25 到 13 楼门位 0，26 到门位 1，
    // 27 到门位 2（门口），打扫到 42。
    const state = play(world, initial(world), act.service(1205), act.service(1303));
    expect(last(state)).toMatchObject({ start: 18, end: 42, walk: 9 });
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: null,
      stillHung: hung(world, { 1201: 20, 1202: 20, 1203: 19, 1204: 19, 1206: 18, 1301: 26, 1302: 26, 1304: 42 }),
    });
  });

  it('ODD_PARAMS：每个门位 2 分钟，电梯 3 分钟，续住房打扫 25 分钟，打电话 3 分钟，都从参数读', () => {
    // 3 楼 301 到 306 在门位 1 到 3，5 楼 501 到 510 在门位 1 到 5，服务间是 5 楼门位 0。
    const world = controlledWorld({ 505: stayover(), 303: stayover() }, { params: ODD_PARAMS });
    // 0 去 505：门位 1、2、3 在 2、4、6，打扫到 31。
    // 31 去 303：33 到 5 楼门位 2，35 到门位 1，37 到门位 0，乘电梯 3 分钟，40 到 3 楼门位 0，42 到门位 1，
    // 44 到门位 2（门口），打扫到 69。
    let state = play(world, initial(world), act.service(505), act.service(303));
    expect(last(state)).toMatchObject({ start: 31, end: 69, walk: 13 });
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: null,
      stillHung: hung(world, { 501: 35, 502: 35, 503: 33, 504: 33, 506: 31, 301: 42, 302: 42, 304: 69 }),
    });

    // 69 打电话，72 挂断：每间还不知道摘牌的请勿打扰房都确认到 72。
    state = play(world, state, act.call());
    expect(recallAt(world, state)).toStrictEqual({ lastCallAt: 72, stillHung: hung(world, allAt(world, 72)) });
  });

  it('停留：敲门被拒是到门口和被拒以后那一分钟，原地等待是等完的那一分钟；电话以后再路过，取晚的', () => {
    const world = controlledWorld({ 1205: stayover({ availableFrom: 100 }), 1207: stayover() });
    // 0 去 1205：3 到门口，客人还在，敲门被拒，4 结束。
    let state = play(world, initial(world), act.service(1205));
    expect(last(state)).toMatchObject({ end: 4, outcome: { type: 'knockRefused', room: 1205 } });
    expect(recallAt(world, state).stillHung).toStrictEqual(
      hung(world, { 1201: 1, 1202: 1, 1203: 2, 1204: 2, 1206: 4 }),
    );

    // 在门位 3 等 5 分钟，9 结束。
    state = play(world, state, act.wait(5));
    expect(recallAt(world, state).stillHung).toStrictEqual(
      hung(world, { 1201: 1, 1202: 1, 1203: 2, 1204: 2, 1206: 9 }),
    );

    // 9 打电话，11 挂断：每间都确认到 11，包括没路过的 13 楼。
    state = play(world, state, act.call());
    expect(recallAt(world, state)).toStrictEqual({ lastCallAt: 11, stillHung: hung(world, allAt(world, 11)) });

    // 11 去 1207：12 到门位 4（门口），打扫到 27。门位 4 的 1208 确认到 27，别的还是电话的 11。
    state = play(world, state, act.service(1207));
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: 11,
      stillHung: hung(world, { ...allAt(world, 11), 1208: 27 }),
    });
  });

  it('17:00 截断的打扫是 17:00 那一分钟；17:00 后还车的路上照样算，班次结束后照样能推', () => {
    const world = controlledWorld({ 1203: stayover() });
    // 在服务间（门位 0，没有房间）等到 10:30，休息到 150，再等到 495：一个门位也没看过。
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    state = waitUntil(world, state, 495);
    expect(recallAt(world, state)).toStrictEqual({ lastCallAt: null, stillHung: hung(world, {}) });

    // 495 去 1203：496 到门位 1，497 到门口，打扫要到 512，在 510 截断。
    state = play(world, state, act.service(1203));
    expect(last(state)).toMatchObject({ end: 510, outcome: { type: 'interrupted', room: 1203 } });
    expect(recallAt(world, state).stillHung).toStrictEqual(hung(world, { 1201: 496, 1202: 496, 1204: 510 }));

    // 510 还车：511 到门位 1，512 到服务间，还车到 517，班次结束。
    state = play(world, state, act.finish());
    expect(state.ended).toBe('hardStop');
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: null,
      stillHung: hung(world, { 1201: 511, 1202: 511, 1204: 510 }),
    });
  });
});

describe('电话', () => {
  it('lastCallAt 是最后一通电话的挂断时刻；电话得知摘牌的、路过得知摘牌的都不再列出；电话以后路过的取路过的时刻', () => {
    const world = controlledWorld({
      // 12 楼门位 2：1203 在 100 摘牌。门位 3：1205 在 103 摘牌。
      1203: dnd({ dndLiftsAt: 100 }),
      1205: dnd({ dndLiftsAt: 103 }),
      1207: stayover(),
    });
    // 在服务间等到 100，打电话，102 挂断：1203 已摘牌，得知；1205 还挂着牌。
    let state = play(world, waitUntil(world, initial(world), 100), act.call());
    expect(last(state).outcome).toStrictEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1203] });
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: 102,
      stillHung: hung(world, allAt(world, 102, [1203]), [1203]),
    });

    // 102 去 1207：103 到门位 1，104 到门位 2，105 到门位 3，看到 1205 已摘牌，106 到门口，打扫到 121。
    state = play(world, state, act.service(1207));
    expect(last(state).noticedLifted).toStrictEqual([1205]);
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: 102,
      stillHung: hung(
        world,
        { ...allAt(world, 102, [1203, 1205]), 1201: 103, 1202: 103, 1204: 104, 1206: 105, 1208: 121 },
        [1203, 1205],
      ),
    });

    // 121 再打一次，123 挂断：lastCallAt 换成后一通的 123，每间都确认到 123。
    state = play(world, state, act.call());
    expect(recallAt(world, state)).toStrictEqual({
      lastCallAt: 123,
      stillHung: hung(world, allAt(world, 123, [1203, 1205]), [1203, 1205]),
    });
  });
});

describe('纯函数', () => {
  it('深度冻结的 View 也能用，不修改 View；两次调用结果相同，但每次都新建对象，不和 View 共用；键的顺序固定', () => {
    const world = controlledWorld({ 1205: stayover(), 1303: stayover() });
    const state = play(world, initial(world), act.service(1205), act.call(), act.service(1303));
    const view = deepFreeze(observe(world, state));
    const json = JSON.stringify(view);
    const first = recall(view, world.params);
    const second = recall(view, world.params);
    expect(JSON.stringify(view)).toBe(json);
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    expect(second.stillHung).not.toBe(first.stillHung);
    first.stillHung.forEach((item, index) => expect(second.stillHung[index]).not.toBe(item));
    const viewObjects = objectsIn(view);
    expect([...objectsIn(first)].filter((node) => viewObjects.has(node))).toEqual([]);
    expect(Object.keys(first)).toEqual(['lastCallAt', 'stillHung']);
    expect(first.stillHung.length).toBeGreaterThan(0);
    for (const item of first.stillHung) expect(Object.keys(item)).toEqual(['room', 'confirmedAt']);
  });
});

describe('参数的楼层和 View 的房间对不上', () => {
  /** 标准档，只把 12 楼同在门位 2 的 1203、1204 对调：房间相同、数量相同，只是顺序不同。 */
  const SWAPPED: Params = {
    ...PARAMS.standard,
    layout: {
      ...PARAMS.standard.layout,
      floors: [
        { floor: 12, rooms: [1201, 1202, 1204, 1203, 1205, 1206, 1207, 1208] },
        { floor: 13, rooms: [1301, 1302, 1303, 1304, 1305, 1306, 1307] },
      ],
    },
  };

  it('房间不同（标准档的 View 配 ODD_PARAMS），或者房间相同但顺序不同，都抛出中文报错', () => {
    const world = controlledWorld({ 1207: stayover() });
    const view = observe(world, play(world, initial(world), act.service(1207)));
    for (const params of [ODD_PARAMS, SWAPPED]) {
      const message = errorOf(() => recall(view, params));
      expect(message).toMatch(CHINESE);
      expect(message).toContain('对不上');
    }
  });
});
