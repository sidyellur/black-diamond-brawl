import Phaser from 'phaser';
import {
  CAMERA_BACK_Z,
  COURSE_LENGTH_SEGMENTS,
  HIT_FLASH_MS,
  HIT_REACTION_MS,
  MAX_ENTITY_SCREEN_FRACTION,
  MAX_SPEED,
  PLAYER_START_Z,
  SCREEN_H,
  SCREEN_W,
  SEGMENT_LENGTH
} from '../config';
import { AIRider } from '../entities/aiRider';
import { AIRiderRenderer } from '../entities/aiRiderRenderer';
import { CollisionSystem, isMogulLaunchAvailable } from '../entities/collision';
import { CombatSystem } from '../entities/combat';
import { bindPlayerInput, PlayerInput } from '../entities/input';
import { Obstacle } from '../entities/obstacle';
import { ObstacleRenderer } from '../entities/obstacleRenderer';
import { collectPickups, Pickup } from '../entities/pickup';
import { PickupRenderer } from '../entities/pickupRenderer';
import { Player } from '../entities/player';
import { PLAYER_FRAME_SIZE, PLAYER_FRAMES, PLAYER_TEXTURE_KEY } from '../entities/playerSprite';
import { computePlayerPosition, ScoreTracker } from '../entities/scoring';
import { recordScore } from '../entities/session';
import { DEPTH } from '../render/depth';
import { Juice } from '../render/Juice';
import { ShadowRenderer } from '../render/ShadowRenderer';
import { UI } from '../render/palette';
import { projectEntity, softClampWidth } from '../render/projectEntity';
import { DrawnSegment, RoadRenderer } from '../render/RoadRenderer';
import { horizonFogColor, SkyRenderer } from '../render/SkyRenderer';
import { FinishBanner } from '../track/finishBanner';
import { generateTrack } from '../track/generator';
import { resolveSeed } from '../track/seed';
import { Segment } from '../track/segment';

// The player is now PROJECTED like every other entity rather than pinned to a
// fixed screen position. Because the camera trails by exactly CAMERA_BACK_Z,
// the player's `dz` is constant, so its on-screen size is stable — but its
// position now comes from the same projection the road and rivals use, which
// is what puts all five racers into one coherent scale model.
const PLAYER_WIDTH_FRACTION = 0.13; // of the projected road half-width at its depth
const PLAYER_JUMP_HEIGHT_WORLD = 520; // world-units at jump apex, fed through projection

// World units behind the finish line the player rests at after crossing —
// keeps the banner in front of the camera instead of sitting exactly at
// dz=0, where project() culls it.
const FINISH_HOLD_BACK = SEGMENT_LENGTH * 8;

// Bare-bones HUD layout (design-spec §3.6 step 5 / §4.7): score, speed,
// progress bar, weapon charges.
const HUD_X = 20;
const HUD_Y = 16;
const PROGRESS_BAR_W = 220;
const PROGRESS_BAR_H = 10;
const HUD_LINE_HEIGHT = 20;

interface RaceSceneData {
  /** Course seed (design-spec §4.2/§4.8) — passed by `TitleScene`'s initial
   *  "press key to start" or `ResultScene`'s restart (same seed / new seed).
   *  Falls back to `resolveSeed()` only if `RaceScene` is ever started
   *  directly without going through Title (e.g. manual testing). */
  seed?: number;
}

/**
 * The full race: renderer, entities, input, combat, scoring, and a minimal
 * in-race HUD. Restartable — `create()` re-derives EVERY piece of per-race
 * state from scratch each time it runs (Phaser reuses the same scene
 * instance across `scene.start('RaceScene', ...)` calls rather than
 * reconstructing it, so anything not explicitly reset here would otherwise
 * leak from the previous run).
 */
