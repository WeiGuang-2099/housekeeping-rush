/**
 * recall 的性质测试。单元测试见 recall.test.ts。
 *
 * 状态来自 tests/helpers/play.ts 的 playShift：fast-check 生成种子和一串下标，随机合法序列从开工走，三档和 ODD_PARAMS 都跑。
 * 交给 recall 的 View 先深度冻结。
 *
 * 1. 反事实：随机轨迹的每个状态，recall 给出的时刻，就是到这一步为止的电话和门位观察能发现的最晚时刻。不照着 recall 的
 *    推法再算一遍，而是改世界、用 apply 从开工起重放同一串动作来核对。只改一间房的一个隐藏时刻：这间房被得知之前，
 *    两个世界的状态完全相同（合法性只读已知信息），动作照样合法；一旦得知就停下，后面的动作可能不再合法。
 *    - lastCallAt 为 h：每间还没被标记的退房房，退房时刻改成 h，重放到这一步时已被标记；改成 h + 1，没被标记。
 *      为 null：退房时刻改到开工前，也没被标记。
 *    - 还不知道摘牌的请勿打扰房，confirmedAt 为 c：摘牌时刻改成 c，重放到这一步时已经得知；改成 c + 1，没得知。
 *      为 null：摘牌时刻改到开工前，也没得知。
 *    电话和门位观察都在固定的时刻看，退房、摘牌得越早越容易被看到，所以 c 和 c + 1 两边一查就确定了 c。
 *    每个状态都查，不只查前缀的末尾：一条日志结束时的那一次门位观察，和下一条日志步行起点的那一次在同一个门位、同一分钟，
 *    只有停在日志最后一条的那个状态上才看得出漏没漏掉它。同一种改法只从开工重放一次，记下第一次得知是第几步。
 *    ODD_PARAMS 的楼层、步行、电梯和电话的分钟数都和三档不同，recall 没从传入的参数读就会对不上。
 * 2. 每个状态：stillHung 恰好是还不知道摘牌的请勿打扰房，按 view.rooms 的顺序；lastCallAt 是最后一条打电话日志的 end，
 *    没打过就是 null；confirmedAt 不早于 lastCallAt，不晚于现在；lastCallAt 和同一间房的 confirmedAt 都只增不减。
 * 3. 不泄露：前缀结束后用 hideDifferently 造只差玩家还不知道的隐藏信息、种子也不同的第二个世界，逐步重放同一前缀、
 *    核对状态；每一步两个世界上 recall 的结果完全相同。
 * 4. 自检（fc.sample 配固定种子）：三档和 ODD_PARAMS 各自的随机轨迹都走到了 SITUATIONS 列的情形（确认时刻来自电话、
 *    步行途中路过、日志最后一条结束时的门位观察，等等），第 1 条的两边（得知、没得知）都真的查到了。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { recall } from '../src/engine/recall';
import { apply, initial } from '../src/engine/rules';
import type { Action, Minute, Recall, RoomId, RoomProgress, View, World } from '../src/engine/types';
import { hideDifferently } from './helpers/hidden';
import { ODD_PARAMS } from './helpers/params';
import { at, deepFreeze, lastOf, picksArb, playShift, RUNS, seedArb, tierArb, TIMEOUT } from './helpers/play';
import { patchWorld } from './helpers/world';

/** fc.sample 的固定种子。 */
const SAMPLE_SEED = 20261125;

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

/** 一间房被得知了什么：退房房被标记已退，或者请勿打扰房得知摘牌。 */
type Learned = (progress: RoomProgress) => boolean;
const flagged: Learned = (progress) => progress.flaggedDeparted;
const liftKnown: Learned = (progress) => progress.dndLiftKnown;

/** 反事实里改的一个隐藏时刻：退房房的退房时刻，或者请勿打扰房的摘牌时刻。 */
type Patch = { availableFrom: Minute } | { dndLiftsAt: Minute };

/**
 * 反事实的重放：把 room 的一个隐藏时刻换掉，从开工起逐步重放 actions，返回这间房第一次被得知（learned）时已经放了几步；
 * 放完还没得知返回 Infinity。得知之前两个世界的状态完全相同，动作照样合法；得知以后不再往下放。
 */
function learnedAfter(world: World, actions: readonly Action[], room: RoomId, patch: Patch, learned: Learned): number {
  const other = patchWorld(world, { [room]: patch });
  const index = other.rooms.findIndex((truth) => truth.id === room);
  let state = initial(other);
  for (const [step, action] of actions.entries()) {
    state = apply(other, state, action);
    if (learned(at(state.rooms, index))) return step + 1;
  }
  return Number.POSITIVE_INFINITY;
}

/** 第 1 条性质的一次核对：改成 patch 以后重放，到这一步时这间房得知与否应当是 expected。 */
interface Probe {
  room: RoomId;
  patch: Patch;
  learned: Learned;
  expected: boolean;
}

