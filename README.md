# Black Diamond Brawl

A Road Rash-style downhill snowboarding combat racer, built as a solo learning project.

Each run is a single race down a fixed-length, seeded procedurally generated slope that
ends at a finish line. Dodge trees, rocks, and moguls, catch trick air off moguls and
hill crests (crests launch you automatically at speed), and shove (or ski-pole) your way
past a handful of AI rivals racing the same course. Score comes from finishing the course
fast, landing hits on rivals, near-misses, and tricks — wipe out hard before the line and
the run ends early.

Built with Phaser 3 + TypeScript + Vite, using a classic segment-based pseudo-3D renderer
for the behind-the-rider "road rushing at you" look (OutRun/Road Rash style), with high-resolution illustrated riders,
obstacles, and pickups, and layered alpine scenery.

## Docs

- [Design spec](docs/design-spec.md)
- [Implementation plan](docs/implementation-plan.md)
- [Task list](docs/tasks.md)

## Controls

| Key | Action |
| --- | --- |
| `←` / `A`, `→` / `D` | Carve one lane per tap; hold to keep carving |
| `Space` / `↑` / `W` | Jump; time a mogul for extended trick air |
| `F` / `K` | Attack the amber-marked rival |
| `Esc` / `P` | Pause / resume |
| `M` | Toggle sound |
| `R` while paused | Retry this mountain |

Touch controls appear on touch devices (or with `?touch=1`). Landscape orientation
provides the largest controls. All menus also work with a mouse or touch.

An amber chevron marks the rival an attack would hit. Attacking locks steering and
jump for 250 ms, so pick a clear line before committing. Higher speed wins an unarmed
exchange; a ski pole wins a deliberate attack and has three charges. Riding into a
rival still body-checks them, for a fifth of the points.

## Chase your best run

- A short countdown gives you time to get ready. Leaving the tab pauses the race;
  resume when you're ready. Paused time never reduces your time bonus.
- Chain clean hits, close calls, and trick landings within 4.2 seconds to build Flow.
  Every four events increases the bonus by 25%, capped at +50%. Damage breaks the chain.
- Your personal best, plus scores/fastest finishes for the last 64 mountains, are saved
  in this browser. Storage failures never prevent playing; there is no account or upload.
- Replay the same seed to master a line, or choose a new mountain. A shared `?seed=42`
  link gives everyone the same course geometry.
- Original procedural sounds are generated locally and can be muted with `M`.

## Development

```bash
npm install
npm run dev        # play at http://localhost:5173
npm run dev        # then open /?spritelab=1 for the sprite contact sheet
npm run verify     # build + models + storage + browser/controls/replay/touch acceptance
npm run lab        # render the sprite sheet headless and check outline contrast

npm run verify:controls    # keyboard/touch state-machine regressions
npm run verify:combat      # headless seeded combat sim — no browser needed
npm run measure:rocklock   # rock-tumble steering lock vs the solvability model
```

All art, atmosphere, and sound are **original and generated locally**. No external
asset downloads, font services, or sound files are required. Colour is governed by `src/render/palette.ts` and
enforced by `npm run verify:palette`, which fails the build if any
gameplay-relevant edge drops below ΔL* 12 or any sprite outline below ΔL* 25
against the snow behind it.

## Verification and status

GitHub Actions runs the complete verification gate on pull requests and main, including
real Chromium input/replay/touch flows against the production build. Screenshots,
reports, and the production `dist` build are uploaded as workflow artifacts.

For the implementation history, resolved issues, test evidence, and remaining
limitations, see [the overnight report](docs/OVERNIGHT_REPORT.md).

No public hosting deployment is configured in this repository. To play locally, use
`npm run dev`. To serve an existing production build, use `npm run preview` or
`python3 -m http.server 8000 --directory dist` and open the printed localhost URL.
