// 引擎的对外入口。界面、策略、模拟器和回放都从这里导入，不要直接引用内部文件。
// rules、observe 和 score 已实现（按 View 判定合法动作的 legalActionsForView 在 rules 里）；事件要到阶段 2 才有，见 docs/TASKS.md。
// drive 是共用驱动函数 runShift：让一个幽灵做完一班，模拟器、界面里的幽灵和全知内部新手的走法都用它。

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
