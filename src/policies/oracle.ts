/**
 * 全知幽灵：知道全部隐藏信息的上界（docs/DESIGN.md 的"全知：已知一切的上界"）。阶段 0 用束搜索，是近似全知，
 * 不保证最优；阶段 2 升级为子集动态规划，在 6 间房的小关卡上和暴力枚举对照。
 *
 * 1. 契约。类型是 OraclePolicy：拿到 World 和 State，返回一个动作。和玩家用同一套合法性：退房房要打电话标记以后
 *    才能去；请勿打扰房要打电话，或者路过、停留在它的门位，得知摘牌以后才能去。知道隐藏信息不等于可以直接去，
 *    所以打电话和路过、停留也在计划里。返回的动作在 legalActions(world, state) 里，等待是 1 到列出的上限之间的
 *    整数分钟；返回之前用 legalActions 核对一遍，不合法就抛错（说明第 7 条的模型和规则对不上）。
 *    纯函数：不在决策之间记东西，同样的 world 和 state 给出同样的动作，不修改传入的参数，没有随机数
 *    （第 5 条新手的走法交给 runShift，它会冻结 state 里的日志条目，值不变，见 src/engine/drive.ts）。
 *    数值都从 world.params 读，束宽是 params.oracle.beamWidth。只从引擎的对外入口和新手（./novice，见第 5 条）导入，
 *    不导入 generate，也用不着种子（tests/engine-purity.test.ts 检查）。班次结束以后调用会抛错。
 *
 * 2. 每一步重新规划。oraclePlan 从传入的状态搜出一份做到收工的完整计划，oracle 返回它的第一个动作，下一步再从新的
 *    状态重新搜。不缓存计划：同一个状态不管从哪里来、什么时候问，答案都一样，回放和中途接手都可以直接调用。
 *    代价是每个决策点都搜一遍。本机实测（束宽 24）一班二十来个决策点，每个约 1 毫秒，一班约 20 毫秒（含新手的走法）；
 *    照这个算，以后 npm run sim 的 1000 个种子乘三档约一分钟。
 *    束搜索不是时间一致的：开工时的计划，和照着每一步重新规划实际做出来的结果，可能差几分钟，多数时候相同，
 *    不同时多半是实际的更好。
 *
 * 3. 动作的粒度。搜索里的一步是"去做一间房"，展开成一串引擎动作：
 *      [回服务间补货] [回服务间休息] [原地等待……] [打电话] [原地等待……] 打扫这间房
 *    方括号里的都可以没有。等待按 waitStepMinutes 拆成几次，最后一次等剩下的分钟数。
 *    - 补货和休息只放在去某间房之前，两样都要时先补货再休息（同在服务间）；14:30 起还没休息，下一个动作只能是休息，
 *      这时先休息。还没到能休息的时候，先原地等到走过去正好 10:30。
 *    - 退房房还没标记：去之前打一次电话，挂断时刻正好是它退房的时刻，已经过了就马上打。
 *    - 请勿打扰房还不知道摘牌：去之前打一次电话，挂断时刻正好是摘牌的时刻；或者人已经在它的门位上，就原地等到摘牌。
 *      路过、停留时看到摘牌，照规则逐个门位算，看到了就不用再打。
 *    - 客人还没出门的续住房和请勿打扰房：原地等到出发以后正好在客人出门时到门口（也不早于状态里已有的回来时间），
 *      不敲会被拒的门。电话要是也得打，就放在这段等待的末尾，挂断时刻尽量晚，问出来的消息不会更少。
 *    - 一通电话标记挂断以前退房的全部退房房，也得知那以前摘牌的全部请勿打扰房；后面要去的房间因此已经标记、
 *      已知摘牌的，就不用再打。
 *    收尾是最后一步：还没休息先休息；17:00 前收工不合法（还有要做、却来不及在 17:00 前做完的房间）时，来得及就先
 *    回服务间补一次货，在那里等到 17:00，17:00 起还车不用再走路；然后收工还车。
 *
 * 4. 束搜索。按计划里做完的房间数分层。每层从上一层留下的每个局面出发，试每间没做完的房间，配上可选的补货、休息和
 *    得知能进的办法（打电话、在门口等摘牌），去掉进不去、来不及、做到 17:00 会被截断的；
 *    同样的（做完的房间、已知的标记和摘牌、位置、布草、是否休息过）只留估值小的那个，再按估值留 beamWidth 个。
 *    每个局面也试一次收尾，所有收尾里等效下班时间最小的就是计划。估值是估计的等效下班时间：现在加上剩下的打扫、
 *    休息、补货、电话和步行的下界，不早于每间房最早能做完的时刻，再加上已有的罚时和看得出来躲不掉的罚时
 *    （赶不上的时限、17:00 前做不完的房间）。只在同一层里比较，不要求是下界。
 *
 * 5. 不比新手差。新手从这个状态起做到收工的走法（用共用驱动函数 runShift 按规则真的走一遍）也是候选，严格更好时用它的第一个动作。
 *    所以每一步的计划都不比新手从这一步接着做差。实际做出来的结果因为第 2 条的重新规划，不严格保证这一点，
 *    测试在一批固定的种子上核对平均成绩不差于新手。
 *
 * 6. 近似。docs/TASKS.md 里也列了。
 *    - 不去会被拒的房间，所以不会得知新的回来时间；状态里已有的回来时间照样遵守。也就用不上"敲一扇会被拒的门，
 *      换个位置"这种走法。
 *    - 电话只在去一间要它的房间之前打，挂断时刻掐在第 3 条说的时刻；不在空等的时候顺路先打一通，留给后面的房间用
 *      （试过这种走法，平均成绩几乎不变，搜索却慢三分之一，就去掉了）。
 *    - 补货和休息只放在去某间房之前和收尾里。
 *    - 不开始做到 17:00 会被截断的房间：截断的房间不算完成。
 *    - 束搜索不穷举，每层只留 beamWidth 个局面；每一步重新规划，前后的计划不一定一致（第 2 条）。
 *
 * 7. 模型和规则。搜索不调用 apply（太慢），在一个只有数字的模型里照 rules.ts 的规则推演：合法性、逐个门位的步行和
 *    门位观察、等待和动作结束时的门位观察、电话按挂断时刻标记、打扫的分钟数（cleanMinutes）、布草、14:30 和 17:00，
 *    以及 score.ts 的计分。测试从随机可达的状态出发，用 apply 重放 oraclePlan 的全部动作，成绩必须和计划给出的
 *    完全相同。
 */

