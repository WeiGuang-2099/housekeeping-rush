/**
 * 动作预览（src/ui/preview.ts）的单元测试：每种动作的步行、到达、完成时刻、打扫时间的范围、客人可能在、17:00 截断、
 * 布草、时限判断；不合法时给 illegalReasonForView 的原因；哪些控件能点、全局的原因、等待的上限；数值从参数读。
 * 和 apply 逐一核对在 tests/ui-preview.property.test.ts。
 *
 * 受控世界里没写到的房间都是整班不摘牌的请勿打扰房（tests/helpers/world.ts）。标准档：同层每个门位 1 分钟，跨层先走到
 * 门位 0，乘电梯 4 分钟；退房房整洁、普通、灾难 24、30、48 分钟，用 2 份布草；续住房 12、15、24 分钟，用 1 份；
 * 敲门被拒 1 分钟，打电话 2 分钟，补货 5 分钟，休息 30 分钟，还车 5 分钟，等待每次最多 5 分钟。服务间是 12 楼门位 0。
 */

import { describe, expect, it } from 'vitest';
import { illegalReasonForView, initial, observe, type Action, type State, type View, type World } from '../src/engine';
import {
  BUTTONS,
  buttonAction,
  canPick,
  globalReason,
  planEnd,
  planTarget,
  previewAction,
  waitLimit,
  type ActionPlan,
  type Preview,
} from '../src/ui/preview';
import { act, play, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze } from './helpers/play';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

function previewAt(world: World, state: State, action: Action): Preview {
  return previewAction(observe(world, state), world.params, action);
}

/** 合法动作的计划；不合法就让测试失败。 */
function planAt(world: World, state: State, action: Action): ActionPlan {
  const preview = previewAt(world, state, action);
  if (!preview.ok) throw new Error(`${JSON.stringify(action)} 不合法：${preview.reason.code}`);
  return preview.plan;
}

/** 已经休息过、在服务间、时刻是 minute 的状态（休息在 10:30 开始）。 */
function restedAt(world: World, minute: number): State {
  const rested = play(world, waitUntil(world, initial(world), world.params.shift.breakEarliest), act.break());
  return waitUntil(world, rested, minute);
}

