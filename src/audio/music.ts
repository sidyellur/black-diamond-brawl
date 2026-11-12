import { FEEL } from '../config';
import { Voice, type Rand } from './voice';

/**
 * The race loop: A minor, four bars, sixteenth-note grid. A kick pulse and a
 * bass line run the whole race (level 0). Flow adds layers on top: hats
 * (level 1), a lead arpeggio (level 2), then snare, pad and an octave lead
 * (level 3). Every layer keeps most of its energy above about 300 Hz so it
 * survives a phone speaker.
 *
 * The sequencer only ever schedules a short way ahead of the audio clock and
 * never catches up: if the frame loop stalls, the missed steps are skipped, so
 * a suspended or throttled context cannot build a pile of notes.
 */
export const MUSIC_LEVELS = 4;
export const STEPS_PER_BAR = 16;
export const LOOP_STEPS = STEPS_PER_BAR * 4;

export function flowLevelFor(chain: number): number {
  let level = 0;
  FEEL.MUSIC_FLOW_LEVELS.forEach((threshold, i) => { if (chain >= threshold) level = i; });
  return level;
}

export const stepSeconds = (): number => 60 / FEEL.MUSIC_BPM / 4;

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
// Am | F | C | G. Root (bass octave) and triad (lead octave).
const CHORDS = [
  { root: 45, triad: [69, 72, 76] },
  { root: 41, triad: [65, 69, 72] },
  { root: 48, triad: [72, 76, 79] },
  { root: 43, triad: [67, 71, 74] }
] as const;
const BASS_STEPS = [0, 2, 3, 6, 8, 10, 11, 14];
const BASS_LIFT = new Set([3, 11]);
const LEAD_STEPS = [0, 2, 4, 6, 8, 10, 12, 13, 14];
const LEAD_INDEX = [0, 1, 2, 3, 2, 1, 2, 3, 4];

/** Schedules one sixteenth-note step of the loop into `v` (a voice that starts at the step's time). */
export function buildMusicStep(v: Voice, step: number, level: number): void {
  const bar = Math.floor(step / STEPS_PER_BAR) % 4;
  const st = step % STEPS_PER_BAR;
  const chord = CHORDS[bar];
  const sec = stepSeconds();

  // Pulse: four on the floor.
  if (st % 4 === 0) {
    v.tone('sine', 165, 46, 0, 0.15, 0.55, { attack: 0.002 });
    v.tone('triangle', 420, 170, 0, 0.07, 0.6);
    v.hit('highpass', 2500, 0, 0.012, 0.3);
  }
  // Bass: rolling eighths with an octave lift.
  const bassIndex = BASS_STEPS.indexOf(st);
  if (bassIndex >= 0) {
    const note = chord.root + (BASS_LIFT.has(st) ? 12 : bassIndex === 3 || bassIndex === 6 ? 7 : 0);
    v.tone('sawtooth', hz(note + 12), hz(note + 12), 0, sec * 1.7, 0.34, { lowpass: 1700, attack: 0.004 });
    v.tone('square', hz(note + 24), hz(note + 24), 0, sec * 1.2, 0.12, { lowpass: 2200 });
    v.tone('sine', hz(note), hz(note), 0, sec * 1.7, 0.2);
  }
  if (level >= 1) {
    if (st % 2 === 0) v.hit('highpass', 7500, 0, 0.035, st % 4 === 2 ? 0.17 : 0.09);
    if (st % 4 === 2) v.hit('highpass', 6000, 0, 0.1, 0.12, { attack: 0.004 });
    if (st % 4 === 3) v.hit('highpass', 8500, 0, 0.02, 0.06);
  }
  if (level >= 2) {
    const slot = LEAD_STEPS.indexOf(st);
    if (slot >= 0) {
      const index = LEAD_INDEX[slot];
      const note = chord.triad[index % 3] + 12 * Math.floor(index / 3);
      v.tone('square', hz(note), hz(note), 0, sec * 1.8, 0.2, { lowpass: 3200, attack: 0.004 });
      if (level >= 3) v.tone('triangle', hz(note + 12), hz(note + 12), 0, sec * 1.4, 0.2);
    }
  }
  if (level >= 3) {
    if (st === 4 || st === 12) {
      v.hit('bandpass', 1900, 0, 0.14, 0.65, { q: 0.8 });
      v.hit('highpass', 3500, 0, 0.06, 0.3);
      v.tone('triangle', 280, 170, 0, 0.09, 0.4);
    }
    if (st === 0) {
      const pad = sec * STEPS_PER_BAR * 0.95;
      for (const n of chord.triad) {
        v.tone('sawtooth', hz(n - 12), hz(n - 12), 0, pad, 0.11, { lowpass: 1800, attack: 0.18, detune: -7 });
        v.tone('sawtooth', hz(n - 12), hz(n - 12), 0, pad, 0.11, { lowpass: 1800, attack: 0.18, detune: 7 });
      }
    }
  }
}

/** Plays the loop live: `pump` is called from the frame loop and schedules a short way ahead. */
export class MusicSequencer {
  private nextStep = 0;
  private nextTime = 0;
  private running = false;
  level = 0;
  private readonly active = new Set<AudioScheduledSourceNode>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly rand: Rand = Math.random
  ) {}

  get isRunning(): boolean { return this.running; }
  get pending(): number { return this.active.size; }

  start(): void {
    this.running = true;
    this.nextStep = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
  }

  pump(): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    // A stalled loop skips ahead rather than playing a burst of old steps.
    if (this.nextTime < now) {
      const skipped = Math.ceil((now - this.nextTime) / stepSeconds());
      this.nextStep += skipped;
      this.nextTime += skipped * stepSeconds();
    }
    const horizon = now + FEEL.MUSIC_LOOKAHEAD_S;
    while (this.nextTime < horizon) {
      const v = new Voice(this.ctx, this.out, this.noise, this.nextTime, this.rand, 0, this.active);
      buildMusicStep(v, this.nextStep % LOOP_STEPS, this.level);
      v.seal();
      this.nextStep++;
      this.nextTime += stepSeconds();
    }
  }

  /** Stops every pending note and the schedule. Used on pause, mute, background and the result screen. */
  stop(): void {
    this.running = false;
    this.active.forEach(source => { try { source.stop(); source.disconnect(); } catch { /* already ended */ } });
    this.active.clear();
  }
}

/** Offline: schedule `seconds` of the loop at a fixed Flow level into `out`. */
export function scheduleMusic(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, level: number, seconds: number): void {
  const sec = stepSeconds();
  for (let i = 0, t = 0.02; t < seconds; i++, t += sec) {
    const v = new Voice(ctx, out, noise, t, () => 0.5, 0);
    buildMusicStep(v, i % LOOP_STEPS, level);
    v.seal();
  }
}
