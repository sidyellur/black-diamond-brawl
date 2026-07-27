import Phaser from 'phaser';
import { generateObstacleSpriteSheet } from '../entities/obstacleSprites';
import { generatePickupSpriteSheet } from '../entities/pickupSprite';
import { generateAIRiderSpriteSheets, generatePlayerSpriteSheet } from '../entities/playerSprite';
import { generateParticleTextures } from '../render/particleArt';
import { generateShadowTexture } from '../render/shadowSprite';
import { generateSkyTexture } from '../render/SkyRenderer';

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
    // The sky gradient depends only on screen height, so it is baked once
    // here rather than re-filled every frame.
    generateSkyTexture(this);
    generateShadowTexture(this);
    generateParticleTextures(this);

    // `?spritelab=1` opens the sprite contact sheet instead of the game — the
    // authoring feedback loop for all generated art (see scripts/spriteLab.mjs).
    if (new URLSearchParams(window.location.search).has('spritelab')) {
      this.scene.start('SpriteLabScene');
      return;
    }

    // Transition to the title screen (design-spec §2/§4.8 scene structure).
    this.scene.start('TitleScene');
  }
}
