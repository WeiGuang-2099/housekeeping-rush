/**
 * 班次 reducer（src/ui/shift.ts）的单元测试：开一班、执行动作、非法动作抛出 apply 的报错、不修改传入的 model，
 * 以及 screenProps 只把 View 和 params 交给界面。
 */

import { describe, expect, it } from 'vitest';
import { apply, generate, initial, observe, PARAMS } from '../src/engine';
import { screenProps, shiftReducer, startShift, type ShiftModel } from '../src/ui/shift';
import { act, errorOf } from './helpers/drive';
import { deepFreeze, TIERS } from './helpers/play';

/** 一个不会碰巧出现在 View 或参数里的种子，用来查种子有没有漏给界面。 */
const SEED = 'ui-shift-seed-7f3a';

describe('startShift', () => {
  it.each(TIERS)('%s：按种子和这一档的参数生成世界，状态是开工时的状态', (tier) => {
    const model = startShift(SEED, tier);
    expect(model.world).toStrictEqual(generate(SEED, PARAMS[tier]));
    expect(model.world.params).toBe(PARAMS[tier]);
    expect(model.state).toStrictEqual(initial(model.world));
  });
});

describe('shiftReducer', () => {
  it('start 丢掉之前的班次，按新的种子和难度档开一班', () => {
    const before = shiftReducer(startShift(SEED, 'standard'), { type: 'act', action: act.call() });
    const after = shiftReducer(before, { type: 'start', seed: 'ui-shift-other', tier: 'weekend' });
    expect(after).toStrictEqual(startShift('ui-shift-other', 'weekend'));
  });

  it('act 用 apply 执行动作：world 不变，state 是 apply 的结果；返回新对象，不修改传入的 model', () => {
    const model: ShiftModel = deepFreeze(startShift(SEED, 'tight'));
    const next = shiftReducer(model, { type: 'act', action: act.call() });
    expect(next).not.toBe(model);
    expect(next.world).toBe(model.world);
    expect(next.state).toStrictEqual(apply(model.world, model.state, act.call()));
    expect(model.state.minute).toBe(0);
    expect(model.state.log).toHaveLength(0);
  });

  it('同样的种子和动作序列得到同样的状态', () => {
    const actions = [act.call(), act.wait(3), act.call()];
    const run = (): ShiftModel =>
      actions.reduce((model, action) => shiftReducer(model, { type: 'act', action }), startShift(SEED, 'standard'));
    expect(run()).toStrictEqual(run());
  });

  it('非法动作抛出 apply 的报错，原样不改', () => {
    // 开工时还没打过电话，没有哪间退房房被标记已退，打扫退房房不合法。
    const model = startShift(SEED, 'standard');
    const departure = model.world.rooms.find((room) => room.kind === 'departure');
    if (departure === undefined) throw new Error('世界里没有退房房');
    const action = act.service(departure.id);
    const expected = errorOf(() => apply(model.world, model.state, action));
    expect(errorOf(() => shiftReducer(model, { type: 'act', action }))).toBe(expected);
  });
});

describe('screenProps', () => {
  it('只有 view 和 params 两项：view 等于 observe 的结果，params 就是 world.params', () => {
    const model = shiftReducer(startShift(SEED, 'weekend'), { type: 'act', action: act.call() });
    const props = screenProps(model);
    expect(Object.keys(props)).toEqual(['view', 'params']);
    expect(props.view).toStrictEqual(observe(model.world, model.state));
    expect(props.params).toBe(model.world.params);
  });

  it('交给界面的东西里没有种子', () => {
    const props = screenProps(startShift(SEED, 'standard'));
    expect(JSON.stringify(props)).not.toContain(SEED);
  });
});
