# Black Diamond Brawl — Design Specification

## 1. Overview & Goal

Black Diamond Brawl is a Road Rash-style downhill snowboarding combat racer built for the
web. It is a **solo learning project**: the goal is for the developer to have fun and learn
game programming (in particular the classic segment-based pseudo-3D rendering technique),
not to ship to users or build a portfolio piece. Decisions below favor authenticity and
learning value over the shortest path to a demo.

**Core fantasy:** you are bombing down a snowy mountain from a behind-the-rider camera,
weaving through trees and rocks, catching air off moguls and crests, and trading shoves
with a handful of AI rival riders — all the way down to a finish line.

### Documented decision: from endless score-attack to race-with-finish-line

The original design was an endless, no-finish-line score-attack run (survive as long as
possible, score from distance). The developer has since decided v1 should have a **finish
line**. These two ideas are reconciled explicitly as follows — this is a deliberate design
decision, not a silent drift:

- Each "run" is a single race down a **fixed-length, procedurally generated course**. The
  course is generated from a seed, so a given seed always produces the same course
  (replayable/deterministic per seed).
- The procedural generation machinery from the endless design is kept, but it now generates
  segments **up to a fixed total course length** instead of forever, with difficulty
  (curve sharpness/frequency, obstacle density) ramping up as the course progresses.
- A handful of AI riders race the same course alongside the player. They are both a hazard
  (they can bump or dodge into you) and a combat target (you can shove/hit them and knock
  them off pace).
- Reaching the finish line completes the run and tallies the final score. Because distance
  is now fixed (full course), scoring shifts emphasis from raw distance to: **finish time,
  race position among AI riders, near-miss bonuses, combat hits on rivals, and jump/trick
  bonuses** off moguls and hill crests.
- A run-ending wipeout before the finish line ends the run early: the player keeps the
  event points accumulated so far (partial score) but gets no completion or time bonus.
- After either a finish or a wipeout, the player can restart (same seed or a new one).

## 2. Architecture & Tech Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript |
| Game framework | Phaser 3 — scene management, input, asset loading, audio, sprite handling |
| Build tool | Vite (`npm run dev` for local dev server, `npm run build` for static output) |
| Road rendering | **Custom segment-based pseudo-3D renderer** drawn each frame via Phaser's Graphics API (see §3) |
| Entities | Phaser sprites whose screen position/scale are computed each frame by the same projection math as the road |
| Deployment | Static site (e.g., GitHub Pages) — possible later, **not** a v1 requirement |
| Art | Pixel art sprites (see §5) |

Phaser's built-in arcade physics and sprite collision are **not** used for the road or for
gameplay collision. The road is a custom renderer; collision is resolved in world space
(lane index + world-Z proximity), which is both simpler and more correct for this
projection style.

### Scene structure

- `BootScene` — asset loading.
- `TitleScene` — bare-bones start screen (title, "press key to start", shows seed).
- `RaceScene` — the entire race: renderer, entities, input, scoring, HUD.
- `ResultScene` — finish or wipeout summary (score breakdown, time, position, restart
  prompt). Can be implemented as an overlay state within `RaceScene` if simpler.

### Suggested module layout (for the implementation plan; not binding)

```
src/
  main.ts              // Phaser game config + scene registration
  scenes/              // Boot, Title, Race, Result
  track/               // segment types, track generator (seeded), seeded RNG
  render/              // projection math, road renderer (Graphics), sprite projection
  entities/            // player, AI rider, obstacle, pickup
  systems/             // collision, combat, scoring, AI behavior
  config.ts            // all tunable constants in one place
```

## 3. Rendering: Segment-Based Pseudo-3D

This is the heart of the project and a **deliberate, non-negotiable choice**: the true
OutRun/Road Rash segment technique, not a simpler "scaling sprites on a flat background"
endless-runner fake. It is more implementation work, and that is the point — do not
simplify it away.

### 3.1 The idea

The track is a long list of **road segments**. Each segment is a short slice of road with:

- `index` — position in the track array,
- `curve` — how hard this slice bends (signed; negative = left, positive = right),
- `y` — world elevation at the segment's far edge (hills),
- `z` — world-Z of the segment's near edge (`index * SEGMENT_LENGTH`).

