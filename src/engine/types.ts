/**
 * 引擎的核心类型（初稿）。
 *
 * 字段可以按实现需要增减，但两条硬约束不能动：
 * 1. 引擎里没有随机数。所有随机性在 generate 里一次用完，写进 World。apply 是纯函数。
 * 2. 公平性由类型保证。新手和老手只拿到 View，拿不到 World；只有全知策略能拿到 World。
 *
 * 规则和数值的出处是 docs/DESIGN.md。
 */

import type { Params } from './params';

/** 开工后第几分钟，08:30 记为 0。换算见 clock.ts。 */
export type Minute = number;

/** 房号，例如 1204。 */
export type RoomId = number;

/** 位置：楼层加门位。门位 0 是电梯厅，1 到 4 是走廊上的门位，一个门位对着两间房。 */
export interface Place {
  floor: number;
  door: number;
}

/** 任务单上的房型：退房房、续住房、请勿打扰。 */
export type RoomKind = 'departure' | 'stayover' | 'dnd';

/** 续住房线索：商务、游客、家庭、长住。请勿打扰房也带一条续住线索。 */
export type StayClue = 'business' | 'tourist' | 'family' | 'longStay';

/** 退房房线索：住一晚、住三晚以上、聚会或家庭。 */
export type DepartureClue = 'oneNight' | 'threeNightsPlus' | 'partyOrFamily';

export type Clue = StayClue | DepartureClue;

/** 脏乱档位：整洁、普通、灾难。对应的时间系数在 params.messMultiplier。 */
export type MessLevel = 'tidy' | 'normal' | 'disaster';

// ---------------------------------------------------------------------------
// World：隐藏的真相，生成时一次掷好，之后不再变化
// ---------------------------------------------------------------------------

export interface RoomTruth {
  id: RoomId;
  place: Place;
  kind: RoomKind;
  clue: Clue;
  mess: MessLevel;
  /**
   * 退房房是客人退房的时刻，续住房和请勿打扰房是客人出门的时刻；负数表示开工前就已经退房或出门；
   * 请勿打扰房实际最早可进的时刻是 max(dndLiftsAt, availableFrom)，摘牌不等于客人已出门。
   */
  availableFrom: Minute;
  /** 延迟退房。这一项印在任务单上，玩家开工就知道。 */
  lateCheckout: boolean;
  /** 贵宾提前入住的时限，印在任务单上；没有则为 null。 */
  vipDeadline: Minute | null;
  /** 仅请勿打扰房：摘牌的时刻；null 表示整班不摘。 */
  dndLiftsAt: Minute | null;
  /** 房间描述在内容包里的编号，开门后界面才显示；没有则为 null。 */
  descriptionId: string | null;
}

/** 事件同样在生成时掷好。绑定房间的事件谁打扫谁遇到，绑定时刻的事件只落在当时在场的人身上。 */
export type ScheduledEvent =
  | { type: 'showerNoise'; room: RoomId }
  | { type: 'guestReturns'; room: RoomId; at: Minute; outcome: 'continue' | 'comeBackLater' }
  | { type: 'rushRequest'; room: RoomId; at: Minute }
  | { type: 'extraTowels'; at: Minute }
  | { type: 'maintenance'; room: RoomId }
  | { type: 'lostProperty'; room: RoomId; valuable: boolean }
  | { type: 'impostor'; at: Minute };

export interface World {
  seed: string;
  params: Params;
  rooms: RoomTruth[];
  events: ScheduledEvent[];
}

// ---------------------------------------------------------------------------
// Action：玩家和算法共用的同一套动作
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'service'; room: RoomId }
  | { type: 'restock' }
  | { type: 'call' }
  | { type: 'break' }
  /** minutes 是整数，1 <= minutes <= min(waitStepMinutes, hardStop - minute)；legalActions 只列上限这一个值。 */
  | { type: 'wait'; minutes: Minute }
  | { type: 'respond'; option: string }
  | { type: 'finish' };

// ---------------------------------------------------------------------------
// State：随动作变化的进度
// ---------------------------------------------------------------------------

export interface RoomProgress {
  id: RoomId;
  /** 打扫完成的时刻；没完成为 null。被 17:00 截断的房间也是 null。 */
  doneAt: Minute | null;
  /**
   * 已经做掉的打扫分钟数。开门开始打扫时扣布草；完成时等于总时长。
   * 17:00 截断（以及阶段 2 的打断）后保留已做的分钟数；续做耗时为总时长减它，续做时不再扣、也不再检查布草。
   */
  workDone: Minute;
  /** 退房房：主管是否已标记"已退"。只由打电话设置；其他房型恒为 false。 */
  flaggedDeparted: boolean;
  /**
   * 客人告知的回来时间（已向上取整）。有约束力：到达时刻早于它时，这间房不是合法的打扫目标。
   * 只由敲门被拒写入（阶段 2 的淋浴声和"请稍后再来"也写它）；延迟退房不预填。null 表示没有这项限制。
   */
  knownAvailableFrom: Minute | null;
  /** 是否开过门。开过门才知道脏乱档位。 */
  messRevealed: boolean;
  /** 请勿打扰房：是否已得知摘牌（打电话，或路过、停留在该门位时看到）。为真之后才能作为打扫目标。 */
  dndLiftKnown: boolean;
  /** 前台催房产生的时限；没有则为 null。 */
  rushDeadline: Minute | null;
}

