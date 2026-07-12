import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    // Asset preloading happens here as each phase introduces sprites.
    // Initially empty as per spec: assets are registered incrementally by later phases.
  }

  create(): void {
    // Transition to the placeholder scene
    this.scene.start('PlaceholderScene');
  }
}
