/**
 * 计分：一个结束的班次的等效下班时间和各项罚时。规则的出处是 docs/DESIGN.md 的"计分"。
 *
 * 1. 成绩只有一个数：等效下班时间，等于还车完成的时刻（finishMinute，最后一条日志的 end）加上全部罚时，越小越好。
 *    罚时按房间算，每间的分钟数从 world.params.penalties 读；Score.penalties 的三项是各类罚时的合计。
 *
 * 2. 收工时刻。自己收工（ended 为 'returned'）时是选择收工还车的那一刻，也就是最后一条日志（收工还车）的 start；
 *    强制下班（'hardStop'）时就是 17:00（params.shift.hardStop），还车在 17:00 以后才开始也一样
 *    （按现有规则，只有自定义参数让休息跨过 17:00 时才会这样）。收工时刻只用来判断请勿打扰房算不算未完成。
 *
 * 3. 未完成。退房房和续住房结束时没做完（doneAt 为 null）就算，包括做到一半被 17:00 截断的。
 *    请勿打扰房按真相算，不管玩家知不知道：摘牌时刻（dndLiftsAt）不晚于收工时刻、却没做完的算；
 *    整班不摘的，以及收工以后才摘的，不算。自己收工时，已知摘牌的请勿打扰房一定已经做完（这是收工的条件），
 *    所以这时算未完成的，只会是收工那一刻玩家还不知道已经摘牌的请勿打扰房。
 *
 * 4. 时限。贵宾房的时限（vipDeadline）在 World 里，前台催房的时限（rushDeadline）在 State 里，由阶段 2 的事件设置。
 *    完成时刻不晚于时限算按时；晚于时限做完，或者没做完，算超时。没做完的再算一次未完成，两项叠加。
 *    一间房既是贵宾房又被催房时，两个时限各算各的。
 *
 * 5. 只给结束的班次计分。state 和 world 的房间对不上、班次还没结束、判负（阶段 2 才有，怎么计分到时再定），
 *    或者最后一条日志不是收工还车，都直接抛错，不给出一个悄悄出错的成绩。
 *
 * 6. 纯函数。不修改 world 和 state，没有随机数，不读系统时间，同样的输入给出相同的输出。
 *    返回的 Score 每次新建，只有数字和布尔值，不和 world、state 共用对象。
 */

import type { LogEntry, Minute, RoomProgress, RoomTruth, Score, State, World } from './types';

/**
 * 一个结束的班次的成绩，规则见文件开头。
 * state 和 world 的房间对不上、班次还没结束、判负，或者最后一条日志不是收工还车时抛错。
 */
export function score(world: World, state: State): Score {
  // 先查房间对得上，再查班次的结束。
  const pairs = pairRooms(world, state);
  const finish = finishEntry(state);
  const { params } = world;
  // 收工时刻：自己收工是选择收工还车的那一刻，强制下班就是 17:00。
  const quitAt = state.ended === 'hardStop' ? params.shift.hardStop : finish.start;

  let roomsDone = 0;
  let lateVips = 0;
  let lateRushes = 0;
  let unfinishedRooms = 0;
  for (const { truth, progress } of pairs) {
    if (progress.doneAt !== null) roomsDone++;
    if (missedDeadline(truth.vipDeadline, progress.doneAt)) lateVips++;
    if (missedDeadline(progress.rushDeadline, progress.doneAt)) lateRushes++;
    if (unfinishedAtQuit(truth, progress, quitAt)) unfinishedRooms++;
  }

  const penalties = {
    vipLate: lateVips * params.penalties.vipLate,
    rushLate: lateRushes * params.penalties.rushLate,
    unfinished: unfinishedRooms * params.penalties.unfinished,
  };
  const finishMinute = finish.end;
  return {
    finishMinute,
    penalties,
    equivalentFinish: finishMinute + penalties.vipLate + penalties.rushLate + penalties.unfinished,
    roomsDone,
    walkedMinutes: state.log.reduce((sum, entry) => sum + entry.walk, 0),
    violation: state.violation,
    // 判负的班次在 finishEntry 里已经抛错，走到这里的都不是判负。
    failed: false,
  };
}

/** 一间房的真相和进度，同一下标上的两项。 */
interface RoomPair {
  truth: RoomTruth;
  progress: RoomProgress;
}

/**
 * 按 world.rooms 的顺序把真相和进度配成对。数量不同，或同一下标上的房号不同，就抛错。
 * 和 observe.ts 的 pairRooms 相同，rules.ts 的 knownStateOf 里还有一份同样的检查。observe.ts 只能导入 types 和 layout
 * （tests/engine-purity.test.ts 检查），所以各留一份；改这项检查时三处一起改。
 */
function pairRooms(world: World, state: State): RoomPair[] {
  const mismatch = 'score: state 和 world 的房间对不上';
  if (state.rooms.length !== world.rooms.length) throw new Error(mismatch);
  return world.rooms.map((truth, index): RoomPair => {
    const progress = state.rooms[index];
    if (progress === undefined || progress.id !== truth.id) throw new Error(mismatch);
    return { truth, progress };
  });
}

/** 结束的班次的最后一条日志，也就是收工还车那一条。班次还没结束、判负，或者最后一条日志不是收工还车，就抛错。 */
function finishEntry(state: State): LogEntry {
  if (state.ended === null) throw new Error('score: 班次还没结束，收工还车以后才能计分');
  if (state.ended === 'failed') throw new Error('score: 判负的班次怎么计分要到阶段 2 才定');
  const last = state.log[state.log.length - 1];
  if (last === undefined || last.action.type !== 'finish' || last.outcome.type !== 'finished') {
    throw new Error('score: 班次已经结束，最后一条日志却不是收工还车');
  }
  return last;
}

/** 有时限，并且没做完或晚于时限才做完。恰好在时限做完的算按时。 */
function missedDeadline(deadline: Minute | null, doneAt: Minute | null): boolean {
  return deadline !== null && (doneAt === null || doneAt > deadline);
}

/**
 * 算不算未完成：退房房和续住房没做完就算，包括被 17:00 截断的；
 * 请勿打扰房按真相，摘牌时刻不晚于收工时刻、却没做完的才算，不管玩家知不知道。
 */
function unfinishedAtQuit(truth: RoomTruth, progress: RoomProgress, quitAt: Minute): boolean {
  if (progress.doneAt !== null) return false;
  if (truth.kind !== 'dnd') return true;
  return truth.dndLiftsAt !== null && truth.dndLiftsAt <= quitAt;
}
