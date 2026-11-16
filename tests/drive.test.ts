/**
 * 共用驱动函数 runShift（src/engine/drive.ts）的测试。新手经 runShift 跑的行为不泄露测试在 novice.property.test.ts。
 *
 * 1. 交给幽灵什么：只看 View 的策略每一步收到的恰好是两个参数，第一个等于 observe(world, 这一步的状态)，并且深度冻结，
 *    第二个就是 world.params 本身；全知每一步收到的恰好是两个参数，就是 world 本身和这一步的状态本身，都深度冻结。
 *    调用的次数等于动作数，幽灵返回的动作原样记进 actions。
 * 2. 返回的状态和逐步 apply 的一致：states[0] 就是起始状态，states[i + 1] 等于 apply(world, states[i], actions[i])，
 *    final 是最后一个状态，班次已经结束，前面的都还没结束。新手经 runShift 走出的轨迹和经 tests/helpers/play.ts 的
 *    policyChooser 走出的相同；真正的全知经 runShift 走出的动作和直接逐步调用它的相同。
 * 3. 起始状态：默认是 initial(world)；可以从中途的状态起（像棋钟超时以后新手接手）；起始状态的班次已经结束时不调用幽灵。
 * 4. 非法动作：apply 的报错原样抛出，消息和直接 apply 这个动作的相同。
 * 5. 冻结：策略改 View（含日志条目），全知改 world 或 state，都抛 TypeError。
 * 6. 步数上界是 hardStop + world.events.length + 1，从 world.params 读：休息只要 1 分钟、每次只等 1 分钟的策略从开工起
 *    正好走满上界；从开工前 1 分钟起（规则走不到的状态，只用来多走一步）就抛错；世界里多一个事件，上界跟着多一步。
 * 7. 第 1、2 条（含第 3 条的中途起始状态）是性质测试，在三档和 ODD_PARAMS 下跑：种子、一串下标、从第几步交给幽灵（先按下标随机走几步），
 *    以及哪个幽灵：新手；按分钟数从合法动作里挑的只看 View 的策略（会走进 17:00 截断、14:30 强制休息这些新手不去的局面）；
 *    同样挑法、拿 world 和 state 的全知一类的策略（真正的全知太慢，另有一个固定种子的用例）。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runShift, type Ghost, type ShiftRun } from '../src/engine/drive';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { apply, initial, legalActions, legalActionsForView } from '../src/engine/rules';
import type { Action, OraclePolicy, Policy, State, World } from '../src/engine/types';
import { novice } from '../src/policies/novice';
import { oracle } from '../src/policies/oracle';
import { errorOf } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import {
  at,
  lastOf,
  objectsIn,
  picksArb,
  playShift,
  policyChooser,
  RUNS,
  seedArb,
  TIMEOUT,
} from './helpers/play';

/** 三档和 ODD_PARAMS。 */
const PARAM_SETS = {
  standard: PARAMS.standard,
  tight: PARAMS.tight,
  weekend: PARAMS.weekend,
  odd: ODD_PARAMS,
} satisfies Record<string, Params>;
type ParamSet = keyof typeof PARAM_SETS;
const SET_NAMES: readonly ParamSet[] = ['standard', 'tight', 'weekend', 'odd'];

/** 只看 View 的策略：按现在的分钟数从合法动作里挑一个。无记忆、确定；只返回列出的动作，所以一定走得到班次结束。 */
const byMinute: Policy = (view, params) => {
  const legal = legalActionsForView(view, params);
  return at(legal, view.minute % legal.length);
};

/** 全知一类的策略：拿 world 和 state，挑法和 byMinute 相同。 */
const byMinuteOracle: OraclePolicy = (world, state) => {
  const legal = legalActions(world, state);
  return at(legal, state.minute % legal.length);
};

/** 性质测试里的幽灵（见文件开头第 7 条）。 */
const GHOSTS = {
  novice: { kind: 'view', policy: novice },
  byMinute: { kind: 'view', policy: byMinute },
  byMinuteOracle: { kind: 'oracle', policy: byMinuteOracle },
} satisfies Record<string, Ghost>;
type GhostName = keyof typeof GHOSTS;
const GHOST_NAMES: readonly GhostName[] = ['novice', 'byMinute', 'byMinuteOracle'];

