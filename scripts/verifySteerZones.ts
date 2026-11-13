/** Touch steer zones: direction from the finger's x, dead band, slide, drift and release. No browser or Phaser. */
import assert from 'node:assert/strict';
import { SCREEN_H, TOUCH_STEER } from '../src/config';
import { PlayerInputController } from '../src/entities/input';
import { Player } from '../src/entities/player';
import { applySteerOps, inSteerZone, steerDirectionAt, SteerZoneTracker, touchHitAreas, type SteerOp } from '../src/input/steerZones';

let checks = 0;
function check(name: string, run: () => void): void {
  run();
  checks++;
  console.log(`  ✓ ${name}`);
}
const { SPLIT_X, RIGHT_X, TOP_Y, DEAD_BAND, OVERSHOOT } = TOUCH_STEER;
const describe = (ops: SteerOp[]) => ops.map(o => `${o.down ? '+' : '-'}${o.action}`).join(' ');

console.log('\n=== touch steer zones ===');
check('the zones fill the bottom-left corner to the screen edges and contain the legacy tap points', () => {
  assert.equal(TOP_Y, 360);
  assert.ok(RIGHT_X >= 230 && RIGHT_X <= 236, 'zones span to about x = 230');
  for (const [x, y] of [[58, 497], [142, 497]]) assert.ok(inSteerZone(x, y), `(${x}, ${y}) is inside`);
  assert.ok(steerDirectionAt(58) < 0 && steerDirectionAt(142) > 0, 'the legacy points still mean left and right');
  assert.ok(inSteerZone(0, SCREEN_H) && inSteerZone(0, SCREEN_H - 0.01) && inSteerZone(RIGHT_X, SCREEN_H), 'bottom corners are live');
  assert.ok(inSteerZone(-OVERSHOOT, SCREEN_H + OVERSHOOT), 'live a little past the left and bottom edges');
  assert.ok(!inSteerZone(RIGHT_X + 1, 500) && !inSteerZone(100, TOP_Y - 1), 'and not beyond the zones');
  assert.ok((SPLIT_X - 0) * (SCREEN_H - TOP_Y) >= 2.2 * 72 * 66, 'each zone is more than 2.2x the old 72x66 button');
  assert.ok((RIGHT_X - SPLIT_X) * (SCREEN_H - TOP_Y) >= 2.2 * 72 * 66);
});
check('direction follows x: left of the split is left, right of it is right', () => {
  for (const x of [-20, 0, 1, 58, SPLIT_X - DEAD_BAND - 1]) assert.equal(steerDirectionAt(x), -1, `x=${x}`);
  for (const x of [SPLIT_X + DEAD_BAND + 1, 142, RIGHT_X, RIGHT_X + 60]) assert.equal(steerDirectionAt(x), 1, `x=${x}`);
});
check('the dead band keeps the previous direction and picks a side only for a fresh finger', () => {
  for (const x of [SPLIT_X - DEAD_BAND, SPLIT_X, SPLIT_X + DEAD_BAND]) {
    assert.equal(steerDirectionAt(x, -1), -1, `x=${x} keeps left`);
    assert.equal(steerDirectionAt(x, 1), 1, `x=${x} keeps right`);
  }
  assert.equal(steerDirectionAt(SPLIT_X - 1, 0), -1);
  assert.equal(steerDirectionAt(SPLIT_X + 1, 0), 1);
});
check('a press anywhere in a zone registers at once, including the screen-edge corners', () => {
  for (const [x, y, action] of [[0, 540, 'left'], [-3, 545, 'left'], [58, 497, 'left'], [SPLIT_X - 1, TOP_Y, 'left'], [SPLIT_X + 20, 540, 'right'], [142, 497, 'right'], [RIGHT_X, 540, 'right']] as const) {
    const t = new SteerZoneTracker();
    assert.equal(describe(t.press(1, x, y)), `+${action}`, `(${x}, ${y})`);
  }
  assert.equal(describe(new SteerZoneTracker().press(1, 300, 500)), '', 'a press outside the zones does nothing');
  assert.equal(describe(new SteerZoneTracker().press(1, 100, 300)), '');
});
check('sliding across the split switches direction without lifting, releasing the old side first', () => {
  const t = new SteerZoneTracker();
  assert.equal(describe(t.press(1, 40, 480)), '+left');
  assert.equal(describe(t.move(1, 80, 480)), '', 'moving within a side changes nothing');
  assert.equal(describe(t.move(1, SPLIT_X + 3, 480)), '', 'inside the dead band it stays left');
  assert.equal(describe(t.move(1, SPLIT_X + DEAD_BAND + 1, 480)), '-left +right');
  assert.equal(t.held, 1);
  assert.equal(describe(t.move(1, SPLIT_X - 3, 480)), '', 'resting on the line does not flicker');
  assert.equal(describe(t.move(1, 30, 480)), '-right +left');
  assert.equal(describe(t.release(1)), '-left');
  assert.equal(t.held, 0);
});
check('a finger that drifts outside the zones keeps its last direction until it lifts', () => {
  const t = new SteerZoneTracker();
  t.press(1, 60, 500);
  for (const [x, y] of [[60, 460], [60, 330], [60, 100], [150, 200], [400, 300], [700, 540]]) {
    assert.equal(describe(t.move(1, x, y)), '', `(${x}, ${y}) outside changes nothing`);
    assert.equal(t.held, -1);
  }
  // Coming back into the other half switches; only the lift releases.
  assert.equal(describe(t.move(1, 170, 450)), '-left +right');
  assert.equal(describe(t.move(1, 300, 450)), '');
  assert.equal(t.held, 1);
  assert.equal(describe(t.release(1)), '-right');
});
check('only a release of the same pointer lets go; other pointers and a repeat release do nothing', () => {
  const t = new SteerZoneTracker();
  t.press(2, 150, 480);
  assert.equal(describe(t.release(1)), '');
  assert.equal(describe(t.move(1, 10, 480)), '');
  assert.equal(t.held, 1);
  assert.equal(describe(t.release(2)), '-right');
  assert.equal(describe(t.release(2)), '');
  t.press(3, 20, 480);
  assert.equal(describe(t.releaseAll()), '-left', 'pause, blur and cancel release the hold');
  assert.equal(describe(t.releaseAll()), '');
});
check('one finger never holds both directions, and a second finger takes over rather than adding a hold', () => {
  const t = new SteerZoneTracker();
  const held = new Map<string, Set<string>>(); // source -> actions down
  const control = (action: string, down: boolean, source: string) => {
    const set = held.get(source) ?? new Set<string>();
    if (down) set.add(action); else set.delete(action);
    held.set(source, set);
    for (const [s, actions] of held) assert.ok(actions.size <= 1, `${s} holds ${[...actions]}`);
    const all = [...held.values()].flatMap(a => [...a]);
    assert.ok(!(all.includes('left') && all.includes('right')), 'left and right are never down together');
  };
  const run = (ops: SteerOp[]) => applySteerOps(ops, control);
  run(t.press(1, 30, 480));
  for (const x of [60, 112, 130, 118, 100, 90, 140, 200, 114, 50]) run(t.move(1, x, 480));
  run(t.press(2, 190, 500)); // a second thumb lands on the right: it takes over
  assert.equal(t.pointerId, 2);
  run(t.move(1, 150, 480)); // the first finger is dropped for good
  run(t.release(1));
  assert.equal(t.held, 1);
  run(t.release(2));
  assert.equal(t.held, 0);
  assert.equal([...held.values()].flatMap(a => [...a]).length, 0, 'everything is released');
});

