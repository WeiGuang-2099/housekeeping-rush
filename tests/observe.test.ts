/**
 * observe 和 legalActionsForView 的单元测试。性质测试见 observe.property.test.ts。
 *
 * View 是玩家和只看 View 的策略能看到的全部：任务单上的公开信息，加上 State 里玩家已经得知的进度。
 * 脏乱档位和房间描述开过门（messRevealed）才显示，包括被 17:00 截断的房间；敲门被拒没开门，不显示。
 * 起始状态一律由 initial 加一串合法动作推出来，只有"待回应的事件"那个用例手工拼 State（理由写在那里）。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0。同层每个门位 1 分钟，跨层先走到门位 0，乘电梯 4 分钟。
 * 打扫分钟：退房房 30，续住房和请勿打扰房 15，乘脏乱系数 0.8、1.0、1.6。敲门被拒花 1 分钟，回来时间按 15 分钟向上取整。
 * 时刻从 08:30 起算：120 是 10:30，360 是 14:30，510 是 17:00。
 */

import { describe, expect, it } from 'vitest';
import { legalActionsForView as legalActionsForViewFromIndex, observe as observeFromIndex } from '../src/engine';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { initial, legalActions, legalActionsForView } from '../src/engine/rules';
import type {
  Action,
  Clue,
  Minute,
  Place,
  RoomId,
  RoomKind,
  RoomProgress,
  RoomTruth,
  RoomView,
  State,
  View,
  World,
} from '../src/engine/types';
import { act, errorOf, last, play, progress, serviceTargets, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { at, deepFreeze } from './helpers/play';
import { PLACE_KEYS, ROOM_VIEW_KEYS, VIEW_KEYS } from './helpers/view';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

/** 中文字符，用来确认报错消息是中文。 */
const CHINESE = /[一-鿿]/;

/** 标准档的两层倒过来列：13 楼在前，world.rooms 以 1301 开头。几何不变，服务间仍是 12 楼门位 0。 */
const REVERSED: Params = {
  ...PARAMS.standard,
  layout: { ...PARAMS.standard.layout, floors: [...PARAMS.standard.layout.floors].reverse() },
};

/**
 * 只有标准档的 12 楼：world.rooms 是 1201 到 1208，正好是标准档 world.rooms 的前 8 间，只是少了 13 楼的 7 间。
 * 房型数量按 8 间改（generate 要求合计等于房间数），2 个贵宾时限不多于 3 间退房房。
 */
const FLOOR_12_ONLY: Params = {
  ...PARAMS.standard,
  layout: { ...PARAMS.standard.layout, floors: PARAMS.standard.layout.floors.slice(0, 1) },
  mix: { departures: 3, stayovers: 3, dnd: 2 },
};

/**
 * 标准档，只把 12 楼同在门位 2 的 1203、1204 对调：几何不变，房间数（15 间）、第一间（1201）、最后一间（1307）
 * 都和标准档相同，只有下标 2、3 上的房号不同。只比数量、第一间或最后一间的检查都看不出它和标准档对不上。
 */
const SWAPPED_12: Params = {
  ...PARAMS.standard,
  layout: {
    ...PARAMS.standard.layout,
    floors: PARAMS.standard.layout.floors.map((plan) =>
      plan.floor === 12 ? { ...plan, rooms: [1201, 1202, 1204, 1203, 1205, 1206, 1207, 1208] } : plan,
    ),
  },
};

/**
 * 开工时一间房在 View 里的样子：房号、位置、房型、线索、延迟退房、贵宾时限照抄任务单；
 * 进度都是初值，没开过门（脏乱、描述为 null），没得知摘牌。
 */
function fresh(
  id: RoomId,
  floor: number,
  door: number,
  kind: RoomKind,
  clue: Clue,
  task: { lateCheckout?: boolean; vipDeadline?: Minute | null } = {},
): RoomView {
  return {
    id,
    place: { floor, door },
    kind,
    clue,
    lateCheckout: task.lateCheckout ?? false,
    vipDeadline: task.vipDeadline ?? null,
    rushDeadline: null,
    doneAt: null,
    workDone: 0,
    flaggedDeparted: false,
    knownAvailableFrom: null,
    mess: null,
    dndLifted: false,
    descriptionId: null,
  };
}

/** 按任务单（RoomTruth 的公开字段）写出的开工时的 RoomView。 */
function freshFromTask(truth: RoomTruth): RoomView {
  return fresh(truth.id, truth.place.floor, truth.place.door, truth.kind, truth.clue, {
    lateCheckout: truth.lateCheckout,
    vipDeadline: truth.vipDeadline,
  });
}

/** View 里的某间房。 */
function roomOf(view: View, id: RoomId): RoomView {
  const found = view.rooms.find((room) => room.id === id);
  if (found === undefined) throw new Error(`View 里没有房间 ${id}`);
  return found;
}

/** View 里一间房的进度字段。 */
function progressInView(room: RoomView): Record<string, unknown> {
  return {
    id: room.id,
    rushDeadline: room.rushDeadline,
    doneAt: room.doneAt,
    workDone: room.workDone,
    flaggedDeparted: room.flaggedDeparted,
    knownAvailableFrom: room.knownAvailableFrom,
    dndLifted: room.dndLifted,
  };
}

/** State 里同一间房的进度字段，名字换成 View 里的。 */
function progressInState(room: RoomProgress): Record<string, unknown> {
  return {
    id: room.id,
    rushDeadline: room.rushDeadline,
    doneAt: room.doneAt,
    workDone: room.workDone,
    flaggedDeparted: room.flaggedDeparted,
    knownAvailableFrom: room.knownAvailableFrom,
    dndLifted: room.dndLiftKnown,
  };
}

describe('对外入口', () => {
  it('能从 src/engine/index.ts 导入 observe 和 legalActionsForView', () => {
    expect(observeFromIndex).toBe(observe);
    expect(legalActionsForViewFromIndex).toBe(legalActionsForView);
    expect(typeof observeFromIndex).toBe('function');
    expect(typeof legalActionsForViewFromIndex).toBe('function');
  });
});

describe('开工时的 View', () => {
  const cases: [string, Params, Place, number][] = [
    // 三档的服务间都是 12 楼门位 0；布草车容量标准档 8 份，紧档和周末档 6 份。
    ['标准档', PARAMS.standard, { floor: 12, door: 0 }, 8],
    ['紧档', PARAMS.tight, { floor: 12, door: 0 }, 6],
    ['周末档', PARAMS.weekend, { floor: 12, door: 0 }, 6],
    // ODD_PARAMS 的服务间是 5 楼门位 0，容量 7 份。
    ['ODD_PARAMS', ODD_PARAMS, { floor: 5, door: 0 }, 7],
  ];

  it.each(cases)('%s：整个 View 等于按任务单和初值写出的对象', (_label, params, servicePoint, capacity) => {
    for (const seed of ['view-0', 'view-1', 'view-2']) {
      const world = generate(seed, params);
      // 生成的世界里每间房都有脏乱档位，也都有贵宾房：下面的 mess 为 null、rushDeadline 为 null 不是碰巧。
      expect(world.rooms.some((room) => room.vipDeadline !== null)).toBe(true);
      expect(observe(world, initial(world))).toStrictEqual({
        // 开工是第 0 分钟，人和满载的布草车在服务间，还没休息。
        minute: 0,
        place: servicePoint,
        cart: capacity,
        breakTaken: false,
        // 按 world.rooms 的顺序；公开字段照抄任务单，其余是初值。
        rooms: world.rooms.map(freshFromTask),
        prompt: null,
        violation: false,
        ended: null,
        log: [],
      });
    }
  });

  it('受控世界：逐间写出预期；隐藏的脏乱、描述、退房时刻、出门时刻、摘牌时刻都不出现', () => {
    const world = controlledWorld({
      // 贵宾房（13:00），住三晚以上，灾难级，有房间描述。
      1201: departure({ clue: 'threeNightsPlus', mess: 'disaster', vipDeadline: 270, descriptionId: 'desc-1201' }),
      // 延迟退房，12:00（210）退房。
      1203: departure({ availableFrom: 210, lateCheckout: true }),
      // 家庭客人 100 出门，整洁，有房间描述。
      1205: stayover({ clue: 'family', mess: 'tidy', availableFrom: 100, descriptionId: 'desc-1205' }),
      // 请勿打扰，长住客人，150 摘牌。
      1301: dnd({ clue: 'longStay', dndLiftsAt: 150 }),
    });
    expect(observe(world, initial(world))).toStrictEqual({
      minute: 0,
      place: { floor: 12, door: 0 },
      cart: 8,
      breakTaken: false,
      // 没写到的房间是整班不摘牌的请勿打扰房，线索是商务（tests/helpers/world.ts）。
      // 第 k 间（从 0 数）在门位 floor(k / 2) + 1。贵宾时限照抄，催房时限是进度，开工时为 null。
      rooms: [
        fresh(1201, 12, 1, 'departure', 'threeNightsPlus', { vipDeadline: 270 }),
        fresh(1202, 12, 1, 'dnd', 'business'),
        fresh(1203, 12, 2, 'departure', 'oneNight', { lateCheckout: true }),
        fresh(1204, 12, 2, 'dnd', 'business'),
        fresh(1205, 12, 3, 'stayover', 'family'),
        fresh(1206, 12, 3, 'dnd', 'business'),
        fresh(1207, 12, 4, 'dnd', 'business'),
        fresh(1208, 12, 4, 'dnd', 'business'),
        fresh(1301, 13, 1, 'dnd', 'longStay'),
        fresh(1302, 13, 1, 'dnd', 'business'),
        fresh(1303, 13, 2, 'dnd', 'business'),
        fresh(1304, 13, 2, 'dnd', 'business'),
        fresh(1305, 13, 3, 'dnd', 'business'),
        fresh(1306, 13, 3, 'dnd', 'business'),
        fresh(1307, 13, 4, 'dnd', 'business'),
      ],
      prompt: null,
      violation: false,
      ended: null,
      log: [],
    });
  });
});

describe('View 的键和顺序', () => {
  it('View 恰好 9 个键，每个 RoomView 恰好 14 个键，位置是 floor、door，都按类型里的字段顺序；开工、开门以后、班次结束后都一样', () => {
    const world = controlledWorld({ 1201: stayover({ descriptionId: 'desc-1201' }) });
    const start = initial(world);
    // 去 1201：走 1 分钟，1 到门口，打扫 15 分钟，16 做完，开过门。
    const opened = play(world, start, act.service(1201));
    // 在门口等到 119 去休息：120 到服务间，休息到 150；收工：步行 0，还车 5 分钟，155 结束。
    const ended = play(world, waitUntil(world, opened, 119), act.break(), act.finish());
    expect(ended.ended).toBe('returned');
    for (const state of [start, opened, ended]) {
      const view = observe(world, state);
      expect(Object.keys(view), `${state.minute} 分钟的 View`).toEqual(VIEW_KEYS);
      expect(Object.keys(view.place)).toEqual(PLACE_KEYS);
      for (const room of view.rooms) {
        expect(Object.keys(room), `${state.minute} 分钟的 ${room.id}`).toEqual(ROOM_VIEW_KEYS);
        expect(Object.keys(room.place), `${state.minute} 分钟的 ${room.id}`).toEqual(PLACE_KEYS);
      }
    }
  });

  it('房间按 world.rooms 的顺序，不按房号：楼层倒过来列时 13 楼在前，同样倒过来的参数能照常判定合法动作', () => {
    // 1201、1301 都是客人开工前已出门的续住房。
    const world = controlledWorld({ 1201: stayover(), 1301: stayover() }, { params: REVERSED });
    const state = initial(world);
    const view = observe(world, state);
    expect(view.rooms.map((room) => room.id)).toEqual([
      1301, 1302, 1303, 1304, 1305, 1306, 1307, 1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208,
    ]);
    // 房间和 allRooms(REVERSED) 逐个相同，不抛错。开工时两间续住房都能打扫（1301 第 5 分钟、1201 第 1 分钟到门口），
    // 按 world.rooms 的顺序 1301 在前。
    expect(legalActionsForView(view, REVERSED)).toStrictEqual(legalActions(world, state));
    expect(serviceTargets(legalActionsForView(view, REVERSED))).toEqual([1301, 1201]);
  });
});

describe('脏乱和房间描述的揭晓', () => {
  it('开门前为 null，敲门被拒以后仍为 null，打扫完成后等于真值；真值没有描述的房间开门后描述仍为 null', () => {
    const world = controlledWorld({
      // 长住客人 200 才出门，灾难级，有房间描述。
      1203: stayover({ clue: 'longStay', availableFrom: 200, mess: 'disaster', descriptionId: 'desc-1203' }),
      // 客人开工前已出门，整洁，没写描述（生成的值是 null）。
      1201: stayover({ mess: 'tidy' }),
    });
    let state = initial(world);
    expect(roomOf(observe(world, state), 1203)).toStrictEqual(fresh(1203, 12, 2, 'stayover', 'longStay'));

    // 去 1203：走 2 分钟，2 到门口，2 < 200，客人还在，敲门被拒，3 结束；回来时间 ceil(200 / 15) × 15 = 14 × 15 = 210。
    state = play(world, state, act.service(1203));
    expect(last(state).outcome).toEqual({ type: 'knockRefused', room: 1203, comeBackAt: 210 });
    // 没开门：脏乱和描述仍为 null，只多了回来时间。
    expect(roomOf(observe(world, state), 1203)).toStrictEqual({
      ...fresh(1203, 12, 2, 'stayover', 'longStay'),
      knownAvailableFrom: 210,
    });

    // 在门口等到 210 再去：步行 0，210 >= 200，进门，打扫 15 × 1.6 = 24 分钟，234 做完。
    state = play(world, waitUntil(world, state, 210), act.service(1203));
    expect(last(state).outcome).toEqual({ type: 'cleaned', room: 1203, minutes: 24 });
    expect(roomOf(observe(world, state), 1203)).toStrictEqual({
      ...fresh(1203, 12, 2, 'stayover', 'longStay'),
      doneAt: 234,
      workDone: 24,
      knownAvailableFrom: 210,
      mess: 'disaster',
      descriptionId: 'desc-1203',
    });

    // 234 去 1201：走 1 分钟，235 到门口，打扫 15 × 0.8 = 12 分钟，247 做完。真值没有描述，所以仍为 null。
    state = play(world, state, act.service(1201));
    expect(roomOf(observe(world, state), 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'stayover', 'business'),
      doneAt: 247,
      workDone: 12,
      mess: 'tidy',
    });
  });

  it('标记了但没开过门的退房房不显示；被 17:00 截断的房间（做了一部分、没完成）显示真值', () => {
    const world = controlledWorld({ 1201: departure({ mess: 'disaster', descriptionId: 'desc-1201' }) });
    // 开工打电话，挂断时刻 2，1201（开工前已退房，-30 <= 2）标为已退。在服务间等到 120 休息到 150，再等到 500。
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, 120), act.break());
    state = waitUntil(world, state, 500);
    expect(roomOf(observe(world, state), 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'departure', 'oneNight'),
      flaggedDeparted: true,
    });

    // 500 出发：走 1 分钟，501 到门口（501 + 1 <= 510，合法），开门；要打扫 30 × 1.6 = 48 分钟，
    // 501 + 48 = 549 > 510，在 510 截断，做了 510 - 501 = 9 分钟，没完成。
    state = play(world, state, act.service(1201));
    expect(last(state).outcome).toEqual({ type: 'interrupted', room: 1201, workDone: 9, reason: 'hardStop' });
    expect(roomOf(observe(world, state), 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'departure', 'oneNight'),
      doneAt: null,
      workDone: 9,
      flaggedDeparted: true,
      mess: 'disaster',
      descriptionId: 'desc-1201',
    });
  });

  it('13 楼的请勿打扰房：电话得知摘牌后开门打扫，做完后显示脏乱和描述的真值', () => {
    // 第 0 分钟摘牌，客人开工前已出门，灾难级，有房间描述。
    const world = controlledWorld({ 1301: dnd({ dndLiftsAt: 0, mess: 'disaster', descriptionId: 'desc-1301' }) });
    // 开工打电话，挂断时刻 2，得知 1301 已摘牌（0 <= 2）。还没开门：脏乱和描述仍为 null。
    let state = play(world, initial(world), act.call());
    expect(roomOf(observe(world, state), 1301)).toStrictEqual({
      ...fresh(1301, 13, 1, 'dnd', 'business'),
      dndLifted: true,
    });

    // 2 去 1301：服务间就在 12 楼门位 0，乘电梯 4 分钟，13 楼走 1 个门位 1 分钟，2 + 4 + 1 = 7 到门口；
    // 客人不在，进门，打扫 15 × 1.6 = 24 分钟（请勿打扰房按续住房算），7 + 24 = 31 做完。
    state = play(world, state, act.service(1301));
    expect(state.minute).toBe(31);
    expect(roomOf(observe(world, state), 1301)).toStrictEqual({
      ...fresh(1301, 13, 1, 'dnd', 'business'),
      doneAt: 31,
      workDone: 24,
      dndLifted: true,
      mess: 'disaster',
      descriptionId: 'desc-1301',
    });
  });
});

