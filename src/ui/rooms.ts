/**
 * 玩家对每间房知道什么：平面图和任务单共用的状态和已知信息，以及任务单的顺序。
 *
 * 1. 只读 View、params 和 recall 的结果，不读 World、State（班次进行中界面只读 View，docs/DESIGN.md 的技术选型）。
 *    纯函数，不修改传入的对象。这里不产出文字：状态和已知信息都是编号加数据，组件按编号从语言包取文案（format.ts）。
 *
 * 2. 状态（RoomStatus），按顺序取第一条成立的：
 *    - done：做完了。
 *    - locked：还不能进，要等新消息：退房房主管还没报已退，或者请勿打扰房还不知道摘牌。
 *    - later：客人说过回来时间，现在还没到。规则按到达门口的时刻算，可以提前出发（docs/DESIGN.md 的动作一览）；
 *      这里只说此刻还进不了门，现在出发几点到、赶不赶得上，是动作预览那一项的事。
 *    - open：看起来能进。续住房的客人在不在，不敲门不知道；布草够不够、来不来得及，也留给动作预览。
 *
 * 3. 已知信息（RoomFact），一间房列成几条，顺序固定：
 *    贵宾时限、催房时限（overdue：做完了的看完成时刻是否晚于时限；没做完的看现在是否已经到了时限，
 *    因为动作至少花 1 分钟，到了时限还没做完就一定赶不上）；延迟退房；
 *    做完了的写完成时刻；没做完的按房型写进度：退房房写主管报没报已退；请勿打扰房还不知道摘牌的写最近一次确认仍挂牌的
 *    时刻（recall 的 confirmedAt，没确认过是 null），已知摘牌的写已摘牌，再和续住房一样写回来时间，没有回来时间、
 *    也没开过门的写还没敲过门；
 *    开过门的写脏乱档位和这间房总共要打扫的分钟数（cleanMinutes），做到一半被 17:00 截断的再写已做的分钟数。
 *
 * 4. 任务单的顺序（docs/DESIGN.md："有时限的排在前面"）分四组，组内按 view.rooms 的顺序：
 *    有时限（贵宾或催房）、还没做完的，按最早的时限排；其余还没做完的；还不知道摘牌的请勿打扰房（它们不挡收工，
 *    任务单上淡显）；做完了的。
 *
 * 5. 平面图房间方块第二行的说明（RoomTag），按顺序取第一条成立的：此刻是 later 的写回来时间；有贵宾时限的写贵宾时限；
 *    有催房时限的写催房时限；都没有就写线索。
 */

import {
  cleanMinutes,
  type Clue,
  type HungDnd,
  type MessLevel,
  type Minute,
  type Params,
  type Recall,
  type RoomId,
  type RoomView,
  type View,
} from '../engine';

/** 一间房此刻的状态，含义见文件开头第 2 条。 */
export type RoomStatus = 'done' | 'locked' | 'later' | 'open';

/** 一条已知信息，含义和顺序见文件开头第 3 条。时刻是开工后第几分钟。 */
export type RoomFact =
  | { readonly code: 'vip'; readonly deadline: Minute; readonly overdue: boolean }
  | { readonly code: 'rush'; readonly deadline: Minute; readonly overdue: boolean }
  | { readonly code: 'lateCheckout' }
  | { readonly code: 'departed' }
  | { readonly code: 'notDeparted' }
  | { readonly code: 'comeBack'; readonly at: Minute }
  | { readonly code: 'notKnocked' }
  | { readonly code: 'stillHung'; readonly confirmedAt: Minute | null }
  | { readonly code: 'lifted' }
  | { readonly code: 'mess'; readonly level: MessLevel; readonly minutes: Minute }
  | { readonly code: 'workDone'; readonly minutes: Minute; readonly total: Minute }
  | { readonly code: 'done'; readonly at: Minute };

/** 平面图房间方块第二行的说明，见文件开头第 5 条。 */
export type RoomTag =
  | { readonly code: 'later'; readonly at: Minute }
  | { readonly code: 'vip'; readonly deadline: Minute }
  | { readonly code: 'rush'; readonly deadline: Minute }
  | { readonly code: 'clue'; readonly clue: Clue };

/** 一间房：View 里的样子，加上推出来的状态和已知信息。 */
export interface RoomInfo {
  readonly room: RoomView;
  readonly status: RoomStatus;
  readonly facts: readonly RoomFact[];
}

/** 任务单上的分组，顺序见文件开头第 4 条。 */
export type TaskGroup = 'deadline' | 'todo' | 'hung' | 'done';

const GROUP_ORDER: readonly TaskGroup[] = ['deadline', 'todo', 'hung', 'done'];

/** now 这一刻这间房的状态。 */
export function roomStatus(room: RoomView, now: Minute): RoomStatus {
  if (room.doneAt !== null) return 'done';
  if (room.kind === 'departure' && !room.flaggedDeparted) return 'locked';
  if (room.kind === 'dnd' && !room.dndLifted) return 'locked';
  if (room.knownAvailableFrom !== null && room.knownAvailableFrom > now) return 'later';
  return 'open';
}

