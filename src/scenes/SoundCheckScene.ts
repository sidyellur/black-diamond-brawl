import Phaser from 'phaser';
import { SCREEN_W } from '../config';
import { getRaceAudio } from '../audio/RaceAudio';
import { SOUND_KINDS, SOUNDS, type SoundGroup, type SoundKind } from '../audio/effects';
import { renderMusic, renderRide, renderSound } from '../audio/render';
import { UI } from '../render/palette';
import { menuText } from '../frontend/menu';

const GROUP_COLOR: Record<SoundGroup, number> = {
  Combat: UI.accentWarn, Hurt: UI.accentBad, Movement: UI.accentInfo,
  Pickups: UI.accentGood, Speed: UI.inkHigh, Score: UI.accentGood
};
const COLS = 5;
const CELL_W = 188;
const CELL_H = 50;
const GRID_X = 14;
const GRID_Y = 62;

/**
 * Sound Check, at `?soundcheck=1`: one big button per sound effect, the music
 * with a stepper through its Flow layers, and the speed and surface layers.
 * Made so the game's owner can audition everything on a phone without having
 * to cause each event in a race, and say which sounds are wrong.
 *
 * Buttons are large because the 960x540 stage is scaled down to a phone.
 */
export class SoundCheckScene extends Phaser.Scene {
  constructor() {
    super({ key: 'SoundCheckScene' });
  }

