/** Real-browser acceptance for controls, interrupted races, replay, and touch.
 * Run against the production build via `npm run verify`, or pass --url=... .
 * Hazard-free input fixtures only remove encounters; input and scene lifecycle
 * remain the real game code. The separate smoke test captures normal racing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const OUT = resolve('.verify');
const BASE_URL = (process.argv.find((arg) => arg.startsWith('--url=')) ?? '--url=http://127.0.0.1:4173').slice(6);
mkdirSync(OUT, { recursive: true });
const notes = [];
const errors = [];
let browser;
let page;
let phase = 'launch';
let failure;
const deadline = setTimeout(() => {
  writeFileSync(`${OUT}/acceptance-timeout.txt`, `Timed out during ${phase}\n${notes.join('\n')}\n`);
  process.exit(1);
}, 360000);

function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name);
  notes.push(`  PASS  ${name}`);
  console.log(notes.at(-1));
}

async function scene(key) {
  await page.waitForFunction((name) => window.__game?.scene.isActive(name), key);
}

async function ready() {
  await scene('RaceScene');
  await page.waitForFunction(() => {
    const sc = window.__game.scene.getScene('RaceScene');
    return sc.countdownMs === 0 && !sc.paused && sc.player.speed > 0;
  });
}

async function state() {
  return page.evaluate(() => {
    const sc = window.__game.scene.getScene('RaceScene');
    return {
      seed: sc.seed, paused: sc.paused, countdown: sc.countdownMs,
      elapsed: sc.elapsedRaceMs, z: sc.player.worldZ, speed: sc.player.speed,
      lane: sc.player.laneIndex, airborne: sc.player.airborne,
      wiped: sc.player.wipedOut, charges: sc.player.weaponCharges,
      listeners: {
        down: sc.input.keyboard.listenerCount('keydown'),
        up: sc.input.keyboard.listenerCount('keyup'),
        pause: sc.input.keyboard.listenerCount('keydown-P'),
        blur: sc.game.events.listenerCount('blur'),
        hidden: sc.game.events.listenerCount('hidden')
      }
    };
  });
}

async function quietCourse() {
  await page.evaluate(() => {
    const sc = window.__game.scene.getScene('RaceScene');
    sc.obstacles.length = 0;
    sc.pickups.length = 0;
    sc.crestApexZs.length = 0;
    sc.aiRiders.forEach((rider, index) => { rider.worldZ = -1000000 - index * 1000; });
  });
}

async function gamePoint(x, y) {
  const box = await page.locator('canvas').boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'rendered canvas bounds');
  return { x: box.x + x * box.width / 960, y: box.y + y * box.height / 540 };
}

async function clickGame(x, y, touch = false) {
  const point = await gamePoint(x, y);
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, ...options });
  const result = await context.newPage();
  result.setDefaultTimeout(45000);
  result.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  result.on('pageerror', (error) => errors.push(error.stack || error.message));
  return result;
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader']
  });
  page = await newPage();
  phase = 'title and countdown';
  await page.goto(`${BASE_URL}/?seed=101`, { waitUntil: 'networkidle' });
  await scene('TitleScene');
  const originalSeed = await page.evaluate(() => window.__game.scene.getScene('TitleScene').seed);
  await clickGame(420, 351);
  const chosenSeed = await page.evaluate(() => window.__game.scene.getScene('TitleScene').seed);
  check('new mountain changes the title seed without starting a race', chosenSeed !== originalSeed && await page.evaluate(() => window.__game.scene.isActive('TitleScene')));
  await clickGame(178, 351);
  await scene('RaceScene');
  // Freeze the short wall-clock countdown immediately, before diagnostics and
  // audio assertions spend time on a software-rendered CI frame.
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  await quietCourse();
  const start = await state();
  check('drop in starts the selected mountain', start.seed, chosenSeed);
  check('countdown begins with a stationary centered rider', start.countdown > 0 && start.speed === 0 && start.lane === 2);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.context?.state === 'running');
  check('Drop In gesture unlocks the real audio context', await page.evaluate(() => window.__game.scene.getScene('RaceScene').audio.context.state), 'running');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('KeyW');
  const pausedCountdown = (await state()).countdown;
  await page.waitForTimeout(300);
  check('pausing the countdown preserves its remaining time', (await state()).countdown, pausedCountdown);
  await page.keyboard.press('Escape');
  await ready();
  await page.waitForTimeout(250);
  const afterCountdown = await state();
  check('held countdown inputs do not leak into the race', afterCountdown.lane === 2 && !afterCountdown.airborne);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('KeyW');
  const baselineListeners = afterCountdown.listeners;
  await page.keyboard.press('KeyM');
  check('M mutes and saves the audio preference', await page.evaluate(() => window.__game.scene.getScene('RaceScene').audio.isMuted && localStorage.getItem('bdb-muted') === '1'));
  await page.keyboard.press('KeyM');
  check('M restores sound and updates the saved preference', await page.evaluate(() => !window.__game.scene.getScene('RaceScene').audio.isMuted && localStorage.getItem('bdb-muted') === '0'));

  phase = 'keyboard steering and jump';
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.laneIndex === 4);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(300);
  check('holding steer reaches the edge and release stops the hold', (await state()).lane, 4);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.airborne);
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').player.airborne);
  await page.waitForTimeout(250);
  check('W jumps once without repeating while held', (await state()).airborne, false);
  await page.keyboard.up('KeyW');

  phase = 'pause and focus interruption';
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  const paused = await state();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(350);
  const stillPaused = await state();
  check('pause freezes race time and rider position', [stillPaused.elapsed, stillPaused.z], [paused.elapsed, paused.z]);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.windGain.gain.value < 0.01);
  check('pause settles procedural riding audio to silence', await page.evaluate(() => window.__game.scene.getScene('RaceScene').audio.windGain.gain.value < 0.01));
  await page.screenshot({ path: `${OUT}/06-pause.png` });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').paused);
  await page.waitForTimeout(350);
  check('a key held across resume cannot become a new steer', (await state()).lane, 4);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.laneIndex === 3);
  check('fresh input works after resume', (await state()).lane, 3);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('returning focus leaves the race paused', (await state()).paused);
  await clickGame(480, 267);
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').paused);

  phase = 'pause retry and listener cleanup';
  await clickGame(902, 77);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => {
    const sc = window.__game.scene.getScene('RaceScene');
    return sc.countdownMs > 0 && !sc.paused && sc.elapsedRaceMs === 0;
  });
  await quietCourse();
  const retry = await state();
  check('pause retry resets the same mountain and player state', retry.seed === chosenSeed && retry.lane === 2 && retry.charges === 0 && !retry.wiped);
  check('retry does not accumulate input or lifecycle listeners', retry.listeners, baselineListeners);
  await ready();

  phase = 'results and repeated replay';
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => window.__game.scene.getScene('RaceScene').player.crashIntoTree());
    await scene('ResultScene');
    await page.keyboard.press('Enter');
    await scene('RaceScene');
    await quietCourse();
    check(`result replay ${attempt + 1} keeps the mountain and resets the run`, (await state()).seed, chosenSeed);
    check(`result replay ${attempt + 1} keeps one set of listeners`, (await state()).listeners, baselineListeners);
    await ready();
  }
  await page.evaluate(() => window.__game.scene.getScene('RaceScene').player.crashIntoTree());
  await scene('ResultScene');
  await clickGame(527, 480);
  await scene('RaceScene');
  await quietCourse();
  const nextSeed = (await state()).seed;
  check('new mountain from results starts a different course', nextSeed !== chosenSeed);
  await ready();
  await page.evaluate(() => {
    const sc = window.__game.scene.getScene('RaceScene');
    sc.player.worldZ = sc.finishSegment.z - 4000;
    sc.prevWorldZ = sc.player.worldZ;
    sc.player.speed = 3000;
    sc.elapsedRaceMs = 93000;
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/10-finish-approach.png` });
  // Fast-forward the fixture to the final meters; the real update/endRace
  // path must cross the line and produce a successful finish breakdown.
  await page.evaluate(() => {
    const sc = window.__game.scene.getScene('RaceScene');
    sc.player.worldZ = sc.finishSegment.z - 20;
    sc.prevWorldZ = sc.player.worldZ;
    sc.player.speed = 3000;
    sc.elapsedRaceMs = 94200;
  });
  await scene('ResultScene');
  check('crossing the finish produces a completed result', await page.evaluate(() => window.__game.scene.getScene('ResultScene').resultData.breakdown.finished));
  await page.screenshot({ path: `${OUT}/09-finish-result.png` });
  await clickGame(800, 480);
  await scene('TitleScene');
  check('base camp preserves the most recently raced mountain', await page.evaluate(() => window.__game.scene.getScene('TitleScene').seed), nextSeed);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('black-diamond-brawl:records:v1')));
  check('completed attempts are saved exactly once', stored.courses[String(chosenSeed)].attempts, 3);
  check('only a completed finish establishes the new mountain time record', stored.courses[String(nextSeed)].bestTimeSeconds > 94 && stored.courses[String(chosenSeed)].bestTimeSeconds === null);
  await page.reload({ waitUntil: 'networkidle' });
  await scene('TitleScene');
  check('mountain records survive a page reload', await page.evaluate((seed) => JSON.parse(localStorage.getItem('black-diamond-brawl:records:v1')).courses[String(seed)].attempts, chosenSeed), 3);
  await page.context().close();

  phase = 'portrait touch and pointer cancellation';
  page = await newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.goto(`${BASE_URL}/?seed=202&touch=1`, { waitUntil: 'networkidle' });
  await scene('TitleScene');
  await page.screenshot({ path: `${OUT}/07-mobile-title.png` });
  const touchSession = await page.context().newCDPSession(page);
  const dropIn = await gamePoint(178, 351);
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...dropIn, id: 1 }] });
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForTimeout(200);
  check('canceling a real touch on Drop In cannot activate the button', await page.evaluate(() => window.__game.scene.isActive('TitleScene')));
  await clickGame(178, 351, true);
  await scene('RaceScene');
  await ready();
  await quietCourse();
  const box = await page.locator('canvas').boundingBox();
  check('portrait canvas fits inside the viewport', box.x >= -1 && box.y >= -1 && box.x + box.width <= 391 && box.y + box.height <= 845);
  await clickGame(142, 497, true);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.laneIndex === 3);
  await clickGame(812, 497, true);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.airborne);
  check('real touch taps steer and jump', (await state()).airborne);
  await page.screenshot({ path: `${OUT}/08-mobile-race.png` });
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').player.airborne);
  const left = await gamePoint(58, 497);
  const outside = await gamePoint(480, 260);
  await page.mouse.move(left.x, left.y);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.move(outside.x, outside.y);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = (await state()).lane;
  await page.waitForTimeout(400);
  check('dragging out of a control cannot leave steering held', (await state()).lane, afterDrag);

  const beforeMultiTouch = await state();
  const jump = await gamePoint(812, 497);
  await touchSession.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ ...left, id: 1 }, { ...jump, id: 2 }]
  });
  await page.waitForFunction((lane) => {
    const player = window.__game.scene.getScene('RaceScene').player;
    return player.airborne && player.laneIndex < lane;
  }, beforeMultiTouch.lane);
  check('two real touches can steer and jump simultaneously', (await state()).airborne);
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').player.airborne);
  const canceled = await state();
  await page.waitForFunction((elapsed) => window.__game.scene.getScene('RaceScene').elapsedRaceMs >= elapsed + 450, canceled.elapsed);
  const settledCancel = await state();
  await page.waitForFunction((elapsed) => window.__game.scene.getScene('RaceScene').elapsedRaceMs >= elapsed + 450, settledCancel.elapsed);
  check('touchcancel releases held steering after the current motion settles', (await state()).lane, settledCancel.lane);
  await touchSession.detach();
  await clickGame(902, 77, true);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  await clickGame(480, 375, true);
  await scene('TitleScene');
  check('touch pause menu returns to the lodge', await page.evaluate(() => window.__game.scene.isActive('TitleScene')));
  await page.setViewportSize({ width: 844, height: 390 });
  await clickGame(178, 351, true);
  await ready();
  await page.screenshot({ path: `${OUT}/11-mobile-landscape.png` });
  const landscape = await page.locator('canvas').boundingBox();
  check('landscape touch canvas fits the viewport', landscape.x >= -1 && landscape.y >= -1 && landscape.x + landscape.width <= 845 && landscape.y + landscape.height <= 391);
  await page.context().close();

  phase = 'Canvas compatibility';
  page = await newPage();
  await page.goto(`${BASE_URL}/?seed=101&renderer=canvas`, { waitUntil: 'networkidle' });
  await scene('TitleScene');
  check('explicit Canvas fallback uses the 2D renderer', await page.evaluate(() => window.__game.renderer.type), 1);
  await clickGame(178, 351);
  await ready();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.laneIndex === 3);
  check('Canvas fallback starts a race and accepts steering', (await state()).lane, 3);
  await page.screenshot({ path: `${OUT}/12-canvas-race.png` });

  phase = 'ten-retry resource stability';
  const resources = () => page.evaluate(() => {
    const game = window.__game;
    const sc = game.scene.getScene('RaceScene');
    return {
      cameras: sc.cameras.cameras.length,
      textures: Object.keys(game.textures.list).length,
      displayObjects: sc.children.length,
      pointers: sc.input.manager.pointersTotal,
      down: sc.input.keyboard.listenerCount('keydown'),
      up: sc.input.keyboard.listenerCount('keyup'),
      blur: game.events.listenerCount('blur')
    };
  });
  const resourceBaseline = await resources();
  const resourceHistory = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
    await page.keyboard.press('KeyR');
    await page.waitForFunction(() => {
      const sc = window.__game.scene.getScene('RaceScene');
      return !sc.paused && sc.countdownMs > 0 && sc.elapsedRaceMs === 0;
    });
    await ready();
    resourceHistory.push(await resources());
  }
  writeFileSync(`${OUT}/replay-resources.json`, JSON.stringify({ resourceBaseline, resourceHistory }, null, 2));
  const stable = ['cameras', 'textures', 'pointers', 'down', 'up', 'blur'];
  check('ten retries preserve camera, texture, pointer and listener counts', resourceHistory.every((sample) => stable.every((key) => sample[key] === resourceBaseline[key])));
  // A few lazily allocated scenery sprites can vary with a sampled frame;
  // bound that variation rather than mistaking legitimate pool warmup for a leak.
  check('ten retries keep display-object allocation bounded', resourceHistory.every((sample) => sample.displayObjects <= resourceBaseline.displayObjects + 12));
  check('no console or uncaught browser errors', errors, []);
} catch (error) {
  failure = `FAIL during ${phase}: ${error.stack || error.message || String(error)}`;
  console.error(failure);
  if (page && !page.isClosed()) await page.screenshot({ path: `${OUT}/acceptance-failure.png` }).catch(() => {});
} finally {
  clearTimeout(deadline);
  writeFileSync(`${OUT}/acceptance-report.txt`, [...notes, ...(failure ? [failure] : []), ...errors.map((error) => `BROWSER ERROR ${error}`)].join('\n') + '\n');
  await browser?.close();
}
if (failure || errors.length) process.exit(1);
console.log(`\nAll ${notes.length} browser acceptance checks passed.\n`);
