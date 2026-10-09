import { FIXED_STEP_MS } from './rules';

/** Gameplay advances in exactly 60 Hz ticks. Ignore wall-clock time while
 * paused/counting down; discardPending() prevents resume catch-up. */
export class FixedRaceClock {
  private accumulator = 0;
  private ticks = 0;
  get elapsedMs(): number { return this.ticks * FIXED_STEP_MS; }
  reset(): void { this.accumulator = 0; this.ticks = 0; }
  discardPending(): void { this.accumulator = 0; }
  advance(deltaMs: number, step: (deltaMs: number, elapsedMs: number) => void | boolean): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
    this.accumulator += Math.min(250, deltaMs);
    let steps = 0;
    while (this.accumulator + 1e-8 >= FIXED_STEP_MS && steps < 15) {
      this.accumulator = Math.max(0, this.accumulator - FIXED_STEP_MS);
      this.ticks++;
      steps++;
      if (step(FIXED_STEP_MS, this.elapsedMs) === false) { this.accumulator = 0; break; }
    }
    return steps;
  }
}
