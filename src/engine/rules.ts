/**
 * 班次规则：初始状态、合法动作和动作的结算。规则的出处是 docs/DESIGN.md。
 *
 * 1. 纯函数。没有随机数，不读系统时间，所有数值从 world.params 读。
 *    apply 不修改传入的 world、state、action。返回的新 State 复制 rooms 数组，只替换有变化的房间；
 *    log 用新数组追加一条；不用深拷贝。相邻两个 State 可以共享没变的部分，但不与 params 共享对象
 *    （例如 place 从 servicePoint 复制一份）。State 里只放普通对象和数组。
 *
 * 2. 合法性只读玩家已知的信息，只写一份。knownStateOf 把 (world, state) 投影成 KnownState，
 *    里面没有 availableFrom、mess、dndLiftsAt、descriptionId、world.events、world.seed。
 *    illegalReason(known, action, params) 是唯一的判定函数：合法返回 null，非法返回中文原因。
 *    legalActions 用它过滤 candidateActions 列出的候选；apply 只用它校验提交的这一个动作，不生成整张列表。
 *    判定函数读不到隐藏信息，所以在只差隐藏信息的两个世界里，同一个非法动作的报错文字完全相同。
 *
 * 3. 动作按时间线推进。Timeline 是一个动作执行中的草稿：walkTo 沿 layout.walkPath 逐个门位步行
 *    （含乘电梯），每到一个门位（包括起点和终点），在到达的那一分钟做一次门位观察；然后是动作本身
 *    （doService、doRestock 等）；closeAction 在结束的那一分钟对所在门位再观察一次，写出新的 State。
 *    门位观察只揭晓请勿打扰房已摘牌，不揭晓别的隐藏信息。17:00 截断用同一条时间线。
 *    段与段之间调用 eventCheckpoint，阶段 2 在那里处理事件，现在什么都不做。
 *
 * 4. 每次 apply 恰好追加一条日志，引擎从不自动追加记录。
 */

import { toClock } from './clock';
import { walkMinutes, walkPath } from './layout';
import type { Params } from './params';
import type {
  Action,
  LogEntry,
  MessLevel,
  Minute,
  Outcome,
  Place,
  RoomId,
  RoomKind,
  RoomProgress,
  RoomTruth,
  ShiftEnd,
  State,
  World,
} from './types';

/** 判断打扫分钟是不是整数时容许的浮点误差。这不是玩法数值，所以不放 params。 */
const INTEGER_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// 对外的函数
// ---------------------------------------------------------------------------

/**
 * 开工时的状态：08:30，人和满载的布草车在服务间，所有房间都没有进度。
 * 开工前已退房的退房房也不预先标记，要打电话才知道。房间按 world.rooms 的顺序排列。
 */
export function initial(world: World): State {
  const { params } = world;
  return {
    // 开工是第 0 分钟（08:30）。
    minute: 0,
    place: copyPlace(params.layout.servicePoint),
    cart: params.cart.capacity,
    breakTaken: false,
    rooms: world.rooms.map(
      (truth): RoomProgress => ({
        id: truth.id,
        doneAt: null,
        workDone: 0,
        flaggedDeparted: false,
        knownAvailableFrom: null,
        messRevealed: false,
        dndLiftKnown: false,
        rushDeadline: null,
      }),
    ),
    prompt: null,
    firedEvents: [],
    violation: false,
    ended: null,
    log: [],
  };
}

/**
 * 当前状态下全部合法的动作，顺序固定：service 按 world.rooms 的顺序在前，
 * 然后依次是 restock、call、break、wait、finish 中合法的那些。wait 只列一个，分钟数取上限。
 * 班次结束后返回空数组。只读玩家已知的信息。
 */
export function legalActions(world: World, state: State): Action[] {
  const { params } = world;
  const known = knownStateOf(world, state);
  return candidateActions(known, params).filter((action) => illegalReason(known, action, params) === null);
}

/**
 * 执行一个动作，返回新的状态，并在日志里追加恰好一条记录。
 * 先校验这一个动作的合法性，非法就抛 Error（中文，只写玩家已知的原因）。
 */