import {
  cleanMinutes,
  legalActions,
  runShift,
  score,
  walkMinutes,
  walkPath,
  type Action,
  type Minute,
  type OraclePolicy,
  type Params,
  type Place,
  type RoomId,
  type RoomKind,
  type State,
  type World,
} from '../engine';
import { novice } from './novice';

/** 全知幽灵：从这个状态重新规划，返回计划的第一个动作（见文件开头）。 */
export const oracle: OraclePolicy = (world, state) => {
  const first = oraclePlan(world, state).actions[0];
  if (first === undefined) throw new Error('全知：计划里没有动作');
  if (!isLegal(first, legalActions(world, state))) {
    throw new Error(`全知：计划的第一个动作 ${JSON.stringify(first)} 不合法，搜索用的模型和规则对不上`);
  }
  return first;
};

/** 全知从某个状态做到收工的计划。 */
export interface OraclePlan {
  /** 从传入的状态起一直到收工还车的全部动作，按执行的顺序。 */
  readonly actions: readonly Action[];
  /** 照这些动作做完这一班的等效下班时间，也就是 score 给出的 equivalentFinish。 */
  readonly equivalentFinish: Minute;
  /** 计划从哪来：束搜索，或者新手的走法（只在它严格更好时）。 */
  readonly source: 'search' | 'novice';
}

/**
 * 从 state 起做到收工的计划（文件开头第 2 到 5 条）：束搜索的结果和新手的走法里，取等效下班时间小的，一样时取束搜索的。
 * 班次已经结束，或者有待回应的事件（阶段 2 才有）时抛错。
 */
export function oraclePlan(world: World, state: State): OraclePlan {
  if (state.ended !== null) throw new Error('全知：班次已经结束，没有合法动作');
  if (state.prompt !== null) throw new Error('全知：阶段 0 没有事件，待回应的事件要到阶段 2 才规划');
  const searched = searchPlan(world, state);
  const greedy = novicePlan(world, state);
  return greedy.equivalentFinish < searched.equivalentFinish ? greedy : searched;
}

