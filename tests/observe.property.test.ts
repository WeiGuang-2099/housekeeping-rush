/**
 * observe 和 legalActionsForView 的性质测试。单元测试见 observe.test.ts。
 *
 * fast-check 生成种子字符串、难度档和一串下标，用 tests/helpers/play.ts 的 playShift 跑随机合法序列，
 * 逐步检查每个状态（含开工和班次结束后）的 View。生成器、规模和时限都用 play.ts 的，和 rules 的性质测试相当。
 * 对照、不泄露和逐字段三条性质除了三档，还用 tests/helpers/params.ts 的 ODD_PARAMS 跑：它的楼层、房数和
 * rules 用到的各项数值都和三档不同。三档的楼层相同、数值大多相同，合法性和传入哪一档的参数无关，
 * 只用三档测不出 legalActionsForView 用错了参数，也测不出只在某套参数下才出错的 View。
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS } from '../src/engine/params';
import { apply, initial, legalActions, legalActionsForView } from '../src/engine/rules';
import type { RoomView, State, View, World } from '../src/engine/types';
import { hideDifferently } from './helpers/hidden';
import { ODD_PARAMS } from './helpers/params';
import {
  at,
  deepFreeze,
  lastOf,
  objectsIn,
  picksArb,
  playShift,
  RUNS,
  seedArb,
  tierArb,
  TIMEOUT,
} from './helpers/play';
import { PLACE_KEYS, ROOM_VIEW_KEYS, VIEW_KEYS, withDescriptions } from './helpers/view';

/** 前缀的步数，和 rules 的不泄露性质相同。 */
const prefixArb = fc.nat({ max: 120 });
/** 构造第二个世界用的一串数。 */
const noiseArb = fc.array(fc.nat(), { minLength: 1, maxLength: 64 });

/**
 * 对照：随机合法序列的每一步，按 View 判定的合法动作和 legalActions 完全相同，顺序也相同。
 * 交给 legalActionsForView 的 View 先深度冻结：它不能修改 View。
 */
function expectSameLegalActions(world: World, picks: readonly number[]): void {
  const { states } = playShift(world, picks);
  for (const state of states) {
    const view = deepFreeze(observe(world, state));
    expect(legalActionsForView(view, world.params), `${state.minute} 分钟`).toStrictEqual(legalActions(world, state));
  }
}

/**
 * 不泄露：前缀结束后用 hideDifferently 造第二个世界（只改玩家到那时还不知道的隐藏信息，种子也换掉），
 * 先在第二个世界里重放同一前缀，逐步核对状态完全相同；再比较前缀的每一步：两个世界的 View 完全相同，
 * JSON 也相同，按 View 判定的合法动作也相同。
 */
function expectSameViews(world: World, picks: readonly number[], prefixLength: number, noise: readonly number[]): void {
  const { states, actions } = playShift(world, picks, prefixLength);
  // 第二个世界的构造见 tests/helpers/hidden.ts。
  const other = hideDifferently(world, lastOf(states), noise);
  expect(other.seed).not.toBe(world.seed);
  // 同一前缀在两个世界里的状态完全相同，下面逐步重放核对（三档另有 rules 的不泄露性质）。
  // hideDifferently 改到了玩家已经知道的信息时，这里会失败；ODD_PARAMS 下只有这里核对。
  let replayed = initial(other);
  expect(replayed, '开工').toStrictEqual(at(states, 0));
  actions.forEach((action, index) => {
    replayed = apply(other, replayed, action);
    expect(replayed, `第 ${index + 1} 步`).toStrictEqual(at(states, index + 1));
  });
  for (const state of states) {
    const view = observe(world, state);
    const otherView = observe(other, state);
    expect(otherView, `${state.minute} 分钟`).toStrictEqual(view);
    expect(JSON.stringify(otherView), `${state.minute} 分钟`).toBe(JSON.stringify(view));
    expect(legalActionsForView(otherView, other.params)).toStrictEqual(legalActionsForView(view, world.params));
  }
}

