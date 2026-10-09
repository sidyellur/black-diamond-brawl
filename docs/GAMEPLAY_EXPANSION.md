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
- `expansionAcceptance.mjs`: real keyboard practice lessons, ghost capture/finish integration,
  split comparison, reload and actual themed screenshots
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

PR #30 contains the shared combat/rival/mountain slice. The following integrated PR contains
all five playable experiences and the README. Exact final CI runs and artifact references are
recorded after browser/native validation; do not interpret this planning note as a test result.
