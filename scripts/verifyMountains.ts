import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  BLIND_LANDING_SEGMENTS, CAMERA_HEIGHT, CHUTE_FUNNEL_SEGMENTS, CHUTE_MAX_SEGMENTS, CHUTE_MIN_SEGMENTS, CHUTE_WALL_SPACING, COURSE_LENGTH_SEGMENTS, DRAW_DISTANCE, ICE_EDGE_MARGIN_SEGMENTS, ICE_MAX_SEGMENTS,
  ICE_MIN_SEGMENTS, ICE_TREE_FREE_SEGMENTS, JUMP_REACH_EXTENDED, LANES,
  POWDER_ENTRY_MOGULS_MIN, POWDER_MAX_SEGMENTS, POWDER_MIN_SEGMENTS, SEGMENT_LENGTH
} from '../src/config';
import { chuteEnd } from '../src/track/chute';
import { generateTrack } from '../src/track/generator';
import { MOUNTAIN_GENERATOR_VERSION, MountainTheme, sectionAtZ } from '../src/track/mountain';
import { roadElevationAt } from '../src/track/segment';
import { surfaceAtZ } from '../src/track/surface';
import { RoadRenderer } from '../src/render/RoadRenderer';
import { SceneryRenderer } from '../src/render/SceneryRenderer';
import { deltaL } from '../src/render/palette';

const started = performance.now();
const variants = new Set<string>();
const layouts = new Set<string>();
const totals = { forests: 0, ridges: 0, bowls: 0, crests: 0, combatSegments: 0, obstacles: 0 };
const powderStats = { fields: 0, minLength: Infinity, maxLength: 0, threeMogulFields: 0, hillFields: 0, curveFields: 0,
  minTreeDistanceAfterEntry: Infinity };
const chuteStats = { courses: 0, walls: 0, inner: 0, removed: 0, demoted: 0, thinned: 0, minLength: Infinity, maxLength: 0,
  sections: new Set<string>(), bySection: { first: 0, second: 0 } };
const forestStats = { gateRowsKept: 0, minGates: Infinity };
const iceStats = { sheets: 0, minLength: Infinity, maxLength: 0, thinnedSheets: 0, thinnedObstacles: 0, minForestGap: Infinity,
  minCrestGap: Infinity, withRows: 0 };
