import { COURSE_VERSION, hashIdentity, RULES_VERSION } from './rules';
import { newRunId, type RaceOptions, type RunSummary } from './race';

/** The calendar date is always UTC, including around midnight and DST. */
export function utcDate(now: Date | number = new Date()): string {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid date');
  return date.toISOString().slice(0, 10);
}
export function validDailyDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(time) && utcDate(time) === date;
}
export function dailySeed(date: string): number {
  if (!validDailyDate(date)) throw new RangeError('Daily dates use YYYY-MM-DD (UTC)');
  return hashIdentity(`BDB/daily/${RULES_VERSION}/${COURSE_VERSION}/${date}`);
}
export function dailyRace(date: string = utcDate(), practice = false): RaceOptions {
  return { mode: practice ? 'practice' : 'daily', seed: dailySeed(date), dailyDate: date, runId: newRunId('daily') };
}

/** Links never silently replay unsupported rules or a seed that disagrees with
 * its date. Past/future dates are practice, preserving today's competition. */
export function parseChallenge(search: string, today: string = utcDate()): RaceOptions | null {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const date = params.get('daily');
    if (!validDailyDate(date)) return null;
    if (params.get('rules') !== RULES_VERSION || params.get('course') !== COURSE_VERSION) return null;
    if (params.has('seed') && params.get('seed') !== String(dailySeed(date))) return null;
    return dailyRace(date, date !== today || params.get('practice') === '1');
  } catch { return null; }
}
export function challengeUrl(options: RaceOptions, baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  // Do not leak unrelated debug/account query parameters or fragments.
  url.search = '';
  url.hash = '';
  if (options.dailyDate && validDailyDate(options.dailyDate)) url.searchParams.set('daily', options.dailyDate);
  url.searchParams.set('seed', String(options.seed >>> 0));
  url.searchParams.set('rules', RULES_VERSION);
  url.searchParams.set('course', COURSE_VERSION);
  if (options.mode === 'practice') url.searchParams.set('practice', '1');
  return url.toString();
}
export function shareResultText(options: RaceOptions, result: RunSummary, baseUrl?: string): string {
  const title = options.dailyDate ? `UTC daily ${options.dailyDate}` : `Mountain #${options.seed >>> 0}`;
  const outcome = result.finished ? `${result.finishTimeSeconds.toFixed(2)}s, place ${result.position}/5` : 'DNF';
  const lines = [
    `Black Diamond Brawl · ${title}${options.mode === 'practice' ? ' (practice)' : ''}`,
    `${outcome} · ${Math.round(result.total).toLocaleString('en-US')} points`,
    `Seed ${options.seed >>> 0} · rules ${RULES_VERSION} · course ${COURSE_VERSION}`,
    'Self-reported local result. No online leaderboard.'
  ];
  if (baseUrl) {
    try { const url = challengeUrl(options, baseUrl); if (url) lines.push(url); } catch { /* Native schemes use the reproducible text. */ }
  }
  return lines.join('\n');
}
