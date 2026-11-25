/**
 * 班次的状态：一个 reducer 持有引擎的 World 和 State（docs/DESIGN.md 技术选型的"状态管理"），另外记着正在预览的动作。
 *
 * 1. 只有这个文件拿 World 和 State。班次进行中，界面经 screenProps 只拿到 observe 的结果（View）、world.params 和
 *    正在预览的动作：主界面和四个部件的属性里没有 World 和 State。tests/ui-boundary.test.ts 查 src/ui 下别的文件不导入
 *    World、State 这些名字，tests/ui-screen.property.test.tsx 查只差隐藏信息的两个世界画出的主界面逐字相同。
 *    结算和回放读 World，到那几项再加。
 * 2. 消息（docs/DESIGN.md 核心循环的第 2 步）：
 *    - start：按种子和难度档开一班（generate 加 initial），没有预览。
 *    - select：预览一个动作。只记下动作，不改动班次的状态；预览的内容由界面按 View 和 params 算（preview.ts）。
 *      再选一个就换成新的，合法不合法都能选，不合法的在预览里写出原因。
 *    - cancel：取消预览，班次的状态不变。
 *    - confirm：执行正在预览的动作（apply），然后清掉预览。确认后不能撤销，只能在确认之前取消
 *      （docs/DESIGN.md 的"撤销"）。
 * 3. 没有正在预览的动作时确认，或者确认的动作不合法，都抛错（后者是 apply 的报错），不吞掉，也不换成别的动作：
 *    界面只在预览合法时才让确认按钮能按，交来这两种消息是界面的错误，要马上暴露。
 * 4. 纯函数：不修改传入的 model，每次返回新对象；world 一班之内不变，state 由 apply 新建。没有随机数，不读系统时间，
 *    同样的种子、难度档和消息序列得到同样的状态（React 的严格模式会把 reducer 调两次，结果相同）。
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

/** reducer 持有的状态：这一班的世界、当前状态和正在预览的动作。 */
export interface ShiftModel {
  readonly world: World;
  readonly state: State;
  /** 正在预览、还没确认的动作；没有为 null。 */
  readonly selected: Action | null;
}

/** 交给 reducer 的消息，含义见文件开头第 2 条。 */
export type ShiftMessage =
  | { readonly type: 'start'; readonly seed: string; readonly tier: Tier }
  | { readonly type: 'select'; readonly action: Action }
  | { readonly type: 'cancel' }
  | { readonly type: 'confirm' };

/** 四个部件都收的属性：玩家能看到的 View，以及公开的参数。 */
export interface ScreenProps {
  readonly view: View;
  readonly params: Params;
}

/** 班次进行中交给主界面的全部数据：View、公开的参数和正在预览的动作。 */
export interface ScreenData extends ScreenProps {
  readonly selected: Action | null;
}

/** 按种子和难度档开一班：开工时的状态，没有预览。 */
export function startShift(seed: string, tier: Tier): ShiftModel {
  const world = generate(seed, PARAMS[tier]);
  return { world, state: initial(world), selected: null };
}

/** 班次的 reducer，规则见文件开头。 */
export function shiftReducer(model: ShiftModel, message: ShiftMessage): ShiftModel {
  switch (message.type) {
    case 'start':
      return startShift(message.seed, message.tier);
    case 'select':
      return { world: model.world, state: model.state, selected: message.action };
    case 'cancel':
      return { world: model.world, state: model.state, selected: null };
    case 'confirm': {
      if (model.selected === null) throw new Error('班次：没有正在预览的动作，不能确认');
      return { world: model.world, state: apply(model.world, model.state, model.selected), selected: null };
    }
  }
}

/** 班次进行中界面能拿到的全部：observe 的结果、world.params 和正在预览的动作，不给 World 和 State。 */
export function screenProps(model: ShiftModel): ScreenData {
  return { view: observe(model.world, model.state), params: model.world.params, selected: model.selected };
}
