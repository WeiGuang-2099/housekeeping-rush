/**
 * 主界面的性质测试。班次进行中界面只读 View（docs/DESIGN.md 技术选型的"状态管理"）：App 经 src/ui/shift.ts 的
 * screenProps 把 observe 的结果、world.params 和正在预览的动作交给主界面，主界面和部件只收这几样。
 *
 * 1. 不泄露：随机前缀结束后用 tests/helpers/hidden.ts 的 hideDifferently 造第二个世界（只改玩家到那时还不知道的
 *    隐藏信息，种子也换掉）。前缀的每一步，两个世界经 screenProps 画出的主界面逐字相同。每一步轮流预览三种情形之一：
 *    不预览；预览这一步接下来真的做的动作；预览去随机一间房打扫（合法不合法都有，含客人可能在的续住房）。主界面、预览或
 *    screenProps 哪天读了 World、State 或种子，画出来的东西就会随隐藏信息变。三档和 ODD_PARAMS 都跑。
 *    预览本身对每个探测动作的不泄露在 tests/ui-preview.property.test.ts 里逐一查，这里查画出来的整屏。
 * 2. 画得出来：随机合法序列的每个状态（含开工和班次结束后）都画得出来，不抛错，预览的是这一步接下来的动作
 *    （班次结束后没有，就不预览）。每间房在平面图上一个方块、在任务单上一行，布草车的实心格数等于 View 的 cart。
 *
 * 渲染比引擎慢，所以班次数比引擎的性质测试少（RUNS 的五分之一），前缀的步数也短一些，每一步只画一种预览。
 */

import fc from 'fast-check';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { generate, observe, PARAMS, type Action, type Params, type State, type World } from '../src/engine';
import { ShiftScreen } from '../src/ui/ShiftScreen';
import { screenProps } from '../src/ui/shift';
import { hideDifferently } from './helpers/hidden';
import { ODD_PARAMS } from './helpers/params';
import { at, lastOf, picksArb, playShift, RUNS, seedArb, TIMEOUT, TIERS } from './helpers/play';

const UI_RUNS = Math.max(1, Math.floor(RUNS / 5));
const prefixArb = fc.nat({ max: 60 });
const noiseArb = fc.array(fc.nat(), { minLength: 1, maxLength: 64 });

const PARAM_SETS: readonly (readonly [string, Params])[] = [
  ...TIERS.map((tier) => [tier, PARAMS[tier]] as const),
  ['ODD_PARAMS', ODD_PARAMS],
];

/** 不做任何事的回调：服务端渲染不会调用它们。 */
const ignore = (): void => undefined;

/** App 画出的主界面：经 screenProps 只拿 View、params 和正在预览的动作。 */
function screenOf(world: World, state: State, selected: Action | null): string {
  const props = screenProps({ world, state, selected });
  return renderToStaticMarkup(
    <ShiftScreen
      view={props.view}
      params={props.params}
      selected={props.selected}
      onSelect={ignore}
      onCancel={ignore}
      onConfirm={ignore}
    />,
  );
}

function count(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

describe('主界面：不泄露', () => {
  it.each(PARAM_SETS)(
    '%s：只差还不知道的隐藏信息、种子也不同的两个世界，前缀的每一步画出的主界面逐字相同',
    (_name, params) => {
      fc.assert(
        fc.property(seedArb, picksArb, prefixArb, noiseArb, (seed, picks, prefixLength, noise) => {
          const world = generate(seed, params);
          const { states, actions } = playShift(world, picks, prefixLength);
          const other = hideDifferently(world, lastOf(states), noise);
          expect(other.seed).not.toBe(world.seed);
          for (const [index, state] of states.entries()) {
            // 轮流：不预览、预览接下来的动作、预览去随机一间房打扫。
            const room = at(world.rooms, at(picks, index % picks.length) % world.rooms.length).id;
            const choices: readonly (Action | null)[] = [null, actions[index] ?? null, { type: 'service', room }];
            const selected = at(choices, index % choices.length);
            expect(screenOf(other, state, selected), `${state.minute} 分钟 ${JSON.stringify(selected)}`).toBe(
              screenOf(world, state, selected),
            );
          }
        }),
        { numRuns: UI_RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('主界面：画得出来', () => {
  it.each(PARAM_SETS)(
    '%s：随机合法序列的每个状态都画得出来（预览接下来的动作），每间房一个方块、一行，布草车的实心格数等于 cart',
    (_name, params) => {
      fc.assert(
        fc.property(seedArb, picksArb, (seed, picks) => {
          const world = generate(seed, params);
          const { states, actions } = playShift(world, picks);
          expect(lastOf(states).ended).not.toBeNull();
          for (const [index, state] of states.entries()) {
            const view = observe(world, state);
            const html = screenOf(world, state, actions[index] ?? null);
            expect(count(html, /<g class="fp-room /g)).toBe(view.rooms.length);
            expect(count(html, /<tr /g)).toBe(view.rooms.length);
            expect(count(html, /class="cart-cell is-full(?: is-use)?"/g)).toBe(view.cart);
          }
        }),
        { numRuns: UI_RUNS },
      );
    },
    TIMEOUT,
  );
});
