# Gameplay expansion

## Reviewed scope

Each feature was scoped in its own issue before implementation:

1. [#25: skillful combat](https://github.com/sidyellur/black-diamond-brawl/issues/25): explicit attack phases, timed existing-input evades and target-specific counters.
2. [#26: rivals and practice](https://github.com/sidyellur/black-diamond-brawl/issues/26): distinct pursuit, line protection and jump-seeking decision models; three repeatable practical lessons.
3. [#27: mountains](https://github.com/sidyellur/black-diamond-brawl/issues/27): seeded forest/ridge/bowl sections, named setpieces, protected transitions and landing zones.
4. [#28: cup and cosmetics](https://github.com/sidyellur/black-diamond-brawl/issues/28): three persistent rounds, standings, medals, challenges and equipment with no economic system.
5. [#29: ghosts and daily challenges](https://github.com/sidyellur/black-diamond-brawl/issues/29): local best-run replay, checkpoint comparisons, UTC daily identity and shareable self-reported results.

The implementation order puts shared entity/generation contracts first, then integrates practice,
fixed-step orchestration, progression and user-facing flows. No new dependency, server or account is required.

## Important rules

### Combat

Wind-ups are 560–720ms depending on the opponent. A deliberate jump or steer within the final
280ms can earn a 1,100ms counter opportunity. A counter belongs to the attacker you evaded,
uses the existing Attack control, and expires on the simulation clock. Automatic crest launches
do not qualify as deliberate evades. Hits/tumbles interrupt pending strikes. Tree and road-edge
knockback constraints are unchanged.

### Championship

NOVA, SLATE, FROST and EMBER retain their identities across all three cup races and ordinary modes.
Every round is classified when the player's run ends: finishers by time, surviving riders by
progress, then wiped-out riders by progress. Wipeouts earn zero points. Ties in the championship
use points, wins, finished rounds, total finish time, then stable rider identity. A player who
finishes none of the three races cannot earn a medal. Finishing all three unlocks the Alpine
jacket; podium and gold have separate rewards. A round ID can score only once.

### Daily and ghost identity

UTC date, `fixed60-v2`, `mountain-v2` and seed determine the challenge. Historical/future shared
dates and explicit practice links retain the course but cannot change competitive records,
ghosts or rewards. Starting or retrying an old daily after midnight normalizes it to practice.
A race already underway retains its starting identity.

Ghosts contain bounded sampled poses, not inputs or a physics actor. They interpolate only for
rendering and compare checkpoint crossing times. They are not opponents, cannot affect RNG and
cannot validate a remote result. Successful faster finishes replace the local ghost; DNFs do not.

### Persistence

- Legacy v1 scores remain untouched; current score/time records use a distinct versioned key
- Career saves cup rounds, medals, known challenge rewards and selected board/jacket
- Result screens are read-only; finish commits happen once before transition
- Input validation rejects corrupt or incompatible data; storage failure leaves an in-memory fallback
- Ghost storage is bounded to eight courses and 2,400 samples per run, with compaction for long runs
- Sequential stale-tab writes merge earned rewards and stronger records; cup replacement/abandon uses generation stamps
- Truly simultaneous browser writes are not transactional and there is no cloud synchronization

## Test coverage

The aggregate `npm run verify` includes deterministic models, 1,000 themed generation checks,
1,000 independent solvability seeds, renderer/asset contrast, combat, controls, scoring, storage,
native lifecycle/audio and the following production-browser suites:

- Existing smoke, keyboard/touch/replay and mobile WebKit acceptance
- `expansionAcceptance.mjs`: real keyboard practice lessons, complete natural-course simulation with all
  hazards and four rivals retained, ghost capture/finish integration, rendered ghost/split, reload
  and actual themed screenshots (only the themed captures reposition the camera/player)
- `verifyMenus.mjs`: cup end-to-end menus using labelled finish fixtures, standings/idempotence,
  unlock/equip/persistence, daily links/share fallback, keyboard focus and phone routes

Model tests compare the production player/rival/combat state with identical tick inputs at
30/60/144Hz, independently of render randomness. Native XCTest verifies the installed bundled
WKWebView, actual safe areas, touch/lifecycle/audio, Preferences hydration/restart and the new
cup/daily/practice/locker routes. Physical signing/install and hardware performance remain in #24.

## Review fixes

Independent review found and fixed duplicate practice completion under batched ticks,
invisible pause controls beneath completion, stale-tab career overwrites, failed-write adapter
reconciliation, and daily retry across UTC midnight. These paths have targeted regressions.

## Verification evidence

- [PR #30](https://github.com/sidyellur/black-diamond-brawl/pull/30): shared combat/rival/mountain slice and safe-area input-origin correction
- [PR #31](https://github.com/sidyellur/black-diamond-brawl/pull/31): all five integrated playable experiences, native routes, persistence and this guide
- [Browser checks](https://github.com/sidyellur/black-diamond-brawl/actions/workflows/verify.yml) and [iPhone simulator checks](https://github.com/sidyellur/black-diamond-brawl/actions/workflows/ios.yml): match the run's head SHA to the commit being evaluated

The `game-verification-*` artifact contains model reports, keyboard/touch acceptance,
`expansion-natural-run.json`, `expansion-natural-replay.json`, `expansion-natural-cup.json`, a complete practice report,
rendered ghost/checkpoint captures, and forest/ridge/bowl screenshots. The natural driver
accelerates the production fixed-step simulation and sends legal player actions; it retains
all obstacles, pickups, crests, four opponents and colliders through a quick race and all three cup rounds. The real-keyboard practice suite
separately proves event handling. Camera-positioned terrain screenshots and cup finish fixtures
are labelled separately and are not substitutes for a normal-course finish.

The `iphone-simulator-*` artifact contains unsigned Release launch images, the native test log,
XCTest screenshots, and the simulator app. Native tests exercise actual WKWebView touch,
safe areas, lifecycle and persistent progress across process restart. Simulator success is not
physical-device or hardware-performance validation; see [#24](https://github.com/sidyellur/black-diamond-brawl/issues/24).

Final reviewed heads and verification run links are recorded in the PR conversations, including
any failed intermediate runs and the fixes that superseded them. Do not substitute an earlier
successful run for the checks on the final merged `main` commit.
