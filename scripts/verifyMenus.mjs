/** Production-build menu acceptance. Finish fixtures deliberately advance a
 * real RaceScene to a result, rather than simulating a clean 2-minute descent.
 * Routing, persistence, awards, result rendering and input are real game code.
 * No development-only imports or test hooks are used. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = (process.argv.find(arg => arg.startsWith('--url=')) ?? '--url=http://127.0.0.1:4173').slice(6);
mkdirSync('.verify', { recursive: true });
const checks = [], errors = [];
let browser, page;
let phase = 'launch';
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const scene = key => page.waitForFunction(name => window.__game?.scene.isActive(name) && window.__game.scene.getScene(name).leaving !== true, key);
const texts = () => page.evaluate(() => window.__game.scene.getScenes(true).flatMap(scene => scene.children.list.filter(item => item.type === 'Text').map(item => item.text)).join('\n'));
const state = () => page.evaluate(() => {
  const race = window.__game.scene.getScene('RaceScene');
  const result = window.__game.scene.getScene('ResultScene');
  return { options: race.options, texture: race.playerSprite?.texture.key, result: result.resultData };
});
const storage = () => page.evaluate(() => ({ career: localStorage.getItem('black-diamond-brawl:career:v1'), records: localStorage.getItem('black-diamond-brawl:records:v2') }));
const tap = async (x, y) => {
  const rect = await page.locator('canvas').boundingBox(); assert.ok(rect);
  await page.touchscreen.tap(rect.x + x * rect.width / 960, rect.y + y * rect.height / 540);
};
const finishFixture = async (time = 100000) => {
  await scene('RaceScene');
  await page.evaluate(time => {
    const race = window.__game.scene.getScene('RaceScene');
    race.elapsedRaceMs = time;
    race.player.worldZ = race.finishSegment.z;
    race.aiRiders.forEach((rider, index) => { rider.worldZ = race.finishSegment.z - 1000 - index * 1000; rider.finishTimeMs = null; rider.wipedOut = false; });
    race.endRace(true, time);
  }, time);
  await scene('ResultScene');
};
const layout = async name => {
  const failures = await page.evaluate(name => {
    const s = window.__game.scene.getScene(name), errors = [];
    const buttons = s.children.list.filter(item => item.type === 'Container' && item.name);
    const boxes = buttons.map(button => {
      const zone = button.getAt(3), bounds = zone.getBounds();
      const title = button.getAt(1).getBounds(), shortcut = button.getAt(2).getBounds();
      if (title.right > shortcut.left - 6 && button.getAt(2).text) errors.push(`${button.name}: label touches shortcut`);
      if (bounds.left < 0 || bounds.top < 0 || bounds.right > 960.1 || bounds.bottom > 540.1) errors.push(`${button.name}: outside canvas`);
      return { name: button.name, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    });
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const x = boxes[a], y = boxes[b];
      if (x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top) errors.push(`${x.name} overlaps ${y.name}`);
    }
    return errors;
  }, name);
  assert.deepEqual(failures, [], `${name} touch/label geometry`);
  check(`${name} buttons stay in bounds without overlaps`, true);
};

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/?seed=42`, { waitUntil: 'networkidle' });
  await scene('TitleScene');
  phase = 'title modes and reduced motion';
  await layout('TitleScene');
  check('title exposes free ride, cup, daily, practice and locker', await page.evaluate(() => {
    const names = window.__game.scene.getScene('TitleScene').children.list.filter(item => item.type === 'Container').map(item => item.name);
    return ['DROP IN', 'CUP SERIES', 'DAILY RUN', 'PRACTICE', 'LOCKER'].every(name => names.includes(name));
  }));
  check('reduced motion stops title drift and rider tweens', await page.evaluate(() => {
    const title = window.__game.scene.getScene('TitleScene'); return title.reducedMotion && title.drift === 0 && title.tweens.getTweens().length === 0;
  }));
  await page.screenshot({ path: '.verify/expansion-title.png' });
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await scene('RaceScene');
  check('Tab and Enter activate the focused free-ride button', (await state()).options.mode === 'quick');
  // Reload is an intentional interruption of an unfinished quick run.
  await page.reload({ waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('KeyL'); await scene('LockerScene'); await layout('LockerScene');
  await page.keyboard.press('Digit4');
  check('locked Champion board gives an explicit requirement', (await texts()).includes('LOCKED: Win a gold cup medal'));
  check('locked cosmetic cannot replace the equipped board', !JSON.parse((await storage()).career ?? '{}').equipped?.board?.includes('champion'));
  await page.screenshot({ path: '.verify/expansion-locker-locked.png' });
  await page.keyboard.press('Escape'); await scene('TitleScene');

  phase = 'cup start, result idempotence and resume';
  await page.keyboard.press('KeyC'); await scene('CupScene'); await layout('CupScene');
  await page.screenshot({ path: '.verify/expansion-cup-intro.png' });
  await page.keyboard.press('Enter'); await scene('RaceScene');
  check('cup button starts round one with an explicit cup identity', (await state()).options.mode === 'cup' && (await state()).options.roundIndex === 0);
  await finishFixture();
  await layout('ResultScene');
  check('first cup finish advances exactly one round and announces first unlock', (await state()).result.cup.rounds.length === 1 && (await texts()).includes('UNLOCKED: Sunrise'));
  const firstSave = await storage();
  await page.evaluate(() => { const result = window.__game.scene.getScene('ResultScene'); result.scene.restart(result.resultData); });
  await scene('ResultScene'); await page.waitForTimeout(100);
  assert.deepEqual(await storage(), firstSave, 'result revisits do not recommit awards, records or cup rounds');
  check('reopening a result is read-only', true);
  await page.keyboard.press('KeyC'); await scene('CupScene');
  check('round standings identify all five persistent riders', await page.evaluate(() => {
    const text = window.__game.scene.getScene('CupScene').children.list.filter(item => item.type === 'Text').map(item => item.text).join(' ');
    return ['YOU', 'NOVA', 'SLATE', 'FROST', 'EMBER', '1 OF 3 ROUNDS COMPLETE'].every(name => text.includes(name));
  }));
  await page.screenshot({ path: '.verify/expansion-cup-standings.png' });
  await page.keyboard.press('Escape'); await scene('TitleScene');
  check('base camp advertises a resumable cup', await page.evaluate(() => window.__game.scene.getScene('TitleScene').children.list.some(item => item.name === 'RESUME CUP')));
  await page.reload({ waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('KeyC'); await scene('CupScene');
  check('cup round progress survives process-style reload', (await texts()).includes('1 OF 3 ROUNDS COMPLETE'));
  await page.keyboard.press('Enter'); await scene('RaceScene');
  check('resume starts the next unplayed cup round', (await state()).options.roundIndex === 1);
  await finishFixture(); await page.keyboard.press('Enter'); await scene('RaceScene');
  check('result next button starts round three', (await state()).options.roundIndex === 2);
  await finishFixture();
  check('third result reports a final gold medal', (await state()).result.cup.status === 'complete' && (await state()).result.cup.medal === 'gold');
  await page.keyboard.press('Enter'); await scene('CupScene');
  check('final podium shows final standings and medal', (await texts()).includes('FINAL STANDINGS') && (await texts()).includes('GOLD MEDAL EARNED'));
  await page.screenshot({ path: '.verify/expansion-cup-podium.png' });

  phase = 'earned cosmetics, visible equipment and reload';
  await page.keyboard.press('KeyL'); await scene('LockerScene');
  await page.keyboard.press('Digit4'); await scene('LockerScene');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('black-diamond-brawl:career:v1')).equipped.board === 'champion-board');
  await scene('LockerScene');
  await page.keyboard.press('KeyJ'); await scene('LockerScene');
  await page.keyboard.press('Digit3');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('black-diamond-brawl:career:v1')).equipped.jacket === 'alpine-jacket');
  await scene('LockerScene');
  check('gold cup unlocks and equips Champion board plus Alpine jacket', true);
  await page.screenshot({ path: '.verify/expansion-locker-earned.png' });
  await page.reload({ waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('Enter'); await scene('RaceScene');
  check('selected board and jacket survive reload and change the race texture', (await state()).texture === 'player-equipped-268770-ffd36b');

  phase = 'daily retry, share text, copy fallback and shared link';
  await page.reload({ waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('KeyD'); await scene('RaceScene');
  const dailyOptions = (await state()).options;
  check('daily route uses the UTC date and daily identity', dailyOptions.mode === 'daily' && dailyOptions.dailyDate === await page.evaluate(() => new Date().toISOString().slice(0, 10)));
  await finishFixture();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Fixture: clipboard unavailable'); } } });
  });
  await page.keyboard.press('KeyS'); await page.locator('dialog').waitFor({ state: 'visible' });
  const shareText = await page.locator('dialog textarea').inputValue();
  check('failed clipboard still exposes selectable daily result text', shareText.includes(dailyOptions.dailyDate) && shareText.includes(String(dailyOptions.seed)) && shareText.includes('Self-reported local result'));
  await page.screenshot({ path: '.verify/expansion-daily-share-fallback.png' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  check('closing share text restores result keyboard controls', await page.evaluate(() => window.__game.scene.getScene('ResultScene').input.keyboard.enabled));
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedDaily = text; } } }));
  await page.keyboard.press('KeyS'); await page.waitForFunction(() => !!window.__copiedDaily);
  check('supported clipboard copies the same share result', await page.evaluate(() => window.__copiedDaily) === shareText);
  await page.keyboard.press('Enter'); await scene('RaceScene');
  check('daily retry keeps seed/date but receives a fresh attempt ID', (await state()).options.seed === dailyOptions.seed && (await state()).options.dailyDate === dailyOptions.dailyDate && (await state()).options.runId !== dailyOptions.runId);
  const sharedUrl = shareText.split('\n').find(line => line.startsWith('http'));
  assert.ok(sharedUrl, 'browser share text includes a challenge URL');
  await page.goto(sharedUrl, { waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('Enter'); await scene('RaceScene');
  check('shared daily link opens the identical daily course', (await state()).options.seed === dailyOptions.seed && (await state()).options.mode === 'daily');

  phase = 'dated practice and invalid daily links';
  const practiceUrl = new URL(sharedUrl); practiceUrl.searchParams.set('practice', '1');
  await page.goto(practiceUrl.toString(), { waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('Enter'); await scene('RaceScene');
  check('dated practice retains its daily course rather than starting lessons', (await state()).options.mode === 'practice' && (await state()).options.seed === dailyOptions.seed && await page.evaluate(() => !window.__game.scene.getScene('RaceScene').practiceObjective));
  const practiceBefore = await storage();
  await finishFixture();
  assert.deepEqual(await storage(), practiceBefore, 'dated practice does not change career or records');
  check('dated practice results explicitly exclude records and rewards', (await texts()).includes('PRACTICE · NO RECORDS OR REWARDS'));
  await page.screenshot({ path: '.verify/expansion-daily-practice-result.png' });
  const badLink = new URL(sharedUrl); badLink.searchParams.set('rules', 'unsupported-rules');
  await page.goto(badLink.toString(), { waitUntil: 'networkidle' }); await scene('TitleScene');
  check('unsupported daily links show a clear compatibility warning', (await texts()).includes('Invalid or outdated daily link'));

  phase = 'touch menu routes on a landscape phone';
  const touch = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  page = await touch.newPage(); page.setDefaultTimeout(45000); page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/?seed=42&touch=1`, { waitUntil: 'networkidle' }); await scene('TitleScene');
  await tap(826, 416); await scene('LockerScene');
  check('touch opens locker and preserves safe menu bounds', true); await layout('LockerScene');
  await tap(188, 480); await scene('TitleScene');
  await tap(638, 338); await scene('CupScene');
  await tap(800, 480); await scene('TitleScene');
  await tap(638, 416); await scene('RaceScene');
  check('touch Practice route enters guided practice', (await state()).options.mode === 'practice' && await page.evaluate(() => !!window.__game.scene.getScene('RaceScene').practiceObjective));
  await page.screenshot({ path: '.verify/expansion-phone-practice.png' });
  check('menu suite reports no uncaught errors', errors.length === 0);
} catch (error) {
  await page?.screenshot({ path: '.verify/expansion-menu-failure.png' }).catch(() => {});
  throw error;
} finally {
  writeFileSync('.verify/expansion-menus-report.json', JSON.stringify({ phase, checks, errors }, null, 2));
  await browser?.close();
}
