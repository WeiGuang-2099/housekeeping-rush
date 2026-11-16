/**
 * npm run sim：批量模拟，打印评测表（docs/DESIGN.md 的"平衡与评测"）。
 *
 * 用 Vite 自带的 runnerImport 加载 TS 入口 src/sim/index.ts，不加依赖。读命令行参数、计时和打印都在这里；
 * src/sim 只返回结果和报告文本，那里的代码不用 Node 的 API。
 *
 * 用法（npm run sim 后面的参数要放在 -- 之后）：
 *   npm run sim                         每档 1000 个种子，三档都跑
 *   npm run sim -- --seeds 100          每档 100 个种子
 *   npm run sim -- --tier tight         只跑紧档；可以写几次，也可以用逗号隔开，例如 --tier standard,weekend
 *
 * 评测表打印到标准输出，进度和耗时打印到标准错误。要把评测表存成文件，用 node scripts/sim.mjs > 文件名
 * （npm run 会在标准输出前面多打两行命令）。参数不对时打印用法，退出码为 1。
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runnerImport } from 'vite';

const USAGE = [
  '用法：npm run sim -- [--seeds 数量] [--tier 档]',
  '  --seeds  每档跑多少个种子，默认 1000',
  '  --tier   跑哪几档：standard、tight、weekend；可以写几次，也可以用逗号隔开；默认三档都跑',
].join('\n');

await main();

async function main() {
  let args;
  try {
    args = parseArgs({
      options: { seeds: { type: 'string' }, tier: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
    }).values;
  } catch (error) {
    fail(`参数不对：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const root = fileURLToPath(new URL('..', import.meta.url));
  const entry = fileURLToPath(new URL('../src/sim/index.ts', import.meta.url));
  const { module: sim } = await runnerImport(entry, { root, logLevel: 'error' });

  const seeds = args.seeds === undefined ? sim.GATE.seeds : Number(args.seeds);
  if (!/^\d+$/.test(args.seeds ?? '1') || !Number.isSafeInteger(seeds) || seeds < 1) {
    fail(`--seeds 要是正整数，收到的是 ${args.seeds}`);
    return;
  }
  const tiers = args.tier === undefined ? [...sim.SIM_TIERS] : args.tier.flatMap((value) => value.split(','));
  const unknown = tiers.filter((tier) => !sim.SIM_TIERS.includes(tier));
  if (unknown.length > 0 || tiers.length === 0) {
    fail(`--tier 只能是 ${sim.SIM_TIERS.join('、')}，收到的是 ${tiers.join('、') || '空'}`);
    return;
  }
  if (new Set(tiers).size !== tiers.length) {
    fail(`--tier 重复了：${tiers.join('、')}`);
    return;
  }

  const showProgress = process.stderr.isTTY === true;
  const started = performance.now();
  const results = sim.runSim({
    tiers,
    seeds,
    onProgress: showProgress
      ? (done, total) => {
          if (done === total || done % 10 === 0) process.stderr.write(`\r模拟中：${done}/${total} 局`);
        }
      : undefined,
  });
  const elapsed = performance.now() - started;
  if (showProgress) process.stderr.write(`\r${' '.repeat(40)}\r`);

  process.stdout.write(sim.formatReport(results));
  const shifts = tiers.length * seeds;
  process.stderr.write(
    `\n耗时 ${(elapsed / 1000).toFixed(1)} 秒：${tiers.length} 档 × ${seeds} 个种子 = ${shifts} 局，` +
      `平均每局 ${(elapsed / shifts).toFixed(1)} 毫秒（新手和全知各做一班）。\n`,
  );
}

/** 参数不对：打印原因和用法，退出码为 1。 */
function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exitCode = 1;
}
