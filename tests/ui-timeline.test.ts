/**
 * 时间轴上画什么（src/ui/timelineModel.ts）的单元测试：刻度和整点从参数和开工时刻来，休息的浅色带、14:30 的线和
 * 休息过的那一段，时限的小旗和分行，回来时间的小点，以及 17:00 以后轴的右端。
 * 受控世界里没写到的房间都是整班不摘牌的请勿打扰房（tests/helpers/world.ts），没有时限。
 */

import { describe, expect, it } from 'vitest';
import { fromClock, initial, observe, PARAMS, type Minute, type State, type View, type World } from '../src/engine';
import { LABEL_SPAN, percentOf, timelineModel, type TimelineFlag } from '../src/ui/timelineModel';
import { act, play, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze } from './helpers/play';
import { controlledWorld, departure, stayover } from './helpers/world';

function modelAt(world: World, state: State) {
  return timelineModel(observe(world, state), world.params);
}

/** 把 View 里几间房的催房时限换掉（阶段 0 没有事件，催房时限只能这样造）。 */
function withRush(view: View, rush: Record<number, Minute>): View {
  return { ...view, rooms: view.rooms.map((room) => ({ ...room, rushDeadline: rush[room.id] ?? room.rushDeadline })) };
}

describe('刻度', () => {
  it('标准档开工时：轴到 17:00，带字的刻度是开工、10:30、14:30、16:00、17:00，整点从 09:00 起到 16:00', () => {
    const world = controlledWorld({});
    const model = modelAt(world, initial(world));
    expect(model.end).toBe(fromClock('17:00'));
    expect(model.now).toBe(0);
    expect(model.ticks).toEqual([
      { role: 'start', at: 0 },
      { role: 'breakEarliest', at: fromClock('10:30') },
      { role: 'breakLatest', at: fromClock('14:30') },
      { role: 'targetFinish', at: fromClock('16:00') },
      { role: 'hardStop', at: fromClock('17:00') },
    ]);
    expect(model.hours).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'].map(fromClock));
  });

  it('从参数读：ODD_PARAMS 的休息窗口、目标下班和强制下班都换了', () => {
    const world = controlledWorld({}, { params: ODD_PARAMS });
    const model = modelAt(world, initial(world));
    const { shift } = ODD_PARAMS;
    expect(model.end).toBe(shift.hardStop);
    expect(model.ticks.map((tick) => tick.at)).toEqual([
      0,
      shift.breakEarliest,
      shift.breakLatest,
      shift.targetFinish,
      shift.hardStop,
    ]);
    expect(model.breakWindow).toEqual({ from: shift.breakEarliest, to: shift.hardStop });
    expect(model.breakLatest).toBe(shift.breakLatest);
    expect(model.hours.at(-1)).toBeLessThan(shift.hardStop);
  });

  it('17:00 以后还车，轴的右端延到现在', () => {
    const world = controlledWorld({ 1208: stayover() });
    const { shift } = world.params;
    let state = play(world, waitUntil(world, initial(world), shift.breakEarliest), act.break());
    // 在 1208 门口（门位 4）等到 17:00，回服务间还车要走 4 分钟再还 5 分钟。
    state = play(world, state, act.service(1208));
    state = play(world, waitUntil(world, state, shift.hardStop), act.finish());
    expect(state.minute).toBeGreaterThan(shift.hardStop);
    const model = modelAt(world, state);
    expect(model.end).toBe(state.minute);
    expect(model.now).toBe(state.minute);
    expect(percentOf(model.now, model.end)).toBe(100);
  });

  it('percentOf：开工是 0，轴的右端是 100，正中是 50', () => {
    expect(percentOf(0, 510)).toBe(0);
    expect(percentOf(510, 510)).toBe(100);
    expect(percentOf(255, 510)).toBe(50);
  });
});

describe('休息', () => {
  it('还没休息：浅色带从 10:30 到轴的右端，14:30 有线，没有休息过的那一段', () => {
    const world = controlledWorld({});
    const model = modelAt(world, initial(world));
    expect(model.breakWindow).toEqual({ from: PARAMS.standard.shift.breakEarliest, to: model.end });
    expect(model.breakLatest).toBe(PARAMS.standard.shift.breakLatest);
    expect(model.breakTaken).toBeNull();
  });

  it('休息过了：不再画浅色带和 14:30 的线，休息那一段从到达服务间到休息结束', () => {
    const world = controlledWorld({ 1203: stayover() });
    const { shift } = world.params;
    // 做完 1203 停在门位 2，等到 10:28 再回服务间，走 2 分钟，10:30 到达，休息 30 分钟。
    const ready = waitUntil(world, play(world, initial(world), act.service(1203)), shift.breakEarliest - 2);
    const rested = play(world, ready, act.break());
    const model = modelAt(world, rested);
    expect(model.breakWindow).toBeNull();
    expect(model.breakLatest).toBeNull();
    expect(model.breakTaken).toEqual({ from: shift.breakEarliest, to: shift.breakEarliest + shift.breakMinutes });
  });
});

