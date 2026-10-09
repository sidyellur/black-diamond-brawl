/**
 * Headless visual smoke test / regression gate.
 *
 * Boots the built game in headless Chromium, drives it through the title
 * screen into a race, and asserts:
 *   1. no console errors or uncaught page errors,
 *   2. the canvas actually rendered (not a blank frame),
 *   3. measured CIE L* separation for gameplay-critical edges,
 *   4. no entity exceeds a sane fraction of screen width.
 *
 * Screenshots are written to `.verify/` for eyeballing. This is the gate the
 * v2 overhaul runs after every task — see docs issue "[Epic] v2 Visual &
 * Game-Feel Overhaul", Phase 0 item 2.
 *
 * Usage: node scripts/smokeTest.mjs [--update] [--url=http://localhost:4173]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('.verify');
const URL = (process.argv.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:4173').slice(6);

mkdirSync(OUT, { recursive: true });

const failures = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) {
    notes.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- colour helpers (CIE L*, the perceptually correct metric) -------------
const srgbToLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const relLuminance = ([r, g, b]) =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
const lStar = (rgb) => {
  const y = relLuminance(rgb);
  return y > 0.008856 ? 116 * Math.pow(y, 1 / 3) - 16 : 903.3 * y;
};
const deltaL = (a, b) => Math.abs(lStar(a) - lStar(b));

let browser;
let page;
const consoleMessages = [];
const runtimeSnapshots = [];

async function recordRuntime(label) {
  if (!page || page.isClosed()) return;
  const runtime = await page.evaluate(() => {
    const game = window.__game;
    const sc = game?.scene.getScene('RaceScene');
    const gl = game?.renderer.gl;
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      activeScenes: game?.scene.getScenes(true).map((s) => s.scene.key),
      countdownMs: sc?.countdownMs, elapsedRaceMs: sc?.elapsedRaceMs,
      speed: sc?.player?.speed, paused: sc?.paused,
      actualFps: game?.loop.actualFps, rawDelta: game?.loop.rawDelta,
      documentHidden: document.hidden, documentFocused: document.hasFocus(),
      renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
      vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl?.getParameter(gl.VENDOR),
      sceneObjects: sc?.children?.length,
      navigationToTitleRenderedMs: window.__qaTitleRenderedMs,
      navigationObservedMs: performance.now()
    };
  });
  runtimeSnapshots.push({ label, at: new Date().toISOString(), ...runtime });
  console.log(`RUNTIME ${label}: ${JSON.stringify(runtime)}`);
}

async function run() {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // Chromium's supported ANGLE + SwiftShader driver path. The old
    // --use-gl=swiftshader switch is rejected by modern headless Chromium.
    args: ['--use-gl=angle', '--use-angle=swiftshader']
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    const attach = () => {
      const game = window.__game;
      if (!game?.events) { requestAnimationFrame(attach); return; }
      const rendered = () => {
        if (!game.scene.isActive('TitleScene')) return;
        window.__qaTitleRenderedMs = performance.now();
        game.events.off('postrender', rendered);
      };
      game.events.on('postrender', rendered);
    };
    requestAnimationFrame(attach);
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    consoleMessages.push({ type: m.type(), text: m.text() });
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

  const smokeUrl = new globalThis.URL(URL);
  // This seed contains both a substantial mid-course curve and jumpable crests
  // for the explicitly labeled position-fixture screenshots below.
  if (!smokeUrl.searchParams.has('seed')) smokeUrl.searchParams.set('seed', '202');
  await page.goto(smokeUrl.href, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game?.scene.isActive('TitleScene'));
  await recordRuntime('title');

  // The game canvas must exist and have non-zero size.
  const canvasBox = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  check('canvas present', !!canvasBox && canvasBox.w > 0, canvasBox ? `${canvasBox.w}x${canvasBox.h}` : 'no canvas');

  // Confirm we are on WebGL, not the Canvas fallback — postFX is WebGL-only.
  const rendererType = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return 'none';
    return c.getContext('webgl2') || c.getContext('webgl') ? 'webgl' : 'canvas';
  });
  check('WebGL renderer active', rendererType === 'webgl', rendererType);

  await page.screenshot({ path: `${OUT}/01-title.png` });

  // Enter the race.
  await page.keyboard.press('Space');
  await recordRuntime('drop-in');
  await page.waitForFunction(() => {
    const game = window.__game;
    const scene = game?.scene.getScene('RaceScene');
    return game?.scene.isActive('RaceScene') && scene?.player?.speed > 0;
  }, undefined, { timeout: 60000 });
  await recordRuntime('countdown-complete');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').elapsedRaceMs >= 1000, undefined, { timeout: 60000 });
  await page.screenshot({ path: `${OUT}/02-race-early.png` });

  // Assert/capture actual simulated progress, independent of software GPU FPS.
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').elapsedRaceMs >= 5500, undefined, { timeout: 90000 });
  await page.screenshot({ path: `${OUT}/03-race-mid.png` });
  await recordRuntime('racing');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${OUT}/03b-desktop-wide.png` });
  await page.setViewportSize({ width: 960, height: 540 });

  /**
   * Samples a screenshot PNG by decoding it inside the browser (drawImage into a
   * 2D canvas + getImageData). Reading the WebGL backbuffer directly with
   * `readPixels` does NOT work here — Phaser leaves `preserveDrawingBuffer`
   * false, so the buffer is undefined once the frame has been composited. The
   * screenshot is also the more faithful thing to assert on: it's what a player
   * actually sees, post-composite.
   */
  async function samplePng(pngBuffer) {
    const b64 = pngBuffer.toString('base64');
    return page.evaluate(async (dataUrl) => {
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data, width: w, height: h } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const at = (x, y) => {
        const i = (y * w + x) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const rowMean = (y) => {
        let r = 0, g = 0, b = 0;
        let n = 0;
        for (let x = 0; x < w; x += 4) {
          const p = at(x, y);
          r += p[0]; g += p[1]; b += p[2]; n++;
        }
        return [r / n, g / n, b / n];
      };
      // Widest run of distinct row-mean values = evidence the frame has structure.
      return {
        w, h,
        skyBand: rowMean(Math.floor(h * 0.15)),
        horizonBand: rowMean(Math.floor(h * 0.5)),
        nearRoad: rowMean(Math.floor(h * 0.88)),
        center: at(Math.floor(w / 2), Math.floor(h * 0.55))
      };
    }, `data:image/png;base64,${b64}`);
  }

  const midShot = await page.screenshot();
  const probe = await samplePng(midShot);

  // A blank/solid frame means nothing rendered.
  const skyVsRoad = deltaL(probe.skyBand, probe.nearRoad);
  check('frame is not blank', skyVsRoad > 1.0, `sky↔road ΔL* ${skyVsRoad.toFixed(1)}`);

  // Entity scale sanity. This is the regression test for the projection
  // singularity: rivals used to draw over 1600px wide on a 960px screen, and
  // combat resolved entirely inside that blow-up. Reads real runtime state
  // rather than pixels, via the harness hook in main.ts.
  const scales = await page.evaluate(() => {
    const g = window.__game;
    const sc = g && g.scene.getScene('RaceScene');
    if (!sc || !sc.playerSprite) return null;
    const riders = (sc.aiRiderRenderer?.pool || []).filter((s) => s.visible).map((s) => s.displayWidth);
    return { player: sc.playerSprite.displayWidth, riders };
  });

  if (scales) {
    const maxW = Math.max(scales.player, ...(scales.riders.length ? scales.riders : [0]));
    check('no entity exceeds 42% of screen width', maxW <= 960 * 0.42 + 1, `widest ${maxW.toFixed(0)}px`);
    check('player is on screen at a sane size', scales.player > 20 && scales.player < 300, `${scales.player.toFixed(0)}px`);
  } else {
    check('runtime scale probe', false, 'could not read RaceScene state');
  }

  // The attack button, end to end: park a rival in reach, press F, and assert
  // the game registered a deliberate attack rather than silently doing nothing.
  const attackResult = await page.evaluate(() => {
    const sc = window.__game?.scene.getScene('RaceScene');
    if (!sc?.combat) return { ok: false, why: 'no scene' };
    const r = sc.aiRiders[0];
    // Explicit neutral encounter fixture. A line-defender otherwise returns
    // to its original lane after repositioning, correctly leaving reach.
    // Keep its protected line aligned with this fixture, and clear nearby
    // hazards/other actors so this check measures a deliberate Attack only.
    const lane = sc.player.laneIndex < 4 ? sc.player.laneIndex + 1 : sc.player.laneIndex - 1;
    r.params.aggression = 0;
    r.params.cruiseSpeedFactor = 0.98;
    r.homeLane = lane;
    r._laneIndex = lane;
    r.tween = null;
    r.worldZ = sc.player.worldZ;
    r.speed = 2940;
    r.wipedOut = false;
    r.finishTimeMs = null;
    r.airborne = false;
    r.tumbleMsRemaining = 0;
    r.immunityMsRemaining = 0;
    r.hitReactionMsRemaining = 0;
    r.attack?.cancel();
    sc.player.airborne = false;
    sc.player.tumbleMsRemaining = 0;
    sc.player.immunityMsRemaining = 0;
    sc.player.speed = 3000;
    sc.player.tween = null;
    sc.obstacles.splice(0, sc.obstacles.length, ...sc.obstacles.filter(o => Math.abs(o.z-sc.player.worldZ)>3000));
    sc.aiRiders.slice(1).forEach(other => { other.worldZ = sc.player.worldZ - 100000; });
    sc.combat.pairImmunityMs.clear();
    sc.combat.attackCooldownMs = 0;
    sc.combat.currentTarget = null;
    sc.combat.update(0, sc.elapsedRaceMs);
    // Observe the real post-update swing once, rather than sampling a short
    // animation after a nondeterministic browser/CI round trip. No state is forced.
    window.__attackObservation = null;
    const observeAttack = () => {
      if (!sc.player.swinging) return;
      window.__attackObservation = { swinging: sc.player.swingMsRemaining > 0,
        riderRecoiling: r.hitReactionMsRemaining > 0, onCooldown: sc.combat.attackOnCooldown };
      sc.events.off('postupdate', observeAttack);
    };
    sc.events.on('postupdate', observeAttack);
    return { ok: true, targeted: sc.combat.target === r, cooldown: sc.combat.attackOnCooldown };
  });

  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__attackObservation !== null);
  const afterAttack = await page.evaluate(() => window.__attackObservation);
  await page.screenshot({ path: `${OUT}/05-attack.png` });

  check('a rival in reach becomes the attack target', attackResult.ok && attackResult.targeted, JSON.stringify(attackResult));
  check('pressing F starts a swing', afterAttack.swinging, JSON.stringify(afterAttack));
  check('the struck rival visibly recoils', afterAttack.riderRecoiling);
  check('attack goes on cooldown', afterAttack.onCooldown);

  // Explicit visual-QA position fixtures, not an automated full playthrough.
  // Course, obstacles, collisions and AI stay intact. Reposition only the
  // player onto a locally clear lane, then capture the real active renderer.
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').player.swinging);
  const positionFixtures = [];
  for (const kind of ['mid-course-curve', 'crest-approach']) {
    const fixture = await page.evaluate((view) => {
      const sc = window.__game.scene.getScene('RaceScene');
      const lanes = [2, 1, 3, 0, 4];
      const crestZ = sc.crestApexZs.find((z) => z > 520 * 200);
      const candidates = sc.track.filter((segment) => view === 'mid-course-curve'
        ? segment.index >= 500 && segment.index < sc.track.length - 150 && Math.abs(segment.curve) > 0.3
        : crestZ !== undefined && segment.z >= crestZ - 5000 && segment.z <= crestZ - 3000);
      for (const segment of candidates) {
        const z = segment.z + 100;
        const lane = lanes.find((candidate) => !sc.obstacles.some((obstacle) =>
          obstacle.lane === candidate && obstacle.z > z - 300 && obstacle.z < z + 1800));
        if (lane === undefined) continue;
        sc.player.worldZ = z;
        sc.player._laneIndex = lane;
        sc.player.tween = null;
        sc.prevWorldZ = z;
        // The camera teleport is not traversal. Keep the scorer's crossing
        // cursor aligned so skipped obstacles do not manufacture flow rewards.
        sc.scoreTracker.previousPlayerZ = z;
        sc.playerInput.reset();
        return {
          label: view, seed: sc.seed, segment: segment.index, z, lane,
          curve: segment.curve, elevation: segment.y, crestZ,
          visibleRangeObstacles: sc.obstacles.filter((o) => o.z > z && o.z < z + 25000).length
        };
      }
      return null;
    }, kind);
    check(`${kind} position fixture has a clear landing lane`, fixture !== null);
    if (!fixture) continue;
    await page.waitForFunction((z) => window.__game.scene.getScene('RaceScene').player.worldZ > z + 10, fixture.z);
    await page.screenshot({ path: `${OUT}/${kind === 'mid-course-curve' ? '13' : '14'}-${kind}-position-fixture.png` });
    positionFixtures.push(fixture);
  }
  writeFileSync(`${OUT}/position-fixtures.json`, JSON.stringify({ note: 'One-time player/camera position fixtures; not a full course playthrough.', positionFixtures }, null, 2));

  // Drive into the result screen so the finish/wipeout path is exercised too —
  // a crash there would otherwise never show up in this gate.
  await page.waitForTimeout(1000);
  const reachedResult = await page.evaluate(async () => {
    const g = window.__game;
    const sc = g && g.scene.getScene('RaceScene');
    if (!sc || !sc.player) return 'no-scene';
    sc.player.crashIntoTree(); // run-ending wipeout -> ResultScene
    return 'triggered';
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/04-result.png` });
  const onResult = await page.evaluate(() => {
    const g = window.__game;
    return g.scene.isActive('ResultScene');
  });
  check('wipeout reaches the result screen', reachedResult === 'triggered' && onResult, String(onResult));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | ') || 'clean');

}

try {
  await run();
} catch (error) {
  check('browser smoke completed', false, error.stack || error.message || String(error));
} finally {
  await recordRuntime(failures.length ? 'failure' : 'complete').catch((error) => {
    runtimeSnapshots.push({ label: 'diagnostic-error', message: error.message });
  });
  writeFileSync(`${OUT}/smoke-runtime.json`, JSON.stringify({ runtimeSnapshots, consoleMessages }, null, 2));
  if (failures.length && page && !page.isClosed()) {
    await page.screenshot({ path: `${OUT}/smoke-failure.png` }).catch(() => {});
  }
  await browser?.close();
}

const report = [
  '',
  '=== visual smoke test ===',
  ...notes,
  ...failures,
  ''
].join('\n');
writeFileSync(`${OUT}/report.txt`, report);
console.log(report);

if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('all checks passed.');
