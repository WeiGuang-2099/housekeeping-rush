/**
 * 应用的根组件：一个 reducer 持有班次的 World 和 State（src/ui/shift.ts），主界面只拿到 screenProps 给出的
 * View 和 params。
 *
 * 现在打开就是一班开工时的主界面，种子和难度档先固定写在下面；"网址里带种子"那一项改成从网址读，
 * 每日班次（阶段 3）按日期定种子和难度档。动作按钮、动作预览和确认是下一项，到时用 reducer 的 dispatch 执行动作。
 */

import { useMemo, useReducer } from 'react';
import type { Tier } from './engine';
import { ShiftScreen } from './ui/ShiftScreen';
import { screenProps, shiftReducer, startShift } from './ui/shift';

/** 临时固定的种子：批量模拟的第一个种子。 */
const DEFAULT_SEED = 'sim-0';
const DEFAULT_TIER: Tier = 'standard';

export function App() {
  const [model] = useReducer(shiftReducer, null, () => startShift(DEFAULT_SEED, DEFAULT_TIER));
  const props = useMemo(() => screenProps(model), [model]);
  return <ShiftScreen view={props.view} params={props.params} />;
}
