/**
 * 测试辅助的自检：tests/helpers/hidden.ts 的 hideDifferently 和 tests/helpers/play.ts 的 playShift。
 *
 * 不泄露性质能抓到什么，取决于 hideDifferently 改了哪些隐藏信息。在第二个世界里逐步重放、比较状态，
 * 只能发现它改多了（改到玩家已经知道的信息）；改少了（漏掉某一类，或者某一类里漏掉一种房型，甚至一项都不改），
 * 不泄露性质照样全过，对没改的那部分信息等于没查。所以这里确认完全没揭晓的隐藏信息每类、每种房型都确实改动过，
 * 种子也换了。
 *
 * 改多了由不泄露性质发现，可它们每次只随机抽 100 个例子。只在少数前缀上才出错的范围推错（例如只在 ODD_PARAMS 下
 * 用错步行时间、把门位观察的时刻推错，大约每 100 例才有 1 例对不上）要碰运气。所以这里再用固定种子在 ODD_PARAMS
 * 和三档下各抽 1000 个前缀，在第二个世界里逐步重放、比较状态。
 *
 * 性质测试都靠 playShift 按下标挑动作，走到敲门被拒、得知摘牌、17:00 截断这些关键状态。它退化成每步固定挑
 * 一个动作时，性质测试只在几乎不变的状态上比较，也照样全过。所以这里确认随机序列确实走到了这些状态。
 *
 * 样本都用 fc.sample 配固定种子抽，每次运行都是同一批，结果可复现。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/engine/generate';
import { PARAMS, type Params } from '../src/engine/params';
import { apply, initial } from '../src/engine/rules';
import type { LogEntry, RoomKind, RoomProgress, RoomTruth, State, World } from '../src/engine/types';
import { hideDifferently } from './helpers/hidden';
import { ODD_PARAMS } from './helpers/params';
import { at, lastOf, picksArb, playShift, RUNS, seedArb, tierArb, TIMEOUT, type Trace } from './helpers/play';
import { withDescriptions } from './helpers/view';

/** fc.sample 的固定种子。 */
const SAMPLE_SEED = 20261114;

/** 三档和 ODD_PARAMS，带上报错时用的名字。 */
const PARAM_SETS: [string, Params][] = [
  ['标准档', PARAMS.standard],
  ['紧档', PARAMS.tight],
  ['周末档', PARAMS.weekend],
  ['ODD_PARAMS', ODD_PARAMS],
];

/** 前缀的步数和构造第二个世界用的一串数，和不泄露性质用的生成器相同。 */
const prefixArb = fc.nat({ max: 120 });
const noiseArb = fc.array(fc.nat(), { minLength: 1, maxLength: 64 });

/** 前缀结束时的一间房：真相，玩家已知的进度，以及前缀里有没有作为打扫目标去过。 */
interface RoomAtEnd {
  truth: RoomTruth;
  known: RoomProgress;
  visited: boolean;
}

/** 三种房型在报错消息里的名字。 */
const KIND_NAMES: Record<RoomKind, string> = { departure: '退房房', stayover: '续住房', dnd: '请勿打扰房' };

/** 完全没揭晓的一类隐藏信息。 */
interface Unrevealed {
  name: string;
  /** 这一类涉及的房型。 */
  kinds: readonly RoomKind[];
  /** 前缀结束时玩家还不知道这间房的这一项，并且第二个世界里改了它。 */
  isChanged: (room: RoomAtEnd, other: RoomTruth) => boolean;
}

/**
 * 完全没揭晓的隐藏信息，按 tests/helpers/hidden.ts 文件开头的第一组分成五类。只数前缀结束时玩家还不知道这一项的房间。
 * 一类横跨几种房型时按房型分开数：只漏掉其中一种房型，别的房型照样能把合起来的计数撑过 0。
 */
const UNREVEALED: Unrevealed[] = [
  {
    name: '没开过门时的脏乱',
    kinds: ['departure', 'stayover', 'dnd'],
    isChanged: ({ truth, known }, other) => !known.messRevealed && other.mess !== truth.mess,
  },
  {
    name: '没开过门时的描述编号',
    kinds: ['departure', 'stayover', 'dnd'],
    isChanged: ({ truth, known }, other) => !known.messRevealed && other.descriptionId !== truth.descriptionId,
  },
  {
    name: '没标记、也不是延迟退房时的退房时刻',
    kinds: ['departure'],
    isChanged: ({ truth, known }, other) =>
      !truth.lateCheckout && !known.flaggedDeparted && other.availableFrom !== truth.availableFrom,
  },
  {
    name: '还不知道摘牌时的摘牌时刻',
    kinds: ['dnd'],
    isChanged: ({ truth, known }, other) => !known.dndLiftKnown && other.dndLiftsAt !== truth.dndLiftsAt,
  },
  {
    name: '前缀里没去过时的客人出门时刻',
    kinds: ['stayover', 'dnd'],
    isChanged: ({ truth, visited }, other) => !visited && other.availableFrom !== truth.availableFrom,
  },
];

