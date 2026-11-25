/**
 * 班次 reducer（src/ui/shift.ts）的单元测试：开一班；选一个动作预览、换一个、取消都不改动班次的状态；确认才执行
 * （apply），之后清掉预览；没有预览时确认、确认非法动作都抛错；不修改传入的 model；screenProps 只把 View、params 和
 * 正在预览的动作交给界面。
 */

import { describe, expect, it } from 'vitest';
import { apply, generate, initial, observe, PARAMS, type Action } from '../src/engine';
import { screenProps, shiftReducer, startShift, type ShiftMessage, type ShiftModel } from '../src/ui/shift';
import { act, errorOf } from './helpers/drive';
import { deepFreeze, TIERS } from './helpers/play';

/** 一个不会碰巧出现在 View 或参数里的种子，用来查种子有没有漏给界面。 */
const SEED = 'ui-shift-seed-7f3a';

/** 依次交给 reducer。 */
function run(model: ShiftModel, ...messages: ShiftMessage[]): ShiftModel {
  return messages.reduce(shiftReducer, model);
}

/** 选一个动作再确认。 */
function confirmed(action: Action): ShiftMessage[] {
  return [{ type: 'select', action }, { type: 'confirm' }];
}

describe('startShift', () => {
  it.each(TIERS)('%s：按种子和这一档的参数生成世界，状态是开工时的状态，没有预览', (tier) => {
    const model = startShift(SEED, tier);
    expect(model.world).toStrictEqual(generate(SEED, PARAMS[tier]));
    expect(model.world.params).toBe(PARAMS[tier]);
    expect(model.state).toStrictEqual(initial(model.world));
    expect(model.selected).toBeNull();
  });
});

describe('shiftReducer', () => {
  it('start 丢掉之前的班次和预览，按新的种子和难度档开一班', () => {
    const before = run(startShift(SEED, 'standard'), ...confirmed(act.call()), { type: 'select', action: act.wait(2) });
    const after = shiftReducer(before, { type: 'start', seed: 'ui-shift-other', tier: 'weekend' });
    expect(after).toStrictEqual(startShift('ui-shift-other', 'weekend'));
  });

  it('select 只记下动作，班次的状态不变（同一个对象）；再选一个就换成新的；cancel 清掉预览', () => {
    const model = deepFreeze(startShift(SEED, 'tight'));
    const selected = shiftReducer(model, { type: 'select', action: act.call() });
    expect(selected.selected).toEqual(act.call());
    expect(selected.state).toBe(model.state);
    expect(selected.world).toBe(model.world);
    const changed = shiftReducer(selected, { type: 'select', action: act.wait(3) });
    expect(changed.selected).toEqual(act.wait(3));
    expect(changed.state).toBe(model.state);
    const cancelled = shiftReducer(changed, { type: 'cancel' });
    expect(cancelled.selected).toBeNull();
    expect(cancelled.state).toBe(model.state);
  });

  it('不合法的动作也能选（预览里写原因），班次的状态不变', () => {
    const model = startShift(SEED, 'standard');
    const selected = shiftReducer(model, { type: 'select', action: act.finish() });
    expect(selected.selected).toEqual(act.finish());
    expect(selected.state).toBe(model.state);
  });

  it('confirm 用 apply 执行正在预览的动作，然后清掉预览；返回新对象，不修改传入的 model', () => {
    const model = deepFreeze(shiftReducer(startShift(SEED, 'tight'), { type: 'select', action: act.call() }));
    const next = shiftReducer(model, { type: 'confirm' });
    expect(next).not.toBe(model);
    expect(next.world).toBe(model.world);
    expect(next.state).toStrictEqual(apply(model.world, model.state, act.call()));
    expect(next.selected).toBeNull();
    expect(model.state.minute).toBe(0);
    expect(model.selected).toEqual(act.call());
  });

  it('同样的种子和消息序列得到同样的状态', () => {
    const messages = [...confirmed(act.call()), { type: 'select', action: act.wait(5) } as const, ...confirmed(act.wait(3))];
    expect(run(startShift(SEED, 'standard'), ...messages)).toStrictEqual(run(startShift(SEED, 'standard'), ...messages));
  });

  it('没有正在预览的动作时确认抛错', () => {
    const model = startShift(SEED, 'standard');
    expect(errorOf(() => shiftReducer(model, { type: 'confirm' }))).toContain('没有正在预览的动作');
    const cancelled = run(model, { type: 'select', action: act.call() }, { type: 'cancel' });
    expect(errorOf(() => shiftReducer(cancelled, { type: 'confirm' }))).toContain('没有正在预览的动作');
  });

  it('确认非法的动作抛出 apply 的报错，原样不改', () => {
    // 开工时还没打过电话，没有哪间退房房被标记已退，打扫退房房不合法。
    const model = startShift(SEED, 'standard');
    const departure = model.world.rooms.find((room) => room.kind === 'departure');
    if (departure === undefined) throw new Error('世界里没有退房房');
    const action = act.service(departure.id);
    const expected = errorOf(() => apply(model.world, model.state, action));
    expect(errorOf(() => run(model, ...confirmed(action)))).toBe(expected);
  });
});

describe('screenProps', () => {
  it('只有 view、params 和正在预览的动作：view 等于 observe 的结果，params 就是 world.params', () => {
    const model = run(startShift(SEED, 'weekend'), ...confirmed(act.call()), { type: 'select', action: act.wait(4) });
    const props = screenProps(model);
    expect(Object.keys(props)).toEqual(['view', 'params', 'selected']);
    expect(props.view).toStrictEqual(observe(model.world, model.state));
    expect(props.params).toBe(model.world.params);
    expect(props.selected).toEqual(act.wait(4));
  });

  it('交给界面的东西里没有种子', () => {
    const props = screenProps(startShift(SEED, 'standard'));
    expect(JSON.stringify(props)).not.toContain(SEED);
  });
});