export interface EventOption {
  id: string;
  minutes: Minute;
  /** 选了会被记违规，本班不计星。 */
  violation: boolean;
  /** 选了班次立即结束并判负。 */
  endsShift: boolean;
}

/** 弹出后必须先回应的事件。 */
export interface EventPrompt {
  /** 在 world.events 里的下标。 */
  eventIndex: number;
  event: ScheduledEvent;
  options: EventOption[];
}

export type Outcome =
  /** minutes：本次动作里打扫的分钟数，不含步行。 */
  | { type: 'cleaned'; room: RoomId; minutes: Minute }
  | { type: 'knockRefused'; room: RoomId; comeBackAt: Minute }
  /** workDone：这间房累计已做的分钟数。阶段 2 再给 reason 加上事件原因。 */
  | { type: 'interrupted'; room: RoomId; workDone: Minute; reason: 'hardStop' }
  | { type: 'restocked' }
  /** 两个列表都只列这通电话新得知的房间，按 world.rooms 的顺序。房态的截止时刻是这条日志的 end。 */
  | { type: 'called'; newlyDeparted: RoomId[]; newlyLifted: RoomId[] }
  | { type: 'breakTaken' }
  | { type: 'waited'; minutes: Minute }
  | { type: 'responded'; option: string }
  | { type: 'finished' };

/**
 * 一条动作记录。回放、轨迹图和分享卡片都从这份日志重建。
 * 每次 apply 恰好追加一条，引擎从不自动追加记录。
 */
export interface LogEntry {
  /** 动作开始的时刻，即动作前的 state.minute。 */
  start: Minute;
  /** 动作结束的时刻，即动作后的 state.minute。 */
  end: Minute;
  /** 动作前的位置。 */
  from: Place;
  /** 动作后的位置。 */
  to: Place;
  /** 原样记录提交的动作。 */
  action: Action;
  outcome: Outcome;
  /** 这条动作实际走过的分钟数。打电话和等待为 0。 */
  walk: Minute;
  /** 本动作中路过或停留时新得知已摘牌的请勿打扰房，按 world.rooms 的顺序。电话得知的记在 called 里，不在这里。 */
  noticedLifted: RoomId[];
}

/** 'returned' 是 17:00 前自己收工并还车；'hardStop' 是到了 17:00 之后只能还车，还完车结束；'failed' 留给阶段 2 的判负。 */
export type ShiftEnd = 'returned' | 'hardStop' | 'failed';

export interface State {
  /** 当前时刻。班次以 'returned' 或 'hardStop' 结束时，等于还车完成的时刻，也就是最后一条日志的 end。 */
  minute: Minute;
  place: Place;
  /** 布草车里剩余的份数。 */
  cart: number;
  breakTaken: boolean;
  rooms: RoomProgress[];
  prompt: EventPrompt | null;
  /** 已经触发过的事件在 world.events 里的下标。 */
  firedEvents: number[];
  violation: boolean;
  /** 班次是否结束以及怎么结束的；进行中为 null。 */
  ended: ShiftEnd | null;
  log: LogEntry[];
}

// ---------------------------------------------------------------------------
// View：玩家和老手能看到的全部
// ---------------------------------------------------------------------------

export interface RoomView {
  id: RoomId;
  place: Place;
  kind: RoomKind;
  clue: Clue;
  lateCheckout: boolean;
  vipDeadline: Minute | null;
  rushDeadline: Minute | null;
  /** 打扫完成的时刻；没完成为 null。 */
  doneAt: Minute | null;
  /** 已经做掉的打扫分钟数。 */
  workDone: Minute;
  flaggedDeparted: boolean;
  knownAvailableFrom: Minute | null;
  /** 开门前为 null。 */
  mess: MessLevel | null;
  /** 玩家已知的摘牌状态。 */
  dndLifted: boolean;
  /** 开门前为 null。 */
  descriptionId: string | null;
}

export interface View {
  minute: Minute;
  place: Place;
  cart: number;
  breakTaken: boolean;
  rooms: RoomView[];
  prompt: EventPrompt | null;
  violation: boolean;
  ended: ShiftEnd | null;
  log: LogEntry[];
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export interface Score {
  /** 还车完成的时刻。 */
  finishMinute: Minute;
  /** 各项罚时，单位分钟。 */
  penalties: { vipLate: Minute; rushLate: Minute; unfinished: Minute };
  /** 等效下班时间：finishMinute 加全部罚时。越小越好，是唯一的成绩。 */
  equivalentFinish: Minute;
  roomsDone: number;
  walkedMinutes: Minute;
  violation: boolean;
  failed: boolean;
}

// ---------------------------------------------------------------------------
// 引擎接口与策略
// ---------------------------------------------------------------------------

export interface Engine {
  /** 唯一允许使用随机数的地方。 */
  generate(seed: string, params: Params): World;
  initial(world: World): State;
  legalActions(world: World, state: State): Action[];
  /** 纯函数，无随机数，不修改传入的 state。 */
  apply(world: World, state: State, action: Action): State;
  /** 隐藏所有还没揭晓的信息。 */
  observe(world: World, state: State): View;
  score(world: World, state: State): Score;
}

/** 新手和老手：只能看到 View。 */
export type Policy = (view: View, params: Params) => Action;

/** 全知：可以看到 World。 */
export type OraclePolicy = (world: World, state: State) => Action;
