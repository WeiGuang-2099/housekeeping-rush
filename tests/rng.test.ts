import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, hashSeed } from '../src/engine/rng';

const take = (seed: string, count: number): number[] => {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
};

describe('rng', () => {
  it('同一个种子产生同一串随机数', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        expect(take(seed, 20)).toEqual(take(seed, 20));
      }),
    );
  });

  it('不同的种子产生不同的序列', () => {
    expect(take('2026-11-13', 10)).not.toEqual(take('2026-11-14', 10));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });

  it('next 落在 [0, 1) 之内', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        for (const value of take(seed, 50)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
    );
  });

  it('int 不越界，而且两端都能取到', () => {
    const rng = createRng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(3, 6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('pick 不会抽到权重为 0 的元素，频率大致符合权重', () => {
    const rng = createRng('pick');
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6000; i++) {
      counts[rng.pick(['a', 'b', 'c'] as const, [1, 0, 2])]++;
    }
    expect(counts.b).toBe(0);
    expect(counts.a / 6000).toBeCloseTo(1 / 3, 1);
    expect(counts.c / 6000).toBeCloseTo(2 / 3, 1);
  });

  it('pick 遇到空列表或全零权重会报错', () => {
    const rng = createRng('errors');
    expect(() => rng.pick([])).toThrow();
    expect(() => rng.pick(['a', 'b'], [0, 0])).toThrow();
    expect(() => rng.pick(['a', 'b'], [1])).toThrow();
  });

  it('shuffle 返回一个排列，不修改原数组', () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.integer(), { maxLength: 30 }), (seed, items) => {
        const original = items.slice();
        const shuffled = createRng(seed).shuffle(items);
        expect(items).toEqual(original);
        expect(shuffled.slice().sort((x, y) => x - y)).toEqual(original.slice().sort((x, y) => x - y));
      }),
    );
  });
});
