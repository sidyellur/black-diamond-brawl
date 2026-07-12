import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { PlaceholderScene } from './scenes/PlaceholderScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 960,
  height: 540,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  pixelArt: true,
  scene: [BootScene, PlaceholderScene]
};

const game = new Phaser.Game(config);