/** 一次调用：收到的全部参数和返回的动作。 */
interface Call {
  args: readonly unknown[];
  action: Action;
}

/** 包一层的幽灵：照原样交给 inner，记下每次调用收到的全部参数和返回的动作。 */
function spied(ghost: Ghost): { ghost: Ghost; calls: Call[] } {
  const calls: Call[] = [];
  if (ghost.kind === 'view') {
    const inner = ghost.policy;
    const policy: Policy = (...args) => {
      const action = inner(...args);
      calls.push({ args, action });
      return action;
    };
    return { ghost: { kind: 'view', policy }, calls };
  }
  const inner = ghost.policy;
  const policy: OraclePolicy = (...args) => {
    const action = inner(...args);
    calls.push({ args, action });
    return action;
  };
  return { ghost: { kind: 'oracle', policy }, calls };
}

/** value 和从它能走到的全部对象、数组都冻结了。 */
function allFrozen(value: unknown): boolean {
  return [...objectsIn(value)].every((node) => Object.isFrozen(node));
}

/** 第 1 条：每一步交给幽灵的恰好是该给的两个参数，深度冻结；返回的动作原样记进 actions。 */
function expectHandedOver(world: World, run: ShiftRun, kind: Ghost['kind'], calls: readonly Call[]): void {
  expect(calls).toHaveLength(run.actions.length);
  calls.forEach(({ args, action }, step) => {
    const label = `第 ${step} 步`;
    const state = at(run.states, step);
    expect(args, label).toHaveLength(2);
    const [first, second] = args;
    if (kind === 'view') {
      expect(first, label).toStrictEqual(observe(world, state));
      expect(second, label).toBe(world.params);
      expect(allFrozen(first), `${label}：View 深度冻结`).toBe(true);
    } else {
      expect(first, label).toBe(world);
      expect(second, label).toBe(state);
      expect(allFrozen(first) && allFrozen(second), `${label}：world 和 state 深度冻结`).toBe(true);
    }
    expect(at(run.actions, step), label).toBe(action);
  });
}

/** 第 2 条：返回的状态和从起始状态逐步 apply 的一致。 */
function expectReplays(world: World, run: ShiftRun, start: State): void {
  expect(run.states[0]).toBe(start);
  expect(run.states).toHaveLength(run.actions.length + 1);
  run.actions.forEach((action, step) => {
    const before = at(run.states, step);
    expect(before.ended, `第 ${step} 步之前班次还没结束`).toBeNull();
    expect(at(run.states, step + 1), `第 ${step} 步`).toStrictEqual(apply(world, before, action));
  });
  expect(run.final).toBe(lastOf(run.states));
  expect(run.final.ended).not.toBeNull();
}

/** 性质测试的一个样本（见文件开头第 7 条）。 */
interface Case {
  set: ParamSet;
  seed: string;
  picks: number[];
  /** 先按下标随机走几步再交给幽灵；班次提前结束就从结束的状态起。 */
  takeOverAt: number;
  ghost: GhostName;
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  set: fc.constantFrom(...SET_NAMES),
  seed: seedArb,
  picks: picksArb,
  takeOverAt: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 150 })),
  ghost: fc.constantFrom(...GHOST_NAMES),
});

/** 样本的世界和起始状态：从开工起按下标随机走 takeOverAt 步。 */
function startOf(input: Case): { world: World; start: State } {
  const world = generate(input.seed, PARAM_SETS[input.set]);
  return { world, start: lastOf(playShift(world, input.picks, input.takeOverAt).states) };
}

