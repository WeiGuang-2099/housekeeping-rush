/**
 * 界面推出的房间状态、已知信息、任务单顺序和平面图说明（src/ui/rooms.ts）的单元测试。
 *
 * 受控世界里没写到的房间都是整班不摘牌的请勿打扰房（tests/helpers/world.ts）。起始状态一律由 initial 加一串合法动作
 * 推出来，再 observe 成 View，界面只拿 View 和 params。标准档的几何：12 楼 1201 到 1208 在门位 1 到 4
 * （每两间一个门位，前一间在上排），13 楼 1301 到 1307 在门位 1 到 4；服务间是 12 楼门位 0。同层每个门位 1 分钟。
 * 退房房普通 30 分钟、灾难 48 分钟，续住房普通 15 分钟；打电话 2 分钟，敲门被拒 1 分钟。
 */

import { describe, expect, it } from 'vitest';
import { cleanMinutes, initial, observe, PARAMS, recall, type RoomId, type State, type View, type World } from '../src/engine';
import {
  roomFacts,
  roomInfos,
  roomStatus,
  roomTag,
  taskGroup,
  taskSheetOrder,
  type RoomFact,
  type RoomInfo,
} from '../src/ui/rooms';
import { act, errorOf, play, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze } from './helpers/play';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

/** 这一刻的 View。 */
function viewAt(world: World, state: State): View {
  return observe(world, state);
}

/** 这一刻某间房的状态和已知信息，和界面一样从 View 推。 */
function infoAt(world: World, state: State, id: RoomId): RoomInfo {
  const view = viewAt(world, state);
  const info = roomInfos(view, world.params, recall(view, world.params)).find((candidate) => candidate.room.id === id);
  if (info === undefined) throw new Error(`View 里没有房间 ${id}`);
  return info;
}

function factsAt(world: World, state: State, id: RoomId): readonly RoomFact[] {
  return infoAt(world, state, id).facts;
}

/** View 里某间房客人告知的回来时间；没有就让测试失败。 */
function comeBackOf(world: World, state: State, id: RoomId): number {
  const room = viewAt(world, state).rooms.find((candidate) => candidate.id === id);
  if (room === undefined || room.knownAvailableFrom === null) throw new Error(`房间 ${id} 没有回来时间`);
  return room.knownAvailableFrom;
}

/** 任务单的房号顺序。 */
function sheetOrder(view: View, world: World): RoomId[] {
  return taskSheetOrder(roomInfos(view, world.params, recall(view, world.params))).map((info) => info.room.id);
}

describe('状态', () => {
  it('开工时：退房房还没报已退、请勿打扰房还不知道摘牌的是 locked，续住房看起来能进是 open', () => {
    const world = controlledWorld({ 1201: departure(), 1203: stayover(), 1205: dnd() });
    const start = initial(world);
    expect(infoAt(world, start, 1201).status).toBe('locked');
    expect(infoAt(world, start, 1203).status).toBe('open');
    expect(infoAt(world, start, 1205).status).toBe('locked');
  });

  it('退房房打电话报了已退就 open，做完是 done', () => {
    const world = controlledWorld({ 1201: departure() });
    const called = play(world, initial(world), act.call());
    expect(infoAt(world, called, 1201).status).toBe('open');
    const cleaned = play(world, called, act.service(1201));
    expect(infoAt(world, cleaned, 1201).status).toBe('done');
  });

  it('请勿打扰房得知摘牌以后 open', () => {
    const world = controlledWorld({ 1205: dnd({ dndLiftsAt: 50 }) });
    const before = play(world, initial(world), act.call());
    expect(infoAt(world, before, 1205).status).toBe('locked');
    const after = play(world, waitUntil(world, before, 50), act.call());
    expect(infoAt(world, after, 1205).status).toBe('open');
  });

  it('客人说了回来时间：到那一刻之前是 later，到了那一刻是 open；之后做完是 done', () => {
    const world = controlledWorld({ 1203: stayover({ availableFrom: 100 }) });
    const refused = play(world, initial(world), act.service(1203));
    const comeBack = comeBackOf(world, refused, 1203);
    expect(comeBack).toBeGreaterThan(refused.minute);
    expect(infoAt(world, refused, 1203).status).toBe('later');
    expect(infoAt(world, waitUntil(world, refused, comeBack - 1), 1203).status).toBe('later');
    const reached = waitUntil(world, refused, comeBack);
    expect(infoAt(world, reached, 1203).status).toBe('open');
    expect(infoAt(world, play(world, reached, act.service(1203)), 1203).status).toBe('done');
  });

  it('roomStatus 只看这间房和现在的时刻：同一间房换个时刻，later 变 open', () => {
    const world = controlledWorld({ 1203: stayover({ availableFrom: 100 }) });
    const refused = play(world, initial(world), act.service(1203));
    const room = infoAt(world, refused, 1203).room;
    const comeBack = comeBackOf(world, refused, 1203);
    expect(roomStatus(room, comeBack - 1)).toBe('later');
    expect(roomStatus(room, comeBack)).toBe('open');
  });
});

