/**
 * Cup grudges (#38): tally rules, decay and caps, applyGrudge, taunts, saved-cup
 * compatibility, the SETTLED bonus and "nothing changes outside a Cup".
 * Run: node --import tsx scripts/verifyGrudges.ts
 */
import assert from 'node:assert/strict';
import {
  GRUDGE_AGGRESSION_PER_LEVEL, GRUDGE_INTERVAL_FACTOR, GRUDGE_MAX, MAX_SPEED, POINTS
} from '../src/config';
import { AIRider, type AIRiderParams } from '../src/entities/aiRider';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem, type CombatEvent } from '../src/entities/combat';
import { PERSONALITIES, type RivalPersonality } from '../src/entities/personality';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';
import { PERSONALITY_ORDER } from '../src/entities/personality';
import {
  applyCupRound, applyGrudge, bannerRival, createCareerStore, createCup, cupBanner, cupGrudges, cupQuote, cupRace,
  cupRivalParams, emptyGrudges, emptyTally, GRUDGE_RIVAL_IDS, GrudgeTracker, grudgeSummary, parseCup, pickTaunt,
  RACER_IDS, RIVALS, TAUNT_CONTEXTS, TAUNTS, tauntContext, updateGrudges, type GrudgeState, type RaceTally,
  type RacerSnapshot, type TauntContext
} from '../src/progression';
import type { ValueStore } from '../src/progression/persistence';

let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }

const [A, B, C, D] = GRUDGE_RIVAL_IDS;
function tally(over: Partial<Record<string, Partial<RaceTally['rivals'][string]>>> = {}, settled: string[] = []): RaceTally {
  const t = emptyTally();
  for (const [id, counts] of Object.entries(over)) Object.assign(t.rivals[id], counts);
  t.settled = settled;
  return t;
}
const withLevels = (levels: Partial<Record<string, 0 | 1 | 2>>, scores: string[] = []): GrudgeState => {
  const s = emptyGrudges(); Object.assign(s.levels, levels); s.scores = scores; return s;
};
const base: AIRiderParams = { cruiseSpeedFactor: 1, aggression: 0.5, reactionDistanceSegments: 8, startLane: 1, startZOffset: 300, paletteIndex: 0, personality: 'bully' };

console.log('\n=== cup grudges ===');

test('rival ids line up with the cup roster', () => {
  assert.deepEqual([...GRUDGE_RIVAL_IDS], RIVALS.map(rival => rival.id));
  assert.deepEqual(RACER_IDS.slice(1), RIVALS.map(rival => rival.id));
  assert.equal(GRUDGE_MAX, 2); assert.equal(POINTS.SETTLED, 500);
});

test('knocking a rival down (or into a tree) once raises its level by one', () => {
  const next = updateGrudges(emptyGrudges(), tally({ [A]: { knockdowns: 1 } }));
  assert.equal(next.levels[A], 1);
  assert.equal(next.levels[B], 0);
  assert.equal(updateGrudges(emptyGrudges(), tally({ [A]: { knockdowns: 4 } })).levels[A], 1, 'one level per race however many knockdowns');
});

test('three deliberate hits raise a level; two do not', () => {
  assert.equal(updateGrudges(emptyGrudges(), tally({ [B]: { hits: 3 } })).levels[B], 1);
  assert.equal(updateGrudges(withLevels({ [B]: 1 }), tally({ [B]: { hits: 2 } })).levels[B], 0, '2 hits is "none of the above": decays');
  assert.equal(updateGrudges(emptyGrudges(), tally({ [B]: { knockdowns: 1, hits: 5 } })).levels[B], 1, 'both triggers still one level');
});

test('a rival landing two hits on you leaves a score to settle and holds its level', () => {
  const next = updateGrudges(withLevels({ [C]: 1 }), tally({ [C]: { hitsOnPlayer: 2 } }));
  assert.deepEqual(next.scores, [C]);
  assert.equal(next.levels[C], 1, 'beating you up is not "none of the above": no decay');
  assert.deepEqual(updateGrudges(emptyGrudges(), tally({ [C]: { hitsOnPlayer: 1 } })).scores, [], 'one hit is not enough');
});