Each frame, the renderer takes the camera's current world-Z position, finds the base
segment (the one the camera is over), and projects the next `DRAW_DISTANCE` segments from
world space to screen space, drawing each as a trapezoid (two projected edges connected).
Because farther segments project smaller and higher on screen, the result is the classic
"road of trapezoids rushing toward you."

### 3.2 Projection math

For a world point `(worldX, worldY, worldZ)` and camera at `(camX, camY, camZ)`:

```
dz     = worldZ - camZ                      // distance in front of camera
scale  = CAMERA_DEPTH / dz                  // CAMERA_DEPTH = 1 / tan(fov/2)
screenX = SCREEN_W/2 + scale * (worldX - camX) * SCREEN_W/2
screenY = SCREEN_H/2 - scale * (worldY - camY) * SCREEN_H/2
screenW = scale * ROAD_WIDTH * SCREEN_W/2   // projected road half-width
```

Each segment's near and far edges are projected with this formula; the road polygon for the
segment is the trapezoid between the two projected edges. Rumble strips / edge markers and
alternating snow shading are drawn as proportionally narrower/wider trapezoids on the same
edges (alternating colors every few segments sells the sense of speed).

### 3.3 Curves

Curves are **not** real 3D turns — the trick is a per-segment horizontal offset that
accumulates as you walk out from the camera. **Documented decision (correctness fix):**
the two edges of each segment must be projected with *different* offsets so that
consecutive trapezoids tile together — the near edge uses the currently accumulated
offset `x`, the far edge uses `x + dx`, and the accumulators update only **after** both
edges of the current segment are projected. (Projecting both edges of a segment with a
single per-segment offset — the previous wording here — cracks/stair-steps the road in
curves and is wrong.)

```
x  = 0                                       // accumulated curve offset
dx = -(baseSegment.curve * baseFraction)     // seed term: camera's fractional position
                                             // within the base segment (prevents popping
                                             // as the camera crosses segment boundaries)
for each of the next DRAW_DISTANCE segments, front to back:
    nearOffset = x        // near edge, at world-Z = segment.index * SEGMENT_LENGTH
    farOffset  = x + dx   // far edge,  at world-Z = (segment.index + 1) * SEGMENT_LENGTH
    project the NEAR edge with road-center X shifted by nearOffset
    project the FAR  edge with road-center X shifted by farOffset
    x  += dx              // update ONLY AFTER both edges are projected, so the NEXT
    dx += segment.curve   // segment's near edge equals this segment's far edge (x + dx
                          // from before the update) — no cracks between trapezoids
```

Because `dx` grows cumulatively, a run of segments with the same `curve` value bends away
smoothly like a real curve. Curved sections in the generator ease curve values in and out
(e.g., ramp 0 → C over the enter portion, hold C, ramp back to 0) to avoid kinks.

Note on the seed term: with small, eased per-segment curve values (as the generator
specifies), the residual discontinuity from the seed term as the camera crosses the
base-segment boundary is sub-pixel and not visually noticeable. This is a property of the
technique to design around — keep per-segment curve values gentle — not a bug to chase in
code.

### 3.4 Hills

Each segment stores a world `y` elevation; the generator eases elevation changes across a
hill section (e.g., cosine interpolation from startY to endY). Projection already handles
the rest: segments with higher `y` project higher on screen. The camera's `camY` is the
road elevation under the player plus a fixed camera height, so the horizon rises and falls
as you crest hills.

Clipping rules (stated precisely — the comparison direction matters):

- **Crest clip:** while drawing front-to-back, track the **minimum projected screen-Y**
  seen so far (numerically smallest = highest on screen). Skip (do not draw) any segment
  whose far-edge projected Y is **numerically greater than or equal to** that running
  minimum — such a segment would draw lower on screen, i.e., behind the crest. This
  correctly hides road "behind" a crest.
- The per-segment clip decision is recorded and **also applied to entities** standing on
  clipped segments (see §3.5) — hidden road must hide what stands on it.
