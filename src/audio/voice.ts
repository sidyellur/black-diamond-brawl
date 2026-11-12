/**
 * Building blocks shared by the live mixer and the offline renderer.
 *
 * Everything here takes a `BaseAudioContext`, so the same recipe can run in a
 * real `AudioContext` during play and in an `OfflineAudioContext` when the
 * measurement script renders it to numbers and WAV files. Nothing here owns a
 * context or starts a timer.
 */

export const MIN_GAIN = 0.0001;
export type Rand = () => number;

/** mulberry32: a tiny seeded generator so offline renders are reproducible. */
export function seededRandom(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 1.5, seed?: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  const rand = seed === undefined ? Math.random : seededRandom(seed);
  for (let i = 0; i < channel.length; i++) channel[i] = rand() * 2 - 1;
  return buffer;
}

export interface ToneOptions {
  attack?: number;
  /** A low-pass in front of the envelope, to take the buzz off a saw or square. */
  lowpass?: number;
  detune?: number;
}
export interface NoiseOptions {
  attack?: number;
  /** Frequency the filter ends on; the filter glides exponentially from `f0`. */
  f1?: number;
  q?: number;
}

/**
 * One sound event: a handful of oscillators and noise bursts feeding `out`.
 * Every source gets exactly one scheduled stop; when the last one ends the
 * whole voice disconnects itself, and `registry` lets the mixer stop whatever
 * is still pending when the app is backgrounded.
 */
export class Voice {
  /** Overall level of this voice (an intensity from the game). */
  level = 1;
  /** One pitch multiplier per voice so repeats do not sound identical. */
  readonly pitch: number;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  /** Absolute time the last scheduled source stops. */
  end: number;

  constructor(
    readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
    readonly t0: number,
    readonly rand: Rand = Math.random,
    jitter = 0.05,
    private readonly registry?: Set<AudioScheduledSourceNode>
  ) {
    this.pitch = 1 + (rand() - 0.5) * 2 * jitter;
    this.end = t0;
  }

  /** A pitched tone whose frequency glides from `f0` to `f1` over `dur` seconds. */
  tone(type: OscillatorType, f0: number, f1: number, delay: number, dur: number, peak: number, opts: ToneOptions = {}): void {
    const { ctx } = this;
    const t = this.t0 + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * this.pitch, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * this.pitch), t + dur);
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t);
    this.envelope(gain, t, dur, peak * this.level, opts.attack ?? 0.004);
    if (opts.lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(opts.lowpass, t);
      filter.Q.value = 0.7;
      osc.connect(filter); filter.connect(gain);
      this.nodes.push(filter);
    } else osc.connect(gain);
    gain.connect(this.out);
    this.nodes.push(osc, gain);
    this.launch(osc, t, dur);
  }

  /** A burst of filtered noise. */
  hit(type: BiquadFilterType, f0: number, delay: number, dur: number, peak: number, opts: NoiseOptions = {}): void {
    const { ctx } = this;
    const t = this.t0 + delay;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = this.noise;
    filter.type = type;
    filter.Q.value = opts.q ?? 0.8;
    filter.frequency.setValueAtTime(f0, t);
    if (opts.f1 !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t + dur);
    this.envelope(gain, t, dur, peak * this.level, opts.attack ?? 0.002);
    src.connect(filter); filter.connect(gain); gain.connect(this.out);
    this.nodes.push(src, filter, gain);
    const span = Math.max(0, (this.noise.duration || 1) - dur - 0.05);
    this.launch(src, t, dur, this.rand() * span);
  }

  /** Call once, after the recipe has added everything. */
  seal(onDone?: () => void): void {
    let remaining = this.sources.length;
    if (remaining === 0) { onDone?.(); return; }
    for (const source of this.sources) {
      source.onended = () => {
        this.registry?.delete(source);
        if (--remaining > 0) return;
        for (const node of this.nodes) { try { node.disconnect(); } catch { /* already gone */ } }
        onDone?.();
      };
    }
  }

  private envelope(gain: GainNode, t: number, dur: number, peak: number, attack: number): void {
    const a = Math.min(attack, dur * 0.5);
    gain.gain.setValueAtTime(MIN_GAIN, t);
    gain.gain.linearRampToValueAtTime(Math.max(MIN_GAIN * 2, peak), t + a);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
  }

  private launch(source: AudioScheduledSourceNode, t: number, dur: number, offset?: number): void {
    if (offset === undefined) source.start(t); else (source as AudioBufferSourceNode).start(t, offset);
    source.stop(t + dur + 0.03);
    this.sources.push(source);
    this.registry?.add(source);
    this.end = Math.max(this.end, t + dur + 0.03);
  }
}
