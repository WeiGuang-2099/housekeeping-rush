/**
 * 把 runSim 的结果整理成评测表，输出 Markdown 文本，scripts/sim.mjs 把它打印出来。指标的出处是 docs/DESIGN.md 的
 * "平衡与评测"和 docs/TASKS.md 阶段 0 的关口。口径同样写在报告的末尾，引用数字时连同口径一起看。
 *
 * 1. 成绩是 score 的等效下班时间：还车完成的时刻加全部罚时，越早越好。单位是分钟，从 08:30 起算；钟点由 toClock 换算，
 *    四舍五入到分钟。
 * 2. 每档、每个幽灵：平均等效下班时间；等效下班时间不晚于目标下班时间（params.shift.targetFinish，16:00，恰好 16:00
 *    也算）的局数比例；等效下班时间的总体标准差（除以局数），也就是同一个幽灵在不同种子之间的运气幅度；
 *    调参看的诊断，都是每班平均：错过的贵宾时限、未完成的房间、步行分钟。
 * 3. 新手落后全知：每一局新手减全知的等效下班时间，取平均。全知不如新手的局数也列出来：全知是束搜索的近似，
 *    不保证每一局都不比新手差。
 * 4. 关口（GATE，docs/TASKS.md 阶段 0，2026-11-16 定的口径）：标准、紧、周末三档各跑 1000 个种子，每一档新手平均都落后
 *    全知至少 30 分钟，这一档才算过；三档都过才算过关。报告按档判断过没过，最后给总结论（judgeGate）：三档都跑了、
 *    每档都是 1000 个种子时才下结论，否则写明缺什么，按这次的数说一句，只作参考。关口还要求测试全部通过，
 *    那一条不归模拟器判断，报告里提醒用 npm test 另查。
 * 5. 纯函数，不读系统时间：同样的结果给出同样的文本。
 */

import { toClock, type Minute, type Tier } from '../engine';
import { SIM_GHOSTS, SIM_TIERS, type GhostShift, type SimGhost, type TierResult } from './run';

/**
 * docs/TASKS.md 阶段 0 的关口（文件开头第 4 条）：这几档（标准、紧、周末三档）各跑 seeds 个种子，每一档新手平均都落后
 * 全知至少 gapMinutes 分钟，三档都过才算过关。
 */
export const GATE = { tiers: SIM_TIERS, seeds: 1000, gapMinutes: 30 } as const;

const TIER_NAMES: Readonly<Record<Tier, string>> = { standard: '标准档', tight: '紧档', weekend: '周末档' };
const GHOST_NAMES: Readonly<Record<SimGhost, string>> = { novice: '新手', oracle: '全知' };

/** 一个幽灵在一档里的统计（文件开头第 2 条）。分钟都从 08:30 起算。 */
export interface GhostStats {
  /** 平均等效下班时间。 */
  readonly meanFinish: Minute;
  /** 等效下班时间的总体标准差，分钟。 */
  readonly sdFinish: number;
  /** 等效下班时间不晚于目标下班时间的局数比例，0 到 1。 */
  readonly onTargetShare: number;
  /** 每班平均错过的贵宾时限个数。 */
  readonly lateVips: number;
  /** 每班平均未完成的房间数。 */
  readonly unfinishedRooms: number;
  /** 每班平均步行分钟。 */
  readonly walkedMinutes: number;
}

/** 一档的统计。 */
export interface TierSummary {
  readonly tier: Tier;
  /** 局数。 */
  readonly shifts: number;
  /** 目标下班时间，params.shift.targetFinish。 */
  readonly targetFinish: Minute;
  readonly ghosts: Readonly<Record<SimGhost, GhostStats>>;
  /** 新手落后全知的平均分钟数：每一局新手减全知，取平均。 */
  readonly gap: number;
  /** gap 不少于 GATE.gapMinutes。 */
  readonly passesGate: boolean;
  /** 全知的等效下班时间比新手晚的局数。 */
  readonly oracleWorse: number;
}

