import {
  ARMED_SHOVE_SPEED_LOSS_FACTOR,
  COLLISION_LANE_FRACTION,
  KNOCKOUT_WINDOW_MS,
  LANES,
  SEGMENT_LENGTH,
  SHOVE_IMMUNITY_MS,
  SHOVE_SPEED_LOSS_FACTOR,
  SHOVE_Z_WINDOW,
  TREE_CLAMP_SEGMENTS
} from '../config';
import { AIRider } from './aiRider';
import { Obstacle } from './obstacle';
import { Player } from './player';

const LANE_COUNT = LANES.length;

/**
 * Combat event, drained each frame by `ScoreTracker` (combat hit 250,
 * knockout 500 ON TOP of the hit, §4.7). `'hit'` fires the instant an
 * exchange resolves in the player's favor; `'knockout'` fires separately
 * (later, possibly never) if that same rival then trees within
 * `KNOCKOUT_WINDOW_MS` of the loss.
 */
export type CombatEvent = { type: 'hit' | 'knockout'; rider: AIRider };

/**
 * Combat system (design-spec §4.6): resolves bump-to-shove exchanges between
 * the player and the 4 AI riders. There is no AI-vs-AI combat (§4.5 v1
 * simplification), so every exchange is always player-vs-one-rival — this
 * keeps the resolution logic a simple pairwise thing rather than a general
 * N-body system.
 *
 * Two trigger paths both funnel into the same `resolveExchange`:
 *  - Lateral (`attemptPlayerShove`): the player explicitly steers toward an
 *    adjacent lane a rival occupies. Wired via `Player.shoveInterceptor` so
 *    it fires instead of an actual lane change.
 *  - Same-lane (`update`'s per-frame scan): the player and a rival already
 *    share a lane within `SHOVE_Z_WINDOW` — covers rear-approach, a dodging
 *    rival drifting in, AND an AI rider's own bump-drift (`AIRider.maybeBump`
 *    just moves the rider into the lane; this is what actually resolves it).
 */
export class CombatSystem {
  readonly events: CombatEvent[] = [];

  // Per-rival-pair cooldown (§4.6 "shove immunity", scoped per attacker —
  // since every exchange is player-vs-that-specific-rival, a pairwise cooldown
  // keyed by rider covers both directions: the same rider can't re-trigger an
  // exchange with the player, but a DIFFERENT rider is unaffected).
  private readonly pairImmunityMs = new Map<AIRider, number>();
  private readonly wasWipedOut = new Map<AIRider, boolean>();
  // Cached from the most recent `update()` call. `attemptPlayerShove` fires
  // synchronously from a keyboard handler — outside the frame loop — so it
  // has no `nowMs` of its own; reusing this keeps it on the same clock as
  // `checkKnockoutTransitions`'s window comparisons instead of mixing in
  // `Date.now()`/`performance.now()`.
  private lastFrameNowMs = 0;

  constructor(
    private readonly player: Player,
    private readonly riders: AIRider[],
    private readonly obstacles: Obstacle[]
  ) {
    riders.forEach((rider) => this.wasWipedOut.set(rider, rider.wipedOut));
  }

  /**
   * Stamps this frame's `nowMs` for `attemptPlayerShove` to use. Called by
   * `RaceScene` as the very FIRST thing each frame — before `Player.update()`
   * runs — because a lane-shift press can synchronously call
   * `attemptPlayerShove` from inside `Player.update()`/`updateLaneTween`,
   * which happens before this class's own `update()` (that must instead run
   * LAST, after every rider's collision pass — see `update()`'s doc).
   * Without this separate stamp, the very first shove of a race would record
   * `nowMs = 0` (before `update()` ever ran), and every later shove would be
   * timestamped one frame stale.
   */
  beginFrame(nowMs: number): void {
    this.lastFrameNowMs = nowMs;
  }

