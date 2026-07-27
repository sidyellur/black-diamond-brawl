import { MOGUL, ROCK, SNOW, TREE, mix, shade } from '../render/palette';
import { PixelCanvas, applyRim } from '../render/pixel';

/**
 * Obstacle art.
 *
 * All three sit on snow, which is the brightest surface in the game, so each
 * is built to separate from it by *value* before anything else. Every sprite
 * is drawn to stand on the bottom edge of its frame, so a sprite anchored at
 * origin (0.5, 1) plants its base on the road surface — the existing
 * convention, kept.
 */

export const OBSTACLE_ART_SIZE = 48;

export type ObstacleArtKind = 'tree' | 'rock' | 'mogul';

export function drawObstacle(kind: ObstacleArtKind): PixelCanvas {
  const cv = new PixelCanvas(OBSTACLE_ART_SIZE, OBSTACLE_ART_SIZE);
  switch (kind) {
    case 'tree':
      drawTree(cv);
      break;
    case 'rock':
      drawRock(cv);
      break;
    case 'mogul':
      drawMogul(cv);
      break;
  }
  applyRim(cv, SNOW.packed);
  return cv;
}

/**
 * A snow-laden conifer. Built from overlapping tiers rather than one triangle:
 * each tier casts a shadow onto the one below, which is what gives the tree
 * depth instead of reading as a flat green wedge.
 */
function drawTree(cv: PixelCanvas): void {
  const cx = 24;
  const base = 46;

  // Trunk.
  cv.rect(cx - 2, base - 9, 4, 9, TREE.trunk);
  cv.rect(cx - 2, base - 9, 1, 9, shade(TREE.trunk, 'lit'));
  cv.rect(cx + 1, base - 9, 1, 9, shade(TREE.trunk, 'shadow'));

  // Four tiers, widest at the bottom, each one shorter than the last.
  const tiers = [
    { y: base - 7, halfW: 15, h: 11 },
    { y: base - 15, halfW: 12, h: 10 },
    { y: base - 23, halfW: 9, h: 9 },
    { y: base - 30, halfW: 6, h: 8 }
  ];

  for (const t of tiers) {
    // Shadowed underside first, then the lit body inset above it — the pair is
    // what reads as an overhanging branch.
    cv.triangle(cx, t.y - t.h, cx - t.halfW, t.y, cx + t.halfW, t.y, TREE.foliageDeep);
    cv.triangle(cx, t.y - t.h + 1, cx - t.halfW + 2, t.y - 2, cx + t.halfW - 2, t.y - 2, TREE.foliage);
    // Sunward edge catches light.
    cv.triangle(cx, t.y - t.h + 1, cx - t.halfW + 2, t.y - 2, cx - 1, t.y - 3, shade(TREE.foliage, 'lit'));
    // Snow settles on the upper surface of each tier.
    cv.line(cx - t.halfW + 3, t.y - 2, cx - 1, t.y - t.h + 3, TREE.snowLoad, 1);
    cv.set(cx + 1, t.y - t.h + 3, mix(TREE.snowLoad, TREE.foliage, 0.3));
  }

  // Capped tip.
  cv.set(cx, base - 39, TREE.snowLoad);
  cv.set(cx, base - 38, TREE.snowLoad);
}

/**
 * A boulder. Faceted rather than smooth — angular planes catching light at
 * different angles is what distinguishes rock from a grey blob, and each facet
 * is a flat tone so the shape stays readable when scaled down.
 */
function drawRock(cv: PixelCanvas): void {
  const cx = 24;
  const base = 46;

  const body = ROCK.body;
  const lit = shade(body, 'lit');
  const hilite = shade(body, 'hilite');
  const dark = shade(body, 'shadow');
  const core = shade(body, 'core');

  // Bulk.
  cv.ellipse(cx, base - 7, 15, 8, dark);
  cv.triangle(cx - 15, base - 6, cx + 15, base - 6, cx - 3, base - 22, body);
  cv.triangle(cx + 15, base - 6, cx - 3, base - 22, cx + 11, base - 17, body);

  // Sunward facets.
  cv.triangle(cx - 3, base - 22, cx - 12, base - 8, cx - 1, base - 11, lit);
  cv.triangle(cx - 3, base - 22, cx - 1, base - 11, cx + 5, base - 16, hilite);

  // Shaded right flank.
  cv.triangle(cx + 11, base - 17, cx + 15, base - 6, cx + 4, base - 8, core);

  // Cracks, as single dark pixels following a facet edge.
  cv.line(cx - 2, base - 20, cx + 1, base - 12, core, 1);
  cv.line(cx + 1, base - 12, cx - 3, base - 8, core, 1);

  // Snow caught on the upper ledges.
  cv.line(cx - 10, base - 9, cx - 5, base - 12, SNOW.packed, 1);
  cv.set(cx + 7, base - 15, SNOW.packed);
}

/**
 * A mogul — a packed snow bump.
 *
 * This one is the reason the palette gate exists. Previously it was a
 * near-white ellipse on near-white snow at ΔL* 2.5: an unavoidable hazard,
 * costing 25% speed, that the player could not see coming.
 *
 * The fix is not "make it brighter" — a bump on snow is not brighter than the
 * snow around it. It reads by the shadow it casts and by the shaded lee slope
 * facing away from the sun. So it is built from the shadow up: a cast shadow
 * on the ground, a dark lee face, and only a thin lit crown.
 */
function drawMogul(cv: PixelCanvas): void {
  const cx = 24;
  const base = 46;

  // Cast shadow on the snow, offset away from the sun. This is doing most of
  // the legibility work.
  cv.ellipse(cx + 3, base - 3, 19, 5, mix(SNOW.shadow, SNOW.packed, 0.25), 235);

  // The lee (shaded) face — the mass of the bump.
  cv.ellipse(cx, base - 7, 17, 8, MOGUL.lee);
  cv.ellipse(cx + 4, base - 6, 13, 6, shade(MOGUL.lee, 'shadow'));

  // Lit crown, kept deliberately small: a big bright cap would wash back into
  // the snow and undo the separation.
  cv.ellipse(cx - 3, base - 10, 10, 4, mix(MOGUL.lee, MOGUL.crest, 0.75));
  cv.ellipse(cx - 4, base - 11, 6, 2, MOGUL.crest);

  // Scoured ridges on the windward side, as value pairs rather than colour
  // noise — a couple of light/dark line pairs read as packed snow texture.
  cv.line(cx - 12, base - 6, cx - 6, base - 9, shade(MOGUL.lee, 'core'), 1);
  cv.line(cx - 11, base - 5, cx - 5, base - 8, MOGUL.crest, 1);
  cv.line(cx + 6, base - 9, cx + 12, base - 6, shade(MOGUL.lee, 'core'), 1);
}
