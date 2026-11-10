import { COLLISION_LANE_FRACTION, COLLISION_Z_WINDOW, WAX_BOOST_GAIN } from '../config';
import { laneFraction } from './obstacle';
import { Player } from './player';

/** What a pickup does when collected (#36). */
export type PickupKind = 'pole' | 'shield' | 'wax' | 'snowball';
/** Canonical order: art sheets, weights and the placement draw all use it. */
export const PICKUP_KIND_LIST: readonly PickupKind[] = ['pole', 'shield', 'wax', 'snowball'];

/**
 * A course pickup (design-spec §4.2/§4.6, kinds from #36). Lives in world
 * coordinates like every other entity (§3.5): a lane and a world-Z at the
 * centre of its segment, matching `Obstacle`'s shape.
 */
export interface Pickup {
  kind: PickupKind;
  lane: number;
  segIndex: number;
  z: number;
  /** Set once collected; renderer and collection both skip it thereafter. */
  collected: boolean;
}

/** The only slice of the boost meter a pickup needs (speed wax). */
export interface BoostSink {
  add(amount: number): void;
}

/**
 * Collects pickups by lane + Z proximity (§4.6) — reuses the same
 * `COLLISION_Z_WINDOW`/`COLLISION_LANE_FRACTION` tolerances `CollisionSystem`
 * uses for obstacles, but deliberately does NOT check `player.airborne`:
 * unlike a solid obstacle, a pickup collects even while airborne (§4.3/§4.6
 * — "isn't something you'd want to dodge by jumping over").
 *
 * Applies each effect the moment it is collected and returns the kinds
 * collected this call, so the scene can message and play audio without
 * diffing player state.
 */
export function collectPickups(player: Player, pickups: Pickup[], boost: BoostSink): PickupKind[] {
  const collected: PickupKind[] = [];
  if (player.wipedOut) {
    return collected;
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
    collected.push(pickup.kind);
    switch (pickup.kind) {
      case 'pole': player.armWeapon(); break;
      case 'snowball': player.giveSnowball(); break;
      case 'shield': player.giveShield(); break;
      case 'wax': boost.add(WAX_BOOST_GAIN); break;
    }
  }
  return collected;
}
