/**
 * 批量模拟（docs/DESIGN.md 的"平衡与评测"）：每一档跑同一批固定的种子，新手和全知各做一班，用 score 计分。
 * 报告的整理和格式在 report.ts，命令行在 scripts/sim.mjs（npm run sim）。
 *
 * 1. 种子。第 i 个种子（从 0 数）是 sim-i，三档用同一批：同一个种子在三档里是同一串随机数，参数不同。
 * 2. 每一局。generate(种子, PARAMS[档]) 得到世界，新手和全知各用共用驱动函数 runShift 从开工做到班次结束
 *    （新手每一步只拿到 observe 的结果和 world.params，全知拿 world 和 state，见 src/engine/drive.ts），再用 score 计分。
 * 3. 诊断用的间数：错过时限的贵宾房（晚于时限做完或者没做完）和未完成的房间。按每间罚 1 分钟再用 score 算一遍，
 *    罚时的合计就是间数，口径和 score 完全相同，不在这里另写一份。
 * 4. 这里只返回结果，不打印、不计时、不读命令行参数，那些在 scripts/sim.mjs 里。这里的代码不用 Node 的 API，
 *    在浏览器里也能跑。没有随机数，不读系统时间：同样的选项给出同样的结果。
 */

import {
  generate,
  PARAMS,
  runShift,
  score,
  type Ghost,
  type Params,
  type Score,
  type State,
  type Tier,
  type World,
} from '../engine';
import { novice } from '../policies/novice';
import { oracle } from '../policies/oracle';

/** 模拟器跑的幽灵，也是报告里各列的顺序。 */
export const SIM_GHOSTS = ['novice', 'oracle'] as const;
export type SimGhost = (typeof SIM_GHOSTS)[number];

/** 每个幽灵交给 runShift 的写法：新手只看 View，全知拿 World。 */
const GHOSTS: Readonly<Record<SimGhost, Ghost>> = {
  novice: { kind: 'view', policy: novice },
  oracle: { kind: 'oracle', policy: oracle },
};

/** 模拟器能跑的档，也是默认跑的档和报告里的顺序。 */
export const SIM_TIERS: readonly Tier[] = ['standard', 'tight', 'weekend'];

export interface SimOptions {
  /** 跑哪几档，按这个顺序，不能重复。 */
  readonly tiers: readonly Tier[];
  /** 每档跑多少个种子：sim-0 到 sim-(seeds - 1)。 */
  readonly seeds: number;
  /** 每做完一局（两个幽灵各一班）调用一次，给出已做完的局数和总局数。scripts/sim.mjs 用它显示进度。 */
  readonly onProgress?: (done: number, total: number) => void;
}

/** 一个幽灵做完一班的结果。 */
export interface GhostShift {
  readonly score: Score;
  /** 错过时限的贵宾房间数：晚于时限做完，或者没做完。 */
  readonly lateVips: number;
  /** 未完成的房间数，score 的口径（见 src/engine/score.ts 开头第 3 条）。 */
  readonly unfinishedRooms: number;
}

/** 一局：一个种子在一档里，每个幽灵各做一班。 */
export interface ShiftResult {
  readonly seed: string;
  readonly ghosts: Readonly<Record<SimGhost, GhostShift>>;
}

/** 一档的全部局，按种子的顺序。 */
export interface TierResult {
  readonly tier: Tier;
  /** 这一档的参数，就是 PARAMS[tier]。 */
  readonly params: Params;
  readonly shifts: readonly ShiftResult[];
}

/** 前 count 个种子：sim-0 到 sim-(count - 1)。 */
export function simSeeds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `sim-${index}`);
}

/**
 * 按选项跑完全部局，规则见文件开头。种子数不是正整数、没有选档、档重复或者不认识时抛错。
 */
export function runSim(options: SimOptions): TierResult[] {
  const { tiers, seeds } = checkOptions(options);
  const total = tiers.length * seeds.length;
  let done = 0;
  return tiers.map((tier): TierResult => {
    const params = PARAMS[tier];
    const shifts = seeds.map((seed): ShiftResult => {
      const world = generate(seed, params);
      const result: ShiftResult = { seed, ghosts: { novice: runGhost(world, 'novice'), oracle: runGhost(world, 'oracle') } };
      done += 1;
      options.onProgress?.(done, total);
      return result;
    });
    return { tier, params, shifts };
  });
}

/** 选项不合法就抛错，合法就返回要跑的档和种子。 */
function checkOptions(options: SimOptions): { tiers: readonly Tier[]; seeds: string[] } {
  const { tiers, seeds } = options;
  if (!Number.isInteger(seeds) || seeds < 1) throw new Error(`sim: 种子数要是正整数，收到的是 ${String(seeds)}`);
  if (tiers.length === 0) throw new Error('sim: 至少要选一档');
  for (const tier of tiers) {
    if (!SIM_TIERS.includes(tier)) throw new Error(`sim: 没有 ${String(tier)} 这一档，可选的是 ${SIM_TIERS.join('、')}`);
  }
  if (new Set(tiers).size !== tiers.length) throw new Error(`sim: 档重复了：${tiers.join('、')}`);
  return { tiers, seeds: simSeeds(seeds) };
}

/** 一局里的一个幽灵：从开工做到班次结束，计分，再数出诊断用的间数（文件开头第 2、3 条）。 */
export function runGhost(world: World, ghost: SimGhost): GhostShift {
  const { final } = runShift(world, GHOSTS[ghost]);
  return { score: score(world, final), ...countRooms(world, final) };
}

/** 每间罚 1 分钟：用它计分，每项罚时的合计就是间数。 */
const UNIT_PENALTIES: Params['penalties'] = { vipLate: 1, rushLate: 1, unfinished: 1 };

/** 错过时限的贵宾房间数和未完成的房间数，按每间罚 1 分钟用 score 再算一遍（见文件开头第 3 条）。 */
function countRooms(world: World, final: State): { lateVips: number; unfinishedRooms: number } {
  const counted = score({ ...world, params: { ...world.params, penalties: UNIT_PENALTIES } }, final);
  return { lateVips: counted.penalties.vipLate, unfinishedRooms: counted.penalties.unfinished };
}
