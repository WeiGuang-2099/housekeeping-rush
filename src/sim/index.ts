// 批量模拟器的入口：scripts/sim.mjs（npm run sim）用 Vite 的 runnerImport 加载它。跑模拟在 run.ts，整理报告在 report.ts。
// 这个目录不用 Node 的 API：读命令行参数、计时和打印都在 scripts/sim.mjs 里。

export * from './run';
export * from './report';
