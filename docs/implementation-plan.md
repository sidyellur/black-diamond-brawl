# Black Diamond Brawl — Implementation Plan

Derived from [design-spec.md](design-spec.md). Nine phases, each small and independently
verifiable: every phase ends with something you can run in the browser and confirm with
your eyes (or a quick console check) before starting the next. No phase requires a big
leap of untested code. Spec section references are noted per phase.

Tunable constants (lane offsets, speeds, draw distance, point values, etc.) all go in
`src/config.ts` from Phase 1 onward so later tuning never means hunting through systems.

---

## Phase 1 — Project scaffolding + empty Phaser scene

**Build:** Vite + TypeScript project with Phaser 3 installed. `main.ts` with a Phaser game
config (`pixelArt: true`, ~960×540, scale mode FIT) and a single scene that clears to a
sky-blue background and draws a "Black Diamond Brawl" text label. Create `config.ts` with
the initial constants from the spec (§4.1, §7). Add a `BootScene` (spec §2 scene
structure) that runs first, loads assets in `preload()`, and hands off to the next scene —
it starts essentially empty and **grows incrementally**: each later phase that introduces
sprites (Phase 4 player sheet, Phase 6 obstacles, Phase 7 rider palette swaps, Phase 8
pickup) registers its own assets in BootScene as part of that phase, rather than
front-loading everything here. Add `npm run dev` / `npm run build` scripts and stub the
module folders (`scenes/`, `track/`, `render/`, `entities/`, `systems/`).

**Verify:** `npm run dev` → BootScene runs (empty preload) and hands off to the scene
showing the background color and label; no console errors. `npm run build` completes
cleanly.

---

## Phase 2 — Segment renderer: static straight, flat track

**Build:** The core projection (spec §3.2) and road renderer (§3.6 steps 1–2) against a
hard-coded track: an array of ~500 segments, all `curve = 0`, `y = 0`. Each frame, project
`DRAW_DISTANCE` segments from a camera world-Z and draw the road trapezoids with Phaser
Graphics — skipping any edge with `dz <= 0` (§3.4's behind-camera clamp, built here where
projection first exists) — with alternating snow shading and edge/rumble strips every few
segments. Advance the
camera's world-Z automatically at a constant speed (no input yet), looping back to the
start when it runs out of track.

**Verify:** Run the dev server and visually confirm: a straight road converging to a
horizon point, alternating segment bands scrolling smoothly toward the camera with no
popping or flicker at segment boundaries, steady frame rate (check the FPS in devtools;
should be an easy 60).

---

## Phase 3 — Curves + hills in the renderer

**Build:** Per-segment `curve` with the accumulated `x/dx` offset walk **using the
corrected near/far edge algorithm (§3.3)**: each segment's near edge is projected with the
current `x`, its far edge with `x + dx`, and `x += dx; dx += segment.curve` runs only
after both edges are projected — so each segment's near edge tiles exactly onto the
previous segment's far edge. Include the base-segment fraction seed term. Per-segment `y`
elevation with eased hill sections and the front-to-back crest clipping rule, implemented
per §3.4's precise statement: running **minimum** projected screen-Y, skip segments whose
far-edge Y is ≥ that minimum, alongside the `dz <= 0` behind-camera clamp from Phase 2.
Replace the flat test track with a hard-coded sampler track that exercises everything:
left curve, right curve, S-curve, hill up, hill down, crest. Camera Y follows road
elevation + fixed height.

**Verify:** Run the dev server and visually confirm: the road bends left and right
smoothly as segments scroll (no kinks at curve entry/exit), the horizon rises and falls
through hills, and the road correctly disappears behind a crest and reappears past it. No
popping when the camera crosses segment boundaries mid-curve. **If cracks or stair-steps
appear between road trapezoids in curves, the near/far edge offset assignment (`x` vs
`x + dx`, updated only after both projections) is the first thing to check.**

---

## Phase 4 — Player entity + lane-shift/jump controls

**Build:** Player state in world coordinates (world-Z, lane index, airborne offset).
Auto-acceleration toward `MAX_SPEED` (§4.1); camera follows the player — camera height
tracks the **road elevation at the player's world-Z + fixed height, not the jump arc**
(§4.1), so the camera stays smooth while the sprite animates the jump. Lane-shift input
(arrows/A-D) with 5 lanes, ~150 ms tween between lane offsets, one-deep input buffer
(§4.3). Jump (Space/Up) with a fixed gravity arc: constant ~600 ms airtime, horizontal
distance scaling with speed (~`JUMP_REACH_NORMAL = 9` segments at max speed, §4.3), no
mid-air lane changes. Player pixel-art sprite (lean/jump frames — a placeholder-quality
hand-drawn sheet is fine, but pixel art per §5) registered in BootScene and drawn at
fixed screen position with lean/jump frame switching. The player's lateral offset must
feed into the road projection so the camera view shifts correctly across lanes.