/** 时限 deadline 是否已经赶不上：做完了的看完成时刻，没做完的看现在是否已经到了时限。 */
export function isOverdue(room: RoomView, deadline: Minute, now: Minute): boolean {
  return room.doneAt !== null ? room.doneAt > deadline : now >= deadline;
}

/**
 * 一间房的已知信息，按文件开头第 3 条的顺序。memory 是同一个 View 的 recall 结果：还不知道摘牌的请勿打扰房
 * 要在 memory.stillHung 里，不在就抛错（recall 和 View 对不上）。
 */
export function roomFacts(room: RoomView, now: Minute, params: Params, memory: Recall): RoomFact[] {
  const facts: RoomFact[] = [];
  if (room.vipDeadline !== null) {
    facts.push({ code: 'vip', deadline: room.vipDeadline, overdue: isOverdue(room, room.vipDeadline, now) });
  }
  if (room.rushDeadline !== null) {
    facts.push({ code: 'rush', deadline: room.rushDeadline, overdue: isOverdue(room, room.rushDeadline, now) });
  }
  if (room.lateCheckout) facts.push({ code: 'lateCheckout' });
  if (room.doneAt !== null) facts.push({ code: 'done', at: room.doneAt });
  else facts.push(...progressFacts(room, memory));
  if (room.mess !== null) {
    const total = cleanMinutes(room.kind, room.mess, params);
    facts.push({ code: 'mess', level: room.mess, minutes: total });
    if (room.doneAt === null && room.workDone > 0) facts.push({ code: 'workDone', minutes: room.workDone, total });
  }
  return facts;
}

/** 没做完的房间的进度，见文件开头第 3 条。 */
function progressFacts(room: RoomView, memory: Recall): RoomFact[] {
  if (room.kind === 'departure') return [room.flaggedDeparted ? { code: 'departed' } : { code: 'notDeparted' }];
  const facts: RoomFact[] = [];
  if (room.kind === 'dnd') {
    if (!room.dndLifted) return [{ code: 'stillHung', confirmedAt: hungOf(memory, room.id).confirmedAt }];
    facts.push({ code: 'lifted' });
  }
  if (room.knownAvailableFrom !== null) facts.push({ code: 'comeBack', at: room.knownAvailableFrom });
  else if (room.mess === null) facts.push({ code: 'notKnocked' });
  return facts;
}

function hungOf(memory: Recall, room: RoomId): HungDnd {
  const found = memory.stillHung.find((hung) => hung.room === room);
  if (found === undefined) throw new Error(`rooms: recall 里没有还不知道摘牌的请勿打扰房 ${room}，recall 和 View 对不上`);
  return found;
}

/** View 里每间房的状态和已知信息，按 view.rooms 的顺序。memory 是 recall(view, params) 的结果。 */
export function roomInfos(view: View, params: Params, memory: Recall): RoomInfo[] {
  return view.rooms.map(
    (room): RoomInfo => ({
      room,
      status: roomStatus(room, view.minute),
      facts: roomFacts(room, view.minute, params, memory),
    }),
  );
}

/** 这间房在任务单上的分组。 */
export function taskGroup(room: RoomView): TaskGroup {
  if (room.doneAt !== null) return 'done';
  if (room.vipDeadline !== null || room.rushDeadline !== null) return 'deadline';
  if (room.kind === 'dnd' && !room.dndLifted) return 'hung';
  return 'todo';
}

/** 任务单的顺序（见文件开头第 4 条）。返回新数组，不修改传入的数组。 */
export function taskSheetOrder(infos: readonly RoomInfo[]): RoomInfo[] {
  // Array.prototype.sort 是稳定的：比较结果为 0 的保持 view.rooms 的顺序。
  return [...infos].sort((a, b) => {
    const groupA = taskGroup(a.room);
    const groupB = taskGroup(b.room);
    if (groupA !== groupB) return GROUP_ORDER.indexOf(groupA) - GROUP_ORDER.indexOf(groupB);
    // 只有"有时限、还没做完"那一组按时限排；做完了的贵宾房和别的做完了的房间一样按 view.rooms 的顺序。
    return groupA === 'deadline' ? earliestDeadline(a.room) - earliestDeadline(b.room) : 0;
  });
}

/** 最早的时限。只对"有时限、还没做完"那一组调用，那一组的房间至少有一个时限。 */
function earliestDeadline(room: RoomView): Minute {
  return Math.min(...[room.vipDeadline, room.rushDeadline].filter((deadline): deadline is Minute => deadline !== null));
}

/** 平面图房间方块第二行的说明，见文件开头第 5 条。 */
export function roomTag(info: RoomInfo): RoomTag {
  const { room } = info;
  if (info.status === 'later' && room.knownAvailableFrom !== null) return { code: 'later', at: room.knownAvailableFrom };
  if (room.vipDeadline !== null) return { code: 'vip', deadline: room.vipDeadline };
  if (room.rushDeadline !== null) return { code: 'rush', deadline: room.rushDeadline };
  return { code: 'clue', clue: room.clue };
}
