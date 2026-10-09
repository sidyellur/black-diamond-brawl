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

function readRecords(): Records {
  if (records) return records;
  records = { bestScore: 0, courses: {} };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return records;
    const saved = raw as Partial<Records>;
    if (nonNegative(saved.bestScore)) records.bestScore = saved.bestScore;
    if (saved.courses && typeof saved.courses === 'object') {
      const entries = Object.entries(saved.courses)
        .filter(([seed, course]) => /^\d{1,10}$/.test(seed) && Number(seed) <= 0xffffffff &&
          course && typeof course === 'object' && nonNegative(course.bestScore) &&
          nonNegative(course.attempts) && nonNegative(course.lastPlayed) &&
          (course.bestTimeSeconds === null || (nonNegative(course.bestTimeSeconds) && course.bestTimeSeconds > 0)))
        .sort(([, a], [, b]) => b.lastPlayed - a.lastPlayed)
        .slice(0, MAX_COURSES);
      for (const [seed, course] of entries) {
        records.courses[seed] = { ...course, attempts: Math.floor(course.attempts) };
      }
    }
  } catch {
    // Blocked storage, private browsing, corrupt JSON, and SSR all remain playable.
  }
  return records;
}

function saveRecords(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readRecords()));
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
    saveRecords();
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
  const oldest = Object.keys(saved.courses).sort((a, b) => saved.courses[a].lastPlayed - saved.courses[b].lastPlayed);
  while (oldest.length > MAX_COURSES) {
    const expired = oldest.shift()!;
    // Preserve the course just played even if the system clock moved backwards.
    if (expired !== key) delete saved.courses[expired];
    else oldest.push(expired);
  }
  saveRecords();
  return { record: { ...record }, isNewScore, isNewTime, previousBestTime };
}
