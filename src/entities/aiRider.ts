import {
  AI_BUMP_CHECK_INTERVAL_MS,
  AI_CRUISE_SPEED_MAX_FACTOR,
  COLLISION_Z_WINDOW,
  HIT_REACTION_MS,
  JUMP_AIRTIME_EXTENDED_MS,
  JUMP_AIRTIME_MS,
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
import { mulberry32, type Prng } from '../track/prng';
import { Collidable } from './collision';
import { Obstacle } from './obstacle';
import { deriveRiderSeed, PERSONALITIES, type RivalPersonality } from './personality';
import { Player } from './player';
import { RivalAttack, type AttackPhase, type RivalStrike } from './skillCombat';

const smoothstep = (t: number): number => t * t * (3 - 2 * t);
export const PACK_CHASE_START_Z = SEGMENT_LENGTH * 6;
export const PACK_CHASE_END_Z = SHOVE_Z_WINDOW + SEGMENT_LENGTH * 0.25;
export const PACK_SETBACK_GRACE_MS = 4000;

interface LaneTween { fromLane: number; toLane: number; elapsedMs: number }

export interface AIRiderParams {
  cruiseSpeedFactor: number;
  aggression: number;
  reactionDistanceSegments: number;
  startLane: number;
  startZOffset: number;
  paletteIndex: number;
  /** Optional to keep older model fixtures/save adapters compatible. All
   * generated races supply an explicit archetype and independent seed. */
  name?: string;
  personality?: RivalPersonality;
  behaviorSeed?: number;
}

/** A deterministic rival. Obstacle rules, acceleration and pack pacing remain
 * shared across archetypes; the route and attack decisions are different. */
export class AIRider implements Collidable {
  worldZ: number;
  speed = 0;
  wipedOut = false;
  airborne = false;
  finishTimeMs: number | null = null;
  readonly personality: RivalPersonality;
  readonly homeLane: number;
  readonly behaviorSeed: number;
  private readonly random: Prng;
  private readonly attack = new RivalAttack();
  attackManeuverSerial = 0;
  private _laneIndex: number;
  private tween: LaneTween | null = null;
  private chasingPack = false;
  private packGraceMs = 0;
  private tumbleMsRemaining = 0;
  private immunityMsRemaining = 0;
  private stumbleMsRemaining = 0;
  private bumpCooldownMs: number;
  private shovedByPlayerAtMs: number | null = null;
  private jumpElapsedMs = 0;
  private jumpAirtimeMs = JUMP_AIRTIME_MS;
  hitReactionMsRemaining = 0;

  constructor(readonly params: AIRiderParams) {
    this._laneIndex = params.startLane;
    this.homeLane = params.startLane;
    this.worldZ = params.startZOffset;
    this.personality = params.personality ?? 'bully';
    this.behaviorSeed = params.behaviorSeed ?? deriveRiderSeed(
      Math.floor(params.cruiseSpeedFactor * 0x100000000) ^ Math.floor(params.startZOffset), params.paletteIndex);
    this.random = mulberry32(this.behaviorSeed);
    this.bumpCooldownMs = this.random() * AI_BUMP_CHECK_INTERVAL_MS;
  }

  get personalityName(): string { return PERSONALITIES[this.personality].name; }
  get attackPhase(): AttackPhase { return this.attack.phase; }
  get attackProgress(): number { return this.attack.progress; }
  get attackId(): number { return this.attack.id; }
  get attackTargetFraction(): number { return this.attack.targetFraction; }
  get attackElapsedMs(): number { return this.attack.elapsedMs; }

  update(deltaMs: number, obstacles: Obstacle[], player: Player): void {
    if (this.wipedOut || this.finishTimeMs !== null) { this.attack.cancel(); return; }
    const dt = Math.max(0, deltaMs);
    this.bumpCooldownMs -= dt;
    this.packGraceMs = Math.max(0, this.packGraceMs - dt);
    this.speed = Math.min(this.cruiseSpeedFor(player, dt), this.speed + PLAYER_ACCEL * dt / 1000);
    this.worldZ += this.speed * dt / 1000;
    this.tumbleMsRemaining = Math.max(0, this.tumbleMsRemaining - dt);
    this.hitReactionMsRemaining = Math.max(0, this.hitReactionMsRemaining - dt);
    this.immunityMsRemaining = Math.max(0, this.immunityMsRemaining - dt);
    this.stumbleMsRemaining = Math.max(0, this.stumbleMsRemaining - dt);
    this.updateLaneTween(dt);
    if (this.airborne) {
      this.jumpElapsedMs += dt;
      if (this.jumpElapsedMs >= this.jumpAirtimeMs) this.airborne = false;
    }
    this.attack.update(dt);
    // Committing stops pursuit and locks the target line. Survival still
    // outranks combat: a defensive dodge interrupts the pending strike.
    if (this.tween || this.tumbling || this.hitReacting) return;
    if (this.attackPhase !== 'idle') {
      if (!this.airborne && this.maybeDodge(obstacles)) this.attack.interrupt();
      return;
    }
    if (this.airborne) {
      if (this.personality === 'daredevil' && player.airborne) this.maybeAttack(player);
      return;
    }
    if (this.maybeDodge(obstacles)) return;
    if (this.personality === 'daredevil' && this.seekJump(obstacles)) return;
    if (this.maybeAttack(player)) return;
    if (this.personality === 'bully') this.pursuePlayer(player, obstacles);
    else if (this.personality === 'line-defender') this.defendLine(obstacles);
  }

  protected cruiseSpeedFor(player: Player, deltaMs: number): number {
    const nativeSpeed = MAX_SPEED * this.params.cruiseSpeedFactor;
    const gap = player.worldZ - this.worldZ;
    if (this.packGraceMs > 0 || this.collisionImmune || this.stumbling || this.hitReacting ||
        player.wipedOut || player.speed < MAX_SPEED * 0.9) {
      this.chasingPack = false;
      return nativeSpeed;
    }
    if (gap >= PACK_CHASE_START_Z) this.chasingPack = true;
    const dt = deltaMs / 1000;
    const chaseStep = Math.min(MAX_SPEED * AI_CRUISE_SPEED_MAX_FACTOR, this.speed + PLAYER_ACCEL * dt) * dt;
    if (gap - chaseStep <= PACK_CHASE_END_Z) this.chasingPack = false;
    return this.chasingPack ? MAX_SPEED * AI_CRUISE_SPEED_MAX_FACTOR : nativeSpeed;
  }

  private preserveSetback(): void {
    this.packGraceMs = PACK_SETBACK_GRACE_MS;
    this.chasingPack = false;
  }

  get laneIndex(): number { return this._laneIndex; }
  get laneOffsetFraction(): number {
    if (!this.tween) return LANES[this._laneIndex];
    const t = smoothstep(Math.min(1, this.tween.elapsedMs / LANE_TWEEN_MS));
    return LANES[this.tween.fromLane] + (LANES[this.tween.toLane] - LANES[this.tween.fromLane]) * t;
  }
  get collisionImmune(): boolean { return this.tumbleMsRemaining > 0 || this.immunityMsRemaining > 0; }
  get tumbling(): boolean { return this.tumbleMsRemaining > 0; }
  get stumbling(): boolean { return this.stumbleMsRemaining > 0; }
  get hitReacting(): boolean { return this.hitReactionMsRemaining > 0; }
  get leanDirection(): -1 | 0 | 1 {
    return this.tween ? (this.tween.toLane > this.tween.fromLane ? 1 : -1) : 0;
  }
  get jumpArcHeight(): number {
    if (!this.airborne) return 0;
    const t = this.jumpElapsedMs / this.jumpAirtimeMs;
    return 4 * t * (1 - t);
  }

  crashIntoTree(): void {
    if (this.wipedOut) return;
    this.wipedOut = true;
    this.speed = 0;
    this.airborne = false;
    this.attack.cancel();
  }
  hitRock(): void {
    this.preserveSetback();
    this.speed *= ROCK_SPEED_FACTOR;
    this.tumbleMsRemaining = ROCK_TUMBLE_MS;
    this.immunityMsRemaining = ROCK_TUMBLE_MS + ROCK_IMMUNITY_MS;
    this.tween = null;
    this.airborne = false;
    this.attack.interrupt();
  }
  hitMogul(): void {
    this.preserveSetback();
    this.speed *= MOGUL_SPEED_FACTOR;
    this.stumbleMsRemaining = MOGUL_STUMBLE_MS;
    this.attack.interrupt();
  }

  /** Public so the replayable lesson can arrange a fair encounter, while
   * running precisely the same telegraph, timing and strike as a real race. */
  requestTelegraphedAttack(player: Player): boolean {
    if (this.wipedOut || this.finishTimeMs !== null || this.collisionImmune || this.hitReacting ||
        player.wipedOut || player.collisionImmune || this.attackPhase !== 'idle') return false;
    if (Math.abs(player.worldZ - this.worldZ) > SHOVE_Z_WINDOW ||
        Math.abs(player.laneOffsetFraction - this.laneOffsetFraction) > 0.55) return false;
    // Ground attacks can be jumped. Air attacks require both riders already
    // airborne at the tell, and cannot suddenly turn into a grounded strike.
    if (this.airborne !== player.airborne) return false;
    const definition = PERSONALITIES[this.personality];
    if (!this.attack.begin(player.laneOffsetFraction, this.airborne, definition.windupMs, definition.recoveryMs)) return false;
    this.attackManeuverSerial = player.maneuverSerial;
    this.bumpCooldownMs = definition.attackIntervalMs;
    return true;
  }

  consumeStrike(): RivalStrike | null { return this.attack.takeStrike(); }

  private maybeAttack(player: Player): boolean {
    if (this.bumpCooldownMs > 0 || this.params.aggression <= 0) return false;
    this.bumpCooldownMs = PERSONALITIES[this.personality].attackIntervalMs;
    // Defenders only challenge someone encroaching on the protected line;
    // bullies chase players, while daredevils primarily follow terrain.
    if (this.personality === 'line-defender' &&
        Math.abs(player.laneOffsetFraction - LANES[this.homeLane]) > 0.26) return false;
    if (this.random() >= Math.min(1, this.params.aggression * PERSONALITIES[this.personality].aggressionMultiplier)) return false;
    return this.requestTelegraphedAttack(player);
  }

  /** All voluntary movement checks the full tween horizon. Tree safety wins
   * over pursuit, defending, and finding a spectacular jump. */
  private laneClear(lane: number, obstacles: Obstacle[], distance = this.params.reactionDistanceSegments * SEGMENT_LENGTH): boolean {
    return !obstacles.some((o) => o.lane === lane && o.z >= this.worldZ - COLLISION_Z_WINDOW &&
      o.z <= this.worldZ + distance);
  }
  private moveTo(lane: number): void {
    if (lane === this._laneIndex || lane < 0 || lane >= LANES.length) return;
    this.tween = { fromLane: this._laneIndex, toLane: lane, elapsedMs: 0 };
  }

  private maybeDodge(obstacles: Obstacle[]): boolean {
    const lookahead = this.params.reactionDistanceSegments * SEGMENT_LENGTH;
    const nearest = obstacles.filter((o) => o.lane === this._laneIndex && o.z > this.worldZ - COLLISION_Z_WINDOW &&
      o.z <= this.worldZ + lookahead).sort((a, b) => a.z - b.z)[0];
    if (!nearest) return false;
    if (this.personality === 'daredevil' && nearest.kind !== 'tree' && this.jumpLaneSafe(this._laneIndex, nearest, obstacles)) {
      this.tryTerrainJump(nearest);
      return true; // deliberately hold the jump line until the launch window
    }
    const candidates = [this._laneIndex - 1, this._laneIndex + 1].filter((l) => l >= 0 && l < LANES.length);
    // A defender's escape direction favors its protected line when possible.
    if (this.personality === 'line-defender') candidates.sort((a, b) => Math.abs(a - this.homeLane) - Math.abs(b - this.homeLane));
    for (const lane of candidates) if (this.laneClear(lane, obstacles, lookahead)) { this.moveTo(lane); break; }
    return true;
  }

  private pursuePlayer(player: Player, obstacles: Obstacle[]): void {
    // Old zero-aggression fixtures intentionally stay neutral. Production
    // bullies pursue from beyond attack reach, visibly closing one lane.
    if (this.params.aggression <= 0 || player.wipedOut ||
        Math.abs(player.worldZ - this.worldZ) > SHOVE_Z_WINDOW * 5) return;
    const difference = player.laneIndex - this._laneIndex;
    if (!difference) return;
    const lane = this._laneIndex + Math.sign(difference);
    if (this.laneClear(lane, obstacles)) this.moveTo(lane);
  }

  private defendLine(obstacles: Obstacle[]): void {
    const difference = this.homeLane - this._laneIndex;
    if (!difference) return;
    const lane = this._laneIndex + Math.sign(difference);
    if (this.laneClear(lane, obstacles)) this.moveTo(lane);
  }

  private jumpLaneSafe(lane: number, obstacle: Obstacle, obstacles: Obstacle[]): boolean {
    const airtime = obstacle.kind === 'mogul' ? JUMP_AIRTIME_EXTENDED_MS : JUMP_AIRTIME_MS;
    const landingZ = Math.max(obstacle.z, this.worldZ) + this.speed * (airtime + 250) / 1000;
    return !obstacles.some((o) => o.kind === 'tree' && o.lane === lane &&
      o.z >= this.worldZ - COLLISION_Z_WINDOW && o.z <= landingZ);
  }

  private tryTerrainJump(obstacle: Obstacle): void {
    const launchDistance = this.speed * 0.18 + COLLISION_Z_WINDOW;
    if (obstacle.z - this.worldZ > launchDistance || this.speed <= 0) return;
    this.airborne = true;
    this.jumpElapsedMs = 0;
    this.jumpAirtimeMs = obstacle.kind === 'mogul' ? JUMP_AIRTIME_EXTENDED_MS : JUMP_AIRTIME_MS;
  }

  private seekJump(obstacles: Obstacle[]): boolean {
    const reach = this.params.reactionDistanceSegments * SEGMENT_LENGTH;
    const target = obstacles.filter((o) => o.kind !== 'tree' && o.z > this.worldZ + this.speed * LANE_TWEEN_MS / 1000 + COLLISION_Z_WINDOW &&
      o.z <= this.worldZ + reach && Math.abs(o.lane - this._laneIndex) === 1 && this.jumpLaneSafe(o.lane, o, obstacles))
      .sort((a, b) => a.z - b.z)[0];
    if (!target) return false;
    // An earlier rock is as dangerous as a tree during the lane transition.
    if (!this.laneClear(target.lane, obstacles, target.z - this.worldZ - COLLISION_Z_WINDOW)) return false;
    this.moveTo(target.lane);
    return true;
  }

  notifyHit(): void {
    this.preserveSetback();
    this.hitReactionMsRemaining = HIT_REACTION_MS;
    this.attack.interrupt();
  }
  applyKnockback(targetLaneIndex: number, speedLossFactor: number): void {
    if (this.wipedOut) return;
    if (speedLossFactor > 0) this.preserveSetback();
    this.speed *= 1 - speedLossFactor;
    this.tween = targetLaneIndex === this._laneIndex ? null :
      { fromLane: this._laneIndex, toLane: targetLaneIndex, elapsedMs: 0 };
  }
  markShovedByPlayer(nowMs: number): void { this.shovedByPlayerAtMs = nowMs; }
  wasRecentlyShovedByPlayer(nowMs: number, windowMs: number): boolean {
    return this.shovedByPlayerAtMs !== null && nowMs - this.shovedByPlayerAtMs <= windowMs;
  }
  private updateLaneTween(deltaMs: number): void {
    if (!this.tween) return;
    this.tween.elapsedMs += deltaMs;
    if (this.tween.elapsedMs < LANE_TWEEN_MS) return;
    this._laneIndex = this.tween.toLane;
    this.tween = null;
  }
}
