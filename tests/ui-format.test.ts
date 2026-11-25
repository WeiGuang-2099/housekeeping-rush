/**
 * 编号写成文字（src/ui/format.ts）的单元测试：每个编号取的是语言包里对应的那一句，数据原样传进去，时刻换成钟点。
 * 语言包用中文的表（src/content/zh/ui.ts），预期的文字也从表里取，不在测试里另写一份句子。
 */

import { describe, expect, it } from 'vitest';
import { zhUi as t } from '../src/content/zh/ui';
import { initial, observe, recall, toClock, type Clue } from '../src/engine';
import { factText, roomSummary, tagText } from '../src/ui/format';
import { roomInfos, type RoomFact, type RoomTag } from '../src/ui/rooms';
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
