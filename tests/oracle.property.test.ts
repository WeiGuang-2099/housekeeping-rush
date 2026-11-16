/**
 * 全知（src/policies/oracle.ts）的性质测试。单元测试见 oracle.test.ts。
 *
 * 一局班次的输入：参数（三档和 ODD_PARAMS）、种子、一串下标，以及全知从第几步接手。每局跑两种轨迹：
 * 随机轨迹是 playShift 默认的均匀随机挑法从开工走到结束，每个状态都是随机可达的状态，会走到 14:30 以后还没休息、
 * 17:00 以后、布草为 0、敲门被拒过、做到一半被 17:00 截断这些全知自己不会走进去的局面；接手轨迹先按下标随机走几步，
 * 再交给全知一直做到班次结束（从第 0 步接手就是整班都由全知做）。交给全知的是深度冻结的 world 和 state，
 * 和共用驱动函数 runShift（src/engine/drive.ts）约定的一样：全知拿 world 和 state。全知每个决策点都要搜一遍，比新手慢得多，
 * 所以这里每条性质跑的局数比别的性质测试少。
 *
 * 1. 契约：两种轨迹的每个决策点，返回的动作合法（illegalReasonForView 返回 null：和 apply 同一个判定，全知的动作也只能是
 *    玩家能做的动作，等待的 1 到上限之间的整数分钟都合法）；
 *    同样的输入调两次结果相同（oracle 和 oraclePlan 的第一个动作是两次独立的调用）；几局的决策点混在一起、
 *    打乱调用顺序，结果也相同；交给它的 world 和 state 深度冻结，改了就抛错。接手轨迹都走到了班次结束。
 * 2. 计划和规则一致（oracle.ts 文件开头第 7 条）：两种轨迹的每个决策点，用 apply 重放 oraclePlan 的全部动作，
 *    每个动作都合法（apply 校验），重放完班次结束，score 的等效下班时间和计划给出的完全相同。
 * 3. 不差于新手：固定种子的一批班次（三档和 ODD_PARAMS 各一批），整班都由全知做，平均等效下班时间不差于新手；
 *    每一局开工时的计划都不差于新手整班的成绩（新手的走法是候选）。新手用 policyChooser 驱动。
 * 4. 数值从 params 读：ODD_PARAMS 里全知直接读的每项数值都和三档不同（numbersUsedByOracle），上面几条都在 ODD_PARAMS 下跑。
 * 5. 自检（样本用 fc.sample 配固定种子抽）：随机轨迹的决策点确实走到了第 2 条要覆盖的那些局面。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { createRng } from '../src/engine/rng';
import { illegalReasonForView, initial } from '../src/engine/rules';
import { score } from '../src/engine/score';
import type { Action, State, World } from '../src/engine/types';
import { novice } from '../src/policies/novice';
import { oracle, oraclePlan } from '../src/policies/oracle';
import { play } from './helpers/drive';
import { numbersUsedByOracle, ODD_PARAMS } from './helpers/params';
import {
  at,
  choose,
  deepFreeze,
  lastOf,
  picksArb,
  playShift,
  policyChooser,
  seedArb,
  TIERS,
  TIMEOUT,
  type Chooser,
  type Trace,
} from './helpers/play';

/** 每条性质跑多少局：全知每个决策点都要搜一遍，比别的性质测试少。 */
const ORACLE_RUNS = 25;
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

/** 一局班次的输入。 */
interface ShiftInput {
  set: ParamSet;
  seed: string;
  picks: number[];
  /** 全知从第几步（从 0 数）接手。 */
  takeOverAt: number;
}

/** 全知从第几步接手：一半是整班都由全知做（0），一半先随机走 1 到 150 步。 */
const takeOverArb = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 150 }));

const shiftArb: fc.Arbitrary<ShiftInput> = fc.record({
  set: fc.constantFrom(...SET_NAMES),
  seed: seedArb,
  picks: picksArb,
  takeOverAt: takeOverArb,
});

/** 交给全知的和驱动函数约定的一样：world 和 state，都深度冻结。 */
function decide(world: World, state: State): Action {
  return oracle(deepFreeze(world), deepFreeze(state));
}

/** 把全知当挑法：第 step 步在 takeOverAt 之前按下标挑，从 takeOverAt 起交给全知，一直到班次结束。 */
function oracleChooser(takeOverAt = 0): Chooser {
  return (legal, picks, step, world, state) => (step < takeOverAt ? choose(legal, picks, step) : decide(world, state));
}

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
    takeOver: playShift(world, input.picks, Number.POSITIVE_INFINITY, oracleChooser(input.takeOverAt)),
  };
}

/** 几条轨迹里全部的决策点：班次还没结束的状态。 */
function decisionStates(...traces: Trace[]): State[] {
  return traces.flatMap((trace) => trace.states.filter((state) => state.ended === null));
}

/**
 * 合法：按这一步的 View 判定，illegalReasonForView 返回 null。它和 apply 用同一个判定，等待的 1 到上限之间的整数分钟都合法；
 * 不合法时失败信息里是原因的编号和数据。
 */
function expectAllowed(action: Action, world: World, state: State, label: string): void {
  expect(illegalReasonForView(observe(world, state), world.params, action), `${label} ${JSON.stringify(action)}`).toBeNull();
}

