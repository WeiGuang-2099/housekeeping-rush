/**
 * 生成一个班次的世界：把全部隐藏信息一次掷好（docs/DESIGN.md，"隐藏信息与线索"）。
 *
 * 这是引擎里唯一使用随机数的地方。同一个种子加同一份 params，生成的世界永远相同，
 * 玩家的动作影响不到这里。
 *
 * 几处约定：
 *
 * 1. 时刻一律是整数分钟。params 里的时间窗 [from, to) 左闭右开，在里面等概率抽一个整数分钟，
 *    所以首尾相接的退房早、晚两段（现在是 [0, 120) 和 [120, 150)）互不重叠。
 *    打扫耗时（基础时间乘脏乱系数）在现在的数值下也都是整数，整个引擎可以只用整数分钟。
 *
 * 2. 开工前就能进的房间（开工前已退房，或客人开工前已出门），可进时刻记为 params.shift.beforeStart。
 *    它是负数，具体取值不影响玩法。时间窗都不早于开工，所以 availableFrom 小于 0 就等于"开工前"。
 *
 * 3. 子随机流。每间房的每一项各用一条随机流，种子是 `${seed}:room:${房号}:${用途}`；
 *    房型分配用 `${seed}:kinds`，贵宾用 `${seed}:vip`。好处有两个：
 *    以后加新的随机项（阶段 2 的事件、阶段 3 的房间描述）各用新的流，已有种子生成的房间不变；
 *    调一个概率时只有受它影响的那一项会变，比如提高摘牌概率，原来摘牌的房间仍在同一时刻摘牌。
 *    批量模拟对比两组参数时，差异来自参数本身，而不是整个世界被重新掷了一遍。
 *
 * 4. 贵宾候选不够。贵宾房只从非延迟退房的退房房里抽。这样的房间少于 vipDeadlines 的长度时，
 *    从延迟退房房里随机挑出缺的数量，改成普通退房：退房时刻按开工前、早、晚三段的比例重抽。
 *    这样"贵宾数量等于时限个数"和"贵宾不是延迟退房"两条都不破例。
 *    按现在的参数（6 间退房房，各有一成延迟退房），周末档（3 个贵宾）约每 790 个世界补一次，
 *    标准档和紧档（2 个贵宾）约每 18000 个世界一次。周末档延迟退房的实际比例因此比 params 低约万分之二。
 */

import { allRooms, placeOf } from './layout';
import type { MessDistribution, Params } from './params';
import { createRng, type Rng } from './rng';
import type { DepartureClue, MessLevel, Minute, RoomId, RoomKind, RoomTruth, StayClue, World } from './types';

/**
 * 抽取时的固定顺序。顺序决定随机数映射到哪个结果，所以写死在这里，不依赖 params 里对象键的顺序。
 * 漏掉的项永远抽不到，会被 tests/generate.test.ts 的统计测试发现。
 */
const MESS_LEVELS = ['tidy', 'normal', 'disaster'] as const satisfies readonly MessLevel[];
const STAY_CLUES = ['business', 'tourist', 'family', 'longStay'] as const satisfies readonly StayClue[];
const DEPARTURE_CLUES = ['oneNight', 'threeNightsPlus', 'partyOrFamily'] as const satisfies readonly DepartureClue[];

type CheckoutSegment = keyof Params['checkout'];
const CHECKOUT_SEGMENTS = ['beforeStart', 'early', 'late', 'lateCheckout'] as const satisfies readonly CheckoutSegment[];
/** 不含延迟退房的三段，补足贵宾候选时用。 */
const ON_TIME_SEGMENTS = ['beforeStart', 'early', 'late'] as const satisfies readonly CheckoutSegment[];

