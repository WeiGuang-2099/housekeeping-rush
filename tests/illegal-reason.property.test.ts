/**
 * 非法动作原因的性质测试。单元测试见 illegal-reason.test.ts。
 *
 * 状态来自 tests/helpers/play.ts 的 playShift：fast-check 生成种子和一串下标，随机合法序列从开工走到班次结束，
 * 三档和 ODD_PARAMS 都跑。每个状态（含开工和班次结束后）拿一批探测动作去问（probes：每间房的打扫、楼层里没有的房号、
 * 补货、打电话、休息、等 0、1、1.5、上限、上限加 1 分钟、收工、回应、一个不认识的动作类型）。
 * 交给 illegalReasonForView 的 View 先深度冻结。
 *
 * 1. 对照：按 View 判定的原因和不经过 rules、按规则直接算出的原因（expectedReason）完全相同，编号和数据都相同。
 *    直接算的只读玩家已知的部分：任务单上的房号、房型、门位，状态里已知的进度，以及 params；优先级和 rules.ts 的相同。
 *    ODD_PARAMS 的楼层、房数和 rules 用到的各项数值都和三档不同，数据没从传入的参数读就会对不上。
 * 2. 和 apply 一致：原因为 null 当且仅当 apply 接受这个动作；不为 null 时 apply 抛出中文报错，写明原因里的每一项数据
 *    （mentions：房号写成数字，时刻写成钟点，份数、上限照数字写，选项照原样）；同一局里原因相同的，报错文字也相同。
 * 3. 不泄露：前缀结束后用 hideDifferently 造只差玩家还不知道的隐藏信息、种子也不同的第二个世界，在它上面逐步重放同一前缀、
 *    核对状态；前缀的每一步，每个探测动作在两个世界里的原因（编号和数据）完全相同。
 * 4. 自检（fc.sample 配固定种子）：三档和 ODD_PARAMS 各自的随机轨迹里，探测走到了按 View 能给出的 19 个编号
 *    （mustRespond 和 noSuchOption 要有待回应的事件，阶段 0 的 View 没有，见单元测试）。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toClock } from '../src/engine/clock';
import { generate } from '../src/engine/generate';
import { walkMinutes } from '../src/engine/layout';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { apply, illegalReasonForView, initial } from '../src/engine/rules';
import type { Action, IllegalReason, IllegalReasonCode, State, View, World } from '../src/engine/types';
import { hideDifferently } from './helpers/hidden';
import { ODD_PARAMS } from './helpers/params';
import { at, deepFreeze, lastOf, picksArb, playShift, RUNS, seedArb, tierArb, TIMEOUT } from './helpers/play';

/** fc.sample 的固定种子。 */
const SAMPLE_SEED = 20261116;

/** 三档和 ODD_PARAMS。 */
const PARAM_SETS = {
  standard: PARAMS.standard,
  tight: PARAMS.tight,
  weekend: PARAMS.weekend,
  odd: ODD_PARAMS,
} satisfies Record<string, Params>;
type ParamSet = keyof typeof PARAM_SETS;
const SET_NAMES: readonly ParamSet[] = ['standard', 'tight', 'weekend', 'odd'];

/** 前缀的步数和构造第二个世界用的一串数，和 rules、observe 的不泄露性质相同。 */
const prefixArb = fc.nat({ max: 120 });
const noiseArb = fc.array(fc.nat(), { minLength: 1, maxLength: 64 });

/** 楼层里没有的房号：三档和 ODD_PARAMS 都没有。 */
const NO_SUCH_ROOM = 1499;
/** 不认识的动作类型。只能绕过类型检查造出来。 */
const DANCE = { type: 'dance' } as unknown as Action;

