# Black Diamond Brawl — Task List

Granular tasks derived from [implementation-plan.md](implementation-plan.md), grouped by
the same phases. Work top-to-bottom; each phase ends with its verification tasks. All
gameplay/tuning numbers referenced below are defined in
[design-spec.md](design-spec.md) and live in `src/config.ts`.

## Phase 1 — Project scaffolding + empty Phaser scene

- [ ] Scaffold Vite + TypeScript + Phaser 3 project (`npm create vite@latest` TS template, `npm install phaser`)
- [ ] Add `src/main.ts` with Phaser game config: `pixelArt: true`, 960×540 internal resolution, scale mode FIT
- [ ] Create `src/config.ts` with initial constants from the spec: `SEGMENT_LENGTH=200`, `COURSE_LENGTH_SEGMENTS=1500`, `MAX_SPEED=3000`, `DRAW_DISTANCE=100`, `CAMERA_DEPTH` (FOV 100°), `LANES=[-0.8,-0.4,0,0.4,0.8]`, `PAR_TIME=130`, `JUMP_REACH_NORMAL=9`, `JUMP_REACH_EXTENDED=18`, `LANE_CHANGE_SEGMENTS=3`, point values
- [ ] Create stub folders/modules: `src/scenes/`, `src/track/`, `src/render/`, `src/entities/`, `src/systems/`
- [ ] Add `BootScene` (spec §2): runs first, loads assets in `preload()` (initially empty), hands off to the next scene — later phases register their sprite sheets here as they introduce them
- [ ] Add a single gameplay-placeholder scene that clears to a sky-blue background and draws a "Black Diamond Brawl" text label
- [ ] Confirm `npm run dev` launches BootScene → placeholder scene in the browser with no console errors
- [ ] Confirm `npm run build` completes cleanly

## Phase 2 — Segment renderer: static straight, flat track

- [ ] Define the `Segment` type: `index`, `curve`, `y`, `z` (+ per-segment color band index)
- [ ] Build a hard-coded test track: ~500 segments, all `curve=0`, `y=0`
- [ ] Implement `project(worldX, worldY, worldZ, camX, camY, camZ)` → `{screenX, screenY, scale, screenW}` per spec §3.2
- [ ] Implement the road renderer: find base segment from camera Z, project near/far edges of the next `DRAW_DISTANCE` segments, draw road trapezoids with Phaser Graphics
- [ ] Skip projecting/drawing any segment edge with `dz <= 0` (at/behind the camera) — never divide by a near-zero `dz` (spec §3.4 clamp)
- [ ] Add alternating snow shading + edge/rumble strips (color band alternates every few segments)
- [ ] Draw a static sky/backdrop behind the road
- [ ] Auto-advance camera world-Z at constant speed, looping to track start at the end
- [ ] Verify visually: straight road converging to horizon, bands scrolling smoothly, no popping/flicker at segment boundaries, ~60 FPS in devtools

## Phase 3 — Curves + hills in the renderer

