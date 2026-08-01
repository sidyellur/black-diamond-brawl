import {
  ARMED_SHOVE_SPEED_LOSS_FACTOR,
  ATTACK_COOLDOWN_MS,
  ATTACK_LANE_REACH,
  COLLISION_LANE_FRACTION,
  KNOCKOUT_WINDOW_MS,
  LANES,
  SEGMENT_LENGTH,
  SHOVE_IMMUNITY_MS,
  SHOVE_SPEED_LOSS_FACTOR,
  SAME_LANE_EPSILON,
  SHOVE_Z_WINDOW,
  TARGET_GRACE_MS,
  TARGET_SWITCH_RATIO,
  TREE_CLAMP_SEGMENTS
} from '../config';
import { AIRider } from './aiRider';
import { Obstacle } from './obstacle';
import { Player } from './player';

const LANE_COUNT = LANES.length;

/**
 * Combat event, drained each frame by `ScoreTracker`.
 *
 * `'hit'` is a DELIBERATE attack the player pressed the attack key for.
 * `'brush'` is a passive same-lane contact the player won without asking —
 * riding into someone, or a rival drifting into them. They pay differently
 * (250 vs 50) because the whole point of a dedicated attack button is that
 * choosing to fight is the interesting action; before the split they scored
 * identically and the scoreboard could not tell intent from accident.
 *
 * `'knockout'` fires separately (later, possibly never) if the rival then
 * trees within `KNOCKOUT_WINDOW_MS` of the loss, and is paid on top of
 * whichever of the two caused it.
 */
export type CombatEvent = { type: 'hit' | 'brush' | 'knockout'; rider: AIRider };

/**
 * Combat system (design-spec §4.6): resolves bump-to-shove exchanges between
 * the player and the 4 AI riders. There is no AI-vs-AI combat (§4.5 v1
 * simplification), so every exchange is always player-vs-one-rival — this
 * keeps the resolution logic a simple pairwise thing rather than a general
 * N-body system.
 *
 * Two trigger paths funnel into the same `resolveExchange`, and the split
 * between them is the point of the system:
 *
 *  - **Deliberate attack** (`attemptAttack`): the player pressed the attack
 *    key at a target the marker was showing. Pays full value, applies armed
 *    bonuses, and commits the attacker to a steering-locked swing.
 *  - **Body check** (`update`'s same-lane scan): passive contact nobody asked
 *    for — rear-ending someone, or a rival drifting in via `maybeBump`. Same
 *    physics, a fifth of the reward, and never armed.
 *
 * The lateral steer-shove that used to exist as a third path is gone.
 * Steering now always steers. While it existed, `Player.shoveInterceptor`'s
 * boolean did two jobs at once — "did combat happen" and "should the lane
 * change be eaten" — which made *declining* a fight inexpressible: the only
 * way into a rival's lane without fighting was to fight first and move during
 * the immunity window.
 */
export class CombatSystem {
  readonly events: CombatEvent[] = [];

  // Per-rival-pair cooldown (§4.6 "shove immunity", scoped per attacker —
  // since every exchange is player-vs-that-specific-rival, a pairwise cooldown
  // keyed by rider covers both directions: the same rider can't re-trigger an
  // exchange with the player, but a DIFFERENT rider is unaffected).
  private readonly pairImmunityMs = new Map<AIRider, number>();
  private readonly wasWipedOut = new Map<AIRider, boolean>();
  /** Global attack cooldown, independent of target. Longer than pair
   *  immunity, so re-attacking the SAME rival is gated by this. */
  private attackCooldownMs = 0;

  /** Current attack target, and how long it has been out of range. Held on
   *  the system (recreated per race) so restart-reset is free. */
  private currentTarget: AIRider | null = null;
  private targetOutOfRangeMs = 0;

