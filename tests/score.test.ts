/**
 * score 的单元测试：等效下班时间、未完成、请勿打扰房按真相算、收工时刻、贵宾和催房的时限、违规，
 * 以及只给结束的班次计分。
 *
 * 标准档的数值：退房房 30 分钟（灾难 48），续住房和请勿打扰房 15 分钟；休息 30 分钟，还车 5 分钟，打电话 2 分钟。
 * 罚时：贵宾房超时每间 30 分钟，催房超时每间 20 分钟，未完成每间 45 分钟。17:00 是 510。
 * 服务间是 12 楼门位 0；从 12 楼门位 d 走回去 d 分钟，从 13 楼门位 d 走回去 d + 4 分钟。
 * 受控世界里没写到的房间都是整班不摘牌的请勿打扰房：不算未完成，也不挡收工。
 * 结束时的状态一律由 initial 加一串合法动作推出来；只有阶段 0 走不到的情形（催房时限、违规、判负、坏掉的状态）
 * 才在结束时的状态上直接改。
 */

import { describe, expect, it } from 'vitest';
import { score as scoreFromIndex } from '../src/engine';
import { generate } from '../src/engine/generate';
import { PARAMS, type Params } from '../src/engine/params';
import { initial } from '../src/engine/rules';
import { score } from '../src/engine/score';
import type { LogEntry, Minute, RoomId, State, World } from '../src/engine/types';
import { act, errorOf, last, play, progress, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { at } from './helpers/play';
import { controlledWorld, departure, dnd, stayover, type RoomSetup } from './helpers/world';

/** 三项罚时都是 0。 */
const NO_PENALTIES = { vipLate: 0, rushLate: 0, unfinished: 0 };

/** 退房房 1201、1203 各自写明的字段，没写的取 departure() 的默认值。 */
type TwoDepartures = Record<1201 | 1203, Partial<Omit<RoomSetup, 'kind'>>>;

/**
 * 阶段 0 没有事件，催房时限恒为 null。把催房时限直接写进结束时的状态，当作阶段 2 前台催房以后的样子。
 * 其余字段不变，没写到的房间还是原来的对象。房号写错（状态里没有这间房）就抛错，免得断言悄悄落空。
 */
function withRush(state: State, deadlines: Record<RoomId, Minute>): State {
  const ids = new Set(state.rooms.map((room) => room.id));
  for (const key of Object.keys(deadlines)) {
    if (!ids.has(Number(key))) throw new Error(`withRush：状态里没有房间 ${key}`);
  }
  return {
    ...state,
    rooms: state.rooms.map((room) => {
      const deadline = deadlines[room.id];
      return deadline === undefined ? room : { ...room, rushDeadline: deadline };
    }),
  };
}

/**
 * 两间退房房 1201、1203（开工前已退），各自的设置由调用方给。开工打电话标记两间，120 在服务间休息到 150，
 * 等到 239 出发：1201 走 1 分钟，240 到门口，270 做完；1203 走 1 分钟，271 到门口，301 做完；
 * 收工走 2 分钟回服务间，303 到，还车 5 分钟，308 结束。
 */
function twoDeparturesReturned(rooms: TwoDepartures): { world: World; state: State } {
  const world = controlledWorld({ 1201: departure(rooms[1201]), 1203: departure(rooms[1203]) });
  let state = play(world, initial(world), act.call());
  state = play(world, waitUntil(world, state, 120), act.break());
  state = play(world, waitUntil(world, state, 239), act.service(1201), act.service(1203), act.finish());
  expect(progress(state, 1201).doneAt).toBe(270);
  expect(progress(state, 1203).doneAt).toBe(301);
  expect(state.ended).toBe('returned');
  expect(state.minute).toBe(308);
  return { world, state };
}

/**
 * 两间退房房 1201（灾难级，48 分钟）、1203，各自的其余设置由调用方给。开工打电话标记两间，120 在服务间休息到 150，
 * 等到 500 出发去 1201：501 到门口，做到 510 截断，做了 9 分钟；17:00 起只能还车，走 1 分钟回服务间，
 * 511 到，还车 5 分钟，516 结束。两间都没做完。
 */
function twoDeparturesHardStop(rooms: TwoDepartures): { world: World; state: State } {
  const world = controlledWorld({ 1201: departure({ mess: 'disaster', ...rooms[1201] }), 1203: departure(rooms[1203]) });
  let state = play(world, initial(world), act.call());
  state = play(world, waitUntil(world, state, 120), act.break());
  state = play(world, waitUntil(world, state, 500), act.service(1201));
  expect(last(state).outcome).toEqual({ type: 'interrupted', room: 1201, workDone: 9, reason: 'hardStop' });
  state = play(world, state, act.finish());
  expect(state.ended).toBe('hardStop');
  expect(state.minute).toBe(516);
  return { world, state };
}

describe('等效下班时间', () => {
  it('自己收工、没有罚时：成绩就是还车完成的时刻；步行分钟是各条日志的 walk 之和', () => {
    const world = controlledWorld({ 1201: stayover(), 1307: stayover() });
    // 1201：走 1 分钟，1 到门口，16 做完。1307：从 {12, 1} 走 1 + 4 + 电梯 4 = 9 分钟，25 到门口，40 做完。
    let state = play(world, initial(world), act.service(1201), act.service(1307));
    expect(state.minute).toBe(40);
    // 在 1307 门口等到 112，走 8 分钟回服务间，120 开始休息，150 休息完；收工不用走路，还车 5 分钟，155 结束。
    state = play(world, waitUntil(world, state, 112), act.break(), act.finish());
    expect(state.ended).toBe('returned');
    expect(last(state)).toMatchObject({ start: 150, end: 155, walk: 0 });
    expect(score(world, state)).toStrictEqual({
      finishMinute: 155,
      penalties: NO_PENALTIES,
      equivalentFinish: 155,
      roomsDone: 2,
      // 1 + 9 + 8 + 0；等待和收工都没有走路。
      walkedMinutes: 18,
      violation: false,
      failed: false,
    });
    // 每次都是新对象，没有罚时的时候也不共用同一个 penalties。
    const again = score(world, state);
    expect(again).not.toBe(score(world, state));
    expect(again.penalties).not.toBe(score(world, state).penalties);
  });

  it('强制下班：被 17:00 截断的房间、一直没去的退房房和续住房各算一间未完成；成绩从还完车的时刻算起', () => {
    // 1201 是灾难级退房房（48 分钟），1203 续住，1205 退房。开工打电话标记 1201 和 1205，120 在服务间休息到 150。
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }), 1203: stayover(), 1205: departure() });
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, 120), act.break());
    // 等到 500 出发去 1201：501 到门口，开门，做到 510 截断，做了 9 分钟。
    state = play(world, waitUntil(world, state, 500), act.service(1201));
    expect(last(state).outcome).toEqual({ type: 'interrupted', room: 1201, workDone: 9, reason: 'hardStop' });
    // 17:00 起只能还车：走 1 分钟回服务间，511 到，还车 5 分钟，516 结束。
    state = play(world, state, act.finish());
    expect(state.ended).toBe('hardStop');
    expect(score(world, state)).toStrictEqual({
      finishMinute: 516,
      penalties: { vipLate: 0, rushLate: 0, unfinished: 3 * 45 },
      equivalentFinish: 516 + 3 * 45,
      roomsDone: 0,
      walkedMinutes: 2,
      violation: false,
      failed: false,
    });
  });

  it('恰好 17:00 做完的算做完，不算未完成', () => {
    // 120 在服务间休息到 150，等到 494 出发去 1201：495 到门口，510 做完。走 1 分钟回服务间，还车 5 分钟，516 结束。
    const world = controlledWorld({ 1201: stayover() });
    let state = play(world, waitUntil(world, initial(world), 120), act.break());
    state = play(world, waitUntil(world, state, 494), act.service(1201), act.finish());
    expect(progress(state, 1201).doneAt).toBe(510);
    expect(state.ended).toBe('hardStop');
    expect(score(world, state)).toStrictEqual({
      finishMinute: 516,
      penalties: NO_PENALTIES,
      equivalentFinish: 516,
      roomsDone: 1,
      walkedMinutes: 2,
      violation: false,
      failed: false,
    });
  });
});