test('a quiet race decays each grudge by one, never below zero', () => {
  const next = updateGrudges(withLevels({ [A]: 2, [B]: 1, [C]: 0 }), tally());
  assert.deepEqual([next.levels[A], next.levels[B], next.levels[C], next.levels[D]], [1, 0, 0, 0]);
});

test('levels cap at GRUDGE_MAX and one rival does not affect another', () => {
  let state = emptyGrudges();
  for (let i = 0; i < 4; i++) state = updateGrudges(state, tally({ [D]: { knockdowns: 1 } }));
  assert.equal(state.levels[D], GRUDGE_MAX);
  assert.equal(state.levels[A], 0);
  const mixed = updateGrudges(withLevels({ [A]: 2, [B]: 0 }), tally({ [B]: { hits: 3 } }));
  assert.deepEqual([mixed.levels[A], mixed.levels[B]], [1, 1]);
});

test('updateGrudges is pure and a score outlives a quiet race until settled', () => {
  const previous = withLevels({ [A]: 1 }, [B]);
  const snapshot = JSON.stringify(previous);
  const next = updateGrudges(previous, tally());
  assert.equal(JSON.stringify(previous), snapshot);
  assert.deepEqual(next.scores, [B], 'an unsettled score carries over');
  assert.deepEqual(updateGrudges(previous, tally({}, [B])).scores, [], 'settling clears it');
});

test('applyGrudge adds aggression per level (cap 1.0) and shortens the attack interval', () => {
  assert.deepEqual(applyGrudge(base, 0), base);
  assert.notEqual(applyGrudge(base, 0), base, 'level 0 returns a copy');
  const one = applyGrudge(base, 1);
  assert.ok(Math.abs(one.aggression - (0.5 + GRUDGE_AGGRESSION_PER_LEVEL)) < 1e-9);
  assert.ok(Math.abs(one.attackIntervalMs! - PERSONALITIES.bully.attackIntervalMs * GRUDGE_INTERVAL_FACTOR) < 1e-9);
  const two = applyGrudge(base, 2);
  assert.ok(Math.abs(two.aggression - 0.8) < 1e-9);
  assert.ok(Math.abs(two.attackIntervalMs! - PERSONALITIES.bully.attackIntervalMs * GRUDGE_INTERVAL_FACTOR ** 2) < 1e-9);
  assert.equal(applyGrudge({ ...base, aggression: 0.95 }, 2).aggression, 1, 'aggression caps at 1.0');
  assert.equal(applyGrudge(base, 9).grudgeLevel, GRUDGE_MAX, 'level clamps');
  assert.equal(base.aggression, 0.5, 'input is not mutated');
  assert.equal(applyGrudge({ ...base, personality: 'daredevil' }, 1).attackIntervalMs, PERSONALITIES.daredevil.attackIntervalMs * GRUDGE_INTERVAL_FACTOR);
  assert.equal(applyGrudge({ ...base, attackIntervalMs: 400 }, 1).attackIntervalMs, 400 * GRUDGE_INTERVAL_FACTOR, 'stacks on an explicit interval');
});

test('AIRider reads its attack interval from params and exposes its grudge', () => {
  const plain = new AIRider(base);
  const angry = new AIRider(applyGrudge(base, 2));
  assert.equal(plain.grudgeLevel, 0); assert.equal(angry.grudgeLevel, 2);
  // Same seed and cooldown draw, so the only difference is the interval used after a strike.
  const player = new Player(); player.worldZ = 300; player.speed = MAX_SPEED;
  const fire = (rider: AIRider): number => {
    rider.speed = MAX_SPEED; rider.worldZ = 300;
    assert.ok(rider.requestTelegraphedAttack(player));
    return (rider as unknown as { bumpCooldownMs: number }).bumpCooldownMs;
  };
  assert.equal(fire(plain), PERSONALITIES.bully.attackIntervalMs);
  assert.ok(Math.abs(fire(angry) - PERSONALITIES.bully.attackIntervalMs * GRUDGE_INTERVAL_FACTOR ** 2) < 1e-9);
});

