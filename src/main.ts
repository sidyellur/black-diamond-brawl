import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from './config';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';
import { ResultScene } from './scenes/ResultScene';
import { SpriteLabScene } from './scenes/SpriteLabScene';
import { TitleScene } from './scenes/TitleScene';
import { initializeStorage } from './platform/storage';

const config: Phaser.Types.Core.GameConfig = {
  parent: 'app',
  // Prefer accelerated WebGL, while keeping the same sprite/Graphics game
  // playable when a device cannot create a WebGL context. No game mechanic
  // relies on a WebGL-only post-process. Explicit canvas mode is also tested.
  type: new URLSearchParams(window.location.search).get('renderer') === 'canvas' ? Phaser.CANVAS : Phaser.AUTO,
  // Our gesture-unlocked procedural mixer owns audio; avoid a second,
  // unused Phaser AudioContext and its autoplay warning at boot.
  audio: { noAudio: true },
  width: SCREEN_W,
  height: SCREEN_H,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  // High-resolution illustration assets use linear sampling for smooth
  // contour animation at every projected scale; the road stays sub-pixel.
  pixelArt: false,
  antialias: true,
  roundPixels: false,
  scene: [BootScene, TitleScene, RaceScene, ResultScene, SpriteLabScene]
};

// Native Preferences is asynchronous. Hydrate it before menus/audio read
// records or mute state; the loading screen stays visible during this step.
void initializeStorage().then(() => {
  const game = new Phaser.Game(config);
  // Exposed for real-runtime browser verification, not used by gameplay.
  (window as unknown as { __game: Phaser.Game }).__game = game;
});
