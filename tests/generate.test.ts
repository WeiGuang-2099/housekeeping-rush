import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  allRooms,
  generate,
  PARAMS,
  placeOf,
  type Clue,
  type DepartureClue,
  type MessLevel,
  type Minute,
  type Params,
  type RoomKind,
  type RoomTruth,
  type StayClue,
  type Tier,
  type World,
} from '../src/engine';

const TIERS: Tier[] = ['standard', 'tight', 'weekend'];
const MESS_LEVELS: MessLevel[] = ['tidy', 'normal', 'disaster'];

const seeds = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
const byNumber = (a: number, b: number): number => a - b;

/** 时间窗 [from, to) 左闭右开，和 generate 的约定一致。 */
const within = (minute: Minute, from: Minute, to: Minute): boolean =>
  Number.isInteger(minute) && from <= minute && minute < to;

const isDepartureClue = (params: Params, clue: Clue): clue is DepartureClue => Object.hasOwn(params.departureClues, clue);
const isStayClue = (params: Params, clue: Clue): clue is StayClue => Object.hasOwn(params.stayClues, clue);
const isOnTimeDeparture = (room: RoomTruth): boolean => room.kind === 'departure' && !room.lateCheckout;

/** 两个世界里同一位置的房间配成对。 */
function pairs(a: readonly RoomTruth[], b: readonly RoomTruth[]): [RoomTruth, RoomTruth][] {
  expect(b).toHaveLength(a.length);
  return a.map((room, i) => {
    const other = b[i];
    if (other === undefined) throw new Error(`第 ${i} 间房没有对应`);
    return [room, other];
  });
}

/** 每个世界都必须满足的不变量。 */
function expectValidWorld(world: World, params: Params): void {
  const { rooms } = world;

  // 房间按楼层顺序排列，位置和 layout 一致。
  expect(rooms.map((room) => room.id)).toEqual(allRooms(params));
  for (const room of rooms) expect(room.place).toEqual(placeOf(room.id, params));

  // 房型数量严格等于 mix。
  const countKind = (kind: RoomKind): number => rooms.filter((room) => room.kind === kind).length;
  expect(countKind('departure')).toBe(params.mix.departures);
  expect(countKind('stayover')).toBe(params.mix.stayovers);
  expect(countKind('dnd')).toBe(params.mix.dnd);

  for (const room of rooms) {
    expect(MESS_LEVELS).toContain(room.mess);
    expect(room.descriptionId).toBeNull();
    if (room.kind === 'departure') expectValidDeparture(room, params);
    else expectValidGuestRoom(room, params);
  }

  // 贵宾：每个时限恰好用一次，贵宾房都是退房房，都不是延迟退房。
  const deadlines = rooms.flatMap((room) => (room.vipDeadline === null ? [] : [room.vipDeadline]));
  expect(deadlines.sort(byNumber)).toEqual([...params.vipDeadlines].sort(byNumber));
  for (const room of rooms) {
    if (room.vipDeadline !== null) expect(isOnTimeDeparture(room), `贵宾房 ${room.id}`).toBe(true);
  }

  expect(world.events).toEqual([]);
}

function expectValidDeparture(room: RoomTruth, params: Params): void {
  expect(isDepartureClue(params, room.clue), `房间 ${room.id} 的线索 ${room.clue}`).toBe(true);
  expect(room.dndLiftsAt).toBeNull();
  const { early, late, lateCheckout } = params.checkout;
  const t = room.availableFrom;
  if (room.lateCheckout) {
    expect(t).toBe(lateCheckout.at);
  } else {
    const ok = t === params.shift.beforeStart || within(t, early.from, early.to) || within(t, late.from, late.to);
    expect(ok, `房间 ${room.id} 的退房时刻 ${t}`).toBe(true);
  }
}