- **Behind-camera clamp:** skip projecting/drawing entirely any segment whose `dz <= 0`
  (the base segment's near edge, or anything at/behind the camera) — never divide by a
  zero or near-zero `dz`.

### 3.5 Entities use the same projection

Every entity (player, AI riders, obstacles, pickups, finish banner) lives in **world
coordinates**: a world-Z position, a lateral offset from road center (expressed as a
fraction of road half-width, derived from its lane), and the road elevation at its Z. Each
frame, an entity's screen X, screen Y, and render scale are computed with the **same
projection math** (including the accumulated curve offset — see below), then applied to
its Phaser sprite (`setPosition` + `setScale`, plus depth-sorting by Z so nearer sprites
draw on top). This is what makes sprites correctly shrink/grow and slide horizontally
through curves as they approach the camera.

Two precision rules:

- **Curve offset is interpolated, not snapped:** an entity's curve offset is linearly
  interpolated between its segment's near-edge offset (`x`) and far-edge offset (`x + dx`,
  per §3.3) by the entity's **fractional Z position within the segment**. Snapping every
  entity in a segment to one quantized per-segment offset produces visible stair-stepping
  through curves as entities cross segment boundaries.
- **Hiding covers all three cases:** a sprite is hidden if it is behind the camera, beyond
  draw distance, **or standing on a segment that was clipped by the crest rule (§3.4)** —
  an entity hidden behind a crest must vanish with the road under it, not float above it.

The player sprite is the one exception: it renders at a fixed screen position near the
bottom-center (the camera follows the player), bobbing/tilting per lane-change and jump
animation frames.

### 3.6 Render order per frame

1. Sky/backdrop (static gradient or parallax strip; parallax shift by curve is a
   nice-to-have).
2. Road segments, front-to-back with the crest clipping rule (or back-to-front painter's
   algorithm — front-to-back with clipping is the classic and cheaper approach).
3. Entity sprites, sorted far-to-near.
4. Player sprite.
5. HUD (speed, score, progress-to-finish, weapon state).

## 4. Core Systems

### 4.1 Units, speed, and the camera

- `SEGMENT_LENGTH = 200` world units. Course length **1,500 segments = 300,000 world
  units** (see §7 Assumptions — tuned for roughly a **105–130 second** clean run: 100 s is
  the hard floor at `MAX_SPEED`, and the standing-start acceleration ramp plus minor
  slowdowns add the rest; the earlier "~90–120 s" claim was arithmetically unreachable and
  has been corrected).
- The player auto-accelerates downhill toward `MAX_SPEED = 3,000` units/sec (~15 segments/
  sec). There is **no brake or tuck control in v1** — speed is managed by the game
  (collisions and stumbles reduce it; it recovers automatically). Controls are steering
  and jumping only.
- The camera sits a fixed distance behind and above the player's world position. The
  camera's height follows the **road's elevation at the player's world-Z** (plus the fixed
  camera height) — **not** the player's jump-arc height. During a jump the camera stays
  smooth while the player sprite animates the arc independently; this avoids a jarring
  bouncing camera.
- `DRAW_DISTANCE = 100` segments; `FOV = 100°` (`CAMERA_DEPTH ≈ 0.84`).

All of these are tunables in `config.ts` and expected to change during play-testing.

### 4.2 Track generation (seeded, fixed length)

- **Seeded PRNG** (e.g., mulberry32) — every random draw in track generation goes through
  it, so a seed fully determines the course: geometry, obstacle placement, pickup
  placement, and AI rider parameters. A new random seed is chosen per run and displayed on
  the title/result screens; a specific seed can be forced via URL query param (`?seed=`)
  for replays and debugging.
- **PRNG draw-order discipline:** the generator must complete the full **geometry pass**
  (section layout, curves, hills) through the seeded PRNG **before** the **placement pass**
  (obstacles, pickups, AI rider parameters) begins — placement draws never interleave with
  geometry draws, so future tuning of one pass can never reroll the other. Runtime
  randomness (e.g., AI bump-aggression timing during actual play) is intentionally **not**
  routed through the seeded course-generation PRNG and is not expected to be reproducible —
  the determinism guarantee covers course geometry and placement only.
- The generator emits the whole track up front (1,500 segments is trivially small) by
  stitching **sections** from a pattern library: straight, gentle curve L/R, sharp curve
  L/R, S-curve, hill up, hill down, crest (up-then-down, jumpable). Each section is a run
  of segments with eased curve/elevation values (§3.3–3.4).
- **Difficulty ramp:** let `t = z / COURSE_LENGTH` (0 at start, 1 at finish). As `t`
  grows: sharper curve values and shorter straights become more likely, and obstacle
  density rises (e.g., obstacle rows per 100 segments scales from ~4 at `t=0` to ~12 at
  `t=1`). The first ~100 segments are kept obstacle-free and straight as a warm-up.