describe('打扫', () => {
  it('没敲过门的续住房：步行、到门口、三档脏乱的打扫时间、做完的时刻、客人在的话几点回来、用 1 份布草', () => {
    const world = controlledWorld({ 1204: stayover() });
    expect(planAt(world, initial(world), act.service(1204))).toEqual({
      type: 'service',
      room: 1204,
      walk: 2,
      arrival: 2,
      cleaning: { from: 12, to: 24 },
      finish: { from: 14, to: 26 },
      cut: 'none',
      refusedAt: 3,
      linen: 1,
      resumed: 0,
      deadlines: [],
    });
  });

  it('报了已退的退房房：客人已走，不会被拒；用 2 份布草；贵宾时限按做完的时刻判断', () => {
    const world = controlledWorld({
      1202: departure({ vipDeadline: 270 }),
      1203: departure({ vipDeadline: 40 }),
      1204: departure({ vipDeadline: 26 }),
    });
    const called = play(world, initial(world), act.call());
    // 打完电话 2 分钟，走到门位 1 一分钟，3 分钟到；24 到 48 分钟。
    const plan = planAt(world, called, act.service(1202));
    expect(plan).toMatchObject({ walk: 1, arrival: 3, finish: { from: 27, to: 51 }, refusedAt: null, linen: 2 });
    expect(plan.type === 'service' && plan.deadlines).toEqual([{ kind: 'vip', at: 270, verdict: 'onTime' }]);
    // 走到门位 2 两分钟，4 分钟到，28 到 52 分钟做完：40 可能赶不上；26 一定赶不上。
    const maybe = planAt(world, called, act.service(1203));
    expect(maybe.type === 'service' && maybe.deadlines).toEqual([{ kind: 'vip', at: 40, verdict: 'maybeLate' }]);
    const late = planAt(world, called, act.service(1204));
    expect(late.type === 'service' && late.deadlines).toEqual([{ kind: 'vip', at: 26, verdict: 'late' }]);
  });

  it('跨层：先走到门位 0，乘电梯 4 分钟，再走到目标门位', () => {
    const world = controlledWorld({ 1303: stayover() });
    // 12 楼门位 0 到 13 楼门位 2：0 + 4 + 2。
    expect(planAt(world, initial(world), act.service(1303))).toMatchObject({ walk: 6, arrival: 6 });
  });

  it('有回来时间、到门口不早于它：客人一定已经出门，不会被拒', () => {
    const world = controlledWorld({ 1204: stayover({ availableFrom: 20 }) });
    const refused = play(world, initial(world), act.service(1204));
    const comeBack = observe(world, refused).rooms.find((room) => room.id === 1204)?.knownAvailableFrom ?? null;
    if (comeBack === null) throw new Error('1204 没有回来时间');
    const plan = planAt(world, waitUntil(world, refused, comeBack), act.service(1204));
    expect(plan).toMatchObject({ walk: 0, arrival: comeBack, refusedAt: null });
  });

  it('已知摘牌的请勿打扰房像续住房：没敲过门时客人可能在', () => {
    const world = controlledWorld({ 1205: dnd({ dndLiftsAt: 10 }) });
    const lifted = play(world, waitUntil(world, initial(world), 10), act.call());
    expect(planAt(world, lifted, act.service(1205))).toMatchObject({ cleaning: { from: 12, to: 24 }, refusedAt: lifted.minute + 3 + 1, linen: 1 });
  });

  it('接着做开过门的房间：脏乱已知，打扫剩下的分钟数，不再用布草，也不会被拒（View 里造的局面，阶段 0 走不到）', () => {
    const world = controlledWorld({ 1201: departure() });
    const view = observe(world, play(world, initial(world), act.call()));
    const resumed: View = {
      ...view,
      rooms: view.rooms.map((room) => (room.id === 1201 ? { ...room, mess: 'disaster', workDone: 10 } : room)),
    };
    const preview = previewAction(resumed, world.params, act.service(1201));
    expect(preview.ok && preview.plan).toMatchObject({ cleaning: { from: 38, to: 38 }, linen: 0, resumed: 10, refusedAt: null });
  });

  it('17:00 前可能做不完、一定做不完：做完的时刻停在 17:00', () => {
    const world = controlledWorld({ 1201: departure() });
    const { hardStop } = world.params.shift;
    // 打电话标记 1201，休息，再等到 16:30：走 1 分钟，481 到，24 到 48 分钟，505 到 529。
    const at1630 = play(world, restedAt(world, hardStop - 32), act.call());
    expect(at1630.minute).toBe(hardStop - 30);
    expect(planAt(world, at1630, act.service(1201))).toMatchObject({ cut: 'maybe', finish: { from: hardStop - 5, to: hardStop } });
    // 16:40：491 到，515 到 539 都晚于 17:00。
    const at1640 = waitUntil(world, at1630, hardStop - 20);
    expect(planAt(world, at1640, act.service(1201))).toMatchObject({ cut: 'sure', finish: { from: hardStop, to: hardStop } });
  });

  it('恰好在 17:00 做完算做完：最早做完是 17:00 时只是可能做不完，不是一定做不完', () => {
    const world = controlledWorld({ 1201: departure() });
    const { hardStop } = world.params.shift;
    // 走 1 分钟，最少 24 分钟：在 17:00 前 25 分钟出发，最早恰好 17:00 做完。
    const state = play(world, restedAt(world, hardStop - 27), act.call());
    expect(state.minute).toBe(hardStop - 25);
    expect(planAt(world, state, act.service(1201))).toMatchObject({ cut: 'maybe', finish: { from: hardStop, to: hardStop } });
  });

  it('时限在 17:00、可能做不完时，只是可能赶不上（做不完就没赶上）', () => {
    const world = controlledWorld({ 1201: departure({ vipDeadline: 510 }) });
    const state = play(world, restedAt(world, 478), act.call());
    const plan = planAt(world, state, act.service(1201));
    expect(plan.type === 'service' && plan.cut).toBe('maybe');
    expect(plan.type === 'service' && plan.deadlines).toEqual([{ kind: 'vip', at: 510, verdict: 'maybeLate' }]);
  });

  it('催房时限也判断（View 里造的局面，阶段 0 没有催房事件）：贵宾在前、催房在后', () => {
    const world = controlledWorld({ 1202: departure({ vipDeadline: 270 }) });
    const view = observe(world, play(world, initial(world), act.call()));
    const rushed: View = {
      ...view,
      rooms: view.rooms.map((room) => (room.id === 1202 ? { ...room, rushDeadline: 40 } : room)),
    };
    const preview = previewAction(rushed, world.params, act.service(1202));
    expect(preview.ok && preview.plan.type === 'service' && preview.plan.deadlines).toEqual([
      { kind: 'vip', at: 270, verdict: 'onTime' },
      { kind: 'rush', at: 40, verdict: 'maybeLate' },
    ]);
  });

  it('时限遇上一定做不完是赶不上，遇上可能做不完是可能赶不上', () => {
    const world = controlledWorld({ 1201: departure({ vipDeadline: 505 }), 1202: departure({ vipDeadline: 509 }) });
    const { hardStop } = world.params.shift;
    const state = play(world, restedAt(world, hardStop - 32), act.call());
    const maybe = planAt(world, state, act.service(1201));
    expect(maybe.type === 'service' && maybe.deadlines).toEqual([{ kind: 'vip', at: 505, verdict: 'maybeLate' }]);
    const sure = planAt(world, waitUntil(world, state, hardStop - 20), act.service(1202));
    expect(sure.type === 'service' && sure.deadlines).toEqual([{ kind: 'vip', at: 509, verdict: 'late' }]);
  });
});

