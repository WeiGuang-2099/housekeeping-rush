/**
 * 任务单（docs/DESIGN.md 的"主界面的四个部件"）：同一批房间的列表，有时限的排在前面，每行是房号、房型、线索和已知信息。
 * 顶上写最近一次打电话的时刻；还不知道摘牌的请勿打扰房那一行写最近一次确认仍挂牌的时刻（docs/DESIGN.md 的"记性"）。
 * 这两样都来自 recall（只读 View 和 params），顺序和已知信息来自 rooms.ts，文字一律从语言包取。
 *
 * 房号也是按钮：点了预览去这间房打扫，和点平面图上的房间一样（能不能点按 preview.ts 的 canPick）。预览中的那一行描成强调色。
 */

import { useId } from 'react';
import { useText } from '../content';
import { recall, toClock, type Action } from '../engine';
import { factText } from './format';
import { StatusIcon } from './icons';
import { canPick, type Preview } from './preview';
import { roomInfos, taskGroup, taskSheetOrder } from './rooms';
import type { ScreenProps } from './shift';

export interface TaskSheetProps extends ScreenProps {
  /** 正在预览的动作；没有为 null。 */
  readonly preview?: Preview | null;
  /** 点房号时预览去那间房打扫；不给就不能点。 */
  readonly onSelect?: (action: Action) => void;
}

export function TaskSheet({ view, params, preview = null, onSelect }: TaskSheetProps) {
  const t = useText();
  const titleId = useId();
  const memory = recall(view, params);
  const rows = taskSheetOrder(roomInfos(view, params, memory));
  const target = preview?.action.type === 'service' ? preview.action.room : null;

  return (
    <section className="task-sheet" aria-labelledby={titleId}>
      <h2 id={titleId}>{t.taskSheet.title}</h2>
      <p className="ts-call">
        {memory.lastCallAt === null ? t.taskSheet.noCallYet : t.taskSheet.lastCall(toClock(memory.lastCallAt))}
      </p>
      <table className="ts-table">
        <tbody>
          {rows.map((info) => {
            const { room, status } = info;
            const pick: Action = { type: 'service', room: room.id };
            const select = onSelect !== undefined && canPick(view, params, pick) ? () => onSelect(pick) : null;
            return (
              <tr
                key={room.id}
                className={`ts-row is-${status} in-${taskGroup(room)}${room.id === target ? ' is-selected' : ''}`}
                data-room={room.id}
                data-status={status}
              >
                <td className="ts-icon">
                  <StatusIcon status={status} />
                </td>
                <th scope="row" className="ts-room mono">
                  {select !== null ? (
                    <button
                      type="button"
                      className="ts-pick"
                      aria-label={t.taskSheet.pick(room.id)}
                      aria-pressed={room.id === target}
                      onClick={select}
                    >
                      {room.id}
                    </button>
                  ) : (
                    room.id
                  )}
                </th>
                <td className="ts-kind">{t.kind[room.kind]}</td>
                <td className="ts-clue">{t.clue[room.clue]}</td>
                <td className="ts-facts">
                  {info.facts.map((fact) => (
                    <span key={fact.code} className={`ts-fact is-${fact.code}`}>
                      {factText(fact, t)}
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
