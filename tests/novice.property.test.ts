/**
 * 新手（src/policies/novice.ts）的性质测试。单元测试见 novice.test.ts。
 *
 * 一局班次的输入：参数（三档和 ODD_PARAMS）、种子、一串下标，以及新手从第几步接手。每局跑两种轨迹：
 * 随机轨迹是 playShift 默认的均匀随机挑法从开工走到结束，每个状态都是随机可达的状态，会走到 14:30 以后还没休息
 * （新手自己走不到）、17:00 以后、布草为 0、人不在服务间那一层（标准档就是 13 楼）这些局面；
 * 接手轨迹先按下标随机走几步，再交给新手一直做到班次结束
 * （从第 0 步接手就是整班都由新手做），像棋钟超时以后新手从玩家的局面接着做。交给新手的只有 observe 的结果（深度冻结）
 * 和 world.params（tests/helpers/play.ts 的 policyChooser），和模拟器的共用驱动函数约定的一样。
 *
 * 1. 契约（docs/DESIGN.md 的"策略的契约"）：两种轨迹的每个决策点，返回的动作合法；同一个 View 调两次结果相同；
 *    几个班次的决策点混在一起、打乱调用顺序，结果也相同（在决策之间记东西的写法会在这里露馅）；交给它的 View 深度冻结，
 *    改了就抛错。合法按 View 判定：在 legalActionsForView 的结果里，或者是分钟数为 1 到列出的那个等待的分钟数之间
 *    整数的等待。阶段 1 有了 illegalReasonForView 以后改用它判定。
 * 2. 行为不泄露（docs/DESIGN.md 的"公平性约束"第 2 道）：在世界 A 上跑完接手轨迹，用 hideDifferently 造只差
 *    A 跑完时仍未揭晓的隐藏信息、种子也不同的世界 B，同样地重跑，动作序列和终态必须完全相同。
 * 3. 对照新手规则：两种轨迹的每个决策点，新手的动作和按 novice.ts 文件开头的规则直接算出的动作完全相同。
 *    对照不调用新手，也不用新手"满车再判定一次"的写法，而是按 docs/DESIGN.md 的打扫条件逐条写；只读玩家已知的部分
 *    （任务单上的房型和位置、状态里已知的进度）和 params。
 * 4. 数值从 params 读：ODD_PARAMS 里新手用到的每项数值都和三档不同（numbersUsedByNovice），上面三条都在 ODD_PARAMS 下跑。
 * 5. 自检（样本都用 fc.sample 配固定种子抽，每次运行都是同一批）：随机轨迹确实走到 14:30 以后还没休息、17:00 以后、
 *    布草为 0、人不在服务间那一层；对照规则的每一种情形都走到了；从闭包里看真实世界或种子的作弊策略，
 *    在世界 B 上会走出和 A 不同的动作，第 2 条抓得到它。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/engine/generate';
import { walkMinutes } from '../src/engine/layout';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { createRng } from '../src/engine/rng';
import { legalActions, legalActionsForView } from '../src/engine/rules';
import type { Action, Minute, Policy, RoomId, State, View, World } from '../src/engine/types';
import { novice } from '../src/policies/novice';
import { hideDifferently } from './helpers/hidden';
import { numbersUsedByNovice, ODD_PARAMS } from './helpers/params';
import {
  at,
  deepFreeze,
  lastOf,
  picksArb,
  playShift,
  policyChooser,
  RUNS,
  seedArb,
  TIERS,
  TIMEOUT,
  type Trace,
} from './helpers/play';

/** fc.sample 的固定种子。 */
const SAMPLE_SEED = 20261116;
/** 自检抽多少局。 */
const SAMPLES = 200;

/** 三档和 ODD_PARAMS。 */
const PARAM_SETS = {
  standard: PARAMS.standard,
  tight: PARAMS.tight,
  weekend: PARAMS.weekend,
  odd: ODD_PARAMS,
} satisfies Record<string, Params>;
type ParamSet = keyof typeof PARAM_SETS;
const SET_NAMES: readonly ParamSet[] = ['standard', 'tight', 'weekend', 'odd'];