describe('摘牌', () => {
  it('没得知时为 false（真值已经摘牌也一样）；路过门位看到以后为 true；打电话得知以后为 true；整班不摘牌的永远为 false', () => {
    const world = controlledWorld({
      // 12 楼门位 2：1203 在 100 摘牌，1204 在 153 摘牌。
      1203: dnd({ dndLiftsAt: 100 }),
      1204: dnd({ dndLiftsAt: 153 }),
      // 12 楼门位 3，整班不摘牌。
      1205: dnd(),
      // 12 楼门位 4，客人开工前已出门。
      1207: stayover(),
      // 13 楼门位 1，160 摘牌。
      1301: dnd({ dndLiftsAt: 160 }),
    });
    /** View 里 dndLifted 为 true 的房间。 */
    const lifted = (state: State): RoomId[] =>
      observe(world, state)
        .rooms.filter((room) => room.dndLifted)
        .map((room) => room.id);

    let state = initial(world);
    expect(lifted(state)).toEqual([]);
    // 在服务间（门位 0，没有房间）等到 150：1203 在 100 就摘了牌，但玩家没看到，也没打电话。
    state = waitUntil(world, state, 150);
    expect(lifted(state)).toEqual([]);

    // 150 出发去 1207：151 经过门位 1，152 经过门位 2，看到 1203（100 <= 152）；1204 要到 153 才摘，看不到。
    // 153 经过门位 3（1205 不摘），154 到门口，打扫 15 分钟，169 做完；门位 4 的另一间 1208 不摘。
    state = play(world, state, act.service(1207));
    expect(last(state).noticedLifted).toEqual([1203]);
    // 1204（153）和 1301（160）此时都已摘牌，但玩家没看到：仍为 false。
    expect(lifted(state)).toEqual([1203]);

    // 169 打电话，挂断时刻 171：1204（153 <= 171）和 1301（160 <= 171）得知摘牌，按 world.rooms 的顺序。
    state = play(world, state, act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1204, 1301] });
    expect(lifted(state)).toEqual([1203, 1204, 1301]);

    // 171 回服务间休息：走 4 分钟，175 到，休息到 205。等到 17:00（510）只能还车：步行 0，还车 5 分钟，515 结束。
    // 1205 整班不摘牌，到班次结束也不知道。
    state = play(world, state, act.break());
    state = play(world, waitUntil(world, state, 510), act.finish());
    expect(state.ended).toBe('hardStop');
    expect(state.minute).toBe(515);
    expect(lifted(state)).toEqual([1203, 1204, 1301]);
  });
});