/** 等待可以是 1 到列出的上限之间的任意整数分钟，其余的动作要出现在合法动作的列表里。 */
function isLegal(action: Action, legal: readonly Action[]): boolean {
  if (action.type === 'wait') {
    const listed = legal.find((candidate) => candidate.type === 'wait');
    return (
      listed?.type === 'wait' && Number.isInteger(action.minutes) && action.minutes >= 1 && action.minutes <= listed.minutes
    );
  }
  return legal.some((candidate) => sameAction(candidate, action));
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

// ---------------------------------------------------------------------------
// 新手的走法（文件开头第 5 条）
// ---------------------------------------------------------------------------

/**
 * 新手从 state 起做到收工：交给共用驱动函数 runShift（每一步只给新手 observe 的结果和 world.params，用 apply 执行），
 * 最后用 score 计分。
 */
function novicePlan(world: World, state: State): OraclePlan {
  const run = runShift(world, { kind: 'view', policy: novice }, state);
  return { actions: run.actions, equivalentFinish: score(world, run.final).equivalentFinish, source: 'novice' };
}

// ---------------------------------------------------------------------------
// 搜索用的模型（文件开头第 7 条）
// ---------------------------------------------------------------------------

/** 位掩码用 32 位整数的位运算，最高用到第 29 位，房间再多就抛错。 */
const MAX_ROOMS = 30;

/** 模型里的一间房：还没做完，这一班还可能要做。整班不摘牌的请勿打扰房永远不能做，也不算未完成，不进模型。 */
interface ModelRoom {
  /** 这间房在各个房间集合（位掩码）里的位。 */
  readonly bit: number;
  readonly id: RoomId;
  readonly kind: RoomKind;
  /** 门位在位置表里的编号。 */
  readonly place: number;
  /** 门位所在楼层在楼层表里的编号，以及门位号。估值算步行的下界用。 */
  readonly floor: number;
  readonly door: number;
  /** 还要打扫的分钟数。 */
  readonly minutes: Minute;
  /** 开门时要扣的布草；接着做被打断的房间时为 0。 */
  readonly linen: number;
  /**
   * 到门口不早于这个时刻才进得去，早到就会被拒或者不合法：续住房和请勿打扰房是客人出门的时刻，状态里有回来时间的
   * 取两者中晚的；退房房标记了就一定已退，只看回来时间。没有限制时是负无穷。
   */
  readonly enterFrom: Minute;
  /**
   * 要打电话问的事发生的时刻：退房房是退房时刻，请勿打扰房是摘牌时刻。挂断时刻不早于它的电话就能问出来，
   * 请勿打扰房在这个时刻以后路过、停留也能看到。续住房为 null。
   */
  readonly infoAt: Minute | null;
  readonly vipDeadline: Minute | null;
  readonly rushDeadline: Minute | null;
}

/** 步行途中经过一个有请勿打扰房的门位：位置编号，以及从出发算起第几分钟到那里。 */
interface Sighting {
  readonly place: number;
  readonly offset: Minute;
}

/** 一次规划用的模型。位置只有服务间、开始时所在的位置和各房间的门位，各出现一次，按编号查表。 */
interface Model {
  readonly params: Params;
  /** 按 world.rooms 的顺序。 */
  readonly rooms: readonly ModelRoom[];
  readonly placeCount: number;
  /** 服务间的位置编号。 */
  readonly service: number;
  /** 每个位置所在楼层在楼层表里的编号，以及门位号。 */
  readonly placeFloor: readonly number[];
  readonly placeDoor: readonly number[];
  /** 楼层表的长度，以及服务间所在楼层的编号。 */
  readonly floorCount: number;
  readonly serviceFloor: number;
  /** walk[a * placeCount + b]：从 a 走到 b 的分钟数（walkMinutes）。 */
  readonly walk: readonly Minute[];
  /** sightings[a * placeCount + b]：从 a 走到 b 途中（含起点和终点）经过的有请勿打扰房的门位（walkPath）。 */
  readonly sightings: readonly (readonly Sighting[])[];
  /** doorRooms[p]：门位 p 上模型里的请勿打扰房。 */
  readonly doorRooms: readonly (readonly ModelRoom[])[];
  /** 搜索开始之前已经做完的房间的超时罚时（贵宾、催房）。 */
  readonly settled: Minute;
  /** 去重用的数字键的进位；房间太多、数字键可能超过安全整数时为 null，改用字符串键。 */
  readonly keyScale: { readonly rooms: number; readonly cart: number } | null;
}

/** 搜索树上的一个局面：从开始的状态照计划做了若干步以后。 */
interface Node {
  readonly t: Minute;
  readonly place: number;
  readonly cart: number;
  readonly rested: boolean;
  /** 计划里做完的房间。 */
  readonly done: number;
  /** 已被标记已退的退房房和已知摘牌的请勿打扰房（两种房型，位不重叠）。 */
  readonly known: number;
  /** 计划里做完的房间超时的罚时。 */
  readonly late: Minute;
  readonly parent: Node | null;
  /** 从 parent 走到这里的那一步；开始的局面为 null。 */
  readonly step: Step | null;
  /** 排序用的估值：估计的等效下班时间（文件开头第 4 条）。 */
  readonly estimate: number;
}

/** 去之前怎样得知这间房能进：不用（续住房，或者已经标记、已知摘牌）；打一次电话；在它的门位原地等到摘牌。 */
type Learn = 'none' | 'call' | 'door';

/** 计划里的一步（文件开头第 3 条）：可选的补货、休息，然后去打扫一间房。 */
interface Step {
  readonly restock: boolean;
  readonly rest: boolean;
  readonly room: ModelRoom;
  readonly learn: Learn;
}

/** 搜索里收尾的局面和它的等效下班时间。 */
interface Ending {
  readonly node: Node;
  readonly score: Minute;
}

function item<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`全知：下标 ${index} 越界`);
  return value;
}

