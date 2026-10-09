import assert from 'node:assert/strict';
import { RaceAudio } from '../src/audio/RaceAudio';

class Parameter {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}
class AudioNodeMock {
  gain = new Parameter(); frequency = new Parameter();
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
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
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
  const effects = context.sources.slice(1);
  assert.ok(effects.length > 0);
  audio.setActive(false); await settle();
  assert.equal(context.state, 'suspended');
  assert.equal(context.gains[0].gain.value, 0, 'master is immediately silent on background');
  assert.equal(context.gains[1].gain.value, 0, 'wind cannot return from an old ride value');
  assert.ok(effects.every(source => source.stops === 2), 'old hit effects are discarded before resume');
  audio.unlock(); await settle();
  assert.equal(context.resumes, 2, 'inactive gesture cannot resume audio');
  audio.setActive(true); await settle();
  assert.equal(context.state, 'suspended', 'foreground waits for fresh gesture');
  audio.unlock(); await settle();
  assert.equal(context.state, 'running'); assert.equal(context.gains[0].gain.value, 0.16);
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

  const racing = new RaceAudio(); racing.unlock(); racing.setActive(false); await settle();
  assert.equal(AudioContextMock.contexts.at(-1)!.state, 'suspended', 'in-flight resume cannot reopen background audio');
  racing.destroy();
  console.log('PASS audio recovery: gesture-only creation, interrupted/suspended/closed contexts, immediate background silence, no stale effects, explicit gesture recovery, mute, rejected resume, teardown and in-flight resume race');
} finally {
  if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext');
}
