import Phaser from 'phaser';
import { generateObstacleSpriteSheet } from '../entities/obstacleSprites';
import { generatePlayerSpriteSheet } from '../entities/playerSprite';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    // Asset preloading happens here as each phase introduces sprites.
    // Most assets are still registered incrementally by later phases; the
    // player sprite sheet (Task 4) is generated procedurally rather than
    // loaded from a file, so it's built here instead.
  }

  create(): void {
    generatePlayerSpriteSheet(this);
    generateObstacleSpriteSheet(this);

    // Transition straight into the race scene.
    this.scene.start('RaceScene');
  }
}