/** 从 world 和 state 建模型，以及搜索开始的局面。 */
function buildModel(world: World, state: State): { model: Model; root: Node } {
  const { params } = world;
  if (state.rooms.length !== world.rooms.length) throw new Error('全知：state 和 world 的房间对不上');

  const places: Place[] = [];
  const placeIds = new Map<string, number>();
  const placeKey = (place: Place): string => `${place.floor}:${place.door}`;
  const placeOf = (place: Place): number => {
    const found = placeIds.get(placeKey(place));
    if (found !== undefined) return found;
    places.push({ floor: place.floor, door: place.door });
    placeIds.set(placeKey(place), places.length - 1);
    return places.length - 1;
  };
  const service = placeOf(params.layout.servicePoint);
  const start = placeOf(state.place);
  for (const truth of world.rooms) placeOf(truth.place);

  const floors = [...new Set(places.map((place) => place.floor))];
  const placeFloor = places.map((place) => floors.indexOf(place.floor));
  const placeDoor = places.map((place) => place.door);

  const { vipLate, rushLate } = params.penalties;
  let settled = 0;
  let known = 0;
  const rooms: ModelRoom[] = [];
  world.rooms.forEach((truth, index) => {
    const progress = state.rooms[index];
    if (progress === undefined || progress.id !== truth.id) throw new Error('全知：state 和 world 的房间对不上');
    if (progress.doneAt !== null) {
      if (truth.vipDeadline !== null && progress.doneAt > truth.vipDeadline) settled += vipLate;
      if (progress.rushDeadline !== null && progress.doneAt > progress.rushDeadline) settled += rushLate;
      return;
    }
    if (truth.kind === 'dnd' && truth.dndLiftsAt === null) return;
    if (rooms.length >= MAX_ROOMS) throw new Error(`全知：搜索最多支持 ${MAX_ROOMS} 间没做完的房间`);
    const bit = 1 << rooms.length;
    const place = placeOf(truth.place);
    const comeBack = progress.knownAvailableFrom ?? Number.NEGATIVE_INFINITY;
    const linen = truth.kind === 'departure' ? params.rooms.departure.linen : params.rooms.stayover.linen;
    rooms.push({
      bit,
      id: truth.id,
      kind: truth.kind,
      place,
      floor: item(placeFloor, place),
      door: item(placeDoor, place),
      minutes: cleanMinutes(truth.kind, truth.mess, params) - progress.workDone,
      linen: progress.workDone > 0 ? 0 : linen,
      enterFrom: truth.kind === 'departure' ? comeBack : Math.max(truth.availableFrom, comeBack),
      infoAt: truth.kind === 'departure' ? truth.availableFrom : truth.kind === 'dnd' ? truth.dndLiftsAt : null,
      vipDeadline: truth.vipDeadline,
      rushDeadline: progress.rushDeadline,
    });
    if ((truth.kind === 'departure' && progress.flaggedDeparted) || (truth.kind === 'dnd' && progress.dndLiftKnown)) {
      known |= bit;
    }
  });

  const placeCount = places.length;
  const doorRooms = places.map((_, index) => rooms.filter((room) => room.kind === 'dnd' && room.place === index));
  const walk: Minute[] = [];
  const sightings: Sighting[][] = [];
  for (const from of places) {
    for (const to of places) {
      walk.push(walkMinutes(from, to, params));
      const seen: Sighting[] = [];
      for (const step of walkPath(from, to, params)) {
        const index = placeIds.get(placeKey(step.place));
        if (index !== undefined && item(doorRooms, index).length > 0) seen.push({ place: index, offset: step.offset });
      }
      sightings.push(seen);
    }
  }

  const roomStates = 2 ** rooms.length;
  const cartStates = params.cart.capacity + 1;
  const keyScale =
    roomStates * roomStates * placeCount * cartStates * 2 <= Number.MAX_SAFE_INTEGER
      ? { rooms: roomStates, cart: cartStates }
      : null;

  const model: Model = {
    params,
    rooms,
    placeCount,
    service,
    placeFloor,
    placeDoor,
    floorCount: floors.length,
    serviceFloor: item(placeFloor, service),
    walk,
    sightings,
    doorRooms,
    settled,
    keyScale,
  };
  const root: Node = {
    t: state.minute,
    place: start,
    cart: state.cart,
    rested: state.breakTaken,
    done: 0,
    known,
    late: 0,
    parent: null,
    step: null,
    estimate: 0,
  };
  return { model, root };
}