/** 按 params 生成一个班次的世界。rooms 按楼层顺序（allRooms 的顺序）排列。规则见文件开头的注释。 */
export function generate(seed: string, params: Params): World {
  const ids = allRooms(params);
  checkParams(params, ids.length);

  const stream = (purpose: string): Rng => createRng(`${seed}:${purpose}`);

  const kinds = stream('kinds').shuffle(kindPool(params.mix));
  const drawn = ids.map((id, index) => {
    const kind = kinds[index];
    // checkParams 已经保证房型数量等于房间数量，这里只是让类型检查知道。
    if (kind === undefined) throw new Error('generate: 房型数量少于房间数量');
    return drawRoom(id, kind, params, (aspect) => stream(`room:${id}:${aspect}`));
  });

  const vipRng = stream('vip');
  const rooms = assignVipDeadlines(ensureVipCandidates(drawn, params, vipRng), params, vipRng);

  // 事件在阶段 2 加入，用自己的随机流掷。
  return { seed, params, rooms, events: [] };
}

/** 参数自相矛盾时直接报错，不生成一个悄悄出错的世界。 */
function checkParams(params: Params, roomCount: number): void {
  const { departures, stayovers, dnd } = params.mix;
  if (departures + stayovers + dnd !== roomCount) {
    throw new Error(`generate: mix 合计 ${departures + stayovers + dnd} 间，楼层里有 ${roomCount} 间`);
  }
  if (params.vipDeadlines.length > departures) {
    throw new Error(`generate: 有 ${params.vipDeadlines.length} 个贵宾时限，退房房只有 ${departures} 间`);
  }
  const onTimeShare = ON_TIME_SEGMENTS.reduce((sum, segment) => sum + params.checkout[segment].share, 0);
  if (params.vipDeadlines.length > 0 && !(onTimeShare > 0)) {
    throw new Error('generate: 有贵宾时限，但退房分布里没有非延迟退房的部分');
  }
}

/** 按 mix 排好的房型，打乱后按楼层顺序分给各个房间。 */
function kindPool(mix: Params['mix']): RoomKind[] {
  return [
    ...Array<RoomKind>(mix.departures).fill('departure'),
    ...Array<RoomKind>(mix.stayovers).fill('stayover'),
    ...Array<RoomKind>(mix.dnd).fill('dnd'),
  ];
}

/** 一间房除贵宾以外的隐藏信息。aspect 是用途名，每个用途一条随机流。 */
function drawRoom(id: RoomId, kind: RoomKind, params: Params, stream: (aspect: string) => Rng): RoomTruth {
  const place = placeOf(id, params);

  if (kind === 'departure') {
    const clue = pickByShare(stream('clue'), DEPARTURE_CLUES, params.departureClues);
    return {
      id,
      place,
      kind,
      clue,
      mess: drawMess(stream('mess'), params.departureClues[clue].mess),
      ...drawCheckout(stream('available'), params, CHECKOUT_SEGMENTS),
      vipDeadline: null,
      dndLiftsAt: null,
      descriptionId: null,
    };
  }

  // 续住房和请勿打扰房都带续住线索；请勿打扰房摘牌后按续住房处理。
  const clue = pickByShare(stream('clue'), STAY_CLUES, params.stayClues);
  return {
    id,
    place,
    kind,
    clue,
    mess: drawMess(stream('mess'), params.stayClues[clue].mess),
    availableFrom: drawGuestLeaves(stream('available'), params, clue),
    lateCheckout: false,
    vipDeadline: null,
    dndLiftsAt: kind === 'dnd' ? drawDndLift(stream('dndLift'), params) : null,
    descriptionId: null,
  };
}

/** 按 share 抽一条线索。 */
function pickByShare<K extends string>(rng: Rng, order: readonly K[], table: Record<K, { share: number }>): K {
  return rng.pick(order, order.map((key) => table[key].share));
}

function drawMess(rng: Rng, mess: MessDistribution): MessLevel {
  return rng.pick(MESS_LEVELS, MESS_LEVELS.map((level) => mess[level]));
}

