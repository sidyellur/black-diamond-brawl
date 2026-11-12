import { FEEL } from '../config';
import { getStoredValue, setStoredValue, STORAGE_KEYS } from '../platform/storage';
import { SOUNDS, type PlayOptions, type SoundKind } from './effects';
import { buildMasterChain, type MasterChain } from './graph';
import { flowLevelFor, MusicSequencer } from './music';
import { RideLayers, type RideState } from './ride';
import { createNoiseBuffer, Voice } from './voice';

export type { SoundKind, PlayOptions } from './effects';

/** Never let a burst of events build an unbounded number of live sources. */
const MAX_EFFECT_SOURCES = 90;

/**
 * The procedural mixer: effects, the speed/surface layers and the race music,
 * all generated in code and all activated only by a user gesture.
 *
 * Lifecycle rules (see scripts/verifyAudioRecovery.ts): nothing is created
 * before a gesture; a backgrounded or inactive app stops every pending source
 * and silences the master at once; the context only resumes on a gesture; and
 * music never restarts by itself after any of that. The race calls
 * `startMusic()` again when play resumes.
 */
export class RaceAudio {
  private context: AudioContext | null = null;
  private chain: MasterChain | null = null;
  private muted = false;
  private musicOn = true;
  private noiseBuffer: AudioBuffer | null = null;
  private rideLayers: RideLayers | null = null;
  private music: MusicSequencer | null = null;
  /** The race wants music right now (set by `startMusic`, cleared by `stopMusic` and by backgrounding). */
  private musicWanted = false;
  private active = true;
  private resumeAttempt: Promise<void> = Promise.resolve();
  private readonly effects = new Set<AudioScheduledSourceNode>();

  constructor() {
    this.muted = getStoredValue(STORAGE_KEYS.muted) === '1';
    this.musicOn = getStoredValue(STORAGE_KEYS.music) !== '0';
  }

  get isMuted(): boolean { return this.muted; }
  get isMusicOn(): boolean { return this.musicOn; }
  /** True while music notes are actually being scheduled. */
  get musicPlaying(): boolean { return !!this.music?.isRunning; }
  /** Combined level of the wind, board and edge layers; near zero when the ride sound is silent. */
  get rideLevel(): number { return this.rideLayers?.level ?? 0; }
  get isRunning(): boolean { return this.context?.state === 'running'; }

  private get masterLevel(): number { return this.muted || !this.active ? 0 : FEEL.MASTER_GAIN; }

  unlock(): void {
    if (!this.active) return;
    try {
      // A closed context cannot resume. Rebuild only on a fresh gesture.
      if (this.context?.state === 'closed') this.destroy();
      if (!this.context) {
        const context = new AudioContext();
        this.context = context;
        this.chain = buildMasterChain(context, this.masterLevel);
        this.noiseBuffer = createNoiseBuffer(context);
        this.rideLayers = new RideLayers(context, this.noiseBuffer, this.chain.ride);
        this.music = new MusicSequencer(context, this.chain.music, this.noiseBuffer);
      }
      this.chain!.master.gain.setValueAtTime(this.masterLevel, this.context.currentTime);
      // iOS Safari/WKWebView reports "interrupted" after phone calls and
      // system UI. Test for any resumable non-running state, including that
      // WebKit state even with older TypeScript DOM declarations.
      if (this.context.state !== 'running') {
        const context = this.context;
        this.resumeAttempt = context.resume().then(() => {
          // Backgrounding can race an in-flight resume request.
          if (!this.active && context.state !== 'closed') return context.suspend();
        }).catch(() => {});
      }
    } catch { /* Audio is enhancement; unsupported browsers remain playable. */ }
  }

  /** Resolves once the last resume attempt has settled (a first gesture needs this before it can play). */
  ready(): Promise<void> { return this.resumeAttempt; }

