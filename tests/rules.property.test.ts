/**
 * rules 的性质测试。
 *
 * fast-check 生成种子字符串、难度档和一串下标；第 k 步取 legalActions[下标 % 长度]，下标循环使用。
 * 规模：每条性质跑几十到一百个班次，整个 npm test 在本机几十秒内跑完。
 * 生成器、规模、playShift 和几个小工具在 tests/helpers/play.ts，换一套参数用的 ODD_PARAMS 在 tests/helpers/params.ts。
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { generate } from '../src/engine/generate';
import { allRooms, walkMinutes, walkPath } from '../src/engine/layout';
import { PARAMS } from '../src/engine/params';
import { apply, cleanMinutes, initial, legalActions } from '../src/engine/rules';
import type { Action, LogEntry, Place, RoomId, RoomProgress, State, World } from '../src/engine/types';
import { hideDifferently } from './helpers/hidden';
import { numbersUsedByRules, ODD_PARAMS } from './helpers/params';
import {
  at,
  choose,
  deepFreeze,
  lastOf,
  objectsIn,
  picksArb,
  playShift,
  RUNS,
  seedArb,
  tierArb,
  TIERS,
  TIMEOUT,
} from './helpers/play';

/** State 恰好有这十个字段（按字母排序）。不加累计步行之类的字段：步行分钟只记在每条日志的 walk 里。 */
const STATE_KEYS = ['breakTaken', 'cart', 'ended', 'firedEvents', 'log', 'minute', 'place', 'prompt', 'rooms', 'violation'];
/** 每条日志恰好有这八个字段（按字母排序）。 */
const LOG_ENTRY_KEYS = ['action', 'end', 'from', 'noticedLifted', 'outcome', 'start', 'to', 'walk'];

function samePlace(a: Place, b: Place): boolean {
  return a.floor === b.floor && a.door === b.door;
}

function sameAction(a: Action, b: Action): boolean {
  switch (a.type) {
    case 'service':
      return b.type === 'service' && b.room === a.room;
    case 'wait':
      return b.type === 'wait' && b.minutes === a.minutes;
    case 'respond':
      return b.type === 'respond' && b.option === a.option;
    default:
      return b.type === a.type;
  }
}

