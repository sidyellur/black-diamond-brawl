export type RaceMode = 'quick' | 'cup' | 'daily' | 'practice';
export interface RaceOptions {
  mode: RaceMode;
  seed: number;
  runId: string;
  dailyDate?: string;
  cupId?: string;
  /** Zero based. */
  roundIndex?: number;
}

/** Structurally accepts ScoreBreakdown without depending on renderer/entities. */
export interface RunSummary {
  finished: boolean;
  total: number;
  finishTimeSeconds: number;
  position: number;
  combatHitCount?: number;
  knockoutCount?: number;
  trickJumpCount?: number;
  nearMissCount?: number;
  maxChain?: number;
}

let sequence = 0;
export function newRunId(prefix = 'run'): string {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  return `${prefix}-${token}`;
}

export function createQuickRace(seed: number): RaceOptions {
  return { mode: 'quick', seed: seed >>> 0, runId: newRunId() };
}

/** A completed cup round cannot be retried for points. Interrupted rounds reuse
 * their persisted ID; getCupRace() supplies the next unplayed round. */
export function normalizeRaceOptions(options: RaceOptions, today = new Date().toISOString().slice(0, 10)): RaceOptions {
  // A run already in progress may finish after midnight. Starting/retrying it
  // on a later UTC date is practice and cannot replace competitive records.
  return options.mode === 'daily' && options.dailyDate !== today ? { ...options, mode: 'practice' } : { ...options };
}
export function retryRace(options: RaceOptions, today = new Date().toISOString().slice(0, 10)): RaceOptions {
  return { ...normalizeRaceOptions(options, today), runId: options.mode === 'cup' ? options.runId : newRunId() };
}

export function validRunSummary(value: RunSummary): boolean {
  return typeof value.finished === 'boolean' && Number.isFinite(value.total) && value.total >= 0 && value.total <= 1e9 &&
    Number.isFinite(value.finishTimeSeconds) && value.finishTimeSeconds >= 0 && value.finishTimeSeconds <= 3600 &&
    (!value.finished || value.finishTimeSeconds > 0) &&
    Number.isInteger(value.position) && value.position >= 1 && value.position <= 5;
}