function expectValidGuestRoom(room: RoomTruth, params: Params): void {
  if (!isStayClue(params, room.clue)) throw new Error(`房间 ${room.id} 的线索 ${room.clue} 不是续住线索`);
  expect(room.lateCheckout).toBe(false);
  const { leaveFrom, leaveTo } = params.stayClues[room.clue];
  const { leaveDelay } = params.guests;
  const t = room.availableFrom;
  const ok = t === params.shift.beforeStart || within(t, leaveFrom + leaveDelay, leaveTo + leaveDelay);
  expect(ok, `房间 ${room.id}（${room.clue}）的出门时刻 ${t}`).toBe(true);

  if (room.kind === 'stayover') {
    expect(room.dndLiftsAt, `续住房 ${room.id} 不该有摘牌时刻`).toBeNull();
  } else if (room.dndLiftsAt !== null) {
    expect(within(room.dndLiftsAt, params.dnd.liftFrom, params.dnd.liftTo), `房间 ${room.id} 的摘牌时刻`).toBe(true);
  }
}

describe.each(TIERS)('generate：%s 档', (tier) => {
  const params = PARAMS[tier];

  it('同一种子生成的世界完全相同', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        expect(generate(seed, params)).toStrictEqual(generate(seed, params));
      }),
    );
  });

  it('任意种子生成的世界都满足不变量', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const world = generate(seed, params);
        expect(world.seed).toBe(seed);
        expect(world.params).toBe(params);
        expectValidWorld(world, params);
      }),
    );
  });

  it('不修改传入的 params', () => {
    const before = structuredClone(params);
    for (const seed of seeds('pure', 50)) generate(seed, params);
    expect(params).toStrictEqual(before);
  });
});

describe('generate：不同种子', () => {
  it('不同种子一般得到不同的世界', () => {
    const worlds = seeds('distinct', 200).map((seed) => JSON.stringify(generate(seed, PARAMS.standard).rooms));
    expect(new Set(worlds).size).toBe(200);
  });
});

/**
 * 钉住几个固定种子生成的世界，三档各两个种子。每间房写成一行，字段依次是：
 * 房号 房型 线索 脏乱 availableFrom lateCheckout vipDeadline dndLiftsAt。
 *
 * 1. 这条测试钉住的是"同一份参数、同一个种子，生成的世界不变"。
 * 2. 有意调 params.ts 以后，这里的期望会变。更新之前先确认变化只落在被调参数影响的那一项上
 *    （见 generate.ts 文件头第 3 条：每间房的每一项各用一条随机流），再照新的输出改。
 * 3. 如果是代码改动让它失败，说明已有种子生成的世界变了。
 */
