/**
 * 性质测试共用的辅助：fast-check 的生成器、每条性质的规模和时限，按下标跑随机合法序列的 playShift，
 * 以及取下标、深度冻结、收集对象的小工具。rules、observe 和 score 的性质测试都从这里导入。
 *
 * fast-check 生成种子字符串、难度档和一串下标；默认的挑法是第 k 步取 legalActions[下标 % 长度]，下标循环使用。
 * 这里只调用引擎和普通的数组操作，不调用 expect。
 */

import fc from 'fast-check';
import type { Tier } from '../../src/engine/params';
import { apply, initial, legalActions } from '../../src/engine/rules';
import type { Action, State, World } from '../../src/engine/types';

/** 三个难度档。 */
export const TIERS = ['standard', 'tight', 'weekend'] as const satisfies readonly Tier[];

/** 种子字符串。 */
export const seedArb = fc.string({ maxLength: 16 });
/** 难度档。 */
export const tierArb = fc.constantFrom(...TIERS);
/** 选动作用的一串下标，循环使用。 */
export const picksArb = fc.array(fc.nat({ max: 9999 }), { minLength: 1, maxLength: 64 });

/** 每条性质跑多少个班次。 */
export const RUNS = 100;
/** 单个性质测试的时限（毫秒）。正常只要一两秒，留足余量给慢机器。 */
export const TIMEOUT = 60_000;

/**
 * 按下标挑动作的挑法：从第 step 步的合法动作 legal 里挑一个。world 和 state 是这一步的世界和状态，
 * 挑法只该读玩家已知的部分（任务单上的房型、状态里已知的进度）。playShift 默认用 choose，它只看合法动作和下标。
 */
export type Chooser = (
  legal: readonly Action[],
  picks: readonly number[],
  step: number,
  world: World,
  state: State,
) => Action;

/** 第 step 步取 legal[下标 % 长度]。 */
export function choose(legal: readonly Action[], picks: readonly number[], step: number): Action {
  const pick = picks[step % picks.length] ?? 0;
  const action = legal[pick % legal.length];
  if (action === undefined) throw new Error(`第 ${step} 步没有合法动作`);
  return action;
}

/** playShift 的结果：世界，以及每一步的状态和动作。 */
export interface Trace {
  world: World;
  /** states[0] 是开工时的状态，states[i + 1] 是执行 actions[i] 之后的状态。 */
  states: State[];
  actions: Action[];
}

/**
 * 从开工起按下标选动作，跑到班次结束，或跑满 maxSteps 步。挑法默认是 choose，可以换成别的 Chooser。
 * 只调用引擎和普通的数组操作，不调用 expect，所以也能放进替换了 Math.random 的那段代码里。
 */
export function playShift(
  world: World,
  picks: readonly number[],
  maxSteps = Number.POSITIVE_INFINITY,
  chooser: Chooser = choose,
): Trace {
  // 每个动作至少推进 1 分钟，班次一定在 hardStop + 事件数 + 1 步之内结束。
  const limit = world.params.shift.hardStop + world.events.length + 1;
  let state = initial(world);
  const states = [state];
  const actions: Action[] = [];
  while (state.ended === null && actions.length < maxSteps) {
    if (actions.length >= limit) throw new Error(`走了 ${limit} 步，班次还没结束`);
    const action = chooser(legalActions(world, state), picks, actions.length, world, state);
    state = apply(world, state, action);
    states.push(state);
    actions.push(action);
  }
  return { world, states, actions };
}

/** list[index]，越界就抛错。 */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`下标 ${index} 越界`);
  return item;
}

/** 最后一项，空数组就抛错。 */
export function lastOf<T>(list: readonly T[]): T {
  return at(list, list.length - 1);
}

/** 把 value 和从它能走到的全部对象、数组冻结，返回 value 本身。 */
export function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return value;
}

/** 一个值里能走到的全部对象和数组。 */
export function objectsIn(value: unknown, into: Set<object> = new Set()): Set<object> {
  if (typeof value === 'object' && value !== null && !into.has(value)) {
    into.add(value);
    for (const child of Object.values(value)) objectsIn(child, into);
  }
  return into;
}
