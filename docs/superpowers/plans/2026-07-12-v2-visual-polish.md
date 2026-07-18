# Black Diamond Brawl v2 — Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v1's procedurally-drawn placeholder sprites and flat backdrop with real
CC0 pixel art, a parallax mountain background, a snow-textured track surface, hit/speed
juice, and a styled UI — without touching any v1 game logic.

**Architecture:** Every current sprite (player, AI riders, obstacles, pickup) is drawn at
runtime with Phaser's `Graphics` API; this plan swaps those for real image-based textures
loaded from downloaded CC0 asset packs, while leaving the world-to-screen projection math
(`src/render/project.ts`, `src/render/projectEntity.ts`) completely untouched — it already
computes screen X/Y/scale from world coordinates and doesn't care whether the resulting
sprite is texture-based or Graphics-based. The road surface and background are new
rendering additions layered around the existing `RoadRenderer`, not replacements for it.

**Tech Stack:** TypeScript, Phaser 3, Vite (unchanged from v1). New: four downloaded CC0
asset packs (PNG/atlas files served from `public/assets/`).

## Global Constraints

- Game logic is frozen: rendering math (curve/hill/crest-clip algorithm), collision rules,
  AI behavior, combat resolution, scoring, and track generation are v1-complete. No task
  in this plan may change behavior in `src/track/generator.ts`, `src/track/placement.ts`,
  `src/entities/collision.ts`, `src/entities/combat.ts`, `src/entities/scoring.ts`, or the
  projection formulas in `src/render/project.ts` — only how things are *drawn*.
- All four asset packs are CC0 1.0 Universal (public domain) — confirmed via a dedicated
  research pass. No attribution is legally required, but `docs/THIRD_PARTY_LICENSES.md`
  (created in Task 0) records source/license for the project's own reference:
  - Tiny Ski — https://kenney-assets.itch.io/tiny-ski
  - Platformer Art: Winter — https://kenney.nl/assets/platformer-art-winter
  - Pixel Art Mountains Parallax (DustDFG) — https://opengameart.org/content/pixel-art-mountains-parallax
  - UI Pack or Pixel UI Pack (Kenney) — https://kenney-assets.itch.io/ui-pack / https://kenney.nl/assets/pixel-ui-pack
- **No free/CC0 snowboarder-specific character pack exists** (confirmed by prior deep
  research across Kenney, itch.io, OpenGameArt, CraftPix free tier). Tiny Ski's skier is
  the accepted v2 baseline — do not block a task on trying to find or draw a snowboarder.
- **No free ski-pole/weapon pickup icon exists in any researched pack.** The pickup sprite
  stays a small custom procedurally-drawn icon (Task 0 keeps `pickupSprite.ts`'s existing
  Graphics-drawn approach) — do not source external art for this one item.
- **Testing convention for this plan (adapted from v1):** most of this work is rendering/
  visual — there is no meaningful pixel-output assertion to write. Follow v1's proven
  pattern instead: after each task's code changes, run `npm run build` (must pass clean —
  `tsc && vite build`) and visually verify the specific change in a running `npm run dev`
  session (Chrome browser automation if available; otherwise describe expected visual
  result from code review and say so explicitly in the task report). Where a task
  introduces genuine reusable *logic* (not just drawing calls) — e.g. the parallax
  depth-scaling formula in Task 5 — write a small focused check for that formula the same
  way v1's `scripts/verifySolvability.ts` checked placement logic, but don't force a fake
  unit test onto pure rendering code.
- Every downloaded asset's exact internal frame names/layout can only be discovered by
  opening the actual downloaded file — this plan cannot pre-specify a Kenney atlas's inner
  frame names without having downloaded it first (Task 0 downloads them). Later tasks
  explicitly call out "inspect the real file, adapt as needed" rather than assuming
  specific frame names.
- Follow existing project conventions: sprites for ground-planted entities use
  `setOrigin(0.5, 1)` (base of sprite sits on the road surface), texture generation
  functions are named `generateXSpriteSheet(scene)` and no-op if the texture already
  exists (`scene.textures.exists(key)`), and renderers pool `Phaser.GameObjects.Sprite`
  instances rather than creating/destroying per frame (see `ObstacleRenderer`/
  `PickupRenderer`/`AIRiderRenderer` for the existing pattern).
- Downloading files requires explicit permission. The four packs above were named and
  approved by the developer during design review, which covers Task 0's downloads — but
  if any pack's actual download requires more than a direct file fetch (e.g. an itch.io
  "claim"/payment-page flow rather than a static zip URL), stop and ask rather than
  attempting to work around it.

