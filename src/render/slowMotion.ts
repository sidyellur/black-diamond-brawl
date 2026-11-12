import { FEEL } from '../config';

/**
 * The slow-motion beat on a knockout or a heavy crash.
 *
 * It only produces a number: the factor by which real frame time is scaled
 * before it is handed to the fixed 60 Hz clock. The clock still runs whole
 * steps and each step does exactly what it always did, so the race plays out
 * identically, only spread over more real time.
 *
 * Rules:
 *  - a request waits out the simulation's own hit-stop, so the freeze and the
 *    slow motion never overlap and stretch each other;
 *  - a request inside the cooldown of the previous beat is dropped (not
 *    queued), so back-to-back knockouts cannot chain: at most `SLOWMO_MS` of
 *    slow time in any `SLOWMO_COOLDOWN_MS`;
 *  - reduced motion never starts one.
 */
export class SlowMotion {
  private pending = false;
  private pendingMs = 0;
  private active = false;
  private elapsed = 0;
  private sinceStart: number = FEEL.SLOWMO_COOLDOWN_MS;
  private current = 1;
  /** Beats started over the life of this object (for tests and tuning). */
  started = 0;

  constructor(private readonly disabled = false) {}

  /** Asks for a beat. Returns whether it was accepted. */
  request(): boolean {
    if (this.disabled || this.pending || this.active || this.sinceStart < FEEL.SLOWMO_COOLDOWN_MS) return false;
    this.pending = true;
    this.pendingMs = 0;
    return true;
  }

  get scale(): number { return this.current; }
  get isActive(): boolean { return this.active; }

  /** Advances by real elapsed time and returns the factor for this frame. */
  advance(realDeltaMs: number, simFrozen: boolean): number {
    if (!(realDeltaMs > 0)) return this.current;
    this.sinceStart += realDeltaMs;
    if (this.pending) {
      this.pendingMs += realDeltaMs;
      if (!simFrozen) {
        this.pending = false;
        this.active = true;
        this.elapsed = 0;
        this.sinceStart = 0;
        this.started++;
      } else if (this.pendingMs > 600) this.pending = false;
    }
    if (!this.active) { this.current = 1; return 1; }
    const u = this.elapsed / FEEL.SLOWMO_MS;
    const hold = FEEL.SLOWMO_HOLD_FRACTION;
    const e = u <= hold ? 0 : Math.min(1, (u - hold) / (1 - hold));
    const smooth = e * e * (3 - 2 * e);
    this.current = FEEL.SLOWMO_SCALE + (1 - FEEL.SLOWMO_SCALE) * smooth;
    this.elapsed += realDeltaMs;
    if (this.elapsed >= FEEL.SLOWMO_MS) { this.active = false; this.current = 1; }
    return this.current;
  }

  reset(): void {
    this.pending = false; this.active = false; this.current = 1;
    this.sinceStart = FEEL.SLOWMO_COOLDOWN_MS;
  }
}
