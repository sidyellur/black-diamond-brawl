import Phaser from 'phaser';
import { getRaceAudio } from '../audio/RaceAudio';
import { SCREEN_H, SCREEN_W } from '../config';
import { SkyRenderer } from '../render/SkyRenderer';
import { UI } from '../render/palette';
import { randomSeed, resolveSeed } from '../track/seed';
import { RIDER_FRAME_SIZE } from '../entities/riderArt';
import { AI_RIDER_TEXTURE_KEYS, getSelectedPlayerTexture } from '../entities/playerSprite';
import { createQuickRace, dailyRace, getBestScore, getCourseRecord, getCup, parseChallenge, RaceOptions, utcDate } from '../progression';
import { formatPoints, formatTime, menuButton, menuKeys, menuText, mountainName, MONO } from '../frontend/menu';

export class TitleScene extends Phaser.Scene {
  private seed = 0;
  private sky!: SkyRenderer;
  private drift = 0;
  private leaving = false;
  private courseLabel!: Phaser.GameObjects.Text;
  private courseRecord!: Phaser.GameObjects.Text;
  private sharedChallenge: RaceOptions | null = null;
  private invalidChallenge = false;
  private reducedMotion = false;
  private dailyDateText!: Phaser.GameObjects.Text;
  private lastDateCheck = 0;
  private dropInButton!: Phaser.GameObjects.Container;

  constructor() {
    super({ key: 'TitleScene' });
  }

  create(data?: { seed?: number }): void {
    this.sharedChallenge = typeof data?.seed === 'number' ? null : parseChallenge(window.location.search);
    this.invalidChallenge = typeof data?.seed !== 'number' && new URLSearchParams(window.location.search).has('daily') && !this.sharedChallenge;
    this.seed = typeof data?.seed === 'number' ? data.seed >>> 0 : this.sharedChallenge?.seed ?? resolveSeed();
    this.drift = 0;
    this.lastDateCheck = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.leaving = false;
    this.sky = new SkyRenderer(this);
    this.addBackdrop();
    this.addRiders();
    this.addTitle();
    this.addModes();
    this.addControls();
    this.refreshCourse();
    if (!this.reducedMotion) this.cameras.main.fadeIn(240, 12, 20, 30);

    menuKeys(this, (code) => {
      if (code === 'Enter' || code === 'Space') this.startRace();
      if (code === 'KeyN') this.newMountain();
      if (code === 'KeyC') this.openMenu('CupScene');
      if (code === 'KeyD') this.startRace(dailyRace());
      if (code === 'KeyP') this.startRace({ ...createQuickRace(this.seed), mode: 'practice' });
      if (code === 'KeyL') this.openMenu('LockerScene');
    });
  }

  private addBackdrop(): void {
    const art = this.add.graphics().setDepth(-1_000_000_000);
    art.fillStyle(0xc0d6e7);
    art.fillTriangle(450, 220, SCREEN_W, 215, SCREEN_W, 330);
    art.fillStyle(0xeef4fb);
    art.fillTriangle(480, 220, SCREEN_W, 250, SCREEN_W, 335);
    art.fillTriangle(480, 220, SCREEN_W, 335, 530, 320);
    // Carved tracks guide the eye into the rider group.
    art.lineStyle(3, 0x9cbacf, 0.6);
    art.beginPath();
    art.moveTo(652, 332); art.lineTo(742, 371); art.lineTo(635, 443);
    art.moveTo(659, 330); art.lineTo(751, 371); art.lineTo(648, 444);
    art.strokePath();
    // A soft left-side scrim keeps the title readable over the moving mountains.
    const shade = this.add.graphics().setDepth(-900_000_000);
    for (let x = 0; x < SCREEN_W; x += 8) {
      shade.fillStyle(UI.panel, Math.min(0.97, Math.max(0, (765 - x) / 270)));
      shade.fillRect(x, 0, 8, 448);
    }
    const decoration = this.add.graphics();
    decoration.lineStyle(1, UI.inkHigh, 0.15);
    decoration.strokeCircle(734, 193, 101);
    decoration.strokeCircle(734, 193, 108);
    decoration.lineBetween(612, 193, 624, 193);
    decoration.lineBetween(844, 193, 856, 193);
    decoration.lineBetween(734, 74, 734, 84);
    decoration.fillStyle(UI.accentWarn);
    decoration.fillPoints([{ x: 50, y: 29 }, { x: 58, y: 40 }, { x: 50, y: 51 }, { x: 42, y: 40 }], true);
    menuText(this, 70, 40, 'ALPINE COMBAT CIRCUIT', 12, UI.inkMid, true).setOrigin(0, 0.5);
    menuText(this, 917, 33, 'PERSONAL BEST', 10, UI.inkMid, true).setOrigin(1, 0.5);
    menuText(this, 917, 54, formatPoints(getBestScore()), 23, UI.inkHigh, true).setOrigin(1, 0.5);
  }