  /**
   * Call once per frame, AFTER every rider's own `update()`/collision pass
   * has run (so this frame's `wipedOut` transitions are final) but BEFORE
   * anything reads `events` for scoring.
   */
  update(deltaMs: number, nowMs: number): void {
    this.lastFrameNowMs = nowMs;
    for (const [rider, ms] of this.pairImmunityMs) {
      const next = ms - deltaMs;
      if (next <= 0) {
        this.pairImmunityMs.delete(rider);
      } else {
        this.pairImmunityMs.set(rider, next);
      }
    }

    this.checkSameLaneContacts(nowMs);
    this.checkKnockoutTransitions(nowMs);
  }

  /**
   * Player pressed a lane-shift direction (§4.6 trigger 1: lateral shove).
   * Returns true only if an exchange actually resolved — the caller
   * (`Player.startLaneTween`) treats that as "resolved as combat, skip the
   * lane change." If a rival is there but the exchange no-ops (e.g. still
   * pair-immune from a shove moments ago), this returns false so the
   * lane-shift proceeds normally instead of silently eating the input.
   */
  attemptPlayerShove(direction: -1 | 1): boolean {
    if (this.player.wipedOut || this.player.airborne) {
      return false;
    }
    const targetLane = this.player.laneIndex + direction;
    const rival = this.findRiderInLane(targetLane, SHOVE_Z_WINDOW);
    if (!rival) {
      return false;
    }
    return this.resolveExchange(rival, this.lastFrameNowMs);
  }

  private findRiderInLane(lane: number, zWindow: number): AIRider | undefined {
    if (lane < 0 || lane >= LANE_COUNT) {
      return undefined;
    }
    return this.riders.find(
      (r) => !r.wipedOut && r.laneIndex === lane && Math.abs(r.worldZ - this.player.worldZ) <= zWindow
    );
  }

  /**
   * Trigger 2 (§4.6): player and a rival already occupy the same lane within
   * the shove Z-window, regardless of how either got there. Every exchange is
   * player-vs-one-rival (§4.5: no AI-vs-AI), so at most ONE exchange resolves
   * per frame even if two riders both qualify simultaneously (plausible since
   * rivals never avoid each other, §4.5) — stop at the first, matching the
   * class's own "always player-vs-one-rival" invariant instead of letting the
   * player take multiple stacked knockbacks for what reads as one contact.
   */
  private checkSameLaneContacts(nowMs: number): void {
    if (this.player.wipedOut || this.player.airborne) {
      return;
    }
    const playerFraction = this.player.laneOffsetFraction;
    for (const rider of this.riders) {
      if (rider.wipedOut) {
        continue;
      }
      if ((this.pairImmunityMs.get(rider) ?? 0) > 0) {
        continue;
      }
      if (Math.abs(rider.worldZ - this.player.worldZ) > SHOVE_Z_WINDOW) {
        continue;
      }
      if (Math.abs(rider.laneOffsetFraction - playerFraction) > COLLISION_LANE_FRACTION) {
        continue;
      }
      if (this.resolveExchange(rider, nowMs)) {
        return;
      }
    }
  }

  /**
   * Knockout attribution (§4.6/§4.7): scans for a rider that just transitioned
   * into `wipedOut` this frame (the only path there is a tree collision — see
   * `AIRider.crashIntoTree`) and, if it happened within `KNOCKOUT_WINDOW_MS`
   * of losing a shove to the player, records a knockout event.
   */
  private checkKnockoutTransitions(nowMs: number): void {
    for (const rider of this.riders) {
      const was = this.wasWipedOut.get(rider) ?? false;
      if (!was && rider.wipedOut && rider.wasRecentlyShovedByPlayer(nowMs, KNOCKOUT_WINDOW_MS)) {
        this.events.push({ type: 'knockout', rider });
      }
      this.wasWipedOut.set(rider, rider.wipedOut);
    }
  }

