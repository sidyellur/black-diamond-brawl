import {
  AI_BUMP_CHECK_INTERVAL_MS,
  LANE_TWEEN_MS,
  LANES,
  MAX_SPEED,
  MOGUL_SPEED_FACTOR,
  MOGUL_STUMBLE_MS,
  PLAYER_ACCEL,
  ROCK_IMMUNITY_MS,
  ROCK_SPEED_FACTOR,
  ROCK_TUMBLE_MS,
  SEGMENT_LENGTH,
  SHOVE_Z_WINDOW
} from '../config';
import { Collidable } from './collision';
import { Obstacle } from './obstacle';
import { Player } from './player';

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

  /** Set once this rider crosses the finish line (design-spec §4.7/§4.8), so
   *  `computePlayerPosition` can rank finishers by actual finish
   *  order instead of the frozen "held at the line" worldZ they all end up
   *  sharing (see `RaceScene`'s per-rider finish handling). `null` while
   *  still racing or if they wiped out before ever finishing. */
  finishTimeMs: number | null = null;

  private _laneIndex: number;
  private tween: LaneTween | null = null;

  // Same temporary-collision timers as Player (design-spec §4.4), so a rock/
  // mogul hit produces the identical slow-down/tumble/immunity behavior.
  private tumbleMsRemaining = 0;
  private immunityMsRemaining = 0;
  private stumbleMsRemaining = 0;

  // Combat (Task 8, design-spec §4.5 behavior 3 / §4.6). Countdown to the next
  // bump-attempt roll — deliberately seeded from `Math.random()` (runtime
  // randomness), never the seeded course-generation PRNG (§4.2). Timestamp of
  // this rider's most recent shove LOSS to the player, for knockout
  // attribution's "trees within ~2s of losing a shove" window (§4.6/§4.7).
  private bumpCooldownMs = Math.random() * AI_BUMP_CHECK_INTERVAL_MS;
  private shovedByPlayerAtMs: number | null = null;

  constructor(readonly params: AIRiderParams) {
    this._laneIndex = params.startLane;
    this.worldZ = params.startZOffset;
  }

  /**
   * Advances race + dodge + bump behavior for one frame. Called every frame
   * for EVERY rider regardless of on-screen visibility (design-spec §4.5:
   * riders off-screen still simulate so finishing position stays honest and
   * they don't teleport back into view) — rendering is a separate, purely
   * read-only step in `AIRiderRenderer`. `player` is read
   * (never mutated) for the bump behavior's proximity/lane checks (§4.5
   * behavior 3) — always passed even for off-screen riders, since they still
   * simulate (see class doc).
   */
  update(deltaMs: number, obstacles: Obstacle[], player: Player): void {
    // The bump-attempt cooldown ticks down regardless of wipeout/tumble/tween
    // state so a rider that was busy doesn't get an unfair backlog of
    // attempts once it's free again — `maybeBump` itself gates on eligibility.
    this.bumpCooldownMs -= deltaMs;

    if (this.wipedOut) {
      return; // tree wipeout: frozen, same as Player.wipedOut
    }

    const deltaSeconds = deltaMs / 1000;

    // Behavior 1 (Race): accelerate toward this rider's own cruise speed.
    // Speed only ever falls via a collision/combat outcome below, so
    // clamping up to the target here is sufficient to "recover" after one.
    const targetSpeed = MAX_SPEED * this.params.cruiseSpeedFactor;
    this.speed = Math.min(targetSpeed, this.speed + PLAYER_ACCEL * deltaSeconds);
    this.worldZ += this.speed * deltaSeconds;

    this.tumbleMsRemaining = Math.max(0, this.tumbleMsRemaining - deltaMs);
    this.immunityMsRemaining = Math.max(0, this.immunityMsRemaining - deltaMs);
    this.stumbleMsRemaining = Math.max(0, this.stumbleMsRemaining - deltaMs);

    this.updateLaneTween(deltaMs);

    // Behavior 2 (Dodge) takes priority over Behavior 3 (Bump) — only
    // consider a bump attempt when dodge didn't need to act this frame
    // (design-spec §4.5's priority list). Both need the rider settled and
    // not mid-tumble (control loss mirrors the player's rock knockdown).
    if (!this.tween && this.tumbleMsRemaining <= 0) {
      const dodged = this.maybeDodge(obstacles);
      if (!dodged) {
        this.maybeBump(player);
      }
    }
  }

  /** Discrete lane index into `LANES` — mirrors `Player.laneIndex`, read by
   *  `CombatSystem` for lateral-adjacency checks and by this rider's own
   *  bump behavior for lane-diff comparisons. */
  get laneIndex(): number {
    return this._laneIndex;
  }

  /** Current lane-offset fraction of road half-width — mirrors
   *  `Player.laneOffsetFraction` exactly so `projectEntity`/`CollisionSystem`
   *  treat this rider identically to the player. */
  get laneOffsetFraction(): number {
    if (!this.tween) {
      return LANES[this._laneIndex];
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
   * design-spec §4.5's "simple reactive dodge". Returns whether dodge
   * behavior was engaged this frame (an obstacle was in the current lane,
   * whether or not an escape lane was actually found) so `update()` can
   * deprioritize Behavior 3 (Bump, §4.5) below it — a rider in a jam
   * shouldn't also be trying to shove the player.
   */
  private maybeDodge(obstacles: Obstacle[]): boolean {
    const lookaheadZ = this.worldZ + this.params.reactionDistanceSegments * SEGMENT_LENGTH;
    const currentLane = this._laneIndex;
    const laneHasObstacleAhead = (lane: number): boolean =>
      obstacles.some((o) => o.lane === lane && o.z > this.worldZ && o.z <= lookaheadZ);

    if (!laneHasObstacleAhead(currentLane)) {
      return false;
    }

    const candidates = [currentLane - 1, currentLane + 1].filter((l) => l >= 0 && l < LANES.length);
    for (const lane of candidates) {
      if (!laneHasObstacleAhead(lane)) {
        this.tween = { fromLane: currentLane, toLane: lane, elapsedMs: 0 };
        break;
      }
    }
    return true;
  }

  /**
   * Bump behavior (design-spec §4.5 behavior 3): on an aggression-weighted
   * runtime-random timer (NOT the seeded PRNG — §4.2), a rider adjacent to
   * the player and within `SHOVE_Z_WINDOW` occasionally drifts into the
   * player's lane to attempt a shove. This only ever MOVES the rider — the
   * actual exchange resolves generically once the rider shares the player's
   * lane, via `CombatSystem`'s same-lane trigger (§4.6), the identical path
   * a dodging rider drifting into the player's lane would take. That also
   * means a player who becomes airborne mid-drift naturally gets the
   * "whiffs, no effect on either rider" outcome for free (§4.3/§4.6) —
   * `CombatSystem` simply never resolves an exchange against an airborne
   * target, so the rider just ends up parked alongside with no consequence.
   *
   * Gated on `SHOVE_Z_WINDOW`, not a wider "bump range": the ~150ms lane
   * tween only moves the rider LATERALLY, not along Z — at similar cruise
   * speeds the Z-gap barely changes during the drift, so initiating from any
   * farther out than the window `CombatSystem` actually resolves against
   * would just strand the rider parked in the player's lane with the
   * exchange perpetually failing to fire.
   */
  private maybeBump(player: Player): void {
    if (this.bumpCooldownMs > 0) {
      return;
    }
    this.bumpCooldownMs = AI_BUMP_CHECK_INTERVAL_MS; // one roll per interval regardless of outcome

    if (player.wipedOut) {
      return;
    }
    const laneDiff = player.laneIndex - this._laneIndex;
    if (Math.abs(laneDiff) !== 1) {
      return; // must be laterally adjacent, not already sharing a lane or 2+ away
    }
    if (Math.abs(player.worldZ - this.worldZ) > SHOVE_Z_WINDOW) {
      return;
    }
    if (Math.random() >= this.params.aggression) {
      return; // aggression-weighted chance; runtime randomness, deliberately unseeded
    }
    this.tween = { fromLane: this._laneIndex, toLane: this._laneIndex + laneDiff, elapsedMs: 0 };
  }

  /**
   * Combat knockback (§4.6) — identical contract to `Player.applyKnockback`:
   * `targetLaneIndex` is already clamped by the caller's tree/edge-safety
   * logic (passing this rider's own current lane means "no lane change,
   * speed loss only"). Overrides any in-progress dodge/bump tween.
   */
  applyKnockback(targetLaneIndex: number, speedLossFactor: number): void {
    if (this.wipedOut) {
      return;
    }
    this.speed *= 1 - speedLossFactor;
    if (targetLaneIndex === this._laneIndex) {
      this.tween = null; // clamped: no lane change, speed loss only
      return;
    }
    this.tween = { fromLane: this._laneIndex, toLane: targetLaneIndex, elapsedMs: 0 };
  }

  /** Records that this rider just lost a shove exchange to the player, for
   *  the knockout-attribution window (§4.6/§4.7: a tree within ~2s of the
   *  loss credits the player's knockout). */
  markShovedByPlayer(nowMs: number): void {
    this.shovedByPlayerAtMs = nowMs;
  }

  /** Whether this rider lost a shove to the player within `windowMs` ago. */
  wasRecentlyShovedByPlayer(nowMs: number, windowMs: number): boolean {
    return this.shovedByPlayerAtMs !== null && nowMs - this.shovedByPlayerAtMs <= windowMs;
  }

  private updateLaneTween(deltaMs: number): void {
    if (!this.tween) {
      return;
    }
    this.tween.elapsedMs += deltaMs;
    if (this.tween.elapsedMs < LANE_TWEEN_MS) {
      return;
    }
    this._laneIndex = this.tween.toLane;
    this.tween = null;
  }
}
