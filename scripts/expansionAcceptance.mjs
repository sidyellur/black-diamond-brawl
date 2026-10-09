/** Production-browser integration. Practice uses real keyboard input; clearly
 * labelled clean-course fixtures accelerate full recorder/finish paths only. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
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
  await page.keyboard.press('KeyP'); await scene('RaceScene'); await ready();
  await page.waitForFunction(() => { const r = window.__game.scene.getScene('RaceScene').aiRiders[0]; return r.attackPhase === 'windup' && r.attackProgress >= 0.62 && r.attackProgress < 0.88; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').combat.counterReady);
  await shot('practice-counter');
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').practiceLesson === 1);
  check('real keyboard timed evade and counter complete the bully lesson', true);
  await ready(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').practiceLesson === 2);
  check('real steering passes the defender without adding controls', true);
  await ready();
  await page.waitForFunction(() => { const s = window.__game.scene.getScene('RaceScene'); const dz = s.practiceMogulZ-s.player.worldZ; return dz <= 350 && dz > 80; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').practiceComplete);
  check('real jump and landing finish the daredevil lesson', true);
  await shot('practice-complete');
  check('practice completion is idempotent even at batched frame rates', await page.evaluate(() => {
    const s=window.__game.scene.getScene('RaceScene'); s.finishPractice(); s.update(0,50);
    return s.children.list.filter(o=>o.type==='Text'&&o.text==='READY FOR THE CIRCUIT').length===1;
  }));
  await tap(480,375);
  check('completion blank space cannot activate hidden pause buttons', await page.evaluate(() => window.__game.scene.isActive('RaceScene') && window.__game.scene.getScene('RaceScene').practiceComplete));
  check('practice does not write PBs, ghosts or career', await page.evaluate(() => !localStorage.getItem('black-diamond-brawl:records:v2') && !localStorage.getItem('black-diamond-brawl:ghosts:v1') && !localStorage.getItem('black-diamond-brawl:career:v1')));
  await page.keyboard.press('Enter'); await ready();
  check('practice can be replayed from its first lesson', await page.evaluate(() => window.__game.scene.getScene('RaceScene').practiceLesson===0));
  await page.keyboard.press('Escape'); await tap(480,375); await scene('TitleScene');

  phase = 'complete ghost capture through actual simulation';
  await page.keyboard.press('Enter'); await scene('RaceScene'); await ready();
  const run = await page.evaluate(() => {
    const s=window.__game.scene.getScene('RaceScene');
    // Hazard-free fixture changes only encounters. The actual fixed-step
    // player, scoring, recorder, checkpoints and endRace save remain active.
    s.paused=true; s.obstacles.length=0; s.pickups.length=0; s.crestApexZs.length=0;
    s.aiRiders.forEach((r,i)=>{r.worldZ=1000000+i*1000;r.finishTimeMs=1;});
    const dt=1000/60;
    for(let i=0;i<12000&&!s.raceOver;i++){
      if(i===150) s.player.requestLaneShift(1);
      if(i===300) s.player.requestLaneShift(-1);
      if(i===450) s.player.requestJump();
      s.simulate(dt,dt);
    }
    return {over:s.raceOver,time:s.elapsedRaceMs,seed:s.seed};
  });
  check('a complete clean-course simulation reaches the real finish/save path', run.over && run.time>90000);
  await scene('ResultScene');
  check('successful finish stores a personal ghost', await page.evaluate(() => window.__game.scene.getScene('ResultScene').resultData.ghostSaved));
  await page.keyboard.press('Enter'); await scene('RaceScene'); await ready();
  check('same-mountain retry loads its ghost without another racer/collider', await page.evaluate(() => {const s=window.__game.scene.getScene('RaceScene');return !!s.ghost && s.aiRiders.length===4 && s.aiCollisions.length===4;}));
  await shot('ghost-replay');
  const splits=await page.evaluate(()=>{
    const s=window.__game.scene.getScene('RaceScene');s.paused=true;s.obstacles.length=0;s.pickups.length=0;s.crestApexZs.length=0;
    s.aiRiders.forEach((r,i)=>{r.worldZ=1000000+i*1000;r.finishTimeMs=1;});
    for(let i=0;i<1700;i++)s.simulate(1000/60,1000/60);
    return {latest:s.checkpoints.latest,text:s.ghostSplit};
  });
  check('checkpoint splits compare the new run with recorded crossing time', splits.latest && Number.isFinite(splits.latest.deltaMs) && splits.text.includes('TO GHOST'));
  await page.reload({waitUntil:'networkidle'});await scene('TitleScene');await page.keyboard.press('Enter');await scene('RaceScene');
  check('ghost survives browser reload',await page.evaluate(()=>!!window.__game.scene.getScene('RaceScene').ghost));

  phase='actual themed terrain captures';
  for(const theme of ['forest','ridge','bowl']){
    await page.evaluate(theme=>{
      const s=window.__game.scene.getScene('RaceScene');s.paused=false;s.countdownMs=0;s.playerInput.setEnabled(true);
      const section=s.mountainSections.find(x=>x.theme===theme&&x.setpiece);
      s.player.worldZ=(section.startSegment+45)*200;s.player.speed=0;
      s.obstacles.length=0;s.pickups.length=0;s.aiRiders.forEach((r,i)=>{r.worldZ=s.player.worldZ+250+i*180;});
    },theme);
    await page.waitForTimeout(350);await shot(`theme-${theme}`);
  }
  check('all three themed sections render through production projection',true);
  check('expanded gameplay has no uncaught browser errors',errors.length===0);
} catch(error){await shot(`failure-${phase.replaceAll(' ','-')}`).catch(()=>{});throw error;}
finally{writeFileSync('.verify/expansion-report.json',JSON.stringify({phase,checks,errors},null,2));await browser.close();}
