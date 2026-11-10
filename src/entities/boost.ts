import {
  BOOST_FULL_DURATION_MS,
  BOOST_GAIN,
  BOOST_MAX,
  BOOST_MIN_TO_START,
  BOOST_PENALTY_KEEP
} from '../config';

/** Score-feedback kinds that can feed the meter (`ScoreTracker.feedback`). */
export type BoostFeedbackKind = 'hit' | 'brush' | 'knockout' | 'near' | 'trick';

/** The slice of player state the meter reads. Keeps this module Phaser-free. */
export interface BoostPlayerState {
  wipedOut: boolean;
  heavyCrashing: boolean;
  tumbling: boolean;
  stumbling: boolean;
  hitReacting: boolean;
  airborne: boolean;
}

/**
 * Boost meter (0..BOOST_MAX). Owns only the number and the active flag; the
 * speed effect lives in `Player.update`. Deterministic: advanced only by the
 * fixed simulation step and by discrete events.
 *
 * Boost is not allowed while airborne: jump airtime is constant, so a boosted
 * jump would travel past the landing zones placement guarantees (see
 * scripts/verifyBoost.ts). Penalties and air cuts require releasing the button
 * before the next boost can begin.
 */
export class BoostMeter {
  private _value = 0;
  private _active = false;
  /** After a forced cut the button must be released before boost can restart. */
  private needsRelease = false;
  private prevHeavyCrashing = false;
  private prevTumbling = false;
  private prevStumbling = false;
  private prevHitReacting = false;

  get value(): number { return this._value; }
  get active(): boolean { return this._active; }
  /** Enough meter to start a boost (drives the HUD cue). */
  get ready(): boolean { return this._value >= BOOST_MIN_TO_START; }

  add(amount: number): void {
    if (amount > 0) this._value = Math.min(BOOST_MAX, this._value + amount);
  }

  /** Total gain for one frame of score feedback. A counter hit replaces the
   *  ordinary hit gain it also produces rather than stacking on it. */
  static gainFor(kinds: readonly BoostFeedbackKind[], counter: boolean): number {
    let gain = 0;
    for (const kind of kinds) {
      if (kind === 'near') gain += BOOST_GAIN.NEAR_MISS;
      else if (kind === 'trick') gain += BOOST_GAIN.TRICK_LANDING;
      else if (kind === 'knockout') gain += BOOST_GAIN.KNOCKOUT;
      else if (kind === 'hit') gain += counter ? 0 : BOOST_GAIN.HIT;
    }
    if (counter) gain += BOOST_GAIN.COUNTER;
    return gain;
  }

  addFeedback(kinds: readonly BoostFeedbackKind[], counter = false): void {
    this.add(BoostMeter.gainFor(kinds, counter));
  }

  /** Rock hit or a lost combat exchange: end the boost, keep half the meter. */
  penalize(): void {
    this._value *= BOOST_PENALTY_KEEP;
    this.cut();
  }

  /** Heavy tree crash: the meter is emptied and the boost ends. */
  empty(): void {
    this._value = 0;
    this.cut();
  }

  /** Mogul stumble: ends the boost only. */
  interrupt(): void {
    this.cut();
  }

  /** Back to an empty, idle meter (new race). */
  reset(): void {
    this._value = 0;
    this._active = false;
    this.needsRelease = false;
    this.prevHeavyCrashing = this.prevTumbling = this.prevStumbling = this.prevHitReacting = false;
  }

  /** Edge-detect collision and combat losses from the player's state. */
  observe(player: BoostPlayerState): void {
    // A heavy crash also reads as a tumble; the stronger penalty wins.
    if (player.heavyCrashing && !this.prevHeavyCrashing) this.empty();
    else if ((player.tumbling && !this.prevTumbling) || (player.hitReacting && !this.prevHitReacting)) this.penalize();
    else if (player.stumbling && !this.prevStumbling) this.interrupt();
    this.prevHeavyCrashing = player.heavyCrashing;
    this.prevTumbling = player.tumbling;
    this.prevStumbling = player.stumbling;
    this.prevHitReacting = player.hitReacting;
  }

  /** Advance one fixed step. `canBoost` is false while wiped out, tumbling or airborne. */
  update(deltaMs: number, held: boolean, canBoost = true): void {
    if (!held) this.needsRelease = false;
    if (!canBoost) {
      if (this._active) this.cut(false);
      return;
    }
    if (!held) {
      this._active = false;
      return;
    }
    if (!this._active) {
      if (this.needsRelease || this._value < BOOST_MIN_TO_START) return;
      this._active = true;
    }
    this._value = Math.max(0, this._value - (BOOST_MAX * deltaMs) / BOOST_FULL_DURATION_MS);
    if (this._value <= 0) this._active = false;
  }

  private cut(latch = true): void {
    this._active = false;
    if (latch) this.needsRelease = true;
  }
}