describe('其余动作', () => {
  it('补货：走回服务间，5 分钟补完，补回容量减现有的份数', () => {
    const world = controlledWorld({ 1203: departure() });
    const cleaned = play(world, initial(world), act.call(), act.service(1203));
    expect(planAt(world, cleaned, act.restock())).toEqual({
      type: 'restock',
      walk: 2,
      arrival: cleaned.minute + 2,
      end: cleaned.minute + 7,
      refill: 2,
    });
  });

  it('打电话：2 分钟，挂断的时刻', () => {
    const world = controlledWorld({});
    expect(planAt(world, initial(world), act.call())).toEqual({ type: 'call', end: 2 });
  });

  it('休息：开始的时刻是到达服务间的时刻，休 30 分钟；到达早于 10:30 不合法，给出到达的时刻', () => {
    const world = controlledWorld({ 1204: stayover() });
    const { breakEarliest } = world.params.shift;
    const atDoor = waitUntil(world, play(world, initial(world), act.service(1204)), breakEarliest - 3);
    const early = previewAt(world, atDoor, act.break());
    expect(early).toEqual({
      action: act.break(),
      ok: false,
      reason: { code: 'breakTooEarly', breakEarliest, arrival: breakEarliest - 1 },
    });
    const onTime = waitUntil(world, atDoor, breakEarliest - 2);
    expect(planAt(world, onTime, act.break())).toEqual({ type: 'break', walk: 2, start: breakEarliest, end: breakEarliest + 30 });
  });

  it('等待：选几分钟就到几点；超过上限不合法', () => {
    const world = controlledWorld({});
    expect(planAt(world, initial(world), act.wait(3))).toEqual({ type: 'wait', minutes: 3, end: 3 });
    expect(previewAt(world, initial(world), act.wait(6))).toMatchObject({ ok: false, reason: { code: 'badWait', limit: 5 } });
  });

  it('收工还车：走回服务间，还车 5 分钟；17:00 以后是强制下班', () => {
    const world = controlledWorld({});
    const rested = restedAt(world, 200);
    expect(planAt(world, rested, act.finish())).toEqual({ type: 'finish', walk: 0, end: 205, forced: false });
    const late = waitUntil(world, rested, world.params.shift.hardStop);
    expect(planAt(world, late, act.finish())).toEqual({ type: 'finish', walk: 0, end: late.minute + 5, forced: true });
  });
});