/** apply 的结果：成功记为 'ok'，抛错记为报错消息。 */
function verdict(world: World, state: State, action: Action): string {
  try {
    apply(world, state, action);
    return 'ok';
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 拿来检查合法性的一组动作：每间房、不存在的房号、各种等待分钟数，以及其余动作。 */
function candidates(world: World, state: State): Action[] {
  const max = Math.min(world.params.waitStepMinutes, world.params.shift.hardStop - state.minute);
  return [
    ...world.rooms.map((room): Action => ({ type: 'service', room: room.id })),
    { type: 'service', room: 1499 },
    { type: 'restock' },
    { type: 'call' },
    { type: 'break' },
    { type: 'wait', minutes: 0 },
    { type: 'wait', minutes: 1 },
    { type: 'wait', minutes: 1.5 },
    { type: 'wait', minutes: max },
    { type: 'wait', minutes: max + 1 },
    { type: 'finish' },
    { type: 'respond', option: 'continue' },
  ];
}

/**
 * 按路过和停留的规则，这条动作应当新看到摘牌的请勿打扰房：
 * 步行途中每到一个门位（含起点和终点）在到达的那一分钟观察一次，动作结束时在所在门位再观察一次。
 * 电话先得知的摘牌不算在这里。
 */
function expectedNoticed(world: World, before: State, entry: LogEntry): RoomId[] {
  const { params } = world;
  const walks = entry.action.type !== 'call' && entry.action.type !== 'wait';
  const visits = walks
    ? walkPath(entry.from, entry.to, params).map((step) => ({ place: step.place, minute: entry.start + step.offset }))
    : [];
  visits.push({ place: entry.to, minute: entry.end });
  const byCall = entry.outcome.type === 'called' ? entry.outcome.newlyLifted : [];
  const noticed = world.rooms.filter((room, index) => {
    if (room.kind !== 'dnd' || room.dndLiftsAt === null) return false;
    if (at(before.rooms, index).dndLiftKnown || byCall.includes(room.id)) return false;
    const liftsAt = room.dndLiftsAt;
    return visits.some((visit) => samePlace(visit.place, room.place) && liftsAt <= visit.minute);
  });
  return noticed.map((room) => room.id);
}

/** 一条日志和它前后的状态符合这个动作的规则。 */
function expectEntryFollowsRules(world: World, before: State, after: State, entry: LogEntry): void {
  const { params } = world;
  const hardStop = params.shift.hardStop;
  const service = params.layout.servicePoint;
  const arrive = entry.start + entry.walk;
  const action = entry.action;
  let target = -1;

  switch (action.type) {
    case 'service': {
      target = world.rooms.findIndex((room) => room.id === action.room);
      const room = at(world.rooms, target);
      const was = at(before.rooms, target);
      const now = at(after.rooms, target);
      const outcome = entry.outcome;
      expect(entry.to).toEqual(room.place);
      if (outcome.type === 'knockRefused') {
        // 只有续住房和请勿打扰房会被拒：到门口时客人还在。不扣布草，不开门。
        expect(room.kind).not.toBe('departure');
        expect(arrive).toBeLessThan(room.availableFrom);
        expect(entry.end).toBe(arrive + params.knockRefusedMinutes);
        const comeBackAt = Math.ceil(room.availableFrom / params.comeBackRounding) * params.comeBackRounding;
        expect(outcome).toEqual({ type: 'knockRefused', room: room.id, comeBackAt });
        expect(now).toStrictEqual({ ...was, knownAvailableFrom: comeBackAt });
        expect(after.cart).toBe(before.cart);
        break;
      }
      // 进了门：退房房已标记；续住房和请勿打扰房到门口时客人已出门。workDone 为 0 时开门扣布草。
      if (room.kind === 'departure') expect(was.flaggedDeparted).toBe(true);
      else expect(arrive).toBeGreaterThanOrEqual(room.availableFrom);
      const linen = room.kind === 'departure' ? params.rooms.departure.linen : params.rooms.stayover.linen;
      expect(after.cart).toBe(was.workDone === 0 ? before.cart - linen : before.cart);
      const total = cleanMinutes(room.kind, room.mess, params);
      const remaining = total - was.workDone;
      if (outcome.type === 'cleaned') {
        expect(arrive + remaining).toBeLessThanOrEqual(hardStop);
        expect(outcome).toEqual({ type: 'cleaned', room: room.id, minutes: remaining });
        expect(entry.end).toBe(arrive + remaining);
        expect(now).toStrictEqual({ ...was, doneAt: entry.end, workDone: total, messRevealed: true });
      } else if (outcome.type === 'interrupted') {
        expect(arrive + remaining).toBeGreaterThan(hardStop);
        expect(entry.end).toBe(hardStop);
        const workDone = was.workDone + (hardStop - arrive);
        expect(outcome).toEqual({ type: 'interrupted', room: room.id, workDone, reason: 'hardStop' });
        expect(now).toStrictEqual({ ...was, workDone, messRevealed: true });
      } else {
        throw new Error(`打扫的结果不该是 ${outcome.type}`);
      }
      break;
    }
    case 'restock':
      expect(entry.to).toEqual(service);
      expect(entry.end).toBe(arrive + params.cart.restockMinutes);
      expect(entry.outcome).toEqual({ type: 'restocked' });
      expect(after.cart).toBe(params.cart.capacity);
      break;
    case 'call': {
      const hangUp = entry.start + params.callMinutes;
      expect(entry.end).toBe(hangUp);
      expect(entry.to).toEqual(entry.from);
      expect(entry.walk).toBe(0);
      const departed = world.rooms.filter(
        (room, index) => room.kind === 'departure' && !at(before.rooms, index).flaggedDeparted && room.availableFrom <= hangUp,
      );
      const lifted = world.rooms.filter(
        (room, index) =>
          room.kind === 'dnd' && !at(before.rooms, index).dndLiftKnown && room.dndLiftsAt !== null && room.dndLiftsAt <= hangUp,
      );
      expect(entry.outcome).toEqual({
        type: 'called',
        newlyDeparted: departed.map((room) => room.id),
        newlyLifted: lifted.map((room) => room.id),
      });
      expect(entry.noticedLifted).toEqual([]);
      expect(after.cart).toBe(before.cart);
      break;
    }
    case 'break':
      expect(before.breakTaken).toBe(false);
      expect(after.breakTaken).toBe(true);
      expect(entry.to).toEqual(service);
      expect(entry.end).toBe(arrive + params.shift.breakMinutes);
      expect(entry.outcome).toEqual({ type: 'breakTaken' });
      expect(after.cart).toBe(before.cart);
      break;
    case 'wait':
      expect(entry.end).toBe(entry.start + action.minutes);
      expect(entry.to).toEqual(entry.from);
      expect(entry.walk).toBe(0);
      expect(entry.outcome).toEqual({ type: 'waited', minutes: action.minutes });
      expect(after.cart).toBe(before.cart);
      break;
    case 'finish':
      expect(entry.to).toEqual(service);
      expect(entry.end).toBe(arrive + params.shift.returnCartMinutes);
      expect(entry.outcome).toEqual({ type: 'finished' });
      expect(after.ended).toBe(entry.start >= hardStop ? 'hardStop' : 'returned');
      expect(after.cart).toBe(before.cart);
      break;
    case 'respond':
      throw new Error('阶段 0 没有事件，不该出现 respond');
  }

  if (action.type !== 'finish') expect(after.ended).toBeNull();
  if (action.type !== 'break') expect(after.breakTaken).toBe(before.breakTaken);

  // 路过和停留：按 world.rooms 的顺序、不重复，恰好是按规则应当看到的那些。
  expect(entry.noticedLifted).toEqual(expectedNoticed(world, before, entry));

  // 其余房间：只有电话会改已退标记；只有电话、路过和停留会改已知摘牌；别的字段都不变。
  const byCall = entry.outcome.type === 'called' ? entry.outcome.newlyLifted : [];
  const departedByCall = entry.outcome.type === 'called' ? entry.outcome.newlyDeparted : [];
  world.rooms.forEach((room, index) => {
    if (index === target) return;
    const was = at(before.rooms, index);
    const now = at(after.rooms, index);
    expect(now.flaggedDeparted).toBe(was.flaggedDeparted || departedByCall.includes(room.id));
    expect(now.dndLiftKnown).toBe(was.dndLiftKnown || byCall.includes(room.id) || entry.noticedLifted.includes(room.id));
    expect({ ...now, flaggedDeparted: false, dndLiftKnown: false }).toStrictEqual({
      ...was,
      flaggedDeparted: false,
      dndLiftKnown: false,
    });
  });
}

/**
 * 不经过 rules，按合法性的优先级、各动作的条件和列表的顺序，从世界和状态直接算出的合法动作列表，用来对照 legalActions。
 * 只用玩家已知的字段：任务单上的房号、房型、门位，以及房间进度。
 */
function expectedLegalActions(world: World, state: State): Action[] {
  const { params } = world;
  const { hardStop, breakEarliest, breakLatest } = params.shift;
  // 优先级：班次结束；待回应的事件（阶段 0 没有）；17:00 起只能还车；14:30 起还没休息只能休息。
  if (state.ended !== null) return [];
  if (state.prompt !== null) throw new Error('阶段 0 不该有待回应的事件');
  if (state.minute >= hardStop) return [{ type: 'finish' }];
  if (!state.breakTaken && state.minute >= breakLatest) return [{ type: 'break' }];

  const toService = walkMinutes(state.place, params.layout.servicePoint, params);
  const legal: Action[] = [];
  world.rooms.forEach((room, index) => {
    const known = at(state.rooms, index);
    if (known.doneAt !== null) return;
    if (room.kind === 'departure' && !known.flaggedDeparted) return;
    if (room.kind === 'dnd' && !known.dndLiftKnown) return;
    const arrive = state.minute + walkMinutes(state.place, room.place, params);
    if (known.knownAvailableFrom !== null && arrive < known.knownAvailableFrom) return;
    if (arrive + params.knockRefusedMinutes > hardStop) return;
    const linen = room.kind === 'departure' ? params.rooms.departure.linen : params.rooms.stayover.linen;
    if (known.workDone === 0 && state.cart < linen) return;
    legal.push({ type: 'service', room: room.id });
  });
  if (state.minute + toService + params.cart.restockMinutes <= hardStop) legal.push({ type: 'restock' });
  if (state.minute + params.callMinutes <= hardStop) legal.push({ type: 'call' });
  if (!state.breakTaken && state.minute + toService >= breakEarliest) legal.push({ type: 'break' });
  // 这时 minute < hardStop，上限至少是 1，等待总是合法。
  legal.push({ type: 'wait', minutes: Math.min(params.waitStepMinutes, hardStop - state.minute) });
  // 挡收工的：没做完的退房房和续住房，以及已知摘牌却没做完的请勿打扰房。
  const blocking = world.rooms.filter((room, index) => {
    const known = at(state.rooms, index);
    return known.doneAt === null && (room.kind !== 'dnd' || known.dndLiftKnown);
  });
  if (state.breakTaken && blocking.length === 0) legal.push({ type: 'finish' });
  return legal;
}

describe('性质：确定性', () => {
  it(
    '同一种子、同一串下标跑两次，最终状态完全相同，JSON 序列化的结果也相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const first = lastOf(playShift(generate(seed, PARAMS[tier]), picks).states);
          const second = lastOf(playShift(generate(seed, PARAMS[tier]), picks).states);
          expect(second).toStrictEqual(first);
          expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：合法性', () => {
  it(
    '布草在 0 到容量之间；每步至少 1 分钟；没结束时总有合法动作且列表里的都能执行；步数有上界；结束后没有合法动作',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const world = generate(seed, PARAMS[tier]);
          const { capacity } = world.params.cart;
          const limit = world.params.shift.hardStop + world.events.length + 1;
          let state = initial(world);
          let steps = 0;
          for (;;) {
            expect(state.cart).toBeGreaterThanOrEqual(0);
            expect(state.cart).toBeLessThanOrEqual(capacity);
            const legal = legalActions(world, state);
            if (state.ended !== null) {
              expect(legal).toEqual([]);
              break;
            }
            expect(legal.length).toBeGreaterThan(0);
            expect(legal.some((action) => action.type === 'respond')).toBe(false);
            for (const action of legal) expect(verdict(world, state, action), JSON.stringify(action)).toBe('ok');
            const next = apply(world, state, choose(legal, picks, steps));
            expect(next.minute).toBeGreaterThanOrEqual(state.minute + 1);
            state = next;
            steps++;
            expect(steps).toBeLessThanOrEqual(limit);
          }
          expect(['returned', 'hardStop']).toContain(state.ended);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'apply 恰好接受 legalActions 里的动作；等待接受 1 到列表里那个上限之间的整数',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          states.forEach((state, index) => {
            // 抽查：每 3 步查一次，最后的状态也查。
            if (index % 3 !== 0 && index !== states.length - 1) return;
            const legal = legalActions(world, state);
            for (const action of candidates(world, state)) {
              const listed =
                action.type === 'wait'
                  ? Number.isInteger(action.minutes) &&
                    action.minutes >= 1 &&
                    legal.some((other) => other.type === 'wait' && action.minutes <= other.minutes)
                  : legal.some((other) => sameAction(other, action));
              const accepted = verdict(world, state, action) === 'ok';
              expect(accepted, `${state.minute} 分钟 ${JSON.stringify(action)}`).toBe(listed);
            }
          });
        }),
        { numRuns: 50 },
      );
    },
    TIMEOUT,
  );

  it(
    '17:00 之后只能还车；还没休息时，休息合法当且仅当到达服务间不早于 10:30，14:30 起只能休息',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          const { breakEarliest, breakLatest, hardStop } = world.params.shift;
          const service = world.params.layout.servicePoint;
          for (const state of states) {
            if (state.ended !== null) continue;
            const legal = legalActions(world, state);
            if (state.minute >= hardStop) {
              expect(legal).toEqual([{ type: 'finish' }]);
              continue;
            }
            if (state.breakTaken) {
              expect(legal.some((action) => action.type === 'break')).toBe(false);
              continue;
            }
            if (state.minute >= breakLatest) {
              expect(legal).toEqual([{ type: 'break' }]);
              continue;
            }
            const canRest = state.minute + walkMinutes(state.place, service, world.params) >= breakEarliest;
            expect(legal.some((action) => action.type === 'break')).toBe(canRest);
            // 240 及以后从任何位置都可以休息。
            if (state.minute >= 240) expect(canRest).toBe(true);
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：合法动作列表', () => {
  it(
    '每个状态的 legalActions 与按合法性规则直接算出的列表完全相同，顺序也相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          for (const state of states) {
            expect(legalActions(world, state), `${state.minute} 分钟`).toStrictEqual(expectedLegalActions(world, state));
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：数值都从 world.params 读', () => {
  it('这套参数里 rules 用到的每项数值都和三档不同', () => {
    const odd = numbersUsedByRules(ODD_PARAMS);
    for (const tier of TIERS) {
      const base = numbersUsedByRules(PARAMS[tier]);
      for (const [name, value] of Object.entries(odd)) expect(value, `${tier} 档的 ${name}`).not.toBe(base[name]);
    }
  });

  it(
    '换一套参数：开工状态、合法动作列表、每条日志的结果和状态变化、日志不变量、休息规则都按 world.params 成立',
    () => {
      fc.assert(
        fc.property(seedArb, picksArb, (seed, picks) => {
          const world = generate(seed, ODD_PARAMS);
          const { states, actions } = playShift(world, picks);
          const { breakEarliest, breakMinutes } = ODD_PARAMS.shift;

          const start = at(states, 0);
          expect(start.minute).toBe(0);
          expect(start.place).toEqual(ODD_PARAMS.layout.servicePoint);
          expect(start.cart).toBe(ODD_PARAMS.cart.capacity);
          expect(start.rooms.map((room) => room.id)).toEqual(allRooms(ODD_PARAMS));

          for (const state of states) {
            expect(legalActions(world, state), `${state.minute} 分钟`).toStrictEqual(expectedLegalActions(world, state));
          }

          actions.forEach((action, i) => {
            const before = at(states, i);
            const after = at(states, i + 1);
            const entry = lastOf(after.log);
            expect(after.log).toHaveLength(before.log.length + 1);
            expect(entry.start).toBe(before.minute);
            expect(entry.end).toBe(after.minute);
            expect(entry.from).toEqual(before.place);
            expect(entry.to).toEqual(after.place);
            expect(entry.action).toStrictEqual(action);
            expect(entry.walk).toBe(walkMinutes(entry.from, entry.to, world.params));
            expectEntryFollowsRules(world, before, after, entry);
          });

          // 结束的班次恰好休息一次，开始时刻不早于 breakEarliest。
          const final = lastOf(states);
          expect(['returned', 'hardStop']).toContain(final.ended);
          const breaks = final.log.filter((entry) => entry.action.type === 'break');
          expect(breaks).toHaveLength(1);
          expect(at(breaks, 0).end - breakMinutes).toBeGreaterThanOrEqual(breakEarliest);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：休息', () => {
  it(
    '结束的班次恰好休息一次；休息开始时刻（日志 end 减 30）不早于 10:30；还没休息时 14:30 起不开始休息以外的动作',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states, actions } = playShift(generate(seed, PARAMS[tier]), picks);
          const { breakEarliest, breakLatest, breakMinutes } = world.params.shift;
          const final = lastOf(states);
          expect(['returned', 'hardStop']).toContain(final.ended);
          const breaks = final.log.filter((entry) => entry.action.type === 'break');
          expect(breaks).toHaveLength(1);
          const rest = at(breaks, 0);
          expect(rest.outcome).toEqual({ type: 'breakTaken' });
          expect(rest.end - breakMinutes).toBeGreaterThanOrEqual(breakEarliest);
          actions.forEach((action, index) => {
            const before = at(states, index);
            if (!before.breakTaken && before.minute >= breakLatest) {
              expect(['break', 'respond'], `${before.minute} 分钟还没休息`).toContain(action.type);
            }
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：单调', () => {
  it(
    '已标记、已知摘牌、已开门只会从假变真；完成时刻和回来时间一旦设置就不再改变',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { states } = playShift(generate(seed, PARAMS[tier]), picks);
          for (let i = 1; i < states.length; i++) {
            const before = at(states, i - 1);
            const after = at(states, i);
            expect(after.rooms.map((room) => room.id)).toEqual(before.rooms.map((room) => room.id));
            before.rooms.forEach((was, index) => {
              const now = at(after.rooms, index);
              if (was.flaggedDeparted) expect(now.flaggedDeparted).toBe(true);
              if (was.dndLiftKnown) expect(now.dndLiftKnown).toBe(true);
              if (was.messRevealed) expect(now.messRevealed).toBe(true);
              if (was.doneAt !== null) expect(now.doneAt).toBe(was.doneAt);
              if (was.knownAvailableFrom !== null) expect(now.knownAvailableFrom).toBe(was.knownAvailableFrom);
            });
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：日志', () => {
  it(
    '每次 apply 恰好追加一条；start 接上一条的 end（第一条为 0）；minute 等于最后一条的 end；from、to、walk 与状态一致；状态和日志都没有多余的字段',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states, actions } = playShift(generate(seed, PARAMS[tier]), picks);
          // 每个状态恰好是那十个字段，每条日志恰好是那八个字段。
          for (const state of states) expect(Object.keys(state).sort(), `${state.minute} 分钟的状态`).toEqual(STATE_KEYS);
          actions.forEach((action, i) => {
            const before = at(states, i);
            const after = at(states, i + 1);
            expect(after.log).toHaveLength(before.log.length + 1);
            expect(after.log.slice(0, before.log.length)).toStrictEqual(before.log);
            const entry = lastOf(after.log);
            expect(Object.keys(entry).sort(), `第 ${i + 1} 条日志`).toEqual(LOG_ENTRY_KEYS);
            expect(entry.start).toBe(i === 0 ? 0 : lastOf(before.log).end);
            expect(entry.start).toBe(before.minute);
            expect(entry.end).toBe(after.minute);
            expect(entry.from).toEqual(before.place);
            expect(entry.to).toEqual(after.place);
            expect(entry.action).toStrictEqual(action);
            expect(entry.walk).toBe(walkMinutes(entry.from, entry.to, world.params));
          });
          const final = lastOf(states);
          expect(final.minute).toBe(lastOf(final.log).end);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '每条日志的结束时刻、位置、结果和状态变化符合各动作的规则，路过和停留看到的摘牌符合观察规则',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          for (let i = 1; i < states.length; i++) {
            const after = at(states, i);
            expectEntryFollowsRules(world, at(states, i - 1), after, lastOf(after.log));
          }
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：纯函数', () => {
  it(
    '深度冻结的 world、state 和动作上跑随机合法序列不抛错，事先用 structuredClone 存下的副本与运行后的入参相同',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          // 用 params 的副本生成：深度冻结只冻结这个测试自己造的对象，不碰全局共用的 PARAMS。
          const world = deepFreeze(generate(seed, structuredClone(PARAMS[tier])));
          const worldCopy = structuredClone(world);
          const inputs: { state: State; stateCopy: State; action: Action; actionCopy: Action }[] = [];
          let state = deepFreeze(initial(world));
          while (state.ended === null) {
            const action = deepFreeze(structuredClone(choose(legalActions(world, state), picks, inputs.length)));
            inputs.push({ state, stateCopy: structuredClone(state), action, actionCopy: structuredClone(action) });
            state = deepFreeze(apply(world, state, action));
          }
          expect(world).toStrictEqual(worldCopy);
          for (const input of inputs) {
            expect(input.state).toStrictEqual(input.stateCopy);
            expect(input.action).toStrictEqual(input.actionCopy);
          }
        }),
        { numRuns: 50 },
      );
    },
    TIMEOUT,
  );

  it(
    '结构共享：相邻两步之间，内容没变的房间进度是同一个对象，上一步已有的日志条目也是同一个对象',
    () => {
      // 只查共享这一个方向：内容变了的房间换成新对象，已由上面的深度冻结检查（改旧对象会抛错）保证。
      // rooms 数组本身是不是新数组不做要求，相邻两个状态可以共享没变的部分。
      const sameContent = (a: RoomProgress, b: RoomProgress): boolean => JSON.stringify(a) === JSON.stringify(b);
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { states } = playShift(generate(seed, PARAMS[tier]), picks);
          for (let i = 1; i < states.length; i++) {
            const before = at(states, i - 1);
            const after = at(states, i);
            const copiedRooms = before.rooms.flatMap((was, index) => {
              const now = at(after.rooms, index);
              return now !== was && sameContent(now, was) ? [was.id] : [];
            });
            expect(copiedRooms, `第 ${i} 步：内容没变却换了新对象的房间`).toEqual([]);
            const copiedEntries = before.log.flatMap((entry, index) => (at(after.log, index) === entry ? [] : [index]));
            expect(copiedEntries, `第 ${i} 步：换了新对象的旧日志条目`).toEqual([]);
          }
        }),
        { numRuns: 50 },
      );
    },
    TIMEOUT,
  );

  it(
    '返回的状态不与 params 共享对象',
    () => {
      fc.assert(
        fc.property(seedArb, tierArb, picksArb, (seed, tier, picks) => {
          const { world, states } = playShift(generate(seed, PARAMS[tier]), picks);
          const shared = objectsIn(world.params);
          for (const state of states) {
            for (const object of objectsIn(state)) expect(shared.has(object)).toBe(false);
          }
        }),
        { numRuns: 30 },
      );
    },
    TIMEOUT,
  );

  it(
    '整局运行时把 Math.random 和 Date.now 换成会抛错的桩，结果不变',
    () => {
      // 在 fast-check 之外准备好世界和下标序列，并先不换桩跑一遍，得到对照结果。
      const samples = fc.sample(fc.tuple(seedArb, tierArb, picksArb), { numRuns: 30, seed: 20261114 });
      const cases = samples.map(([seed, tier, picks]) => ({ world: generate(seed, PARAMS[tier]), picks }));
      const expected = cases.map(({ world, picks }) => lastOf(playShift(world, picks).states));

      // 只在直接调用引擎的这段代码里换桩，用 try/finally 恢复。这段代码里不调用 expect。
      let randomCalls = 0;
      let nowCalls = 0;
      const random = vi.spyOn(Math, 'random').mockImplementation(() => {
        randomCalls++;
        throw new Error('引擎不该调用 Math.random');
      });
      const now = vi.spyOn(Date, 'now').mockImplementation(() => {
        nowCalls++;
        throw new Error('引擎不该调用 Date.now');
      });
      let finals: State[] = [];
      let failure: unknown = null;
      try {
        finals = cases.map(({ world, picks }) => lastOf(playShift(world, picks).states));
      } catch (error) {
        failure = error;
      } finally {
        random.mockRestore();
        now.mockRestore();
      }

      expect(failure).toBeNull();
      expect(randomCalls).toBe(0);
      expect(nowCalls).toBe(0);
      expect(finals).toStrictEqual(expected);
    },
    TIMEOUT,
  );
});

describe('性质：不泄露', () => {
  it(
    '只改动前缀结束时玩家仍不知道的隐藏信息（完全没揭晓的，以及只知道范围的）：同一前缀在两个世界里都合法，状态和合法动作完全相同，非法动作的报错文字也相同',
    () => {
      fc.assert(
        fc.property(
          seedArb,
          tierArb,
          picksArb,
          fc.nat({ max: 120 }),
          fc.array(fc.nat(), { minLength: 1, maxLength: 64 }),
          (seed, tier, picks, prefixLength, noise) => {
            const world = generate(seed, PARAMS[tier]);
            const { states, actions } = playShift(world, picks, prefixLength);
            const end = lastOf(states);
            // 第二个世界的构造见 tests/helpers/hidden.ts：改动的范围从前缀的日志推出，推错了下面逐步比较状态就会失败。
            const other = hideDifferently(world, end, noise);

            // 同一前缀在第二个世界里逐步执行：每一步合法动作相同，执行后的状态相同。
            let state = initial(other);
            expect(state).toStrictEqual(at(states, 0));
            actions.forEach((action, i) => {
              expect(legalActions(other, state)).toStrictEqual(legalActions(world, at(states, i)));
              state = apply(other, state, action);
              expect(state).toStrictEqual(at(states, i + 1));
            });
            expect(state).toStrictEqual(end);
            expect(legalActions(other, state)).toStrictEqual(legalActions(world, end));

            // 前缀结束时，非法动作在两个世界里的报错文字相同（合法动作两边都不抛错）。
            for (const action of candidates(world, end)) {
              expect(verdict(other, state, action), JSON.stringify(action)).toBe(verdict(world, end, action));
            }
          },
        ),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});
