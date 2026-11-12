import { SOUNDS, type PlayOptions, type SoundKind } from './effects';
import { buildMasterChain } from './graph';
import { scheduleMusic } from './music';
import { RideLayers, type RideState } from './ride';
import { createNoiseBuffer, seededRandom, Voice } from './voice';

/**
 * Offline renders of the same recipes the game plays, through the same output
 * stage (buses, compressor, soft clipper). Used by the audio measurement
 * script, and handy for exporting WAVs to listen to. Seeded, so repeatable.
 */
const SAMPLE_RATE = 44100;

function offline(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
}

export async function renderSound(kind: SoundKind, options: PlayOptions = {}, tailSeconds = 0.3): Promise<Float32Array> {
  const def = SOUNDS[kind];
  const ctx = offline(def.maxS + tailSeconds + 0.1);
  const chain = buildMasterChain(ctx);
  const voice = new Voice(ctx, chain.sfx, createNoiseBuffer(ctx, 1.5, 7), 0.02, () => 0.5, 0);
  voice.level = options.intensity ?? 1;
  def.build(voice, options);
  voice.seal();
  return (await ctx.startRendering()).getChannelData(0).slice();
}

export async function renderMusic(level: number, seconds = 30): Promise<Float32Array> {
  const ctx = offline(seconds);
  const chain = buildMasterChain(ctx);
  scheduleMusic(ctx, chain.music, createNoiseBuffer(ctx, 1.5, 11), level, seconds);
  return (await ctx.startRendering()).getChannelData(0).slice();
}

export async function renderRide(state: RideState, seconds = 2): Promise<Float32Array> {
  const ctx = offline(seconds);
  const chain = buildMasterChain(ctx);
  const layers = new RideLayers(ctx, createNoiseBuffer(ctx, 1.5, 13), chain.ride);
  layers.set(state, 0, 0);
  const data = (await ctx.startRendering()).getChannelData(0).slice();
  layers.dispose();
  return data;
}

export const SAMPLE_RATE_HZ = SAMPLE_RATE;
export { seededRandom };