describe('请勿打扰房按真相算', () => {
  it('收工那一刻已经摘牌、玩家却不知道，也算未完成；恰好在收工那一刻摘牌的也算；收工以后才摘的不算', () => {
    // 1207 在 200 摘牌。1201 在 16 做完，在门位 1 等到 119，走回服务间，120 到 150 休息，然后在服务间等。
    // 一直没有走到 1207 所在的门位 4，也没有打电话，玩家始终不知道它摘牌。
    const world = controlledWorld({ 1201: stayover(), 1207: dnd({ dndLiftsAt: 200 }) });
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break());
    state = waitUntil(world, state, 199);

    // 199 收工：1207 在收工以后才摘牌，不算。还车 5 分钟，204 结束。
    const early = play(world, state, act.finish());
    expect(early.ended).toBe('returned');
    expect(progress(early, 1207).dndLiftKnown).toBe(false);
    expect(score(world, early)).toMatchObject({ finishMinute: 204, penalties: NO_PENALTIES, equivalentFinish: 204 });

    // 等到 200 再收工：恰好在收工那一刻摘牌，玩家不知道也算未完成。205 结束，加 45 分钟。
    const late = play(world, state, act.wait(1), act.finish());
    expect(late.ended).toBe('returned');
    expect(progress(late, 1207).dndLiftKnown).toBe(false);
    expect(score(world, late)).toStrictEqual({
      finishMinute: 205,
      penalties: { vipLate: 0, rushLate: 0, unfinished: 45 },
      equivalentFinish: 250,
      roomsDone: 1,
      walkedMinutes: 2,
      violation: false,
      failed: false,
    });
  });

  it('摘牌不等于客人已出门：摘了牌、客人还在房里的请勿打扰房，也按摘牌时刻算未完成', () => {
    // 1207 在 150 摘牌，客人 250 才出门：玩家就算得知摘牌，收工前去也会被拒。
    // 路线和上一条相同：1201 在 16 做完，在门位 1 等到 119，走回服务间休息到 150，在服务间等到 200 收工，205 结束。
    const world = controlledWorld({ 1201: stayover(), 1207: dnd({ dndLiftsAt: 150, availableFrom: 250 }) });
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break());
    state = play(world, waitUntil(world, state, 200), act.finish());
    expect(state.ended).toBe('returned');
    expect(score(world, state)).toMatchObject({
      finishMinute: 205,
      penalties: { vipLate: 0, rushLate: 0, unfinished: 45 },
      equivalentFinish: 250,
    });
  });

  it('收工时刻是选择收工的那一刻：收工以前摘牌、还车路上才看到的照样算；收工以后才摘、还车路上看到的不算', () => {
    // 1203 在门位 2，摘牌时刻由参数给；1207 续住，在门位 4。120 在服务间休息到 150。
    // 去 1207：151 过门位 1，152 过门位 2（还没摘牌，看不到），154 到门口，169 做完。
    // 169 收工：169 在门位 4，170 过门位 3，171 过门位 2（这时看到 1203 已摘牌），172 过门位 1，173 到服务间，还车到 178。
    const run = (liftsAt: Minute): { world: World; state: State } => {
      const world = controlledWorld({ 1203: dnd({ dndLiftsAt: liftsAt }), 1207: stayover() });
      let state = play(world, waitUntil(world, initial(world), 120), act.break(), act.service(1207));
      expect(state.minute).toBe(169);
      expect(progress(state, 1203).dndLiftKnown).toBe(false);
      state = play(world, state, act.finish());
      expect(last(state)).toMatchObject({ start: 169, end: 178, walk: 4, noticedLifted: [1203] });
      return { world, state };
    };

    // 160 摘牌：早于 169 收工，算未完成。
    const before = run(160);
    expect(score(before.world, before.state)).toStrictEqual({
      finishMinute: 178,
      penalties: { vipLate: 0, rushLate: 0, unfinished: 45 },
      equivalentFinish: 223,
      roomsDone: 1,
      walkedMinutes: 8,
      violation: false,
      failed: false,
    });

    // 170 摘牌：晚于 169 收工，不算，虽然还车路上看到了。
    const after = run(170);
    expect(score(after.world, after.state)).toMatchObject({ penalties: NO_PENALTIES, equivalentFinish: 178 });
  });

  it('得知摘牌、做完了的请勿打扰房不算未完成，也计入做完的房间数', () => {
    // 1203 在 150 摘牌。1201 在 16 做完，在门位 1 等到 119，走回服务间休息到 150；打电话（150 到 152）得知 1203 摘牌。
    // 去 1203：走 2 分钟，154 到门口，169 做完；收工走 2 分钟回服务间，171 到，还车到 176。
    const world = controlledWorld({ 1201: stayover(), 1203: dnd({ dndLiftsAt: 150 }) });
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break(), act.call(), act.service(1203), act.finish());
    expect(progress(state, 1203).doneAt).toBe(169);
    expect(score(world, state)).toStrictEqual({
      finishMinute: 176,
      penalties: NO_PENALTIES,
      equivalentFinish: 176,
      roomsDone: 2,
      // 1 + 1 + 0 + 2 + 2：去 1201、回服务间休息、打电话、去 1203、收工。
      walkedMinutes: 6,
      violation: false,
      failed: false,
    });
  });

  it('强制下班时收工时刻是 17:00：已知摘牌没做的、不知道已摘牌的、17:00 整摘牌的都算；17:00 以后才摘的和整班不摘的不算', () => {
    // 1203 在 150、1205 在 300、1206 在 510、1207 在 511 摘牌，1208 整班不摘。
    // 1201 在 16 做完，在门位 1 等到 119，走回服务间休息到 150；打电话（150 到 152）只得知 1203 摘牌，不去做。
    // 然后在服务间（门位 0，没有房间）等到 510，只能还车，515 结束。
    const world = controlledWorld({
      1201: stayover(),
      1203: dnd({ dndLiftsAt: 150 }),
      1205: dnd({ dndLiftsAt: 300 }),
      1206: dnd({ dndLiftsAt: 510 }),
      1207: dnd({ dndLiftsAt: 511 }),
      1208: dnd(),
    });
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 119), act.break(), act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [], newlyLifted: [1203] });
    state = play(world, waitUntil(world, state, 510), act.finish());
    expect(state.ended).toBe('hardStop');
    expect([1203, 1205, 1206, 1207].map((room) => progress(state, room).dndLiftKnown)).toEqual([true, false, false, false]);
    // 算未完成的是 1203、1205、1206。
    expect(score(world, state)).toStrictEqual({
      finishMinute: 515,
      penalties: { vipLate: 0, rushLate: 0, unfinished: 3 * 45 },
      equivalentFinish: 515 + 3 * 45,
      roomsDone: 1,
      walkedMinutes: 2,
      violation: false,
      failed: false,
    });
  });

  it('强制下班时，还车在 17:00 以后才开始，收工时刻仍是 17:00（自定义参数让休息跨过 17:00）', () => {
    // 按现有参数，强制下班的还车总是在 17:00 整开始，分不出"17:00"和"最后一条日志的 start"。
    // 所以把休息窗口的上界改到 16:50（500），让 16:49 开始的休息跨过 17:00。
    const params: Params = { ...PARAMS.standard, shift: { ...PARAMS.standard.shift, breakLatest: 500 } };
    // 1203 在 510、1205 在 511 摘牌，玩家一直不知道。
    const world = controlledWorld(
      { 1201: stayover(), 1203: dnd({ dndLiftsAt: 510 }), 1205: dnd({ dndLiftsAt: 511 }) },
      { params },
    );
    // 1201 在 16 做完，在门位 1 等到 499；走 1 分钟回服务间，500 开始休息，530 结束；17:00 已过，只能还车，535 结束。
    let state = play(world, initial(world), act.service(1201));
    state = play(world, waitUntil(world, state, 499), act.break(), act.finish());
    expect(state.ended).toBe('hardStop');
    expect(last(state)).toMatchObject({ start: 530, end: 535 });
    // 收工时刻是 510，不是 530：1203 算未完成，1205 不算。
    expect(score(world, state)).toStrictEqual({
      finishMinute: 535,
      penalties: { vipLate: 0, rushLate: 0, unfinished: 45 },
      equivalentFinish: 580,
      roomsDone: 1,
      walkedMinutes: 2,
      violation: false,
      failed: false,
    });
  });
});

