# Housekeeping Rush

A short decision game about one hotel housekeeping shift. You plan the shift with incomplete information, then compare your route with three algorithmic "ghosts" that worked the same floor.

| Ghost | What it knows | How it decides |
| --- | --- | --- |
| Novice | The same as you | Greedy: walks to the nearest room that looks available |
| Veteran | The same as you | Samples possible worlds and rolls each option forward |
| Oracle | Every hidden fact | Searches with full information; the gap to it is your regret |

No reflexes are involved. You and the ghosts choose from the same set of actions: which room to service next, when to restock the linen cart, when to take the break, and when to phone the supervisor for an update.

## Status

Project scaffold only. The engine types, the tuning parameters and a few utilities are in place; the rules, the ghosts and the interface are not implemented yet. See `docs/TASKS.md`.

## Getting started

```
npm install
npm run dev
npm test
npm run build
```

Requires Node 20 or newer.

## Documents

- `docs/DESIGN.md`: the full design (in Chinese)
- `docs/TASKS.md`: the task list by phase
- `prototype/`: a rough Python prototype used to sanity check the numbers

The hotel, its guests and its floor plan are fictional.