- **Obstacles** are placed on specific lanes of specific segments. **Solvability rule
  (quantified for reachability):** a lane change costs travel distance — at the ~150 ms
  tween (§4.3) and `MAX_SPEED` (~15 segments/sec), one lane shift takes ~2.25 segments of
  travel; the generator plans with `LANE_CHANGE_SEGMENTS = 3` (rounded up to absorb input
  buffering and reaction). Any segment row with obstacles must leave **at least one clear
  lane**, and for consecutive obstacle rows within a short Z window a clear lane in the
  later row must be **reachable in time** from a clear lane in the earlier row:
  `(lanes of shift needed) × LANE_CHANGE_SEGMENTS ≤ (segment gap between the rows)`.
  "A clear lane exists" alone is not enough — it must be reachable from the player's prior
  clear lane within the gap (no impossible walls, and no technically-clear-but-unreachable
  lanes).
- **Jump-reach constraint (no tree-baited launches):** a mogul launches from its own lane,
  so for every mogul, no **tree** may be placed in that mogul's lane within the full
  extended-jump reach (`JUMP_REACH_EXTENDED ≈ 18` segments, §4.3) downstream of it. A
  jumpable crest auto-launches from whatever lane the player crosses the apex in (§4.3),
  so no tree may be placed in **any** lane within `JUMP_REACH_EXTENDED` downstream of a
  crest apex (in practice subsumed by the blind-landing rule below, which is stricter).
  This is the solvability rule's "reachable lane must be clear" logic extended to the jump
  arc's landing zone — a launch can never bait the player into an unavoidable tree. Rocks
  and moguls may still appear in the landing zone: they are recoverable, not run-ending.
- **Blind landing zone:** every lane must be obstacle-free for a minimum reaction distance
  after a crest apex (**20 segments**, ≈1.3 s at `MAX_SPEED`), since a crest hides
  upcoming obstacles until the rider is over it. (20 ≥ 18 also satisfies the crest case of
  the jump-reach constraint above.)
- **Weapon pickups** spawn on a random clear lane roughly every 20–30 seconds of travel
  (~300–450 segments), through the seeded RNG.
- The final segment carries the **finish line** (banner sprite across the road). A short
  obstacle-free run-out precedes it.

### 4.3 Controls

- **Lane-shifting, not free movement:** the road has **5 discrete lanes** (lateral offsets
  −0.8, −0.4, 0, +0.4, +0.8 of road half-width). Left/Right (arrow keys and A/D) shift the
  player one lane per press; the visible position tweens between lane offsets over
  ~150 ms. Inputs during a tween are buffered (one deep) so double-taps feel responsive.
- **Jump:** Space or Up. Fixed-impulse vertical arc (simple gravity) with a **constant
  ~600 ms airtime** — airtime is a property of the fixed impulse and gravity, independent
  of speed; it is the **horizontal distance** covered during the arc that scales with
  current speed. At `MAX_SPEED` (~15 segments/sec) a normal jump covers
  `JUMP_REACH_NORMAL ≈ 9` segments. While airborne the player clears **rocks and moguls**
  (they pass beneath) but not **trees** (too tall) and cannot lane-shift (committed jump —
  a deliberate risk/reward choice).
- **Extended (trick) jumps:** launching off a **mogul** or a **crest** doubles the airtime
  (~1,200 ms), covering up to `JUMP_REACH_EXTENDED ≈ 18` segments (2× the normal jump's
  reach) at `MAX_SPEED`, and awards trick points (§4.7). The two launchers differ in
  input: a **mogul** requires pressing jump on/just before it (riding over one without
  jumping is a stumble, §4.4); a **jumpable crest auto-launches** the player at its apex
  with **no jump press required** — the crest acts as a ramp, mirroring real downhill
  racers, where cresting a hill at speed puts you airborne without input. The generator
  guarantees no tree can sit within extended-jump reach of any launch point (§4.2).
- **Airborne interaction rules:** while airborne the player can neither **initiate** a
  combat exchange (no mid-air lane-shift) nor **be targeted** by one — an AI bump attempt
  against an airborne player simply whiffs with no effect (§4.6). Weapon pickups **are**
  still collected while airborne when the player's lane matches the pickup's lane (§4.6).
  Airborne = combat-immune but steering-locked: the committed jump trades combat safety
  for losing steering control, consistent with the risk/reward framing above.
