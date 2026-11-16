/**
 * 新手幽灵：贪心策略（docs/DESIGN.md 的"新手：贪心"）。它是一星的基线，作用是展示"不动脑子会怎样"：
 * 永远去最近的、看起来能进的房间，不看线索，不看时限。
 *
 * 1. 契约（docs/DESIGN.md 的"策略的契约"）。类型是 Policy，只拿到 View 和 params，拿不到 World。
 *    无记忆的纯函数：不在决策之间记东西，要用的历史（上一个动作是不是打电话）从 view.log 推；同一个 View 给出同一个动作；
 *    不修改 View，深度冻结的 View 也能用；只返回合法动作（legalActionsForView 列出的动作，等待就取列出的那一档）。
 *    只从引擎的对外入口 src/engine/index.ts 导入，不导入 generate，不读种子（tests/engine-purity.test.ts 检查）。
 *    数值都从 params 读：休息时刻是 params.novice.breakAt，其余的经由 legalActionsForView 和 walkMinutes 读。
 *
 * 2. 每一步按下面的顺序决定，前面的成立就不再往下看：
 *    (1) 17:00 起：收工还车。这时只能还车。
 *    (2) 还没休息，并且到了 params.novice.breakAt（12:30）：回服务间休息，手上有能做的房间也先休息。
 *        14:30 起还没休息时只能休息，也落在这一条里，因为 breakAt 早于 14:30（tests/params.test.ts 检查三档）。
 *    (3) 有能做的房间（见第 3 条）：挑最近的一间。车里的布草够这一间要用的份数，就去打扫；不够，就先回服务间补货。
 *        补完货人在服务间，下一步从那里重新挑最近的一间，不一定还是原来那间（新手不记得原来想去哪间）。
 *    (4) 没房可做：
 *        a. 打电话可能问出新消息，并且上一个动作不是打电话：打给主管。
 *        b. 不然，能收工就收工。
 *        c. 再不然，原地等待，等列出的那一档，也就是 min(waitStepMinutes, 17:00 减现在)。
 *
 * 3. 能做的房间。先看看起来能不能进：假设车里的布草是满的，按 View 判定打扫它是不是合法动作。这就是除了布草以外的
 *    全部条件：没做完，退房房已被标记已退，请勿打扰房已知摘牌，到门口还来得及在 17:00 前敲一次门，有回来时间的，
 *    到达不早于它。用的是规则的同一份判定（legalActionsForView），只把 View 里的布草换成容量：车里的份数只影响
 *    布草够不够这一项，换了以后剩下的就是别的条件。线索、时限、脏乱都不看；客人在不在房里也不猜，没有回来时间的
 *    续住房都算能进。布草够不够同样按这份判定：用真实的 View，打扫它是合法动作就够（续做的房间不再扣布草，总是够）。
 *    看起来能进、布草却不够，又来不及补货（补货在 17:00 前做不完）的房间，这班做不成，不算能做的房间。
 *
 * 4. 规则没说的细节，在这里定下：
 *    - 最近：从现在的位置走过去的分钟数（walkMinutes）最少。一样近时取 view.rooms 里排在前面的那间，也就是任务单的
 *      顺序（params 楼层平面里列的先后：标准档先 12 楼后 13 楼，同层按门位，同一门位的两间按房号）。
 *    - 打电话可能问出新消息：还有没被标记已退的退房房，或者还不知道摘牌的请勿打扰房。电话只报这两样，都没有时打了也白打。
 *      例如只剩要等回来时间的续住房：这时不打电话，原地等，等到走过去到达时不早于回来时间，再去。
 *    - 不连着打两次电话：打完电话还是没房可做，就先收工或者等一次，下一步再打。所以没房可做、电话又一直没问出
 *      能做的房间时，新手隔一次等待打一次电话。
 *    - 房间都做完、还没到 12:30 时，还没休息，不能收工：先原地等待（打电话可能问出新消息时，照样隔一次等待打一次电话），
 *      到 12:30 去休息，休息完再收工。
 *    - 收工之前，还有不知道摘牌的请勿打扰房，就按 (4)a 先打一次电话：问出摘牌就去做，问不出再收工。
 *    - 班次结束以后没有合法动作，调用新手会抛错。驱动函数不该在班次结束后调用策略。
 *    - 阶段 0 没有事件。阶段 2 加了事件以后，待回应的事件要先回应，到时再补这一条。
 */