export function apply(world: World, state: State, action: Action): State {
  const reason = illegalReason(knownStateOf(world, state), action, world.params);
  if (reason !== null) throw new Error(reason);

  const timeline = startTimeline(world, state);
  const outcome = runAction(timeline, action);
  return closeAction(timeline, state, action, outcome);
}

/**
 * 打扫一间房的总分钟数：基础时间（请勿打扰房用续住房的）乘脏乱系数。结果不是整数就抛错。
 * 先用 Math.round 吸收浮点误差（例如 45 乘 1.4 在浮点里不是正好 63），离整数超过 1e-9 才算不是整数。
 */
export function cleanMinutes(kind: RoomKind, mess: MessLevel, params: Params): Minute {
  const base = roomSpec(kind, params).baseMinutes;
  const multiplier = params.messMultiplier[mess];
  const exact = base * multiplier;
  const minutes = Math.round(exact);
  // 写成"不满足 <="，这样 NaN 和 Infinity 也会报错。
  if (!(Math.abs(exact - minutes) <= INTEGER_TOLERANCE)) {
    throw new Error(`cleanMinutes: ${kind} 的基础时间 ${base} 乘 ${mess} 的系数 ${multiplier} 得 ${exact}，不是整数分钟`);
  }
  return minutes;
}

// ---------------------------------------------------------------------------
// 合法性：只读玩家已知的信息，只写一份
// ---------------------------------------------------------------------------

/** 判定合法性时能看到的一间房：任务单上的公开字段，加上进度里玩家已知的字段。 */
type KnownRoom = Pick<RoomTruth, 'id' | 'place' | 'kind' | 'clue' | 'lateCheckout' | 'vipDeadline'> &
  Pick<
    RoomProgress,
    'doneAt' | 'workDone' | 'flaggedDeparted' | 'knownAvailableFrom' | 'dndLiftKnown' | 'messRevealed' | 'rushDeadline'
  >;

/**
 * 判定合法性时能看到的全部：(world, state) 只保留玩家已知字段的投影。
 * 没有 availableFrom、mess、dndLiftsAt、descriptionId、world.events、world.seed，判定函数想读也读不到。
 * observe 完成后，View 也能投影成这个结构，按 View 判定时复用同一个判定函数。
 */
interface KnownState extends Pick<State, 'minute' | 'place' | 'cart' | 'breakTaken' | 'ended'> {
  /** 待回应事件的选项编号，按原来的顺序；没有待回应的事件时为 null。只取编号，不带事件本身。 */
  pendingOptions: string[] | null;
  /** 按 world.rooms 的顺序。 */
  rooms: KnownRoom[];
}

/** 把 (world, state) 投影成 KnownState。逐个字段复制，不把隐藏字段带进来。开销是 O(房间数)。 */
function knownStateOf(world: World, state: State): KnownState {
  if (state.rooms.length !== world.rooms.length) {
    throw new Error('rules: state 和 world 的房间对不上');
  }
  return {
    minute: state.minute,
    place: state.place,
    cart: state.cart,
    breakTaken: state.breakTaken,
    ended: state.ended,
    pendingOptions: state.prompt === null ? null : state.prompt.options.map((option) => option.id),
    rooms: world.rooms.map((truth, index): KnownRoom => {
      const progress = state.rooms[index];
      if (progress === undefined || progress.id !== truth.id) {
        throw new Error('rules: state 和 world 的房间对不上');
      }
      return {
        id: truth.id,
        place: truth.place,
        kind: truth.kind,
        clue: truth.clue,
        lateCheckout: truth.lateCheckout,
        vipDeadline: truth.vipDeadline,
        doneAt: progress.doneAt,
        workDone: progress.workDone,
        flaggedDeparted: progress.flaggedDeparted,
        knownAvailableFrom: progress.knownAvailableFrom,
        dndLiftKnown: progress.dndLiftKnown,
        messRevealed: progress.messRevealed,
        rushDeadline: progress.rushDeadline,
      };
    }),
  };
}

/**
 * legalActions 的候选，顺序就是列表的顺序：有待回应的事件时是它的各个选项；
 * 否则是按 world.rooms 顺序的 service，然后是 restock、call、break、wait、finish。
 * wait 只列一个，分钟数取这一刻的上限。候选合不合法由 illegalReason 决定。
 */