/** 计数的一格：参数名、房型、类别。 */
function cellOf(label: string, kind: RoomKind, name: string): string {
  return `${label}：${KIND_NAMES[kind]}：${name}`;
}

/** 重放自检每组抽多少个前缀。 */
const REPLAY_RUNS = 1000;

/**
 * 同一前缀在 hideDifferently 造的第二个世界里逐步重放，返回第一处对不上的地方；每一步都相同时返回 null。
 * 状态都是普通数据，JSON 相同就是完全相同（连键的顺序也相同）。
 */
function replayMismatch(
  world: World,
  picks: readonly number[],
  prefixLength: number,
  noise: readonly number[],
): string | null {
  const { states, actions } = playShift(world, picks, prefixLength);
  const other = hideDifferently(world, lastOf(states), noise);
  const sameAt = (replayed: State, step: number): boolean =>
    JSON.stringify(replayed) === JSON.stringify(at(states, step));
  let replayed = initial(other);
  if (!sameAt(replayed, 0)) return '开工时的状态不同';
  for (const [index, action] of actions.entries()) {
    try {
      replayed = apply(other, replayed, action);
    } catch (error) {
      return `第 ${index + 1} 步报错：${error instanceof Error ? error.message : String(error)}`;
    }
    if (!sameAt(replayed, index + 1)) return `第 ${index + 1} 步之后的状态不同`;
  }
  return null;
}

/** 一局随机序列应当走到的关键状态：名字，以及这一局有没有走到。 */
type Milestone = [string, (trace: Trace) => boolean];

/** 一局的完整日志。 */
function logOf(trace: Trace): readonly LogEntry[] {
  return lastOf(trace.states).log;
}

/** 自己收工还车。单独拿出来，因为 ODD_PARAMS 那一组不要求它（理由见那条测试）。 */
const RETURNED: Milestone = ["以 'returned' 结束", (trace) => lastOf(trace.states).ended === 'returned'];

/** 三档那一组要求的全部关键状态。 */
const MILESTONES: Milestone[] = [
  ['敲门被拒', (trace) => logOf(trace).some((entry) => entry.outcome.type === 'knockRefused')],
  [
    '电话标记已退',
    (trace) => logOf(trace).some((entry) => entry.outcome.type === 'called' && entry.outcome.newlyDeparted.length > 0),
  ],
  ['路过或停留时得知摘牌', (trace) => logOf(trace).some((entry) => entry.noticedLifted.length > 0)],
  [
    '电话得知摘牌',
    (trace) => logOf(trace).some((entry) => entry.outcome.type === 'called' && entry.outcome.newlyLifted.length > 0),
  ],
  ['17:00 截断', (trace) => logOf(trace).some((entry) => entry.outcome.type === 'interrupted')],
  RETURNED,
  ["以 'hardStop' 结束", (trace) => lastOf(trace.states).ended === 'hardStop'],
  [
    '开过门的请勿打扰房',
    (trace) =>
      lastOf(trace.states).rooms.some(
        (room, index) => room.messRevealed && at(trace.world.rooms, index).kind === 'dnd',
      ),
  ],
];

