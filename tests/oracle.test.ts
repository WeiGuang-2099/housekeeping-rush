/**
 * 全知（src/policies/oracle.ts）的单元测试。性质测试（契约、计划和规则一致、不差于新手、数值从 params 读）见
 * oracle.property.test.ts。
 *
 * 每个用例用受控世界写明几间房，起始状态由 initial 加一串合法动作推出来（催房时限的两例和待回应事件的一例除外，用例里有说明）。
 * 没写到的房间是整班不摘牌的请勿打扰房（见 tests/helpers/world.ts）：永远不能做，也不算未完成，全知的计划里没有它们。
 * 交给全知的是深度冻结的 world 和 state，和以后模拟器的共用驱动函数约定的一样。
 *
 * 开工后休息要等到 10:30，房间少的时候整班的下班时刻全由休息决定，早几分钟晚几分钟都一样。为了让每一分钟都算数，
 * 不少用例先原地等到 10:30、在服务间休息到 11:00（150），再从这个局面交给全知：它不用再休息，成绩直接取决于后面每一步。
 *
 * 标准档的几何：12 楼 1201 到 1208 在门位 1 到 4（每两间一个门位），13 楼 1301 到 1307 在门位 1 到 4；
 * 服务间是 12 楼门位 0。同层每个门位 1 分钟，跨层先走到门位 0，乘电梯 4 分钟。打扫分钟：退房房 30，续住房和请勿打扰房 15
 * （普通脏乱，灾难档乘 1.6）；退房房要 2 份布草，续住房 1 份。打电话 2 分钟，补货和收工还车是走回服务间再加 5 分钟，
 * 休息是走回服务间再加 30 分钟，每次最多等 5 分钟。时刻从 08:30 起算：120 是 10:30，150 是 11:00，360 是 14:30，510 是 17:00。
 */

import { describe, expect, it } from 'vitest';
import { generate } from '../src/engine/generate';
import { observe } from '../src/engine/observe';
import { PARAMS, type Params } from '../src/engine/params';
import { apply, initial } from '../src/engine/rules';
import { score } from '../src/engine/score';
import type { Action, LogEntry, Score, State, World } from '../src/engine/types';
import { novice } from '../src/policies/novice';
import { oracle, oraclePlan, type OraclePlan } from '../src/policies/oracle';
import { act, errorOf, last, play, progress, waitUntil } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';
import { deepFreeze } from './helpers/play';
import { controlledWorld, departure, dnd, stayover } from './helpers/world';

/** 中文字符，用来确认报错消息是中文。 */
const CHINESE = /[一-鿿]/;

/** 交给全知的和驱动函数约定的一样：world 和 state，都深度冻结。 */
function decide(world: World, state: State): Action {
  return oracle(deepFreeze(world), deepFreeze(state));
}

function planOf(world: World, state: State): OraclePlan {
  return oraclePlan(deepFreeze(world), deepFreeze(state));
}

/** 照计划的全部动作执行（apply 会校验每个动作合法），返回结束时的状态和计划里新增的日志。 */
function replay(world: World, state: State, plan: OraclePlan): { final: State; entries: LogEntry[] } {
  const final = play(world, state, ...plan.actions);
  return { final, entries: final.log.slice(state.log.length) };
}

/** 新手从 state 起做到收工的成绩：每一步交给它深度冻结的 View 和 world.params。 */
function noviceScore(world: World, state: State): Score {
  let current = state;
  while (current.ended === null) current = apply(world, current, novice(deepFreeze(observe(world, current)), world.params));
  return score(world, current);
}

/** 开工后原地等到 10:30，在服务间休息到 11:00（150）。 */
function afterBreak(world: World): State {
  return play(world, waitUntil(world, initial(world), 120), act.break());
}

/** 计划里的动作类型，按顺序。 */
function typesOf(plan: OraclePlan): Action['type'][] {
  return plan.actions.map((action) => action.type);
}

