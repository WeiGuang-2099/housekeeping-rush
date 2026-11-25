/**
 * 班次主界面（docs/DESIGN.md 的"界面、美术与声音"）：上面是时间轴，中间是平面图，旁边是任务单和布草车，
 * 底部是动作栏（预览和五个按钮）；手机竖屏时任务单折到平面图下方（index.css）。
 *
 * 班次进行中只读 View：属性只有 observe 的结果、公开的参数和正在预览的动作（ScreenData，由 shift.ts 的 screenProps 给出），
 * 拿不到 World 和 State。预览由 preview.ts 按 View 和 params 算一次，交给各个部件：时间轴画虚影，平面图描出目标和路线，
 * 任务单描出那一行，布草车高亮要用的份数，动作栏写出代价。点房间、房号或按钮是选一个动作预览，
 * 确认才执行（onConfirm），取消不改动班次的状态。幽灵进度是阶段 2 的事。
 */

import { useText } from '../content';
import type { Action } from '../engine';
import { ActionBar } from './ActionBar';
import { Cart } from './Cart';
import { FloorPlan } from './FloorPlan';
import { previewAction } from './preview';
import type { ScreenData } from './shift';
import { TaskSheet } from './TaskSheet';
import { Timeline } from './Timeline';

export interface ShiftScreenProps extends ScreenData {
  /** 选一个动作预览（换一个也是它）。 */
  readonly onSelect: (action: Action) => void;
  /** 取消预览。 */
  readonly onCancel: () => void;
  /** 确认正在预览的动作，执行它。 */
  readonly onConfirm: () => void;
}

export function ShiftScreen({ view, params, selected, onSelect, onCancel, onConfirm }: ShiftScreenProps) {
  const t = useText();
  const preview = selected === null ? null : previewAction(view, params, selected);
  return (
    <main className="shift">
      <header className="shift-header">
        <h1>{t.title}</h1>
        <span className="shift-tier">{t.tier[params.tier]}</span>
      </header>
      <Timeline view={view} params={params} preview={preview} />
      <div className="shift-body">
        <FloorPlan view={view} params={params} preview={preview} onSelect={onSelect} />
        <aside className="shift-side">
          <TaskSheet view={view} params={params} preview={preview} onSelect={onSelect} />
          <Cart view={view} params={params} preview={preview} />
        </aside>
      </div>
      <ActionBar
        view={view}
        params={params}
        preview={preview}
        onSelect={onSelect}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </main>
  );
}
