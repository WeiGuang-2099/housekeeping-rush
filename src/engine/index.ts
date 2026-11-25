// 引擎的对外入口。界面、策略、模拟器和回放都从这里导入，不要直接引用内部文件。
// rules、observe 和 score 已实现（按 View 判定的 legalActionsForView 和 illegalReasonForView 在 rules 里，非法动作原因的
// 类型 IllegalReason 在 types 里）；事件要到阶段 2 才有，见 docs/TASKS.md。
// drive 是共用驱动函数 runShift：让一个幽灵做完一班，模拟器、界面里的幽灵和全知内部新手的走法都用它。
// recall 从 View 的日志推出界面要替玩家记着的关键事实（最近一次打电话的时刻、请勿打扰房最近一次确认仍挂牌的时刻）。

export * from './types';
export * from './params';
export * from './clock';
export * from './layout';
export * from './rng';
export * from './generate';
export * from './rules';
export * from './observe';
export * from './score';
export * from './drive';
export * from './recall';