/** 一局班次的输入。 */
interface ShiftInput {
  set: ParamSet;
  seed: string;
  picks: number[];
  /** 新手从第几步（从 0 数）接手。 */
  takeOverAt: number;
}

/** 新手从第几步接手：一半是整班都由新手做（0），一半先随机走 1 到 150 步。 */
const takeOverArb = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 150 }));

const shiftArb: fc.Arbitrary<ShiftInput> = fc.record({
  set: fc.constantFrom(...SET_NAMES),
  seed: seedArb,
  picks: picksArb,
  takeOverAt: takeOverArb,
});

/** 构造第二个世界用的一串数，和 observe、rules 的不泄露性质用的相同。 */
const noiseArb = fc.array(fc.nat(), { minLength: 1, maxLength: 64 });

/** 一局的世界和两种轨迹（见文件开头）。 */
interface Shift {
  world: World;
  random: Trace;
  takeOver: Trace;
}

function shiftOf(input: ShiftInput): Shift {
  const world = generate(input.seed, PARAM_SETS[input.set]);
  return {
    world,
    random: playShift(world, input.picks),
    takeOver: playShift(world, input.picks, Number.POSITIVE_INFINITY, policyChooser(novice, input.takeOverAt)),
  };
}

/** 几条轨迹里全部的决策点：班次还没结束的状态。 */
function decisionStates(...traces: Trace[]): State[] {
  return traces.flatMap((trace) => trace.states.filter((state) => state.ended === null));
}

/** 交给新手的 View：observe 的结果，深度冻结。 */
function viewOf(world: World, state: State): View {
  return deepFreeze(observe(world, state));
}

/**
 * 按 View 判定合法：在 legalActionsForView 的结果里；或者是等待，这时列表里也有等待，分钟数是 1 到列出的那个等待的
 * 分钟数之间的整数（列表只列上限那一档）。
 */
function expectAllowed(action: Action, view: View, params: Params, label: string): void {
  const legal = legalActionsForView(view, params);
  if (action.type !== 'wait') {
    expect(legal, label).toContainEqual(action);
    return;
  }
  const listed = legal.find((candidate) => candidate.type === 'wait');
  expect(listed, `${label}：这时不能等待`).toBeDefined();
  const limit = listed?.type === 'wait' ? listed.minutes : 0;
  expect(Number.isInteger(action.minutes), label).toBe(true);
  expect(action.minutes, label).toBeGreaterThanOrEqual(1);
  expect(action.minutes, label).toBeLessThanOrEqual(limit);
}

/** 对照规则算出的动作，以及这一步落在哪几种情形里（报错信息和自检用）。 */
interface Expected {
  action: Action;
  cases: string[];
}

/**
 * 按 novice.ts 文件开头的规则，直接从 world 和 state 算新手该做的动作。不调用新手，也不用"满车再判定一次"：
 * 能不能进、布草够不够、补货和打电话来不来得及、能不能收工，都照 docs/DESIGN.md 的规则逐条写出来。
 * 只读玩家已知的部分：任务单上的房型和位置、状态里已知的进度、日志，以及 params；不读脏乱、退房时刻、出门时刻和摘牌时刻。
 */
