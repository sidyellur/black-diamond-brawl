import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  BLIND_LANDING_SEGMENTS, CAMERA_HEIGHT, COURSE_LENGTH_SEGMENTS, DRAW_DISTANCE, LANES, SEGMENT_LENGTH
} from '../src/config';
import { generateTrack } from '../src/track/generator';
import { MOUNTAIN_GENERATOR_VERSION, MountainTheme, sectionAtZ } from '../src/track/mountain';
import { roadElevationAt } from '../src/track/segment';
import { RoadRenderer } from '../src/render/RoadRenderer';
import { SceneryRenderer } from '../src/render/SceneryRenderer';
import { deltaL } from '../src/render/palette';

const started = performance.now();
const variants = new Set<string>();
const layouts = new Set<string>();
const totals = { forests: 0, ridges: 0, bowls: 0, crests: 0, combatSegments: 0, obstacles: 0 };
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
      const desired = rows.map(([index, blocked]) => {
        assert.equal(blocked.size, LANES.length - 2, 'slalom gate has exactly two open lanes');
        assert.ok(track.segments[index].slalomLane !== undefined);
        const clear = LANES.map((_, lane) => lane).filter((lane) => !blocked.has(lane));
        assert.equal(clear[1] - clear[0], 1, 'readable adjacent opening');
        return clear[0];
      });
      assert.ok(Math.max(...desired) - Math.min(...desired) >= 1, 'forest physically asks for lane changes');
      assert.ok(desired.every((lane, i) => i === 0 || Math.abs(lane - desired[i - 1]) <= 1), 'successive gates overlap');
      assert.ok(desired.filter((lane, i) => i > 0 && desired[i - 1] !== lane).length >= 2);
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
      assert.ok(rows.every(([, blocked]) => blocked.size <= 1));
      totals.combatSegments += arena.length;
    }
  }
  assert.deepEqual(themeCounts, { forest: 2, ridge: 2, bowl: 2 });
  const names = track.sections.slice(1, -1).map((section) => section.name);
  assert.equal(new Set(names).size, 6, 'no repeated named feature within one mountain');
  layouts.add(JSON.stringify(track.sections));
  totals.crests += track.crestApexes.length;
  totals.obstacles += track.obstacles.length;
}
assert.equal(variants.size, 9);
assert.equal(layouts.size, 1000, 'seeded structure, names and lengths vary');
const generationMs = performance.now() - started;
console.log(`PASS 1,000 mountains: exact budgets, metadata boundaries, deterministic content, distinct riding rhythms and safe transitions (${Math.round(generationMs)} ms).`);
console.log(JSON.stringify(totals));

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
console.log(`PASS themed terrain and scenery: finite geometry, distinct silhouettes, pooled sprites <= ${maxSprites}.`);

const shades = (road as unknown as { shades: { snow: number; offPiste: number }[] }).shades;
for (const themeIndex of [0, 1, 2]) {
  for (let band = 0; band < 16; band++) {
    const shade = shades[(themeIndex * DRAW_DISTANCE) * 16 + band];
    assert.ok(deltaL(shade.snow, shade.offPiste) >= 12, 'themed near-field piste edges retain contrast');
  }
}
console.log('PASS all themed near-field snow boundaries preserve minimum gameplay contrast.');
