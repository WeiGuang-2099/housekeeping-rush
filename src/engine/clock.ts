/**
 * 时间约定：引擎里的时间一律是"开工后第几分钟"（Minute），08:30 记为 0。
 * 只有显示给玩家时才换算成钟点。
 */

import type { Minute } from './types';

/** 开工时刻 08:30，以当天 00:00 起算的分钟数。 */
export const SHIFT_START_OF_DAY = 8 * 60 + 30;

/** 开工后第几分钟 → "HH:MM"。例如 0 → "08:30"，270 → "13:00"。 */
export function toClock(minute: Minute): string {
  const total = SHIFT_START_OF_DAY + Math.round(minute);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** "HH:MM" → 开工后第几分钟。例如 "13:00" → 270。 */
export function fromClock(clock: string): Minute {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!match) throw new Error(`fromClock: 无法解析 "${clock}"`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) throw new Error(`fromClock: 无效的时刻 "${clock}"`);
  return hh * 60 + mm - SHIFT_START_OF_DAY;
}