/** 计划开头连续的等待加起来的分钟数。 */
function leadingWait(plan: OraclePlan): number {
  let total = 0;
  for (const action of plan.actions) {
    if (action.type !== 'wait') break;
    total += action.minutes;
  }
  return total;
}

describe('全知：打电话', () => {
  it('掐着退房的时刻打电话：09:28 打、09:30 挂断正好标记已退，赶上贵宾时限；新手的电话晚了几分钟，贵宾超时', () => {
    // 1201 在 60（09:30）退房，贵宾时限 91：挂断不早于 60 才标记，走 1 分钟、打扫 30 分钟，60 挂断正好 91 做完。
    // 早一分钟打（59 挂断）标记不上，晚一分钟打就超时。之后原地等到走回服务间正好 10:30，休息到 150，收工 155。
    const world = controlledWorld({ 1201: departure({ availableFrom: 60, vipDeadline: 91 }) });
    const start = initial(world);
    const plan = planOf(world, start);
    expect(leadingWait(plan)).toBe(58);
    expect(plan.actions.every((action) => action.type !== 'wait' || action.minutes <= 5)).toBe(true);
    const { final, entries } = replay(world, start, plan);
    const call = entries.find((entry) => entry.action.type === 'call');
    expect(call?.start).toBe(58);
    expect(call?.end).toBe(60);
    expect(call?.outcome).toStrictEqual({ type: 'called', newlyDeparted: [1201], newlyLifted: [] });
    expect(progress(final, 1201).doneAt).toBe(91);
    expect(score(world, final)).toMatchObject({ equivalentFinish: 155, penalties: { vipLate: 0, rushLate: 0, unfinished: 0 } });
    expect(plan.equivalentFinish).toBe(155);
    // 第一步：等一档。
    expect(decide(world, start)).toStrictEqual(act.wait(5));
    // 新手没房可做就隔一次等待打一次电话，63 才打出已退，贵宾超时。
    expect(noviceScore(world, start).penalties.vipLate).toBe(30);
  });

  it('ODD_PARAMS：打电话 3 分钟、每次最多等 4 分钟，都从 params 读：57 打、60 挂断', () => {
    // 501 在 5 楼门位 1，从服务间（5 楼门位 0）走 2 分钟；退房房普通脏乱 40 × 1.25 = 50 分钟。
    // 60 挂断，62 到门口，112 做完，正好赶上时限 112。之后走回服务间 114（不早于 100）休息 20 分钟，收工还车 7 分钟。
    const world = controlledWorld({ 501: departure({ availableFrom: 60, vipDeadline: 112 }) }, { params: ODD_PARAMS });
    const start = initial(world);
    const plan = planOf(world, start);
    expect(leadingWait(plan)).toBe(57);
    expect(plan.actions.every((action) => action.type !== 'wait' || action.minutes <= 4)).toBe(true);
    const { final, entries } = replay(world, start, plan);
    const call = entries.find((entry) => entry.action.type === 'call');
    expect([call?.start, call?.end]).toStrictEqual([57, 60]);
    expect(progress(final, 501).doneAt).toBe(112);
    expect(plan.equivalentFinish).toBe(141);
    expect(score(world, final).equivalentFinish).toBe(141);
  });

  it('一通电话只标记挂断以前退房的退房房：1201 在 60、1202 在 100 退房，分两次打，各掐在退房的时刻', () => {
    // 58 打、60 挂断标记 1201，61 到 91 做完；原地等到 98 再打，100 挂断标记 1202，接着做到 130（同一门位）；
    // 走回服务间 131 休息到 161，收工 166。等到 98 打一次电话把两间都标记，要到 197。
    const world = controlledWorld({ 1201: departure({ availableFrom: 60 }), 1202: departure({ availableFrom: 100 }) });
    const start = initial(world);
    const plan = planOf(world, start);
    const { final, entries } = replay(world, start, plan);
    const calls = entries.filter((entry) => entry.action.type === 'call');
    expect(calls.map((entry) => [entry.start, entry.end])).toStrictEqual([
      [58, 60],
      [98, 100],
    ]);
    expect(calls.map((entry) => entry.outcome)).toStrictEqual([
      { type: 'called', newlyDeparted: [1201], newlyLifted: [] },
      { type: 'called', newlyDeparted: [1202], newlyLifted: [] },
    ]);
    expect(plan.equivalentFinish).toBe(166);
    expect(score(world, final).equivalentFinish).toBe(166);
  });

  it('路过、停留时看到了摘牌就不再打电话：做完同一门位的 1203 时看到 1204 已摘牌，接着做 1204', () => {
    // 11:00 从服务间出发。1203 是灾难档的续住房（24 分钟），152 到门口，176 做完；1204 是同一门位的请勿打扰房，170 摘牌，
    // 1203 做完时在门口看一眼就知道了，接着做（191），收工：走 2 分钟加 5 分钟，198。
    // 先打电话问 1204 要等到 168 才问得出来，两间都做完要 211，晚得多。
    const world = controlledWorld({ 1203: stayover({ mess: 'disaster' }), 1204: dnd({ dndLiftsAt: 170 }) });
    const state = afterBreak(world);
    expect(state.minute).toBe(150);
    const plan = planOf(world, state);
    expect(typesOf(plan)).not.toContain('call');
    expect(plan.actions).toStrictEqual([act.service(1203), act.service(1204), act.finish()]);
    const { final, entries } = replay(world, state, plan);
    expect(entries[0]?.noticedLifted).toStrictEqual([1204]);
    expect(plan.equivalentFinish).toBe(198);
    expect(score(world, final).equivalentFinish).toBe(198);
  });

  it('步行途中路过时看到摘牌：从服务间去门位 4 的路上经过门位 2，看到 1203 早已摘牌，回头做它，不用打电话', () => {
    // 11:00 从服务间出发去 1207（门位 4），152 经过门位 2，1203 在 100 就摘了牌，就此得知。1207 在 169 做完，
    // 回到门位 2 做 1203（171 到 186），收工走 2 分钟加 5 分钟，193。先打电话问 1203 再做两间是 195。
    const world = controlledWorld({ 1203: dnd({ dndLiftsAt: 100 }), 1207: stayover() });
    const state = afterBreak(world);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.service(1207), act.service(1203), act.finish()]);
    const { entries } = replay(world, state, plan);
    expect(entries[0]?.noticedLifted).toStrictEqual([1203]);
    expect(plan.equivalentFinish).toBe(193);
  });

  it('站在请勿打扰房的门位上：原地等 1 分钟看到摘牌，比打电话早 1 分钟', () => {
    // 同上，只是 1204 在 177 摘牌：1203 在 176 做完时还挂着牌。原地等到 177，等待结束时看到摘牌，177 开始做 1204，192 做完；
    // 再去门位 4 的 1207（客人 190 出门），194 到，209 做完，收工走 4 分钟加 5 分钟，218。打电话要 176 打、178 挂断，晚 1 分钟。
    // 1207 让全知走不了：只有 1203、1204 两间时，176 做完 1203 就收工最好，那时 1204 还没摘牌，不算未完成。
    const world = controlledWorld({
      1203: stayover({ mess: 'disaster' }),
      1204: dnd({ dndLiftsAt: 177 }),
      1207: stayover({ availableFrom: 190 }),
    });
    const state = afterBreak(world);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([
      act.service(1203),
      act.wait(1),
      act.service(1204),
      act.service(1207),
      act.finish(),
    ]);
    const { entries } = replay(world, state, plan);
    expect(entries[1]?.noticedLifted).toStrictEqual([1204]);
    expect(plan.equivalentFinish).toBe(218);
  });

  it('请勿打扰房摘牌之前就收工，它不算未完成：只剩还挂着牌的请勿打扰房时，全知做完别的就走', () => {
    // 1203 在 176 做完，1204 要 177 才摘牌。176 收工：走 2 分钟加 5 分钟，183，没有罚时。等着做 1204 要 199。
    const world = controlledWorld({ 1203: stayover({ mess: 'disaster' }), 1204: dnd({ dndLiftsAt: 177 }) });
    const state = afterBreak(world);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.service(1203), act.finish()]);
    expect(score(world, replay(world, state, plan).final)).toMatchObject({ equivalentFinish: 183, roomsDone: 1 });
  });
});

