import { STORAGE_KEYS } from '../platform/storage';
import { clone, finite, integer, localStore, object, parseStored, saveStored, validId, type ValueStore } from './persistence';
import { validRunSummary, type RaceOptions, type RunSummary } from './race';
import { COURSE_VERSION, courseKey, RULES_VERSION } from './rules';

export const MAX_RECORD_COURSES = 64;
const MAX_RECEIPTS = 128;
export interface CourseRecord { bestScore: number; bestTimeSeconds: number | null; attempts: number; lastPlayed: number }
export interface RunRecordResult {
  bestScore: number; isNewBest: boolean; record: CourseRecord; isNewScore: boolean;
  isNewTime: boolean; previousBestTime: number | null; duplicate: boolean;
}
interface Receipt { runId: string; course: string; result: RunRecordResult }
interface Records {
  version: 2; rulesVersion: string; courseVersion: string; bestScore: number;
  courses: Record<string, CourseRecord>; receipts: Receipt[];
}
function empty(): Records { return { version: 2, rulesVersion: RULES_VERSION, courseVersion: COURSE_VERSION, bestScore: 0, courses: {}, receipts: [] }; }
function validCourse(value: unknown): value is CourseRecord {
  return object(value) && finite(value.bestScore, 0, 1e9) && (value.bestTimeSeconds === null || finite(value.bestTimeSeconds, 0.001, 3600)) &&
    integer(value.attempts, 0, 1e9) && finite(value.lastPlayed, 0, 1e16);
}
function validKey(key: string): boolean {
  const prefix = `${RULES_VERSION}/${COURSE_VERSION}/`;
  const seed = key.slice(prefix.length);
  return key.startsWith(prefix) && /^\d{1,10}$/.test(seed) && Number(seed) <= 0xffffffff;
}
function parse(value: unknown): Records {
  const records = empty();
  if (!object(value) || value.version !== 2 || value.rulesVersion !== RULES_VERSION || value.courseVersion !== COURSE_VERSION) return records;
  if (finite(value.bestScore, 0, 1e9)) records.bestScore = value.bestScore;
  if (object(value.courses)) {
    Object.entries(value.courses).filter(([key, item]) => validKey(key) && validCourse(item))
      .sort(([, a], [, b]) => (b as CourseRecord).lastPlayed - (a as CourseRecord).lastPlayed)
      .slice(0, MAX_RECORD_COURSES).forEach(([key, item]) => { records.courses[key] = clone(item as CourseRecord); });
  }
  if (Array.isArray(value.receipts)) {
    for (const item of value.receipts.slice(-MAX_RECEIPTS)) {
      if (!object(item) || !validId(item.runId) || typeof item.course !== 'string' || !validKey(item.course) || !object(item.result)) continue;
      const result = item.result;
      if (!validCourse(result.record) || !finite(result.bestScore, 0, 1e9) || typeof result.isNewBest !== 'boolean' ||
          typeof result.isNewScore !== 'boolean' || typeof result.isNewTime !== 'boolean' ||
          !(result.previousBestTime === null || finite(result.previousBestTime, 0.001, 3600))) continue;
      records.receipts.push({ runId: item.runId, course: item.course, result: { ...(clone(result) as unknown as RunRecordResult), duplicate: false } });
    }
  }
  return records;
}
function freshRecord(): CourseRecord { return { bestScore: 0, bestTimeSeconds: null, attempts: 0, lastPlayed: 0 }; }
export function createRecordsStore(store: ValueStore, now: () => number = Date.now) {
  let cache: Records | null = null;
  function read(): Records {
    const disk = parse(parseStored(store, 160_000));
    if (!cache) return cache = disk;
    cache.bestScore = Math.max(cache.bestScore, disk.bestScore);
    for (const [key, item] of Object.entries(disk.courses)) {
      const current = cache.courses[key];
      if (!current) { cache.courses[key] = item; continue; }
      current.bestScore = Math.max(current.bestScore, item.bestScore);
      if (item.bestTimeSeconds !== null) current.bestTimeSeconds = current.bestTimeSeconds === null ? item.bestTimeSeconds : Math.min(current.bestTimeSeconds, item.bestTimeSeconds);
      current.attempts = Math.max(current.attempts, item.attempts);
      current.lastPlayed = Math.max(current.lastPlayed, item.lastPlayed);
    }
    for (const receipt of disk.receipts) if (!cache.receipts.some(item => item.runId === receipt.runId)) cache.receipts.push(receipt);
    cache.receipts = cache.receipts.slice(-MAX_RECEIPTS);
    trim(cache);
    return cache;
  }
  function trim(records: Records, keep?: string): void {
    const keys = Object.keys(records.courses).filter(key => key !== keep).sort((a, b) => records.courses[b].lastPlayed - records.courses[a].lastPlayed);
    if (keep) keys.unshift(keep);
    for (const key of keys.slice(MAX_RECORD_COURSES)) delete records.courses[key];
  }
  function recordRun(options: RaceOptions, summary: RunSummary): RunRecordResult {
    const records = read();
    const key = courseKey(options.seed);
    const prior = records.courses[key] ?? freshRecord();
    const previousBestTime = prior.bestTimeSeconds;
    const noChange: RunRecordResult = { bestScore: records.bestScore, isNewBest: false, record: clone(prior), isNewScore: false, isNewTime: false, previousBestTime, duplicate: false };
    if (options.mode === 'practice' || !validId(options.runId) || !validRunSummary(summary)) return noChange;
    const receipt = records.receipts.find(item => item.runId === options.runId);
    if (receipt) return receipt.course === key ? { ...clone(receipt.result), duplicate: true } : { ...noChange, duplicate: true };
    const isNewBest = summary.total > records.bestScore;
    const isNewScore = summary.total > prior.bestScore;
    const isNewTime = summary.finished && (previousBestTime === null || summary.finishTimeSeconds < previousBestTime);
    const record: CourseRecord = {
      bestScore: Math.max(summary.total, prior.bestScore), bestTimeSeconds: isNewTime ? summary.finishTimeSeconds : previousBestTime,
      attempts: Math.min(1e9, prior.attempts + 1), lastPlayed: Math.max(0, Math.min(1e16, now()))
    };
    records.bestScore = Math.max(records.bestScore, summary.total);
    records.courses[key] = record;
    const result: RunRecordResult = { bestScore: records.bestScore, isNewBest, record: clone(record), isNewScore, isNewTime, previousBestTime, duplicate: false };
    records.receipts.push({ runId: options.runId, course: key, result: clone(result) });
    records.receipts = records.receipts.slice(-MAX_RECEIPTS);
    trim(records, key);
    saveStored(store, records);
    return result;
  }
  return {
    getBestScore: (): number => read().bestScore,
    getCourseRecord: (seed: number): CourseRecord | null => { const item = read().courses[courseKey(seed)]; return item ? clone(item) : null; },
    recordRun
  };
}
const records = createRecordsStore(localStore(STORAGE_KEYS.recordsV2));
export const getBestScore = records.getBestScore;
export const getCourseRecord = records.getCourseRecord;
export const recordRun = records.recordRun;
