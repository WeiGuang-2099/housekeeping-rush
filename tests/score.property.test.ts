/**
 * score 的性质测试。
 *
 * 班次用两种挑法从开工跑到结束：playShift 默认的均匀随机挑法，多半拖到 17:00 强制下班，留下各种没做完的房间；
 * 这里的勤快挑法，能收工时多半收工，有房间能做时多半去做，在三档下常常自己收工。两种挑法都在三档和 ODD_PARAMS 下跑。
 * ODD_PARAMS 的活太多，两种挑法都不会自己收工（见 tests/helpers.test.ts），它的自己收工由 tests/score.test.ts 的
 * 受控世界覆盖；自己收工那条性质只在三档下跑。
 * 阶段 0 没有事件，催房时限恒为 null。对照计分规则、成绩的结构、纯函数的两条性质和末尾的自检，都在结束时的状态上
 * 随机写进几个催房时限，覆盖催房这一项。这些情形确实都走到了，由文件末尾的自检确认。
 * 生成器、规模和 playShift 在 tests/helpers/play.ts，ODD_PARAMS 在 tests/helpers/params.ts。
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { generate } from '../src/engine/generate';
import { walkMinutes } from '../src/engine/layout';
import { PARAMS, type Params } from '../src/engine/params';
import { score } from '../src/engine/score';
import type { Clue, MessLevel, Minute, RoomId, RoomProgress, RoomTruth, Score, State, World } from '../src/engine/types';
import { numbersIn } from './helpers/drive';
import { numbersUsedByScore, ODD_PARAMS } from './helpers/params';
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
  TIERS,
  TIMEOUT,
  type Chooser,
  type Trace,
} from './helpers/play';

/** fc.sample 的固定种子。 */
const SAMPLE_SEED = 20261116;

/**
 * 对照计分规则的性质、自己收工的那条性质和末尾的自检多跑一些：自己收工、又有摘了牌玩家却不知道的请勿打扰房的班次
 * 很少，三档和 ODD_PARAMS、两种挑法混在一起抽，大约每 40 局才有一局。一局从开工跑到结束不到 1 毫秒，
 * 多跑几百局只多花几百毫秒。
 */
const WIDE_RUNS = 3 * RUNS;

/** Score 恰好有这七个字段（按字母排序），penalties 恰好有这三个。 */
const SCORE_KEYS = [
  'equivalentFinish',
  'failed',
  'finishMinute',
  'penalties',
  'roomsDone',
  'violation',
  'walkedMinutes',
] as const satisfies readonly (keyof Score)[];
const PENALTY_KEYS = ['rushLate', 'unfinished', 'vipLate'] as const satisfies readonly (keyof Score['penalties'])[];

/**
 * 勤快的挑法：能收工时多半收工；不能收工、有房间能去打扫时多半去打扫；否则在合法动作里挑，
 * 但只在还有退房房没被标记已退时才打电话，不为了请勿打扰房打电话。下标决定具体挑哪个。
 * 均匀随机的挑法很少把房间都做完，几乎总是拖到 17:00 强制下班；这种挑法常常自己收工，而且常常有摘了牌、
 * 玩家却不知道的请勿打扰房，自己收工时的计分才有足够的例子。只读任务单上的房型和状态里已知的已退标记。
 */
const chooseDiligent: Chooser = (legal, picks, step, world, state) => {
  const pick = picks[step % picks.length] ?? 0;
  const finish = legal.find((action) => action.type === 'finish');
  if (finish !== undefined && pick % 4 !== 0) return finish;
  const services = legal.filter((action) => action.type === 'service');
  if (services.length > 0 && pick % 3 !== 0) return at(services, pick % services.length);
  const unflagged = world.rooms.some((room, index) => room.kind === 'departure' && !at(state.rooms, index).flaggedDeparted);
  // 去掉打电话以后不会是空的：17:00 以前总能等待，17:00 起只剩还车。
  const pool = unflagged ? legal : legal.filter((action) => action.type !== 'call');
  return at(pool, pick % pool.length);
};

