/**
 * The continuous layers under the race: wind, the board on the snow, and on
 * ice a thin edge scrape. Levels follow speed steeply on purpose, so 80%,
 * 100% and 120% of top speed are three clearly different sounds rather than
 * three nearly identical ones. Powder damps wind and board; ice adds the edge.
 */
export interface RideState {
  speed01: number;
  airborne: boolean;
  carving: boolean;
  boosting: boolean;
  surface?: 'powder' | 'ice';
}

export interface RideTargets {
  windGain: number; windFreq: number;
  boardGain: number; boardFreq: number;
  edgeGain: number;
}

export function rideTargets(s: RideState, out: RideTargets = { windGain: 0, windFreq: 0, boardGain: 0, boardFreq: 0, edgeGain: 0 }): RideTargets {
  const sp = Math.max(0, Math.min(1.3, s.speed01));
  const powder = s.surface === 'powder';
  const ice = s.surface === 'ice';
  const air = s.airborne ? 0.7 : 1;
  const carve = s.carving ? 1.25 : 1;
  out.windGain = 0.34 * sp ** 3 * carve * air * (powder ? 0.65 : 1);
  out.windFreq = (260 + 2700 * sp ** 1.6) * (s.carving ? 1.15 : 1) * (powder ? 0.6 : 1) * (s.boosting ? 1.1 : 1);
  out.boardGain = s.airborne ? 0 : 0.3 * sp ** 2.4 * (s.carving ? 1.6 : 1) * (powder ? 0.45 : 1);
  out.boardFreq = (900 + 1500 * sp) * (powder ? 0.6 : 1);
  out.edgeGain = ice && !s.airborne ? 0.55 * sp ** 1.5 * (s.carving ? 1 : 0.35) : 0;
  return out;
}

export class RideLayers {
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly boardGain: GainNode;
  private readonly boardFilter: BiquadFilterNode;
  private readonly edgeGain: GainNode;
  /** Reused every frame so the frame loop allocates nothing. */
  private readonly targets: RideTargets = { windGain: 0, windFreq: 0, boardGain: 0, boardFreq: 0, edgeGain: 0 };

  constructor(ctx: BaseAudioContext, noise: AudioBuffer, out: AudioNode) {
    const layer = (type: BiquadFilterType, freq: number, q: number, offset: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noise; src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter); filter.connect(gain); gain.connect(out);
      src.start(0, offset);
      this.sources.push(src); this.nodes.push(src, filter, gain);
      return { filter, gain };
    };
    const wind = layer('lowpass', 400, 0.7, 0);
    const board = layer('bandpass', 1400, 0.9, 0.31);
    const edge = layer('bandpass', 5200, 7, 0.67);
    this.windGain = wind.gain; this.windFilter = wind.filter;
    this.boardGain = board.gain; this.boardFilter = board.filter;
    this.edgeGain = edge.gain;
  }

  /** `tau` is the smoothing time constant in seconds; 0 sets the values outright (offline renders). */
  set(state: RideState, now: number, tau = 0.1): void {
    const t = rideTargets(state, this.targets);
    const go = (param: AudioParam, value: number, time = tau) => {
      if (time > 0) param.setTargetAtTime(value, now, time); else param.setValueAtTime(value, now);
    };
    go(this.windGain.gain, t.windGain); go(this.windFilter.frequency, t.windFreq, tau * 1.2);
    go(this.boardGain.gain, t.boardGain); go(this.boardFilter.frequency, t.boardFreq, tau * 1.2);
    go(this.edgeGain.gain, t.edgeGain);
  }

  /** Sum of the layer gains right now (for tests: zero means the ride sound is silent). */
  get level(): number { return this.windGain.gain.value + this.boardGain.gain.value + this.edgeGain.gain.value; }

  silence(now: number): void {
    for (const gain of [this.windGain, this.boardGain, this.edgeGain]) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
    }
  }

  dispose(): void {
    for (const source of this.sources) { try { source.stop(); } catch { /* already stopped */ } }
    for (const node of this.nodes) { try { node.disconnect(); } catch { /* already gone */ } }
    this.sources.length = 0; this.nodes.length = 0;
  }
}