export class RaceScene extends Phaser.Scene {
  private track: Segment[] = [];
  private obstacles: Obstacle[] = [];
  private crestApexZs: number[] = [];
  private finishSegment: Segment | undefined;
  private roadRenderer!: RoadRenderer;
  private skyRenderer!: SkyRenderer;
  private shadows!: ShadowRenderer;
  private juice!: Juice;
  /** Previous-frame collision/airborne state, so juice can fire on
   *  TRANSITIONS without collision or combat logic having to know that
   *  anything is watching. */
  private prevWiped = false;
  private prevTumbling = false;
  private prevStumbling = false;
  private prevAirborne = false;
  private uiCamera!: Phaser.Cameras.Scene2D.Camera;
  private finishBanner!: FinishBanner;
  private obstacleRenderer!: ObstacleRenderer;
  private collisions!: CollisionSystem;
  private player!: Player;
  private playerSprite!: Phaser.GameObjects.Sprite;

  private aiRiders: AIRider[] = [];
  private aiCollisions: CollisionSystem[] = [];
  private aiRiderRenderer!: AIRiderRenderer;

  private combat!: CombatSystem;
  private playerInput!: PlayerInput;
  private targetMarker!: Phaser.GameObjects.Graphics;
  private pickups: Pickup[] = [];
  private pickupRenderer!: PickupRenderer;
  private scoreTracker!: ScoreTracker;

  private seed = 0;
  private progressBarBg!: Phaser.GameObjects.Graphics;
  private progressBarFill!: Phaser.GameObjects.Graphics;
  private attackPip!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private speedText!: Phaser.GameObjects.Text;
  private weaponText!: Phaser.GameObjects.Text;

  /** True once the run has ended (finish or wipeout) and `ResultScene` has
   *  been started — guards against re-triggering the transition on a later
   *  frame this same scene instance might still process. */
  private raceOver = false;
  private prevWorldZ = PLAYER_START_Z;
  /** Every world-space display object, so the UI camera can ignore them all. */
  private worldObjects: Phaser.GameObjects.GameObject[] = [];
  /** `this.time.now` at the instant this race started (design-spec §4.7's
   *  finish time is race-elapsed time, not wall-clock time since the game
   *  booted) — Phaser's `update(time, delta)` `time` argument is the GLOBAL
   *  game clock shared by every scene, never reset on a scene restart, so
   *  finish time must be computed as `time - raceStartMs`, never `time`
   *  directly (see `endRace`). */
  private raceStartMs = 0;

  constructor() {
    super({ key: 'RaceScene' });
  }

