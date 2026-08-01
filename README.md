# Black Diamond Brawl

A Road Rash-style downhill snowboarding combat racer, built as a solo learning project.

Each run is a single race down a fixed-length, seeded procedurally generated slope that
ends at a finish line. Dodge trees, rocks, and moguls, catch trick air off moguls and
hill crests (crests launch you automatically at speed), and shove (or ski-pole) your way
past a handful of AI rivals racing the same course. Score comes from finishing the course
fast, landing hits on rivals, near-misses, and tricks — wipe out hard before the line and
the run ends early.

Built with Phaser 3 + TypeScript + Vite, using a classic segment-based pseudo-3D renderer
for the behind-the-rider "road rushing at you" look (OutRun/Road Rash style), with pixel
art sprites for riders, obstacles, and pickups.

## Docs

- [Design spec](docs/design-spec.md)
- [Implementation plan](docs/implementation-plan.md)
- [Task list](docs/tasks.md)

## Controls

| Key | Action |
| --- | --- |
| `←` / `A`, `→` / `D` | Shift one lane |
| `Space` / `↑` | Jump |
| `F` / `K` | Attack the marked rival |

An amber chevron marks the rival an attack would hit; it is visible exactly when a press
would land. Attacking locks steering and jump for 250 ms — that commitment is the cost.
Riding into someone still body-checks them, for a fifth of the points.

## Development

```bash
npm install
npm run dev        # play at http://localhost:5173
npm run dev        # then open /?spritelab=1 for the sprite contact sheet
npm run verify     # the gate: build + palette + combat + solvability + visual smoke test
npm run lab        # render the sprite sheet headless and check outline contrast

npm run verify:combat      # headless seeded combat sim — no browser needed
npm run measure:rocklock   # rock-tumble steering lock vs the solvability model
```

All art and atmosphere is **generated in code at boot** — there are no image
files in this repository. Colour is governed by `src/render/palette.ts` and
enforced by `npm run verify:palette`, which fails the build if any
gameplay-relevant edge drops below ΔL* 12 or any sprite outline below ΔL* 25
against the snow behind it.

## Status

v1 complete (all 9 phases). v2 visual overhaul complete: projection fixes,
palette system, atmospheric depth, redrawn sprites, contact shadows, impact
feedback and styled screens. See issue #12 for the plan and what is
deliberately deferred.