for (let seed = 0; seed < 1000; seed++) {
  const track = generateTrack(seed);
  assert.equal(track.generatorVersion, MOUNTAIN_GENERATOR_VERSION);
  assert.equal(track.segments.length, COURSE_LENGTH_SEGMENTS);
  assert.equal(track.sections.length, 8);
  assert.deepEqual(track, generateTrack(seed), `seed ${seed}: all four generation passes deterministic`);
  assert.equal(track.segments.filter((segment) => segment.isFinish).length, 1);
  assert.ok(track.segments.at(-1)!.isFinish);
  const first = track.sections[0];
  const last = track.sections.at(-1)!;
  assert.equal(first.startSegment, 0);
  assert.equal(first.endSegment, 100);
  assert.equal(last.endSegment, COURSE_LENGTH_SEGMENTS);
  assert.equal(sectionAtZ(track.sections, -100), first);
  assert.equal(sectionAtZ(track.sections, Infinity), undefined);
  assert.equal(sectionAtZ(track.sections, COURSE_LENGTH_SEGMENTS * SEGMENT_LENGTH), last);
  assert.equal(sectionAtZ([], 0), undefined);

  const rowMap = new Map<number, Set<number>>();
  for (const obstacle of track.obstacles) {
    const segment = track.segments[obstacle.segIndex];
    assert.equal(segment.safeZone, undefined, `${seed}: obstacle in ${segment.safeZone} at ${segment.index}`);
    if (segment.theme !== 'forest') assert.notEqual(obstacle.kind, 'tree', 'exposed terrain is treeless');
    if (!rowMap.has(obstacle.segIndex)) rowMap.set(obstacle.segIndex, new Set());
    rowMap.get(obstacle.segIndex)!.add(obstacle.lane);
  }
  for (let index = 0; index < track.segments.length; index++) {
    const segment = track.segments[index];
    assert.equal(segment.index, index);
    assert.equal(segment.z, index * SEGMENT_LENGTH);
    assert.ok(Number.isFinite(segment.y));
    assert.ok(Number.isFinite(segment.curve) && Math.abs(segment.curve) <= 1);
    assert.ok(segment.sectionIndex !== undefined);
    const section = track.sections[segment.sectionIndex];
    assert.ok(index >= section.startSegment && index < section.endSegment);
    assert.equal(section.theme, segment.theme);
    assert.equal(section.setpiece, segment.setpiece);
    if (index < 100 || index >= COURSE_LENGTH_SEGMENTS - 41) {
      assert.equal(segment.y, 0, 'flat warmup and final runout');
      assert.equal(segment.curve, 0);
    }
  }
  const themeCounts = { forest: 0, ridge: 0, bowl: 0 };
  for (let sectionIndex = 0; sectionIndex < track.sections.length; sectionIndex++) {
    const section = track.sections[sectionIndex];
    if (sectionIndex > 0) assert.equal(section.startSegment, track.sections[sectionIndex - 1].endSegment);
    assert.equal(sectionAtZ(track.sections, section.startSegment * SEGMENT_LENGTH), section);
    assert.equal(sectionAtZ(track.sections, section.endSegment * SEGMENT_LENGTH - 0.1), section);
    if (section.setpiece === 'warmup' || section.setpiece === 'runout') continue;
    variants.add(section.setpiece);
    themeCounts[section.theme]++;
    const segments = track.segments.slice(section.startSegment, section.endSegment);
    assert.ok(segments.length >= 180 && segments.length <= 255);
    assert.ok(segments.slice(0, 10).every((segment) => segment.safeZone === 'transition' && segment.curve === 0));
    assert.ok(segments.slice(-10).every((segment) => segment.safeZone === 'transition' && segment.curve === 0));
    const rows = [...rowMap].filter(([index]) => index >= section.startSegment && index < section.endSegment);
    const crests = track.crestApexes.filter((index) => index >= section.startSegment && index < section.endSegment);
    if (section.theme === 'forest') {
      totals.forests++;
      assert.equal(crests.length, 0);
      assert.ok(segments.some((segment) => segment.curve > 0.4));
      assert.ok(segments.some((segment) => segment.curve < -0.4));
      // The tree chute (#39) replaces the gates inside its funnel and walls, so the slalom assertions below
      // are about the gates that remain, taken as two runs (before and after the chute): the chute
      // re-centres the rider on the inner lanes, so successive gates are not asked to overlap across it.
      const chute = track.chute.find((c) => c.sectionIndex === sectionIndex);
      const inChute = (index: number) => !!chute && index >= chute.funnelStart && index < chuteEnd(chute);
      const gates = rows.filter(([index]) => !inChute(index));
      assert.ok(gates.length >= 4, `${seed}: ${gates.length} slalom gates remain around the chute`);
      const runs: number[][] = [[]];
      for (const [index, blocked] of gates) {
        assert.equal(blocked.size, LANES.length - 2, 'slalom gate has exactly two open lanes');
        assert.ok(track.segments[index].slalomLane !== undefined);
        assert.ok(!track.segments[index].chute && !track.segments[index].chuteFunnel, 'a gate is never a chute row');
        const clear = LANES.map((_, lane) => lane).filter((lane) => !blocked.has(lane));
        assert.equal(clear[1] - clear[0], 1, 'readable adjacent opening');
        if (chute && index >= chuteEnd(chute) && runs.length === 1) runs.push([]);
        runs.at(-1)!.push(clear[0]);
      }
      const desired = runs.flat();
      assert.ok(Math.max(...desired) - Math.min(...desired) >= 1, 'forest physically asks for lane changes');
      for (const run of runs) assert.ok(run.every((lane, i) => i === 0 || Math.abs(lane - run[i - 1]) <= 1), 'successive gates overlap');
      assert.ok(runs.reduce((n, run) => n + run.filter((lane, i) => i > 0 && run[i - 1] !== lane).length, 0) >= 2);
      forestStats.gateRowsKept += gates.length;
      forestStats.minGates = Math.min(forestStats.minGates, gates.length);
    } else if (section.theme === 'ridge') {
      totals.ridges++;
      assert.ok(crests.length >= 1 && crests.length <= 2);
      for (const apex of crests) {
        assert.ok(track.segments[apex].y > track.segments[apex - 10].y);
        assert.ok(track.segments[apex].y > track.segments[apex + 10].y);
        assert.ok(apex + BLIND_LANDING_SEGMENTS < section.endSegment - 10);
        for (let i = apex - 9; i <= apex + BLIND_LANDING_SEGMENTS; i++) assert.ok(!rowMap.has(i));
      }
    } else {
      totals.bowls++;
      assert.equal(crests.length, 0);
      const arena = segments.filter((segment) => segment.safeZone === 'combat');
      assert.ok(arena.length >= 70, 'at least 4.6 seconds full-speed combat space');
      assert.ok(arena.every((segment) => segment.curve === 0 && segment.y === arena[0].y));
      // Bowl rows block one lane, except the entry row of the powder field.
      const field = track.powder.filter((f) => f.sectionIndex === sectionIndex);
      assert.equal(field.length, 1, `${seed}: exactly one powder field per bowl section`);
      assert.ok(rows.every(([index, blocked]) => blocked.size <= 1 || index === field[0].start));
      totals.combatSegments += arena.length;
    }
  }
  assert.deepEqual(themeCounts, { forest: 2, ridge: 2, bowl: 2 });
  const names = track.sections.slice(1, -1).map((section) => section.name);
  assert.equal(new Set(names).size, 6, 'no repeated named feature within one mountain');
  // ---- powder fields (#39) ------------------------------------------------
  // Only the six stage bowls carry powder: not the warm-up, forests, ridges or the finish runout.
  const surfaced = track.segments.filter((segment) => segment.surface !== undefined);
  assert.ok(surfaced.every((segment) => segment.surface === 'powder' || segment.surface === 'ice'), 'only powder and ice are surfaces');
  assert.equal(track.powder.length, 2, `${seed}: one field in each of the two bowl sections`);
  assert.equal(surfaced.filter((segment) => segment.surface === 'powder').length, track.powder.reduce((n, f) => n + f.length, 0),
    'no powder outside the recorded fields');
  for (const field of track.powder) {
    const section = track.sections[field.sectionIndex];
    assert.equal(section.theme, 'bowl');
    assert.notEqual(section.setpiece, 'runout');
    assert.ok(field.length >= POWDER_MIN_SEGMENTS && field.length <= POWDER_MAX_SEGMENTS, `${seed}: length ${field.length}`);
    const end = field.start + field.length;
    assert.ok(field.start >= section.startSegment && end <= section.endSegment, 'field stays inside its bowl');
    for (let index = field.start; index < end; index++) {
      assert.equal(track.segments[index].surface, 'powder');
      assert.equal(track.segments[index].safeZone, undefined, 'never over the combat arena or a transition');
      assert.equal(surfaceAtZ(track.segments, index * SEGMENT_LENGTH + 1), 'powder');
    }
    assert.equal(surfaceAtZ(track.segments, (field.start - 1) * SEGMENT_LENGTH + 1), undefined, 'ordinary piste before the field');
    assert.equal(surfaceAtZ(track.segments, end * SEGMENT_LENGTH + 1), undefined, 'ordinary piste after the field');
    // Entry rule: moguls in at least two lanes on the first powder segment, and they are real placed obstacles.
    const entry = track.obstacles.filter((o) => o.segIndex === field.start);
    assert.deepEqual(entry.map((o) => o.lane).sort(), [...field.moguls].sort());
    assert.ok(entry.length >= POWDER_ENTRY_MOGULS_MIN && entry.every((o) => o.kind === 'mogul'), `${seed}: entry moguls`);
    assert.equal(new Set(entry.map((o) => o.lane)).size, entry.length);
    assert.ok(entry.length < LANES.length - 1, 'at least two lanes stay clear at the entry');
    // Mogul jump-reach rule, checked explicitly across the bowl-to-forest hand-off.
    const trees = track.obstacles.filter((o) => o.kind === 'tree' && o.segIndex > field.start);
    for (const mogul of entry) {
      assert.ok(!trees.some((t) => t.lane === mogul.lane && t.segIndex <= field.start + JUMP_REACH_EXTENDED),
        `${seed}: tree inside an entry mogul's jump reach`);
    }
    if (trees.length) powderStats.minTreeDistanceAfterEntry = Math.min(powderStats.minTreeDistanceAfterEntry, trees[0].segIndex - field.start);
    powderStats.fields++;
    powderStats.minLength = Math.min(powderStats.minLength, field.length);
    powderStats.maxLength = Math.max(powderStats.maxLength, field.length);
    if (entry.length > POWDER_ENTRY_MOGULS_MIN) powderStats.threeMogulFields++;
    const arenaStart = track.segments.slice(section.startSegment, section.endSegment).findIndex((s) => s.safeZone === 'combat') + section.startSegment;
    if (field.start < arenaStart) powderStats.hillFields++; else powderStats.curveFields++;
  }
  // ---- ice sheets (#39, part 2) -------------------------------------------
  // One sheet in each of the two ridge sections and nowhere else: not the warm-up, forests, bowls or runout.
  assert.equal(track.ice.length, 2, `${seed}: one sheet in each of the two ridge sections`);
  assert.equal(surfaced.filter((segment) => segment.surface === 'ice').length, track.ice.reduce((n, sheet) => n + sheet.length, 0),
    'no ice outside the recorded sheets');
  assert.deepEqual(track.ice.map((sheet) => track.sections[sheet.sectionIndex].theme), ['ridge', 'ridge']);
  assert.equal(new Set(track.ice.map((sheet) => sheet.sectionIndex)).size, 2, 'exactly one sheet per ridge section');
  for (const sheet of track.ice) {
    const section = track.sections[sheet.sectionIndex];
    const end = sheet.start + sheet.length;
    assert.ok(sheet.length >= ICE_MIN_SEGMENTS && sheet.length <= ICE_MAX_SEGMENTS, `${seed}: ice length ${sheet.length}`);
    assert.ok(sheet.start >= section.startSegment && end <= section.endSegment, 'sheet stays inside its ridge');
    for (let index = sheet.start; index < end; index++) {
      assert.equal(track.segments[index].surface, 'ice');
      assert.equal(track.segments[index].safeZone, undefined, 'never over a transition, take-off, apex or landing');
      assert.equal(surfaceAtZ(track.segments, index * SEGMENT_LENGTH + 1), 'ice');
    }
    assert.equal(surfaceAtZ(track.segments, (sheet.start - 1) * SEGMENT_LENGTH + 1), undefined, 'ordinary piste before the sheet');
    assert.equal(surfaceAtZ(track.segments, end * SEGMENT_LENGTH + 1), undefined, 'ordinary piste after the sheet');
    // Ice never meets a jump: nobody lands on it, takes off from it or is locked in the air over it.
    for (const apex of track.crestApexes) {
      const gap = apex > end ? apex - 9 - end : sheet.start - (apex + BLIND_LANDING_SEGMENTS) - 1;
      assert.ok(apex - 9 >= end || apex + BLIND_LANDING_SEGMENTS < sheet.start, `${seed}: ice overlaps the jump at ${apex}`);
      iceStats.minCrestGap = Math.min(iceStats.minCrestGap, gap);
    }
    // Tree-free margin: no tree on the ice or within ICE_TREE_FREE_SEGMENTS after it, and no forest begins that close.
    assert.ok(!track.obstacles.some((o) => o.kind === 'tree' && o.segIndex >= sheet.start && o.segIndex < end + ICE_TREE_FREE_SEGMENTS),
      `${seed}: tree on or within ${ICE_TREE_FREE_SEGMENTS} segments after ice`);
    const nextForest = track.sections.find((candidate) => candidate.theme === 'forest' && candidate.startSegment >= end);
    assert.ok(!nextForest || nextForest.startSegment - end >= ICE_TREE_FREE_SEGMENTS, `${seed}: forest begins too soon after ice`);
    if (nextForest) iceStats.minForestGap = Math.min(iceStats.minForestGap, nextForest.startSegment - end);
    assert.ok(!track.segments.slice(sheet.start, end + ICE_TREE_FREE_SEGMENTS).some((segment) => segment.theme === 'forest'));
    assert.ok(sheet.start - ICE_EDGE_MARGIN_SEGMENTS >= section.startSegment);
    iceStats.sheets++;
    iceStats.minLength = Math.min(iceStats.minLength, sheet.length);
    iceStats.maxLength = Math.max(iceStats.maxLength, sheet.length);
    if (sheet.thinned > 0) { iceStats.thinnedSheets++; iceStats.thinnedObstacles += sheet.thinned; }
    if (track.obstacles.some((o) => o.segIndex >= sheet.start && o.segIndex < end)) iceStats.withRows++;
  }
  layouts.add(JSON.stringify(track.sections));
  totals.crests += track.crestApexes.length;
  totals.obstacles += track.obstacles.length;
}
assert.equal(variants.size, 9);
assert.equal(layouts.size, 1000, 'seeded structure, names and lengths vary');
const generationMs = performance.now() - started;
console.log(`PASS 1,000 mountains: exact budgets, metadata boundaries, deterministic content, distinct riding rhythms and safe transitions (${Math.round(generationMs)} ms).`);
console.log(JSON.stringify(totals));
assert.equal(powderStats.fields, 2000);
assert.ok(powderStats.minLength === POWDER_MIN_SEGMENTS && powderStats.maxLength === POWDER_MAX_SEGMENTS, 'full length range is exercised');
assert.ok(powderStats.threeMogulFields > 0 && powderStats.hillFields > 0 && powderStats.curveFields > 0, 'variety in lanes and placement');
// 20 protected transition segments sit between a bowl's last placeable segment and any forest tree, so an
// entry mogul can never put a tree inside its 18-segment jump reach; the explicit check above enforces it.
assert.ok(powderStats.minTreeDistanceAfterEntry > JUMP_REACH_EXTENDED);
console.log(`PASS powder: ${powderStats.fields} fields over 1,000 seeds (two per mountain), ${powderStats.minLength}-${powderStats.maxLength} segments, ` +
  `${powderStats.hillFields} on the entry hill / ${powderStats.curveFields} on the exit curve, ${powderStats.threeMogulFields} with three entry moguls; ` +
  `nearest tree after any entry mogul: ${powderStats.minTreeDistanceAfterEntry} segments (reach ${JUMP_REACH_EXTENDED}).`);

