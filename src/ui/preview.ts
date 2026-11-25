/**
 * 动作预览（docs/DESIGN.md 核心循环的第 2 步和"动作预览"）：点了房间或按钮、还没确认的时候，告诉玩家这个动作的代价：
 * 步行几分钟、打扫时间的范围、完成时刻、赶不赶得上时限。
 *
 * 1. 只由 View 和 params 算出（docs/DESIGN.md 的"撤销"）。拿不到 World 和 State，所以预览不会透露玩家还不知道的事，
 *    例如续住房的客人在不在、没开过门的房间有多乱（tests/ui-preview.property.test.ts 查只差隐藏信息的两个世界上预览相同）。
 *    纯函数：选中、换一个、取消都不改动班次的状态。不产出文字，组件按编号从语言包取文案（format.ts）。
 *
 * 2. 合法性用 illegalReasonForView 判，和规则是同一份判定。不合法时只给原因（编号加数据）。
 *
 * 3. 合法时给出计划（ActionPreview）。时刻都是开工后第几分钟，算法和 rules.ts 的 apply 一致，
 *    tests/ui-preview.property.test.ts 在随机局面上用 apply 核对每一个数：
 *    - 打扫：走到门口要 walkMinutes 分钟。打扫的分钟数：开过门的（被 17:00 截断过）是总分钟数减已做的分钟数，
 *      没开过门的是三档脏乱各自的分钟数（cleanMinutes）里最少到最多。做完的时刻是到门口加打扫的分钟数；
 *      晚于 17:00 的停在 17:00，不算做完（cut：一定做不完、可能做不完、做得完）。
 *      续住房和已知摘牌的请勿打扰房，没敲过门、也没开过门的，客人可能在：在的话敲门 knockRefusedMinutes 分钟就回来，
 *      这个时刻也给出（refusedAt）。有回来时间的，合法就说明到门口时不早于它，客人一定已经出门（第一版客人不说谎）。
 *      退房房报了已退才合法，客人已经走了。
 *      布草：第一次开门时扣这间房的份数（退房房和其他房型各按 params.rooms），接着做被截断的房间不扣。
 *      时限：这间房的贵宾和催房时限各判一次：最晚的做完时刻不晚于时限、也不会被拒、不会被截断，是赶得上；
 *      一定做不完或者最早的做完时刻也晚于时限，是赶不上；其余是可能赶不上。
 *    - 补货、休息、收工还车：走回服务间 walkMinutes 分钟，再花各自的分钟数（params）。补货补满到容量。
 *      休息的开始时刻是到达服务间的时刻。17:00 起收工还车是强制下班。
 *    - 打电话：callMinutes 分钟。等待：选的分钟数。
 *
 * 4. 哪些控件能点（canPick）。原因是全局的（班次结束、要先回应事件、17:00 以后、14:30 起还没休息）时不能点：
 *    这时只剩一种动作能做（docs/DESIGN.md："17:00 起只剩收工还车能点"）。做完的房间也不能点，它永远做不了。
 *    其余不合法的照样能点，预览里写出为什么做不了，确认按钮不能按。
 *
 * 5. 等待的上限取 legalActionsForView 列出的那一档（min(waitStepMinutes, 17:00 减现在)），1 到上限之间的整数分钟都能选，
 *    和幽灵一样（硬约束 11）。
 */

import {
  cleanMinutes,
  illegalReasonForView,
  legalActionsForView,
  walkMinutes,
  type Action,
  type IllegalReason,
  type IllegalReasonCode,
  type MessLevel,
  type Minute,
  type Params,
  type Place,
  type RoomId,
  type RoomView,
  type View,
} from '../engine';
import type { Span } from './timelineModel';

/** 没开过门的房间，脏乱可能是这三档里的任何一档。 */
const MESS_LEVELS = ['tidy', 'normal', 'disaster'] as const satisfies readonly MessLevel[];

/** 原因是这几种时，只剩一种动作能做，别的控件都不能点（见文件开头第 4 条）。 */
const GLOBAL_REASONS: readonly IllegalReasonCode[] = ['ended', 'mustRespond', 'afterHardStop', 'mustBreak'];

/** 时限赶不赶得上。 */
export type DeadlineVerdict = 'onTime' | 'maybeLate' | 'late';

