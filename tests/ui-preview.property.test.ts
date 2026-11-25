/**
 * 动作预览（src/ui/preview.ts）的性质测试，三档和 ODD_PARAMS。单元测试见 ui-preview.test.ts。
 *
 * 轨迹有两种：随机合法序列（tests/helpers/play.ts 的 playShift），以及先随机走几步、再交给新手做到收工的序列
 * （policyChooser）。随机序列很少在 17:00 前做完所有房间，新手的轨迹补上按时收工、按需补货这些局面。
 * 每个状态上拿一批探测动作去预览：每间房的打扫，补货、打电话、休息、收工还车，1 到上限的每一种等待，
 * 再加超过上限一分钟的等待（不能等待时按 waitStepMinutes 探）。
 *
 * 1. 和规则一致：预览合法当且仅当 illegalReasonForView 为 null，不合法时原因相同；canPick 为 false 的一定不合法。
 * 2. 和 apply 一致：合法的动作交给 apply 执行，结果落在预览说的范围里。
 *    - 打扫：步行分钟数相同。敲门被拒时，回来的时刻就是 refusedAt（预览说过客人可能在）；做完时，完成时刻在 finish 的
 *      范围里，这次打扫的分钟数在 cleaning 的范围里，预览没说一定做不完，布草少了 linen 份；被 17:00 截断时，预览说过
 *      可能或一定做不完，停在 17:00，布草少了 linen 份。时限：赶得上的确实不晚于时限做完，赶不上的确实没有。
 *    - 别的动作：结束的时刻就是预览的 end，步行分钟数相同；补货以后车是满的，补回的份数是容量减原来的份数；
 *      休息从到达服务间开始；17:00 起的还车标成强制下班。
 * 3. 不泄露：hideDifferently 造的第二个世界（只改玩家还不知道的隐藏信息，种子也换掉）上，前缀的每一步、每个探测动作的
 *    预览完全相同，JSON 也相同。
 * 4. 自检（fc.sample 配固定种子）：三档和 ODD_PARAMS 各自的随机轨迹都走到了 SITUATIONS 列的情形
 *    （被拒、做完、截断、可能做不完、一定做不完、三种时限判断、客人可能在却进了门、每种别的动作、强制下班）。
 *    只有一种例外：ODD_PARAMS 房间多、打扫久、17:00（hardStop）又早，光打扫就超过一整班，谁都做不完，
 *    不会在 17:00 前收工，所以它不要求"收工还车"（"强制下班"照样要走到，收工还车的预览在那里照样核对）。
 *
 * 内层循环先收集对不上的地方，最后一起 expect，免得每个探测都调 expect 拖慢。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apply, generate, illegalReasonForView, observe, PARAMS, type Action, type Params, type State, type World } from '../src/engine';
import { novice } from '../src/policies/novice';
import { canPick, previewAction, waitLimit } from '../src/ui/preview';
import { hideDifferently } from './helpers/hidden';
import { ODD_PARAMS } from './helpers/params';
import { choose, lastOf, picksArb, playShift, policyChooser, RUNS, seedArb, TIMEOUT, type Chooser } from './helpers/play';

const PARAM_SETS = { standard: PARAMS.standard, tight: PARAMS.tight, weekend: PARAMS.weekend, ODD_PARAMS } as const;
type SetName = keyof typeof PARAM_SETS;
const SET_NAMES = Object.keys(PARAM_SETS) as SetName[];

/** 前缀的步数和构造第二个世界用的一串数，和 observe 的不泄露性质相同。 */
const prefixArb = fc.nat({ max: 120 });
/** 新手从第几步起接手。 */
const takeOverArb = fc.nat({ max: 40 });
const noiseArb = fc.array(fc.nat(), { minLength: 1, maxLength: 64 });
/** 自检用的固定种子。 */
const SAMPLE_SEED = 20261125;

/** 自检要走到的情形。 */
const SITUATIONS = [
  '敲门被拒',
  '做完',
  '被 17:00 截断',
  '可能做不完',
  '一定做不完',
  '赶得上',
  '可能赶不上',
  '赶不上',
  '客人可能在却进了门',
  '补货',
  '打电话',
  '休息',
  '等待',
  '收工还车',
  '强制下班',
  '不合法',
] as const;
type Situation = (typeof SITUATIONS)[number];

