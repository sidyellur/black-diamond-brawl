/**
 * Render-order bands.
 *
 * Depth was previously chosen ad-hoc at each call site, which left two traps:
 * the player sprite sat at 1e9 — above the HUD, harmless only because the HUD
 * lives in the top-left and the player at bottom-centre — and entities drew
 * over the finish banner because the banner's single depth was below the whole
 * entity range.
 *
 * Bands are spaced far enough apart that no amount of per-entity offsetting
 * inside a band can leak into the next one. World entities are sorted
 * far-to-near *within* `ENTITY` by subtracting world-Z, so nearer things draw
 * on top; that subtraction is why `ENTITY` needs a wide floor beneath it.
 */
export const DEPTH = {
  /** Sky gradient, sun, clouds, parallax ridges — behind everything. */
  BACKDROP: -2_000_000_000,
  /** The distance-haze quad that hides the seam where the road ends. */
  HAZE: -1_500_000_000,
  /** The road surface itself. */
  ROAD: -1_000_000_000,
  /** Contact shadows: above the road, below the things casting them. */
  SHADOW: -800_000_000,
  /** Finish banner — world geometry, but always behind racers and obstacles. */
  BANNER: -600_000_000,
  /**
   * Base for obstacles, riders and pickups. Each subtracts its world-Z from
   * this, so the band spans downward from here; the gap to `BANNER` below is
   * sized to cover a full course length (1500 segments x 200 = 300,000).
   */
  ENTITY: 0,
  /** The player, above every other racer but below all UI. */
  PLAYER: 500_000_000,
  /** Particles, spray, impact bursts. */
  VFX: 800_000_000,
  /** HUD, popups, screen-space overlays — always on top. */
  HUD: 1_000_000_000
} as const;

/**
 * Depth for a world entity at `worldZ`. Nearer (smaller Z) sorts on top, which
 * is the far-to-near painter's order the pseudo-3D projection needs.
 */
export function entityDepth(worldZ: number): number {
  return DEPTH.ENTITY - worldZ;
}
