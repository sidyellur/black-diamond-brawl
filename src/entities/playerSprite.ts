import Phaser from 'phaser';

export const PLAYER_TEXTURE_KEY = 'player-sheet';
export const PLAYER_FRAME_SIZE = 32;

/**
 * Frame layout of the player sprite sheet (design-spec §5): five 32x32
 * frames in a single row, left to right — lean-left, center, lean-right,
 * jump, tumble. Task 7 reuses this exact layout (palette-swapped) for AI
 * riders, so keep any future edits to this file additive/positional.
 */
export const PLAYER_FRAMES = {
  LEAN_LEFT: 'lean-left',
  CENTER: 'center',
  LEAN_RIGHT: 'lean-right',
  JUMP: 'jump',
  TUMBLE: 'tumble'
} as const;

const FRAME_ORDER = [
  PLAYER_FRAMES.LEAN_LEFT,
  PLAYER_FRAMES.CENTER,
  PLAYER_FRAMES.LEAN_RIGHT,
  PLAYER_FRAMES.JUMP,
  PLAYER_FRAMES.TUMBLE
];

interface RiderPalette {
  suit: number;
  skin: number;
  board: number;
  outline: number;
}

// Placeholder-quality hand-drawn palette (design-spec §5: geometric
// placeholders are explicitly NOT acceptable, but simple pixel-art shapes
// suggesting a snowboarder are fine for v1).
const PLAYER_PALETTE: RiderPalette = {
  suit: 0xd94f4f,
  skin: 0xe8b98a,
  board: 0x2b2b2b,
  outline: 0x1a1a1a
};

/**
 * Procedurally draws the player's placeholder pixel-art sheet and registers
 * it as a Phaser texture with named sub-frames, so callers do
 * `sprite.setFrame(PLAYER_FRAMES.LEAN_LEFT)` etc. Called once from
 * BootScene; safe to call again (no-ops if the texture already exists).
 */
export function generatePlayerSpriteSheet(scene: Phaser.Scene): void {
  generateRiderSpriteSheet(scene, PLAYER_TEXTURE_KEY, PLAYER_PALETTE);
}

// Task 7: AI rival sprite sheets — the exact same frame layout/dimensions as
// the player's, palette-swapped (just the suit color) rather than hand-drawn
// from scratch, per design-spec §4.5's "palette-swapped rider sprites".
export const AI_RIDER_TEXTURE_KEYS = [
  'ai-rider-sheet-0',
  'ai-rider-sheet-1',
  'ai-rider-sheet-2',
  'ai-rider-sheet-3'
] as const;

const AI_RIDER_PALETTES: RiderPalette[] = [
  { ...PLAYER_PALETTE, suit: 0x4f7fd9 }, // blue
  { ...PLAYER_PALETTE, suit: 0x4fd97a }, // green
  { ...PLAYER_PALETTE, suit: 0xb44fd9 }, // purple
  { ...PLAYER_PALETTE, suit: 0xd9a54f } // amber
];

/** Generates all 4 palette-swapped AI rival sheets. Called once from
 *  BootScene alongside `generatePlayerSpriteSheet`; safe to call again. */
export function generateAIRiderSpriteSheets(scene: Phaser.Scene): void {
  AI_RIDER_TEXTURE_KEYS.forEach((key, i) => generateRiderSpriteSheet(scene, key, AI_RIDER_PALETTES[i]));
}

function generateRiderSpriteSheet(scene: Phaser.Scene, textureKey: string, palette: RiderPalette): void {
  if (scene.textures.exists(textureKey)) {
    return;
  }

  const size = PLAYER_FRAME_SIZE;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  FRAME_ORDER.forEach((frame, i) => drawFrame(graphics, frame, i * size, size, palette));

  graphics.generateTexture(textureKey, size * FRAME_ORDER.length, size);
  graphics.destroy();

  const texture = scene.textures.get(textureKey);
  FRAME_ORDER.forEach((frame, i) => texture.add(frame, 0, i * size, 0, size, size));
}

function drawFrame(g: Phaser.GameObjects.Graphics, frame: string, ox: number, size: number, palette: RiderPalette): void {
  const cx = ox + size / 2;
  const cy = size / 2;

  switch (frame) {
    case PLAYER_FRAMES.LEAN_LEFT:
      drawRider(g, cx, cy, -10, palette);
      break;
    case PLAYER_FRAMES.CENTER:
      drawRider(g, cx, cy, 0, palette);
      break;
    case PLAYER_FRAMES.LEAN_RIGHT:
      drawRider(g, cx, cy, 10, palette);
      break;
    case PLAYER_FRAMES.JUMP:
      drawRider(g, cx, cy - 4, 0, palette, true);
      break;
    case PLAYER_FRAMES.TUMBLE:
      drawTumble(g, cx, cy, palette);
      break;
  }
}

/** A simple blocky rider: head, torso, board — torso/head skew by `tilt` for
 *  the lean poses; `airborne` swaps in raised-arm limbs for the jump pose. */
function drawRider(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  tilt: number,
  palette: RiderPalette,
  airborne = false
): void {
  const bodyTop = cy - 10 + (airborne ? -2 : 0);
  const bodyBottom = cy + 4;

  g.fillStyle(palette.board, 1);
  g.fillRect(cx - 9 + tilt * 0.2, cy + 6, 18, 3);

  g.fillStyle(palette.suit, 1);
  g.fillRect(cx - 4 + tilt * 0.3, bodyTop, 8, bodyBottom - bodyTop);

  g.fillStyle(palette.skin, 1);
  g.fillRect(cx - 3 + tilt * 0.4, bodyTop - 6, 6, 6);

  g.lineStyle(1, palette.outline, 1);
  if (airborne) {
    g.lineBetween(cx - 4, bodyTop + 2, cx - 11, bodyTop - 5);
    g.lineBetween(cx + 4, bodyTop + 2, cx + 11, bodyTop - 5);
  } else {
    g.lineBetween(cx + tilt * 0.3 - 4, bodyTop + 3, cx + tilt * 0.6 - 8, bodyTop + 9);
  }
}

/** A crumpled heap suggesting a tumble/wipeout (Task 6's collision handling
 *  triggers this for the player; Task 7 reuses it for a wiped-out rival). */
function drawTumble(g: Phaser.GameObjects.Graphics, cx: number, cy: number, palette: RiderPalette): void {
  g.fillStyle(palette.suit, 1);
  g.fillRect(cx - 6, cy - 5, 12, 11);
  g.fillStyle(palette.board, 1);
  g.fillRect(cx - 9, cy + 3, 16, 3);
  g.fillStyle(palette.skin, 1);
  g.fillRect(cx + 3, cy - 8, 5, 5);
}