**Verify:** Run the dev server: rider accelerates down the sampler track; each tap moves
exactly one lane with a smooth tween (mash-tapping buffers cleanly, never skips to a wrong
lane or exits the road); jump arcs and lands believably, steering is locked mid-air, and
the camera does **not** bounce with the jump arc (including over hills); sprite shows
lean-left/right and jump frames at the right moments.

---

## Phase 5 — Procedural track generation + finish line

**Build:** Seeded PRNG (mulberry32) in `track/`; `?seed=` URL param with a random default
(§4.2). Section pattern library (straight, gentle/sharp curve L/R, S-curve, hill up/down,
crest) with eased curve/elevation values. Generator stitches sections to exactly
`COURSE_LENGTH` (1,500 segments), difficulty ramp `t = z / COURSE_LENGTH` biasing sharper
curves later, obstacle-free straight warm-up at the start, run-out + finish-line segment
at the end (banner sprite projected like any entity). Structure the generator as **two
strictly ordered passes over the seeded PRNG** (§4.2): the full geometry pass completes
before any placement pass begins (placement — obstacles/pickups/AI parameters — arrives
in Phases 6–8 and must slot in *after* geometry, never interleaved); runtime gameplay
randomness never touches the seeded PRNG. Crossing the final segment logs "FINISHED +
time" to the console (real finish flow comes in Phase 9). HUD progress bar.

**Verify:** Load the same `?seed=` twice → visibly identical course (spot-check a few
landmarks; optionally hash the segment array and compare). Different seeds → different
courses. Ride the whole course: early portion is gentle, curves visibly sharpen later,
banner appears at the end and crossing it logs the finish time. Progress bar tracks
position.

---

## Phase 6 — Obstacles + collision/wipeout

**Build:** Obstacle placement in the generator (trees/rocks/moguls on lanes, density
ramping with `t`) with the full §4.2 placement constraints: every obstacle row leaves a
clear lane; consecutive rows keep a clear lane **reachable in time** (lanes-of-shift ×
`LANE_CHANGE_SEGMENTS = 3` ≤ segment gap); **no tree in a mogul's lane within
`JUMP_REACH_EXTENDED = 18` segments downstream of it, and none in any lane within 18
segments downstream of a crest apex**; and the post-crest
**blind landing zone** (20 segments, all lanes) stays obstacle-free. Register obstacle
sprites in BootScene; pixel-art obstacle sprites projected with the entity math (§3.5) —
curve offset **interpolated between the segment's near/far offsets** by fractional Z, not
snapped per segment — depth-sorted, and **hidden when their segment is crest-clipped**
(§3.4), not only when behind the camera or beyond draw distance. Lane + Z-window collision
(§4.4): tree → run-ending wipeout (freeze + console log for now; real game-over in Phase
9), rock → temporary wipeout (speed drop, 1 s no-steer tumble, 1 s immunity), mogul →
stumble, jump clears rocks/moguls but not trees. Extended (trick) launches per §4.3:
jumping on/just before a mogul launches a ~1,200 ms extended jump; a **jumpable crest
auto-launches at its apex with no jump press** (this phase owns crest-launch mechanics —
crest geometry exists from Phase 3, the jump arc from Phase 4, and the tree-safety
constraints land here with the rest of placement).

**Verify:** Run the dev server: obstacles scale/slide correctly through curves as they
approach (watch one through a curve specifically — no stair-stepping as it crosses
segment boundaries) and vanish behind crests along with the road; deliberately hit each
type and confirm its distinct outcome; jump over a rock and take no damage; jump onto a
mogul and get the big launch; ride over a crest at speed and get auto-launched without
pressing jump, landing in an obstacle-free zone; ride the full course and confirm there
is always a survivable, *reachable* line and density visibly rises late-course.

---

## Phase 7 — AI riders (race + dodge, no combat)

**Build:** 4 AI rider entities with seeded per-rider parameters (cruise speed 90–105% of
`MAX_SPEED`, reaction distance) drawn in the generator's placement pass (§4.2, §4.5).
Behaviors 1–2 only: accelerate to cruise speed; look ahead and lane-change around
obstacles; suffer normal obstacle collisions on failure. **No AI-vs-AI combat or
rider-collision** — rivals ignore each other and may briefly share a lane (deliberate v1
simplification, §4.5). Off-screen simulation (update without rendering) so positions stay
honest. Palette-swapped rider sprites registered in BootScene, projected + depth-sorted
(and crest-clipped) with everything else. Console-loggable race positions.