describe('贵宾时限', () => {
  it('恰好在时限做完算按时；晚 1 分钟做完罚 30 分钟', () => {
    // 1201 在 270 做完，时限 270；1203 在 301 做完，时限 300。
    const { world, state } = twoDeparturesReturned({ 1201: { vipDeadline: 270 }, 1203: { vipDeadline: 300 } });
    expect(score(world, state)).toStrictEqual({
      finishMinute: 308,
      penalties: { vipLate: 30, rushLate: 0, unfinished: 0 },
      equivalentFinish: 338,
      roomsDone: 2,
      // 1 + 1 + 2：去 1201、去 1203、收工；打电话、等待和在服务间休息都没有走路。
      walkedMinutes: 4,
      violation: false,
      failed: false,
    });
  });

  it('没做完的贵宾房既算超时又算未完成，每间 30 + 45 = 75 分钟；被 17:00 截断的也一样', () => {
    // 1201（时限 270）被 17:00 截断，1203（时限 330）一直没去。
    const { world, state } = twoDeparturesHardStop({ 1201: { vipDeadline: 270 }, 1203: { vipDeadline: 330 } });
    expect(score(world, state)).toStrictEqual({
      finishMinute: 516,
      penalties: { vipLate: 2 * 30, rushLate: 0, unfinished: 2 * 45 },
      equivalentFinish: 516 + 2 * 75,
      roomsDone: 0,
      walkedMinutes: 2,
      violation: false,
      failed: false,
    });
  });
});