assert.equal(iceStats.sheets, 2000);
assert.ok(iceStats.minLength === ICE_MIN_SEGMENTS && iceStats.maxLength === ICE_MAX_SEGMENTS, 'full ice length range is exercised');
assert.ok(iceStats.minForestGap >= ICE_TREE_FREE_SEGMENTS);
console.log(`PASS ice: ${iceStats.sheets} sheets over 1,000 seeds (two per mountain, one per ridge), ${iceStats.minLength}-${iceStats.maxLength} segments, ` +
  `${iceStats.withRows} hold at least one obstacle row; nearest forest after any sheet: ${iceStats.minForestGap} segments (margin ${ICE_TREE_FREE_SEGMENTS}); ` +
  `nearest jump zone: ${iceStats.minCrestGap} segments; ${iceStats.thinnedSheets} sheets needed obstacles thinned (${iceStats.thinnedObstacles} obstacles).`);

// ---- tree chute (#39, part 3) -------------------------------------------------------------------
for (let seed = 0; seed < 1000; seed++) {
  const track = generateTrack(seed);
  assert.equal(track.chute.length, 1, `${seed}: exactly one chute per course`);
  const chute = track.chute[0];
  const section = track.sections[chute.sectionIndex];
  const end = chuteEnd(chute);
  assert.equal(section.theme, 'forest');
  assert.notEqual(section.setpiece, 'warmup', 'never the warm-up lodge');
  assert.ok(chute.length >= CHUTE_MIN_SEGMENTS && chute.length <= CHUTE_MAX_SEGMENTS, `${seed}: chute length ${chute.length}`);
  assert.equal(chute.start - chute.funnelStart, CHUTE_FUNNEL_SEGMENTS);
  assert.ok(chute.funnelStart >= section.startSegment && end <= section.endSegment, 'chute stays inside its forest');
  assert.equal(track.chute.filter((c) => c.sectionIndex === chute.sectionIndex).length, 1);
  // Segment flags: funnel then walls, nothing else, and never over a safe zone.
  const flagged = track.segments.filter((segment) => segment.chute || segment.chuteFunnel);
  assert.equal(flagged.length, CHUTE_FUNNEL_SEGMENTS + chute.length);
  for (let index = chute.funnelStart; index < end; index++) {
    const segment = track.segments[index];
    assert.equal(!!segment.chuteFunnel, index < chute.start);
    assert.equal(!!segment.chute, index >= chute.start);
    assert.equal(segment.safeZone, undefined);
    assert.equal(segment.theme, 'forest');
  }
  // Entry funnel: obstacle-free (the pole markers are drawn on exactly these segments).
  assert.ok(!track.obstacles.some((o) => o.segIndex >= chute.funnelStart && o.segIndex < chute.start), `${seed}: funnel is obstacle-free`);
  // Walls: a real tree in lanes 0 and 4 on every second segment of the stretch, and only there.
  const walls = track.obstacles.filter((o) => o.wall);
  assert.equal(walls.length, chute.walls);
  assert.equal(walls.length, 2 * Math.ceil(chute.length / CHUTE_WALL_SPACING));
  for (const wall of walls) {
    assert.equal(wall.kind, 'tree');
    assert.ok(wall.lane === 0 || wall.lane === LANES.length - 1);
    assert.ok(wall.segIndex >= chute.start && wall.segIndex < end && (wall.segIndex - chute.start) % CHUTE_WALL_SPACING === 0);
  }
  // Inside the stretch: rocks and moguls in the inner lanes only, at least one inner lane clear in every row.
  const inside = track.obstacles.filter((o) => !o.wall && o.segIndex >= chute.start && o.segIndex < end);
  assert.equal(inside.length, chute.inner);
  assert.ok(inside.every((o) => o.kind !== 'tree' && o.lane >= 1 && o.lane <= LANES.length - 2), `${seed}: inner rows are rocks and moguls in lanes 1-3`);
  assert.ok(track.obstacles.filter((o) => o.segIndex >= chute.start && o.segIndex < end && o.kind === 'tree').every((o) => o.wall), 'no other tree');
  const rowsInside = new Map<number, Set<number>>();
  for (const o of inside) { if (!rowsInside.has(o.segIndex)) rowsInside.set(o.segIndex, new Set()); rowsInside.get(o.segIndex)!.add(o.lane); }
  assert.ok([...rowsInside.values()].every((lanes) => lanes.size < LANES.length - 2), 'an inner lane is clear in every row');
  // Mogul rule: nothing in a wall lane before the walls can launch a rider into them, and inner moguls clear every tree downstream.
  const treesAll = track.obstacles.filter((o) => o.kind === 'tree');
  for (const mogul of track.obstacles.filter((o) => o.kind === 'mogul')) {
    assert.ok(!treesAll.some((t) => t.lane === mogul.lane && t.segIndex > mogul.segIndex && t.segIndex <= mogul.segIndex + JUMP_REACH_EXTENDED),
      `${seed}: mogul at ${mogul.segIndex} lane ${mogul.lane} launches into a tree`);
  }
  // Kept outside the chute: the generator touched nothing else except what it reports.
  chuteStats.courses++;
  chuteStats.walls += walls.length;
  chuteStats.inner += inside.length;
  chuteStats.removed += chute.removed;
  chuteStats.demoted += chute.demoted;
  chuteStats.thinned += chute.thinned;
  chuteStats.minLength = Math.min(chuteStats.minLength, chute.length);
  chuteStats.maxLength = Math.max(chuteStats.maxLength, chute.length);
  chuteStats.sections.add(section.setpiece);
  chuteStats.bySection[section.id.startsWith('forest-0') ? 'first' : 'second']++;
}
assert.equal(chuteStats.courses, 1000, 'every seed hosts a chute');
assert.ok(chuteStats.minLength === CHUTE_MIN_SEGMENTS && chuteStats.maxLength === CHUTE_MAX_SEGMENTS, 'the full chute length range is exercised');
assert.equal(chuteStats.sections.size, 3, 'chutes land in all three forest setpieces');
assert.ok(chuteStats.bySection.first > 300 && chuteStats.bySection.second > 300, 'both forest sections are used');
console.log(`PASS chute: one per course over 1,000 seeds (${chuteStats.minLength}-${chuteStats.maxLength} segments, ${chuteStats.bySection.first} in the first forest / ${chuteStats.bySection.second} in the second), ` +
  `${chuteStats.walls / 1000} wall trees and ${chuteStats.inner / 1000} inner rock/mogul per course, ${chuteStats.removed / 1000} obstacles replaced per course; ` +
  `${chuteStats.demoted} outer-lane moguls demoted before a funnel, ${chuteStats.thinned} rows thinned after a chute; ` +
  `slalom gates kept around it: at least ${forestStats.minGates} per forest section (${(forestStats.gateRowsKept / 2000).toFixed(1)} on average).`);