  create(data: RaceSceneData): void {
    // Reset per-race primitive state explicitly: Phaser reuses this scene
    // instance across restarts, so a field's inline initializer (`= false`,
    // `= 0`) only ever runs once, at construction — NOT on every `create()`.
    this.raceOver = false;
    this.prevWorldZ = PLAYER_START_Z;
    this.raceStartMs = this.time.now;
    this.worldObjects = [];
    this.prevWiped = false;
    this.prevTumbling = false;
    this.prevStumbling = false;
    this.prevAirborne = false;

    // Sits behind the generated sky; only ever visible in the bleed margin a
    // camera shake can expose, so it matches the horizon rather than the old
    // flat blue.
    this.cameras.main.setBackgroundColor(horizonFogColor());

    this.seed = data?.seed ?? resolveSeed();
    const generated = generateTrack(this.seed);
    this.track = generated.segments;
    this.obstacles = generated.obstacles;
    this.pickups = generated.pickups;
    // Precompute world-Z of each jumpable crest apex (centre of the apex
    // segment) for the auto-launch crossing test (§4.3).
    this.crestApexZs = generated.crestApexes.map((i) => i * SEGMENT_LENGTH + SEGMENT_LENGTH / 2);
    this.finishSegment = this.track.find((segment) => segment.isFinish);

    this.skyRenderer = new SkyRenderer(this);
    this.roadRenderer = new RoadRenderer(this);
    this.roadRenderer.setDepth(DEPTH.ROAD);
    this.finishBanner = new FinishBanner(this);
    this.finishBanner.setDepth(DEPTH.BANNER);
    this.shadows = new ShadowRenderer(this, this.registerWorld);
    this.obstacleRenderer = new ObstacleRenderer(this, this.registerWorld);
    this.collisions = new CollisionSystem();

    // 4 AI riders from the params drawn by the generator's placement pass
    // (same seeded PRNG as geometry/obstacles), each with its OWN
    // CollisionSystem instance — the `hit` set inside CollisionSystem is
    // per-rider, so sharing one across riders would let one rider's dodge
    // failure silently clear an obstacle for everyone else.
    this.aiRiders = generated.aiRiders.map((params) => new AIRider(params));
    this.aiCollisions = this.aiRiders.map(() => new CollisionSystem());
    this.aiRiderRenderer = new AIRiderRenderer(this, this.registerWorld);
    this.pickupRenderer = new PickupRenderer(this, this.registerWorld);

    this.player = new Player();
    this.combat = new CombatSystem(this.player, this.aiRiders, this.obstacles);
    // Steering no longer intercepts into combat — it always steers. Attacking
    // is its own key, polled in `update`.
    this.playerInput = bindPlayerInput(this, this.player, () => {
      this.player.jump(isMogulLaunchAvailable(this.player, this.obstacles));
    });

    this.targetMarker = this.add.graphics();
    this.targetMarker.setDepth(DEPTH.SHADOW + 1);
    this.registerWorld(this.targetMarker);

    this.scoreTracker = new ScoreTracker(this.player, this.aiRiders, this.obstacles, this.collisions, this.combat);

    this.playerSprite = this.add.sprite(SCREEN_W / 2, SCREEN_H * 0.8, PLAYER_TEXTURE_KEY, PLAYER_FRAMES.CENTER);
    this.playerSprite.setOrigin(0.5, 1);
    this.playerSprite.setDepth(DEPTH.PLAYER);
    this.registerWorld(this.playerSprite);

    // Every world-space object must be registered, not just the pooled
    // sprites: the UI camera draws the whole display list minus what it
    // ignores, and it renders AFTER the main camera — so anything left
    // unregistered gets repainted on top of the world. Missing the road and
    // sky graphics here hid the player and the entire rival pack behind a
    // second copy of the backdrop.
    this.skyRenderer.displayObjects.forEach(this.registerWorld);
    this.roadRenderer.displayObjects.forEach(this.registerWorld);
    this.finishBanner.displayObjects.forEach(this.registerWorld);

    this.buildHud();

    // Built after the HUD so the UI camera already exists — every juice
    // object registers as world-space and must be ignored by it.
    this.juice = new Juice(this, this.cameras.main, this.registerWorld);
  }

  /**
   * Registers a world-space object so the UI camera ignores it.
   *
   * A second camera in Phaser renders the *entire* display list unless told
   * otherwise, and the entity renderers grow their sprite pools lazily
   * mid-race — so any sprite created after setup would otherwise render twice,
   * once in the world and once smeared across the HUD. Routing every world
   * object through one hook means a future renderer cannot forget to opt in.
   */
  private registerWorld = (obj: Phaser.GameObjects.GameObject): void => {
    this.worldObjects.push(obj);
    this.uiCamera?.ignore(obj);
  };

