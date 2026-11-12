import type { Voice } from './voice';

/**
 * The sound palette. Every effect is a recipe: a few layers (a low body, a mid
 * knock or tone, a noise transient) written into a `Voice`. No files.
 *
 * Phone speakers reproduce almost nothing below about 300 Hz, so every recipe
 * keeps most of its character above that: the low layers are the weight, the
 * mids and the noise are what the player actually hears. `maxS` is the length
 * the recipe is meant to stay within; the measurement script enforces it.
 */
export type SoundKind =
  | 'hit' | 'poleHit' | 'counter' | 'shove' | 'throw' | 'snowImpact' | 'shieldBreak'
  | 'knockdown' | 'treeKnockout' | 'takeHit' | 'rockHit' | 'treeCrash' | 'wipeout' | 'bump'
  | 'jump' | 'trickLand' | 'land'
  | 'pickupPole' | 'pickupShield' | 'pickupWax' | 'pickupSnowball'
  | 'boostStart' | 'boostEnd' | 'go' | 'nearMiss' | 'evade' | 'flowStep';

export interface PlayOptions {
  /** Scales the whole effect. 1 is nominal. */
  intensity?: number;
  /** Flow chain length for `flowStep`: the blip climbs with it. */
  step?: number;
}

export type SoundGroup = 'Combat' | 'Hurt' | 'Movement' | 'Pickups' | 'Speed' | 'Score';

export interface SoundDef {
  label: string;
  group: SoundGroup;
  /** Intended upper bound on how long the effect is audible. */
  maxS: number;
  build: (v: Voice, o: PlayOptions) => void;
}

const bell = (v: Voice, f: number, delay: number, dur: number, peak: number): void => {
  v.tone('sine', f, f, delay, dur, peak, { attack: 0.003 });
  v.tone('sine', f * 2.76, f * 2.76, delay, dur * 0.5, peak * 0.35, { attack: 0.002 });
};

