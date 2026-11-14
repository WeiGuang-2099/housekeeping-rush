/**
 * observe：把 (world, state) 投影成 View，也就是玩家和只看 View 的策略（新手、老手）能看到的全部。
 *
 * 1. View 是什么。任务单上的公开信息（房号、位置、房型、线索、延迟退房、贵宾时限），玩家自己的状态
 *    （时刻、位置、布草、是否休息过、违规、班次怎么结束的），每间房已经得知的进度（催房时限、完成时刻、
 *    已做的分钟数、已退标记、回来时间、是否得知摘牌，开过门的还有脏乱档位和房间描述），以及完整的日志。
 *    隐藏的退房时刻、出门时刻和摘牌时刻（availableFrom、dndLiftsAt）不以任何形式出现。
 *
 * 2. 白名单。按 types.ts 里 View 和 RoomView 的字段顺序逐个字段构造，不展开 world、state 或其中的对象，
 *    没列出的字段就不会漏进来：没有 seed、params、events、firedEvents、tier。字段顺序就是 JSON 的键顺序
 *    （老手以后会用 JSON.stringify(view) 派生随机数种子），不要调换。日志条目由 rules 构造，键的顺序同样固定
 *    （动作按类型重建），所以内容相同的 View 序列化的结果相同。View 里只放普通对象和数组。
 *
 * 3. 揭晓口径。开过门（messRevealed）的房间显示脏乱档位和房间描述的编号，包括被 17:00 截断的房间；
 *    没开过门的房间（包括敲门被拒的）两者都是 null。摘牌只显示玩家是否已经得知（dndLiftKnown）。
 *
 * 4. 不共用对象。每次调用都新建 View、rooms 数组和每个 RoomView；View 的 place 和每个 RoomView 的 place
 *    各复制一份，不引用 world.rooms 和 params 里的任何对象。日志数组复制一份（view.log !== state.log），
 *    日志条目和 State 共用同一批对象。日志条目本身也不引用 world 和 params 的对象（rules 写日志时
 *    位置是复制的，动作按类型重建），所以从 View 走不到 World 里的任何对象。
 *
 * 5. 阶段 0 的 prompt。阶段 0 没有事件，View.prompt 恒为 null；state.prompt 不是 null 时直接抛错。
 *    阶段 2 换成不含隐藏结果的事件视图类型。
 *
 * 6. 班次结束后照样隐藏。没开过门的房间，班次结束后也看不到脏乱和描述。结算页、回放和分享卡片读 World、
 *    score 和各参与者的 State；回放里"当时知道什么"，就是对那一步的状态再调一次 observe。
 *
 * 7. 纯函数。不修改 world、state，没有随机数，不读系统时间；同样的输入给出相同的输出。
 *    不导入 rules.ts（按 View 判定合法动作的 legalActionsForView 在 rules.ts 里）。
 */

import type { RoomProgress, RoomTruth, RoomView, State, View, World } from './types';

/**
 * 玩家在 state 这一刻能看到的全部，构造规则见文件开头。
 * state 和 world 的房间对不上（数量不同，或同一下标上的房号不同）时抛错。
 * state 带着待回应的事件时抛错：阶段 0 不会出现，待回应事件的视图类型要到阶段 2 才有。
 */
export function observe(world: World, state: State): View {
  // 先查房间对得上，再查待回应的事件。
  const pairs = pairRooms(world, state);
  if (state.prompt !== null) {
    throw new Error('observe: state 有待回应的事件。阶段 0 没有事件，待回应事件的视图类型要到阶段 2 才有');
  }
  // 键的顺序就是 types.ts 里 View 的字段顺序。
  return {
    minute: state.minute,
    place: { floor: state.place.floor, door: state.place.door },
    cart: state.cart,
    breakTaken: state.breakTaken,
    rooms: pairs.map(
      // 键的顺序就是 types.ts 里 RoomView 的字段顺序。
      ({ truth, progress }): RoomView => ({
        id: truth.id,
        place: { floor: truth.place.floor, door: truth.place.door },
        kind: truth.kind,
        clue: truth.clue,
        lateCheckout: truth.lateCheckout,
        vipDeadline: truth.vipDeadline,
        rushDeadline: progress.rushDeadline,
        doneAt: progress.doneAt,
        workDone: progress.workDone,
        flaggedDeparted: progress.flaggedDeparted,
        knownAvailableFrom: progress.knownAvailableFrom,
        mess: progress.messRevealed ? truth.mess : null,
        dndLifted: progress.dndLiftKnown,
        descriptionId: progress.messRevealed ? truth.descriptionId : null,
      }),
    ),
    prompt: null,
    violation: state.violation,
    ended: state.ended,
    log: state.log.slice(),
  };
}

/** 一间房的真相和进度，同一下标上的两项。 */
interface RoomPair {
  truth: RoomTruth;
  progress: RoomProgress;
}

/** 按 world.rooms 的顺序把真相和进度配成对。数量不同，或同一下标上的房号不同，就抛错。 */
function pairRooms(world: World, state: State): RoomPair[] {
  const mismatch = 'observe: state 和 world 的房间对不上';
  if (state.rooms.length !== world.rooms.length) throw new Error(mismatch);
  return world.rooms.map((truth, index): RoomPair => {
    const progress = state.rooms[index];
    if (progress === undefined || progress.id !== truth.id) throw new Error(mismatch);
    return { truth, progress };
  });
}