test('cup rivals carry grudges only when a Cup race passes them', () => {
  const generated = { ...base, personality: undefined };
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(cupRivalParams(i, generated), cupRivalParams(i, generated, null), 'no grudge state = plain rival');
    assert.deepEqual(cupRivalParams(i, generated, emptyGrudges()), cupRivalParams(i, generated));
  }
  const angry = cupRivalParams(1, generated, withLevels({ [B]: 2 }));
  assert.ok(Math.abs(angry.aggression - (RIVALS[1].aggression + 2 * GRUDGE_AGGRESSION_PER_LEVEL)) < 1e-9);
  assert.equal(cupRivalParams(0, generated, withLevels({ [B]: 2 })).aggression, RIVALS[0].aggression, 'other rivals untouched');
});

test('taunt tables: three personalities, five contexts, at least four short original lines each', () => {
  assert.deepEqual(Object.keys(TAUNTS).sort(), [...PERSONALITY_ORDER].sort());
  const all = new Set<string>();
  for (const personality of PERSONALITY_ORDER) {
    assert.deepEqual(Object.keys(TAUNTS[personality]).sort(), [...TAUNT_CONTEXTS].sort());
    for (const context of TAUNT_CONTEXTS) {
      const lines = TAUNTS[personality][context];
      assert.ok(lines.length >= 4, `${personality}/${context} has ${lines.length}`);
      for (const line of lines) {
        assert.ok(line.length >= 8 && line.length <= 46, `"${line}" is ${line.length} chars`);
        assert.ok(!all.has(line), `duplicate line "${line}"`);
        all.add(line);
      }
    }
  }
});

test('taunt choice is stable for the same inputs, varies across rounds, and never uses Math.random', () => {
  const realRandom = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    for (const personality of PERSONALITY_ORDER) for (const context of TAUNT_CONTEXTS) {
      const first = pickTaunt('cup-abc', 1, 'rival-2', personality, context);
      assert.equal(pickTaunt('cup-abc', 1, 'rival-2', personality, context), first);
      assert.ok(TAUNTS[personality][context].includes(first));
      const rounds = new Set([0, 1, 2, 3, 4, 5].map(round => pickTaunt('cup-abc', round, 'rival-2', personality, context)));
      assert.ok(rounds.size >= 2, `${personality}/${context} never varies across rounds`);
    }
    const cups = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(id => pickTaunt(`cup-${id}`, 0, 'rival-0', 'bully', 'neutral')));
    assert.ok(cups.size >= 2, 'differs between cups');
  } finally { Math.random = realRandom; }
});

test('quote context follows the state: settled, grudge 2, owes, grudge 1, neutral', () => {
  const ctx = (state: GrudgeState): TauntContext => tauntContext(state, A);
  assert.equal(ctx(emptyGrudges()), 'neutral');
  assert.equal(ctx(withLevels({ [A]: 1 })), 'grudge-1');
  assert.equal(ctx(withLevels({ [A]: 2 })), 'grudge-2');
  assert.equal(ctx(withLevels({}, [A])), 'player-owes');
  assert.equal(ctx({ ...withLevels({ [A]: 2 }), settled: [A] }), 'settled');
  assert.equal(tauntContext(null, A), 'neutral');
});

test('start-line banner picks the highest-grudge rival; nobody angry means no banner', () => {
  assert.equal(bannerRival(emptyGrudges()), null);
  assert.equal(bannerRival(null), null);
  assert.equal(bannerRival(withLevels({ [A]: 1, [C]: 2 })), C);
  assert.equal(bannerRival(withLevels({ [A]: 1, [B]: 1 })), A, 'ties go to the first rider');
  assert.equal(bannerRival(withLevels({ [A]: 1, [B]: 1 }, [B])), B, 'a score breaks a tie');
  assert.equal(bannerRival(withLevels({}, [D])), D);
  assert.equal(cupBanner('cup-x', 1, emptyGrudges()), null);
  const banner = cupBanner('cup-x', 1, withLevels({ [B]: 2 }))!;
  assert.equal(banner.name, 'SLATE'); assert.equal(banner.index, 1);
  assert.ok(TAUNTS.bully['grudge-2'].includes(banner.text));
});