/** 拿来问的一批动作：只用 View 和 params 列出来。 */
function probes(view: View, params: Params): Action[] {
  const limit = Math.min(params.waitStepMinutes, params.shift.hardStop - view.minute);
  return [
    ...view.rooms.map((room): Action => ({ type: 'service', room: room.id })),
    { type: 'service', room: NO_SUCH_ROOM },
    { type: 'restock' },
    { type: 'call' },
    { type: 'break' },
    { type: 'wait', minutes: 0 },
    { type: 'wait', minutes: 1 },
    { type: 'wait', minutes: 1.5 },
    { type: 'wait', minutes: limit },
    { type: 'wait', minutes: limit + 1 },
    { type: 'finish' },
    { type: 'respond', option: 'continue' },
    DANCE,
  ];
}

/**
 * 不经过 rules，按 docs/DESIGN.md 的规则从世界和状态直接算出的原因：先按优先级看班次结束、待回应的事件（阶段 0 没有）、
 * 17:00 以后、14:30 起还没休息，再看各动作自己的条件，第一条不满足的就是原因，数据取这一条用到的数。
 * 只用玩家已知的字段：任务单上的房号、房型、门位，房间进度里已知的部分，状态里的时刻、位置、布草、是否休息过。
 */
function expectedReason(world: World, state: State, action: Action): IllegalReason | null {
  const { params } = world;
  const { hardStop, breakEarliest, breakLatest } = params.shift;
  if (state.ended !== null) return { code: 'ended' };
  if (state.prompt !== null) throw new Error('阶段 0 不该有待回应的事件');
  if (state.minute >= hardStop) return action.type === 'finish' ? null : { code: 'afterHardStop', hardStop };
  if (!state.breakTaken && state.minute >= breakLatest) {
    return action.type === 'break' ? null : { code: 'mustBreak', breakLatest };
  }
  const toService = state.minute + walkMinutes(state.place, params.layout.servicePoint, params);
  switch (action.type) {
    case 'service': {
      const index = world.rooms.findIndex((room) => room.id === action.room);
      if (index < 0) return { code: 'noSuchRoom', room: action.room };
      const room = at(world.rooms, index);
      const known = at(state.rooms, index);
      if (known.doneAt !== null) return { code: 'roomDone', room: room.id };
      if (room.kind === 'departure' && !known.flaggedDeparted) return { code: 'notFlagged', room: room.id };
      if (room.kind === 'dnd' && !known.dndLiftKnown) return { code: 'dndNotLifted', room: room.id };
      // 到门口要来得及在 17:00 前敲一次门；有回来时间的，到达不早于它；第一次开门的布草要够。
      const arrival = state.minute + walkMinutes(state.place, room.place, params);
      if (arrival + params.knockRefusedMinutes > hardStop) return { code: 'cannotReachInTime', room: room.id, hardStop };
      if (known.knownAvailableFrom !== null && arrival < known.knownAvailableFrom) {
        return { code: 'comeBackLater', room: room.id, comeBackAt: known.knownAvailableFrom, arrival };
      }
      const needed = room.kind === 'departure' ? params.rooms.departure.linen : params.rooms.stayover.linen;
      if (known.workDone === 0 && state.cart < needed) return { code: 'linenShort', room: room.id, needed, cart: state.cart };
      return null;
    }
    case 'restock':
      return toService + params.cart.restockMinutes <= hardStop ? null : { code: 'restockTooLate', hardStop };
    case 'call':
      return state.minute + params.callMinutes <= hardStop ? null : { code: 'callTooLate', hardStop };
    case 'break':
      if (state.breakTaken) return { code: 'breakAlreadyTaken' };
      return toService >= breakEarliest ? null : { code: 'breakTooEarly', breakEarliest, arrival: toService };
    case 'wait': {
      const limit = Math.min(params.waitStepMinutes, hardStop - state.minute);
      const { minutes } = action;
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= limit ? null : { code: 'badWait', limit };
    }
    case 'finish': {
      if (!state.breakTaken) return { code: 'breakNotTaken' };
      // 挡收工的：没做完的退房房和续住房，以及已知摘牌却没做完的请勿打扰房，按 world.rooms 的顺序。
      const rooms = world.rooms
        .filter((room, index) => {
          const known = at(state.rooms, index);
          return known.doneAt === null && (room.kind !== 'dnd' || known.dndLiftKnown);
        })
        .map((room) => room.id);
      return rooms.length > 0 ? { code: 'roomsLeft', rooms } : null;
    }
    case 'respond':
      return { code: 'noPrompt' };
    default:
      return { code: 'unknownAction' };
  }
}

