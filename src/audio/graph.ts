import { FEEL } from '../config';

/**
 * The output stage: three buses into a master gain, a compressor, and a soft
 * clipper. Effects stacked on top of each other (a hit, a knockout and the
 * music landing on the same frame) are tamed by the compressor first; the
 * clipper then guarantees nothing reaches full scale, so a phone speaker is
 * never driven into hard digital clipping.
 */
export interface MasterChain {
  master: GainNode;
  ride: GainNode;
  sfx: GainNode;
  music: GainNode;
}

const CLIP_CEILING = 0.97;

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1.15;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (Math.tanh(k * x) / Math.tanh(k)) * CLIP_CEILING;
  }
  return curve;
}

export function buildMasterChain(ctx: BaseAudioContext, masterLevel: number = FEEL.MASTER_GAIN): MasterChain {
  const master = ctx.createGain();
  master.gain.value = masterLevel;
  const ride = ctx.createGain();
  ride.gain.value = FEEL.WIND_GAIN;
  const sfx = ctx.createGain();
  sfx.gain.value = 1;
  const music = ctx.createGain();
  music.gain.value = FEEL.MUSIC_GAIN;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 10;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = '2x';
  ride.connect(master); sfx.connect(master); music.connect(master);
  master.connect(compressor); compressor.connect(clip); clip.connect(ctx.destination);
  return { master, ride, sfx, music };
}