/** 三档和 ODD_PARAMS。 */
const PARAM_SETS = {
  standard: PARAMS.standard,
  tight: PARAMS.tight,
  weekend: PARAMS.weekend,
  odd: ODD_PARAMS,
} satisfies Record<string, Params>;
type ParamSet = keyof typeof PARAM_SETS;

const CHOOSERS = { uniform: choose, diligent: chooseDiligent } satisfies Record<string, Chooser>;
type ChooserName = keyof typeof CHOOSERS;

/** 一局班次的输入：参数、种子、挑法和下标。 */
interface ShiftInput {
  set: ParamSet;
  seed: string;
  chooser: ChooserName;
  picks: number[];
}

const shiftArb: fc.Arbitrary<ShiftInput> = fc.record({
  set: fc.constantFrom<ParamSet>('standard', 'tight', 'weekend', 'odd'),
  seed: seedArb,
  chooser: fc.constantFrom<ChooserName>('uniform', 'diligent'),
  picks: picksArb,
});

/** 自己收工那条性质的输入：只用三档（ODD_PARAMS 不会自己收工），挑法固定是勤快的，反例里显示的就是实际用的挑法。 */
const returningShiftArb: fc.Arbitrary<ShiftInput> = fc.record({
  set: fc.constantFrom<ParamSet>('standard', 'tight', 'weekend'),
  seed: seedArb,
  chooser: fc.constant<ChooserName>('diligent'),
  picks: picksArb,
});

/** 写进结束时状态的催房时限：挑第几间退房房（下标取模），时限是第几分钟。时限可以晚于 17:00。 */
interface Rush {
  pick: number;
  deadline: Minute;
}

const rushesArb: fc.Arbitrary<Rush[]> = fc.array(fc.record({ pick: fc.nat(), deadline: fc.nat({ max: 520 }) }), {
  maxLength: 3,
});

/** 按输入从开工跑到班次结束。 */
function playToEnd(input: ShiftInput): Trace {
  return playShift(generate(input.seed, PARAM_SETS[input.set]), input.picks, Number.POSITIVE_INFINITY, CHOOSERS[input.chooser]);
}

/**
 * 阶段 0 没有事件，催房时限恒为 null。把催房时限直接写进结束时的状态，当作阶段 2 前台催房以后的样子：
 * 只写给退房房，同一间房写了几次以最后一次为准。没有退房房或者没有时限时原样返回。
 */
function withRushes(world: World, state: State, rushes: readonly Rush[]): State {
  const departures = world.rooms.flatMap((room, index) => (room.kind === 'departure' ? [index] : []));
  if (departures.length === 0 || rushes.length === 0) return state;
  const rooms = state.rooms.slice();
  for (const { pick, deadline } of rushes) {
    const index = at(departures, pick % departures.length);
    rooms[index] = { ...at(rooms, index), rushDeadline: deadline };
  }
  return { ...state, rooms };
}

/** 收工时刻：自己收工是选择收工还车的那一刻（最后一条日志的 start），强制下班就是 17:00。 */
function quitMomentOf(world: World, final: State): Minute {
  return final.ended === 'hardStop' ? world.params.shift.hardStop : lastOf(final.log).start;
}

/** 把对象里能走到的每个数字原地加上 bump() 给的数，逐层走对象和数组。只用在 structuredClone 出来的副本上。 */
function bumpNumbers(node: object, bump: () => number): void {
  const entries: [string, unknown][] = Object.entries(node);
  for (const [key, child] of entries) {
    if (typeof child === 'number') Reflect.set(node, key, child + bump());
    else if (typeof child === 'object' && child !== null) bumpNumbers(child, bump);
  }
}

/** 换掉第 index 间房真相里的几个字段，其余不变。 */
function patchTruth(world: World, index: number, patch: Partial<RoomTruth>): World {
  return { ...world, rooms: world.rooms.map((room, i) => (i === index ? { ...room, ...patch } : room)) };
}

