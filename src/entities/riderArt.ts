import { RIDER, RIVAL_SUITS, mix, shade } from '../render/palette';
import { PixelCanvas } from '../render/pixel';
import { linearGradient, Point, preserveAlphaRim, transformed, VectorPainter } from '../render/vectorArt';

/** Original high-resolution vector-style riders, rendered once at boot. */
export const RIDER_FRAME_SIZE = 192;
export type RiderPose = 'lean-left' | 'center' | 'lean-right' | 'jump' | 'tumble' | 'hit' | 'swing';
export interface RiderPalette { suit: number; board: number }
export const PLAYER_RIDER_PALETTE: RiderPalette = { suit: RIDER.suit, board: RIDER.board };
export const RIVAL_RIDER_PALETTES: RiderPalette[] = RIVAL_SUITS.map((suit, i) => ({
  suit, board: i % 2 === 0 ? RIDER.boardAlt : RIDER.board
}));

interface Skeleton {
  shoulder: Point; hip: Point; head: Point;
  leftArm: Point[]; rightArm: Point[];
  leftLeg: Point[]; rightLeg: Point[];
  board: Point; boardAngle: number; headAngle: number;
}

const INK = 0x13232f;
const PANTS = 0x263747;
const SILVER = 0xb9d2df;

function skeleton(pose: RiderPose): Skeleton {
  const base: Skeleton = {
    shoulder: [102, 87], hip: [92, 126], head: [99, 56],
    leftArm: [[82, 94], [66, 111], [52, 106]],
    rightArm: [[118, 85], [134, 100], [145, 113]],
    leftLeg: [[82, 125], [67, 143], [75, 164]],
    rightLeg: [[102, 124], [123, 136], [119, 156]],
    board: [97, 167], boardAngle: -0.16, headAngle: -0.16
  };
  if (pose === 'lean-left' || pose === 'lean-right') {
    const side = pose === 'lean-left' ? -1 : 1;
    base.shoulder = [97 + side * 22, 87];
    base.hip = [97 + side * 8, 129];
    base.head = [96 + side * 29, 57];
    base.headAngle = side * 0.28;
    base.leftArm = [[base.shoulder[0] - 19, 91], [base.shoulder[0] - 30, 109 + side * 13], [base.shoulder[0] - 41, 117 + side * 18]];
    base.rightArm = [[base.shoulder[0] + 19, 91], [base.shoulder[0] + 31, 109 - side * 13], [base.shoulder[0] + 44, 116 - side * 19]];
    base.leftLeg = [[base.hip[0] - 10, 128], [79 + side * 8, 148], [73 - side * 6, 158]];
    base.rightLeg = [[base.hip[0] + 9, 128], [118 + side * 8, 147], [120 - side * 6, 158]];
    base.board = [97 - side * 5, 164];
    base.boardAngle = side * 0.18;
  } else if (pose === 'jump') {
    base.shoulder = [97, 72]; base.hip = [99, 113]; base.head = [95, 42];
    base.leftArm = [[77, 79], [59, 65], [42, 49]];
    base.rightArm = [[116, 77], [137, 67], [153, 52]];
    base.leftLeg = [[88, 112], [62, 128], [73, 145]];
    base.rightLeg = [[110, 113], [129, 128], [118, 145]];
    base.board = [96, 154]; base.boardAngle = -0.11;
  } else if (pose === 'swing') {
    base.shoulder = [99, 84]; base.head = [98, 53]; base.hip = [96, 128];
    base.leftArm = [[79, 88], [65, 111], [84, 111]];
    base.rightArm = [[117, 84], [140, 76], [166, 73]];
    base.headAngle = 0.09;
  } else if (pose === 'hit') {
    base.shoulder = [76, 85]; base.hip = [102, 128]; base.head = [60, 55];
    base.leftArm = [[60, 90], [40, 76], [26, 57]];
    base.rightArm = [[93, 85], [114, 63], [132, 52]];
    base.headAngle = -0.45; base.board = [105, 164]; base.boardAngle = 0.19;
  } else if (pose === 'tumble') {
    base.shoulder = [75, 130]; base.hip = [110, 143]; base.head = [49, 114];
    base.leftArm = [[66, 145], [47, 159], [30, 158]];
    base.rightArm = [[79, 113], [103, 100], [110, 83]];
    base.leftLeg = [[106, 151], [106, 172], [124, 176]];
    base.rightLeg = [[115, 134], [135, 139], [141, 158]];
    base.board = [149, 116]; base.boardAngle = 1.18; base.headAngle = -0.8;
  }
  return base;
}

