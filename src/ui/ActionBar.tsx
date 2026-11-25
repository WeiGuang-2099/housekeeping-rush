/**
 * 动作栏：动作预览和五个动作按钮（docs/DESIGN.md 核心循环的第 2 步和"动作预览"）。贴在屏幕底部（index.css），
 * 任务单再长、在手机上看平面图时也看得见。打扫是点平面图上的房间或任务单上的房号，这里是补货、打给主管、休息、等待、收工还车。
 *
 * 点了先预览：标题和几句代价（format.ts 的 planLines），等待还能选 1 到上限之间的分钟数（硬约束 11）。
 * 合法才能确认；确认后不能撤销，确认之前可以取消或者换一个（docs/DESIGN.md 的"撤销"）。不合法的写出原因（illegalText）。
 * 只剩一种动作能做时（17:00 以后、14:30 起还没休息、班次结束），别的按钮不能点（preview.ts 的 canPick），
 * 没选动作时把这条原因写在预览的位置上。文字一律从语言包取。
 */

import { useText } from '../content';
import { toClock, type Action } from '../engine';
import { actionTitle, illegalText, planLines } from './format';
import { BUTTONS, buttonAction, canPick, globalReason, waitLimit, type Preview } from './preview';
import type { ScreenProps } from './shift';

export interface ActionBarProps extends ScreenProps {
  /** 正在预览的动作和它的预览；没有为 null。 */
  readonly preview: Preview | null;
  readonly onSelect: (action: Action) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ActionBar({ view, params, preview, onSelect, onCancel, onConfirm }: ActionBarProps) {
  const t = useText();
  const limit = waitLimit(view, params);
  const selectedType = preview?.action.type ?? null;

  return (
    <section className="action-bar" aria-label={t.actions.label}>
      <div className="ab-preview" aria-live="polite" aria-label={t.preview.label}>
        {preview === null ? (
          <p className="ab-hint">{idleText(view, params, t)}</p>
        ) : (
          <>
            <div className="ab-head">
              <h2 className="ab-title">{actionTitle(preview.action, t)}</h2>
              <div className="ab-decide">
                <button type="button" className="ab-cancel" onClick={onCancel}>
                  {t.preview.cancel}
                </button>
                <button type="button" className="ab-confirm" disabled={!preview.ok} onClick={onConfirm}>
                  {t.preview.confirm}
                </button>
              </div>
            </div>
            {preview.ok ? (
              <ul className="ab-lines">
                {planLines(preview.plan, view, params, t).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="ab-cannot">
                {t.preview.cannot}
                {illegalText(preview.reason, t)}
              </p>
            )}
            {preview.action.type === 'wait' && limit !== null && (
              <div className="ab-wait" role="group" aria-label={t.preview.waitPick}>
                <span className="ab-wait-label">{t.preview.waitPick}</span>
                {Array.from({ length: limit }, (_, index) => index + 1).map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="ab-wait-option mono"
                    aria-pressed={preview.action.type === 'wait' && preview.action.minutes === minutes}
                    onClick={() => onSelect({ type: 'wait', minutes })}
                  >
                    {minutes}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="ab-buttons">
        {BUTTONS.map((type) => {
          const action = buttonAction(type, view, params);
          return (
            <button
              key={type}
              type="button"
              className="ab-button"
              data-action={type}
              disabled={!canPick(view, params, action)}
              aria-pressed={selectedType === type}
              onClick={() => onSelect(action)}
            >
              {t.actions[type]}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 没选动作时预览位置上的字：班次结束了写几点还完车；只剩一种动作能做时写原因；平常是提示。 */
function idleText(view: ScreenProps['view'], params: ScreenProps['params'], t: ReturnType<typeof useText>): string {
  if (view.ended !== null) return t.preview.ended(toClock(view.minute));
  const reason = globalReason(view, params);
  return reason === null ? t.preview.hint : illegalText(reason, t);
}