  create(): void {
    const audio = getRaceAudio();
    this.cameras.main.setBackgroundColor(0x131c27);
    menuText(this, 16, 12, 'SOUND CHECK', 26, UI.inkHigh, true);
    menuText(this, 220, 20, 'Tap a sound. Tell us which ones are wrong.', 13, UI.inkMid);
    const status = menuText(this, 16, 396, '', 12, UI.inkMid);

    const button = (x: number, y: number, w: number, h: number, label: string, color: number, action: () => void, size = 14) => {
      const plate = this.add.rectangle(x, y, w, h, 0x1b2836).setOrigin(0, 0).setStrokeStyle(2, color, 0.9).setInteractive({ useHandCursor: true });
      const text = menuText(this, x + w / 2, y + h / 2, label, size, UI.inkHigh, true).setOrigin(0.5);
      plate.on('pointerover', () => plate.setFillStyle(0x28405a));
      plate.on('pointerout', () => plate.setFillStyle(0x1b2836));
      plate.on('pointerdown', () => { plate.setFillStyle(0x38536a); action(); });
      plate.on('pointerup', () => plate.setFillStyle(0x1b2836));
      return { plate, text };
    };
    const withAudio = (action: () => void) => () => {
      audio.unlock();
      void audio.ready().then(action);
    };

    SOUND_KINDS.forEach((kind: SoundKind, i) => {
      const def = SOUNDS[kind];
      const x = GRID_X + (i % COLS) * CELL_W;
      const y = GRID_Y + Math.floor(i / COLS) * (CELL_H + 6);
      button(x, y, CELL_W - 8, CELL_H, def.label, GROUP_COLOR[def.group], withAudio(() => {
        audio.play(kind, { step: 1 + Math.floor(Math.random() * 10) });
        status.setText(`${def.label}  (${def.group}, up to ${def.maxS.toFixed(1)}s)`);
      }), 13);
    });

    // Music row: play/stop, Flow layer stepper, ducking.
    const rowY = 416;
    let level = 0;
    let musicPlaying = false;
    const levelText = menuText(this, 0, 0, '', 14, UI.inkHigh, true).setOrigin(0.5);
    const layerNames = ['PULSE + BASS', '+ HATS', '+ LEAD', '+ SNARE, PAD'];
    const refreshLevel = () => { levelText.setText(`FLOW ${level}  ${layerNames[level]}`); audio.setMusicLevel(level); };
    const playButton = button(14, rowY, 178, 48, 'MUSIC  PLAY', UI.accentGood, withAudio(() => {
      musicPlaying = !musicPlaying;
      if (musicPlaying) { audio.startMusic(); refreshLevel(); } else audio.stopMusic();
      playButton.text.setText(musicPlaying ? 'MUSIC  STOP' : 'MUSIC  PLAY');
      status.setText(audio.isMusicOn && !audio.isMuted ? 'Music loop' : 'Music is switched off or muted: turn it on below');
    }), 14);
    button(200, rowY, 56, 48, '-', UI.inkMid, () => { level = Math.max(0, level - 1); refreshLevel(); }, 24);
    levelText.setPosition(380, rowY + 24);
    button(504, rowY, 56, 48, '+', UI.inkMid, () => { level = Math.min(3, level + 1); refreshLevel(); }, 24);
    button(570, rowY, 112, 48, 'DUCK', UI.inkMid, withAudio(() => audio.duck(900)), 14);
    const musicToggle = button(690, rowY, 130, 48, '', UI.accentInfo, () => {
      audio.toggleMusic(); paintToggles();
    }, 13);
    const soundToggle = button(828, rowY, 118, 48, '', UI.accentInfo, () => {
      audio.toggle(); paintToggles();
    }, 13);
    const paintToggles = () => {
      musicToggle.text.setText(audio.isMusicOn ? 'MUSIC: ON' : 'MUSIC: OFF');
      soundToggle.text.setText(audio.isMuted ? 'SOUND: MUTED' : 'SOUND: ON');
    };
    refreshLevel(); paintToggles();

    // Ride row: how speed and surface sound.
    const rideY = 472;
    let speed = 1;
    let surface: 'powder' | 'ice' | undefined;
    let carving = true;
    let riding = false;
    const rideButton = button(14, rideY, 148, 48, 'RIDE  START', UI.accentGood, withAudio(() => {
      riding = !riding;
      rideButton.text.setText(riding ? 'RIDE  STOP' : 'RIDE  START');
      if (!riding) audio.ride(0);
      status.setText('Wind and board follow speed and surface. Try 80, 100, 120 on snow, powder and ice.');
    }), 14);
    const speedButtons = [0.8, 1, 1.2].map((value, i) =>
      button(172 + i * 92, rideY, 86, 48, `${Math.round(value * 100)}%`, UI.inkMid, () => { speed = value; paintRide(); }, 15));
    const surfaceButtons = ([[undefined, 'SNOW'], ['powder', 'POWDER'], ['ice', 'ICE']] as const).map(([value, label], i) =>
      button(458 + i * 112, rideY, 106, 48, label, UI.inkMid, () => { surface = value; paintRide(); }, 14));
    const carveButton = button(800, rideY, 146, 48, '', UI.inkMid, () => { carving = !carving; paintRide(); }, 14);
    const paintRide = () => {
      speedButtons.forEach((b, i) => b.plate.setStrokeStyle(3, [0.8, 1, 1.2][i] === speed ? UI.accentWarn : UI.inkMid, 1));
      surfaceButtons.forEach((b, i) => b.plate.setStrokeStyle(3, [undefined, 'powder', 'ice'][i] === surface ? UI.accentWarn : UI.inkMid, 1));
      carveButton.text.setText(carving ? 'CARVING' : 'STRAIGHT');
    };
    paintRide();

    const back = menuText(this, SCREEN_W - 14, 20, 'TITLE', 14, UI.accentInfo, true).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    back.on('pointerdown', () => { audio.stopMusic(); audio.ride(0); this.scene.start('TitleScene'); });

    this.events.on(Phaser.Scenes.Events.UPDATE, () => {
      if (riding) audio.ride(speed, false, carving, speed > 1.1, surface);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => { audio.stopMusic(); audio.ride(0); });

    // The measurement script renders the same recipes offline through this handle.
    (window as unknown as { __audioLab: unknown }).__audioLab = { renderSound, renderMusic, renderRide, SOUNDS, SOUND_KINDS };
  }
}