/**
 * 按白名单从 world 和 state 逐字段写出的 View，不调用 observe。玩家自己的状态（时刻、位置、布草、是否休息过、
 * 违规、班次怎么结束的）和日志取 state；每间房的房号、位置、房型、线索、延迟退房、贵宾时限取 world.rooms，
 * 催房时限、完成时刻、已做分钟、已退标记、回来时间取 state.rooms，是否得知摘牌取 dndLiftKnown；
 * 开过门（messRevealed）的房间才有脏乱档位和描述编号，取 world.rooms 的真值，没开过门的两者都是 null。
 * 阶段 0 的 prompt 恒为 null。
 */
function expectedView(world: World, state: State): View {
  return {
    minute: state.minute,
    place: state.place,
    cart: state.cart,
    breakTaken: state.breakTaken,
    rooms: world.rooms.map((truth, index): RoomView => {
      const progress = at(state.rooms, index);
      return {
        id: truth.id,
        place: truth.place,
        kind: truth.kind,
        clue: truth.clue,
        lateCheckout: truth.lateCheckout,
        vipDeadline: truth.vipDeadline,
        rushDeadline: progress.rushDeadline,
        doneAt: progress.doneAt,
        workDone: progress.workDone,
        flaggedDeparted: progress.flaggedDeparted,
        knownAvailableFrom: progress.knownAvailableFrom,
        mess: progress.messRevealed ? truth.mess : null,
        dndLifted: progress.dndLiftKnown,
        descriptionId: progress.messRevealed ? truth.descriptionId : null,
      };
    }),
    prompt: null,
    violation: state.violation,
    ended: state.ended,
    log: state.log,
  };
}

/**
 * 逐字段：随机合法序列的每一步（含开工和班次结束后），View 都和 expectedView 写出的对象完全相同。
 * 世界先给每间房一个不同的描述编号：描述该显示时没显示、不该显示时显示了，或取错了房间，都会对不上。
 */
function expectFieldsFromSources(generated: World, picks: readonly number[]): void {
  const { world, states } = playShift(withDescriptions(generated), picks);
  for (const state of states) {
    expect(observe(world, state), `${state.minute} 分钟`).toStrictEqual(expectedView(world, state));
  }
}