describe('时限的小旗', () => {
  it('每间有贵宾时限的房间一面旗，按时刻排；做没做完、赶不赶得上照实记', () => {
    const world = controlledWorld({
      1202: departure({ vipDeadline: 330 }),
      1204: departure({ vipDeadline: 40 }),
    });
    const start = modelAt(world, initial(world));
    expect(start.flags.map(({ room, kind, at, done, overdue }) => ({ room, kind, at, done, overdue }))).toEqual([
      { room: 1204, kind: 'vip', at: 40, done: false, overdue: false },
      { room: 1202, kind: 'vip', at: 330, done: false, overdue: false },
    ]);
    // 打电话到 2，走到 1204 到 2 + 2 = 4，做到 34：赶上了 40。
    const done = modelAt(world, play(world, initial(world), act.call(), act.service(1204)));
    expect(done.flags[0]).toMatchObject({ room: 1204, done: true, overdue: false });
    const overdue = modelAt(world, waitUntil(world, initial(world), 40));
    expect(overdue.flags[0]).toMatchObject({ room: 1204, done: false, overdue: true });
  });

  it('分行：相差不到 LABEL_SPAN 分钟的旗放在不同的行，放进编号最小的够远的行', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 270 }) });
    const view = withRush(observe(world, initial(world)), {
      1201: 270 + LABEL_SPAN / 2,
      1203: 270 + LABEL_SPAN - 1,
      1204: 270 + LABEL_SPAN,
      1205: 270 + LABEL_SPAN * 2,
    });
    const model = timelineModel(view, world.params);
    const lanes = Object.fromEntries(model.flags.map((flag) => [flag.room, flag.lane]));
    expect(lanes).toEqual({ 1202: 0, 1201: 1, 1203: 2, 1204: 0, 1205: 0 });
    expect(model.lanes).toBe(3);
    expect(model.flags.find((flag) => flag.room === 1201)?.kind).toBe('rush');
  });

  it('同一行里相邻两面旗至少隔 LABEL_SPAN 分钟（三档开工时的贵宾时限）', () => {
    for (const tier of ['standard', 'tight', 'weekend'] as const) {
      const world = controlledWorld(
        Object.fromEntries(PARAMS[tier].vipDeadlines.map((deadline, index) => [1201 + index, departure({ vipDeadline: deadline })])),
        { tier },
      );
      const model = modelAt(world, initial(world));
      expect(model.flags).toHaveLength(PARAMS[tier].vipDeadlines.length);
      const byLane = new Map<number, TimelineFlag[]>();
      for (const flag of model.flags) byLane.set(flag.lane, [...(byLane.get(flag.lane) ?? []), flag]);
      for (const flags of byLane.values()) {
        for (let index = 1; index < flags.length; index++) {
          const [before, after] = [flags[index - 1], flags[index]];
          if (before === undefined || after === undefined) throw new Error('下标越界');
          expect(after.at - before.at).toBeGreaterThanOrEqual(LABEL_SPAN);
        }
      }
      expect(model.lanes).toBe(byLane.size);
    }
  });

  it('没有时限时没有旗，行数是 0', () => {
    const world = controlledWorld({});
    const model = modelAt(world, initial(world));
    expect(model.flags).toEqual([]);
    expect(model.lanes).toBe(0);
  });
});

describe('回来时间的小点', () => {
  it('敲门被拒的房间在回来时间处一个小点，做完以后没有', () => {
    const world = controlledWorld({ 1203: stayover({ availableFrom: 100 }) });
    const refused = play(world, initial(world), act.service(1203));
    const model = modelAt(world, refused);
    const comeBack = observe(world, refused).rooms.find((room) => room.id === 1203)?.knownAvailableFrom;
    expect(model.comeBacks).toEqual([{ room: 1203, at: comeBack }]);
    const done = play(world, waitUntil(world, refused, comeBack ?? 0), act.service(1203));
    expect(modelAt(world, done).comeBacks).toEqual([]);
  });
});

describe('纯函数', () => {
  it('不修改深度冻结的 View，同一个 View 两次结果相同', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 270 }) });
    const view = deepFreeze(observe(world, play(world, initial(world), act.call())));
    expect(timelineModel(view, world.params)).toEqual(timelineModel(view, world.params));
  });
});
