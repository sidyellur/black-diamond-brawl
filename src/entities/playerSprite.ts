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

// Placeholder-quality hand-drawn palette (design-spec §5: geometric
// placeholders are explicitly NOT acceptable, but simple pixel-art shapes
// suggesting a snowboarder are fine for v1).
const SUIT_COLOR = 0xd94f4f;
const SKIN_COLOR = 0xe8b98a;
const BOARD_COLOR = 0x2b2b2b;
const OUTLINE_COLOR = 0x1a1a1a;

/**
 * Procedurally draws the player's placeholder pixel-art sheet and registers
 * it as a Phaser texture with named sub-frames, so callers do
 * `sprite.setFrame(PLAYER_FRAMES.LEAN_LEFT)` etc. Called once from
 * BootScene; safe to call again (no-ops if the texture already exists).
 */
export function generatePlayerSpriteSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(PLAYER_TEXTURE_KEY)) {
    return;
  }

  const size = PLAYER_FRAME_SIZE;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  FRAME_ORDER.forEach((frame, i) => drawFrame(graphics, frame, i * size, size));

  graphics.generateTexture(PLAYER_TEXTURE_KEY, size * FRAME_ORDER.length, size);
  graphics.destroy();

  const texture = scene.textures.get(PLAYER_TEXTURE_KEY);
  FRAME_ORDER.forEach((frame, i) => texture.add(frame, 0, i * size, 0, size, size));
}

function drawFrame(g: Phaser.GameObjects.Graphics, frame: string, ox: number, size: number): void {
  const cx = ox + size / 2;
  const cy = size / 2;

  switch (frame) {
    case PLAYER_FRAMES.LEAN_LEFT:
      drawRider(g, cx, cy, -10);
      break;
    case PLAYER_FRAMES.CENTER:
      drawRider(g, cx, cy, 0);
      break;
    case PLAYER_FRAMES.LEAN_RIGHT:
      drawRider(g, cx, cy, 10);
      break;
    case PLAYER_FRAMES.JUMP:
      drawRider(g, cx, cy - 4, 0, true);
      break;
    case PLAYER_FRAMES.TUMBLE:
      drawTumble(g, cx, cy);
      break;
  }
}

/** A simple blocky rider: head, torso, board — torso/head skew by `tilt` for
 *  the lean poses; `airborne` swaps in raised-arm limbs for the jump pose. */
function drawRider(g: Phaser.GameObjects.Graphics, cx: number, cy: number, tilt: number, airborne = false): void {
  const bodyTop = cy - 10 + (airborne ? -2 : 0);
  const bodyBottom = cy + 4;

  g.fillStyle(BOARD_COLOR, 1);
  g.fillRect(cx - 9 + tilt * 0.2, cy + 6, 18, 3);

  g.fillStyle(SUIT_COLOR, 1);
  g.fillRect(cx - 4 + tilt * 0.3, bodyTop, 8, bodyBottom - bodyTop);

  g.fillStyle(SKIN_COLOR, 1);
  g.fillRect(cx - 3 + tilt * 0.4, bodyTop - 6, 6, 6);

  g.lineStyle(1, OUTLINE_COLOR, 1);
  if (airborne) {
    g.lineBetween(cx - 4, bodyTop + 2, cx - 11, bodyTop - 5);
    g.lineBetween(cx + 4, bodyTop + 2, cx + 11, bodyTop - 5);
  } else {
    g.lineBetween(cx + tilt * 0.3 - 4, bodyTop + 3, cx + tilt * 0.6 - 8, bodyTop + 9);
  }
}

/** A crumpled heap suggesting a tumble/wipeout (reserved for Task 6's
 *  collision handling — not yet triggered by anything in this task). */
function drawTumble(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
  g.fillStyle(SUIT_COLOR, 1);
  g.fillRect(cx - 6, cy - 5, 12, 11);
  g.fillStyle(BOARD_COLOR, 1);
  g.fillRect(cx - 9, cy + 3, 16, 3);
  g.fillStyle(SKIN_COLOR, 1);
  g.fillRect(cx + 3, cy - 8, 5, 5);
}
