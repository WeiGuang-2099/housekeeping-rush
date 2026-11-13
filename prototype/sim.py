"""客房冲刺：数值可行性的粗略原型。

用途：在写正式引擎之前，确认 docs/DESIGN.md 里的初始数值能让班次做得完，
并粗看三种策略之间有没有差距。正式的评测以 TypeScript 引擎的批量模拟器为准，
这个脚本只作参考，不要把它的数字写进 README。

运行：python sim.py            （每种配置 500 个随机班次）
      python sim.py 1000       （指定班次数）

时间单位是分钟，从 08:30 起算。位置是 (楼层序号, 门位)，服务间在 (0, 0)。

和设计文档相比，这里省略了：
  事件、请勿打扰房（直接不生成）、前台催房、17:00 强制下班。
三种策略也都是简化版：
  novice        贪心，去最近的看起来能进的房间，12:30 固定休息
  veteran       手写规则（看线索、看时限、没房可做时休息），不是设计里的采样推演
  oracle_greedy 已知全部隐藏信息的贪心，不是真正的最优解
"""

import math
import random
import statistics

INF = 10**9
CAP = 8
FLOORS = 1
LIFT = 4
N_DEADLINES = 2
LATE_GUESTS = 0
def dist(a, b):
    return abs(a[1] - b[1]) if a[0] == b[0] else a[1] + b[1] + LIFT
