/**
 * 主界面四个部件和主界面的渲染测试：在 Node 里用 react-dom/server 渲染成 HTML 字符串，查要显示的东西都显示了、
 * 文字取自语言包（src/content/zh/ui.ts）、数值取自参数。状态和已知信息怎么推的在 tests/ui-rooms.test.ts，
 * 时间轴和平面图的位置在 tests/ui-timeline.test.ts 和 tests/ui-floor-geometry.test.ts，这里只查画出来的结果。
 * 受控世界里没写到的房间都是整班不摘牌的请勿打扰房（tests/helpers/world.ts）。
 */

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useText } from '../src/content';
import { zhUi } from '../src/content/zh/ui';
import { initial, observe, PARAMS, recall, toClock, type Params, type State, type View, type World } from '../src/engine';
import { Cart } from '../src/ui/Cart';
import { FloorPlan } from '../src/ui/FloorPlan';
import { floorGeometry, placePoint } from '../src/ui/floorGeometry';
import { roomInfos, taskSheetOrder } from '../src/ui/rooms';
import { ShiftScreen } from '../src/ui/ShiftScreen';
import { TaskSheet } from '../src/ui/TaskSheet';
import { Timeline } from '../src/ui/Timeline';
import { act, play, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze, TIERS } from './helpers/play';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

type Widget = (props: { view: View; params: Params }) => ReactElement;

/** 用 world 这一刻的 View 渲染一个部件。View 先深度冻结：部件不能修改它。 */
function render(Component: Widget, world: World, state: State): string {
  return renderToStaticMarkup(<Component view={deepFreeze(observe(world, state))} params={world.params} />);
}

/** 带 data-room 的元素按出现顺序的房号。 */
function roomsIn(html: string): number[] {
  return [...html.matchAll(/data-room="(\d+)"/g)].map((match) => Number(match[1]));
}

/** 任务单里某一行的 HTML。 */
function rowOf(html: string, room: number): string {
  const match = new RegExp(`<tr[^>]*data-room="${room}"[\\s\\S]*?</tr>`).exec(html);
  if (match === null) throw new Error(`任务单里没有 ${room} 这一行`);
  return match[0];
}