- **Restart:** R (or Enter on the result screen) restarts; the result screen offers "same
  seed" and "new seed".

### 4.4 Obstacles & wipeouts

Three obstacle types, placed per-lane, all rendered as pixel art sprites projected like
everything else:

| Obstacle | Collision effect | Jumpable? |
| --- | --- | --- |
| **Tree** | **Run-ending wipeout** — the run ends immediately; partial score | No |
| **Rock** | **Temporary wipeout** — big speed loss (drop to ~30% of current speed), ~1 s tumble animation during which the player can't steer, then recover with ~1 s of collision immunity | Yes |
| **Mogul** | **Stumble** — moderate speed loss (~25%), brief wobble, no control loss. If the player **jumps** on/just before a mogul, no penalty and it launches an extended trick jump | Yes |

Collision test: player and obstacle occupy the same lane and their world-Z positions are
within a small window (~0.5 segment), and the player is not airborne above a jumpable
obstacle. No pixel-perfect or physics-engine collision.

### 4.5 AI riders

**4 AI riders** race the full course with the player. Per-rider parameters (cruise speed,
aggression, reaction distance) are drawn from the seeded RNG at generation time, so rivals
are deterministic per seed too. Behavior is a simple priority list evaluated per frame:

1. **Race:** accelerate toward a per-rider cruise speed (90–105% of the player's
   `MAX_SPEED`, so the pack roughly keeps pace and finishing order is contestable).
2. **Dodge:** look ahead a few segments; if an obstacle occupies the rider's lane, change
   to an adjacent clear lane. AI riders that fail to dodge hit obstacles under the same
   rules as the player (a tree takes a rival out of the race entirely).
3. **Bump:** when within ~2 segments of the player's Z and an adjacent lane, occasionally
   (aggression-weighted timer) drift into the player's lane to attempt a shove. A bump
   attempt against an **airborne** player whiffs — no effect on either rider (§4.3, §4.6).

AI riders start staggered around the player at the start line. They do not use weapons in
v1 (their bumps are always baseline strength). Riders far behind or far ahead of the
camera still simulate (cheaply — no rendering) so finishing position is honest.

**AI-vs-AI is skipped in v1:** AI riders do not resolve combat or rider-collision against
each other — combat and rider proximity only matter vs. the player, and obstacle
collisions apply to everyone. Two rivals may briefly overlap a lane without consequence.
This is a deliberate v1 simplification (flagged in §7).

### 4.6 Combat