describe('不合法', () => {
  it('原因就是 illegalReasonForView 给的：没报已退、做完了、早于回来时间、布草不够、还没休息不能收工', () => {
    const world = controlledWorld({ 1201: departure(), 1203: stayover({ availableFrom: 100 }), 1204: stayover() });
    const refused = play(world, initial(world), act.service(1203), act.service(1204));
    const view = observe(world, refused);
    for (const action of [act.service(1201), act.service(1204), act.service(1203), act.finish()]) {
      const preview = previewAction(view, world.params, action);
      expect(preview.ok).toBe(false);
      expect(!preview.ok && preview.reason).toEqual(illegalReasonForView(view, world.params, action));
    }
    expect(previewAction(view, world.params, act.service(1201))).toMatchObject({ reason: { code: 'notFlagged', room: 1201 } });
    expect(previewAction(view, world.params, act.service(1204))).toMatchObject({ reason: { code: 'roomDone', room: 1204 } });
  });
});

describe('控件能不能点', () => {
  const world = controlledWorld({ 1201: departure(), 1204: stayover() });

  it('平常：合法的能点；不合法、原因不是全局的也能点（预览写原因）；做完的房间不能点；没有全局原因', () => {
    const state = play(world, initial(world), act.service(1204));
    const view = observe(world, state);
    expect(canPick(view, world.params, act.call())).toBe(true);
    expect(canPick(view, world.params, act.service(1201))).toBe(true);
    expect(canPick(view, world.params, act.break())).toBe(true);
    expect(canPick(view, world.params, act.service(1204))).toBe(false);
    expect(globalReason(view, world.params)).toBeNull();
    expect(waitLimit(view, world.params)).toBe(5);
  });

  it('14:30 起还没休息：只有休息能点，全局原因是 mustBreak，不能等待', () => {
    const state = waitUntil(world, initial(world), world.params.shift.breakLatest);
    const view = observe(world, state);
    expect(canPick(view, world.params, act.break())).toBe(true);
    for (const action of [act.call(), act.restock(), act.wait(1), act.finish(), act.service(1204)]) {
      expect(canPick(view, world.params, action), JSON.stringify(action)).toBe(false);
    }
    expect(globalReason(view, world.params)).toEqual({ code: 'mustBreak', breakLatest: world.params.shift.breakLatest });
    expect(waitLimit(view, world.params)).toBeNull();
  });

  it('17:00 以后：只有收工还车能点；还完车以后什么都不能点，全局原因是 ended', () => {
    const late = waitUntil(world, restedAt(world, 200), world.params.shift.hardStop);
    const view = observe(world, late);
    expect(canPick(view, world.params, act.finish())).toBe(true);
    for (const action of [act.call(), act.break(), act.wait(1), act.service(1204)]) {
      expect(canPick(view, world.params, action), JSON.stringify(action)).toBe(false);
    }
    expect(globalReason(view, world.params)).toEqual({ code: 'afterHardStop', hardStop: world.params.shift.hardStop });
    const ended = observe(world, play(world, late, act.finish()));
    expect(canPick(ended, world.params, act.finish())).toBe(false);
    expect(globalReason(ended, world.params)).toEqual({ code: 'ended' });
  });

  it('等待的上限：17:00 前不到 5 分钟时是剩下的分钟数', () => {
    const near = waitUntil(world, restedAt(world, 200), world.params.shift.hardStop - 2);
    expect(waitLimit(observe(world, near), world.params)).toBe(2);
  });
});