describe('性质：交给幽灵什么，返回的状态和逐步 apply 的一致', () => {
  it(
    '三档和 ODD_PARAMS，从开工或随机可达的中途状态起：只看 View 的策略收到深度冻结的 observe 结果和 world.params，全知一类的收到 world 和 state 本身；states 和逐步 apply 的一致，final 已经结束',
    () => {
      fc.assert(
        fc.property(caseArb, (input) => {
          const { world, start } = startOf(input);
          const ghost = GHOSTS[input.ghost];
          const spy = spied(ghost);
          const run = runShift(world, spy.ghost, start);
          expectHandedOver(world, run, ghost.kind, spy.calls);
          expectReplays(world, run, start);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '新手经 runShift 从中途接手，走出的动作和状态和经 policyChooser 走出的相同',
    () => {
      fc.assert(
        fc.property(caseArb, (input) => {
          const { world, start } = startOf(input);
          const run = runShift(world, GHOSTS.novice, start);
          const trace = playShift(world, input.picks, Number.POSITIVE_INFINITY, policyChooser(novice, input.takeOverAt));
          // 接手之前的随机步数：班次提前结束时比 takeOverAt 少。
          const before = trace.actions.length - run.actions.length;
          expect(at(trace.states, before)).toStrictEqual(start);
          expect(trace.actions.slice(before)).toStrictEqual(run.actions);
          expect(trace.states.slice(before)).toStrictEqual(run.states);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('runShift：起始状态和真正的全知', () => {
  it('不给起始状态时从 initial(world) 开工', () => {
    const world = generate('drive-default', PARAMS.standard);
    const run = runShift(world, GHOSTS.novice);
    expect(run.states[0]).toStrictEqual(initial(world));
    expectReplays(world, run, at(run.states, 0));
  });

  it('起始状态的班次已经结束：不调用幽灵，没有动作，final 就是起始状态', () => {
    const world = generate('drive-ended', PARAMS.standard);
    const ended = runShift(world, GHOSTS.novice).final;
    for (const name of GHOST_NAMES) {
      const spy = spied(GHOSTS[name]);
      const run = runShift(world, spy.ghost, ended);
      expect(spy.calls, name).toEqual([]);
      expect(run.actions, name).toEqual([]);
      expect(run.states, name).toEqual([ended]);
      expect(run.final, name).toBe(ended);
    }
  });

  it(
    '真正的全知（三档和 ODD_PARAMS 各一局）：每一步收到 world 本身和这一步的状态本身，都深度冻结；动作和直接逐步调用全知的相同',
    () => {
      for (const set of SET_NAMES) {
        const world = generate(`drive-oracle-${set}`, PARAM_SETS[set]);
        const spy = spied({ kind: 'oracle', policy: oracle });
        const run = runShift(world, spy.ghost);
        expectHandedOver(world, run, 'oracle', spy.calls);
        expectReplays(world, run, at(run.states, 0));
        const actions: Action[] = [];
        let state = initial(world);
        while (state.ended === null) {
          const action = oracle(world, state);
          actions.push(action);
          state = apply(world, state, action);
        }
        expect(run.actions, set).toStrictEqual(actions);
      }
    },
    TIMEOUT,
  );
});

describe('runShift：非法动作', () => {
  const world = generate('drive-illegal', PARAMS.standard);
  const start = initial(world);

  it('只看 View 的策略开工就收工（还没休息）、等 0 分钟：抛出的就是 apply 的报错', () => {
    const illegal: Action[] = [{ type: 'finish' }, { type: 'wait', minutes: 0 }];
    for (const action of illegal) {
      const expected = errorOf(() => apply(world, start, action));
      expect(errorOf(() => runShift(world, { kind: 'view', policy: () => action })), JSON.stringify(action)).toBe(expected);
    }
  });

  it('全知一类的策略要打扫不存在的房间：抛出的就是 apply 的报错', () => {
    const action: Action = { type: 'service', room: 9999 };
    const expected = errorOf(() => apply(world, start, action));
    expect(expected).toMatch('9999');
    expect(errorOf(() => runShift(world, { kind: 'oracle', policy: () => action }))).toBe(expected);
  });

  it('走到第 3 步才返回非法动作：抛出的是那一步的状态上 apply 的报错', () => {
    // 前 3 步照新手做，第 4 个动作（日志里已有 3 条）要打扫一间已经做完、或者还不能做的房间：每间都试，取第一间非法的。
    const third = at(playShift(world, [0], 3, policyChooser(novice)).states, 3);
    const room = world.rooms.find((candidate) => {
      try {
        apply(world, third, { type: 'service', room: candidate.id });
        return false;
      } catch {
        return true;
      }
    });
    if (room === undefined) throw new Error('第 3 步之后每间房都能做，换一个种子');
    const action: Action = { type: 'service', room: room.id };
    const policy: Policy = (view, params) => (view.log.length === 3 ? action : novice(view, params));
    expect(errorOf(() => runShift(world, { kind: 'view', policy }))).toBe(errorOf(() => apply(world, third, action)));
  });
});

describe('runShift：交给幽灵的东西深度冻结，改了就抛 TypeError', () => {
  it('只看 View 的策略改 View 本身、房间、或者日志条目（日志条目和 State 共用）', () => {
    const world = generate('drive-freeze', PARAMS.standard);
    const mutations: ((view: Parameters<Policy>[0]) => void)[] = [
      (view) => {
        (view as { minute: number }).minute = 0;
      },
      (view) => {
        (at(view.rooms, 0) as { doneAt: number | null }).doneAt = 0;
      },
      (view) => {
        (at(view.log, 0) as { end: number }).end = 0;
      },
    ];
    mutations.forEach((mutate, index) => {
      const policy: Policy = (view, params) => {
        // 第三种要等日志里有了条目才改得到：先照新手做一步。
        if (index < 2 || view.log.length > 0) mutate(view);
        return novice(view, params);
      };
      expect(() => runShift(world, { kind: 'view', policy }), `第 ${index} 种`).toThrow(TypeError);
    });
  });

  it('全知一类的策略改 world 的房间、改 state 本身、改 state 的房间数组', () => {
    const mutations: ((world: World, state: State) => void)[] = [
      (world) => {
        at(world.rooms, 0).mess = 'tidy';
      },
      (_world, state) => {
        state.minute = 0;
      },
      (_world, state) => {
        state.rooms.reverse();
      },
    ];
    mutations.forEach((mutate, index) => {
      // 每种用一个新的世界：上一种冻结了它。
      const world = generate(`drive-freeze-${index}`, PARAMS.standard);
      const policy: OraclePolicy = (w, s) => {
        mutate(w, s);
        return byMinuteOracle(w, s);
      };
      expect(() => runShift(world, { kind: 'oracle', policy }), `第 ${index} 种`).toThrow(TypeError);
    });
  });
});

describe('runShift：步数上界是 hardStop + world.events.length + 1', () => {
  // 休息只要 1 分钟。其余是 ODD_PARAMS：17:00 是 480，14:30 是 300，上界是 481 步。
  const QUICK_BREAK: Params = { ...ODD_PARAMS, shift: { ...ODD_PARAMS.shift, breakMinutes: 1 } };
  const { hardStop, breakLatest } = QUICK_BREAK.shift;

  /** 能等就等 1 分钟；不能等时（14:30 起只能休息、17:00 起只能还车）就休息或还车。人一直在服务间。 */
  const oneMinuteAtATime: Policy = (view, params) => {
    const legal = legalActionsForView(view, params);
    if (legal.some((action) => action.type === 'wait')) return { type: 'wait', minutes: 1 };
    const next = legal.find((action) => action.type === 'break' || action.type === 'finish');
    if (next === undefined) throw new Error('既不能等待，也不能休息或还车');
    return next;
  };
  const ghost: Ghost = { kind: 'view', policy: oneMinuteAtATime };

  it('从开工起：等到 14:30、休息 1 分钟、等到 17:00、还车，正好 hardStop + 1 步，不抛错', () => {
    const world = generate('drive-bound', QUICK_BREAK);
    const run = runShift(world, ghost);
    expect(run.actions).toHaveLength(hardStop + 1);
    expect(run.actions.filter((action) => action.type === 'wait')).toHaveLength(hardStop - 1);
    expect(at(run.states, breakLatest).minute).toBe(breakLatest);
    expect(run.final.ended).toBe('hardStop');
  });

  it('从开工前 1 分钟起（规则走不到的状态）要多走一步：走满 hardStop + 1 步就抛错，报错写明步数', () => {
    const world = generate('drive-bound', QUICK_BREAK);
    const early: State = { ...initial(world), minute: -1 };
    expect(errorOf(() => runShift(world, ghost, early))).toMatch(`走了 ${hardStop + 1} 步，班次还没结束`);
  });

  it('世界里多一个事件（阶段 0 的规则不读事件），上界多一步：同样从开工前 1 分钟起，走 hardStop + 2 步做完', () => {
    const plain = generate('drive-bound', QUICK_BREAK);
    const world: World = { ...plain, events: [{ type: 'extraTowels', at: hardStop }] };
    const run = runShift(world, ghost, { ...initial(world), minute: -1 });
    expect(run.actions).toHaveLength(hardStop + 2);
    expect(run.final.ended).toBe('hardStop');
  });
});