function expectedChoice(world: World, state: State): Expected {
  const { params } = world;
  const { hardStop, breakLatest } = params.shift;
  if (state.minute >= hardStop) return { action: { type: 'finish' }, cases: ['17:00 起收工还车'] };
  if (!state.breakTaken && state.minute >= params.novice.breakAt) {
    return { action: { type: 'break' }, cases: [state.minute >= breakLatest ? '14:30 起只能休息' : '到了 12:30 去休息'] };
  }

  // 能做的房间。
  const cases: string[] = [];
  const toService = walkMinutes(state.place, params.layout.servicePoint, params);
  const canRestock = state.minute + toService + params.cart.restockMinutes <= hardStop;
  const options: { id: RoomId; walk: Minute; linenEnough: boolean }[] = [];
  world.rooms.forEach((room, index) => {
    const known = at(state.rooms, index);
    if (known.doneAt !== null) return;
    if (room.kind === 'departure' && !known.flaggedDeparted) return;
    if (room.kind === 'dnd' && !known.dndLiftKnown) return;
    const walk = walkMinutes(state.place, room.place, params);
    const arrival = state.minute + walk;
    // 到门口还来得及在 17:00 前敲一次门；有回来时间的，到达不早于它。
    if (arrival + params.knockRefusedMinutes > hardStop) return;
    if (known.knownAvailableFrom !== null && arrival < known.knownAvailableFrom) return;
    // 第一次开门要扣布草，续做不扣。
    const linen = room.kind === 'departure' ? params.rooms.departure.linen : params.rooms.stayover.linen;
    const linenEnough = known.workDone > 0 || state.cart >= linen;
    if (!linenEnough && params.cart.capacity < linen) return;
    if (!linenEnough && !canRestock) {
      cases.push('布草不够又来不及补货的房间不算');
      return;
    }
    options.push({ id: room.id, walk, linenEnough });
  });

  if (options.length > 0) {
    const nearest = Math.min(...options.map((option) => option.walk));
    const tied = options.filter((option) => option.walk === nearest);
    const chosen = at(tied, 0);
    if (tied.length > 1) cases.push('一样近的有几间，取排在前面的');
    if (chosen.linenEnough) return { action: { type: 'service', room: chosen.id }, cases: [...cases, '去最近的房间'] };
    if (options.some((option) => option.linenEnough)) cases.push('更远的房间布草够，也先补货');
    return { action: { type: 'restock' }, cases: [...cases, '布草不够，先补货'] };
  }

  // 没房可做。
  const mayTell = world.rooms.some((room, index) => {
    const known = at(state.rooms, index);
    return (room.kind === 'departure' && !known.flaggedDeparted) || (room.kind === 'dnd' && !known.dndLiftKnown);
  });
  const justCalled = state.log.at(-1)?.action.type === 'call';
  const canCall = state.minute + params.callMinutes <= hardStop;
  if (mayTell && !justCalled && canCall) return { action: { type: 'call' }, cases: [...cases, '没房可做，打电话'] };
  const reason = !mayTell ? '问不出新消息' : justCalled ? '刚打过电话' : '来不及打电话';
  // 收工的条件：已休息；除了还不知道摘牌的请勿打扰房，房间都做完了。
  const canFinish =
    state.breakTaken &&
    world.rooms.every((room, index) => {
      const known = at(state.rooms, index);
      return known.doneAt !== null || (room.kind === 'dnd' && !known.dndLiftKnown);
    });
  if (canFinish) return { action: { type: 'finish' }, cases: [...cases, `没房可做，${reason}，收工`] };
  const minutes = Math.min(params.waitStepMinutes, hardStop - state.minute);
  return { action: { type: 'wait', minutes }, cases: [...cases, `没房可做，${reason}，等待`] };
}