// End to end through the real input controller and player.
const STEP = 1000 / 60;
function rig() {
  const player = new Player();
  let time = 0;
  const input = new PlayerInputController(player, () => player.requestJump(), () => time);
  const control = (action: 'left' | 'right', down: boolean, source: string) => input.setAction(action, down, source);
  const step = (n = 1) => { for (let i = 0; i < n; i++) { time += STEP; input.update(STEP); player.update(STEP); } };
  step(5);
  return { player, input, control, step, tracker: new SteerZoneTracker() };
}
check('a tap at the extreme bottom-left corner steers left on the next frame', () => {
  const { player, control, step, tracker } = rig();
  const lane = player.laneIndex;
  applySteerOps(tracker.press(1, 0, 540), control);
  applySteerOps(tracker.release(1), control); // finger is up again before the frame
  step(12);
  assert.equal(player.laneIndex, lane - 1);
});
check('a tap on the far edge of the right zone steers right', () => {
  const { player, control, step, tracker } = rig();
  const lane = player.laneIndex;
  applySteerOps(tracker.press(1, RIGHT_X, 540), control);
  applySteerOps(tracker.release(1), control);
  step(12);
  assert.equal(player.laneIndex, lane + 1);
});
check('sliding from the left zone to the right zone goes left, then right, without lifting', () => {
  const { player, control, step, tracker } = rig();
  const lane = player.laneIndex;
  applySteerOps(tracker.press(1, 40, 480), control);
  step(12);
  assert.equal(player.laneIndex, lane - 1);
  applySteerOps(tracker.move(1, 170, 480), control);
  step(12);
  assert.equal(player.laneIndex, lane, 'the slide steered right once');
  applySteerOps(tracker.release(1), control);
  step(60);
  assert.equal(player.laneIndex, lane, 'and the lift ended it');
});
check('a held finger repeats lanes while it drifts 40 units outside the zone, and stops only on the lift', () => {
  const { player, control, step, tracker } = rig();
  applySteerOps(tracker.press(1, 60, 500), control);
  step(12);
  const after = player.laneIndex;
  applySteerOps(tracker.move(1, 60, TOP_Y - 40), control);
  step(40); // 660 ms: the hold keeps carving
  assert.ok(player.laneIndex < after || player.laneIndex === 0, 'still carving left');
  applySteerOps(tracker.release(1), control);
  step(30);
  const settled = player.laneIndex;
  step(60);
  assert.equal(player.laneIndex, settled, 'nothing moves after the lift');
});
check('two quick taps in the same direction move two lanes, even when the second lands mid-lane-change', () => {
  for (const gapSteps of [1, 3, 5, 7, 8, 9, 10, 12]) {
    const { player, control, step, tracker } = rig();
    const lane = player.laneIndex;
    applySteerOps(tracker.press(1, 150, 500), control); applySteerOps(tracker.release(1), control);
    step(gapSteps);
    applySteerOps(tracker.press(2, 150, 500), control); applySteerOps(tracker.release(2), control);
    step(40);
    assert.equal(player.laneIndex, lane + 2, `gap of ${gapSteps} frames`);
  }
});
check('a pointer id whose release never arrived cannot swallow the next tap', () => {
  const { player, control, step, tracker } = rig();
  control('right', true, 'touch:1'); // a hold that was never released (a missed pointerup)
  step(10);
  const lane = player.laneIndex; // it carved one lane right and is now waiting to repeat
  // The same pointer id lands in the left zone: the press must still count as a fresh steer.
  applySteerOps(tracker.press(1, 30, 500), control);
  applySteerOps(tracker.release(1), control);
  step(12);
  assert.equal(player.laneIndex, lane - 1);
});
check('right-hand button hit areas reach past the faces and never overlap each other', () => {
  const centers = [726, 812, 898];
  const areas = touchHitAreas(centers);
  centers.forEach((cx, i) => {
    const a = areas[i];
    assert.ok(a.left <= cx - 36 && a.right >= cx + 36, 'covers the face horizontally');
    assert.ok(a.top < SCREEN_H - 43 - 33 - 40, 'reaches well above the face');
    assert.ok(a.bottom > SCREEN_H, 'and past the bottom edge');
  });
  assert.ok(areas[2].right > 960, 'HIT reaches past the right screen edge');
  for (let i = 1; i < areas.length; i++) assert.ok(areas[i - 1].right <= areas[i].left, `button ${i - 1} and ${i} do not overlap`);
  assert.ok(areas[0].right >= 726 + 36 + 5, 'neighbours meet half-way across the gap');
  assert.ok(areas[2].top >= 160, 'stays clear of the PAUSE button');
});
console.log(`\n${checks} steer-zone checks passed`);