test('result summary names rivals whose grudge grew and rivals you now owe', () => {
  const names = Object.fromEntries(RIVALS.map(rival => [rival.id, rival.name]));
  const before = emptyGrudges();
  assert.equal(grudgeSummary(before, updateGrudges(before, tally({ [B]: { knockdowns: 1 } })), names), "SLATE won't forget that.");
  assert.equal(grudgeSummary(before, updateGrudges(before, tally({ [A]: { hits: 3 }, [D]: { hits: 3 } })), names), "NOVA and EMBER won't forget that.");
  assert.equal(grudgeSummary(before, updateGrudges(before, tally({ [C]: { hitsOnPlayer: 2 } })), names), 'You owe FROST one.');
  assert.equal(grudgeSummary(before, updateGrudges(before, tally()), names), '');
  assert.equal(grudgeSummary(before, updateGrudges(before, tally({ [A]: { knockdowns: 1 }, [B]: { knockdowns: 1 }, [C]: { knockdowns: 1 } })), names), "3 rivals won't forget that.");
});

// ---------------------------------------------------------------- saved cups

function racers(): RacerSnapshot[] {
  return RACER_IDS.map((id, index) => ({ id, worldZ: 300000, finishTimeMs: 70000 + index * 1000, wipedOut: false }));
}
function playRound(cup: ReturnType<typeof createCup>, t?: RaceTally) {
  const next = applyCupRound(cup, cupRace(cup)!, racers(), t);
  assert.notEqual(next, cup);
  return next;
}
function memoryStore(raw: string | null = null) {
  let value = raw;
  const store: ValueStore = { get: () => value, set: next => { value = next; } };
  return { store, read: () => value };
}

test('a cup saved before grudges (no grudges field, no round tallies) still parses and resumes', () => {
  let cup = createCup('cup-legacy');
  cup = playRound(cup);
  const legacy = JSON.parse(JSON.stringify(cup));
  delete legacy.grudges;
  for (const round of legacy.rounds) delete round.tally;
  const parsed = parseCup(legacy)!;
  assert.ok(parsed, 'legacy cup is accepted');
  assert.equal(parsed.rounds.length, 1);
  assert.deepEqual(cupGrudges(parsed), emptyGrudges());
  assert.ok(cupRace(parsed), 'next round is playable');
  const freshOnly = JSON.parse(JSON.stringify(createCup('cup-empty'))); delete freshOnly.grudges;
  assert.ok(parseCup(freshOnly)); assert.deepEqual(cupGrudges(parseCup(freshOnly)), emptyGrudges());
  assert.deepEqual(cupGrudges(undefined), emptyGrudges());
});

test('grudges are rebuilt from round tallies on load; a tampered grudges field is ignored', () => {
  let cup = createCup('cup-replay');
  cup = playRound(cup, tally({ [B]: { knockdowns: 1 }, [C]: { hitsOnPlayer: 3 } }));
  cup = playRound(cup, tally({ [B]: { hits: 3 } }));
  assert.equal(cup.grudges!.levels[B], 2);
  assert.deepEqual(cup.grudges!.scores, [C]);
  const saved = JSON.parse(JSON.stringify(cup));
  assert.deepEqual(parseCup(saved)!.grudges, cup.grudges, 'round trip is exact');
  saved.grudges = { levels: { [A]: 2, [B]: 0, [C]: 2, [D]: 2 }, scores: [A, B, C, D] };
  assert.deepEqual(parseCup(saved)!.grudges, cup.grudges, 'saved levels are never trusted');
  saved.rounds[0].tally = { rivals: { [A]: { knockdowns: -5, hits: 'lots', hitsOnPlayer: 1e9 } }, settled: ['nope'] };
  assert.ok(parseCup(saved), 'hostile tallies are sanitised, not fatal');
});