// Powder, ice and the chute must not re-roll anything they do not own. Hashes recorded on `main`: segments (surface
// and chute flags aside), sections, rival parameters, and the obstacles outside the chute (funnel plus walled stretch)
// minus the entry moguls powder appends. Ice leaves the rows untouched: it is placed where the existing field already
// passes its stricter lane-change cost. The chute replaces what stood in its own stretch, so the obstacle pin is of
// everything else, as `main` had it. (Pins 1, 2 and 4 are unchanged since before powder existed; pin 3 was the hash of
// ALL pre-powder obstacles until the chute, which removes 3-6 of them per course: it was re-recorded from `main`'s own
// obstacle lists with exactly those stretches cut out, and the whole-course comparison over 400+ seeds is in verifyChute.)
{
  const PINNED_MAIN: Record<number, [string, string, string, string]> = {
    1: ['9a71d3264a2f', '7bbf6d93ca86', '8454d9eb0b90', '52ed29de7f9f'],
    42: ['2a740e57cf06', '0bee60a0a09b', '2e0eb3c3ed88', 'eb88fd2f071f'],
    202: ['4c4e371cddac', '26a439bc05fc', '1c61f7176632', '4c07497ce21a'],
    333: ['a64f7e9e68d9', '124ac6b5a346', 'fafeb97c29c7', 'f6452d635bec'],
    400: ['dafe6963ad53', '776a410edbda', 'e8f7e7649ff4', 'ea3554fec739']
  };
  const h = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
  const actual: typeof PINNED_MAIN = {};
  for (const seed of Object.keys(PINNED_MAIN).map(Number)) {
    const t = generateTrack(seed);
    const entry = new Set(t.powder.flatMap((f) => f.moguls.map((lane) => `${f.start}:${lane}`)));
    const chute = t.chute[0];
    const cut = (o: { segIndex: number }) => o.segIndex >= chute.funnelStart && o.segIndex < chuteEnd(chute);
    actual[seed] = [h(t.segments.map(({ surface: _surface, chute: _chute, chuteFunnel: _funnel, ...rest }) => rest)), h(t.sections),
      h(t.obstacles.filter((o) => !(o.kind === 'mogul' && entry.has(`${o.segIndex}:${o.lane}`)) && !cut(o))), h(t.aiRiders)];
  }
  assert.deepEqual(actual, PINNED_MAIN);
  console.log('PASS powder, ice and the chute leave geometry, sections, rival parameters and every obstacle outside the chute identical to `main`.');
}

