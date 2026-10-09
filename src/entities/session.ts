/** Personal records are local to this browser, with an in-memory fallback. */
const STORAGE_KEY = 'black-diamond-brawl:records:v1';
const MAX_COURSES = 64;

export interface CourseRecord {
  bestScore: number;
  bestTimeSeconds: number | null;
  attempts: number;
  lastPlayed: number;
}

interface Records {
  bestScore: number;
  courses: Record<string, CourseRecord>;
}

let records: Records | null = null;

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parse storage independently of the live cache: another tab may have saved
 * a better run since this one opened. Never trust malformed external data. */
function readStoredRecords(): Records {
  const stored: Records = { bestScore: 0, courses: {} };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return stored;
    const saved = raw as Partial<Records>;
    if (nonNegative(saved.bestScore)) stored.bestScore = saved.bestScore;
    if (saved.courses && typeof saved.courses === 'object') {
      const entries = Object.entries(saved.courses)
        .filter(([seed, course]) => /^\d{1,10}$/.test(seed) && Number(seed) <= 0xffffffff &&
          course && typeof course === 'object' && nonNegative(course.bestScore) &&
          nonNegative(course.attempts) && nonNegative(course.lastPlayed) &&
          (course.bestTimeSeconds === null || (nonNegative(course.bestTimeSeconds) && course.bestTimeSeconds > 0)))
        .sort(([, a], [, b]) => b.lastPlayed - a.lastPlayed)
        .slice(0, MAX_COURSES);
      for (const [seed, course] of entries) {
        stored.courses[seed] = {
          bestScore: course.bestScore,
          bestTimeSeconds: course.bestTimeSeconds,
          attempts: Math.floor(course.attempts),
          lastPlayed: course.lastPlayed
        };
      }
    }
  } catch {
    // Blocked storage, private browsing, corrupt JSON, and SSR all remain playable.
  }
  return stored;
}

function trimCourses(saved: Records, keepKey?: string): void {
  const newest = Object.keys(saved.courses)
    .filter(key => key !== keepKey)
    .sort((a, b) => saved.courses[b].lastPlayed - saved.courses[a].lastPlayed);
  if (keepKey !== undefined) newest.unshift(keepKey);
  for (const expired of newest.slice(MAX_COURSES)) delete saved.courses[expired];
}

function readRecords(): Records {
  const stored = readStoredRecords();
  if (!records) return records = stored;
  // Merge, rather than replacing the cache: quota/denied writes can leave
  // newer results only in memory. Scores/times must never move backwards.
  records.bestScore = Math.max(records.bestScore, stored.bestScore);
  for (const [seed, incoming] of Object.entries(stored.courses)) {
    const current = records.courses[seed];
    if (!current) {
      records.courses[seed] = incoming;
      continue;
    }
    current.bestScore = Math.max(current.bestScore, incoming.bestScore);
    if (incoming.bestTimeSeconds !== null &&
      (current.bestTimeSeconds === null || incoming.bestTimeSeconds < current.bestTimeSeconds)) {
      current.bestTimeSeconds = incoming.bestTimeSeconds;
    }
    // Snapshots describe the same attempts, so adding counts would duplicate
    // them. A new completion increments only after this refresh has merged.
    current.attempts = Math.max(current.attempts, incoming.attempts);
    current.lastPlayed = Math.max(current.lastPlayed, incoming.lastPlayed);
  }
  trimCourses(records);
  return records;
}

function saveRecords(saved: Records): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A full quota or denied storage must never interrupt a race or replay.
  }
}

export function getBestScore(): number {
  return readRecords().bestScore;
}

/** Existing race-facing API; best now survives reloads where storage permits. */
export function recordScore(score: number): { best: number; isNewBest: boolean } {
  const saved = readRecords();
  const isNewBest = nonNegative(score) && score > saved.bestScore;
  if (isNewBest) {
    saved.bestScore = score;
    saveRecords(saved);
  }
  return { best: saved.bestScore, isNewBest };
}

export function getCourseRecord(seed: number): CourseRecord | null {
  const course = readRecords().courses[String(seed >>> 0)];
  return course ? { ...course } : null;
}

/** Only successful finishes enter the time leaderboard; wipeouts keep points. */
export function recordCourse(
  seed: number, score: number, finishTimeSeconds: number | null
): { record: CourseRecord; isNewScore: boolean; isNewTime: boolean; previousBestTime: number | null } {
  const saved = readRecords();
  const key = String(seed >>> 0);
  const previous = saved.courses[key];
  const validScore = nonNegative(score) ? score : 0;
  const validTime = nonNegative(finishTimeSeconds) && finishTimeSeconds > 0 ? finishTimeSeconds : null;
  const previousBestTime = previous?.bestTimeSeconds ?? null;
  const isNewScore = validScore > (previous?.bestScore ?? 0);
  const isNewTime = validTime !== null && (previousBestTime === null || validTime < previousBestTime);
  const record: CourseRecord = {
    bestScore: Math.max(previous?.bestScore ?? 0, validScore),
    bestTimeSeconds: isNewTime ? validTime : previousBestTime,
    attempts: (previous?.attempts ?? 0) + 1,
    lastPlayed: Date.now()
  };
  saved.courses[key] = record;
  // Preserve the course just played even if the system clock moved backwards.
  trimCourses(saved, key);
  saveRecords(saved);
  return { record: { ...record }, isNewScore, isNewTime, previousBestTime };
}
