/**
 * 语言包里界面文字的形状（硬约束 8：界面文字放语言包，不写死在组件里）。
 *
 * 1. 现在只有中文（zh/ui.ts）。组件一律经 useText()（index.ts）取文案，不用 React context，也不切换语言；
 *    以后"语言包结构"那一项加语言切换时只改 useText 的实现，不用搬文件（2026-11-25 用户定）。房间描述的格式留到阶段 3。
 * 2. 按引擎的编号写映射类型：难度档、房型、线索、脏乱档位各是"编号到文字"的 Record，语言包漏写一项类型检查就报错。
 *    界面自己的编号（房间的状态、任务单上的已知信息）由组件逐个编号取文案，switch 漏写一个编号同样过不了类型检查。
 * 3. 要带数据的句子写成函数，参数是排好版的字符串和数字：钟点由界面用 clock.ts 换好再传进来，
 *    语言包里不算时间，不读 View，也不读 params。
 * 4. 只从引擎的对外入口导入类型，不导入 React，也不导入界面（tests/ui-boundary.test.ts 检查）。
 */

import type { Clue, MessLevel, RoomId, RoomKind, Tier } from '../engine';

/** 一种语言的全部界面文字。 */
export interface UiText {
  /** 游戏名，主界面顶上。 */
  readonly title: string;
  /** 难度档的名字，主界面顶上。 */
  readonly tier: Readonly<Record<Tier, string>>;
  /** 房型的全称，任务单上用。 */
  readonly kind: Readonly<Record<RoomKind, string>>;
  /** 房型的简称，平面图的房间方块里用。 */
  readonly kindShort: Readonly<Record<RoomKind, string>>;
  /** 线索的全称，任务单上用。 */
  readonly clue: Readonly<Record<Clue, string>>;
  /** 线索的简称，平面图的房间方块里用。 */
  readonly clueShort: Readonly<Record<Clue, string>>;
  /** 脏乱档位，开门后才知道。 */
  readonly mess: Readonly<Record<MessLevel, string>>;
  readonly timeline: TimelineText;
  readonly floorPlan: FloorPlanText;
  readonly taskSheet: TaskSheetText;
  readonly cart: CartText;
}

/** 时间轴（docs/DESIGN.md 的"主界面的四个部件"）。 */
export interface TimelineText {
  /** 整条时间轴的无障碍名称。 */
  readonly label: string;
  /** 指针上方的当前时刻。 */
  readonly now: (clock: string) => string;
  /** 浅色带的说明：从这时起可以开始休息（按到达服务间的时刻算）。 */
  readonly breakWindow: string;
  /** 14:30 那条线的说明：还没休息的话，从这里起只能休息。 */
  readonly breakLatest: string;
  /** 已经休息过的那一段。 */
  readonly breakTaken: string;
  /** 小旗上房号后面的字：贵宾时限。窄屏上只留房号。 */
  readonly vip: string;
  /** 小旗上房号后面的字：前台催房的时限（阶段 2 的事件）。 */
  readonly rush: string;
  /** 小旗的提示文字，鼠标停在上面时显示。overdue 是已经赶不上或者做完时已经晚了。 */
  readonly vipTitle: (room: RoomId, clock: string, overdue: boolean) => string;
  readonly rushTitle: (room: RoomId, clock: string, overdue: boolean) => string;
  /** 客人告知的回来时间那个小点的提示文字。 */
  readonly comeBackTitle: (room: RoomId, clock: string) => string;
}

/** 平面图。 */
export interface FloorPlanText {
  /** 整张平面图的无障碍名称。 */
  readonly label: string;
  readonly floor: (floor: number) => string;
  readonly lift: string;
  readonly servicePoint: string;
  /** 玩家的圆点旁边的字。 */
  readonly you: string;
  /** 房间方块第二行房型简称后面的说明，按 rooms.ts 的顺序挑一种：回来时间、贵宾时限、催房时限，都没有就写线索简称。 */
  readonly laterTag: (clock: string) => string;
  readonly vipTag: (clock: string) => string;
  readonly rushTag: (clock: string) => string;
  /** 图例：三种和"看起来能进"不同的状态。 */
  readonly legend: { readonly done: string; readonly locked: string; readonly later: string };
}

/** 任务单。 */
export interface TaskSheetText {
  readonly title: string;
  /** 顶上一行：最近一次打给主管的挂断时刻，主管报的房态截至这一刻。 */
  readonly lastCall: (clock: string) => string;
  readonly noCallYet: string;
  /** 已知信息，一条一句（rooms.ts 的 RoomFact，按编号取）。 */
  readonly vip: (clock: string, overdue: boolean) => string;
  readonly rush: (clock: string, overdue: boolean) => string;
  readonly lateCheckout: string;
  readonly departed: string;
  readonly notDeparted: string;
  readonly comeBack: (clock: string) => string;
  readonly notKnocked: string;
  /** 还不知道摘牌的请勿打扰房：最近一次确认仍挂牌的时刻（recall 的 confirmedAt）。 */
  readonly stillHung: (clock: string) => string;
  /** 同上，本班还没确认过（confirmedAt 为 null）。 */
  readonly neverConfirmed: string;
  readonly lifted: string;
  readonly mess: (mess: string, minutes: number) => string;
  readonly workDone: (done: number, total: number) => string;
  readonly done: (clock: string) => string;
  /** 一间房的完整说明，平面图上鼠标停在房间方块上时显示。facts 是排好的已知信息。 */
  readonly summary: (room: RoomId, kind: string, clue: string, facts: readonly string[]) => string;
}

/** 布草车。 */
export interface CartText {
  readonly title: string;
  readonly count: (left: number, capacity: number) => string;
  /** 无障碍名称：格子本身不读出来，用这一句代替。 */
  readonly label: (left: number, capacity: number) => string;
}