describe('进度', () => {
  it('打电话以后已退标记为 true；敲门被拒以后回来时间是取整后的值；打扫完成后完成时刻和已做分钟与 State 一致', () => {
    const world = controlledWorld({
      // 开工前已退房。
      1201: departure(),
      // 游客 61 出门。
      1203: stayover({ clue: 'tourist', availableFrom: 61 }),
    });
    let state = initial(world);
    expect(roomOf(observe(world, state), 1201).flaggedDeparted).toBe(false);

    // 开工打电话，挂断时刻 2：1201（-30 <= 2）标为已退；续住房不会被标记。
    state = play(world, state, act.call());
    let view = observe(world, state);
    expect(roomOf(view, 1201).flaggedDeparted).toBe(true);
    expect(roomOf(view, 1203).flaggedDeparted).toBe(false);

    // 2 去 1203：走 2 分钟，4 到门口，4 < 61，敲门被拒，5 结束；回来时间 ceil(61 / 15) × 15 = 5 × 15 = 75，不是 61。
    state = play(world, state, act.service(1203));
    expect(roomOf(observe(world, state), 1203)).toStrictEqual({
      ...fresh(1203, 12, 2, 'stayover', 'tourist'),
      knownAvailableFrom: 75,
    });

    // 5 去 1201：从门位 2 走 1 分钟，6 到门口，打扫 30 分钟，36 做完，用 2 份布草（8 - 2 = 6）。
    state = play(world, state, act.service(1201));
    view = observe(world, state);
    expect(roomOf(view, 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'departure', 'oneNight'),
      doneAt: 36,
      workDone: 30,
      flaggedDeparted: true,
      mess: 'normal',
    });
    expect(roomOf(view, 1201).doneAt).toBe(progress(state, 1201).doneAt);
    expect(roomOf(view, 1201).workDone).toBe(progress(state, 1201).workDone);
    expect(view).toMatchObject({ minute: 36, place: { floor: 12, door: 1 }, cart: 6, breakTaken: false });
    // 每间房的进度字段都和 State 一致（dndLifted 对应 dndLiftKnown）。
    expect(view.rooms.map(progressInView)).toStrictEqual(state.rooms.map(progressInState));
  });
});