/**
 * 在模型里照规则推演的游标，从一个局面出发执行一步或收尾。和 rules.ts 逐条对应：哪些动作合法，步行时逐个门位观察，
 * 等待和每个动作结束时在所在门位再看一眼，电话按挂断时刻标记，打扫扣布草、算超时；收尾按 score.ts 计分。
 * out 不为 null 时，把对应的引擎动作依次写进去。
 */
class Cursor {
  t = 0;
  place = 0;
  cart = 0;
  rested = false;
  done = 0;
  known = 0;
  late = 0;
  private out: Action[] | null = null;
  private readonly model: Model;

  constructor(model: Model) {
    this.model = model;
  }

  reset(node: Node, out: Action[] | null): void {
    this.t = node.t;
    this.place = node.place;
    this.cart = node.cart;
    this.rested = node.rested;
    this.done = node.done;
    this.known = node.known;
    this.late = node.late;
    this.out = out;
  }

  /**
   * 执行一步（文件开头第 3 条）。不合法、进不去或者做到 17:00 会被截断就返回 false，游标停在半路，调用方丢弃它。
   */
  run(restock: boolean, rest: boolean, room: ModelRoom, learn: Learn): boolean {
    const { params } = this.model;
    const { breakLatest, hardStop } = params.shift;
    if (!this.rested && this.t >= breakLatest && this.t < hardStop) {
      // 14:30 起还没休息：下一个动作只能是休息，补货放在休息以后。
      if (!rest || !this.rest() || (restock && !this.restock())) return false;
    } else if ((restock && !this.restock()) || (rest && !this.rest())) {
      return false;
    }

    // 还要问的事发生的时刻：没标记的退房房是退房时刻，不知道摘牌的请勿打扰房是摘牌时刻；不用问为 null。
    const pending = room.infoAt !== null && (this.known & room.bit) === 0 ? room.infoAt : null;
    // 出发的最早时刻：再早到门口就会被拒。下面的等待和电话都不离开这里，它不变。
    const leave = room.enterFrom - this.walkOf(this.place, room.place);
    if (learn === 'call') {
      // 挂断时刻正好是退房或摘牌的时刻；客人还没出门的，挂断时刻推到出发的时刻，问出来的消息不会更少。
      if (pending === null) return false;
      if (!this.waitUntil(Math.max(pending, leave) - params.callMinutes) || !this.call()) return false;
    } else if (learn === 'door') {
      // 已经站在这间请勿打扰房的门位上：原地等到摘牌，等待结束时就看到了。
      if (pending === null || room.kind !== 'dnd' || this.place !== room.place) return false;
      if (!this.waitUntil(pending)) return false;
    } else if (pending !== null) {
      return false;
    }
    return this.waitUntil(leave) && this.service(room);
  }

  /**
   * 收尾（文件开头第 3 条）：还没休息先休息；17:00 前收工不合法，就先回服务间补一次货（来得及的话），等到 17:00；
   * 然后收工还车。返回这一班的等效下班时间，算法和 score.ts 相同；做不到时返回 null。
   */
  close(): Minute | null {
    const { params, rooms, service, settled } = this.model;
    const { hardStop, returnCartMinutes } = params.shift;
    if (this.t < hardStop && !this.rested && !this.rest()) return null;
    if (this.t < hardStop && !this.canFinish()) {
      const toService = this.walkOf(this.place, service);
      if (this.place !== service && this.t + toService + params.cart.restockMinutes <= hardStop && !this.restock()) {
        return null;
      }
      if (!this.waitUntil(hardStop)) return null;
    }
    // 收工时刻：自己收工是选择收工的那一刻，强制下班就是 17:00。
    const quit = this.t >= hardStop ? hardStop : this.t;
    this.out?.push({ type: 'finish' });
    this.walkTo(service);
    this.t += returnCartMinutes;
    const { vipLate, rushLate, unfinished } = params.penalties;
    let total = this.t + settled + this.late;
    for (const room of rooms) {
      if ((this.done & room.bit) !== 0) continue;
      if (room.vipDeadline !== null) total += vipLate;
      if (room.rushDeadline !== null) total += rushLate;
      // 请勿打扰房按真相算：摘牌时刻不晚于收工时刻才算未完成。
      if (room.kind !== 'dnd' || (room.infoAt !== null && room.infoAt <= quit)) total += unfinished;
    }
    return total;
  }

