import Phaser from 'phaser';
import {
  CAMERA_BACK_Z,
  COURSE_LENGTH_SEGMENTS,
  HIT_FLASH_MS,
  HIT_REACTION_MS,
  MAX_ENTITY_SCREEN_FRACTION,
  MAX_SPEED,
  PLAYER_START_Z,
  RIDER_WIDTH_FRACTION,
  RIDER_JUMP_HEIGHT_WORLD,
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
import { PLAYER_FRAME_SIZE, PLAYER_FRAMES, PLAYER_TEXTURE_KEY, getSelectedPlayerTexture } from '../entities/playerSprite';
import { computePlayerPosition, ScoreTracker } from '../entities/scoring';
import { FixedRaceClock, RaceOptions, createQuickRace, retryRace, normalizeRaceOptions, cupRivalParams,
  recordRun, awardRun, completeCupRound, GhostRecorder, GhostRecording, loadGhost, saveGhost,
  sampleGhost, CheckpointTracker, checkpointWorldZs } from '../progression';
import { menuButton, menuText, menuKeys } from '../frontend/menu';
import { PRACTICE_LESSONS, PracticeObjectives } from '../practice/lessons';
import { MountainSection, sectionAtZ } from '../track/mountain';
import { DEPTH } from '../render/depth';
import { Juice } from '../render/Juice';
import { ShadowRenderer } from '../render/ShadowRenderer';
import { RIVAL_SUITS, UI } from '../render/palette';
import { RaceHud } from '../ui/RaceHud';
import { SceneryRenderer } from '../render/SceneryRenderer';
import { getRaceAudio, RaceAudio } from '../audio/RaceAudio';
import { projectEntity, softClampWidth } from '../render/projectEntity';
import { DrawnSegment, RoadRenderer } from '../render/RoadRenderer';
import { horizonFogColor, SkyRenderer } from '../render/SkyRenderer';
import { FinishBanner } from '../track/finishBanner';
import { generateTrack } from '../track/generator';
import { resolveSeed } from '../track/seed';
import { Segment } from '../track/segment';
import { oncePerKeyEvent } from '../input/keyboardEvents';
import { APP_ACTIVE, APP_INACTIVE, CANCEL_INPUT, isAppActive } from '../input/appLifecycle';

// The player is now PROJECTED like every other entity rather than pinned to a
// fixed screen position. Because the camera trails by exactly CAMERA_BACK_Z,
// the player's `dz` is constant, so its on-screen size is stable — but its
// position now comes from the same projection the road and rivals use, which
// is what puts all five racers into one coherent scale model.
const PLAYER_WIDTH_FRACTION = RIDER_WIDTH_FRACTION; // of the projected road half-width at its depth
const PLAYER_JUMP_HEIGHT_WORLD = RIDER_JUMP_HEIGHT_WORLD; // world-units at jump apex, fed through projection

// World units behind the finish line the player rests at after crossing —
// keeps the banner in front of the camera instead of sitting exactly at
// dz=0, where project() culls it.
const FINISH_HOLD_BACK = SEGMENT_LENGTH * 8;

interface RaceSceneData extends Partial<RaceOptions> {
  practiceLesson?: number;
  practiceFeedback?: string;
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
  private sceneryRenderer!: SceneryRenderer;
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
  private hud!: RaceHud;
  private audio!: RaceAudio;
  private paused = false;
  private countdownMs = 1800;
  private elapsedRaceMs = 0;
  private previousCharges = 0;
  private previousHitReaction = false;
  private worldRoll = 0;
  private previousUpdateAt = 0;
  private resumePending = false;
  private fixedClock = new FixedRaceClock();
  private simulationHitStopMs = 0;
  private frameStruckRiders: AIRider[] = [];
  private reducedMotion = false;
  private options!: RaceOptions;
  private mountainSections: MountainSection[] = [];
  private practiceLesson = 0;
  private practiceObjective: PracticeObjectives | null = null;
  private practiceFeedback = '';
  private practiceAdvanceAt = 0;
  private practiceMogulZ = 0;
  private practiceLaunched = false;
  private counterCount = 0;
  private practiceComplete = false;
  private ghost: GhostRecording | null = null;
  private ghostRecorder!: GhostRecorder;
  private ghostSprite!: Phaser.GameObjects.Sprite;
  private checkpoints!: CheckpointTracker;
  private ghostSplit = '';

  /** True once the run has ended (finish or wipeout) and `ResultScene` has
   *  been started — guards against re-triggering the transition on a later
   *  frame this same scene instance might still process. */
  private raceOver = false;
  /** Every world-space display object, so the UI camera can ignore them all. */
  private worldObjects: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super({ key: 'RaceScene' });
  }

  create(data: RaceSceneData): void {
    // Reset per-race primitive state explicitly: Phaser reuses this scene
    // instance across restarts, so a field's inline initializer (`= false`,
    // `= 0`) only ever runs once, at construction — NOT on every `create()`.
    this.raceOver = false;
    this.fixedClock.reset();
    this.simulationHitStopMs = 0;
    this.frameStruckRiders = [];
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.elapsedRaceMs = 0;
    this.paused = false;
    this.countdownMs = 1800;
    this.previousCharges = 0;
    this.previousHitReaction = false;
    this.worldRoll = 0;
    this.previousUpdateAt = performance.now();
    this.resumePending = false;
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
    this.options = normalizeRaceOptions(data?.mode && data.runId ? data as RaceOptions : { ...createQuickRace(this.seed), ...data, seed: this.seed });
    this.practiceLesson = Math.max(0, Math.min(2, data?.practiceLesson ?? 0));
    this.practiceObjective = this.options.mode === 'practice' && !this.options.dailyDate ? new PracticeObjectives(this.practiceLesson) : null;
    this.practiceFeedback = data?.practiceFeedback ?? PRACTICE_LESSONS[this.practiceLesson].hint;
    this.practiceAdvanceAt = 0;
    this.practiceLaunched = false;
    this.counterCount = 0;
    this.practiceComplete = false;
    const generated = generateTrack(this.seed);
    this.track = generated.segments;
    this.mountainSections = generated.sections;
    this.obstacles = generated.obstacles;
    this.pickups = generated.pickups;
    // Precompute world-Z of each jumpable crest apex (centre of the apex
    // segment) for the auto-launch crossing test (§4.3).
    this.crestApexZs = generated.crestApexes.map((i) => i * SEGMENT_LENGTH + SEGMENT_LENGTH / 2);
    this.finishSegment = this.track.find((segment) => segment.isFinish);
    this.ghost = this.practiceObjective ? null : loadGhost(this.seed);
    this.ghostRecorder = new GhostRecorder(this.seed, this.finishSegment!.z);
    this.checkpoints = new CheckpointTracker(checkpointWorldZs(PLAYER_START_Z, this.finishSegment!.z));
    this.ghostSplit = this.practiceObjective ? '' : this.ghost ? 'PERSONAL GHOST · CHECKPOINT 1 AHEAD' : 'FINISH TO SET YOUR PERSONAL GHOST';

    this.skyRenderer = new SkyRenderer(this);
    this.roadRenderer = new RoadRenderer(this);
    this.roadRenderer.setDepth(DEPTH.ROAD);
    this.finishBanner = new FinishBanner(this);
    this.finishBanner.setDepth(DEPTH.BANNER);
    this.shadows = new ShadowRenderer(this, this.registerWorld);
    this.obstacleRenderer = new ObstacleRenderer(this, this.registerWorld);
    this.sceneryRenderer = new SceneryRenderer(this, this.seed, this.track.length, this.registerWorld);
    this.collisions = new CollisionSystem();

    // 4 AI riders from the params drawn by the generator's placement pass
    // (same seeded PRNG as geometry/obstacles), each with its OWN
    // CollisionSystem instance — the `hit` set inside CollisionSystem is
    // per-rider, so sharing one across riders would let one rider's dodge
    // failure silently clear an obstacle for everyone else.
    this.aiRiders = generated.aiRiders.map((params, i) => new AIRider(cupRivalParams(i, params)));
    this.aiCollisions = this.aiRiders.map(() => new CollisionSystem());
    this.aiRiderRenderer = new AIRiderRenderer(this, this.registerWorld);
    this.aiRiderRenderer.reducedMotion = this.reducedMotion;
    this.pickupRenderer = new PickupRenderer(this, this.registerWorld);

    this.player = new Player();
    if (this.practiceObjective) this.configurePractice();
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

    this.playerSprite = this.add.sprite(SCREEN_W / 2, SCREEN_H * 0.8, getSelectedPlayerTexture(this), PLAYER_FRAMES.CENTER);
    this.playerSprite.setOrigin(0.5, 1);
    this.playerSprite.setDepth(DEPTH.PLAYER);
    this.registerWorld(this.playerSprite);
    this.ghostSprite = this.add.sprite(0, 0, PLAYER_TEXTURE_KEY, PLAYER_FRAMES.CENTER)
      .setOrigin(0.5, 1).setAlpha(0.32).setTint(0x88f6ff).setVisible(false);
    this.registerWorld(this.ghostSprite);
    this.ghostRecorder.capture(0, this.ghostPose());

    // Every world-space object must be registered, not just the pooled
    // sprites: the UI camera draws the whole display list minus what it
    // ignores, and it renders AFTER the main camera — so anything left
    // unregistered gets repainted on top of the world. Missing the road and
    // sky graphics here hid the player and the entire rival pack behind a
    // second copy of the backdrop.
    this.skyRenderer.displayObjects.forEach(this.registerWorld);
    this.roadRenderer.displayObjects.forEach(this.registerWorld);
    this.finishBanner.displayObjects.forEach(this.registerWorld);

    this.audio = getRaceAudio();
    this.buildHud();
    this.bindRaceLifecycle();
    this.playerInput.setEnabled(false);
    if (!isAppActive(this.game)) this.setPaused(true);

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
    this.hud = new RaceHud(this, this.seed, {
      pause: () => this.setPaused(true),
      resume: () => this.setPaused(false),
      restart: () => this.scene.restart({ ...retryRace(this.options), practiceLesson: this.practiceLesson }),
      menu: () => this.scene.start('TitleScene'),
      mute: () => this.audio.toggle(),
      control: (action, down, source) => this.playerInput.setAction(action, down, source)
    });
    this.hud.setMuted(this.audio.isMuted);
    this.uiCamera = this.cameras.add(0, 0, SCREEN_W, SCREEN_H);
    this.uiCamera.setName('ui');
    this.uiCamera.transparent = true;
    this.uiCamera.ignore(this.worldObjects);
    this.cameras.main.ignore(this.hud.objects);
  }

  private bindRaceLifecycle(): void {
    const keyboard = this.input.keyboard;
    const pause = oncePerKeyEvent(event => { if (!event.repeat && isAppActive(this.game)) this.setPaused(!this.paused); });
    const restart = oncePerKeyEvent(event => { if (!event.repeat && this.paused && !this.practiceComplete && !this.raceOver && isAppActive(this.game)) this.scene.restart({ ...retryRace(this.options), practiceLesson: this.practiceLesson }); });
    const mute = oncePerKeyEvent(event => { if (!event.repeat) this.hud.setMuted(this.audio.toggle()); });
    const blur = () => this.setPaused(true);
    const cancel = () => { this.playerInput.reset(); this.hud.cancelInput(); };
    const foreground = () => { this.previousUpdateAt = performance.now(); };
    const unlock = () => this.audio.unlock();
    const lifecycleKeys = keyboard?.addKeys('P,ESC,R,M') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    keyboard?.on('keydown-P', pause);
    keyboard?.on('keydown-ESC', pause);
    keyboard?.on('keydown-R', restart);
    keyboard?.on('keydown-M', mute);
    keyboard?.on('keydown', unlock);
    this.input.on('pointerdown', unlock);
    this.game.events.on(Phaser.Core.Events.BLUR, blur);
    this.game.events.on(Phaser.Core.Events.HIDDEN, blur);
    this.game.events.on(APP_INACTIVE, blur);
    this.game.events.on(CANCEL_INPUT, cancel);
    this.game.events.on(APP_ACTIVE, foreground);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      keyboard?.off('keydown-P', pause);
      keyboard?.off('keydown-ESC', pause);
      keyboard?.off('keydown-R', restart);
      keyboard?.off('keydown-M', mute);
      keyboard?.off('keydown', unlock);
      Object.values(lifecycleKeys ?? {}).forEach(key => keyboard?.removeKey(key, true, true));
      keyboard?.removeCapture('P,ESC,R,M');
      this.input.off('pointerdown', unlock);
      this.game.events.off(Phaser.Core.Events.BLUR, blur);
      this.game.events.off(Phaser.Core.Events.HIDDEN, blur);
      this.game.events.off(APP_INACTIVE, blur);
      this.game.events.off(CANCEL_INPUT, cancel);
      this.game.events.off(APP_ACTIVE, foreground);
      this.playerInput.destroy();
      this.audio.ride(0);
    });
  }

  private setPaused(paused: boolean): void {
    if (this.practiceComplete || this.raceOver || (!paused && !isAppActive(this.game))) return;
    if (this.paused === paused) {
      if (paused) { this.playerInput.reset(); this.hud.cancelInput(); }
      return;
    }
    this.paused = paused;
    this.fixedClock.discardPending();
    this.hud.setPaused(paused);
    if (paused) this.audio.ride(0);
    this.playerInput.setEnabled(!paused && this.countdownMs === 0);
    if (!paused) {
      this.previousUpdateAt = performance.now();
      this.resumePending = true;
      this.audio.unlock();
    }
  }

  update(_wallTime: number, frameDelta: number): void {
    // Match the input event clock, not RAF's possibly delayed timestamp. Tick
    // every render attempt, including pause/hit-stop, so a stale command can
    // never borrow the entire interruption as its fresh-frame allowance.
    const updateAt = performance.now();
    const inputFrameElapsedMs = Math.max(0, updateAt - this.previousUpdateAt);
    this.previousUpdateAt = updateAt;
    if (this.paused) return;
    const resumed = this.resumePending;
    this.resumePending = false;
    // Bound a frame's travel below the collision window. A slow/background
    // frame must never teleport through a tree or consume a whole jump.
    let delta = resumed ? 0 : Math.min(50, Math.max(0, frameDelta));
    this.hud.tick(delta);
    if (this.countdownMs > 0) {
      // Countdown is a wall-time affordance, not physics. Phaser smoothing
      // discards >200 ms frames as hiccups, which stretched three beats into
      // ~17 seconds on software-rendered CI. Raw frame time keeps it honest;
      // movement remains bounded separately and explicit pause still freezes it.
      // A Resume gesture can arrive before the first restored RAF. Never
      // count that frame's background gap against the starting countdown.
      const countdownDelta = resumed ? 0 : Math.min(1000, Math.max(0, this.game.loop.rawDelta || frameDelta));
      this.countdownMs = Math.max(0, this.countdownMs - countdownDelta);
      this.hud.setCountdown(this.countdownMs > 1200 ? '3' : this.countdownMs > 600 ? '2' : this.countdownMs > 0 ? '1' : '');
      if (this.countdownMs === 0) {
        this.playerInput.setEnabled(true);
        this.hud.showMessage('DROP IN!', UI.accentGood);
        this.audio.play('go');
      }
      delta = 0;
    }
    const time = this.elapsedRaceMs;
    if (this.raceOver) return;
    this.frameStruckRiders = [];
    this.fixedClock.advance(delta, (step) => {
      if (this.raceOver || this.paused || this.practiceComplete) return false;
      this.simulate(step, inputFrameElapsedMs);
      return !this.raceOver && !this.paused && !this.practiceComplete;
    });
    if (this.raceOver) return;

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
    this.worldRoll = this.reducedMotion ? 0 : Phaser.Math.Linear(this.worldRoll, -this.player.leanDirection * 0.008, 0.12);
    this.cameras.main.setRotation(this.worldRoll);
    this.sceneryRenderer.render(this.track, result.drawnSegments, { x: camX, y: camY, z: camZ });
    this.shadows.begin();
    this.finishBanner.render(this.finishSegment, this.track, result.drawnSegments, { x: camX, y: camY, z: camZ });
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
    this.renderGhost(camX, camY, camZ, result.drawnSegments);
    this.updatePlayerSprite(camX, camY, camZ, result.drawnSegments);
    this.renderTargetMarker(camX, camY, camZ, result.drawnSegments);
    this.emitCombatFeedback(this.frameStruckRiders, camX, camY, camZ, result.drawnSegments);
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
    this.audio.ride(this.player.speed / MAX_SPEED, this.player.airborne, this.player.leanDirection !== 0);

  }

  private configurePractice(): void {
    // Explicit training fixture: real controllers/physics/combat on a forgiving
    // flat run. It never enters career, ghost, daily or cup record paths.
    for (const segment of this.track) { segment.curve = 0; segment.y = 0; }
    this.obstacles.splice(0);
    this.pickups.splice(0);
    this.crestApexZs = [];
    const personality = (['bully', 'line-defender', 'daredevil'] as const)[this.practiceLesson];
    const rider = new AIRider({ ...this.aiRiders[0].params, personality, behaviorSeed: 700 + this.practiceLesson,
      startLane: this.practiceLesson === 1 ? 2 : 1,
      startZOffset: PLAYER_START_Z + (this.practiceLesson === 1 ? 600 : this.practiceLesson === 2 ? 700 : 90),
      aggression: this.practiceLesson === 0 ? 0 : 0.9,
      cruiseSpeedFactor: this.practiceLesson === 1 ? 0.92 : 1 });
    this.aiRiders.splice(0, this.aiRiders.length, rider);
    this.aiCollisions = [new CollisionSystem()];
    this.player.speed = MAX_SPEED;
    rider.speed = MAX_SPEED * rider.params.cruiseSpeedFactor;
    this.practiceMogulZ = PLAYER_START_Z + 5400;
    if (this.practiceLesson === 2) {
      this.obstacles.push({ kind: 'mogul', lane: 2, z: this.practiceMogulZ, segIndex: Math.floor(this.practiceMogulZ / SEGMENT_LENGTH) },
        { kind: 'mogul', lane: 1, z: this.practiceMogulZ - 200, segIndex: Math.floor((this.practiceMogulZ - 200) / SEGMENT_LENGTH) });
    }
  }

  private advancePractice(): boolean {
    const objective = this.practiceObjective!;
    const rider = this.aiRiders[0];
    if (this.practiceLesson === 0 && !this.practiceLaunched && this.elapsedRaceMs >= 850) {
      this.practiceLaunched = rider.requestTelegraphedAttack(this.player);
    }
    if (this.practiceLesson === 1 && this.player.worldZ > rider.worldZ + 160 &&
        Math.abs(this.player.laneOffsetFraction - rider.laneOffsetFraction) >= 0.35) objective.passed = true;
    if (this.practiceLesson === 2) {
      if (this.player.airborne && this.player.extendedJump && this.player.worldZ >= this.practiceMogulZ - 800) objective.jumped = true;
      if (objective.jumped && !this.player.airborne && this.player.worldZ > this.practiceMogulZ && !this.player.stumbling) objective.landed = true;
    }
    if (objective.complete && this.practiceAdvanceAt === 0) {
      this.practiceFeedback = this.practiceLesson === 0 ? 'COUNTER LANDED! You turned their attack against them.' : this.practiceLesson === 1 ? 'CLEAN PASS! You kept your speed and avoided the fight.' : 'TRICK LANDED! You are ready for the circuit.';
      this.practiceAdvanceAt = this.elapsedRaceMs + 1400;
      this.hud.showMessage('LESSON COMPLETE', UI.accentGood);
      this.audio.play('score');
    }
    if (this.practiceAdvanceAt && this.elapsedRaceMs >= this.practiceAdvanceAt) {
      if (this.practiceLesson < 2) {
        this.raceOver = true;
        this.scene.restart({ ...this.options, practiceLesson: this.practiceLesson + 1 });
      } else this.finishPractice();
      return true;
    }
    if (!objective.complete && (this.elapsedRaceMs > 8500 || this.player.wipedOut)) {
      this.raceOver = true;
      this.scene.restart({ ...this.options, practiceLesson: this.practiceLesson,
        practiceFeedback: this.practiceLesson === 0 ? 'Try again: evade late in the wind-up, then HIT when COUNTER appears.' : this.practiceLesson === 1 ? 'Try again: carve away from the center, then hold your clear lane.' : 'Try again: stay in the center and JUMP just before the mound.' });
      return true;
    }
    return false;
  }

  private finishPractice(): void {
    if (this.practiceComplete) return;
    this.practiceComplete = true;
    this.raceOver = true;
    this.paused = true;
    this.playerInput.setEnabled(false);
    this.hud.setPracticeComplete();
    this.audio.ride(0);
    const before = new Set(this.children.list);
    this.add.rectangle(480, 270, 960, 540, UI.panel, 0.96).setDepth(12000);
    menuText(this, 480, 137, 'READY FOR THE CIRCUIT', 34, UI.accentGood, true).setOrigin(0.5).setDepth(12001);
    menuText(this, 480, 212, 'Read the bully. Pass the defender. Fly with the daredevil.', 18, UI.inkHigh, true).setOrigin(0.5).setDepth(12001);
    menuText(this, 480, 254, 'Practice complete · No scores or records were changed.', 14, UI.inkMid).setOrigin(0.5).setDepth(12001);
    const replay = () => this.scene.restart({ ...this.options, practiceLesson: 0 });
    const lodge = () => this.scene.start('TitleScene');
    menuButton(this, 180, 326, 285, 'PRACTICE AGAIN', 'ENTER', replay, true);
    menuButton(this, 495, 326, 285, 'BASE CAMP', 'ESC', lodge);
    const added = this.children.list.filter(obj => !before.has(obj));
    for (const obj of added) { if ('setDepth' in obj) (obj as unknown as Phaser.GameObjects.Components.Depth).setDepth(12001); }
    this.cameras.main.ignore(added);
    menuKeys(this, code => { if (code === 'Enter') replay(); if (code === 'Escape') lodge(); });
  }

  /** Fixed 60 Hz gameplay. Rendering, particle RNG and display refresh do not
   * participate in competitive simulation or opponent decision streams. */
  private simulate(delta: number, inputFrameElapsedMs: number): void {
    this.elapsedRaceMs += delta;
    const time = this.elapsedRaceMs;
    if (this.simulationHitStopMs > 0) {
      this.simulationHitStopMs = Math.max(0, this.simulationHitStopMs - delta);
      return;
    }
    // Attack is polled here rather than fired from a key handler: handlers
    // still run during hit-stop, when this method early-returns above, so a
    // handler-driven attack would resolve combat inside the freeze on a stale
    // clock. A press with no eligible target is refused by `attemptAttack`
    // itself and costs nothing.
    this.playerInput.update(delta, inputFrameElapsedMs);
    if (this.playerInput.attackJustPressed()) {
      this.combat.attemptAttack(time);
    }

    const prevZ = this.player.worldZ;
    this.player.update(delta);

    // Crest auto-launch (§4.3): crossing a jumpable crest's apex fires an
    // extended trick jump with NO jump press — the crest acts as a ramp. No
    // speed threshold (spec §4.3 note 14). `jump()` no-ops if already airborne
    // (e.g. launched off a mogul just before the crest) or wiped out.
    for (const apexZ of this.crestApexZs) {
      if (prevZ < apexZ && this.player.worldZ >= apexZ) {
        this.player.jump(true, false);
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
    for (const event of this.combat.skillEvents.splice(0)) {
      this.practiceObjective?.combat(event.type);
      if (event.type === 'evade') { this.hud.showMessage('EVADED · COUNTER NOW!', UI.accentGood); this.audio.play('score'); }
      if (event.type === 'counter') { this.counterCount++; this.hud.showMessage('COUNTER HIT!', UI.accentGood); }
    }
    if (this.practiceObjective && this.advancePractice()) return;

    // Ski-pole pickup (§4.6): collected by lane + Z, including while
    // airborne — unlike obstacles, never gated on `player.airborne`.
    collectPickups(this.player, this.pickups);
    if (this.player.weaponCharges > this.previousCharges) {
      this.hud.showMessage('SKI POLE · 3 POWER HITS', UI.accentWarn);
      this.audio.play('pickup');
    }
    this.previousCharges = this.player.weaponCharges;

    // Combat feedback is emitted AFTER the render pass (`emitCombatFeedback`)
    // so the struck rival can be projected with THIS frame's offset-walk
    // data — but the riders must be captured here, because
    // `ScoreTracker.update()` below drains `combat.events`.
    this.frameStruckRiders.push(...this.combat.events.map((event) => event.rider));
    if (this.combat.events.length) this.simulationHitStopMs = Math.max(this.simulationHitStopMs, 50);

    // Collision feedback, fired on state TRANSITIONS so neither the collision
    // system nor combat needs to know anything is watching.
    if (this.player.wipedOut && !this.prevWiped) this.simulationHitStopMs = 133.33333333333334;
    else if (this.player.tumbling && !this.prevTumbling) this.simulationHitStopMs = 83.33333333333334;
    this.emitCollisionFeedback();

    // Scoring reads this frame's settled combat/collision/pickup state —
    // must run after all of the above.
    this.scoreTracker.update(delta);
    const feedback = this.scoreTracker.feedback;
    if (feedback.length > 0) {
      const primary = feedback.find(e => e.kind === 'knockout') ?? feedback.find(e => e.kind === 'hit') ?? feedback[feedback.length - 1];
      const total = feedback.reduce((sum, e) => sum + e.points, 0);
      this.hud.showMessage(`${primary.label}  +${total}${this.scoreTracker.chain >= 3 ? `   ${this.scoreTracker.chain} EVENT FLOW` : ''}`, primary.kind === 'near' ? UI.accentInfo : UI.accentWarn);
      if (primary.kind === 'near' || primary.kind === 'trick') this.audio.play('score');
    }

    if (!this.practiceObjective) {
      this.ghostRecorder.capture(time, this.ghostPose());
      const splits = this.checkpoints.update(prevZ, this.player.worldZ, time - delta, time, this.ghost ?? undefined);
      for (const split of splits) {
        this.ghostSplit = split.deltaMs === null ? `CHECKPOINT ${split.index + 1} · ${(split.timeMs / 1000).toFixed(1)}s` :
          `SPLIT ${split.index + 1} · ${split.deltaMs <= 0 ? '−' : '+'}${(Math.abs(split.deltaMs) / 1000).toFixed(2)}s TO GHOST`;
        this.hud.showMessage(this.ghostSplit, split.deltaMs !== null && split.deltaMs < 0 ? UI.accentGood : UI.accentInfo);
      }
    }

    // Wipeout ends the run immediately (§4.4/§4.7/§4.8): capture score and
    // position ONCE and hand off to ResultScene. Checked before the finish
    // check below since a tree collision can never itself put the player
    // past the finish line.
    // Gated on the hit-stop still running: a tree wipeout sets `wipedOut` and
    // triggers the heaviest impact in the game on the SAME frame, so ending
    // the race here immediately would cut to the result screen before a
    // single frozen frame — or any of the shake and spray — had been drawn.
    // Holding the transition until the freeze expires lets the crash land.
    if (this.player.wipedOut && this.simulationHitStopMs <= 0) {
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
    this.playerInput.setEnabled(false);
    const recording = this.ghostRecorder.finish(this.elapsedRaceMs, this.ghostPose(), finished);
    const ghostSaved = recording ? saveGhost(this.options, recording) : false;
    if (finished) {
      // Held a couple of segments BEHIND the finish line rather than exactly
      // on it: project() culls anything at dz <= 0, so parking the camera
      // exactly at the banner's own z would make it invisible on this final
      // render — not that ResultScene needs it, but keeps worldZ sane.
      this.player.worldZ = Math.max(0, this.finishSegment!.z - FINISH_HOLD_BACK);
    }
    // All finish stamps use the same pause-aware race clock. Menu dwell,
    // countdown, and time spent in the pause overlay never reduce time bonus.
    const playerFinishTimeMs = finished ? nowMs : null;
    const position = computePlayerPosition(this.player, this.aiRiders, playerFinishTimeMs);
    const breakdown = this.scoreTracker.finalize(finished, this.elapsedRaceMs, position);
    const course = recordRun(this.options, breakdown);
    const awards = awardRun(this.options, breakdown);
    const cup = this.options.mode === 'cup' ? completeCupRound(this.options, [
      { id: 'player', worldZ: this.player.worldZ, finishTimeMs: playerFinishTimeMs, wipedOut: !finished },
      ...this.aiRiders.map((r, i) => ({ id: `rival-${i}` as 'rival-0' | 'rival-1' | 'rival-2' | 'rival-3', worldZ: r.worldZ, finishTimeMs: r.finishTimeMs, wipedOut: r.wipedOut }))
    ]) : null;
    this.scene.start('ResultScene', { seed: this.seed, breakdown, bestScore: course.bestScore,
      isNewBest: course.isNewBest, options: this.options, course, awards, cup, ghostSaved });
  }

  private updateHud(): void {
    const courseLength = (this.finishSegment?.z ?? COURSE_LENGTH_SEGMENTS * SEGMENT_LENGTH) - PLAYER_START_Z;
    this.hud.update({
      sectionName: this.practiceObjective ? 'TRAINING SLOPE' : sectionAtZ(this.mountainSections, this.player.worldZ)?.name,
      modeLabel: this.options.mode === 'daily' ? `DAILY ${this.options.dailyDate} UTC` : this.options.mode === 'cup' ? `CUP · RACE ${(this.options.roundIndex ?? 0) + 1} / 3` : this.practiceObjective ? 'PRACTICE' : this.options.dailyDate ? `${this.options.dailyDate} · PRACTICE` : 'MOUNTAIN RUN',
      incomingAttack: this.combat.incomingAttack ? 'WIND UP' : undefined,
      counterReady: this.combat.counterReady,
      ghostSplit: this.ghostSplit,
      practice: this.practiceObjective ? { ...PRACTICE_LESSONS[this.practiceLesson], feedback: this.practiceFeedback } : undefined,
      score: this.scoreTracker.runningScore,
      speed: this.player.speed / MAX_SPEED,
      position: computePlayerPosition(this.player, this.aiRiders, null),
      elapsedMs: this.elapsedRaceMs,
      progress: Phaser.Math.Clamp((this.player.worldZ - PLAYER_START_Z) / courseLength, 0, 1),
      charges: this.player.weaponCharges,
      attackCooldown: this.combat.attackCooldownFraction,
      target: this.combat.target !== null,
      targetAdvantage: this.player.armed || this.player.speed >= (this.combat.target?.speed ?? Infinity),
      airborne: this.player.airborne,
      recovering: this.player.tumbling,
      chain: this.scoreTracker.chain,
      chainRemaining: this.scoreTracker.chainRemaining,
      rivals: this.aiRiders.map((r, i) => ({ progress: (r.worldZ - PLAYER_START_Z) / courseLength, color: RIVAL_SUITS[i], out: r.wipedOut }))
    });
  }

  private ghostPose(): { worldZ: number; laneOffset: number; jumpHeight: number; lean: number } {
    return { worldZ: this.player.worldZ, laneOffset: this.player.laneOffsetFraction,
      jumpHeight: this.player.jumpArcHeight, lean: this.player.leanDirection };
  }

  private renderGhost(camX: number, camY: number, camZ: number, drawn: Map<number, DrawnSegment>): void {
    const pose = this.ghost ? sampleGhost(this.ghost, this.elapsedRaceMs) : null;
    if (!pose) { this.ghostSprite.setVisible(false); return; }
    const projected = projectEntity(pose.laneOffset, pose.worldZ, this.track, drawn,
      { x: camX, y: camY, z: camZ }, pose.jumpHeight * PLAYER_JUMP_HEIGHT_WORLD);
    if (!projected) { this.ghostSprite.setVisible(false); return; }
    const width = softClampWidth(projected.screenW * PLAYER_WIDTH_FRACTION, SCREEN_W * MAX_ENTITY_SCREEN_FRACTION);
    this.ghostSprite.setVisible(true).setPosition(projected.screenX, projected.screenY)
      .setScale(width / PLAYER_FRAME_SIZE).setDepth(DEPTH.ENTITY - pose.worldZ)
      .setFrame(pose.jumpHeight > 0 ? PLAYER_FRAMES.JUMP : pose.lean < 0 ? PLAYER_FRAMES.LEAN_LEFT : pose.lean > 0 ? PLAYER_FRAMES.LEAN_RIGHT : PLAYER_FRAMES.CENTER);
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
    // A little articulated board lean bridges the discrete illustration poses.
    // It is presentation only: the collision line remains the exact lane tween.
    const targetAngle = this.player.tumbling ? Math.sin(this.elapsedRaceMs / 90) * 32
      : this.player.hitReacting ? -11 : this.player.swinging ? 8
      : this.player.airborne ? Math.sin(this.elapsedRaceMs / 180) * 5 : lean * 7;
    this.playerSprite.setAngle(Phaser.Math.Linear(this.playerSprite.angle, targetAngle, 0.28));
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
    this.targetMarker.fillStyle(this.combat.counterReady ? UI.accentGood : UI.accentWarn, 0.92);
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
    if (struckRiders.length > 0) this.audio.play('hit');
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
      this.audio.play('crash');
    } else if (this.player.tumbling && !this.prevTumbling) {
      // Rock: a hard knockdown, recoverable.
      this.juice.impact(x, y, 0.62);
      this.audio.play('crash');
      this.hud.showMessage('ROCK HIT · RECOVERING', UI.accentBad);
    } else if (this.player.stumbling && !this.prevStumbling) {
      // Mogul: a bump, not a crash — spray and a nudge, no flash.
      this.juice.impact(x, y, 0.18);
      this.audio.play('land');
    }

    if (this.player.airborne && !this.prevAirborne) this.audio.play('jump');
    if (this.player.hitReacting && !this.previousHitReaction) {
      this.audio.play('hit');
      this.hud.showMessage('RIVAL HIT · FIGHT BACK', UI.accentBad);
    }
    this.previousHitReaction = this.player.hitReacting;

    // Landing. An extended (trick) landing is a reward, so it sparkles rather
    // than shakes.
    if (!this.player.airborne && this.prevAirborne && !this.player.wipedOut) {
      this.audio.play('land');
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