describe('班次结束后', () => {
  it("收工还车（'returned'）：没开过门的房间仍不显示脏乱和描述；ended、日志和 State 一致", () => {
    const world = controlledWorld({
      // 客人开工前已出门，整洁，有房间描述。
      1201: stayover({ mess: 'tidy', descriptionId: 'desc-1201' }),
      // 整班不摘牌，从没开过门。
      1203: dnd({ mess: 'disaster', descriptionId: 'desc-1203' }),
    });
    // 去 1201：走 1 分钟，1 到门口，打扫 15 × 0.8 = 12 分钟，13 做完。在门口等到 119 去休息：120 到服务间，休息到 150。
    // 150 收工：步行 0，还车 5 分钟，155 结束。
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break(), act.finish());
    expect(state.ended).toBe('returned');
    expect(state.minute).toBe(155);

    const view = observe(world, state);
    expect(view.ended).toBe('returned');
    expect(view.minute).toBe(155);
    // 日志：打扫 1 条，13 到 119 等待 22 条（21 次 5 分钟加 1 次 1 分钟），休息 1 条，收工 1 条，共 25 条。
    expect(view.log).toHaveLength(25);
    expect(view.log).toStrictEqual(state.log);
    expect(roomOf(view, 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'stayover', 'business'),
      doneAt: 13,
      workDone: 12,
      mess: 'tidy',
      descriptionId: 'desc-1201',
    });
    expect(roomOf(view, 1203)).toStrictEqual(fresh(1203, 12, 2, 'dnd', 'business'));
  });

  it("17:00 后还车（'hardStop'）：截断的房间显示真值，没开过门的房间仍不显示；ended、日志、布草、是否休息过和违规都和 State 一致", () => {
    const world = controlledWorld({
      1201: departure({ mess: 'disaster', descriptionId: 'desc-1201' }),
      // 客人开工前已出门，从没去过。
      1203: stayover({ mess: 'tidy', descriptionId: 'desc-1203' }),
    });
    // 同截断的用例：开工打电话（挂断 2，1201 标为已退），120 休息到 150，500 出发去 1201，510 截断，做了 9 分钟。
    // 17:00 之后只能还车：走 1 分钟回服务间，511 到，还车 5 分钟，516 结束。
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, 120), act.break());
    state = play(world, waitUntil(world, state, 500), act.service(1201), act.finish());
    expect(state.ended).toBe('hardStop');
    expect(state.minute).toBe(516);

    const view = observe(world, state);
    expect(view.ended).toBe('hardStop');
    expect(view.minute).toBe(516);
    expect(view.log).toStrictEqual(state.log);
    // 布草：1201 第一次开门扣 2 份，之后没补货，8 - 2 = 6。休息过。阶段 0 没有操守事件，没有违规。
    expect(view.cart).toBe(6);
    expect(view.breakTaken).toBe(true);
    expect(view.violation).toBe(false);
    expect(roomOf(view, 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'departure', 'oneNight'),
      doneAt: null,
      workDone: 9,
      flaggedDeparted: true,
      mess: 'disaster',
      descriptionId: 'desc-1201',
    });
    expect(roomOf(view, 1203)).toStrictEqual(fresh(1203, 12, 2, 'stayover', 'business'));
  });

  it("17:00 后还车（'hardStop'）：敲门被拒过的房间在班次结束后仍显示回来时间，布草是剩下的份数", () => {
    const world = controlledWorld({
      // 开工前已退房，灾难级，没写描述（生成的值是 null）。
      1201: departure({ mess: 'disaster' }),
      // 游客 61 出门。
      1203: stayover({ clue: 'tourist', availableFrom: 61 }),
    });
    // 开工打电话，挂断时刻 2，1201 标为已退（-30 <= 2）。
    // 2 去 1203：走 2 分钟，4 到门口，4 < 61，敲门被拒，5 结束；回来时间 ceil(61 / 15) × 15 = 5 × 15 = 75。停在 {12, 2}。
    let state = play(world, initial(world), act.call(), act.service(1203));
    expect(last(state).outcome).toEqual({ type: 'knockRefused', room: 1203, comeBackAt: 75 });
    // 在 1203 门口等到 120 再去休息：从门位 2 走回服务间 2 分钟，122 到（不早于 120，可以休息），休息 30 分钟到 152。
    state = play(world, waitUntil(world, state, 120), act.break());
    expect(state.minute).toBe(152);
    // 在服务间等到 500 去 1201：走 1 分钟，501 到门口（501 + 1 <= 510，合法），开门扣 2 份布草，8 - 2 = 6；
    // 要打扫 30 × 1.6 = 48 分钟，501 + 48 = 549 > 510，在 510 截断，做了 510 - 501 = 9 分钟。
    // 17:00 之后只能还车：走 1 分钟回服务间，511 到，还车 5 分钟，516 结束。
    state = play(world, waitUntil(world, state, 500), act.service(1201), act.finish());
    expect(state.ended).toBe('hardStop');
    expect(state.minute).toBe(516);

    const view = observe(world, state);
    expect(view).toMatchObject({
      minute: 516,
      place: { floor: 12, door: 0 },
      cart: 6,
      breakTaken: true,
      violation: false,
      ended: 'hardStop',
    });
    // 1203 从没开过门，只多了回来时间；班次结束后照样显示。
    expect(roomOf(view, 1203)).toStrictEqual({ ...fresh(1203, 12, 2, 'stayover', 'tourist'), knownAvailableFrom: 75 });
    // 1201 被截断：开过门，显示脏乱；描述的真值是 null。
    expect(roomOf(view, 1201)).toStrictEqual({
      ...fresh(1201, 12, 1, 'departure', 'oneNight'),
      workDone: 9,
      flaggedDeparted: true,
      mess: 'disaster',
    });
  });
});