test('an interrupted round resumes with the same grudge state; completing it stores the new one', () => {
  const memory = memoryStore();
  let career = createCareerStore(memory.store);
  career.startCup();
  const round1 = career.getCupRace()!;
  career.completeCupRound(round1, racers(), tally({ [A]: { knockdowns: 1 } }));
  const before = cupGrudges(career.getCup());
  assert.equal(before.levels[A], 1);
  // The app is killed mid round 2: nothing was committed, so a reload sees round 2 with identical grudges.
  career = createCareerStore(memory.store);
  assert.deepEqual(cupGrudges(career.getCup()), before);
  assert.equal(career.getCupRace()!.runId, `${career.getCup()!.id}:round-1`);
  const quote = cupQuote(career.getCup()!, A);
  assert.equal(cupQuote(createCareerStore(memory.store).getCup()!, A), quote, 'the quote is stable across reloads');
  const round2 = career.getCupRace()!;
  const after = career.completeCupRound(round2, racers(), tally({ [A]: { hits: 3 } }))!;
  assert.equal(after.grudges!.levels[A], 2);
  assert.deepEqual(cupGrudges(createCareerStore(memory.store).getCup()), after.grudges);
  // A stale duplicate result cannot apply a second tally.
  assert.deepEqual(career.completeCupRound(round2, racers(), tally({ [A]: { knockdowns: 1 } })), after);
});

test('a hand-built CupState with no grudges field behaves as an empty one', () => {
  const cup = createCup('cup-hand');
  const bare = { ...cup }; delete bare.grudges;
  const next = applyCupRound(bare, cupRace(bare)!, racers());
  assert.deepEqual(next.grudges, updateGrudges(emptyGrudges(), emptyTally()));
  assert.equal(next.rounds[0].tally!.settled.length, 0);
});

// ---------------------------------------------------------------- race tally

function scoreRig(grudges?: GrudgeState) {
  setDeterministicRuntime(5);
  const player = new Player(); player.worldZ = 1200; player.speed = MAX_SPEED;
  const riders = RIVALS.map((_, i) => new AIRider({ ...base, startLane: i, startZOffset: 1300, paletteIndex: i }));
  const combat = new CombatSystem(player, riders, []);
  const tracker = grudges ? new GrudgeTracker(grudges) : undefined;
  const score = new ScoreTracker(player, riders, [], new CollisionSystem(), combat, tracker);
  const emit = (type: CombatEvent['type'], index: number) => { combat.events.push({ type, rider: riders[index] }); score.update(0); };
  return { player, riders, combat, tracker, score, emit };
}

test('deliberate hits and knockdowns are tallied; shoves and body checks are not hits', () => {
  const r = scoreRig(emptyGrudges());
  r.emit('hit', 0); r.emit('hit', 0); r.emit('brush', 0); r.emit('push', 0); r.emit('push', 0);
  assert.equal(r.tracker!.tally.rivals[A].hits, 2, 'push and brush do not count toward the 3-hits rule');
  r.emit('push', 1); r.emit('knockout', 1);
  assert.equal(r.tracker!.tally.rivals[B].knockdowns, 1, 'a tree knockout caused by a push is a knockdown');
  assert.equal(r.tracker!.tally.rivals[B].hits, 0);
  r.emit('hit', 2); r.emit('hit', 2); r.emit('hit', 2); r.emit('knockout', 2);
  assert.equal(r.tracker!.tally.rivals[C].hits, 3);
  assert.equal(r.tracker!.tally.rivals[C].knockdowns, 1);
  assert.equal(r.score.finalize(true, 90_000, 1).settledCount, 0, 'no score to settle, no bonus');
});

