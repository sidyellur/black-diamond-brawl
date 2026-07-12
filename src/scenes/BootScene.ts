import Phaser from 'phaser';
import { generateObstacleSpriteSheet } from '../entities/obstacleSprites';
import { generatePickupSpriteSheet } from '../entities/pickupSprite';
import { generateAIRiderSpriteSheets, generatePlayerSpriteSheet } from '../entities/playerSprite';

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
    generateAIRiderSpriteSheets(this);
    generateObstacleSpriteSheet(this);
    generatePickupSpriteSheet(this);

    // Transition to the title screen (design-spec §2/§4.8 scene structure).
    this.scene.start('TitleScene');
  }
}