/** 一个状态上要核对的反事实，见文件开头第 1 条。 */
function probesFor(view: View, result: Recall, params: Params): Probe[] {
  const { beforeStart } = params.shift;
  const probes: Probe[] = [];
  const h = result.lastCallAt;
  for (const room of view.rooms) {
    if (room.kind !== 'departure' || room.flaggedDeparted) continue;
    if (h === null) {
      probes.push({ room: room.id, patch: { availableFrom: beforeStart }, learned: flagged, expected: false });
    } else {
      probes.push({ room: room.id, patch: { availableFrom: h }, learned: flagged, expected: true });
      probes.push({ room: room.id, patch: { availableFrom: h + 1 }, learned: flagged, expected: false });
    }
  }
  for (const { room, confirmedAt: c } of result.stillHung) {
    if (c === null) {
      probes.push({ room, patch: { dndLiftsAt: beforeStart }, learned: liftKnown, expected: false });
    } else {
      probes.push({ room, patch: { dndLiftsAt: c }, learned: liftKnown, expected: true });
      probes.push({ room, patch: { dndLiftsAt: c + 1 }, learned: liftKnown, expected: false });
    }
  }
  return probes;
}

/** 第 1 条性质：一局随机轨迹的每个状态，recall 给出的时刻都是到这一步为止能发现的最晚时刻。只在对不上时调用 expect。 */
function expectCounterfactual(world: World, picks: readonly number[]): void {
  const { states, actions } = playShift(world, picks);
  /** 每种改法（房号加改成的时刻）第一次得知是第几步。同一种改法在各个状态上的答案只差停在哪一步，只重放一次。 */
  const learnedSteps = new Map<string, number>();
  const learnedStep = (probe: Probe): number => {
    const key = `${probe.room}:${JSON.stringify(probe.patch)}`;
    const known = learnedSteps.get(key);
    if (known !== undefined) return known;
    const step = learnedAfter(world, actions, probe.room, probe.patch, probe.learned);
    learnedSteps.set(key, step);
    return step;
  };
  states.forEach((state, index) => {
    const view = deepFreeze(observe(world, state));
    const result = recall(view, world.params);
    for (const probe of probesFor(view, result, world.params)) {
      const learned = learnedStep(probe) <= index;
      if (learned !== probe.expected) {
        const label = `第 ${index} 步、${state.minute} 分钟，recall 给出 ${JSON.stringify(result)}；${probe.room} 改成 ${JSON.stringify(probe.patch)}`;
        expect(learned, label).toBe(probe.expected);
      }
    }
  });
}

/** 第 2 条性质：一局随机轨迹的每个状态。内层先用普通比较，对不上才调 expect。 */
function expectEveryState(world: World, picks: readonly number[]): void {
  const { states } = playShift(world, picks);
  let previous: Recall | null = null;
  for (const state of states) {
    const view = deepFreeze(observe(world, state));
    const result = recall(view, world.params);
    const label = `${state.minute} 分钟，recall 给出 ${JSON.stringify(result)}`;

    const calls = view.log.filter((entry) => entry.outcome.type === 'called');
    const lastCallAt = calls.length === 0 ? null : lastOf(calls).end;
    if (result.lastCallAt !== lastCallAt) expect(result.lastCallAt, label).toBe(lastCallAt);
    const rooms = view.rooms.filter((room) => room.kind === 'dnd' && !room.dndLifted).map((room) => room.id);
    const listed = result.stillHung.map((item) => item.room);
    if (JSON.stringify(listed) !== JSON.stringify(rooms)) expect(listed, label).toEqual(rooms);

    for (const { room, confirmedAt } of result.stillHung) {
      const notBeforeCall = lastCallAt === null || (confirmedAt !== null && confirmedAt >= lastCallAt);
      const notAfterNow = confirmedAt === null || confirmedAt <= state.minute;
      if (!notBeforeCall || !notAfterNow) throw new Error(`${label}：${room} 的确认时刻应当不早于最近一次电话、不晚于现在`);
      const before = previous?.stillHung.find((item) => item.room === room)?.confirmedAt ?? null;
      if (before !== null && (confirmedAt === null || confirmedAt < before)) {
        throw new Error(`${label}：${room} 的确认时刻从 ${before} 变小了`);
      }
    }
    const lastBefore = previous === null ? null : previous.lastCallAt;
    if (lastBefore !== null && (result.lastCallAt === null || result.lastCallAt < lastBefore)) {
      throw new Error(`${label}：lastCallAt 从 ${lastBefore} 变小了`);
    }
    previous = result;
  }
}