/** 每个状态拿去预览的动作，见文件开头。 */
function probes(world: World, state: State): Action[] {
  const view = observe(world, state);
  const limit = waitLimit(view, world.params) ?? world.params.waitStepMinutes;
  return [
    ...view.rooms.map((room): Action => ({ type: 'service', room: room.id })),
    { type: 'restock' },
    { type: 'call' },
    { type: 'break' },
    { type: 'finish' },
    ...Array.from({ length: limit + 1 }, (_, index): Action => ({ type: 'wait', minutes: index + 1 })),
  ];
}

/** 一个探测动作：对不上的地方（空数组就是都对得上），以及走到的情形。 */
function check(world: World, state: State, action: Action): { problems: string[]; situations: Situation[] } {
  const { params } = world;
  const { hardStop } = params.shift;
  const view = observe(world, state);
  const preview = previewAction(view, params, action);
  const reason = illegalReasonForView(view, params, action);
  const problems: string[] = [];
  const situations: Situation[] = [];
  const label = `${state.minute} 分钟 ${JSON.stringify(action)}`;
  const problem = (what: string): void => {
    problems.push(`${label}：${what}`);
  };

  if (!preview.ok) {
    if (JSON.stringify(preview.reason) !== JSON.stringify(reason)) problem('原因和 illegalReasonForView 不同');
    return { problems, situations: ['不合法'] };
  }
  if (reason !== null) problem('illegalReasonForView 说不合法，预览却合法');
  if (!canPick(view, params, action)) problem('合法的动作不能点');

  const next = apply(world, state, action);
  const entry = lastOf(next.log);
  const plan = preview.plan;
  if (plan.type === 'service') {
    if (entry.walk !== plan.walk) problem(`步行 ${entry.walk}，预览 ${plan.walk}`);
    const cleaned = entry.outcome.type === 'cleaned';
    switch (entry.outcome.type) {
      case 'knockRefused':
        if (plan.refusedAt !== next.minute) problem(`被拒后 ${next.minute} 回来，预览 ${String(plan.refusedAt)}`);
        situations.push('敲门被拒');
        break;
      case 'cleaned':
        if (next.minute < plan.finish.from || next.minute > plan.finish.to) problem(`${next.minute} 做完，不在预览的范围里`);
        if (entry.outcome.minutes < plan.cleaning.from || entry.outcome.minutes > plan.cleaning.to) {
          problem(`打扫 ${entry.outcome.minutes} 分钟，不在预览的范围里`);
        }
        if (plan.cut === 'sure') problem('预览说一定做不完，却做完了');
        if (state.cart - next.cart !== plan.linen) problem(`用了 ${state.cart - next.cart} 份布草，预览 ${plan.linen}`);
        if (plan.refusedAt !== null) situations.push('客人可能在却进了门');
        situations.push('做完');
        break;
      case 'interrupted':
        if (plan.cut === 'none') problem('预览说做得完，却被 17:00 截断');
        if (next.minute !== hardStop) problem(`截断在 ${next.minute}，不在 17:00`);
        if (state.cart - next.cart !== plan.linen) problem(`用了 ${state.cart - next.cart} 份布草，预览 ${plan.linen}`);
        situations.push('被 17:00 截断');
        break;
      default:
        problem(`打扫的结果是 ${entry.outcome.type}`);
    }
    if (plan.cut === 'maybe') situations.push('可能做不完');
    if (plan.cut === 'sure') situations.push('一定做不完');
    for (const deadline of plan.deadlines) {
      const onTime = cleaned && next.minute <= deadline.at;
      if (deadline.verdict === 'onTime' && !onTime) problem(`预览说赶得上 ${deadline.at}，结果没有`);
      if (deadline.verdict === 'late' && onTime) problem(`预览说赶不上 ${deadline.at}，结果赶上了`);
      situations.push(deadline.verdict === 'onTime' ? '赶得上' : deadline.verdict === 'late' ? '赶不上' : '可能赶不上');
    }
    return { problems, situations };
  }

  if (next.minute !== plan.end) problem(`${next.minute} 结束，预览 ${plan.end}`);
  const walk = plan.type === 'call' || plan.type === 'wait' ? 0 : plan.walk;
  if (entry.walk !== walk) problem(`步行 ${entry.walk}，预览 ${walk}`);
  switch (plan.type) {
    case 'restock':
      if (next.cart !== params.cart.capacity) problem(`补完货车里 ${next.cart} 份`);
      if (plan.refill !== params.cart.capacity - state.cart) problem(`补回 ${plan.refill} 份，应是 ${params.cart.capacity - state.cart}`);
      situations.push('补货');
      break;
    case 'call':
      situations.push('打电话');
      break;
    case 'break':
      if (plan.start !== state.minute + entry.walk) problem(`休息从 ${plan.start} 开始，到达服务间是 ${state.minute + entry.walk}`);
      situations.push('休息');
      break;
    case 'wait':
      situations.push('等待');
      break;
    case 'finish':
      if (plan.forced !== state.minute >= hardStop) problem('强制下班标错');
      if (next.ended === null) problem('还车以后班次没有结束');
      situations.push(plan.forced ? '强制下班' : '收工还车');
      break;
  }
  return { problems, situations };
}