// Renderer smoke and bounded pools without a DOM/WebGL dependency. Actual
// browser screenshots remain part of the integration acceptance suite.
let drawCalls = 0;
const graphics: any = new Proxy({}, { get: () => (...args: unknown[]) => {
  for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg));
  drawCalls++;
  return graphics;
}});
const sprites: any[] = [];
const sprite = () => {
  const item: any = { visible: false, frame: '' };
  for (const method of ['setOrigin', 'setPosition', 'setScale', 'setFlipX', 'setDepth', 'setTint', 'setAlpha']) {
    item[method] = (...args: unknown[]) => {
      for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg));
      return item;
    };
  }
  item.setVisible = (visible: boolean) => { item.visible = visible; return item; };
  item.setFrame = (frame: string) => { item.frame = frame; return item; };
  sprites.push(item);
  return item;
};
const scene: any = { add: { graphics: () => graphics, sprite } };
const road = new RoadRenderer(scene);
const scenery = new SceneryRenderer(scene, 42, COURSE_LENGTH_SEGMENTS, () => {});
const sample = generateTrack(42);
let maxSprites = 0;
for (const section of sample.sections) {
  for (let index = section.startSegment; index < section.endSegment; index += 3) {
    const z = (index + 0.25) * SEGMENT_LENGTH;
    const camera = { x: 0, y: roadElevationAt(sample.segments, z) + CAMERA_HEIGHT, z };
    const drawn = road.render(sample.segments, camera.x, camera.y, camera.z, 0xcfe4f5).drawnSegments;
    scenery.render(sample.segments, drawn, camera);
    maxSprites = Math.max(maxSprites, sprites.length);
  }
}
assert.ok(drawCalls > 0);
assert.ok(maxSprites <= 36, `bounded visible scenery pool: ${maxSprites}`);
for (const theme of ['forest', 'ridge', 'bowl'] as MountainTheme[]) {
  const flat = sample.segments.map((segment) => ({ ...segment, curve: 0, y: 0, theme }));
  const camera = { x: 0, y: CAMERA_HEIGHT, z: 200 * SEGMENT_LENGTH };
  const drawn = road.render(flat, 0, CAMERA_HEIGHT, camera.z, 0xcfe4f5).drawnSegments;
  scenery.render(flat, drawn, camera);
  const visible = sprites.filter((item) => item.visible);
  assert.ok(visible.length > 0);
  assert.ok(visible.every((item) => theme === 'forest' ? item.frame.startsWith('tree')
    : item.frame === (theme === 'ridge' ? 'rock' : 'mogul')));
}
{
  // A camera approaching and riding through a powder field draws finite geometry and the stipple.
  const field = sample.powder[0];
  const before = drawCalls;
  for (const offset of [-30, -10, -1, 0, 5, 12]) {
    const z = (field.start + offset + 0.25) * SEGMENT_LENGTH;
    road.render(sample.segments, 0, roadElevationAt(sample.segments, z) + CAMERA_HEIGHT, z, 0xcfe4f5);
  }
  assert.ok(drawCalls - before > 0);
}
{
  // The same for an ice sheet: approach, entry threshold, deep inside and leaving it all draw finite geometry.
  const sheet = sample.ice[0];
  const before = drawCalls;
  for (const offset of [-30, -10, -1, 0, 5, 15, sheet.length - 1, sheet.length + 3]) {
    const z = (sheet.start + offset + 0.25) * SEGMENT_LENGTH;
    road.render(sample.segments, 0, roadElevationAt(sample.segments, z) + CAMERA_HEIGHT, z, 0xcfe4f5);
  }
  assert.ok(drawCalls - before > 0);
}
{
  // And for the tree chute: approaching the funnel, along its poles, at the first wall, deep inside and leaving. The pole pool
  // (one pair every second funnel segment plus the gate at the first wall) must never be asked for more than it holds.
  const chute = sample.chute[0];
  const before = drawCalls;
  let maxPoles = 0;
  for (const offset of [-40, -22, -12, -10, -6, -1, 0, 1, 8, chute.length - 1, chute.length + 3]) {
    const z = (chute.start + offset + 0.25) * SEGMENT_LENGTH;
    road.render(sample.segments, 0, roadElevationAt(sample.segments, z) + CAMERA_HEIGHT, z, 0xcfe4f5);
    maxPoles = Math.max(maxPoles, (road as unknown as { chutePoleCount: number }).chutePoleCount);
  }
  assert.ok(drawCalls - before > 0);
  assert.ok(maxPoles >= 8 && maxPoles <= 24, `funnel poles drawn: ${maxPoles}`);
}
console.log(`PASS themed terrain and scenery: finite geometry, distinct silhouettes, pooled sprites <= ${maxSprites}.`);

const shades = (road as unknown as { shades: { snow: number; offPiste: number }[] }).shades;
for (const themeIndex of [0, 1, 2]) {
  for (let band = 0; band < 16; band++) {
    const shade = shades[(themeIndex * DRAW_DISTANCE) * 16 + band];
    assert.ok(deltaL(shade.snow, shade.offPiste) >= 12, 'themed near-field piste edges retain contrast');
  }
}
console.log('PASS all themed near-field snow boundaries preserve minimum gameplay contrast.');
