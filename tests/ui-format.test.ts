/**
 * 编号写成文字（src/ui/format.ts）的单元测试：每个编号取的是语言包里对应的那一句，数据原样传进去，时刻换成钟点。
 * 已知信息、方块说明、非法动作的 21 个原因、预览的标题和几句代价都查。
 * 语言包用中文的表（src/content/zh/ui.ts），预期的文字也从表里取，不在测试里另写一份句子。
 */

import { describe, expect, it } from 'vitest';
import { zhUi as t } from '../src/content/zh/ui';
import {
  initial,
  observe,
  PARAMS,
  recall,
  toClock,
  type Action,
  type Clue,
  type IllegalReason,
  type IllegalReasonCode,
} from '../src/engine';
import { actionTitle, factText, illegalText, planLines, roomSummary, tagText } from '../src/ui/format';
import type { ActionPlan } from '../src/ui/preview';
import { roomInfos, type RoomFact, type RoomTag } from '../src/ui/rooms';
import { errorOf } from './helpers/drive';
import { controlledWorld, departure } from './helpers/world';

const CLUES: readonly Clue[] = ['business', 'tourist', 'family', 'longStay', 'oneNight', 'threeNightsPlus', 'partyOrFamily'];

describe('factText', () => {
  it('每个编号取对应的那一句', () => {
    const cases: readonly (readonly [RoomFact, string])[] = [
      [{ code: 'vip', deadline: 270, overdue: false }, t.taskSheet.vip('13:00', false)],
      [{ code: 'vip', deadline: 270, overdue: true }, t.taskSheet.vip('13:00', true)],
      [{ code: 'rush', deadline: 315, overdue: false }, t.taskSheet.rush('13:45', false)],
      [{ code: 'rush', deadline: 315, overdue: true }, t.taskSheet.rush('13:45', true)],
      [{ code: 'lateCheckout' }, t.taskSheet.lateCheckout],
      [{ code: 'departed' }, t.taskSheet.departed],
      [{ code: 'notDeparted' }, t.taskSheet.notDeparted],
      [{ code: 'comeBack', at: 165 }, t.taskSheet.comeBack('11:15')],
      [{ code: 'notKnocked' }, t.taskSheet.notKnocked],
      [{ code: 'stillHung', confirmedAt: 317 }, t.taskSheet.stillHung('13:47')],
      [{ code: 'stillHung', confirmedAt: null }, t.taskSheet.neverConfirmed],
      [{ code: 'lifted' }, t.taskSheet.lifted],
      [{ code: 'mess', level: 'tidy', minutes: 12 }, t.taskSheet.mess(t.mess.tidy, 12)],
      [{ code: 'mess', level: 'normal', minutes: 30 }, t.taskSheet.mess(t.mess.normal, 30)],
      [{ code: 'mess', level: 'disaster', minutes: 48 }, t.taskSheet.mess(t.mess.disaster, 48)],
      [{ code: 'workDone', minutes: 39, total: 48 }, t.taskSheet.workDone(39, 48)],
      [{ code: 'done', at: 132 }, t.taskSheet.done('10:42')],
    ];
    for (const [fact, expected] of cases) expect(factText(fact, t), JSON.stringify(fact)).toBe(expected);
    // 几对容易取反的句子确实不同，上面的对照才有意义。
    expect(t.taskSheet.vip('13:00', true)).not.toBe(t.taskSheet.vip('13:00', false));
    expect(t.taskSheet.departed).not.toBe(t.taskSheet.notDeparted);
    expect(t.taskSheet.workDone(39, 48)).not.toBe(t.taskSheet.workDone(48, 39));
    expect(new Set(Object.values(t.mess)).size).toBe(3);
  });
});

describe('tagText', () => {
  it('回来时间、贵宾时限、催房时限和每种线索各取对应的那一句', () => {
    const cases: readonly (readonly [RoomTag, string])[] = [
      [{ code: 'later', at: 165 }, t.floorPlan.laterTag('11:15')],
      [{ code: 'vip', deadline: 270 }, t.floorPlan.vipTag('13:00')],
      [{ code: 'rush', deadline: 315 }, t.floorPlan.rushTag('13:45')],
      ...CLUES.map((clue): readonly [RoomTag, string] => [{ code: 'clue', clue }, t.clueShort[clue]]),
    ];
    for (const [tag, expected] of cases) expect(tagText(tag, t), JSON.stringify(tag)).toBe(expected);
    expect(new Set([t.floorPlan.laterTag('11:15'), t.floorPlan.vipTag('11:15'), t.floorPlan.rushTag('11:15')]).size).toBe(3);
    expect(new Set(CLUES.map((clue) => t.clueShort[clue])).size).toBe(CLUES.length);
  });
});

