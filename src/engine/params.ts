/**
 * 全部数值集中在这里。引擎和策略里不要写魔法数字。
 *
 * 这些是第一版的初始值，来自 docs/DESIGN.md，并用 prototype/sim.py 粗略试算过。
 * 正式引擎写好后要用批量模拟器重新调（见 docs/DESIGN.md 的"平衡与评测"）。
 * 时间单位是分钟，从 08:30 起算：120 是 10:30，270 是 13:00，450 是 16:00。
 * 成对的时间窗（from 和 to、leaveFrom 和 leaveTo、liftFrom 和 liftTo）都是左闭右开的 [from, to)，
 * generate 在里面等概率抽一个整数分钟。
 */

import type { DepartureClue, MessLevel, Minute, Place, RoomId, StayClue } from './types';

/** 难度档位：标准（周一到周三）、紧（周四周五）、周末。 */
export type Tier = 'standard' | 'tight' | 'weekend';

/** 三档脏乱程度的概率，三项之和为 1。 */
export type MessDistribution = Record<MessLevel, number>;

export interface FloorPlan {
  floor: number;
  /** 按门位顺序排列，每两间对着同一个门位：第 1、2 间在门位 1，第 3、4 间在门位 2，依此类推。 */
  rooms: RoomId[];
}

export interface Params {
  tier: Tier;

  shift: {
    /**
     * 开工前的一个时刻，必须是负数。开工前就已退房、或客人开工前已出门的房间，
     * RoomTruth.availableFrom 记为它。具体取值不影响玩法，只要求早于开工。
     */
    beforeStart: Minute;
    /** 目标下班时间，16:00。 */
    targetFinish: Minute;
    /** 强制下班时间，17:00。 */
    hardStop: Minute;
    /**
     * 休息窗口：10:30 和 14:30。休息的开始时刻是到达服务间的时刻。
     * 还没休息，并且到达服务间的时刻不早于 breakEarliest，就可以休息；没有上界条件。
     * 到了 breakLatest（整点也算）还没休息，就只能休息。这次休息可以晚于 breakLatest 开始
     * （上一个动作跨过它时必然如此）。休息不被 hardStop 截断，参数测试保证最晚的强制休息也在 hardStop 之前结束。
     */
    breakEarliest: Minute;
    breakLatest: Minute;
    breakMinutes: Minute;
    returnCartMinutes: Minute;
  };

  layout: {
    floors: FloorPlan[];
    /** 服务间：补货、休息、还车的地点。 */
    servicePoint: Place;
    walkMinutesPerDoor: Minute;
    liftMinutes: Minute;
  };

  /** 每班三种房型的数量，合计等于房间总数。 */
  mix: { departures: number; stayovers: number; dnd: number };

  rooms: {
    departure: { baseMinutes: Minute; linen: number };
    stayover: { baseMinutes: Minute; linen: number };
  };

  /** 实际打扫时间等于基础时间乘以这个系数。 */
  messMultiplier: Record<MessLevel, number>;

  cart: { capacity: number; restockMinutes: Minute };

  callMinutes: Minute;
  knockRefusedMinutes: Minute;
  waitStepMinutes: Minute;
  /** 客人告知的回来时间，向上取整到这个步长。 */
  comeBackRounding: Minute;

  /** 退房时间分布，四项的 share 之和为 1。 */
  checkout: {
    /** 开工前已退，退房时刻（availableFrom）记为 shift.beforeStart。 */
    beforeStart: { share: number };
    early: { share: number; from: Minute; to: Minute };
    late: { share: number; from: Minute; to: Minute };
    /** 延迟退房，任务单上会注明。 */
    lateCheckout: { share: number; at: Minute };
  };

  stayClues: Record<
    StayClue,
    { share: number; inRoomAtStart: number; leaveFrom: Minute; leaveTo: Minute; mess: MessDistribution }
  >;

  departureClues: Record<DepartureClue, { share: number; mess: MessDistribution }>;

  /** 整体推迟客人出门的时间，并提高开工时人在房内的概率。周末档使用。 */
  guests: { leaveDelay: Minute; inRoomBoost: number };

  dnd: { liftChance: number; liftFrom: Minute; liftTo: Minute };

  /** 贵宾时限。有几个时限，就有几间退房房被标为贵宾房。 */
  vipDeadlines: Minute[];

  events: {
    showerNoise: { chancePerStayover: number; retryAfter: Minute };
    guestReturns: { chancePerStayover: number; continueChance: number; comeBackAfter: Minute };
    rushRequest: { chancePerShift: number; from: Minute; to: Minute; minutesAllowed: Minute };
    extraTowels: { chancePerShift: number; minutes: Minute; linen: number };
    maintenance: { chancePerRoom: number; minutes: Minute };
    lostProperty: { chancePerDeparture: number; minutes: Minute; valuableShare: number; valuableMinutes: Minute };
    impostor: { chancePerShift: number; minutes: Minute };
  };

  /** 罚时，单位分钟。 */
  penalties: { vipLate: Minute; rushLate: Minute; unfinished: Minute };

  /** 三星要求：遗憾值不超过这么多分钟。 */
  stars: { threeStarRegret: Minute };
}