  private addRiders(): void {
    const textures = [AI_RIDER_TEXTURE_KEYS[0], AI_RIDER_TEXTURE_KEYS[2], getSelectedPlayerTexture(this)];
    const poses = ['lean-right', 'lean-left', 'swing'] as const;
    const xs = [642, 831, 730];
    const ys = [259, 255, 295];
    const scales = [1.9, 1.8, 3.2];
    const shadow = this.add.graphics();
    textures.forEach((key, i) => {
      shadow.fillStyle(0x284761, i === 2 ? 0.18 : 0.13);
      shadow.fillEllipse(xs[i], ys[i] - 7, 39 * scales[i], 6 * scales[i]);
      const sprite = this.add.image(xs[i], ys[i], key, poses[i]).setOrigin(0.5, 1).setScale(scales[i] * 48 / RIDER_FRAME_SIZE);
      if (!this.reducedMotion) this.tweens.add({ targets: sprite, y: ys[i] - (i === 2 ? 5 : 3), duration: 1600 + i * 270, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    });
    menuText(this, 734, 118, 'NO BRAKES. NO FRIENDS.', 10, UI.panel, true).setOrigin(0.5);
    const flakes = this.add.graphics();
    flakes.fillStyle(0xffffff, 0.8);
    [[655, 277], [665, 286], [813, 277], [825, 267], [795, 294], [642, 290]].forEach(([x, y]) => {
      flakes.fillRect(x, y, 4, 4);
    });
  }

  private addTitle(): void {
    menuText(this, 45, 85, 'BLACK DIAMOND', 46, UI.inkHigh, true).setLetterSpacing(-2);
    menuText(this, 41, 128, 'BRAWL', 102, UI.accentWarn, true).setLetterSpacing(-4);
    menuText(this, 49, 245, 'Four rivals. One finish line.', 21, UI.inkHigh, true);
    menuText(this, 49, 276, 'Dodge the trees. Catch big air. Fight for first.', 15, UI.inkMid);
    this.dropInButton = menuButton(this, 48, 325, 263, 'DROP IN', 'ENTER', () => this.startRace(), true);
    menuButton(this, 324, 325, 195, 'NEW MOUNTAIN', 'N', () => this.newMountain());
    this.courseLabel = menuText(this, 49, 394, '', 12, UI.inkMid, true).setFontFamily(MONO);
    this.courseRecord = menuText(this, 49, 415, '', 12, UI.inkLow);
  }


  private addModes(): void {
    const cup = getCup();
    const hasCup = cup?.status === 'active';
    menuButton(this, 550, 312, 176, hasCup ? 'RESUME CUP' : 'CUP SERIES', 'C', () => this.openMenu('CupScene'));
    menuButton(this, 738, 312, 174, 'DAILY RUN', 'D', () => this.startRace(dailyRace()));
    menuText(this, 555, 370, hasCup ? `${cup.rounds.length}/3 rounds complete` : '3 mountains. One medal.', 11, UI.inkMid);
    this.dailyDateText = menuText(this, 743, 370, `${utcDate()} · UTC`, 10, UI.inkMid).setFontFamily(MONO);
    menuButton(this, 550, 390, 176, 'PRACTICE', 'P', () => this.startRace({ ...createQuickRace(this.seed), mode: 'practice' }));
    menuButton(this, 738, 390, 174, 'LOCKER', 'L', () => this.openMenu('LockerScene'));
  }

  private openMenu(key: 'CupScene' | 'LockerScene'): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start(key, { seed: this.seed });
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
    (this.dropInButton.getAt(1) as Phaser.GameObjects.Text).setText(this.sharedChallenge?.dailyDate ? this.sharedChallenge.mode === 'practice' ? 'DAILY PRACTICE' : 'DAILY DROP IN' : 'DROP IN');
    this.courseLabel.setText(`${this.sharedChallenge?.dailyDate ? `DAILY ${this.sharedChallenge.dailyDate}  /  ` : `${mountainName(this.seed)}  /  `}#${this.seed}`);
    const record = getCourseRecord(this.seed);
    this.courseRecord.setText(this.invalidChallenge ? 'Invalid or outdated daily link. Choose today’s DAILY RUN.' : record
      ? `Mountain best ${formatPoints(record.bestScore)}${record.bestTimeSeconds !== null ? `  ·  Fastest ${formatTime(record.bestTimeSeconds)}` : '  ·  Finish it to set a time'}`
      : 'A fresh line. Make this mountain yours.');
  }

  private newMountain(): void {
    if (this.leaving) return;
    this.sharedChallenge = null;
    this.invalidChallenge = false;
    const previous = this.seed;
    this.seed = randomSeed();
    if (this.seed === previous) this.seed = (previous + 1) >>> 0;
    this.refreshCourse();
    if (!this.reducedMotion) this.tweens.add({ targets: this.courseLabel, alpha: { from: 0.25, to: 1 }, duration: 220 });
  }

  private startRace(options: RaceOptions = this.sharedChallenge ?? createQuickRace(this.seed)): void {
    if (this.leaving) return;
    this.leaving = true;
    if (options.mode === 'daily' && options.dailyDate !== utcDate()) options = { ...options, mode: 'practice' };
    getRaceAudio().unlock();
    this.scene.start('RaceScene', options);
  }

  update(time: number, delta: number): void {
    if (time - this.lastDateCheck >= 1000) {
      this.lastDateCheck = time;
      this.dailyDateText.setText(`${utcDate()} · UTC`);
      if (this.sharedChallenge?.mode === 'daily' && this.sharedChallenge.dailyDate !== utcDate()) {
        this.sharedChallenge = { ...this.sharedChallenge, mode: 'practice' };
        this.refreshCourse();
      }
    }
    if (!this.reducedMotion) this.drift += delta * 0.45;
    this.sky.render(this.drift, 0, SCREEN_H * 0.62);
  }
}
