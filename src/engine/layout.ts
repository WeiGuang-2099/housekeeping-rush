/**
 * 楼层几何：房号对应的位置，以及两点之间的步行时间。纯函数。
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

/** 楼层里的全部房号，按楼层和门位顺序。 */
export function allRooms(params: Params): RoomId[] {
  return params.layout.floors.flatMap((plan) => plan.rooms);
}
