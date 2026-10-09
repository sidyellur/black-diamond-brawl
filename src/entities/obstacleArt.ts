import { MOGUL, ROCK, SNOW, TREE, mix, rim, shade } from '../render/palette';
import { PixelCanvas } from '../render/pixel';
import { Point, VectorPainter, preserveAlphaRim, linearGradient } from '../render/vectorArt';

/** Original high-resolution, antialiased alpine illustrations. Their shading
 * and silhouettes are authored at this resolution, never scaled-up pixel art.
 * Every subject still plants its base at the bottom of a square frame. */
export const OBSTACLE_ART_SIZE = 192;
export type ObstacleArtKind = 'tree' | 'rock' | 'mogul';

export function drawObstacle(kind: ObstacleArtKind, variant = 0): PixelCanvas {
  const canvas = new PixelCanvas(OBSTACLE_ART_SIZE, OBSTACLE_ART_SIZE);
  // Paint with breathing room before positioning the grounded frame; curved
  // strokes can extend beyond their final control point by a couple pixels.
  const drawing = new PixelCanvas(OBSTACLE_ART_SIZE, OBSTACLE_ART_SIZE + 4);
  const painter = new VectorPainter(drawing);
  if (kind === 'tree') drawTree(painter, ((variant % 3) + 3) % 3);
  else if (kind === 'rock') drawRock(painter);
  else drawMogul(painter);
  canvas.blit(drawing, 0, -4);
  preserveAlphaRim(canvas, SNOW.packed);
  return canvas;
}

function drawTree(p: VectorPainter, variant: number): void {
  const outline = rim(TREE.foliage);
  // Tapered bark, lit on the left. The trunk remains visible beneath the
  // branches, which makes this read as an actual tree rather than a cone.
  p.shape([[88, 180], [92, 124], [99, 116], [106, 141], [110, 181]],
    linearGradient(88, 157, 110, 161, [shade(TREE.trunk, 'lit'), TREE.trunk, shade(TREE.trunk, 'core')]),
    rim(TREE.trunk), 2.5);
  p.stroke([[97, 142], [95, 166], [97, 184]], 1.7, shade(TREE.trunk, 'hilite'), false, 0.7);

  // Asymmetric drooping branch whorls. Curved lobes, broken shelves of snow,
  // and a shaded underside replace the old stack of identical triangles.
  const variants = [
    [[94, 165, 75, 55], [98, 139, 64, 51], [94, 116, 52, 47],
      [99, 91, 40, 41], [98, 67, 28, 35], [101, 43, 15, 31]],
    [[97, 166, 67, 60], [92, 140, 57, 53], [98, 114, 43, 49],
      [95, 89, 35, 44], [100, 65, 23, 38], [101, 40, 12, 29]],
    [[93, 165, 77, 45], [99, 145, 66, 45], [92, 125, 58, 44],
      [99, 103, 42, 39], [97, 82, 31, 38], [99, 60, 18, 35]]
  ];
  const tiers = variants[variant];
  tiers.forEach(([x, y, w, h], index) => {
    const left = w * ((index + variant) % 4 === 2 ? 0.72 : (index + variant) % 2 ? 1 : 0.9);
    const right = w * ((index + variant) % 2 ? 0.79 : 1);
    const leftDroop = index % 3 === 0 ? 3 : -2;
    const rightDroop = index % 3 === 1 ? 6 : 0;
    const canopy: Point[] = [
      [x + 2, y - h], [x - left * 0.23, y - h * 0.61],
      [x - left * 0.60, y - h * 0.23], [x - left, y + 1 + leftDroop],
      [x - left * 0.76, y + 8], [x - left * 0.46, y + 3],
      [x - left * 0.25, y + 11], [x - left * 0.02, y + 3],
      [x + right * 0.26, y + 10], [x + right * 0.49, y + 3],
      [x + right * 0.92, y + 5 + rightDroop], [x + right * 0.71, y - h * 0.27],
      [x + right * 0.30, y - h * 0.63]
    ];
    p.shape(canopy,
      linearGradient(x - left * 0.45, y - h, x + right * 0.6, y + 9,
        [shade(TREE.foliage, 'lit'), TREE.foliage, TREE.foliageDeep]), outline, 2.4);
    p.stroke([[x - left * 0.75, y + 1], [x - left * 0.35, y - 3], [x + 1, y - 20]],
      1.5, shade(TREE.foliage, 'lit'), false, 0.65);
    p.stroke([[x + right * 0.69, y + 2], [x + right * 0.32, y - 8], [x + 1, y - 24]],
      1.6, TREE.foliageDeep, false, 0.8);

    const snowDepth = Math.min(22, h * 0.44);
    const shelf: Point[] = [
      [x - left * 0.85, y - 3 + leftDroop], [x - left * 0.67, y - 13 + leftDroop],
      [x - left * 0.35, y - snowDepth - 3], [x - 3, y - snowDepth - 9],
      [x - left * 0.09, y - snowDepth + 2], [x - left * 0.30, y - 8 + leftDroop],
      [x - left * 0.46, y - 4 + leftDroop], [x - left * 0.65, y + 1 + leftDroop]
    ];
    p.shape(shelf, linearGradient(x, y - snowDepth, x + 12, y + 6,
      [TREE.snowLoad, SNOW.packed, mix(SNOW.shadow, TREE.snowLoad, 0.48)]),
      rim(SNOW.shadow), 2.6);
    // Separate lee-side patches leave a dark gap through the centre. Broken
    // shelves and unequal droop are what make these natural branches instead
    // of a symmetric decorated Christmas-tree icon.
    if ((index + variant) % 4 !== 2) {
      p.shape([[x + right * 0.16, y - snowDepth + 2],
        [x + right * 0.39, y - snowDepth * 0.5], [x + right * 0.79, y + rightDroop],
        [x + right * 0.68, y + 5 + rightDroop], [x + right * 0.49, y + 3 + rightDroop],
        [x + right * 0.29, y - 1 + rightDroop]],
      linearGradient(x, y - snowDepth, x + right, y + 9,
        [SNOW.packed, SNOW.offPiste]), rim(SNOW.shadow), 2.6);
    }
    // A few long needles on the exposed underside, not high-frequency noise.
    if (index < 3) {
      p.line([x - left * 0.60, y + 3], [x - left * 0.63, y + 10], 1.4, TREE.foliageDeep);
      p.line([x + right * 0.47, y + 3], [x + right * 0.51, y + 9], 1.4, TREE.foliageDeep);
    }
  });
  const tipY = variant === 2 ? 21 : 7;
  p.shape([[98, tipY + 13], [102, tipY], [106, tipY + 16], [102, tipY + 20]],
    TREE.snowLoad, outline, 2.6);
  p.shape([[84, 186], [93, 181], [104, 183], [114, 188], [105, 190], [87, 190]],
    linearGradient(90, 181, 108, 190, [SNOW.packed, SNOW.shadow]), rim(SNOW.shadow), 2.6);
}