  private buildHud(): void {
    const hud: Phaser.GameObjects.GameObject[] = [];
    const ink = (v: number): string => `#${v.toString(16).padStart(6, '0')}`;

    const seedText = this.add.text(HUD_X, HUD_Y, `seed: ${this.seed}`, {
      fontSize: '13px',
      color: ink(UI.inkLow)
    });
    this.scoreText = this.add.text(HUD_X, HUD_Y + HUD_LINE_HEIGHT, '', {
      fontSize: '15px',
      color: ink(UI.inkHigh),
      fontStyle: 'bold'
    });
    this.speedText = this.add.text(HUD_X, HUD_Y + HUD_LINE_HEIGHT * 2, '', {
      fontSize: '14px',
      color: ink(UI.inkMid)
    });
    this.weaponText = this.add.text(HUD_X, HUD_Y + HUD_LINE_HEIGHT * 3, '', {
      fontSize: '14px',
      color: ink(UI.accentWarn)
    });

    // The bar's background never changes for the whole race — drawn once
    // here rather than every frame in updateHud(), unlike progressBarFill's
    // width, which genuinely does change every frame.
    const barY = HUD_Y + HUD_LINE_HEIGHT * 4;
    this.progressBarBg = this.add.graphics();
    this.progressBarBg.fillStyle(UI.panel, 0.55);
    this.progressBarBg.fillRect(HUD_X - 2, barY - 2, PROGRESS_BAR_W + 4, PROGRESS_BAR_H + 4);
    this.progressBarBg.fillStyle(UI.panelEdge, 0.9);
    this.progressBarBg.fillRect(HUD_X, barY, PROGRESS_BAR_W, PROGRESS_BAR_H);

    this.progressBarFill = this.add.graphics();
    this.attackPip = this.add.graphics();

    hud.push(
      seedText,
      this.scoreText,
      this.speedText,
      this.weaponText,
      this.progressBarBg,
      this.progressBarFill,
      this.attackPip
    );

    // A dedicated UI camera keeps the HUD still while the world camera shakes
    // on impact — and keeps postFX (vignette, bloom) off the text, which
    // would otherwise darken the HUD corners and blow out white glyphs.
    this.uiCamera = this.cameras.add(0, 0, SCREEN_W, SCREEN_H);
    this.uiCamera.setName('ui');
    this.uiCamera.transparent = true;
    this.uiCamera.ignore(this.worldObjects);
    this.cameras.main.ignore(hud);
  }