const PINNED_WORLDS: Record<Tier, Record<string, string[]>> = {
  standard: {
    'pin-standard-0': [
      '1201 stayover tourist normal -30 false null null',
      '1202 departure oneNight tidy -30 false 270 null',
      '1203 dnd tourist disaster 83 false null null',
      '1204 departure oneNight normal 52 false 330 null',
      '1205 stayover longStay tidy 268 false null null',
      '1206 departure threeNightsPlus normal 44 false null null',
      '1207 stayover business normal 46 false null null',
      '1208 dnd business normal -30 false null 200',
      '1301 stayover longStay tidy 164 false null null',
      '1302 stayover tourist normal -30 false null null',
      '1303 stayover family normal 117 false null null',
      '1304 departure oneNight normal 100 false null null',
      '1305 stayover family tidy 92 false null null',
      '1306 departure threeNightsPlus normal 210 true null null',
      '1307 departure partyOrFamily disaster 98 false null null',
    ],
    'pin-standard-1': [
      '1201 stayover business normal -30 false null null',
      '1202 stayover family disaster 141 false null null',
      '1203 stayover tourist normal 66 false null null',
      '1204 departure threeNightsPlus disaster 129 false null null',
      '1205 departure oneNight disaster -30 false 270 null',
      '1206 stayover tourist normal 130 false null null',
      '1207 stayover business disaster -30 false null null',
      '1208 departure partyOrFamily disaster 91 false null null',
      '1301 departure oneNight tidy 127 false null null',
      '1302 dnd family tidy 95 false null null',
      '1303 stayover family normal 147 false null null',
      '1304 departure oneNight normal 47 false null null',
      '1305 stayover longStay disaster 177 false null null',
      '1306 departure oneNight tidy 143 false 330 null',
      '1307 dnd family normal 171 false null null',
    ],
  },
  tight: {
    'pin-tight-0': [
      '1201 stayover family disaster -30 false null null',
      '1202 stayover business normal -30 false null null',
      '1203 departure partyOrFamily disaster -30 false null null',
      '1204 stayover tourist tidy 121 false null null',
      '1205 stayover family normal 88 false null null',
      '1206 departure threeNightsPlus disaster 49 false null null',
      '1207 departure threeNightsPlus normal -30 false null null',
      '1208 stayover business normal -30 false null null',
      '1301 departure threeNightsPlus tidy -30 false 330 null',
      '1302 dnd business normal -30 false null 303',
      '1303 stayover tourist disaster 102 false null null',
      '1304 departure oneNight tidy -30 false 270 null',
      '1305 dnd family normal 124 false null 317',
      '1306 departure threeNightsPlus normal 33 false null null',
      '1307 stayover business tidy 45 false null null',
    ],
    'pin-tight-1': [
      '1201 stayover family normal 100 false null null',
      '1202 departure oneNight normal 19 false 330 null',
      '1203 departure oneNight normal 60 false 270 null',
      '1204 stayover tourist disaster -30 false null null',
      '1205 stayover longStay normal 228 false null null',
      '1206 departure partyOrFamily disaster 124 false null null',
      '1207 departure oneNight tidy 62 false null null',
      '1208 departure oneNight normal -30 false null null',
      '1301 dnd business tidy -30 false null null',
      '1302 stayover family disaster 115 false null null',
      '1303 stayover longStay disaster 245 false null null',
      '1304 stayover tourist normal 24 false null null',
      '1305 stayover tourist disaster 17 false null null',
      '1306 departure partyOrFamily normal 145 false null null',
      '1307 dnd business normal 7 false null 325',
    ],
  },
  weekend: {
    'pin-weekend-0': [
      '1201 stayover tourist tidy 102 false null null',
      '1202 stayover tourist disaster -30 false null null',
      '1203 departure oneNight tidy 107 false 270 null',
      '1204 departure partyOrFamily normal -30 false null null',
      '1205 stayover business tidy -30 false null null',
      '1206 dnd longStay normal 289 false null 233',
      '1207 departure threeNightsPlus disaster 137 false null null',
      '1208 stayover business tidy -30 false null null',
      '1301 stayover business normal -30 false null null',
      '1302 departure threeNightsPlus normal 73 false null null',
      '1303 stayover longStay normal 255 false null null',
      '1304 departure threeNightsPlus tidy 120 false 300 null',
      '1305 stayover business tidy -30 false null null',
      '1306 dnd business tidy 50 false null null',
      '1307 departure oneNight disaster 112 false 330 null',
    ],
    'pin-weekend-1': [
      '1201 departure threeNightsPlus tidy -30 false 270 null',
      '1202 stayover family disaster 191 false null null',
      '1203 departure oneNight normal 210 true null null',
      '1204 stayover family disaster 161 false null null',
      '1205 departure oneNight normal 86 false null null',
      '1206 dnd longStay normal 258 false null null',
      '1207 stayover tourist disaster -30 false null null',
      '1208 stayover business tidy -30 false null null',
      '1301 departure oneNight tidy 124 false null null',
      '1302 dnd business normal 53 false null 260',
      '1303 stayover tourist normal 85 false null null',
      '1304 stayover tourist tidy -30 false null null',
      '1305 departure partyOrFamily disaster 70 false 300 null',
      '1306 stayover business normal 30 false null null',
      '1307 departure threeNightsPlus tidy -30 false 330 null',
    ],
  },
};

/** 一间房写成一行，字段顺序见 PINNED_WORLDS 的说明。null 写成 null。 */
function pinnedLine(room: RoomTruth): string {
  return `${room.id} ${room.kind} ${room.clue} ${room.mess} ${room.availableFrom} ${room.lateCheckout} ${room.vipDeadline} ${room.dndLiftsAt}`;
}