describe('日志', () => {
  it('View 的日志和 State 的日志内容相同，但数组是新的，每个条目是同一个对象', () => {
    const world = controlledWorld({ 1201: departure(), 1203: stayover({ clue: 'tourist', availableFrom: 61 }) });
    const start = initial(world);
    const startView = observe(world, start);
    expect(startView.log).toStrictEqual([]);
    expect(startView.log).not.toBe(start.log);

    // 打电话（0 到 2）、敲门被拒（2 到 5）、打扫 1201（5 到 36）、等待 5 分钟（36 到 41）：4 条日志。
    const state = play(world, start, act.call(), act.service(1203), act.service(1201), act.wait(5));
    expect(state.minute).toBe(41);
    const view = observe(world, state);
    expect(view.log).toHaveLength(4);
    expect(view.log).toStrictEqual(state.log);
    expect(view.log).not.toBe(state.log);
    state.log.forEach((entry, index) => expect(at(view.log, index), `第 ${index + 1} 条`).toBe(entry));
  });

  /**
   * 一整局的固定合法动作，阶段 0 走得到的六种都有（respond 阶段 0 走不到，apply 收到就抛错）。
   * 世界：1201 开工前已退房，1203 的游客 61 出门，其余是整班不摘牌的请勿打扰房，不挡收工。
   * 打电话（0 到 2，1201 标为已退）；去 1203（4 到门口，敲门被拒，5 结束，回来时间 75）；打扫 1201（6 到门口，36 做完）；
   * 回服务间补货（37 到，42 补完）；等 3 分钟（45），再等 15 次 5 分钟（120）；在服务间休息（120 到 150）；
   * 再去 1203（152 到门口，客人不在，打扫 15 分钟，167 做完）；收工（走 2 分钟，169 回到服务间，还车 5 分钟，174 结束）。
   * 每次调用都返回新的动作对象。
   */
  function wholeShift(): Action[] {
    return [
      act.call(),
      act.service(1203),
      act.service(1201),
      act.restock(),
      act.wait(3),
      ...Array.from({ length: 15 }, () => act.wait(5)),
      act.break(),
      act.service(1203),
      act.finish(),
    ];
  }

  /** 同一个动作，有字段的改成字段在前、type 在后（打扫先 room，等待先 minutes）；只有 type 的原样返回。 */
  function fieldsFirst(action: Action): Action {
    switch (action.type) {
      case 'service':
        return { room: action.room, type: 'service' };
      case 'wait':
        return { minutes: action.minutes, type: 'wait' };
      case 'respond':
        return { option: action.option, type: 'respond' };
      default:
        return action;
    }
  }

  /**
   * 同一个动作多带几个键，写在 type 前面：和哪种动作都无关的 note，以及别的类型的字段（这个类型自己的字段取原来的值），
   * 每个动作的键都是 note、room、minutes、option、type。先存进有显式类型的变量再返回：变量不是新写的对象字面量，
   * 不触发多余属性检查，不用 as。
   */
  function withExtraKeys(action: Action): Action {
    const written: Action & { note: string; room: RoomId; minutes: Minute; option: string } = {
      note: 'x',
      room: 1201,
      minutes: 3,
      option: 'continue',
      ...action,
    };
    return written;
  }

  it('两串动作只差提交时键的顺序（打扫先 room、等待先 minutes），或者每个动作多带几个键（包括别的类型的字段）：observe 的结果相同（toStrictEqual），JSON.stringify 也逐字相同', () => {
    // 日志里的动作由 apply 按类型重建，键的顺序固定，多带的键不进日志，所以内容相同的 View 序列化的结果相同。
    // toStrictEqual 不比较键的顺序，顺序要靠 JSON.stringify 比。
    const world = controlledWorld({ 1201: departure(), 1203: stayover({ clue: 'tourist', availableFrom: 61 }) });
    const viewAfter = (actions: Action[]): View => observe(world, play(world, initial(world), ...actions));
    const expected = viewAfter(wholeShift());
    expect(expected).toMatchObject({ minute: 174, ended: 'returned' });
    expect(new Set(expected.log.map((entry) => entry.action.type))).toEqual(
      new Set(['service', 'restock', 'call', 'break', 'wait', 'finish']),
    );

    const reversed = wholeShift().map(fieldsFirst);
    const extra = wholeShift().map(withExtraKeys);
    // 对照：反过来写的打扫和等待确实是字段在前；多带键的那串每个动作确实带着这几个键。
    for (const action of reversed) {
      if (action.type === 'service') expect(Object.keys(action)).toEqual(['room', 'type']);
      if (action.type === 'wait') expect(Object.keys(action)).toEqual(['minutes', 'type']);
    }
    for (const action of extra) expect(Object.keys(action)).toEqual(['note', 'room', 'minutes', 'option', 'type']);

    const cases: [string, Action[]][] = [
      ['打扫和等待的字段写在 type 前面', reversed],
      ['每个动作多带几个键，包括别的类型的字段', extra],
    ];
    for (const [label, actions] of cases) {
      const view = viewAfter(actions);
      expect(view, label).toStrictEqual(expected);
      expect(JSON.stringify(view), label).toBe(JSON.stringify(expected));
    }
  });
});