---

### Task 0: Asset curation, licensing record, and pipeline spike

**Files:**
- Create: `public/assets/tiny-ski/` (extracted pack contents)
- Create: `public/assets/platformer-winter/` (extracted pack contents)
- Create: `public/assets/parallax-mountains/` (extracted pack contents)
- Create: `public/assets/ui-pack/` (extracted pack contents)
- Create: `docs/THIRD_PARTY_LICENSES.md`
- Modify: `src/scenes/BootScene.ts:11-16` (`preload()` — currently empty except a comment)
- Modify: `src/entities/pickupSprite.ts` (proof-of-pipeline target — see Step 5)

**Interfaces:**
- Produces: an established `preload()` pattern (`this.load.image(key, url)` /
  `this.load.atlas(key, url, atlasUrl)` / `this.load.spritesheet(key, url, {frameWidth,
  frameHeight})`) that Tasks 1–3 replicate for their own textures.
- Produces: `docs/THIRD_PARTY_LICENSES.md` recording each pack's name, source URL,
  license, and date accessed.
- Does NOT change `PICKUP_TEXTURE_KEY`, `PICKUP_FRAME`, or `generatePickupSpriteSheet`'s
  signature (`(scene: Phaser.Scene): void`) — `PickupRenderer` and `RaceScene` must not
  need any changes.