export const SOUNDS: Record<SoundKind, SoundDef> = {
  hit: {
    label: 'HIT', group: 'Combat', maxS: 0.35,
    build: v => {
      v.hit('highpass', 2400, 0, 0.02, 0.5, { q: 0.7 });
      v.tone('triangle', 440, 200, 0, 0.14, 0.7);
      v.hit('bandpass', 1400, 0, 0.14, 0.55, { f1: 700, q: 0.9 });
      v.tone('sine', 120, 55, 0, 0.14, 0.16);
    }
  },
  poleHit: {
    label: 'POLE HIT', group: 'Combat', maxS: 0.55,
    build: v => {
      v.hit('highpass', 3000, 0, 0.025, 0.6, { q: 0.7 });
      v.tone('square', 330, 140, 0, 0.12, 0.28, { lowpass: 2200 });
      v.hit('bandpass', 1800, 0, 0.12, 0.5, { f1: 900, q: 1.2 });
      bell(v, 1244, 0.01, 0.4, 0.32);
      bell(v, 1865, 0.03, 0.3, 0.2);
      v.tone('sine', 110, 50, 0, 0.16, 0.4);
    }
  },
  counter: {
    label: 'COUNTER', group: 'Combat', maxS: 0.7,
    build: v => {
      v.hit('bandpass', 500, 0, 0.14, 0.45, { f1: 3200, q: 1.6, attack: 0.04 });
      v.tone('sawtooth', 220, 560, 0, 0.14, 0.2, { lowpass: 2400, attack: 0.04 });
      v.hit('highpass', 2600, 0.14, 0.03, 0.6);
      v.tone('triangle', 300, 110, 0.14, 0.16, 0.75);
      v.hit('bandpass', 1500, 0.14, 0.16, 0.55, { f1: 800 });
      v.tone('triangle', 659, 659, 0.2, 0.3, 0.32);
      v.tone('triangle', 988, 988, 0.27, 0.36, 0.34);
      v.tone('sine', 1976, 1976, 0.27, 0.25, 0.1);
    }
  },
  shove: {
    label: 'SHOVE', group: 'Combat', maxS: 0.5,
    build: v => {
      v.hit('lowpass', 2600, 0, 0.26, 0.5, { f1: 450, q: 0.5, attack: 0.03 });
      v.tone('sine', 150, 52, 0.02, 0.24, 0.2);
      v.tone('triangle', 360, 190, 0.02, 0.22, 0.42);
      v.hit('bandpass', 900, 0.02, 0.2, 0.4, { f1: 500, q: 0.6 });
    }
  },
  throw: {
    label: 'SNOWBALL THROW', group: 'Combat', maxS: 0.4,
    build: v => {
      v.hit('highpass', 5200, 0, 0.03, 0.45);
      v.hit('bandpass', 700, 0.01, 0.15, 0.75, { f1: 3800, q: 3.5, attack: 0.02 });
      v.tone('square', 1900, 800, 0.02, 0.05, 0.12, { lowpass: 3200 });
    }
  },
  snowImpact: {
    label: 'SNOWBALL IMPACT', group: 'Combat', maxS: 0.4,
    build: v => {
      v.hit('lowpass', 3400, 0, 0.16, 0.7, { f1: 800, q: 0.4 });
      v.hit('highpass', 5200, 0, 0.05, 0.3);
      v.tone('sine', 190, 90, 0, 0.1, 0.45);
      v.tone('triangle', 420, 240, 0, 0.07, 0.3);
    }
  },
  shieldBreak: {
    label: 'SHIELD BREAK', group: 'Hurt', maxS: 0.8,
    build: v => {
      v.hit('highpass', 3500, 0, 0.2, 0.5, { q: 0.6 });
      v.tone('sine', 1500, 600, 0, 0.35, 0.34);
      for (const [f, d] of [[2093, 0.01], [2794, 0.03], [3520, 0.05], [4186, 0.02]] as const) {
        v.tone('sine', f, f * 0.9, d, 0.25 + d * 3, 0.17);
      }
      v.tone('triangle', 520, 190, 0, 0.3, 0.4);
      v.tone('sine', 900, 200, 0.03, 0.3, 0.26);
    }
  },
  knockdown: {
    label: 'KNOCKDOWN', group: 'Combat', maxS: 0.9,
    build: v => {
      v.hit('highpass', 2200, 0, 0.03, 0.7);
      v.tone('triangle', 320, 90, 0, 0.3, 0.9);
      v.hit('bandpass', 1100, 0, 0.3, 0.7, { f1: 450, q: 0.7 });
      v.tone('sine', 110, 36, 0, 0.5, 0.55);
      v.tone('sawtooth', 700, 150, 0.04, 0.4, 0.2, { lowpass: 1800 });
      v.hit('lowpass', 1500, 0.25, 0.35, 0.3, { f1: 300 });
    }
  },
  treeKnockout: {
    label: 'TREE KNOCKOUT', group: 'Combat', maxS: 1.1,
    build: v => {
      for (const d of [0, 0.035, 0.08]) v.hit('bandpass', 2200 - d * 4000, d, 0.04, 0.65, { q: 3 });
      v.tone('square', 420, 150, 0, 0.1, 0.3, { lowpass: 1800 });
      v.tone('sine', 100, 40, 0, 0.6, 0.26);
      v.tone('triangle', 380, 130, 0.02, 0.4, 0.5);
      v.hit('bandpass', 3600, 0.12, 0.5, 0.2, { f1: 1800, q: 1.4, attack: 0.08 });
      v.hit('lowpass', 1400, 0.1, 0.5, 0.3, { f1: 300 });
      bell(v, 880, 0.18, 0.4, 0.14);
    }
  },
  takeHit: {
    label: 'TAKING A HIT', group: 'Hurt', maxS: 0.55,
    build: v => {
      v.hit('highpass', 1800, 0, 0.025, 0.4);
      v.tone('sawtooth', 380, 130, 0, 0.26, 0.38, { lowpass: 1200 });
      v.tone('sine', 140, 60, 0, 0.2, 0.5);
      v.hit('lowpass', 1100, 0, 0.2, 0.55, { f1: 350 });
      v.tone('triangle', 560, 280, 0.04, 0.3, 0.2);
    }
  },
  rockHit: {
    label: 'ROCK HIT', group: 'Hurt', maxS: 0.7,
    build: v => {
      for (const d of [0, 0.09]) {
        v.hit('highpass', 2800, d, 0.025, 0.55);
        v.tone('square', 560 - d * 800, 280, d, 0.08, 0.26, { lowpass: 2600 });
        v.hit('bandpass', 2000, d, 0.1, 0.5, { f1: 900, q: 2.2 });
        v.tone('sine', 130, 60, d, 0.14, 0.5);
      }
      v.hit('lowpass', 1600, 0.12, 0.3, 0.3, { f1: 400 });
    }
  },
  treeCrash: {
    label: 'HEAVY TREE CRASH', group: 'Hurt', maxS: 1.4,
    build: v => {
      v.hit('highpass', 2000, 0, 0.04, 0.75);
      v.hit('bandpass', 2400, 0.03, 0.05, 0.55, { q: 3 });
      v.tone('triangle', 430, 120, 0, 0.5, 0.8);
      v.tone('sine', 90, 30, 0, 0.8, 0.3);
      v.hit('bandpass', 1500, 0, 0.6, 0.75, { f1: 450, q: 0.6 });
      v.hit('bandpass', 3200, 0.15, 0.6, 0.2, { f1: 1500, q: 1.2, attack: 0.1 });
      v.tone('sawtooth', 160, 70, 0.1, 0.7, 0.18, { lowpass: 700 });
    }
  },
  wipeout: {
    label: 'WIPEOUT', group: 'Hurt', maxS: 2.0,
    build: v => {
      v.hit('highpass', 2000, 0, 0.05, 0.8);
      v.tone('triangle', 450, 100, 0, 0.6, 0.85);
      v.tone('sine', 85, 28, 0, 1.0, 0.3);
      v.hit('bandpass', 1500, 0, 0.8, 0.8, { f1: 350, q: 0.6 });
      v.tone('sawtooth', 700, 70, 0.1, 1.2, 0.28, { lowpass: 1600 });
      v.hit('bandpass', 2600, 0.3, 0.9, 0.22, { f1: 700, q: 1, attack: 0.15 });
      v.tone('triangle', 330, 90, 0.8, 0.8, 0.3);
    }
  },
  bump: {
    label: 'MOGUL BUMP', group: 'Movement', maxS: 0.3,
    build: v => {
      v.tone('sine', 240, 110, 0, 0.12, 0.25);
      v.tone('triangle', 520, 300, 0, 0.1, 0.5);
      v.hit('bandpass', 900, 0, 0.12, 0.4, { f1: 450, q: 1 });
    }
  },
  jump: {
    label: 'JUMP', group: 'Movement', maxS: 0.35,
    build: v => {
      v.tone('sine', 330, 900, 0, 0.17, 0.5, { attack: 0.01 });
      v.tone('triangle', 660, 1700, 0, 0.14, 0.22, { attack: 0.01 });
      v.hit('bandpass', 700, 0, 0.2, 0.12, { f1: 1500, q: 1.2, attack: 0.04 });
      v.tone('sine', 990, 2700, 0.02, 0.12, 0.12, { attack: 0.02 });
    }
  },
  trickLand: {
    label: 'TRICK LANDING', group: 'Score', maxS: 0.9,
    build: v => {
      v.tone('sine', 180, 80, 0, 0.12, 0.45);
      v.hit('lowpass', 2800, 0, 0.12, 0.4, { f1: 900 });
      [523, 659, 784, 1047].forEach((f, i) => {
        v.tone('triangle', f, f, 0.04 + i * 0.065, 0.28, 0.34, { attack: 0.004 });
        v.tone('sine', f * 2, f * 2, 0.04 + i * 0.065, 0.2, 0.12);
      });
      v.hit('highpass', 6000, 0.2, 0.15, 0.1, { attack: 0.03 });
    }
  },
  land: {
    label: 'LANDING', group: 'Movement', maxS: 0.3,
    build: v => {
      v.tone('sine', 170, 70, 0, 0.12, 0.2);
      v.tone('triangle', 480, 260, 0, 0.1, 0.4);
      v.hit('bandpass', 1300, 0, 0.13, 0.5, { f1: 500, q: 0.7 });
    }
  },
  pickupPole: {
    label: 'PICKUP POLE', group: 'Pickups', maxS: 0.7,
    build: v => {
      bell(v, 1175, 0, 0.35, 0.4);
      bell(v, 1568, 0.09, 0.45, 0.4);
      v.hit('highpass', 5000, 0, 0.04, 0.2);
      v.tone('square', 392, 392, 0, 0.1, 0.1, { lowpass: 1800 });
    }
  },
  pickupShield: {
    label: 'PICKUP SHIELD', group: 'Pickups', maxS: 0.8,
    build: v => {
      v.tone('triangle', 392, 784, 0, 0.35, 0.34, { attack: 0.03 });
      v.tone('triangle', 396, 790, 0, 0.35, 0.3, { attack: 0.03, detune: 12 });
      v.tone('sine', 1175, 1175, 0.2, 0.4, 0.28);
      v.tone('sine', 1568, 1568, 0.27, 0.4, 0.24);
      v.hit('bandpass', 3000, 0.15, 0.4, 0.14, { f1: 5000, q: 2.5, attack: 0.1 });
    }
  },
  pickupWax: {
    label: 'PICKUP WAX', group: 'Pickups', maxS: 0.6,
    build: v => {
      v.hit('bandpass', 900, 0, 0.3, 0.5, { f1: 5200, q: 2, attack: 0.05 });
      v.tone('sawtooth', 330, 1320, 0, 0.22, 0.2, { lowpass: 3000, attack: 0.03 });
      v.tone('sine', 1760, 1760, 0.22, 0.2, 0.3);
      v.hit('highpass', 6500, 0.2, 0.1, 0.2);
    }
  },
  pickupSnowball: {
    label: 'PICKUP SNOWBALL', group: 'Pickups', maxS: 0.5,
    build: v => {
      v.tone('sine', 560, 280, 0, 0.07, 0.55);
      v.tone('triangle', 840, 420, 0, 0.06, 0.3);
      for (const d of [0.03, 0.08, 0.13]) v.hit('bandpass', 3200, d, 0.05, 0.45, { f1: 1800, q: 1.4 });
      v.hit('highpass', 5500, 0.02, 0.03, 0.3);
    }
  },
  boostStart: {
    label: 'BOOST START', group: 'Speed', maxS: 1.0,
    build: v => {
      v.tone('sine', 140, 40, 0, 0.14, 0.7);
      v.hit('highpass', 3000, 0, 0.03, 0.5);
      v.hit('bandpass', 300, 0.02, 0.5, 0.65, { f1: 3800, q: 1.2, attack: 0.15 });
      v.tone('sawtooth', 110, 440, 0.02, 0.5, 0.26, { lowpass: 2800, attack: 0.1 });
      v.tone('triangle', 880, 1760, 0.2, 0.3, 0.16, { attack: 0.1 });
    }
  },
  boostEnd: {
    label: 'BOOST END', group: 'Speed', maxS: 0.8,
    build: v => {
      v.hit('bandpass', 3400, 0, 0.5, 0.42, { f1: 450, q: 1.1, attack: 0.04 });
      v.tone('sawtooth', 380, 120, 0, 0.45, 0.2, { lowpass: 2200 });
      v.tone('triangle', 1100, 500, 0, 0.2, 0.12);
    }
  },
  go: {
    label: 'DROP IN!', group: 'Score', maxS: 1.3,
    build: v => {
      [392, 494, 587].forEach((f, i) => {
        v.tone('square', f, f, i * 0.09, 0.16, 0.2, { lowpass: 2400 });
        v.tone('triangle', f * 2, f * 2, i * 0.09, 0.2, 0.3);
      });
      for (const f of [784, 988, 1175]) {
        v.tone('square', f, f, 0.27, 0.7, 0.14, { lowpass: 3200 });
        v.tone('triangle', f, f, 0.27, 0.7, 0.2);
      }
      v.tone('sine', 98, 98, 0.27, 0.5, 0.4);
      v.hit('highpass', 4500, 0.27, 0.2, 0.3, { attack: 0.01 });
    }
  },
  nearMiss: {
    label: 'NEAR MISS', group: 'Score', maxS: 0.5,
    build: v => {
      v.hit('bandpass', 2800, 0, 0.24, 0.55, { f1: 800, q: 2.2, attack: 0.07 });
      v.tone('sine', 1400, 700, 0, 0.18, 0.25, { attack: 0.06 });
      v.tone('triangle', 1760, 1760, 0.17, 0.12, 0.2);
    }
  },
  evade: {
    label: 'EVADE', group: 'Score', maxS: 0.4,
    build: v => {
      v.tone('triangle', 880, 1480, 0, 0.1, 0.32);
      v.tone('triangle', 1480, 1480, 0.1, 0.14, 0.3);
      v.hit('highpass', 4200, 0, 0.1, 0.22, { attack: 0.02 });
    }
  },
  flowStep: {
    label: 'FLOW STEP', group: 'Score', maxS: 0.35,
    build: (v, o) => {
      const step = Math.max(1, Math.min(14, o.step ?? 3));
      const f = 660 * Math.pow(2, step / 12);
      v.tone('sine', f, f, 0, 0.16, 0.34, { attack: 0.003 });
      v.tone('triangle', f * 2, f * 2, 0, 0.12, 0.2);
      v.hit('highpass', 7000, 0, 0.02, 0.12);
    }
  }
};

export const SOUND_KINDS = Object.keys(SOUNDS) as SoundKind[];