  /** Becoming active never produces audio by itself. The next user gesture
   * recovers the context, and the race still requires explicit Resume. */
  setActive(active: boolean): void {
    this.active = active;
    if (active || !this.context) return;
    const context = this.context;
    try {
      // Suspending freezes audio time. Discard short effects and queued music
      // so nothing from before the call can play when the next gesture resumes it.
      this.stopEffects();
      this.haltMusic();
      this.musicWanted = false;
      this.rideLayers?.silence(context.currentTime);
      this.chain?.master.gain.cancelScheduledValues(context.currentTime);
      this.chain?.master.gain.setValueAtTime(0, context.currentTime);
      if (context.state !== 'closed' && context.state !== 'suspended') void context.suspend().catch(() => {});
    } catch { /* Interruptions must not prevent pausing gameplay. */ }
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.chain && this.context) this.chain.master.gain.setTargetAtTime(this.masterLevel, this.context.currentTime, 0.02);
    setStoredValue(STORAGE_KEYS.muted, this.muted ? '1' : '0');
    this.unlock();
    return this.muted;
  }

  /** The music preference. Silences only the music; effects keep playing. */
  toggleMusic(): boolean {
    this.musicOn = !this.musicOn;
    setStoredValue(STORAGE_KEYS.music, this.musicOn ? '1' : '0');
    if (!this.musicOn) this.haltMusic();
    else this.syncMusic();
    return this.musicOn;
  }

  /** The race (or Sound Check) wants the loop to play. It only does when music is on, sound is not muted and the context runs. */
  startMusic(): void {
    this.musicWanted = true;
    this.syncMusic();
  }

  stopMusic(): void {
    this.musicWanted = false;
    this.haltMusic();
  }

  /** Flow chain length -> which layers play. Takes effect on the next scheduled step. */
  setFlow(chain: number): void {
    if (this.music) this.music.level = flowLevelFor(chain);
  }

  /** Sound Check: pick a layer level directly. */
  setMusicLevel(level: number): void {
    if (this.music) this.music.level = Math.max(0, Math.min(3, Math.round(level)));
  }

  get musicLevel(): number { return this.music?.level ?? 0; }

  /** Dips the music under a big moment, then lets it back. */
  duck(ms: number): void {
    const context = this.context;
    if (!context || !this.chain || !this.active) return;
    const now = context.currentTime;
    const gain = this.chain.music.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(FEEL.MUSIC_GAIN * FEEL.MUSIC_DUCK_GAIN, now, 0.03);
    gain.setTargetAtTime(FEEL.MUSIC_GAIN, now + ms / 1000, 0.2);
  }

  /** Speed, surface and board layers. Also pumps the music schedule from the frame loop. */
  ride(speed01: number, airborne = false, carving = false, boosting = false, surface?: RideState['surface']): void {
    if (!this.active || !this.context || !this.rideLayers) return;
    const now = this.context.currentTime;
    this.rideLayers.set({ speed01, airborne, carving, boosting, surface }, now);
    if (this.musicWanted) {
      if (this.musicAudible) this.syncMusic(); else this.haltMusic();
    }
  }

  play(kind: SoundKind, options: PlayOptions & { delayMs?: number } = {}): void {
    const c = this.context;
    if (!this.active || !c || !this.chain || !this.noiseBuffer || this.muted || c.state !== 'running') return;
    if (this.effects.size > MAX_EFFECT_SOURCES) return;
    const voice = new Voice(c, this.chain.sfx, this.noiseBuffer, c.currentTime + (options.delayMs ?? 0) / 1000, Math.random, 0.05, this.effects);
    voice.level = options.intensity ?? 1;
    SOUNDS[kind].build(voice, options);
    voice.seal();
  }

  destroy(): void {
    this.stopEffects();
    this.haltMusic();
    this.rideLayers?.dispose();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.context = null; this.chain = null; this.noiseBuffer = null;
    this.rideLayers = null; this.music = null;
  }

  /** Pause: drop every effect still sounding or queued (a delayed snowball impact included). */
  cutEffects(): void { this.stopEffects(); }

  private get musicAudible(): boolean {
    return this.active && this.musicOn && !this.muted && this.context?.state === 'running';
  }

  private syncMusic(): void {
    if (!this.musicWanted || !this.music || !this.context || !this.chain) return;
    if (!this.musicAudible) return;
    if (!this.music.isRunning) {
      this.chain.music.gain.cancelScheduledValues(this.context.currentTime);
      this.chain.music.gain.setValueAtTime(FEEL.MUSIC_GAIN, this.context.currentTime);
      this.music.start();
    }
    this.music.pump();
  }

  private haltMusic(): void {
    this.music?.stop();
  }

  private stopEffects(): void {
    this.effects.forEach(source => {
      try { source.stop(); source.disconnect(); } catch { /* Already ended. */ }
    });
    this.effects.clear();
  }
}

let sharedAudio: RaceAudio | null = null;
/** One audio context across menu/replay; unlock on the Drop In user gesture. */
export function getRaceAudio(): RaceAudio {
  return sharedAudio ??= new RaceAudio();
}