describe('性质：契约', () => {
  it(
    '两种轨迹（含随机可达的 14:30 以后还没休息、17:00 以后、布草为 0、人不在服务间那一层）的每个决策点：交给它深度冻结的 View，返回的动作合法，同一个 View 调两次结果相同；接手轨迹都走到了班次结束',
    () => {
      fc.assert(
        fc.property(shiftArb, (input) => {
          const { world, random, takeOver } = shiftOf(input);
          // 接手轨迹里新手的每个动作都由 apply 校验过（非法就抛错）；这里再按 View 核对一遍。
          expect(lastOf(takeOver.states).ended).not.toBeNull();
          for (const state of decisionStates(random, takeOver)) {
            const view = viewOf(world, state);
            const action = novice(view, world.params);
            expectAllowed(action, view, world.params, `${state.minute} 分钟`);
            expect(novice(view, world.params), `${state.minute} 分钟`).toStrictEqual(action);
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '打乱调用顺序：几局（不同的世界和参数）的决策点混在一起，按顺序调一遍，再按打乱的顺序调一遍，每个 View 的动作都相同',
    () => {
      fc.assert(
        fc.property(fc.array(shiftArb, { minLength: 2, maxLength: 3 }), fc.string(), (inputs, shuffleSeed) => {
          const points = inputs.flatMap((input) => {
            const { world, random, takeOver } = shiftOf(input);
            return decisionStates(random, takeOver).map((state) => ({ view: viewOf(world, state), params: world.params }));
          });
          const inOrder = points.map(({ view, params }) => novice(view, params));
          const shuffled = new Array<Action>(points.length);
          for (const index of createRng(shuffleSeed).shuffle(points.map((_, i) => i))) {
            const { view, params } = at(points, index);
            shuffled[index] = novice(view, params);
          }
          expect(shuffled).toStrictEqual(inOrder);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：行为不泄露', () => {
  it(
    '在世界 A 上跑完接手轨迹，再在只差 A 跑完时仍未揭晓的隐藏信息、种子也不同的世界 B 上同样地重跑：动作序列和终态完全相同',
    () => {
      fc.assert(
        fc.property(shiftArb, noiseArb, (input, noise) => {
          const world = generate(input.seed, PARAM_SETS[input.set]);
          const chooser = policyChooser(novice, input.takeOverAt);
          const a = playShift(world, input.picks, Number.POSITIVE_INFINITY, chooser);
          const other = hideDifferently(world, lastOf(a.states), noise);
          expect(other.seed).not.toBe(world.seed);
          const b = playShift(other, input.picks, Number.POSITIVE_INFINITY, chooser);
          expect(b.actions).toStrictEqual(a.actions);
          expect(lastOf(b.states)).toStrictEqual(lastOf(a.states));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：对照新手规则', () => {
  it(
    '三档和 ODD_PARAMS，两种轨迹的每个决策点：新手的动作和按规则直接算出的完全相同；按规则算出的动作本身也在 legalActions 里',
    () => {
      fc.assert(
        fc.property(shiftArb, (input) => {
          const { world, random, takeOver } = shiftOf(input);
          for (const state of decisionStates(random, takeOver)) {
            const expected = expectedChoice(world, state);
            const label = `${state.minute} 分钟：${expected.cases.join('；')}`;
            expect(legalActions(world, state), label).toContainEqual(expected.action);
            expect(novice(viewOf(world, state), world.params), label).toStrictEqual(expected.action);
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：数值从 params 读', () => {
  it('ODD_PARAMS 里新手用到的每项数值都和三档不同（上面几条性质都在 ODD_PARAMS 下跑过），它的休息时刻也在休息窗口里', () => {
    const odd = numbersUsedByNovice(ODD_PARAMS);
    for (const tier of TIERS) {
      const base = numbersUsedByNovice(PARAMS[tier]);
      for (const [name, value] of Object.entries(odd)) expect(value, `${tier} 档的 ${name}`).not.toBe(base[name]);
    }
    expect(ODD_PARAMS.novice.breakAt).toBeGreaterThanOrEqual(ODD_PARAMS.shift.breakEarliest);
    expect(ODD_PARAMS.novice.breakAt).toBeLessThan(ODD_PARAMS.shift.breakLatest);
  });
});

/** 契约要求随机可达的状态里一定要有的几种局面。 */
const HARD_STATES: readonly [string, (world: World, state: State) => boolean][] = [
  [
    '14:30 以后还没休息',
    (world, state) =>
      !state.breakTaken && state.minute >= world.params.shift.breakLatest && state.minute < world.params.shift.hardStop,
  ],
  ['17:00 以后', (world, state) => state.minute >= world.params.shift.hardStop],
  ['布草为 0', (_world, state) => state.cart === 0],
  ['人不在服务间那一层', (world, state) => state.place.floor !== world.params.layout.servicePoint.floor],
];

/** 对照规则的每一种情形，自检要求都走到。 */
const ALL_CASES: readonly string[] = [
  '17:00 起收工还车',
  '到了 12:30 去休息',
  '14:30 起只能休息',
  '去最近的房间',
  '一样近的有几间，取排在前面的',
  '布草不够，先补货',
  '更远的房间布草够，也先补货',
  '布草不够又来不及补货的房间不算',
  '没房可做，打电话',
  '没房可做，刚打过电话，等待',
  '没房可做，刚打过电话，收工',
  '没房可做，问不出新消息，等待',
  '没房可做，问不出新消息，收工',
  '没房可做，来不及打电话，等待',
];

/** 作弊的新手：照新手的规则做，只是从闭包里拿到真实世界，去续住房和请勿打扰房之前看一眼客人真实的出门时刻，客人还在就先等。 */
function peekingAtGuests(world: World): Policy {
  return (view, params) => {
    const action = novice(view, params);
    if (action.type !== 'service') return action;
    const room = world.rooms.find((candidate) => candidate.id === action.room);
    if (room === undefined || room.kind === 'departure') return action;
    if (view.minute + walkMinutes(view.place, room.place, params) >= room.availableFrom) return action;
    // 新手选了打扫，说明不在 17:00 以后、也不在必须休息的时候，这时总能等待。
    return legalActionsForView(view, params).find((candidate) => candidate.type === 'wait') ?? action;
  };
}

/** 作弊的新手：照新手的规则做，只是从闭包里拿到种子，种子的长度是奇数时，开工第一步先等 1 分钟。 */
function peekingAtSeed(world: World): Policy {
  return (view, params) =>
    view.log.length === 0 && world.seed.length % 2 === 1 ? { type: 'wait', minutes: 1 } : novice(view, params);
}

describe('自检', () => {
  it('三档和 ODD_PARAMS 各自的随机轨迹里，都有 14:30 以后还没休息、17:00 以后（班次还没结束）、布草为 0、人不在服务间那一层的决策点', () => {
    const counts = new Map<string, number>();
    for (const input of fc.sample(shiftArb, { numRuns: SAMPLES, seed: SAMPLE_SEED })) {
      const world = generate(input.seed, PARAM_SETS[input.set]);
      for (const state of decisionStates(playShift(world, input.picks))) {
        for (const [name, holds] of HARD_STATES) {
          const key = `${input.set}：${name}`;
          if (holds(world, state)) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    const missing = SET_NAMES.flatMap((set) => HARD_STATES.map(([name]) => `${set}：${name}`)).filter(
      (key) => (counts.get(key) ?? 0) === 0,
    );
    expect(missing, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
  });

  it('对照规则的每一种情形，在两种轨迹的决策点里都走到了', () => {
    const counts = new Map<string, number>();
    for (const input of fc.sample(shiftArb, { numRuns: SAMPLES, seed: SAMPLE_SEED })) {
      const { world, random, takeOver } = shiftOf(input);
      for (const state of decisionStates(random, takeOver)) {
        for (const name of expectedChoice(world, state).cases) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const missing = ALL_CASES.filter((name) => (counts.get(name) ?? 0) === 0);
    expect(missing, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
  });

  it('从闭包里看客人出门时刻或种子的作弊策略，在世界 B 上走出和 A 不同的动作，不泄露性质抓得到；老实的新手一局也不会', () => {
    // 整班都由策略做（看种子的作弊策略只在开工第一步作弊），世界 B 的构造和不泄露性质相同。
    const samples = fc.sample(fc.tuple(fc.constantFrom(...SET_NAMES), seedArb, noiseArb), {
      numRuns: 50,
      seed: SAMPLE_SEED,
    });
    const diverging = (policyFor: (world: World) => Policy): number =>
      samples.filter(([set, seed, noise]) => {
        const world = generate(seed, PARAM_SETS[set]);
        const a = playShift(world, [0], Number.POSITIVE_INFINITY, policyChooser(policyFor(world)));
        const other = hideDifferently(world, lastOf(a.states), noise);
        const b = playShift(other, [0], Number.POSITIVE_INFINITY, policyChooser(policyFor(other)));
        return JSON.stringify(b.actions) !== JSON.stringify(a.actions);
      }).length;
    expect(diverging(() => novice)).toBe(0);
    expect(diverging(peekingAtGuests)).toBeGreaterThan(0);
    // B 的种子比 A 多 7 个字符，长度的奇偶一定不同：每一局都在第一步分叉。
    expect(diverging(peekingAtSeed)).toBe(samples.length);
  });
});
