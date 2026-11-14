// 占位页面：只用来确认脚手架和引擎的导入是通的。阶段 1 会整个换掉。
// 正式界面的文字要放进语言包（src/content），不要像这里一样写死。

import { PARAMS, allRooms, toClock, type Tier } from './engine';

const TIER_LABEL: Record<Tier, string> = {
  standard: '标准（周一到周三）',
  tight: '紧（周四、周五）',
  weekend: '周末',
};

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];

export function App() {
  return (
    <main className="page">
      <h1>
        客房冲刺 <span className="en">Housekeeping Rush</span>
      </h1>
      <p>这是占位页面，游戏界面还在开发中。</p>

      <table>
        <thead>
          <tr>
            <th>难度档</th>
            <th>房间数</th>
            <th>布草车</th>
            <th>贵宾时限</th>
            <th>目标下班</th>
          </tr>
        </thead>
        <tbody>
          {TIERS.map((tier) => {
            const params = PARAMS[tier];
            return (
              <tr key={tier}>
                <td>{TIER_LABEL[tier]}</td>
                <td>{allRooms(params).length} 间</td>
                <td>{params.cart.capacity} 份</td>
                <td>{params.vipDeadlines.map(toClock).join('、')}</td>
                <td>{toClock(params.shift.targetFinish)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
