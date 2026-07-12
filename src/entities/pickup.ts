import { COLLISION_LANE_FRACTION, COLLISION_Z_WINDOW } from '../config';
import { laneFraction } from './obstacle';
import { Player } from './player';

/**
 * The ski-pole weapon pickup (design-spec §4.2/§4.6). Lives in world
 * coordinates like every other entity (§3.5): a lane and a world-Z at the
 * centre of its segment, matching `Obstacle`'s shape.
 */
export interface Pickup {
  lane: number;
  segIndex: number;
  z: number;
  /** Set once collected; renderer and collection both skip it thereafter. */
  collected: boolean;
}

/**
 * Collects pickups by lane + Z proximity (§4.6) — reuses the same
 * `COLLISION_Z_WINDOW`/`COLLISION_LANE_FRACTION` tolerances `CollisionSystem`
 * uses for obstacles, but deliberately does NOT check `player.airborne`:
 * unlike a solid obstacle, a pickup collects even while airborne (§4.3/§4.6
 * — "isn't something you'd want to dodge by jumping over").
 */
export function collectPickups(player: Player, pickups: Pickup[]): void {
  if (player.wipedOut) {
    return;
  }
  for (const pickup of pickups) {
    if (pickup.collected) {
      continue;
    }
    if (Math.abs(pickup.z - player.worldZ) > COLLISION_Z_WINDOW) {
      continue;
    }
    if (Math.abs(laneFraction(pickup.lane) - player.laneOffsetFraction) > COLLISION_LANE_FRACTION) {
      continue;
    }
    pickup.collected = true;
    player.armWeapon();
    // Temporary stand-in (same convention as the other phases' console logs)
    // until Task 9's real HUD/scoring reads this — the `weaponText` HUD
    // field already shows the charge count live.
    // eslint-disable-next-line no-console
    console.log(`[BDB] picked up ski pole — armed with ${player.weaponCharges} charges`);
  }
}