HOME = (0, 0)
WALK = 1          # min per position step
RESTOCK = 5
CALL = 2
KNOCK = 1
BREAK_LEN = 30
BREAK_LO, BREAK_HI = 120, 360   # break must start within [10:30, 14:30]
SHIFT_END = 450                 # 16:00
RETURN_CART = 5
MULTS = (0.8, 1.0, 1.6)
STAY_CLUES = {  # p_in_at_start, leave range, mess probs
 'biz':    (0.30, (0, 60),    (0.5, 0.4, 0.1)),
 'tour':   (0.70, (15, 150),  (0.25, 0.5, 0.25)),
 'family': (0.85, (45, 180),  (0.1, 0.4, 0.5)),
 'long':   (0.90, (150, 270), (0.3, 0.6, 0.1)),
}
DEP_CLUES = {
 'one_night': (0.4, 0.5, 0.1),
 'long_stay': (0.15, 0.5, 0.35),
 'party':     (0.05, 0.35, 0.6),
}
def gen(seed, n_dep=6, n_stay=7, n_dnd=2):
    r = random.Random(seed)
    nums = list(range(1, 16)); r.shuffle(nums)
    rooms = []
    for i, n in enumerate(nums):
        fl = (n - 1) * FLOORS // 15
        k = n - 1 - (0 if fl == 0 else (15 + FLOORS - 1) // FLOORS)
        pos = (fl, k // 2 + 1)
        if i < n_dep:
            clue = r.choices(list(DEP_CLUES), weights=[5, 3, 2])[0]
            mult = r.choices(MULTS, weights=DEP_CLUES[clue])[0]
            u = r.random()
            late = False
            if u < 0.2: co = -1
            elif u < 0.7: co = r.uniform(0, 120)
            elif u < 0.9: co = r.uniform(120, 150)
            else: co = 210; late = True          # late checkout 12:00, printed on sheet
            rooms.append(dict(n=n, pos=pos, kind='dep', clue=clue, base=30, linen=2, mult=mult,
                              avail=co, late=late, flagged=False, known=None, done=False, deadline=None))
        elif i < n_dep + n_stay:
            clue = r.choices(list(STAY_CLUES), weights=[3, 3, 2, 1])[0]
            p_in, (lo, hi), mp = STAY_CLUES[clue]
            mult = r.choices(MULTS, weights=mp)[0]
            leave = r.uniform(lo + LATE_GUESTS, hi + LATE_GUESTS) if r.random() < min(1, p_in + LATE_GUESTS / 200) else -1
            rooms.append(dict(n=n, pos=pos, kind='stay', clue=clue, base=15, linen=1, mult=mult,
                              avail=leave, late=False, flagged=True, known=None, done=False, deadline=None))
    deps = [x for x in rooms if x['kind'] == 'dep' and not x['late']]
    r.shuffle(deps)
    for d, dl in zip(deps, [270, 330, 300][:N_DEADLINES]):
        d['deadline'] = dl
    return rooms

class Sim:
    def __init__(s, rooms):
        s.rooms = rooms; s.t = 0.0; s.pos = HOME; s.cart = CAP; s.break_done = False
        s.walked = 0; s.failed_knocks = 0; s.calls = 0; s.restocks = 0; s.waited = 0; s.last_call = -INF
        s.late_deadlines = 0
    def walk(s, p):
        d = dist(s.pos, p) * WALK; s.t += d; s.walked += d; s.pos = p
    def todo(s): return [x for x in s.rooms if not x['done']]
    def call(s):
        s.t += CALL; s.calls += 1; s.last_call = s.t
        for x in s.rooms:
            if x['kind'] == 'dep' and x['avail'] <= s.t: x['flagged'] = True
    def restock(s):
        s.walk(HOME); s.t += RESTOCK; s.cart = CAP; s.restocks += 1
    def take_break(s):
        s.walk(HOME); s.t += BREAK_LEN; s.break_done = True
    def wait(s, dt): s.t += dt; s.waited += dt
    def service(s, x):
        assert x['flagged'] and s.cart >= x['linen']
        s.walk(x['pos'])
        if x['kind'] == 'stay' and s.t < x['avail']:
            s.t += KNOCK; s.failed_knocks += 1
            x['known'] = math.ceil(x['avail'] / 15) * 15     # guest tells a come-back time
            return False
        s.t += x['base'] * x['mult']; s.cart -= x['linen']; x['done'] = True
        if x['deadline'] is not None and s.t > x['deadline']: s.late_deadlines += 1
        return True
    def finish(s):
        s.walk(HOME); s.t += RETURN_CART
        s.raw = s.t
        return s.t + 30 * s.late_deadlines

def believed(s, x):   # visible info only
    if x['kind'] == 'dep': return x['flagged']
    return x['known'] is None or x['known'] <= s.t

def novice(s):
    while s.todo():
        if not s.break_done and s.t >= 240:           # fixed lunch at 12:30
            s.take_break(); continue
        cands = [x for x in s.todo() if believed(s, x)]
        if not cands:
            if s.t - s.last_call >= 15: s.call()
            else: s.wait(5)
            continue
        x = min(cands, key=lambda x: (dist(x['pos'], s.pos), x['n']))
        if s.cart < x['linen']: s.restock(); continue
        s.service(x)
    if not s.break_done: s.take_break()
    return s.finish()

P_OUT = {'biz': lambda t: 0.7 + 0.3 * min(1, t / 60),
         'tour': lambda t: 0.3 + 0.7 * min(1, max(0, (t - 15) / 135)),
         'family': lambda t: 0.15 + 0.85 * min(1, max(0, (t - 45) / 135)),
         'long': lambda t: 0.1 + 0.9 * min(1, max(0, (t - 150) / 120))}
EXP_MULT = lambda probs: sum(m * p for m, p in zip(MULTS, probs))

def veteran(s):
    while s.todo():
        todo = s.todo()
        unflagged = [x for x in todo if x['kind'] == 'dep' and not x['flagged']]
        cands = [x for x in todo if believed(s, x)]
        need = sum(x['linen'] for x in todo)
        # score = expected minutes spent per useful minute, with deadline urgency
        def score(x):
            d = dist(x['pos'], s.pos) * WALK
            if x['kind'] == 'stay':
                p = 1.0 if x['known'] is not None else P_OUT[x['clue']](s.t + d)
                dur = 15 * EXP_MULT(STAY_CLUES[x['clue']][2])
            else:
                p = 1.0; dur = 30 * EXP_MULT(DEP_CLUES[x['clue']])
            cost = d + (1 - p) * KNOCK * 6            # a failed knock also wastes the walk
            urgency = 0
            if x['deadline'] is not None:
                slack = x['deadline'] - (s.t + d + dur)
                urgency = 40 if slack < 60 else (15 if slack < 120 else 0)
            return cost - urgency + (0 if p > 0.6 else 25)
        blocked = not cands or min(score(x) for x in cands) > 20
        # take the break when blocked, or when at the service point anyway
        if not s.break_done and s.t >= BREAK_LO - dist(s.pos, HOME) and (blocked or s.t >= BREAK_HI - 40):
            if s.t + dist(s.pos, HOME) < BREAK_LO: s.wait(BREAK_LO - s.t - dist(s.pos, HOME))
            s.take_break()
            if s.cart < min(CAP, need): s.t += RESTOCK; s.cart = CAP; s.restocks += 1
            continue
        if unflagged and s.t - s.last_call >= 30 and (blocked or any(x['deadline'] for x in unflagged)):
            s.call(); continue
        if not cands:
            if unflagged and s.t - s.last_call >= 15: s.call()
            else: s.wait(5)
            continue
        x = min(cands, key=score)
        if s.cart < x['linen'] or (dist(s.pos, HOME) <= 1 and s.cart < min(4, need)):
            s.restock(); continue
        s.service(x)
    if not s.break_done:
        if s.t + dist(s.pos, HOME) < BREAK_LO: s.wait(BREAK_LO - s.t - dist(s.pos, HOME))
        s.take_break()
    return s.finish()

def oracle_greedy(s):
    """full information, greedy with deadline awareness: a LOWER-QUALITY stand-in for the true optimum"""
    while s.todo():
        todo = s.todo(); need = sum(x['linen'] for x in todo)
        def ready(x): return max(x['avail'], 0)
        def score(x):
            d = dist(x['pos'], s.pos) * WALK
            start = max(s.t + d, ready(x)) + (CALL if not x['flagged'] else 0)
            dur = x['base'] * x['mult']
            urgency = 0
            if x['deadline'] is not None:
                slack = x['deadline'] - (start + dur)
                urgency = 60 if slack < 45 else (20 if slack < 100 else 0)
            return (start - s.t) - urgency
        x = min(todo, key=score)
        gap = max(0, ready(x) - (s.t + dist(x['pos'], s.pos)))
        if not s.break_done and s.t + dist(s.pos, HOME) >= BREAK_LO and (gap >= 15 or s.t >= BREAK_HI - 40):
            s.take_break()
            if s.cart < min(CAP, need): s.t += RESTOCK; s.cart = CAP; s.restocks += 1
            continue
        if s.cart < x['linen'] or (dist(s.pos, HOME) <= 1 and s.cart < min(4, need)):
            s.restock(); continue
        if gap > 0:
            s.wait(min(gap, 5)); continue
        if not x['flagged']:
            s.walk(x['pos'])
            if s.t < x['avail']: s.wait(x['avail'] - s.t)
            s.call()
        s.service(x)
    if not s.break_done:
        if s.t + dist(s.pos, HOME) < BREAK_LO: s.wait(BREAK_LO - s.t - dist(s.pos, HOME))
        s.take_break()
    return s.finish()

def fmt(m):
    m = int(round(m)) + 8 * 60 + 30
    return f"{m // 60:02d}:{m % 60:02d}"

def run(N=1000, **kw):
    import copy
    res = {k: [] for k in ('novice', 'veteran', 'oracle')}
    stats = {k: [] for k in res}
    for seed in range(N):
        base = gen(seed, **kw)
        for name, pol in (('novice', novice), ('veteran', veteran), ('oracle', oracle_greedy)):
            s = Sim(copy.deepcopy(base)); res[name].append(pol(s)); stats[name].append(s)
    for k in res:
        v = sorted(res[k]); ss = stats[k]
        print(f"{k:8s} mean {fmt(statistics.mean(v))}  p10 {fmt(v[N // 10])}  p50 {fmt(v[N // 2])}  p90 {fmt(v[9 * N // 10])}"
              f"  over16:00 {sum(x > SHIFT_END for x in v) / N:.0%}"
              f"  raw {fmt(statistics.mean(x.raw for x in ss))}  walk {statistics.mean(x.walked for x in ss):.0f}  failKnock {statistics.mean(x.failed_knocks for x in ss):.1f}"
              f"  calls {statistics.mean(x.calls for x in ss):.1f}  restock {statistics.mean(x.restocks for x in ss):.1f}"
              f"  wait {statistics.mean(x.waited for x in ss):.0f}  lateVIP {statistics.mean(x.late_deadlines for x in ss):.2f}")
    d1 = [a - b for a, b in zip(res['novice'], res['veteran'])]
    d2 = [a - b for a, b in zip(res['veteran'], res['oracle'])]
    print(f"novice - veteran: mean {statistics.mean(d1):.1f} min, veteran wins {sum(x > 0 for x in d1) / N:.0%}")
    print(f"veteran - oracle: mean {statistics.mean(d2):.1f} min, oracle wins {sum(x > 0 for x in d2) / N:.0%}")

VARIANTS = [
    ("单层走廊，布草车 8 份，2 个贵宾", dict(FLOORS=1, CAP=8, N_DEADLINES=2, LATE_GUESTS=0)),
    ("两层楼，电梯 4 分钟（标准档）", dict(FLOORS=2, CAP=8, N_DEADLINES=2, LATE_GUESTS=0)),
    ("两层楼，布草车 6 份（紧档）", dict(FLOORS=2, CAP=6, N_DEADLINES=2, LATE_GUESTS=0)),
    ("紧档加第三个贵宾，客人晚出门 30 分钟（周末档）", dict(FLOORS=2, CAP=6, N_DEADLINES=3, LATE_GUESTS=30)),
]

if __name__ == '__main__':
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 500
    for name, settings in VARIANTS:
        globals().update(settings)
        print('==', name)
        run(n)
