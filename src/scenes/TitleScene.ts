import Phaser from 'phaser';
import { getRaceAudio } from '../audio/RaceAudio';
import { SCREEN_H, SCREEN_W } from '../config';
import { SkyRenderer } from '../render/SkyRenderer';
import { UI } from '../render/palette';
import { randomSeed, resolveSeed } from '../track/seed';
import { RIDER_FRAME_SIZE } from '../entities/riderArt';
import { AI_RIDER_TEXTURE_KEYS, PLAYER_TEXTURE_KEY } from '../entities/playerSprite';
import { getBestScore, getCourseRecord } from '../entities/session';
import { formatPoints, formatTime, menuButton, menuKeys, menuText, mountainName, MONO } from '../frontend/menu';

export class TitleScene extends Phaser.Scene {
  private seed = 0;
  private sky!: SkyRenderer;
  private drift = 0;
  private leaving = false;
  private courseLabel!: Phaser.GameObjects.Text;
  private courseRecord!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'TitleScene' });
  }

  create(data?: { seed?: number }): void {
    this.seed = typeof data?.seed === 'number' ? data.seed >>> 0 : resolveSeed();
    this.drift = 0;
    this.leaving = false;
    this.sky = new SkyRenderer(this);
    this.addBackdrop();
    this.addRiders();
    this.addTitle();
    this.addControls();
    this.refreshCourse();
    this.cameras.main.fadeIn(240, 12, 20, 30);

    menuKeys(this, (code) => {
      if (code === 'Enter' || code === 'Space') this.startRace();
      if (code === 'KeyN') this.newMountain();
    });
  }

  private addBackdrop(): void {
    const art = this.add.graphics().setDepth(-1_000_000_000);
    art.fillStyle(0xc0d6e7);
    art.fillTriangle(450, 302, SCREEN_W, 290, SCREEN_W, 480);
    art.fillStyle(0xeef4fb);
    art.fillTriangle(480, 318, SCREEN_W, 354, SCREEN_W, 504);
    art.fillTriangle(480, 318, SCREEN_W, 504, 210, 480);
    // Carved tracks guide the eye into the rider group.
    art.lineStyle(3, 0x9cbacf, 0.6);
    art.beginPath();
    art.moveTo(652, 332); art.lineTo(742, 371); art.lineTo(635, 443);
    art.moveTo(659, 330); art.lineTo(751, 371); art.lineTo(648, 444);
    art.strokePath();
    // A soft left-side scrim keeps the title readable over the moving mountains.
    const shade = this.add.graphics().setDepth(-900_000_000);
    for (let x = 0; x < SCREEN_W; x += 8) {
      shade.fillStyle(UI.panel, Math.min(0.97, Math.max(0, (780 - x) / 360)));
      shade.fillRect(x, 0, 8, 448);
    }
    const decoration = this.add.graphics();
    decoration.lineStyle(1, UI.inkHigh, 0.15);
    decoration.strokeCircle(734, 251, 131);
    decoration.strokeCircle(734, 251, 138);
    decoration.lineBetween(580, 251, 598, 251);
    decoration.lineBetween(870, 251, 888, 251);
    decoration.lineBetween(734, 100, 734, 116);
    decoration.fillStyle(UI.accentWarn);
    decoration.fillPoints([{ x: 50, y: 29 }, { x: 58, y: 40 }, { x: 50, y: 51 }, { x: 42, y: 40 }], true);
    menuText(this, 70, 40, 'ALPINE COMBAT CIRCUIT', 12, UI.inkMid, true).setOrigin(0, 0.5);
    menuText(this, 917, 33, 'PERSONAL BEST', 10, UI.inkMid, true).setOrigin(1, 0.5);
    menuText(this, 917, 54, formatPoints(getBestScore()), 23, UI.inkHigh, true).setOrigin(1, 0.5);
  }

  private addRiders(): void {
    const textures = [AI_RIDER_TEXTURE_KEYS[0], AI_RIDER_TEXTURE_KEYS[2], PLAYER_TEXTURE_KEY];
    const poses = ['lean-right', 'lean-left', 'swing'] as const;
    const xs = [601, 844, 724];
    const ys = [365, 360, 424];
    const scales = [2.4, 2.3, 4.4];
    const shadow = this.add.graphics();
    textures.forEach((key, i) => {
      shadow.fillStyle(0x284761, i === 2 ? 0.18 : 0.13);
      shadow.fillEllipse(xs[i], ys[i] - 7, 39 * scales[i], 6 * scales[i]);
      const sprite = this.add.image(xs[i], ys[i], key, poses[i]).setOrigin(0.5, 1).setScale(scales[i] * 48 / RIDER_FRAME_SIZE);
      this.tweens.add({ targets: sprite, y: ys[i] - (i === 2 ? 5 : 3), duration: 1600 + i * 270, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    });
    menuText(this, 734, 165, 'NO BRAKES. NO FRIENDS.', 11, UI.panel, true).setOrigin(0.5);
    const flakes = this.add.graphics();
    flakes.fillStyle(0xffffff, 0.8);
    [[631, 388], [644, 401], [813, 405], [825, 395], [795, 426], [625, 418]].forEach(([x, y]) => {
      flakes.fillRect(x, y, 4, 4);
    });
  }

  private addTitle(): void {
    menuText(this, 45, 85, 'BLACK DIAMOND', 46, UI.inkHigh, true).setLetterSpacing(-2);
    menuText(this, 41, 128, 'BRAWL', 102, UI.accentWarn, true).setLetterSpacing(-4);
    menuText(this, 49, 245, 'Four rivals. One finish line.', 21, UI.inkHigh, true);
    menuText(this, 49, 276, 'Dodge the trees. Catch big air. Fight for first.', 15, UI.inkMid);
    menuButton(this, 48, 325, 263, 'DROP IN', 'ENTER', () => this.startRace(), true);
    menuButton(this, 324, 325, 195, 'NEW MOUNTAIN', 'N', () => this.newMountain());
    this.courseLabel = menuText(this, 49, 394, '', 12, UI.inkMid, true).setFontFamily(MONO);
    this.courseRecord = menuText(this, 49, 415, '', 12, UI.inkLow);
  }

  private addControls(): void {
    const plate = this.add.graphics();
    plate.fillStyle(UI.panel, 0.97);
    plate.fillRect(0, 448, SCREEN_W, SCREEN_H - 448);
    plate.fillStyle(UI.panelEdge);
    plate.fillRect(0, 448, SCREEN_W, 1);
    const touch = this.sys.game.device.input.touch || new URLSearchParams(window.location.search).has('touch');
    const controls = touch ? [
      { x: 49, key: 'TAP / HOLD  ← →', label: 'CARVE', hint: 'Tap a lane · hold to carve' },
      { x: 278, key: 'TAP  JUMP', label: 'JUMP', hint: 'Time moguls for trick air' },
      { x: 522, key: 'TAP  HIT', label: 'ATTACK', hint: 'Strike the amber-marked rival' },
      { x: 799, key: 'TAP  PAUSE', label: 'PAUSE', hint: 'Take a breather' }
    ] : [
      { x: 49, key: '← →  /  A D', label: 'CARVE', hint: 'Tap a lane · hold to carve' },
      { x: 278, key: 'SPACE  /  ↑ W', label: 'JUMP', hint: 'Time moguls for trick air' },
      { x: 522, key: 'F  /  K', label: 'ATTACK', hint: 'Strike the amber-marked rival' },
      { x: 799, key: 'ESC  /  P', label: 'PAUSE', hint: 'Take a breather' }
    ];
    controls.forEach(({ x, key, label, hint }) => {
      menuText(this, x, 464, key, 14, UI.accentWarn, true).setFontFamily(MONO);
      menuText(this, x, 487, label, 12, UI.inkHigh, true);
      menuText(this, x, 507, hint, 11, UI.inkLow);
    });
  }

  private refreshCourse(): void {
    this.courseLabel.setText(`${mountainName(this.seed)}  /  #${this.seed}`);
    const record = getCourseRecord(this.seed);
    this.courseRecord.setText(record
      ? `Mountain best ${formatPoints(record.bestScore)}${record.bestTimeSeconds !== null ? `  ·  Fastest ${formatTime(record.bestTimeSeconds)}` : '  ·  Finish it to set a time'}`
      : 'A fresh line. Make this mountain yours.');
  }

  private newMountain(): void {
    if (this.leaving) return;
    const previous = this.seed;
    this.seed = randomSeed();
    if (this.seed === previous) this.seed = (previous + 1) >>> 0;
    this.refreshCourse();
    this.tweens.add({ targets: this.courseLabel, alpha: { from: 0.25, to: 1 }, duration: 220 });
  }

  private startRace(): void {
    if (this.leaving) return;
    this.leaving = true;
    getRaceAudio().unlock();
    this.scene.start('RaceScene', { seed: this.seed });
  }

  update(_time: number, delta: number): void {
    this.drift += delta * 0.45;
    this.sky.render(this.drift, 0, SCREEN_H * 0.62);
  }
}
