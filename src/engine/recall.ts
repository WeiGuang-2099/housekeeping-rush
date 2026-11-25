/**
 * recall：从 View 的日志推出界面要替玩家记着的关键事实（docs/DESIGN.md 的"记性"）。
 *
 * 1. 为什么要有它。幽灵从日志里记得一切，玩家要靠自己记。为了让"信息和玩家相同"成立，界面要显示从日志能推出的
 *    关键事实：最近一次打电话的时刻，以及每间还不知道摘牌的请勿打扰房最近一次确认仍挂牌的时刻。只看 View 的策略
 *    要用时也调它，和界面显示的是同一份。
 *
 * 2. 只读 View 和 params。拿不到 World 和 State，推出的东西不会多于 View 里已有的。params 只用楼层几何：
 *    walkPath 读的每个门位的步行分钟和电梯分钟，以及核对房间用的楼层平面。View 的房间和 allRooms(params) 的房号、
 *    顺序对不上时抛错，和 legalActionsForView 一样。不修改 view，深度冻结的 View 也能用；每次返回新建的对象，
 *    键的顺序就是 types.ts 里 Recall 和 HungDnd 的字段顺序。
 *
 * 3. 最近一次打电话的时刻：最后一条打电话日志的 end，也就是挂断的时刻。rules.ts 按挂断的时刻标记已退的退房房和
 *    已摘牌的请勿打扰房，所以主管报的房态截至这一刻：还没被标记的退房房，到这一刻还没退。本班还没打过为 null。
 *
 * 4. 确认仍挂牌。玩家有两种途径得知请勿打扰房的房态（rules.ts）：打给主管，按挂断的时刻报出已摘牌的；
 *    门位观察，步行途中每到一个门位（含起点和终点）在到达的那一分钟看一次，动作结束时在所在门位再看一次。
 *    还不知道摘牌的房间，过去每一通电话、它门位上的每一次观察，看到的都是仍挂着牌（看到摘牌就已经得知了），
 *    所以它最近一次确认仍挂牌的时刻，就是所有电话的挂断时刻和它门位上每一次门位观察的时刻里最晚的那个。
 *    门位观察从日志推：步行从 entry.from 沿 walkPath 走到 entry.to，entry.start 出发，每个门位在 entry.start
 *    加它的 offset 到达；结束时的那一次在 entry.to、entry.end。打电话和等待不走路，from 和 to 相同，walkPath
 *    只给出起点；这一刻不晚于同一条日志结束时的那一次，算进去不改变结果，所以不按动作类型区分。
 *    本班还没打过电话，也没在它的门位观察过，就是 null。开工时任务单上标着请勿打扰，不算一次确认：规则在 08:30
 *    不看任何门位（人在服务间，门位 0 没有房间），任务单上的房型 View 里本来就有。
 *
 * 5. 已经得知摘牌的请勿打扰房不列。界面用不着；而且路过或停留时得知的，最近一次看到挂牌是哪一刻推不准：日志只记
 *    在哪个动作里得知，不记是那个动作里的哪一次看到的（一个动作里可以两次看到同一个门位：到门口时和动作结束时）。
 *
 * 6. 阶段 2 的事件会在动作中途弹出，到时候要重新核对门位观察的推法（例如回应事件的日志条目、作废的剩余步行）。
 *
 * 7. 纯函数。没有随机数，不读系统时间；只导入类型、参数的类型和几何（tests/engine-purity.test.ts 检查）。
 */

import { allRooms, walkPath } from './layout';
import type { Params } from './params';
import type { HungDnd, LogEntry, Minute, Place, Recall, View } from './types';

/** 从 View 的日志推出的关键事实，推法见文件开头。View 的房间和 params 的楼层对不上时抛错。 */
export function recall(view: View, params: Params): Recall {
  const ids = allRooms(params);
  if (view.rooms.length !== ids.length || view.rooms.some((room, index) => room.id !== ids[index])) {
    throw new Error('recall: View 的房间和 params 的楼层对不上');
  }
  const lastCallAt = view.log.filter((entry) => entry.outcome.type === 'called').at(-1)?.end ?? null;
  const sightings = view.log.flatMap((entry) => sightingsOf(entry, params));
  // 键的顺序就是 types.ts 里 Recall 和 HungDnd 的字段顺序。
  return {
    lastCallAt,
    stillHung: view.rooms
      .filter((room) => room.kind === 'dnd' && !room.dndLifted)
      .map((room): HungDnd => {
        const seen = sightings.filter((sighting) => samePlace(sighting.place, room.place)).map((sighting) => sighting.minute);
        return { room: room.id, confirmedAt: latest(lastCallAt === null ? seen : [...seen, lastCallAt]) };
      }),
  };
}

/** 一次门位观察：在 place 这个门位、minute 这一分钟看了一次。 */
interface Sighting {
  place: Place;
  minute: Minute;
}

/** 一条日志里的门位观察：步行途中到达每个门位（含起点和终点）的那一分钟，以及结束时在所在门位的那一次。 */
function sightingsOf(entry: LogEntry, params: Params): Sighting[] {
  return [
    ...walkPath(entry.from, entry.to, params).map(
      (step): Sighting => ({ place: step.place, minute: entry.start + step.offset }),
    ),
    { place: entry.to, minute: entry.end },
  ];
}

/** 最晚的时刻；一个都没有时为 null。 */
function latest(minutes: readonly Minute[]): Minute | null {
  return minutes.length === 0 ? null : Math.max(...minutes);
}

function samePlace(a: Place, b: Place): boolean {
  return a.floor === b.floor && a.door === b.door;
}
