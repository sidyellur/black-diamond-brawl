export type AttackPhase = 'idle' | 'windup' | 'strike' | 'recovery';
export const RIVAL_STRIKE_MS = 120;
/** A full lane shift takes 150ms: the last 280ms is readable and achievable. */
export const EVADE_TIMING_MS = 280;
export const COUNTER_WINDOW_MS = 1100;
export const COUNTER_LANE_REACH = 1.05;
export const COUNTER_Z_REACH_FACTOR = 3.5;

export interface RivalStrike {
  readonly id: number;
  readonly targetFraction: number;
  readonly airborne: boolean;
  readonly windupMs: number;
  /** Time since the strike boundary, including a long simulation frame. */
  readonly ageMs: number;
}

/** Simulation-only timer. A pending strike survives a long frame, so rendering
 * cadence cannot erase damage or make a strike resolve twice. */
export class RivalAttack {
  phase: AttackPhase = 'idle';
  elapsedMs = 0;
  id = 0;
  targetFraction = 0;
  private airborne = false;
  private windupMs = 0;
  private recoveryMs = 0;
  private strikeConsumed = true;

  get progress(): number {
    if (this.phase === 'windup') return Math.min(1, this.elapsedMs / this.windupMs);
    if (this.phase === 'strike') return 1;
    return 0;
  }

  begin(targetFraction: number, airborne: boolean, windupMs: number, recoveryMs: number): boolean {
    if (this.phase !== 'idle' || !this.strikeConsumed) return false;
    this.id++;
    this.targetFraction = targetFraction;
    this.airborne = airborne;
    this.windupMs = windupMs;
    this.recoveryMs = recoveryMs;
    this.elapsedMs = 0;
    this.strikeConsumed = false;
    this.phase = 'windup';
    return true;
  }

  update(deltaMs: number): void {
    if (this.phase === 'idle') return;
    this.elapsedMs += Math.max(0, deltaMs);
    if (this.elapsedMs < this.windupMs) this.phase = 'windup';
    else if (this.elapsedMs < this.windupMs + RIVAL_STRIKE_MS) this.phase = 'strike';
    else if (this.elapsedMs < this.windupMs + RIVAL_STRIKE_MS + this.recoveryMs) this.phase = 'recovery';
    else this.phase = 'idle';
  }

  takeStrike(): RivalStrike | null {
    if (this.strikeConsumed || this.elapsedMs < this.windupMs) return null;
    this.strikeConsumed = true;
    return { id: this.id, targetFraction: this.targetFraction, airborne: this.airborne,
      windupMs: this.windupMs, ageMs: this.elapsedMs - this.windupMs };
  }

  /** Damage cancels an unfinished strike and enforces the same recovery. */
  interrupt(): void {
    this.strikeConsumed = true;
    if (this.phase !== 'idle') {
      this.elapsedMs = this.windupMs + RIVAL_STRIKE_MS;
      this.phase = 'recovery';
    }
  }

  cancel(): void {
    this.phase = 'idle';
    this.strikeConsumed = true;
  }
}
