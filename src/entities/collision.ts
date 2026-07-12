import { COLLISION_LANE_FRACTION, COLLISION_Z_WINDOW, MOGUL_LAUNCH_WINDOW } from '../config';
import { isJumpable, obstacleLaneFraction, Obstacle } from './obstacle';
import { Player } from './player';

/**
 * Minimal shape any rider (player or AI) must expose for obstacle collision
 * (design-spec §4.4) — extracted so Task 7's AI riders can reuse this system
 * as-is rather than forking a parallel copy of the tree/rock/mogul outcome
 * logic (§4.5's explicit instruction: AI riders "suffer normal obstacle
 * collisions" under "the same rules as the player"). `Player` already
 * satisfies this shape structurally.
 */
export interface Collidable {
  worldZ: number;
  readonly laneOffsetFraction: number;
  readonly airborne: boolean;
  readonly collisionImmune: boolean;
  readonly wipedOut: boolean;
  crashIntoTree(): void;
  hitRock(): void;
  hitMogul(): void;
}

/**
 * Rider-vs-obstacle collision (design-spec §4.4). A hit needs the rider and
 * obstacle in the same lane (lateral offset within `COLLISION_LANE_FRACTION`)
 * and their world-Z within `COLLISION_Z_WINDOW` (~half a segment), and the
 * rider NOT airborne over a jumpable obstacle (rock/mogul pass beneath; a tree
 * is too tall and hits even mid-air).
 *
 * Stateful only to fire each obstacle's outcome exactly once — without the
 * `hit` set the rider would sit inside the ~0.5-segment window for several
 * frames and re-apply the effect (e.g. compounding a rock's speed drop). Call
 * `reset()` when the course is regenerated. Each rider (player + every AI
 * rider) needs its OWN `CollisionSystem` instance — the `hit` set is
 * per-rider, not shared, so one rider clearing an obstacle never hides it
 * from another.
 */
export class CollisionSystem {
  private readonly hit = new Set<Obstacle>();

  reset(): void {
    this.hit.clear();
  }

  update(rider: Collidable, obstacles: Obstacle[]): void {
    if (rider.wipedOut) {
      return;
    }
    const pz = rider.worldZ;
    const pf = rider.laneOffsetFraction;

    for (const obstacle of obstacles) {
      if (this.hit.has(obstacle)) {
        continue;
      }
      if (Math.abs(obstacle.z - pz) > COLLISION_Z_WINDOW) {
        continue;
      }
      if (Math.abs(obstacleLaneFraction(obstacle) - pf) > COLLISION_LANE_FRACTION) {
        continue;
      }
      // Same lane + Z window. Airborne clears jumpable obstacles.
      if (rider.airborne && isJumpable(obstacle.kind)) {
        continue;
      }
      // Temporary post-collision immunity (still passing through, don't consume
      // the obstacle — the rider is far past it before immunity lapses).
      if (rider.collisionImmune) {
        continue;
      }

      this.hit.add(obstacle);
      switch (obstacle.kind) {
        case 'tree':
          rider.crashIntoTree();
          break;
        case 'rock':
          rider.hitRock();
          break;
        case 'mogul':
          rider.hitMogul();
          break;
      }
      if (rider.wipedOut) {
        break;
      }
    }
  }
}

/**
 * Whether a jump press right now should be an extended MOGUL launch (§4.3): a
 * mogul is in the player's lane within the launch window — from just behind the
 * player (so landing on one still counts) to `MOGUL_LAUNCH_WINDOW` ahead (so
 * pressing "just before" it counts). Returns false → a normal jump.
 */
export function isMogulLaunchAvailable(player: Player, obstacles: Obstacle[]): boolean {
  const pz = player.worldZ;
  const pf = player.laneOffsetFraction;
  for (const obstacle of obstacles) {
    if (obstacle.kind !== 'mogul') {
      continue;
    }
    if (Math.abs(obstacleLaneFraction(obstacle) - pf) > COLLISION_LANE_FRACTION) {
      continue;
    }
    const dz = obstacle.z - pz;
    if (dz >= -COLLISION_Z_WINDOW && dz <= MOGUL_LAUNCH_WINDOW) {
      return true;
    }
  }
  return false;
}
