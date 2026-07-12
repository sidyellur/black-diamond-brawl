import Phaser from 'phaser';
import { COURSE_LENGTH_SEGMENTS, MAX_SPEED, SCREEN_H, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { AIRider } from '../entities/aiRider';
import { AIRiderRenderer } from '../entities/aiRiderRenderer';
import { CollisionSystem, isMogulLaunchAvailable } from '../entities/collision';
import { CombatSystem } from '../entities/combat';
import { bindPlayerInput } from '../entities/input';
import { Obstacle } from '../entities/obstacle';
import { ObstacleRenderer } from '../entities/obstacleRenderer';
import { collectPickups, Pickup } from '../entities/pickup';
import { PickupRenderer } from '../entities/pickupRenderer';
import { Player } from '../entities/player';
import { PLAYER_FRAMES, PLAYER_TEXTURE_KEY } from '../entities/playerSprite';
import { computePlayerPosition, ScoreTracker } from '../entities/scoring';
import { recordScore } from '../entities/session';
import { RoadRenderer } from '../render/RoadRenderer';
import { FinishBanner } from '../track/finishBanner';
import { generateTrack } from '../track/generator';
import { resolveSeed } from '../track/seed';
import { Segment } from '../track/segment';

const SKY_COLOR = '#8fd0ff';

// Depths keep the render order of §3.6: road (bottom) < finish banner <
// obstacle sprites (own far-to-near depths, all negative but above these) <
// player sprite (always on top).
const ROAD_DEPTH = -1_000_000_000;
const BANNER_DEPTH = -900_000_000;
const PLAYER_DEPTH = 1_000_000_000;

// Player sprite is drawn at a FIXED screen position (design-spec §3.5) — it
// does NOT go through project(); only its frame/sway/bob react to state.
const PLAYER_SPRITE_SCALE = 2.5; // 32px base art scaled up for screen readability
const PLAYER_SPRITE_BASE_Y = SCREEN_H - 110; // fixed screen position near bottom-center
const PLAYER_LEAN_SWAY_PX = 40; // horizontal sway range across the full lane-offset span
const PLAYER_JUMP_RISE_PX = 60; // sprite bob height at jump apex

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
  private finishBanner!: FinishBanner;
  private obstacleRenderer!: ObstacleRenderer;
  private collisions!: CollisionSystem;
  private player!: Player;
  private playerSprite!: Phaser.GameObjects.Sprite;

  private aiRiders: AIRider[] = [];
  private aiCollisions: CollisionSystem[] = [];
  private aiRiderRenderer!: AIRiderRenderer;

  private combat!: CombatSystem;
  private pickups: Pickup[] = [];
  private pickupRenderer!: PickupRenderer;
  private scoreTracker!: ScoreTracker;

  private seed = 0;
  private progressBarBg!: Phaser.GameObjects.Graphics;
  private progressBarFill!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private speedText!: Phaser.GameObjects.Text;
  private weaponText!: Phaser.GameObjects.Text;

  /** True once the run has ended (finish or wipeout) and `ResultScene` has
   *  been started — guards against re-triggering the transition on a later
   *  frame this same scene instance might still process. */
  private raceOver = false;
  private prevWorldZ = 0;
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
    this.prevWorldZ = 0;
    this.raceStartMs = this.time.now;

    // Static sky/backdrop (design-spec §3.6 step 1): a flat camera
    // background color repaints behind everything each frame for free.
    this.cameras.main.setBackgroundColor(SKY_COLOR);

    this.seed = data?.seed ?? resolveSeed();
    const generated = generateTrack(this.seed);
    this.track = generated.segments;
    this.obstacles = generated.obstacles;
    this.pickups = generated.pickups;
    // Precompute world-Z of each jumpable crest apex (centre of the apex
    // segment) for the auto-launch crossing test (§4.3).
    this.crestApexZs = generated.crestApexes.map((i) => i * SEGMENT_LENGTH + SEGMENT_LENGTH / 2);
    this.finishSegment = this.track.find((segment) => segment.isFinish);

    this.roadRenderer = new RoadRenderer(this);
    this.roadRenderer.setDepth(ROAD_DEPTH);
    this.finishBanner = new FinishBanner(this);
    this.finishBanner.setDepth(BANNER_DEPTH);
    this.obstacleRenderer = new ObstacleRenderer(this);
    this.collisions = new CollisionSystem();

    // 4 AI riders from the params drawn by the generator's placement pass
    // (same seeded PRNG as geometry/obstacles), each with its OWN
    // CollisionSystem instance — the `hit` set inside CollisionSystem is
    // per-rider, so sharing one across riders would let one rider's dodge
    // failure silently clear an obstacle for everyone else.
    this.aiRiders = generated.aiRiders.map((params) => new AIRider(params));
    this.aiCollisions = this.aiRiders.map(() => new CollisionSystem());
    this.aiRiderRenderer = new AIRiderRenderer(this);
    this.pickupRenderer = new PickupRenderer(this);

    this.player = new Player();
    // A steer into an adjacent rival resolves a shove instead of a lane
    // change (§4.6 trigger 1) — wired before any input so the very first
    // press is covered.
    this.combat = new CombatSystem(this.player, this.aiRiders, this.obstacles);
    this.player.shoveInterceptor = (direction) => this.combat.attemptPlayerShove(direction);
    // Jump routes through here so a press on/just before a mogul becomes an
    // extended trick launch (§4.3); otherwise it's a normal jump.
    bindPlayerInput(this, this.player, () => {
      this.player.jump(isMogulLaunchAvailable(this.player, this.obstacles));
    });

    this.scoreTracker = new ScoreTracker(this.player, this.aiRiders, this.obstacles, this.collisions, this.combat);

    this.playerSprite = this.add.sprite(SCREEN_W / 2, PLAYER_SPRITE_BASE_Y, PLAYER_TEXTURE_KEY, PLAYER_FRAMES.CENTER);
    this.playerSprite.setOrigin(0.5, 1);
    this.playerSprite.setScale(PLAYER_SPRITE_SCALE);
    this.playerSprite.setDepth(PLAYER_DEPTH);

    this.buildHud();
  }

  private buildHud(): void {
    this.add.text(HUD_X, HUD_Y, `seed: ${this.seed}`, { fontSize: '14px', color: '#ffffff' });
    this.scoreText = this.add.text(HUD_X, HUD_Y + HUD_LINE_HEIGHT, '', { fontSize: '14px', color: '#ffffff' });
    this.speedText = this.add.text(HUD_X, HUD_Y + HUD_LINE_HEIGHT * 2, '', { fontSize: '14px', color: '#ffffff' });
    this.weaponText = this.add.text(HUD_X, HUD_Y + HUD_LINE_HEIGHT * 3, '', { fontSize: '14px', color: '#ffffff' });

    this.progressBarBg = this.add.graphics();
    this.progressBarFill = this.add.graphics();
  }

  update(time: number, delta: number): void {
    if (this.raceOver) {
      return; // frozen: ResultScene has already been started this frame
    }

    // Stamps this frame's clock BEFORE player.update() — a lane-shift press
    // can synchronously resolve a shove via `Player.shoveInterceptor`, which
    // needs a fresh `nowMs` even though `CombatSystem.update()` itself must
    // run later, after every rider's collision pass (see its own doc).
    this.combat.beginFrame(time);

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

    // Scoring reads this frame's settled combat/collision/pickup state —
    // must run after all of the above.
    this.scoreTracker.update();

    // Wipeout ends the run immediately (§4.4/§4.7/§4.8): capture score and
    // position ONCE and hand off to ResultScene. Checked before the finish
    // check below since a tree collision can never itself put the player
    // past the finish line.
    if (this.player.wipedOut) {
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
    const camZ = this.player.worldZ;
    const camX = this.player.worldX;
    const camY = this.player.camY(this.track);

    const result = this.roadRenderer.render(this.track, camX, camY, camZ);
    this.finishBanner.render(this.finishSegment, camX, camY, camZ);
    // Obstacles project with the SAME frame's offset-walk / crest-clip data so
    // they slide through curves and vanish behind crests exactly like the road.
    this.obstacleRenderer.render(this.obstacles, this.track, result.drawnSegments, {
      x: camX,
      y: camY,
      z: camZ
    });
    // AI riders project with the SAME frame's offset-walk / crest-clip data,
    // so they slide through curves and vanish behind crests exactly like the
    // road/obstacles do.
    this.aiRiderRenderer.render(this.aiRiders, this.track, result.drawnSegments, {
      x: camX,
      y: camY,
      z: camZ
    });
    // Pickups project with the SAME frame's offset-walk / crest-clip data too.
    this.pickupRenderer.render(this.pickups, this.track, result.drawnSegments, {
      x: camX,
      y: camY,
      z: camZ
    });
    this.updatePlayerSprite();
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

    const courseLength = COURSE_LENGTH_SEGMENTS * SEGMENT_LENGTH;
    const progress = courseLength > 0 ? Phaser.Math.Clamp(this.player.worldZ / courseLength, 0, 1) : 0;
    const barY = HUD_Y + HUD_LINE_HEIGHT * 4;

    this.progressBarBg.clear();
    this.progressBarBg.fillStyle(0x1a1a1a, 0.6);
    this.progressBarBg.fillRect(HUD_X, barY, PROGRESS_BAR_W, PROGRESS_BAR_H);

    this.progressBarFill.clear();
    this.progressBarFill.fillStyle(0xffcc33, 1);
    this.progressBarFill.fillRect(HUD_X, barY, PROGRESS_BAR_W * progress, PROGRESS_BAR_H);
  }

  private updatePlayerSprite(): void {
    const lean = this.player.leanDirection;
    const frame =
      this.player.wipedOut || this.player.tumbling
        ? PLAYER_FRAMES.TUMBLE // tree wipeout or rock knockdown
        : this.player.airborne
          ? PLAYER_FRAMES.JUMP
          : lean < 0
            ? PLAYER_FRAMES.LEAN_LEFT
            : lean > 0
              ? PLAYER_FRAMES.LEAN_RIGHT
              : PLAYER_FRAMES.CENTER;
    this.playerSprite.setFrame(frame);

    // Subtle horizontal sway across the lane-offset span (lean effect only —
    // NOT how lane position feeds the camera; that's player.worldX -> camX
    // above) and a vertical bob during the jump arc. A mogul stumble adds a
    // brief cosmetic shimmy on top.
    const stumbleShimmy = this.player.stumbling ? Math.sin(this.time.now / 30) * 6 : 0;
    const swayX = SCREEN_W / 2 + this.player.laneOffsetFraction * PLAYER_LEAN_SWAY_PX + stumbleShimmy;
    const bobY = PLAYER_SPRITE_BASE_Y - this.player.jumpArcHeight * PLAYER_JUMP_RISE_PX;
    this.playerSprite.setPosition(swayX, bobY);
  }
}
