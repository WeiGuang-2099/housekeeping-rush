/**
 * 批量模拟器（src/sim）的测试。命令行 scripts/sim.mjs 只读参数、计时和打印，不在这里测。
 *
 * 1. 冒烟：三档各跑几个种子。每一局另外不经驱动函数、直接用 apply 逐步做一遍（新手每一步拿深度冻结的 observe 结果和
 *    world.params，全知拿深度冻结的 world 和 state），score 和模拟器给的完全相同；错过时限的贵宾房和未完成的房间
 *    另按定义数一遍。报告的统计等于按口径从逐局成绩直接算出的数，报告文本里写的也是这些数。进度回调按局数调用。
 * 2. 同样的选项跑两次，结果和报告文本完全相同；种子是 sim-0 起的一串，各档相同。
 * 3. 口径的边界（手工写的逐局成绩）：恰好在目标下班时间算不晚于；标准差是总体标准差；差距恰好是关口算过，差一点不算；
 *    全知比新手晚的局数。
 * 4. 关口的总结论（手工写的逐局成绩）：三档各 1000 个种子、三档都过才算过关；有一档没过就没过关；少跑一档或者种子数
 *    不是 1000 时不下结论，写明缺什么，只作参考。
 * 5. 选项不合法时抛错。
 * 用到的数值从 params 读：目标下班时间是 params.shift.targetFinish，每间的罚时是 params.penalties。
 */

import { describe, expect, it } from 'vitest';
import { toClock } from '../src/engine/clock';
import { generate } from '../src/engine/generate';
import { allRooms } from '../src/engine/layout';
import { observe } from '../src/engine/observe';
import { PARAMS, type Tier } from '../src/engine/params';
import { apply, initial } from '../src/engine/rules';
import { score } from '../src/engine/score';
import type { Action, Score, State, World } from '../src/engine/types';
import { novice } from '../src/policies/novice';
import { oracle } from '../src/policies/oracle';
import {
  formatReport,
  GATE,
  judgeGate,
  runGhost,
  runSim,
  SIM_GHOSTS,
  SIM_TIERS,
  simSeeds,
  summarize,
  type GhostShift,
  type ShiftResult,
  type SimGhost,
  type TierResult,
} from '../src/sim';
import { at, deepFreeze, TIMEOUT } from './helpers/play';
import { controlledWorld, departure } from './helpers/world';

/** 冒烟测试每档跑几个种子。 */
const SEEDS = 3;

/** 不经驱动函数，直接用 apply 逐步做完一班，返回结束时的状态。 */
function playByHand(world: World, decide: (world: World, state: State) => Action): State {
  let state = initial(world);
  while (state.ended === null) state = apply(world, state, decide(world, state));
  return state;
}

/** 两个幽灵各自直接做一班：新手拿深度冻结的 observe 结果和 world.params，全知拿深度冻结的 world 和 state。 */
const BY_HAND: Readonly<Record<SimGhost, (world: World, state: State) => Action>> = {
  novice: (world, state) => novice(deepFreeze(observe(world, state)), world.params),
  oracle: (world, state) => oracle(deepFreeze(world), deepFreeze(state)),
};

