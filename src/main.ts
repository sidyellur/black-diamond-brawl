import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from './config';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';
import { ResultScene } from './scenes/ResultScene';
import { SpriteLabScene } from './scenes/SpriteLabScene';
import { TitleScene } from './scenes/TitleScene';

const config: Phaser.Types.Core.GameConfig = {
  // WEBGL, not AUTO. postFX/preFX and every FX controller (Bloom, Vignette,
  // ColorMatrix) are WebGL-only — under a Canvas fallback they silently no-op
  // rather than erroring, so the whole visual polish layer would vanish with
  // no indication anything was wrong. Failing to start is better than
  // shipping a silently degraded renderer.
  type: Phaser.WEBGL,
  width: SCREEN_W,
  height: SCREEN_H,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  // Nearest-neighbour sampling, but NOT integer position snapping. The
  // projection scales every world sprite by a continuously-varying
  // non-integer factor, so `roundPixels` cannot make sprites land on a stable
  // pixel grid anyway — and because Graphics objects ignore it entirely, the
  // road would keep sub-pixel positions while the sprites standing on it
  // snapped, making entities visibly swim against the surface at distance.
  // Disabling it keeps sprites and road in the same coordinate space.
  pixelArt: true,
  roundPixels: false,
  scene: [BootScene, TitleScene, RaceScene, ResultScene, SpriteLabScene]
};

const game = new Phaser.Game(config);

// Exposed for the headless verification harness (`scripts/smokeTest.mjs`) so
// it can assert on real runtime state — sprite positions, entity scales —
// rather than only on pixels. Harmless in production; nothing reads it unless
// a test explicitly looks for it.
(window as unknown as { __game: Phaser.Game }).__game = game;
