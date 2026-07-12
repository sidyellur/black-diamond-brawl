/**
 * Session-best score (design-spec §4.7/§6): "no persistence — session-best
 * only, in memory." A module-level variable is the whole implementation —
 * it naturally survives a `RaceScene`/`ResultScene` restart (Phaser reuses
 * the same scene instances, but this lives outside any scene entirely) and
 * is just as naturally wiped by a full page reload, matching "no save data"
 * exactly.
 */
let bestScore = 0;

/** Records `score` as this run's result; returns the session-best AFTER
 *  factoring it in, and whether this run just set a new one. */
export function recordScore(score: number): { best: number; isNewBest: boolean } {
  const isNewBest = score > bestScore;
  if (isNewBest) {
    bestScore = score;
  }
  return { best: bestScore, isNewBest };
}