  update(time: number, delta: number): void {
    if (this.raceOver) {
      return; // frozen: ResultScene has already been started this frame
    }

    // Hit-stop: freeze the SIMULATION for a few frames after an impact while
    // rendering and VFX keep running. Those frozen frames are what give a
    // collision its sense of mass — without them the rider simply continues
    // through the hit and it registers as a number changing.
    //
    // Only the world stops. The juice timer, particles and camera shake all
    // keep advancing, so the freeze reads as impact rather than as a stall,
    // and the HUD stays live on its own camera.
    if (this.juice.frozen) {
      this.juice.tick(delta);
      this.juice.renderSpeed(this.player.speed, time);
      return;
    }

    // Attack is polled here rather than fired from a key handler: handlers
    // still run during hit-stop, when this method early-returns above, so a
    // handler-driven attack would resolve combat inside the freeze on a stale
    // clock. A press with no eligible target is refused by `attemptAttack`
    // itself and costs nothing.
    if (this.playerInput.attackJustPressed()) {
      this.combat.attemptAttack(time);
    }

    const prevZ = this.prevWorldZ;
    this.player.update(delta);

    // Crest auto-launch (§4.3): crossing a jumpable crest's apex fires an
    // extended trick jump with NO jump press — the crest acts as a ramp. No
    // speed threshold (spec §4.3 note 14). `jump()` no-ops if already airborne
    // (e.g. launched off a mogul just before the crest) or wiped out.
    for (const apexZ of this.crestApexZs) {
      if (prevZ < apexZ && this.player.worldZ >= apexZ) {
        this.player.jump(true);
        break;
      }
    }

    // Player-vs-obstacle collision (§4.4).
    this.collisions.update(this.player, this.obstacles);

    // AI riders. Every rider updates (race + dodge + bump) EVERY frame
    // regardless of whether it's currently on-screen — off-screen simulation
    // keeps world-Z/speed/lane honest so a rider re-entering draw distance
    // appears at the right spot instead of teleporting. No AI-vs-AI collision
    // (design-spec §4.5 v1 simplification): only each rider's own obstacle
    // collisions are checked, never rider-vs-rider.
    for (let i = 0; i < this.aiRiders.length; i++) {
      const rider = this.aiRiders[i];
      rider.update(delta, this.obstacles, this.player);
      if (this.finishSegment && rider.finishTimeMs === null && rider.worldZ >= this.finishSegment.z) {
        rider.finishTimeMs = time;
      }
      if (rider.finishTimeMs !== null) {
        // Hold a finished rider at the line rather than letting it run past
        // the end of the (fixed-length, non-looping) track array.
        rider.worldZ = this.finishSegment!.z;
      }
      this.aiCollisions[i].update(rider, this.obstacles);
    }

    // Combat resolution runs AFTER every rider has moved and taken its own
    // obstacle collision this frame, so same-lane checks and knockout
    // attribution (a rider's wipedOut transition) see final state.
    this.combat.update(delta, time);

    // Ski-pole pickup (§4.6): collected by lane + Z, including while
    // airborne — unlike obstacles, never gated on `player.airborne`.
    collectPickups(this.player, this.pickups);

    // Combat feedback is emitted AFTER the render pass (`emitCombatFeedback`)
    // so the struck rival can be projected with THIS frame's offset-walk
    // data — but the riders must be captured here, because
    // `ScoreTracker.update()` below drains `combat.events`.
    const struckRiders = this.combat.events.map((event) => event.rider);

    // Collision feedback, fired on state TRANSITIONS so neither the collision
    // system nor combat needs to know anything is watching.
    this.emitCollisionFeedback();

    // Scoring reads this frame's settled combat/collision/pickup state —
    // must run after all of the above.
    this.scoreTracker.update();

    // Wipeout ends the run immediately (§4.4/§4.7/§4.8): capture score and
    // position ONCE and hand off to ResultScene. Checked before the finish
    // check below since a tree collision can never itself put the player
    // past the finish line.
    // Gated on the hit-stop still running: a tree wipeout sets `wipedOut` and
    // triggers the heaviest impact in the game on the SAME frame, so ending
    // the race here immediately would cut to the result screen before a
    // single frozen frame — or any of the shake and spray — had been drawn.
    // Holding the transition until the freeze expires lets the crash land.
    if (this.player.wipedOut && !this.juice.frozen) {
      this.endRace(false, time);
      return;
    }

    // The course is a fixed, non-looping length (design-spec §4.2) — crossing
    // the finish line ends the run (§4.7/§4.8): capture score/position once
    // and hand off to ResultScene.
    if (this.finishSegment && this.player.worldZ >= this.finishSegment.z) {
      this.endRace(true, time);
      return;
    }

    // Camera follows the player (§4.1): camZ/camX derive from the player's
    // world-Z and lane offset. Camera height comes from the ROAD's elevation
    // at the player's world-Z (via player.camY), never the jump-arc height,
    // so the camera stays smooth through jumps, including over hills.
    // The camera trails the player by CAMERA_BACK_Z. That offset is what makes
    // the player projectable at all: with the camera sitting exactly on the
    // player, dz was 0 and `project()` culls dz <= 0, so the player had to be
    // drawn as a fixed screen-space sprite and every rival that came close
    // enough to fight blew up past the screen width.
    const camZ = this.player.worldZ - CAMERA_BACK_Z;
    const camX = this.player.worldX;
    const camY = this.player.camY(this.track);
    const fogColor = horizonFogColor();

    const result = this.roadRenderer.render(this.track, camX, camY, camZ, fogColor);
    // Sky draws behind the road but needs this frame's curve offset and the
    // road's measured top edge, so it renders after.
    this.skyRenderer.render(result.farCurveOffset, camX, result.topScreenY);
    this.shadows.begin();
    this.finishBanner.render(this.finishSegment, camX, camY, camZ);
    // Obstacles project with the SAME frame's offset-walk / crest-clip data so
    // they slide through curves and vanish behind crests exactly like the road.
    this.obstacleRenderer.render(
      this.obstacles,
      this.track,
      result.drawnSegments,
      { x: camX, y: camY, z: camZ },
      this.shadows
    );
    // AI riders project with the SAME frame's offset-walk / crest-clip data,
    // so they slide through curves and vanish behind crests exactly like the
    // road/obstacles do.
    this.aiRiderRenderer.render(
      this.aiRiders,
      this.track,
      result.drawnSegments,
      { x: camX, y: camY, z: camZ },
      this.shadows
    );
    // Pickups project with the SAME frame's offset-walk / crest-clip data too.
    this.pickupRenderer.render(
      this.pickups,
      this.track,
      result.drawnSegments,
      { x: camX, y: camY, z: camZ },
      this.shadows
    );
    this.updatePlayerSprite(camX, camY, camZ, result.drawnSegments);
    this.renderTargetMarker(camX, camY, camZ, result.drawnSegments);
    this.emitCombatFeedback(struckRiders, camX, camY, camZ, result.drawnSegments);
    this.shadows.end();

    // Carve spray off the board edge, and speed lines whose intensity tracks
    // actual speed — so the difference between 60% and 100% is something you
    // feel rather than something you read off the HUD.
    if (!this.player.wipedOut && !this.player.airborne) {
      this.juice.emitCarve(
        this.playerSprite.x,
        this.playerSprite.y,
        this.player.speed / MAX_SPEED,
        this.player.leanDirection !== 0
      );
    }
    this.juice.renderSpeed(this.player.speed, time);
    this.juice.tick(delta);
    this.updateHud();

    this.prevWorldZ = this.player.worldZ;
  }