describe('性质：对照', () => {
  it(
    '三档：每一步（含开工和班次结束后），legalActionsForView(observe(world, state), world.params) 和 legalActions(world, state) 完全相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          expectSameLegalActions(generate(seed, PARAMS[tier]), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'ODD_PARAMS：同上；楼层、房数和 rules 用到的各项数值都和三档不同，legalActionsForView 没用传入的参数就会不同',
    () => {
      fc.assert(
        fc.property(seedArb, picksArb, (seed, picks) => {
          expectSameLegalActions(generate(seed, ODD_PARAMS), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：不泄露', () => {
  it(
    '三档：只差玩家还不知道的隐藏信息、种子也不同的两个世界，同一前缀在两边的状态完全相同，每一步的 View 完全相同，JSON 相同，按 View 判定的合法动作相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, prefixArb, noiseArb, (seed, tier, picks, prefixLength, noise) => {
          expectSameViews(generate(seed, PARAMS[tier]), picks, prefixLength, noise);
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
          expectSameViews(generate(seed, ODD_PARAMS), picks, prefixLength, noise);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：逐字段', () => {
  it(
    '三档：每一步（含开工和班次结束后），View 的每个字段都按白名单取值：玩家自己的状态、日志和每间房的进度等于 State，任务单上的公开字段等于 world.rooms，开过门的房间才显示脏乱和描述的真值',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          expectFieldsFromSources(generate(seed, PARAMS[tier]), picks);
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
        fc.property(seedArb, picksArb, (seed, picks) => {
          expectFieldsFromSources(generate(seed, ODD_PARAMS), picks);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：纯函数', () => {
  it(
    'world 和每一步的 state 先存一份 structuredClone 的副本再深度冻结：observe 不抛错，入参和副本相同；同一输入调两次结果相同，但每次都是新建的，两次的结果之间只共用日志条目',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          // 用 params 的副本生成：深度冻结只冻结这个测试自己造的对象，不碰全局共用的 PARAMS。
          const world = generate(seed, structuredClone(PARAMS[tier]));
          const worldCopy = structuredClone(world);
          deepFreeze(world);
          const { states } = playShift(world, picks);
          for (const state of states) {
            const stateCopy = structuredClone(state);
            deepFreeze(state);
            const first = observe(world, state);
            const second = observe(world, state);
            expect(second, `${state.minute} 分钟`).toStrictEqual(first);
            expect(state, `${state.minute} 分钟`).toStrictEqual(stateCopy);
            // 每次调用都新建 View、rooms 数组、每个 RoomView、位置和日志数组；日志条目（连同条目里的对象）和 State 共用，
            // 所以两次的结果也共用它们，除此之外不该有同一个对象。缓存 View 的写法会在这里失败。
            const fromLog = objectsIn(state.log);
            const secondObjects = objectsIn(second);
            const shared = [...objectsIn(first)].filter((object) => secondObjects.has(object) && !fromLog.has(object));
            expect(shared, `${state.minute} 分钟`).toEqual([]);
          }
          expect(world).toStrictEqual(worldCopy);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '运行时把 Math.random 和 Date.now 换成会抛错的桩，View 不变',
    () => {
      // 在 fast-check 之外准备好世界和每一步的状态，并先不换桩算一遍 View，得到对照结果。
      const samples = fc.sample(fc.tuple(seedArb, tierArb, picksArb), { numRuns: RUNS, seed: 20261114 });
      const traces = samples.map(([seed, tier, picks]) => playShift(generate(seed, PARAMS[tier]), picks));
      const expected = traces.map(({ world, states }) => states.map((state) => observe(world, state)));

      // 只在调用 observe 的这段代码里换桩，用 try/finally 恢复。这段代码里不调用 expect。
      let randomCalls = 0;
      let nowCalls = 0;
      const random = vi.spyOn(Math, 'random').mockImplementation(() => {
        randomCalls++;
        throw new Error('observe 不该调用 Math.random');
      });
      const now = vi.spyOn(Date, 'now').mockImplementation(() => {
        nowCalls++;
        throw new Error('observe 不该调用 Date.now');
      });
      let views: View[][] = [];
      let failure: unknown = null;
      try {
        views = traces.map(({ world, states }) => states.map((state) => observe(world, state)));
      } catch (error) {
        failure = error;
      } finally {
        random.mockRestore();
        now.mockRestore();
      }

      expect(failure).toBeNull();
      expect(randomCalls).toBe(0);
      expect(nowCalls).toBe(0);
      expect(views).toStrictEqual(expected);
    },
    TIMEOUT,
  );
});

describe('性质：不共用对象', () => {
  it(
    '从 View 能走到的对象和从 world（含 params）能走到的对象没有交集；View 的日志数组和位置都不是 State 里的那个',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const world = generate(seed, PARAMS[tier]);
          const worldObjects = objectsIn(world);
          const { states } = playShift(world, picks);
          // 各步的 View 共用 State 的日志条目，收进同一个集合，每个对象只走一次。
          const viewObjects = new Set<object>();
          for (const state of states) {
            const view = observe(world, state);
            expect(view.log, `${state.minute} 分钟`).not.toBe(state.log);
            expect(view.place, `${state.minute} 分钟`).not.toBe(state.place);
            objectsIn(view, viewObjects);
          }
          expect([...viewObjects].filter((object) => worldObjects.has(object))).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：普通数据', () => {
  it(
    '每一步的 View 经 structuredClone 复制后和原来完全相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          for (const state of states) {
            const view = observe(world, state);
            expect(structuredClone(view), `${state.minute} 分钟`).toStrictEqual(view);
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：键', () => {
  it(
    '每一步的 View 恰好 9 个键，每个 RoomView 恰好 14 个键，位置是 floor、door，都按类型里的字段顺序',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          for (const state of states) {
            const view = observe(world, state);
            expect(Object.keys(view), `${state.minute} 分钟的 View`).toEqual(VIEW_KEYS);
            expect(Object.keys(view.place), `${state.minute} 分钟的位置`).toEqual(PLACE_KEYS);
            expect(
              view.rooms.map((room) => Object.keys(room)),
              `${state.minute} 分钟的房间`,
            ).toEqual(view.rooms.map(() => ROOM_VIEW_KEYS));
            expect(
              view.rooms.map((room) => Object.keys(room.place)),
              `${state.minute} 分钟的房间位置`,
            ).toEqual(view.rooms.map(() => PLACE_KEYS));
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});