/** Pure buffer output keeps the asset lab and contrast gates browser-independent. */
export function drawRider(pose: RiderPose, palette: RiderPalette): PixelCanvas {
  const cv = new PixelCanvas(RIDER_FRAME_SIZE, RIDER_FRAME_SIZE);
  const p = new VectorPainter(cv);
  const s = skeleton(pose);
  drawBoard(p, s.board, s.boardAngle, palette.board, pose === 'tumble' ? 0.68 : 1);
  drawLeg(p, s.rightLeg, false);
  drawLeg(p, s.leftLeg, true);
  drawSleeve(p, s.rightArm, palette.suit, false);
  drawSleeve(p, s.leftArm, palette.suit, true);
  drawJacket(p, s, palette);
  if (pose === 'swing') drawSleeve(p, s.rightArm, palette.suit, true);
  drawHelmet(p, s.head, s.headAngle);
  preserveAlphaRim(cv);
  return cv;
}

function drawBoard(p: VectorPainter, center: Point, angle: number, color: number, scale: number): void {
  const point = (x: number, y: number): Point => transformed([[x * scale, y * scale]], center[0], center[1], angle)[0];
  const shape = (points: Point[]): Point[] => points.map(([x, y]) => point(x, y));
  const outline: Point[] = [[-77, 0], [-70, -7], [-48, -8], [0, -5], [49, -8], [69, -7], [78, -1], [72, 7], [47, 9], [0, 6], [-46, 10], [-68, 8]];
  p.shape(shape(outline.map(([x, y]) => [x, y + 3])), 0x0c202a, INK, 2);
  p.shape(shape(outline), linearGradient(center[0] - 50, center[1] - 12, center[0] + 38, center[1] + 9,
    [mix(color, 0xffffff, 0.65), color, shade(color, 'shadow'), 0x143948]), INK, 2);
  p.stroke(shape([[-68, -4], [-45, -5], [0, -3], [47, -6], [67, -4]]), 1.2, 0xdcf6fa, false, 0.75);
  p.polygon(shape([[-62, -5], [-44, -6], [-30, 8], [-44, 9]]), 0xf4f3e9);
  p.polygon(shape([[-36, -6], [-30, -5], [-15, 7], [-23, 7]]), 0xf0b334);
  p.polygon(shape([[42, -7], [56, -7], [44, 8], [30, 7]]), 0x123041);
  p.polygon(shape([[59, -7], [65, -5], [55, 7], [49, 8]]), 0xe9eff2);
  // Visible steel edge and a pair of binding heel cups.
  p.stroke(shape([[-69, 7], [-42, 9], [0, 6], [46, 8], [70, 6]]), 1.2, SILVER, false, 0.8);
  for (const x of [-24, 24]) {
    p.shape(shape([[x - 9, -9], [x + 7, -9], [x + 10, 3], [x - 10, 4]]), 0x122630, INK, 1.5);
    p.line(point(x - 7, -7), point(x + 6, -7), 2, 0x7b9ba9);
    p.line(point(x - 7, 0), point(x + 7, 0), 2.5, 0x283e4a);
  }
}

function drawLeg(p: VectorPainter, points: Point[], lit: boolean): void {
  const [hip, knee, foot] = points;
  p.stroke(points, 23, INK);
  p.stroke(points, 19, linearGradient(hip[0] - 8, hip[1], foot[0] + 10, foot[1],
    lit ? [0x557184, 0x334d60, PANTS, 0x142632] : [0x395568, PANTS, 0x162b37]));
  p.line([hip[0] - 4, hip[1] + 2], [knee[0] - 5, knee[1] - 1], 2, 0x8da3ad, 0.48);
  p.ellipse(knee[0], knee[1], 8, 7, 0x1d3341);
  p.line([knee[0] - 6, knee[1] - 2], [knee[0] + 5, knee[1] + 1], 1.2, 0x738b9a, 0.7);
  p.line([knee[0] - 6, knee[1] + 4], [knee[0] + 5, knee[1] + 6], 1.2, 0x0f2531);
  const x = foot[0]; const y = foot[1];
  p.shape([[x - 8, y - 8], [x + 6, y - 8], [x + 12, y - 1], [x + 12, y + 5], [x - 11, y + 5], [x - 11, y]],
    linearGradient(x - 5, y - 8, x + 8, y + 5, [0x506877, 0x263b49, 0x142633]), INK, 1.7);
  p.line([x - 8, y + 3], [x + 10, y + 3], 2, 0x9aadb5);
  p.line([x - 5, y - 3], [x + 6, y - 3], 2.5, 0x0f202b);
  p.line([x - 5, y - 3], [x + 5, y - 3], 1, 0xe0af3e);
}

