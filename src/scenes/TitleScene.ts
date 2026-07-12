import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { resolveSeed } from '../track/seed';

const SKY_COLOR = '#8fd0ff';

/**
 * Bare-bones title screen (design-spec §2/§4.8): game name, the seed this
 * run will use (a `?seed=` URL param if present, otherwise fresh-random —
 * `resolveSeed()`, same resolution `RaceScene` used to do itself before this
 * scene existed), and "press any key to start". A restart from `ResultScene`
 * goes straight back to `RaceScene` — it does NOT come back through here
 * (§4.8's flow: `Title → Race → Result → restart → Race`).
 */
export class TitleScene extends Phaser.Scene {
  private seed = 0;

  constructor() {
    super({ key: 'TitleScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor(SKY_COLOR);
    this.seed = resolveSeed();

    this.add
      .text(SCREEN_W / 2, SCREEN_H / 2 - 70, 'BLACK DIAMOND BRAWL', {
        fontSize: '36px',
        color: '#1a1a1a',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    this.add
      .text(SCREEN_W / 2, SCREEN_H / 2 - 10, `seed: ${this.seed}`, {
        fontSize: '16px',
        color: '#1a1a1a'
      })
      .setOrigin(0.5);

    this.add
      .text(SCREEN_W / 2, SCREEN_H / 2 + 30, 'press any key to start', {
        fontSize: '18px',
        color: '#1a1a1a'
      })
      .setOrigin(0.5);

    this.input.keyboard?.once('keydown', () => {
      this.scene.start('RaceScene', { seed: this.seed });
    });
  }
}
