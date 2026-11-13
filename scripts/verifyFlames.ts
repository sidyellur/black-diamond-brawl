/** Boost rocket flames: state machine, generated art and structure. Pure Node, no Phaser runtime. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLAME_BURST_MS, FLAME_FALL_MS, FLAME_REIGNITE_WINDOW_MS, FLAME_RISE_MS, FLAME_SPUTTER_MS, FlameState, type FlameEdge
} from '../src/render/flameState';
import {
  drawFlameCore, drawFlameGlow, drawFlameRing, drawFlameStreak, drawFlameTongue, FLAME_TONGUE_H, FLAME_TONGUE_W
} from '../src/render/flameArt';

let checks = 0;
function check(name: string, run: () => void): void {
  run();
  checks++;
  console.log(`  ✓ ${name}`);
}
const STEP = 1000 / 60;
const run = (s: FlameState, ms: number, boosting: boolean, airborne = false): FlameEdge[] => {
  const edges: FlameEdge[] = [];
  for (let t = 0; t < ms; t += STEP) { s.update(STEP, boosting, airborne); if (s.edge !== 'none') edges.push(s.edge); }
  return edges;
};

console.log('\n=== boost flames ===');
check('nothing is lit, and nothing changes, while boost is off', () => {
  const s = new FlameState();
  assert.deepEqual(run(s, 3000, false), []);
  assert.equal(s.power, 0);
  assert.equal(s.lit, false);
  assert.equal(s.burst, 0);
});
check('ignition fires once, ramps up quickly, and the extra-large burst decays', () => {
  const s = new FlameState();
  assert.deepEqual(run(s, STEP, true), ['ignite']);
  assert.equal(s.burst > 0.9, true);
  assert.deepEqual(run(s, 2000, true), [], 'no further edges while held');
  assert.equal(s.power, 1);
  assert.equal(s.burst, 0);
  const t = new FlameState(); run(t, FLAME_RISE_MS / 2, true);
  assert.ok(t.power > 0.3 && t.power < 1, 'power ramps rather than snapping');
  assert.ok(FLAME_BURST_MS <= 400, 'the burst is short');
});
check('a plain release flames out once and the flame dies away by itself', () => {
  const s = new FlameState();
  run(s, 600, true);
  assert.deepEqual(run(s, STEP, false), ['flameout']);
  run(s, FLAME_FALL_MS + 2 * STEP, false);
  assert.equal(s.power, 0);
  assert.equal(s.lit, false);
  assert.equal(s.isSputtering, false);
});
check('a takeoff cut sputters out over longer, and landing with boost still held re-ignites smaller', () => {
  const s = new FlameState();
  run(s, 600, true);
  assert.deepEqual(run(s, STEP, false, true), ['sputter']);
  assert.equal(s.isSputtering, true);
  run(s, FLAME_FALL_MS + STEP, false, true);
  assert.ok(s.power > 0, 'still guttering after a plain release would have finished');
  run(s, FLAME_SPUTTER_MS, false, true);
  assert.equal(s.power, 0);
  assert.deepEqual(run(s, STEP, true), ['reignite']);
  assert.ok(s.burst < 0.6, 'smaller than a fresh ignition');
  const late = new FlameState();
  run(late, 300, true); run(late, STEP, false, true);
  run(late, FLAME_REIGNITE_WINDOW_MS + 100, false);
  assert.deepEqual(run(late, STEP, true), ['ignite'], 'a long gap is a fresh start again');
});
check('re-lighting mid flame-out keeps one continuous flame and never exceeds its range', () => {
  const s = new FlameState();
  run(s, 400, true); run(s, 60, false);
  const before = s.power;
  run(s, STEP, true);
  assert.ok(s.power >= before);
  for (let i = 0; i < 600; i++) { s.update(STEP, i % 7 < 3, i % 11 < 4); assert.ok(s.power >= 0 && s.power <= 1 && s.burst >= 0 && s.burst <= 1); }
  s.update(NaN, true, false); s.update(-5, false, false);
  assert.ok(Number.isFinite(s.power));
  s.reset();
  assert.equal(s.power, 0);
});

function alphaAt(cv: { w: number; data: Uint8ClampedArray }, x: number, y: number): number { return cv.data[(y * cv.w + x) * 4 + 3]; }
function rgbAt(cv: { w: number; data: Uint8ClampedArray }, x: number, y: number): [number, number, number] { const i = (y * cv.w + x) * 4; return [cv.data[i], cv.data[i + 1], cv.data[i + 2]]; }
check('the flame art is white-yellow on the axis near the nozzle, orange in the body and red at the rim, and soft at the tip', () => {
  for (const phase of [0, 2.4]) {
    const cv = drawFlameTongue(phase);
    assert.equal(cv.w, FLAME_TONGUE_W); assert.equal(cv.h, FLAME_TONGUE_H);
    let opaque = 0;
    for (let i = 3; i < cv.data.length; i += 4) if (cv.data[i] > 40) opaque++;
    assert.ok(opaque > 0.2 * cv.w * cv.h, 'a solid shape');
    // Find the brightest-alpha pixel row 20 and check the axis colour against the rim colour there.
    const y = 22;
    const row = Array.from({ length: cv.w }, (_, x) => x).filter(x => alphaAt(cv, x, y) > 200);
    assert.ok(row.length > 6, 'wide at the nozzle');
    const axis = rgbAt(cv, Math.round((row[0] + row[row.length - 1]) / 2), y), rim = rgbAt(cv, row[0], y);
    assert.ok(axis[1] > 200 && axis[2] > 90, `axis is hot (${axis})`);
    assert.ok(rim[0] > 200 && rim[1] < 150 && rim[2] < 60, `rim is orange to red (${rim})`);
    const tipRows = Array.from({ length: cv.h }, (_, yy) => yy).filter(yy => Array.from({ length: cv.w }, (_, x) => alphaAt(cv, x, yy)).some(a => a > 40));
    assert.ok(tipRows[tipRows.length - 1] >= cv.h - 14, 'reaches near the tip');
  }
  assert.notDeepEqual(Array.from(drawFlameTongue(0).data), Array.from(drawFlameTongue(2.4).data), 'the two variants differ so the flame can flicker');
  assert.deepEqual(Array.from(drawFlameTongue(0).data), Array.from(drawFlameTongue(0).data), 'and each is deterministic');
});
check('core, glow, ring and streak textures are non-empty and centred', () => {
  for (const cv of [drawFlameCore(), drawFlameGlow(), drawFlameRing(), drawFlameStreak()]) {
    let sum = 0;
    for (let i = 3; i < cv.data.length; i += 4) sum += cv.data[i];
    assert.ok(sum > 0);
  }
  const glow = drawFlameGlow();
  assert.ok(alphaAt(glow, 32, 32) > 200 && alphaAt(glow, 1, 1) === 0);
  const ring = drawFlameRing();
  assert.ok(alphaAt(ring, 48, 48) === 0 && alphaAt(ring, 48 + 39, 48) > 150, 'a ring, empty in the middle');
});
check('flames are presentation only: the flame modules never import the simulation, and wiring stays in RaceScene', () => {
  const src = (p: string) => readFileSync(new URL(`../src/render/${p}`, import.meta.url), 'utf8');
  for (const file of ['BoostFlames.ts', 'flameState.ts', 'flameArt.ts']) {
    const imports = src(file).split('\n').filter(l => /^import /.test(l)).join('\n');
    assert.ok(!/entities\/|progression\/|track\//.test(imports), `${file} imports only render code`);
  }
  const scene = readFileSync(new URL('../src/scenes/RaceScene.ts', import.meta.url), 'utf8');
  assert.ok(/new BoostFlames\(this, this\.registerWorld/.test(scene), 'created through the register hook');
  const rules = readFileSync(new URL('../src/progression/rules.ts', import.meta.url), 'utf8');
  assert.ok(/RULES_VERSION/.test(rules));
});
check('particle pools are fixed and small enough for a phone', () => {
  const text = readFileSync(new URL('../src/render/BoostFlames.ts', import.meta.url), 'utf8');
  const m = /FLAME_POOLS = \{ blobs: (\d+), embers: (\d+), smoke: (\d+), scorch: (\d+), rings: (\d+) \}/.exec(text);
  assert.ok(m, 'pool sizes are declared in one place');
  const total = m!.slice(1).reduce((a, b) => a + Number(b), 0);
  assert.ok(total <= 160, `${total} pooled images`);
  const update = text.slice(text.indexOf('  update(deltaMs'), text.indexOf('  /** Warm the rider'));
  assert.ok(update.includes('if (!live)') && update.includes('return;'), 'update returns early when nothing is lit');
});
console.log(`\n${checks} boost-flame checks passed`);
