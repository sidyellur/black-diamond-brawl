import {
  CAMERA_HEIGHT,
  JUMP_AIRTIME_EXTENDED_MS,
  JUMP_AIRTIME_MS,
  LANE_TWEEN_MS,
  LANES,
  MAX_SPEED,
  MOGUL_SPEED_FACTOR,
  MOGUL_STUMBLE_MS,
  PLAYER_ACCEL,
  ROAD_WIDTH,
  ROCK_IMMUNITY_MS,
  ROCK_SPEED_FACTOR,
  ROCK_TUMBLE_MS
} from '../config';
import { roadElevationAt, Segment } from '../track/segment';

const CENTER_LANE_INDEX = Math.floor(LANES.length / 2);

// Smoothstep eases the lane tween in/out instead of moving linearly.
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

interface LaneTween {
  fromLane: number;
  toLane: number;
  elapsedMs: number;
}

/**
 * The player entity (design-spec §4.1/§4.3): world-Z position and speed,
 * a discrete lane index with a tweened lateral offset, and jump/airborne
 * state. This is the first entity separate from the road itself — the
 * camera (in RaceScene) reads `worldZ`/`worldX`/`camY()` off this each frame
 * instead of free-running on its own.
 *
 * Owns its own input-buffering and jump-arc timing so `RaceScene` just calls
 * `update()` plus `requestLaneShift()`/`requestJump()` from input handlers.
 */
export class Player {
  worldZ = 0;
  speed = 0;

  private laneIndex = CENTER_LANE_INDEX;
  private tween: LaneTween | null = null;
  private bufferedDirection: -1 | 1 | null = null;

  airborne = false;
  private jumpElapsedMs = 0;
  /** Airtime of the CURRENT/most-recent jump (§4.3): normal or extended. */
  private jumpAirtimeMs = JUMP_AIRTIME_MS;
  /** Whether the current/most-recent jump was an extended (trick) launch off a
   *  mogul or crest. Exposed for Task 9's trick scoring; not scored here. */
  extendedJump = false;

  /** Run-ending wipeout latch (tree collision, §4.4). Freezes the player;
   *  real game-over/restart is Task 9. */
  wipedOut = false;

  // Temporary-collision timers (design-spec §4.4). While `tumbleMsRemaining`
  // > 0 the player can't steer (rock knockdown); `immunityMsRemaining` grants
  // post-recovery collision immunity; `stumbleMsRemaining` is a cosmetic mogul
  // wobble with no control loss.
  private tumbleMsRemaining = 0;
  private immunityMsRemaining = 0;
  private stumbleMsRemaining = 0;

  update(deltaMs: number): void {
    if (this.wipedOut) {
      return; // run-ending wipeout: frozen until Task 9's restart flow
    }

    const deltaSeconds = deltaMs / 1000;

    // Auto-acceleration toward MAX_SPEED (§4.1) — no brake/tuck control in v1.
    // Speed recovers automatically after a collision knocked it down.
    this.speed = Math.min(MAX_SPEED, this.speed + PLAYER_ACCEL * deltaSeconds);
    this.worldZ += this.speed * deltaSeconds;

    this.tumbleMsRemaining = Math.max(0, this.tumbleMsRemaining - deltaMs);
    this.immunityMsRemaining = Math.max(0, this.immunityMsRemaining - deltaMs);
    this.stumbleMsRemaining = Math.max(0, this.stumbleMsRemaining - deltaMs);

    this.updateLaneTween(deltaMs);
    this.updateJump(deltaMs);
  }

  /** Left/Right (or A/D): shift one lane, clamped to the road edges (§4.3). */
  requestLaneShift(direction: -1 | 1): void {
    if (this.wipedOut || this.tumbleMsRemaining > 0) {
      return; // frozen (tree) or tumbling (rock): no steering control
    }
    if (this.airborne) {
      return; // committed jump: steering is locked mid-air, input is dropped
    }
    if (this.tween) {
      // One-deep buffer: a rapid second tap overwrites any previously
      // buffered direction rather than queuing, so mashing never stacks up
      // more than one pending shift (never skips a lane).
      this.bufferedDirection = direction;
      return;
    }
    this.startLaneTween(direction);
  }

  /** Space/Up: a normal fixed-impulse jump (§4.3). No double-jump. Kept for
   *  input wiring; `RaceScene` decides via `jump()` whether a jump press near a
   *  mogul should be an extended launch instead. */
  requestJump(): void {
    this.jump(false);
  }

  /**
   * Start a jump (§4.3). `extended` doubles the airtime (~1,200ms) for a mogul
   * or crest trick launch; a normal jump is ~600ms. No-op while airborne (no
   * double-jump) or frozen by a run-ending wipeout.
   */
  jump(extended: boolean): void {
    if (this.airborne || this.wipedOut) {
      return;
    }
    this.airborne = true;
    this.jumpElapsedMs = 0;
    this.extendedJump = extended;
    this.jumpAirtimeMs = extended ? JUMP_AIRTIME_EXTENDED_MS : JUMP_AIRTIME_MS;
  }

