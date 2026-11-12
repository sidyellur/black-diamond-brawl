/**
 * Real-browser acceptance for the feel pass.
 *
 *  A. A complete natural race (the production RaceScene.simulate, driven by the
 *     natural race driver) ends in identical state with effects on, with
 *     prefers-reduced-motion, and with sound and music switched off.
 *  B. The real RaceScene.update clock path: a scripted knockout, played through
 *     real frames with ragged timing, runs the slow-motion beat in the default
 *     context and none under reduced motion, and both reach the exact same
 *     simulation state at the same simulation step.
 *  C. Audio state: music starts on DROP IN, stops on pause, returns on resume,
 *     the music toggle silences only music, and both preferences survive a
 *     reload; backgrounding stops everything and nothing resumes by itself.
 *  D. The Sound Check screen opens at ?soundcheck=1 and every button plays.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { naturalRaceDriver } from './naturalRaceDriver.mjs';

const BASE_URL = (process.argv.find(arg => arg.startsWith('--url=')) ?? '--url=http://127.0.0.1:4173').slice(6);
const notes = [];
const errors = [];
const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); notes.push(name); console.log(`  PASS  ${name}`); };
const deadline = setTimeout(() => { console.error('feel acceptance timed out'); process.exit(1); }, 320000);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
async function open(url, options = {}, init) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, ...options });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.stack || e.message));
  await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game?.scene.isActive('TitleScene') || window.__game?.scene.isActive('SoundCheckScene'));
  return { context, page };
}
async function dropIn(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__game.scene.isActive('RaceScene'));
  await page.waitForFunction(() => { const s = window.__game.scene.getScene('RaceScene'); return s.countdownMs === 0 && !s.paused && s.player.speed > 0; });
}

try {
  // ---- A. natural race, three ways -----------------------------------------
  const results = {};
  for (const [name, options, init] of [
    ['effects on', {}, undefined],
    ['reduced motion', { reducedMotion: 'reduce' }, undefined],
    ['sound and music off', {}, () => { localStorage.setItem('bdb-muted', '1'); localStorage.setItem('bdb-music', '0'); }]
  ]) {
    const { context, page } = await open('/?seed=202', options, init);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.scene.isActive('RaceScene'));
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
    await page.evaluate(() => { const s = window.__game.scene.getScene('RaceScene'); s.countdownMs = 0; });
    const outcome = await page.evaluate(driver => {
      const scene = window.__game.scene.getScene('RaceScene');
      let breakdown = null;
      const start = scene.scene.start.bind(scene.scene);
      scene.scene.start = (key, data) => { if (key === 'ResultScene') breakdown = data.breakdown; return scene.scene; };
      const run = (0, eval)(`(${driver})`)({ render: false });
      scene.scene.start = start;
      // Ghost samples are part of the simulation record; text and timestamps are not.
      return JSON.stringify({ ...run, ghostSplit: undefined, breakdown });
    }, naturalRaceDriver.toString());
    results[name] = outcome;
    const parsed = JSON.parse(outcome);
    check(`${name}: a complete natural race finished (${parsed.elapsedMs} ms, ${parsed.fixedSteps} steps)`, parsed.over && parsed.breakdown !== null);
    await context.close();
  }
  check('natural race identical with effects on and with reduced motion', results['reduced motion'], results['effects on']);
  check('natural race identical with sound and music off', results['sound and music off'], results['effects on']);

  // ---- B. real update loop with a scripted knockout ---------------------------
  const scripted = async (options) => {
    const { context, page } = await open('/?seed=202', options);
    await dropIn(page);
    const out = await page.evaluate(() => new Promise(resolve => {
      const game = window.__game;
      const scene = game.scene.getScene('RaceScene');
      game.loop.sleep();
      scene.obstacles.length = 0; scene.pickups.length = 0;
      scene.aiRiders.slice(1).forEach((rival, i) => { rival.worldZ = scene.player.worldZ + 20000 + i * 900; });
      scene.player.armWeapon();
      const STOP_AT = 90;
      let sims = 0, pressed = false, released = false;
      const original = scene.simulate.bind(scene);
      let beatFrames = 0, minScale = 1, frames = 0, realMs = 0;
      scene.simulate = (delta, elapsed) => {
        // Scripted fight, keyed to simulation steps so it is identical in both runs.
        if (sims < 12) {
          const r = scene.aiRiders[0];
          r.worldZ = scene.player.worldZ + 100; r._laneIndex = Math.min(4, scene.player.laneIndex + 1); r.tween = null; r.speed = scene.player.speed;
          r.stagger = 2; r.staggerDecayMs = 9000;
        }
        if (sims === 10 && !pressed) { scene.playerInput.setAction('attack', true, 'script'); pressed = true; }
        if (sims === 11 && !released) { scene.playerInput.setAction('attack', false, 'script'); released = true; }
        original(delta, elapsed);
        sims++;
        if (sims >= STOP_AT) scene.paused = true;
      };
      // Ragged real frames, like a phone, from a fixed sequence.
      let seed = 12345;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      let t = performance.now();
      const pump = () => {
        for (let k = 0; k < 40 && !scene.paused; k++) {
          const d = 10 + rand() * 30;
          t += d; realMs += d; frames++;
          game.step(t, d);
          const scale = scene.juice.slowMotion.scale;
          if (scale < 1) { beatFrames++; minScale = Math.min(minScale, scale); }
        }
        if (!scene.paused) setTimeout(pump, 0);
        else resolve({
          sims, realMs: Math.round(realMs), frames, beatFrames, minScale, beats: scene.juice.slowMotionStarts,
          state: JSON.stringify({
            elapsed: scene.elapsedRaceMs, z: scene.player.worldZ, speed: scene.player.speed, lane: scene.player.laneOffsetFraction,
            score: scene.scoreTracker.runningScore, chain: scene.scoreTracker.chain,
            rivals: scene.aiRiders.map(r => [r.worldZ, r.speed, r.laneIndex, r.wipedOut, r.knockedDown, r.treeCrashSerial]), charges: scene.player.weaponCharges
          }),
          knocked: scene.aiRiders[0].knockedDown || scene.aiRiders[0].knockdownMsRemaining > 0
        });
      };
      pump();
    }));
    await context.close();
    return out;
  };
  const withEffects = await scripted({});
  const reducedRun = await scripted({ reducedMotion: 'reduce' });
  check(`scripted fight knocked the rival down (${withEffects.sims} simulation steps)`, withEffects.knocked && reducedRun.knocked);
  check(`default run played a slow-motion beat (${withEffects.beats} beat, ${withEffects.beatFrames} slow frames, floor ${withEffects.minScale})`, withEffects.beats === 1 && withEffects.beatFrames > 5);
  check('reduced-motion run played none', reducedRun.beats === 0 && reducedRun.beatFrames === 0);
  check(`slow motion cost real time, not simulation (${withEffects.realMs} ms vs ${reducedRun.realMs} ms real, same ${withEffects.sims} steps)`, withEffects.realMs > reducedRun.realMs && withEffects.sims === reducedRun.sims);
  check('same simulation state at the same step with and without slow motion', withEffects.state, reducedRun.state);

  // ---- C. audio state ----------------------------------------------------------
  {
    const { context, page } = await open('/?seed=202');
    const audio = () => page.evaluate(() => { const a = window.__game.scene.getScene('RaceScene').audio; return { running: a.isRunning, music: a.musicPlaying, musicOn: a.isMusicOn, muted: a.isMuted }; });
    await dropIn(page);
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.musicPlaying, null, { timeout: 15000 });
    check('music plays once the race is on', (await audio()).music);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
    check('music stops when paused', !(await audio()).music);
    // Music toggle button in the pause menu: game coordinates (480, 418).
    const click = async (x, y) => {
      const box = await page.locator('canvas').boundingBox();
      await page.mouse.click(box.x + box.width * x / 960, box.y + box.height * y / 540);
    };
    await click(480, 418);
    await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').audio.isMusicOn);
    check('pause-menu music toggle turns music off and saves it', await page.evaluate(() => localStorage.getItem('bdb-music') === '0' && localStorage.getItem('bdb-muted') !== '1'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').paused);
    await page.waitForTimeout(600);
    const resumed = await audio();
    check('resuming with music off keeps music silent and the mixer running', !resumed.music && resumed.running && !resumed.muted);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__game?.scene.isActive('TitleScene'));
    await dropIn(page);
    await page.waitForTimeout(800);
    const reloaded = await audio();
    check('music preference survives a reload (still off)', !reloaded.musicOn && !reloaded.music);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
    await click(480, 418);
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.isMusicOn);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.musicPlaying, null, { timeout: 15000 });
    check('music back on resumes the loop', (await audio()).music);
    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.isMuted);
    await page.waitForTimeout(400);
    check('mute silences the music too', !(await audio()).music);
    await page.keyboard.press('KeyM');
    // Backgrounding: nothing plays, nothing restarts on its own.
    await page.evaluate(() => window.__game.events.emit('hidden'));
    await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
    await page.waitForTimeout(300);
    const hidden = await audio();
    check('music is not playing while hidden/paused', !hidden.music);
    await context.close();
  }

  // ---- D. Sound Check ------------------------------------------------------------
  for (const [label, options, touch] of [['touch', { hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } }, true], ['mouse', {}, false]]) {
    const { context, page } = await open('/?soundcheck=1', options);
    const kinds = await page.evaluate(() => window.__audioLab.SOUND_KINDS);
    check(`Sound Check (${label}) lists ${kinds.length} sounds`, kinds.length >= 25);
    const box = await page.locator('canvas').boundingBox();
    const at = async (x, y) => {
      const px = box.x + box.width * x / 960, py = box.y + box.height * y / 540;
      if (touch) await page.touchscreen.tap(px, py); else await page.mouse.click(px, py);
    };
    const audio = () => page.evaluate(() => { const a = window.__game.scene.getScene('SoundCheckScene').audio; return { played: a.soundsPlayed, last: a.lastSound, running: a.isRunning, music: a.musicPlaying, level: a.musicLevel }; });
    await at(106, 87); // first button: HIT
    await page.waitForFunction(() => window.__game.scene.getScene('SoundCheckScene').audio.soundsPlayed >= 1, null, { timeout: 10000 });
    check(`Sound Check (${label}): the first tap unlocks audio and plays HIT`, (await audio()).last === 'hit' && (await audio()).running);
    const before = (await audio()).played;
    for (let i = 1; i < kinds.length; i++) {
      await at(14 + (i % 5) * 188 + 90, 62 + Math.floor(i / 5) * 56 + 25);
      await page.waitForTimeout(60);
    }
    const after = await audio();
    check(`Sound Check (${label}): every button plays its sound (${after.played - before} of ${kinds.length - 1})`, after.played - before === kinds.length - 1);
    await at(100, 440); // MUSIC PLAY
    await page.waitForFunction(() => window.__game.scene.getScene('SoundCheckScene').audio.musicPlaying, null, { timeout: 10000 });
    await at(532, 440); // flow +
    check(`Sound Check (${label}): music plays and the Flow stepper changes its layer`, (await audio()).music && (await audio()).level === 1);
    await at(100, 440); // MUSIC STOP
    await page.waitForFunction(() => !window.__game.scene.getScene('SoundCheckScene').audio.musicPlaying);
    await context.close();
  }

  check('no console errors', errors, []);
  console.log(`\nAll ${notes.length} feel acceptance checks passed.`);
} catch (error) {
  console.error(`FAIL ${error.message}`);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser.close();
}
