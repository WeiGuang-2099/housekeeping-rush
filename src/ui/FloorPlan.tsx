/**
 * 平面图（docs/DESIGN.md 的"主界面的四个部件"）：两层走廊上下叠放，左端是电梯和服务间。房间是方块，里面是房号、
 * 房型简称和一条说明（回来时间、时限或线索，见 rooms.ts），颜色和图标表示状态；你是一个实心圆点。
 * 位置由 floorGeometry.ts 按 params 的楼层平面算出，状态和说明由 rooms.ts 按 View 推出，文字一律从语言包取。
 *
 * 点房间就预览去那间房打扫（核心循环的第 2 步）。能不能点按 preview.ts 的 canPick：只剩一种动作能做时、做完的房间不能点；
 * 别的房间不合法也能点，预览里写原因。预览中的目标描成强调色（线框图的"预览中的目标"）；预览合法、要走路时，
 * 从你的圆点沿走廊画一条虚线到目标（walkPath 经过的门位，跨层时经过电梯）。
 */

import type { KeyboardEvent } from 'react';
import { useText, type UiText } from '../content';
import { recall, walkPath, type Action, type RoomId } from '../engine';
import { roomSummary, tagText } from './format';
import { floorGeometry, placePoint, type Box, type RoomBox } from './floorGeometry';
import { GLYPH_SIZE, StatusGlyph, StatusIcon } from './icons';
import { canPick, planTarget, type Preview } from './preview';
import { roomInfos, roomTag, type RoomInfo, type RoomStatus } from './rooms';
import type { ScreenProps } from './shift';

/** 房间方块里的排版（SVG 用户单位）：字离方块左边的距离，房号和第二行的基线，状态图标的大小和离右上角的距离。 */
const TEXT_INSET = 12;
const ID_BASELINE = 28;
const TAG_BASELINE = 51;
const ICON_SIZE = 20;
const ICON_INSET = 8;
/** 圆点的半径，以及"你"字离圆点的距离。 */
const DOT_RADIUS = 8;
const DOT_LABEL_GAP = 6;

/** 图例里列的状态，看起来能进的不列。 */
const LEGEND: readonly Exclude<RoomStatus, 'open'>[] = ['done', 'locked', 'later'];

export interface FloorPlanProps extends ScreenProps {
  /** 正在预览的动作；没有为 null。 */
  readonly preview?: Preview | null;
  /** 点房间时预览去那间房打扫；不给就不能点。 */
  readonly onSelect?: (action: Action) => void;
}