describe('不共用对象', () => {
  it('View 的位置和每间房的位置都是副本：内容相同，但不是 State 或 World 里的那个对象', () => {
    const world = controlledWorld({ 1205: stayover() });
    const start = initial(world);
    // 去 1205：走 3 分钟，3 到门口，打扫 15 分钟，18 做完，停在 {12, 3}。
    const moved = play(world, start, act.service(1205));
    expect(moved.place).toEqual({ floor: 12, door: 3 });
    for (const state of [start, moved]) {
      const view = observe(world, state);
      expect(view.place).toStrictEqual(state.place);
      expect(view.place).not.toBe(state.place);
      expect(view.place).not.toBe(world.params.layout.servicePoint);
      world.rooms.forEach((truth, index) => {
        const room = at(view.rooms, index);
        expect(room.place, `${truth.id}`).toStrictEqual(truth.place);
        expect(room.place, `${truth.id}`).not.toBe(truth.place);
      });
    }
  });
});

describe('state 和 world 的房间对不上', () => {
  it('拿另一个世界的 state：房间数不同（包括前面的房号逐个相同、只是多出或少了几间），或房间相同但顺序不同（包括只有中间两间对调），observe 都抛出中文报错', () => {
    const standard = generate('mismatch', PARAMS.standard);
    const odd = generate('mismatch', ODD_PARAMS);
    const reversed = generate('mismatch', REVERSED);
    const floor12 = generate('mismatch', FLOOR_12_ONLY);
    const swapped = generate('mismatch', SWAPPED_12);
    // 标准档 15 间，ODD_PARAMS 16 间；楼层倒过来的世界也是那 15 间，但 13 楼在前；只有 12 楼的世界 8 间，是标准档的前 8 间。
    expect(standard.rooms).toHaveLength(15);
    expect(odd.rooms).toHaveLength(16);
    expect(floor12.rooms.map((room) => room.id)).toEqual(standard.rooms.slice(0, 8).map((room) => room.id));
    // 1203、1204 对调的世界：generate 照常接受（房型合计仍是 15 间）；每个下标上的位置和标准档相同，
    // 房号只在下标 2、3 上不同，第一间 1201、最后一间 1307 都相同。
    expect(swapped.rooms.map((room) => room.place)).toStrictEqual(standard.rooms.map((room) => room.place));
    expect(swapped.rooms.map((room) => room.id)).toEqual([
      1201, 1202, 1204, 1203, 1205, 1206, 1207, 1208, 1301, 1302, 1303, 1304, 1305, 1306, 1307,
    ]);
    const cases: [string, World, State][] = [
      ['标准档的世界配 ODD_PARAMS 世界的 state（state 多一间）', standard, initial(odd)],
      ['ODD_PARAMS 的世界配标准档世界的 state（state 少一间）', odd, initial(standard)],
      ['标准档的世界配楼层倒过来的 state（房间相同、顺序不同）', standard, initial(reversed)],
      ['楼层倒过来的世界配标准档的 state', reversed, initial(standard)],
      // 下面两个前 8 间的房号逐个相同，只有房间数不同：只逐个比房号、不比数量的写法会漏掉第一个。
      ['只有 12 楼的世界配标准档的 state（state 多出 13 楼的 7 间）', floor12, initial(standard)],
      ['标准档的世界配只有 12 楼的 state（state 少了 13 楼的 7 间）', standard, initial(floor12)],
      // 下面两个房间数、第一间、最后一间都相同，只有下标 2、3 的房号不同：只比数量、第一间或最后一间的写法都会漏掉，
      // 只有逐个比房号的写法才能抓到。
      ['标准档的世界配 1203、1204 对调的 state（只有下标 2、3 不同）', standard, initial(swapped)],
      ['1203、1204 对调的世界配标准档的 state', swapped, initial(standard)],
    ];
    for (const [label, world, state] of cases) {
      // 对照：同一个世界配它自己的 state 不抛错。只看会不会抛错的话，一律抛错的写法也能通过。
      expect(() => observe(world, initial(world)), label).not.toThrow();
      expect(errorOf(() => observe(world, state)), label).toMatch(CHINESE);
    }
  });
});

