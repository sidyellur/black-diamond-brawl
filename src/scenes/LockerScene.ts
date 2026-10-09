import Phaser from 'phaser';
import { SCREEN_W } from '../config';
import { CHALLENGES, COSMETICS, equipCosmetic, getCareer } from '../progression';
import { getSelectedPlayerTexture } from '../entities/playerSprite';
import { UI } from '../render/palette';
import { menuButton, menuKeys, menuText } from '../frontend/menu';

type Slot = 'board' | 'jacket';
interface LockerData { seed?: number; returnTo?: 'TitleScene' | 'CupScene'; slot?: Slot; page?: number; feedback?: string }

export class LockerScene extends Phaser.Scene {
  private lockerData!: LockerData;
  private slot: Slot = 'board';
  private page = 0;
  private leaving = false;
  private status!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'LockerScene' }); }

  create(data: LockerData = {}): void {
    this.lockerData = data;
    this.slot = data.slot ?? 'board';
    this.page = data.page ?? 0;
    this.leaving = false;
    const career = getCareer();
    this.cameras.main.setBackgroundColor(UI.panel);
    const art = this.add.graphics();
    art.fillStyle(UI.accentInfo, 0.07); art.fillRect(0, 0, SCREEN_W, 84);
    art.fillStyle(UI.panelEdge); art.fillRect(48, 83, 864, 1);
    art.fillStyle(0x1c3040); art.fillRoundedRect(48, 104, 286, 300, 8);
    art.fillStyle(0x30465b); art.fillTriangle(58, 356, 168, 184, 323, 356);
    art.fillStyle(0x18313f); art.fillEllipse(192, 365, 224, 24);
    menuText(this, 48, 30, 'THE LOCKER', 30, UI.accentInfo, true);
    menuText(this, 48, 66, 'Earn your look. Every jacket and board rides with the same stats.', 12, UI.inkMid);
    menuText(this, 912, 38, 'COSMETICS ONLY', 12, UI.inkMid, true).setOrigin(1, 0);
    menuText(this, 68, 123, 'YOUR RACE KIT', 12, UI.inkMid, true);
    this.add.image(190, 374, getSelectedPlayerTexture(this), 'center').setOrigin(0.5, 1).setScale(1.24);
    const board = COSMETICS.find(item => item.slot === 'board' && item.id === career.equipped.board);
    const jacket = COSMETICS.find(item => item.slot === 'jacket' && item.id === career.equipped.jacket);
    menuText(this, 190, 376, `${jacket?.name ?? 'Classic'} · ${board?.name ?? 'Classic'}`, 11, UI.inkHigh, true).setOrigin(0.5);
    menuText(this, 49, 415, `MEDALS  ${career.medals.gold} GOLD · ${career.medals.silver} SILVER · ${career.medals.bronze} BRONZE`, 10, UI.inkMid);
    menuButton(this, 358, 105, 267, 'BOARDS', 'B', () => this.changeSlot('board'), this.slot === 'board');
    menuButton(this, 645, 105, 267, 'JACKETS', 'J', () => this.changeSlot('jacket'), this.slot === 'jacket');

    const items = COSMETICS.filter(item => item.slot === this.slot);
    const pages = Math.max(1, Math.ceil(items.length / 6));
    this.page = Math.min(this.page, pages - 1);
    const shown = items.slice(this.page * 6, this.page * 6 + 6);
    shown.forEach((item, index) => {
      const x = 358 + (index % 2) * 287;
      const y = 174 + Math.floor(index / 2) * 85;
      const unlocked = (this.slot === 'board' ? career.unlockedBoards : career.unlockedJackets).includes(item.id);
      const equipped = career.equipped[this.slot] === item.id;
      const swatch = this.add.graphics();
      swatch.fillStyle(item.color); swatch.fillRoundedRect(x, y - 7, 267, 4, 2);
      menuButton(this, x, y, 267, item.name.toUpperCase(), equipped ? 'ON' : unlocked ? String(index + 1) : 'LOCKED', () => this.choose(item.id), equipped);
      menuText(this, x + 4, y + 58, unlocked ? equipped ? 'Equipped for your next run' : 'Unlocked · tap to equip' : item.requirement, 10, unlocked ? UI.inkMid : UI.inkLow)
        .setWordWrapWidth(263);
    });
    if (shown.length <= 4) {
      menuText(this, 358, 367, `SKILL CHALLENGES  ${career.challenges.length} / ${CHALLENGES.length}`, 11, UI.inkMid, true);
      const nextChallenge = CHALLENGES.find(challenge => !career.challenges.includes(challenge.id));
      menuText(this, 358, 389, nextChallenge ? `${nextChallenge.name}: ${nextChallenge.description}` : 'Every challenge completed. The whole mountain knows your name.', 12, UI.inkLow).setWordWrapWidth(554);
    }
    this.status = menuText(this, 912, 429, data.feedback ?? 'Unlock styles with medals and skill challenges.', 11, UI.inkMid).setOrigin(1, 0.5);
    menuButton(this, 48, 454, 286, data.returnTo === 'CupScene' ? 'BACK TO CUP' : 'BASE CAMP', 'ESC', () => this.home());
    if (pages > 1) menuButton(this, 358, 454, 267, `PAGE ${this.page + 1} / ${pages}`, '→', () => this.changePage(pages));
    else menuText(this, 358, 478, 'TAB to choose · ENTER to equip', 12, UI.inkLow).setOrigin(0, 0.5);
    menuButton(this, 645, 454, 267, 'LOOKING GOOD', 'ENTER', () => this.home(), true);
    menuKeys(this, code => {
      if (code === 'Escape' || code === 'Enter') this.home();
      if (code === 'KeyB') this.changeSlot('board');
      if (code === 'KeyJ') this.changeSlot('jacket');
      if (code === 'ArrowRight' && pages > 1) this.changePage(pages);
      if (/^Digit[1-6]$/.test(code)) {
        const item = shown[Number(code.slice(-1)) - 1];
        if (item) this.choose(item.id);
      }
    });
  }

  private choose(id: string): void {
    if (this.leaving) return;
    const item = COSMETICS.find(entry => entry.slot === this.slot && entry.id === id);
    if (!item) return;
    if (!equipCosmetic(this.slot, id)) {
      this.status.setText(`LOCKED: ${item.requirement}`).setColor('#ffc36b');
      return;
    }
    this.leaving = true;
    this.scene.restart({ ...this.lockerData, slot: this.slot, page: this.page, feedback: `${item.name} equipped. Your look is saved on this device.` });
  }

  private changeSlot(slot: Slot): void {
    if (this.leaving || slot === this.slot) return;
    this.leaving = true;
    this.scene.restart({ ...this.lockerData, slot, page: 0, feedback: undefined });
  }

  private changePage(pages: number): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.restart({ ...this.lockerData, slot: this.slot, page: (this.page + 1) % pages, feedback: undefined });
  }

  private home(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start(this.lockerData.returnTo ?? 'TitleScene', { seed: this.lockerData.seed });
  }
}
