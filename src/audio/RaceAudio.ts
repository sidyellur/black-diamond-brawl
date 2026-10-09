/** Small procedural sound palette, activated only by a user gesture. No files or network. */
export class RaceAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private noiseBuffer: AudioBuffer | null = null;
  private wind: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  constructor() {
    try { this.muted = localStorage.getItem('bdb-muted') === '1'; } catch { /* optional storage */ }
  }

  get isMuted(): boolean { return this.muted; }

  unlock(): void {
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : 0.16;
        this.master.connect(this.context.destination);
        this.noiseBuffer = this.context.createBuffer(1, this.context.sampleRate / 2, this.context.sampleRate);
        const channel = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
        this.wind = this.context.createBufferSource();
        this.wind.buffer = this.noiseBuffer;
        this.wind.loop = true;
        this.windFilter = this.context.createBiquadFilter();
        this.windFilter.type = 'lowpass';
        this.windFilter.frequency.value = 400;
        this.windGain = this.context.createGain();
        this.windGain.gain.value = 0;
        this.wind.connect(this.windFilter); this.windFilter.connect(this.windGain);
        this.windGain.connect(this.master); this.wind.start();
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
    } catch { /* Audio is enhancement; unsupported browsers remain playable. */ }
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.16, this.context.currentTime, 0.02);
    try { localStorage.setItem('bdb-muted', this.muted ? '1' : '0'); } catch { /* optional storage */ }
    this.unlock();
    return this.muted;
  }

  /** Quiet powder/wind texture tracks motion instead of a fixed-volume loop. */
  ride(speed01: number, airborne = false, carving = false): void {
    if (!this.context || !this.windGain || !this.windFilter) return;
    const speed = Math.max(0, Math.min(1, speed01));
    const now = this.context.currentTime;
    this.windGain.gain.setTargetAtTime(speed * (airborne ? 0.10 : carving ? 0.25 : 0.14), now, 0.1);
    this.windFilter.frequency.setTargetAtTime(250 + speed * (carving ? 1700 : 700), now, 0.12);
  }

  play(kind: 'jump' | 'land' | 'hit' | 'crash' | 'pickup' | 'score' | 'go'): void {
    const c = this.context;
    if (!c || !this.master || this.muted || c.state !== 'running') return;
    const now = c.currentTime;
    const tone = (frequency: number, end: number, duration: number, delay = 0) => {
      const osc = c.createOscillator(); const gain = c.createGain();
      osc.type = kind === 'hit' || kind === 'crash' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(frequency, now + delay);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), now + delay + duration);
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.45, now + delay + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
      osc.connect(gain); gain.connect(this.master!); osc.start(now + delay); osc.stop(now + delay + duration + 0.02);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    };
    if (kind === 'pickup' || kind === 'go') {
      [392, 494, 587].forEach((f, i) => tone(f, f, 0.16, i * 0.075));
    } else if (kind === 'score') tone(740, 980, 0.10);
    else if (kind === 'jump') tone(180, 430, 0.17);
    else if (kind === 'land') tone(130, 60, 0.13);
    else {
      tone(kind === 'hit' ? 190 : 90, 32, kind === 'hit' ? 0.18 : 0.4);
      if (this.noiseBuffer) {
        const src = c.createBufferSource(); const filter = c.createBiquadFilter(); const gain = c.createGain();
        src.buffer = this.noiseBuffer; filter.type = 'lowpass'; filter.frequency.value = kind === 'hit' ? 1800 : 600;
        gain.gain.setValueAtTime(0.6, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.21);
        src.connect(filter); filter.connect(gain); gain.connect(this.master); src.start(); src.stop(now + 0.23);
        src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect(); };
      }
    }
  }

  destroy(): void {
    if (this.wind) this.wind.stop();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null; this.master = null; this.noiseBuffer = null;
    this.wind = null; this.windGain = null; this.windFilter = null;
  }
}

let sharedAudio: RaceAudio | null = null;
/** One audio context across menu/replay; unlock on the Drop In user gesture. */
export function getRaceAudio(): RaceAudio {
  return sharedAudio ??= new RaceAudio();
}