- **Bump-to-shove is the baseline — no attack button.** A knockback exchange triggers in
  either of two ways, and **both resolve identically**:
  1. **Lateral shove:** the player is laterally adjacent to a rival (neighboring lane),
     within ~1 segment in Z, and **steers toward the rival's lane** — the exchange
     resolves instead of a lane change.
  2. **Same-lane contact:** the player and a rival occupy the **same lane** within the
     same ~1-segment Z window (e.g., closing on a rival from behind, or a dodging rival
     drifting into the player's lane) — the exchange resolves instead of an undefined
     rear-end pass-through. This makes the rear-approach case fully defined: catching a
     rival parked in your lane is a combat exchange, same rules as a lateral shove.
  The same resolution applies regardless of who initiates — player steering in, or an AI
  bump (behavior 3, §4.5) drifting in. **Exception:** an airborne player can neither
  initiate nor be targeted — an AI bump attempt against an airborne player whiffs with no
  effect on either rider (§4.3).
- **Resolution:** the faster rider (or the one holding a weapon) wins. The loser is
  knocked one lane away and loses ~20% speed; the loser gets ~0.5 s of shove immunity so
  exchanges don't machine-gun. Knockback clamps and scoping:
  - **Road-edge clamp:** a loser already in the edge lane takes the speed loss only — no
    lane change is possible.
  - **Tree clamp (no forced deaths):** a knockback **loser is never knocked into a lane
    containing a tree**. If the lane in the knockback direction has a tree within the
    immediate knockback window (~2 segments downstream of the loser's world-Z — the
    distance covered during the knockback plus the collision window), clamp to **no lane
    change, speed loss only**, exactly like the road-edge clamp. For a two-lane (armed)
    knockback, the loser lands in the **farthest tree-free lane** along the knockback
    direction (possibly staying put). Rocks and moguls remain valid knockback
    destinations — they are recoverable, not run-ending. **This guarantees a shove loss
    can never be an unavoidable tree kill** (closing the loophole where the only clear
    lane through a tree row is occupied by a rival and losing the exchange would bounce
    the player into the tree).
  - **Shove-immunity scope:** immunity applies **per attacker** — an immune loser cannot
    be re-shoved by the **same** rival within the ~0.5 s window, but **can** be targeted
    by a different rival. This prevents double-dipping from one exchange without
    overcomplicating group combat.
- A rider knocked into a (non-tree) obstacle suffers that obstacle's normal collision.
  Because of the tree clamp, an *instant* shove-into-tree is impossible for everyone —
  **knockouts are positional plays instead**: a rival knocked into a bad line (slowed,
  displaced) that then collides with a tree within ~2 s of losing the exchange to the
  player is removed from the race and credited as the player's **knockout** (§4.7).
- **Weapon pickup — ski pole (one type in v1):** driving over a pickup arms the pole with
  **3 charges**. Pickups are collected by lane + Z proximity **regardless of airborne
  state** — unlike a solid obstacle, a pickup isn't something you'd want to dodge by
  jumping over, so airborne collection is the more fun default. While armed, **every
  combat exchange the player wins — whether player-initiated or AI-initiated — consumes
  one charge** (the consumption rule is symmetric in who started it): the armed player
  auto-wins the exchange regardless of speed and knocks the victim **two** lanes (subject
  to the edge and tree clamps above) with double speed loss. At 0 charges the player
  reverts to baseline bump; picking up another pole refreshes to 3. Charges **persist
  through a rock tumble** (temporary wipeout) and are only cleared by a run-ending
  wipeout (tree — which ends the run anyway) or overwritten by a fresh pickup. HUD shows
  remaining charges.

### 4.7 Scoring

Score is a running total of event points, plus completion bonuses at the finish line:

| Event | Points |
| --- | --- |
| Combat hit landed on a rival | 250 |
| Knockout (rival removed from the race by your shove) | 500, **in addition to** the 250 combat hit — a knockout totals **750** |
| Near-miss (pass within one lane of an obstacle, or graze past a rival without contact, at ≥70% max speed) | 100 |
| Trick jump (airtime launched off a mogul or crest) | 150 (+50 per extra 0.25 s of airtime) |
| **Completion bonus** (crossing the finish line) | 2,000 |
| **Time bonus** | `max(0, (PAR_TIME − finishTime)) × 50` per second under par; `PAR_TIME = 130 s` |
| **Position bonus** (finish position among player + 4 rivals) | `(5 − finishPosition) × 250` — 1st = 1,000, 2nd = 750, 3rd = 500, 4th = 250, 5th = 0 |

- **Knockout attribution:** a rival that collides with a tree within ~2 s of losing a
  shove exchange to the player counts as the player's knockout (the tree clamp in §4.6
  makes instant tree-slams impossible, so this window is how knockouts are credited).
- **Near-miss is a one-shot check per entity:** it is evaluated exactly once per
  obstacle/rival, at the moment that entity's world-Z crosses the player's world-Z — not
  a continuous per-frame check — so dense sections can't re-trigger it repeatedly for the
  same entity.
- Wipeout before the finish: keep accumulated event points; no completion, time, **or
  position** bonus (a run that never reaches the line doesn't have a finish position to
  reward). Race position is still **computed and shown** on the wipeout result screen for
  informational purposes, frozen at the standings at the moment of the wipeout —
  consistent with the finished-mode result screen, just without the point award.
- Race **position** at the finish (1st–5th among player + 4 rivals) is tracked, displayed
  prominently on the result screen, and **awards the position bonus above** — confirmed in
  Open Questions (§7).
- HUD during the race: score, speed, course progress bar, weapon charges. Result screen:
  score breakdown by category, finish time, position, best-score-this-session (no
  persistence — see out of scope).

### 4.8 Race flow

```
Title (seed shown) → Race → { cross finish line → Result (finished: time, position, full score) }
                          → { run-ending wipeout → Result (wiped out: partial score) }
Result → restart (same seed or new seed) → Race
```