describe('前台催房的时限（阶段 0 没有事件，直接写进结束时的状态）', () => {
  it('恰好在时限做完不罚；晚于时限做完罚 20 分钟', () => {
    // 1201 在 270 做完，催房时限 270；1203 在 301 做完，催房时限 300。
    const { world, state } = twoDeparturesReturned({ 1201: {}, 1203: {} });
    expect(score(world, withRush(state, { 1201: 270, 1203: 300 }))).toStrictEqual({
      finishMinute: 308,
      penalties: { vipLate: 0, rushLate: 20, unfinished: 0 },
      equivalentFinish: 328,
      roomsDone: 2,
      walkedMinutes: 4,
      violation: false,
      failed: false,
    });
  });

  it('没做完的催房房间既算超时又算未完成，每间 20 + 45 = 65 分钟', () => {
    const { world, state } = twoDeparturesHardStop({ 1201: {}, 1203: {} });
    expect(score(world, withRush(state, { 1201: 400, 1203: 400 }))).toMatchObject({
      penalties: { vipLate: 0, rushLate: 2 * 20, unfinished: 2 * 45 },
      equivalentFinish: 516 + 2 * 65,
    });
  });

  it('一间房既是贵宾房又被催房时，两个时限各算各的', () => {
    // 1203 在 301 做完：贵宾时限 300 超时，催房时限 290 也超时；1201 在 270 做完，贵宾时限 270 按时，没被催房。
    const { world, state } = twoDeparturesReturned({ 1201: { vipDeadline: 270 }, 1203: { vipDeadline: 300 } });
    expect(score(world, withRush(state, { 1203: 290 }))).toMatchObject({
      penalties: { vipLate: 30, rushLate: 20, unfinished: 0 },
      equivalentFinish: 308 + 30 + 20,
    });
    // 催房时限 310 按时，只剩贵宾超时。
    expect(score(world, withRush(state, { 1203: 310 }))).toMatchObject({
      penalties: { vipLate: 30, rushLate: 0, unfinished: 0 },
      equivalentFinish: 338,
    });
  });
});

