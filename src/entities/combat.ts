import {
  ARMED_SHOVE_SPEED_LOSS_FACTOR,
  ATTACK_COOLDOWN_MS,
  ATTACK_LANE_REACH,
  COLLISION_LANE_FRACTION,
  KNOCKOUT_WINDOW_MS,
  LANES,
  PUSH_COOLDOWN_MS,
  PUSH_HAZARD_LOOKAHEAD_MS,
  PUSH_SPEED_LOSS,
  PUSH_SWING_MS,
  SEGMENT_LENGTH,
  SHOVE_IMMUNITY_MS,
  SHOVE_SPEED_LOSS_FACTOR,
  SNOWBALL_RANGE_SEGMENTS,
  SAME_LANE_EPSILON,
  SHOVE_Z_WINDOW,
  STAGGER_PIPS,
  TARGET_GRACE_MS,
  TARGET_SWITCH_RATIO,
  TREE_CLAMP_SEGMENTS
} from '../config';
import { AIRider } from './aiRider';
import { Obstacle } from './obstacle';
import { Player } from './player';
import { COUNTER_LANE_REACH, COUNTER_WINDOW_MS, COUNTER_Z_REACH_FACTOR, EVADE_TIMING_MS } from './skillCombat';

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
/** A snowball thrown this frame, for presentation (the hit already resolved). */
export interface ThrowEvent { rider: AIRider; fromLane: number }
export type CombatEvent = { type: 'hit' | 'brush' | 'knockout' | 'push'; rider: AIRider };
/** Where a directional shove would send a rival, and whether a tree or rock is
 *  waiting there. The HUD cue and `attemptPush` both read this one value, so
 *  the "!" can never disagree with what the push then does. */
export interface PushPlan {
  /** -1 left, 1 right: the direction the rival actually travels (after the road-edge flip). */
  direction: -1 | 1;
  /** Lane the rival ends in. */
  lane: number;
  /** Lanes moved (1, or 2 for an armed push that was not stopped by a tree). */
  shift: number;
  /** A tree or rock in the destination lane within `PUSH_HAZARD_LOOKAHEAD_MS` of travel. */
  hazard: 'tree' | 'rock' | null;
}
/** Separate feedback stream: legacy scoring still receives one ordinary hit,
 * never duplicate counter points. The scene drains this after HUD/audio. */
