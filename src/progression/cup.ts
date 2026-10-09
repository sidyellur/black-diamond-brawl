import type { AIRiderParams } from '../entities/aiRider';
import { clone, finite, integer, object, validId } from './persistence';
import { newRunId, type RaceOptions } from './race';
import { COURSE_VERSION, hashIdentity, RULES_VERSION } from './rules';

export const CUP_NAME = 'Black Diamond Cup';
export const CUP_ROUND_NAMES = ['First Tracks', 'Knife Edge', 'Summit Showdown'] as const;
export const CUP_SEEDS: readonly number[] = CUP_ROUND_NAMES.map((_, index) => hashIdentity(`BDB/cup/${COURSE_VERSION}/${index}`));
export const PLACEMENT_POINTS = [10, 7, 5, 3, 1] as const;
export const RIVALS = [
  { id: 'rival-0', name: 'NOVA', personality: 'line-defender', cruiseSpeedFactor: 0.98, aggression: 0.38, reactionDistanceSegments: 7 },
  { id: 'rival-1', name: 'SLATE', personality: 'bully', cruiseSpeedFactor: 1.02, aggression: 0.62, reactionDistanceSegments: 7 },
  { id: 'rival-2', name: 'FROST', personality: 'line-defender', cruiseSpeedFactor: 0.96, aggression: 0.25, reactionDistanceSegments: 11 },
  { id: 'rival-3', name: 'EMBER', personality: 'daredevil', cruiseSpeedFactor: 1.04, aggression: 0.72, reactionDistanceSegments: 6 }
] as const;
export const RACER_IDS = ['player', ...RIVALS.map(rival => rival.id)] as const;
export type RacerId = typeof RACER_IDS[number];
export type Medal = 'gold' | 'silver' | 'bronze';
export interface RacerSnapshot { id: RacerId; worldZ: number; finishTimeMs: number | null; wipedOut: boolean }
export interface CupRoundEntry extends RacerSnapshot { position: number; points: number }
export interface CupRound { index: number; seed: number; runId: string; results: CupRoundEntry[] }
export interface CupState {
  id: string;
  rulesVersion: string;
  courseVersion: string;
  seeds: number[];
  rounds: CupRound[];
  status: 'active' | 'complete';
  medal: Medal | null;
}
export interface CupStanding {
  id: RacerId; name: string; points: number; position: number; wins: number;
  finishedRounds: number; totalTimeMs: number;
}
export function cupRivalParams(index: number, generated: AIRiderParams): AIRiderParams {
  const rival = RIVALS[index];
  return rival ? { ...generated, name: rival.name, personality: rival.personality, cruiseSpeedFactor: rival.cruiseSpeedFactor,
    aggression: rival.aggression, reactionDistanceSegments: rival.reactionDistanceSegments, paletteIndex: index } : { ...generated };
}
export function createCup(id = newRunId('cup')): CupState {
  return { id, rulesVersion: RULES_VERSION, courseVersion: COURSE_VERSION, seeds: [...CUP_SEEDS], rounds: [], status: 'active', medal: null };
}
export function cupRace(cup: CupState): RaceOptions | null {
  if (cup.status !== 'active' || cup.rounds.length >= 3) return null;
  const roundIndex = cup.rounds.length;
  return { mode: 'cup', seed: cup.seeds[roundIndex], cupId: cup.id, roundIndex, runId: `${cup.id}:round-${roundIndex}` };
}
function racerOrder(id: RacerId): number { return RACER_IDS.indexOf(id); }
export function racerName(id: RacerId): string { return id === 'player' ? 'YOU' : RIVALS.find(rival => rival.id === id)?.name ?? id; }
function compareRacers(a: RacerSnapshot, b: RacerSnapshot): number {
  if ((a.finishTimeMs !== null) !== (b.finishTimeMs !== null)) return a.finishTimeMs !== null ? -1 : 1;
  if (a.finishTimeMs !== null && b.finishTimeMs !== null) return a.finishTimeMs - b.finishTimeMs || racerOrder(a.id) - racerOrder(b.id);
  if (a.wipedOut !== b.wipedOut) return a.wipedOut ? 1 : -1;
  return b.worldZ - a.worldZ || racerOrder(a.id) - racerOrder(b.id);
}
function validSnapshot(value: unknown): value is RacerSnapshot {
  return object(value) && RACER_IDS.includes(value.id as RacerId) && finite(value.worldZ, 0, 1e8) &&
    typeof value.wipedOut === 'boolean' && (value.finishTimeMs === null || finite(value.finishTimeMs, 0.001, 3_600_000)) &&
    !(value.wipedOut && value.finishTimeMs !== null);
}
export function rankCupRacers(racers: readonly RacerSnapshot[]): CupRoundEntry[] {
  if (racers.length !== 5 || !racers.every(validSnapshot) || new Set(racers.map(racer => racer.id)).size !== 5) return [];
  return racers.map(racer => ({ ...racer })).sort(compareRacers).map((racer, index) => ({
    ...racer, position: index + 1, points: racer.wipedOut ? 0 : PLACEMENT_POINTS[index]
  }));
}
/** Classified when the player's run ends: finish order, surviving distance,
 * then DNF distance. A DNF gets zero points; every slot keeps its identity. */
