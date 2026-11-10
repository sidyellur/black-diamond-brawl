import Phaser from 'phaser';
import { BOOST_MAX, BOOST_MIN_TO_START, SCREEN_H, SCREEN_W } from '../config';
import { UI } from '../render/palette';
import { formatTime } from '../frontend/menu';
import type { InputAction } from '../entities/input';
import { isAppActive } from '../input/appLifecycle';
import type { Surface } from '../track/segment';
import { SURFACE_LABELS, surfaceSpeedFactor } from '../track/surface';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export interface HudState {
  riderCount?: number;
  score: number;
  speed: number;
  position: number;
  elapsedMs: number;
  progress: number;
  charges: number;
  /** A snowball is held (shares the weapon slot with the pole). */
  snowball?: boolean;
  /** A shield is up. */
  shield?: boolean;
  /** A thrown snowball would hit someone right now (no melee target). */
  throwTarget?: boolean;
  attackCooldown: number;
  /** 0..1 remaining cooldown of the directional shove. */
  pushCooldown?: number;
  /** A shove would land on someone right now. */
  push?: boolean;
  /** Tree or rock waiting in the lane the shove would send the rival to. */
  pushHazard?: 'tree' | 'rock' | null;
  target: boolean;
  targetAdvantage: boolean;
  boost?: { value: number; active: boolean; ready: boolean };
  airborne: boolean;
  recovering: boolean;
  /** Trees hit this race; 1 shows the LAST CHANCE tag. */
  treeStrikes?: number;
  chain: number;
  chainRemaining: number;
  sectionName?: string;
  /** Riding surface under the player; drives the persistent tag under the pace readout. */
  surface?: Surface;
  modeLabel?: string;
  ghostSplit?: string;
  incomingAttack?: string;
  counterReady?: boolean;
  practice?: { title: string; instruction: string; feedback: string };
  rivals: { progress: number; color: number; out: boolean }[];
}

// Beside the pace readout, which it modifies, and clear of the centre of the
// road where the riders and the hint bar already compete for space.
const BOOST_BAR_W = 150;
const BOOST_BAR_X = 184;

// Held-item strip under the score panel: weapon slot (pole with charges, or a
// snowball) on the left, shield on the right. Only drawn while something is held.
const HELD_X = 750;
const HELD_Y = 98;
const HELD_W = 194;
const HELD_H = 28;

// Under the left panel, below the section/split lines.
const LAST_CHANCE_X = 16;
const LAST_CHANCE_Y = 156;
const LAST_CHANCE_W = 270;

// Countdown digit is centred at 0.42 * SCREEN_H and ~72px tall; the hint bar sits at the bottom.
const TAUNT_Y = 318;

/** Screen-space cockpit. Every object belongs exclusively to the UI camera. */
export class RaceHud {
  readonly objects: Phaser.GameObjects.GameObject[] = [];
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly place: Phaser.GameObjects.Text;
  private readonly clock: Phaser.GameObjects.Text;
  private readonly score: Phaser.GameObjects.Text;
  private readonly speed: Phaser.GameObjects.Text;
  private readonly surfaceTag: Phaser.GameObjects.Text;
  private readonly attack: Phaser.GameObjects.Text;
  private readonly progress: Phaser.GameObjects.Text;
  private readonly status: Phaser.GameObjects.Text;
  private readonly chain: Phaser.GameObjects.Text;
  private readonly message: Phaser.GameObjects.Text;
  private readonly surfaceCue: Phaser.GameObjects.Text;
  private readonly pauseOverlay: Phaser.GameObjects.Container;
  private readonly countdown: Phaser.GameObjects.Text;
  private readonly taunt: Phaser.GameObjects.Container;
  private readonly tauntChip: Phaser.GameObjects.Rectangle;
  private readonly tauntName: Phaser.GameObjects.Text;
  private readonly tauntLine: Phaser.GameObjects.Text;
  private readonly tauntPlate: Phaser.GameObjects.Rectangle;
  private readonly section: Phaser.GameObjects.Text;
  private readonly split: Phaser.GameObjects.Text;
  private readonly lesson: Phaser.GameObjects.Text;
  private readonly lessonBg: Phaser.GameObjects.Rectangle;
  private readonly boostLabel: Phaser.GameObjects.Text;
  private readonly boostCue: Phaser.GameObjects.Text;
  private readonly lastChance: Phaser.GameObjects.Text;
  private readonly weaponText: Phaser.GameObjects.Text;
  private readonly shieldText: Phaser.GameObjects.Text;
  private readonly muteLabel: Phaser.GameObjects.Text;
  private readonly touch: boolean;
  private messageMs = 0;
  private surfaceCueMs = 0;
  private readonly raceControls: Phaser.GameObjects.GameObject[] = [];
  private readonly releaseTouchControls: Array<() => void> = [];
  private readonly cancelButtons: Array<() => void> = [];

