/**
 * 图标：在 16 × 16 的格子里画的 SVG 图形，线条颜色跟随文字颜色（index.css）。
 * 状态同时用颜色和图标表达，色觉障碍的玩家也能分辨（docs/DESIGN.md 的美术方向）：做完了是对勾，还不能进是锁，
 * 晚点再来是钟，看起来能进的没有图标。图标本身不带文字，要读出来的意思写在旁边的文字或提示里。
 */

import type { RoomStatus } from './rooms';

/** 图标格子的边长，图形的坐标都在 0 到它之间。 */
export const GLYPH_SIZE = 16;

/** 状态图标的图形部分，平面图里直接放进 SVG；看起来能进的房间没有图标。 */
export function StatusGlyph({ status }: { readonly status: RoomStatus }) {
  switch (status) {
    case 'done':
      return <path className="glyph" d="M3 8.5 6.5 12 13 4.5" />;
    case 'locked':
      return (
        <g className="glyph">
          <rect x="3.5" y="7.5" width="9" height="6.5" rx="1" />
          <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
        </g>
      );
    case 'later':
      return (
        <g className="glyph">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" />
        </g>
      );
    case 'open':
      return null;
  }
}

/** HTML 里用的状态图标：外面包一层 svg，读屏软件跳过它。 */
export function StatusIcon({ status }: { readonly status: RoomStatus }) {
  return (
    <svg className="icon" viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`} aria-hidden="true" focusable="false">
      <StatusGlyph status={status} />
    </svg>
  );
}

/** 时间轴上时限的小旗。 */
export function FlagIcon() {
  return (
    <svg className="icon icon-flag" viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`} aria-hidden="true" focusable="false">
      <path className="glyph" d="M4.5 15V1.5" />
      <path className="glyph-fill" d="M4.5 2 13 5 4.5 8z" />
    </svg>
  );
}
