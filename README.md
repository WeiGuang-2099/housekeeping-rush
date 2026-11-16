# Housekeeping Rush

A short decision game about one hotel housekeeping shift. You plan the shift with incomplete information, then compare your route with three algorithmic "ghosts" that worked the same floor.

| Ghost | What it knows | How it decides |
| --- | --- | --- |
| Novice | The same as you | Greedy: walks to the nearest room that looks available |
| Veteran | The same as you | Samples possible worlds and rolls each option forward |
| Oracle | Every hidden fact | Searches with full information; the gap to it is your regret |

No reflexes are involved. You and the ghosts choose from the same set of actions: which room to service next, when to restock the linen cart, when to take the break, and when to phone the supervisor for an update.

## Status

The engine is partly built: the types, the tuning parameters, seeded world generation, the core shift rules, the player's view and scoring are in place, and so is the first ghost, the greedy novice. Events during the shift, the other two ghosts and the interface are not implemented yet.

## Getting started

```
npm install
npm run dev
npm test
npm run build
```

Requires Node 22.12 or newer.

## Prototype

`prototype/` holds a rough Python prototype used to sanity check the numbers.

The hotel, its guests and its floor plan are fictional.