/** 错过时限的贵宾房间数，按定义直接数：有贵宾时限，没做完或者晚于时限做完。 */
function lateVipsOf(world: World, final: State): number {
  return world.rooms.filter((room, index) => {
    const { doneAt } = at(final.rooms, index);
    return room.vipDeadline !== null && (doneAt === null || doneAt > room.vipDeadline);
  }).length;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 总体标准差（除以个数）。 */
function populationSd(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

describe('冒烟：三档各跑几个种子', () => {
  // 跑一次，几个用例共用。
  const progress: [number, number][] = [];
  const results = runSim({ tiers: SIM_TIERS, seeds: SEEDS, onProgress: (done, total) => progress.push([done, total]) });

  it('结构：按选的档排，参数就是 PARAMS 里那一档，种子是 sim-0 起的一串、各档相同；每做完一局报一次进度', () => {
    expect(results.map((result) => result.tier)).toEqual([...SIM_TIERS]);
    for (const result of results) {
      expect(result.params).toBe(PARAMS[result.tier]);
      expect(result.shifts.map((shift) => shift.seed)).toEqual(simSeeds(SEEDS));
    }
    expect(simSeeds(SEEDS)).toEqual(['sim-0', 'sim-1', 'sim-2']);
    const total = SIM_TIERS.length * SEEDS;
    expect(progress).toEqual(Array.from({ length: total }, (_, index) => [index + 1, total]));
  });

  it(
    '每一局：直接用 apply 逐步做一遍，score 完全相同；错过时限的贵宾房和未完成的房间按定义另数一遍，也相同',
    () => {
      for (const result of results) {
        for (const shift of result.shifts) {
          const world = generate(shift.seed, result.params);
          for (const ghost of SIM_GHOSTS) {
            const label = `${result.tier} ${shift.seed} ${ghost}`;
            const final = playByHand(world, BY_HAND[ghost]);
            const expected = score(world, final);
            const got = shift.ghosts[ghost];
            expect(got.score, label).toStrictEqual(expected);
            expect(got.lateVips, label).toBe(lateVipsOf(world, final));
            expect(got.unfinishedRooms, label).toBe(expected.penalties.unfinished / world.params.penalties.unfinished);
          }
        }
      }
    },
    TIMEOUT,
  );

  it('报告的统计等于按口径从逐局成绩直接算出的数，报告文本里写的也是这些数', () => {
    const summaries = summarize(results);
    const text = formatReport(results);
    expect(summaries.map((summary) => summary.tier)).toEqual([...SIM_TIERS]);
    // 每档只跑了几个种子：不下总结论。
    expect(judgeGate(summaries)).toMatchObject({ complete: false, passed: false, missingTiers: [] });
    expect(text).toContain('结论：这次不下结论');
    results.forEach((result, index) => {
      const summary = at(summaries, index);
      const { targetFinish } = result.params.shift;
      expect(summary.shifts).toBe(SEEDS);
      expect(summary.targetFinish).toBe(targetFinish);
      const cells: Record<SimGhost, string[]> = { novice: [], oracle: [] };
      for (const ghost of SIM_GHOSTS) {
        const runs = result.shifts.map((shift) => shift.ghosts[ghost]);
        const finishes = runs.map((run) => run.score.equivalentFinish);
        const stats = summary.ghosts[ghost];
        const expected = {
          meanFinish: mean(finishes),
          sdFinish: populationSd(finishes),
          onTargetShare: finishes.filter((finish) => finish <= targetFinish).length / finishes.length,
          lateVips: mean(runs.map((run) => run.lateVips)),
          unfinishedRooms: mean(runs.map((run) => run.unfinishedRooms)),
          walkedMinutes: mean(runs.map((run) => run.score.walkedMinutes)),
        };
        for (const [key, value] of Object.entries(expected)) {
          expect(stats[key as keyof typeof expected], `${result.tier} ${ghost} ${key}`).toBeCloseTo(value, 9);
        }
        cells[ghost] = [
          `${toClock(expected.meanFinish)}（${expected.meanFinish.toFixed(1)} 分钟）`,
          `${(expected.onTargetShare * 100).toFixed(1)}%`,
          `${expected.sdFinish.toFixed(1)} 分钟`,
          `${expected.lateVips.toFixed(2)} 个`,
          `${expected.unfinishedRooms.toFixed(2)} 间`,
          `${expected.walkedMinutes.toFixed(1)} 分钟`,
        ];
      }
      const gaps = result.shifts.map(
        (shift) => shift.ghosts.novice.score.equivalentFinish - shift.ghosts.oracle.score.equivalentFinish,
      );
      expect(summary.gap).toBeCloseTo(mean(gaps), 9);
      expect(summary.passesGate).toBe(mean(gaps) >= GATE.gapMinutes);
      expect(summary.oracleWorse).toBe(gaps.filter((gap) => gap < 0).length);

      // 这一档的表格：每一行的两格，按新手、全知的顺序。
      const labels = [
        '平均等效下班时间',
        `不晚于 ${toClock(targetFinish)} 的比例`,
        '标准差（运气幅度）',
        '每班错过的贵宾时限',
        '每班未完成的房间',
        '每班步行',
      ];
      labels.forEach((label, row) => {
        expect(text, `${result.tier} ${label}`).toContain(`| ${label} | ${at(cells.novice, row)} | ${at(cells.oracle, row)} |`);
      });
      expect(text).toContain(`新手平均落后全知 ${mean(gaps).toFixed(1)} 分钟，关口 ${GATE.gapMinutes} 分钟`);
    });
  });

  it(
    '错过时限的贵宾房和未完成的房间（冒烟的几局里没有未完成的房间，所以另用受控世界）：15 间都是灾难档的退房房，' +
      '两间贵宾房的时限早到谁也赶不上，两个幽灵都既有错过的时限、又有做不完的房间；runGhost 数出来的和按定义数的相同',
    () => {
      const params = PARAMS.standard;
      // 打扫一间要 30 × 1.6 = 48 分钟，打电话标记已退至少 2 分钟：时限 40 谁也赶不上；15 间要 720 分钟，17:00 前做不完。
      const deadline = params.callMinutes + params.rooms.departure.baseMinutes * params.messMultiplier.disaster - 10;
      const ids = allRooms(params);
      const vips = new Set(ids.slice(0, 2));
      const world = controlledWorld(
        Object.fromEntries(
          ids.map((id) => [id, departure({ mess: 'disaster', vipDeadline: vips.has(id) ? deadline : null })]),
        ),
        { params },
      );
      for (const ghost of SIM_GHOSTS) {
        const result = runGhost(world, ghost);
        const final = playByHand(world, BY_HAND[ghost]);
        expect(result.score, ghost).toStrictEqual(score(world, final));
        expect(result.lateVips, ghost).toBe(lateVipsOf(world, final));
        // 都是退房房：没做完就算未完成。
        expect(result.unfinishedRooms, ghost).toBe(final.rooms.filter((room) => room.doneAt === null).length);
        expect(result.lateVips, ghost).toBe(vips.size);
        expect(result.unfinishedRooms, ghost).toBeGreaterThan(0);
      }
    },
    TIMEOUT,
  );

  it(
    '同样的选项跑两次，结果和报告文本完全相同',
    () => {
      const again = runSim({ tiers: SIM_TIERS, seeds: SEEDS });
      expect(again).toStrictEqual(results);
      expect(formatReport(again)).toBe(formatReport(results));
    },
    TIMEOUT,
  );
});

/** 手工写的成绩：只有等效下班时间和步行分钟有意义，没有罚时。 */
function fakeScore(equivalentFinish: number, walkedMinutes = 0): Score {
  return {
    finishMinute: equivalentFinish,
    penalties: { vipLate: 0, rushLate: 0, unfinished: 0 },
    equivalentFinish,
    roomsDone: 0,
    walkedMinutes,
    violation: false,
    failed: false,
  };
}

function fakeGhost(equivalentFinish: number, lateVips = 0, unfinishedRooms = 0): GhostShift {
  return { score: fakeScore(equivalentFinish), lateVips, unfinishedRooms };
}

/** 手工写的一档：每一项是 [新手的等效下班时间, 全知的等效下班时间]。 */
function fakeTier(tier: Tier, finishes: readonly (readonly [number, number])[]): TierResult {
  const shifts = finishes.map(
    ([noviceFinish, oracleFinish], index): ShiftResult => ({
      seed: `sim-${index}`,
      ghosts: { novice: fakeGhost(noviceFinish), oracle: fakeGhost(oracleFinish) },
    }),
  );
  return { tier, params: PARAMS[tier], shifts };
}

describe('口径的边界', () => {
  const target = PARAMS.standard.shift.targetFinish;

  it('恰好在目标下班时间算不晚于，晚 1 分钟不算；标准差除以局数（总体标准差）', () => {
    // 新手：target - 10、target + 10，平均 target，总体标准差 10（除以局数减 1 会是 14.1）。
    // 全知：target、target + 1，恰好 target 的那一局算。
    const [summary] = summarize([
      fakeTier('standard', [
        [target - 10, target],
        [target + 10, target + 1],
      ]),
    ]);
    if (summary === undefined) throw new Error('没有统计');
    expect(summary.ghosts.novice.meanFinish).toBe(target);
    expect(summary.ghosts.novice.sdFinish).toBe(10);
    expect(summary.ghosts.novice.onTargetShare).toBe(0.5);
    expect(summary.ghosts.oracle.onTargetShare).toBe(0.5);
  });

  it('差距恰好是关口算过，差半分钟不算；全知比新手晚的局数单独列出，一样的不算', () => {
    // 三局的差距是 3 × 关口 + 5、-5（这一局全知比新手晚）和 0（一样），平均恰好是关口。
    const exact = summarize([
      fakeTier('tight', [
        [target + 3 * GATE.gapMinutes + 5, target],
        [target, target + 5],
        [target, target],
      ]),
    ]);
    expect(exact.map((summary) => [summary.gap, summary.passesGate, summary.oracleWorse])).toEqual([[GATE.gapMinutes, true, 1]]);
    const short = [fakeTier('tight', [[target + GATE.gapMinutes - 0.5, target]])];
    expect(summarize(short).map((summary) => [summary.gap, summary.passesGate, summary.oracleWorse])).toEqual([
      [GATE.gapMinutes - 0.5, false, 0],
    ]);
    const text = formatReport(short);
    expect(text).toContain(`关口 ${GATE.gapMinutes} 分钟：没过`);
    expect(text).toContain('没过的档：紧档');
  });

  it('有一档一局都没有时抛错', () => {
    expect(() => summarize([fakeTier('standard', [])])).toThrow('一局都没有');
  });
});

describe(`关口的总结论：三档各跑 ${GATE.seeds} 个种子，每一档都过才算过关`, () => {
  const target = PARAMS.standard.shift.targetFinish;
  /** 手工写的一档：count 局，每局新手比全知晚 gap 分钟。 */
  const tierOf = (tier: Tier, count: number, gap: number): TierResult =>
    fakeTier(
      tier,
      Array.from({ length: count }, () => [target + gap, target] as const),
    );
  const passing = GATE.gapMinutes + 30;
  const failing = GATE.gapMinutes - 1;
  const UNDECIDED = '结论：这次不下结论';

  it(`三档都是 ${GATE.seeds} 个种子、都过：过关，不注明只作参考`, () => {
    const results = GATE.tiers.map((tier) => tierOf(tier, GATE.seeds, passing));
    expect(GATE.tiers).toEqual(['standard', 'tight', 'weekend']);
    expect(judgeGate(summarize(results))).toEqual({ complete: true, passed: true, failedTiers: [], missingTiers: [] });
    const text = formatReport(results);
    expect(text).toContain('结论：过关，三档都过了。');
    expect(text).toContain(`每档 ${GATE.seeds} 个种子（sim-0 到 sim-${GATE.seeds - 1}`);
    expect(text).not.toContain('只作参考');
  });

  it(`三档都是 ${GATE.seeds} 个种子、有一档差 1 分钟：没过关，列出没过的档`, () => {
    const results = GATE.tiers.map((tier) => tierOf(tier, GATE.seeds, tier === 'weekend' ? failing : passing));
    expect(judgeGate(summarize(results))).toEqual({
      complete: true,
      passed: false,
      failedTiers: ['weekend'],
      missingTiers: [],
    });
    const text = formatReport(results);
    expect(text).toContain('结论：没过关，没过的档：周末档。');
    expect(text).not.toContain('只作参考');
  });

  it(`只跑了两档（各 ${GATE.seeds} 个种子、都过）：不下结论，写明没跑哪一档，只作参考`, () => {
    const results = [tierOf('standard', GATE.seeds, passing), tierOf('tight', GATE.seeds, passing)];
    expect(judgeGate(summarize(results))).toEqual({
      complete: false,
      passed: false,
      failedTiers: [],
      missingTiers: ['weekend'],
    });
    const text = formatReport(results);
    expect(text).toContain(UNDECIDED);
    expect(text).toContain('这次没跑周末档。按这次的数，跑的档都过了，只作参考。');
  });

  it(`三档都跑了、种子不是 ${GATE.seeds} 个：不下结论，写明种子数；有一档没过时按这次的数列出它`, () => {
    const results = GATE.tiers.map((tier) => tierOf(tier, 2, tier === 'tight' ? failing : passing));
    expect(judgeGate(summarize(results))).toEqual({
      complete: false,
      passed: false,
      failedTiers: ['tight'],
      missingTiers: [],
    });
    const text = formatReport(results);
    expect(text).toContain(UNDECIDED);
    expect(text).toContain('这次每档跑了 2 个种子。按这次的数，没过的档：紧档，只作参考。');
  });
});

describe('选项不合法时抛错', () => {
  it('种子数不是正整数', () => {
    for (const seeds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => runSim({ tiers: ['standard'], seeds }), String(seeds)).toThrow('种子数要是正整数');
    }
  });

  it('没有选档、档不认识、档重复', () => {
    expect(() => runSim({ tiers: [], seeds: 1 })).toThrow('至少要选一档');
    expect(() => runSim({ tiers: ['monday' as Tier], seeds: 1 })).toThrow('没有 monday 这一档');
    expect(() => runSim({ tiers: ['tight', 'tight'], seeds: 1 })).toThrow('档重复了');
  });
});