describe('roomSummary', () => {
  it('房号、房型全称、线索全称，加上按顺序写成文字的已知信息', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 270, clue: 'threeNightsPlus' }) });
    const view = observe(world, initial(world));
    const info = roomInfos(view, world.params, recall(view, world.params)).find((candidate) => candidate.room.id === 1202);
    if (info === undefined) throw new Error('没有 1202');
    expect(roomSummary(info, t)).toBe(
      t.taskSheet.summary(1202, t.kind.departure, t.clue.threeNightsPlus, [
        t.taskSheet.vip(toClock(270), false),
        t.taskSheet.notDeparted,
      ]),
    );
  });
});

describe('illegalText', () => {
  it('21 个编号各取对应的那一句，时刻换成钟点；编号表少一个就过不了类型检查', () => {
    const cases: { readonly [K in IllegalReasonCode]: readonly [Extract<IllegalReason, { code: K }>, string] } = {
      ended: [{ code: 'ended' }, t.illegal.ended],
      mustRespond: [{ code: 'mustRespond' }, t.illegal.mustRespond],
      noSuchOption: [{ code: 'noSuchOption', option: 'b' }, t.illegal.noSuchOption('b')],
      afterHardStop: [{ code: 'afterHardStop', hardStop: 510 }, t.illegal.afterHardStop('17:00')],
      mustBreak: [{ code: 'mustBreak', breakLatest: 360 }, t.illegal.mustBreak('14:30')],
      restockTooLate: [{ code: 'restockTooLate', hardStop: 510 }, t.illegal.restockTooLate('17:00')],
      callTooLate: [{ code: 'callTooLate', hardStop: 480 }, t.illegal.callTooLate('16:30')],
      breakAlreadyTaken: [{ code: 'breakAlreadyTaken' }, t.illegal.breakAlreadyTaken],
      breakTooEarly: [{ code: 'breakTooEarly', breakEarliest: 120, arrival: 95 }, t.illegal.breakTooEarly('10:30', '10:05')],
      badWait: [{ code: 'badWait', limit: 4 }, t.illegal.badWait(4)],
      noPrompt: [{ code: 'noPrompt' }, t.illegal.noPrompt],
      unknownAction: [{ code: 'unknownAction' }, t.illegal.unknownAction],
      noSuchRoom: [{ code: 'noSuchRoom', room: 999 }, t.illegal.noSuchRoom(999)],
      roomDone: [{ code: 'roomDone', room: 1204 }, t.illegal.roomDone(1204)],
      notFlagged: [{ code: 'notFlagged', room: 1201 }, t.illegal.notFlagged(1201)],
      dndNotLifted: [{ code: 'dndNotLifted', room: 1305 }, t.illegal.dndNotLifted(1305)],
      cannotReachInTime: [{ code: 'cannotReachInTime', room: 1307, hardStop: 510 }, t.illegal.cannotReachInTime(1307, '17:00')],
      comeBackLater: [
        { code: 'comeBackLater', room: 1207, comeBackAt: 165, arrival: 150 },
        t.illegal.comeBackLater(1207, '11:15', '11:00'),
      ],
      linenShort: [{ code: 'linenShort', room: 1202, needed: 2, cart: 1 }, t.illegal.linenShort(1202, 2, 1)],
      breakNotTaken: [{ code: 'breakNotTaken' }, t.illegal.breakNotTaken],
      roomsLeft: [{ code: 'roomsLeft', rooms: [1201, 1305] }, t.illegal.roomsLeft([1201, 1305])],
    };
    for (const [reason, expected] of Object.values(cases)) expect(illegalText(reason, t), reason.code).toBe(expected);
    // 带两个数的句子，先后确实看得出来，上面的对照才有意义。
    expect(t.illegal.comeBackLater(1207, '11:15', '11:00')).not.toBe(t.illegal.comeBackLater(1207, '11:00', '11:15'));
    expect(t.illegal.breakTooEarly('10:30', '10:05')).not.toBe(t.illegal.breakTooEarly('10:05', '10:30'));
    expect(t.illegal.linenShort(1202, 2, 1)).not.toBe(t.illegal.linenShort(1202, 1, 2));
  });
});

