import assert from 'node:assert/strict';
import { RoadRenderer } from '../src/render/RoadRenderer';
import { SkyRenderer } from '../src/render/SkyRenderer';
import { Juice } from '../src/render/Juice';
import { FinishBanner } from '../src/track/finishBanner';
import { project } from '../src/render/project';
import { softClampWidth } from '../src/render/projectEntity';
import { projectEntity } from '../src/render/projectEntity';
import { SEGMENT_LENGTH, CAMERA_BACK_Z, CAMERA_HEIGHT, LANES, ROAD_WIDTH, SCREEN_W, MAX_ENTITY_SCREEN_FRACTION, RIDER_WIDTH_FRACTION, RIDER_JUMP_HEIGHT_WORLD } from '../src/config';


// Same-depth outer rivals used to lie wholly outside the centered view. Keep
// the local pack readable without shrinking the player or flattening jumps.
for (const lane of LANES) {
  const p = project(lane * ROAD_WIDTH, 0, CAMERA_BACK_Z, 0, CAMERA_HEIGHT, 0)!;
  const width = softClampWidth(p.screenW * RIDER_WIDTH_FRACTION, SCREEN_W * MAX_ENTITY_SCREEN_FRACTION);
  assert.ok(p.screenX - width / 2 > 0 && p.screenX + width / 2 < SCREEN_W, 'all five centered-pack frames fit');
  assert.ok(width >= 94 && width <= 104, 'readable, coherent rider scale');
  assert.ok(p.screenY >= 455 && p.screenY <= 465, 'stable hero foot position');
}
const grounded = project(0, 0, CAMERA_BACK_Z, 0, CAMERA_HEIGHT, 0)!;
const jumping = project(0, RIDER_JUMP_HEIGHT_WORLD, CAMERA_BACK_Z, 0, CAMERA_HEIGHT, 0)!;
assert.ok(grounded.screenY - jumping.screenY >= 95 && grounded.screenY - jumping.screenY <= 100);
console.log('PASS local pack framing: five same-depth riders visible, stable hero size/feet and jump height');

let calls = 0;
let fillAlpha = 1;
const filledRectangles: { y: number; height: number; alpha: number }[] = [];
const graphics: any = new Proxy({}, { get: (_target, key) => key === 'clear' ? () => {
  calls = 0;
  filledRectangles.length = 0;
} : (...args: unknown[]) => {
  for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `${String(key)} received ${arg}`);
  if (key === 'fillStyle') fillAlpha = args[1] === undefined ? 1 : args[1] as number;
  if (key === 'fillRect') filledRectangles.push({ y: args[1] as number, height: args[3] as number, alpha: fillAlpha });
  calls++;
  return graphics;
}});
const scene: any = { add: { graphics: () => graphics } };
const renderer = new RoadRenderer(scene);
const track = Array.from({length: 400}, (_, i) => ({index: i, z: i * SEGMENT_LENGTH, y: Math.sin(i / 23) * 130, curve: Math.sin(i / 37) * 0.8, colorBand: (Math.floor(i / 3) % 2) as 0 | 1}));
const first = renderer.render(track, 0, 1000, 0, 0xcfe4f5);
const map = first.drawnSegments;
const set = first.clippedSegments;
for (let step = 1; step < 350; step++) {
  const z = step * 173;
  const result = renderer.render(track, Math.sin(step / 12) * 1300, 1000 + Math.sin(z / SEGMENT_LENGTH / 23) * 130, z, 0xcfe4f5);
  assert.equal(result.drawnSegments, map);
  assert.equal(result.clippedSegments, set);
  assert.ok(Number.isFinite(result.topScreenY));
  assert.ok(calls > 0);
}
console.log('PASS road projection/crest traversal: 350 varied-camera frames, finite geometry and reused bookkeeping');

const tileObjects: any[] = [];
const object = () => { const o:any={setOrigin:()=>o,setDepth:()=>o,setScrollFactor:()=>o,setDisplaySize:()=>o}; return o; };
const skyScene:any={textures:{exists:()=>true}, add:{image:()=>object(),graphics:()=>graphics,tileSprite:()=>{const o=object();tileObjects.push(o);return o;}}};
const sky = new SkyRenderer(skyScene);
for (const curve of [-200000, -1, 0, 1, 200000]) {
  sky.render(curve, 1000, 280);
  assert.equal(tileObjects.length, 3);
  assert.ok(tileObjects.every(o=>Number.isFinite(o.tilePositionX)));
  assert.equal(sky.displayObjects.length, 6);
}
console.log('PASS sky: all six objects registered, finite continuous parallax in both curve directions');