- [ ] Implement the accumulated curve offset walk per the corrected §3.3 algorithm: project each segment's NEAR edge with `x` and its FAR edge with `x + dx`, then update `x += dx; dx += segment.curve` only after both edges are projected (so each near edge tiles onto the previous far edge)
- [ ] Include the base-segment fraction seed term (`dx` seeded from camera's fractional position in its segment) to prevent popping at segment boundaries
- [ ] Implement per-segment `y` elevation in projection; camera Y = road elevation under camera + fixed camera height
- [ ] Add eased curve sections (ramp in → hold → ramp out) and eased hill sections (cosine interpolation) to the test-track builder
- [ ] Implement front-to-back crest clipping per §3.4's precise rule: track the running MINIMUM projected screen-Y; skip any segment whose far-edge Y is ≥ that minimum; record the per-segment clip decision for entity hiding later (Phase 6)
- [ ] Replace the flat test track with a sampler track: left curve, right curve, S-curve, hill up, hill down, crest
- [ ] Verify visually: road bends smoothly both directions with no kinks at curve entry/exit, and no cracks/stair-steps between trapezoids in curves (if cracks appear, check the near/far edge `x` vs `x + dx` assignment first)
- [ ] Verify visually: horizon rises/falls on hills; road hides behind a crest and reappears past it
- [ ] Verify visually: no popping when the camera crosses segment boundaries mid-curve

## Phase 4 — Player entity + lane-shift/jump controls

- [ ] Create the player entity: world-Z, lane index, lateral offset, vertical (jump) offset, speed
- [ ] Implement auto-acceleration toward `MAX_SPEED`; camera follows player world-Z (fixed distance behind/above)
- [ ] Camera height follows the ROAD elevation at the player's world-Z + fixed camera height — never the player's jump-arc height (spec §4.1: camera stays smooth through jumps)
- [ ] Feed the player's lateral lane offset into the road projection (camera X) so the view shifts across lanes
- [ ] Implement lane-shift input (Left/Right arrows + A/D): one lane per press, clamped to road edges
- [ ] Tween lateral offset between lane positions over ~150 ms
- [ ] Implement one-deep input buffering during a lane tween
- [ ] Implement jump (Space/Up): fixed-impulse gravity arc, constant ~600 ms airtime (speed-independent; horizontal distance scales with speed, ~`JUMP_REACH_NORMAL=9` segments at max speed), `airborne` flag
- [ ] Lock lane-shift input while airborne (committed jumps)
- [ ] Create the player pixel-art sprite sheet (lean-left / center / lean-right / jump / tumble frames, 32×32 base) and register it in BootScene
- [ ] Draw the player sprite at a fixed screen position; switch frames on lean/jump state
- [ ] Verify: each tap moves exactly one lane smoothly; mash-tapping buffers cleanly and never skips or exits the road
- [ ] Verify: jump arcs and lands believably; steering locked mid-air; camera does not bounce with the jump arc; correct sprite frames throughout

## Phase 5 — Procedural track generation + finish line

- [ ] Implement a seeded PRNG (mulberry32) in `src/track/`; all generation randomness goes through it
- [ ] Structure the generator as two strictly ordered PRNG passes (spec §4.2): the full geometry pass (sections/curves/hills) completes before any placement draw (obstacles/pickups/AI parameters, added in Phases 6–8) — never interleave; runtime gameplay randomness (e.g., AI bump timers) must NOT use the seeded PRNG
- [ ] Read seed from `?seed=` URL param; otherwise generate a random seed; expose the active seed for display
- [ ] Build the section pattern library: straight, gentle curve L/R, sharp curve L/R, S-curve, hill up, hill down, crest — each emitting eased segments
- [ ] Implement the generator: stitch sections to exactly `COURSE_LENGTH_SEGMENTS`, with difficulty ramp `t = z / courseLength` biasing sharper/more frequent curves as `t` grows
- [ ] Keep the first ~100 segments straight and obstacle-free (warm-up); end with a short obstacle-free run-out
- [ ] Mark the final segment as the finish line; create the finish-banner pixel-art sprite and project it across the road like an entity
- [ ] Detect the player crossing the final segment; log "FINISHED" + elapsed time to console (temporary until Phase 9)
- [ ] Add a HUD course-progress bar (player Z / course length)
- [ ] Verify: loading the same `?seed=` twice produces an identical course (spot-check landmarks or hash the segment array)
- [ ] Verify: different seeds produce different courses
- [ ] Verify: full ride shows gentle start, sharper curves late, banner at the end, finish time logged

## Phase 6 — Obstacles + collision/wipeout

- [ ] Define obstacle entity type: kind (tree/rock/mogul), lane, world-Z
- [ ] Add obstacle placement to the generator (in the placement pass, after geometry): rows on specific lanes, density ramping with `t` (~4 → ~12 rows per 100 segments)
- [ ] Enforce solvability with reachability (spec §4.2): every obstacle row leaves ≥1 clear lane, and a clear lane in the next row within the Z window is reachable in time — (lanes of shift) × `LANE_CHANGE_SEGMENTS=3` ≤ segment gap between rows
- [ ] Enforce the jump-reach constraint (spec §4.2): no tree in a mogul's lane within `JUMP_REACH_EXTENDED=18` segments downstream of it; no tree in ANY lane within 18 segments downstream of a crest apex
- [ ] Enforce the blind landing zone (spec §4.2): all lanes obstacle-free for 20 segments after every crest apex
- [ ] Create pixel-art sprites for tree, rock, and mogul (32×32 base) and register them in BootScene
- [ ] Implement entity sprite projection (spec §3.5): screen X/Y/scale from the same projection math; curve offset interpolated between the segment's near-edge (`x`) and far-edge (`x + dx`) offsets by the entity's fractional Z within the segment (no per-segment snapping)
- [ ] Hide entities whose segment was crest-clipped (spec §3.4/§3.5) — in addition to hiding beyond draw distance/behind camera
- [ ] Depth-sort entity sprites far-to-near (player on top)
- [ ] Implement collision detection: same lane + world-Z within ~0.5 segment, skipped when airborne over a jumpable obstacle
- [ ] Tree collision → run-ending wipeout (temporary: freeze + console log; real game-over wired in Phase 9)
- [ ] Rock collision → temporary wipeout: speed drops to ~30%, ~1 s no-steer tumble animation, ~1 s collision immunity after recovery
- [ ] Mogul collision → stumble: ~25% speed loss, brief wobble, no control loss
- [ ] Jump clears rocks and moguls but never trees
- [ ] Jumping on/just before a mogul → no penalty + extended trick launch (~1,200 ms airtime, up to `JUMP_REACH_EXTENDED=18` segments at max speed)
- [ ] Crest auto-launch (spec §4.3): crossing a jumpable crest apex launches an extended trick jump with NO jump press required (moguls still require the press)
- [ ] Verify: watch an obstacle approach through a curve — it scales and slides correctly with the road, no stair-stepping across segment boundaries; obstacles vanish behind a crest along with the road
- [ ] Verify: deliberately hit each obstacle type and confirm its distinct outcome; jump a rock unharmed; mogul-launch works; crest auto-launches without input and the landing zone is obstacle-free
- [ ] Verify: full-course run always has a survivable, reachable line; density visibly rises late-course

## Phase 7 — AI riders (race + dodge, no combat)

- [ ] Create the AI rider entity: world-Z, lane, speed, per-rider parameters (cruise speed 90–105% of `MAX_SPEED`, aggression, reaction distance) drawn from the seeded RNG in the generator's placement pass
- [ ] Spawn 4 AI riders staggered around the player at the start line
- [ ] Implement race behavior: accelerate toward per-rider cruise speed
- [ ] Implement dodge behavior: look ahead a few segments; lane-change to an adjacent clear lane when an obstacle occupies the current lane
- [ ] Apply the player's obstacle collision rules to AI riders (tree removes a rival from the race; rock/mogul slow them)
- [ ] No AI-vs-AI combat or rider-collision (spec §4.5 v1 simplification): rivals ignore each other and may briefly share a lane
- [ ] Simulate riders outside draw distance without rendering (positions stay honest)
- [ ] Create palette-swapped rival sprites from the player base sheet and register them in BootScene
- [ ] Render AI riders via entity projection + depth sorting (crest-clipped like all entities)
- [ ] Track live race positions (player + 4 rivals by world-Z); log positions at finish (temporary until Phase 9)
- [ ] Verify: rivals race at visibly different paces (some ahead, some behind); a rival visibly dodges an obstacle
- [ ] Verify: logged finish positions match observation; riders re-entering draw distance appear plausibly, not teleported

## Phase 8 — Combat: bump/shove + weapon pickup

- [ ] Detect shove trigger 1 (lateral): player steers toward a rival in an adjacent lane within ~1 segment in Z → resolve exchange instead of lane change
- [ ] Detect shove trigger 2 (same-lane, spec §4.6): player and a rival occupy the same lane within ~1 segment in Z (rear approach / rival drifting in) → resolve the identical exchange instead of a pass-through
- [ ] Resolve exchange: faster (or armed) rider wins; loser knocked one lane away + ~20% speed loss
- [ ] Apply knockback clamps (spec §4.6): road edge → speed loss only; tree clamp — if the destination lane has a tree within ~2 segments downstream of the loser, no lane change + speed loss only; 2-lane (armed) knockback lands in the farthest tree-free lane
- [ ] Add ~0.5 s shove immunity to the loser, scoped per attacker: the same rival cannot re-shove within the window; a different rival can
- [ ] A rider knocked into a rock/mogul lane suffers that obstacle's normal collision; a rival that hits a tree within ~2 s of losing a shove to the player is removed from the race and credited as the player's knockout
- [ ] Airborne combat immunity (spec §4.3/§4.6): airborne player cannot initiate an exchange; an AI bump attempt against an airborne player whiffs with no effect
- [ ] Implement AI bump behavior: aggression-weighted timer (runtime randomness — NOT the seeded PRNG) drifts a rival into the player's lane when within ~2 segments; same exchange resolution when AI initiates
- [ ] Create the ski-pole pickup pixel-art sprite and register it in BootScene; generator's placement pass spawns pickups on a clear lane every ~300–450 segments (seeded)
- [ ] Implement pickup collection by lane + Z proximity, including while airborne; collecting arms the pole with 3 charges; re-pickup refreshes to 3
- [ ] Armed exchanges: the player auto-wins, knocks the victim two lanes (clamped) with double speed loss; EVERY exchange the armed player wins consumes a charge, whether player- or AI-initiated; revert to baseline at 0 charges
- [ ] Weapon charges persist through a rock tumble; they are only cleared by a run-ending wipeout (tree) or overwritten by a fresh pickup
- [ ] Show weapon charge count on the HUD
- [ ] Verify: steering into an adjacent rival resolves a shove (knockback + slowdown), not a lane swap; closing on a rival in the same lane resolves an exchange, not a pass-through; rivals bump the player back
- [ ] Verify: losing an exchange beside a tree row never dumps the loser into the tree lane (speed loss only); knocking a slowed rival into a line where they tree within ~2 s removes them and credits a knockout
- [ ] Verify: jumping makes an incoming AI bump whiff; a pickup is collected mid-jump
- [ ] Verify: pole pickup → 3 visibly stronger won exchanges with HUD counting 3→0 (including a charge consumed on an AI-initiated exchange the player wins); charges survive a rock tumble; then baseline bumps again

## Phase 9 — Scoring + finish/restart flow + bare-bones UI

- [ ] Implement the scoring system with values from `config.ts`: combat hit 250, knockout 500 awarded on top of the 250 hit (750 total, credited when a rival trees within ~2 s of losing a shove to the player), near-miss 100, trick jump 150 (+50 per extra 0.25 s airtime)
- [ ] Implement near-miss detection as a one-shot check per entity: evaluated exactly once, when the obstacle's/rival's world-Z crosses the player's world-Z — pass within one lane (or graze a rival without contact) at ≥70% max speed; never re-triggers per frame
- [ ] Implement trick-jump detection: airtime launched off a mogul or crest (including crest auto-launches), scored on landing by airtime
- [ ] Build the race HUD: running score, speed, progress bar, weapon charges
- [ ] Implement the position bonus: `(5 − finishPosition) × 250` (1st = 1,000 ... 5th = 0), awarded only on a completed finish
- [ ] Implement finish flow: crossing the line → Result screen with score breakdown by category, finish time, time bonus (`max(0, PAR_TIME − finishTime) × 50`, `PAR_TIME=130`), completion bonus (2,000), race position (1st–5th) and its point award
- [ ] Implement wipeout flow: run-ending tree collision → Result screen in "wiped out" mode — accumulated event points only, no completion/time/position bonus, race position still computed and shown (unrewarded), frozen at the standings at the moment of the wipeout
- [ ] Track session-best score in memory (no persistence) and show it on the Result screen
- [ ] Build the Title scene: game name, current seed, "press key to start"
- [ ] Implement restart from the Result screen: same seed or new seed → fresh `RaceScene`
- [ ] Remove the temporary console-log stand-ins from Phases 5–7 (finish log, wipeout freeze, position log)
- [ ] Verify: finish a race and hand-check the score breakdown math (a knockout counts 750 total; 1st place adds 1,000 position points); position shown matches observation; a faster run earns a larger time bonus
- [ ] Verify: graze a long obstacle row → exactly one near-miss per entity, no rapid re-triggering
- [ ] Verify: hit a tree → wipeout screen with partial score only (no position points) and the frozen race position shown
- [ ] Verify: same-seed restart replays the identical course; new-seed restart does not
- [ ] Verify: every scoring event visibly ticks the HUD when performed
- [ ] Final pass: `npm run build` clean; no console errors across several full runs; check every "In scope for v1" bullet in the spec (§6) is present
