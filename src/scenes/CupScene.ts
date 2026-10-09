import Phaser from 'phaser';
import { getRaceAudio } from '../audio/RaceAudio';
import { SCREEN_H, SCREEN_W } from '../config';
import { CUP_ROUND_NAMES, CupState, getCup, getCupRace, getCupStandings, startCup } from '../progression';
import { UI } from '../render/palette';
import { menuButton, menuKeys, menuText, mountainName, MONO } from '../frontend/menu';

/** The cup is committed by RaceScene, never by a menu visit. The saved
 * snapshot makes leaving between rounds and relaunching safe. */
export class CupScene extends Phaser.Scene {
  private seed = 0;
  private cup: CupState | null = null;
  private leaving = false;
  private resetArmed = false;
  private note!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'CupScene' }); }

  create(data?: { seed?: number }): void {
    this.seed = data?.seed ?? 0;
    this.cup = getCup();
    this.leaving = false;
    this.resetArmed = false;
    this.cameras.main.setBackgroundColor(UI.panel);
    const art = this.add.graphics();
    art.fillStyle(0x1c3040);
    art.fillTriangle(0, 420, 199, 84, 479, 420);
    art.fillStyle(UI.accentWarn, 0.07);
    art.fillRect(0, 0, SCREEN_W, 84);
    art.fillStyle(UI.panelEdge);
    art.fillRect(48, 83, 864, 1);
    art.fillStyle(0x172330, 0.95);
    art.fillRoundedRect(438, 107, 474, 297, 8);
    menuText(this, 48, 30, 'BLACK DIAMOND CUP', 30, UI.accentWarn, true);
    menuText(this, 912, 36, '3 RACES  /  5 RIDERS', 12, UI.inkMid, true).setOrigin(1, 0).setFontFamily(MONO);
    menuText(this, 48, 65, 'Place well. Stay consistent. Bring home a medal.', 12, UI.inkMid);

    this.addRounds();
    if (this.cup) this.addStandings(this.cup);
    else this.addCupIntro();
    const finished = this.cup?.status === 'complete';
    const current = this.cup?.rounds.length ?? 0;
    this.note = menuText(this, SCREEN_W / 2, 427,
      finished ? `CUP COMPLETE${this.cup?.medal ? ` · ${this.cup.medal.toUpperCase()} MEDAL EARNED` : ' · A NEW CUP IS WAITING'}`
        : 'Progress saves after every round. Come back to this cup any time.', 13,
      finished && this.cup?.medal ? UI.accentWarn : UI.inkMid, finished).setOrigin(0.5);
    menuButton(this, 48, 454, 322, finished || !this.cup ? 'START A CUP' : `RACE ${current + 1} OF 3`, 'ENTER', () => this.play(), true);
    menuButton(this, 385, 454, 292, this.cup?.status === 'active' ? 'NEW CUP' : 'LOCKER', this.cup?.status === 'active' ? 'N' : 'L',
      () => this.cup?.status === 'active' ? this.resetCup() : this.openLocker());
    menuButton(this, 692, 454, 220, 'BASE CAMP', 'ESC', () => this.home());
    menuText(this, 48, SCREEN_H - 16, 'FINISH POINTS: 10 / 7 / 5 / 3 / 1 · WIPEOUT: 0', 10, UI.inkLow).setOrigin(0, 0.5);
    menuText(this, 912, SCREEN_H - 16, 'TAB TO CHOOSE · ENTER TO CONFIRM', 10, UI.inkLow).setOrigin(1, 0.5);
    menuKeys(this, code => {
      if (code === 'Enter' || code === 'Space') this.play();
      if (code === 'KeyN' && this.cup?.status === 'active') this.resetCup();
      if (code === 'KeyL') this.openLocker();
      if (code === 'Escape') this.home();
    });
  }

  private addRounds(): void {
    const cup = this.cup;
    const names = CUP_ROUND_NAMES.map(name => name.toUpperCase());
    menuText(this, 48, 109, 'YOUR ROUTE TO THE PODIUM', 12, UI.inkMid, true);
    for (let index = 0; index < 3; index++) {
      const y = 143 + index * 85;
      const complete = index < (cup?.rounds.length ?? 0);
      const current = !complete && index === (cup?.rounds.length ?? 0);
      const art = this.add.graphics();
      art.fillStyle(current ? UI.accentWarn : complete ? UI.accentGood : UI.panelEdge);
      art.fillCircle(66, y + 15, 18);
      menuText(this, 66, y + 15, complete ? '✓' : String(index + 1), 17, current || complete ? UI.panel : UI.inkHigh, true).setOrigin(0.5);
      menuText(this, 98, y - 2, cup ? mountainName(cup.seeds[index]) : names[index], 19, UI.inkHigh, true);
      menuText(this, 99, y + 27, cup ? `#${cup.seeds[index]} · ${complete ? 'ROUND COMPLETE' : current ? 'UP NEXT' : 'ON THE HORIZON'}`
        : ['Find your line.', 'Keep your points rolling.', 'Leave it all on the mountain.'][index], 11, complete ? UI.accentGood : UI.inkMid);
      if (index < 2) { art.lineStyle(1, UI.panelEdge); art.lineBetween(66, y + 37, 66, y + 62); }
    }
    menuText(this, 48, 397, 'The same four rivals follow you through the series.', 11, UI.inkLow);
  }

  private addStandings(cup: CupState): void {
    const standings = getCupStandings(cup);
    menuText(this, 461, 124, cup.status === 'complete' ? 'FINAL STANDINGS' : 'SERIES STANDINGS', 13, UI.inkHigh, true);
    menuText(this, 461, 154, `${cup.rounds.length} OF 3 ROUNDS COMPLETE`, 10, UI.inkLow, true).setFontFamily(MONO);
    menuText(this, 795, 182, 'WINS', 10, UI.inkLow, true).setOrigin(1, 0);
    menuText(this, 888, 182, 'POINTS', 10, UI.inkLow, true).setOrigin(1, 0);
    standings.forEach((rider, index) => {
      const y = 218 + index * 34;
      const player = rider.id === 'player';
      if (player) {
        const art = this.add.graphics(); art.fillStyle(UI.accentWarn, 0.1); art.fillRoundedRect(452, y - 13, 447, 30, 4);
      }
      menuText(this, 464, y, `${rider.position}.`, 16, player ? UI.accentWarn : UI.inkMid, true).setOrigin(0, 0.5);
      menuText(this, 505, y, player ? 'YOU' : rider.name.toUpperCase(), 15, player ? UI.accentWarn : UI.inkHigh, player).setOrigin(0, 0.5);
      menuText(this, 795, y, String(rider.wins), 14, UI.inkMid).setOrigin(1, 0.5).setFontFamily(MONO);
      menuText(this, 888, y, String(rider.points), 19, player ? UI.accentWarn : UI.inkHigh, true).setOrigin(1, 0.5);
    });
    menuText(this, 461, 385, 'Ties: wins, finishes, total time, then rider order.', 10, UI.inkLow);
  }

  private addCupIntro(): void {
    menuText(this, 462, 128, 'THREE MOUNTAINS. ONE CHAMPION.', 18, UI.inkHigh, true);
    menuText(this, 462, 165, 'Race the same rivals across three seeded courses.\nYour finishing place earns series points.\nEven a rough round is a reason to keep riding.', 14, UI.inkMid).setLineSpacing(10);
    menuText(this, 462, 265, 'PODIUM REWARDS', 11, UI.inkLow, true);
    const medals = [{ label: 'GOLD', color: 0xffc36b }, { label: 'SILVER', color: 0xb9d2df }, { label: 'BRONZE', color: 0xd69562 }];
    medals.forEach((medal, index) => {
      const x = 508 + index * 149;
      const art = this.add.graphics();
      art.fillStyle(medal.color, 0.15); art.fillCircle(x, 318, 26);
      art.lineStyle(2, medal.color); art.strokeCircle(x, 318, 22);
      menuText(this, x, 318, String(index + 1), 23, medal.color, true).setOrigin(0.5);
      menuText(this, x, 354, medal.label, 12, medal.color, true).setOrigin(0.5);
    });
    menuText(this, 462, 384, 'Earn cosmetics through cups and skill challenges.', 11, UI.inkLow);
  }

  private play(): void {
    if (this.leaving) return;
    if (!this.cup || this.cup.status === 'complete') this.cup = startCup();
    const options = getCupRace();
    if (!options) { this.note.setText('Could not load this round. Start a new cup.'); return; }
    this.leaving = true;
    getRaceAudio().unlock();
    this.scene.start('RaceScene', options);
  }

  private resetCup(): void {
    if (this.leaving) return;
    if (!this.resetArmed) {
      this.resetArmed = true;
      this.note.setText('Replace this cup? Press N or tap NEW CUP again. Your medals stay.').setColor('#ffc36b');
      return;
    }
    startCup();
    this.scene.restart({ seed: this.seed });
  }

  private home(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start('TitleScene', { seed: this.seed });
  }

  private openLocker(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start('LockerScene', { seed: this.seed, returnTo: 'CupScene' });
  }
}
