/**
 * 班次主界面（docs/DESIGN.md 的"界面、美术与声音"）：上面是时间轴，中间是平面图，旁边是任务单和布草车；
 * 手机竖屏时任务单折到平面图下方（index.css）。
 *
 * 班次进行中只读 View：属性只有 observe 的结果和公开的参数（ScreenProps，由 shift.ts 的 screenProps 给出），
 * 拿不到 World 和 State。五个动作按钮、动作预览和确认是下一项，幽灵进度是阶段 2 的事。
 */

import { useText } from '../content';
import { Cart } from './Cart';
import { FloorPlan } from './FloorPlan';
import type { ScreenProps } from './shift';
import { TaskSheet } from './TaskSheet';
import { Timeline } from './Timeline';

export function ShiftScreen({ view, params }: ScreenProps) {
  const t = useText();
  return (
    <main className="shift">
      <header className="shift-header">
        <h1>{t.title}</h1>
        <span className="shift-tier">{t.tier[params.tier]}</span>
      </header>
      <Timeline view={view} params={params} />
      <div className="shift-body">
        <FloorPlan view={view} params={params} />
        <aside className="shift-side">
          <TaskSheet view={view} params={params} />
          <Cart view={view} params={params} />
        </aside>
      </div>
    </main>
  );
}
