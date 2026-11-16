/**
 * 非法动作原因的单元测试：illegalReasonForView 给出的编号和数据，以及 apply 的报错。性质测试见 illegal-reason.property.test.ts。
 *
 * 21 个编号各有一个用例（CASES 按编号写成一张表，类型里多一个或少一个编号，类型检查都会报错）：受控世界里按 View 判定的
 * 原因和期望的完全相同（编号、数据、键的顺序）；这个动作不在 legalActions 里；apply 抛出中文报错，写明原因里的数据
 * （房号、钟点、份数）。报错只查关键内容，不查整句，和 rules.test.ts 的约定一样；整句和改成编号之前逐字相同，
 * 是改的时候用一次性的对照核对的（见 docs/TASKS.md）。边界两侧各查一次：差一分钟就合法的，合法时按 View 判定为 null。
 * mustRespond 和 noSuchOption 要有待回应的事件：阶段 0 推不出这样的状态，View 也没有待回应的事件（observe 遇到它抛错），
 * 所以这两个用例手工拼 State，只经 apply 检查报错。
 * 另有：ODD_PARAMS 下数据从传入的参数读；合法的动作按 View 判定为 null；参数的楼层和 View 的房间对不上时抛错；
 * 不修改深度冻结的 View 和动作，每次返回新建的对象；能从对外入口导入。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0。同层每个门位 1 分钟，跨层先走到门位 0，乘电梯 4 分钟。打扫分钟（普通脏乱）：退房房 30，
 * 续住房和请勿打扰房 15。敲门被拒花 1 分钟，回来时间按 15 分钟向上取整。补货 5 分钟，电话 2 分钟，休息 30 分钟，
 * 每次最多等 5 分钟。时刻从 08:30 起算：120 是 10:30，360 是 14:30，510 是 17:00。
 */

import { describe, expect, it } from 'vitest';
import { illegalReasonForView as illegalReasonForViewFromIndex } from '../src/engine';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { apply, illegalReasonForView, initial, legalActions } from '../src/engine/rules';
import type { Action, IllegalReason, IllegalReasonCode, State, View, World } from '../src/engine/types';
import { act, errorOf, expectIllegal, expectLegal, play, progress, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze } from './helpers/play';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

/** 中文字符，用来确认报错消息是中文。 */
const CHINESE = /[一-鿿]/;

/** 不认识的动作类型。只能绕过类型检查造出来。 */
const DANCE = { type: 'dance' } as unknown as Action;

/** 标准档的两层倒过来列：13 楼在前，world.rooms 以 1301 开头，和房号的顺序不同。几何不变，服务间仍是 12 楼门位 0。 */
const REVERSED: Params = {
  ...PARAMS.standard,
  layout: { ...PARAMS.standard.layout, floors: [...PARAMS.standard.layout.floors].reverse() },
};

/**
 * 非法：按 View 判定的原因和 expected 完全相同，键的顺序也相同（编号在前，数据按类型里的顺序）；这个动作不在
 * legalActions 里；apply 抛出中文报错，报错里有 mentions 的每一项。交给 illegalReasonForView 的 View 和动作都先深度冻结。
 */
function expectReason(
  world: World,
  state: State,
  action: Action,
  expected: IllegalReason,
  mentions: readonly string[],
): void {
  const label = `${state.minute} 分钟 ${JSON.stringify(action)}`;
  const reason = illegalReasonForView(deepFreeze(observe(world, state)), world.params, deepFreeze(structuredClone(action)));
  expect(reason, label).toStrictEqual(expected);
  expect(Object.keys(reason ?? {}), label).toEqual(Object.keys(expected));
  const message = expectIllegal(world, state, action);
  for (const text of mentions) expect(message, `${label} 的报错应当写明 ${text}`).toContain(text);
}

