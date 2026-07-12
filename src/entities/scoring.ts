import {
  JUMP_AIRTIME_EXTENDED_MS,
  JUMP_AIRTIME_MS,
  MAX_SPEED,
  NEAR_MISS_MAX_LANE_DISTANCE,
  NEAR_MISS_MIN_SPEED_FACTOR,
  PAR_TIME,
  POINTS
} from '../config';
import { AIRider } from './aiRider';
import { CollisionSystem } from './collision';
import { CombatSystem } from './combat';
import { Obstacle } from './obstacle';
import { Player } from './player';

/** Full score breakdown for the Result screen (design-spec §4.7). */
export interface ScoreBreakdown {
  combatHitCount: number;
  combatHitPoints: number;
  knockoutCount: number;
  knockoutPoints: number;
  nearMissCount: number;
  nearMissPoints: number;
  trickJumpCount: number;
  trickJumpPoints: number;
  /** Sum of the event categories above — the running total shown live on
   *  the race HUD before the run ends. */
  eventTotal: number;
  /** True if the run ended by crossing the finish line; false if wiped out. */
  finished: boolean;
  completionBonus: number;
  finishTimeSeconds: number;
  timeBonus: number;
  /** 1st-5th among the player + 4 rivals (§4.7) — computed and shown even on
   *  a wipeout, just unrewarded there. */
  position: number;
  positionBonus: number;
  total: number;
}

const POSITION_BONUS_BY_PLACE: Record<number, number> = {
  1: POINTS.POSITION_BONUS_FIRST,
  2: POINTS.POSITION_BONUS_SECOND,
  3: POINTS.POSITION_BONUS_THIRD,
  4: POINTS.POSITION_BONUS_FOURTH,
  5: POINTS.POSITION_BONUS_FIFTH
};

/**
 * Tracks running event score (combat, near-miss, trick jumps — §4.7) during
 * a race and computes the full breakdown, including the finish-only
 * completion/time/position bonuses, once the run ends.
 *
 * Owns two kinds of one-shot detection state per §4.7's precise rules:
 *  - Near-miss is evaluated EXACTLY ONCE per obstacle/rider, at the moment
 *    its world-Z crosses the player's — never a continuous per-frame check,
 *    so a dense obstacle row or a rival lingering nearby can't re-trigger it.
 *  - Trick-jump points are awarded once per landing, on the airborne→grounded
 *    transition, only when that jump was an extended (mogul/crest) launch.
 */
export class ScoreTracker {
  private combatHitCount = 0;
  private knockoutCount = 0;
  private nearMissCount = 0;
  private trickJumpCount = 0;
  private trickJumpPoints = 0;
  private eventPoints = 0;

  private readonly evaluatedObstacles = new Set<Obstacle>();
  private readonly evaluatedRiders = new Set<AIRider>();
  private readonly previousRiderZ = new Map<AIRider, number>();
  private previousPlayerZ: number;
  private previousAirborne: boolean;

  constructor(
    private readonly player: Player,
    private readonly riders: AIRider[],
    private readonly obstacles: Obstacle[],
    private readonly playerCollisions: CollisionSystem,
    private readonly combat: CombatSystem
  ) {
    this.previousPlayerZ = player.worldZ;
    this.previousAirborne = player.airborne;
    riders.forEach((rider) => this.previousRiderZ.set(rider, rider.worldZ));
  }

  /** Running event-only total (combat + near-miss + trick), for the live HUD
   *  before the run ends — completion/time/position bonuses only exist once
   *  `finalize()` runs. */
  get runningScore(): number {
    return this.eventPoints;
  }

  /**
   * Call once per frame, AFTER this frame's combat resolution, obstacle
   * collision, and pickup collection have all settled (so `wasHit`/combat
   * events reflect final per-frame state).
   */
  update(): void {
    this.drainCombatEvents();
    this.checkNearMisses();
    this.checkTrickJumpLanding();
    this.previousPlayerZ = this.player.worldZ;
    for (const rider of this.riders) {
      this.previousRiderZ.set(rider, rider.worldZ);
    }
  }

  /** Combat hit = 250, knockout = 500 ON TOP of the hit that caused it (a
   *  knockout totals 750 — §4.7) — both land as separate events from
   *  `CombatSystem`, so no special-casing is needed here beyond summing them. */
  private drainCombatEvents(): void {
    for (const event of this.combat.events) {
      if (event.type === 'hit') {
        this.combatHitCount++;
        this.eventPoints += POINTS.COMBAT_HIT;
      } else {
        this.knockoutCount++;
        this.eventPoints += POINTS.KNOCKOUT;
      }
    }
    this.combat.events.length = 0;
  }