/** 原因里每一项数据在报错里的写法：房号写成数字，时刻用 toClock 写成钟点，份数和上限照数字写，选项照原样。 */
function mentions(reason: IllegalReason): string[] {
  switch (reason.code) {
    case 'ended':
    case 'mustRespond':
    case 'breakAlreadyTaken':
    case 'noPrompt':
    case 'unknownAction':
    case 'breakNotTaken':
      return [];
    case 'noSuchOption':
      return [reason.option];
    case 'afterHardStop':
    case 'restockTooLate':
    case 'callTooLate':
      return [toClock(reason.hardStop)];
    case 'mustBreak':
      return [toClock(reason.breakLatest)];
    case 'breakTooEarly':
      return [toClock(reason.breakEarliest), toClock(reason.arrival)];
    case 'badWait':
      return [String(reason.limit)];
    case 'noSuchRoom':
    case 'roomDone':
    case 'notFlagged':
    case 'dndNotLifted':
      return [String(reason.room)];
    case 'cannotReachInTime':
      return [String(reason.room), toClock(reason.hardStop)];
    case 'comeBackLater':
      return [String(reason.room), toClock(reason.comeBackAt), toClock(reason.arrival)];
    case 'linenShort':
      return [String(reason.room), String(reason.needed), String(reason.cart)];
    case 'roomsLeft':
      return reason.rooms.map(String);
  }
}

/** 中文字符，用来确认报错消息是中文。 */
const CHINESE = /[一-鿿]/;

/**
 * 两个原因相同：JSON 相同，键的个数也相同（JSON 会丢掉值为 undefined 的键）。内层循环先用它比，对不上时再交给
 * expect 的 toStrictEqual 报出差别：每个探测动作都调 expect 的话，一局要多花几倍的时间。
 */
function sameReason(a: IllegalReason | null, b: IllegalReason | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b) && Object.keys(a).length === Object.keys(b).length;
}

/** apply 的结果：接受时为 null，抛错时为报错消息；抛出的不是 Error 就让测试失败。 */
function rejection(world: World, state: State, action: Action): string | null {
  try {
    apply(world, state, action);
    return null;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw new Error(`抛出的不是 Error：${String(error)}`);
  }
}

/** 第 1、2 条性质：一局随机轨迹的每个状态、每个探测动作。只在对不上时调用 expect（见 sameReason）。 */
function expectReasonsFollowRules(world: World, picks: readonly number[]): void {
  const { states } = playShift(world, picks);
  /** 这一局里每个原因（JSON）第一次见到时的报错文字。 */
  const messages = new Map<string, string>();
  for (const state of states) {
    const view = deepFreeze(observe(world, state));
    for (const action of probes(view, world.params)) {
      const label = (): string => `${state.minute} 分钟 ${JSON.stringify(action)}`;
      const reason = illegalReasonForView(view, world.params, action);
      const expected = expectedReason(world, state, action);
      if (!sameReason(reason, expected)) expect(reason, label()).toStrictEqual(expected);
      const message = rejection(world, state, action);
      if (reason === null) {
        if (message !== null) expect(message, `${label()} 合法，apply 却不接受`).toBeNull();
        continue;
      }
      if (message === null) throw new Error(`${label()}：原因是 ${JSON.stringify(reason)}，apply 却接受了`);
      if (!CHINESE.test(message)) expect(message, label()).toMatch(CHINESE);
      for (const text of mentions(reason)) {
        if (!message.includes(text)) expect(message, `${label()} 的报错应当写明 ${text}`).toContain(text);
      }
      const key = JSON.stringify(reason);
      const seen = messages.get(key);
      if (seen === undefined) messages.set(key, message);
      else if (message !== seen) expect(message, `${label()}：原因相同，报错文字却不同`).toBe(seen);
    }
  }
}