describe('generate：固定种子的世界', () => {
  it.each(TIERS)('%s 档：固定种子生成的每间房都和钉住的值相同', (tier) => {
    for (const [seed, expected] of Object.entries(PINNED_WORLDS[tier])) {
      expect(generate(seed, PARAMS[tier]).rooms.map(pinnedLine), `种子 ${seed}`).toEqual(expected);
    }
  });
});

/**
 * 频率检验的容差：4 个标准差。种子是固定的，所以结果是确定的。
 * 实现正确时，单项检验落在容差之外的概率约为十万分之六，三档合起来约 270 项，总体约百分之二。
 * 改了随机流以后如果只有一项差一点点没过，可以换一组种子复核是不是巧合。
 * 概率为 0 或 1 的项容差为 0，必须完全一致（比如周末档的家庭和长住客人开工时一定在房内）。
 */
const SIGMAS = 4;

function expectRate(hits: number, total: number, p: number, label: string): void {
  expect(total, label).toBeGreaterThan(0);
  const tolerance = SIGMAS * Math.sqrt((p * (1 - p)) / total);
  expect(Math.abs(hits / total - p), `${label}：${hits}/${total}，期望 ${p}`).toBeLessThanOrEqual(tolerance);
}

/** 时刻落在 [from, to) 里，样本均值离均匀分布的期望不超过 4 个标准差。 */
function expectUniformMinutes(values: Minute[], from: Minute, to: Minute, label: string): void {
  expect(values.length, label).toBeGreaterThan(0);
  for (const value of values) expect(within(value, from, to), `${label}：${value}`).toBe(true);
  const width = to - from;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt((width * width - 1) / 12 / values.length);
  expect(Math.abs(mean - (from + to - 1) / 2), `${label} 的均值 ${mean}`).toBeLessThanOrEqual(SIGMAS * sd);
}

