/**
 * 规则测试用的受控世界。
 *
 * 从 generate 生成的世界出发，按房号整个换掉任务单信息和隐藏信息
 * （kind、clue、mess、availableFrom、lateCheckout、vipDeadline、dndLiftsAt）。
 * id 和 place 仍由房号决定，events 仍为空。descriptionId 是可选的：写了就覆盖生成的值，
 * 没写就保留生成的值（现在 generate 给的都是 null）；departure、stayover、dnd 不给它默认值。
 *
 * 没写到的房间一律换成"整班不摘牌的请勿打扰房"：玩家永远不会得知它摘牌，
 * 所以它不能打扫、不挡收工，路过和打电话也得不到它的任何消息。
 * 这样每个用例只受自己写出来的房间影响，不依赖某个种子恰好生成了什么。
 */

import { generate } from '../../src/engine/generate';
import { PARAMS, type Params, type Tier } from '../../src/engine/params';
import type { Clue, MessLevel, Minute, RoomId, RoomKind, World } from '../../src/engine/types';

/** 受控世界里每间房写明的字段。 */
export interface RoomSetup {
  kind: RoomKind;
  clue: Clue;
  mess: MessLevel;
  availableFrom: Minute;
  lateCheckout: boolean;
  vipDeadline: Minute | null;
  dndLiftsAt: Minute | null;
  /** 房间描述的编号。可选，构造函数不给默认值：没写就保留生成的值，写了就覆盖。 */
  descriptionId?: string | null;
}

/** 开工前（params.shift.beforeStart，三档都是 -30）：开工前就已退房，或客人开工前已出门。 */
export const BEFORE_START: Minute = PARAMS.standard.shift.beforeStart;

type RoomOptions = Partial<Omit<RoomSetup, 'kind'>>;

/** 退房房。默认：住一晚，普通脏乱，开工前已退房，不是延迟退房，不是贵宾房。 */
export function departure(options: RoomOptions = {}): RoomSetup {
  return {
    kind: 'departure',
    clue: 'oneNight',
    mess: 'normal',
    availableFrom: BEFORE_START,
    lateCheckout: false,
    vipDeadline: null,
    dndLiftsAt: null,
    ...options,
  };
}

/** 续住房。默认：商务客人，普通脏乱，客人开工前已出门。 */
export function stayover(options: RoomOptions = {}): RoomSetup {
  return {
    kind: 'stayover',
    clue: 'business',
    mess: 'normal',
    availableFrom: BEFORE_START,
    lateCheckout: false,
    vipDeadline: null,
    dndLiftsAt: null,
    ...options,
  };
}

/** 请勿打扰房。默认：商务客人，普通脏乱，客人开工前已出门，整班不摘牌。 */
export function dnd(options: RoomOptions = {}): RoomSetup {
  return {
    kind: 'dnd',
    clue: 'business',
    mess: 'normal',
    availableFrom: BEFORE_START,
    lateCheckout: false,
    vipDeadline: null,
    dndLiftsAt: null,
    ...options,
  };
}

export interface WorldOptions {
  /** 难度档，默认标准档。给了 params 时忽略。 */
  tier?: Tier;
  params?: Params;
  seed?: string;
}

/** 按房号写明房间的受控世界。没写到的房间是整班不摘牌的请勿打扰房（见文件开头）。 */
export function controlledWorld(rooms: Record<RoomId, RoomSetup>, options: WorldOptions = {}): World {
  const params = options.params ?? PARAMS[options.tier ?? 'standard'];
  const base = generate(options.seed ?? 'controlled', params);
  const ids = new Set(base.rooms.map((room) => room.id));
  for (const key of Object.keys(rooms)) {
    if (!ids.has(Number(key))) throw new Error(`受控世界：楼层里没有房间 ${key}`);
  }
  return {
    ...base,
    rooms: base.rooms.map((room) => ({ ...room, ...(rooms[room.id] ?? dnd()), id: room.id, place: room.place })),
  };
}

/** 在已有的世界上改几间房的个别字段，其余不变。用来构造只差隐藏信息的第二个世界。 */
export function patchWorld(world: World, patches: Record<RoomId, Partial<RoomSetup>>): World {
  const ids = new Set(world.rooms.map((room) => room.id));
  for (const key of Object.keys(patches)) {
    if (!ids.has(Number(key))) throw new Error(`patchWorld：楼层里没有房间 ${key}`);
  }
  return {
    ...world,
    rooms: world.rooms.map((room) => ({ ...room, ...(patches[room.id] ?? {}), id: room.id, place: room.place })),
  };
}
