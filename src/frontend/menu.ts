import Phaser from 'phaser';
import { UI } from '../render/palette';

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

/** A pointer/touch target with visible hover and pressed states. */
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
  let pressed = false;
  const paint = (hover = false, down = false): void => {
    plate.clear();
    plate.fillStyle(primary ? (hover ? 0xffbe4f : UI.accentWarn) : (hover ? UI.panelEdge : 0x1b2836), 1);
    plate.fillRoundedRect(0, down ? 2 : 0, width, height - (down ? 2 : 0), 5);
    plate.lineStyle(1, primary ? 0xffc36b : UI.panelEdge, 1);
    plate.strokeRoundedRect(0, down ? 2 : 0, width, height - (down ? 2 : 0), 5);
    if (primary && !down) {
      plate.fillStyle(0xb66b1d, 1);
      plate.fillRect(5, height - 3, width - 10, 3);
    }
  };
  paint();
  hit.on('pointerover', () => paint(true, pressed));
  hit.on('pointerout', () => { pressed = false; paint(); });
  hit.on('pointerdown', () => { pressed = true; paint(true, true); });
  hit.on('pointerup', () => {
    const activate = pressed;
    pressed = false;
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
  const listener = (event: KeyboardEvent): void => {
    if (!event.repeat) callback(event.code);
  };
  keyboard.on('keydown', listener);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => keyboard.off('keydown', listener));
}

export function formatPoints(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${(Math.floor(tenths / 10) % 60).toString().padStart(2, '0')}.${tenths % 10}`;
}
