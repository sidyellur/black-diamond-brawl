import {
  LANE_TWEEN_MS,
  LANES,
  MAX_SPEED,
  MOGUL_SPEED_FACTOR,
  MOGUL_STUMBLE_MS,
  PLAYER_ACCEL,
  ROCK_IMMUNITY_MS,
  ROCK_SPEED_FACTOR,
  ROCK_TUMBLE_MS,
  SEGMENT_LENGTH
} from '../config';
import { Collidable } from './collision';
import { Obstacle } from './obstacle';

// Smoothstep eases the lane tween in/out, same curve `Player` uses.
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

interface LaneTween {
  fromLane: number;
  toLane: number;
  elapsedMs: number;
}

/**
 * Per-rider parameters (design-spec §4.5), drawn from the seeded PRNG at
 * generation time by `track/aiSpawn.ts` — never at runtime — so a seed fully
 * determines the rival field too.
 */
export interface AIRiderParams {
  /** Fraction of MAX_SPEED this rider accelerates toward (0.9-1.05). */
  cruiseSpeedFactor: number;
  /** Drawn now (part of the spec's per-rider set); Task 8's bump/combat is
   *  the only thing that reads this — unused here. */
  aggression: number;
  /** How many segments ahead this rider looks for an obstacle in its lane. */
  reactionDistanceSegments: number;
  /** Starting lane index into `LANES`. */
  startLane: number;
  /** Starting world-Z offset (staggers riders around the player's start). */
  startZOffset: number;
  /** Which palette-swapped sprite sheet this rider uses. */
  paletteIndex: number;
}

/**
 * An AI rival (design-spec §4.5): races toward its own cruise speed and
 * reactively dodges obstacles in its lane. NO combat/rider-collision and NO
 * jumping in v1 (Task 7 scope is behaviors 1-2 only; Task 8 adds bump/shove
 * off the `aggression` parameter drawn above) — `airborne` is always false,
 * so this rider never clears a rock/mogul by jumping, it can only dodge
 * sideways or take the obstacle's normal collision outcome.
 *
 * Implements `Collidable` so `CollisionSystem` (Task 6) applies the exact
 * same tree/rock/mogul rules the player gets, with no parallel logic.
 */
export class AIRider implements Collidable {
  worldZ: number;
  speed = 0;
  wipedOut = false;
  readonly airborne = false;

  private laneIndex: number;
  private tween: LaneTween | null = null;

  // Same temporary-collision timers as Player (design-spec §4.4), so a rock/
  // mogul hit produces the identical slow-down/tumble/immunity behavior.
  private tumbleMsRemaining = 0;
  private immunityMsRemaining = 0;
  private stumbleMsRemaining = 0;

  constructor(readonly params: AIRiderParams) {
    this.laneIndex = params.startLane;
    this.worldZ = params.startZOffset;
  }

  /**
   * Advances race + dodge behavior for one frame. Called every frame for
   * EVERY rider regardless of on-screen visibility (design-spec §4.5: riders
   * off-screen still simulate so finishing position stays honest and they
   * don't teleport back into view) — rendering is a separate, purely
   * read-only step in `AIRiderRenderer`.
   */
  update(deltaMs: number, obstacles: Obstacle[]): void {
    if (this.wipedOut) {
      return; // tree wipeout: frozen, same as Player.wipedOut
    }

    const deltaSeconds = deltaMs / 1000;

    // Behavior 1 (Race): accelerate toward this rider's own cruise speed.
    // Speed only ever falls via a collision outcome below, so clamping up to
    // the target here is sufficient to "recover" after one.
    const targetSpeed = MAX_SPEED * this.params.cruiseSpeedFactor;
    this.speed = Math.min(targetSpeed, this.speed + PLAYER_ACCEL * deltaSeconds);
    this.worldZ += this.speed * deltaSeconds;

    this.tumbleMsRemaining = Math.max(0, this.tumbleMsRemaining - deltaMs);
    this.immunityMsRemaining = Math.max(0, this.immunityMsRemaining - deltaMs);
    this.stumbleMsRemaining = Math.max(0, this.stumbleMsRemaining - deltaMs);

    this.updateLaneTween(deltaMs);

    // Behavior 2 (Dodge): only decide a new lane while settled and not
    // mid-tumble (control loss mirrors the player's rock knockdown).
    if (!this.tween && this.tumbleMsRemaining <= 0) {
      this.maybeDodge(obstacles);
    }
  }