export function FloorPlan({ view, params, preview = null, onSelect }: FloorPlanProps) {
  const t = useText();
  const geometry = floorGeometry(params);
  const infos = new Map(roomInfos(view, params, recall(view, params)).map((info) => [info.room.id, info]));
  const you = placePoint(geometry, view.place);
  const service = geometry.servicePoint;
  const liftLabel = tallest(geometry.lift);
  const target = preview?.action.type === 'service' ? preview.action.room : null;
  const destination = preview?.ok === true ? planTarget(preview.plan, view, params) : null;
  const path =
    destination === null
      ? []
      : walkPath(view.place, destination, params).map((step) => placePoint(geometry, step.place));

  return (
    <figure className="floor-plan">
      <div className="fp-scroll">
        <svg
          className="fp-svg"
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          role="group"
          aria-label={t.floorPlan.label}
        >
          {geometry.floors.map((band) => (
            <g key={band.floor}>
              <text className="fp-floor" x={band.label.x} y={band.label.y}>
                {t.floorPlan.floor(band.floor)}
              </text>
              <line
                className="fp-corridor"
                x1={band.corridor.from.x}
                y1={band.corridor.from.y}
                x2={band.corridor.to.x}
                y2={band.corridor.to.y}
              />
            </g>
          ))}

          {geometry.lift.map((segment) => (
            <rect key={segment.y} className="fp-lift" x={segment.x} y={segment.y} width={segment.width} height={segment.height} rx={6} />
          ))}
          {liftLabel !== null && (
            <text className="fp-lift-label" x={liftLabel.x + liftLabel.width / 2} y={liftLabel.y + liftLabel.height / 2}>
              {t.floorPlan.lift}
            </text>
          )}
          <rect className="fp-service" x={service.x} y={service.y} width={service.width} height={service.height} rx={6} />
          <text className="fp-service-label" x={service.x + service.width / 2} y={service.y + service.height / 2}>
            {t.floorPlan.servicePoint}
          </text>

          {geometry.rooms.map((box) => {
            const pick: Action = { type: 'service', room: box.id };
            return (
              <RoomBlock
                key={box.id}
                box={box}
                info={infoOf(infos, box.id)}
                t={t}
                selected={box.id === target}
                onPick={onSelect !== undefined && canPick(view, params, pick) ? () => onSelect(pick) : null}
              />
            );
          })}

          {path.length > 1 && (
            <polyline className="fp-path" points={path.map((point) => `${point.x},${point.y}`).join(' ')} />
          )}

          <g className="fp-you">
            <circle cx={you.x} cy={you.y} r={DOT_RADIUS} />
            <text x={you.x + DOT_RADIUS + DOT_LABEL_GAP} y={you.y}>
              {t.floorPlan.you}
            </text>
          </g>
        </svg>
      </div>
      <figcaption className="fp-legend">
        {LEGEND.map((status) => (
          <span key={status} className={`fp-legend-item is-${status}`}>
            <span className="fp-swatch">
              <StatusIcon status={status} />
            </span>
            {t.floorPlan.legend[status]}
          </span>
        ))}
        <span className="fp-legend-item is-target">
          <span className="fp-swatch" />
          {t.floorPlan.target}
        </span>
      </figcaption>
    </figure>
  );
}

interface RoomBlockProps {
  readonly box: RoomBox;
  readonly info: RoomInfo;
  readonly t: UiText;
  /** 是不是预览中的目标。 */
  readonly selected: boolean;
  /** 点了以后预览去这间房打扫；不能点时为 null。 */
  readonly onPick: (() => void) | null;
}

/** 一间房的方块：房号、状态图标、房型简称加一条说明，提示文字是这间房的完整说明。能点时是一个按钮。 */
function RoomBlock({ box, info, t, selected, onPick }: RoomBlockProps) {
  const { room, status } = info;
  const button =
    onPick === null
      ? {}
      : {
          role: 'button',
          tabIndex: 0,
          'aria-label': t.floorPlan.pick(room.id),
          'aria-pressed': selected,
          onClick: onPick,
          onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onPick();
            }
          },
        };
  return (
    <g
      className={`fp-room is-${status}${selected ? ' is-selected' : ''}${onPick === null ? '' : ' is-pickable'}`}
      data-room={room.id}
      data-status={status}
      {...button}
    >
      <title>{roomSummary(info, t)}</title>
      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={6} />
      <text className="fp-room-id" x={box.x + TEXT_INSET} y={box.y + ID_BASELINE}>
        {room.id}
      </text>
      {status !== 'open' && (
        <g
          className="fp-room-icon"
          transform={`translate(${box.x + box.width - ICON_INSET - ICON_SIZE} ${box.y + ICON_INSET}) scale(${ICON_SIZE / GLYPH_SIZE})`}
        >
          <StatusGlyph status={status} />
        </g>
      )}
      <text className="fp-room-tag" x={box.x + TEXT_INSET} y={box.y + TAG_BASELINE}>
        <tspan className="fp-room-kind">{t.kindShort[room.kind]}</tspan>
        <tspan dx={6}>{tagText(roomTag(info), t)}</tspan>
      </text>
    </g>
  );
}

function infoOf(infos: ReadonlyMap<RoomId, RoomInfo>, id: RoomId): RoomInfo {
  const info = infos.get(id);
  if (info === undefined) throw new Error(`平面图：View 里没有房间 ${id}，View 和 params 的楼层对不上`);
  return info;
}

/** 最高的一段电梯，"电梯"两个字写在它正中；一段都没有时为 null。 */
function tallest(segments: readonly Box[]): Box | null {
  return segments.reduce<Box | null>((best, segment) => (best === null || segment.height > best.height ? segment : best), null);
}