/** 在时间窗 [from, to) 里等概率抽一个整数分钟。 */
function minuteIn(rng: Rng, from: Minute, to: Minute): Minute {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from < to)) {
    throw new Error(`generate: 时间窗 [${from}, ${to}) 必须是非空的整数分钟区间`);
  }
  return rng.int(from, to - 1);
}

/** 退房房的可进时刻：按 segments 里各段的 share 选一段，再在段内抽时刻。 */
function drawCheckout(
  rng: Rng,
  params: Params,
  segments: readonly CheckoutSegment[],
): Pick<RoomTruth, 'availableFrom' | 'lateCheckout'> {
  const { checkout } = params;
  const segment = rng.pick(segments, segments.map((name) => checkout[name].share));
  switch (segment) {
    case 'beforeStart':
      return { availableFrom: params.shift.beforeStart, lateCheckout: false };
    case 'early':
    case 'late':
      return { availableFrom: minuteIn(rng, checkout[segment].from, checkout[segment].to), lateCheckout: false };
    case 'lateCheckout':
      return { availableFrom: checkout.lateCheckout.at, lateCheckout: true };
  }
}

/**
 * 续住房和请勿打扰房的可进时刻，即客人出门的时刻。
 * 以 min(1, inRoomAtStart + inRoomBoost) 的概率开工时人在房内，出门时刻在线索的时间窗里抽，
 * 再整体推迟 leaveDelay；否则客人开工前已出门。周末档的这个做法和 prototype/README.md 一致。
 */
function drawGuestLeaves(rng: Rng, params: Params, clue: StayClue): Minute {
  const { inRoomAtStart, leaveFrom, leaveTo } = params.stayClues[clue];
  const { inRoomBoost, leaveDelay } = params.guests;
  if (!rng.chance(Math.min(1, inRoomAtStart + inRoomBoost))) return params.shift.beforeStart;
  return minuteIn(rng, leaveFrom + leaveDelay, leaveTo + leaveDelay);
}

/** 请勿打扰房的摘牌时刻；null 表示整班不摘。 */
function drawDndLift(rng: Rng, params: Params): Minute | null {
  const { liftChance, liftFrom, liftTo } = params.dnd;
  return rng.chance(liftChance) ? minuteIn(rng, liftFrom, liftTo) : null;
}

function isVipCandidate(room: RoomTruth): boolean {
  return room.kind === 'departure' && !room.lateCheckout;
}

/** 贵宾候选不够时，把缺的数量的延迟退房房改成普通退房（见文件开头第 4 条）。 */
function ensureVipCandidates(rooms: RoomTruth[], params: Params, rng: Rng): RoomTruth[] {
  const shortfall = params.vipDeadlines.length - rooms.filter(isVipCandidate).length;
  if (shortfall <= 0) return rooms;

  const lateIds = rooms.filter((room) => room.kind === 'departure' && room.lateCheckout).map((room) => room.id);
  const promoted = new Set(rng.shuffle(lateIds).slice(0, shortfall));
  return rooms.map((room) =>
    promoted.has(room.id) ? { ...room, ...drawCheckout(rng, params, ON_TIME_SEGMENTS) } : room,
  );
}

/** 从候选里随机抽出贵宾房，按 vipDeadlines 的顺序依次分配时限。 */
function assignVipDeadlines(rooms: RoomTruth[], params: Params, rng: Rng): RoomTruth[] {
  const chosen = rng.shuffle(rooms.filter(isVipCandidate).map((room) => room.id));
  const deadlineOf = new Map<RoomId, Minute>();
  for (const [index, deadline] of params.vipDeadlines.entries()) {
    const id = chosen[index];
    // ensureVipCandidates 之后候选一定够数。
    if (id === undefined) throw new Error('generate: 贵宾候选不够');
    deadlineOf.set(id, deadline);
  }
  return rooms.map((room) => ({ ...room, vipDeadline: deadlineOf.get(room.id) ?? null }));
}
