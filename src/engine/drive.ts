/**
 * 共用驱动函数 runShift：让一个幽灵从某个状态一直做到班次结束。批量模拟器（src/sim）、界面里的幽灵和全知内部新手的
 * 走法都用它；阶段 2 的老手推演用不用它，到时再定（docs/TASKS.md）。它是 docs/DESIGN.md 公平性约束第 3 道的一部分：
 * 交给只看 View 的策略什么，只在这一处写。
 *
 * 1. 交给幽灵什么。幽灵用带 kind 的联合类型区分。只看 View 的策略（kind 为 'view'，新手和老手）每一步只拿到
 *    observe(world, state) 的结果和 world.params，拿不到 world、state、合法动作和种子；全知（kind 为 'oracle'）
 *    拿 world 和 state。每次调用只传这两个参数。
 *
 * 2. 交给幽灵的东西先深度冻结：只看 View 的策略拿到的 View，全知拿到的 world 和 state。策略的契约是不修改传入的参数
 *    （docs/DESIGN.md 的"策略的契约"），冻结以后改了就抛 TypeError，不会悄悄改坏后面的步骤。
 *    View 的日志条目和 State 共用（observe 只复制日志数组），所以起始状态和返回的状态里的日志条目也一起冻结；
 *    驱动全知时，传入的 world 和起始状态也冻结。引擎从不修改这些对象，冻结不改变任何值。
 *    一次驱动里冻结过的对象记下来，后面的步骤不再走一遍（日志一步只多一条）。
 *
 * 3. 合法性由 apply 校验。策略返回非法动作时，apply 的报错原样抛出，不吞掉，不改写，也不换成别的动作。
 *    等待可以是 1 到上限之间的任意整数分钟，和玩家一样，照样交给 apply 校验。
 *
 * 4. 步数上界。除回应事件外每个动作至少推进 1 分钟，每个事件最多弹出一次，17:00 以后只能收工还车，所以从任何可达的
 *    状态起，班次都在 hardStop + world.events.length + 1 步之内结束（tests/rules.property.test.ts 检查）。
 *    这次驱动走满这么多步，班次还没结束，就抛错，不会无限循环。
 *
 * 5. 返回每一步的状态和动作，供计分和回放：states[0] 是起始状态，states[i + 1] 是执行 actions[i] 之后的状态，
 *    final 是最后一个状态，班次已经结束，可以直接交给 score。起始状态的班次已经结束时，不调用幽灵，没有动作。
 *    回放里"当时知道什么"，就是对那一步的状态再调一次 observe。
 *
 * 6. 没有随机数，不读系统时间，不在两次驱动之间记东西。幽灵是纯函数时，同样的世界、幽灵和起始状态给出同样的结果。
 */

import { observe } from './observe';
import { apply, initial } from './rules';
import type { Action, OraclePolicy, Policy, State, World } from './types';

/** 驱动函数能驱动的幽灵。kind 决定交给它什么（见文件开头第 1 条）。 */
export type Ghost =
  /** 只看 View 的策略：新手、老手。 */
  | { readonly kind: 'view'; readonly policy: Policy }
  /** 全知。 */
  | { readonly kind: 'oracle'; readonly policy: OraclePolicy };

/** runShift 的结果：每一步的状态和动作。 */
export interface ShiftRun {
  /** states[0] 是起始状态，states[i + 1] 是执行 actions[i] 之后的状态。 */
  readonly states: readonly State[];
  /** 幽灵每一步返回的动作，按顺序。 */
  readonly actions: readonly Action[];
  /** 最后一个状态，班次已经结束。 */
  readonly final: State;
}

/**
 * 让 ghost 从 start（默认是开工时的状态）一直做到班次结束，规则见文件开头。
 * 幽灵返回非法动作时抛出 apply 的报错；走满 hardStop + world.events.length + 1 步班次还没结束时抛错。
 */
export function runShift(world: World, ghost: Ghost, start: State = initial(world)): ShiftRun {
  const limit = world.params.shift.hardStop + world.events.length + 1;
  const frozen = new Set<object>();
  const states: State[] = [start];
  const actions: Action[] = [];
  let state = start;
  while (state.ended === null) {
    if (actions.length >= limit) throw new Error(`runShift: 走了 ${limit} 步，班次还没结束`);
    const action = decide(world, ghost, state, frozen);
    state = apply(world, state, action);
    states.push(state);
    actions.push(action);
  }
  return { states, actions, final: state };
}

/** 问幽灵这一步做什么：按 kind 交给它冻结好的 View 和 world.params，或者 world 和 state。 */
function decide(world: World, ghost: Ghost, state: State, frozen: Set<object>): Action {
  switch (ghost.kind) {
    case 'view':
      return ghost.policy(deepFreeze(observe(world, state), frozen), world.params);
    case 'oracle':
      return ghost.policy(deepFreeze(world, frozen), deepFreeze(state, frozen));
  }
}

/**
 * 把 value 和从它能走到的全部对象、数组冻结，返回 value 本身。frozen 记着这次驱动里已经深度冻结过的对象，
 * 遇到就不再往下走：它们和它们能走到的对象都已经冻结了。
 */
function deepFreeze<T>(value: T, frozen: Set<object>): T {
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || frozen.has(node)) return;
    frozen.add(node);
    Object.freeze(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return value;
}