  private walkOf(from: number, to: number): Minute {
    return item(this.model.walk, from * this.model.placeCount + to);
  }

  /** 在门位 place 的 at 这一分钟看一眼：已经摘牌的请勿打扰房就此得知。 */
  private see(place: number, at: Minute): void {
    for (const room of item(this.model.doorRooms, place)) {
      if (room.infoAt !== null && room.infoAt <= at) this.known |= room.bit;
    }
  }

  /** 走到 target：途中每到一个门位（含起点和终点），在到达的那一分钟看一眼。 */
  private walkTo(target: number): void {
    const { placeCount, sightings } = this.model;
    for (const sighting of item(sightings, this.place * placeCount + target)) this.see(sighting.place, this.t + sighting.offset);
    this.t += this.walkOf(this.place, target);
    this.place = target;
  }

  /** 这一刻能做休息以外的动作：17:00 之前，并且已经休息过或者还没到 14:30。 */
  private canAct(): boolean {
    const { hardStop, breakLatest } = this.model.params.shift;
    return this.t < hardStop && (this.rested || this.t < breakLatest);
  }

  /** 原地等到 target：每次最多等 waitStepMinutes，最后一次等剩下的；每次等待开始时都要合法。 */
  private waitUntil(target: Minute): boolean {
    if (target <= this.t) return true;
    const { params } = this.model;
    const { hardStop, breakLatest } = params.shift;
    if (target > hardStop) return false;
    const step = params.waitStepMinutes;
    const lastStart = this.t + step * Math.floor((target - this.t - 1) / step);
    if (!this.rested && lastStart >= breakLatest) return false;
    if (this.out !== null) {
      for (let at = this.t; at < target; at += step) this.out.push({ type: 'wait', minutes: Math.min(step, target - at) });
    }
    this.t = target;
    // 中间每次等待结束时也看一眼，最后一次看到的包含前面的。
    this.see(this.place, target);
    return true;
  }

  private restock(): boolean {
    const { params, service } = this.model;
    if (!this.canAct() || this.t + this.walkOf(this.place, service) + params.cart.restockMinutes > params.shift.hardStop) {
      return false;
    }
    this.out?.push({ type: 'restock' });
    this.walkTo(service);
    this.t += params.cart.restockMinutes;
    this.cart = params.cart.capacity;
    this.see(service, this.t);
    return true;
  }

  /** 回服务间休息。还不能休息时，先原地等到走过去正好能休息；14:30 起还没休息则马上去。 */
  private rest(): boolean {
    const { params, service } = this.model;
    const { hardStop, breakEarliest, breakLatest, breakMinutes } = params.shift;
    if (this.rested || this.t >= hardStop) return false;
    const walk = this.walkOf(this.place, service);
    if (this.t < breakLatest && this.t + walk < breakEarliest && !this.waitUntil(breakEarliest - walk)) return false;
    this.out?.push({ type: 'break' });
    this.walkTo(service);
    this.t += breakMinutes;
    this.rested = true;
    this.see(service, this.t);
    return true;
  }

  /** 打给主管：挂断时刻已经退房的退房房标记已退，已经摘牌的请勿打扰房得知摘牌。 */
  private call(): boolean {
    const { params, rooms } = this.model;
    const hangUp = this.t + params.callMinutes;
    if (!this.canAct() || hangUp > params.shift.hardStop) return false;
    this.out?.push({ type: 'call' });
    for (const room of rooms) {
      if (room.infoAt !== null && room.infoAt <= hangUp) this.known |= room.bit;
    }
    this.t = hangUp;
    this.see(this.place, hangUp);
    return true;
  }

  /** 打扫一间房：要已知能进、布草够、到门口时客人已出门，并且在 17:00 前做完。 */
  private service(room: ModelRoom): boolean {
    if (!this.canAct() || (this.done & room.bit) !== 0) return false;
    if (room.infoAt !== null && (this.known & room.bit) === 0) return false;
    const { params } = this.model;
    const { hardStop } = params.shift;
    const arrival = this.t + this.walkOf(this.place, room.place);
    if (arrival + params.knockRefusedMinutes > hardStop || arrival < room.enterFrom || room.linen > this.cart) return false;
    const end = arrival + room.minutes;
    if (end > hardStop) return false;
    this.out?.push({ type: 'service', room: room.id });
    this.walkTo(room.place);
    this.cart -= room.linen;
    this.t = end;
    this.done |= room.bit;
    if (room.vipDeadline !== null && end > room.vipDeadline) this.late += params.penalties.vipLate;
    if (room.rushDeadline !== null && end > room.rushDeadline) this.late += params.penalties.rushLate;
    this.see(room.place, end);
    return true;
  }