describe('全知：时限和顺序', () => {
  it('贵宾时限：电话问出两间已退的退房房，先去远的贵宾房，不先去近的普通房；新手先去近的，贵宾超时', () => {
    // 1307（13 楼门位 4）的贵宾时限 40：2 挂断，走 8 分钟，10 到 40 做完。先做 1201 的话 1307 要 72 才做完。
    const world = controlledWorld({ 1201: departure(), 1307: departure({ vipDeadline: 40 }) });
    const start = initial(world);
    const plan = planOf(world, start);
    expect(plan.actions.slice(0, 3)).toStrictEqual([act.call(), act.service(1307), act.service(1201)]);
    expect(decide(world, start)).toStrictEqual(act.call());
    const { final } = replay(world, start, plan);
    expect(progress(final, 1307).doneAt).toBe(40);
    // 做完 1201 在 79，原地等到走回服务间正好 10:30，休息到 150，收工 155。
    expect(plan.equivalentFinish).toBe(155);
    const noviceResult = noviceScore(world, start);
    expect(noviceResult.penalties.vipLate).toBe(30);
    expect(noviceResult.equivalentFinish).toBeGreaterThan(plan.equivalentFinish);
  });

  it('催房时限也算：有时限的 1307 先做，赶上时限；先做近的 1201 会超时', () => {
    // 阶段 0 没有事件，催房时限写不进状态，只能手工写进一个可达状态的进度里（和计分的测试一样）。
    // 11:00 休息完打电话（152），两间退房房都已退。1307 先做：走 8 分钟，160 到 190 做完，正好赶上时限 190；
    // 再做 1201（走 9 分钟，199 到 229），收工走 1 分钟加 5 分钟，235。先做 1201 的话 1307 要 222 才做完，罚 20 分钟。
    const world = controlledWorld({ 1201: departure(), 1307: departure() });
    const reached = play(world, afterBreak(world), act.call());
    const state: State = {
      ...reached,
      rooms: reached.rooms.map((room) => (room.id === 1307 ? { ...room, rushDeadline: 190 } : room)),
    };
    const plan = planOf(world, state);
    expect(plan.actions[0]).toStrictEqual(act.service(1307));
    expect(plan.equivalentFinish).toBe(235);
    expect(score(world, replay(world, state, plan).final).equivalentFinish).toBe(235);
  });

  it('搜索之前已经超时做完的贵宾房也算罚时：计划给出的成绩照样和计分相同', () => {
    // 1201 的贵宾时限 20：打电话（2）、走 1 分钟、33 才做完，已经超时。之后原地等到走回服务间正好 10:30，休息到 150，
    // 收工 155，加贵宾超时的 30，185。
    const world = controlledWorld({ 1201: departure({ vipDeadline: 20 }) });
    const state = play(world, initial(world), act.call(), act.service(1201));
    expect(progress(state, 1201).doneAt).toBe(33);
    const plan = planOf(world, state);
    expect(plan.equivalentFinish).toBe(185);
    expect(score(world, replay(world, state, plan).final)).toMatchObject({
      equivalentFinish: 185,
      penalties: { vipLate: 30, rushLate: 0, unfinished: 0 },
    });
  });

  it('催房时限按真相计分：搜索之前已经超时做完的、到收工也没做完的，都按 params 的每间罚时算', () => {
    // 同样是手工写进可达状态的催房时限。1201 在 166 做完，时限 160，已经超时；1202 到 17:00 也没做，时限 200。
    // 17:00 在门位 1 还车：走 1 分钟加 5 分钟，516；1202 未完成罚 45，两间催房超时各罚 20，共 601。
    const world = controlledWorld({ 1201: stayover(), 1202: stayover() });
    const reached = waitUntil(world, play(world, afterBreak(world), act.service(1201)), 510);
    expect(progress(reached, 1201).doneAt).toBe(166);
    const deadlines = new Map([
      [1201, 160],
      [1202, 200],
    ]);
    const state: State = {
      ...reached,
      rooms: reached.rooms.map((room) => ({ ...room, rushDeadline: deadlines.get(room.id) ?? null })),
    };
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.finish()]);
    expect(plan.equivalentFinish).toBe(601);
    expect(score(world, replay(world, state, plan).final)).toMatchObject({
      equivalentFinish: 601,
      penalties: { vipLate: 0, rushLate: 40, unfinished: 45 },
    });
  });

  it('不敲会被拒的门：客人 170 出门，全知原地等到 166 出发，170 正好到门口；新手先去敲门被拒', () => {
    // 1207 在门位 4，从服务间走 4 分钟。185 做完，收工走 4 分钟加 5 分钟，194。
    const world = controlledWorld({ 1207: stayover({ availableFrom: 170 }) });
    const state = afterBreak(world);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.wait(5), act.wait(5), act.wait(5), act.wait(1), act.service(1207), act.finish()]);
    const { entries } = replay(world, state, plan);
    expect(entries.some((entry) => entry.outcome.type === 'knockRefused')).toBe(false);
    expect(entries[4]).toMatchObject({ start: 166, end: 185, outcome: { type: 'cleaned', room: 1207, minutes: 15 } });
    expect(plan.equivalentFinish).toBe(194);
    // 新手 150 出发，154 敲门被拒，回来时间 180，晚得多。
    expect(noviceScore(world, state).equivalentFinish).toBeGreaterThan(194);
  });

  it('敲门被拒过的房间：遵守客人说的回来时间 105，哪怕全知知道客人 100 就出门了', () => {
    // 开工就去 1201，客人 100 才出门：1 分钟到门口，被拒，回来时间 105。全知在门口等到 105 再进门，120 做完，
    // 走 1 分钟回服务间正好 10:30，休息到 151，收工 156。按真相 100 就进门的计划不合法。
    const world = controlledWorld({ 1201: stayover({ availableFrom: 100 }) });
    const state = play(world, initial(world), act.service(1201));
    expect(last(state).outcome).toStrictEqual({ type: 'knockRefused', room: 1201, comeBackAt: 105 });
    const plan = planOf(world, state);
    const { final, entries } = replay(world, state, plan);
    expect(entries.find((entry) => entry.action.type === 'service')?.start).toBe(105);
    expect(progress(final, 1201).doneAt).toBe(120);
    expect(plan.equivalentFinish).toBe(156);
  });

  it('休息放在空等的时候：客人 150 才出门，10:30 先休息，11:00 正好去做', () => {
    // 1201、1202 都在门位 1。在服务间等到 120 休息，150 出发，151 到门口，两间做完 181，收工 187。
    // 先做房间再休息要 216。
    const world = controlledWorld({ 1201: stayover({ availableFrom: 150 }), 1202: stayover({ availableFrom: 150 }) });
    const start = initial(world);
    const plan = planOf(world, start);
    expect(leadingWait(plan)).toBe(120);
    const { entries } = replay(world, start, plan);
    const rest = entries.find((entry) => entry.action.type === 'break');
    expect([rest?.start, rest?.end]).toStrictEqual([120, 150]);
    expect(plan.equivalentFinish).toBe(187);
  });

  it('17:00 前做不完剩下的房间：先回服务间补一次货，在那里等到 17:00，还车不用再走路', () => {
    // 11:00 休息完，等到 476 去做门位 4 的 1208（480 到，495 做完）。剩下的 1207 是没标记的退房房，
    // 打电话加打扫要到 527，来不及。补货 495 + 4 + 5 = 504，等到 510，还车 515，1207 未完成罚 45，共 560。
    // 原地等到 510 再走回去还车是 519 + 45 = 564；新手打电话问出 1207，做到 17:00 被截断，也是 564。
    const world = controlledWorld({ 1207: departure(), 1208: stayover() });
    const state = play(world, waitUntil(world, afterBreak(world), 476), act.service(1208));
    expect(state.minute).toBe(495);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.restock(), act.wait(5), act.wait(1), act.finish()]);
    expect(plan.source).toBe('search');
    expect(plan.equivalentFinish).toBe(560);
    expect(score(world, replay(world, state, plan).final)).toMatchObject({ finishMinute: 515, equivalentFinish: 560 });
    expect(noviceScore(world, state).equivalentFinish).toBe(564);
  });
});