function drawRock(p: VectorPainter): void {
  const edge = rim(ROCK.body);
  p.shape([[18, 176], [29, 139], [49, 110], [86, 92], [134, 102], [165, 129],
    [179, 169], [161, 184], [114, 190], [58, 187], [27, 185]],
  linearGradient(56, 95, 141, 185, [shade(ROCK.body, 'lit'), ROCK.body, shade(ROCK.body, 'core')]), edge, 3.2);
  p.polygon([[29, 140], [49, 111], [86, 94], [77, 143], [35, 173]],
    linearGradient(48, 107, 72, 167, [shade(ROCK.body, 'hilite'), shade(ROCK.body, 'lit'), ROCK.body]));
  p.polygon([[77, 143], [86, 94], [134, 103], [139, 150], [104, 179]],
    linearGradient(82, 105, 127, 175, [shade(ROCK.body, 'lit'), ROCK.body, shade(ROCK.body, 'shadow')]));
  p.polygon([[139, 150], [134, 104], [163, 129], [176, 168], [156, 182], [104, 179]],
    linearGradient(139, 131, 169, 186, [ROCK.wet, shade(ROCK.body, 'shadow'), shade(ROCK.body, 'core')]));
  p.polygon([[35, 173], [77, 143], [104, 179], [155, 182], [113, 188], [58, 184]],
    shade(ROCK.body, 'shadow'));
  p.stroke([[87, 104], [80, 137], [91, 154], [82, 162]], 1.8, shade(ROCK.body, 'core'));
  p.stroke([[139, 150], [150, 158], [157, 176]], 1.6, shade(ROCK.body, 'core'));
  // Snow gathers in ledges, leaving the dangerous rock silhouette readable.
  p.shape([[47, 113], [68, 97], [86, 93], [108, 97], [135, 104], [139, 111],
    [120, 115], [110, 110], [96, 119], [86, 112], [68, 119], [56, 115]],
  linearGradient(72, 98, 100, 122, [SNOW.packed, SNOW.offPiste]), mix(ROCK.body, SNOW.shadow, 0.5), 1.3);
  p.shape([[29, 161], [46, 152], [62, 151], [54, 159], [36, 167]],
    linearGradient(32, 151, 53, 166, [SNOW.packed, SNOW.offPiste]), ROCK.wet, 1);
  p.line([53, 130], [66, 124], 1.5, shade(ROCK.body, 'hilite'), 0.75);
  p.ellipse(118, 142, 3, 1.4, shade(ROCK.body, 'hilite'), -0.4, 0.6);
}

function drawMogul(p: VectorPainter): void {
  // A sweeping lee face does the legibility work. Only the narrow windward
  // lip is near-white, so this never washes into the piste beneath it.
  p.shape([[8, 183], [23, 169], [44, 151], [65, 133], [85, 125], [105, 132],
    [126, 153], [154, 171], [181, 180], [174, 188], [103, 191], [41, 188]],
  linearGradient(65, 124, 126, 190, [mix(MOGUL.crest, MOGUL.lee, 0.34), MOGUL.lee, shade(MOGUL.lee, 'shadow')]),
  rim(MOGUL.lee), 2.5);
  p.shape([[86, 135], [105, 135], [126, 155], [151, 171], [177, 181],
    [142, 184], [118, 178], [106, 160]],
  linearGradient(92, 137, 151, 188, [MOGUL.lee, shade(MOGUL.lee, 'shadow')]), MOGUL.lee, 0);
  p.shape([[27, 168], [50, 148], [69, 132], [85, 128], [101, 136],
    [86, 135], [70, 140], [49, 157], [34, 170]],
  linearGradient(63, 129, 66, 165, [MOGUL.crest, SNOW.packed, MOGUL.lee]), MOGUL.lee, 0);
  p.stroke([[111, 149], [120, 166], [143, 178]], 1.9, shade(MOGUL.lee, 'shadow'), false, 0.65);
  p.stroke([[33, 176], [55, 163], [65, 151]], 1.3, MOGUL.crest, false, 0.75);
  p.stroke([[43, 182], [66, 171], [79, 153]], 1.2, mix(MOGUL.lee, MOGUL.crest, 0.5), false, 0.6);
}