function candidateActions(known: KnownState, params: Params): Action[] {
  if (known.pendingOptions !== null) {
    return known.pendingOptions.map((option): Action => ({ type: 'respond', option }));
  }
  return [
    ...known.rooms.map((room): Action => ({ type: 'service', room: room.id })),
    { type: 'restock' },
    { type: 'call' },
    { type: 'break' },
    { type: 'wait', minutes: waitLimit(known, params) },
    { type: 'finish' },
  ];
}

/**
 * 唯一的合法性判定。合法返回 null，非法返回中文原因，原因里只有玩家已知的信息。
 * 先按优先级处理特殊情况：班次结束、待回应的事件、17:00 之后、强制休息；其余按各动作自己的条件。
 */
function illegalReason(known: KnownState, action: Action, params: Params): string | null {
  const { hardStop, breakEarliest, breakLatest } = params.shift;

  // 1. 班次已经结束：没有合法动作。
  if (known.ended !== null) return '班次已经结束';

  // 2. 有待回应的事件：只能回应（阶段 0 不会出现）。
  if (known.pendingOptions !== null) {
    if (action.type !== 'respond') return '有事件要先回应';
    return known.pendingOptions.includes(action.option) ? null : `没有选项 ${action.option}`;
  }

  // 3. 到了 17:00：只能还车，不要求房间做完，也不要求已休息。
  if (known.minute >= hardStop) {
    return action.type === 'finish' ? null : `${toClock(hardStop)} 已过，只能还车`;
  }

  // 4. 还没休息且到了 14:30（整点也算）：只能休息。此时到达服务间的时刻必然不早于 breakEarliest，不再检查下界。
  if (!known.breakTaken && known.minute >= breakLatest) {
    return action.type === 'break' ? null : `${toClock(breakLatest)} 起还没休息，现在只能休息`;
  }

  // 5. 正常情况。
  switch (action.type) {
    case 'service':
      return serviceIllegalReason(known, action.room, params);
    case 'restock': {
      const end = known.minute + walkMinutes(known.place, params.layout.servicePoint, params) + params.cart.restockMinutes;
      return end <= hardStop ? null : `来不及在 ${toClock(hardStop)} 前补完货`;
    }
    case 'call':
      return known.minute + params.callMinutes <= hardStop ? null : `来不及在 ${toClock(hardStop)} 前打完电话`;
    case 'break': {
      if (known.breakTaken) return '已经休息过了';
      // 休息的开始时刻是到达服务间的时刻；没有上界条件。
      const arrival = known.minute + walkMinutes(known.place, params.layout.servicePoint, params);
      return arrival >= breakEarliest
        ? null
        : `${toClock(breakEarliest)} 以后才能休息，现在去服务间 ${toClock(arrival)} 就到了`;
    }
    case 'wait': {
      const limit = waitLimit(known, params);
      const { minutes } = action;
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= limit
        ? null
        : `每次等待的分钟数要是 1 到 ${limit} 之间的整数`;
    }
    case 'finish':
      return finishIllegalReason(known);
    case 'respond':
      return '现在没有要回应的事件';
    default:
      return unknownActionReason(action);
  }
}

/** 打扫一间房的条件（正常情况）。按到达门口的时刻判断，所以可以提前出发。 */
function serviceIllegalReason(known: KnownState, roomId: RoomId, params: Params): string | null {
  const room = known.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) return `没有房间 ${roomId}`;
  if (room.doneAt !== null) return `${roomId} 已经做完了`;
  if (room.kind === 'departure' && !room.flaggedDeparted) return `${roomId} 还没被主管标记为已退`;
  if (room.kind === 'dnd' && !room.dndLiftKnown) return `${roomId} 挂着请勿打扰，还没得知摘牌`;

  const { hardStop } = params.shift;
  const arrival = known.minute + walkMinutes(known.place, room.place, params);
  // 到门口时要来得及敲一次门。
  if (arrival + params.knockRefusedMinutes > hardStop) return `来不及在 ${toClock(hardStop)} 前赶到 ${roomId} 门口`;
  if (room.knownAvailableFrom !== null && arrival < room.knownAvailableFrom) {
    return `${roomId} 的客人说 ${toClock(room.knownAvailableFrom)} 以后再来，现在出发 ${toClock(arrival)} 就到了`;
  }
  // 续做（workDone 大于 0）在第一次开门时已经扣过布草，不再检查。
  const { linen } = roomSpec(room.kind, params);
  if (room.workDone === 0 && known.cart < linen) {
    return `布草不够：${roomId} 要 ${linen} 份，车里只剩 ${known.cart} 份`;
  }
  return null;
}