  /**
   * Ends the run (§4.7/§4.8): computes the final score breakdown and race
   * position exactly once — at this instant nothing else in the world keeps
   * moving (the scene is about to stop), which is what makes a wipeout's
   * position read as "frozen at the moment of the wipeout" rather than a
   * live-updating value. Records the session-best, then hands off to
   * `ResultScene`. `finished` = crossed the finish line; false = wiped out.
   */
  private endRace(finished: boolean, nowMs: number): void {
    this.raceOver = true;
    if (finished) {
      // Held a couple of segments BEHIND the finish line rather than exactly
      // on it: project() culls anything at dz <= 0, so parking the camera
      // exactly at the banner's own z would make it invisible on this final
      // render — not that ResultScene needs it, but keeps worldZ sane.
      this.player.worldZ = Math.max(0, this.finishSegment!.z - FINISH_HOLD_BACK);
    }
    // `computePlayerPosition` only ever compares `finishTimeMs` values against
    // EACH OTHER (relative order, never against a fixed constant), so the raw
    // (wall-clock-since-boot) `nowMs`/`rider.finishTimeMs` pairing is fine
    // there. `ScoreTracker.finalize`'s time bonus is different: it compares
    // finish time against the fixed `PAR_TIME` constant, so it needs the
    // RACE-elapsed duration, not time-since-game-booted — see `raceStartMs`.
    const playerFinishTimeMs = finished ? nowMs : null;
    const position = computePlayerPosition(this.player, this.aiRiders, playerFinishTimeMs);
    const breakdown = this.scoreTracker.finalize(finished, nowMs - this.raceStartMs, position);
    const { best, isNewBest } = recordScore(breakdown.total);

    this.scene.start('ResultScene', { seed: this.seed, breakdown, bestScore: best, isNewBest });
  }

  private updateHud(): void {
    this.scoreText.setText(`score: ${Math.round(this.scoreTracker.runningScore)}`);
    this.speedText.setText(`speed: ${Math.round((this.player.speed / MAX_SPEED) * 100)}%`);
    this.weaponText.setText(this.player.armed ? `pole: ${this.player.weaponCharges}` : '');

    // Attack readiness. An invisible cooldown is another way to generate
    // "I pressed attack and nothing happened".
    const pipY = HUD_Y + HUD_LINE_HEIGHT * 3 + 4;
    const pipX = HUD_X + 92;
    this.attackPip.clear();
    if (this.combat.attackOnCooldown) {
      this.attackPip.fillStyle(UI.inkLow, 0.5);
      this.attackPip.fillRect(pipX, pipY, 34, 5);
      this.attackPip.fillStyle(UI.inkMid, 0.9);
      this.attackPip.fillRect(pipX, pipY, 34 * (1 - this.combat.attackCooldownFraction), 5);
    } else {
      this.attackPip.fillStyle(this.combat.target ? UI.accentWarn : UI.inkLow, this.combat.target ? 1 : 0.45);
      this.attackPip.fillRect(pipX, pipY, 34, 5);
    }

    const courseLength = COURSE_LENGTH_SEGMENTS * SEGMENT_LENGTH;
    const progress = courseLength > 0 ? Phaser.Math.Clamp(this.player.worldZ / courseLength, 0, 1) : 0;
    const barY = HUD_Y + HUD_LINE_HEIGHT * 4;

    this.progressBarFill.clear();
    this.progressBarFill.fillStyle(0xffcc33, 1);
    this.progressBarFill.fillRect(HUD_X, barY, PROGRESS_BAR_W * progress, PROGRESS_BAR_H);
  }

