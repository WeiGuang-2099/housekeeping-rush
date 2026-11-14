/**
 * 规则测试的驱动工具：动作的写法、按顺序执行动作、原地等到某个时刻、取日志和房间进度、检查非法动作。
 * 起始状态一律由 initial 加一串合法动作推出来，不手工拼 State。
 */

import { expect } from 'vitest';
import { apply, legalActions } from '../../src/engine/rules';
import type { Action, LogEntry, Minute, RoomId, RoomProgress, State, World } from '../../src/engine/types';

/** 动作的写法。每次调用都返回新对象。 */
export const act = {
  service: (room: RoomId): Action => ({ type: 'service', room }),
  restock: (): Action => ({ type: 'restock' }),
  call: (): Action => ({ type: 'call' }),
  break: (): Action => ({ type: 'break' }),
  wait: (minutes: Minute): Action => ({ type: 'wait', minutes }),
  respond: (option: string): Action => ({ type: 'respond', option }),
  finish: (): Action => ({ type: 'finish' }),
};

/** 从 state 起依次执行 actions，返回最后的状态。 */
export function play(world: World, state: State, ...actions: Action[]): State {
  return actions.reduce((current, action) => apply(world, current, action), state);
}

/**
 * 原地等到 minute：每次等 min(waitStepMinutes, 剩下的分钟数)。
 * 等待只在动作结束时观察所在门位，所以在服务间（门位 0，没有房间）等待不会得知任何事。
 */
export function waitUntil(world: World, state: State, minute: Minute): State {
  if (minute < state.minute) throw new Error(`waitUntil：现在已经是 ${state.minute}，等不到 ${minute}`);
  let current = state;
  while (current.minute < minute) {
    current = apply(world, current, act.wait(Math.min(world.params.waitStepMinutes, minute - current.minute)));
  }
  return current;
}

/** 最后一条日志。 */
export function last(state: State): LogEntry {
  const entry = state.log[state.log.length - 1];
  if (entry === undefined) throw new Error('日志为空');
  return entry;
}

/** 某间房的进度。 */
export function progress(state: State, room: RoomId): RoomProgress {
  const found = state.rooms.find((candidate) => candidate.id === room);
  if (found === undefined) throw new Error(`状态里没有房间 ${room}`);
  return found;
}

/** 开工时的房间进度：还没有任何进度，各字段都是初值。 */
export function freshProgress(room: RoomId): RoomProgress {
  return {
    id: room,
    doneAt: null,
    workDone: 0,
    flaggedDeparted: false,
    knownAvailableFrom: null,
    messRevealed: false,
    dndLiftKnown: false,
    rushDeadline: null,
  };
}

/** 动作列表里打扫的房号，保持原顺序。 */
export function serviceTargets(actions: readonly Action[]): RoomId[] {
  return actions.flatMap((action) => (action.type === 'service' ? [action.room] : []));
}

/** 执行 run，返回它抛出的 Error 的消息；没有抛错，或抛出的不是 Error，就让测试失败。 */
export function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw new Error(`抛出的不是 Error：${String(error)}`);
  }
  throw new Error('预期会抛错，实际没有抛错');
}

/**
 * 非法动作：不在 legalActions 里，apply 抛出消息为中文的 Error。返回报错消息。
 * 给了 pattern 时，报错消息还要包含这个字符串，或匹配这个正则。只用来查关键内容（房号、钟点、原因的关键词），
 * 不查整句，改措辞不用改测试。
 */
export function expectIllegal(world: World, state: State, action: Action, pattern?: string | RegExp): string {
  const label = JSON.stringify(action);
  expect(legalActions(world, state), `${label} 不该出现在 legalActions 里`).not.toContainEqual(action);
  const message = errorOf(() => apply(world, state, action));
  expect(message, `${label} 的报错消息应当是中文`).toMatch(/[一-鿿]/);
  if (pattern !== undefined) expect(message, `${label} 的报错消息应当写明已知的原因`).toMatch(pattern);
  return message;
}

/** 合法动作：出现在 legalActions 里，apply 不抛错。等待只能用上限那一个值。 */
export function expectLegal(world: World, state: State, action: Action): void {
  expect(legalActions(world, state), `${JSON.stringify(action)} 应当出现在 legalActions 里`).toContainEqual(action);
  expect(() => apply(world, state, action)).not.toThrow();
}

/** 一个值里出现的全部数字（深度遍历对象和数组）。 */
export function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}