import {
  legalActionsForView,
  walkMinutes,
  type Action,
  type Minute,
  type Params,
  type Policy,
  type RoomId,
  type View,
} from '../engine';

/** 新手幽灵。每一步怎么决定见文件开头。 */
export const novice: Policy = (view, params) => {
  if (view.ended !== null) throw new Error('新手：班次已经结束，没有合法动作');
  const legal = legalActionsForView(view, params);

  // (1) 17:00 起只能还车。
  if (view.minute >= params.shift.hardStop) return pick(legal, 'finish');

  // (2) 还没休息，到了 12:30 就去休息。
  if (!view.breakTaken && view.minute >= params.novice.breakAt) return pick(legal, 'break');

  // (3) 去最近的能做的房间；布草不够这一间要用的份数，就先回服务间补货。
  const target = nearestRoom(view, params, legal);
  if (target !== null) return target.linenEnough ? { type: 'service', room: target.id } : pick(legal, 'restock');

  // (4) 没房可做：可能问出新消息就打电话（不连着打两次），不然能收工就收工，再不然原地等待。
  if (callMayTell(view) && !justCalled(view)) {
    const call = legal.find((action) => action.type === 'call');
    if (call !== undefined) return call;
  }
  return legal.find((action) => action.type === 'finish') ?? pick(legal, 'wait');
};

/** 能做的房间里挑出来的那一间。 */
interface Target {
  id: RoomId;
  /** 车里的布草够这一间要用的份数，可以直接去打扫。 */
  linenEnough: boolean;
  /** 从现在的位置走过去的分钟数。 */
  walk: Minute;
}

/**
 * 能做的房间（见文件开头第 3 条）里最近的一间，一样近时取 view.rooms 里排在前面的；没有能做的房间时返回 null。
 * legal 是 legalActionsForView(view, params) 的结果。
 */
function nearestRoom(view: View, params: Params, legal: readonly Action[]): Target | null {
  // 只把布草换成满车再判定一次：判定出的打扫目标，就是除了布草以外条件都满足的房间。展开出一个新对象，不改 view。
  const enterable = serviceTargets(legalActionsForView({ ...view, cart: params.cart.capacity }, params));
  const linenEnough = serviceTargets(legal);
  const canRestock = legal.some((action) => action.type === 'restock');
  let best: Target | null = null;
  for (const room of view.rooms) {
    if (!enterable.has(room.id)) continue;
    const enough = linenEnough.has(room.id);
    // 布草不够，又来不及补货：这班做不成。
    if (!enough && !canRestock) continue;
    const walk = walkMinutes(view.place, room.place, params);
    // 严格更近才换：一样近时留下排在前面的那间。
    if (best === null || walk < best.walk) best = { id: room.id, linenEnough: enough, walk };
  }
  return best;
}

/** 动作列表里打扫的房号。 */
function serviceTargets(actions: readonly Action[]): Set<RoomId> {
  return new Set(actions.flatMap((action) => (action.type === 'service' ? [action.room] : [])));
}

/** 打电话可能问出新消息：还有没被标记已退的退房房，或者还不知道摘牌的请勿打扰房。电话只报这两样。 */
function callMayTell(view: View): boolean {
  return view.rooms.some(
    (room) => (room.kind === 'departure' && !room.flaggedDeparted) || (room.kind === 'dnd' && !room.dndLifted),
  );
}

/** 上一个动作是打电话。 */
function justCalled(view: View): boolean {
  return view.log.at(-1)?.action.type === 'call';
}

/**
 * 合法动作里这种类型的那一个。按文件开头的规则，用到它的地方一定有；没有就说明规则或参数出了错，
 * 直接抛错，不返回非法动作。
 */
function pick(legal: readonly Action[], type: Action['type']): Action {
  const action = legal.find((candidate) => candidate.type === type);
  if (action === undefined) throw new Error(`新手：现在没有合法的 ${type} 动作`);
  return action;
}
