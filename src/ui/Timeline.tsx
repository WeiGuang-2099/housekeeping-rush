/**
 * 时间轴（docs/DESIGN.md 的"主界面的四个部件"）：开工到 17:00 的一条横线，指针是现在。画什么由 timelineModel.ts 算出，
 * 这里只管画：横向位置按轴上的百分比放；字用 HTML 写，窄屏上也不缩小。文字一律从语言包取。
 *
 * 从上到下：指针上方的"现在"；时限小旗的字（可能分几行）；轴（浅色带、14:30 的线、刻度、休息过的那一段、小点、指针）；
 * 刻度的钟点；最下一行是说明：还没休息时 10:30 下面写"可以休息"、14:30 下面写"只能休息"，休息过了在那一段下面写"休息"。
 * 动作预览时指针前方的虚影是"动作预览和确认"那一项的事。
 */

import { Fragment } from 'react';
import { useText } from '../content';
import { toClock, type Minute } from '../engine';
import { FlagIcon } from './icons';
import type { ScreenProps } from './shift';
import { percentOf, timelineModel, type TickRole } from './timelineModel';

/** 竖直方向的布局（像素）：每一行的高度，以及最下面一行旗字和轴之间的空隙。 */
const NOW_ROW = 24;
const LANE = 20;
const AXIS_GAP = 14;
const TICK_ROW = 20;
const NOTE_ROW = 20;

/** "现在"那行字离轴的两端不到这个百分比时，靠这一端对齐，不居中，免得伸出时间轴。 */
const EDGE = 10;

export function Timeline({ view, params }: ScreenProps) {
  const t = useText();
  const model = timelineModel(view, params);
  const lanes = Math.max(model.lanes, 1);
  const axisY = NOW_ROW + lanes * LANE + AXIS_GAP;
  const tickY = axisY + 8;
  const noteY = tickY + TICK_ROW;
  const at = (minute: Minute): string => `${percentOf(minute, model.end)}%`;
  const width = (from: Minute, to: Minute): string => `${percentOf(to, model.end) - percentOf(from, model.end)}%`;
  const nowPercent = percentOf(model.now, model.end);
  const nowAlign = nowPercent < EDGE ? 'start' : nowPercent > 100 - EDGE ? 'end' : 'center';

  // 还没休息时，10:30 和 14:30 两个刻度下面的说明。
  const notes: Partial<Record<TickRole, string>> = {};
  if (model.breakWindow !== null) notes.breakEarliest = t.timeline.breakWindow;
  if (model.breakLatest !== null) notes.breakLatest = t.timeline.breakLatest;

  return (
    <section className="timeline" aria-label={t.timeline.label}>
      <div className="tl-track" style={{ height: noteY + NOTE_ROW }}>
        {model.breakWindow !== null && (
          <div
            className="tl-band"
            style={{ left: at(model.breakWindow.from), width: width(model.breakWindow.from, model.breakWindow.to), top: axisY - 7 }}
          />
        )}
        {model.breakLatest !== null && <div className="tl-latest" style={{ left: at(model.breakLatest), top: axisY - 12 }} />}

        <div className="tl-axis" style={{ top: axisY }} />
        {model.hours.map((minute) => (
          <div key={minute} className="tl-hour" style={{ left: at(minute), top: axisY - 3 }} />
        ))}
        {model.ticks.map((tick) => (
          <Fragment key={tick.role}>
            <div className="tl-tick" data-role={tick.role} style={{ left: at(tick.at), top: axisY - 6 }} />
            <span className="tl-tick-label mono" style={{ left: at(tick.at), top: tickY }}>
              {toClock(tick.at)}
            </span>
            {notes[tick.role] !== undefined && (
              <span className="tl-note" data-role={tick.role} style={{ left: at(tick.at), top: noteY }}>
                {notes[tick.role]}
              </span>
            )}
          </Fragment>
        ))}

        {model.breakTaken !== null && (
          <>
            <div
              className="tl-break"
              style={{ left: at(model.breakTaken.from), width: width(model.breakTaken.from, model.breakTaken.to), top: axisY - 4 }}
            />
            <span
              className="tl-note"
              data-role="breakTaken"
              style={{ left: at((model.breakTaken.from + model.breakTaken.to) / 2), top: noteY }}
            >
              {t.timeline.breakTaken}
            </span>
          </>
        )}

        {model.flags.map((flag) => {
          const top = NOW_ROW + (lanes - 1 - flag.lane) * LANE;
          const poleTop = top + LANE - 4;
          const title =
            flag.kind === 'vip'
              ? t.timeline.vipTitle(flag.room, toClock(flag.at), flag.overdue)
              : t.timeline.rushTitle(flag.room, toClock(flag.at), flag.overdue);
          const state = `${flag.done ? ' is-done' : ''}${flag.overdue ? ' is-overdue' : ''}`;
          return (
            <Fragment key={`${flag.kind}-${flag.room}`}>
              <div className={`tl-pole${state}`} style={{ left: at(flag.at), top: poleTop, height: axisY - poleTop }} />
              <span
                className={`tl-flag${state}`}
                data-room={flag.room}
                data-kind={flag.kind}
                data-lane={flag.lane}
                title={title}
                style={{ left: at(flag.at), top }}
              >
                <FlagIcon />
                <span className="mono">{flag.room}</span>
                <span className="tl-flag-word">{flag.kind === 'vip' ? t.timeline.vip : t.timeline.rush}</span>
              </span>
            </Fragment>
          );
        })}

        {model.comeBacks.map((comeBack) => (
          <span
            key={comeBack.room}
            className="tl-dot"
            data-room={comeBack.room}
            title={t.timeline.comeBackTitle(comeBack.room, toClock(comeBack.at))}
            style={{ left: at(comeBack.at), top: axisY - 4 }}
          />
        ))}

        <div className="tl-now" style={{ left: at(model.now), top: NOW_ROW - 4, height: axisY - NOW_ROW + 10 }} />
        <div className="tl-now-dot" style={{ left: at(model.now), top: axisY - 5 }} />
        <span className={`tl-now-label is-${nowAlign}`} style={{ left: at(model.now), top: 0 }}>
          {t.timeline.now(toClock(model.now))}
        </span>
      </div>
    </section>
  );
}
