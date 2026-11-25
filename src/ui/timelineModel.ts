/**
 * 时间轴上画什么：刻度、休息、时限的小旗、回来时间的小点和指针（docs/DESIGN.md 的"主界面的四个部件"）。
 *
 * 1. 只读 View 和 params，纯函数。时刻都是开工后第几分钟；组件显示时用 clock.ts 换成钟点，用 percentOf 换成位置。
 * 2. 轴从开工（0）画到 17:00（hardStop）。17:00 以后才还完车时，现在的时刻晚于 17:00，轴的右端就延到现在，指针不出界；
 *    正在预览的动作 17:00 以后才做完（收工还车）时，也延到它，虚影不出界。
 * 3. 带字的刻度：开工、10:30（breakEarliest）、14:30（breakLatest）、16:00（targetFinish）、17:00（hardStop），
 *    都从 params 读；另有每个整点一个不带字的小刻度（整点按 clock.ts 的开工时刻推）。
 * 4. 休息。还没休息时，浅色带从 10:30 画到轴的右端，表示从这时起可以开始休息（按到达服务间的时刻算，没有上界）；
 *    14:30 处画一条线：还没休息的话，从这里起只能休息。休息过了就不画这两样，改画实际休息的那一段：
 *    从休息那条日志的开始加步行（到达服务间的时刻）到它结束。
 * 5. 小旗：每间房的贵宾时限、催房时限各一面，标着房号；记下做没做完，和是否已经赶不上（口径同 rooms.ts 的 isOverdue）。
 *    旗上的字可能挤在一起，所以分行（lane）：按时刻从早到晚一面一面放，放进编号最小的、和这一行已有的旗相差至少
 *    LABEL_SPAN 分钟的那一行，都放不下就另起一行。
 * 6. 小点：客人告知过回来时间、还没做完的房间，在回来时间处各一个，按 view.rooms 的顺序。
 */

import { SHIFT_START_OF_DAY, type Minute, type Params, type RoomId, type View } from '../engine';
import { isOverdue } from './rooms';

/**
 * 同一行里两面旗至少隔这么多分钟，旗上的字才不重叠。这是画面布局的长度，不是玩法数值，所以不放 params。
 * 按最窄的屏幕定：320 像素宽的手机上，轴约 240 像素，100 分钟约 47 像素，放得下小旗加四位房号（窄屏上旗字只留房号，
 * 见 index.css）；宽屏上连"贵宾"两个字一起也远远放得下，只是相隔不到 100 分钟的两面旗会分在两行。
 */
export const LABEL_SPAN: Minute = 100;

/** 一小时的分钟数，用来找整点。这是单位换算，不是玩法数值。 */
const MINUTES_PER_HOUR = 60;

/** 带字的刻度是哪一个时刻。 */
export type TickRole = 'start' | 'breakEarliest' | 'breakLatest' | 'targetFinish' | 'hardStop';

export interface TimelineTick {
  readonly role: TickRole;
  readonly at: Minute;
}

/** 一面小旗。 */
export interface TimelineFlag {
  readonly room: RoomId;
  readonly kind: 'vip' | 'rush';
  readonly at: Minute;
  readonly done: boolean;
  readonly overdue: boolean;
  /** 旗上的字放在第几行，0 是离轴最近的一行。 */
  readonly lane: number;
}

/** 一段时间，from 到 to。 */
export interface Span {
  readonly from: Minute;
  readonly to: Minute;
}

/** 时间轴上的全部内容。 */
export interface TimelineModel {
  /** 轴的右端，见文件开头第 2 条。左端是开工（0）。 */
  readonly end: Minute;
  readonly now: Minute;
  readonly ticks: readonly TimelineTick[];
  /** 不带字的整点刻度。 */
  readonly hours: readonly Minute[];
  /** 可以开始休息的浅色带；休息过了为 null。 */
  readonly breakWindow: Span | null;
  /** 14:30 那条线；休息过了为 null。 */
  readonly breakLatest: Minute | null;
  /** 实际休息的那一段；还没休息为 null。 */
  readonly breakTaken: Span | null;
  readonly flags: readonly TimelineFlag[];
  /** 旗字一共占几行，没有旗时为 0。 */
  readonly lanes: number;
  readonly comeBacks: readonly { readonly room: RoomId; readonly at: Minute }[];
}

