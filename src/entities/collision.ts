import { COLLISION_LANE_FRACTION, COLLISION_Z_WINDOW, MOGUL_LAUNCH_WINDOW } from '../config';
import { isJumpable, obstacleLaneFraction, Obstacle } from './obstacle';
import { Player } from './player';

/**
 * Player-vs-obstacle collision (design-spec §4.4). A hit needs the player and
 * obstacle in the same lane (lateral offset within `COLLISION_LANE_FRACTION`)
 * and their world-Z within `COLLISION_Z_WINDOW` (~half a segment), and the
 * player NOT airborne over a jumpable obstacle (rock/mogul pass beneath; a tree
 * is too tall and hits even mid-air).
 *
 * Stateful only to fire each obstacle's outcome exactly once — without the
 * `hit` set the player would sit inside the ~0.5-segment window for several
 * frames and re-apply the effect (e.g. compounding a rock's speed drop). Call
 * `reset()` when the course is regenerated.
 */
export class CollisionSystem {
  private readonly hit = new Set<Obstacle>();

  reset(): void {
    this.hit.clear();
  }

  update(player: Player, obstacles: Obstacle[]): void {
    if (player.wipedOut) {
      return;
    }
    const pz = player.worldZ;
    const pf = player.laneOffsetFraction;

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
      if (player.airborne && isJumpable(obstacle.kind)) {
        continue;
      }
      // Temporary post-collision immunity (still passing through, don't consume
      // the obstacle — the player is far past it before immunity lapses).
      if (player.collisionImmune) {
        continue;
      }

      this.hit.add(obstacle);
      switch (obstacle.kind) {
        case 'tree':
          player.crashIntoTree();
          break;
        case 'rock':
          player.hitRock();
          break;
        case 'mogul':
          player.hitMogul();
          break;
      }
      if (player.wipedOut) {
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