/** 收工的条件（正常情况）：已休息；退房房和续住房全部完成；已知摘牌的请勿打扰房全部完成。 */
function finishIllegalReason(known: KnownState): string | null {
  if (!known.breakTaken) return '还没休息，不能收工';
  // 玩家不知道已经摘牌的请勿打扰房不挡收工。
  const unfinished = known.rooms.filter((room) => room.doneAt === null && (room.kind !== 'dnd' || room.dndLiftKnown));
  if (unfinished.length > 0) return `还有房间没做完：${unfinished.map((room) => room.id).join('、')}`;
  return null;
}

/** 这一刻单次等待的上限：min(waitStepMinutes, hardStop - minute)。 */
function waitLimit(known: KnownState, params: Params): Minute {
  return Math.min(params.waitStepMinutes, params.shift.hardStop - known.minute);
}

/** 动作类型的穷举检查：Action 新增类型而这里没处理时，编译报错。运行时收到未知类型就给出原因。 */
function unknownActionReason(_action: never): string {
  return '没有这种动作';
}

// ---------------------------------------------------------------------------
// 执行：按时间线推进
// ---------------------------------------------------------------------------

/**
 * 一个动作执行中的草稿。apply 按时间线推进它，最后由 closeAction 写成新的 State；它本身不会被返回出去。
 * rooms 是 state.rooms 的副本，有变化的房间换成新对象，没变的房间对象继续共享。
 */
interface Timeline {
  readonly world: World;
  minute: Minute;
  place: Place;
  cart: number;
  breakTaken: boolean;
  ended: ShiftEnd | null;
  rooms: RoomProgress[];
  /** 本动作中路过或停留时新得知摘牌的房间在 world.rooms 里的下标。 */
  noticed: number[];
  /** 本动作实际走过的分钟数。 */
  walk: Minute;
}

/**
 * 事件检查点在时间线上的位置：
 * arrived 是步行段结束、到了目的地（打扫时就是到了门口，判定能不能进门之前）；
 * doorOpened 是打扫时开门之后（布草已扣，脏乱已揭晓）、开始打扫之前；
 * actionDone 是动作本身做完之后、结束时的门位观察之前。
 */
type Checkpoint = 'arrived' | 'doorOpened' | 'actionDone';

function startTimeline(world: World, state: State): Timeline {
  return {
    world,
    minute: state.minute,
    place: state.place,
    cart: state.cart,
    breakTaken: state.breakTaken,
    ended: state.ended,
    rooms: state.rooms.slice(),
    noticed: [],
    walk: 0,
  };
}

/** 动作本身。调用前已经通过合法性检查。 */
function runAction(timeline: Timeline, action: Action): Outcome {
  switch (action.type) {
    case 'service':
      return doService(timeline, action.room);
    case 'restock':
      return doRestock(timeline);
    case 'call':
      return doCall(timeline);
    case 'break':
      return doBreak(timeline);
    case 'wait':
      return doWait(timeline, action.minutes);
    case 'finish':
      return doFinish(timeline);
    case 'respond':
      // 阶段 0 没有事件，prompt 恒为 null，respond 过不了合法性检查，走不到这里。
      throw new Error('rules: 回应事件要到阶段 2 才实现');
  }
}