function drawSleeve(p: VectorPainter, points: Point[], color: number, lit: boolean): void {
  const [shoulder, elbow, hand] = points;
  p.stroke(points, 21, INK);
  p.stroke(points, 17, linearGradient(shoulder[0] - 10, shoulder[1] - 13, hand[0] + 9, hand[1] + 7,
    [shade(color, lit ? 'hilite' : 'lit'), color, shade(color, 'core')]));
  p.line([shoulder[0] - 3, shoulder[1] - 3], [elbow[0] - 3, elbow[1] - 4], 2.2, mix(color, 0xffffff, 0.6), 0.6);
  p.line([elbow[0] - 5, elbow[1] + 2], [elbow[0] + 4, elbow[1] + 5], 1.5, shade(color, 'core'), 0.8);
  p.line([elbow[0] - 4, elbow[1] + 6], [elbow[0] + 2, elbow[1] + 8], 1, shade(color, 'lit'));
  const angle = Math.atan2(hand[1] - elbow[1], hand[0] - elbow[0]);
  p.ellipse(hand[0], hand[1], 10, 8.5, INK, angle);
  p.ellipse(hand[0] - 1, hand[1] - 2, 8, 6.5, linearGradient(hand[0] - 4, hand[1] - 6, hand[0] + 6, hand[1] + 7,
    [0x6c7e88, 0x2d414f, 0x122635]), angle);
  p.line([hand[0] - 4, hand[1] - 4], [hand[0] + 4, hand[1] - 2], 1.4, 0xb1c2c6, 0.8);
}

function drawJacket(p: VectorPainter, s: Skeleton, palette: RiderPalette): void {
  const dx = s.hip[0] - s.shoulder[0];
  const dy = s.hip[1] - s.shoulder[1];
  const length = Math.hypot(dx, dy);
  const axis: Point = [dy / length, -dx / length];
  const point = (x: number, y: number): Point => [s.shoulder[0] + dx * y / 44 + axis[0] * x, s.shoulder[1] + dy * y / 44 + axis[1] * x];
  const points = (list: Point[]): Point[] => list.map(([x, y]) => point(x, y));
  const color = palette.suit;
  p.shape(points([[-16, -8], [0, -12], [18, -6], [22, 10], [16, 30], [18, 42], [5, 47], [-13, 44], [-18, 26], [-23, 9]]),
    linearGradient(s.shoulder[0] - 23, s.shoulder[1] - 10, s.hip[0] + 22, s.hip[1] + 4,
      [shade(color, 'hilite'), shade(color, 'lit'), color, shade(color, 'core')]), INK, 2.3);
  // Panel seams, shoulder yoke and lower storm skirt provide material structure.
  p.shape(points([[-18, 0], [-7, -5], [10, -3], [19, 3], [15, 12], [0, 7], [-17, 12]]),
    shade(color, 'shadow'), shade(color, 'core'), 0.7);
  p.stroke(points([[-17, 1], [-5, -3], [9, -1], [17, 4]]), 1.7, mix(color, 0xffffff, 0.7));
  p.polygon(points([[-17, 35], [16, 36], [18, 43], [3, 47], [-13, 44]]), shade(color, 'core'));
  p.stroke(points([[-17, 35], [-2, 37], [16, 36]]), 1.3, mix(color, 0xffffff, 0.4));
  // Rear-view panel construction: shoulder-blade seams and a sewn back badge.
  // A full front zipper or face would make the trailing camera read uphill.
  p.stroke(points([[-17, 10], [-12, 17], [-12, 31]]), 1.3, shade(color, 'core'), false, 0.7);
  p.stroke(points([[17, 10], [12, 18], [12, 31]]), 1.4, shade(color, 'core'), false, 0.8);
  p.stroke(points([[-15, 10], [-11, 16], [-11, 29]]), 0.8, mix(color, 0xffffff, 0.5), false, 0.7);
  p.polygon(points([[1, 11], [9, 21], [1, 31], [-7, 21]]), 0x163440);
  p.polygon(points([[1, 13], [7, 21], [1, 29], [-5, 21]]), 0xe1ece6);
  p.polygon(points([[1, 17], [4, 21], [1, 25], [-2, 21]]), shade(color, 'shadow'));
  p.stroke(points([[-14, 32], [-3, 34], [10, 33]]), 1.6, 0xe9ede4, false, 0.78);
  // Fold highlights/shadows follow the fabric's tension, not a flat stripe.
  p.stroke(points([[-15, 15], [-11, 19], [-7, 20]]), 1.3, shade(color, 'hilite'), false, 0.7);
  p.stroke(points([[8, 27], [14, 31], [8, 32]]), 1.4, shade(color, 'core'), false, 0.7);
  p.stroke(points([[-12, 31], [-7, 33], [-2, 33]]), 1.1, shade(color, 'hilite'), false, 0.6);
  // A padded collar sits in front of the helmet's dark neck gaiter.
  p.shape(points([[-12, -9], [-4, -14], [8, -13], [15, -6], [9, 1], [-6, -1]]),
    linearGradient(s.shoulder[0], s.shoulder[1] - 14, s.shoulder[0], s.shoulder[1] + 2, [shade(color, 'shadow'), 0x132c39]), INK, 1.5);
}

