import Phaser from 'phaser';
import { UI } from '../render/palette';
import { oncePerKeyEvent } from '../input/keyboardEvents';
import { CANCEL_INPUT, isAppActive } from '../input/appLifecycle';

export const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;
export const FONT = 'Arial, Helvetica, sans-serif';
export const MONO = '"Courier New", monospace';

/** Cosmetic mountain names never consume the track's seeded random stream. */
export function mountainName(seed: number): string {
  const names = ['FROSTBITE', 'WHITEOUT', 'GHOST', 'IRON', 'THUNDER', 'WILD', 'NORTH', 'BLACK ICE'];
  const terrain = ['RIDGE', 'PEAK', 'GLACIER', 'SUMMIT', 'PASS', 'BASIN', 'DESCENT', 'CANYON'];
  return `${names[(seed >>> 0) % names.length]} ${terrain[(seed >>> 5) % terrain.length]}`;
}

export function menuText(
  scene: Phaser.Scene, x: number, y: number, value: string,
  size = 16, color: number = UI.inkHigh, bold = false
): Phaser.GameObjects.Text {
  return scene.add.text(x, y, value, {
    fontFamily: FONT, fontSize: `${size}px`, color: hex(color),
    fontStyle: bold ? 'bold' : 'normal'
  });
}

interface MenuFocus {
  buttons: Array<{ action: () => void; focus: (value: boolean) => void }>;
  index: number;
}
const focusByScene = new WeakMap<Phaser.Scene, MenuFocus>();

function focusState(scene: Phaser.Scene): MenuFocus {
  let state = focusByScene.get(scene);
  if (!state) {
    state = { buttons: [], index: -1 };
    focusByScene.set(scene, state);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => focusByScene.delete(scene));
  }
  return state;
}

/** A pointer/touch target with visible hover, keyboard focus and pressed states. */
export function menuButton(
  scene: Phaser.Scene, x: number, y: number, width: number,
  label: string, shortcut: string, action: () => void, primary = false
): Phaser.GameObjects.Container {
  const height = 52;
  const container = scene.add.container(x, y);
  const plate = scene.add.graphics();
  const ink = primary ? UI.panel : UI.inkHigh;
  const title = menuText(scene, 18, 26, label, 17, ink, true).setOrigin(0, 0.5);
  const key = menuText(scene, width - 15, 26, shortcut, 11, primary ? UI.panel : UI.inkMid, true)
    .setOrigin(1, 0.5).setFontFamily(MONO);
  const hit = scene.add.zone(0, 0, width, height).setOrigin(0).setInteractive({ useHandCursor: true });
  // Never let a long label collide with its keyboard shortcut.
  const available = width - 36 - (shortcut ? key.width + 18 : 0);
  if (title.width > available) title.setFontSize(Math.max(11, Math.floor(17 * available / title.width)));
  let pressedPointer: number | null = null;
  let focused = false;
  const paint = (hover = false, down = false): void => {
    plate.clear();
    plate.fillStyle(primary ? (hover ? 0xffbe4f : UI.accentWarn) : (hover ? UI.panelEdge : 0x1b2836), 1);
    plate.fillRoundedRect(0, down ? 2 : 0, width, height - (down ? 2 : 0), 5);
    plate.lineStyle(focused ? 3 : 1, focused ? UI.inkHigh : primary ? 0xffc36b : UI.panelEdge, 1);
    plate.strokeRoundedRect(0, down ? 2 : 0, width, height - (down ? 2 : 0), 5);
    if (primary && !down) {
      plate.fillStyle(0xb66b1d, 1);
      plate.fillRect(5, height - 3, width - 10, 3);
    }
  };
  paint();
  focusState(scene).buttons.push({ action, focus: value => { focused = value; paint(value); } });
  container.setName(label);
  const cancel = (): void => { pressedPointer = null; paint(); };
  scene.game.events.on(CANCEL_INPUT, cancel);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => scene.game.events.off(CANCEL_INPUT, cancel));
  hit.on('pointerover', () => paint(true, pressedPointer !== null));
  hit.on('pointerout', (pointer: Phaser.Input.Pointer) => {
    if (pressedPointer === pointer.id) pressedPointer = null;
    if (pressedPointer === null) paint();
  });
  hit.on('pointerdown', (pointer: Phaser.Input.Pointer) => { if (pressedPointer === null && isAppActive(scene.game)) { pressedPointer = pointer.id; paint(true, true); } });
  hit.on('pointerup', (pointer: Phaser.Input.Pointer) => {
    // Phaser maps touchcancel to pointerup too. A cancelled gesture must
    // never start/retry/leave a race just because the finger began here.
    if (pressedPointer !== pointer.id) return;
    const activate = !pointer.wasCanceled && pointer.event?.type !== 'touchcancel' && pointer.event?.type !== 'pointercancel' && isAppActive(scene.game);
    pressedPointer = null;
    paint(true);
    if (activate) action();
  });
  container.add([plate, title, key, hit]);
  return container;
}

/** Scene restarts must not retain shortcuts from a previous visit. */
export function menuKeys(scene: Phaser.Scene, callback: (code: string) => void): void {
  const keyboard = scene.input.keyboard;
  if (!keyboard) return;
  // Capture at the original DOM event; Phaser emits queued key events later,
  // too late for preventDefault alone to keep Tab inside the canvas menu.
  keyboard.addCapture('TAB');
  const listener = oncePerKeyEvent((event): void => {
    if (event.repeat || !isAppActive(scene.game)) return;
    const focus = focusState(scene);
    if (event.code === 'Tab') {
      event.preventDefault();
      if (focus.buttons.length) {
        if (focus.index >= 0) focus.buttons[focus.index].focus(false);
        focus.index = focus.index < 0
          ? event.shiftKey ? focus.buttons.length - 1 : 0
          : (focus.index + (event.shiftKey ? -1 : 1) + focus.buttons.length) % focus.buttons.length;
        focus.buttons[focus.index].focus(true);
      }
      return;
    }
    if ((event.code === 'Enter' || event.code === 'Space') && focus.index >= 0) {
      event.preventDefault();
      focus.buttons[focus.index].action();
      return;
    }
    callback(event.code);
  });
  keyboard.on('keydown', listener);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    keyboard.off('keydown', listener);
    keyboard.removeCapture('TAB');
  });
}

export function formatPoints(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${(Math.floor(tenths / 10) % 60).toString().padStart(2, '0')}.${tenths % 10}`;
}