/** 打扫一间房：步行，到门口判定，进门，打扫（或在 17:00 截断）。 */
function doService(timeline: Timeline, roomId: RoomId): Outcome {
  const { world } = timeline;
  const { params } = world;
  const index = world.rooms.findIndex((truth) => truth.id === roomId);
  const truth = world.rooms[index];
  // 合法性检查已经保证房间存在，这里只是让类型检查知道。
  if (truth === undefined) throw new Error(`没有房间 ${roomId}`);

  // 1. 步行到房间的门位，沿途逐个门位观察。
  walkTo(timeline, truth.place);
  eventCheckpoint(timeline, 'arrived');

  // 2. 到门口判定。已标记的退房房直接进门：标记说明退房时刻不晚于那次电话的挂断时刻，也就不晚于现在。
  //    续住房和已知摘牌的请勿打扰房，客人还没出门就敲门被拒，得知回来时间；客人不在就直接进门，不另花时间。
  if (truth.kind !== 'departure' && timeline.minute < truth.availableFrom) {
    const { comeBackRounding } = params;
    const comeBackAt = Math.ceil(truth.availableFrom / comeBackRounding) * comeBackRounding;
    timeline.minute += params.knockRefusedMinutes;
    patchRoom(timeline, index, { knownAvailableFrom: comeBackAt });
    return { type: 'knockRefused', room: roomId, comeBackAt };
  }

  // 3. 进门。第一次开门（workDone 为 0）时扣布草，续做时不扣。开门就知道脏乱档位。
  const before = progressAt(timeline, index);
  if (before.workDone === 0) timeline.cart -= roomSpec(truth.kind, params).linen;
  patchRoom(timeline, index, { messRevealed: true });
  eventCheckpoint(timeline, 'doorOpened');

  // 4. 打扫剩下的分钟数。17:00 前（含 17:00 整）做完算完成；做不完就停在 17:00，保留已做的分钟数。
  const total = cleanMinutes(truth.kind, truth.mess, params);
  const remaining = total - before.workDone;
  const { hardStop } = params.shift;
  const start = timeline.minute;
  if (start + remaining <= hardStop) {
    timeline.minute = start + remaining;
    patchRoom(timeline, index, { doneAt: timeline.minute, workDone: total });
    return { type: 'cleaned', room: roomId, minutes: remaining };
  }
  const workDone = before.workDone + (hardStop - start);
  timeline.minute = hardStop;
  patchRoom(timeline, index, { workDone });
  return { type: 'interrupted', room: roomId, workDone, reason: 'hardStop' };
}

/** 回服务间补货：补满到容量，与补多少份无关；车满也可以。 */
function doRestock(timeline: Timeline): Outcome {
  const { params } = timeline.world;
  walkTo(timeline, params.layout.servicePoint);
  eventCheckpoint(timeline, 'arrived');
  timeline.minute += params.cart.restockMinutes;
  timeline.cart = params.cart.capacity;
  return { type: 'restocked' };
}

/**
 * 打给主管：按挂断的时刻判断，恰好在那一刻发生的也算。只报告新的变化，标记只增不减。
 * 不涉及续住房。先标记，再在挂断时刻做结束时的门位观察，所以电话得知的摘牌不会记进 noticedLifted。
 */
function doCall(timeline: Timeline): Outcome {
  const { world } = timeline;
  const hangUp = timeline.minute + world.params.callMinutes;
  const newlyDeparted: RoomId[] = [];
  const newlyLifted: RoomId[] = [];
  for (const [index, truth] of world.rooms.entries()) {
    const progress = progressAt(timeline, index);
    if (truth.kind === 'departure' && !progress.flaggedDeparted && truth.availableFrom <= hangUp) {
      patchRoom(timeline, index, { flaggedDeparted: true });
      newlyDeparted.push(truth.id);
    }
    if (truth.kind === 'dnd' && !progress.dndLiftKnown && truth.dndLiftsAt !== null && truth.dndLiftsAt <= hangUp) {
      patchRoom(timeline, index, { dndLiftKnown: true });
      newlyLifted.push(truth.id);
    }
  }
  timeline.minute = hangUp;
  return { type: 'called', newlyDeparted, newlyLifted };
}

/** 回服务间休息。不被 17:00 截断；布草车不变。 */
function doBreak(timeline: Timeline): Outcome {
  const { params } = timeline.world;
  walkTo(timeline, params.layout.servicePoint);
  eventCheckpoint(timeline, 'arrived');
  timeline.minute += params.shift.breakMinutes;
  timeline.breakTaken = true;
  return { type: 'breakTaken' };
}

/** 原地等待。 */
function doWait(timeline: Timeline, minutes: Minute): Outcome {
  timeline.minute += minutes;
  return { type: 'waited', minutes };
}