/** Three-quarter rear helmet: the gameplay camera follows behind the rider. */
function drawHelmet(p: VectorPainter, center: Point, angle: number): void {
  const [cx, cy] = center;
  const point = (x: number, y: number): Point => transformed([[x, y]], cx, cy, angle)[0];
  const points = (list: Point[]): Point[] => list.map(([x, y]) => point(x, y));
  // Dark padded nape and neck gaiter, with no camera-facing chin or mouth.
  p.shape(points([[-9, 12], [12, 11], [13, 23], [1, 27], [-10, 22]]),
    linearGradient(cx - 8, cy + 11, cx + 10, cy + 26, [0x59707d, 0x203b4b, 0x112835]), INK, 1.7);
  p.stroke(points([[-7, 19], [1, 22], [9, 19]]), 1.3, 0x7b909b, false, 0.6);
  // Sculpted rear shell, broad crown, tapered lower rim and directional light.
  p.shape(points([[-22, -1], [-18, -15], [-7, -23], [9, -23], [20, -13], [24, 1], [20, 13], [6, 19], [-10, 15], [-20, 8]]),
    linearGradient(cx - 19, cy - 23, cx + 23, cy + 17, [0xffffff, 0xe7edf1, 0xb2c5d0, 0x567386]), INK, 2.4);
  p.shape(points([[-14, -13], [-5, -21], [8, -20], [15, -14], [3, -15], [-6, -10]]), 0xffffff, 0xffffff, 0);
  // Side shell channel and a thinner rear spine emphasise the curved volume.
  p.stroke(points([[9, -20], [15, -11], [18, -1], [17, 12]]), 3.8, 0x627d8e);
  p.stroke(points([[8, -20], [12, -12], [15, -2], [14, 11]]), 1.2, 0xfafcf9);
  p.stroke(points([[-2, -20], [-1, -11], [0, -4]]), 1.1, 0x97afbf, false, 0.8);
  for (const x of [-11, -5, 1]) p.line(point(x, -9), point(x + 1, -5), 2.2, 0x425e70);
  // The goggle strap wraps around the BACK, secured with a raised clasp.
  p.stroke(points([[-21, 1], [-12, 7], [0, 10], [13, 9], [22, 4]]), 6.7, 0x162f3e);
  p.stroke(points([[-20, 0], [-11, 5], [0, 8], [13, 7], [21, 3]]), 1.2, 0x86a5b8, false, 0.8);
  p.shape(points([[-4, 6], [3, 7], [4, 13], [-3, 12]]), 0x0c2634, 0xa6bfcc, 0.8);
  p.line(point(-1, 8), point(0, 11), 1.1, 0xd6e4e8);
  // Only a slim peripheral lens is visible at the far side of the helmet.
  p.shape(points([[-23, -2], [-19, -4], [-16, 0], [-17, 9], [-21, 10], [-24, 6]]), 0x112b3b, INK, 1.3);
  p.shape(points([[-22, 0], [-20, -1], [-18, 1], [-19, 7], [-21, 7]]),
    linearGradient(cx - 24, cy - 1, cx - 16, cy + 9, [0xe0ffff, 0x56d4e1, 0x205275]), 0x70bfcf, 0.4);
  p.line(point(-21, 1), point(-21, 5), 0.9, 0xeaffff);
  // Rear-shell safety decal and lower edge glint remain legible at race scale.
  p.polygon(points([[5, -3], [8, 0], [5, 3], [2, 0]]), 0xf1f5ec);
  p.stroke(points([[-9, 13], [4, 17], [16, 13]]), 1.4, 0xc9dde4, false, 0.9);
}
