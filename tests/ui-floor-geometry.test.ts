/**
 * 平面图的几何（src/ui/floorGeometry.ts）的单元测试：楼层上下叠放、同一门位的两间房上下相对、门位从左往右排，
 * 电梯和服务间在左边一列，位置的点在走廊上。三档用同一套楼层；ODD_PARAMS 的楼层、房数、门位数和服务间所在楼层都不同
 * （3 楼 6 间、5 楼 10 间，服务间在上面的 5 楼），用来查位置都从 params 来。
 */

import { describe, expect, it } from 'vitest';
import { allRooms, PARAMS, placeOf, type Params } from '../src/engine';
import { floorGeometry, placePoint, type Box, type FloorGeometry, type RoomBox } from '../src/ui/floorGeometry';
import { errorOf } from './helpers/drive';
import { ODD_PARAMS } from './helpers/params';

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(inner: Box, geometry: FloorGeometry): boolean {
  return inner.x >= 0 && inner.y >= 0 && inner.x + inner.width <= geometry.width && inner.y + inner.height <= geometry.height;
}

function boxOf(geometry: FloorGeometry, id: number): RoomBox {
  const box = geometry.rooms.find((candidate) => candidate.id === id);
  if (box === undefined) throw new Error(`平面图里没有房间 ${id}`);
  return box;
}

/** 两套楼层都查的性质。 */
function expectSoundLayout(params: Params): void {
  const geometry = floorGeometry(params);
  // 每间房一个方块，顺序和 allRooms 相同，位置和 placeOf 相同。
  expect(geometry.rooms.map((box) => box.id)).toEqual(allRooms(params));
  for (const box of geometry.rooms) expect(box.place).toEqual(placeOf(box.id, params));
  // 楼层从上到下，楼层号大的在上面；每层的门位数等于房间数的一半向上取整。
  const floors = [...params.layout.floors].sort((a, b) => b.floor - a.floor);
  expect(geometry.floors.map((band) => band.floor)).toEqual(floors.map((plan) => plan.floor));
  for (const plan of floors) {
    const band = geometry.floors.find((candidate) => candidate.floor === plan.floor);
    expect(band?.doors).toBe(Math.ceil(plan.rooms.length / 2));
  }
  // 方块、电梯和服务间互不重叠，都在画面里。
  const all: Box[] = [...geometry.rooms, ...geometry.lift, geometry.servicePoint];
  for (const [index, box] of all.entries()) {
    expect(inside(box, geometry)).toBe(true);
    for (const other of all.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
  }
  for (const plan of params.layout.floors) {
    const band = geometry.floors.find((candidate) => candidate.floor === plan.floor);
    if (band === undefined) throw new Error(`没有 ${plan.floor} 楼`);
    const corridorY = band.corridor.from.y;
    for (const [position, id] of plan.rooms.entries()) {
      const box = boxOf(geometry, id);
      // 前一间在走廊上面，后一间在走廊下面。
      if (position % 2 === 0) expect(box.y + box.height).toBeLessThan(corridorY);
      else expect(box.y).toBeGreaterThan(corridorY);
      // 位置的点在走廊上，正对这间房。
      const point = placePoint(geometry, box.place);
      expect(point.y).toBe(corridorY);
      expect(point.x).toBe(box.x + box.width / 2);
    }
    // 同一门位的两间房上下对齐；门位越大越靠右。
    for (let position = 0; position + 1 < plan.rooms.length; position += 2) {
      const [upper, lower] = [plan.rooms[position], plan.rooms[position + 1]];
      if (upper === undefined || lower === undefined) throw new Error('下标越界');
      expect(boxOf(geometry, lower).x).toBe(boxOf(geometry, upper).x);
    }
    const lefts = plan.rooms.filter((_, position) => position % 2 === 0).map((id) => boxOf(geometry, id).x);
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    // 门位 0 在走廊左端：在电梯和服务间右边，在这一层所有房间左边。
    const lobby = placePoint(geometry, { floor: plan.floor, door: 0 });
    expect(lobby).toEqual(band.corridor.from);
    expect(lobby.x).toBeGreaterThan(geometry.servicePoint.x + geometry.servicePoint.width);
    for (const id of plan.rooms) expect(lobby.x).toBeLessThan(boxOf(geometry, id).x);
  }
  // 服务间在它那一层下排的高度上，左边一列；电梯也在左边一列。
  const serviceBand = geometry.floors.find((band) => band.floor === params.layout.servicePoint.floor);
  if (serviceBand === undefined) throw new Error('没有服务间所在的楼层');
  expect(geometry.servicePoint.y).toBeGreaterThan(serviceBand.corridor.from.y);
  for (const segment of geometry.lift) expect(segment.x).toBe(geometry.servicePoint.x);
}

describe('平面图的几何', () => {
  it('标准档：13 楼在上 12 楼在下，各 4 个门位；服务间在 12 楼，电梯只剩服务间上面一段', () => {
    expectSoundLayout(PARAMS.standard);
    const geometry = floorGeometry(PARAMS.standard);
    expect(geometry.floors.map((band) => [band.floor, band.doors])).toEqual([
      [13, 4],
      [12, 4],
    ]);
    expect(geometry.lift).toHaveLength(1);
    const [lift] = geometry.lift;
    expect(lift !== undefined && lift.y + lift.height < geometry.servicePoint.y).toBe(true);
  });

  it('ODD_PARAMS：5 楼（5 个门位）在上 3 楼（3 个门位）在下；服务间在上面的 5 楼，电梯分成上下两段', () => {
    expectSoundLayout(ODD_PARAMS);
    const geometry = floorGeometry(ODD_PARAMS);
    expect(geometry.floors.map((band) => [band.floor, band.doors])).toEqual([
      [5, 5],
      [3, 3],
    ]);
    expect(geometry.lift).toHaveLength(2);
    // 门位多的楼层决定宽度：5 楼最右边的房间也在画面里，比标准档宽。
    expect(geometry.width).toBeGreaterThan(floorGeometry(PARAMS.standard).width);
  });

  it('三档的楼层相同，几何也相同', () => {
    expect(floorGeometry(PARAMS.tight)).toEqual(floorGeometry(PARAMS.standard));
    expect(floorGeometry(PARAMS.weekend)).toEqual(floorGeometry(PARAMS.standard));
  });

  it('服务间不在电梯厅时抛错；位置不在平面图里时抛错', () => {
    const moved: Params = { ...PARAMS.standard, layout: { ...PARAMS.standard.layout, servicePoint: { floor: 12, door: 2 } } };
    expect(errorOf(() => floorGeometry(moved))).toContain('服务间');
    const geometry = floorGeometry(PARAMS.standard);
    for (const place of [
      { floor: 14, door: 1 },
      { floor: 12, door: 5 },
      { floor: 12, door: -1 },
      { floor: 12, door: 1.5 },
    ]) {
      expect(errorOf(() => placePoint(geometry, place))).toContain('不在平面图里');
    }
  });
});