const STANDARD: Params = {
  tier: 'standard',

  shift: {
    beforeStart: -30,
    targetFinish: 450,
    hardStop: 510,
    breakEarliest: 120,
    breakLatest: 360,
    breakMinutes: 30,
    returnCartMinutes: 5,
  },

  layout: {
    floors: [
      { floor: 12, rooms: [1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208] },
      { floor: 13, rooms: [1301, 1302, 1303, 1304, 1305, 1306, 1307] },
    ],
    servicePoint: { floor: 12, door: 0 },
    walkMinutesPerDoor: 1,
    liftMinutes: 4,
  },

  mix: { departures: 6, stayovers: 7, dnd: 2 },

  rooms: {
    departure: { baseMinutes: 30, linen: 2 },
    stayover: { baseMinutes: 15, linen: 1 },
  },

  messMultiplier: { tidy: 0.8, normal: 1.0, disaster: 1.6 },

  cart: { capacity: 8, restockMinutes: 5 },

  callMinutes: 2,
  knockRefusedMinutes: 1,
  waitStepMinutes: 5,
  comeBackRounding: 15,

  checkout: {
    beforeStart: { share: 0.2 },
    early: { share: 0.5, from: 0, to: 120 },
    late: { share: 0.2, from: 120, to: 150 },
    lateCheckout: { share: 0.1, at: 210 },
  },

  stayClues: {
    business: { share: 3 / 9, inRoomAtStart: 0.3, leaveFrom: 0, leaveTo: 60, mess: { tidy: 0.5, normal: 0.4, disaster: 0.1 } },
    tourist: { share: 3 / 9, inRoomAtStart: 0.7, leaveFrom: 15, leaveTo: 150, mess: { tidy: 0.25, normal: 0.5, disaster: 0.25 } },
    family: { share: 2 / 9, inRoomAtStart: 0.85, leaveFrom: 45, leaveTo: 180, mess: { tidy: 0.1, normal: 0.4, disaster: 0.5 } },
    longStay: { share: 1 / 9, inRoomAtStart: 0.9, leaveFrom: 150, leaveTo: 270, mess: { tidy: 0.3, normal: 0.6, disaster: 0.1 } },
  },

  departureClues: {
    oneNight: { share: 0.5, mess: { tidy: 0.4, normal: 0.5, disaster: 0.1 } },
    threeNightsPlus: { share: 0.3, mess: { tidy: 0.15, normal: 0.5, disaster: 0.35 } },
    partyOrFamily: { share: 0.2, mess: { tidy: 0.05, normal: 0.35, disaster: 0.6 } },
  },

  guests: { leaveDelay: 0, inRoomBoost: 0 },

  dnd: { liftChance: 0.5, liftFrom: 150, liftTo: 330 },

  vipDeadlines: [270, 330],

  // 事件没有进过原型试算。标了"待调"的数值设计文档里没有定，是占位的初始值。
  events: {
    showerNoise: { chancePerStayover: 0.05, retryAfter: 20 },
    guestReturns: { chancePerStayover: 0.05 /* 待调 */, continueChance: 0.5 /* 待调 */, comeBackAfter: 30 },
    rushRequest: { chancePerShift: 0.7 /* 待调 */, from: 150, to: 300, minutesAllowed: 45 },
    extraTowels: { chancePerShift: 0.5 /* 待调 */, minutes: 2, linen: 1 },
    maintenance: { chancePerRoom: 0.05, minutes: 2 },
    lostProperty: { chancePerDeparture: 0.15, minutes: 3, valuableShare: 0.3 /* 待调 */, valuableMinutes: 5 },
    impostor: { chancePerShift: 1 / 3, minutes: 1 },
  },

  penalties: { vipLate: 30, rushLate: 20, unfinished: 45 },

  stars: { threeStarRegret: 10 },
};

/** 周四周五档：布草车减到 6 份。 */
const TIGHT: Params = {
  ...STANDARD,
  tier: 'tight',
  cart: { ...STANDARD.cart, capacity: 6 },
};

/** 周末档：在紧档基础上加第三个贵宾（13:30），客人出门普遍晚 30 分钟。 */
const WEEKEND: Params = {
  ...TIGHT,
  tier: 'weekend',
  vipDeadlines: [270, 300, 330],
  guests: { leaveDelay: 30, inRoomBoost: 0.15 },
};

/** 把一个对象和它能走到的全部对象、数组冻结。PARAMS 被所有班次、幽灵和测试共用，冻结后误改会直接抛错。 */
function deepFreeze<T>(value: T): T {
  // 三档之间共享子对象（紧档和周末档由标准档展开）。记下走过的对象，每个只走一次，有环也不会打转。
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    const children: unknown[] = Object.values(node);
    for (const child of children) visit(child);
  };
  visit(value);
  return value;
}

/** 三档的参数，深度冻结。要一套改过的参数，就像 TIGHT 那样用展开写法造新对象，改到哪一层就展开到哪一层。 */
export const PARAMS: Record<Tier, Params> = deepFreeze({ standard: STANDARD, tight: TIGHT, weekend: WEEKEND });

/**
 * 每日班次的难度随星期递增。
 * weekday 用 Date.getDay() 的约定：0 是周日，1 是周一，6 是周六。
 */
export function tierForWeekday(weekday: number): Tier {
  if (weekday === 0 || weekday === 6) return 'weekend';
  if (weekday === 4 || weekday === 5) return 'tight';
  return 'standard';
}