describe('待回应的事件', () => {
  it('state 带着待回应的事件时 observe 抛错', () => {
    // 这是唯一手工拼出的 State，因为 initial 加合法动作推不出它：阶段 0 没有事件，prompt 恒为 null。
    // View.prompt 在阶段 0 的类型就是 null，待回应的事件要到阶段 2 才有不含隐藏结果的视图类型，所以 observe 必须拒绝。
    const world = controlledWorld({ 1201: stayover() });
    // 对照：没有待回应事件的同一个状态不抛错。
    expect(() => observe(world, initial(world))).not.toThrow();
    const state: State = {
      ...initial(world),
      prompt: {
        eventIndex: 0,
        event: { type: 'extraTowels', at: 10 },
        options: [{ id: 'deliver', minutes: 2, violation: false, endsShift: false }],
      },
    };
    expect(errorOf(() => observe(world, state))).toMatch(CHINESE);
  });
});

describe('legalActionsForView：参数的楼层和 View 的房间对不上', () => {
  it('房间数不同（包括前面的房号逐个相同、只是多出或少了几间），或房间相同但顺序不同（包括只有中间两间对调），都抛出中文报错', () => {
    const standard = generate('floors', PARAMS.standard);
    const odd = generate('floors', ODD_PARAMS);
    const reversed = generate('floors', REVERSED);
    const floor12 = generate('floors', FLOOR_12_ONLY);
    const swapped = generate('floors', SWAPPED_12);
    const standardView = observe(standard, initial(standard));
    const oddView = observe(odd, initial(odd));
    const reversedView = observe(reversed, initial(reversed));
    const floor12View = observe(floor12, initial(floor12));
    const swappedView = observe(swapped, initial(swapped));
    // 对照：配上各自世界的参数都不抛错。只看会不会抛错的话，一律抛错的写法也能通过。
    expect(() => legalActionsForView(standardView, PARAMS.standard)).not.toThrow();
    expect(() => legalActionsForView(oddView, ODD_PARAMS)).not.toThrow();
    expect(() => legalActionsForView(reversedView, REVERSED)).not.toThrow();
    expect(() => legalActionsForView(floor12View, FLOOR_12_ONLY)).not.toThrow();
    expect(() => legalActionsForView(swappedView, SWAPPED_12)).not.toThrow();
    const cases: [string, View, Params][] = [
      ['标准档的 View 配 ODD_PARAMS（15 间对 16 间）', standardView, ODD_PARAMS],
      ['ODD_PARAMS 的 View 配标准档（16 间对 15 间）', oddView, PARAMS.standard],
      ['标准档的 View 配楼层倒过来的参数（13 楼在前）', standardView, REVERSED],
      ['楼层倒过来的 View 配标准档（12 楼在前）', reversedView, PARAMS.standard],
      // 下面两个前 8 间的房号逐个相同，只有房间数不同：只逐个比 View 的房号、不比数量的写法会漏掉第一个。
      ['只有 12 楼的 View 配标准档（8 间对 15 间）', floor12View, PARAMS.standard],
      ['标准档的 View 配只有 12 楼的参数（15 间对 8 间）', standardView, FLOOR_12_ONLY],
      // 下面两个房间数、第一间、最后一间都相同，只有下标 2、3 的房号不同：只比数量、第一间或最后一间的写法都会漏掉，
      // 只有逐个比房号的写法才能抓到。
      ['标准档的 View 配 1203、1204 对调的参数（只有下标 2、3 不同）', standardView, SWAPPED_12],
      ['1203、1204 对调的 View 配标准档', swappedView, PARAMS.standard],
    ];
    for (const [label, view, params] of cases) {
      expect(errorOf(() => legalActionsForView(view, params)), label).toMatch(CHINESE);
    }
  });
});

