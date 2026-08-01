import { RIDER, RIVAL_SUITS, SNOW, mix, shade } from '../render/palette';
import { PixelCanvas, applyRim } from '../render/pixel';

/**
 * Draws a snowboarder into a pixel buffer.
 *
 * Built around three rules that separate shaded art from flat shapes:
 *
 *   1. **Every material gets at least three tones** — a lit face, a base, and
 *      a shadow — all derived from one base colour through the shared `shade()`
 *      ramp, so the whole pack is lit by the same sun.
 *   2. **Structure lives in value, not hue.** Form is described by light/dark
 *      pairs rather than by colour noise, which reads as dirt at this size.
 *   3. **Silhouette first.** The pose is built so the black shape alone reads
 *      as a person on a board: board wider than the body, arms clear of the
 *      torso, head separated from the shoulders by a neck gap.
 *
 * Frames are 48x48. Bigger than the old 32x32 not for "more detail" but for
 * the silhouette: a helmet, a shoulder line and a board edge cannot all be
 * distinguished inside 32px once the projection scales the sprite down.
 */

export const RIDER_FRAME_SIZE = 48;

export type RiderPose = 'lean-left' | 'center' | 'lean-right' | 'jump' | 'tumble' | 'hit' | 'swing';

export interface RiderPalette {
  suit: number;
  board: number;
}

export const PLAYER_RIDER_PALETTE: RiderPalette = {
  suit: RIDER.suit,
  board: RIDER.board
};

export const RIVAL_RIDER_PALETTES: RiderPalette[] = RIVAL_SUITS.map((suit, i) => ({
  suit,
  // Alternating board colours give the rivals a second distinguishing cue
  // beyond suit hue, which matters when they are small on screen.
  board: i % 2 === 0 ? RIDER.boardAlt : RIDER.board
}));

/** Draws one pose and returns the finished buffer, rim included. */
export function drawRider(pose: RiderPose, palette: RiderPalette): PixelCanvas {
  const cv = new PixelCanvas(RIDER_FRAME_SIZE, RIDER_FRAME_SIZE);
  if (pose === 'tumble') {
    drawTumble(cv, palette);
  } else if (pose === 'hit') {
    drawHit(cv, palette);
  } else if (pose === 'swing') {
    drawSwing(cv, palette);
  } else {
    const lean = pose === 'lean-left' ? -1 : pose === 'lean-right' ? 1 : 0;
    drawUpright(cv, palette, lean, pose === 'jump');
  }
  applyRim(cv, SNOW.packed);
  return cv;
}

function drawUpright(cv: PixelCanvas, pal: RiderPalette, lean: -1 | 0 | 1, airborne: boolean): void {
  const cx = 24;
  // Airborne riders tuck up; the board comes with them.
  const baseY = airborne ? 36 : 42;

  drawBoard(cv, cx, baseY, lean, pal);

  // A carving rider angles hard into the turn. The old sheet moved the torso
  // by 2-4px between lean frames, which made all three poses effectively
  // identical; the lean has to be a real change of shape — the body crosses
  // over the board, the shoulders drop, and the board foreshortens onto its
  // edge — or the sprite reads as static however fast the rider is turning.
  const tilt = lean * 6;
  const hipY = baseY - 9;
  // Shoulders drop into the turn as well as shifting across.
  const shoulderY = hipY - 11 + Math.abs(lean);

  drawLegs(cv, cx, hipY, baseY, tilt, airborne);
  drawTorso(cv, cx + tilt, shoulderY, hipY, pal);
  drawArms(cv, cx + tilt, shoulderY, lean, airborne, pal);
  drawHead(cv, cx + Math.round(tilt * 1.3), shoulderY - 3);
}

/**
 * The board. Drawn as a flattened ellipse rather than a bar so it reads as a
 * shaped deck, with a lit top edge and a dark underside — the value pair is
 * what makes it look like it has thickness.
 */
function drawBoard(
  cv: PixelCanvas,
  cx: number,
  y: number,
  lean: -1 | 0 | 1,
  pal: RiderPalette
): void {
  // Carving tips the board onto its edge, so it foreshortens across and gets
  // *thicker* in profile — you start seeing the sidewall rather than the deck.
  const halfW = lean === 0 ? 15 : 11;
  const thickness = lean === 0 ? 3 : 4;
  const bx = cx - lean * 3;

  cv.ellipse(bx, y, halfW, thickness, shade(pal.board, 'shadow'));
  cv.ellipse(bx, y - 1, halfW, thickness - 1, pal.board);

  if (lean === 0) {
    cv.ellipse(bx, y - 2, halfW - 3, 1, shade(pal.board, 'hilite'));
  } else {
    // Raised edge catches the light along its whole length.
    const edgeX = bx + lean * (halfW - 2);
    cv.line(bx - lean * halfW, y - 1, edgeX, y - 4, shade(pal.board, 'hilite'), 1);
  }

  // Bindings, riding with the board.
  cv.rect(bx - 5, y - 3, 4, 2, shade(RIDER.boot, 'base'));
  cv.rect(bx + 2, y - 3, 4, 2, shade(RIDER.boot, 'base'));
}

