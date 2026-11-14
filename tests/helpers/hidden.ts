/**
 * 不泄露性质用的第二个世界。
 *
 * hideDifferently(world, state, noise)：state 是在 world 上从开工起执行一串合法动作得到的状态（前缀），
 * 返回另一个世界，只改动玩家到 state 为止还不知道的隐藏信息，改成什么由 noise 决定。
 * 同一串动作在两个世界里都合法，每一步的状态（含日志）完全相同。
 *
 * 改动的范围都从 state.rooms 和 state.log 精确推出来。推错了，两个世界的前缀状态就会不同，
 * 所以调用方逐步断言前缀状态相同，本身就能发现这里推错。
 * rules 的不泄露性质用它比较状态、合法动作和报错文字；observe 的不泄露性质可以直接复用：
 * 同一前缀的每一步，observe(world, 状态) 和 observe(第二个世界, 状态) 应当完全相同。
 *
 * 完全没揭晓的值，任意改：
 * - 没开过门的房间：脏乱，以及房间描述的编号（descriptionId，开门后才显示）。
 * - 没标记、不是延迟退房的退房房：退房时刻改到前缀结束之后。
 * - 没得知摘牌的请勿打扰房：摘牌时刻改为 null（整班不摘）或前缀结束之后。
 * - 前缀里从没作为打扫目标的续住房和请勿打扰房：客人出门时刻。
 *
 * 只知道范围的值（部分揭晓），在已知的范围里改：
 * - 已标记、不是延迟退房的退房房：玩家只知道退房时刻晚于上一通电话的挂断时刻、不晚于标记它的那通电话的挂断时刻；
 *   标记它之前没打过电话的，只知道不晚于那次挂断时刻，可以改到开工前。
 * - 进过门、从没被拒的续住房和请勿打扰房：只知道客人出门不晚于进门那次的到达时刻。
 * - 敲门被拒过的续住房和请勿打扰房：只知道出门晚于被拒那次的到达时刻，并且按 comeBackRounding 向上取整
 *   等于回来时间 c，也就是晚于 c - comeBackRounding、不晚于 c。
 * - 已知摘牌的请勿打扰房：只知道摘牌晚于得知之前每一次看到它所在门位的时刻，也晚于得知之前每一通电话的挂断时刻。
 *   上界：电话得知的，不晚于那通电话的挂断时刻；路过或停留得知的，不晚于那个动作里最后一次看到它所在门位的时刻
 *   （日志只记在哪个动作里得知，不记是那个动作里的哪一次看到的）。
 *
 * 延迟退房房的退房时刻是公开的（任务单上注明延迟退房，时刻在 params 里），不改。
 * 不改 world.seed 和 world.events（阶段 0 的事件恒为空）。
 */

import { walkPath } from '../../src/engine/layout';
import type { LogEntry, MessLevel, Minute, Place, RoomId, RoomTruth, State, World } from '../../src/engine/types';

const MESS_LEVELS = ['tidy', 'normal', 'disaster'] as const satisfies readonly MessLevel[];

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`下标 ${index} 越界`);
  return item;
}

function samePlace(a: Place, b: Place): boolean {
  return a.floor === b.floor && a.door === b.door;
}

/**
 * 一个动作里玩家看到门位的时刻（门位观察）：步行途中每到一个门位（含起点和终点）在到达的那一分钟看一次，
 * 动作结束时在所在门位再看一次。打电话和等待不走路，只有结束时的那一次。只返回 place 这个门位上的时刻。
 */
function sightings(entry: LogEntry, place: Place, world: World): Minute[] {
  const walks = entry.action.type !== 'call' && entry.action.type !== 'wait';
  const visits = walks
    ? walkPath(entry.from, entry.to, world.params).map((step) => ({ place: step.place, minute: entry.start + step.offset }))
    : [];
  visits.push({ place: entry.to, minute: entry.end });
  return visits.filter((visit) => samePlace(visit.place, place)).map((visit) => visit.minute);
}

/** 这通电话标记了 room 为已退。 */
function flagged(entry: LogEntry, room: RoomId): boolean {
  return entry.outcome.type === 'called' && entry.outcome.newlyDeparted.includes(room);
}

/** 这通电话让玩家得知 room 已摘牌。 */
function liftedByCall(entry: LogEntry, room: RoomId): boolean {
  return entry.outcome.type === 'called' && entry.outcome.newlyLifted.includes(room);
}