describe('违规', () => {
  it('照抄状态里的 violation（阶段 0 恒为 false，这里直接改结束时的状态）；违规不加罚时', () => {
    const { world, state } = twoDeparturesReturned({ 1201: {}, 1203: {} });
    expect(score(world, state).violation).toBe(false);
    const result = score(world, { ...state, violation: true });
    expect(result).toStrictEqual({ ...score(world, state), violation: true });
    expect(result.equivalentFinish).toBe(308);
  });
});

describe('只给结束的班次计分', () => {
  it('班次还没结束时抛错：开工时、班次中途、到了 17:00 还没还车', () => {
    const world = controlledWorld({ 1201: stayover() });
    const start = initial(world);
    const midway = play(world, start, act.service(1201));
    const atHardStop = waitUntil(world, play(world, waitUntil(world, midway, 119), act.break()), 510);
    for (const state of [start, midway, atHardStop]) {
      expect(state.ended).toBeNull();
      expect(errorOf(() => score(world, state)), `${state.minute} 分钟`).toMatch(/还没结束/);
    }
  });

  it('state 和 world 的房间对不上时抛错：数量不同、顺序不同，或者整套房号都不同；对得上时不抛错', () => {
    const { world, state } = twoDeparturesReturned({ 1201: {}, 1203: {} });
    // 下标 5、6 是 1206 和 1207：对调以后房间数、第一间和最后一间都不变，只有中间两间不同。
    const swapped = world.rooms.map((room, index) => (index === 5 ? at(world.rooms, 6) : index === 6 ? at(world.rooms, 5) : room));
    const cases: [string, World, State][] = [
      // 只有比较房间数才看得出来：前 14 间逐个相同。
      ['世界少了最后一间', { ...world, rooms: world.rooms.slice(0, -1) }, state],
      ['状态少了最后一间', world, { ...state, rooms: state.rooms.slice(0, -1) }],
      ['状态多了一间', world, { ...state, rooms: [...state.rooms, { ...progress(state, 1307), id: 1309 }] }],
      ['世界的房间倒过来', { ...world, rooms: [...world.rooms].reverse() }, state],
      ['世界中间两间对调', { ...world, rooms: swapped }, state],
      // ODD_PARAMS 有 16 间房，房号从 301 开始。
      ['换了一套楼层', generate('other', ODD_PARAMS), state],
    ];
    for (const [label, otherWorld, otherState] of cases) {
      expect(errorOf(() => score(otherWorld, otherState)), label).toMatch(/对不上/);
    }
    expect(() => score(world, state)).not.toThrow();
  });

  it('判负的班次抛错：阶段 0 没有判负，怎么计分到阶段 2 再定', () => {
    const { world, state } = twoDeparturesReturned({ 1201: {}, 1203: {} });
    // 阶段 2 的判负是回应事件以后班次立即结束，最后一条日志不是收工还车。报错要说判负，而不是说日志不对。
    expect(errorOf(() => score(world, { ...state, ended: 'failed', log: state.log.slice(0, -1) }))).toMatch(/判负/);
    // 最后一条还是收工还车，也一样。
    expect(errorOf(() => score(world, { ...state, ended: 'failed' }))).toMatch(/判负/);
  });

  it('班次已经结束、最后一条日志却不是收工还车时抛错：动作和结果有一样不是收工还车就算', () => {
    const { world, state } = twoDeparturesReturned({ 1201: {}, 1203: {} });
    // 去掉收工还车那一条，最后一条变成打扫 1203；或者日志是空的。
    expect(errorOf(() => score(world, { ...state, log: state.log.slice(0, -1) }))).toMatch(/收工还车/);
    expect(errorOf(() => score(world, { ...state, log: [] }))).toMatch(/收工还车/);
    // 最后一条的动作是收工、结果却是等待，或者反过来。
    const finish = last(state);
    const endingWith = (entry: LogEntry): State => ({ ...state, log: [...state.log.slice(0, -1), entry] });
    const halfWrong: LogEntry[] = [
      { ...finish, outcome: { type: 'waited', minutes: 5 } },
      { ...finish, action: { type: 'wait', minutes: 5 } },
    ];
    for (const entry of halfWrong) {
      expect(errorOf(() => score(world, endingWith(entry))), JSON.stringify(entry)).toMatch(/收工还车/);
    }
  });
});