## 5. Art & Audio

- **Pixel art sprites** for the player rider (with lean-left/center/lean-right + jump +
  tumble frames), AI riders (palette-swapped variants of one base sheet is fine), trees,
  rocks, moguls, the ski-pole pickup, and the finish banner. This was an explicit choice —
  not geometric placeholders, and not deferred. Suggested working format: 32×32 base
  sprites (48×32 for the banner), nearest-neighbor scaled by the projection (Phaser pixel
  art mode: `pixelArt: true`, no anti-aliasing). Free/CC0 asset packs or hand-drawn Aseprite
  sprites are both acceptable; the road itself is flat-shaded Graphics polygons, which
  reads well next to pixel sprites.
- **Audio:** placeholder or none for v1. Full sound design is out of scope.

## 6. MVP Scope

### In scope for v1

- One continuous downhill race course: seeded procedural generation within a fixed length,
  with curves and hills, difficulty ramping over the course, and a finish line.
- Segment-based pseudo-3D renderer (curves, hills, crest clipping) via Phaser Graphics.
- Player entity with discrete lane-shift + jump controls, projected onto the road.
- Three obstacle types (trees, rocks, moguls) with the wipeout/stumble rules in §4.4.
- 4 AI riders with race/dodge/bump behavior.
- Bump-to-shove combat + one weapon pickup type (ski pole).
- Scoring: combat, near-miss, trick, completion, and time bonuses; position tracked and
  displayed at finish.
- Run-ending wipeout before the finish → partial-score game over with restart.
- Finish-line completion state with restart (same seed / new seed).
- Bare-bones title and result screens; minimal HUD.
- Pixel art sprites for all entities.

### Out of scope for v1 (future work — do not plan for these)

- Multiplayer.
- Multiple distinct tracks/levels (v1 has exactly one course; the seed provides variety).
- Upgrades or persistence between runs (no save data, no meta-progression, no persistent
  high-score table — session-best only, in memory).
- Full sound design (placeholder or no audio is fine).
- Polished menus/UI (bare-bones start/restart is enough).
- Deployment (GitHub Pages etc. is a later concern, not part of v1).

## 7. Open Questions / Assumptions

Concrete defaults have been chosen for everything below (nothing is left TBD — the
implementation plan builds against these values), but each is explicitly flagged so the
developer can spot and override it.

1. **Race position (CONFIRMED by developer): affects score.** Finish position among the
   player + 4 AI riders awards a **position bonus** of `(5 − finishPosition) × 250` points
   at the finish line (§4.7) — 1st place is worth 1,000 points, on par with the completion
   bonus's weight. The bonus is finish-only: a wipeout still tracks/displays position for
   information but awards no position points (§4.7), consistent with wipeouts also
   skipping the completion and time bonuses.
2. **Lane count: 5** (offsets −0.8/−0.4/0/+0.4/+0.8 of road half-width). 3 felt cramped
   for dodge + combat + pickups simultaneously; 7 dilutes obstacle pressure.
3. **AI rider count: 4** (5 racers total). Enough for a pack and a meaningful position
   range without crowding 5 lanes.
4. **Course length: 1,500 segments × 200 units = 300,000 world units**, targeting a
   **~105–130 s** clean run at `MAX_SPEED = 3,000` units/sec; `PAR_TIME = 130 s`. (The
   earlier ~90–120 s claim was internally inconsistent: 300,000 / 3,000 = 100 s is the
   hard floor before the standing-start acceleration ramp, so 90 s was unreachable. The
   constants were kept — they're the first-pass tuning targets — and the claimed range
   and `PAR_TIME` were corrected to match.)
5. **No brake/tuck in v1** — controls are exactly lane-shift + jump; speed is automatic.
6. **Obstacle severity mapping:** trees = run-ending; rocks = temporary wipeout; moguls =
   stumble (and trick launcher). Jump clears rocks and moguls but never trees.
7. **No lane-shifting mid-jump** (committed jumps). Chosen for risk/reward; easy to relax.
8. **Ski pole = 3 charged hits** (charge count, not a timer), refreshing on re-pickup.
9. **Seed handling:** random per run, shown on title/result screens, forceable via
   `?seed=` URL param.
