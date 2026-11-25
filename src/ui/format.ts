/**
 * 把 rooms.ts 的编号写成文字：按编号从语言包取文案，时刻用 clock.ts 换成钟点。
 * 不是组件，不调用 useText，文案表由调用它的组件传进来。每个 switch 都列全编号，漏写一个就过不了类型检查。
 */

import type { UiText } from '../content';
import { toClock } from '../engine';
import type { RoomFact, RoomInfo, RoomTag } from './rooms';

/** 一条已知信息的文字，任务单和平面图的提示文字共用。 */
export function factText(fact: RoomFact, t: UiText): string {
  const text = t.taskSheet;
  switch (fact.code) {
    case 'vip':
      return text.vip(toClock(fact.deadline), fact.overdue);
    case 'rush':
      return text.rush(toClock(fact.deadline), fact.overdue);
    case 'lateCheckout':
      return text.lateCheckout;
    case 'departed':
      return text.departed;
    case 'notDeparted':
      return text.notDeparted;
    case 'comeBack':
      return text.comeBack(toClock(fact.at));
    case 'notKnocked':
      return text.notKnocked;
    case 'stillHung':
      return fact.confirmedAt === null ? text.neverConfirmed : text.stillHung(toClock(fact.confirmedAt));
    case 'lifted':
      return text.lifted;
    case 'mess':
      return text.mess(t.mess[fact.level], fact.minutes);
    case 'workDone':
      return text.workDone(fact.minutes, fact.total);
    case 'done':
      return text.done(toClock(fact.at));
  }
}

/** 平面图房间方块第二行房型简称后面的说明。 */
export function tagText(tag: RoomTag, t: UiText): string {
  const text = t.floorPlan;
  switch (tag.code) {
    case 'later':
      return text.laterTag(toClock(tag.at));
    case 'vip':
      return text.vipTag(toClock(tag.deadline));
    case 'rush':
      return text.rushTag(toClock(tag.deadline));
    case 'clue':
      return t.clueShort[tag.clue];
  }
}

/** 一间房的完整说明：房号、房型、线索和全部已知信息，平面图上鼠标停在房间方块上时显示。 */
export function roomSummary(info: RoomInfo, t: UiText): string {
  const { room } = info;
  return t.taskSheet.summary(
    room.id,
    t.kind[room.kind],
    t.clue[room.clue],
    info.facts.map((fact) => factText(fact, t)),
  );
}