  private updatePlayerSprite(
    camX: number,
    camY: number,
    camZ: number,
    drawnSegments: Map<number, DrawnSegment>
  ): void {
    // Priority: crash > recoil > mid-attack > airborne > steering. Recoil
    // outranks the swing so losing an exchange you started still reads as
    // being hit.
    const lean = this.player.leanDirection;
    const frame =
      this.player.wipedOut || this.player.tumbling
        ? PLAYER_FRAMES.TUMBLE // tree wipeout or rock knockdown
        : this.player.hitReacting
          ? PLAYER_FRAMES.HIT
          : this.player.swinging
            ? PLAYER_FRAMES.SWING
            : this.player.airborne
              ? PLAYER_FRAMES.JUMP
              : lean < 0
                ? PLAYER_FRAMES.LEAN_LEFT
                : lean > 0
                  ? PLAYER_FRAMES.LEAN_RIGHT
                  : PLAYER_FRAMES.CENTER;
    this.playerSprite.setFrame(frame);

    if (this.player.hitReactionMsRemaining > HIT_REACTION_MS - HIT_FLASH_MS) {
      this.playerSprite.setTintFill(0xffffff);
    } else {
      this.playerSprite.clearTint();
    }

    // Projected exactly like every other entity, with the jump arc fed in as a
    // real world-space height rather than a screen-space bob — so the player
    // rises through the same perspective the world uses, and the arc reads
    // correctly over crests instead of sliding independently of the terrain.
    // `ignoreCrestClip` keeps the player visible while airborne over a rise,
    // where the road beneath is legitimately hidden.
    const projected = projectEntity(
      this.player.laneOffsetFraction,
      this.player.worldZ,
      this.track,
      drawnSegments,
      { x: camX, y: camY, z: camZ },
      this.player.jumpArcHeight * PLAYER_JUMP_HEIGHT_WORLD,
      true
    );
    if (!projected) {
      return; // never expected at a constant dz, but never float a stale sprite
    }

    const stumbleShimmy = this.player.stumbling ? Math.sin(this.time.now / 30) * 5 : 0;
    const widthPx = softClampWidth(
      projected.screenW * PLAYER_WIDTH_FRACTION,
      SCREEN_W * MAX_ENTITY_SCREEN_FRACTION
    );
    this.playerSprite.setScale(widthPx / PLAYER_FRAME_SIZE);
    this.playerSprite.setPosition(projected.screenX + stumbleShimmy, projected.screenY);

    // The shadow tracks the ROAD, not the sprite — projected again at zero
    // height. The growing gap between rider and shadow is what makes a jump
    // read as height rather than as the sprite drifting up the screen.
    const ground = projectEntity(
      this.player.laneOffsetFraction,
      this.player.worldZ,
      this.track,
      drawnSegments,
      { x: camX, y: camY, z: camZ },
      0,
      true
    );
    if (ground) {
      this.shadows.draw(ground.screenX, ground.screenY, widthPx, this.player.jumpArcHeight);
    }
  }