export function getCupStandings(cup: CupState): CupStanding[] {
  const standings = RACER_IDS.map(id => ({ id, name: racerName(id), points: 0, position: 0, wins: 0, finishedRounds: 0, totalTimeMs: 0 }));
  for (const round of cup.rounds) {
    for (const result of round.results) {
      const standing = standings.find(entry => entry.id === result.id)!;
      standing.points += result.points;
      if (result.position === 1 && !result.wipedOut) standing.wins++;
      if (result.finishTimeMs !== null) standing.finishedRounds++;
      // Unfinished riders receive the same bounded penalty for a stable tie.
      standing.totalTimeMs += result.finishTimeMs ?? 3_600_000;
    }
  }
  standings.sort((a, b) => b.points - a.points || b.wins - a.wins || b.finishedRounds - a.finishedRounds ||
    a.totalTimeMs - b.totalTimeMs || racerOrder(a.id) - racerOrder(b.id));
  return standings.map((entry, index) => ({ ...entry, position: index + 1 }));
}
export function cupMedal(cup: CupState): Medal | null {
  if (cup.rounds.length !== 3) return null;
  const player = getCupStandings(cup).find(entry => entry.id === 'player')!;
  return player.finishedRounds === 0 ? null : (['gold', 'silver', 'bronze'] as const)[player.position - 1] ?? null;
}
/** Pure, idempotent transition. A stale result from an abandoned/replaced cup,
 * an already committed round or a wrong seed can never score again. */
export function applyCupRound(cup: CupState, options: RaceOptions, racers: readonly RacerSnapshot[]): CupState {
  const expected = cupRace(cup);
  if (!expected || options.mode !== 'cup' || options.cupId !== expected.cupId || options.roundIndex !== expected.roundIndex ||
      options.seed !== expected.seed || options.runId !== expected.runId) return cup;
  const results = rankCupRacers(racers);
  const player = results.find(result => result.id === 'player');
  if (!player || (!player.wipedOut && player.finishTimeMs === null)) return cup;
  const next = clone(cup);
  next.rounds.push({ index: expected.roundIndex!, seed: expected.seed, runId: expected.runId, results });
  if (next.rounds.length === 3) { next.status = 'complete'; next.medal = cupMedal(next); }
  return next;
}
/** Validate by replay, never trusting saved points, rankings or medal fields. */
export function parseCup(value: unknown): CupState | null {
  if (!object(value) || !validId(value.id) || value.rulesVersion !== RULES_VERSION || value.courseVersion !== COURSE_VERSION ||
      !Array.isArray(value.seeds) || value.seeds.length !== 3 || value.seeds.some((seed, index) => seed !== CUP_SEEDS[index]) ||
      !Array.isArray(value.rounds) || value.rounds.length > 3) return null;
  let cup = createCup(value.id);
  for (const saved of value.rounds) {
    if (!object(saved) || !integer(saved.index, 0, 2) || saved.index !== cup.rounds.length ||
        saved.seed !== cup.seeds[saved.index] || !Array.isArray(saved.results) || !saved.results.every(validSnapshot)) return null;
    const options = cupRace(cup)!;
    if (saved.runId !== options.runId) return null;
    const next = applyCupRound(cup, options, saved.results);
    if (next === cup) return null;
    cup = next;
  }
  return cup;
}