describe('已知信息', () => {
  it('贵宾退房房：开工时是时限和还没报已退；报了已退写已退房；做完写完成时刻、脏乱和分钟数', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 270 }) });
    const start = initial(world);
    expect(factsAt(world, start, 1202)).toEqual([{ code: 'vip', deadline: 270, overdue: false }, { code: 'notDeparted' }]);
    const called = play(world, start, act.call());
    expect(factsAt(world, called, 1202)).toEqual([{ code: 'vip', deadline: 270, overdue: false }, { code: 'departed' }]);
    // 打完电话 2 分钟，走到 1202（门位 1）1 分钟，普通退房房 30 分钟。
    const cleaned = play(world, called, act.service(1202));
    expect(factsAt(world, cleaned, 1202)).toEqual([
      { code: 'vip', deadline: 270, overdue: false },
      { code: 'done', at: 33 },
      { code: 'mess', level: 'normal', minutes: 30 },
    ]);
  });

  it('超时：没做完的到了时限就算赶不上，差一分钟还不算；做完的看完成时刻，恰好在时限做完不算超时', () => {
    const late = controlledWorld({ 1202: departure({ vipDeadline: 40 }) });
    const vip = (world: World, state: State): RoomFact | undefined => factsAt(world, state, 1202)[0];
    expect(vip(late, waitUntil(late, initial(late), 39))).toEqual({ code: 'vip', deadline: 40, overdue: false });
    const atDeadline = waitUntil(late, initial(late), 40);
    expect(vip(late, atDeadline)).toEqual({ code: 'vip', deadline: 40, overdue: true });
    expect(vip(late, play(late, atDeadline, act.call(), act.service(1202)))).toEqual({
      code: 'vip',
      deadline: 40,
      overdue: true,
    });
    // 打电话到 2，走到 1202 到 3，做到 33：恰好在时限 33 做完。
    const exact = controlledWorld({ 1202: departure({ vipDeadline: 33 }) });
    const done = play(exact, initial(exact), act.call(), act.service(1202));
    expect(vip(exact, done)).toEqual({ code: 'vip', deadline: 33, overdue: false });
  });

  it('延迟退房写在时限之后、进度之前', () => {
    const world = controlledWorld({ 1204: departure({ lateCheckout: true, availableFrom: 210, vipDeadline: null }) });
    expect(factsAt(world, initial(world), 1204)).toEqual([{ code: 'lateCheckout' }, { code: 'notDeparted' }]);
  });

  it('续住房：没敲过门；敲门被拒写回来时间；做完写完成时刻和脏乱', () => {
    const world = controlledWorld({ 1203: stayover({ availableFrom: 100, mess: 'disaster' }) });
    const start = initial(world);
    expect(factsAt(world, start, 1203)).toEqual([{ code: 'notKnocked' }]);
    const refused = play(world, start, act.service(1203));
    const comeBack = comeBackOf(world, refused, 1203);
    expect(factsAt(world, refused, 1203)).toEqual([{ code: 'comeBack', at: comeBack }]);
    const done = play(world, waitUntil(world, refused, comeBack), act.service(1203));
    expect(factsAt(world, done, 1203)).toEqual([
      { code: 'done', at: comeBack + 24 },
      { code: 'mess', level: 'disaster', minutes: 24 },
    ]);
  });

  it('还不知道摘牌的请勿打扰房：开工时还没确认过；路过它的门位记下那一分钟；打电话以后是挂断的时刻', () => {
    const world = controlledWorld({ 1205: dnd(), 1207: stayover() });
    const start = initial(world);
    expect(factsAt(world, start, 1205)).toEqual([{ code: 'stillHung', confirmedAt: null }]);
    // 去 1207（门位 4）的路上第 3 分钟经过 1205 的门位 3，打扫完停在门位 4。
    const passed = play(world, start, act.service(1207));
    expect(factsAt(world, passed, 1205)).toEqual([{ code: 'stillHung', confirmedAt: 3 }]);
    const called = play(world, passed, act.call());
    expect(factsAt(world, called, 1205)).toEqual([{ code: 'stillHung', confirmedAt: called.minute }]);
  });

  it('已知摘牌的请勿打扰房：已摘牌，再像续住房一样写没敲过门或回来时间', () => {
    const world = controlledWorld({ 1205: dnd({ dndLiftsAt: 50, availableFrom: 200 }) });
    const lifted = play(world, waitUntil(world, initial(world), 50), act.call());
    expect(factsAt(world, lifted, 1205)).toEqual([{ code: 'lifted' }, { code: 'notKnocked' }]);
    const refused = play(world, lifted, act.service(1205));
    expect(factsAt(world, refused, 1205)).toEqual([
      { code: 'lifted' },
      { code: 'comeBack', at: comeBackOf(world, refused, 1205) },
    ]);
  });

  it('做到一半被 17:00 截断：写已退房、脏乱和总分钟数，再写已做的分钟数', () => {
    const world = controlledWorld({ 1201: departure({ mess: 'disaster' }) });
    const params = world.params;
    let state = play(world, initial(world), act.call());
    state = play(world, waitUntil(world, state, params.shift.breakEarliest), act.break());
    // 走到 1201 要 1 分钟，471 到达，灾难的退房房要 48 分钟，做到 510 停下，做了 39 分钟。
    state = play(world, waitUntil(world, state, params.shift.hardStop - 40), act.service(1201));
    expect(state.minute).toBe(params.shift.hardStop);
    expect(factsAt(world, state, 1201)).toEqual([
      { code: 'departed' },
      { code: 'mess', level: 'disaster', minutes: 48 },
      { code: 'workDone', minutes: 39, total: 48 },
    ]);
  });

  it('续住房做到一半被 17:00 截断：开过门，不再写还没敲过门', () => {
    const world = controlledWorld({ 1203: stayover({ mess: 'disaster' }) });
    const { shift } = world.params;
    let state = play(world, waitUntil(world, initial(world), shift.breakEarliest), act.break());
    // 走到 1203 要 2 分钟，502 到达，灾难的续住房要 24 分钟，做到 510 停下，做了 8 分钟。
    state = play(world, waitUntil(world, state, shift.hardStop - 10), act.service(1203));
    expect(state.minute).toBe(shift.hardStop);
    expect(factsAt(world, state, 1203)).toEqual([
      { code: 'mess', level: 'disaster', minutes: 24 },
      { code: 'workDone', minutes: 8, total: 24 },
    ]);
  });

  it('分钟数从参数读：ODD_PARAMS 下普通的退房房要 50 分钟（标准档 30 分钟）', () => {
    const world = controlledWorld({ 301: departure() }, { params: ODD_PARAMS });
    const done = play(world, initial(world), act.call(), act.service(301));
    const expected = cleanMinutes('departure', 'normal', ODD_PARAMS);
    expect(expected).not.toBe(cleanMinutes('departure', 'normal', PARAMS.standard));
    expect(factsAt(world, done, 301)).toContainEqual({ code: 'mess', level: 'normal', minutes: expected });
  });

  it('recall 的结果里没有还不知道摘牌的请勿打扰房时抛错：recall 和 View 对不上', () => {
    const world = controlledWorld({ 1205: dnd() });
    const view = viewAt(world, initial(world));
    const room = view.rooms.find((candidate) => candidate.id === 1205);
    if (room === undefined) throw new Error('View 里没有 1205');
    const message = errorOf(() => roomFacts(room, view.minute, world.params, { lastCallAt: null, stillHung: [] }));
    expect(message).toContain('1205');
  });
});