function count(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

/** 平面图上某间房方块第二行的字：房型简称和说明，去掉标签，中间隔一个空格。 */
function tagOf(html: string, room: number): string {
  const start = html.indexOf(`data-room="${room}" data-status=`);
  if (start < 0) throw new Error(`平面图上没有 ${room}`);
  const match = /<text class="fp-room-tag"[^>]*>([\s\S]*?)<\/text>/.exec(html.slice(start));
  if (match?.[1] === undefined) throw new Error(`${room} 的方块里没有第二行`);
  return match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('语言包', () => {
  it('useText 现在就是中文的文案表', () => {
    expect(useText()).toBe(zhUi);
  });
});

describe('任务单', () => {
  const world = controlledWorld({
    1201: departure({ clue: 'threeNightsPlus' }),
    1202: departure({ vipDeadline: 270 }),
    1203: stayover({ availableFrom: 100, clue: 'tourist' }),
    1205: dnd({ clue: 'longStay' }),
    1207: stayover(),
  });

  it('开工时：标题、还没打过电话；每间房一行，顺序同 taskSheetOrder；每行有房号、房型、线索和已知信息', () => {
    const start = initial(world);
    const html = render(TaskSheet, world, start);
    expect(html).toContain(zhUi.taskSheet.title);
    expect(html).toContain(zhUi.taskSheet.noCallYet);
    const view = observe(world, start);
    const ordered = taskSheetOrder(roomInfos(view, world.params, recall(view, world.params)));
    expect(roomsIn(html)).toEqual(ordered.map((info) => info.room.id));
    expect(count(html, /<tr /g)).toBe(view.rooms.length);
    const vipRow = rowOf(html, 1202);
    for (const text of ['1202', zhUi.kind.departure, zhUi.clue.oneNight, zhUi.taskSheet.vip(toClock(270), false), zhUi.taskSheet.notDeparted]) {
      expect(vipRow).toContain(text);
    }
    expect(rowOf(html, 1201)).toContain(zhUi.clue.threeNightsPlus);
    expect(rowOf(html, 1203)).toContain(zhUi.taskSheet.notKnocked);
    expect(rowOf(html, 1205)).toContain(zhUi.kind.dnd);
    expect(rowOf(html, 1205)).toContain(zhUi.taskSheet.neverConfirmed);
  });

  it('打过电话：顶上写挂断的时刻；路过请勿打扰房的门位以后，那一行写确认仍挂牌的时刻', () => {
    // 去 1207（门位 4）的路上第 3 分钟经过 1205 的门位 3；打扫完停在门位 4，再打电话。
    const passed = play(world, initial(world), act.service(1207));
    const passedHtml = render(TaskSheet, world, passed);
    expect(passedHtml).toContain(zhUi.taskSheet.noCallYet);
    expect(rowOf(passedHtml, 1205)).toContain(zhUi.taskSheet.stillHung(toClock(3)));
    const called = play(world, passed, act.call());
    const calledHtml = render(TaskSheet, world, called);
    expect(calledHtml).toContain(zhUi.taskSheet.lastCall(toClock(called.minute)));
    expect(calledHtml).not.toContain(zhUi.taskSheet.noCallYet);
    expect(rowOf(calledHtml, 1205)).toContain(zhUi.taskSheet.stillHung(toClock(called.minute)));
    expect(rowOf(calledHtml, 1201)).toContain(zhUi.taskSheet.departed);
  });

  it('敲门被拒写回来时间，做完写完成时刻和脏乱', () => {
    const refused = play(world, initial(world), act.service(1203));
    const comeBack = observe(world, refused).rooms.find((room) => room.id === 1203)?.knownAvailableFrom ?? null;
    if (comeBack === null) throw new Error('1203 没有回来时间');
    expect(rowOf(render(TaskSheet, world, refused), 1203)).toContain(zhUi.taskSheet.comeBack(toClock(comeBack)));
    const done = play(world, waitUntil(world, refused, comeBack), act.service(1203));
    const row = rowOf(render(TaskSheet, world, done), 1203);
    expect(row).toContain(zhUi.taskSheet.done(toClock(done.minute)));
    expect(row).toContain(zhUi.taskSheet.mess(zhUi.mess.normal, 15));
  });

  it('ODD_PARAMS：打电话 3 分钟，挂断的时刻从日志来', () => {
    const odd = controlledWorld({ 301: departure() }, { params: ODD_PARAMS });
    const called = play(odd, initial(odd), act.call());
    expect(called.minute).toBe(ODD_PARAMS.callMinutes);
    expect(render(TaskSheet, odd, called)).toContain(zhUi.taskSheet.lastCall(toClock(ODD_PARAMS.callMinutes)));
  });
});

describe('布草车', () => {
  it.each([...TIERS.map((tier) => [tier, PARAMS[tier]] as const), ['ODD_PARAMS', ODD_PARAMS] as const])(
    '%s：格子数等于容量，开工时全是实心格',
    (_name, params) => {
      const world = controlledWorld({}, { params });
      const html = render(Cart, world, initial(world));
      expect(count(html, /class="cart-cell(?: is-full)?"/g)).toBe(params.cart.capacity);
      expect(count(html, /class="cart-cell is-full"/g)).toBe(params.cart.capacity);
      expect(html).toContain(zhUi.cart.count(params.cart.capacity, params.cart.capacity));
      expect(html).toContain(zhUi.cart.title);
    },
  );

  it('打扫用掉的变空：退房房用 2 份，续住房用 1 份', () => {
    const world = controlledWorld({ 1201: departure(), 1203: stayover() });
    const state = play(world, initial(world), act.call(), act.service(1201), act.service(1203));
    const capacity = world.params.cart.capacity;
    const left = capacity - world.params.rooms.departure.linen - world.params.rooms.stayover.linen;
    expect(state.cart).toBe(left);
    const html = render(Cart, world, state);
    expect(count(html, /class="cart-cell(?: is-full)?"/g)).toBe(capacity);
    expect(count(html, /class="cart-cell is-full"/g)).toBe(left);
    expect(html).toContain(zhUi.cart.label(left, capacity));
  });
});

describe('时间轴', () => {
  it('开工时：现在 08:30，刻度的钟点，贵宾时限的小旗，休息的两条说明', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 270 }), 1304: departure({ vipDeadline: 330 }) });
    const html = render(Timeline, world, initial(world));
    expect(html).toContain(zhUi.timeline.now(toClock(0)));
    for (const clock of ['08:30', '10:30', '14:30', '16:00', '17:00']) expect(html).toContain(`>${clock}<`);
    expect(roomsIn(html)).toEqual([1202, 1304]);
    expect(html).toContain(zhUi.timeline.vipTitle(1202, toClock(270), false));
    expect(html).toContain(zhUi.timeline.breakWindow);
    expect(html).toContain(zhUi.timeline.breakLatest);
    expect(html).not.toContain(`>${zhUi.timeline.breakTaken}<`);
  });

  it('ODD_PARAMS：刻度的钟点从参数换算', () => {
    const world = controlledWorld({}, { params: ODD_PARAMS });
    const html = render(Timeline, world, initial(world));
    const { shift } = ODD_PARAMS;
    for (const minute of [shift.breakEarliest, shift.breakLatest, shift.targetFinish, shift.hardStop]) {
      expect(html).toContain(`>${toClock(minute)}<`);
    }
    expect(html).not.toContain('>17:00<');
  });

  it('休息过了：不再写可以休息和只能休息，改写休息；指针上方是现在的时刻；敲门被拒的房间在回来时间处有小点', () => {
    const world = controlledWorld({ 1203: stayover({ availableFrom: 200 }) });
    const refused = play(world, initial(world), act.service(1203));
    const rested = play(world, waitUntil(world, refused, world.params.shift.breakEarliest), act.break());
    const html = render(Timeline, world, rested);
    expect(rested.minute).toBeGreaterThan(0);
    expect(html).toContain(zhUi.timeline.now(toClock(rested.minute)));
    expect(html).not.toContain(zhUi.timeline.now(toClock(0)));
    expect(html).not.toContain(zhUi.timeline.breakWindow);
    expect(html).not.toContain(zhUi.timeline.breakLatest);
    expect(html).toContain(`>${zhUi.timeline.breakTaken}<`);
    const comeBack = observe(world, rested).rooms.find((room) => room.id === 1203)?.knownAvailableFrom ?? null;
    if (comeBack === null) throw new Error('1203 没有回来时间');
    expect(html).toContain(zhUi.timeline.comeBackTitle(1203, toClock(comeBack)));
  });
});