  /** 17:00 前收工的条件：已休息；没做完的只剩还不知道摘牌的请勿打扰房。 */
  private canFinish(): boolean {
    return (
      this.rested &&
      this.model.rooms.every(
        (room) => (this.done & room.bit) !== 0 || (room.kind === 'dnd' && (this.known & room.bit) === 0),
      )
    );
  }
}

// ---------------------------------------------------------------------------
// 束搜索（文件开头第 4 条）
// ---------------------------------------------------------------------------

/** 搜出计划，再从开始的局面照着走一遍，把每一步展开成引擎动作。 */
function searchPlan(world: World, state: State): OraclePlan {
  const { model, root } = buildModel(world, state);
  const best = beamSearch(model, root);
  const steps: Step[] = [];
  for (let node: Node | null = best.node; node !== null && node.step !== null; node = node.parent) steps.push(node.step);
  steps.reverse();

  const actions: Action[] = [];
  const cursor = new Cursor(model);
  cursor.reset(root, actions);
  for (const step of steps) {
    if (!cursor.run(step.restock, step.rest, step.room, step.learn)) throw new Error('全知：照计划重走时有一步不成立');
  }
  const total = cursor.close();
  if (total !== best.score) throw new Error('全知：照计划重走得到的成绩和搜索时不同');
  return { actions, equivalentFinish: total, source: 'search' };
}

function beamSearch(model: Model, root: Node): Ending {
  const width = model.params.oracle.beamWidth;
  if (!(Number.isInteger(width) && width >= 1)) throw new Error(`全知：束宽 ${width} 要是正整数`);
  const cursor = new Cursor(model);
  const farthest = new Array<number>(model.floorCount).fill(-1);
  let best: Ending | null = null;
  let layer: Node[] = [root];
  while (layer.length > 0) {
    const next = new Map<number | string, Node>();
    for (const node of layer) {
      cursor.reset(node, null);
      const total = cursor.close();
      if (total !== null && (best === null || total < best.score)) best = { node, score: total };
      expand(model, cursor, farthest, node, next);
    }
    layer = [...next.values()].sort((a, b) => a.estimate - b.estimate || a.t - b.t).slice(0, width);
  }
  // 开始的局面总能收尾：先休息，等到 17:00，再还车。
  if (best === null) throw new Error('全知：找不到能收尾的计划');
  return best;
}

/** 从 node 出发试下一步的每一种做法，成立的放进 next（同一个键只留估值小的）。 */
function expand(model: Model, cursor: Cursor, farthest: number[], node: Node, next: Map<number | string, Node>): void {
  const { params, rooms } = model;
  let linenNeeded = 0;
  for (const room of rooms) if ((node.done & room.bit) === 0) linenNeeded += room.linen;
  // 车里的布草够做完剩下的房间时，补货没有用。
  const canRestock = node.cart < params.cart.capacity && linenNeeded > node.cart;
  for (const room of rooms) {
    if ((node.done & room.bit) !== 0) continue;
    const needsInfo = room.infoAt !== null && (node.known & room.bit) === 0;
    for (const [restock, rest] of PRE_STEPS) {
      if ((restock && !canRestock) || (rest && node.rested)) continue;
      tryStep(model, cursor, farthest, node, next, { restock, rest, room, learn: needsInfo ? 'call' : 'none' });
      // 在门口等摘牌只在已经站在它的门位上时成立，补货、休息都会离开门位。
      if (needsInfo && room.kind === 'dnd' && !restock && !rest) {
        tryStep(model, cursor, farthest, node, next, { restock, rest, room, learn: 'door' });
      }
    }
  }
}

/** 去一间房之前可选的补货和休息：都不做、只补货、只休息、两样都做。 */
const PRE_STEPS: readonly (readonly [boolean, boolean])[] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

function tryStep(
  model: Model,
  cursor: Cursor,
  farthest: number[],
  parent: Node,
  next: Map<number | string, Node>,
  step: Step,
): void {
  cursor.reset(parent, null);
  if (!cursor.run(step.restock, step.rest, step.room, step.learn)) return;
  const key = keyOf(model, cursor);
  const seen = next.get(key);
  // 同一个键：时刻和罚时都不比已有的少，估值也就不会更小，不用再算。
  if (seen !== undefined && cursor.t >= seen.t && cursor.late >= seen.late) return;
  const value = estimate(model, cursor, farthest);
  if (seen !== undefined && (value > seen.estimate || (value === seen.estimate && cursor.t >= seen.t))) return;
  next.set(key, {
    t: cursor.t,
    place: cursor.place,
    cart: cursor.cart,
    rested: cursor.rested,
    done: cursor.done,
    known: cursor.known,
    late: cursor.late,
    parent,
    step,
    estimate: value,
  });
}