  /** Resolves a shove exchange, if eligible. Returns whether it actually
   *  resolved (false if either side is wiped out/airborne/collision-immune,
   *  or this specific pair is still within its shove-immunity window) — the
   *  caller uses this to distinguish a genuine exchange from a no-op. */
  private resolveExchange(rider: AIRider, nowMs: number): boolean {
    if (this.player.wipedOut || rider.wipedOut || this.player.airborne) {
      return false;
    }
    if (this.player.collisionImmune || rider.collisionImmune) {
      return false; // mid rock-tumble on either side: not a valid combat participant
    }
    if ((this.pairImmunityMs.get(rider) ?? 0) > 0) {
      return false;
    }

    const playerWins = this.player.armed || this.player.speed >= rider.speed;
    const maxShift = this.player.armed && playerWins ? 2 : 1;
    const speedLossFactor = this.player.armed && playerWins ? ARMED_SHOVE_SPEED_LOSS_FACTOR : SHOVE_SPEED_LOSS_FACTOR;

    const winnerLane = playerWins ? this.player.laneIndex : rider.laneIndex;
    const loserLane = playerWins ? rider.laneIndex : this.player.laneIndex;
    const loserZ = playerWins ? rider.worldZ : this.player.worldZ;

    // Same-lane contact has no inherent side to knock toward — pick one via
    // runtime randomness; a genuine lateral shove already has a clear
    // direction (the side the loser was standing on). Either way only ONE
    // direction is ever tried — the spec's road-edge clamp ("a loser already
    // in the edge lane takes the speed loss only — no lane change is
    // possible") has no carve-out for retrying the opposite side, so an
    // edge-lane loser must be able to end up merely speed-lossed even in the
    // ambiguous case, not bounced to the only lane that happened to be open.
    const laneDiff = loserLane - winnerLane;
    const direction: -1 | 1 = laneDiff === 0 ? (Math.random() < 0.5 ? 1 : -1) : laneDiff > 0 ? 1 : -1;

    const targetLane = this.resolveKnockbackLane(loserLane, direction, maxShift, loserZ);

    if (playerWins) {
      rider.applyKnockback(targetLane, speedLossFactor);
      if (this.player.armed) {
        this.player.consumeWeaponCharge();
      }
      this.events.push({ type: 'hit', rider });
      rider.markShovedByPlayer(nowMs);
    } else {
      this.player.applyKnockback(targetLane, speedLossFactor);
    }

    this.pairImmunityMs.set(rider, SHOVE_IMMUNITY_MS);
    return true;
  }

  /**
   * Knockback clamps (§4.6): tries the destination `maxShift` lanes away in
   * `direction` first (the "farthest tree-free lane" for an armed 2-lane
   * knockback), then closer, rejecting any lane out of road bounds or with a
   * tree within `TREE_CLAMP_SEGMENTS` downstream of `fromZ`. Falls back to
   * `fromLane` itself (no lane change, speed loss only) if every shift in
   * `direction` is blocked — the road-edge and tree clamps unified into one
   * rule, matching spec exactly (no opposite-direction retry).
   */
  private resolveKnockbackLane(fromLane: number, direction: -1 | 1, maxShift: number, fromZ: number): number {
    for (let shift = maxShift; shift >= 1; shift--) {
      const target = fromLane + direction * shift;
      if (target < 0 || target >= LANE_COUNT) {
        continue;
      }
      if (!this.hasTreeDownstream(target, fromZ)) {
        return target;
      }
    }
    return fromLane;
  }

  private hasTreeDownstream(lane: number, fromZ: number): boolean {
    return this.obstacles.some(
      (o) =>
        o.kind === 'tree' &&
        o.lane === lane &&
        o.z >= fromZ - SEGMENT_LENGTH * 0.5 &&
        o.z <= fromZ + TREE_CLAMP_SEGMENTS * SEGMENT_LENGTH
    );
  }
}
