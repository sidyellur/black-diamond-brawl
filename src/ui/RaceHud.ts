import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { UI } from '../render/palette';
import { formatTime } from '../frontend/menu';
import type { InputAction } from '../entities/input';
import { isAppActive } from '../input/appLifecycle';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export interface HudState {
  riderCount?: number;
  score: number;
  speed: number;
  position: number;
  elapsedMs: number;
  progress: number;
  charges: number;
  attackCooldown: number;
  target: boolean;
  targetAdvantage: boolean;
  airborne: boolean;
  recovering: boolean;
  chain: number;
  chainRemaining: number;
  sectionName?: string;
  modeLabel?: string;
  ghostSplit?: string;
  incomingAttack?: string;
  counterReady?: boolean;
  practice?: { title: string; instruction: string; feedback: string };
  rivals: { progress: number; color: number; out: boolean }[];
}

/** Screen-space cockpit. Every object belongs exclusively to the UI camera. */
export class RaceHud {
  readonly objects: Phaser.GameObjects.GameObject[] = [];
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly place: Phaser.GameObjects.Text;
  private readonly clock: Phaser.GameObjects.Text;
  private readonly score: Phaser.GameObjects.Text;
  private readonly speed: Phaser.GameObjects.Text;
  private readonly attack: Phaser.GameObjects.Text;
  private readonly progress: Phaser.GameObjects.Text;
  private readonly status: Phaser.GameObjects.Text;
  private readonly chain: Phaser.GameObjects.Text;
  private readonly message: Phaser.GameObjects.Text;
  private readonly pauseOverlay: Phaser.GameObjects.Container;
  private readonly countdown: Phaser.GameObjects.Text;
  private readonly section: Phaser.GameObjects.Text;
  private readonly split: Phaser.GameObjects.Text;
  private readonly lesson: Phaser.GameObjects.Text;
  private readonly lessonBg: Phaser.GameObjects.Rectangle;
  private readonly muteLabel: Phaser.GameObjects.Text;
  private readonly touch: boolean;
  private messageMs = 0;
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
    this.attack = this.text(SCREEN_W / 2, SCREEN_H - 31, '', 14, UI.inkHigh, true).setOrigin(0.5);
    const helpBg = scene.add.rectangle(SCREEN_W / 2, SCREEN_H - 30, 464, 30, UI.panel, 0.88).setDepth(9999);
    this.objects.push(helpBg);
    this.status = this.text(SCREEN_W / 2, 91, '', 13, UI.panel, true).setOrigin(0.5);
    this.chain = this.text(925, 115, '', 17, UI.panel, true).setOrigin(1, 0);
    this.message = this.text(SCREEN_W / 2, 151, '', 21, UI.accentWarn, true).setOrigin(0.5);
    this.message.setStroke(hex(UI.panel), 5);
    this.countdown = this.text(SCREEN_W / 2, SCREEN_H * 0.42, '', 72, UI.inkHigh, true).setOrigin(0.5).setStroke(hex(UI.panel), 8);
    this.section = this.text(30, 109, '', 14, UI.panel, true).setStroke('#f3f8ff', 3);
    this.split = this.text(30, 133, '', 12, UI.panel, true).setStroke('#f3f8ff', 3);
    this.lessonBg = scene.add.rectangle(SCREEN_W / 2, 231, 700, 112, UI.panel, 0.93).setDepth(10000).setVisible(false);
    this.objects.push(this.lessonBg);
    this.lesson = this.text(SCREEN_W / 2, 193, '', 16, UI.inkHigh, true).setOrigin(0.5, 0).setAlign('center').setLineSpacing(6).setWordWrapWidth(666);
    this.button(902, 77, 62, 25, 'PAUSE', actions.pause, 10);
    this.muteLabel = this.button(687, 30, 74, 23, this.touch ? 'SOUND' : 'M SOUND', () => this.setMuted(actions.mute()), 10);