  /**
   * Draws a chevron under the rival an attack would strike.
   *
   * This is what replaces directional attack input. Auto-targeting on its own
   * would leave the player unable to predict who a press hits — but showing
   * the choice *before* the press answers the same question without needing
   * extra keys, which would collide with the steering bindings anyway.
   *
   * The target comes from `CombatSystem.target`, which is the exact rival
   * `attemptAttack` will resolve against, and is null whenever any guard
   * would refuse — cooldown, pair immunity, a rival mid-rock-tumble. So the
   * marker can never promise a hit that then silently fails.
   */
  private renderTargetMarker(
    camX: number,
    camY: number,
    camZ: number,
    drawnSegments: Map<number, DrawnSegment>
  ): void {
    this.targetMarker.clear();
    const target = this.combat.target;
    if (!target) {
      return;
    }
    const projected = projectEntity(target.laneOffsetFraction, target.worldZ, this.track, drawnSegments, {
      x: camX,
      y: camY,
      z: camZ
    });
    if (!projected) {
      return;
    }

    const w = Math.max(10, softClampWidth(projected.screenW * PLAYER_WIDTH_FRACTION, SCREEN_W * 0.2));
    const x = projected.screenX;
    const y = projected.screenY + 3;
    // A chevron rather than a ring: it points at the rider, survives being
    // small, and cannot be mistaken for a contact shadow.
    this.targetMarker.fillStyle(UI.accentWarn, 0.92);
    this.targetMarker.beginPath();
    this.targetMarker.moveTo(x, y + w * 0.30);
    this.targetMarker.lineTo(x - w * 0.34, y);
    this.targetMarker.lineTo(x - w * 0.17, y);
    this.targetMarker.lineTo(x, y + w * 0.15);
    this.targetMarker.lineTo(x + w * 0.17, y);
    this.targetMarker.lineTo(x + w * 0.34, y);
    this.targetMarker.closePath();
    this.targetMarker.fillPath();
  }

  /**
   * Combat impact feedback, at the STRUCK rider's position.
   *
   * This used to fire at the player's sprite — sparks appeared on the
   * attacker rather than on the rival who was hit, exactly backwards for an
   * attack (a #13 regression; the #17 prerequisite). Reading the rival's
   * pooled sprite would still be wrong in two edge cases: sprite positions
   * are a frame stale, and a rider whose projection was null last frame
   * (crest-clipped, or a knockout event firing seconds after the shove with
   * the treed rival far behind the camera) holds a stale-or-garbage position
   * with `visible = false`. So the rider is re-projected fresh with this
   * frame's data; if that fails, `Juice.combatHit(null)` plays the shake and
   * hit-stop without emitting particles somewhere meaningless.
   */
  private emitCombatFeedback(
    struckRiders: AIRider[],
    camX: number,
    camY: number,
    camZ: number,
    drawnSegments: Map<number, DrawnSegment>
  ): void {
    for (const rider of struckRiders) {
      const projected = projectEntity(rider.laneOffsetFraction, rider.worldZ, this.track, drawnSegments, {
        x: camX,
        y: camY,
        z: camZ
      });
      // Mid-body: sprites are square with a bottom-centre origin, so half the
      // drawn width up from the base. Same width fraction the renderer uses.
      this.juice.combatHit(
        projected
          ? { x: projected.screenX, y: projected.screenY - projected.screenW * PLAYER_WIDTH_FRACTION * 0.5 }
          : null
      );
    }
  }

  /**
   * Fires impact feedback on state transitions.
   *
   * Reading transitions rather than hooking the collision system keeps
   * `CollisionSystem` and `Player` unaware that anything is observing them —
   * the v2 work is not allowed to change collision behaviour, only how it is
   * presented.
   */
  private emitCollisionFeedback(): void {
    const x = this.playerSprite.x;
    const y = this.playerSprite.y;

    // Tree: run-ending. The heaviest hit in the game, so it gets the most.
    if (this.player.wipedOut && !this.prevWiped) {
      this.juice.impact(x, y, 1);
    } else if (this.player.tumbling && !this.prevTumbling) {
      // Rock: a hard knockdown, recoverable.
      this.juice.impact(x, y, 0.62);
    } else if (this.player.stumbling && !this.prevStumbling) {
      // Mogul: a bump, not a crash — spray and a nudge, no flash.
      this.juice.impact(x, y, 0.18);
    }

    // Landing. An extended (trick) landing is a reward, so it sparkles rather
    // than shakes.
    if (!this.player.airborne && this.prevAirborne && !this.player.wipedOut) {
      if (this.player.extendedJump) {
        this.juice.trickLanded(x, y);
      } else {
        this.juice.emitCarve(x, y, 1, true);
      }
    }

    this.prevWiped = this.player.wipedOut;
    this.prevTumbling = this.player.tumbling;
    this.prevStumbling = this.player.stumbling;
    this.prevAirborne = this.player.airborne;
  }

}