  /**
   * Which rivals the player was already touching last frame.
   *
   * Body checks fire on the ENTERING edge only. Firing them continuously
   * while co-located starves the deliberate attack outright: each brush sets
   * pair immunity, and since that window (500ms) is shorter than the attack
   * cooldown (600ms), the passive scan would re-trigger first every single
   * time and a same-lane rival could never actually be attacked on purpose.
   *
   * Edge-triggering is also just truer to what a body check is — riding into
   * someone is one event, not a rate.
   */
  private readonly inContact = new Set<AIRider>();

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
    this.attackCooldownMs = Math.max(0, this.attackCooldownMs - deltaMs);
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
    this.updateTarget(deltaMs);
  }

  /** True while the attack key would be refused — drives the HUD cooldown pip. */
  get attackOnCooldown(): boolean {
    return this.attackCooldownMs > 0;
  }

  /** 0..1 remaining cooldown, for the HUD. */
  get attackCooldownFraction(): number {
    return Math.max(0, Math.min(1, this.attackCooldownMs / ATTACK_COOLDOWN_MS));
  }

  /**
   * The rival an attack would currently strike, or null.
   *
   * Whatever this returns is exactly what `attemptAttack` will resolve
   * against — the marker drawn from it therefore cannot promise a hit the
   * exchange would refuse. That equivalence is the whole reason targeting is
   * a query rather than a range check at press time: a marker that pointed at
   * a rider mid-rock-tumble, or one still inside pair immunity, would have
   * the player press attack, see nothing happen, and eat the swing lock for a
   * hit the game had advertised.
   */
  get target(): AIRider | null {
    return this.currentTarget && this.isAttackable(this.currentTarget) ? this.currentTarget : null;
  }

  /** Score for target selection: 0 at touching, 1 at the edge of reach.
   *  Lateral and longitudinal distance are normalised to their own ranges
   *  first, so the two units are comparable. */
  private targetScore(rider: AIRider): number | null {
    const dFrac = Math.abs(rider.laneOffsetFraction - this.player.laneOffsetFraction);
    const dz = Math.abs(rider.worldZ - this.player.worldZ);
    if (dFrac > ATTACK_LANE_REACH || dz > SHOVE_Z_WINDOW) {
      return null;
    }
    return dFrac / ATTACK_LANE_REACH + dz / SHOVE_Z_WINDOW;
  }

  /**
   * Whether an attack against this rider would resolve *if it were in reach*.
   * Mirrors every guard in `resolveExchange`, plus the global cooldown.
   *
   * Deliberately separate from range. Range is sticky — a target is held
   * through brief drop-outs so the marker does not flicker during a pass-by —
   * but eligibility is not: being on cooldown or inside pair immunity means
   * the press genuinely will not land, and holding the marker through that
   * would break the one promise it makes.
   */
  private isEligible(rider: AIRider): boolean {
    if (this.player.wipedOut || this.player.airborne || this.player.collisionImmune) return false;
    if (rider.wipedOut || rider.finishTimeMs !== null || rider.collisionImmune) return false;
    if ((this.pairImmunityMs.get(rider) ?? 0) > 0) return false;
    if (this.attackCooldownMs > 0) return false;
    return true;
  }

  /** Both halves: in reach AND allowed. */
  private isAttackable(rider: AIRider): boolean {
    return this.isEligible(rider) && this.targetScore(rider) !== null;
  }

  /**
   * Re-picks the attack target, with hysteresis.
   *
   * A challenger must be meaningfully closer than the incumbent to steal the
   * target, and a target that leaves reach is kept for a short grace period.
   * Without both, the marker flickers between two rivals at similar range
   * during a pass-by, which is worse than showing no marker at all.
   */
  private updateTarget(deltaMs: number): void {
    // Selection tracks REACH only. Eligibility is applied by the `target`
    // getter, so a rival that is merely on cooldown stays the tracked choice
    // (no thrash when it becomes available again) while the marker correctly
    // hides.
    let best: AIRider | null = null;
    let bestScore = Infinity;
    for (const rider of this.riders) {
      if (rider.wipedOut || rider.finishTimeMs !== null) continue;
      const score = this.targetScore(rider);
      if (score !== null && score < bestScore) {
        bestScore = score;
        best = rider;
      }
    }

    const incumbentScore = this.currentTarget ? this.targetScore(this.currentTarget) : null;

    if (incumbentScore === null) {
      // Incumbent no longer valid: hold it briefly before dropping, so a
      // momentary range blip does not blink the marker off.
      this.targetOutOfRangeMs += deltaMs;
      if (this.targetOutOfRangeMs >= TARGET_GRACE_MS || this.currentTarget === null) {
        this.currentTarget = best;
        this.targetOutOfRangeMs = 0;
      }
      return;
    }

    this.targetOutOfRangeMs = 0;
    if (best && best !== this.currentTarget && bestScore < incumbentScore * TARGET_SWITCH_RATIO) {
      this.currentTarget = best;
    }
  }

  /**
   * The player pressed attack.
   *
   * Returns true if a swing started. A press with no eligible target — out of
   * reach, on cooldown, airborne, tumbling — is **refused outright**: no
   * swing, no cooldown, no cost. The cost of attacking is meant to be the
   * steering commitment when you genuinely engage, not a tax for a press the
   * game declined to honour.
   */
  attemptAttack(nowMs: number): boolean {
    const rider = this.currentTarget;
    if (!rider || !this.isAttackable(rider)) {
      return false;
    }
    this.attackCooldownMs = ATTACK_COOLDOWN_MS;
    this.player.startSwing();
    this.resolveExchange(rider, nowMs, true);
    return true;
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
      const touching =
        !rider.wipedOut &&
        rider.finishTimeMs === null &&
        Math.abs(rider.worldZ - this.player.worldZ) <= SHOVE_Z_WINDOW &&
        Math.abs(rider.laneOffsetFraction - playerFraction) <= COLLISION_LANE_FRACTION;

      if (!touching) {
        this.inContact.delete(rider);
        continue;
      }
      // Already touching last frame: this is the same contact continuing, not
      // a new one. Staying in someone's lane must not machine-gun them.
      if (this.inContact.has(rider)) {
        continue;
      }
      this.inContact.add(rider);

      if ((this.pairImmunityMs.get(rider) ?? 0) > 0) {
        continue;
      }
      if (this.resolveExchange(rider, nowMs, false)) {
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

  /**
   * Resolves an exchange, if eligible. Returns whether it actually resolved
   * (false if either side is wiped out/airborne/collision-immune, the rider
   * has already finished, or this pair is still within its shove-immunity
   * window).
   *
   * `deliberate` distinguishes a pressed attack from a passive body check,
   * and controls three things: the reward, whether the ski pole applies at
   * all, and therefore whether a charge is spent. Passive contact never
   * spends a charge — before the split, an armed player who was merely
   * rear-ended into a rival burned a pole charge for it.
   */
  private resolveExchange(rider: AIRider, nowMs: number, deliberate: boolean): boolean {
    if (this.player.wipedOut || rider.wipedOut || this.player.airborne || rider.finishTimeMs !== null) {
      return false;
    }
    if (this.player.collisionImmune || rider.collisionImmune) {
      return false; // mid rock-tumble on either side: not a valid combat participant
    }
    if ((this.pairImmunityMs.get(rider) ?? 0) > 0) {
      return false;
    }

    // The ski pole is a weapon you SWING. It applies to deliberate attacks
    // only, so a passive brush neither auto-wins nor spends a charge.
    const armed = deliberate && this.player.armed;
    const playerWins = armed || this.player.speed >= rider.speed;
    const maxShift = armed && playerWins ? 2 : 1;
    const speedLossFactor = armed && playerWins ? ARMED_SHOVE_SPEED_LOSS_FACTOR : SHOVE_SPEED_LOSS_FACTOR;

    const loserLane = playerWins ? rider.laneIndex : this.player.laneIndex;
    const loserZ = playerWins ? rider.worldZ : this.player.worldZ;

    const direction = this.knockbackDirection(playerWins, loserLane);

    const targetLane = this.resolveKnockbackLane(loserLane, direction, maxShift, loserZ);

    if (playerWins) {
      rider.applyKnockback(targetLane, speedLossFactor);
      rider.notifyHit();
      if (armed) {
        this.player.consumeWeaponCharge();
      }
      this.events.push({ type: deliberate ? 'hit' : 'brush', rider });
      rider.markShovedByPlayer(nowMs);
    } else {
      this.player.applyKnockback(targetLane, speedLossFactor);
      // The player losing an exchange used to produce no signal at all — no
      // event, no state, nothing for the scene to react to. Now it recoils
      // and flashes exactly like a rival does.
      this.player.notifyHit();
    }

    this.pairImmunityMs.set(rider, SHOVE_IMMUNITY_MS);
    return true;
  }

  /**
   * Which way the loser gets knocked.
   *
   * A lateral exchange has a natural answer — away from the winner. A
   * same-lane one does not, and that is the common case for a deliberate
   * attack: you press the key having settled in the rival's lane, at which
   * point both riders return *identically* the same lane offset. (An earlier
   * design assumed mid-tween drift would break the tie; it does not, because
   * nobody is mid-tween when they deliberately press attack.)
   *
   * So the tie resolves **toward road centre**. It is deterministic — this
   * used to be a coin flip, which would have made the new attack button's
   * most common outcome random — and it is the kinder of the two options for
   * the loser, since the edge lanes are where the road-edge clamp turns a
   * knockback into a no-op.
   */
  private knockbackDirection(playerWins: boolean, loserLane: number): -1 | 1 {
    const winnerFraction = playerWins ? this.player.laneOffsetFraction : 0;
    const loserFraction = playerWins ? 0 : this.player.laneOffsetFraction;
    const lateral = playerWins
      ? LANES[loserLane] - winnerFraction
      : loserFraction - LANES[loserLane];
    if (Math.abs(lateral) > SAME_LANE_EPSILON) {
      return lateral > 0 ? 1 : -1;
    }
    const centre = (LANE_COUNT - 1) / 2;
    if (loserLane === centre) {
      return 1;
    }
    return loserLane > centre ? -1 : 1;
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
      // Every lane the knockback CROSSES has to be clear, not just where it
      // lands. A 2-lane knockback tweens continuously through the lane in
      // between, and sits inside that lane's collision band (`COLLISION_LANE_
      // FRACTION`) for roughly 45ms — comfortably longer than the
      // `COLLISION_Z_WINDOW` needs to register a hit. Checking only the
      // destination meant an armed knockback could drag the loser straight
      // through a tree it had carefully avoided landing on.
      let pathClear = true;
      for (let step = 1; step <= shift; step++) {
        if (this.hasTreeDownstream(fromLane + direction * step, fromZ)) {
          pathClear = false;
          break;
        }
      }
      if (pathClear) {
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