/**
 * 时间轴的内容，规则见文件开头。until 是正在预览的动作最晚做完的时刻（指针前方的虚影画到这里），
 * 它晚于 17:00 时（17:00 以后才还完车），轴的右端也延到它。
 */
export function timelineModel(view: View, params: Params, until: Minute | null = null): TimelineModel {
  const { shift } = params;
  const end = Math.max(shift.hardStop, view.minute, until ?? view.minute);
  const breakEntry = view.log.find((entry) => entry.outcome.type === 'breakTaken');
  const { flags, lanes } = placeFlags(view);
  return {
    end,
    now: view.minute,
    ticks: [
      { role: 'start', at: 0 },
      { role: 'breakEarliest', at: shift.breakEarliest },
      { role: 'breakLatest', at: shift.breakLatest },
      { role: 'targetFinish', at: shift.targetFinish },
      { role: 'hardStop', at: shift.hardStop },
    ],
    hours: hourTicks(end),
    breakWindow: view.breakTaken ? null : { from: shift.breakEarliest, to: end },
    breakLatest: view.breakTaken ? null : shift.breakLatest,
    breakTaken: breakEntry === undefined ? null : { from: breakEntry.start + breakEntry.walk, to: breakEntry.end },
    flags,
    lanes,
    comeBacks: view.rooms.flatMap((room) =>
      room.doneAt === null && room.knownAvailableFrom !== null ? [{ room: room.id, at: room.knownAvailableFrom }] : [],
    ),
  };
}

/** minute 在轴上的位置，0 到 100 的百分比；轴从 0 到 end。 */
export function percentOf(minute: Minute, end: Minute): number {
  return (minute / end) * 100;
}

/** 0 和 end 之间（不含两端）的整点，开工后第几分钟。 */
function hourTicks(end: Minute): Minute[] {
  const offset = SHIFT_START_OF_DAY % MINUTES_PER_HOUR;
  const first = offset === 0 ? MINUTES_PER_HOUR : MINUTES_PER_HOUR - offset;
  const hours: Minute[] = [];
  for (let minute = first; minute < end; minute += MINUTES_PER_HOUR) hours.push(minute);
  return hours;
}

/** 每面小旗和它的行，见文件开头第 5 条。时刻相同的按 view.rooms 的顺序，同一间房先贵宾后催房。 */
function placeFlags(view: View): { flags: TimelineFlag[]; lanes: number } {
  const unplaced = view.rooms.flatMap((room) => {
    const deadlines: { kind: 'vip' | 'rush'; at: Minute }[] = [];
    if (room.vipDeadline !== null) deadlines.push({ kind: 'vip', at: room.vipDeadline });
    if (room.rushDeadline !== null) deadlines.push({ kind: 'rush', at: room.rushDeadline });
    return deadlines.map(({ kind, at }) => ({
      room: room.id,
      kind,
      at,
      done: room.doneAt !== null,
      overdue: isOverdue(room, at, view.minute),
    }));
  });
  // 稳定排序：时刻相同的保持上面的顺序。
  unplaced.sort((a, b) => a.at - b.at);
  // 每一行最后放进去的那面旗的时刻。按时刻从早到晚放，只要和每行最后一面比。
  const laneEnds: Minute[] = [];
  const flags = unplaced.map((flag): TimelineFlag => {
    let lane = laneEnds.findIndex((last) => flag.at - last >= LABEL_SPAN);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = flag.at;
    return { ...flag, lane };
  });
  return { flags, lanes: laneEnds.length };
}