  /** Current lane-offset fraction of road half-width — mirrors
   *  `Player.laneOffsetFraction` exactly so `projectEntity`/`CollisionSystem`
   *  treat this rider identically to the player. */
  get laneOffsetFraction(): number {
    if (!this.tween) {
      return LANES[this.laneIndex];
    }
    const t = smoothstep(Math.min(1, this.tween.elapsedMs / LANE_TWEEN_MS));
    const from = LANES[this.tween.fromLane];
    const to = LANES[this.tween.toLane];
    return from + (to - from) * t;
  }

  /** True while collision-immune (mid rock-tumble or the post-recovery
   *  immunity window) — same rule as `Player.collisionImmune`. */
  get collisionImmune(): boolean {
    return this.tumbleMsRemaining > 0 || this.immunityMsRemaining > 0;
  }

  /** Whether this rider can't steer right now (mid rock-tumble). */
  get tumbling(): boolean {
    return this.tumbleMsRemaining > 0;
  }

  /** Cosmetic-only mogul wobble flag, for the sprite renderer. */
  get stumbling(): boolean {
    return this.stumbleMsRemaining > 0;
  }

  /** Direction of the in-progress lane tween (sprite lean frame), 0 when
   *  settled on a lane — mirrors `Player.leanDirection`. */
  get leanDirection(): -1 | 0 | 1 {
    if (!this.tween) {
      return 0;
    }
    return this.tween.toLane > this.tween.fromLane ? 1 : -1;
  }

  /** Tree collision (§4.4): removes this rider from the race entirely —
   *  freeze it in place, same run-ending latch as `Player.crashIntoTree`. */
  crashIntoTree(): void {
    if (this.wipedOut) {
      return;
    }
    this.wipedOut = true;
    this.speed = 0;
  }

  /** Rock collision (§4.4): temporary wipeout, identical outcome to the
   *  player's — speed drops to ~30%, a no-steer tumble, then immunity. */
  hitRock(): void {
    this.speed *= ROCK_SPEED_FACTOR;
    this.tumbleMsRemaining = ROCK_TUMBLE_MS;
    this.immunityMsRemaining = ROCK_TUMBLE_MS + ROCK_IMMUNITY_MS;
    this.tween = null; // cancel any in-flight dodge; control is lost during the tumble
  }

  /** Mogul collision when ridden over (§4.4): a stumble — ~25% speed loss
   *  and a brief cosmetic wobble, no control loss. */
  hitMogul(): void {
    this.speed *= MOGUL_SPEED_FACTOR;
    this.stumbleMsRemaining = MOGUL_STUMBLE_MS;
  }

  /**
   * Dodge: looks ahead `reactionDistanceSegments` for an obstacle of ANY kind
   * in the current lane (this rider never jumps, so it can't clear even a
   * jumpable one) and, if found, steers to whichever adjacent lane is clear
   * across that same window. If neither adjacent lane is clear this frame,
   * it simply re-evaluates next frame — no general pathfinding, per
   * design-spec §4.5's "simple reactive dodge".
   */
  private maybeDodge(obstacles: Obstacle[]): void {
    const lookaheadZ = this.worldZ + this.params.reactionDistanceSegments * SEGMENT_LENGTH;
    const currentLane = this.laneIndex;
    const laneHasObstacleAhead = (lane: number): boolean =>
      obstacles.some((o) => o.lane === lane && o.z > this.worldZ && o.z <= lookaheadZ);

    if (!laneHasObstacleAhead(currentLane)) {
      return;
    }

    const candidates = [currentLane - 1, currentLane + 1].filter((l) => l >= 0 && l < LANES.length);
    for (const lane of candidates) {
      if (!laneHasObstacleAhead(lane)) {
        this.tween = { fromLane: currentLane, toLane: lane, elapsedMs: 0 };
        return;
      }
    }
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
  }
}