export interface DeadlineCheck {
  readonly kind: 'vip' | 'rush';
  readonly at: Minute;
  readonly verdict: DeadlineVerdict;
}

/** 17:00 前做不做得完。 */
export type CutRisk = 'none' | 'maybe' | 'sure';

/** 去一间房打扫。 */
export interface ServicePlan {
  readonly type: 'service';
  readonly room: RoomId;
  readonly walk: Minute;
  /** 到门口的时刻。 */
  readonly arrival: Minute;
  /** 打扫的分钟数，最少到最多。 */
  readonly cleaning: Span;
  /** 做完的时刻，最早到最晚；做不完的停在 17:00。 */
  readonly finish: Span;
  readonly cut: CutRisk;
  /** 客人可能在：在的话敲门以后回来的时刻。客人一定不在时为 null。 */
  readonly refusedAt: Minute | null;
  /** 这一步用几份布草；接着做的房间是 0。 */
  readonly linen: number;
  /** 接着做的房间已经做了的分钟数；没做过是 0。 */
  readonly resumed: Minute;
  readonly deadlines: readonly DeadlineCheck[];
}

/** 回服务间补货。 */
export interface RestockPlan {
  readonly type: 'restock';
  readonly walk: Minute;
  readonly arrival: Minute;
  readonly end: Minute;
  /** 补回几份：容量减车里现有的份数。 */
  readonly refill: number;
}

export interface CallPlan {
  readonly type: 'call';
  /** 挂断的时刻。 */
  readonly end: Minute;
}

/** 回服务间休息。 */
export interface BreakPlan {
  readonly type: 'break';
  readonly walk: Minute;
  /** 开始休息的时刻，也就是到达服务间的时刻。 */
  readonly start: Minute;
  readonly end: Minute;
}

export interface WaitPlan {
  readonly type: 'wait';
  readonly minutes: Minute;
  readonly end: Minute;
}

/** 走回服务间还车。 */
export interface FinishPlan {
  readonly type: 'finish';
  readonly walk: Minute;
  readonly end: Minute;
  /** 17:00 起的还车是强制下班。 */
  readonly forced: boolean;
}

export type ActionPlan = ServicePlan | RestockPlan | CallPlan | BreakPlan | WaitPlan | FinishPlan;

/** 一个动作的预览：合法时是计划，不合法时是原因。 */
export type Preview =
  | { readonly action: Action; readonly ok: true; readonly plan: ActionPlan }
  | { readonly action: Action; readonly ok: false; readonly reason: IllegalReason };

/** 预览一个动作，规则见文件开头。 */
export function previewAction(view: View, params: Params, action: Action): Preview {
  const reason = illegalReasonForView(view, params, action);
  if (reason !== null) return { action, ok: false, reason };
  return { action, ok: true, plan: planOf(view, params, action) };
}

function planOf(view: View, params: Params, action: Action): ActionPlan {
  const servicePoint = params.layout.servicePoint;
  const toService = walkMinutes(view.place, servicePoint, params);
  switch (action.type) {
    case 'service':
      return servicePlan(view, params, roomOf(view, action.room));
    case 'restock':
      return {
        type: 'restock',
        walk: toService,
        arrival: view.minute + toService,
        end: view.minute + toService + params.cart.restockMinutes,
        refill: params.cart.capacity - view.cart,
      };
    case 'call':
      return { type: 'call', end: view.minute + params.callMinutes };
    case 'break':
      return {
        type: 'break',
        walk: toService,
        start: view.minute + toService,
        end: view.minute + toService + params.shift.breakMinutes,
      };
    case 'wait':
      return { type: 'wait', minutes: action.minutes, end: view.minute + action.minutes };
    case 'finish':
      return {
        type: 'finish',
        walk: toService,
        end: view.minute + toService + params.shift.returnCartMinutes,
        forced: view.minute >= params.shift.hardStop,
      };
    case 'respond':
      // 阶段 0 没有事件，回应过不了合法性判定，走不到这里。
      throw new Error('预览：回应事件要到阶段 2 才有');
  }
}