describe('actionTitle', () => {
  it('每种动作取对应的标题；回应事件在阶段 0 没有，抛错', () => {
    const cases: readonly (readonly [Action, string])[] = [
      [{ type: 'service', room: 1204 }, t.preview.service(1204)],
      [{ type: 'restock' }, t.preview.restock],
      [{ type: 'call' }, t.preview.call],
      [{ type: 'break' }, t.preview.break],
      [{ type: 'wait', minutes: 3 }, t.preview.wait],
      [{ type: 'finish' }, t.preview.finish],
    ];
    for (const [action, expected] of cases) expect(actionTitle(action, t)).toBe(expected);
    expect(errorOf(() => actionTitle({ type: 'respond', option: 'a' }, t))).toContain('阶段 2');
  });
});

describe('planLines', () => {
  const params = PARAMS.standard;
  const world = controlledWorld({});
  const view = observe(world, initial(world));

  it('打扫：步行、打扫多久、几点做完、客人可能在、布草、时限，按这个顺序', () => {
    const plan: ActionPlan = {
      type: 'service',
      room: 1204,
      walk: 2,
      arrival: 2,
      cleaning: { from: 24, to: 48 },
      finish: { from: 26, to: 50 },
      cut: 'none',
      refusedAt: 3,
      linen: 2,
      resumed: 0,
      deadlines: [
        { kind: 'vip', at: 270, verdict: 'onTime' },
        { kind: 'rush', at: 40, verdict: 'maybeLate' },
      ],
    };
    expect(planLines(plan, view, params, t)).toEqual([
      t.preview.walk(2, '08:32'),
      t.preview.cleaning(24, 48),
      t.preview.finishAt('08:56', '09:20'),
      t.preview.mayBeRefused('08:33'),
      t.preview.linen(2, view.cart - 2),
      t.preview.onTime(t.preview.vip, '13:00'),
      t.preview.maybeLate(t.preview.rush, '09:10'),
    ]);
  });

  it('打扫：接着做的写已做的分钟数、不用布草；可能做不完、一定做不完；赶不上', () => {
    const base = {
      type: 'service',
      room: 1201,
      walk: 1,
      arrival: 470,
      cleaning: { from: 20, to: 20 },
      refusedAt: null,
      linen: 0,
      resumed: 10,
    } as const;
    const maybe: ActionPlan = {
      ...base,
      finish: { from: 490, to: 510 },
      cut: 'maybe',
      deadlines: [{ kind: 'vip', at: 480, verdict: 'late' }],
    };
    expect(planLines(maybe, view, params, t)).toEqual([
      t.preview.walk(1, toClock(470)),
      t.preview.resume(10),
      t.preview.cleaning(20, 20),
      t.preview.finishAt('16:40', '17:00'),
      t.preview.cutMaybe('17:00'),
      t.preview.noLinen,
      t.preview.late(t.preview.vip, '16:30'),
    ]);
    const sure: ActionPlan = { ...base, finish: { from: 510, to: 510 }, cut: 'sure', deadlines: [] };
    expect(planLines(sure, view, params, t)).toEqual([
      t.preview.walk(1, toClock(470)),
      t.preview.resume(10),
      t.preview.cleaning(20, 20),
      t.preview.cutSure('17:00'),
      t.preview.noLinen,
    ]);
  });

  it('补货、打电话、休息、等待、收工还车（含强制下班）', () => {
    expect(planLines({ type: 'restock', walk: 3, arrival: 33, end: 38, refill: 4 }, view, params, t)).toEqual([
      t.preview.walk(3, '09:03'),
      t.preview.restockPlan('09:08', params.cart.capacity),
    ]);
    expect(planLines({ type: 'call', end: 2 }, view, params, t)).toEqual([t.preview.callPlan('08:32')]);
    expect(planLines({ type: 'break', walk: 2, start: 120, end: 150 }, view, params, t)).toEqual([
      t.preview.walk(2, '10:30'),
      t.preview.breakPlan('10:30', '11:00'),
    ]);
    expect(planLines({ type: 'wait', minutes: 4, end: 4 }, view, params, t)).toEqual([t.preview.waitPlan(4, '08:34')]);
    expect(planLines({ type: 'finish', walk: 4, end: 9, forced: false }, view, params, t)).toEqual([
      t.preview.walk(4, '08:34'),
      t.preview.finishPlan('08:39'),
    ]);
    expect(planLines({ type: 'finish', walk: 4, end: 9, forced: true }, view, params, t)).toEqual([
      t.preview.walk(4, '08:34'),
      t.preview.finishPlan('08:39'),
      t.preview.forced('17:00'),
    ]);
  });
});