describe('性质：契约，计划和规则一致', () => {
  it(
    '两种轨迹的每个决策点：交给它深度冻结的 world 和 state，返回的动作合法，两次调用结果相同；用 apply 重放计划，成绩和计划给出的相同；接手轨迹都走到了班次结束',
    () => {
      fc.assert(
        fc.property(shiftArb, (input) => {
          const { world, random, takeOver } = shiftOf(input);
          // 接手轨迹里全知的每个动作都由 apply 校验过（非法就抛错）；这里再核对一遍。
          expect(lastOf(takeOver.states).ended).not.toBeNull();
          for (const state of decisionStates(random, takeOver)) {
            const label = `${input.set} ${JSON.stringify(input.seed)} 第 ${state.minute} 分钟`;
            const action = decide(world, state);
            expectAllowed(action, world, state, label);
            const plan = oraclePlan(deepFreeze(world), deepFreeze(state));
            expect(plan.actions[0], label).toStrictEqual(action);
            const final = play(world, state, ...plan.actions);
            expect(final.ended, label).not.toBeNull();
            expect(score(world, final).equivalentFinish, label).toBe(plan.equivalentFinish);
          }
        }),
        { numRuns: ORACLE_RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '打乱调用顺序：几局（不同的世界和参数）的决策点混在一起，按顺序调一遍，再按打乱的顺序调一遍，每个状态的动作都相同',
    () => {
      fc.assert(
        fc.property(fc.array(shiftArb, { minLength: 2, maxLength: 3 }), fc.string(), (inputs, shuffleSeed) => {
          const points = inputs.flatMap((input) => {
            const { world, takeOver } = shiftOf(input);
            return decisionStates(takeOver).map((state) => ({ world, state }));
          });
          const inOrder = points.map(({ world, state }) => decide(world, state));
          const shuffled = new Array<Action>(points.length);
          for (const index of createRng(shuffleSeed).shuffle(points.map((_, i) => i))) {
            const { world, state } = at(points, index);
            shuffled[index] = decide(world, state);
          }
          expect(shuffled).toStrictEqual(inOrder);
        }),
        { numRuns: 10 },
      );
    },
    TIMEOUT,
  );
});

describe('性质：不差于新手', () => {
  it('三档和 ODD_PARAMS 各一批固定种子：整班都由全知做，平均等效下班时间不差于新手；每一局开工时的计划都不差于新手整班的成绩', () => {
    const SEEDS = 15;
    for (const set of SET_NAMES) {
      let oracleTotal = 0;
      let noviceTotal = 0;
      for (let i = 0; i < SEEDS; i++) {
        const world = generate(`oracle-batch-${i}`, PARAM_SETS[set]);
        const byOracle = lastOf(playShift(world, [0], Number.POSITIVE_INFINITY, oracleChooser()).states);
        const byNovice = lastOf(playShift(world, [0], Number.POSITIVE_INFINITY, policyChooser(novice)).states);
        const noviceScore = score(world, byNovice).equivalentFinish;
        oracleTotal += score(world, byOracle).equivalentFinish;
        noviceTotal += noviceScore;
        const firstPlan = oraclePlan(deepFreeze(world), deepFreeze(initial(world)));
        expect(firstPlan.equivalentFinish, `${set} ${world.seed}`).toBeLessThanOrEqual(noviceScore);
      }
      expect(oracleTotal / SEEDS, set).toBeLessThanOrEqual(noviceTotal / SEEDS);
    }
  });
});

describe('性质：数值从 params 读', () => {
  it('ODD_PARAMS 里全知直接读的每项数值都和三档不同（上面几条性质都在 ODD_PARAMS 下跑过），束宽是正整数', () => {
    const odd = numbersUsedByOracle(ODD_PARAMS);
    for (const tier of TIERS) {
      const base = numbersUsedByOracle(PARAMS[tier]);
      for (const [name, value] of Object.entries(odd)) expect(value, `${tier} 档的 ${name}`).not.toBe(base[name]);
    }
    for (const params of [ODD_PARAMS, ...TIERS.map((tier) => PARAMS[tier])]) {
      expect(Number.isInteger(params.oracle.beamWidth)).toBe(true);
      expect(params.oracle.beamWidth).toBeGreaterThanOrEqual(1);
    }
  });
});

/** 随机轨迹要走到的局面，计划和规则一致的性质要在这些局面上查过。 */
const HARD_STATES: readonly [string, (world: World, state: State) => boolean][] = [
  [
    '14:30 以后还没休息',
    (world, state) =>
      !state.breakTaken && state.minute >= world.params.shift.breakLatest && state.minute < world.params.shift.hardStop,
  ],
  ['17:00 以后', (world, state) => state.minute >= world.params.shift.hardStop],
  ['布草为 0', (_world, state) => state.cart === 0],
  ['有敲门被拒过、还没做完的房间', (_world, state) => state.rooms.some((room) => room.knownAvailableFrom !== null && room.doneAt === null)],
  ['有做到一半被截断的房间', (_world, state) => state.rooms.some((room) => room.workDone > 0 && room.doneAt === null)],
  ['人不在服务间那一层', (world, state) => state.place.floor !== world.params.layout.servicePoint.floor],
];

describe('自检', () => {
  it('三档和 ODD_PARAMS 各自的随机轨迹里，都有 14:30 以后还没休息、17:00 以后、布草为 0、有被拒过的房间、有被截断的房间、人不在服务间那一层的决策点', () => {
    const counts = new Map<string, number>();
    for (const input of fc.sample(shiftArb, { numRuns: 200, seed: SAMPLE_SEED })) {
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
});
