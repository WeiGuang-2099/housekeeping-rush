/**
 * 班次的状态：一个 reducer 持有引擎的 World 和 State（docs/DESIGN.md 技术选型的"状态管理"）。
 *
 * 1. 只有这个文件拿 World 和 State。班次进行中，界面经 screenProps 只拿到 observe 的结果（View）和 world.params：
 *    主界面和四个部件的属性只有这两样（ScreenProps）。tests/ui-boundary.test.ts 查 src/ui 下别的文件不导入
 *    World、State 这些名字，tests/ui-screen.property.test.tsx 查只差隐藏信息的两个世界画出的主界面逐字相同。
 *    结算和回放读 World，到那几项再加。
 * 2. 两种消息：start 按种子和难度档开一班（generate 加 initial）；act 执行一个动作（apply）。
 *    不做撤销：确认后的动作不能撤回，只能在确认之前取消预览（docs/DESIGN.md 的"撤销"）。动作预览和确认是下一项，
 *    预览只由 View 和 params 算出，不改动这里的状态。
 * 3. 非法动作照样交给 apply，抛出它的报错，不吞掉，也不换成别的动作：界面只该交来合法的动作，
 *    交来非法动作是界面的错误，要马上暴露。
 * 4. 纯函数：不修改传入的 model，每次返回新对象；world 一班之内不变，state 由 apply 新建。没有随机数，不读系统时间，
 *    同样的种子、难度档和动作序列得到同样的状态（React 的严格模式会把 reducer 调两次，结果相同）。
 */

import {
  apply,
  generate,
  initial,
  observe,
  PARAMS,
  type Action,
  type Params,
  type State,
  type Tier,
  type View,
  type World,
} from '../engine';

/** reducer 持有的状态：这一班的世界和当前状态。 */
export interface ShiftModel {
  readonly world: World;
  readonly state: State;
}

/** 交给 reducer 的消息。 */
export type ShiftMessage =
  /** 按种子和难度档开一班，之前的班次丢掉。 */
  | { readonly type: 'start'; readonly seed: string; readonly tier: Tier }
  /** 执行一个动作。动作必须合法，否则抛出 apply 的报错。 */
  | { readonly type: 'act'; readonly action: Action };

/** 班次进行中交给主界面和四个部件的全部：玩家能看到的 View，以及公开的参数。 */
export interface ScreenProps {
  readonly view: View;
  readonly params: Params;
}

/** 按种子和难度档开一班：开工时的状态。 */
export function startShift(seed: string, tier: Tier): ShiftModel {
  const world = generate(seed, PARAMS[tier]);
  return { world, state: initial(world) };
}

/** 班次的 reducer，规则见文件开头。 */
export function shiftReducer(model: ShiftModel, message: ShiftMessage): ShiftModel {
  switch (message.type) {
    case 'start':
      return startShift(message.seed, message.tier);
    case 'act':
      return { world: model.world, state: apply(model.world, model.state, message.action) };
  }
}

/** 班次进行中界面能拿到的全部：observe 的结果和 world.params，不给 World 和 State。 */
export function screenProps(model: ShiftModel): ScreenProps {
  return { view: observe(model.world, model.state), params: model.world.params };
}
