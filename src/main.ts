import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from './config';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';
import { ResultScene } from './scenes/ResultScene';
import { TitleScene } from './scenes/TitleScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: SCREEN_W,
  height: SCREEN_H,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  pixelArt: true,
  scene: [BootScene, TitleScene, RaceScene, ResultScene]
};

new Phaser.Game(config);