describe.each(TIERS)('generate 的统计频率：%s 档，1000 个固定种子', (tier) => {
  const params = PARAMS[tier];
  let rooms: RoomTruth[] = [];
  let departures: RoomTruth[] = [];
  // 续住房和请勿打扰房：都带续住线索，出门时刻的规则相同。
  let guestRooms: RoomTruth[] = [];
  const withClue = (list: RoomTruth[], clue: string): RoomTruth[] => list.filter((room) => room.clue === clue);

  // 放在 beforeAll 里生成：generate 抛错时报在这组测试上，而不是让整个文件收集失败。
  beforeAll(() => {
    rooms = seeds(`stats-${tier}`, 1000).flatMap((seed) => generate(seed, params).rooms);
    departures = rooms.filter((room) => room.kind === 'departure');
    guestRooms = rooms.filter((room) => room.kind !== 'departure');
  });

  it('房型随机分到各个房间：每间房是各房型的比例接近 mix 的比例', () => {
    const roomCount = allRooms(params).length;
    const shares: [RoomKind, number][] = [
      ['departure', params.mix.departures / roomCount],
      ['stayover', params.mix.stayovers / roomCount],
      ['dnd', params.mix.dnd / roomCount],
    ];
    for (const id of allRooms(params)) {
      const sample = rooms.filter((room) => room.id === id);
      for (const [kind, share] of shares) {
        expectRate(sample.filter((room) => room.kind === kind).length, sample.length, share, `${id} ${kind}`);
      }
    }
  });

  it('退房房线索的比例接近 share', () => {
    for (const [clue, { share }] of Object.entries(params.departureClues)) {
      expectRate(withClue(departures, clue).length, departures.length, share, clue);
    }
  });

  it('续住房和请勿打扰房线索的比例接近 share', () => {
    for (const [clue, { share }] of Object.entries(params.stayClues)) {
      expectRate(withClue(guestRooms, clue).length, guestRooms.length, share, clue);
    }
  });

  it('每条线索的脏乱分布接近 params', () => {
    const tables = [...Object.entries(params.departureClues), ...Object.entries(params.stayClues)];
    for (const [clue, { mess }] of tables) {
      const sample = withClue(rooms, clue);
      for (const level of MESS_LEVELS) {
        expectRate(sample.filter((room) => room.mess === level).length, sample.length, mess[level], `${clue} ${level}`);
      }
    }
  });

  it('退房时刻四段的比例接近 params，四段互不重叠', () => {
    const { early, late } = params.checkout;
    const segments = {
      beforeStart: departures.filter((room) => room.availableFrom === params.shift.beforeStart),
      early: departures.filter((room) => within(room.availableFrom, early.from, early.to)),
      late: departures.filter((room) => within(room.availableFrom, late.from, late.to)),
      lateCheckout: departures.filter((room) => room.lateCheckout),
    };
    const total = Object.values(segments).reduce((sum, list) => sum + list.length, 0);
    expect(total).toBe(departures.length);
    for (const [name, list] of Object.entries(segments)) {
      expectRate(list.length, departures.length, params.checkout[name as keyof typeof segments].share, name);
    }

    // 时间窗左闭右开：两端的整数分钟都取得到，右端点不取。
    for (const [name, list, range] of [
      ['早段', segments.early, early],
      ['晚段', segments.late, late],
    ] as const) {
      const times = list.map((room) => room.availableFrom);
      expectUniformMinutes(times, range.from, range.to, name);
      expect(Math.min(...times), name).toBe(range.from);
      expect(Math.max(...times), name).toBe(range.to - 1);
    }
  });

  it('开工时人在房内的比例接近 min(1, inRoomAtStart + inRoomBoost)', () => {
    const { inRoomBoost, leaveDelay } = params.guests;
    for (const [clue, { inRoomAtStart, leaveFrom, leaveTo }] of Object.entries(params.stayClues)) {
      const sample = withClue(guestRooms, clue);
      // 出门时间窗不早于开工，所以出门时刻（availableFrom）不小于 0 就是开工时人在房内。
      const inRoom = sample.filter((room) => room.availableFrom >= 0);
      expectRate(inRoom.length, sample.length, Math.min(1, inRoomAtStart + inRoomBoost), clue);
      expectUniformMinutes(
        inRoom.map((room) => room.availableFrom),
        leaveFrom + leaveDelay,
        leaveTo + leaveDelay,
        `${clue} 的出门时刻`,
      );
    }
  });

  it('请勿打扰房摘牌的比例接近 liftChance', () => {
    const dndRooms = rooms.filter((room) => room.kind === 'dnd');
    const lifts = dndRooms.flatMap((room) => (room.dndLiftsAt === null ? [] : [room.dndLiftsAt]));
    expectRate(lifts.length, dndRooms.length, params.dnd.liftChance, '摘牌');
    expectUniformMinutes(lifts, params.dnd.liftFrom, params.dnd.liftTo, '摘牌时刻');
  });
});