10. **Point values in §4.7** (250/500 [knockout totals 750]/100/150/2,000, par 130 s at
    50/s) are first-pass tuning targets, expected to change during play-testing; they
    live in `config.ts`.
11. **Rendering/tuning constants** (5 lanes, draw distance 100, FOV 100°, segment length
    200, 32×32 sprites, ~960×540 internal resolution) are starting values in `config.ts`,
    not commitments.
12. **AI riders simulate off-screen** (cheap update without rendering) so finish position
    is honest rather than staged.
13. **Jump-reach constants:** normal jump = constant ~600 ms airtime ≈
    `JUMP_REACH_NORMAL = 9` segments at `MAX_SPEED`; extended (mogul/crest) jump = **2×**
    (~1,200 ms ≈ `JUMP_REACH_EXTENDED = 18` segments). The 2× multiplier was chosen from
    the directed 1.5–2× range for round numbers and a clearly-felt trick launch; tunable
    in `config.ts`.
14. **Crest launch input:** jumpable crests **auto-launch at the apex with no jump press,
    at any speed** (a slow crest crossing is just a short hop — no speed threshold, to
    keep the rule simple); moguls require a jump press to launch (no press = stumble). A
    minimum-speed threshold for crest auto-launch is a possible later refinement.
15. **Generator safety distances (derived, first-pass):** `LANE_CHANGE_SEGMENTS = 3`
    segments per lane shift (from the 150 ms tween at `MAX_SPEED`, rounded up for input
    buffering); post-crest blind landing zone = **20 obstacle-free segments** (~1.3 s of
    reaction at `MAX_SPEED`, and ≥ `JUMP_REACH_EXTENDED`).
16. **Combat clamp/attribution windows (judgment calls):** the tree clamp checks the
    knockback-destination lane for a tree within **~2 segments** downstream of the
    loser's world-Z (immediate-kill range only — trees farther ahead are dodgeable and
    remain normal gameplay); a rival hitting a tree within **~2 s** of losing a shove to
    the player credits the player's knockout. Consequence worth knowing: with the tree
    clamp, knockouts are positional plays (shove a slowed rival into a bad line), never
    instant tree-slams.
17. **AI-vs-AI combat/collision is skipped in v1** — rivals only interact with the player
    and with obstacles. A reasonable v1 simplification; rival-vs-rival jostling is future
    work.

### Revision notes (2026-07-11 consistency pass)

A review pass found and resolved the following; each fix is written into the sections
noted rather than only listed here:

- **Curve projection corrected (§3.3):** replaced the single-offset walk with the correct
  near-edge-`x` / far-edge-`x + dx` algorithm (update accumulators only after both edges),
  plus a note that the seed term's residual discontinuity is sub-pixel with gentle eased
  curves. §3.5 now interpolates entity curve offsets between near/far edges.
- **Same-lane combat defined + forced-death loophole closed (§4.6):** combat triggers on
  same-lane contact as well as lateral steering-in, both resolving identically; knockback
  losers are never knocked into a tree lane — the knockback clamps instead (see item 16).
- **Airborne interactions defined (§4.3, §4.5, §4.6):** airborne = combat-immune (AI
  bumps whiff), pickups still collect mid-air; weapon charge consumption is symmetric;
  knockout scoring totals 750 (§4.7).
- **Jump reach quantified + generator constraints added (§4.2, §4.3):** items 13–15
  above; no tree within extended-jump reach of a launch; post-crest blind landing zone.
- **Crest clipping made precise (§3.4):** min-screen-Y comparison direction stated,
  entity clipping included, `dz <= 0` clamp added.
- **Solvability made time-aware (§4.2):** clear lanes must be *reachable* given
  `LANE_CHANGE_SEGMENTS`.
- **Seeded-PRNG draw-order discipline stated (§4.2):** geometry pass fully before
  placement pass; runtime randomness deliberately unseeded.
- **Crest auto-launch decided (§4.3, item 14)** and scheduled in the implementation plan.
- **Timing corrected (§4.1, §4.7, item 4):** clean-run target ~105–130 s, `PAR_TIME =
  130 s` (90 s was unreachable at the stated constants).
- **Minor rules made explicit:** edge-lane knockback, per-attacker shove immunity,
  charge persistence through tumbles, constant-airtime wording, one-shot near-miss check,
  camera height ignoring the jump arc, wipeout result screen showing frozen position.
