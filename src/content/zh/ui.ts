/**
 * 中文的界面文字。形状见 ../types.ts，组件经 useText()（../index.ts）取。
 * 钟点由界面用 clock.ts 换好再传进来。文案里不用破折号（CLAUDE.md 的约定）。
 */

import type { UiText } from '../types';

export const zhUi: UiText = {
  title: '客房冲刺',
  tier: { standard: '标准档', tight: '紧档', weekend: '周末档' },
  kind: { departure: '退房', stayover: '续住', dnd: '请勿打扰' },
  kindShort: { departure: '退', stayover: '续', dnd: '勿扰' },
  clue: {
    business: '商务',
    tourist: '游客',
    family: '家庭',
    longStay: '长住',
    oneNight: '住一晚',
    threeNightsPlus: '住三晚以上',
    partyOrFamily: '聚会或家庭',
  },
  clueShort: {
    business: '商务',
    tourist: '游客',
    family: '家庭',
    longStay: '长住',
    oneNight: '一晚',
    threeNightsPlus: '三晚+',
    partyOrFamily: '聚会',
  },
  mess: { tidy: '整洁', normal: '普通', disaster: '灾难' },

  timeline: {
    label: '时间轴',
    now: (clock) => `现在 ${clock}`,
    breakWindow: '可以休息',
    breakLatest: '只能休息',
    breakTaken: '休息',
    vip: '贵宾',
    rush: '催房',
    vipTitle: (room, clock, overdue) => `${room} 贵宾时限 ${clock}${overdue ? '，超时' : ''}`,
    rushTitle: (room, clock, overdue) => `${room} 催房时限 ${clock}${overdue ? '，超时' : ''}`,
    comeBackTitle: (room, clock) => `${room} 客人说 ${clock} 后可进`,
  },

  floorPlan: {
    label: '平面图',
    floor: (floor) => `${floor} 楼`,
    lift: '电梯',
    servicePoint: '服务间',
    you: '你',
    laterTag: (clock) => `${clock} 后`,
    vipTag: (clock) => `贵宾 ${clock}`,
    rushTag: (clock) => `催房 ${clock}`,
    legend: { done: '已完成', locked: '还不能进', later: '晚点再来' },
  },

  taskSheet: {
    title: '任务单',
    lastCall: (clock) => `最近一次打电话 ${clock}`,
    noCallYet: '还没打过电话',
    vip: (clock, overdue) => `贵宾 ${clock}${overdue ? ' 超时' : ''}`,
    rush: (clock, overdue) => `催房 ${clock}${overdue ? ' 超时' : ''}`,
    lateCheckout: '延迟退房',
    departed: '已退房',
    notDeparted: '还没报已退',
    comeBack: (clock) => `${clock} 后可进`,
    notKnocked: '还没敲过门',
    stillHung: (clock) => `${clock} 确认仍挂牌`,
    neverConfirmed: '还没确认过有没有摘牌',
    lifted: '已摘牌',
    mess: (mess, minutes) => `${mess} ${minutes} 分钟`,
    workDone: (done, total) => `已做 ${done}/${total} 分钟`,
    done: (clock) => `${clock} 完成`,
    summary: (room, kind, clue, facts) =>
      facts.length === 0 ? `${room} ${kind} ${clue}` : `${room} ${kind} ${clue}：${facts.join('，')}`,
  },

  cart: {
    title: '布草车',
    count: (left, capacity) => `${left}/${capacity}`,
    label: (left, capacity) => `布草车剩 ${left} 份，共 ${capacity} 格`,
  },
};
