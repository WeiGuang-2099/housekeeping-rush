/**
 * observe 测试共用的常量：View、RoomView 和位置的键，按 src/engine/types.ts 里的字段顺序。
 * 这个顺序也是 JSON.stringify(view) 的键顺序（以后老手会用它派生随机数种子），所以测试连顺序一起比较。
 * 另有 withDescriptions：给世界的每间房一个不同的描述编号，observe 的性质测试和 tests/helpers.test.ts 共用。
 */

import type { Place, RoomView, View, World } from '../../src/engine/types';

/** View 恰好这 9 个键，按这个顺序。 */
export const VIEW_KEYS = [
  'minute',
  'place',
  'cart',
  'breakTaken',
  'rooms',
  'prompt',
  'violation',
  'ended',
  'log',
] as const satisfies readonly (keyof View)[];

/** RoomView 恰好这 14 个键，按这个顺序。 */
export const ROOM_VIEW_KEYS = [
  'id',
  'place',
  'kind',
  'clue',
  'lateCheckout',
  'vipDeadline',
  'rushDeadline',
  'doneAt',
  'workDone',
  'flaggedDeparted',
  'knownAvailableFrom',
  'mess',
  'dndLifted',
  'descriptionId',
] as const satisfies readonly (keyof RoomView)[];

/** 位置恰好这 2 个键，按这个顺序。 */
export const PLACE_KEYS = ['floor', 'door'] as const satisfies readonly (keyof Place)[];

/**
 * 同一个世界，只是每间房的描述编号换成 desc-房号，各不相同。generate 给的描述都是 null：
 * 看不出 View 里的描述是不是按揭晓口径取自这间房，也看不出第二个世界有没有改掉没开门房间的描述。
 */
export function withDescriptions(world: World): World {
  return { ...world, rooms: world.rooms.map((room) => ({ ...room, descriptionId: `desc-${room.id}` })) };
}
