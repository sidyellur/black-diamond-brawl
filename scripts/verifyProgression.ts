/** Pure progression + actual browser/native storage contract regression gate. */
import assert from 'node:assert/strict';
import { createStorage, STORAGE_KEYS } from '../src/platform/storage';
import {
  applyCupRound, COSMETICS, createCareerStore, createCup, createQuickRace, createRecordsStore,
  CUP_SEEDS, cupRace, cupRivalParams, getCupStandings, parseCup, PLACEMENT_POINTS,
  RACER_IDS, retryRace, RULES_VERSION, type RacerSnapshot, type RunSummary
} from '../src/progression';
import type { ValueStore } from '../src/progression/persistence';
let passed = 0;
const check = (name: string, run: () => void) => { run(); passed++; console.log(`  PASS ${name}`); };
function storage(raw: string | null = null) {
  let value = raw;
  let failGet = false;
  let failSet = false;
  const store: ValueStore = { get: () => { if (failGet) throw Error('blocked'); return value; },
    set: next => { if (failSet) throw Error('quota'); value = next; } };
  return { store, read: () => value, inject: (next: string) => { value = next; },
    failReads: () => { failGet = true; }, failWrites: () => { failSet = true; } };
}
const finished: RunSummary = { finished: true, total: 14000, finishTimeSeconds: 70, position: 1, combatHitCount: 5, trickJumpCount: 3 };
function racers(playerPlace = 1, dnf = false): RacerSnapshot[] {
  const others = RACER_IDS.filter(id => id !== 'player');
  const order = [...others.slice(0, playerPlace - 1), 'player' as const, ...others.slice(playerPlace - 1)];
  return order.map((id, index) => ({ id, worldZ: 300000, finishTimeMs: id === 'player' && dnf ? null : 70000 + index * 1000, wipedOut: id === 'player' && dnf }));
}
console.log('\n=== cup, career, and versioned record models ===');
check('three deterministic courses and stable named rival slots use fixed personalities', () => {
  assert.equal(CUP_SEEDS.length, 3);
  assert.equal(new Set(CUP_SEEDS).size, 3);
  const baseline = { cruiseSpeedFactor: 1, aggression: 1, reactionDistanceSegments: 8, startLane: 1, startZOffset: 300, paletteIndex: 3 };
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(cupRivalParams(index, baseline), cupRivalParams(index, { ...baseline, aggression: 0.1, cruiseSpeedFactor: 0.9 }));
    assert.equal(cupRivalParams(index, baseline).startLane, baseline.startLane);
    assert.equal(cupRivalParams(index, baseline).paletteIndex, index);
  }
});
check('three rounds score complete standings, persist each round, and award one medal', () => {
  const memory = storage();
  let career = createCareerStore(memory.store);
  const cup = career.startCup();
  for (let index = 0; index < 3; index++) {
    const race = career.getCupRace()!;
    assert.equal(race.roundIndex, index);
    const next = career.completeCupRound(race, racers())!;
    assert.equal(next.rounds.length, index + 1);
    assert.equal(getCupStandings(next)[0].points, 10 * (index + 1));
    assert.deepEqual(career.completeCupRound(race, racers(5)), next, 'repeated result cannot replace a classification');
    career = createCareerStore(memory.store);
    assert.deepEqual(career.getCup(), next, 'reload resumes exactly the committed next round');
  }
  assert.equal(career.getCupRace(), null);
  assert.equal(career.getCup()!.id, cup.id);
  assert.equal(career.getCup()!.medal, 'gold');
  assert.equal(career.getCareer().medals.gold, 1);
  assert.ok(career.getCareer().unlockedBoards.includes('champion-board'));
  assert.ok(career.getCareer().unlockedJackets.includes('alpine-jacket'));
  assert.ok(career.getCareer().unlockedJackets.includes('summit-jacket'));
  const last = career.getCup()!.rounds[2];
  career.completeCupRound({ mode: 'cup', seed: last.seed, runId: last.runId, cupId: cup.id, roundIndex: 2 }, racers());
  assert.equal(career.getCareer().medals.gold, 1, 'final result after reload cannot duplicate a medal');
});
check('wipeouts receive zero points and no all-DNF medal; still advance the cup', () => {
  let cup = createCup('cup-dnf');
  for (let index = 0; index < 3; index++) {
    cup = applyCupRound(cup, cupRace(cup)!, racers(1, true));
    assert.equal(cup.rounds[index].results.find(item => item.id === 'player')!.points, 0);
  }
  assert.equal(cup.status, 'complete');
  assert.equal(cup.medal, null);
  assert.equal(getCupStandings(cup).find(item => item.id === 'player')!.finishedRounds, 0);
});
check('placement points follow classification rather than incoming array order', () => {
  const cup = createCup('cup-order');
  const next = applyCupRound(cup, cupRace(cup)!, racers(3).reverse());
  assert.deepEqual(next.rounds[0].results.map(item => item.points), [...PLACEMENT_POINTS]);
  assert.equal(next.rounds[0].results[2].id, 'player');
});
check('ties resolve by points, wins, finished rounds, time, then stable slot identity', () => {
  const cup = createCup('cup-tie');
  const tied = racers().map(item => ({ ...item, finishTimeMs: 75000 }));
  const a = applyCupRound(cup, cupRace(cup)!, tied);
  const b = applyCupRound(cup, cupRace(cup)!, tied.reverse());
  assert.deepEqual(getCupStandings(a), getCupStandings(b));
  assert.equal(getCupStandings(a)[0].id, 'player');
  assert.deepEqual(getCupStandings(createCup()).map(item => item.id), RACER_IDS);
});
check('wrong run, seed, round, incomplete player and missing/duplicate racer IDs are rejected', () => {
  const cup = createCup('cup-guard');
  const options = cupRace(cup)!;
  for (const changed of [{ ...options, runId: 'other' }, { ...options, seed: 0 }, { ...options, roundIndex: 2 }, { ...options, cupId: 'other' }]) {
    assert.equal(applyCupRound(cup, changed, racers()), cup);
  }
  assert.equal(applyCupRound(cup, options, racers().slice(1)), cup);
  assert.equal(applyCupRound(cup, options, racers().map(item => ({ ...item, id: 'player' }))), cup);
  assert.equal(applyCupRound(cup, options, racers().map(item => item.id === 'player' ? { ...item, finishTimeMs: null } : item)), cup);
});
check('interrupted round resumes same ID; abandoning prevents old results from scoring a new cup', () => {
  const memory = storage();
  const original = createCareerStore(memory.store);
  original.startCup();
  const interrupted = original.getCupRace()!;
  const resumed = createCareerStore(memory.store);
  assert.deepEqual(resumed.getCupRace(), interrupted);
  assert.deepEqual(retryRace(interrupted), interrupted);
  resumed.abandonCup();
  assert.equal(resumed.getCup(), null);
  resumed.startCup();
  resumed.completeCupRound(interrupted, racers());
  assert.equal(resumed.getCup()!.rounds.length, 0);
});
check('cup parser recomputes stored points and rejects incompatible or oversized snapshots', () => {
  const cup = applyCupRound(createCup('cup-parse'), cupRace(createCup('cup-parse'))!, racers());
  const saved = JSON.parse(JSON.stringify(cup));
  saved.rounds[0].results[0].points = 999999;
  assert.equal(parseCup(saved)!.rounds[0].results[0].points, 10);
  saved.rulesVersion = 'old';
  assert.equal(parseCup(saved), null);
  saved.rulesVersion = RULES_VERSION;
  saved.rounds.push(...Array(8).fill(saved.rounds[0]));
  assert.equal(parseCup(saved), null);
});
check('meaningful finished-run challenges unlock only colors and selection survives reload', () => {
  const memory = storage();
  const career = createCareerStore(memory.store);
  assert.equal(career.equipCosmetic('board', 'champion-board'), false);
  const options = createQuickRace(77);
  const awards = career.awardRun(options, finished);
  assert.deepEqual(awards.newChallenges, ['first-finish', 'trick-trio', 'five-hits']);
  assert.equal(career.awardRun(options, finished).duplicate, true);
  assert.equal(career.equipCosmetic('board', 'aurora-board'), true);
  assert.equal(career.equipCosmetic('jacket', 'midnight-jacket'), true);
  assert.equal(career.equipCosmetic('jacket', 'aurora-board'), false);
  assert.deepEqual(createCareerStore(memory.store).getCareer().equipped, { board: 'aurora-board', jacket: 'midnight-jacket' });
  for (const item of COSMETICS) assert.deepEqual(Object.keys(item).sort(), ['color', 'id', 'name', 'requirement', 'slot']);
});
check('practice and wipeouts cannot unlock finished-run challenges', () => {
  const career = createCareerStore(storage().store);
  career.awardRun({ ...createQuickRace(1), mode: 'practice' }, finished);
  career.awardRun(createQuickRace(1), { ...finished, finished: false });
  assert.equal(career.getCareer().challenges.length, 0);
});
check('invalid, huge and unavailable progression storage never blocks play', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 500 }), 'x'.repeat(50001), JSON.stringify({ version: 1, medals: { gold: -2 }, equipped: { board: '__proto__' } })]) {
    const career = createCareerStore(storage(raw).store);
    assert.equal(career.getCareer().equipped.board, 'classic-board');
    career.startCup();
    assert.ok(career.getCupRace());
  }
  const blocked = storage(); blocked.failReads(); blocked.failWrites();
  const career = createCareerStore(blocked.store);
  career.startCup(); career.awardRun(createQuickRace(1), finished);
  assert.ok(career.getCareer().unlockedBoards.includes('sunrise-board'));
  assert.equal(career.equipCosmetic('board', 'sunrise-board'), true);
});
check('full storage keeps current cup/selection in memory without overwriting legacy data', () => {
  const memory = storage();
  const career = createCareerStore(memory.store);
  career.startCup();
  memory.failWrites();
  career.completeCupRound(career.getCupRace()!, racers());
  assert.equal(career.getCup()!.rounds.length, 1);
  career.awardRun(createQuickRace(1), finished);
  career.equipCosmetic('board', 'sunrise-board');
  assert.equal(career.getCareer().equipped.board, 'sunrise-board');
});
check('versioned records keep personal/course bests and idempotent attempts across reloads', () => {
  const memory = storage();
  let records = createRecordsStore(memory.store, () => 1234);
  const options = createQuickRace(45);
  const first = records.recordRun(options, finished);
  assert.equal(first.isNewBest, true);
  assert.equal(first.record.attempts, 1);
  records = createRecordsStore(memory.store);
  assert.equal(records.recordRun(options, finished).duplicate, true);
  assert.equal(records.getCourseRecord(45)!.attempts, 1);
  const next = records.recordRun(retryRace(options), { ...finished, total: 1, finishTimeSeconds: 80 });
  assert.equal(next.isNewBest, false);
  assert.equal(next.isNewTime, false);
  assert.equal(next.previousBestTime, 70);
  assert.equal(next.record.attempts, 2);
});
check('practice, bad scores and failed finishes never contaminate competitive time records', () => {
  const records = createRecordsStore(storage().store);
  records.recordRun({ ...createQuickRace(1), mode: 'practice' }, finished);
  assert.equal(records.getCourseRecord(1), null);
  records.recordRun(createQuickRace(1), { ...finished, total: NaN });
  assert.equal(records.getCourseRecord(1), null);
  records.recordRun(createQuickRace(1), { ...finished, finished: false });
  assert.equal(records.getCourseRecord(1)!.bestTimeSeconds, null);
});
check('record storage/receipt counts are bounded and full-quota memory remains usable', () => {
  const memory = storage();
  const records = createRecordsStore(memory.store);
  for (let index = 0; index < 180; index++) records.recordRun({ mode: 'quick', seed: index, runId: `run-${index}` }, finished);
  const saved = JSON.parse(memory.read()!);
  assert.equal(Object.keys(saved.courses).length, 64);
  assert.equal(saved.receipts.length, 128);
  memory.failWrites();
  records.recordRun(createQuickRace(0), { ...finished, total: 50000, finishTimeSeconds: 60 });
  assert.equal(records.getBestScore(), 50000);
  assert.equal(records.getCourseRecord(0)!.bestTimeSeconds, 60);
});
check('stale tabs merge earned unlocks before starting cups or selecting cosmetics', () => {
  const memory = storage();
  const a = createCareerStore(memory.store);
  const b = createCareerStore(memory.store);
  a.getCareer(); b.getCareer();
  a.awardRun(createQuickRace(1), finished);
  b.startCup();
  let reloaded = createCareerStore(memory.store).getCareer();
  assert.ok(reloaded.challenges.includes('first-finish'));
  assert.ok(reloaded.unlockedBoards.includes('sunrise-board'));
  assert.equal(b.equipCosmetic('board', 'sunrise-board'), true, 'stale locker sees newly earned board');
  a.equipCosmetic('jacket', 'midnight-jacket');
  reloaded = createCareerStore(memory.store).getCareer();
  assert.equal(reloaded.equipped.board, 'sunrise-board');
  assert.equal(reloaded.equipped.jacket, 'midnight-jacket');
});
check('stale cup snapshots cannot remove completed rounds or resurrect abandon/replacement', () => {
  const memory = storage();
  const a = createCareerStore(memory.store);
  a.startCup();
  const b = createCareerStore(memory.store);
  const firstRace = b.getCupRace()!;
  a.completeCupRound(firstRace, racers());
  b.awardRun(createQuickRace(1), finished);
  assert.equal(createCareerStore(memory.store).getCup()!.rounds.length, 1);
  const staleSecondRace = b.getCupRace()!;
  a.abandonCup();
  b.awardRun(createQuickRace(2), finished);
  assert.equal(b.getCup(), null);
  assert.equal(createCareerStore(memory.store).getCup(), null);
  const replacement = a.startCup();
  b.completeCupRound(staleSecondRace, racers());
  assert.equal(b.getCup()!.id, replacement.id);
  assert.equal(b.getCup()!.rounds.length, 0);
});
check('two stale tabs retain accumulated medals and cannot re-award a completed old cup', () => {
  const memory = storage();
  const a = createCareerStore(memory.store);
  const b = createCareerStore(memory.store);
  a.getCareer(); b.getCareer();
  a.startCup();
  let finalOptions = a.getCupRace()!;
  for (let index = 0; index < 3; index++) { finalOptions = a.getCupRace()!; a.completeCupRound(finalOptions, racers()); }
  b.startCup();
  for (let index = 0; index < 3; index++) b.completeCupRound(b.getCupRace()!, racers());
  a.completeCupRound(finalOptions, racers());
  assert.equal(a.getCareer().medals.gold, 2);
  assert.equal(createCareerStore(memory.store).getCareer().medals.gold, 2);
});
check('failed writes preserve unsaved earned progress while importing another tab cup', () => {
  const memory = storage();
  let fail = true;
  const localStore: ValueStore = { get: memory.store.get, set: value => { if (fail) throw Error('quota'); memory.store.set(value); } };
  const a = createCareerStore(localStore);
  const b = createCareerStore(memory.store);
  a.awardRun(createQuickRace(1), finished);
  const cup = b.startCup();
  assert.ok(a.getCareer().challenges.includes('first-finish'));
  assert.equal(a.getCup()!.id, cup.id);
  fail = false;
  a.equipCosmetic('board', 'sunrise-board');
  const reloaded = createCareerStore(memory.store).getCareer();
  assert.ok(reloaded.challenges.includes('first-finish'));
  assert.equal(reloaded.cup!.id, cup.id);
  assert.equal(reloaded.equipped.board, 'sunrise-board');
});
check('real browser adapter exposes another tab progress after a local quota failure', () => {
  const disk = new Map<string, string>();
  let failWrites = false;
  const adapter = createStorage({ native: false, preferences: { get: async () => ({ value: null }), set: async () => {} },
    browserStorage: () => ({ getItem: key => disk.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw Error('quota'); disk.set(key, value); } }) });
  const a = createCareerStore({ get: () => adapter.get(STORAGE_KEYS.career), set: value => adapter.set(STORAGE_KEYS.career, value) });
  const b = createCareerStore({ get: () => disk.get(STORAGE_KEYS.career) ?? null, set: value => { disk.set(STORAGE_KEYS.career, value); } });
  a.getCareer(); b.getCareer();
  failWrites = true;
  a.awardRun(createQuickRace(1), finished);
  const newCup = b.startCup();
  assert.ok(a.getCareer().challenges.includes('first-finish'));
  assert.equal(a.getCup()!.id, newCup.id, 'quota memory must not hide another tab cup');
  failWrites = false;
  a.equipCosmetic('board', 'sunrise-board');
  assert.equal(b.getCareer().equipped.board, 'sunrise-board');
  assert.ok(b.getCareer().challenges.includes('first-finish'));
});
check('legacy v1 and incompatible rule snapshots cannot be read as current records', () => {
  const old = { bestScore: 999999, courses: { '1': { bestScore: 99999, bestTimeSeconds: 1, attempts: 50, lastPlayed: 0 } } };
  assert.equal(createRecordsStore(storage(JSON.stringify(old)).store).getBestScore(), 0);
  assert.equal(createRecordsStore(storage(JSON.stringify({ ...old, version: 2, rulesVersion: 'v1' })).store).getBestScore(), 0);
});

const durable = new Map<string, string>([[STORAGE_KEYS.records, 'legacy-preserved']]);
const reads: string[] = [];
const native = createStorage({ native: true, preferences: {
  get: async ({ key }) => { reads.push(key); return { value: durable.get(key) ?? null }; },
  set: async ({ key, value }) => { durable.set(key, value); }
}, browserStorage: () => { throw Error('native must not touch browser storage'); } });
await native.initialize();
assert.deepEqual([...reads].sort(), Object.values(STORAGE_KEYS).sort());
const nativeCareer = createCareerStore({ get: () => native.get(STORAGE_KEYS.career), set: value => native.set(STORAGE_KEYS.career, value) });
nativeCareer.startCup(); nativeCareer.awardRun(createQuickRace(1), finished);
await native.flush();
assert.equal(durable.get(STORAGE_KEYS.records), 'legacy-preserved');
assert.ok(durable.get(STORAGE_KEYS.career));
console.log('  PASS native Preferences hydrates every new key, persists progression and preserves legacy records'); passed++;
console.log(`\n${passed} progression checks passed.`);
