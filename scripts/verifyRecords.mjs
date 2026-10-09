/** Independent storage regressions, including fresh-module reload semantics. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/entities/session.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 }
}).outputText;
let instance = 0;
const freshModule = () => import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// instance-${instance++}`).toString('base64')}`);
const data = new Map();
globalThis.localStorage = {
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value)
};

let records = await freshModule();
assert.deepEqual(records.recordScore(1200.7), { best: 1200.7, isNewBest: true });
assert.deepEqual(records.recordScore(1100), { best: 1200.7, isNewBest: false });
let course = records.recordCourse(123, 1200.7, 123.4);
assert.equal(course.isNewTime, true);
assert.equal(course.record.attempts, 1);
course = records.recordCourse(123, 1600, null);
assert.equal(course.isNewTime, false);
assert.equal(course.record.bestTimeSeconds, 123.4);
assert.equal(course.record.attempts, 2);
course = records.recordCourse(123, 1400, 118.5);
assert.equal(course.isNewTime, true);
assert.equal(course.previousBestTime, 123.4);
assert.equal(course.record.bestScore, 1600);

records = await freshModule();
assert.equal(records.getBestScore(), 1200.7);
assert.equal(records.getCourseRecord(123).bestTimeSeconds, 118.5);
assert.equal(records.getCourseRecord(123).attempts, 3);
const copy = records.getCourseRecord(123);
copy.bestScore = 0;
assert.equal(records.getCourseRecord(123).bestScore, 1600);
for (const invalid of [NaN, Infinity, -10]) records.recordScore(invalid);
assert.equal(records.getBestScore(), 1200.7);

for (let seed = 0; seed < 100; seed++) records.recordCourse(seed, seed, seed + 1);
assert.equal(Object.keys(JSON.parse(data.get('black-diamond-brawl:records:v1')).courses).length, 64);
assert.equal(records.getCourseRecord(99).attempts, 1);
records.recordCourse(0xffffffff, 800, 90);
assert.equal(records.getCourseRecord(0xffffffff).bestScore, 800);

// Independently imported modules model already-open tabs sharing one store.
// A later, lower-scoring completion must not overwrite the other tab's PBs.
data.clear();
const tabA = await freshModule();
tabA.recordScore(100);
tabA.recordCourse(101, 100, 120);
const tabB = await freshModule();
assert.equal(tabB.getBestScore(), 100);
assert.equal(tabB.getCourseRecord(101).attempts, 1);
tabA.recordScore(200);
tabA.recordCourse(101, 200, 100);
tabB.recordCourse(202, 50, null);
let shared = JSON.parse(data.get('black-diamond-brawl:records:v1'));
assert.equal(shared.bestScore, 200);
assert.equal(shared.courses['101'].bestScore, 200);
assert.equal(shared.courses['101'].bestTimeSeconds, 100);
assert.equal(shared.courses['101'].attempts, 2);
course = tabB.recordCourse(101, 150, 110);
assert.equal(course.record.attempts, 3);
assert.equal(course.previousBestTime, 100);
assert.equal(course.isNewScore, false);
assert.equal(course.isNewTime, false);
assert.deepEqual(tabB.recordScore(150), { best: 200, isNewBest: false });
assert.equal(tabA.getCourseRecord(101).attempts, 3, 'open-tab reads also refresh');
assert.equal(tabA.getCourseRecord(202).attempts, 1);
for (let seed = 300; seed < 400; seed++) (seed % 2 ? tabA : tabB).recordCourse(seed, seed, seed + 1);
shared = JSON.parse(data.get('black-diamond-brawl:records:v1'));
assert.equal(Object.keys(shared.courses).length, 64, 'cross-tab merges retain at most 64 courses');
assert.equal(shared.courses['399'].attempts, 1);

// A failed write must not cause the next refresh to replace better in-memory
// results with old storage. Once writes recover, persist the merged record.
data.clear();
records = await freshModule();
records.recordScore(100);
records.recordCourse(1, 100, 120);
let quotaBlocked = true;
globalThis.localStorage.setItem = (key, value) => {
  if (quotaBlocked) throw new Error('quota');
  data.set(key, value);
};
records.recordScore(300);
records.recordCourse(1, 300, 90);
assert.equal(records.getBestScore(), 300);
assert.equal(records.getCourseRecord(1).bestTimeSeconds, 90);
assert.equal(records.getCourseRecord(1).attempts, 2);
quotaBlocked = false;
records.recordCourse(1, 250, null);
shared = JSON.parse(data.get('black-diamond-brawl:records:v1'));
assert.equal(shared.bestScore, 300);
assert.equal(shared.courses['1'].bestScore, 300);
assert.equal(shared.courses['1'].bestTimeSeconds, 90);
assert.equal(shared.courses['1'].attempts, 3);

// Recency pruning must still keep the just-played course if a device clock
// is corrected backwards, even after merging another tab's snapshot.
const realNow = Date.now;
try {
  data.clear();
  Date.now = () => 1000000;
  records = await freshModule();
  for (let seed = 0; seed < 64; seed++) records.recordCourse(seed, seed, 100);
  Date.now = () => 1000;
  records.recordCourse(999, 999, 95);
  assert.equal(records.getCourseRecord(999).bestTimeSeconds, 95);
  assert.equal(Object.keys(JSON.parse(data.get('black-diamond-brawl:records:v1')).courses).length, 64);
} finally {
  Date.now = realNow;
}

data.set('black-diamond-brawl:records:v1', 'broken json');
records = await freshModule();
assert.equal(records.getBestScore(), 0);
assert.equal(records.recordScore(500).best, 500);
data.set('black-diamond-brawl:records:v1', JSON.stringify({
  bestScore: -3,
  courses: {
    foo: {}, 1: null, 2: { bestScore: 'nope' },
    3: { bestScore: 700, bestTimeSeconds: 85, attempts: 3, lastPlayed: 100 }
  }
}));
records = await freshModule();
assert.equal(records.getBestScore(), 0);
assert.equal(records.getCourseRecord(3).bestScore, 700);
assert.equal(records.getCourseRecord(1), null);

globalThis.localStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('quota'); }
};
records = await freshModule();
assert.equal(records.recordScore(800).best, 800);
assert.equal(records.recordCourse(0, 800, 100).record.bestTimeSeconds, 100);
assert.equal(records.getCourseRecord(0).bestScore, 800);
console.log('PASS: persistent scores, finish-only times, reloads, immutable reads, cross-tab refresh/merge, invalid inputs, 64-course retention, corrupt storage, denied/quota fallback and recovery.');
