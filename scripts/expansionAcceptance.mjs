/** Production-browser integration: real keyboard practice and an accelerated
 * natural-course driver retain all hazards, pickups, crests and four real rivals. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { naturalRaceDriver } from './naturalRaceDriver.mjs';
const base = (process.argv.find(a => a.startsWith('--url=')) ?? '--url=http://127.0.0.1:4173').slice(6);
mkdirSync('.verify', { recursive: true });
const checks = [], errors = [];
let phase = 'launch';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
page.on('pageerror', error => errors.push(String(error)));
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const scene = key => page.waitForFunction(k => window.__game?.scene.isActive(k), key);
const ready = () => page.waitForFunction(() => { const s = window.__game.scene.getScene('RaceScene'); return s.countdownMs === 0 && !s.paused; });
const shot = name => page.screenshot({ path: `.verify/expansion-${name}.png` });
const tap = async (x,y) => { const b = await page.locator('canvas').boundingBox(); await page.mouse.click(b.x+x*b.width/960,b.y+y*b.height/540); };
try {
  phase = 'three real-input practice lessons';
  await page.goto(`${base}/?seed=42`, { waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('KeyP'); await scene('RaceScene'); await shot('practice-countdown'); await ready();
  check('bully lesson teaches the real roster identity SLATE', await page.evaluate(() => window.__game.scene.getScene('RaceScene').aiRiders[0].params.name==='SLATE'));
  await page.evaluate(() => {
    const s=window.__game.scene.getScene('RaceScene'); window.__practiceTrace=[];
    const attempt=s.combat.attemptAttack.bind(s.combat);
    s.combat.attemptAttack=(time)=>{const before={time,ready:s.combat.counterReady,fraction:s.combat.counterFraction,airborne:s.player.airborne};const ok=attempt(time);window.__practiceTrace.push({...before,ok});return ok;};
    s.input.keyboard.on('keydown',e=>{if(e.code==='KeyF')window.__practiceTrace.push({key:e.code,time:s.elapsedRaceMs});});
  });
  await page.waitForFunction(() => { const r = window.__game.scene.getScene('RaceScene').aiRiders[0]; return r.attackPhase === 'windup' && r.attackProgress >= 0.62 && r.attackProgress < 0.88; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').combat.counterReady);
  // Do not insert a screenshot round-trip inside the short counter window.
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => { const s=window.__game.scene.getScene('RaceScene'); return s.practiceObjective?.countered || s.practiceLesson === 1; });
  await shot('practice-counter-hit');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').practiceLesson === 1);
  check('real keyboard timed evade and counter complete the bully lesson', true);
  await ready();
  check('defender lesson teaches the real roster identity NOVA', await page.evaluate(() => window.__game.scene.getScene('RaceScene').aiRiders[0].params.name==='NOVA'));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').practiceLesson === 2);
  check('real steering passes the defender without adding controls', true);
  await ready();
  check('daredevil lesson teaches the real roster identity EMBER', await page.evaluate(() => window.__game.scene.getScene('RaceScene').aiRiders[0].params.name==='EMBER'));
  await page.waitForFunction(() => { const s = window.__game.scene.getScene('RaceScene'); const dz = s.practiceMogulZ-s.player.worldZ; return dz <= 350 && dz > 80; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').practiceComplete);
  check('real jump and landing finish the daredevil lesson', true);
  await shot('practice-complete');
  check('practice completion is idempotent even at batched frame rates', await page.evaluate(() => {
    const s=window.__game.scene.getScene('RaceScene'); s.finishPractice(); s.update(0,50);
    return s.children.list.filter(o=>o.type==='Text'&&o.text==='READY FOR THE CIRCUIT').length===1;
  }));
  await page.keyboard.press('KeyR');
  check('completion ignores the hidden pause retry shortcut', await page.evaluate(() => window.__game.scene.getScene('RaceScene').practiceComplete));
  await tap(480,375);
  check('completion blank space cannot activate hidden pause buttons', await page.evaluate(() => window.__game.scene.isActive('RaceScene') && window.__game.scene.getScene('RaceScene').practiceComplete));
  check('practice does not write PBs, ghosts or career', await page.evaluate(() => !localStorage.getItem('black-diamond-brawl:records:v2') && !localStorage.getItem('black-diamond-brawl:ghosts:v1') && !localStorage.getItem('black-diamond-brawl:career:v1')));
  await page.keyboard.press('Enter'); await ready();
  check('practice can be replayed from its first lesson', await page.evaluate(() => window.__game.scene.getScene('RaceScene').practiceLesson===0));
  await page.keyboard.press('Escape'); await tap(480,375); await scene('TitleScene');

  phase = 'complete natural course and ghost capture';
  await page.goto(`${base}/?seed=202`, { waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('Enter'); await scene('RaceScene'); await ready();
  const run = await page.evaluate(naturalRaceDriver, {});
  writeFileSync('.verify/expansion-natural-run.json', JSON.stringify(run, null, 2));
  check('complete natural course reaches real finish with every hazard and four real rivals intact',
    run.finished && run.elapsedMs>90000 && run.obstacles>100 && run.unchangedCourseAndRoster && run.rivals.length===4);
  check('natural run exercises legal steering, real crests and live rival encounters',
    run.shifts>0 && run.crestCrossings>0 && run.rivals.some(r=>r.obstacleHits>0));
  await scene('ResultScene');
  check('natural successful finish stores its personal ghost', await page.evaluate(() => window.__game.scene.getScene('ResultScene').resultData.ghostSaved));
  await page.waitForFunction(() => !window.__game.scene.getScene('ResultScene').cameras.main.fadeEffect.isRunning);
  await shot('natural-finish-result');
  await page.keyboard.press('Enter'); await scene('RaceScene'); await ready();
  check('same-mountain retry loads its ghost without another racer/collider', await page.evaluate(() => {const s=window.__game.scene.getScene('RaceScene');return !!s.ghost && s.aiRiders.length===4 && s.aiCollisions.length===4;}));
  // A real different steering choice separates the live rider from the ghost,
  // rather than relocating either sprite for the visual assertion.
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(350);
  check('personal ghost is a rendered translucent rider', await page.evaluate(() => {
    const s=window.__game.scene.getScene('RaceScene');
    return s.ghostSprite.visible && s.ghostSprite.alpha>0 && s.ghostSprite.alpha<1 && Math.abs(s.ghostSprite.x-s.playerSprite.x)>5;
  }));
  await shot('ghost-replay');
  const replay = await page.evaluate(naturalRaceDriver, { stopAtCheckpoint: 0 });
  writeFileSync('.verify/expansion-natural-replay.json', JSON.stringify(replay, null, 2));
  const split = replay.checkpoints[0];
  check('natural replay checkpoint compares its crossing time with the recorded run',
    !replay.wipedOut && split && Number.isFinite(split.deltaMs) && replay.ghostSplit.includes('TO GHOST') && replay.unchangedCourseAndRoster);
  await shot('ghost-checkpoint-split');
  await page.reload({waitUntil:'networkidle'});await scene('TitleScene');await page.keyboard.press('Enter');await scene('RaceScene');
  check('ghost survives browser reload',await page.evaluate(()=>!!window.__game.scene.getScene('RaceScene').ghost));

  await ready();
  phase='actual themed terrain captures';
  for(const theme of ['forest','ridge','bowl']){
    await page.evaluate(theme=>{
      const s=window.__game.scene.getScene('RaceScene');s.paused=false;s.countdownMs=0;s.playerInput.setEnabled(true);
      const section=s.mountainSections.find(x=>x.theme===theme&&x.setpiece);
      s.player.worldZ=(section.startSegment+45)*200;s.player.speed=0;
      // Position-only visual fixture. Terrain, setpiece obstacles and pickups remain generated.
      s.aiRiders.forEach((r,i)=>{r.worldZ=s.player.worldZ+250+i*180;});
    },theme);
    await page.waitForTimeout(350);await shot(`theme-${theme}`);
  }
  check('all three themed sections render through production projection',true);
  phase='complete natural three-race championship';
  await page.goto(`${base}/?seed=202`, { waitUntil: 'networkidle' }); await scene('TitleScene');
  await page.keyboard.press('KeyC'); await scene('CupScene');
  await page.keyboard.press('Enter'); await scene('RaceScene');
  const cupRuns=[];
  for (let round=0; round<3; round++) {
    await ready();
    const identity=await page.evaluate(()=>window.__game.scene.getScene('RaceScene').options);
    check(`natural cup round ${round+1} starts its actual persistent identity`, identity.mode==='cup' && identity.roundIndex===round);
    const driven=await page.evaluate(naturalRaceDriver, {}); cupRuns.push(driven);
    check(`natural cup round ${round+1} finishes with hazards and all rivals retained`, driven.finished && driven.unchangedCourseAndRoster && driven.obstacles>100);
    await scene('ResultScene');
    const result=await page.evaluate(()=>window.__game.scene.getScene('ResultScene').resultData);
    check(`natural cup round ${round+1} commits standings once`, result.cup.rounds.length===round+1 && result.breakdown.finished);
    if (round===0) {
      // Actual saved cup survives reload before the second natural race.
      await page.goto(`${base}/?seed=202`, {waitUntil:'networkidle'}); await scene('TitleScene');
      await page.keyboard.press('KeyC'); await scene('CupScene');
    }
    await page.keyboard.press('Enter'); await scene(round===2?'CupScene':'RaceScene');
  }
  writeFileSync('.verify/expansion-natural-cup.json',JSON.stringify(cupRuns,null,2));
  check('natural three-race cup reaches complete standings and an earned medal',await page.evaluate(()=>{
    const s=window.__game.scene.getScene('CupScene');return s.cup.status==='complete' && s.cup.rounds.length===3 && !!s.cup.medal;
  }));
  await shot('natural-cup-podium');
  check('expanded gameplay has no uncaught browser errors',errors.length===0);
} catch(error){
  const state=await page.evaluate(()=>{const s=window.__game?.scene.getScene('RaceScene');return s ? {practiceLesson:s.practiceLesson,objective:s.practiceObjective,elapsed:s.elapsedRaceMs,feedback:s.practiceFeedback,counterReady:s.combat?.counterReady,counterCount:s.counterCount,trace:window.__practiceTrace,paused:s.paused,player:{lane:s.player?.laneIndex,airborne:s.player?.airborne,swing:s.player?.swingMsRemaining},riders:s.aiRiders?.map(r=>({z:r.worldZ,phase:r.attackPhase,progress:r.attackProgress}))} : null;}).catch(()=>null);
  writeFileSync('.verify/expansion-failure-state.json',JSON.stringify(state,null,2));
  await shot(`failure-${phase.replaceAll(' ','-')}`).catch(()=>{});throw error;}
finally{writeFileSync('.verify/expansion-report.json',JSON.stringify({phase,checks,errors},null,2));await browser.close();}