describe('generate：子随机流', () => {
  const params = PARAMS.standard;
  const sample = seeds('stream', 200);

  it('提高摘牌概率：原来摘牌的房间仍在同一时刻摘牌，其他隐藏信息都不变', () => {
    const more: Params = { ...params, dnd: { ...params.dnd, liftChance: 0.9 } };
    let newLifts = 0;
    for (const seed of sample) {
      for (const [before, after] of pairs(generate(seed, params).rooms, generate(seed, more).rooms)) {
        expect({ ...after, dndLiftsAt: null }).toStrictEqual({ ...before, dndLiftsAt: null });
        if (before.dndLiftsAt !== null) expect(after.dndLiftsAt).toBe(before.dndLiftsAt);
        else if (after.dndLiftsAt !== null) newLifts++;
      }
    }
    expect(newLifts).toBeGreaterThan(0);
  });

  it('改一条线索的脏乱分布：只有脏乱档位会变', () => {
    const { oneNight } = params.departureClues;
    const messier: Params = {
      ...params,
      departureClues: { ...params.departureClues, oneNight: { ...oneNight, mess: { tidy: 0.1, normal: 0.3, disaster: 0.6 } } },
    };
    let changed = 0;
    for (const seed of sample) {
      for (const [before, after] of pairs(generate(seed, params).rooms, generate(seed, messier).rooms)) {
        expect({ ...after, mess: 'normal' }).toStrictEqual({ ...before, mess: 'normal' });
        if (after.mess !== before.mess) {
          expect(before.clue).toBe('oneNight');
          changed++;
        }
      }
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('generate：贵宾候选不够时', () => {
  // 延迟退房占九成：非延迟的退房房多半不到 3 间，几乎每个世界都要补。
  const base = PARAMS.weekend;
  const crowded: Params = {
    ...base,
    checkout: {
      beforeStart: { share: 0.04 },
      early: { ...base.checkout.early, share: 0.04 },
      late: { ...base.checkout.late, share: 0.02 },
      lateCheckout: { ...base.checkout.lateCheckout, share: 0.9 },
    },
  };
  // 不设贵宾时不需要补，房间就是按原始分布掷出来的样子。
  const noVip: Params = { ...crowded, vipDeadlines: [] };
  const sample = seeds('crowded', 200);

  it('补足之后仍满足全部不变量', () => {
    for (const seed of sample) expectValidWorld(generate(seed, crowded), crowded);
  });

  it('只把缺的数量的延迟退房房改成普通退房，改过的房间都成为贵宾，其余房间不变', () => {
    let promotedTotal = 0;
    for (const seed of sample) {
      const natural = generate(seed, noVip).rooms;
      const shortfall = Math.max(0, crowded.vipDeadlines.length - natural.filter(isOnTimeDeparture).length);
      let promoted = 0;
      for (const [before, after] of pairs(natural, generate(seed, crowded).rooms)) {
        if (before.lateCheckout === after.lateCheckout) {
          expect({ ...after, vipDeadline: null }).toStrictEqual(before);
          continue;
        }
        promoted++;
        expect(before.lateCheckout).toBe(true);
        expect(after.vipDeadline).not.toBeNull();
        // 除了退房时刻、延迟退房标记和贵宾时限，别的隐藏信息没动。
        // 新的退房时刻落在前三段，已由 expectValidWorld 检查过。
        expect({ ...after, availableFrom: 0, lateCheckout: true, vipDeadline: null }).toStrictEqual({
          ...before,
          availableFrom: 0,
        });
      }
      expect(promoted, `种子 ${seed}`).toBe(shortfall);
      promotedTotal += promoted;
    }
    // 确认这组参数确实走到了补足的分支。
    expect(promotedTotal).toBeGreaterThan(sample.length);
  });
});

describe('generate：参数检查', () => {
  it('参数自相矛盾时报错', () => {
    const params = PARAMS.standard;
    const { early, late, lateCheckout } = params.checkout;
    const allLate: Params = {
      ...params,
      checkout: {
        beforeStart: { share: 0 },
        early: { ...early, share: 0 },
        late: { ...late, share: 0 },
        lateCheckout: { ...lateCheckout, share: 1 },
      },
    };

    const tooManyVips = Array.from({ length: params.mix.departures + 1 }, () => params.shift.targetFinish);

    expect(() => generate('x', { ...params, mix: { ...params.mix, dnd: params.mix.dnd + 1 } })).toThrow(/mix/);
    expect(() => generate('x', { ...params, vipDeadlines: tooManyVips })).toThrow(/贵宾时限/);
    expect(() => generate('x', allLate)).toThrow(/非延迟/);
    expect(() => generate('x', { ...params, dnd: { liftChance: 1, liftFrom: 200, liftTo: 200 } })).toThrow(/时间窗/);
    // 没有贵宾时，全是延迟退房也能生成。
    const rooms = generate('x', { ...allLate, vipDeadlines: [] }).rooms;
    expect(rooms.filter((room) => room.lateCheckout)).toHaveLength(params.mix.departures);
  });
});
