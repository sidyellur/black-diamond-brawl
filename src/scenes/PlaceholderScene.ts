import Phaser from 'phaser';

export class PlaceholderScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PlaceholderScene' });
  }

  create(): void {
    // Set sky-blue background
    this.cameras.main.setBackgroundColor('#87CEEB');

    // Add "Black Diamond Brawl" text label
    const width = this.cameras.main.width;
    const height = this.cameras.main.height;

    this.add.text(width / 2, height / 2, 'Black Diamond Brawl', {
      fontSize: '48px',
      color: '#000000',
      fontFamily: 'Arial'
    }).setOrigin(0.5, 0.5);
  }
}
