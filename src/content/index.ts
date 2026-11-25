/**
 * 语言包的对外入口（硬约束 8：界面文字放 src/content，不写死在组件里）。
 *
 * 界面组件一律经 useText() 取文案。现在只有中文，useText 直接返回中文的文案表，不用 React context，也不切换语言。
 * "语言包结构"那一项加语言切换时只改 useText 的实现（例如改成从 context 读当前语言），文件不用搬，组件不用改
 * （2026-11-25 用户定）。房间描述的格式留到阶段 3。
 *
 * 不是组件的纯函数（例如 src/ui/format.ts）不调用 useText，由调用它的组件把文案表传进去；测试直接用 zh/ui.ts 的表。
 */

import type { UiText } from './types';
import { zhUi } from './zh/ui';

export type * from './types';

/**
 * 当前语言的界面文字。名字按 React hook 的约定以 use 开头：以后改成读 context 时，调用的地方不用改，
 * 所以现在就只在组件里调用。
 */
export function useText(): UiText {
  return zhUi;
}