describe('任务单的顺序', () => {
  const world = controlledWorld({
    1201: departure(),
    1202: departure({ vipDeadline: 330 }),
    1203: stayover(),
    1204: departure({ vipDeadline: 270 }),
    1301: stayover(),
  });
  /** 没写到的房间都是还不知道摘牌的请勿打扰房，按 view.rooms 的顺序。 */
  const hungRooms = world.rooms.filter((room) => room.kind === 'dnd').map((room) => room.id);

  it('开工时：有时限的按时限排在最前，其余没做完的按 view.rooms 的顺序，再是还不知道摘牌的请勿打扰房', () => {
    const view = viewAt(world, initial(world));
    expect(sheetOrder(view, world)).toEqual([1204, 1202, 1201, 1203, 1301, ...hungRooms]);
  });

  it('做完的排到最后，按 view.rooms 的顺序：做完的贵宾房不按时限往前或往后挪', () => {
    const state = play(world, initial(world), act.call(), act.service(1203), act.service(1202));
    const view = viewAt(world, state);
    expect(sheetOrder(view, world)).toEqual([1204, 1201, 1301, ...hungRooms, 1202, 1203]);
  });

  it('催房时限也算时限，和贵宾时限一起按时间排', () => {
    const view = viewAt(world, initial(world));
    const withRush: View = {
      ...view,
      rooms: view.rooms.map((room) => (room.id === 1201 ? { ...room, rushDeadline: 300 } : room)),
    };
    expect(sheetOrder(withRush, world)).toEqual([1204, 1201, 1202, 1203, 1301, ...hungRooms]);
  });

  it('分组：做完、有时限、还不知道摘牌、其余', () => {
    const state = play(world, initial(world), act.call(), act.service(1203));
    const rooms = viewAt(world, state).rooms;
    const group = (id: RoomId): string => {
      const room = rooms.find((candidate) => candidate.id === id);
      if (room === undefined) throw new Error(`View 里没有房间 ${id}`);
      return taskGroup(room);
    };
    expect([group(1203), group(1204), group(1205), group(1201)]).toEqual(['done', 'deadline', 'hung', 'todo']);
  });

  it('返回新数组，不修改传入的数组', () => {
    const view = viewAt(world, initial(world));
    const infos = deepFreeze(roomInfos(view, world.params, recall(view, world.params)));
    const ordered = taskSheetOrder(infos);
    expect(ordered).not.toBe(infos);
    expect(infos.map((info) => info.room.id)).toEqual(view.rooms.map((room) => room.id));
  });
});