- [ ] **Step 1: Download and extract the four packs**

  For each pack in the Global Constraints table, fetch the zip and extract it into its
  `public/assets/<pack-name>/` directory. Kenney.nl packs (Tiny Ski, Platformer Art:
  Winter, and Kenney's UI packs) are directly downloadable zips — fetch with `curl -L -o
  pack.zip <url>` from the pack's actual download link (visit the page first to find the
  real asset URL; Kenney's pages link directly to a `.zip`). OpenGameArt's DustDFG
  parallax pack is also a direct-download zip from its content page. If any pack instead
  requires clicking through an itch.io "claim"/payment-page UI rather than a static file
  URL, stop and tell the developer rather than trying to script around it.

  Verify: `ls public/assets/*/` shows extracted PNG (and any accompanying `.xml`/`.json`
  atlas) files for all four packs, not just zip files.

- [ ] **Step 2: Record licenses**

  Create `docs/THIRD_PARTY_LICENSES.md`:

  ```markdown
  # Third-Party Assets

  All packs below are CC0 1.0 Universal (public domain) — no attribution required. Recorded
  here for the project's own reference.

  | Pack | Source | License | Used for |
  | --- | --- | --- | --- |
  | Tiny Ski | https://kenney-assets.itch.io/tiny-ski | CC0 1.0 | Rider/AI rider character, base terrain |
  | Platformer Art: Winter | https://kenney.nl/assets/platformer-art-winter | CC0 1.0 | Obstacle/terrain variety |
  | Pixel Art Mountains Parallax (DustDFG) | https://opengameart.org/content/pixel-art-mountains-parallax | CC0 | Parallax background |
  | UI Pack / Pixel UI Pack (Kenney) | https://kenney-assets.itch.io/ui-pack | CC0 1.0 | HUD/title/result screens |
  ```

  Verify: file exists and lists all four packs with working source URLs.

- [ ] **Step 3: Inspect each pack's file listing**

  Run `find public/assets -type f | sort` and read any included `.xml`/`.json`/`.txt`
  atlas or readme files. Note (in your task report, not in code) what each pack actually
  contains — this is the ground truth Tasks 1–4 will need, since no plan can predict a
  third-party pack's exact internal frame names without opening it.

  Verify: your task report lists, for each pack, the file count and format (single PNG?
  spritesheet + XML atlas? individual per-sprite PNGs?).

- [ ] **Step 4: Load one small proof texture in BootScene**

  Pick the simplest single-purpose image from Tiny Ski or Platformer Art: Winter that
  could plausibly stand in for a ski-pole/pickup icon (or any single small sprite — the
  goal here is proving the *loading pipeline*, not the final pickup art). In
  `src/scenes/BootScene.ts`, add to `preload()`:

  ```typescript
  preload(): void {
    this.load.image('v2-proof-sprite', 'assets/tiny-ski/<actual-file-name>.png');
  }
  ```

  Verify: `npm run build` passes with no errors.

- [ ] **Step 5: Swap the pickup sprite to prove the texture-based pipeline end-to-end**

  The pickup (`src/entities/pickupSprite.ts`) is the simplest existing sprite in the
  codebase (single frame, no lean/jump/tumble variants) — use it as the pipeline proof so
  Tasks 1–2 can copy a working pattern. Modify `generatePickupSpriteSheet` to register
  `PICKUP_FRAME` against the loaded `v2-proof-sprite` texture instead of drawing it with
  Graphics, e.g.:

  ```typescript
  export function generatePickupSpriteSheet(scene: Phaser.Scene): void {
    if (scene.textures.exists(PICKUP_TEXTURE_KEY)) {
      return;
    }
    const source = scene.textures.get('v2-proof-sprite').source[0];
    scene.textures.addSpriteSheetFromAtlas /* or the simpler path below */;
    // Simplest working approach: just re-key the loaded image directly as the
    // pickup texture/frame, since it's a single-frame sprite:
    scene.textures.addImage(PICKUP_TEXTURE_KEY, source.image as HTMLImageElement);
    scene.textures.get(PICKUP_TEXTURE_KEY).add(
      PICKUP_FRAME, 0, 0, 0, source.width, source.height
    );
  }
  ```

  (Adjust to whatever Phaser texture API actually works cleanly once you're looking at
  the real loaded image — the exact call may differ; the requirement is that
  `PICKUP_TEXTURE_KEY`/`PICKUP_FRAME` end up pointing at real image pixels instead of
  Graphics-drawn ones, and `PickupRenderer` needs zero changes to pick it up.)

  Verify: run `npm run dev`, drive to a pickup on the track (or temporarily lower
  `PICKUP_MIN_GAP_SEGMENTS` in a local scratch edit — revert before committing), and
  confirm the pickup renders as the real downloaded image, correctly scaled/positioned by
  the existing `projectEntity` + `PickupRenderer` code with zero changes to either.
  Screenshot it if Chrome automation is available.

- [ ] **Step 6: Commit**

  ```bash
  git add public/assets docs/THIRD_PARTY_LICENSES.md src/scenes/BootScene.ts src/entities/pickupSprite.ts
  git commit -m "Add v2 asset packs, licensing record, and prove the image-sprite pipeline"
  ```

---

### Task 1: Rider + AI rider sprites

**Files:**
- Modify: `src/entities/playerSprite.ts` (replace `generateRiderSpriteSheet`'s Graphics
  drawing with real texture frames from Tiny Ski)
- Modify: `src/scenes/BootScene.ts` (preload the Tiny Ski character source)

**Interfaces:**
- Consumes: the `preload()` / texture-registration pattern proven in Task 0.
- Produces: **unchanged** `PLAYER_TEXTURE_KEY`, `PLAYER_FRAMES` (`LEAN_LEFT`, `CENTER`,
  `LEAN_RIGHT`, `JUMP`, `TUMBLE`), `AI_RIDER_TEXTURE_KEYS`, `generatePlayerSpriteSheet(scene)`,
  and `generateAIRiderSpriteSheets(scene)` — every consumer of these (player rendering in
  `RaceScene.ts`, `src/entities/aiRiderRenderer.ts`) must need zero changes.

- [ ] **Step 1: Inspect Tiny Ski's character frames**

  Open `public/assets/tiny-ski/` and identify which frames show the skier in: a neutral/
  center pose, a turning/leaning pose (there may only be one direction — mirror it for the
  other via `setFlipX`), a jump/airborne pose, and a fallen/crashed pose. Note the exact
  file names or atlas frame names in your task report.

- [ ] **Step 2: Load the character source in BootScene**

  ```typescript
  // in preload()
  this.load.atlas('tiny-ski-chars', 'assets/tiny-ski/<spritesheet>.png', 'assets/tiny-ski/<spritesheet>.xml');
  // or this.load.image(...) per-frame if the pack ships individual PNGs instead of an atlas
  ```

  Verify: `npm run build` passes; `npm run dev` shows no 404s in the console for the new
  asset paths (check via `read_console_messages` if Chrome automation is available).

- [ ] **Step 3: Rebuild the player sprite sheet from real frames**

  Rewrite `generateRiderSpriteSheet` (called by both `generatePlayerSpriteSheet` and
  `generateAIRiderSpriteSheets`) so that instead of calling `drawFrame`/`drawRider`/
  `drawTumble` with Graphics, it composites the five named `PLAYER_FRAMES` from the real
  Tiny Ski source frames identified in Step 1 into a texture keyed the same way the old
  code did (`PLAYER_TEXTURE_KEY` for the player, one of `AI_RIDER_TEXTURE_KEYS` per AI
  rider). If Tiny Ski has no distinct lean-left/lean-right art, use the same source frame
  for both and rely on `sprite.setFlipX(true)` at render time for one direction (check
  where `PLAYER_FRAMES.LEAN_LEFT`/`LEAN_RIGHT` are consumed in `player.ts`/`RaceScene.ts`
  and add the flip there if needed — this is a legitimate, common technique, not a
  workaround to avoid).

- [ ] **Step 4: Palette-swap AI riders**

  Try Phaser's `sprite.setTint(color)` on the shared Tiny Ski texture, reusing the same
  four colors already defined in `AI_RIDER_PALETTES` (`0x4f7fd9`, `0x4fd97a`, `0xb44fd9`,
  `0xd9a54f`). Visually check whether tinting reads well against the pixel-art suit —
  Phaser's tint is a multiply, which can wash out photographic-style shading but usually
  works fine on flat-shaded pixel art. If it looks bad, fall back to generating 4 separate
  recolored texture copies at load time instead (same outcome, more setup cost) — use
  your judgment and note which approach you took and why in your report.

- [ ] **Step 5: Verify in the browser**

  Run `npm run dev`, drive the player through a lane-shift (confirm lean-left/right frames
  swap), a jump (confirm the jump frame and, on landing/crash, the tumble frame), and get
  a screenshot showing at least 2 AI riders in frame simultaneously with visibly different
  colors from the player and each other. If Chrome automation isn't available, describe
  expected results from code review and say so explicitly.

- [ ] **Step 6: Commit**

  ```bash
  git add src/entities/playerSprite.ts src/scenes/BootScene.ts
  git commit -m "Replace procedural rider sprites with Tiny Ski pixel art"
  ```

---

### Task 2: Obstacle + pickup + finish banner sprites

**Files:**
- Modify: `src/entities/obstacleSprites.ts` (replace `drawObstacle`'s Graphics drawing
  with real Tiny Ski/Platformer Art: Winter frames)
- Modify: `src/entities/pickupSprite.ts` (replace Task 0's proof texture with the actual
  final ski-pole-adjacent icon choice, if different from the Task 0 placeholder pick)
- Modify: `src/track/finishBanner.ts` (optional — see Step 3)
- Modify: `src/scenes/BootScene.ts` (preload the terrain/obstacle source)

**Interfaces:**
- Produces: **unchanged** `OBSTACLE_TEXTURE_KEY`, `OBSTACLE_FRAMES` (`tree`/`rock`/`mogul`),
  `generateObstacleSpriteSheet(scene)`, `PICKUP_TEXTURE_KEY`, `PICKUP_FRAME`,
  `generatePickupSpriteSheet(scene)` — `ObstacleRenderer` and `PickupRenderer` need zero
  changes.

- [ ] **Step 1: Inspect Platformer Art: Winter and Tiny Ski for tree/rock/mogul-equivalent art**

  Identify a pine-tree-like sprite, a rock/boulder sprite, and a snow-mound/bump sprite
  (moguls may not have an exact match — a rounded snow-drift tile is an acceptable stand-in;
  note your choice). Record the exact file/frame names in your report.

- [ ] **Step 2: Rebuild `generateObstacleSpriteSheet` from real frames**

  Same technique as Task 1 Step 3: replace the `drawObstacle` Graphics calls with
  compositing the real source frames into `OBSTACLE_TEXTURE_KEY`'s three named sub-frames
  (`OBSTACLE_FRAMES.tree`/`.rock`/`.mogul`). Preserve the existing convention that each
  frame's art sits at the bottom of its frame box (sprites are anchored `setOrigin(0.5,
  1)` by `ObstacleRenderer`, so the art needs to "stand" at the frame's bottom edge the
  same way the old procedural art did).

  Verify: `npm run build` passes clean.

- [ ] **Step 3 (optional, lower priority): Upgrade the finish banner**

  `FinishBanner` currently draws a checkered Graphics quad directly with `project()` calls
  (not a sprite/texture — architecturally different from the other entities). Leave it as
  Graphics-drawn unless a suitable banner/flag sprite exists in one of the packs and can
  be projected as a simple billboard without meaningfully more work than the current
  checker pattern — this is explicitly optional and lower priority than the tree/rock/
  mogul/pickup art, since the banner isn't part of the "looks like a prototype" complaint
  that motivated v2.

- [ ] **Step 4: Verify in the browser**

  Drive past all three obstacle types and a pickup; screenshot each showing the real art,
  correctly scaled through a curve (reusing `projectEntity`'s existing interpolation —
  confirm no stair-stepping, same visual check Task 6 of v1 already established).

- [ ] **Step 5: Commit**

  ```bash
  git add src/entities/obstacleSprites.ts src/entities/pickupSprite.ts src/scenes/BootScene.ts
  git commit -m "Replace procedural obstacle/pickup sprites with real pixel art"
  ```

---

### Task 3: Road surface texture

**Files:**
- Modify: `src/render/RoadRenderer.ts:170-192` (the three `fillTrapezoid` calls per drawn
  segment — off-piste, rumble strip, snow road)
- Modify: `src/scenes/BootScene.ts` (preload a snow-texture swatch if the `TileSprite`
  approach is chosen — see below)

**Interfaces:**
- Produces: **unchanged** `RenderResult`/`DrawnSegment` shape (`clippedSegments`,
  `drawnSegments` with `nearOffsetX`/`farOffsetX`/`clipped`) — `ObstacleRenderer`,
  `AIRiderRenderer`, `PickupRenderer`, and `projectEntity` all depend on this and must
  need zero changes.

- [ ] **Step 1: Read the current fill code**

  `RoadRenderer.render()` already fills the road's center strip with `SNOW_LIGHT`/
  `SNOW_DARK` (`0xf5f9ff`/`0xe4ecf7`) — these ARE snow colors already, just flat with no
  texture/grain. "Snow on the track" (the developer's ask) means adding visible texture
  to what's already conceptually snow, not changing the base palette.

- [ ] **Step 2: Pick ONE of these two pragmatic approaches (do not attempt true
  per-trapezoid texture-mapping — out of scope per the design spec)**

  **Option A — textured `Graphics` fill variation:** instead of two flat alternating
  colors, sample 3-4 near-white/pale-blue shades from a snow texture swatch in one of the
  packs and use them for a subtle dithered/patterned fill within `fillTrapezoid` (e.g.
  alternate in a checker or noise-like pattern at a finer granularity than the existing
  per-segment color-band alternation). Stays entirely within the existing `Graphics` API,
  lowest implementation risk.

  **Option B — masked `TileSprite` overlay:** add a single `Phaser.GameObjects.TileSprite`
  covering the full visible road area, using a tiled snow-texture image loaded from a
  pack, and mask it to the road's actual silhouette each frame using a `Phaser.Display.Masks.GeometryMask`
  built from the same trapezoid points `fillTrapezoid` already computes. More visually
  authentic texture, more implementation complexity (per-frame mask geometry updates).

  Try Option A first — it's a smaller, lower-risk change. If it doesn't look
  meaningfully better than the current flat fill once you see it running, escalate to
  Option B. Either way, curves/hills/crest-clipping geometry (`RoadRenderer`'s core
  algorithm) must NOT change — only the color/fill passed to `fillTrapezoid` for the
  center "snow road" strip (and optionally the off-piste strip).

- [ ] **Step 3: Implement the chosen approach**

  (Concrete code depends on which option — Option A is a small edit to the color values/
  fill call inside the existing loop; Option B needs a new small module, e.g.
  `src/render/roadTexture.ts`, that `RaceScene.ts` calls alongside `roadRenderer.render()`
  each frame, passing it the same `near`/`far` trapezoid points.)

  Verify: `npm run build` passes clean.

- [ ] **Step 4: Verify in the browser**

  Confirm the road visibly reads as snow-textured (not just flat white/pale-blue) while
  driving through straights, curves, and over a hill/crest — curve tiling and crest
  clipping must look exactly as they did before this task (no new cracks, no obstacles/
  riders suddenly hidden or misaligned). This is the same class of regression Task 6/7 of
  v1 already had to protect against when they touched shared rendering code.

- [ ] **Step 5: Commit**

  ```bash
  git add src/render/RoadRenderer.ts src/scenes/BootScene.ts
  # (add src/render/roadTexture.ts if Option B)
  git commit -m "Add snow texture to the road surface fill"
  ```

---

### Task 4: Parallax background

**Files:**
- Create: `src/render/parallaxBackground.ts`
- Modify: `src/scenes/RaceScene.ts` (instantiate the new background layer, call its
  update alongside `roadRenderer.render()`, replace the flat `setBackgroundColor(SKY_COLOR)`
  call at `RaceScene.ts:122`)
- Modify: `src/scenes/BootScene.ts` (preload the parallax layer images)

**Interfaces:**
- Consumes: the camera's current `camX`/`camZ` and the same accumulated curve-offset
  concept `RoadRenderer` computes (does not need `RoadRenderer`'s exact per-segment
  offsets — a simpler, layer-level approximation is fine here, see Step 2).
- Produces: a `ParallaxBackground` class with a `render(camX: number, camZ: number):
  void` method and a `setDepth(depth: number): void` method, called from `RaceScene.ts`
  before `roadRenderer.render()` in the frame's draw order (background must be visually
  behind the road).

- [ ] **Step 1: Inspect the Pixel Art Mountains Parallax pack**

  Note how many distinct layers it ships (the design spec's research found "5 transparent
  PNG layers... 384x216px") and their intended back-to-front order.

- [ ] **Step 2: Load the layers and build the parallax scroll**

  In `BootScene.preload()`, load each layer image with a distinct key (e.g.
  `bg-layer-0`...`bg-layer-4`, far to near). In `src/render/parallaxBackground.ts`:

  ```typescript
  import Phaser from 'phaser';

  const LAYER_KEYS = ['bg-layer-0', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-layer-4'];
  // Far layers scroll slower (smaller factor); near layers scroll faster, closer to 1.
  const SCROLL_FACTORS = [0.05, 0.1, 0.2, 0.35, 0.5];

  export class ParallaxBackground {
    private readonly layers: Phaser.GameObjects.TileSprite[];

    constructor(scene: Phaser.Scene, screenW: number, screenH: number) {
      this.layers = LAYER_KEYS.map((key) =>
        scene.add.tileSprite(0, 0, screenW, screenH, key).setOrigin(0, 0)
      );
    }

    setDepth(depth: number): void {
      this.layers.forEach((layer, i) => layer.setDepth(depth + i));
    }

    /** camX/camZ are the same camera state RoadRenderer.render() receives. */
    render(camX: number, camZ: number): void {
      this.layers.forEach((layer, i) => {
        layer.tilePositionX = camZ * SCROLL_FACTORS[i] * 0.01 + camX * SCROLL_FACTORS[i];
      });
    }
  }
  ```

  (The exact scroll-factor tuning and the camX curve-coupling coefficient are
  implementation-time judgment calls — start with the values above, then adjust by eye
  until it reads as "layers of depth" rather than either static or nauseating. This is
  the kind of tunable v1 always treated as an adjustable starting value, not a fixed
  requirement.)

- [ ] **Step 3: Wire into RaceScene**

  Replace `this.cameras.main.setBackgroundColor(SKY_COLOR)` (or keep it as a base color
  behind the lowest parallax layer, if the pack's furthest layer has transparency) with
  `this.parallaxBackground = new ParallaxBackground(this, SCREEN_W, SCREEN_H)`, call
  `this.parallaxBackground.setDepth(<below ROAD_DEPTH>)` in `create()`, and
  `this.parallaxBackground.render(camX, camZ)` each frame before `this.roadRenderer.render(...)`.

  Verify: `npm run build` passes clean.

- [ ] **Step 4: Verify in the browser**

  Confirm layered mountains/scenery are visible behind the road, that farther layers move
  noticeably slower than nearer ones while driving, and that the effect doesn't look
  jarring/pasted-on through a curve. Screenshot if Chrome automation is available.

- [ ] **Step 5: Commit**

  ```bash
  git add src/render/parallaxBackground.ts src/scenes/RaceScene.ts src/scenes/BootScene.ts
  git commit -m "Add parallax mountain background"
  ```

---

### Task 5: Juice / VFX

**Files:**
- Create: `src/effects/screenShake.ts`
- Create: `src/effects/particles.ts`
- Create: `src/effects/speedLines.ts`
- Modify: `src/scenes/RaceScene.ts` (call the new effect modules at the existing
  collision/combat/jump/speed-update call sites)

**Interfaces:**
- Produces: small focused functions/classes, each taking the `Phaser.Scene` (or camera/
  emitter manager) plus the minimal data needed to trigger — e.g.
  `triggerScreenShake(scene: Phaser.Scene, intensity: 'tree' | 'rock'): void`,
  `emitImpactBurst(scene: Phaser.Scene, screenX: number, screenY: number): void`,
  `emitSnowSpray(scene: Phaser.Scene, screenX: number, screenY: number): void`. RaceScene
  calls these from its EXISTING collision/combat/jump handling — this task does not add
  new gameplay events, only visual reactions to events that already fire.

- [ ] **Step 1: Screen shake**

  ```typescript
  // src/effects/screenShake.ts
  import Phaser from 'phaser';

  const SHAKE_TREE = { duration: 220, intensity: 0.02 };
  const SHAKE_ROCK = { duration: 140, intensity: 0.01 };

  export function triggerScreenShake(scene: Phaser.Scene, kind: 'tree' | 'rock'): void {
    const { duration, intensity } = kind === 'tree' ? SHAKE_TREE : SHAKE_ROCK;
    scene.cameras.main.shake(duration, intensity);
  }
  ```

  Call `triggerScreenShake(this, 'tree')` / `triggerScreenShake(this, 'rock')` from
  `RaceScene.ts` at the existing tree/rock collision handling call sites (find where
  `collision.ts`'s tree/rock outcomes are already consumed — do not change
  `collision.ts` itself, only react to its existing result in the scene).

  Verify: `npm run build` passes; hit a tree and a rock in a dev-server playtest, confirm
  visibly different shake intensity/duration between the two.

- [ ] **Step 2: Particle effects**

  ```typescript
  // src/effects/particles.ts
  import Phaser from 'phaser';

  const SNOW_SPRAY_KEY = 'fx-snow-particle';

  /** Call once from BootScene.create() after textures exist. */
  export function generateParticleTexture(scene: Phaser.Scene): void {
    if (scene.textures.exists(SNOW_SPRAY_KEY)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(2, 2, 2);
    g.generateTexture(SNOW_SPRAY_KEY, 4, 4);
    g.destroy();
  }

  export function emitSnowSpray(scene: Phaser.Scene, x: number, y: number): void {
    scene.add.particles(x, y, SNOW_SPRAY_KEY, {
      speed: { min: 20, max: 60 }, lifespan: 300, quantity: 2, alpha: { start: 0.8, end: 0 }
    });
  }

  export function emitImpactBurst(scene: Phaser.Scene, x: number, y: number): void {
    scene.add.particles(x, y, SNOW_SPRAY_KEY, {
      speed: { min: 80, max: 180 }, lifespan: 250, quantity: 12, tint: 0xffffff,
      alpha: { start: 1, end: 0 }
    });
  }
  ```

  Call `generateParticleTexture` from `BootScene.create()` alongside the other
  `generateXSpriteSheet` calls. Call `emitSnowSpray` continuously (throttled, e.g. every
  few frames) from the player's screen position while moving above some minimum speed;
  call `emitImpactBurst` from the same collision/combat-hit call sites screen shake uses.
  A combat-hit spark and a trick-jump-landing sparkle can reuse `emitImpactBurst` with a
  different tint/quantity rather than needing entirely separate functions — use judgment.

  Verify: snow spray visible behind the player while moving; a distinct, bigger burst on
  collision.

- [ ] **Step 3: Speed lines**

  ```typescript
  // src/effects/speedLines.ts
  import Phaser from 'phaser';
  import { MAX_SPEED, SCREEN_H, SCREEN_W } from '../config';

  export class SpeedLineOverlay {
    private readonly graphics: Phaser.GameObjects.Graphics;
    constructor(scene: Phaser.Scene) {
      this.graphics = scene.add.graphics();
    }
    setDepth(depth: number): void { this.graphics.setDepth(depth); }
    render(currentSpeed: number): void {
      this.graphics.clear();
      const t = Phaser.Math.Clamp(currentSpeed / MAX_SPEED, 0, 1);
      if (t < 0.6) return; // only show above 60% speed
      const alpha = (t - 0.6) / 0.4 * 0.3;
      this.graphics.fillStyle(0xffffff, alpha);
      // simple vignette-ish corner streaks; exact shape is a tuning choice
      this.graphics.fillRect(0, 0, SCREEN_W, 6);
      this.graphics.fillRect(0, SCREEN_H - 6, SCREEN_W, 6);
    }
  }
  ```

  Wire into `RaceScene.ts`'s update loop, called with the player's current speed, depth
  set above the HUD-independent gameplay layers but sensible relative to the HUD (top
  overlay). Exact visual treatment (corner streaks vs. full vignette) is a tuning choice —
  the code above is a starting point, not a fixed spec.

  Verify: overlay fades in only near max speed, not distracting at low/moderate speed.

- [ ] **Step 4: Camera lean**

  Add a small camera rotation (`scene.cameras.main.rotation` or a rotation tween) tied to
  the player's current lane-tween direction and jump state — subtle (a few degrees),
  purely cosmetic, and must NOT affect `RoadRenderer`'s actual projection math (it's a
  camera-object visual transform layered on top of the already-rendered frame, not a
  change to `camX`/`camY`/`camZ` passed into `project()`).

  Verify: visible lean during lane-shifts/jumps, no gameplay/projection change (obstacles
  still line up correctly under the tilted camera — this is a pure post-render visual
  transform).

- [ ] **Step 5: Commit**

  ```bash
  git add src/effects src/scenes/RaceScene.ts src/scenes/BootScene.ts
  git commit -m "Add screen shake, particles, speed lines, and camera lean"
  ```

---

### Task 6: UI/HUD polish

**Files:**
- Modify: `src/scenes/TitleScene.ts`
- Modify: `src/scenes/RaceScene.ts:175-187` (HUD text/progress-bar construction)
- Modify: `src/scenes/ResultScene.ts`
- Modify: `src/scenes/BootScene.ts` (preload the UI pack)

**Interfaces:**
- No new interfaces consumed by other modules — this task is purely presentational within
  the three scene files. `RaceScene`'s HUD update calls (`this.scoreText.setText(...)`
  etc.) can keep the same `Phaser.GameObjects.Text` objects, just re-parented onto styled
  UI-pack panel backgrounds, OR be replaced with UI-pack-provided text/label components if
  the pack includes them — either way, `scoreTracker`/`player.speed`/`player.weaponCharges`
  (the actual data being displayed) are unchanged.

- [ ] **Step 1: Inspect the UI pack**

  Note available panel/frame/button sprites and whether it includes bitmap fonts (Kenney's
  UI packs often do) — a pixel-style bitmap font would look more cohesive than the current
  default Phaser text font.

- [ ] **Step 2: Title screen**

  In `TitleScene.ts`, add a UI-pack panel sprite behind the existing title text/seed/prompt
  text (or replace the flat-color background). Keep the existing "press any key to start"
  behavior and seed-display logic unchanged — this is a visual wrapper, not new title-screen
  functionality.

- [ ] **Step 3: Race HUD**

  In `RaceScene.ts`, add a small UI-pack panel behind the score/speed/weapon-charge text
  block (currently plain white `Phaser.Text` at `HUD_X`/`HUD_Y`) and behind the progress
  bar. Keep `this.scoreText.setText(...)`/`this.speedText.setText(...)`/
  `this.weaponText.setText(...)` calls exactly as they are — only the visual container
  changes.

- [ ] **Step 4: Result screen**

  In `ResultScene.ts`, wrap the score-breakdown display in a UI-pack panel for visual
  consistency with the title/HUD.

- [ ] **Step 5: Verify in the browser**

  Screenshot the title screen, an in-race HUD, and both result-screen modes (finish and
  wipeout) — confirm all read as styled UI rather than raw text-on-flat-background, and
  that no displayed data (score, speed, position, etc.) changed in meaning.

- [ ] **Step 6: Commit**

  ```bash
  git add src/scenes/TitleScene.ts src/scenes/RaceScene.ts src/scenes/ResultScene.ts src/scenes/BootScene.ts
  git commit -m "Restyle title, HUD, and result screens with the UI pack"
  ```

---

## Self-Review

**Spec coverage:** design spec §2 (architecture) → Task 0/1/2 file-loading pipeline; §3
(asset packs) → Task 0 downloads/licenses all four; §3's road-surface addendum → Task 3;
§4 (juice/VFX: shake, particles, speed lines, camera lean) → Task 5 covers all four
bullets; §5 (title/HUD/result) → Task 6 covers all three; §6 phased breakdown (7 phases,
0–6) → 7 tasks here map 1:1. No spec section is uncovered.

**Placeholder scan:** every step has either concrete code or a concrete, specific
inspection/verification instruction — the "inspect the real pack" steps are flagged
explicitly as implementation-time discovery (per Global Constraints), not vague hand-waving,
since no plan can know a third-party zip's internal file names before it's downloaded.

**Type consistency:** `PICKUP_TEXTURE_KEY`/`PICKUP_FRAME`, `PLAYER_TEXTURE_KEY`/
`PLAYER_FRAMES`/`AI_RIDER_TEXTURE_KEYS`, `OBSTACLE_TEXTURE_KEY`/`OBSTACLE_FRAMES`, and
`RenderResult`/`DrawnSegment` are referenced identically (same names) across every task
that touches them, matching their actual current definitions in the codebase (verified by
reading each file before writing its task).
