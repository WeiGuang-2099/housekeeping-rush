/**
 * rules 的单元测试：打给主管（call）。
 *
 * 判定时刻是挂断的时刻 T = minute + 2。退房时刻不晚于 T 的退房房标为已退，摘牌时刻不晚于 T 的请勿打扰房得知摘牌；
 * 结果只列这通电话新得知的房间，按 world.rooms 的顺序（12 楼在前，13 楼在后，同层按房号）。
 * 服务间是 12 楼门位 0，那里没有房间，在服务间等待不会看到任何摘牌。
 */

import { describe, expect, it } from 'vitest';
import { initial } from '../src/engine/rules';
import type { State } from '../src/engine/types';
import { act, expectIllegal, expectLegal, freshProgress, last, play, progress, waitUntil } from './helpers/drive';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

describe('call', () => {
  it('耗时 2 分钟，原地不动，步行为 0；退房时刻恰好等于挂断时刻的标为已退，晚 1 分钟的不标', () => {
    // 1205 续住（客人已出门），1201 在 52 退房，1203 在 53 退房。
    const world = controlledWorld({
      1201: departure({ availableFrom: 52 }),
      1203: departure({ availableFrom: 53 }),
      1205: stayover(),
    });
    // 先做 1205：走 3 分钟，3 到门口，18 做完，停在 {12, 3}。在门口等到 50 打电话，挂断时刻 T = 52。
    let state = play(world, initial(world), act.service(1205));
    state = play(world, waitUntil(world, state, 50), act.call());
    expect(last(state)).toEqual({
      start: 50,
      end: 52,
      from: { floor: 12, door: 3 },
      to: { floor: 12, door: 3 },
      action: act.call(),
      outcome: { type: 'called', newlyDeparted: [1201], newlyLifted: [] },
      walk: 0,
      noticedLifted: [],
    });
    expect(state.minute).toBe(52);
    expect(state.place).toEqual({ floor: 12, door: 3 });
    expect(progress(state, 1201).flaggedDeparted).toBe(true);
    expect(progress(state, 1203).flaggedDeparted).toBe(false);
    // 52 再打一次，挂断时刻 54 >= 53，1203 也标为已退。
    state = play(world, state, act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [1203], newlyLifted: [] });
    expect(progress(state, 1203).flaggedDeparted).toBe(true);
  });

  it('208 打的电话会标记 210 退房的延迟退房房，207 打的不会', () => {
    const world = controlledWorld({ 1207: departure({ availableFrom: 210, lateCheckout: true }) });
    // 207 打：挂断时刻 209 < 210，不标。
    const early = play(world, waitUntil(world, initial(world), 207), act.call());
    expect(last(early).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [] });
    expect(progress(early, 1207).flaggedDeparted).toBe(false);
    // 208 打：挂断时刻 210 <= 210，标为已退。
    const onTime = play(world, waitUntil(world, initial(world), 208), act.call());
    expect(last(onTime).outcome).toEqual({ type: 'called', newlyDeparted: [1207], newlyLifted: [] });
    expect(progress(onTime, 1207).flaggedDeparted).toBe(true);
  });

  it('只列这通电话新得知的房间，按 world.rooms 的顺序；再打不重复列出；标记只增不减；不改变续住房的已知信息', () => {
    // 退房：1201 开工前已退，1203 在 100 退，1305 在 40 退。请勿打扰：1207 在 150 摘牌，1302 在 160 摘牌。
    // 续住：1205 的客人 250 才出门（长住）。
    const world = controlledWorld({
      1201: departure(),
      1203: departure({ availableFrom: 100 }),
      1205: stayover({ clue: 'longStay', availableFrom: 250 }),
      1207: dnd({ dndLiftsAt: 150 }),
      1302: dnd({ dndLiftsAt: 160 }),
      1305: departure({ availableFrom: 40, clue: 'partyOrFamily' }),
    });
    // 先去 1205：走 3 分钟，3 到门口，客人还在，被拒，4 结束；回来时间 ceil(250 / 15) × 15 = 17 × 15 = 255。
    let state = play(world, initial(world), act.service(1205));
    const stayoverKnown = progress(state, 1205);
    expect(stayoverKnown).toStrictEqual({ ...freshProgress(1205), knownAvailableFrom: 255 });

    // 之后一直站在 {12, 3}：门位 3 只有 1205 和 1206，看不到 1207（门位 4）和 1302（13 楼）摘牌。
    const calls: { at: number; departed: number[]; lifted: number[] }[] = [
      // 4 打，挂断 6：只有 1201（-30 <= 6）。
      { at: 4, departed: [1201], lifted: [] },
      // 98 打，挂断 100：1203（100）和 1305（40）。按 world.rooms 的顺序 1203 在前，不按退房先后；1201 不再列出。
      { at: 98, departed: [1203, 1305], lifted: [] },
      // 158 打，挂断 160：1207（150）和 1302（160）摘牌。
      { at: 158, departed: [], lifted: [1207, 1302] },
      // 紧接着 160 再打，挂断 162：没有新消息。
      { at: 160, departed: [], lifted: [] },
    ];
    for (const { at, departed, lifted } of calls) {
      const before: State = waitUntil(world, state, at);
      state = play(world, before, act.call());
      expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: departed, newlyLifted: lifted });
      // 标记只增不减。
      for (const room of before.rooms) {
        const after = progress(state, room.id);
        if (room.flaggedDeparted) expect(after.flaggedDeparted).toBe(true);
        if (room.dndLiftKnown) expect(after.dndLiftKnown).toBe(true);
      }
      // 电话不涉及续住房的任何信息。
      expect(progress(state, 1205)).toStrictEqual(stayoverKnown);
    }
    for (const id of [1201, 1203, 1305]) expect(progress(state, id).flaggedDeparted).toBe(true);
    for (const id of [1207, 1302]) expect(progress(state, id).dndLiftKnown).toBe(true);
  });

  it('摘牌时刻不晚于挂断时刻的请勿打扰房得知摘牌；整班不摘的永远不会得知', () => {
    // 1201 在 150 摘牌，1203 在 151 摘牌，1205 整班不摘。一直待在服务间，只靠电话。
    const world = controlledWorld({
      1201: dnd({ dndLiftsAt: 150 }),
      1203: dnd({ dndLiftsAt: 151 }),
      1205: dnd(),
    });
    // 148 打，挂断 150：1201（150 <= 150）得知，1203（151 > 150）没有。
    let state = play(world, waitUntil(world, initial(world), 148), act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1201] });
    expect(progress(state, 1203).dndLiftKnown).toBe(false);
    // 150 再打，挂断 152：1203 得知。
    state = play(world, state, act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1203] });
    // 152 在服务间休息到 182，再等到 508 打最后一通（挂断 510）：1205 仍然不得知。
    state = play(world, state, act.break());
    state = play(world, waitUntil(world, state, 508), act.call());
    expect(state.minute).toBe(510);
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [] });
    expect(progress(state, 1205).dndLiftKnown).toBe(false);
    // 17:00 之后只能还车；还完车 1205 也仍是不知道。
    state = play(world, state, act.finish());
    expect(progress(state, 1205).dndLiftKnown).toBe(false);
  });

  it('延迟退房房到了 12:00 也不会自动标记，要打电话；回来时间不预填', () => {
    // 1201 延迟到 12:00（210）退房；1202 是同一门位的续住房（客人已出门）。
    const world = controlledWorld({
      1201: departure({ availableFrom: 210, lateCheckout: true }),
      1202: stayover(),
    });
    let state = initial(world);
    expect(progress(state, 1201).knownAvailableFrom).toBeNull();
    // 先做 1202：1 到门口，16 做完。在门位 1 等到 215（已过 12:00）：站在门口也不会知道已经退房。
    state = play(world, state, act.service(1202));
    state = waitUntil(world, state, 215);
    expect(progress(state, 1201)).toStrictEqual(freshProgress(1201));
    expectIllegal(world, state, act.service(1201));
    // 215 打电话，挂断 217 >= 210，标为已退，之后可以打扫。
    state = play(world, state, act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [1201], newlyLifted: [] });
    expect(progress(state, 1201)).toStrictEqual({ ...freshProgress(1201), flaggedDeparted: true });
    expectLegal(world, state, act.service(1201));
  });
});
