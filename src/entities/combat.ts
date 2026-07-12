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
 * Combat event, drained by whatever owns scoring (Task 9 — combat hit 250,
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
   * Returns true if a rival occupies the target lane within the shove
   * window — the caller (`Player.startLaneTween`) must treat this as
   * "resolved as combat" and skip the actual lane change, even if the
   * exchange itself no-ops internally (e.g. the rival is still immune).
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
    this.resolveExchange(rival, this.lastFrameNowMs);
    return true;
  }

  private findRiderInLane(lane: number, zWindow: number): AIRider | undefined {
    if (lane < 0 || lane >= LANE_COUNT) {
      return undefined;
    }
    return this.riders.find(
      (r) => !r.wipedOut && r.laneIndex === lane && Math.abs(r.worldZ - this.player.worldZ) <= zWindow
    );
  }

  /** Trigger 2 (§4.6): player and a rival already occupy the same lane
   *  within the shove Z-window, regardless of how either got there. */
  private checkSameLaneContacts(nowMs: number): void {
    if (this.player.wipedOut || this.player.airborne) {
      return;
    }
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
      if (Math.abs(rider.laneOffsetFraction - this.player.laneOffsetFraction) > COLLISION_LANE_FRACTION) {
        continue;
      }
      this.resolveExchange(rider, nowMs);
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

  private resolveExchange(rider: AIRider, nowMs: number): void {
    if (this.player.wipedOut || rider.wipedOut || this.player.airborne) {
      return;
    }
    if (this.player.collisionImmune || rider.collisionImmune) {
      return; // mid rock-tumble on either side: not a valid combat participant
    }
    if ((this.pairImmunityMs.get(rider) ?? 0) > 0) {
      return;
    }

    const playerWins = this.player.armed || this.player.speed >= rider.speed;
    const maxShift = this.player.armed && playerWins ? 2 : 1;
    const speedLossFactor = this.player.armed && playerWins ? ARMED_SHOVE_SPEED_LOSS_FACTOR : SHOVE_SPEED_LOSS_FACTOR;

    const winnerLane = playerWins ? this.player.laneIndex : rider.laneIndex;
    const loserLane = playerWins ? rider.laneIndex : this.player.laneIndex;
    const loserZ = playerWins ? rider.worldZ : this.player.worldZ;

    const laneDiff = loserLane - winnerLane;
    // Same-lane contact has no inherent side to knock toward — pick one via
    // runtime randomness and allow falling back to the other side if it's
    // blocked; a genuine lateral shove already has a clear direction (the
    // side the loser was standing on) and only that direction is tried, per
    // spec's knockback-clamp wording.
    const ambiguous = laneDiff === 0;
    const direction: -1 | 1 = ambiguous ? (Math.random() < 0.5 ? 1 : -1) : laneDiff > 0 ? 1 : -1;

    const targetLane = this.resolveKnockbackLane(loserLane, direction, maxShift, loserZ, ambiguous);

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
  }

  /**
   * Knockback clamps (§4.6): tries the destination `maxShift` lanes away in
   * `direction` first (the "farthest tree-free lane" for an armed 2-lane
   * knockback), then closer, rejecting any lane out of road bounds or with a
   * tree within `TREE_CLAMP_SEGMENTS` downstream of `fromZ`. If `direction`
   * is fully blocked and `tryOppositeDirection` is set (only true for the
   * ambiguous same-lane case — a genuine lateral shove only ever tries its
   * one true direction), tries the opposite side the same way. Falls back to
   * `fromLane` itself (no lane change, speed loss only) — the road-edge and
   * tree clamps unified into one rule.
   */
  private resolveKnockbackLane(
    fromLane: number,
    direction: -1 | 1,
    maxShift: number,
    fromZ: number,
    tryOppositeDirection: boolean
  ): number {
    const tryDirection = (dir: -1 | 1): number | null => {
      for (let shift = maxShift; shift >= 1; shift--) {
        const target = fromLane + dir * shift;
        if (target < 0 || target >= LANE_COUNT) {
          continue;
        }
        if (!this.hasTreeDownstream(target, fromZ)) {
          return target;
        }
      }
      return null;
    };

    return tryDirection(direction) ?? (tryOppositeDirection ? tryDirection(direction === 1 ? -1 : 1) : null) ?? fromLane;
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
