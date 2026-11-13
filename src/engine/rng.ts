/**
 * 带种子的随机数。
 *
 * 硬约束：随机数只允许在 generate（生成世界）里使用。
 * rules、observe、score 和所有策略的"规则部分"都不得调用它，
 * 这样同一个种子加同一串动作，结果永远相同。
 * （老手策略采样"可能的世界"时可以用它，但必须用自己的种子。）
 */

/** 把任意字符串种子变成 32 位无符号整数（xmur3）。 */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface Rng {
  /** [0, 1) 上的均匀随机数。 */
  next(): number;
  /** [min, max) 上的均匀随机数。 */
  range(min: number, max: number): number;
  /** [min, max] 上的均匀随机整数，两端都包含。 */
  int(min: number, max: number): number;
  /** 以概率 p 返回 true。 */
  chance(p: number): boolean;
  /** 按权重抽一个元素；不给权重时等概率。 */
  pick<T>(items: readonly T[], weights?: readonly number[]): T;
  /** 返回一个打乱后的新数组，不修改原数组。 */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32：小、快、够用，周期 2^32。 */
export function createRng(seed: string): Rng {
  let a = hashSeed(seed);

  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + next() * (max - min);

  const int = (min: number, max: number): number => Math.floor(range(min, max + 1));

  const chance = (p: number): boolean => next() < p;

  const pick = <T>(items: readonly T[], weights?: readonly number[]): T => {
    if (items.length === 0) throw new Error('pick: 列表为空');
    if (weights && weights.length !== items.length) {
      throw new Error('pick: 权重数量和元素数量不一致');
    }
    const total = weights ? weights.reduce((sum, w) => sum + w, 0) : items.length;
    if (!(total > 0)) throw new Error('pick: 权重之和必须大于 0');
    let roll = next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights ? (weights[i] ?? 0) : 1;
      if (roll < 0) return items[i] as T;
    }
    // 浮点误差兜底：返回最后一个权重大于 0 的元素。
    for (let i = items.length - 1; i >= 0; i--) {
      if (!weights || (weights[i] ?? 0) > 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  };

  return { next, range, int, chance, pick, shuffle };
}
