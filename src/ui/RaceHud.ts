import Phaser from 'phaser';
import { BOOST_MAX, BOOST_MIN_TO_START, SCREEN_H, SCREEN_W, TOUCH_BUTTON, TOUCH_STEER } from '../config';
import { UI } from '../render/palette';
import { formatTime } from '../frontend/menu';
import type { InputAction } from '../entities/input';
import { STRIKE_LABELS, type StrikeKind } from '../entities/combat';
import { isAppActive } from '../input/appLifecycle';
import { SteerZoneTracker, applySteerOps, touchHitAreas, type SteerOp } from '../input/steerZones';
import type { Surface } from '../track/segment';
import { SURFACE_LABELS, surfaceTagDetail } from '../track/surface';

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
  /** What the single touch button would do on a press (`CombatSystem.strikeIntent`). */
  strike?: StrikeKind;
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
  practice?: { title: string; instruction: string; touchInstruction?: string; feedback: string };
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

/** Same rule the HUD uses for its touch layout, for scenes that word text for it. */
export function isTouchLayout(scene: Phaser.Scene): boolean {
  return scene.sys.game.device.input.touch || new URLSearchParams(location.search).has('touch');
}

/** The BOOST / JUMP / HIT faces are 72x66 translucent rounded outlines so the slope shows
 *  through; their live area is larger (see `TOUCH_BUTTON` and `touchHitAreas`). */
const TOUCH_W = TOUCH_BUTTON.FACE_W;
const TOUCH_H = TOUCH_BUTTON.FACE_H;

/** Pace readout, surface tag and boost bar in the touch layout: above the steer faces, in the
 *  empty band over the zones, so nothing of theirs sits under a thumb-sized face. */