**Verify:** Run the dev server: rivals visible at the start, racing at slightly different
paces — some pull ahead, some fall behind; watch a rival approach an obstacle and dodge
it; positions logged at the finish are consistent with what you observed; riders that left
draw distance reappear plausibly (not teleported) when pace brings them back.

---

## Phase 8 — Combat: bump/shove + weapon pickup

**Build:** Knockback exchange (§4.6) with **both triggers**: steering into an adjacent
rival within the ~1-segment Z window, **or same-lane contact within that window**
(rear-approach / rival drifting into the player's lane) — both resolve identically.
Faster/armed rider wins; loser knocked a lane + ~20% speed loss + 0.5 s **per-attacker**
shove immunity (same rival can't re-shove within the window; a different rival can).
Knockback clamps: road edge → speed loss only; **tree clamp** — never knock a loser into
a lane with a tree within ~2 segments downstream (clamp to no lane change, speed loss
only); armed 2-lane knockback lands in the farthest tree-free lane. Rocks/moguls remain
valid destinations, and a rider knocked into them suffers normal collision; a rival that
hits a tree within ~2 s of losing a shove counts as the player's knockout. **Airborne
rules (§4.3/§4.6):** an airborne player can't initiate an exchange and AI bump attempts
against an airborne player whiff. AI bump behavior (behavior 3: aggression-timer lane
drift toward the player — timer randomness is runtime, *not* the seeded PRNG). Ski-pole
pickup entity spawned by the generator's placement pass (§4.2), sprite registered in
BootScene: collected by lane + Z **even while airborne**; 3 charges; **every exchange the
armed player wins consumes a charge, whether player- or AI-initiated**; auto-win + 2-lane
knockback (clamped) with double speed loss; refresh on re-pickup; charges persist through
rock tumbles; charge count on HUD.

**Verify:** Run the dev server: steer into an adjacent rival → shove resolves (someone is
knocked sideways and slowed) rather than a lane swap; run up a rival's back in the same
lane → an exchange resolves, no pass-through; get bumped by an aggressive rival; jump
while a rival is mid-bump-drift → the bump whiffs; lose an exchange next to a tree row →
you take speed loss but are never dumped into the tree lane; knock a slowed rival into a
line where they hit a tree → they leave the race (knockout); grab a pole (including
mid-jump) → next 3 won exchanges visibly stronger (2-lane knockback) with HUD charges
counting 3→0, including a charge consumed when a rival initiates and you win; tumble on
a rock while armed → charges survive; then bumps revert to baseline at 0.

---

## Phase 9 — Scoring + finish/restart flow + bare-bones UI

**Build:** Scoring system (§4.7): combat hit (250), knockout (500 **on top of** the 250
hit — 750 total, credited when a rival trees within ~2 s of losing a shove to the
player), near-miss (**one-shot check per entity**, evaluated once when the entity's
world-Z crosses the player's — never per-frame), trick-jump points with airtime bonus;
running score + speed + weapon charges on HUD. Finish flow: crossing the line → Result
screen with score breakdown, finish time, time bonus vs `PAR_TIME = 130 s`, completion
bonus, race position among the 5 racers **and its point award**
(`(5 − finishPosition) × 250`), session-best score (memory only). Wipeout flow: tree
collision → Result screen in "wiped out" mode: partial score, no completion/time/position
bonus, but **race position is still computed and shown** (just unrewarded), frozen at the
standings at the moment of the wipeout. Title scene (name, seed, "press key"); restart
with same seed or new seed (§4.8). Sweep out all temporary console-log stand-ins from
earlier phases.

**Verify:** Play full loops of both endings: finish a race → breakdown adds up correctly
(hand-check one run's math, including a knockout counting 750 and 1st place awarding
1,000 position points), position matches observation, faster runs score higher time
bonus; graze a long tree row → exactly one near-miss per obstacle, no rapid
re-triggering; hit a tree → wipeout screen with partial score (no position points) and
the frozen position shown; same-seed restart replays the identical course,
new-seed restart doesn't; every scoring event visibly ticks the HUD when performed. Then
a final pass: `npm run build` clean, no console errors across several full runs, and a
fresh-eyes read of the spec's MVP list (§6) confirming every in-scope bullet is present.