export type SkillCombatEvent = {
  type: 'windup' | 'evade' | 'counter' | 'rival-hit' | 'whiff';
  rider: AIRider;
  evade?: 'steer' | 'jump';
};

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
  readonly skillEvents: SkillCombatEvent[] = [];
  /** Snowballs thrown, drained by the scene to launch the projectile visual. */
  readonly throwEvents: ThrowEvent[] = [];
  private readonly observedAttacks = new Map<AIRider, number>();
  private counterRider: AIRider | null = null;
  private counterRemainingMs = 0;

  // Per-rival-pair cooldown (§4.6 "shove immunity", scoped per attacker —
  // since every exchange is player-vs-that-specific-rival, a pairwise cooldown
  // keyed by rider covers both directions: the same rider can't re-trigger an
  // exchange with the player, but a DIFFERENT rider is unaffected).
  private readonly pairImmunityMs = new Map<AIRider, number>();
  private readonly seenTreeCrashes = new Map<AIRider, number>();
  /** Global attack cooldown, independent of target. Longer than pair
   *  immunity, so re-attacking the SAME rival is gated by this. */
  private attackCooldownMs = 0;
  /** The directional shove's own cooldown. Separate from the jab's, so a
   *  jab is never locked out by a shove (or the reverse); pair immunity still
   *  stops both landing on the same rival back-to-back. */
  private pushCooldownMs = 0;

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
    riders.forEach((rider) => this.seenTreeCrashes.set(rider, rider.treeCrashSerial));
  }

  /**
   * Call once per frame, AFTER every rider's own `update()`/collision pass
   * has run (so this frame's `wipedOut` transitions are final) but BEFORE
   * anything reads `events` for scoring.
   */
  update(deltaMs: number, nowMs: number): void {
    this.attackCooldownMs = Math.max(0, this.attackCooldownMs - deltaMs);
    this.pushCooldownMs = Math.max(0, this.pushCooldownMs - deltaMs);
    for (const [rider, ms] of this.pairImmunityMs) {
      const next = ms - deltaMs;
      if (next <= 0) {
        this.pairImmunityMs.delete(rider);
      } else {
        this.pairImmunityMs.set(rider, next);
      }
    }

    this.counterRemainingMs = Math.max(0, this.counterRemainingMs - deltaMs);
    if (this.counterRemainingMs <= 0 || this.player.wipedOut || this.player.collisionImmune ||
        this.counterRider?.wipedOut || (this.counterRider !== null && this.counterRider.finishTimeMs !== null)) {
      this.counterRider = null;
      this.counterRemainingMs = 0;
    }
    this.updateRivalAttacks(nowMs);
    this.checkSameLaneContacts(nowMs);
    this.checkKnockoutTransitions(nowMs);
    this.updateTarget(deltaMs);
  }

  /** Visible wind-up nearest to the player, for the textual/audio tell. */
  get incomingAttack(): AIRider | null {
    return this.riders.filter((rider) => !rider.wipedOut && rider.finishTimeMs === null && rider.attackPhase === 'windup')
      .sort((a, b) => Math.abs(a.worldZ - this.player.worldZ) - Math.abs(b.worldZ - this.player.worldZ))[0] ?? null;
  }
  get counterTarget(): AIRider | null { return this.counterRemainingMs > 0 ? this.counterRider : null; }
  get counterReady(): boolean { return this.counterTarget !== null && this.isAttackable(this.counterTarget); }
  get counterFraction(): number { return this.counterTarget ? this.counterRemainingMs / COUNTER_WINDOW_MS : 0; }

  /** True while the attack key would be refused — drives the HUD cooldown pip. */
  get attackOnCooldown(): boolean {
    return this.attackCooldownMs > 0;
  }

  get pushOnCooldown(): boolean {
    return this.pushCooldownMs > 0;
  }

  get pushCooldownFraction(): number {
    return Math.max(0, Math.min(1, this.pushCooldownMs / PUSH_COOLDOWN_MS));
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
    if (this.counterTarget && this.isAttackable(this.counterTarget)) return this.counterTarget;
    return this.currentTarget && this.isAttackable(this.currentTarget) ? this.currentTarget : null;
  }

  /** Score for target selection: 0 at touching, 1 at the edge of reach.
   *  Lateral and longitudinal distance are normalised to their own ranges
   *  first, so the two units are comparable. */
  private targetScore(rider: AIRider, ordinaryReach = false): number | null {
    const dFrac = Math.abs(rider.laneOffsetFraction - this.player.laneOffsetFraction);
    const dz = Math.abs(rider.worldZ - this.player.worldZ);
    const isCounter = !ordinaryReach && rider === this.counterTarget;
    const lateralReach = isCounter ? COUNTER_LANE_REACH : ATTACK_LANE_REACH;
    const zReach = SHOVE_Z_WINDOW * (isCounter ? COUNTER_Z_REACH_FACTOR : 1);
    if (dFrac > lateralReach || dz > zReach) {
      return null;
    }
    return dFrac / lateralReach + dz / zReach;
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
  private isEligible(rider: AIRider, cooldownMs = this.attackCooldownMs, forPush = false): boolean {
    const isCounter = !forPush && rider === this.counterTarget;
    if (this.player.wipedOut || (this.player.airborne && !isCounter) || this.player.collisionImmune) return false;
    if (rider.airborne && !isCounter) return false;
    if (rider.wipedOut || rider.finishTimeMs !== null || rider.knockedDown || rider.collisionImmune) return false;
    if ((this.pairImmunityMs.get(rider) ?? 0) > 0) return false;
    if (cooldownMs > 0) return false;
    return true;
  }

  /** Both halves: in reach AND allowed. */
  private isAttackable(rider: AIRider): boolean {
    return this.isEligible(rider) && this.targetScore(rider) !== null;
  }

  /**
   * The rival a directional shove would push, or null. Same tracked target as
   * the jab, but it never takes the counter rider (a shove is not a counter and
   * must not spend the counter window), uses ordinary reach and altitude rules,
   * and is gated by the shove's own cooldown.
   */
  get pushTarget(): AIRider | null {
    const rider = this.currentTarget;
    if (!rider || rider === this.counterTarget) return null;
    if (!this.isEligible(rider, this.pushCooldownMs, true) || this.targetScore(rider, true) === null) return null;
    return rider;
  }

  /**
   * The rival a thrown snowball would hit right now, or null.
   *
   * Only exists while a snowball is held and NO melee target is available
   * (the melee attack takes priority and keeps the snowball). It is the
   * nearest rival strictly ahead, in the player's lane or an adjacent one,
   * within `SNOWBALL_RANGE_SEGMENTS`, that passes the same eligibility guards a
   * melee exchange does (airborne, tumbling, pair immunity, cooldown). The HUD
   * chevron and `attemptThrow` both read this one value, so the marker cannot
   * promise a throw that is then refused. Ties on distance go to the nearer
   * lane, then to roster order.
   */
  get throwTarget(): AIRider | null {
    if (this.player.snowballs <= 0 || this.target !== null) return null;
    const reach = SNOWBALL_RANGE_SEGMENTS * SEGMENT_LENGTH;
    let best: AIRider | null = null;
    let bestDz = Infinity;
    let bestLane = Infinity;
    for (const rider of this.riders) {
      const dz = rider.worldZ - this.player.worldZ;
      const lanes = Math.abs(rider.laneIndex - this.player.laneIndex);
      if (dz <= 0 || dz > reach || lanes > 1) continue;
      if (!this.isEligible(rider)) continue;
      if (dz < bestDz || (dz === bestDz && lanes < bestLane)) {
        best = rider;
        bestDz = dz;
        bestLane = lanes;
      }
    }
    return best;
  }

  /**
   * The player pressed attack with a snowball held and no melee target.
   * Resolves as an ordinary deliberate exchange the rival loses (no pole
   * bonus), spends the snowball and starts the normal attack cooldown. No
   * swing: throwing does not lock steering. Returns whether it threw.
   */
  attemptThrow(nowMs: number): boolean {
    const rider = this.throwTarget;
    if (!rider) return false;
    const fromLane = rider.laneIndex;
    this.attackCooldownMs = ATTACK_COOLDOWN_MS;
    this.player.consumeSnowball();
    this.resolveExchange(rider, nowMs, true, 'player', false, true);
    this.throwEvents.push({ rider, fromLane });
    return true;
  }

  /** Where a shove at `rider` would send it, given the steer key held. */
  pushPlan(rider: AIRider, heldDirection: -1 | 0 | 1 = 0): PushPlan {
    const fromLane = rider.laneIndex;
    const lateral = LANES[fromLane] - this.player.laneOffsetFraction;
    let direction: -1 | 1;
    if (Math.abs(lateral) > SAME_LANE_EPSILON) direction = lateral > 0 ? 1 : -1; // away from the player
    else if (heldDirection !== 0) direction = heldDirection; // same lane: the side being held
    else direction = this.knockbackDirection(true, fromLane); // nothing held: toward road centre
    // At the road edge the push flips inward rather than doing nothing.
    const first = fromLane + direction;
    if (first < 0 || first >= LANE_COUNT) direction = direction === 1 ? -1 : 1;
    const maxShift = this.player.armed ? 2 : 1;
    let lane = fromLane;
    let shift = 0;
    for (let step = 1; step <= maxShift; step++) {
      const next = fromLane + direction * step;
      if (next < 0 || next >= LANE_COUNT) break;
      lane = next;
      shift = step;
      // The push is never refused by a tree, but it ends AT one: an armed
      // push cannot carry the rival through a tree lane to a clear one.
      if (this.hasTreeDownstream(next, rider.worldZ)) break;
    }
    const reach = rider.worldZ + rider.speed * PUSH_HAZARD_LOOKAHEAD_MS / 1000;
    const found = this.obstacles.find((o) => (o.kind === 'tree' || o.kind === 'rock') && o.lane === lane &&
      o.z >= rider.worldZ - SEGMENT_LENGTH * 0.5 && o.z <= reach);
    const hazard = found ? (found.kind === 'tree' ? 'tree' : 'rock') : null;
    return { direction, lane, shift, hazard };
  }

  /**
   * The player pressed SHOVE.
   *
   * Returns true if a shove started. Like the jab, a press with no eligible
   * target is refused for free. Unlike the jab it never compares speeds, cannot
   * be a counter, ignores the tree clamp, and adds no stagger pip: its cost is
   * the 400 ms steering lock and 900 ms cooldown.
   */
  attemptPush(nowMs: number, heldDirection: -1 | 0 | 1 = 0): boolean {
    const rider = this.pushTarget;
    if (!rider) return false;
    const plan = this.pushPlan(rider, heldDirection);
    this.pushCooldownMs = PUSH_COOLDOWN_MS;
    this.player.startSwing(PUSH_SWING_MS);
    if (this.player.armed) this.player.consumeWeaponCharge();
    rider.applyKnockback(plan.lane, PUSH_SPEED_LOSS);
    rider.notifyHit();
    rider.markShovedByPlayer(nowMs);
    this.events.push({ type: 'push', rider });
    this.pairImmunityMs.set(rider, SHOVE_IMMUNITY_MS);
    return true;
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
      if (rider.wipedOut || rider.finishTimeMs !== null || rider.knockedDown) continue;
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
    const rider = this.target;
    if (!rider || !this.isAttackable(rider)) {
      return false;
    }
    this.attackCooldownMs = ATTACK_COOLDOWN_MS;
    this.player.startSwing();
    const isCounter = rider === this.counterTarget;
    this.resolveExchange(rider, nowMs, true, isCounter ? 'player' : undefined, isCounter);
    if (isCounter) {
      this.skillEvents.push({ type: 'counter', rider });
      this.counterRider = null;
      this.counterRemainingMs = 0;
    }
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
    if (this.player.wipedOut) return;
    const playerFraction = this.player.laneOffsetFraction;
    for (const rider of this.riders) {
      const aerialContact = this.player.airborne && rider.airborne && rider.personality === 'daredevil' &&
        Math.abs(this.player.jumpArcHeight - rider.jumpArcHeight) < 0.35;
      const sameAltitude = (!this.player.airborne && !rider.airborne) || aerialContact;
      const touching = !rider.wipedOut && rider.finishTimeMs === null && sameAltitude &&
        Math.abs(rider.worldZ - this.player.worldZ) <= SHOVE_Z_WINDOW &&
        Math.abs(rider.laneOffsetFraction - playerFraction) <= COLLISION_LANE_FRACTION;
      if (!touching) { this.inContact.delete(rider); continue; }
      // Never sneak a passive impact in during an advertised wind-up, its
      // strike, or recovery. Counter opportunity is protected from brushes.
      if (rider.attackPhase !== 'idle' || rider === this.counterTarget) continue;
      if (this.inContact.has(rider)) continue;
      this.inContact.add(rider);
      if ((this.pairImmunityMs.get(rider) ?? 0) > 0) continue;
      // A production rival's incoming body check is also telegraphed. Older
      // untyped fixtures retain the legacy passive speed-exchange contract.
      if ((rider.params.personality && this.player.speed < rider.speed) || aerialContact) {
        if (rider.requestTelegraphedAttack(this.player)) this.announceWindup(rider);
        continue;
      }
      if (this.resolveExchange(rider, nowMs, false)) return;
    }
  }

  private announceWindup(rider: AIRider): void {
    if (this.observedAttacks.get(rider) === rider.attackId) return;
    this.observedAttacks.set(rider, rider.attackId);
    this.skillEvents.push({ type: 'windup', rider });
  }

  private updateRivalAttacks(nowMs: number): void {
    let struckPlayer = false;
    for (const rider of this.riders) {
      if (rider.attackPhase === 'windup') this.announceWindup(rider);
      const strike = rider.consumeStrike();
      if (!strike) continue;
      if (rider.wipedOut || rider.finishTimeMs !== null || rider.collisionImmune || rider.hitReacting ||
          this.player.wipedOut || this.player.collisionImmune || (this.pairImmunityMs.get(rider) ?? 0) > 0) continue;
      const inZReach = Math.abs(rider.worldZ - this.player.worldZ) <= SHOVE_Z_WINDOW;
      const onTargetLine = Math.abs(this.player.laneOffsetFraction - strike.targetFraction) <= COLLISION_LANE_FRACTION;
      const sameAltitude = strike.airborne
        ? rider.airborne && this.player.airborne && Math.abs(rider.jumpArcHeight - this.player.jumpArcHeight) < 0.35
        : !this.player.airborne && !rider.airborne;
      const missed = !inZReach || !onTargetLine || !sameAltitude;
      if (missed) {
        const actionAgeAtStrike = this.player.maneuverAgeMs - strike.ageMs;
        const deliberateEvade = this.player.maneuverSerial > rider.attackManeuverSerial &&
          actionAgeAtStrike >= 0 && actionAgeAtStrike <= EVADE_TIMING_MS &&
          Math.abs(this.player.maneuverFromFraction - strike.targetFraction) <= COLLISION_LANE_FRACTION;
        const steerEvade = this.player.maneuverKind === 'steer' && !onTargetLine;
        const jumpEvade = this.player.maneuverKind === 'jump' && this.player.airborne && !strike.airborne;
        if (inZReach && deliberateEvade && (steerEvade || jumpEvade)) {
          this.counterRider = rider;
          this.counterRemainingMs = COUNTER_WINDOW_MS;
          // A deliberate successful evade earns an actual usable counter,
          // even if a previous attack's global cooldown has not quite ended.
          this.attackCooldownMs = 0;
          this.skillEvents.push({ type: 'evade', rider, evade: steerEvade ? 'steer' : 'jump' });
        } else this.skillEvents.push({ type: 'whiff', rider });
        continue;
      }
      if (!struckPlayer && this.resolveExchange(rider, nowMs, false, 'rival', strike.airborne)) {
        this.skillEvents.push({ type: 'rival-hit', rider });
        this.counterRemainingMs = 0;
        this.counterRider = null;
        struckPlayer = true;
      }
    }
  }

  /**
   * Knockout attribution (§4.6/§4.7): scans for a rider that just
   * hit a tree this frame (`treeCrashSerial` advanced: a first-strike heavy
   * crash or the eliminating second strike — see `AIRider.crashIntoTree`;
   * a rider cannot take both on one frame) and, if it happened within `KNOCKOUT_WINDOW_MS`
   * of losing a shove to the player, records a knockout event.
   */
  private checkKnockoutTransitions(nowMs: number): void {
    for (const rider of this.riders) {
      const seen = this.seenTreeCrashes.get(rider) ?? 0;
      if (rider.treeCrashSerial > seen && rider.wasRecentlyShovedByPlayer(nowMs, KNOCKOUT_WINDOW_MS)) {
        this.events.push({ type: 'knockout', rider });
        rider.consumeShoveCredit(); // one knockout per incident
      }
      this.seenTreeCrashes.set(rider, rider.treeCrashSerial);
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
  private resolveExchange(rider: AIRider, nowMs: number, deliberate: boolean,
    winner?: 'player' | 'rival', allowAirborne = false, snowball = false): boolean {
    if (this.player.wipedOut || rider.wipedOut || (!allowAirborne && (this.player.airborne || rider.airborne)) || rider.finishTimeMs !== null) {
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
    const counter = winner === 'player' && !snowball;
    const armed = deliberate && this.player.armed && !counter && !snowball;
    const playerWins = winner ? winner === 'player' : armed || this.player.speed >= rider.speed;
    const maxShift = armed && playerWins ? 2 : 1;
    const speedLossFactor = (armed || counter) && playerWins ? ARMED_SHOVE_SPEED_LOSS_FACTOR : SHOVE_SPEED_LOSS_FACTOR;

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
      const pips = counter ? STAGGER_PIPS.COUNTER : !deliberate ? STAGGER_PIPS.BRUSH :
        armed ? STAGGER_PIPS.ARMED_HIT : STAGGER_PIPS.HIT;
      if (rider.addStagger(pips)) {
        // The knockdown is the knockout for this incident: spend the shove
        // attribution so a later tree contact cannot pay a second one.
        this.events.push({ type: 'knockout', rider });
        rider.consumeShoveCredit();
        if (this.counterRider === rider) { this.counterRider = null; this.counterRemainingMs = 0; }
      }
    } else {
      if (this.player.breakShield()) {
        // The shield eats the whole exchange: no knockback, speed loss or
        // recoil. Pair immunity below still applies, so the same rival cannot
        // land a second blow on the broken shield's heels.
      } else {
        this.player.applyKnockback(targetLane, speedLossFactor, allowAirborne);
        // The player losing an exchange used to produce no signal at all — no
        // event, no state, nothing for the scene to react to. Now it recoils
        // and flashes exactly like a rival does.
        this.player.notifyHit();
      }
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