/** 一整条轨迹每个状态的每个探测动作：随机序列一条，新手从 takeOverAt 步起接手的一条。 */
function checkTraces(
  world: World,
  picks: readonly number[],
  takeOverAt: number,
): { problems: string[]; situations: Situation[] } {
  const problems: string[] = [];
  const situations: Situation[] = [];
  const choosers: readonly Chooser[] = [choose, policyChooser(novice, takeOverAt)];
  for (const chooser of choosers) {
    for (const state of playShift(world, picks, Number.POSITIVE_INFINITY, chooser).states) {
      for (const action of probes(world, state)) {
        const result = check(world, state, action);
        problems.push(...result.problems);
        situations.push(...result.situations);
      }
    }
  }
  return { problems, situations };
}

describe('预览和规则、apply 一致', () => {
  it.each(SET_NAMES)(
    '%s：每个状态的每个探测动作，合法性同 illegalReasonForView，合法的结果落在预览说的范围里',
    (name) => {
      const params: Params = PARAM_SETS[name];
      fc.assert(
        fc.property(seedArb, picksArb, takeOverArb, (seed, picks, takeOverAt) => {
          expect(checkTraces(generate(seed, params), picks, takeOverAt).problems).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('预览不泄露', () => {
  it.each(SET_NAMES)(
    '%s：只差还不知道的隐藏信息、种子也不同的两个世界，前缀每一步每个探测动作的预览完全相同',
    (name) => {
      const params: Params = PARAM_SETS[name];
      fc.assert(
        fc.property(seedArb, picksArb, prefixArb, noiseArb, (seed, picks, prefixLength, noise) => {
          const world = generate(seed, params);
          const { states } = playShift(world, picks, prefixLength);
          const other = hideDifferently(world, lastOf(states), noise);
          expect(other.seed).not.toBe(world.seed);
          const different: string[] = [];
          for (const state of states) {
            for (const action of probes(world, state)) {
              const here = JSON.stringify(previewAction(observe(world, state), world.params, action));
              const there = JSON.stringify(previewAction(observe(other, state), other.params, action));
              if (here !== there) different.push(`${state.minute} 分钟 ${JSON.stringify(action)}：${here} / ${there}`);
            }
          }
          expect(different).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('自检', () => {
  it('三档和 ODD_PARAMS 各自的随机轨迹都走到了 SITUATIONS 列的每一种情形', () => {
    const counts = new Map<string, number>();
    for (const name of SET_NAMES) {
      // 种子固定，结果每次相同；一半的班次数就走到了每种情形（最少的一种也有几十次），省一半时间。
      const samples = fc.sample(fc.tuple(seedArb, picksArb, takeOverArb), { numRuns: RUNS / 2, seed: SAMPLE_SEED });
      for (const [seed, picks, takeOverAt] of samples) {
        for (const situation of checkTraces(generate(seed, PARAM_SETS[name]), picks, takeOverAt).situations) {
          const key = `${name}：${situation}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    // ODD_PARAMS 做不完，不会在 17:00 前收工（见文件开头第 4 条）。
    const required = (name: SetName): readonly Situation[] =>
      name === 'ODD_PARAMS' ? SITUATIONS.filter((situation) => situation !== '收工还车') : SITUATIONS;
    const missing = SET_NAMES.flatMap((name) => required(name).map((situation) => `${name}：${situation}`)).filter(
      (key) => (counts.get(key) ?? 0) === 0,
    );
    expect(missing, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
  }, TIMEOUT);
});