/** 走回服务间还车，班次结束。17:00 起开始的还车是强制下班，之前是自己收工。不被 17:00 截断。 */
function doFinish(timeline: Timeline): Outcome {
  const { params } = timeline.world;
  const ended: ShiftEnd = timeline.minute >= params.shift.hardStop ? 'hardStop' : 'returned';
  walkTo(timeline, params.layout.servicePoint);
  eventCheckpoint(timeline, 'arrived');
  timeline.minute += params.shift.returnCartMinutes;
  timeline.ended = ended;
  return { type: 'finished' };
}

/**
 * 步行段：沿 walkPath 逐个门位走到 target（跨层时含乘电梯），
 * 每到一个门位（包括起点和终点）在到达的那一分钟做一次门位观察。耗时用 walkMinutes，和合法性判定算的一致。
 */
function walkTo(timeline: Timeline, target: Place): void {
  const { params } = timeline.world;
  const departAt = timeline.minute;
  for (const step of walkPath(timeline.place, target, params)) {
    observeDoor(timeline, step.place, departAt + step.offset);
  }
  const minutes = walkMinutes(timeline.place, target, params);
  timeline.minute = departAt + minutes;
  timeline.walk += minutes;
  timeline.place = copyPlace(target);
}

/**
 * 门位观察：对着 door 这个门位、到 at 时已经摘牌、玩家还不知道的请勿打扰房，就此得知，记进 noticed。
 * 只揭晓摘牌，不揭晓退房状态、客人在不在和脏乱。门位 0 没有房间，自然什么也看不到。
 */
function observeDoor(timeline: Timeline, door: Place, at: Minute): void {
  for (const [index, truth] of timeline.world.rooms.entries()) {
    if (truth.kind !== 'dnd' || truth.dndLiftsAt === null || truth.dndLiftsAt > at) continue;
    if (!samePlace(truth.place, door)) continue;
    if (progressAt(timeline, index).dndLiftKnown) continue;
    patchRoom(timeline, index, { dndLiftKnown: true });
    timeline.noticed.push(index);
  }
}

/** 事件检查点：时间线上段与段之间的位置。阶段 2 在这里检查到点的事件和绑定房间的事件；阶段 0 没有事件，什么都不做。 */
function eventCheckpoint(_timeline: Timeline, _at: Checkpoint): void {
  // 阶段 0 的 world.events 恒为空。
}

/** 动作的收尾：事件检查点，结束时刻对所在门位的门位观察，然后写出新的 State，并在日志里追加恰好一条。 */
function closeAction(timeline: Timeline, state: State, action: Action, outcome: Outcome): State {
  eventCheckpoint(timeline, 'actionDone');
  observeDoor(timeline, timeline.place, timeline.minute);

  const entry: LogEntry = {
    start: state.minute,
    end: timeline.minute,
    from: state.place,
    to: timeline.place,
    action: { ...action },
    outcome,
    walk: timeline.walk,
    // 按 world.rooms 的顺序，而不是看到的先后。
    noticedLifted: timeline.world.rooms.filter((_, index) => timeline.noticed.includes(index)).map((truth) => truth.id),
  };
  return {
    minute: timeline.minute,
    place: timeline.place,
    cart: timeline.cart,
    breakTaken: timeline.breakTaken,
    rooms: timeline.rooms,
    prompt: state.prompt,
    firedEvents: state.firedEvents,
    violation: state.violation,
    ended: timeline.ended,
    log: [...state.log, entry],
  };
}

function progressAt(timeline: Timeline, index: number): RoomProgress {
  const progress = timeline.rooms[index];
  if (progress === undefined) throw new Error(`rules: 没有下标为 ${index} 的房间进度`);
  return progress;
}

/** 换掉一间房的进度对象：旧对象不动，生成一个改了这些字段的新对象。 */
function patchRoom(timeline: Timeline, index: number, patch: Partial<Omit<RoomProgress, 'id'>>): void {
  timeline.rooms[index] = { ...progressAt(timeline, index), ...patch };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 房型的基础时间和布草份数。请勿打扰房摘牌后按续住房处理，用续住房的。 */
function roomSpec(kind: RoomKind, params: Params): { baseMinutes: Minute; linen: number } {
  return kind === 'departure' ? params.rooms.departure : params.rooms.stayover;
}

function copyPlace(place: Place): Place {
  return { floor: place.floor, door: place.door };
}

function samePlace(a: Place, b: Place): boolean {
  return a.floor === b.floor && a.door === b.door;
}