function drawLegs(
  cv: PixelCanvas,
  cx: number,
  hipY: number,
  boardY: number,
  tilt: number,
  airborne: boolean
): void {
  const lit = shade(RIDER.pants, 'lit');
  const base = RIDER.pants;
  const dark = shade(RIDER.pants, 'shadow');

  // Knees bend more when airborne (a tuck).
  const kneeY = airborne ? hipY + 3 : hipY + 4;
  // Feet stay with the board while the hips move across, so the legs angle —
  // that diagonal is most of what reads as a carve.
  const footShift = -Math.round(tilt * 0.5);
  const legs: Array<[number, number]> = [
    [cx - 4 + tilt, cx - 5 + footShift],
    [cx + 3 + tilt, cx + 4 + footShift]
  ];

  for (const [topX, footX] of legs) {
    // Thigh.
    cv.rect(topX, hipY, 4, kneeY - hipY + 1, base);
    cv.rect(topX, hipY, 1, kneeY - hipY + 1, lit);
    // Shin down to the board.
    const shinH = boardY - 3 - kneeY;
    if (shinH > 0) {
      cv.rect(footX, kneeY, 4, shinH, base);
      cv.rect(footX, kneeY, 1, shinH, lit);
      cv.rect(footX + 3, kneeY, 1, shinH, dark);
    }
    // Boot.
    cv.rect(footX - 1, boardY - 4, 5, 2, RIDER.boot);
  }
}

function drawTorso(cv: PixelCanvas, cx: number, shoulderY: number, hipY: number, pal: RiderPalette): void {
  const h = hipY - shoulderY;
  const lit = shade(pal.suit, 'lit');
  const base = pal.suit;
  const dark = shade(pal.suit, 'shadow');

  // Torso tapers to the waist — a straight rectangle reads as a box.
  for (let i = 0; i < h; i++) {
    const t = i / Math.max(1, h - 1);
    const halfW = Math.round(6 - t * 1.5);
    cv.rect(cx - halfW, shoulderY + i, halfW * 2, 1, base);
    cv.rect(cx - halfW, shoulderY + i, 2, 1, lit);
    cv.rect(cx + halfW - 2, shoulderY + i, 2, 1, dark);
  }

  // A chest stripe breaks the mass up and gives each rival a readable marking.
  cv.rect(cx - 5, shoulderY + Math.floor(h * 0.45), 10, 2, mix(pal.suit, 0xffffff, 0.55));
  // Collar.
  cv.rect(cx - 4, shoulderY, 8, 1, shade(pal.suit, 'core'));
}

function drawArms(
  cv: PixelCanvas,
  cx: number,
  shoulderY: number,
  lean: -1 | 0 | 1,
  airborne: boolean,
  pal: RiderPalette
): void {
  const base = pal.suit;
  const dark = shade(pal.suit, 'shadow');

  // Arms are held out for balance — and, more practically, they are what makes
  // the silhouette read as a snowboarder rather than a standing figure.
  const spread = airborne ? 12 : 10;
  const dropL = airborne ? -4 : lean < 0 ? -2 : 4;
  const dropR = airborne ? -4 : lean > 0 ? -2 : 4;

  cv.line(cx - 5, shoulderY + 2, cx - spread, shoulderY + 2 + dropL, base, 2);
  cv.line(cx + 5, shoulderY + 2, cx + spread, shoulderY + 2 + dropR, dark, 2);

  // Gloves.
  cv.rect(cx - spread - 1, shoulderY + 1 + dropL, 3, 3, RIDER.glove);
  cv.rect(cx + spread - 1, shoulderY + 1 + dropR, 3, 3, RIDER.glove);
}

function drawHead(cv: PixelCanvas, cx: number, y: number): void {
  // Helmet: a dome with a lit crown, not a square.
  cv.ellipse(cx, y - 2, 5, 5, RIDER.helmet);
  cv.ellipse(cx - 1, y - 3, 3, 3, shade(RIDER.helmet, 'hilite'));
  cv.ellipse(cx + 2, y - 1, 3, 3, shade(RIDER.helmet, 'shadow'));

  // Goggles across the brow — the single most recognisable snowboarding cue,
  // and the reason the head reads as a head at small sizes.
  cv.rect(cx - 5, y, 10, 3, RIDER.goggle);
  cv.rect(cx - 4, y, 3, 1, RIDER.goggleGlint);
  cv.rect(cx - 5, y + 3, 10, 1, shade(RIDER.goggle, 'core'));

  // A sliver of face below the goggles.
  cv.rect(cx - 3, y + 4, 6, 2, RIDER.skin);
}

/**
 * Recoil: struck, but still on the board.
 *
 * This has to be readable in a quarter-second, against snow, at ~40px, and —
 * hardest — it must not be confusable with `tumble` (which is a crash) or with
 * a lean (which is a voluntary turn). Before this frame existed, a rival you
 * shoved rendered with the *same* lean pose as one calmly changing lanes, so
 * landing a hit and watching someone dodge looked identical.
 *
 * Three things separate it. The torso jackknifes away from the impact rather
 * than angling into a carve. The head snaps back past the shoulders, which no
 * other pose does. And both arms fly up and outward — the opposite of the
 * controlled balance spread — which is what makes the silhouette read as
 * "lost control" instead of "turning".
 */