describe('按钮点了预览的动作', () => {
  it('补货、打电话、休息、收工还车各是那个动作；等待是上限那一档，不能等待时是 1 分钟', () => {
    const world = controlledWorld({});
    const view = observe(world, initial(world));
    expect(BUTTONS.map((type) => buttonAction(type, view, world.params))).toEqual([
      act.restock(),
      act.call(),
      act.break(),
      act.wait(world.params.waitStepMinutes),
      act.finish(),
    ]);
    const near = observe(world, waitUntil(world, restedAt(world, 200), world.params.shift.hardStop - 3));
    expect(buttonAction('wait', near, world.params)).toEqual(act.wait(3));
    const forced = observe(world, waitUntil(world, initial(world), world.params.shift.breakLatest));
    expect(buttonAction('wait', forced, world.params)).toEqual(act.wait(1));
  });
});

describe('计划的终点和去处', () => {
  it('打扫的终点是做完的时刻（一段），别的动作是一个时刻；打扫去那间房，补货、休息、还车去服务间，电话和等待不动', () => {
    const world = controlledWorld({ 1204: stayover() });
    const view = observe(world, initial(world));
    const service = planAt(world, initial(world), act.service(1204));
    expect(planEnd(service)).toEqual({ from: 14, to: 26 });
    expect(planTarget(service, view, world.params)).toEqual({ floor: 12, door: 2 });
    const call = planAt(world, initial(world), act.call());
    expect(planEnd(call)).toEqual({ from: 2, to: 2 });
    expect(planTarget(call, view, world.params)).toBeNull();
    expect(planTarget(planAt(world, initial(world), act.restock()), view, world.params)).toEqual(world.params.layout.servicePoint);
    expect(planTarget(planAt(world, initial(world), act.wait(1)), view, world.params)).toBeNull();
  });
});

describe('数值从参数读', () => {
  it('ODD_PARAMS：步行每个门位 2 分钟、电梯 3 分钟，打扫和布草、打电话、补货的分钟数都换了', () => {
    const world = controlledWorld({ 301: departure(), 503: stayover() }, { params: ODD_PARAMS });
    // 服务间在 5 楼门位 0；503 在 5 楼门位 2：4 分钟。续住房 20 分钟乘 0.75、1.25、1.5。
    expect(planAt(world, initial(world), act.service(503))).toMatchObject({
      walk: 4,
      cleaning: { from: 15, to: 30 },
      refusedAt: 4 + ODD_PARAMS.knockRefusedMinutes,
      linen: ODD_PARAMS.rooms.stayover.linen,
    });
    expect(planAt(world, initial(world), act.call())).toEqual({ type: 'call', end: ODD_PARAMS.callMinutes });
    const called = play(world, initial(world), act.call());
    expect(called.minute).toBe(ODD_PARAMS.callMinutes);
    // 301 在 3 楼门位 1：0 + 3 + 2 = 5 分钟。退房房 40 分钟乘三档：30、50、60。
    expect(planAt(world, called, act.service(301))).toMatchObject({ walk: 5, cleaning: { from: 30, to: 60 }, linen: 3 });
    expect(planAt(world, called, act.restock())).toMatchObject({ walk: 0, end: called.minute + ODD_PARAMS.cart.restockMinutes });
    expect(waitLimit(observe(world, called), world.params)).toBe(ODD_PARAMS.waitStepMinutes);
  });
});

describe('纯函数', () => {
  it('不修改深度冻结的 View，同样的输入结果相同', () => {
    const world = controlledWorld({ 1204: stayover() });
    const view = deepFreeze(observe(world, initial(world)));
    expect(previewAction(view, world.params, act.service(1204))).toEqual(previewAction(view, world.params, act.service(1204)));
  });
});
