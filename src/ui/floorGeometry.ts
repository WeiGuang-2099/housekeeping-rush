/**
 * 平面图的几何：每间房的方块、走廊、电梯和服务间在 SVG 里的位置（docs/DESIGN.md 的"主界面的四个部件"）。
 *
 * 1. 只读 params 的楼层平面（params.layout），不读 View：楼层、房号、门位都从 params 来，换一套楼层也画得出来。
 *    房间的门位用 layout.ts 的 placeOf，和规则是同一份。结算页的轨迹图以后叠在同一张图上，也用这里的坐标。
 * 2. 楼层上下叠放，楼层号大的在上面。每层先是楼层名，再是两排房间，中间是走廊。同一门位的两间房上下相对：
 *    params 里每两间对着同一个门位，前一间在上排，后一间在下排。门位 1 在最左边，往右依次排开。
 * 3. 左边一列是电梯，从最上一层的上排一直到最下一层的下排。服务间画在它所在楼层下排的高度上，电梯在那里断开。
 *    服务间不在电梯厅（门位 0）时抛错：设计里服务间在 12 楼电梯厅，三档和测试用的参数都是这样。
 * 4. 位置的点（placePoint）：门位 1 起是走廊上正对那两间房的点；门位 0 是走廊左端、紧挨电梯的点。
 * 5. 下面的长度是 SVG 的用户单位，只管画面布局，不是玩法数值，所以不放 params。
 */

import { placeOf, type Params, type Place, type RoomId } from '../engine';

/** 外边距。 */
const PAD = 8;
/** 电梯和服务间那一列的宽度。 */
const LIFT_WIDTH = 64;
/** 电梯和门位 1 的房间之间的空隙，门位 0 的点在它正中。 */
const LIFT_GAP = 32;
const ROOM_WIDTH = 120;
const ROOM_HEIGHT = 64;
/** 同一排相邻两间房之间的空隙。 */
const ROOM_GAP = 16;
/** 两排房间之间的走廊。 */
const CORRIDOR = 40;
/** 每层上排上面留给楼层名的高度。 */
const LABEL_HEIGHT = 32;
/** 楼层名的基线离上排的距离。 */
const LABEL_BASELINE = 10;
/** 相邻两层之间的空隙。 */
const FLOOR_GAP = 16;
/** 服务间和上下两段电梯之间的空隙。 */
const SERVICE_GAP = 8;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 一层楼：楼层名的位置（左端、基线），走廊从门位 0 到最后一个门位的线段，以及这一层有几个门位。 */
export interface FloorBand {
  readonly floor: number;
  readonly label: Point;
  readonly corridor: { readonly from: Point; readonly to: Point };
  readonly doors: number;
}

/** 一间房的方块。 */
export interface RoomBox extends Box {
  readonly id: RoomId;
  readonly place: Place;
}

export interface FloorGeometry {
  /** SVG 的宽和高（viewBox 从 0 0 开始）。 */
  readonly width: number;
  readonly height: number;
  /** 从上到下，楼层号大的在上面。 */
  readonly floors: readonly FloorBand[];
  /** 按 params 楼层平面里列的顺序，也就是 view.rooms 的顺序。 */
  readonly rooms: readonly RoomBox[];
  /** 电梯：服务间把它分成上下两段，只剩一段时只有一项。 */
  readonly lift: readonly Box[];
  readonly servicePoint: Box;
}

/** 门位 door 正对的走廊点的横坐标；门位 0 在电梯旁边。 */
function doorX(door: number): number {
  if (door === 0) return PAD + LIFT_WIDTH + LIFT_GAP / 2;
  return PAD + LIFT_WIDTH + LIFT_GAP + (door - 1) * (ROOM_WIDTH + ROOM_GAP) + ROOM_WIDTH / 2;
}

/** 按 params 的楼层平面算出整张平面图的位置，规则见文件开头。 */
export function floorGeometry(params: Params): FloorGeometry {
  const { floors: plans, servicePoint } = params.layout;
  if (servicePoint.door !== 0) throw new Error('平面图：服务间不在电梯厅（门位 0），画不出来');
  const ordered = [...plans].sort((a, b) => b.floor - a.floor);
  const blockHeight = LABEL_HEIGHT + ROOM_HEIGHT + CORRIDOR + ROOM_HEIGHT;
  const topRowOf = (index: number): number => PAD + index * (blockHeight + FLOOR_GAP) + LABEL_HEIGHT;

  const floors: FloorBand[] = [];
  const boxes = new Map<RoomId, RoomBox>();
  let service: Box | null = null;
  for (const [index, plan] of ordered.entries()) {
    const top = topRowOf(index);
    const corridorY = top + ROOM_HEIGHT + CORRIDOR / 2;
    const bottom = top + ROOM_HEIGHT + CORRIDOR;
    const doors = Math.ceil(plan.rooms.length / 2);
    floors.push({
      floor: plan.floor,
      label: { x: doorX(1) - ROOM_WIDTH / 2, y: top - LABEL_BASELINE },
      corridor: { from: { x: doorX(0), y: corridorY }, to: { x: doorX(doors), y: corridorY } },
      doors,
    });
    for (const [position, id] of plan.rooms.entries()) {
      const place = placeOf(id, params);
      boxes.set(id, {
        id,
        place,
        x: doorX(place.door) - ROOM_WIDTH / 2,
        y: position % 2 === 0 ? top : bottom,
        width: ROOM_WIDTH,
        height: ROOM_HEIGHT,
      });
    }
    if (plan.floor === servicePoint.floor) service = { x: PAD, y: bottom, width: LIFT_WIDTH, height: ROOM_HEIGHT };
  }
  if (service === null) throw new Error(`平面图：楼层里没有服务间所在的 ${servicePoint.floor} 楼`);

  const maxDoors = Math.max(...floors.map((band) => band.doors));
  const liftTop = topRowOf(0);
  const liftBottom = topRowOf(ordered.length - 1) + ROOM_HEIGHT + CORRIDOR + ROOM_HEIGHT;
  const lift = [
    { x: PAD, y: liftTop, width: LIFT_WIDTH, height: service.y - SERVICE_GAP - liftTop },
    {
      x: PAD,
      y: service.y + service.height + SERVICE_GAP,
      width: LIFT_WIDTH,
      height: liftBottom - (service.y + service.height + SERVICE_GAP),
    },
  ].filter((segment) => segment.height > 0);

  return {
    width: doorX(maxDoors) + ROOM_WIDTH / 2 + PAD,
    height: liftBottom + PAD,
    floors,
    rooms: params.layout.floors.flatMap((plan) =>
      plan.rooms.map((id) => {
        const box = boxes.get(id);
        if (box === undefined) throw new Error(`平面图：没有算出房间 ${id} 的位置`);
        return box;
      }),
    ),
    lift,
    servicePoint: service,
  };
}

/** 位置 place 在平面图上的点，见文件开头第 4 条。楼层或门位不在平面图里时抛错。 */
export function placePoint(geometry: FloorGeometry, place: Place): Point {
  const band = geometry.floors.find((floor) => floor.floor === place.floor);
  if (band === undefined || place.door < 0 || place.door > band.doors || !Number.isInteger(place.door)) {
    throw new Error(`平面图：位置 ${place.floor} 楼门位 ${place.door} 不在平面图里`);
  }
  return { x: doorX(place.door), y: band.corridor.from.y };
}