/** 每类关键状态都至少有一局走到。失败时列出一局也没走到的类别，消息里带各类的局数。 */
function expectMilestones(traces: readonly Trace[], milestones: readonly Milestone[]): void {
  const counts = milestones.map(([name, reached]): [string, number] => [name, traces.filter(reached).length]);
  const missed = counts.filter(([, count]) => count === 0).map(([name]) => name);
  expect(missed, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
}

describe('自检：hideDifferently', () => {
  it('三档和 ODD_PARAMS 各自都有例子：完全没揭晓的五类隐藏信息每类、每种房型都确实改动过；第二个世界的种子每次都换了', () => {
    const samples = fc.sample(fc.tuple(seedArb, fc.constantFrom(...PARAM_SETS), picksArb, prefixArb, noiseArb), {
      numRuns: RUNS,
      seed: SAMPLE_SEED,
    });
    /** 键是"参数名：房型：类别"，值是改了的房间数（跨样本累计）。 */
    const changed = new Map<string, number>();
    for (const [seed, [label, params], picks, prefixLength, noise] of samples) {
      // 先给每间房不同的描述编号：生成的描述都是 null，改成 null 就看不出改没改。
      const world = withDescriptions(generate(seed, params));
      const end = lastOf(playShift(world, picks, prefixLength).states);
      const other = hideDifferently(world, end, noise);
      expect(other.seed, `${label} ${JSON.stringify(seed)}`).not.toBe(world.seed);

      const visited = new Set(end.log.flatMap((entry) => (entry.action.type === 'service' ? [entry.action.room] : [])));
      world.rooms.forEach((truth, index) => {
        const room: RoomAtEnd = { truth, known: at(end.rooms, index), visited: visited.has(truth.id) };
        for (const { name, kinds, isChanged } of UNREVEALED) {
          if (!kinds.includes(truth.kind) || !isChanged(room, at(other.rooms, index))) continue;
          const key = cellOf(label, truth.kind, name);
          changed.set(key, (changed.get(key) ?? 0) + 1);
        }
      });
    }

    // 每套参数、每一类、这一类涉及的每种房型都至少改动过一间房。退化成一项都不改，漏掉某一类，
    // 或者某一类只漏掉一种房型，这里都会列出来。
    const expected = PARAM_SETS.flatMap(([label]) =>
      UNREVEALED.flatMap(({ name, kinds }) => kinds.map((kind) => cellOf(label, kind, name))),
    );
    const missed = expected.filter((key) => (changed.get(key) ?? 0) === 0);
    expect(missed, JSON.stringify(Object.fromEntries(changed))).toEqual([]);
  });
});

// hideDifferently 推错了某个只知道范围的值，把它改到已知的范围之外（改到了玩家已经知道的信息）时，
// 同一前缀在第二个世界里的某一步会对不上。只在少数前缀上才出错的推错，随机抽 100 个例子的不泄露性质未必抽得到；
// 这里的样本固定，抽到了就每次都抓得到。
describe('自检：hideDifferently 造的第二个世界', () => {
  it(
    `ODD_PARAMS：固定种子抽 ${REPLAY_RUNS} 个前缀，同一前缀在第二个世界里逐步重放，每一步的状态都和原来的完全相同`,
    () => {
      const samples = fc.sample(fc.tuple(seedArb, picksArb, prefixArb, noiseArb), {
        numRuns: REPLAY_RUNS,
        seed: SAMPLE_SEED,
      });
      const mismatches = samples.flatMap(([seed, picks, prefixLength, noise], index) => {
        const found = replayMismatch(generate(seed, ODD_PARAMS), picks, prefixLength, noise);
        return found === null ? [] : [`样本 ${index}（种子 ${JSON.stringify(seed)}，前缀 ${prefixLength} 步）：${found}`];
      });
      expect(mismatches).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    '三档：同上，难度档也随样本抽',
    () => {
      const samples = fc.sample(fc.tuple(seedArb, tierArb, picksArb, prefixArb, noiseArb), {
        numRuns: REPLAY_RUNS,
        seed: SAMPLE_SEED,
      });
      const mismatches = samples.flatMap(([seed, tier, picks, prefixLength, noise], index) => {
        const found = replayMismatch(generate(seed, PARAMS[tier]), picks, prefixLength, noise);
        return found === null ? [] : [`样本 ${index}（${tier}，种子 ${JSON.stringify(seed)}，前缀 ${prefixLength} 步）：${found}`];
      });
      expect(mismatches).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('自检：playShift 的随机序列', () => {
  it('三档：固定种子抽的这批班次里，每类关键状态都至少有一局走到', () => {
    const traces = fc
      .sample(fc.tuple(seedArb, tierArb, picksArb), { numRuns: RUNS, seed: SAMPLE_SEED })
      .map(([seed, tier, picks]) => playShift(generate(seed, PARAMS[tier]), picks));
    expectMilestones(traces, MILESTONES);
  });

  it("ODD_PARAMS：同上，只是不要求以 'returned' 结束", () => {
    // 按 ODD_PARAMS 的耗时（按线索比例和脏乱分布加权），退房房平均每间 47.65 分钟，续住房 23.14 分钟，
    // 6 × 47.65 + 7 × 23.14 ≈ 448 分钟，加上 20 分钟休息约 468 分钟，接近 480 分钟的班次。
    // 随机序列还要走路、打电话、等待，17:00 前做不完已知的房间，不会自己收工。
    const traces = fc
      .sample(fc.tuple(seedArb, picksArb), { numRuns: RUNS, seed: SAMPLE_SEED })
      .map(([seed, picks]) => playShift(generate(seed, ODD_PARAMS), picks));
    expectMilestones(traces, MILESTONES.filter((milestone) => milestone !== RETURNED));
  });
});
