/**
 * 把界面的编号写成文字：rooms.ts 的已知信息和方块说明、引擎的非法动作原因、preview.ts 的预览，按编号从语言包取文案，
 * 时刻用 clock.ts 换成钟点。不是组件，不调用 useText，文案表由调用它的组件传进来。
 * 每个 switch 都列全编号，漏写一个就过不了类型检查。
 */

import type { UiText } from '../content';
import { toClock, type Action, type IllegalReason, type Params, type View } from '../engine';
import type { ActionPlan, DeadlineCheck } from './preview';
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

/** 非法动作的原因写成一句话：按编号取语言包里的句子，原因里的时刻换成钟点。 */
export function illegalText(reason: IllegalReason, t: UiText): string {
  const text = t.illegal;
  switch (reason.code) {
    case 'ended':
      return text.ended;
    case 'mustRespond':
      return text.mustRespond;
    case 'noSuchOption':
      return text.noSuchOption(reason.option);
    case 'afterHardStop':
      return text.afterHardStop(toClock(reason.hardStop));
    case 'mustBreak':
      return text.mustBreak(toClock(reason.breakLatest));
    case 'restockTooLate':
      return text.restockTooLate(toClock(reason.hardStop));
    case 'callTooLate':
      return text.callTooLate(toClock(reason.hardStop));
    case 'breakAlreadyTaken':
      return text.breakAlreadyTaken;
    case 'breakTooEarly':
      return text.breakTooEarly(toClock(reason.breakEarliest), toClock(reason.arrival));
    case 'badWait':
      return text.badWait(reason.limit);
    case 'noPrompt':
      return text.noPrompt;
    case 'unknownAction':
      return text.unknownAction;
    case 'noSuchRoom':
      return text.noSuchRoom(reason.room);
    case 'roomDone':
      return text.roomDone(reason.room);
    case 'notFlagged':
      return text.notFlagged(reason.room);
    case 'dndNotLifted':
      return text.dndNotLifted(reason.room);
    case 'cannotReachInTime':
      return text.cannotReachInTime(reason.room, toClock(reason.hardStop));
    case 'comeBackLater':
      return text.comeBackLater(reason.room, toClock(reason.comeBackAt), toClock(reason.arrival));
    case 'linenShort':
      return text.linenShort(reason.room, reason.needed, reason.cart);
    case 'breakNotTaken':
      return text.breakNotTaken;
    case 'roomsLeft':
      return text.roomsLeft(reason.rooms);
  }
}

/** 预览的标题：要做的是什么动作。 */
export function actionTitle(action: Action, t: UiText): string {
  const text = t.preview;
  switch (action.type) {
    case 'service':
      return text.service(action.room);
    case 'restock':
      return text.restock;
    case 'call':
      return text.call;
    case 'break':
      return text.break;
    case 'wait':
      return text.wait;
    case 'finish':
      return text.finish;
    case 'respond':
      // 阶段 0 没有事件，界面上没有回应的控件。
      throw new Error('预览：回应事件要到阶段 2 才有');
  }
}

/** 一条时限判断的文字。 */
function deadlineText(check: DeadlineCheck, t: UiText): string {
  const text = t.preview;
  const kind = check.kind === 'vip' ? text.vip : text.rush;
  const clock = toClock(check.at);
  switch (check.verdict) {
    case 'onTime':
      return text.onTime(kind, clock);
    case 'maybeLate':
      return text.maybeLate(kind, clock);
    case 'late':
      return text.late(kind, clock);
  }
}

/**
 * 合法动作的预览写成几句话，按显示的顺序（preview.ts 的计划）：
 * 打扫是步行、接着做（有的话）、打扫多久、几点做完或者 17:00 前做不完、客人可能在（有的话）、布草、这间房的时限；
 * 补货、休息、收工还车是步行和各自几点完；打电话是几点挂断；等待是等几分钟、到几点。
 */
export function planLines(plan: ActionPlan, view: View, params: Params, t: UiText): string[] {
  const text = t.preview;
  const hardStop = toClock(params.shift.hardStop);
  switch (plan.type) {
    case 'service': {
      const lines = [text.walk(plan.walk, toClock(plan.arrival))];
      if (plan.resumed > 0) lines.push(text.resume(plan.resumed));
      lines.push(text.cleaning(plan.cleaning.from, plan.cleaning.to));
      if (plan.cut === 'sure') lines.push(text.cutSure(hardStop));
      else lines.push(text.finishAt(toClock(plan.finish.from), toClock(plan.finish.to)));
      if (plan.cut === 'maybe') lines.push(text.cutMaybe(hardStop));
      if (plan.refusedAt !== null) lines.push(text.mayBeRefused(toClock(plan.refusedAt)));
      lines.push(plan.linen > 0 ? text.linen(plan.linen, view.cart - plan.linen) : text.noLinen);
      for (const check of plan.deadlines) lines.push(deadlineText(check, t));
      return lines;
    }
    case 'restock':
      return [text.walk(plan.walk, toClock(plan.arrival)), text.restockPlan(toClock(plan.end), params.cart.capacity)];
    case 'call':
      return [text.callPlan(toClock(plan.end))];
    case 'break':
      return [text.walk(plan.walk, toClock(plan.start)), text.breakPlan(toClock(plan.start), toClock(plan.end))];
    case 'wait':
      return [text.waitPlan(plan.minutes, toClock(plan.end))];
    case 'finish': {
      const lines = [text.walk(plan.walk, toClock(view.minute + plan.walk)), text.finishPlan(toClock(plan.end))];
      if (plan.forced) lines.push(text.forced(hardStop));
      return lines;
    }
  }
}