describe('全知：布草', () => {
  it('补货补到 params 的容量：紧档 6 份，七间退房房要 14 份，开工满车之外要补两次货', () => {
    const world = controlledWorld(
      {
        1201: departure(),
        1202: departure(),
        1203: departure(),
        1204: departure(),
        1205: departure(),
        1206: departure(),
        1207: departure(),
      },
      { tier: 'tight' },
    );
    const start = initial(world);
    expect(start.cart).toBe(6);
    const plan = planOf(world, start);
    expect(typesOf(plan).filter((type) => type === 'restock')).toHaveLength(2);
    const { final } = replay(world, start, plan);
    expect(final.rooms.filter((room) => room.doneAt !== null)).toHaveLength(7);
    expect(score(world, final).equivalentFinish).toBe(plan.equivalentFinish);
  });
});

describe('全知：14:30、17:00 和班次结束', () => {
  it('14:30 起还没休息：只能休息，全知就去休息', () => {
    const world = controlledWorld({ 1201: stayover() });
    const state = waitUntil(world, initial(world), 360);
    expect(decide(world, state)).toStrictEqual(act.break());
    const plan = planOf(world, state);
    expect(score(world, replay(world, state, plan).final).equivalentFinish).toBe(plan.equivalentFinish);
  });

  it('14:30 以前就得先休息：客人 14:30 才出门，原地等到那时已经只能休息，全知 358 就去休息，回来再做', () => {
    // 做完门位 4 的 1208（19）以后原地等到 358，还没休息。1207（门位 4）的客人 360 才出门，等到 360 就只能休息了。
    // 358 去休息：走 4 分钟，362 到 392；回来 396 到 411 做完 1207；收工走 4 分钟加 5 分钟，420。
    const world = controlledWorld({ 1207: stayover({ availableFrom: 360 }), 1208: stayover() });
    const state = waitUntil(world, play(world, initial(world), act.service(1208)), 358);
    expect(state.breakTaken).toBe(false);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.break(), act.service(1207), act.finish()]);
    expect(plan.equivalentFinish).toBe(420);
  });

  it('14:30 起还没休息、车里没有布草：先休息，再补货，再去做剩下的房间', () => {
    // 打电话标记四间退房房，做完 1201 到 1204 用光 8 份布草（124，门位 2），原地等到 360。
    // 休息：走 2 分钟，362 到 392；补货 397；1205（门位 3）走 3 分钟，400 到 415；收工走 3 分钟加 5 分钟，423。
    // 补货排在休息前面不合法（14:30 起下一个动作只能是休息）；不补货就做不了 1205。
    const world = controlledWorld({
      1201: departure(),
      1202: departure(),
      1203: departure(),
      1204: departure(),
      1205: stayover(),
    });
    const done = play(world, initial(world), act.call(), act.service(1201), act.service(1202), act.service(1203), act.service(1204));
    expect([done.minute, done.cart]).toStrictEqual([124, 0]);
    const state = waitUntil(world, done, 360);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.break(), act.restock(), act.service(1205), act.finish()]);
    expect(plan.equivalentFinish).toBe(423);
  });

  it('17:00 起只能还车：计划就是收工还车，没做完的房间按未完成计分', () => {
    const world = controlledWorld({ 1201: stayover() });
    const state = waitUntil(world, play(world, waitUntil(world, initial(world), 360), act.break()), 510);
    const plan = planOf(world, state);
    expect(plan.actions).toStrictEqual([act.finish()]);
    expect(decide(world, state)).toStrictEqual(act.finish());
    // 510 在服务间还车，515；1201 没做完，罚 45。
    expect(plan.equivalentFinish).toBe(560);
    expect(last(replay(world, state, plan).final).outcome).toStrictEqual({ type: 'finished' });
  });

  it('班次结束以后、或者带着待回应的事件时调用，抛出中文报错', () => {
    const world = controlledWorld({});
    const ended = play(world, waitUntil(world, play(world, waitUntil(world, initial(world), 360), act.break()), 510), act.finish());
    expect(ended.ended).toBe('hardStop');
    expect(errorOf(() => decide(world, ended))).toMatch('班次已经结束');
    // 阶段 0 推不出带着待回应事件的状态，手工拼一个（和 observe 的测试一样）。
    const prompted: State = {
      ...initial(world),
      prompt: {
        eventIndex: 0,
        event: { type: 'extraTowels', at: 10 },
        options: [{ id: 'deliver', minutes: 2, violation: false, endsShift: false }],
      },
    };
    expect(errorOf(() => decide(world, prompted))).toMatch(CHINESE);
  });

  it('state 和 world 的房间对不上时抛出中文报错', () => {
    const standard = generate('mismatch', PARAMS.standard);
    const odd = generate('mismatch', ODD_PARAMS);
    // 对照：配上各自的状态不抛错。
    expect(() => decide(standard, initial(standard))).not.toThrow();
    expect(errorOf(() => decide(standard, initial(odd)))).toMatch(CHINESE);
  });
});

