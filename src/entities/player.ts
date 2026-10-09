import {
  CAMERA_HEIGHT,
  JUMP_AIRTIME_EXTENDED_MS,
  JUMP_AIRTIME_MS,
  LANE_TWEEN_MS,
  LANES,
  MAX_SPEED,
  MOGUL_SPEED_FACTOR,
  ATTACK_SWING_MS,
  HIT_REACTION_MS,
  MOGUL_STUMBLE_MS,
  PLAYER_ACCEL,
  PLAYER_START_Z,
  ROAD_WIDTH,
  ROCK_IMMUNITY_MS,
  ROCK_SPEED_FACTOR,
  ROCK_TUMBLE_MS,
  WEAPON_CHARGES
} from '../config';
import { Collidable } from './collision';
import { roadElevationAt, Segment } from '../track/segment';

const CENTER_LANE_INDEX = Math.floor(LANES.length / 2);
/** Late landing/recovery forgiveness; never queues an entire jump/tumble. */
export const LANE_INPUT_BUFFER_MS = 160;

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
 *
 * Implements `Collidable` (Task 7's AI riders implement the same interface)
 * so `CollisionSystem` — and any future rider type — can apply the identical
 * tree/rock/mogul rules without a parallel copy.
 */
export class Player implements Collidable {
  /** Starts at `PLAYER_START_Z`, not 0, so the camera (which trails by
   *  `CAMERA_BACK_Z`) begins at exactly world-Z 0 instead of behind the front
   *  of the track array. */
  worldZ = PLAYER_START_Z;
  speed = 0;

  private _laneIndex = CENTER_LANE_INDEX;
  private tween: LaneTween | null = null;
  private bufferedDirection: -1 | 1 | null = null;
  private bufferedDirectionMs = 0;

  /**
   * Attack swing countdown. While this runs the player cannot steer or jump —
   * the entire cost of attacking (see `ATTACK_SWING_MS`). Set by
   * `CombatSystem` when a swing starts, never by input directly.
   */
  swingMsRemaining = 0;

  /**
   * Recoil countdown after LOSING a combat exchange. Drives the hit frame and
   * the impact flash.
   *
   * Set through `notifyHit()` rather than inferred from `applyKnockback`,
   * because a knockback is not by itself evidence of being struck — the
   * combat harness uses `applyKnockback` to walk a player across lanes during
   * setup, and any future forced lane change would look identical.
   */
  hitReactionMsRemaining = 0;

  /** Accepted movement, not raw key presses. Used by timed evade detection. */
  maneuverSerial = 0;
  maneuverAgeMs = Infinity;
  maneuverKind: 'steer' | 'jump' | null = null;
  maneuverFromFraction = LANES[CENTER_LANE_INDEX];

  airborne = false;
  private jumpElapsedMs = 0;
  /** Airtime of the CURRENT/most-recent jump (§4.3): normal or extended. */
  private jumpAirtimeMs = JUMP_AIRTIME_MS;
  /** Whether the current/most-recent jump was an extended (trick) launch off a
   *  mogul or crest — read by `ScoreTracker` to score only trick landings. */
  extendedJump = false;

  /** Run-ending wipeout latch (tree collision, §4.4). Freezes the player;
   *  `RaceScene` detects this transition to end the run and show `ResultScene`. */
  wipedOut = false;

  /** Ski-pole charges (design-spec §4.6): 0 = baseline bump, >0 = armed.
   *  Cleared only by a run-ending wipeout or overwritten by a fresh pickup. */
  weaponCharges = 0;

  // Temporary-collision timers (design-spec §4.4). While `tumbleMsRemaining`
  // > 0 the player can't steer (rock knockdown); `immunityMsRemaining` grants
  // post-recovery collision immunity; `stumbleMsRemaining` is a cosmetic mogul
  // wobble with no control loss.
  private tumbleMsRemaining = 0;
  private immunityMsRemaining = 0;
  private stumbleMsRemaining = 0;

  update(deltaMs: number): void {
    if (this.wipedOut) {
      return; // run-ending wipeout: frozen until the result screen restarts the race
    }

    this.maneuverAgeMs += deltaMs;
    const deltaSeconds = deltaMs / 1000;

    // Auto-acceleration toward MAX_SPEED (§4.1) — no brake/tuck control in v1.
    // Speed recovers automatically after a collision knocked it down.
    this.speed = Math.min(MAX_SPEED, this.speed + PLAYER_ACCEL * deltaSeconds);
    this.worldZ += this.speed * deltaSeconds;

    this.tumbleMsRemaining = Math.max(0, this.tumbleMsRemaining - deltaMs);
    this.hitReactionMsRemaining = Math.max(0, this.hitReactionMsRemaining - deltaMs);
    this.swingMsRemaining = Math.max(0, this.swingMsRemaining - deltaMs);
    if (this.bufferedDirection !== null) {
      this.bufferedDirectionMs -= deltaMs;
      if (this.bufferedDirectionMs < 0) this.clearInputBuffer();
    }
    this.immunityMsRemaining = Math.max(0, this.immunityMsRemaining - deltaMs);
    this.stumbleMsRemaining = Math.max(0, this.stumbleMsRemaining - deltaMs);

    this.updateLaneTween(deltaMs);
    this.updateJump(deltaMs);
    // Begin fresh movement only after existing movement/locks have advanced.
    // In particular, never credit an entire locked frame to a new lane tween.
    if (this.bufferedDirection !== null && this.canSteer && !this.tween) {
      const direction = this.bufferedDirection;
      this.clearInputBuffer();
      this.startLaneTween(direction);
    }
  }

  /** Left/Right (or A/D): shift one lane, clamped to the road edges (§4.3). */
  requestLaneShift(direction: -1 | 1): void {
    if (this.wipedOut) return;
    if (!this.canSteer || this.tween) {
      // One-deep, last-intent buffer: never stack up invisible lane changes.
      // Preserve the full short attack commitment; air/tumble presses expire
      // unless recovery is imminent. A held steer can refresh this naturally.
      this.bufferedDirection = direction;
      this.bufferedDirectionMs = Math.max(LANE_INPUT_BUFFER_MS, this.swingMsRemaining + 50);
      return;
    }
    this.clearInputBuffer();
    this.startLaneTween(direction);
  }

  /** Clear unexecuted intent on pause, blur, collision, or race teardown. */
  clearInputBuffer(): void {
    this.bufferedDirection = null;
    this.bufferedDirectionMs = 0;
  }

  private get canSteer(): boolean {
    return !this.wipedOut && !this.airborne && !this.tumbling && !this.swinging;
  }

  /** Input uses this to queue a very early jump without bypassing a lock. */
  get canJump(): boolean {
    return this.canSteer;
  }

  /** Space/Up/W: a normal fixed-impulse jump (§4.3). No double-jump. Kept for
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
  jump(extended: boolean, voluntary = true): void {
    if (this.airborne || this.wipedOut || this.tumbling) {
      return;
    }
    if (this.swingMsRemaining > 0) {
      // Jump is locked during a swing too. Without this, F-then-Space escapes
      // the positional commitment through the air (airborne clears rocks and
      // moguls outright), and "attacking commits you" would mean "attacking
      // commits you unless you press the other button".
      return;
    }
    if (voluntary) this.recordManeuver('jump');
    this.airborne = true;
    this.jumpElapsedMs = 0;
    this.extendedJump = extended;
    this.jumpAirtimeMs = extended ? JUMP_AIRTIME_EXTENDED_MS : JUMP_AIRTIME_MS;
  }

  /** Starts an attack swing: steering and jump are locked for its duration. */
  startSwing(): void {
    this.swingMsRemaining = ATTACK_SWING_MS;
  }

  /** True while mid-attack — drives the swing pose. */
  get swinging(): boolean {
    return this.swingMsRemaining > 0;
  }

  /** Called by `CombatSystem` on the LOSER of an exchange. Distinct from
   *  `applyKnockback`, which is also used to move riders for other reasons. */
  notifyHit(): void {
    this.hitReactionMsRemaining = HIT_REACTION_MS;
  }

  /** True while recoiling from a combat hit — drives the hit pose and flash. */
  get hitReacting(): boolean {
    return this.hitReactionMsRemaining > 0;
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

  /** Tree collision (§4.4): run-ending wipeout — freeze the player;
   *  `RaceScene` picks up the `wipedOut` transition to end the run. */
  crashIntoTree(): void {
    if (this.wipedOut) {
      return;
    }
    this.wipedOut = true;
    this.speed = 0;
    this.airborne = false;
    // A run-ending wipeout clears the pole regardless of remaining charges
    // (§4.6) — the run is over either way, but this keeps state consistent
    // for the restart flow (a fresh Player starts unarmed too).
    this.weaponCharges = 0;
    this.clearInputBuffer();
  }

  /** Rock collision (§4.4): temporary wipeout — speed drops to ~30%, ~1s
   *  no-steer tumble, then ~1s collision immunity. */
  hitRock(): void {
    this.speed *= ROCK_SPEED_FACTOR;
    this.tumbleMsRemaining = ROCK_TUMBLE_MS;
    this.immunityMsRemaining = ROCK_TUMBLE_MS + ROCK_IMMUNITY_MS; // immunity runs through the tumble and 1s past it
    this.airborne = false;
    this.tween = null; // cancel any in-flight steer; control is lost during tumble
    this.clearInputBuffer();
  }

  /** Mogul collision when ridden over without jumping (§4.4): a stumble —
   *  ~25% speed loss and a brief wobble, but no control loss. */
  hitMogul(): void {
    this.speed *= MOGUL_SPEED_FACTOR;
    this.stumbleMsRemaining = MOGUL_STUMBLE_MS;
  }

  /** Discrete lane index into `LANES` — read by `CombatSystem` to test
   *  lateral adjacency (§4.6's "neighboring lane" is a discrete concept,
   *  unlike the continuous `laneOffsetFraction` used for same-lane checks). */
  get laneIndex(): number {
    return this._laneIndex;
  }

  /** Whether the ski pole is currently armed (§4.6): auto-wins the next
   *  exchange and consumes a charge. */
  get armed(): boolean {
    return this.weaponCharges > 0;
  }

  /** Driving over a pickup arms/refreshes the pole to full charges (§4.6). */
  armWeapon(): void {
    this.weaponCharges = WEAPON_CHARGES;
  }

  /** Every exchange the armed player wins consumes one charge (§4.6),
   *  whether player- or AI-initiated. Reverts to baseline at 0. */
  consumeWeaponCharge(): void {
    this.weaponCharges = Math.max(0, this.weaponCharges - 1);
  }

  /**
   * Combat knockback (§4.6): forces a lane change to `targetLaneIndex`
   * (already clamped by the caller's tree/edge-safety logic — passing the
   * player's own current lane index means "no lane change, speed loss
   * only") and applies the loser's speed loss. Overrides any in-progress
   * voluntary tween — a knockback always takes priority. No-ops once
   * wiped out (a frozen player can't be knocked further) or airborne (never
   * reachable in practice: an airborne player is never a valid combat
   * target, but guarded defensively).
   */
  applyKnockback(targetLaneIndex: number, speedLossFactor: number, allowAirborne = false): void {
    if (this.wipedOut || (this.airborne && !allowAirborne)) {
      return;
    }
    this.speed *= 1 - speedLossFactor;
    this.clearInputBuffer();
    if (targetLaneIndex === this._laneIndex) {
      this.tween = null; // clamped: no lane change, speed loss only
      return;
    }
    this.tween = { fromLane: this._laneIndex, toLane: targetLaneIndex, elapsedMs: 0 };
  }

  /** Current lane-offset fraction of road half-width (one of LANES, or
   *  tweening between two of them). Feeds both camX and the sprite lean. */
  get laneOffsetFraction(): number {
    if (!this.tween) {
      return LANES[this._laneIndex];
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
    const target = clamp(this._laneIndex + direction, 0, LANES.length - 1);
    if (target === this._laneIndex) {
      return; // already at the road edge; nothing to do
    }
    this.recordManeuver('steer');
    this.tween = { fromLane: this._laneIndex, toLane: target, elapsedMs: 0 };
  }

  private recordManeuver(kind: 'steer' | 'jump'): void {
    this.maneuverSerial++;
    this.maneuverAgeMs = 0;
    this.maneuverKind = kind;
    this.maneuverFromFraction = this.laneOffsetFraction;
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
