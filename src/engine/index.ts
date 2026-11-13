// 引擎的对外入口。界面、策略、模拟器和回放都从这里导入，不要直接引用内部文件。
// generate、rules、observe、score 尚未实现，见 docs/TASKS.md 的阶段 0。

export * from './types';
export * from './params';
export * from './clock';
export * from './layout';
export * from './rng';