describe('全知：新手的走法也是候选，束宽从 params 读', () => {
  /** 前 200 个种子里，开工时的计划满足 holds 的那些。 */
  function seedsWhere(params: Params, holds: (world: World, plan: OraclePlan) => boolean): string[] {
    const found: string[] = [];
    for (let i = 0; i < 200 && found.length < 3; i++) {
      const world = generate(`oracle-${i}`, params);
      if (holds(world, planOf(world, initial(world)))) found.push(world.seed);
    }
    return found;
  }

  const NARROW: Params = { ...PARAMS.standard, oracle: { beamWidth: 1 } };

  it('束宽为 1 时，有的班次开工时新手的走法更好：计划就是新手的走法，第一个动作就是新手的第一个动作', () => {
    const seeds = seedsWhere(NARROW, (_world, plan) => plan.source === 'novice');
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) {
      const world = generate(seed, NARROW);
      const start = initial(world);
      const plan = planOf(world, start);
      // 新手自己做一遍：动作序列和成绩都和计划相同。
      const actions: Action[] = [];
      let current = start;
      while (current.ended === null) {
        const action = novice(deepFreeze(observe(world, current)), world.params);
        actions.push(action);
        current = apply(world, current, action);
      }
      expect(plan.actions, seed).toStrictEqual(actions);
      expect(plan.equivalentFinish, seed).toBe(score(world, current).equivalentFinish);
      expect(decide(world, start), seed).toStrictEqual(actions[0]);
    }
  });

  it('束宽从 params.oracle.beamWidth 读：有的班次束宽 1 的计划严格比束宽 24 的差；束宽不是正整数时抛错', () => {
    const seeds = seedsWhere(NARROW, (world, plan) => {
      const wide = generate(world.seed, PARAMS.standard);
      return plan.equivalentFinish > planOf(wide, initial(wide)).equivalentFinish;
    });
    expect(seeds.length).toBeGreaterThan(0);
    for (const beamWidth of [0, -1, 2.5, Number.NaN]) {
      const world = generate('width', { ...PARAMS.standard, oracle: { beamWidth } });
      expect(errorOf(() => decide(world, initial(world)))).toMatch('束宽');
    }
  });
});
