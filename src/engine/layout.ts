/**
 * 楼层几何：房号对应的位置，两点之间的步行时间，以及步行途中依次经过的门位。纯函数。
 *
 * 规则（docs/DESIGN.md，"世界规则与数值"）：
 * 同层步行每个门位 1 分钟。跨层要先走到电梯（门位 0），乘电梯，再走到目标门位。
 */

import type { Params } from './params';
import type { Minute, Place, RoomId } from './types';

/** 房号所在的位置。同一层里每两间房对着同一个门位，门位从 1 开始。 */
export function placeOf(room: RoomId, params: Params): Place {
  for (const plan of params.layout.floors) {
    const index = plan.rooms.indexOf(room);
    if (index >= 0) return { floor: plan.floor, door: Math.floor(index / 2) + 1 };
  }
  throw new Error(`placeOf: 楼层里没有房间 ${room}`);
}

/** 从 a 走到 b 需要的分钟数。 */
export function walkMinutes(a: Place, b: Place, params: Params): Minute {
  const { walkMinutesPerDoor, liftMinutes } = params.layout;
  if (a.floor === b.floor) return Math.abs(a.door - b.door) * walkMinutesPerDoor;
  return (a.door + b.door) * walkMinutesPerDoor + liftMinutes;
}

/** 步行路线上的一点：门位，以及从出发算起第几分钟到达这里。 */
export interface WalkStep {
  place: Place;
  offset: Minute;
}

/**
 * 从 a 走到 b 依次经过的门位，包括起点（offset 为 0）和终点（offset 等于 walkMinutes(a, b)）。
 * 同层逐个门位走；跨层先在本层走到门位 0，乘电梯 liftMinutes，再从目标层的门位 0 走到目标门位。
 * a 和 b 相同时只有起点一项。每个门位只出现一次，offset 严格递增。
 * 每一项的 place 都是新对象，不与 a、b 共享。
 */
export function walkPath(a: Place, b: Place, params: Params): WalkStep[] {
  const { walkMinutesPerDoor, liftMinutes } = params.layout;
  const path: WalkStep[] = [{ place: { floor: a.floor, door: a.door }, offset: 0 }];
  let offset = 0;

  // 在 floor 层从门位 from 逐个门位走到 to；from 已经记过，不再重复。
  const walkAlong = (floor: number, from: number, to: number): void => {
    const direction = to > from ? 1 : -1;
    const doors = Math.abs(to - from);
    for (let i = 1; i <= doors; i++) {
      offset += walkMinutesPerDoor;
      path.push({ place: { floor, door: from + direction * i }, offset });
    }
  };

  if (a.floor === b.floor) {
    walkAlong(a.floor, a.door, b.door);
  } else {
    walkAlong(a.floor, a.door, 0);
    offset += liftMinutes;
    path.push({ place: { floor: b.floor, door: 0 }, offset });
    walkAlong(b.floor, 0, b.door);
  }
  return path;
}

/** 楼层里的全部房号，按楼层和门位顺序。 */
export function allRooms(params: Params): RoomId[] {
  return params.layout.floors.flatMap((plan) => plan.rooms);
}