/** 每档的统计，按 results 的顺序。有一档一局都没有时抛错。 */
export function summarize(results: readonly TierResult[]): TierSummary[] {
  return results.map((result): TierSummary => {
    const { shifts, tier } = result;
    if (shifts.length === 0) throw new Error(`report: ${tier} 一局都没有`);
    const targetFinish = result.params.shift.targetFinish;
    const statsFor = (ghost: SimGhost): GhostStats =>
      statsOf(
        shifts.map((shift) => shift.ghosts[ghost]),
        targetFinish,
      );
    const gaps = shifts.map(
      (shift) => shift.ghosts.novice.score.equivalentFinish - shift.ghosts.oracle.score.equivalentFinish,
    );
    const gap = mean(gaps);
    return {
      tier,
      shifts: shifts.length,
      targetFinish,
      ghosts: { novice: statsFor('novice'), oracle: statsFor('oracle') },
      gap,
      passesGate: gap >= GATE.gapMinutes,
      oracleWorse: gaps.filter((value) => value < 0).length,
    };
  });
}

/** 评测表的 Markdown 文本，以换行结尾。内容见文件开头。 */
export function formatReport(results: readonly TierResult[]): string {
  const summaries = summarize(results);
  const first = results[0]?.shifts;
  const firstSeed = first?.[0]?.seed;
  const lastSeed = first?.at(-1)?.seed;
  if (first === undefined || firstSeed === undefined || lastSeed === undefined) throw new Error('report: 没有结果');
  const seedCounts = new Set(summaries.map((summary) => summary.shifts));
  const lines: string[] = [
    '# 批量模拟',
    '',
    `每档 ${[...seedCounts].join('、')} 个种子（${firstSeed} 到 ${lastSeed}，各档用同一批），新手和全知各做一班。` +
      '成绩是等效下班时间（含罚时），越早越好。',
  ];
  for (const summary of summaries) lines.push('', ...tierSection(summary));
  lines.push('', ...gateSection(summaries), '', ...definitions(summaries));
  return `${lines.join('\n')}\n`;
}

/** 一档的表格和差距那一行。 */
function tierSection(summary: TierSummary): string[] {
  const row = (label: string, cell: (stats: GhostStats) => string): string =>
    `| ${label} | ${SIM_GHOSTS.map((ghost) => cell(summary.ghosts[ghost])).join(' | ')} |`;
  return [
    `## ${TIER_NAMES[summary.tier]}（${summary.shifts} 局）`,
    '',
    `| 指标 | ${SIM_GHOSTS.map((ghost) => GHOST_NAMES[ghost]).join(' | ')} |`,
    `| --- | ${SIM_GHOSTS.map(() => '---').join(' | ')} |`,
    row('平均等效下班时间', (stats) => `${toClock(stats.meanFinish)}（${fixed(stats.meanFinish, 1)} 分钟）`),
    row(`不晚于 ${toClock(summary.targetFinish)} 的比例`, (stats) => `${fixed(stats.onTargetShare * 100, 1)}%`),
    row('标准差（运气幅度）', (stats) => `${fixed(stats.sdFinish, 1)} 分钟`),
    row('每班错过的贵宾时限', (stats) => `${fixed(stats.lateVips, 2)} 个`),
    row('每班未完成的房间', (stats) => `${fixed(stats.unfinishedRooms, 2)} 间`),
    row('每班步行', (stats) => `${fixed(stats.walkedMinutes, 1)} 分钟`),
    '',
    `新手平均落后全知 ${fixed(summary.gap, 1)} 分钟，关口 ${GATE.gapMinutes} 分钟：${verdict(summary)}。` +
      `全知不如新手的局数：${summary.oracleWorse}。`,
  ];
}

/** 关口的总结论（文件开头第 4 条）。 */
export interface GateVerdict {
  /** 能下结论：GATE.tiers 的每一档都跑了，并且每档都是 GATE.seeds 个种子。 */
  readonly complete: boolean;
  /** 过关：能下结论，并且每一档都过。 */
  readonly passed: boolean;
  /** 跑了但没过的档，按跑的顺序。 */
  readonly failedTiers: readonly Tier[];
  /** 关口要、这次却没跑的档，按 GATE.tiers 的顺序。 */
  readonly missingTiers: readonly Tier[];
}

/** 关口的总结论：三档都跑了、每档都是 GATE.seeds 个种子才下结论，三档都过才算过关。 */
export function judgeGate(summaries: readonly TierSummary[]): GateVerdict {
  const ran = new Set(summaries.map((summary) => summary.tier));
  const missingTiers = GATE.tiers.filter((tier) => !ran.has(tier));
  const failedTiers = summaries.filter((summary) => !summary.passesGate).map((summary) => summary.tier);
  const complete = missingTiers.length === 0 && summaries.every((summary) => summary.shifts === GATE.seeds);
  return { complete, passed: complete && failedTiers.length === 0, failedTiers, missingTiers };
}