test('rival hits tally unless the player shield absorbed them', () => {
  const tracker = new GrudgeTracker(emptyGrudges());
  tracker.rivalHit(A, false); tracker.rivalHit(A, true); tracker.rivalHit(A, true);
  assert.equal(tracker.tally.rivals[A].hitsOnPlayer, 1);
  tracker.rivalHit(A, false);
  assert.equal(tracker.tally.rivals[A].hitsOnPlayer, 2);
  assert.deepEqual(updateGrudges(emptyGrudges(), tracker.tally).scores, [A]);
});

test('the combat system flags a shield-absorbed rival-hit; an unshielded one is not flagged', () => {
  const run = (shield: boolean) => {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10000;
    if (shield) player.giveShield();
    const rival = new AIRider({ ...base, aggression: 0, startLane: 1, startZOffset: 10100, behaviorSeed: 42 });
    rival.speed = MAX_SPEED;
    const combat = new CombatSystem(player, [rival], []);
    assert.ok(rival.requestTelegraphedAttack(player));
    let now = 0;
    for (let i = 0; i < 80; i++) { now += 20; player.update(20); rival.update(20, [], player); combat.update(20, now); }
    return combat.skillEvents.filter(event => event.type === 'rival-hit');
  };
  const bare = run(false), shielded = run(true);
  assert.equal(bare.length, 1); assert.equal(bare[0].absorbed, false);
  assert.equal(shielded.length, 1, 'the event still fires so the HUD can react'); assert.equal(shielded[0].absorbed, true);
});

test('SETTLED pays +500 exactly once, only for a rival you owe, and clears the score', () => {
  const owed = withLevels({ [B]: 1 }, [B]);
  const r = scoreRig(owed);
  r.emit('knockout', 0);
  assert.equal(r.score.finalize(true, 90_000, 1).settledCount, 0, 'knocking down a rival you do not owe pays no bonus');
  const before = r.score.runningScore;
  r.emit('knockout', 1);
  const afterFirst = r.score.runningScore;
  assert.equal(afterFirst - before, POINTS.KNOCKOUT + POINTS.SETTLED, 'knockout plus SETTLED');
  assert.ok(r.score.feedback.some(event => event.kind === 'settled' && event.points === POINTS.SETTLED));
  r.emit('knockout', 1);
  assert.equal(r.score.runningScore - afterFirst, POINTS.KNOCKOUT, 'the second knockdown of the same rival is only a knockout');
  const breakdown = r.score.finalize(true, 90_000, 1);
  assert.equal(breakdown.settledCount, 1); assert.equal(breakdown.settledPoints, POINTS.SETTLED);
  assert.equal(breakdown.knockoutCount, 3);
  assert.equal(breakdown.total, breakdown.eventTotal + breakdown.completionBonus + breakdown.timeBonus + breakdown.positionBonus);
  assert.deepEqual(r.tracker!.tally.settled, [B]);
  const next = updateGrudges(owed, r.tracker!.tally);
  assert.deepEqual(next.scores, [], 'the score is cleared');
  assert.deepEqual(next.settled, [B]);
  assert.equal(tauntContext(next, B), 'settled');
});

test('outside a Cup there is no tracker: no SETTLED, no tally, nothing changes', () => {
  const plain = scoreRig();
  const same = scoreRig();
  for (const rig of [plain, same]) { rig.emit('hit', 1); rig.emit('knockout', 1); rig.emit('knockout', 1); }
  const a = plain.score.finalize(true, 90_000, 2);
  assert.equal(a.settledCount, 0); assert.equal(a.settledPoints, 0);
  assert.equal(a.eventTotal, POINTS.COMBAT_HIT + 2 * POINTS.KNOCKOUT + a.chainBonusPoints);
  assert.deepEqual(a, same.score.finalize(true, 90_000, 2));
  const generated = { ...base };
  for (let i = 0; i < 4; i++) assert.deepEqual(cupRivalParams(i, generated), cupRivalParams(i, generated, undefined));
  assert.equal(new AIRider(generated).grudgeLevel, 0);
});

console.log(`\n${passed} grudge checks passed.`);