  constructor(private readonly scene: Phaser.Scene, seed: number, actions: {
    pause: () => void;
    resume: () => void;
    restart: () => void;
    menu: () => void;
    mute: () => boolean;
    control: (action: InputAction, down: boolean, source: string) => void;
  }) {
    this.touch = scene.sys.game.device.input.touch || new URLSearchParams(location.search).has('touch');
    const bg = scene.add.graphics().setDepth(10000);
    bg.fillStyle(UI.panel, 0.9).fillRoundedRect(16, 14, 188, 78, 10);
    bg.fillStyle(UI.panel, 0.9).fillRoundedRect(218, 14, 518, 58, 10);
    bg.fillStyle(UI.panel, 0.9).fillRoundedRect(750, 14, 194, 78, 10);
    bg.fillStyle(UI.accentWarn).fillRect(30, 27, 3, 43);
    this.objects.push(bg);
    this.place = this.text(44, 26, '', 28, UI.inkHigh, true);
    this.clock = this.text(44, 61, '', 13, UI.inkMid).setFontFamily('monospace');
    this.score = this.text(766, 24, '', 25, UI.inkHigh, true);
    this.text(766, 57, 'POINTS', 10, UI.inkLow, true);
    this.progress = this.text(234, 24, `MOUNTAIN ${seed}`, 11, UI.inkMid, true);
    this.graphics = scene.add.graphics().setDepth(10001);
    this.objects.push(this.graphics);
    this.speed = this.text(30, SCREEN_H - 86, '', 22, UI.panel, true);
    this.surfaceTag = this.text(30, SCREEN_H - 60, '', 12, UI.panel, true).setStroke('#f3f8ff', 3);
    this.attack = this.text(SCREEN_W / 2, SCREEN_H - 31, '', 14, UI.inkHigh, true).setOrigin(0.5);
    const helpBg = scene.add.rectangle(SCREEN_W / 2, SCREEN_H - 30, 464, 30, UI.panel, 0.88).setDepth(9999);
    this.objects.push(helpBg);
    this.status = this.text(SCREEN_W / 2, 91, '', 13, UI.panel, true).setOrigin(0.5);
    this.chain = this.text(925, 133, '', 17, UI.panel, true).setOrigin(1, 0);
    this.weaponText = this.text(HELD_X + 30, HELD_Y + 7, '', 12, UI.inkHigh, true);
    this.shieldText = this.text(HELD_X + 136, HELD_Y + 7, 'SHIELD', 12, UI.inkHigh, true);
    this.message = this.text(SCREEN_W / 2, 151, '', 21, UI.accentWarn, true).setOrigin(0.5);
    this.message.setStroke(hex(UI.panel), 5);
    // The surface-entry cue has its own line under the message, so a close call
    // or a pickup right at the entry cannot overwrite it.
    this.surfaceCue = this.text(SCREEN_W / 2, 184, '', 19, UI.accentInfo, true).setOrigin(0.5).setAlpha(0);
    this.surfaceCue.setStroke(hex(UI.panel), 5);
    this.countdown = this.text(SCREEN_W / 2, SCREEN_H * 0.42, '', 72, UI.inkHigh, true).setOrigin(0.5).setStroke(hex(UI.panel), 8);
    // Start-line taunt: below the countdown digit and above the hint bar, so it
    // never touches the "3-2-1", the hint line or the control hints.
    this.tauntPlate = scene.add.rectangle(0, 0, 100, 44, UI.panel, 0.92).setStrokeStyle(2, UI.panelEdge);
    this.tauntChip = scene.add.rectangle(0, 0, 14, 14, UI.inkHigh).setStrokeStyle(2, UI.inkHigh);
    this.tauntName = scene.add.text(0, 0, '', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '14px', fontStyle: 'bold', color: hex(UI.accentWarn) }).setOrigin(0, 0.5);
    this.tauntLine = scene.add.text(0, 0, '', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '16px', fontStyle: 'bold', color: hex(UI.inkHigh) }).setOrigin(0, 0.5);
    this.taunt = scene.add.container(SCREEN_W / 2, TAUNT_Y, [this.tauntPlate, this.tauntChip, this.tauntName, this.tauntLine]).setDepth(10002).setVisible(false);
    this.objects.push(this.taunt);
    this.boostLabel = this.text(BOOST_BAR_X, 0, '', 11, UI.panel, true).setStroke('#f3f8ff', 3);
    this.boostCue = this.text(BOOST_BAR_X + BOOST_BAR_W, 0, '', 11, UI.panel, true).setOrigin(1, 0).setStroke('#f3f8ff', 3);
    this.lastChance = this.text(LAST_CHANCE_X + 30, LAST_CHANCE_Y + 5, 'LAST CHANCE · NEXT TREE ENDS RUN', 12, UI.panel, true).setVisible(false);
    this.section = this.text(30, 109, '', 14, UI.panel, true).setStroke('#f3f8ff', 3);
    this.split = this.text(30, 133, '', 12, UI.panel, true).setStroke('#f3f8ff', 3);
    this.lessonBg = scene.add.rectangle(SCREEN_W / 2, 231, 700, 112, UI.panel, 0.93).setDepth(10000).setVisible(false);
    this.objects.push(this.lessonBg);
    this.lesson = this.text(SCREEN_W / 2, 193, '', 16, UI.inkHigh, true).setOrigin(0.5, 0).setAlign('center').setLineSpacing(6).setWordWrapWidth(666);
    this.button(902, 77, 62, 25, 'PAUSE', actions.pause, 10);
    this.muteLabel = this.button(687, 30, 74, 23, this.touch ? 'SOUND' : 'M SOUND', () => this.setMuted(actions.mute()), 10);

    if (this.touch) {
      if (scene.input.manager.pointersTotal < 4) scene.input.addPointer(4 - scene.input.manager.pointersTotal);
      const held = (x: number, label: string, action: InputAction, y = SCREEN_H - 43) => {
        const g = scene.add.rectangle(x, y, 72, 66, UI.panel, 0.8).setStrokeStyle(2, UI.inkMid, 0.7).setDepth(10002).setInteractive();
        const t = this.text(x, y, label, action === 'left' || action === 'right' ? 30 : 13, UI.inkHigh, true).setOrigin(0.5).setDepth(10003);
        const pointers = new Set<number>();
        const press = (p: Phaser.Input.Pointer) => {
          if (!isAppActive(scene.game)) return;
          pointers.add(p.id); actions.control(action, true, `touch:${p.id}`); g.setFillStyle(UI.panelEdge, 0.95);
        };
        const release = (p: Phaser.Input.Pointer) => {
          pointers.delete(p.id); actions.control(action, false, `touch:${p.id}`);
          if (pointers.size === 0) g.setFillStyle(UI.panel, 0.8);
        };
        this.releaseTouchControls.push(() => {
          for (const id of pointers) actions.control(action, false, `touch:${id}`);
          pointers.clear(); g.setFillStyle(UI.panel, 0.8);
        });
        g.on('pointerdown', press).on('pointerup', release).on('pointerout', release);
        this.objects.push(g, t);
        this.raceControls.push(g);
      };
      held(58, '‹', 'left'); held(142, '›', 'right'); held(726, 'BOOST', 'boost'); held(812, 'JUMP', 'jump'); held(898, 'HIT', 'attack');
      // SHOVE stacks above HIT so every existing button keeps its position and
      // the bottom row stays clear of the hint bar.
      held(898, 'SHOVE', 'push', SCREEN_H - 43 - 76);
      this.speed.setPosition(30, SCREEN_H - 104);
      this.surfaceTag.setPosition(30, SCREEN_H - 122); // above the pace readout: the steer buttons sit below it
      helpBg.setSize(420, 30);
    } else {
      this.text(30, SCREEN_H - 42, 'ARROWS / A D  STEER', 10, UI.panel, true);
      // Two short lines keep this clear of the centred hint bar.
      this.text(SCREEN_W - 30, SCREEN_H - 50, 'SPACE / W  JUMP    SHIFT / S  BOOST', 10, UI.panel, true).setOrigin(1, 0);
      this.text(SCREEN_W - 30, SCREEN_H - 35, 'F / K  HIT    G / L  SHOVE', 10, UI.panel, true).setOrigin(1, 0);
    }

    this.pauseOverlay = scene.add.container(0, 0).setDepth(11000).setVisible(false);
    // Keep the shade visual-only. Phaser sorts overlapping input targets by
    // the previous camera renderList, so an overlay shown and clicked before
    // its first render must not let an unrendered shade steal a button press.
    // Ordinary race controls are explicitly disabled while this is visible.
    const shade = scene.add.rectangle(SCREEN_W / 2, SCREEN_H / 2, SCREEN_W, SCREEN_H, UI.panel, 0.78);
    const panel = scene.add.rectangle(SCREEN_W / 2, SCREEN_H / 2, 510, 354, UI.panel, 1).setStrokeStyle(2, UI.panelEdge);
    const heading = scene.add.text(SCREEN_W / 2, 140, 'TAKE A BREATHER', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '30px', fontStyle: 'bold', color: hex(UI.inkHigh) }).setOrigin(0.5);
    const sub = scene.add.text(SCREEN_W / 2, 181, 'The mountain can wait. Your race is frozen.', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '13px', color: hex(UI.inkMid) }).setOrigin(0.5);
    const controls = scene.add.text(SCREEN_W / 2, 217, this.touch ? 'HOLD ‹ ›  carve     TAP JUMP     TAP HIT     TAP SHOVE     HOLD BOOST' : 'A D / ← →  carve  SPACE  jump  F / K  hit  G / L  shove  SHIFT  boost', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', color: hex(UI.inkLow) }).setOrigin(0.5);
    this.pauseOverlay.add([shade, panel, heading, sub, controls]);
    for (const [label, y, callback] of [
      [this.touch ? 'RESUME' : 'RESUME   ESC / P', 267, actions.resume],
      [this.touch ? 'RETRY MOUNTAIN' : 'RETRY MOUNTAIN   R', 321, actions.restart],
      ['BACK TO LODGE', 375, actions.menu]
    ] as const) {
      const b = scene.add.rectangle(SCREEN_W / 2, y, 340, 40, UI.panelEdge).setInteractive({ useHandCursor: true });
      const t = scene.add.text(SCREEN_W / 2, y, label, { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '15px', color: hex(UI.inkHigh), fontStyle: 'bold' }).setOrigin(0.5);
      this.bindButton(b, callback);
      this.pauseOverlay.add([b, t]);
    }
    this.pauseOverlay.add(scene.add.text(SCREEN_W / 2, 426, 'Clean hits, shoves, close calls and landings build Flow. Damage breaks it.', {
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px', color: hex(UI.inkLow)
    }).setOrigin(0.5));
    this.objects.push(this.pauseOverlay);
  }

  private text(x: number, y: number, value: string, size: number, color: number, bold = false): Phaser.GameObjects.Text {
    const t = this.scene.add.text(x, y, value, { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: `${size}px`, color: hex(color), fontStyle: bold ? 'bold' : 'normal' }).setDepth(10002);
    this.objects.push(t);
    return t;
  }

  private button(x: number, y: number, width: number, height: number, label: string, action: () => void, fontSize: number): Phaser.GameObjects.Text {
    const b = this.scene.add.rectangle(x, y, width, height, UI.panelEdge).setDepth(10003).setInteractive({ useHandCursor: true });
    const t = this.text(x, y, label, fontSize, UI.inkHigh, true).setOrigin(0.5).setDepth(10004);
    if (this.touch) b.setInteractive(new Phaser.Geom.Rectangle(-10, -18, width + 20, height + 36), Phaser.Geom.Rectangle.Contains);
    this.bindButton(b, action);
    this.objects.push(b);
    this.raceControls.push(b);
    return t;
  }

  private bindButton(button: Phaser.GameObjects.Rectangle, action: () => void): void {
    let pressedPointer: number | null = null;
    this.cancelButtons.push(() => { pressedPointer = null; button.setFillStyle(UI.panelEdge); });
    button.on('pointerover', () => button.setFillStyle(0x38536a));
    button.on('pointerout', (pointer: Phaser.Input.Pointer) => {
      if (pressedPointer === pointer.id) pressedPointer = null;
      if (pressedPointer === null) button.setFillStyle(UI.panelEdge);
    });
    button.on('pointerdown', (pointer: Phaser.Input.Pointer) => { if (pressedPointer === null && isAppActive(this.scene.game)) { pressedPointer = pointer.id; button.setFillStyle(0x38536a); } });
    button.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (pressedPointer !== pointer.id) return;
      const activate = !pointer.wasCanceled && pointer.event?.type !== 'touchcancel' && pointer.event?.type !== 'pointercancel' && isAppActive(this.scene.game);
      pressedPointer = null;
      button.setFillStyle(UI.panelEdge);
      if (activate) action();
    });
  }

  showMessage(text: string, color: number = UI.accentWarn): void {
    this.message.setText(text).setColor(hex(color)).setAlpha(1);
    this.messageMs = 1500;
  }

  /** Entry cue for a new riding surface (e.g. "POWDER · JUMP IT"), shown a little
   *  longer than an ordinary message because it is advice about the next few seconds. */
  showSurfaceCue(text: string): void {
    this.surfaceCue.setText(text);
    this.surfaceCueMs = 2400;
  }

  tick(delta: number): void {
    this.messageMs = Math.max(0, this.messageMs - delta);
    this.message.setAlpha(Math.min(1, this.messageMs / 350));
    this.surfaceCueMs = Math.max(0, this.surfaceCueMs - delta);
    this.surfaceCue.setAlpha(Math.min(1, this.surfaceCueMs / 400));
  }

  setPaused(paused: boolean): void {
    // Hidden/disabled objects cannot receive the release that follows a
    // keyboard interruption. Forget owned presses before changing visibility.
    this.cancelInput();
    this.pauseOverlay.setVisible(paused);
    for (const control of this.raceControls) {
      if (control.input) control.input.enabled = !paused;
    }
  }
  setPracticeComplete(): void {
    this.setPaused(true);
    this.pauseOverlay.setVisible(false);
    for (const child of this.pauseOverlay.list) if (child.input) child.input.enabled = false;
  }
  cancelInput(): void {
    this.cancelButtons.forEach(cancel => cancel());
    this.releaseTouchControls.forEach(release => release());
  }
  setCountdown(label: string): void { this.countdown.setText(label); }
  /** Start-line rival taunt: name + colour chip on one row, quote beneath. Null hides it. */
  setTaunt(taunt: { name: string; tag: string; color: number; text: string } | null): void {
    this.taunt.setVisible(!!taunt);
    if (!taunt) return;
    this.tauntName.setText(`${taunt.name}  ·  ${taunt.tag}`);
    this.tauntLine.setText(`“${taunt.text}”`);
    const width = Math.min(SCREEN_W - 64, Math.max(this.tauntLine.width, this.tauntName.width + 24) + 40);
    this.tauntPlate.setSize(width, 58);
    this.tauntChip.setFillStyle(taunt.color).setPosition(-width / 2 + 22, -14);
    this.tauntName.setPosition(-width / 2 + 36, -14);
    this.tauntLine.setPosition(-width / 2 + 20, 11);
  }
  setMuted(muted: boolean): void { this.muteLabel.setText(this.touch ? (muted ? 'MUTED' : 'SOUND') : (muted ? 'M MUTED' : 'M SOUND')); }

  /** Boost bar: fill + a tick at the minimum-to-start level + text, so the
   *  state never depends on colour alone. */
  private drawBoost(g: Phaser.GameObjects.Graphics, boost: HudState['boost']): void {
    const b = boost ?? { value: 0, active: false, ready: false };
    const x = BOOST_BAR_X, y = this.speed.y + 14, w = BOOST_BAR_W, h = 10;
    this.boostLabel.setY(y - 17);
    this.boostCue.setY(y - 17);
    g.fillStyle(UI.panel, 0.88).fillRoundedRect(x - 3, y - 3, w + 6, h + 6, 4);
    g.fillStyle(UI.panelEdge).fillRect(x, y, w, h);
    const fill = w * Phaser.Math.Clamp(b.value / BOOST_MAX, 0, 1);
    if (fill > 0) g.fillStyle(b.active ? UI.accentWarn : b.ready ? UI.accentGood : UI.accentInfo).fillRect(x, y, fill, h);
    const tickX = x + w * (BOOST_MIN_TO_START / BOOST_MAX);
    g.fillStyle(UI.inkHigh).fillRect(Math.round(tickX) - 1, y - 3, 2, h + 6);
    this.boostLabel.setText(`BOOST ${Math.floor(b.value)}`);
    this.boostCue.setText(b.active ? 'BOOSTING' : b.ready ? (this.touch ? 'HOLD BOOST' : 'HOLD SHIFT') : '');
  }

  /** Weapon slot and shield: an icon, a word and (for the pole) a charge count,
   *  so what is held never depends on colour. */
  private drawHeld(g: Phaser.GameObjects.Graphics, s: HudState): void {
    const pole = s.charges > 0;
    const snowball = !pole && !!s.snowball;
    const shield = !!s.shield;
    this.weaponText.setText(pole ? `POLE ×${s.charges}` : snowball ? 'SNOWBALL' : '').setVisible(pole || snowball);
    this.shieldText.setVisible(shield);
    if (!pole && !snowball && !shield) return;
    g.fillStyle(UI.panel, 0.9).fillRoundedRect(HELD_X, HELD_Y, HELD_W, HELD_H, 8);
    const cy = HELD_Y + HELD_H / 2;
    if (pole) {
      const x = HELD_X + 16;
      g.lineStyle(3, UI.inkHigh).lineBetween(x - 6, cy + 8, x + 6, cy - 8).lineBetween(x + 6, cy + 8, x - 6, cy - 8);
      g.fillStyle(UI.accentWarn).fillRect(x - 8, cy + 3, 5, 3).fillRect(x + 3, cy + 3, 5, 3);
    } else if (snowball) {
      const x = HELD_X + 16;
      g.fillStyle(UI.inkHigh).fillCircle(x, cy, 8);
      g.lineStyle(2, UI.accentInfo).strokeCircle(x, cy, 8);
    }
    if (shield) {
      const x = HELD_X + 116;
      g.fillStyle(UI.accentInfo).beginPath();
      g.moveTo(x - 8, cy - 9).lineTo(x + 8, cy - 9).lineTo(x + 8, cy).lineTo(x, cy + 10).lineTo(x - 8, cy).closePath();
      g.fillPath();
      g.fillStyle(UI.panel).fillRect(x - 1.5, cy - 5, 3, 8);
    }
  }

  /** Warning-triangle icon + text on a solid plate: shape and words, not colour alone. */
  private drawLastChance(g: Phaser.GameObjects.Graphics): void {
    const x = LAST_CHANCE_X, y = LAST_CHANCE_Y, h = 24;
    g.fillStyle(UI.accentWarn).fillRoundedRect(x, y, LAST_CHANCE_W, h, 6);
    g.lineStyle(2, UI.panel).strokeRoundedRect(x, y, LAST_CHANCE_W, h, 6);
    g.fillStyle(UI.panel).fillTriangle(x + 14, y + 4, x + 5, y + 20, x + 23, y + 20);
    g.fillStyle(UI.accentWarn).fillRect(x + 13, y + 9, 2, 6).fillRect(x + 13, y + 17, 2, 2);
  }

  update(s: HudState): void {
    this.place.setText(`${s.position}${['', 'ST', 'ND', 'RD', 'TH', 'TH'][s.position]} / ${s.riderCount ?? 5}`);
    this.clock.setText(formatTime(s.elapsedMs / 1000));
    this.score.setText(Math.round(s.score).toLocaleString('en-US'));
    this.speed.setText(`${Math.round(s.speed * 100)}%  PACE`);
    // A surface that caps pace says so in words next to the readout it changes.
    this.surfaceTag.setText(s.surface
      ? `${SURFACE_LABELS[s.surface]} · ${s.airborne ? 'AIRBORNE · NO DRAG' : `PACE CAPPED ${Math.round(surfaceSpeedFactor(s.surface) * 100)}%`}`
      : '');
    this.progress.setText(`${s.modeLabel ?? 'MOUNTAIN RUN'}   ${Math.min(100, Math.floor(s.progress * 100))}%`);
    this.section.setText(s.sectionName ?? '');
    this.split.setText(s.ghostSplit ?? '');
    this.lessonBg.setVisible(!!s.practice);
    this.lesson.setText(s.practice ? `${s.practice.title}\n${s.practice.instruction}\n${s.practice.feedback}` : '');
    const hit = this.touch ? 'TAP HIT' : 'F / K  HIT';
    const shove = this.touch ? 'SHOVE' : 'G / L  SHOVE';
    const text = s.counterReady ? `${this.touch ? 'TAP HIT' : 'F / K'}  COUNTER NOW!` : s.incomingAttack ? `${s.incomingAttack} · JUMP OR CARVE NOW` : s.recovering ? 'RECOVERING · GET READY TO CARVE' : s.airborne ? 'AIRBORNE · STICK THE LANDING'
      : s.push && s.pushHazard ? `${shove} · ${s.pushHazard === 'tree' ? 'TREE' : 'ROCK'} AHEAD !`
      : s.target && s.attackCooldown <= 0 ? (s.targetAdvantage ? `${hit} · ${shove}` : `FASTER RIVAL · ${shove} ALWAYS LANDS`)
      : s.push ? `${shove} · HIT RECHARGING`
      : s.attackCooldown > 0 || (s.pushCooldown ?? 0) > 0 ? (s.attackCooldown > 0 && (s.pushCooldown ?? 0) > 0 ? 'HIT + SHOVE RECHARGING' : s.attackCooldown > 0 ? 'HIT RECHARGING' : 'SHOVE RECHARGING')
      : s.throwTarget && s.attackCooldown <= 0 ? `${this.touch ? 'TAP HIT' : 'F / K'} · THROW SNOWBALL`
      : s.charges > 0 ? `POLE ARMED · ${s.charges} HITS · SHOVES PUSH 2 LANES`
      : s.snowball ? 'SNOWBALL READY · LINE UP A RIVAL AHEAD' : s.position === 1 ? 'LEADING · KEEP YOUR LINE CLEAN' : 'CHASE THE PACK · WATCH FOR THE AMBER MARKER';
    this.attack.setText(text);
    this.attack.setColor(hex(s.counterReady ? UI.accentGood : s.incomingAttack ? UI.accentBad : s.push && s.pushHazard ? UI.accentBad : s.target ? (s.targetAdvantage ? UI.accentWarn : UI.accentBad) : s.throwTarget ? UI.accentInfo : UI.inkMid));
    this.status.setText(s.practice ? 'PRACTICE · NO RECORDS OR CUP POINTS' : s.elapsedMs < 6500 ? 'HOLD TO CARVE  ·  JUMP ROCKS  ·  DODGE TREES  ·  HIT RIVALS' : s.progress > 0.9 ? 'FINAL STRETCH · BRING IT HOME' : '');
    this.chain.setText(s.chain >= 2 ? `${s.chain} EVENT FLOW` : '');
    const g = this.graphics.clear();
    const x = 234, y = 51, w = 482;
    g.fillStyle(UI.panelEdge).fillRoundedRect(x, y, w, 7, 3);
    g.fillStyle(UI.accentInfo).fillRoundedRect(x, y, Math.max(3, w * s.progress), 7, 3);
    for (const r of s.rivals) {
      if (r.out) continue;
      const rx = x + w * Phaser.Math.Clamp(r.progress, 0, 1);
      g.fillStyle(r.color).fillCircle(rx, y + 3, 3);
    }
    const px = x + w * s.progress;
    g.fillStyle(UI.inkHigh).fillTriangle(px, y - 5, px - 4, y - 10, px + 4, y - 10);
    this.drawHeld(g, s);
    if (s.chain >= 2) {
      g.fillStyle(UI.panelEdge, 0.55).fillRect(805, 157, 120, 4);
      g.fillStyle(UI.accentWarn).fillRect(805, 157, 120 * s.chainRemaining, 4);
    }
    this.drawBoost(g, s.boost);
    const lastChance = (s.treeStrikes ?? 0) > 0;
    this.lastChance.setVisible(lastChance);
    if (lastChance) this.drawLastChance(g);
    if (s.attackCooldown > 0) {
      g.fillStyle(UI.accentWarn).fillRect(SCREEN_W / 2 - 84, SCREEN_H - 16, 168 * (1 - s.attackCooldown), 2);
    }
    if ((s.pushCooldown ?? 0) > 0) {
      g.fillStyle(UI.accentInfo).fillRect(SCREEN_W / 2 - 84, SCREEN_H - 12, 168 * (1 - (s.pushCooldown ?? 0)), 2);
    }
  }
}