function drawHit(cv: PixelCanvas, pal: RiderPalette): void {
  const cx = 24;
  const baseY = 42;

  // Board skids out from under the rider, still flat but shoved sideways.
  drawBoard(cv, cx + 4, baseY, 1, pal);

  // Torso thrown back over the tail of the board.
  const hipY = baseY - 8;
  const shoulderY = hipY - 10;
  const tilt = -7;

  drawLegs(cv, cx + 3, hipY, baseY, 2, false);

  const lit = shade(pal.suit, 'lit');
  const dark = shade(pal.suit, 'shadow');
  const h = hipY - shoulderY;
  for (let i = 0; i < h; i++) {
    const t = i / Math.max(1, h - 1);
    const halfW = Math.round(6 - t * 1.5);
    // Each row shifts further back up the body — a jackknife, not a lean.
    const x = cx + tilt + Math.round(t * 5);
    cv.rect(x - halfW, shoulderY + i, halfW * 2, 1, pal.suit);
    cv.rect(x - halfW, shoulderY + i, 2, 1, lit);
    cv.rect(x + halfW - 2, shoulderY + i, 2, 1, dark);
  }

  // Arms flung up and out, both sides — reads as flailing, never as balance.
  cv.line(cx + tilt - 4, shoulderY + 2, cx + tilt - 13, shoulderY - 6, pal.suit, 2);
  cv.line(cx + tilt + 4, shoulderY + 2, cx + tilt + 12, shoulderY - 7, dark, 2);
  cv.rect(cx + tilt - 15, shoulderY - 8, 3, 3, RIDER.glove);
  cv.rect(cx + tilt + 11, shoulderY - 9, 3, 3, RIDER.glove);

  // Head snapped back past the shoulder line.
  drawHead(cv, cx + tilt - 4, shoulderY - 2);

  // Spray kicked up by the board losing its edge.
  cv.ellipse(cx + 10, baseY + 1, 9, 2, mix(SNOW.packed, SNOW.shadow, 0.3), 190);
}

/**
 * Mid-swing: the attack pose.
 *
 * Shown on the attacker for the duration of the swing lock, so committing to
 * an attack is visible on your own rider rather than being an invisible state
 * you infer from a cooldown. The lead arm drives across the body — a long
 * horizontal line no other pose has, which is what makes it readable at speed.
 */
function drawSwing(cv: PixelCanvas, pal: RiderPalette): void {
  const cx = 24;
  const baseY = 42;

  drawBoard(cv, cx, baseY, 0, pal);

  const hipY = baseY - 9;
  const shoulderY = hipY - 11;

  drawLegs(cv, cx, hipY, baseY, 0, false);
  // Shoulders rotate into the swing.
  drawTorso(cv, cx + 2, shoulderY, hipY, pal);

  const dark = shade(pal.suit, 'shadow');

  // Trailing arm tucked in for the counter-rotation.
  cv.line(cx - 2, shoulderY + 3, cx - 8, shoulderY + 7, dark, 2);
  cv.rect(cx - 10, shoulderY + 6, 3, 3, RIDER.glove);

  // Lead arm extended hard across — the read.
  cv.line(cx + 4, shoulderY + 2, cx + 16, shoulderY + 1, pal.suit, 3);
  cv.rect(cx + 15, shoulderY - 1, 4, 4, RIDER.glove);

  drawHead(cv, cx + 3, shoulderY - 3);
}

/** A crumpled heap, mid-wipeout. Reads as "person, not upright" in
 *  silhouette — the board thrown clear is most of what communicates it. */
function drawTumble(cv: PixelCanvas, pal: RiderPalette): void {
  const cx = 24;
  const y = 40;

  // Board flipped up on its edge, away from the body.
  cv.ellipse(cx + 10, y - 8, 3, 10, shade(pal.board, 'shadow'));
  cv.ellipse(cx + 10, y - 8, 2, 9, pal.board);

  // Body folded over.
  cv.ellipse(cx - 3, y - 5, 8, 6, pal.suit);
  cv.ellipse(cx - 5, y - 7, 5, 3, shade(pal.suit, 'lit'));
  cv.ellipse(cx - 1, y - 3, 6, 4, shade(pal.suit, 'shadow'));

  // Legs kicked out.
  cv.line(cx + 2, y - 3, cx + 9, y + 1, RIDER.pants, 3);
  cv.line(cx - 6, y - 1, cx - 11, y + 2, RIDER.pants, 3);
  cv.rect(cx + 8, y, 4, 2, RIDER.boot);

  // Head down and forward.
  cv.ellipse(cx - 9, y - 9, 4, 4, RIDER.helmet);
  cv.rect(cx - 12, y - 9, 7, 2, RIDER.goggle);

  // Snow spray kicked up by the crash.
  cv.ellipse(cx + 1, y + 2, 13, 3, mix(SNOW.packed, SNOW.shadow, 0.25), 200);
}