describe('平面图方块第二行的说明', () => {
  it('此刻 later 的写回来时间，回来时间过了改写线索', () => {
    const world = controlledWorld({ 1203: stayover({ availableFrom: 100, clue: 'family' }) });
    const refused = play(world, initial(world), act.service(1203));
    const comeBack = comeBackOf(world, refused, 1203);
    expect(roomTag(infoAt(world, refused, 1203))).toEqual({ code: 'later', at: comeBack });
    expect(roomTag(infoAt(world, waitUntil(world, refused, comeBack), 1203))).toEqual({ code: 'clue', clue: 'family' });
  });

  it('有贵宾时限的写贵宾时限，有催房时限的写催房时限，贵宾在前；都没有的写线索', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 330 }), 1201: departure({ clue: 'partyOrFamily' }) });
    const view = viewAt(world, initial(world));
    const infos = roomInfos(view, world.params, recall(view, world.params));
    const info = (id: RoomId): RoomInfo => {
      const found = infos.find((candidate) => candidate.room.id === id);
      if (found === undefined) throw new Error(`View 里没有房间 ${id}`);
      return found;
    };
    expect(roomTag(info(1202))).toEqual({ code: 'vip', deadline: 330 });
    expect(roomTag(info(1201))).toEqual({ code: 'clue', clue: 'partyOrFamily' });
    const rush = (base: RoomInfo): RoomInfo => ({ ...base, room: { ...base.room, rushDeadline: 300 } });
    expect(roomTag(rush(info(1201)))).toEqual({ code: 'rush', deadline: 300 });
    expect(roomTag(rush(info(1202)))).toEqual({ code: 'vip', deadline: 330 });
  });
});

describe('roomInfos', () => {
  it('按 view.rooms 的顺序，每间一项，状态和已知信息与单独推的相同；不修改深度冻结的 View', () => {
    const world = controlledWorld({ 1201: departure(), 1203: stayover() });
    const view = deepFreeze(viewAt(world, play(world, initial(world), act.call())));
    const memory = recall(view, world.params);
    const infos = roomInfos(view, world.params, memory);
    expect(infos.map((info) => info.room)).toEqual(view.rooms);
    for (const info of infos) {
      expect(info.status).toBe(roomStatus(info.room, view.minute));
      expect(info.facts).toEqual(roomFacts(info.room, view.minute, world.params, memory));
    }
  });
});