/** 换掉第 index 间房进度里的几个字段，其余不变。 */
function patchProgress(state: State, index: number, patch: Partial<RoomProgress>): State {
  return { ...state, rooms: state.rooms.map((room, i) => (i === index ? { ...room, ...patch } : room)) };
}

/**
 * 不经过 score，按 docs/DESIGN.md 的计分规则从世界和结束时的状态直接算出的成绩，用来对照 score。
 * 每间房的完成时刻从日志里打扫完成的那一条推出，不读 state.rooms 的 doneAt；步行分钟按 walkMinutes 重算，
 * 不读日志的 walk；还车完成的时刻取 state.minute，不读日志。
 */
function expectedScore(world: World, final: State): Score {
  const { params } = world;
  const quitAt = quitMomentOf(world, final);
  const doneAt = new Map<RoomId, Minute>();
  for (const entry of final.log) {
    if (entry.outcome.type === 'cleaned') doneAt.set(entry.outcome.room, entry.end);
  }
  // 有时限，并且没做完或晚于时限做完。
  const late = (deadline: Minute | null, done: Minute | null): boolean =>
    deadline !== null && (done === null || done > deadline);

  let vipLate = 0;
  let rushLate = 0;
  let unfinished = 0;
  world.rooms.forEach((room, index) => {
    const done = doneAt.get(room.id) ?? null;
    if (late(room.vipDeadline, done)) vipLate += params.penalties.vipLate;
    if (late(at(final.rooms, index).rushDeadline, done)) rushLate += params.penalties.rushLate;
    // 退房房和续住房没做完就算；请勿打扰房按真相，摘牌不晚于收工时刻、没做完的才算。
    const counts = room.kind !== 'dnd' || (room.dndLiftsAt !== null && room.dndLiftsAt <= quitAt);
    if (done === null && counts) unfinished += params.penalties.unfinished;
  });

  return {
    finishMinute: final.minute,
    penalties: { vipLate, rushLate, unfinished },
    equivalentFinish: final.minute + vipLate + rushLate + unfinished,
    roomsDone: doneAt.size,
    walkedMinutes: final.log.reduce((sum, entry) => sum + walkMinutes(entry.from, entry.to, params), 0),
    violation: final.violation,
    failed: false,
  };
}

