import { STORAGE_KEYS } from '../platform/storage';
import { CHALLENGES, COSMETICS, cosmetic, type CosmeticSlot } from './cosmetics';
import { applyCupRound, createCup, cupRace, getCupStandings, parseCup, type CupState, type Medal, type RacerSnapshot } from './cup';
import { clone, integer, localStore, object, parseStored, saveStored, validId, type ValueStore } from './persistence';
import { newRunId, validRunSummary, type RaceOptions, type RunSummary } from './race';

export interface Career {
  version: 1;
  /** Lamport-style mutation stamps resolve stale tabs without wall-clock trust. */
  revision: number;
  mutationId: string;
  /** Changes only on start/abandon, including a persisted null-cup tombstone. */
  cupGeneration: number;
  cupMutationId: string;
  medals: Record<Medal, number>;
  challenges: string[];
  unlockedBoards: string[];
  unlockedJackets: string[];
  equipped: { board: string; jacket: string };
  cup: CupState | null;
  recentRuns: string[];
}
export interface RunAwards { newUnlocks: string[]; newChallenges: string[]; duplicate: boolean }
function empty(): Career {
  return { version: 1, revision: 0, mutationId: 'initial', cupGeneration: 0, cupMutationId: 'initial', medals: { gold: 0, silver: 0, bronze: 0 }, challenges: [],
    unlockedBoards: ['classic-board'], unlockedJackets: ['classic-jacket'],
    equipped: { board: 'classic-board', jacket: 'classic-jacket' }, cup: null, recentRuns: [] };
}
function unlock(career: Career, challengeId: string): string | null {
  const challenge = CHALLENGES.find(item => item.id === challengeId);
  if (!challenge || career.challenges.includes(challengeId)) return null;
  career.challenges.push(challengeId);
  const item = cosmetic(challenge.cosmetic)!;
  const unlocked = item.slot === 'board' ? career.unlockedBoards : career.unlockedJackets;
  if (!unlocked.includes(item.id)) unlocked.push(item.id);
  return item.id;
}
function parse(value: unknown): Career {
  const career = empty();
  if (!object(value) || value.version !== 1) return career;
  if (integer(value.revision, 0, 1e12)) career.revision = value.revision;
  if (validId(value.mutationId)) career.mutationId = value.mutationId;
  if (integer(value.cupGeneration, 0, 1e12)) career.cupGeneration = value.cupGeneration;
  if (validId(value.cupMutationId)) career.cupMutationId = value.cupMutationId;
  if (object(value.medals)) for (const medal of ['gold', 'silver', 'bronze'] as const) {
    if (integer(value.medals[medal], 0, 1e9)) career.medals[medal] = value.medals[medal];
  }
  // Reconstruct unlocks from known challenges; unknown styles never reach art.
  if (Array.isArray(value.challenges)) for (const id of value.challenges.slice(0, 32)) {
    if (typeof id === 'string') unlock(career, id);
  }
  if (object(value.equipped)) {
    if (typeof value.equipped.board === 'string' && career.unlockedBoards.includes(value.equipped.board)) career.equipped.board = value.equipped.board;
    if (typeof value.equipped.jacket === 'string' && career.unlockedJackets.includes(value.equipped.jacket)) career.equipped.jacket = value.equipped.jacket;
  }
  career.cup = parseCup(value.cup);
  if (Array.isArray(value.recentRuns)) career.recentRuns = [...new Set(value.recentRuns.filter(validId))].slice(-128);
  return career;
}
export function createCareerStore(store: ValueStore) {
  let cache: Career | null = null;
  const stampCompare = (aRevision: number, aId: string, bRevision: number, bId: string): number =>
    aRevision - bRevision || (aId < bId ? -1 : aId > bId ? 1 : 0);
  function read(): Career {
    const disk = parse(parseStored(store, 50_000));
    if (!cache) return cache = disk;
    const local = cache;
    const diskNewer = stampCompare(disk.revision, disk.mutationId, local.revision, local.mutationId) > 0;
    const merged = clone(diskNewer ? disk : local);
    // Earned achievements only grow. A stale tab opening a cup or selecting a
    // jacket must never replace another tab's earned board with its old list.
    for (const source of [local, disk]) {
      for (const challenge of source.challenges) unlock(merged, challenge);
      for (const medal of ['gold', 'silver', 'bronze'] as const) merged.medals[medal] = Math.max(merged.medals[medal], source.medals[medal]);
    }
    merged.recentRuns = [...new Set([...local.recentRuns, ...disk.recentRuns])].slice(-128);
    const generation = stampCompare(disk.cupGeneration, disk.cupMutationId, local.cupGeneration, local.cupMutationId);
    const cupOwner = generation > 0 ? disk : generation < 0 ? local : (diskNewer ? disk : local);
    merged.cupGeneration = cupOwner.cupGeneration;
    merged.cupMutationId = cupOwner.cupMutationId;
    merged.cup = clone(cupOwner.cup);
    // Within one generation, completed rounds are monotonic. Across different
    // generations, even a null cup wins: never resurrect an abandoned cup.
    if (generation === 0 && local.cup && disk.cup && local.cup.id === disk.cup.id) {
      if (local.cup.rounds.length > disk.cup.rounds.length) merged.cup = clone(local.cup);
      else if (disk.cup.rounds.length > local.cup.rounds.length) merged.cup = clone(disk.cup);
    }
    return cache = merged;
  }
  // Call after a read/mutation, without refreshing again and discarding the
  // just-made change. Failed writes keep this newer stamped cache playable.
  const persist = (): void => {
    const state = cache!;
    state.revision = Math.min(1e12, state.revision + 1);
    state.mutationId = newRunId('career');
    saveStored(store, state);
  };
  const replaceCup = (cup: CupState | null): void => {
    const state = read();
    state.cup = cup;
    state.cupGeneration = Math.min(1e12, Math.max(state.cupGeneration, state.revision) + 1);
    state.cupMutationId = newRunId('cup-change');
    persist();
  };
  function unlockCup(career: Career): void {
    const cup = career.cup;
    if (!cup || cup.status !== 'complete') return;
    if (getCupStandings(cup).find(item => item.id === 'player')?.finishedRounds === 3) unlock(career, 'cup-finisher');
    if (cup.medal) unlock(career, 'cup-podium');
    if (cup.medal === 'gold') unlock(career, 'cup-gold');
  }
  return {
    getCareer: (): Career => clone(read()),
    getCup: (): CupState | null => clone(read().cup),
    startCup: (): CupState => { const cup = createCup(); replaceCup(cup); return clone(cup); },
    getCupRace: (): RaceOptions | null => { const cup = read().cup; return cup ? cupRace(cup) : null; },
    abandonCup: (): void => { replaceCup(null); },
    completeCupRound: (options: RaceOptions, racers: readonly RacerSnapshot[]): CupState | null => {
      const career = read();
      if (!career.cup) return null;
      const previous = career.cup;
      const next = applyCupRound(previous, options, racers);
      if (next !== previous) {
        career.cup = next;
        if (next.status === 'complete' && next.medal) career.medals[next.medal] = Math.min(1e9, career.medals[next.medal] + 1);
        // The final-round save and rewards are one atomic snapshot. A crash
        // between the results screen and awardRun cannot lose a cup unlock.
        unlockCup(career);
        persist();
      }
      return clone(career.cup);
    },
    awardRun: (options: RaceOptions, summary: RunSummary): RunAwards => {
      const career = read();
      const awards: RunAwards = { newUnlocks: [], newChallenges: [], duplicate: false };
      if (options.mode === 'practice' || !validId(options.runId) || !validRunSummary(summary)) return awards;
      if (career.recentRuns.includes(options.runId)) return { ...awards, duplicate: true };
      const achieved: string[] = [];
      if (summary.finished) {
        achieved.push('first-finish');
        if ((summary.trickJumpCount ?? 0) >= 3) achieved.push('trick-trio');
        if ((summary.combatHitCount ?? 0) >= 5) achieved.push('five-hits');
      }
      for (const challenge of achieved) {
        const id = unlock(career, challenge);
        if (id) { awards.newUnlocks.push(id); awards.newChallenges.push(challenge); }
      }
      career.recentRuns.push(options.runId);
      career.recentRuns = career.recentRuns.slice(-128);
      persist();
      return awards;
    },
    equipCosmetic: (slot: CosmeticSlot, id: string): boolean => {
      const career = read();
      if (!COSMETICS.some(item => item.id === id && item.slot === slot)) return false;
      if (!(slot === 'board' ? career.unlockedBoards : career.unlockedJackets).includes(id)) return false;
      career.equipped[slot] = id;
      persist();
      return true;
    }
  };
}
const career = createCareerStore(localStore(STORAGE_KEYS.career));
export const getCareer = career.getCareer;
export const getCup = career.getCup;
export const startCup = career.startCup;
export const getCupRace = career.getCupRace;
export const abandonCup = career.abandonCup;
export const completeCupRound = career.completeCupRound;
export const awardRun = career.awardRun;
export const equipCosmetic = career.equipCosmetic;