    if (this.touch) {
      if (scene.input.manager.pointersTotal < 4) scene.input.addPointer(4 - scene.input.manager.pointersTotal);
      const held = (x: number, label: string, action: InputAction) => {
        const g = scene.add.rectangle(x, SCREEN_H - 43, 72, 66, UI.panel, 0.8).setStrokeStyle(2, UI.inkMid, 0.7).setDepth(10002).setInteractive();
        const t = this.text(x, SCREEN_H - 43, label, action === 'left' || action === 'right' ? 30 : 13, UI.inkHigh, true).setOrigin(0.5).setDepth(10003);
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
      held(58, '‹', 'left'); held(142, '›', 'right'); held(812, 'JUMP', 'jump'); held(898, 'HIT', 'attack');
      this.speed.setPosition(30, SCREEN_H - 104);
      helpBg.setSize(420, 30);
    } else {
      this.text(30, SCREEN_H - 42, 'ARROWS / A D  STEER', 10, UI.panel, true);
      this.text(SCREEN_W - 30, SCREEN_H - 42, 'SPACE / W  JUMP    F / K  HIT', 10, UI.panel, true).setOrigin(1, 0);
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
    const controls = scene.add.text(SCREEN_W / 2, 217, this.touch ? 'HOLD ‹ ›  carve     TAP JUMP     TAP HIT' : 'A D / ← →  carve   SPACE / W  jump   F / K  fight', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', color: hex(UI.inkLow) }).setOrigin(0.5);
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
    this.pauseOverlay.add(scene.add.text(SCREEN_W / 2, 426, 'Clean hits, close calls and landings build Flow. Damage breaks it.', {
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

  tick(delta: number): void {
    this.messageMs = Math.max(0, this.messageMs - delta);
    this.message.setAlpha(Math.min(1, this.messageMs / 350));
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
  setMuted(muted: boolean): void { this.muteLabel.setText(this.touch ? (muted ? 'MUTED' : 'SOUND') : (muted ? 'M MUTED' : 'M SOUND')); }

  update(s: HudState): void {
    this.place.setText(`${s.position}${['', 'ST', 'ND', 'RD', 'TH', 'TH'][s.position]} / ${s.riderCount ?? 5}`);
    this.clock.setText(formatTime(s.elapsedMs / 1000));
    this.score.setText(Math.round(s.score).toLocaleString('en-US'));
    this.speed.setText(`${Math.round(s.speed * 100)}%  PACE`);
    this.progress.setText(`${s.modeLabel ?? 'MOUNTAIN RUN'}   ${Math.min(100, Math.floor(s.progress * 100))}%`);
    this.section.setText(s.sectionName ?? '');
    this.split.setText(s.ghostSplit ?? '');
    this.lessonBg.setVisible(!!s.practice);
    this.lesson.setText(s.practice ? `${s.practice.title}\n${s.practice.instruction}\n${s.practice.feedback}` : '');
    this.attack.setText(s.counterReady ? `${this.touch ? 'TAP HIT' : 'F / K'}  COUNTER NOW!` : s.incomingAttack ? `${s.incomingAttack} · JUMP OR CARVE NOW` : s.recovering ? 'RECOVERING · GET READY TO CARVE' : s.airborne ? 'AIRBORNE · STICK THE LANDING' : s.attackCooldown > 0 ? 'HIT RECHARGING' : s.target ? (s.targetAdvantage ? `${this.touch ? 'TAP HIT' : 'F / K  HIT'} · YOU HAVE THE ADVANTAGE` : 'FASTER RIVAL · GAIN PACE OR USE A POLE') : s.charges > 0 ? `POLE ARMED · ${s.charges} HITS` : s.position === 1 ? 'LEADING · KEEP YOUR LINE CLEAN' : 'CHASE THE PACK · WATCH FOR THE AMBER MARKER');
    this.attack.setColor(hex(s.counterReady ? UI.accentGood : s.incomingAttack ? UI.accentBad : s.target ? (s.targetAdvantage ? UI.accentWarn : UI.accentBad) : UI.inkMid));
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
    if (s.charges > 0) for (let i = 0; i < s.charges; i++) g.fillStyle(UI.accentWarn).fillRect(872 + i * 15, 59, 9, 6);
    if (s.chain >= 2) {
      g.fillStyle(UI.panelEdge, 0.55).fillRect(805, 139, 120, 4);
      g.fillStyle(UI.accentWarn).fillRect(805, 139, 120 * s.chainRemaining, 4);
    }
    if (s.attackCooldown > 0) {
      g.fillStyle(UI.accentWarn).fillRect(SCREEN_W / 2 - 84, SCREEN_H - 16, 168 * (1 - s.attackCooldown), 2);
    }
  }
}