/** 去重的键：做完的房间、已知的标记和摘牌、位置、布草、是否休息过。 */
function keyOf(model: Model, cursor: Cursor): number | string {
  const rested = cursor.rested ? 1 : 0;
  const scale = model.keyScale;
  if (scale === null) return `${cursor.done}:${cursor.known}:${cursor.place}:${cursor.cart}:${rested}`;
  return (((cursor.done * scale.rooms + cursor.known) * model.placeCount + cursor.place) * scale.cart + cursor.cart) * 2 + rested;
}

/**
 * 估值：估计的等效下班时间（文件开头第 4 条），只用来给同一层的局面排序。时刻和罚时越多，估值不会越小。
 * farthest 是按楼层记最远门位的草稿数组，每次重填。
 */
function estimate(model: Model, cursor: Cursor, farthest: number[]): number {
  const { params, rooms, placeCount, walk } = model;
  const { shift, penalties } = params;
  farthest.fill(-1);
  let work = 0;
  let linen = 0;
  let count = 0;
  let needCall = false;
  // 每间房最早能做完的时刻里最晚的那个：整班不会早于它结束。
  let lastEnd = cursor.t;
  let penalty = model.settled + cursor.late;
  const from = cursor.place * placeCount;
  for (const room of rooms) {
    if ((cursor.done & room.bit) !== 0) continue;
    count++;
    work += room.minutes;
    linen += room.linen;
    if (room.door > item(farthest, room.floor)) farthest[room.floor] = room.door;
    const distance = item(walk, from + room.place);
    let arrive = cursor.t + distance;
    if (room.infoAt !== null && (cursor.known & room.bit) === 0) {
      needCall = true;
      arrive = Math.max(cursor.t + params.callMinutes, room.infoAt) + distance;
      if (room.kind === 'dnd' && cursor.place === room.place) arrive = Math.min(arrive, Math.max(cursor.t, room.infoAt));
    }
    const end = Math.max(arrive, room.enterFrom) + room.minutes;
    if (end > lastEnd) lastEnd = end;
    if (room.vipDeadline !== null && end > room.vipDeadline) penalty += penalties.vipLate;
    if (room.rushDeadline !== null && end > room.rushDeadline) penalty += penalties.rushLate;
  }
  const restocks = linen > cursor.cart ? Math.ceil((linen - cursor.cart) / params.cart.capacity) : 0;
  const busy =
    cursor.t +
    work +
    (needCall ? params.callMinutes : 0) +
    restocks * params.cart.restockMinutes +
    (cursor.rested ? 0 : shift.breakMinutes) +
    walkBound(model, cursor.place, farthest);
  const restEnd = cursor.rested ? Number.NEGATIVE_INFINITY : shift.breakEarliest + shift.breakMinutes;
  const workEnd = Math.max(busy, lastEnd, restEnd);
  if (count > 0 && workEnd > shift.hardStop) {
    // 17:00 前做不完：按每间的平均分钟数估出做不完的间数，每间算未完成。
    const missed = Math.ceil((workEnd - shift.hardStop) / (work / count));
    return shift.hardStop + shift.returnCartMinutes + penalty + missed * penalties.unfinished;
  }
  return workEnd + shift.returnCartMinutes + penalty;
}

/**
 * 从 place 出发走遍剩下的房间、最后回到服务间，至少要走多少分钟（不管时间窗，是下界）。
 * 每一层要走到最远的那个门位再回到电梯厅（出发的那一层从当前门位算），每进一次别的楼层乘一趟电梯，
 * 最后要回到服务间那一层。farthest[f] 是第 f 层剩下的房间里最远的门位，没有剩下的房间为 -1。
 */
function walkBound(model: Model, place: number, farthest: readonly number[]): Minute {
  const { walkMinutesPerDoor, liftMinutes } = model.params.layout;
  const hereFloor = item(model.placeFloor, place);
  const hereDoor = item(model.placeDoor, place);
  let doors = 0;
  let rides = 0;
  for (let floor = 0; floor < model.floorCount; floor++) {
    const far = item(farthest, floor);
    if (far < 0) continue;
    if (floor === hereFloor) {
      doors += Math.max(far, hereDoor) + Math.max(0, far - hereDoor);
    } else {
      doors += 2 * far;
      rides++;
    }
  }
  if (item(farthest, hereFloor) < 0) doors += hereDoor;
  if (hereFloor === model.serviceFloor) {
    if (rides > 0) rides++;
  } else if (item(farthest, model.serviceFloor) < 0) {
    rides++;
  }
  return doors * walkMinutesPerDoor + rides * liftMinutes;
}