/** 构造第二个世界，规则见文件开头。 */
export function hideDifferently(world: World, state: State, noise: readonly number[]): World {
  const { log } = state;
  const prefixEnd = state.minute;
  const { beforeStart, hardStop } = world.params.shift;
  const { comeBackRounding } = world.params;
  let cursor = 0;
  const next = (): number => noise[cursor++ % noise.length] ?? 0;
  /** lo 到 hi 之间（两端都含）的一个整数。 */
  const between = (lo: Minute, hi: Minute): Minute => lo + (next() % (hi - lo + 1));
  /** 不晚于 hi 的一个整数：开工前，或者 hi 往前不超过 120 分钟。 */
  const notAfter = (hi: Minute): Minute => (next() % 3 === 0 ? beforeStart : hi - (next() % 121));

  /** 已标记退房房的退房时刻：（上一通电话的挂断时刻, 标记它的那通电话的挂断时刻]。 */
  const departedAt = (room: RoomTruth): Minute => {
    const calls = log.filter((entry) => entry.outcome.type === 'called');
    const index = calls.findIndex((entry) => flagged(entry, room.id));
    const hangUp = at(calls, index).end;
    return index === 0 ? notAfter(hangUp) : between(at(calls, index - 1).end + 1, hangUp);
  };

  /** 作为打扫目标去过的续住房和请勿打扰房，客人的出门时刻：按被拒和进门推出的范围。 */
  const leavesAt = (room: RoomTruth, services: readonly LogEntry[]): Minute => {
    let lower: Minute | null = null;
    let upper = Number.POSITIVE_INFINITY;
    for (const entry of services) {
      const arrival = entry.start + entry.walk;
      if (entry.outcome.type === 'knockRefused') {
        // 被拒：出门晚于到达时刻，并且晚于 c - comeBackRounding、不晚于 c。
        const comeBackAt = entry.outcome.comeBackAt;
        lower = Math.max(lower ?? arrival, arrival, comeBackAt - comeBackRounding);
        upper = Math.min(upper, comeBackAt);
      } else {
        // 进了门：出门不晚于到达时刻。
        upper = Math.min(upper, arrival);
      }
    }
    if (!Number.isFinite(upper)) throw new Error(`${room.id} 去过却既没被拒也没进门`);
    return lower === null ? notAfter(upper) : between(lower + 1, upper);
  };

  /**
   * 已知摘牌的请勿打扰房的摘牌时刻：晚于得知之前看到它门位的每一刻和每通电话的挂断时刻；
   * 不晚于电话得知时的挂断时刻，或者路过、停留得知的那个动作里最后一次看到它门位的时刻。
   */
  const liftsAt = (room: RoomTruth): Minute => {
    const index = log.findIndex((entry) => liftedByCall(entry, room.id) || entry.noticedLifted.includes(room.id));
    const learned = at(log, index);
    const latest = liftedByCall(learned, room.id) ? learned.end : Math.max(...sightings(learned, room.place, world));
    const earlier = log
      .slice(0, index)
      .flatMap((entry) => [...sightings(entry, room.place, world), ...(entry.outcome.type === 'called' ? [entry.end] : [])]);
    return earlier.length === 0 ? notAfter(latest) : between(Math.max(...earlier) + 1, latest);
  };

  const rooms = world.rooms.map((room, index): RoomTruth => {
    const known = at(state.rooms, index);
    let changed: RoomTruth = room;
    if (!known.messRevealed) {
      const mess = MESS_LEVELS[next() % MESS_LEVELS.length] ?? 'normal';
      const descriptionId = next() % 2 === 0 ? null : `description-${next() % 10}`;
      changed = { ...changed, mess, descriptionId };
    }

    if (room.kind === 'departure') {
      if (room.lateCheckout) return changed;
      const availableFrom = known.flaggedDeparted ? departedAt(room) : prefixEnd + 1 + (next() % 120);
      return { ...changed, availableFrom };
    }

    // 续住房和请勿打扰房。
    const services = log.filter((entry) => entry.action.type === 'service' && entry.action.room === room.id);
    let availableFrom: Minute;
    if (services.length > 0) availableFrom = leavesAt(room, services);
    else availableFrom = next() % 3 === 0 ? beforeStart : next() % hardStop;
    changed = { ...changed, availableFrom };
    if (room.kind === 'dnd') {
      let dndLiftsAt: Minute | null;
      if (known.dndLiftKnown) dndLiftsAt = liftsAt(room);
      else dndLiftsAt = next() % 2 === 0 ? null : prefixEnd + 1 + (next() % 120);
      changed = { ...changed, dndLiftsAt };
    }
    return changed;
  });
  return { ...world, rooms };
}
