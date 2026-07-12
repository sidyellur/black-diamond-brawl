# Black Diamond Brawl v2 — Visual Polish Design

## 1. Goal & motivation

v1 (all 9 phases) is complete and merged: the game is mechanically solid — segment-based
pseudo-3D rendering, procedural track generation with a rigorously verified solvability
guarantee, obstacles, AI riders, combat, scoring, and a finish/restart flow. But visually
it reads as a prototype, not a game: the player/rider sprites are flat procedurally-drawn
rectangles (a colored box body, a square head, a line for a board), there is no background
scenery at all (flat sky-blue color), the HUD is unstyled monospace text, and there is no
"juice" (no screen shake, particles, or camera feedback on hits/speed).

v2's goal is to close that visual gap: real pixel-art sprites, a parallax mountain
background, hit/speed feedback effects, and a styled UI — without touching v1's game
logic (rendering math, collision, AI, combat, scoring all stay as-is). Audio is explicitly
out of scope for v2 (may become a v3).

## 2. Architecture change

Every sprite in v1 (player, AI riders, obstacles, pickup) is drawn **procedurally** via
Phaser's Graphics API — code drawing rectangles/shapes at runtime, not image files. v2
switches these to real image-based sprites:

- PNG spritesheets/individual sprites are loaded in `BootScene`'s `preload()`.
- The procedural draw calls in `src/entities/playerSprite.ts`, `src/entities/aiRiderRenderer.ts`,
  `src/entities/obstacleSprites.ts`, and `src/entities/pickupSprite.ts` are replaced with
  texture-based Phaser sprites (`this.add.sprite(...)` + frame/texture keys instead of
  `Graphics.fillRect`/similar calls).
- The existing projection/scaling/depth-sorting math in `src/render/projectEntity.ts` is
  **unchanged** — it already computes screen X/Y/scale from world coordinates; it doesn't
  care whether the resulting sprite is texture-based or Graphics-based.
- Background gets a **new render layer**: several parallax `Image`/`TileSprite` layers
  drawn behind the road (far mountains → mid-ground → near snow), each scrolling
  horizontally at a different fraction of the camera's speed, and shifting with the same
  accumulated curve offset the road uses (scaled down per layer by a "depth" factor) so
  the background doesn't look pasted-on during turns.

## 3. Asset packs (all CC0 — verified via a broad multi-source research pass; no
free/open-license snowboarder-specific character pack exists anywhere, confirmed across
Kenney, itch.io, OpenGameArt, and CraftPix's free tier)

| Purpose | Pack | Source | License |
| --- | --- | --- | --- |
| Character (rider) + basic obstacles/terrain | **Tiny Ski** | https://kenney-assets.itch.io/tiny-ski | CC0 1.0 (public domain) |
| Extra winter terrain/obstacle variety | **Platformer Art: Winter** | https://kenney.nl/assets/platformer-art-winter | CC0 1.0 (public domain) |
| Parallax background | **Pixel Art Mountains Parallax** (DustDFG) | https://opengameart.org/content/pixel-art-mountains-parallax | CC0 (public domain) |
| UI/HUD | **UI Pack** or **Pixel UI Pack** (Kenney) | https://kenney-assets.itch.io/ui-pack / https://kenney.nl/assets/pixel-ui-pack | CC0 1.0 (public domain) |

All four are CC0 — no attribution legally required, safe for a hobby project with zero
licensing risk. All share (or are close enough to) a consistent low-resolution pixel-art
house style.

**Known gap, explicitly accepted:** Tiny Ski's character is a **skier**, not a
snowboarder — no free/open-license snowboarder sprite pack exists anywhere (confirmed by
a dedicated deep-research pass across Kenney, itch.io, OpenGameArt, and CraftPix's free
tier). This is the best available free option. A future upgrade path exists (e.g. a
custom Blender-modeled-and-rendered snowboarder sprite sheet) but is out of scope for v2
— tracked as an open question in §7.

**Known gap:** no free ski-pole/melee-weapon pickup icon was found in any researched
pack. The pickup sprite will be a small custom procedurally-drawn icon (same Graphics
technique v1 already used for placeholder sprites), not sourced from a pack.

## 4. Juice / VFX (pure code, no additional asset packs required)

- **Screen shake** on tree/rock collisions — Phaser's built-in camera shake, brief and
  sharp, distinct intensity for run-ending (tree) vs. temporary (rock) wipeouts.