  /** True while the player can't be collided with (§4.4): mid-tumble from a
   *  rock, or in the post-recovery immunity window. */
  get collisionImmune(): boolean {
    return this.tumbleMsRemaining > 0 || this.immunityMsRemaining > 0;
  }

  /** Cosmetic-only wobble flag for the mogul stumble (sprite shimmy). */
  get stumbling(): boolean {
    return this.stumbleMsRemaining > 0;
  }

  /** Whether the player is currently in the no-steer tumble (rock knockdown). */
  get tumbling(): boolean {
    return this.tumbleMsRemaining > 0;
  }

  /** Tree collision (§4.4): run-ending wipeout — freeze the player. Real
   *  game-over/restart is Task 9; here it just latches and logs. */
  crashIntoTree(): void {
    if (this.wipedOut) {
      return;
    }
    this.wipedOut = true;
    this.speed = 0;
    this.airborne = false;
    // eslint-disable-next-line no-console
    console.log('[BDB] WIPEOUT: hit a tree — run over (real game-over is Task 9)');
  }

  /** Rock collision (§4.4): temporary wipeout — speed drops to ~30%, ~1s
   *  no-steer tumble, then ~1s collision immunity. */
  hitRock(): void {
    this.speed *= ROCK_SPEED_FACTOR;
    this.tumbleMsRemaining = ROCK_TUMBLE_MS;
    this.immunityMsRemaining = ROCK_TUMBLE_MS + ROCK_IMMUNITY_MS; // immunity runs through the tumble and 1s past it
    this.airborne = false;
    this.tween = null; // cancel any in-flight steer; control is lost during tumble
    this.bufferedDirection = null;
  }

  /** Mogul collision when ridden over without jumping (§4.4): a stumble —
   *  ~25% speed loss and a brief wobble, but no control loss. */
  hitMogul(): void {
    this.speed *= MOGUL_SPEED_FACTOR;
    this.stumbleMsRemaining = MOGUL_STUMBLE_MS;
  }

  /** Current lane-offset fraction of road half-width (one of LANES, or
   *  tweening between two of them). Feeds both camX and the sprite lean. */
  get laneOffsetFraction(): number {
    if (!this.tween) {
      return LANES[this.laneIndex];
    }
    const t = smoothstep(Math.min(1, this.tween.elapsedMs / LANE_TWEEN_MS));
    const from = LANES[this.tween.fromLane];
    const to = LANES[this.tween.toLane];
    return from + (to - from) * t;
  }

  /** World-X position. ROAD_WIDTH is already the road HALF-width (see
   *  project.ts/RoadRenderer, which use it directly as the projected
   *  half-width), so lane fractions scale it directly rather than by half. */
  get worldX(): number {
    return this.laneOffsetFraction * ROAD_WIDTH;
  }

  /** Camera elevation: the ROAD's elevation at the player's world-Z, plus the
   *  fixed camera height — deliberately NOT `jumpArcHeight`. The jump arc is
   *  a sprite-only animation; the camera must stay smooth through it,
   *  including over hills/crests (§4.1). */
  camY(track: Segment[]): number {
    return roadElevationAt(track, this.worldZ) + CAMERA_HEIGHT;
  }

  /** 0..1 parabola while airborne, for sprite bob height only — never fed
   *  into world-Y/camera math. Uses the current jump's airtime, so an extended
   *  (mogul/crest) launch traces a longer, higher-feeling arc. */
  get jumpArcHeight(): number {
    if (!this.airborne) {
      return 0;
    }
    const t = this.jumpElapsedMs / this.jumpAirtimeMs;
    return 4 * t * (1 - t);
  }

  /** Direction of the in-progress lane tween (for sprite lean frame), 0 when
   *  settled on a lane. */
  get leanDirection(): -1 | 0 | 1 {
    if (!this.tween) {
      return 0;
    }
    return this.tween.toLane > this.tween.fromLane ? 1 : -1;
  }

  private startLaneTween(direction: -1 | 1): void {
    const target = clamp(this.laneIndex + direction, 0, LANES.length - 1);
    if (target === this.laneIndex) {
      return; // already at the road edge; nothing to do
    }
    this.tween = { fromLane: this.laneIndex, toLane: target, elapsedMs: 0 };
  }

  private updateLaneTween(deltaMs: number): void {
    if (!this.tween) {
      return;
    }
    this.tween.elapsedMs += deltaMs;
    if (this.tween.elapsedMs < LANE_TWEEN_MS) {
      return;
    }

    this.laneIndex = this.tween.toLane;
    this.tween = null;

    if (this.bufferedDirection !== null) {
      const direction = this.bufferedDirection;
      this.bufferedDirection = null;
      // A jump could have started while this tween was already in flight
      // (an in-progress tween is allowed to finish, it isn't cancelled mid-
      // air) — but a buffered shift should not fire once airborne.
      if (!this.airborne) {
        this.startLaneTween(direction);
      }
    }
  }

  private updateJump(deltaMs: number): void {
    if (!this.airborne) {
      return;
    }
    this.jumpElapsedMs += deltaMs;
    if (this.jumpElapsedMs >= this.jumpAirtimeMs) {
      this.airborne = false;
      this.jumpElapsedMs = 0;
    }
  }
}
