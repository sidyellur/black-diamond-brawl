import { STORAGE_KEYS } from '../platform/storage';
import { clone, finite, integer, localStore, object, parseStored, saveStored, type ValueStore } from './persistence';
import type { RaceOptions } from './race';
import { COURSE_VERSION, courseKey, RULES_VERSION } from './rules';

export const GHOST_VERSION = 1;
export const MAX_GHOST_SAMPLES = 2400;
export const MAX_GHOST_COURSES = 8;
export const MAX_GHOST_CHARACTERS = 1_500_000;
export const MAX_GHOST_TIME_MS = 600_000;
const SAMPLE_INTERVAL_MS = 100;
/** Cosmetic pose only. Never construct an AIRider or pass this to collisions. */
export interface GhostPose { worldZ: number; laneOffset: number; jumpHeight: number; lean: number }
/** Compact tuples keep local/native payloads small: time,z,lane,jump,lean. */
export type GhostSample = [number, number, number, number, number];
export interface GhostRecording {
  version: 1; rulesVersion: string; courseVersion: string; seed: number;
  finishZ: number; finishTimeMs: number; samples: GhostSample[];
}
function validPose(pose: GhostPose): boolean {
  return finite(pose.worldZ, 0, 1e8) && finite(pose.laneOffset, -1.5, 1.5) &&
    finite(pose.jumpHeight, 0, 1) && finite(pose.lean, -1, 1);
}
const rounded = (value: number, precision: number): number => Math.round(value * precision) / precision;
function pack(timeMs: number, pose: GhostPose): GhostSample {
  return [rounded(timeMs, 1000), rounded(pose.worldZ, 100), rounded(pose.laneOffset, 10000), rounded(pose.jumpHeight, 10000), rounded(pose.lean, 10000)];
}
function unpack(sample: GhostSample): GhostPose {
  return { worldZ: sample[1], laneOffset: sample[2], jumpHeight: sample[3], lean: sample[4] };
}
export class GhostRecorder {
  private samples: GhostSample[] = [];
  private interval = SAMPLE_INTERVAL_MS;
  private lastTime = -1;
  private invalid = false;
  private ended = false;
  constructor(private readonly seed: number, private readonly finishZ: number) {}
  /** Capture t=0 before gameplay, then after each fixed simulation tick. */
  capture(elapsedMs: number, pose: GhostPose): void {
    if (this.ended || this.invalid) return;
    if (!finite(elapsedMs, 0, MAX_GHOST_TIME_MS) || elapsedMs < this.lastTime || !validPose(pose)) { this.invalid = true; return; }
    this.lastTime = elapsedMs;
    if (this.samples.length === 0 || elapsedMs - this.samples[this.samples.length - 1][0] + 0.001 >= this.interval) this.append(pack(elapsedMs, pose));
  }
  private append(sample: GhostSample): void {
    if (this.samples.length >= MAX_GHOST_SAMPLES) {
      // Keep the entire run, progressively lowering sampling density rather
      // than dropping its start. Endpoints are explicitly appended at finish.
      this.samples = this.samples.filter((_, index) => index % 2 === 0);
      this.interval *= 2;
    }
    this.samples.push(sample);
  }
  finish(elapsedMs: number, pose: GhostPose, finished: boolean): GhostRecording | null {
    if (this.ended) return null;
    this.capture(elapsedMs, pose);
    this.ended = true;
    if (!finished || this.invalid || !finite(this.finishZ, 1, 1e8) || pose.worldZ < this.finishZ || elapsedMs <= 0 || this.samples[0]?.[0] !== 0) return null;
    const last = pack(elapsedMs, pose);
    if (last[0] === this.samples[this.samples.length - 1][0]) this.samples[this.samples.length - 1] = last;
    else this.append(last);
    return parseGhost({ version: GHOST_VERSION, rulesVersion: RULES_VERSION, courseVersion: COURSE_VERSION, seed: this.seed >>> 0,
      finishZ: this.finishZ, finishTimeMs: last[0], samples: this.samples });
  }
  get sampleCount(): number { return this.samples.length; }
}
/** Do not trust storage just because JSON.parse succeeds. */
export function parseGhost(value: unknown, expectedSeed?: number): GhostRecording | null {
  if (!object(value) || value.version !== GHOST_VERSION || value.rulesVersion !== RULES_VERSION || value.courseVersion !== COURSE_VERSION ||
      !integer(value.seed, 0, 0xffffffff) || (expectedSeed !== undefined && value.seed !== (expectedSeed >>> 0)) ||
      !finite(value.finishZ, 1, 1e8) || !finite(value.finishTimeMs, 0.001, MAX_GHOST_TIME_MS) ||
      !Array.isArray(value.samples) || value.samples.length < 2 || value.samples.length > MAX_GHOST_SAMPLES) return null;
  let previousTime = -1;
  const samples: GhostSample[] = [];
  for (const sample of value.samples) {
    if (!Array.isArray(sample) || sample.length !== 5 || !sample.every(Number.isFinite)) return null;
    const tuple = sample as GhostSample;
    if (!finite(tuple[0], 0, value.finishTimeMs) || tuple[0] <= previousTime || !validPose(unpack(tuple))) return null;
    previousTime = tuple[0];
    samples.push([...tuple]);
  }
  if (samples[0][0] !== 0 || samples[0][1] >= value.finishZ || samples[samples.length - 1][0] !== value.finishTimeMs ||
      samples[samples.length - 1][1] < value.finishZ) return null;
  return { version: GHOST_VERSION, rulesVersion: RULES_VERSION, courseVersion: COURSE_VERSION, seed: value.seed,
    finishZ: value.finishZ, finishTimeMs: value.finishTimeMs, samples };
}
export function sampleGhost(ghost: GhostRecording, elapsedMs: number): GhostPose | null {
  if (!finite(elapsedMs, 0, ghost.finishTimeMs)) return null;
  const samples = ghost.samples;
  if (elapsedMs <= samples[0][0]) return unpack(samples[0]);
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if (samples[mid][0] <= elapsedMs) low = mid; else high = mid;
  }
  const a = samples[low];
  const b = samples[high];
  const fraction = Math.max(0, Math.min(1, (elapsedMs - a[0]) / (b[0] - a[0])));
  const lerp = (index: number): number => a[index] + (b[index] - a[index]) * fraction;
  return { worldZ: lerp(1), laneOffset: lerp(2), jumpHeight: lerp(3), lean: lerp(4) };
}
/** First crossing only, including a setback and a later recrossing. */
export function ghostTimeAtZ(ghost: GhostRecording, worldZ: number): number | null {
  if (!finite(worldZ, ghost.samples[0][1], ghost.finishZ)) return null;
  if (worldZ === ghost.samples[0][1]) return 0;
  for (let index = 1; index < ghost.samples.length; index++) {
    const a = ghost.samples[index - 1];
    const b = ghost.samples[index];
    if (a[1] < worldZ && b[1] >= worldZ) return a[0] + (b[0] - a[0]) * (worldZ - a[1]) / (b[1] - a[1]);
  }
  return null;
}
export function checkpointWorldZs(startZ: number, finishZ: number): number[] {
  if (!finite(startZ) || !finite(finishZ) || finishZ <= startZ) return [];
  return [0.25, 0.5, 0.75].map(fraction => startZ + (finishZ - startZ) * fraction);
}
export interface CheckpointSplit { index: number; worldZ: number; timeMs: number; ghostTimeMs: number | null; deltaMs: number | null }
export class CheckpointTracker {
  private reached = new Set<number>();
  latest: CheckpointSplit | null = null;
  constructor(readonly positions: readonly number[]) {}
  update(previousZ: number, worldZ: number, previousMs: number, elapsedMs: number, ghost?: GhostRecording | null): CheckpointSplit[] {
    const results: CheckpointSplit[] = [];
    if (![previousZ, worldZ, previousMs, elapsedMs].every(Number.isFinite) || worldZ <= previousZ || elapsedMs < previousMs) return results;
    this.positions.forEach((checkpoint, index) => {
      if (this.reached.has(index) || previousZ >= checkpoint || worldZ < checkpoint) return;
      const timeMs = previousMs + (elapsedMs - previousMs) * (checkpoint - previousZ) / (worldZ - previousZ);
      const ghostTimeMs = ghost ? ghostTimeAtZ(ghost, checkpoint) : null;
      const split = { index, worldZ: checkpoint, timeMs, ghostTimeMs, deltaMs: ghostTimeMs === null ? null : timeMs - ghostTimeMs };
      this.reached.add(index);
      this.latest = split;
      results.push(split);
    });
    return results;
  }
}
interface SavedGhost { ghost: GhostRecording; lastUsed: number }
interface GhostStore { version: 1; recordings: Record<string, SavedGhost> }
function parseStore(value: unknown): GhostStore {
  const store: GhostStore = { version: 1, recordings: {} };
  if (!object(value) || value.version !== 1 || !object(value.recordings)) return store;
  for (const [key, item] of Object.entries(value.recordings).slice(0, MAX_GHOST_COURSES * 2)) {
    if (!object(item) || !finite(item.lastUsed, 0, 1e16)) continue;
    const ghost = parseGhost(item.ghost);
    if (ghost && key === courseKey(ghost.seed)) store.recordings[key] = { ghost, lastUsed: item.lastUsed };
  }
  return store;
}
export function createGhostStore(storage: ValueStore, now: () => number = Date.now) {
  let cache: GhostStore | null = null;
  function read(): GhostStore {
    const disk = parseStore(parseStored(storage, MAX_GHOST_CHARACTERS));
    if (!cache) cache = disk;
    else for (const [key, item] of Object.entries(disk.recordings)) {
      if (!cache.recordings[key] || item.ghost.finishTimeMs < cache.recordings[key].ghost.finishTimeMs) cache.recordings[key] = item;
    }
    trim(cache);
    return cache;
  }
  function trim(store: GhostStore, keep?: string): void {
    const keys = Object.keys(store.recordings).filter(key => key !== keep).sort((a, b) => store.recordings[b].lastUsed - store.recordings[a].lastUsed);
    if (keep) keys.unshift(keep);
    for (const key of keys.slice(MAX_GHOST_COURSES)) delete store.recordings[key];
    while (keys.length > 1 && JSON.stringify(store).length > MAX_GHOST_CHARACTERS) {
      const key = keys.pop()!;
      if (key !== keep) delete store.recordings[key];
    }
  }
  return {
    loadGhost: (seed: number): GhostRecording | null => {
      const saved = read().recordings[courseKey(seed)];
      return saved ? clone(saved.ghost) : null;
    },
    saveGhost: (options: RaceOptions, recording: GhostRecording | null): boolean => {
      if (options.mode === 'practice') return false;
      const ghost = parseGhost(recording, options.seed);
      if (!ghost) return false;
      const store = read();
      const key = courseKey(options.seed);
      const previous = store.recordings[key];
      if (previous && previous.ghost.finishTimeMs <= ghost.finishTimeMs) return false;
      store.recordings[key] = { ghost, lastUsed: Math.max(0, Math.min(1e16, now())) };
      trim(store, key);
      saveStored(storage, store);
      return true;
    }
  };
}
const ghosts = createGhostStore(localStore(STORAGE_KEYS.ghosts));
export const loadGhost = ghosts.loadGhost;
export const saveGhost = ghosts.saveGhost;
