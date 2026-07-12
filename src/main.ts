import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from './config';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: SCREEN_W,
  height: SCREEN_H,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  pixelArt: true,
  scene: [BootScene, RaceScene]
};

new Phaser.Game(config);
