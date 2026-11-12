import assert from 'node:assert/strict';
import { FEEL } from '../src/config';
import { RaceAudio } from '../src/audio/RaceAudio';

class Parameter {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}
class AudioNodeMock {
  gain = new Parameter(); frequency = new Parameter(); Q = new Parameter(); detune = new Parameter();
  threshold = new Parameter(); knee = new Parameter(); ratio = new Parameter(); attack = new Parameter(); release = new Parameter();
  curve: unknown; oversample = 'none';
  buffer: unknown; loop = false; type = ''; onended: (() => void) | null = null;
  stops = 0; disconnects = 0;
  connect() {}
  disconnect() { this.disconnects++; }
  start() {}
  stop() { this.stops++; }
}
class AudioContextMock {
  static contexts: AudioContextMock[] = [];
  state = 'suspended'; currentTime = 0; sampleRate = 44100;
  destination = {}; gains: AudioNodeMock[] = []; sources: AudioNodeMock[] = [];
  resumes = 0; suspends = 0; closes = 0; rejectResume = false;
  constructor() { AudioContextMock.contexts.push(this); }
  createGain() { const node = new AudioNodeMock(); this.gains.push(node); return node; }
  createBuffer() { return { getChannelData: () => new Float32Array(8), duration: 1.5 }; }
  createDynamicsCompressor() { return new AudioNodeMock(); }
  createWaveShaper() { return new AudioNodeMock(); }
  createBufferSource() { const node = new AudioNodeMock(); this.sources.push(node); return node; }
  createBiquadFilter() { return new AudioNodeMock(); }
  createOscillator() { const node = new AudioNodeMock(); this.sources.push(node); return node; }
  async resume() { this.resumes++; if (this.rejectResume) throw Error('gesture needed'); this.state = 'running'; }
  async suspend() { this.suspends++; this.state = 'suspended'; }
  async close() { this.closes++; this.state = 'closed'; }
}
const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: AudioContextMock });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
try {
  const audio = new RaceAudio();
  assert.equal(AudioContextMock.contexts.length, 0, 'boot creates no autoplay context');
  audio.unlock(); await settle();
  const context = AudioContextMock.contexts[0];
  assert.equal(context.state, 'running'); assert.equal(context.resumes, 1);
  audio.unlock();
  assert.equal(AudioContextMock.contexts.length, 1, 'one shared context across gestures');
  assert.equal(context.resumes, 1);
  context.state = 'interrupted';
  audio.unlock(); await settle();
  assert.equal(context.state, 'running', 'Safari interrupted state resumes');
  assert.equal(context.resumes, 2);
  audio.ride(0.8); audio.play('hit');
  // Sources 0-2 are the always-on wind, board and edge layers; everything after is an effect.
  const effects = context.sources.slice(3);
  assert.ok(effects.length > 0);
  audio.setActive(false); await settle();
  assert.equal(context.state, 'suspended');
  assert.equal(context.gains[0].gain.value, 0, 'master is immediately silent on background');
  assert.ok(context.gains.slice(4, 7).every(g => g.gain.value === 0), 'wind, board and edge cannot return from an old ride value');
  assert.ok(effects.every(source => source.stops === 2), 'old hit effects are discarded before resume');
  audio.unlock(); await settle();
  assert.equal(context.resumes, 2, 'inactive gesture cannot resume audio');
  audio.setActive(true); await settle();
  assert.equal(context.state, 'suspended', 'foreground waits for fresh gesture');
  audio.unlock(); await settle();
  assert.equal(context.state, 'running'); assert.equal(context.gains[0].gain.value, FEEL.MASTER_GAIN);
  assert.equal(audio.toggle(), true);
  assert.equal(context.gains[0].gain.value, 0);
  context.state = 'interrupted'; audio.unlock(); await settle();
  assert.equal(context.gains[0].gain.value, 0, 'mute survives interrupted recovery');
  audio.toggle(); context.state = 'suspended'; context.rejectResume = true;
  audio.unlock(); await settle();
  context.rejectResume = false; audio.unlock(); await settle();
  assert.equal(context.state, 'running', 'failed resume can retry on the next gesture');
  context.state = 'closed'; audio.unlock(); await settle();
  assert.equal(AudioContextMock.contexts.length, 2, 'closed context rebuilt only on gesture');
  const replacement = AudioContextMock.contexts[1];
  audio.destroy(); audio.destroy(); await settle();
  assert.equal(replacement.closes, 1, 'destroy is idempotent');

  // ---- Music ------------------------------------------------------------
  const music = new RaceAudio();
  music.unlock(); await settle();
  const mc = AudioContextMock.contexts.at(-1)!;
  const base = mc.sources.length;
  music.startMusic();
  assert.equal(music.musicPlaying, true, 'music starts on a running context');
  music.ride(0.5);
  const first = mc.sources.length - base;
  assert.ok(first > 0 && first < 120, `music schedules only a short way ahead (${first} sources)`);
  mc.currentTime = 600; music.ride(0.5);
  assert.ok(mc.sources.length - base - first < 120, 'a stalled loop skips ahead instead of piling up notes');
  const musicSources = mc.sources.slice(base);
  music.setFlow(7); music.ride(0.5);
  assert.equal(music.musicLevel, 2, 'flow chain 7 selects the lead level');
  music.toggleMusic(); // music off
  assert.equal(music.isMusicOn, false); assert.equal(music.musicPlaying, false);
  assert.ok(musicSources.every(source => source.stops === 2), 'music off stops every pending note');
  const afterOff = mc.sources.length;
  music.ride(0.5); music.play('hit');
  assert.ok(mc.sources.length > afterOff, 'effects still play with music off');
  assert.equal(mc.gains[0].gain.value, FEEL.MASTER_GAIN, 'music off leaves the master up');
  assert.equal(new RaceAudio().isMusicOn, false, 'the music preference persists');
  music.toggleMusic(); music.ride(0.5);
  assert.equal(music.musicPlaying, true, 'music back on resumes while the race wants it');
  music.toggle(); // mute
  music.ride(0.5);
  assert.equal(music.musicPlaying, false, 'mute silences the music too');
  music.toggle(); music.ride(0.5);
  assert.equal(music.musicPlaying, true);
  music.stopMusic();
  assert.equal(music.musicPlaying, false, 'pause / result screen stops the music');
  const stoppedAt = mc.sources.length;
  music.ride(0.5);
  assert.equal(mc.sources.length, stoppedAt, 'stopped music is not rescheduled by the frame loop');
  music.startMusic(); music.ride(0.5);
  const running = mc.sources.slice(stoppedAt);
  music.setActive(false); await settle();
  assert.equal(music.musicPlaying, false, 'background stops the music');
  assert.ok(running.every(source => source.stops === 2), 'background discards queued notes');
  music.setActive(true); music.unlock(); await settle(); music.ride(0.5);
  assert.equal(music.musicPlaying, false, 'foreground never restarts music without the race asking');
  music.startMusic(); music.ride(0.5);
  assert.equal(music.musicPlaying, true, 'the race asks again on resume');
  music.destroy();

  const racing = new RaceAudio(); racing.unlock(); racing.setActive(false); await settle();
  assert.equal(AudioContextMock.contexts.at(-1)!.state, 'suspended', 'in-flight resume cannot reopen background audio');
  racing.destroy();
  console.log('PASS audio recovery (with music): gesture-only creation, interrupted/suspended/closed contexts, immediate background silence, no stale effects, explicit gesture recovery, mute, rejected resume, teardown and in-flight resume race');
} finally {
  if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext');
}