// Translucent haze must meet edge-to-edge. The previous one-pixel rectangle
// bleed blended each boundary twice, leaving scanlines above high crests.
for (const snowEdge of [-20, 198, 281, 360, 500]) {
  sky.render(0, 0, snowEdge);
  assert.equal(filledRectangles.length, 32, 'fine haze gradient subdivision');
  assert.ok(Math.abs(filledRectangles[0].y - Math.min(540 * 0.62 - 10, snowEdge - 30)) < 1e-9);
  const last = filledRectangles[filledRectangles.length - 1];
  assert.ok(Math.abs(last.y + last.height - (snowEdge + 2)) < 1e-9, 'haze reaches the snow edge');
  filledRectangles.forEach((rect, i) => {
    assert.ok(rect.height > 0 && rect.alpha >= 0 && rect.alpha <= 1);
    if (i === 0) return;
    const previous = filledRectangles[i - 1];
    assert.ok(Math.abs(previous.y + previous.height - rect.y) < 1e-9, 'no haze overlaps or gaps');
    assert.ok(rect.alpha > previous.alpha && rect.alpha - previous.alpha < 0.06, 'smooth monotonic haze opacity');
  });
}
console.log('PASS haze: 32 contiguous strips, no double-alpha seams, smooth opacity at five snow edges including high crests');

function testJuice(hz: number) {
  let powder = 0;
  let emitters = 0;
  const s:any = {
    time:{now:100}, tweens:{killTweensOf:()=>{},add:()=>{}},
    add:{graphics:()=>graphics,rectangle:()=>({setDepth:()=>{},setAlpha:()=>{}}),particles:()=>{
      const index = emitters++;
      return {setDepth:()=>{},setEmitterAngle:()=>{},emitParticleAt:(_x:number,_y:number,n:number)=>{if(index===0)powder+=n;}};
    }}};
  const juice = new Juice(s, {shake:()=>{}} as any, ()=>{});
  for (let i=0;i<hz*3;i++) {s.time.now += 1000/hz;juice.emitCarve(i,459,1,true);juice.tick(1000/hz);juice.renderSpeed(3000,s.time.now);}
  for(let i=0;i<20;i++)juice.combatHit({x:480,y:400});
  assert.equal((juice as any).rings.length,6);
  juice.renderSpeed(0,s.time.now+16);
  juice.tick(1000);
  assert.ok((juice as any).rings.every((r:any)=>r.life===0));
  assert.equal(juice.frozen,false);
  return powder;
}
const counts=[30,60,144].map(testJuice);
assert.ok(Math.max(...counts)-Math.min(...counts)<=3, `frame-rate-dependent powder: ${counts}`);
console.log(`PASS juice: powder at 30/60/144 Hz = ${counts.join('/')}; six-ring pool expires correctly`);

// The finish arch must use the exact road-projection offsets and never cover
// the full space from fabric to ground. Record actual draw calls, not colors.
const rectangles: number[][] = [];
const lines: number[][] = [];
const bannerGraphics: any = {
  clear: () => { rectangles.length = 0; lines.length = 0; },
  fillStyle: () => {}, lineStyle: () => {}, fillEllipse: () => {},
  fillRect: (...values: number[]) => rectangles.push(values),
  lineBetween: (...values: number[]) => lines.push(values)
};
const banner = new FinishBanner({ add: { graphics: () => bannerGraphics } } as any);
const finish = track[40];
const camera = {x: 420, y: 1100, z: 5000};
const offsets = new Map([[40, {nearOffsetX: 680, farOffsetX: 695, clipped: false}]]);
banner.render(finish, track, offsets, camera);
assert.equal(rectangles.length, 25, 'backing plus 24 checker tiles');
const ground = projectEntity(0, finish.z, track, offsets, camera)!;
assert.ok(Math.abs(lines[0][0] - (ground.screenX - ground.screenW * 1.035)) < 0.0001);
assert.ok(Math.abs(lines[2][0] - (ground.screenX + ground.screenW * 1.035)) < 0.0001);
const archHeight = ground.screenY - lines[0][3];
for (const rect of rectangles) {
  assert.ok(rect[3] < archHeight * 0.2, 'fabric must stay at the top of the arch');
  assert.ok(rect[1] + rect[3] < ground.screenY - archHeight * 0.75, 'ride-through space stays open');
}
offsets.get(40)!.clipped = true;
banner.render(finish, track, offsets, camera);
assert.equal(rectangles.length, 0, 'crest-clipped finish is hidden');
assert.equal(lines.length, 0);
offsets.clear();
banner.render(finish, track, offsets, camera);
assert.equal(rectangles.length, 0, 'finish beyond draw distance is hidden');
console.log('PASS finish: curved-road anchoring, open arch clearance, crest clipping, and draw-distance culling');
