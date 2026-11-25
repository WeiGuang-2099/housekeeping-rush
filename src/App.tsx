/**
 * 应用的根组件：一个 reducer 持有班次的 World 和 State，以及正在预览的动作（src/ui/shift.ts）。主界面只拿到 screenProps
 * 给出的 View、params 和正在预览的动作，点房间、房号或按钮是选一个动作预览，确认才执行，取消不改动班次的状态。
 *
 * 现在打开就是一班开工时的主界面，种子和难度档先固定写在下面；"网址里带种子"那一项改成从网址读，
 * 每日班次（阶段 3）按日期定种子和难度档。
 */

import { useCallback, useMemo, useReducer } from 'react';
import type { Action, Tier } from './engine';
import { ShiftScreen } from './ui/ShiftScreen';
import { screenProps, shiftReducer, startShift } from './ui/shift';

/** 临时固定的种子：批量模拟的第一个种子。 */
const DEFAULT_SEED = 'sim-0';
const DEFAULT_TIER: Tier = 'standard';

export function App() {
  const [model, dispatch] = useReducer(shiftReducer, null, () => startShift(DEFAULT_SEED, DEFAULT_TIER));
  const data = useMemo(() => screenProps(model), [model]);
  const onSelect = useCallback((action: Action) => dispatch({ type: 'select', action }), []);
  const onCancel = useCallback(() => dispatch({ type: 'cancel' }), []);
  const onConfirm = useCallback(() => dispatch({ type: 'confirm' }), []);
  return (
    <ShiftScreen
      view={data.view}
      params={data.params}
      selected={data.selected}
      onSelect={onSelect}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
