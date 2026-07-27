/**
 * Measures the rock-tumble steering lock against the solvability model.
 *
 * The placement DP guarantees every obstacle row has a clear lane *reachable*
 * from the previous one, budgeting `LANE_CHANGE_SEGMENTS` per lane of travel.
 * It models exactly one source of lost steering: the crest lock. It does not
 * model the rock tumble — `ROCK_TUMBLE_MS` of zero steering after a rock hit.
 *
 * This quantifies the gap rather than guessing at it, because closing it in
 * the DP would change generated geometry for every existing seed. Measure
 * first, then decide.
 *
 * Usage: npm run measure:rocklock
 */
import {
  LANE_CHANGE_SEGMENTS,
  MAX_SPEED,
  PLAYER_ACCEL,
  ROCK_SPEED_FACTOR,
  ROCK_TUMBLE_MS,
  SEGMENT_LENGTH
} from '../src/config';
import { generateTrack } from '../src/track/generator';

/** Distance covered while unable to steer after a rock hit, from full speed. */
function tumbleDistanceUnits(): number {
  const startSpeed = MAX_SPEED * ROCK_SPEED_FACTOR;
  const seconds = ROCK_TUMBLE_MS / 1000;
  // Speed recovers linearly at PLAYER_ACCEL, clamped at MAX_SPEED.
  const endSpeed = Math.min(MAX_SPEED, startSpeed + PLAYER_ACCEL * seconds);
  return ((startSpeed + endSpeed) / 2) * seconds;
}

const lockUnits = tumbleDistanceUnits();
const lockSegments = lockUnits / SEGMENT_LENGTH;

console.log('\n=== rock-tumble steering lock ===');
console.log(`  ROCK_TUMBLE_MS            ${ROCK_TUMBLE_MS} ms`);
console.log(`  speed after hit           ${(MAX_SPEED * ROCK_SPEED_FACTOR).toFixed(0)} u/s`);
console.log(`  distance while locked     ${lockUnits.toFixed(0)} u = ${lockSegments.toFixed(1)} segments`);
console.log(`  lanes of steering lost    ${(lockSegments / LANE_CHANGE_SEGMENTS).toFixed(1)}`);

// How many obstacle rows can a single tumble carry the player through, and how
// often is a rock positioned so that the tumble spans a later row?
const SEEDS = 200;
let rowsSpannedTotal = 0;
let worstSpan = 0;
let rockCount = 0;
let rocksSpanningARow = 0;
const gaps: number[] = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const { obstacles } = generateTrack(seed);

  // Obstacle rows = distinct Z values, sorted.
  const rowZs = [...new Set(obstacles.map((o) => o.z))].sort((a, b) => a - b);
  for (let i = 1; i < rowZs.length; i++) {
    gaps.push((rowZs[i] - rowZs[i - 1]) / SEGMENT_LENGTH);
  }

  for (const rock of obstacles.filter((o) => o.kind === 'rock')) {
    rockCount++;
    const end = rock.z + lockUnits;
    // Rows strictly after the rock that fall inside the lock window.
    const spanned = rowZs.filter((z) => z > rock.z && z <= end).length;
    rowsSpannedTotal += spanned;
    worstSpan = Math.max(worstSpan, spanned);
    if (spanned > 0) rocksSpanningARow++;
  }
}

gaps.sort((a, b) => a - b);
const pct = (p: number): number => gaps[Math.floor(gaps.length * p)];

console.log(`\n=== obstacle row spacing (${SEEDS} seeds, ${gaps.length} gaps) ===`);
console.log(`  min ${gaps[0].toFixed(1)}  p10 ${pct(0.1).toFixed(1)}  median ${pct(0.5).toFixed(1)}  p90 ${pct(0.9).toFixed(1)} segments`);

console.log(`\n=== exposure ===`);
console.log(`  rocks examined            ${rockCount}`);
console.log(`  rocks whose tumble spans >= 1 later row   ${rocksSpanningARow} (${((rocksSpanningARow / rockCount) * 100).toFixed(1)}%)`);
console.log(`  mean rows spanned per rock                ${(rowsSpannedTotal / rockCount).toFixed(2)}`);
console.log(`  worst case rows spanned by one tumble     ${worstSpan}`);

console.log(`\nNOTE: spanning a row is NOT automatically a forced death. The player`);
console.log(`keeps whatever lane they were in, and that lane may well be clear —`);
console.log(`the DP only guarantees a clear lane exists and is reachable, not that`);
console.log(`the CURRENT lane stays clear. What this measures is how often a rock`);
console.log(`hit removes the player's ability to respond to the next row at all.`);

// ---------------------------------------------------------------------------
// The precise forced-death condition.
//
// A player who hits a rock is, by definition, in that rock's lane, and cannot
// steer for the whole lock window. So the unavoidable-kill case is exact:
// a TREE in the SAME LANE as the rock, within the lock distance. Nothing the
// player can do avoids it — they are already committed when the rock lands.
//
// Rocks and moguls inside the window are survivable (speed loss, no run end),
// so only trees count.
// ---------------------------------------------------------------------------
let forcedDeaths = 0;
let rocksChecked = 0;
const offenders: string[] = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const { obstacles } = generateTrack(seed);
  const trees = obstacles.filter((o) => o.kind === 'tree');
  for (const rock of obstacles.filter((o) => o.kind === 'rock')) {
    rocksChecked++;
    const killer = trees.find(
      (t) => t.lane === rock.lane && t.z > rock.z && t.z <= rock.z + lockUnits
    );
    if (killer) {
      forcedDeaths++;
      if (offenders.length < 5) {
        offenders.push(
          `seed ${seed}: rock lane ${rock.lane} @ z=${rock.z} -> tree @ z=${killer.z} (+${((killer.z - rock.z) / SEGMENT_LENGTH).toFixed(1)} seg)`
        );
      }
    }
  }
}

console.log(`\n=== FORCED DEATHS (tree in the rock's own lane, inside the lock) ===`);
console.log(`  rocks checked             ${rocksChecked}`);
console.log(`  unavoidable tree kills    ${forcedDeaths} (${((forcedDeaths / rocksChecked) * 100).toFixed(2)}%)`);
for (const o of offenders) console.log(`    ${o}`);
if (forcedDeaths === 0) {
  console.log(`\n  No forced deaths found. The rock lock is a real gap in the DP's`);
  console.log(`  model, but placement's existing same-lane spacing rules happen to`);
  console.log(`  keep trees out of the window in practice.\n`);
} else {
  console.log(`\n  These are unavoidable run-ending deaths: the player is committed`);
  console.log(`  to the rock's lane and cannot steer out before the tree.\n`);
}