/** 第 3 条性质：前缀的每一步，每个探测动作在两个世界里的原因完全相同。只在对不上时调用 expect。 */
function expectSameReasons(world: World, picks: readonly number[], prefixLength: number, noise: readonly number[]): void {
  const { states, actions } = playShift(world, picks, prefixLength);
  // 第二个世界的构造见 tests/helpers/hidden.ts。先在它上面逐步重放同一前缀，核对每一步的状态完全相同。
  const other = hideDifferently(world, lastOf(states), noise);
  expect(other.seed).not.toBe(world.seed);
  let replayed = initial(other);
  states.forEach((state, index) => {
    if (index > 0) replayed = apply(other, replayed, at(actions, index - 1));
    expect(replayed, `第 ${index} 步`).toStrictEqual(state);
    const view = observe(world, state);
    const otherView = observe(other, replayed);
    for (const action of probes(view, world.params)) {
      const reason = illegalReasonForView(view, world.params, action);
      const otherReason = illegalReasonForView(otherView, other.params, action);
      if (!sameReason(otherReason, reason)) {
        expect(otherReason, `${state.minute} 分钟 ${JSON.stringify(action)}`).toStrictEqual(reason);
      }
    }
  });
}

describe('性质：对照，和 apply 一致', () => {
  it(
    '三档：每个状态的每个探测动作，按 View 判定的原因和按规则直接算出的完全相同；为 null 当且仅当 apply 接受，否则 apply 的报错写明原因里的数据，原因相同的报错相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          expectReasonsFollowRules(generate(seed, PARAMS[tier]), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'ODD_PARAMS：同上；楼层、房数和 rules 用到的各项数值都和三档不同，数据没从传入的参数读就会对不上',
    () => {
      fc.assert(
        fc.property(seedArb, picksArb, (seed, picks) => {
          expectReasonsFollowRules(generate(seed, ODD_PARAMS), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：不泄露', () => {
  it(
    '三档：只差玩家还不知道的隐藏信息、种子也不同的两个世界，同一前缀的每一步，每个探测动作的原因（编号和数据）完全相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, prefixArb, noiseArb, (seed, tier, picks, prefixLength, noise) => {
          expectSameReasons(generate(seed, PARAMS[tier]), picks, prefixLength, noise);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'ODD_PARAMS：同上',
    () => {
      fc.assert(
        fc.property(seedArb, picksArb, prefixArb, noiseArb, (seed, picks, prefixLength, noise) => {
          expectSameReasons(generate(seed, ODD_PARAMS), picks, prefixLength, noise);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

/** 按 View 能给出的编号：除了要有待回应事件的 mustRespond 和 noSuchOption。 */
const VIEW_CODES: readonly IllegalReasonCode[] = [
  'ended',
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
];

describe('自检', () => {
  it('三档和 ODD_PARAMS 各自的随机轨迹里，探测走到了按 View 能给出的 19 个编号', () => {
    const counts = new Map<string, number>();
    for (const set of SET_NAMES) {
      for (const [seed, picks] of fc.sample(fc.tuple(seedArb, picksArb), { numRuns: 100, seed: SAMPLE_SEED })) {
        const world = generate(seed, PARAM_SETS[set]);
        for (const state of playShift(world, picks).states) {
          const view = observe(world, state);
          for (const action of probes(view, world.params)) {
            const reason = illegalReasonForView(view, world.params, action);
            if (reason === null) continue;
            const key = `${set}：${reason.code}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
    }
    const missing = SET_NAMES.flatMap((set) => VIEW_CODES.map((code) => `${set}：${code}`)).filter(
      (key) => (counts.get(key) ?? 0) === 0,
    );
    expect(missing, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
  });
});