describe('数值从 world.params 读', () => {
  it('ODD_PARAMS，强制下班：罚时是每间贵宾超时 35、催房超时 25、未完成 50 分钟，收工时刻是它的 17:00（480）', () => {
    // ODD_PARAMS：服务间是 5 楼门位 0，每个门位 2 分钟；退房房 40 分钟（灾难 60）；打电话 3 分钟，休息 20 分钟，
    // 还车 7 分钟；到达服务间不早于 100 才能休息；17:00 是 480。
    // 501（门位 1）是灾难级贵宾退房房，时限 250；503 是退房房；505、507、509 是请勿打扰房，分别在 200、480、481 摘牌。
    const world = controlledWorld(
      {
        501: departure({ mess: 'disaster', vipDeadline: 250 }),
        503: departure(),
        505: dnd({ dndLiftsAt: 200 }),
        507: dnd({ dndLiftsAt: 480 }),
        509: dnd({ dndLiftsAt: 481 }),
      },
      { params: ODD_PARAMS },
    );
    // 开工打电话（0 到 3）标记 501 和 503；在服务间等到 100 休息，120 休息完；等到 470 出发去 501：
    // 走 2 分钟，472 到门口，开门，做到 480 截断；走 2 分钟回服务间，482 到，还车 7 分钟，489 结束。
    let state = play(world, initial(world), act.call());
    expect(last(state).outcome).toEqual({ type: 'called', newlyDeparted: [501, 503], newlyLifted: [] });
    state = play(world, waitUntil(world, state, 100), act.break());
    state = play(world, waitUntil(world, state, 470), act.service(501));
    expect(last(state).outcome).toEqual({ type: 'interrupted', room: 501, workDone: 8, reason: 'hardStop' });
    state = play(world, state, act.finish());
    expect(state.ended).toBe('hardStop');
    expect(state.minute).toBe(489);
    // 503 再加一个催房时限 300。
    // 未完成：501、503，以及 200 和 480 摘牌的 505、507，共 4 间；481 摘牌的 509 不算（按标准档的 510 就会算）。
    // 贵宾超时：501。催房超时：503。
    expect(score(world, withRush(state, { 503: 300 }))).toStrictEqual({
      finishMinute: 489,
      penalties: { vipLate: 35, rushLate: 25, unfinished: 4 * 50 },
      equivalentFinish: 489 + 35 + 25 + 4 * 50,
      roomsDone: 0,
      walkedMinutes: 4,
      violation: false,
      failed: false,
    });
  });

  it('ODD_PARAMS，自己收工：罚时同样从 world.params 读，收工时刻是选择收工的那一刻', () => {
    // 随机挑法在 ODD_PARAMS 下从不自己收工（活太多，见 tests/helpers.test.ts），这里用受控世界走一遍。
    // 501 续住（25 分钟）；503 是贵宾退房房（50 分钟），时限 40；507、509 是请勿打扰房，分别在 205、150 摘牌。
    const world = controlledWorld(
      {
        501: stayover(),
        503: departure({ vipDeadline: 40 }),
        507: dnd({ dndLiftsAt: 205 }),
        509: dnd({ dndLiftsAt: 150 }),
      },
      { params: ODD_PARAMS },
    );
    // 打电话（0 到 3）标记 503。501：走 2 分钟，5 到门口，30 做完；503：走 2 分钟，32 到门口，82 做完（晚于 40）。
    // 在 503 门口等到 96，走 4 分钟回服务间，100 开始休息，120 休息完；在服务间等到 200 收工，还车 7 分钟，207 结束。
    // 一直没有走到门位 4、5，也没在 150 以后打电话，玩家不知道 507、509 摘牌。
    let state = play(world, initial(world), act.call(), act.service(501), act.service(503));
    expect(progress(state, 503).doneAt).toBe(82);
    state = play(world, waitUntil(world, state, 96), act.break());
    state = play(world, waitUntil(world, state, 200), act.finish());
    expect(state.ended).toBe('returned');
    expect(last(state)).toMatchObject({ start: 200, end: 207 });
    // 未完成只有 150 摘牌的 509；507 在 205 摘牌，晚于 200 收工，不算（按还完车的 207 就会算）。
    expect(score(world, state)).toStrictEqual({
      finishMinute: 207,
      penalties: { vipLate: 35, rushLate: 0, unfinished: 50 },
      equivalentFinish: 207 + 35 + 50,
      roomsDone: 2,
      // 2 + 2 + 4 + 0：去 501、去 503、回服务间休息、收工。
      walkedMinutes: 8,
      violation: false,
      failed: false,
    });
  });
});

describe('对外入口', () => {
  it('能从 src/engine/index.ts 导入 score', () => {
    expect(scoreFromIndex).toBe(score);
  });
});
