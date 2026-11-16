/**
 * 性质测试用的一套参数 ODD_PARAMS，以及确认它和三档确实都不同的 numbersUsedByRules、numbersUsedByScore。
 *
 * ODD_PARAMS 的楼层和房号，以及 rules 用到的每项数值（见 numbersUsedByRules）、score 用到的每项数值
 * （见 numbersUsedByScore）都和三档不同，用来检查 rules、legalActionsForView 和 score 的数值都从传入的参数读。
 * 其余各项里，下面这些沿用标准档：tier 仍是 'standard'；客人、线索、退房和请勿打扰的分布，事件、星级就是标准档的
 * 同一个对象；退房房和续住房的间数、服务间的门位也和标准档相同。开工前的时刻（-45）、目标下班时间（400）、
 * 请勿打扰房的间数（3）和贵宾时限（[250]）也换了，和三档都不同，但 rules 和 score 不读它们（score 读的贵宾时限
 * 是 World 里每间房的 vipDeadline）。要检查别的模块的数值都从参数读，先像 numbersUsedByRules 那样
 * 列出它用到的数值，确认和三档都不同。
 */

import { allRooms } from '../../src/engine/layout';
import { PARAMS, type Params } from '../../src/engine/params';

/**
 * rules 和 score 用到的每项数值都和三档不同的参数：楼层和房号、服务间所在楼层、步行和电梯、各项耗时、布草、脏乱系数、
 * 休息窗口、17:00 和三项罚时都换了。rules 或 score 里只要有一处没从 world.params 读（写死了数值，或直接引用 PARAMS），
 * tests/rules.property.test.ts 里"数值都从 world.params 读"的性质，或者 tests/score.property.test.ts、
 * tests/score.test.ts 里用 ODD_PARAMS 跑的计分就会失败。
 * 最晚的强制休息：任意位置到任意房间最远是 {3, 3} 到 {5, 5}，(3 + 5) × 2 + 3 = 19 分钟；最长的打扫是 40 × 1.5 = 60；
 * 回服务间 {5, 0} 最远是 {5, 5}，5 × 2 = 10 分钟。(300 - 1) + (19 + 60) + 10 + 20 = 408，仍在 480 之前结束。
 */
export const ODD_PARAMS: Params = {
  ...PARAMS.standard,
  shift: {
    beforeStart: -45,
    targetFinish: 400,
    hardStop: 480,
    breakEarliest: 100,
    breakLatest: 300,
    breakMinutes: 20,
    returnCartMinutes: 7,
  },
  layout: {
    floors: [
      { floor: 3, rooms: [301, 302, 303, 304, 305, 306] },
      { floor: 5, rooms: [501, 502, 503, 504, 505, 506, 507, 508, 509, 510] },
    ],
    servicePoint: { floor: 5, door: 0 },
    walkMinutesPerDoor: 2,
    liftMinutes: 3,
  },
  mix: { departures: 6, stayovers: 7, dnd: 3 },
  // 退房房 30、50、60 分钟，续住房和请勿打扰房 15、25、30 分钟，都是整数。
  rooms: { departure: { baseMinutes: 40, linen: 3 }, stayover: { baseMinutes: 20, linen: 2 } },
  messMultiplier: { tidy: 0.75, normal: 1.25, disaster: 1.5 },
  cart: { capacity: 7, restockMinutes: 4 },
  callMinutes: 3,
  knockRefusedMinutes: 2,
  waitStepMinutes: 4,
  // 08:30 是当天第 510 分钟，能被 10 整除。
  comeBackRounding: 10,
  vipDeadlines: [250],
  // 三项各不相同，也和三档的 30、20、45 都不同。
  penalties: { vipLate: 35, rushLate: 25, unfinished: 50 },
};

/** rules 用到的每一项数值，用来确认 ODD_PARAMS 和三档都不同。 */
export function numbersUsedByRules(params: Params): Record<string, number> {
  return {
    hardStop: params.shift.hardStop,
    breakEarliest: params.shift.breakEarliest,
    breakLatest: params.shift.breakLatest,
    breakMinutes: params.shift.breakMinutes,
    returnCartMinutes: params.shift.returnCartMinutes,
    servicePointFloor: params.layout.servicePoint.floor,
    walkMinutesPerDoor: params.layout.walkMinutesPerDoor,
    liftMinutes: params.layout.liftMinutes,
    roomCount: allRooms(params).length,
    departureBaseMinutes: params.rooms.departure.baseMinutes,
    departureLinen: params.rooms.departure.linen,
    stayoverBaseMinutes: params.rooms.stayover.baseMinutes,
    stayoverLinen: params.rooms.stayover.linen,
    tidy: params.messMultiplier.tidy,
    normal: params.messMultiplier.normal,
    disaster: params.messMultiplier.disaster,
    capacity: params.cart.capacity,
    restockMinutes: params.cart.restockMinutes,
    callMinutes: params.callMinutes,
    knockRefusedMinutes: params.knockRefusedMinutes,
    waitStepMinutes: params.waitStepMinutes,
    comeBackRounding: params.comeBackRounding,
  };
}

/** score 用到的每一项数值，用来确认 ODD_PARAMS 和三档都不同。 */
export function numbersUsedByScore(params: Params): Record<string, number> {
  return {
    hardStop: params.shift.hardStop,
    vipLate: params.penalties.vipLate,
    rushLate: params.penalties.rushLate,
    unfinished: params.penalties.unfinished,
  };
}