function servicePlan(view: View, params: Params, room: RoomView): ServicePlan {
  const { hardStop } = params.shift;
  const walk = walkMinutes(view.place, room.place, params);
  const arrival = view.minute + walk;
  const levels: readonly MessLevel[] = room.mess === null ? MESS_LEVELS : [room.mess];
  const remaining = levels.map((level) => cleanMinutes(room.kind, level, params) - room.workDone);
  const cleaning = { from: Math.min(...remaining), to: Math.max(...remaining) };
  const cut: CutRisk =
    arrival + cleaning.from > hardStop ? 'sure' : arrival + cleaning.to > hardStop ? 'maybe' : 'none';
  const finish = { from: Math.min(arrival + cleaning.from, hardStop), to: Math.min(arrival + cleaning.to, hardStop) };
  const guestMayBeIn = room.kind !== 'departure' && room.knownAvailableFrom === null && room.mess === null;
  const refusedAt = guestMayBeIn ? arrival + params.knockRefusedMinutes : null;
  const spec = room.kind === 'departure' ? params.rooms.departure : params.rooms.stayover;
  const deadlines: DeadlineCheck[] = [];
  const judge = (kind: 'vip' | 'rush', at: Minute): void => {
    const verdict: DeadlineVerdict =
      cut === 'sure' || finish.from > at ? 'late' : cut === 'none' && refusedAt === null && finish.to <= at ? 'onTime' : 'maybeLate';
    deadlines.push({ kind, at, verdict });
  };
  if (room.vipDeadline !== null) judge('vip', room.vipDeadline);
  if (room.rushDeadline !== null) judge('rush', room.rushDeadline);
  return {
    type: 'service',
    room: room.id,
    walk,
    arrival,
    cleaning,
    finish,
    cut,
    refusedAt,
    linen: room.workDone === 0 ? spec.linen : 0,
    resumed: room.workDone,
    deadlines,
  };
}

function roomOf(view: View, id: RoomId): RoomView {
  const room = view.rooms.find((candidate) => candidate.id === id);
  if (room === undefined) throw new Error(`预览：View 里没有房间 ${id}`);
  return room;
}

/** 计划结束的时刻，最早到最晚：打扫是做完的时刻（可能是一段），别的动作是一个时刻。时间轴上的虚影画到最晚的那一刻。 */
export function planEnd(plan: ActionPlan): Span {
  return plan.type === 'service' ? plan.finish : { from: plan.end, to: plan.end };
}

/** 计划要走到哪里：打扫是那间房的门位，补货、休息、还车是服务间，打电话和等待原地不动（null）。 */
export function planTarget(plan: ActionPlan, view: View, params: Params): Place | null {
  switch (plan.type) {
    case 'service':
      return roomOf(view, plan.room).place;
    case 'restock':
    case 'break':
    case 'finish':
      return params.layout.servicePoint;
    case 'call':
    case 'wait':
      return null;
  }
}

/** 这个动作的控件能不能点，见文件开头第 4 条。 */
export function canPick(view: View, params: Params, action: Action): boolean {
  const reason = illegalReasonForView(view, params, action);
  return reason === null || !(GLOBAL_REASONS.includes(reason.code) || reason.code === 'roomDone');
}

/** 全局的原因：只剩一种动作能做（或者班次结束了）时，是哪一条；平常为 null。用打电话来问：这几种情况下它都不合法。 */
export function globalReason(view: View, params: Params): IllegalReason | null {
  const reason = illegalReasonForView(view, params, { type: 'call' });
  return reason !== null && GLOBAL_REASONS.includes(reason.code) ? reason : null;
}

/** 这一刻等待的上限（legalActionsForView 列出的那一档）；不能等待时为 null。 */
export function waitLimit(view: View, params: Params): Minute | null {
  const wait = legalActionsForView(view, params).find((action) => action.type === 'wait');
  return wait?.type === 'wait' ? wait.minutes : null;
}

/** 动作栏的五个按钮，按 docs/DESIGN.md 列的顺序。打扫是点房间。 */
export const BUTTONS = ['restock', 'call', 'break', 'wait', 'finish'] as const;
export type ButtonType = (typeof BUTTONS)[number];

/** 按钮点了预览的动作。等待先选上限那一档，再在预览里改分钟数；不能等待时用 1 分钟去问原因。 */
export function buttonAction(type: ButtonType, view: View, params: Params): Action {
  switch (type) {
    case 'restock':
      return { type: 'restock' };
    case 'call':
      return { type: 'call' };
    case 'break':
      return { type: 'break' };
    case 'wait':
      return { type: 'wait', minutes: waitLimit(view, params) ?? 1 };
    case 'finish':
      return { type: 'finish' };
  }
}