/** 第 3 条性质：前缀的每一步，两个世界上 recall 的结果完全相同。只在对不上时调用 expect。 */
function expectSameRecall(world: World, picks: readonly number[], prefixLength: number, noise: readonly number[]): void {
  const { states, actions } = playShift(world, picks, prefixLength);
  // 第二个世界的构造见 tests/helpers/hidden.ts。先在它上面逐步重放同一前缀，核对每一步的状态完全相同。
  const other = hideDifferently(world, lastOf(states), noise);
  expect(other.seed).not.toBe(world.seed);
  let replayed = initial(other);
  states.forEach((state, index) => {
    if (index > 0) replayed = apply(other, replayed, at(actions, index - 1));
    expect(replayed, `第 ${index} 步`).toStrictEqual(state);
    const mine = recall(observe(world, state), world.params);
    const theirs = recall(observe(other, replayed), other.params);
    if (JSON.stringify(theirs) !== JSON.stringify(mine)) expect(theirs, `第 ${index} 步`).toStrictEqual(mine);
  });
}

describe('性质：反事实', () => {
  it(
    '三档：随机轨迹的每个状态，lastCallAt 和每间还不知道摘牌的请勿打扰房的 confirmedAt，都是到这一步为止的电话和门位观察能发现的最晚时刻',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          expectCounterfactual(generate(seed, PARAMS[tier]), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'ODD_PARAMS：同上；楼层、步行、电梯和电话的分钟数都和三档不同',
    () => {
      fc.assert(
        fc.property(seedArb, picksArb, (seed, picks) => {
          expectCounterfactual(generate(seed, ODD_PARAMS), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：每个状态', () => {
  it(
    '三档和 ODD_PARAMS：stillHung 恰好是还不知道摘牌的请勿打扰房，按顺序；lastCallAt 是最后一通电话的挂断时刻；确认时刻不早于它、不晚于现在；都只增不减',
    () => {
      fc.assert(
        fc.property(seedArb, fc.constantFrom(...SET_NAMES), picksArb, (seed, set, picks) => {
          expectEveryState(generate(seed, PARAM_SETS[set]), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：不泄露', () => {
  it(
    '三档和 ODD_PARAMS：只差玩家还不知道的隐藏信息、种子也不同的两个世界，同一前缀的每一步，recall 的结果完全相同',
    () => {
      fc.assert(
        fc.property(
          seedArb,
          fc.constantFrom(...SET_NAMES),
          picksArb,
          prefixArb,
          noiseArb,
          (seed, set, picks, prefixLength, noise) => {
            expectSameRecall(generate(seed, PARAM_SETS[set]), picks, prefixLength, noise);
          },
        ),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

/** 自检要走到的情形。 */
const SITUATIONS = [
  '没打过电话，有没标记的退房房',
  '打过电话，有没标记的退房房',
  '还没确认过的请勿打扰房',
  '确认时刻是电话的挂断时刻',
  '确认时刻是门位观察，晚于最近一次电话',
  '确认时刻是步行途中路过的那一分钟',
  '确认时刻是日志最后一条结束时的门位观察',
  '反事实：得知',
  '反事实：没得知',
] as const;
type Situation = (typeof SITUATIONS)[number];

/** 一个状态走到了哪些情形。 */
function situationsOf(view: View, result: Recall, params: Params): Situation[] {
  const found: Situation[] = [];
  if (view.rooms.some((room) => room.kind === 'departure' && !room.flaggedDeparted)) {
    found.push(result.lastCallAt === null ? '没打过电话，有没标记的退房房' : '打过电话，有没标记的退房房');
  }
  // 步行途中路过的那一分钟在某条日志的 start 和 end 之间，不等于任何一条日志的 end。
  const ends = new Set(view.log.map((entry) => entry.end));
  const lastEnd = view.log.at(-1)?.end;
  for (const { confirmedAt } of result.stillHung) {
    if (confirmedAt === null) found.push('还没确认过的请勿打扰房');
    else if (confirmedAt === result.lastCallAt) found.push('确认时刻是电话的挂断时刻');
    else {
      found.push('确认时刻是门位观察，晚于最近一次电话');
      if (!ends.has(confirmedAt)) found.push('确认时刻是步行途中路过的那一分钟');
      if (confirmedAt === lastEnd) found.push('确认时刻是日志最后一条结束时的门位观察');
    }
  }
  for (const probe of probesFor(view, result, params)) found.push(probe.expected ? '反事实：得知' : '反事实：没得知');
  return found;
}

describe('自检', () => {
  it('三档和 ODD_PARAMS 各自的随机轨迹都走到了 SITUATIONS 列的每一种情形', () => {
    const counts = new Map<string, number>();
    for (const set of SET_NAMES) {
      for (const [seed, picks] of fc.sample(fc.tuple(seedArb, picksArb), { numRuns: RUNS, seed: SAMPLE_SEED })) {
        const world = generate(seed, PARAM_SETS[set]);
        for (const state of playShift(world, picks).states) {
          const view = observe(world, state);
          for (const situation of situationsOf(view, recall(view, world.params), world.params)) {
            const key = `${set}：${situation}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
    }
    const missing = SET_NAMES.flatMap((set) => SITUATIONS.map((situation) => `${set}：${situation}`)).filter(
      (key) => (counts.get(key) ?? 0) === 0,
    );
    expect(missing, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
  });
});