describe('legalActionsForView：深度冻结的 View', () => {
  it('不抛错，结果和没冻结时相同，也和 legalActions 相同；View 没被改', () => {
    // 用参数的副本：深度冻结只冻结这个测试自己造的对象，就算 View 错误地引用了参数里的对象，也不碰全局共用的 PARAMS。
    const params = structuredClone(PARAMS.standard);
    const world = controlledWorld(
      {
        // 开工前已退房。
        1201: departure(),
        // 游客 61 出门。
        1203: stayover({ clue: 'tourist', availableFrom: 61 }),
        // 第 0 分钟摘牌，客人开工前已出门。
        1205: dnd({ dndLiftsAt: 0 }),
        // 客人开工前已出门。
        1207: stayover(),
      },
      { params },
    );
    // 开工打电话，挂断时刻 2：1201 标为已退（-30 <= 2），1205 得知摘牌（0 <= 2）。
    // 2 去 1203：4 到门口，敲门被拒，5 结束，回来时间 75；停在 {12, 2}。
    const state = play(world, initial(world), act.call(), act.service(1203));
    const plain = observe(world, state);
    const frozen = deepFreeze(observe(world, state));
    const copy = structuredClone(frozen);

    let result: Action[] = [];
    expect(() => {
      result = legalActionsForView(frozen, params);
    }).not.toThrow();
    // 5 分钟在 {12, 2}：1201 第 6 分钟到门口（已标记，布草 8 >= 2）；1203 第 5 分钟到门口，早于回来时间 75，不行；
    // 1205 第 6 分钟到门口（已知摘牌）；1207 第 7 分钟到门口。补货 5 + 2 + 5 = 12 <= 510，打电话 7 <= 510；
    // 休息要到达服务间不早于 120，7 < 120，不行；等待上限 min(5, 510 - 5) = 5；还没休息，不能收工。
    expect(result).toStrictEqual([
      act.service(1201),
      act.service(1205),
      act.service(1207),
      act.restock(),
      act.call(),
      act.wait(5),
    ]);
    expect(result).toStrictEqual(legalActionsForView(plain, params));
    expect(result).toStrictEqual(legalActions(world, state));
    expect(frozen).toStrictEqual(copy);
    expect(Object.isFrozen(frozen.rooms)).toBe(true);
  });
});