describe('性质：对照计分规则', () => {
  it(
    'score 与按计分规则直接算出的成绩完全相同（三档和 ODD_PARAMS，两种挑法，结束时随机写进催房时限）',
    () => {
      fc.assert(
        fc.property(shiftArb, rushesArb, (input, rushes) => {
          const { world, states } = playToEnd(input);
          const final = withRushes(world, lastOf(states), rushes);
          const result = score(world, final);
          expect(Object.keys(result).sort()).toEqual(SCORE_KEYS);
          expect(Object.keys(result.penalties).sort()).toEqual(PENALTY_KEYS);
          expect(result).toStrictEqual(expectedScore(world, final));
        }),
        { numRuns: WIDE_RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：成绩的结构', () => {
  it(
    '等效下班时间等于还车完成的时刻加三项罚时；每项是每间罚时的整数倍，间数不超过对应的房间数；数字都是非负整数',
    () => {
      fc.assert(
        fc.property(shiftArb, rushesArb, (input, rushes) => {
          const { world, states } = playToEnd(input);
          const final = withRushes(world, lastOf(states), rushes);
          const result = score(world, final);
          const { penalties } = result;
          const unit = world.params.penalties;

          expect(result.finishMinute).toBe(lastOf(final.log).end);
          expect(result.equivalentFinish).toBe(
            result.finishMinute + penalties.vipLate + penalties.rushLate + penalties.unfinished,
          );
          const numbers = [result.finishMinute, result.equivalentFinish, result.roomsDone, result.walkedMinutes];
          for (const value of [...numbers, ...Object.values(penalties)]) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }

          const vipRooms = world.rooms.filter((room) => room.vipDeadline !== null).length;
          const rushRooms = final.rooms.filter((room) => room.rushDeadline !== null).length;
          expect(penalties.vipLate % unit.vipLate).toBe(0);
          expect(penalties.vipLate / unit.vipLate).toBeLessThanOrEqual(vipRooms);
          expect(penalties.rushLate % unit.rushLate).toBe(0);
          expect(penalties.rushLate / unit.rushLate).toBeLessThanOrEqual(rushRooms);
          expect(penalties.unfinished % unit.unfinished).toBe(0);
          expect(penalties.unfinished / unit.unfinished).toBeLessThanOrEqual(world.rooms.length - result.roomsDone);
          expect(result.roomsDone).toBe(final.rooms.filter((room) => room.doneAt !== null).length);
          expect(result.walkedMinutes).toBe(final.log.reduce((sum, entry) => sum + entry.walk, 0));
          expect(result.violation).toBe(false);
          expect(result.failed).toBe(false);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '自己收工时：退房房和续住房全部做完；算未完成的恰好是收工那一刻玩家还不知道已摘牌、摘牌时刻不晚于收工时刻的请勿打扰房',
    () => {
      fc.assert(
        fc.property(returningShiftArb, (input) => {
          const { world, states } = playToEnd(input);
          const final = lastOf(states);
          // 只要自己收工的班次：强制下班的不算一次，fast-check 换一组输入再试。勤快的挑法在三档下四成多自己收工。
          fc.pre(final.ended === 'returned');
          // 收工那一刻的状态，也就是收工还车之前的那一个。
          const before = at(states, states.length - 2);
          const quitAt = before.minute;
          expect(lastOf(final.log).start).toBe(quitAt);
          world.rooms.forEach((room, index) => {
            if (room.kind !== 'dnd') expect(at(final.rooms, index).doneAt, `${room.id}`).not.toBeNull();
          });
          const unknownLifted = world.rooms.filter((room, index) => {
            const known = at(before.rooms, index);
            return room.kind === 'dnd' && !known.dndLiftKnown && room.dndLiftsAt !== null && room.dndLiftsAt <= quitAt;
          });
          expect(score(world, final).penalties.unfinished).toBe(unknownLifted.length * world.params.penalties.unfinished);
        }),
        { numRuns: WIDE_RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：边界和只读该读的', () => {
  it(
    '没做完的请勿打扰房：摘牌时刻改成收工时刻就多算一间未完成；改成收工时刻的下一分钟或整班不摘就不算；只看真相，不看玩家知不知道',
    () => {
      fc.assert(
        fc.property(shiftArb, (input) => {
          const { world, states } = playToEnd(input);
          const final = lastOf(states);
          const quitAt = quitMomentOf(world, final);
          const unit = world.params.penalties.unfinished;
          world.rooms.forEach((room, index) => {
            if (room.kind !== 'dnd' || at(final.rooms, index).doneAt !== null) return;
            const unfinishedIf = (dndLiftsAt: Minute | null): number =>
              score(patchTruth(world, index, { dndLiftsAt }), final).penalties.unfinished;
            const base = unfinishedIf(null);
            expect(unfinishedIf(quitAt), `${room.id} 在收工时刻摘牌`).toBe(base + unit);
            expect(unfinishedIf(quitAt + 1), `${room.id} 在收工以后摘牌`).toBe(base);
            // 玩家知不知道不影响：同一个摘牌时刻，进度里的已知摘牌改成相反的值，结果不变。
            const flipped = patchProgress(final, index, { dndLiftKnown: !at(final.rooms, index).dndLiftKnown });
            expect(score(patchTruth(world, index, { dndLiftsAt: quitAt }), flipped).penalties.unfinished).toBe(base + unit);
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '时限的边界：做完的房间，时限恰好是完成时刻算按时，早一分钟算超时；没做完的房间不管时限是几点都算超时；时限不影响未完成',
    () => {
      fc.assert(
        fc.property(shiftArb, (input) => {
          const { world, states } = playToEnd(input);
          const final = lastOf(states);
          // 先去掉全部贵宾时限（阶段 0 的催房时限本来就是 null），再逐间只给这一间加时限。
          const plain: World = { ...world, rooms: world.rooms.map((room) => ({ ...room, vipDeadline: null })) };
          const base = score(plain, final);
          expect(base.penalties.vipLate).toBe(0);
          expect(base.penalties.rushLate).toBe(0);
          const unit = world.params.penalties;
          final.rooms.forEach((progress, index) => {
            const done = progress.doneAt;
            // 没做完的房间：时限是开工那一刻，或者远在下班以后，都算超时。
            const cases: [Minute, boolean][] =
              done === null
                ? [
                    [0, true],
                    [final.minute + 1000, true],
                  ]
                : [
                    [done, false],
                    [done - 1, true],
                  ];
            for (const [deadline, late] of cases) {
              const label = `${progress.id} 时限 ${deadline}`;
              const vip = score(patchTruth(plain, index, { vipDeadline: deadline }), final);
              expect(vip.penalties.vipLate, label).toBe(late ? unit.vipLate : 0);
              expect(vip.penalties.unfinished, label).toBe(base.penalties.unfinished);
              const rush = score(plain, patchProgress(final, index, { rushDeadline: deadline }));
              expect(rush.penalties.rushLate, label).toBe(late ? unit.rushLate : 0);
              expect(rush.penalties.unfinished, label).toBe(base.penalties.unfinished);
            }
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '改动 score 不该读的东西，成绩不变：种子、事件，每间房的位置、线索、脏乱、出门和退房时刻、延迟退房、描述，以及罚时和 17:00 以外的全部参数',
    () => {
      const MESS: readonly MessLevel[] = ['tidy', 'normal', 'disaster'];
      const CLUES: readonly Clue[] = ['business', 'tourist', 'family', 'longStay', 'oneNight', 'threeNightsPlus', 'partyOrFamily'];
      fc.assert(
        fc.property(shiftArb, fc.array(fc.nat(), { minLength: 1, maxLength: 32 }), (input, noise) => {
          const { world, states } = playToEnd(input);
          const final = lastOf(states);
          let cursor = 0;
          const next = (): number => noise[cursor++ % noise.length] ?? 0;
          // 参数的副本：每个数字都加上 1 到 7，难度档也换掉，然后只把罚时和 17:00 换回这个世界的。
          const params = structuredClone(world.params);
          bumpNumbers(params, () => 1 + (next() % 7));
          params.tier = params.tier === 'weekend' ? 'standard' : 'weekend';
          params.shift.hardStop = world.params.shift.hardStop;
          params.penalties = { ...world.params.penalties };
          // 确认真的都改到了：逐个对照参数里的数字，没变的恰好是 17:00 和三项罚时这 4 个。
          const original = numbersIn(world.params);
          expect(numbersIn(params).filter((value, index) => value === original[index])).toHaveLength(4);
          const changed: World = {
            seed: `${world.seed}:other`,
            params,
            rooms: world.rooms.map((room) => ({
              ...room,
              place: { floor: next() % 50, door: next() % 9 },
              clue: at(CLUES, next() % CLUES.length),
              mess: at(MESS, next() % MESS.length),
              availableFrom: (next() % 700) - 100,
              lateCheckout: next() % 2 === 0,
              descriptionId: next() % 2 === 0 ? null : `other-${next() % 10}`,
            })),
            events: [{ type: 'extraTowels', at: next() % 500 }],
          };
          expect(score(changed, final)).toStrictEqual(score(world, final));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('性质：数值都从 world.params 读', () => {
  it('ODD_PARAMS 里 score 用到的每项数值都和三档不同（ODD_PARAMS 的班次由上面几条性质跑过）', () => {
    const odd = numbersUsedByScore(ODD_PARAMS);
    for (const tier of TIERS) {
      const base = numbersUsedByScore(PARAMS[tier]);
      for (const [name, value] of Object.entries(odd)) expect(value, `${tier} 档的 ${name}`).not.toBe(base[name]);
    }
  });
});

describe('性质：纯函数', () => {
  it(
    '深度冻结的 world 和 state 上计分不抛错，入参不变；同样的输入两次结果相同；结果每次新建，不和 world、state 共用对象',
    () => {
      fc.assert(
        fc.property(shiftArb, rushesArb, (input, rushes) => {
          // 用参数的副本生成：深度冻结只冻结这个测试自己造的对象，不碰共用的 ODD_PARAMS。
          const world = deepFreeze(generate(input.seed, structuredClone(PARAM_SETS[input.set])));
          const trace = playShift(world, input.picks, Number.POSITIVE_INFINITY, CHOOSERS[input.chooser]);
          const final = deepFreeze(withRushes(world, lastOf(trace.states), rushes));
          const worldCopy = structuredClone(world);
          const stateCopy = structuredClone(final);
          const first = score(world, final);
          const second = score(world, final);
          expect(world).toStrictEqual(worldCopy);
          expect(final).toStrictEqual(stateCopy);
          expect(second).toStrictEqual(first);
          expect(second).not.toBe(first);
          expect(second.penalties).not.toBe(first.penalties);
          const inputs = objectsIn(final, objectsIn(world));
          expect([...objectsIn(first)].filter((object) => inputs.has(object))).toEqual([]);
        }),
        { numRuns: 50 },
      );
    },
    TIMEOUT,
  );

  it(
    '计分时把 Math.random 和 Date.now 换成会抛错的桩，结果不变',
    () => {
      // 在 fast-check 之外准备好结束的班次，先不换桩算一遍，得到对照结果。
      const samples = fc.sample(fc.tuple(shiftArb, rushesArb), { numRuns: 30, seed: SAMPLE_SEED });
      const cases = samples.map(([input, rushes]) => {
        const { world, states } = playToEnd(input);
        return { world, final: withRushes(world, lastOf(states), rushes) };
      });
      const expected = cases.map(({ world, final }) => score(world, final));

      // 只在调用 score 的这段代码里换桩，用 try/finally 恢复。这段代码里不调用 expect。
      let randomCalls = 0;
      let nowCalls = 0;
      const random = vi.spyOn(Math, 'random').mockImplementation(() => {
        randomCalls++;
        throw new Error('score 不该调用 Math.random');
      });
      const now = vi.spyOn(Date, 'now').mockImplementation(() => {
        nowCalls++;
        throw new Error('score 不该调用 Date.now');
      });
      let results: Score[] = [];
      let failure: unknown = null;
      try {
        results = cases.map(({ world, final }) => score(world, final));
      } catch (error) {
        failure = error;
      } finally {
        random.mockRestore();
        now.mockRestore();
      }

      expect(failure).toBeNull();
      expect(randomCalls).toBe(0);
      expect(nowCalls).toBe(0);
      expect(results).toStrictEqual(expected);
    },
    TIMEOUT,
  );
});

/** 一局结束时的样子：世界、结束时的状态（已写进催房时限）、按计分规则算出的成绩、收工时刻和参数。 */
interface Ending {
  world: World;
  final: State;
  expected: Score;
  quitAt: Minute;
  set: ParamSet;
}

/** 一种计分情形：名字，以及这一局有没有走到。用按计分规则算出的成绩判断，不用 score 本身。 */
type Situation = [string, (ending: Ending) => boolean];

/** 真相和结束时的进度，按 world.rooms 的顺序配成对。 */
function roomsOf({ world, final }: Ending): { truth: RoomTruth; progress: RoomProgress }[] {
  return world.rooms.map((truth, index) => ({ truth, progress: at(final.rooms, index) }));
}

/** 有没做完、摘牌时刻不晚于收工时刻的请勿打扰房，并且玩家知道（或不知道）它已摘牌。 */
function liftedUndone(ending: Ending, known: boolean): boolean {
  return roomsOf(ending).some(
    ({ truth, progress }) =>
      truth.kind === 'dnd' &&
      progress.doneAt === null &&
      truth.dndLiftsAt !== null &&
      truth.dndLiftsAt <= ending.quitAt &&
      progress.dndLiftKnown === known,
  );
}

/** 有带时限的房间是这种情况：on 按时做完，late 晚于时限做完，undone 没做完。 */
function deadlineCase(ending: Ending, which: 'vip' | 'rush', kind: 'on' | 'late' | 'undone'): boolean {
  return roomsOf(ending).some(({ truth, progress }) => {
    const deadline = which === 'vip' ? truth.vipDeadline : progress.rushDeadline;
    if (deadline === null) return false;
    if (progress.doneAt === null) return kind === 'undone';
    return kind === (progress.doneAt <= deadline ? 'on' : 'late');
  });
}

const SITUATIONS: Situation[] = [
  ['自己收工，没有罚时', ({ final, expected }) => final.ended === 'returned' && expected.equivalentFinish === expected.finishMinute],
  // 收工以后才摘牌的请勿打扰房这里走不到：按现有参数最晚 14:00 前摘牌，随机挑法做不完全部房间那么早收工。
  // 这种情形由单元测试和上面"摘牌时刻改成收工时刻的下一分钟"那条性质覆盖。
  // 也没有"ODD_PARAMS 下自己收工"这一项：两种挑法都不会自己收工（见文件开头），由单元测试覆盖。
  [
    '自己收工，收工那一刻已摘牌、玩家还不知道的请勿打扰房算未完成',
    (ending) => ending.final.ended === 'returned' && liftedUndone(ending, false),
  ],
  [
    '强制下班，有被 17:00 截断的房间',
    ({ final }) => final.ended === 'hardStop' && final.log.some((entry) => entry.outcome.type === 'interrupted'),
  ],
  [
    '强制下班，已知摘牌却没做完的请勿打扰房',
    (ending) => ending.final.ended === 'hardStop' && liftedUndone(ending, true),
  ],
  [
    '强制下班，不知道已摘牌的请勿打扰房',
    (ending) => ending.final.ended === 'hardStop' && liftedUndone(ending, false),
  ],
  ['贵宾房按时做完', (ending) => deadlineCase(ending, 'vip', 'on')],
  ['贵宾房晚于时限做完', (ending) => deadlineCase(ending, 'vip', 'late')],
  ['贵宾房没做完', (ending) => deadlineCase(ending, 'vip', 'undone')],
  ['催房房间按时做完', (ending) => deadlineCase(ending, 'rush', 'on')],
  ['催房房间晚于时限做完', (ending) => deadlineCase(ending, 'rush', 'late')],
  ['催房房间没做完', (ending) => deadlineCase(ending, 'rush', 'undone')],
  ['ODD_PARAMS 下强制下班', ({ final, set }) => set === 'odd' && final.ended === 'hardStop'],
];

describe('自检：随机班次走到的计分情形', () => {
  it('固定种子抽的这批班次里（和上面的性质用同样的生成器），每类计分情形都至少有一局走到', () => {
    const endings = fc
      .sample(fc.tuple(shiftArb, rushesArb), { numRuns: WIDE_RUNS, seed: SAMPLE_SEED })
      .map(([input, rushes]): Ending => {
        const { world, states } = playToEnd(input);
        const final = withRushes(world, lastOf(states), rushes);
        return { world, final, expected: expectedScore(world, final), quitAt: quitMomentOf(world, final), set: input.set };
      });
    const counts = SITUATIONS.map(([name, reached]): [string, number] => [name, endings.filter(reached).length]);
    const missed = counts.filter(([, count]) => count === 0).map(([name]) => name);
    expect(missed, JSON.stringify(Object.fromEntries(counts))).toEqual([]);
  });
});