/** 合法：在 legalActions 里（等待只能用上限那一档），apply 不抛错，按 View 判定为 null。 */
function expectNoReason(world: World, state: State, action: Action): void {
  expectLegal(world, state, action);
  expect(illegalReasonForView(observe(world, state), world.params, action), JSON.stringify(action)).toBeNull();
}

/** 开工后在服务间等到 120（10:30）休息，150 休息完，人还在服务间。 */
function rested(world: World): State {
  return play(world, waitUntil(world, initial(world), world.params.shift.breakEarliest), act.break());
}

/** 手工拼的待回应事件的状态：阶段 0 推不出它（理由见文件开头）。选项是 deliver 和 later。 */
function prompted(state: State): State {
  return {
    ...state,
    prompt: {
      eventIndex: 0,
      event: { type: 'extraTowels', at: 10 },
      options: [
        { id: 'deliver', minutes: 2, violation: false, endsShift: false },
        { id: 'later', minutes: 0, violation: false, endsShift: false },
      ],
    },
  };
}

/** 每个编号的用例：说明和检查。 */
const CASES: { [C in IllegalReasonCode]: readonly [string, () => void] } = {
  ended: [
    '班次结束以后：任何动作，包括还车、不认识的动作和带着待回应事件的状态，都是这一条',
    () => {
      // 没写到的房间都是整班不摘牌的请勿打扰房，不挡收工。120 休息到 150，在服务间收工，155 还完车。
      const world = controlledWorld({});
      const state = play(world, rested(world), act.finish());
      expect(state.ended).toBe('returned');
      for (const action of [act.wait(1), act.finish(), act.break(), act.service(1201), act.respond('continue'), DANCE]) {
        expectReason(world, state, action, { code: 'ended' }, ['班次已经结束']);
      }
      // 班次结束排在待回应的事件前面（只能经 apply 查，理由见文件开头）。
      expect(errorOf(() => apply(world, prompted(state), act.respond('deliver')))).toContain('班次已经结束');
    },
  ],
  mustRespond: [
    '有待回应的事件时，回应以外的动作（手工拼的状态，只经 apply 查）',
    () => {
      const world = controlledWorld({ 1201: stayover() });
      const state = prompted(initial(world));
      expect(legalActions(world, state)).toStrictEqual([act.respond('deliver'), act.respond('later')]);
      for (const action of [act.wait(1), act.service(1201), act.call(), act.finish(), DANCE]) {
        expect(errorOf(() => apply(world, state, action)), JSON.stringify(action)).toContain('先回应');
      }
    },
  ],
  noSuchOption: [
    '有待回应的事件时，回应了没有的选项（手工拼的状态，只经 apply 查）：报错里有提交的选项编号',
    () => {
      const world = controlledWorld({});
      const state = prompted(initial(world));
      expect(errorOf(() => apply(world, state, act.respond('nope')))).toContain('nope');
      // 有的选项过了合法性检查；阶段 0 的执行部分还不处理回应，报的是另一种错。
      const message = errorOf(() => apply(world, state, act.respond('deliver')));
      expect(message).not.toContain('deliver');
      expect(message).toContain('阶段 2');
    },
  ],
  afterHardStop: [
    '17:00 起：还车以外的动作，包括不认识的动作；之前还没到 17:00 时还能等待',
    () => {
      const world = controlledWorld({ 1201: stayover() });
      const before = waitUntil(world, rested(world), 509);
      expectNoReason(world, before, act.wait(1));
      const state = waitUntil(world, before, 510);
      for (const action of [act.call(), act.service(1201), act.restock(), act.break(), act.wait(1), act.respond('continue'), DANCE]) {
        expectReason(world, state, action, { code: 'afterHardStop', hardStop: 510 }, ['17:00', '还车']);
      }
      expectNoReason(world, state, act.finish());
    },
  ],
  mustBreak: [
    '14:30 起还没休息：休息以外的动作，包括不认识的动作；14:29 还能等待',
    () => {
      const world = controlledWorld({ 1201: stayover() });
      const before = waitUntil(world, initial(world), 359);
      expectNoReason(world, before, act.wait(5));
      const state = waitUntil(world, before, 360);
      for (const action of [act.wait(1), act.service(1201), act.call(), act.restock(), act.finish(), act.respond('continue'), DANCE]) {
        expectReason(world, state, action, { code: 'mustBreak', breakLatest: 360 }, ['14:30', '只能休息']);
      }
      expectNoReason(world, state, act.break());
    },
  ],
  restockTooLate: [
    '16:56 在服务间补货要到 17:01 才补完；16:55 补完正好 17:00，还来得及',
    () => {
      const world = controlledWorld({});
      const before = waitUntil(world, rested(world), 505);
      expectNoReason(world, before, act.restock());
      const state = waitUntil(world, before, 506);
      expectReason(world, state, act.restock(), { code: 'restockTooLate', hardStop: 510 }, ['17:00', '补完货']);
    },
  ],
  callTooLate: [
    '16:59 打电话要到 17:01 才打完；16:58 打完正好 17:00，还来得及',
    () => {
      const world = controlledWorld({});
      const before = waitUntil(world, rested(world), 508);
      expectNoReason(world, before, act.call());
      const state = waitUntil(world, before, 509);
      expectReason(world, state, act.call(), { code: 'callTooLate', hardStop: 510 }, ['17:00', '打完电话']);
    },
  ],
  breakAlreadyTaken: [
    '休息过以后再休息',
    () => {
      const world = controlledWorld({});
      expectReason(world, rested(world), act.break(), { code: 'breakAlreadyTaken' }, ['已经休息过']);
    },
  ],
  breakTooEarly: [
    '到达服务间的时刻（不是现在的时刻）早于 10:30：报错写明 10:30 和到达的钟点；到达正好 10:30 就可以',
    () => {
      // 开工去 1203（门位 2）：2 到门口，打扫 15 分钟，17 做完。从门位 2 回服务间要 2 分钟，19（08:49）到。
      const world = controlledWorld({ 1203: stayover() });
      const state = play(world, initial(world), act.service(1203));
      expect(state.minute).toBe(17);
      expectReason(world, state, act.break(), { code: 'breakTooEarly', breakEarliest: 120, arrival: 19 }, ['10:30', '08:49']);
      // 117 出发，119（10:29）到，还不行；118 出发，120 到，可以。
      const late = waitUntil(world, state, 117);
      expectReason(world, late, act.break(), { code: 'breakTooEarly', breakEarliest: 120, arrival: 119 }, ['10:30', '10:29']);
      expectNoReason(world, waitUntil(world, late, 118), act.break());
    },
  ],
  badWait: [
    '等待的分钟数不是 1 到上限之间的整数：报错写明这一刻的上限（开工时 5，16:59 只剩 1）',
    () => {
      const world = controlledWorld({});
      const start = initial(world);
      for (const minutes of [0, -5, 1.5, 6, Number.NaN]) {
        expectReason(world, start, act.wait(minutes), { code: 'badWait', limit: 5 }, ['1 到 5']);
      }
      const late = waitUntil(world, rested(world), 509);
      expectReason(world, late, act.wait(2), { code: 'badWait', limit: 1 }, ['1 到 1']);
      expectNoReason(world, late, act.wait(1));
    },
  ],
  noPrompt: [
    '没有待回应的事件时回应',
    () => {
      const world = controlledWorld({});
      for (const option of ['continue', 'deliver', '']) {
        expectReason(world, initial(world), act.respond(option), { code: 'noPrompt' }, ['没有要回应的事件']);
      }
    },
  ],
  unknownAction: [
    '不认识的动作类型',
    () => {
      const world = controlledWorld({});
      expectReason(world, initial(world), DANCE, { code: 'unknownAction' }, ['没有这种动作']);
    },
  ],
  noSuchRoom: [
    '楼层里没有的房号：报错里有这个房号',
    () => {
      const world = controlledWorld({});
      // 1499 哪套参数里都没有；301 是 ODD_PARAMS 的房间，标准档没有。
      for (const room of [1499, 301]) {
        expectReason(world, initial(world), act.service(room), { code: 'noSuchRoom', room }, [String(room)]);
      }
    },
  ],
  roomDone: [
    '做完的房间再去',
    () => {
      // 1203 在 17 做完。
      const world = controlledWorld({ 1203: stayover() });
      const state = play(world, initial(world), act.service(1203));
      expectReason(world, state, act.service(1203), { code: 'roomDone', room: 1203 }, ['1203', '做完']);
    },
  ],
  notFlagged: [
    '没被标记的退房房：其实开工前就退了，玩家不知道，也是这一条',
    () => {
      const world = controlledWorld({ 1204: departure() });
      expectReason(world, initial(world), act.service(1204), { code: 'notFlagged', room: 1204 }, ['1204', '标记']);
    },
  ],
  dndNotLifted: [
    '不知道摘牌的请勿打扰房：其实第 0 分钟就摘了，玩家不知道，也是这一条',
    () => {
      const world = controlledWorld({ 1205: dnd({ dndLiftsAt: 0 }) });
      expectReason(world, initial(world), act.service(1205), { code: 'dndNotLifted', room: 1205 }, ['1205', '请勿打扰']);
    },
  ],
  cannotReachInTime: [
    '到了门口再敲一次门要晚于 17:00：16:56 从服务间去门位 4 是 17:00 到，17:01 才敲完；门位 3 正好 17:00 敲完，还来得及；到门口的时刻也早于客人说的回来时间时，给的还是这一条',
    () => {
      // 1208 的客人 511（17:01）才出门：开工去，4 到门口被拒，5 结束，回来时间 ceil(511 / 15) × 15 = 525（17:15）。
      // 在门位 4 等到 116 去休息，120 到服务间，150 休息完，再等到 506（16:56）。
      const world = controlledWorld({
        1205: stayover(),
        1207: stayover(),
        1208: stayover({ clue: 'longStay', availableFrom: 511 }),
      });
      const refused = play(world, initial(world), act.service(1208));
      expect(progress(refused, 1208).knownAvailableFrom).toBe(525);
      const state = waitUntil(world, play(world, waitUntil(world, refused, 116), act.break()), 506);
      expectReason(world, state, act.service(1207), { code: 'cannotReachInTime', room: 1207, hardStop: 510 }, ['1207', '17:00']);
      // 1208 在 510 到门口：来不及敲门，也早于回来时间 525；先查来不来得及敲门。
      expectReason(world, state, act.service(1208), { code: 'cannotReachInTime', room: 1208, hardStop: 510 }, ['1208', '17:00']);
      expectNoReason(world, state, act.service(1205));
    },
  ],
  comeBackLater: [
    '客人说过回来时间，现在出发到达的时刻早于它：报错写明回来时间和到达的钟点；到达正好是回来时间就可以',
    () => {
      // 1201 的客人 61 出门：开工去，1 到门口被拒，2 结束，回来时间 ceil(61 / 15) × 15 = 75（09:45）。
      // 再去 1203（门位 2，客人开工前已出门）：3 到门口，打扫 15 分钟，18 做完。从门位 2 回 1201 要 1 分钟，19（08:49）到。
      const world = controlledWorld({ 1201: stayover({ clue: 'tourist', availableFrom: 61 }), 1203: stayover() });
      const state = play(world, initial(world), act.service(1201), act.service(1203));
      expect(state.minute).toBe(18);
      expectReason(
        world,
        state,
        act.service(1201),
        { code: 'comeBackLater', room: 1201, comeBackAt: 75, arrival: 19 },
        ['1201', '09:45', '08:49'],
      );
      // 73 出发，74（09:44）到，还不行；74 出发，75 到，可以。
      const late = waitUntil(world, state, 73);
      expectReason(
        world,
        late,
        act.service(1201),
        { code: 'comeBackLater', room: 1201, comeBackAt: 75, arrival: 74 },
        ['1201', '09:45', '09:44'],
      );
      expectNoReason(world, waitUntil(world, late, 74), act.service(1201));
    },
  ],
  linenShort: [
    '第一次开门的布草不够：报错写明要几份、车里剩几份；退房房和续住房要的份数不同',
    () => {
      // 紧档，布草车 6 份。开工打电话（0 到 2），标记开工前已退房的 1201。再做 1203 到 1207 五间续住房，81 做完，
      // 各用 1 份，剩 1 份；1201 要 2 份。1208 是续住房，要 1 份，够。
      const world = controlledWorld(
        {
          1201: departure(),
          1202: stayover(),
          1203: stayover(),
          1204: stayover(),
          1205: stayover(),
          1206: stayover(),
          1207: stayover(),
          1208: stayover(),
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
      expectReason(world, state, act.service(1201), { code: 'linenShort', room: 1201, needed: 2, cart: 1 }, [
        '1201',
        '要 2 份',
        '只剩 1 份',
      ]);
      expectNoReason(world, state, act.service(1208));
      // 做完 1208（同在门位 4，96 做完），车空了；续住房 1202 要 1 份。
      const empty = play(world, state, act.service(1208));
      expect(empty.cart).toBe(0);
      expectReason(world, empty, act.service(1202), { code: 'linenShort', room: 1202, needed: 1, cart: 0 }, [
        '1202',
        '要 1 份',
        '只剩 0 份',
      ]);
    },
  ],
  breakNotTaken: [
    '还没休息就收工：排在没做完的房间前面',
    () => {
      const world = controlledWorld({ 1201: stayover() });
      expectReason(world, initial(world), act.finish(), { code: 'breakNotTaken' }, ['还没休息']);
    },
  ],
  roomsLeft: [
    '还有房间没做完：按 world.rooms 的顺序（楼层倒过来列，不是房号的顺序），列出退房房（不管标没标记）、续住房和已知摘牌的请勿打扰房，不知道摘牌的不算',
    () => {
      // 1302 是 200 才退房的退房房，1305 开工前已退房，1201 续住，1206 第 0 分钟摘牌，1207 整班不摘（没写到的房间也是）。
      // 开工打电话，2 挂断：1305 标为已退，1302 还没退，没标记；1206 得知摘牌。在服务间等到 120 休息，150 休息完。
      const world = controlledWorld(
        {
          1201: stayover(),
          1206: dnd({ dndLiftsAt: 0 }),
          1207: dnd(),
          1302: departure({ availableFrom: 200 }),
          1305: departure(),
        },
        { params: REVERSED },
      );
      const state = play(world, waitUntil(world, play(world, initial(world), act.call()), 120), act.break());
      expect(world.rooms[0]?.id).toBe(1301);
      expectReason(world, state, act.finish(), { code: 'roomsLeft', rooms: [1302, 1305, 1201, 1206] }, ['1302、1305、1201、1206']);
    },
  ],
};

describe('每个编号：按 View 判定的原因、legalActions 和 apply 的报错', () => {
  it('编号恰好是 docs/TASKS.md 列的 21 个，按那里的顺序', () => {
    expect(Object.keys(CASES)).toEqual([
      'ended',
      'mustRespond',
      'noSuchOption',
      'afterHardStop',
      'mustBreak',
      'restockTooLate',
      'callTooLate',
      'breakAlreadyTaken',
      'breakTooEarly',
      'badWait',
      'noPrompt',
      'unknownAction',
      'noSuchRoom',
      'roomDone',
      'notFlagged',
      'dndNotLifted',
      'cannotReachInTime',
      'comeBackLater',
      'linenShort',
      'breakNotTaken',
      'roomsLeft',
    ]);
  });

  const rows = Object.entries(CASES).map(([code, [title, run]]): [string, string, () => void] => [code, title, run]);
  it.each(rows)('%s：%s', (_code, _title, run) => {
    run();
  });
});

describe('数据从传入的参数读（ODD_PARAMS：17:00 是 480，14:30 是 300，10:30 是 100，退房房 3 份布草，续住房 2 份，等待上限 4）', () => {
  // ODD_PARAMS 的几何：服务间是 5 楼门位 0；5 楼 501 到 510 在门位 1 到 5，每个门位 2 分钟。
  // 普通脏乱的续住房 20 × 1.25 = 25 分钟；电话 3 分钟，补货 4 分钟，敲门被拒 2 分钟，回来时间按 10 分钟向上取整，休息 20 分钟。

  it('开工：等 5 分钟超过上限 4；休息要等到 10:10', () => {
    const world = controlledWorld({}, { params: ODD_PARAMS });
    const start = initial(world);
    expectReason(world, start, act.wait(5), { code: 'badWait', limit: 4 }, ['1 到 4']);
    expectReason(world, start, act.break(), { code: 'breakTooEarly', breakEarliest: 100, arrival: 0 }, ['10:10', '08:30']);
  });

  it('13:30 起还没休息只能休息', () => {
    const world = controlledWorld({}, { params: ODD_PARAMS });
    const state = waitUntil(world, initial(world), 300);
    expectReason(world, state, act.wait(1), { code: 'mustBreak', breakLatest: 300 }, ['13:30']);
  });

  it('布草：做完三间续住房剩 1 份，退房房要 3 份，续住房要 2 份', () => {
    // 开工打电话，3 挂断，标记 501。502（门位 1）5 到门口、30 做完，503（门位 2）32 到、57 做完，504（门位 2）82 做完，
    // 7 - 3 × 2 = 1 份。
    const world = controlledWorld(
      { 501: departure(), 502: stayover(), 503: stayover(), 504: stayover(), 505: stayover() },
      { params: ODD_PARAMS },
    );
    const state = play(world, initial(world), act.call(), act.service(502), act.service(503), act.service(504));
    expect(state.minute).toBe(82);
    expect(state.cart).toBe(1);
    expectReason(world, state, act.service(501), { code: 'linenShort', room: 501, needed: 3, cart: 1 }, ['要 3 份', '只剩 1 份']);
    expectReason(world, state, act.service(505), { code: 'linenShort', room: 505, needed: 2, cart: 1 }, ['要 2 份', '只剩 1 份']);
  });

  it('回来时间按 10 分钟取整', () => {
    // 505（门位 3）：6 到门口，客人 61 出门，被拒，敲门 2 分钟，8 结束，回来时间 70（09:40）。站在门口再去，8（08:38）到。
    const world = controlledWorld({ 505: stayover({ clue: 'tourist', availableFrom: 61 }) }, { params: ODD_PARAMS });
    const state = play(world, initial(world), act.service(505));
    expect(state.minute).toBe(8);
    expectReason(world, state, act.service(505), { code: 'comeBackLater', room: 505, comeBackAt: 70, arrival: 8 }, [
      '09:40',
      '08:38',
    ]);
  });

  it('16:30 前后：补货、电话、去门位 5、等待和 16:30 以后', () => {
    // 100 休息到 120，在服务间等。510 在门位 5，走 10 分钟。
    const world = controlledWorld({ 510: stayover() }, { params: ODD_PARAMS });
    const rest = play(world, waitUntil(world, initial(world), 100), act.break());
    const at476 = waitUntil(world, rest, 476);
    expectNoReason(world, at476, act.restock());
    expectReason(world, at476, act.service(510), { code: 'cannotReachInTime', room: 510, hardStop: 480 }, ['510', '16:30']);
    const at477 = waitUntil(world, at476, 477);
    expectReason(world, at477, act.restock(), { code: 'restockTooLate', hardStop: 480 }, ['16:30']);
    expectNoReason(world, at477, act.call());
    const at478 = waitUntil(world, at477, 478);
    expectReason(world, at478, act.call(), { code: 'callTooLate', hardStop: 480 }, ['16:30']);
    expectReason(world, at478, act.wait(3), { code: 'badWait', limit: 2 }, ['1 到 2']);
    const at480 = waitUntil(world, at478, 480);
    expectReason(world, at480, act.wait(1), { code: 'afterHardStop', hardStop: 480 }, ['16:30']);
  });
});

describe('合法的动作', () => {
  it('legalActions 列出的每个动作，以及 1 到上限之间每个整数分钟的等待，按 View 判定都是 null', () => {
    // 开工：两间续住房、补货、打电话和等 5 分钟合法。
    const world = controlledWorld({ 1201: stayover(), 1305: stayover() });
    const state = initial(world);
    const legal = legalActions(world, state);
    expect(legal).toStrictEqual([act.service(1201), act.service(1305), act.restock(), act.call(), act.wait(5)]);
    const view = observe(world, state);
    for (const action of [...legal, act.wait(1), act.wait(2), act.wait(3), act.wait(4)]) {
      expect(illegalReasonForView(view, world.params, action), JSON.stringify(action)).toBeNull();
    }
  });
});

describe('参数的楼层和 View 的房间对不上', () => {
  it('房间数不同、或者楼层的顺序不同时抛出中文报错，配上自己的参数不抛错', () => {
    const standard = generate('reason-floors', PARAMS.standard);
    const reversed = generate('reason-floors', REVERSED);
    const standardView = observe(standard, initial(standard));
    const reversedView = observe(reversed, initial(reversed));
    // 对照：配上各自世界的参数都不抛错。只看会不会抛错的话，一律抛错的写法也能通过。
    expect(illegalReasonForView(standardView, PARAMS.standard, act.wait(1))).toBeNull();
    expect(illegalReasonForView(reversedView, REVERSED, act.wait(1))).toBeNull();
    const cases: [string, View, Params][] = [
      ['标准档的 View 配 ODD_PARAMS（15 间对 16 间）', standardView, ODD_PARAMS],
      ['标准档的 View 配楼层倒过来的参数（13 楼在前）', standardView, REVERSED],
      ['楼层倒过来的 View 配标准档（12 楼在前）', reversedView, PARAMS.standard],
    ];
    for (const [label, view, params] of cases) {
      expect(errorOf(() => illegalReasonForView(view, params, act.wait(1))), label).toMatch(CHINESE);
    }
  });
});

describe('纯函数', () => {
  it('深度冻结的 View 和动作：不抛错，入参没被改；同一输入调两次结果相同，但每次都是新建的对象', () => {
    // 用参数的副本：深度冻结只冻结这个测试自己造的对象，不碰全局共用的 PARAMS。
    const params = structuredClone(PARAMS.standard);
    const world = controlledWorld({ 1201: stayover(), 1203: departure() }, { params });
    const state = play(world, waitUntil(world, initial(world), 120), act.break());
    const view = deepFreeze(observe(world, state));
    const viewCopy = structuredClone(view);
    const action = deepFreeze(act.finish());
    const first = illegalReasonForView(view, params, action);
    const second = illegalReasonForView(view, params, action);
    // 1203 没打电话，没标记，也挡收工。
    expect(first).toStrictEqual({ code: 'roomsLeft', rooms: [1201, 1203] });
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    if (first?.code !== 'roomsLeft' || second?.code !== 'roomsLeft') throw new Error('应当是 roomsLeft');
    expect(second.rooms).not.toBe(first.rooms);
    expect(view).toStrictEqual(viewCopy);
    expect(action).toStrictEqual(act.finish());
  });
});

describe('对外入口', () => {
  it('能从 src/engine/index.ts 导入 illegalReasonForView', () => {
    expect(illegalReasonForViewFromIndex).toBe(illegalReasonForView);
    expect(typeof illegalReasonForViewFromIndex).toBe('function');
  });
});