  private checkNearMisses(): void {
    const playerZ = this.player.worldZ;
    const speedOk = this.player.speed >= NEAR_MISS_MIN_SPEED_FACTOR * MAX_SPEED;
    const playerLane = this.player.laneIndex;

    for (const obstacle of this.obstacles) {
      if (this.evaluatedObstacles.has(obstacle)) {
        continue;
      }
      // Obstacles are static, so crossing is one-sided: the player advances
      // from before it to at-or-past it.
      if (!(this.previousPlayerZ < obstacle.z && playerZ >= obstacle.z)) {
        continue;
      }
      this.evaluatedObstacles.add(obstacle); // evaluated now, regardless of outcome below
      if (!speedOk) {
        continue;
      }
      if (this.playerCollisions.wasHit(obstacle)) {
        continue; // a real hit isn't a "near" miss
      }
      if (Math.abs(obstacle.lane - playerLane) > NEAR_MISS_MAX_LANE_DISTANCE) {
        continue;
      }
      this.awardNearMiss();
    }

    for (const rider of this.riders) {
      const prevRiderZ = this.previousRiderZ.get(rider) ?? rider.worldZ;
      if (this.evaluatedRiders.has(rider)) {
        continue;
      }
      // Both entities move, so crossing is a sign change in (riderZ - playerZ).
      const prevSign = Math.sign(prevRiderZ - this.previousPlayerZ);
      const currSign = Math.sign(rider.worldZ - playerZ);
      if (prevSign === 0 || currSign === 0 || prevSign === currSign) {
        continue;
      }
      this.evaluatedRiders.add(rider);
      if (!speedOk || rider.wipedOut) {
        continue;
      }
      // Same-lane rider encounters are always combat's job (§4.6), never a
      // peaceful pass — a near miss is specifically the ADJACENT-lane graze.
      if (Math.abs(rider.laneIndex - playerLane) !== NEAR_MISS_MAX_LANE_DISTANCE) {
        continue;
      }
      this.awardNearMiss();
    }
  }

  private awardNearMiss(): void {
    this.nearMissCount++;
    this.eventPoints += POINTS.NEAR_MISS;
  }

  /** Trick jump = 150 base, +50 per extra 0.25s of airtime beyond a normal
   *  jump's ~600ms (§4.7) — only extended (mogul/crest) launches qualify. */
  private checkTrickJumpLanding(): void {
    const airborne = this.player.airborne;
    if (this.previousAirborne && !airborne && this.player.extendedJump) {
      this.trickJumpCount++;
      const extraAirtimeMs = Math.max(0, JUMP_AIRTIME_EXTENDED_MS - JUMP_AIRTIME_MS);
      const extraQuarterSeconds = Math.floor(extraAirtimeMs / 250);
      const points = POINTS.TRICK_JUMP + extraQuarterSeconds * POINTS.TRICK_JUMP_EXTRA_PER_QUARTER_SECOND;
      this.trickJumpPoints += points;
      this.eventPoints += points;
    }
    this.previousAirborne = airborne;
  }

  /**
   * Computes the full breakdown once the run ends. `finished` = crossed the
   * finish line (completion/time/position bonuses apply); false = wiped out
   * (event points only kept — §4.7). `position` is still included either way
   * for display, just unrewarded on a wipeout. `elapsedRaceMs` MUST be
   * race-elapsed time (e.g. `time - raceStartMs`) — it's compared against the
   * fixed `PAR_TIME` constant below, so a caller passing Phaser's raw
   * `update(time, ...)` clock (shared globally across every scene, never
   * reset on a scene restart) would silently zero the time bonus after the
   * very first race.
   */
  finalize(finished: boolean, elapsedRaceMs: number, position: number): ScoreBreakdown {
    const finishTimeSeconds = elapsedRaceMs / 1000;
    const completionBonus = finished ? POINTS.COMPLETION_BONUS : 0;
    const timeBonus = finished ? Math.max(0, PAR_TIME - finishTimeSeconds) * POINTS.TIME_BONUS_PER_SECOND_UNDER_PAR : 0;
    const positionBonus = finished ? (POSITION_BONUS_BY_PLACE[position] ?? 0) : 0;
    const eventTotal = this.eventPoints;

    return {
      combatHitCount: this.combatHitCount,
      combatHitPoints: this.combatHitCount * POINTS.COMBAT_HIT,
      knockoutCount: this.knockoutCount,
      knockoutPoints: this.knockoutCount * POINTS.KNOCKOUT,
      nearMissCount: this.nearMissCount,
      nearMissPoints: this.nearMissCount * POINTS.NEAR_MISS,
      trickJumpCount: this.trickJumpCount,
      trickJumpPoints: this.trickJumpPoints,
      eventTotal,
      finished,
      completionBonus,
      finishTimeSeconds,
      timeBonus,
      position,
      positionBonus,
      total: eventTotal + completionBonus + timeBonus + positionBonus
    };
  }
}

interface StandingEntry {
  isPlayer: boolean;
  worldZ: number;
  /** null = still racing or wiped out before finishing. */
  finishTimeMs: number | null;
}

function compareStandings(a: StandingEntry, b: StandingEntry): number {
  const aFinished = a.finishTimeMs !== null;
  const bFinished = b.finishTimeMs !== null;
  if (aFinished !== bFinished) {
    return aFinished ? -1 : 1; // any finisher outranks any non-finisher
  }
  if (aFinished) {
    return a.finishTimeMs! - b.finishTimeMs!; // earlier finish = better
  }
  return b.worldZ - a.worldZ; // both still racing/DNF: further along = better
}

/**
 * Race position (1st-5th) among the player + 4 rivals (§4.7), by actual
 * finish order for anyone who's finished, falling back to raw progress
 * (world-Z) for anyone who hasn't (still racing, or wiped out before ever
 * reaching the line). Call this exactly once, at the instant the player's own
 * run ends (finish or wipeout) — the position is "frozen" simply because
 * nothing else in the world keeps moving after `RaceScene` stops simulating.
 */
export function computePlayerPosition(player: Player, riders: AIRider[], playerFinishTimeMs: number | null): number {
  const entries: StandingEntry[] = [
    { isPlayer: true, worldZ: player.worldZ, finishTimeMs: playerFinishTimeMs },
    ...riders.map((rider) => ({ isPlayer: false, worldZ: rider.worldZ, finishTimeMs: rider.finishTimeMs }))
  ];
  entries.sort(compareStandings);
  return entries.findIndex((entry) => entry.isPlayer) + 1;
}