const TOUCH_PACE_Y = 368;
const TOUCH_TAG_Y = 396;

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
  private readonly musicLabel: Phaser.GameObjects.Text;
  private readonly touch: boolean;
  private readonly helpBg: Phaser.GameObjects.Rectangle;
  private strikeLabel: Phaser.GameObjects.Text | null = null;
  private strikeKind: StrikeKind = 'none';
  private drawStrike: (() => void) | null = null;
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
    /** Toggles the music preference; returns whether music is now on. */
    music: () => boolean;
    musicOn: boolean;
    control: (action: InputAction, down: boolean, source: string) => void;
  }) {
    this.touch = isTouchLayout(scene);
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
    this.helpBg = helpBg;
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
      // Mouse + five touches: steer, BOOST held and a jump or hit are three thumbs and fingers
      // at once, and a fourth must not be dropped for want of a pointer.
      if (scene.input.manager.pointersTotal < 6) scene.input.addPointer(6 - scene.input.manager.pointersTotal);
      this.buildSteerZones(actions.control);
      const centers = [726, 812, 898];
      const areas = touchHitAreas(centers);
      const held = (index: number, label: string, action: InputAction, y = TOUCH_BUTTON.CENTER_Y) => {
        const x = centers[index], area = areas[index];
        // The input target is an invisible rectangle, bigger than the face and not overlapping
        // its neighbours; the face is a translucent rounded outline drawn over it.
        const g = scene.add.rectangle((area.left + area.right) / 2, (area.top + area.bottom) / 2, area.right - area.left, area.bottom - area.top, UI.panel, 0)
          .setDepth(10002).setInteractive();
        g.name = `touch-${action}`;
        const face = scene.add.graphics().setDepth(10002);
        const t = this.text(x, y, label, 12, UI.inkHigh, false).setOrigin(0.5).setDepth(10003).setAlpha(0.92);
        t.setStroke(hex(UI.panel), 3);
        const pointers = new Set<number>();
        const draw = () => {
          const down = pointers.size > 0;
          const shove = action === 'strike' && this.strikeKind === 'shove';
          const left = x - TOUCH_W / 2, top = y - TOUCH_H / 2;
          face.clear();
          // Resting: a faint dark wash with a thin light outline, ringed by a hairline dark edge so it
          // still reads on bright snow and ice. Pressed: a stronger wash and a bold outline.
          // SHOVE: a near-solid plate with a heavy red outline, plus the word and "!".
          face.fillStyle(UI.panel, shove ? 0.86 : down ? 0.6 : 0.16);
          face.fillRoundedRect(left, top, TOUCH_W, TOUCH_H, 14);
          face.lineStyle(1.5, UI.panel, 0.5).strokeRoundedRect(left - 1.5, top - 1.5, TOUCH_W + 3, TOUCH_H + 3, 15);
          face.lineStyle(shove ? 4 : down ? 3 : 1.5, shove ? UI.accentBad : UI.inkHigh, shove || down ? 1 : 0.7).strokeRoundedRect(left, top, TOUCH_W, TOUCH_H, 14);
          t.setAlpha(down || shove ? 1 : 0.92).setFontStyle(shove ? 'bold' : 'normal');
        };
        draw();
        const press = (p: Phaser.Input.Pointer) => {
          if (!isAppActive(scene.game)) return;
          // A stale hold under this pointer id (a release that never arrived) would swallow the press, so clear it first.
          actions.control(action, false, `touch:${p.id}`);
          pointers.add(p.id); actions.control(action, true, `touch:${p.id}`); draw();
        };
        // Only a lift lets go: a thumb that rolls or slides off the button keeps its hold. The scene
        // level events also fire when the lift lands outside the button or the canvas.
        const release = (p: Phaser.Input.Pointer) => {
          if (!pointers.delete(p.id)) return;
          actions.control(action, false, `touch:${p.id}`);
          if (pointers.size === 0) draw();
        };
        this.releaseTouchControls.push(() => {
          for (const id of pointers) actions.control(action, false, `touch:${id}`);
          pointers.clear(); draw();
        });
        g.on('pointerdown', press);
        scene.input.on('pointerup', release).on('pointerupoutside', release);
        this.objects.push(g, face, t);
        this.raceControls.push(g);
        if (action === 'strike') { this.strikeLabel = t; this.drawStrike = draw; }
      };
      // One attack button: `strike` hits, shoves into a hazard or throws, whichever
      // `CombatSystem.strikeIntent` says, and the label follows the same answer.
      held(0, 'BOOST', 'boost'); held(1, 'JUMP', 'jump'); held(2, 'HIT', 'strike');
      this.speed.setPosition(30, TOUCH_PACE_Y);
      this.surfaceTag.setPosition(30, TOUCH_TAG_Y); // under the pace readout, still above the steer faces
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
    const panel = scene.add.rectangle(SCREEN_W / 2, SCREEN_H / 2 + 15, 510, 384, UI.panel, 1).setStrokeStyle(2, UI.panelEdge);
    const heading = scene.add.text(SCREEN_W / 2, 140, 'TAKE A BREATHER', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '30px', fontStyle: 'bold', color: hex(UI.inkHigh) }).setOrigin(0.5);
    const sub = scene.add.text(SCREEN_W / 2, 181, 'The mountain can wait. Your race is frozen.', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '13px', color: hex(UI.inkMid) }).setOrigin(0.5);
    const controls = scene.add.text(SCREEN_W / 2, 217, this.touch ? 'HOLD ‹ ›  carve     TAP JUMP     TAP HIT (shoves at trees)     HOLD BOOST' : 'A D / ← →  carve  SPACE  jump  F / K  hit  G / L  shove  SHIFT  boost', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', color: hex(UI.inkLow) }).setOrigin(0.5);
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
    // Music on/off sits under the three main buttons, which keep their positions.
    const musicButton = scene.add.rectangle(SCREEN_W / 2, 418, 340, 32, 0x1b2836).setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    this.musicLabel = scene.add.text(SCREEN_W / 2, 418, '', { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '14px', color: hex(UI.inkHigh), fontStyle: 'bold' }).setOrigin(0.5);
    this.setMusic(actions.musicOn);
    this.bindButton(musicButton, () => this.setMusic(actions.music()));
    this.pauseOverlay.add([musicButton, this.musicLabel]);
    this.pauseOverlay.add(scene.add.text(SCREEN_W / 2, 454, 'Clean hits, shoves, close calls and landings build Flow. Damage breaks it.', {
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px', color: hex(UI.inkLow)
    }).setOrigin(0.5));
    this.objects.push(this.pauseOverlay);
  }

  /** Two big steer zones in the bottom-left corner. One interactive pad covers both; the finger's x
   *  (see `SteerZoneTracker`) picks left or right, so a slide across the split switches direction
   *  with no lift and a drifting thumb keeps its hold until it lifts. */
  private buildSteerZones(control: (action: InputAction, down: boolean, source: string) => void): void {
    const scene = this.scene;
    const { SPLIT_X, RIGHT_X, TOP_Y, OVERSHOOT, FACE_W, FACE_H, FACE_CENTER_Y } = TOUCH_STEER;
    const tracker = new SteerZoneTracker();
    const pad = scene.add.rectangle(-OVERSHOOT, TOP_Y, RIGHT_X + OVERSHOOT, SCREEN_H + OVERSHOOT - TOP_Y, UI.panel, 0)
      .setOrigin(0, 0).setDepth(10002).setInteractive();
    pad.name = 'steer-zone';
    const face = scene.add.graphics().setDepth(10002);
    const faces = [
      { dir: -1 as const, cx: SPLIT_X / 2 },
      { dir: 1 as const, cx: (SPLIT_X + RIGHT_X) / 2 }
    ];
    const draw = () => {
      face.clear();
      for (const { dir, cx } of faces) {
        const down = tracker.held === dir;
        const left = cx - FACE_W / 2, top = FACE_CENTER_Y - FACE_H / 2;
        // Same quiet style as the other buttons: a faint wash and thin outline, a stronger wash and bold outline when held.
        face.fillStyle(UI.panel, down ? 0.6 : 0.16).fillRoundedRect(left, top, FACE_W, FACE_H, 18);
        face.lineStyle(1.5, UI.panel, 0.5).strokeRoundedRect(left - 1.5, top - 1.5, FACE_W + 3, FACE_H + 3, 19.5);
        face.lineStyle(down ? 3.5 : 1.5, UI.inkHigh, down ? 1 : 0.7).strokeRoundedRect(left, top, FACE_W, FACE_H, 18);
        // A big chevron: dark under-stroke first so it reads on bright snow, then the light stroke.
        const reach = 15, half = 22;
        const x0 = cx - dir * reach * 0.5, x1 = cx + dir * reach * 0.5;
        face.lineStyle(11, UI.panel, down ? 0.9 : 0.55).beginPath().moveTo(x0, FACE_CENTER_Y - half).lineTo(x1, FACE_CENTER_Y).lineTo(x0, FACE_CENTER_Y + half).strokePath();
        face.lineStyle(7, UI.inkHigh, down ? 1 : 0.92).beginPath().moveTo(x0, FACE_CENTER_Y - half).lineTo(x1, FACE_CENTER_Y).lineTo(x0, FACE_CENTER_Y + half).strokePath();
      }
    };
    draw();
    const apply = (ops: SteerOp[]) => {
      applySteerOps(ops, control);
      if (ops.length) draw();
    };
    pad.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (isAppActive(scene.game)) apply(tracker.press(p.id, p.x, p.y));
    });
    // Scene-level events keep tracking a finger that leaves the pad, and see its lift wherever it lands.
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => apply(tracker.move(p.id, p.x, p.y)));
    const lift = (p: Phaser.Input.Pointer) => apply(tracker.release(p.id));
    scene.input.on('pointerup', lift).on('pointerupoutside', lift);
    this.releaseTouchControls.push(() => apply(tracker.releaseAll()));
    this.objects.push(pad, face);
    this.raceControls.push(pad);
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
  setMusic(on: boolean): void { this.musicLabel.setText(on ? 'MUSIC   ON' : 'MUSIC   OFF'); }
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
    this.surfaceTag.setText(s.surface ? `${SURFACE_LABELS[s.surface]} · ${surfaceTagDetail(s.surface, s.airborne)}` : '');
    this.progress.setText(`${s.modeLabel ?? 'MOUNTAIN RUN'}   ${Math.min(100, Math.floor(s.progress * 100))}%`);
    this.section.setText(s.sectionName ?? '');
    this.split.setText(s.ghostSplit ?? '');
    this.lessonBg.setVisible(!!s.practice);
    this.lesson.setText(s.practice ? `${s.practice.title}\n${this.touch && s.practice.touchInstruction ? s.practice.touchInstruction : s.practice.instruction}\n${s.practice.feedback}` : '');
    // The strike button's face follows the same intent the press executes.
    if (this.strikeLabel) {
      const kind = s.strike ?? 'none';
      if (kind !== this.strikeKind) { this.strikeKind = kind; this.strikeLabel.setText(STRIKE_LABELS[kind]); this.drawStrike?.(); }
    }
    // The bar only carries cues the player must act on; with nothing to act on it is hidden.
    const hit = this.touch ? 'TAP HIT' : 'F / K  HIT';
    const shove = this.touch ? 'TAP SHOVE' : 'G / L  SHOVE';
    const text = s.counterReady ? `${this.touch ? 'TAP HIT' : 'F / K'}  COUNTER NOW!` : s.incomingAttack ? `${s.incomingAttack} · JUMP OR CARVE NOW` : s.recovering ? 'RECOVERING · GET READY TO CARVE' : s.airborne ? ''
      : s.push && s.pushHazard ? `${shove} · ${s.pushHazard === 'tree' ? 'TREE' : 'ROCK'} AHEAD !`
      : s.target && s.attackCooldown <= 0 ? (this.touch ? (s.targetAdvantage ? 'TAP HIT' : 'FASTER RIVAL · HIT WILL LOSE') : s.targetAdvantage ? `${hit} · ${shove}` : `FASTER RIVAL · ${shove} ALWAYS LANDS`)
      // A shove with no hazard is a keyboard-only action (the touch button never fires it).
      : s.push && !this.touch ? `${shove} · HIT RECHARGING`
      : s.throwTarget && s.attackCooldown <= 0 ? `${this.touch ? 'TAP THROW' : 'F / K'} · THROW SNOWBALL`
      : s.charges > 0 ? `POLE ARMED · ${s.charges} HITS · SHOVES PUSH 2 LANES`
      : '';
    this.attack.setText(text);
    this.attack.setVisible(text !== '');
    this.helpBg.setVisible(text !== '');
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