/** 关口一节：口径、每档过没过、总结论。 */
function gateSection(summaries: readonly TierSummary[]): string[] {
  const perTier = summaries.map((summary) => `${TIER_NAMES[summary.tier]} ${fixed(summary.gap, 1)} 分钟，${verdict(summary)}`);
  return [
    '## 关口',
    '',
    `口径（docs/TASKS.md 阶段 0）：${tierNames(GATE.tiers)}各跑 ${GATE.seeds} 个种子，每一档新手平均都落后全知至少 ` +
      `${GATE.gapMinutes} 分钟，这一档才算过；三档都过才算过关。关口还要求测试全部通过，那一条用 npm test 另查。`,
    '',
    `各档：${perTier.join('；')}。`,
    '',
    conclusion(judgeGate(summaries), summaries),
  ];
}

/** 总结论那一句。下不了结论时写明缺什么，再按这次的数说一句，只作参考。 */
function conclusion(gate: GateVerdict, summaries: readonly TierSummary[]): string {
  if (gate.complete) {
    return gate.passed ? '结论：过关，三档都过了。' : `结论：没过关，没过的档：${tierNames(gate.failedTiers)}。`;
  }
  const lacking: string[] = [];
  if (gate.missingTiers.length > 0) lacking.push(`没跑${tierNames(gate.missingTiers)}`);
  const counts = [...new Set(summaries.map((summary) => summary.shifts))];
  if (counts.some((count) => count !== GATE.seeds)) lacking.push(`每档跑了 ${counts.join('、')} 个种子`);
  const soFar = gate.failedTiers.length === 0 ? '跑的档都过了' : `没过的档：${tierNames(gate.failedTiers)}`;
  return `结论：这次不下结论。关口要三档各跑 ${GATE.seeds} 个种子，这次${lacking.join('，')}。按这次的数，${soFar}，只作参考。`;
}

function tierNames(tiers: readonly Tier[]): string {
  return tiers.map((tier) => TIER_NAMES[tier]).join('、');
}

/** 口径一节（文件开头第 1 到 3 条）。 */
function definitions(summaries: readonly TierSummary[]): string[] {
  const targets = [...new Set(summaries.map((summary) => toClock(summary.targetFinish)))].join('、');
  return [
    '## 口径',
    '',
    '- 成绩是 score 的等效下班时间：还车完成的时刻加全部罚时。分钟从 08:30 起算，钟点四舍五入到分钟。平均是这一档全部局的算术平均。',
    `- 不晚于 ${targets} 的比例：等效下班时间不晚于目标下班时间（params.shift.targetFinish）的局数占这一档局数的比例，恰好 ${targets} 也算。`,
    '- 标准差是等效下班时间的总体标准差（除以局数），说明同一个幽灵在不同种子之间成绩差多少，也就是运气幅度。',
    '- 新手落后全知：每一局新手减全知的等效下班时间，取平均。',
    '- 错过的贵宾时限是晚于时限做完或者没做完的贵宾房间数；未完成的房间按 score 的口径，被 17:00 截断的算，' +
      '收工时已经摘牌却没做的请勿打扰房也算（不管知不知道摘牌）；步行是全班走路的分钟数。三项都是每班平均。',
    '- 全知不如新手的局数：全知的等效下班时间比新手晚的局数。全知是束搜索的近似（src/policies/oracle.ts），不保证每一局都不比新手差。',
  ];
}

function verdict(summary: TierSummary): string {
  return summary.passesGate ? '过' : '没过';
}

/** 一个幽灵在一档里的统计（文件开头第 2 条）。runs 不能是空的。 */
function statsOf(runs: readonly GhostShift[], targetFinish: Minute): GhostStats {
  const finishes = runs.map((run) => run.score.equivalentFinish);
  const meanFinish = mean(finishes);
  return {
    meanFinish,
    sdFinish: Math.sqrt(mean(finishes.map((value) => (value - meanFinish) ** 2))),
    onTargetShare: finishes.filter((value) => value <= targetFinish).length / finishes.length,
    lateVips: mean(runs.map((run) => run.lateVips)),
    unfinishedRooms: mean(runs.map((run) => run.unfinishedRooms)),
    walkedMinutes: mean(runs.map((run) => run.score.walkedMinutes)),
  };
}

/** 算术平均。values 不能是空的。 */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 保留 digits 位小数；四舍五入以后是零的负数（例如 -0.04 保留一位）写成不带负号的零。 */
function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}