- **Particle effects** (small code-generated particle textures, tinted — no external
  assets needed): snow spray trailing behind the player while moving, an impact burst on
  any collision, a spark/flash on a landed combat hit, a sparkle on trick-jump landings.
- **Speed sensation**: a subtle speed-line/vignette overlay whose intensity scales with
  current speed as a fraction of `MAX_SPEED`.
- **Camera lean**: slight camera tilt/roll during lane-shift tweens and jumps for a more
  dynamic feel — cosmetic only, must not affect the actual projection math or gameplay.

## 5. UI/HUD polish

- **Title screen**: a UI-pack panel behind the title text, seed display, and "press any
  key" prompt, replacing the current flat sky-blue background.
- **Race HUD**: score, speed, progress bar, and weapon charge count rendered inside
  styled UI-pack panels/frames instead of raw white monospace `Phaser.Text`.
- **Result screen**: a styled panel for the score breakdown (finish/wipeout modes both),
  using the same UI kit for visual consistency with the title/HUD.

## 6. Phased breakdown

1. **Phase 0 — Asset curation & pipeline spike.** Download the four approved CC0 packs
   into the repo (with a `THIRD_PARTY_LICENSES`-style note recording each pack's source
   and license, even though CC0 requires no attribution — for the project's own record).
   Wire up Phaser image/spritesheet loading in `BootScene`. Prove the image-based sprite
   pipeline works end-to-end by swapping ONE sprite (e.g. the finish banner, the simplest
   entity) from procedural to image-based before committing to the full rollout — this
   de-risks the architecture change before touching the player/AI/obstacle code that v1's
   solvability/collision guarantees depend on.
2. **Phase 1 — Rider + AI rider sprites.** Replace the procedural player sprite
   (`playerSprite.ts`) with real image-based frames adapted from Tiny Ski (lean-left/
   center/right, jump, tumble poses). AI riders continue to be palette-swapped variants
   of the same base sheet, now using real art instead of procedural shapes.
3. **Phase 2 — Obstacle + pickup + finish banner sprites.** Swap tree/rock/mogul sprites
   to Tiny Ski/Platformer Art Winter equivalents; the ski-pole pickup gets a custom
   procedural icon (see §3 gap); finish banner uses the pipeline proven in Phase 0.
4. **Phase 3 — Parallax background.** Multi-layer scrolling scenery from Pixel Art
   Mountains Parallax, shifting horizontally with the road's curve offset per layer at a
   depth-scaled fraction, so it reads as behind the road rather than static wallpaper.
5. **Phase 4 — Juice/VFX.** Screen shake, particle effects (snow spray, impact, combat
   hit spark, trick sparkle), speed-line overlay, camera lean on lane-shift/jump.
6. **Phase 5 — UI/HUD polish.** Title screen, race HUD, and result screen restyled with
   the UI pack.

Each phase is independently verifiable in the browser before moving to the next,
following the same build → verify pattern v1's implementation plan used.

## 7. Explicitly out of scope for v2

- Audio (music/SFX) — deferred, possible v3.
- A genuine snowboarder-specific character (no free pack exists; Tiny Ski's skier is the
  accepted v2 baseline).
- Any change to game logic: rendering math, collision rules, AI behavior, combat
  resolution, scoring, or track generation are all v1-complete and untouched by v2.
- Blender-based custom asset modeling — considered and explicitly deferred (see below);
  requires local tooling setup (Blender + addon + MCP configuration) not currently
  available in-session.

## 8. Open questions / assumptions

1. **Skier vs. snowboarder (accepted gap):** ship v2 with Tiny Ski's skier as the
   player/AI character. A custom snowboarder (via hand art, a different future pack, or a
   Blender-modeled-and-rendered sprite sheet) is a possible later upgrade, not part of v2.
2. **Ski-pole pickup icon:** no free pack includes one; v2 draws a small custom
   procedural icon reusing v1's existing Graphics-drawing technique, rather than sourcing
   external art for this one item.
3. **Exact background layer count/depth-scaling factors** are implementation-time tuning
   decisions (not pinned to specific numbers here), similar to how v1 treated its
   rendering/tuning constants as adjustable starting values in `config.ts`.
4. **Kenney UI Pack vs. Pixel UI Pack** — both are CC0 and viable; the exact choice is an
   implementation-time decision based on which better fits the HUD's specific needs once
   Phase 5 starts (both are free to try).