describe('平面图', () => {
  it('每间房一个方块，状态和房间的状态相同；楼层名、电梯、服务间、你和图例都有', () => {
    const world = controlledWorld({
      1201: departure(),
      1202: departure({ vipDeadline: 270 }),
      1203: stayover({ availableFrom: 100 }),
      1207: stayover(),
    });
    const refused = play(world, initial(world), act.call(), act.service(1207), act.service(1203));
    const html = render(FloorPlan, world, refused);
    const statuses = Object.fromEntries([...html.matchAll(/data-room="(\d+)" data-status="(\w+)"/g)].map((match) => [Number(match[1]), match[2]]));
    const view = observe(world, refused);
    expect(Object.keys(statuses)).toHaveLength(view.rooms.length);
    expect(statuses[1201]).toBe('open');
    expect(statuses[1207]).toBe('done');
    expect(statuses[1203]).toBe('later');
    expect(statuses[1205]).toBe('locked');
    for (const text of [
      zhUi.floorPlan.floor(12),
      zhUi.floorPlan.floor(13),
      zhUi.floorPlan.lift,
      zhUi.floorPlan.servicePoint,
      zhUi.floorPlan.you,
      zhUi.floorPlan.legend.done,
      zhUi.floorPlan.legend.locked,
      zhUi.floorPlan.legend.later,
      zhUi.floorPlan.vipTag(toClock(270)),
    ]) {
      expect(html).toContain(text);
    }
    // 方块第二行：房型简称加一条说明。
    const comeBack = view.rooms.find((room) => room.id === 1203)?.knownAvailableFrom ?? null;
    if (comeBack === null) throw new Error('1203 没有回来时间');
    expect(tagOf(html, 1203)).toBe(`${zhUi.kindShort.stayover} ${zhUi.floorPlan.laterTag(toClock(comeBack))}`);
    expect(tagOf(html, 1202)).toBe(`${zhUi.kindShort.departure} ${zhUi.floorPlan.vipTag(toClock(270))}`);
    expect(tagOf(html, 1201)).toBe(`${zhUi.kindShort.departure} ${zhUi.clueShort.oneNight}`);
    expect(tagOf(html, 1205)).toBe(`${zhUi.kindShort.dnd} ${zhUi.clueShort.business}`);
    // 你的圆点在 View 的位置上：打扫完 1203 停在 12 楼门位 2。
    const you = /<g class="fp-you"><circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html);
    expect(view.place).toEqual({ floor: 12, door: 2 });
    expect({ x: Number(you?.[1]), y: Number(you?.[2]) }).toEqual(placePoint(floorGeometry(world.params), view.place));
  });

  it('ODD_PARAMS：5 楼和 3 楼，16 间房', () => {
    const world = controlledWorld({}, { params: ODD_PARAMS });
    const html = render(FloorPlan, world, initial(world));
    expect(roomsIn(html)).toHaveLength(16);
    expect(html).toContain(zhUi.floorPlan.floor(5));
    expect(html).toContain(zhUi.floorPlan.floor(3));
    expect(html).not.toContain(zhUi.floorPlan.floor(12));
  });
});

describe('主界面', () => {
  it.each(TIERS)('%s：游戏名、难度档和四个部件都在', (tier) => {
    const world = controlledWorld({}, { tier });
    const html = render(ShiftScreen, world, initial(world));
    expect(html).toContain(zhUi.title);
    expect(html).toContain(zhUi.tier[tier]);
    for (const part of ['class="timeline"', 'class="floor-plan"', 'class="task-sheet"', 'class="cart"']) {
      expect(html).toContain(part);
    }
  });
});
