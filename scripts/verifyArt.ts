/// <reference types="phaser" />
/** Actual generated-buffer art gate. Pure Node: no Phaser runtime or DOM.
 * Run: node --import tsx scripts/verifyArt.ts
 * Browser/GPU upload and Canvas-painted sky/mountains are measured separately.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  drawRider, PLAYER_RIDER_PALETTE, RIDER_FRAME_SIZE, RIVAL_RIDER_PALETTES,
  type RiderPose
} from '../src/entities/riderArt';
import { drawObstacle, OBSTACLE_ART_SIZE, type ObstacleArtKind } from '../src/entities/obstacleArt';
import { drawPickup, PICKUP_ART_SIZE } from '../src/entities/pickupArt';
import { deltaL, MIN_OUTLINE_DELTA_L, SNOW } from '../src/render/palette';
import { measureOutlineContrast, PixelCanvas } from '../src/render/pixel';

const poses: RiderPose[] = ['lean-left', 'center', 'lean-right', 'jump', 'tumble', 'hit', 'swing'];
const kinds: ObstacleArtKind[] = ['tree', 'rock', 'mogul'];
type Kind = 'rider' | 'tree' | 'rock' | 'mogul' | 'pickup';
interface Entry { name: string; kind: Kind; cv: PixelCanvas; generationMs: number }
interface Bounds { left: number; top: number; right: number; bottom: number }
const entries: Entry[] = [];
const sheets: PixelCanvas[] = [];
let passed = 0;
const failures: string[] = [];
function check(name: string, run: () => void): void {
  try { run(); passed++; }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : error}`); }
}
const mib = (bytes: number): number => bytes / (1024 * 1024);
const digest = (data: Uint8Array | Uint8ClampedArray): string => createHash('sha256').update(data).digest('hex');
const memoryBefore = process.memoryUsage();
const generationStart = performance.now();
function generate(name: string, kind: Kind, draw: () => PixelCanvas): void {
  const start = performance.now();
  const cv = draw();
  entries.push({ name, kind, cv, generationMs: performance.now() - start });
}
const palettes = [PLAYER_RIDER_PALETTE, ...RIVAL_RIDER_PALETTES];
for (const [index, palette] of palettes.entries()) {
  for (const pose of poses) generate(`${index === 0 ? 'player' : `rival${index - 1}`}/${pose}`, 'rider', () => drawRider(pose, palette));
}
for (const kind of kinds) {
  generate(`obstacle/${kind}`, kind, () => drawObstacle(kind));
  if (kind === 'tree') for (const variant of [1, 2]) {
    generate(`obstacle/tree-${variant}`, kind, () => drawObstacle(kind, variant));
  }
}
generate('pickup/ski-pole', 'pickup', drawPickup);
const generationMs = performance.now() - generationStart;

// Reproduce the actual boot's row-atlas packing and verify every visible byte.
const packingStart = performance.now();
let packingMs = 0;
function pack(group: Entry[]): void {
  const start = performance.now();
  const size = group[0].cv.w;
  const sheet = new PixelCanvas(size * group.length, size);
  group.forEach((entry, index) => sheet.blit(entry.cv, index * size, 0));
  sheets.push(sheet);
  packingMs += performance.now() - start;
  check(`${group[0].name} atlas keeps frame pixels and transparent seams`, () => {
    group.forEach(({ cv }, index) => {
      for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
        const alpha = cv.alphaAt(x, y);
        assert.equal(sheet.alphaAt(x + index * size, y), alpha);
        if (alpha) assert.equal(sheet.colorAt(x + index * size, y), cv.colorAt(x, y));
      }
    });
  });
}
for (let palette = 0; palette < palettes.length; palette++) pack(entries.slice(palette * poses.length, (palette + 1) * poses.length));
pack(entries.filter((entry) => kinds.includes(entry.kind as ObstacleArtKind)));
sheets.push(entries[entries.length - 1].cv);
const packingAndVerificationMs = performance.now() - packingStart;
const memoryAfterBuffers = process.memoryUsage();

/** Exterior antialias coverage, flood-filled from the image border. Internal
 * transparent details do not masquerade as the outside of the silhouette. */
function exteriorCoverage(cv: PixelCanvas): Uint8Array {
  const outside = new Uint8Array(cv.w * cv.h);
  const queue: number[] = [];
  const add = (x: number, y: number): void => {
    if (!cv.inBounds(x, y)) return;
    const i = y * cv.w + x;
    if (!outside[i] && cv.alphaAt(x, y) < 255) { outside[i] = 1; queue.push(i); }
  };
  for (let x = 0; x < cv.w; x++) { add(x, 0); add(x, cv.h - 1); }
  for (let y = 0; y < cv.h; y++) { add(0, y); add(cv.w - 1, y); }
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i] % cv.w;
    const y = Math.floor(queue[i] / cv.w);
    add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1);
  }
  return outside;
}

/** Measure full-coverage boundary pixels, never pretending a 1/255-alpha fringe
 * is an opaque edge. Check both actual snow bands, not just palette constants. */
function opaqueEdgeContrast(cv: PixelCanvas) {
  const outside = exteriorCoverage(cv);
  let minimum = Infinity;
  let samples = 0;
  let worst = { x: -1, y: -1, color: '', background: '' };
  const neighbours = (x: number, y: number) => [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
    if (cv.alphaAt(x, y) !== 255 || !neighbours(x, y).some(([xx, yy]) =>
      !cv.inBounds(xx, yy) || outside[yy * cv.w + xx])) continue;
    samples++;
    for (const [label, background] of [['packed', SNOW.packed], ['packedAlt', SNOW.packedAlt]] as const) {
      const contrast = deltaL(cv.colorAt(x, y), background);
      if (contrast < minimum) {
        minimum = contrast;
        worst = { x, y, color: cv.colorAt(x, y).toString(16).padStart(6, '0'), background: label };
      }
    }
  }
  return { minimum, samples, worst };
}

/** Exact area averaging for projected-size alpha masks, independent of a GPU. */
function silhouetteAtSize(cv: PixelCanvas, width: number) {
  const height = Math.round(width * cv.h / cv.w);
  const sx = cv.w / width;
  const sy = cv.h / height;
  let visiblePixels = 0;
  let solidPixels = 0;
  let alphaArea = 0;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const left = px * sx; const right = (px + 1) * sx;
    const top = py * sy; const bottom = (py + 1) * sy;
    let weighted = 0;
    for (let y = Math.floor(top); y < Math.ceil(bottom); y++) for (let x = Math.floor(left); x < Math.ceil(right); x++) {
      const area = Math.max(0, Math.min(right, x + 1) - Math.max(left, x)) *
        Math.max(0, Math.min(bottom, y + 1) - Math.max(top, y));
      weighted += cv.alphaAt(x, y) / 255 * area;
    }
    const coverage = weighted / (sx * sy);
    alphaArea += coverage;
    if (coverage >= 0.1) visiblePixels++;
    if (coverage >= 0.5) solidPixels++;
  }
  return { width, height, visiblePixels, solidPixels, alphaArea };
}

// Broad subject-specific silhouette requirements, not snapshots of today's art.
const geometry: Record<Kind, { minWidth: number; minHeight: number; minFill: number }> = {
  rider: { minWidth: 0.55, minHeight: 0.5, minFill: 0.08 },
  tree: { minWidth: 0.35, minHeight: 0.6, minFill: 0.1 },
  rock: { minWidth: 0.5, minHeight: 0.2, minFill: 0.05 },
  mogul: { minWidth: 0.55, minHeight: 0.15, minFill: 0.03 },
  pickup: { minWidth: 0.3, minHeight: 0.5, minFill: 0.025 }
};

check('all seven poses and four rival palettes are generated', () => {
  assert.equal(poses.length, 7);
  assert.equal(RIVAL_RIDER_PALETTES.length, 4);
  assert.equal(entries.filter((entry) => entry.kind === 'rider').length, 35);
  assert.equal(entries.filter((entry) => entry.kind === 'tree').length, 3);
  assert.equal(entries.length, 41);
  assert.equal(new Set(entries.map((entry) => entry.name)).size, entries.length);
});
check('high-resolution gameplay frame sizes stay aligned', () => {
  assert.equal(RIDER_FRAME_SIZE, 192);
  assert.equal(OBSTACLE_ART_SIZE, 192);
  assert.equal(PICKUP_ART_SIZE, 192);
});

console.log('\n=== generated gameplay art: 41 buffers ===');
const reports = entries.map(({ name, kind, cv, generationMs: entryMs }) => {
  const bounds: Bounds = { left: cv.w, top: cv.h, right: -1, bottom: -1 };
  let occupied = 0; let opaque = 0; let fractional = 0;
  const colors = new Set<number>();
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
    const alpha = cv.alphaAt(x, y);
    if (!alpha) continue;
    occupied++;
    if (alpha === 255) opaque++; else fractional++;
    colors.add(cv.colorAt(x, y));
    bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
  }
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const edge = opaqueEdgeContrast(cv);
  const legacyContrast = measureOutlineContrast(cv, SNOW.packed);
  const scales = [24, 40, 78].map((size) => silhouetteAtSize(cv, size));
  check(`${name} finite RGBA storage`, () => {
    assert.equal(cv.w, 192); assert.equal(cv.h, 192);
    assert.ok(cv.data instanceof Uint8ClampedArray);
    assert.equal(cv.data.length, cv.w * cv.h * 4);
    assert.ok(cv.data.every((value) => Number.isFinite(value) && value >= 0 && value <= 255));
    assert.ok(opaque > 32, 'visible fully opaque subject is required');
  });
  check(`${name} transparent gutter / no cropped silhouette`, () => {
    assert.ok(bounds.left >= 1 && bounds.top >= 1 && bounds.right <= cv.w - 2 && bounds.bottom <= cv.h - 2,
      `occupied bounds ${JSON.stringify(bounds)} touch the frame; every edge needs a transparent pixel gutter`);
  });
  check(`${name} useful occupied bounds and material detail`, () => {
    const profile = geometry[kind];
    assert.ok(width / cv.w >= profile.minWidth, `silhouette too narrow (${width}px)`);
    assert.ok(height / cv.h >= profile.minHeight, `silhouette too short (${height}px)`);
    assert.ok(opaque / (cv.w * cv.h) >= profile.minFill, `opaque subject too sparse (${opaque}px)`);
    assert.ok(occupied / (cv.w * cv.h) < 0.85, 'frame must retain useful negative space');
    assert.ok(colors.size >= 64, `only ${colors.size} colors; expected smooth shaded materials`);
    assert.ok(fractional >= 16, 'high-resolution contour must include antialias coverage');
  });
  check(`${name} full-coverage exterior outline contrast`, () => {
    assert.ok(edge.samples >= 16, 'no meaningful fully opaque boundary was sampled');
    assert.ok(edge.minimum >= MIN_OUTLINE_DELTA_L,
      `ΔL* ${edge.minimum.toFixed(2)} < ${MIN_OUTLINE_DELTA_L}; worst ${JSON.stringify(edge.worst)}`);
  });
  check(`${name} existing SpriteLab raw-outline compatibility`, () => {
    assert.ok(legacyContrast >= MIN_OUTLINE_DELTA_L, `raw ΔL* ${legacyContrast.toFixed(2)}`);
  });
  check(`${name} silhouette survives 24/40/78px game-scale sampling`, () => {
    for (const scale of scales) {
      assert.ok(scale.solidPixels >= Math.max(5, scale.width * scale.height * 0.015), `${scale.width}px: too few stable subject pixels`);
      assert.ok(scale.alphaArea > scale.width * scale.height * 0.025, `${scale.width}px: insignificant silhouette area`);
    }
  });
  console.log(`  ${name.padEnd(21)} bounds ${`${width}×${height}`.padStart(7)}  AA ${String(fractional).padStart(4)}  opaque ΔL* ${edge.minimum.toFixed(1).padStart(4)}  lab ${legacyContrast.toFixed(1).padStart(4)}  24px solid ${scales[0].solidPixels}`);
  return { name, kind, bounds, occupied, opaque, fractional, uniqueColors: colors.size,
    edge, legacyContrast, scales, generationMs: entryMs, rgbaHash: digest(cv.data) };
});

for (let palette = 0; palette < palettes.length; palette++) {
  const group = entries.slice(palette * poses.length, (palette + 1) * poses.length);
  check(`palette ${palette} poses contain distinct imagery and silhouettes`, () => {
    assert.equal(new Set(group.map(({ cv }) => digest(cv.data))).size, poses.length);
    const masks = group.map(({ cv }) => Uint8Array.from({ length: cv.w * cv.h }, (_, i) => cv.data[i * 4 + 3] >= 128 ? 1 : 0));
    assert.equal(new Set(masks.map(digest)).size, poses.length);
    for (let a = 0; a < masks.length; a++) for (let b = a + 1; b < masks.length; b++) {
      let union = 0; let difference = 0;
      masks[a].forEach((value, i) => { if (value || masks[b][i]) union++; if (value !== masks[b][i]) difference++; });
      assert.ok(difference / union > 0.05, `${poses[a]}/${poses[b]} silhouette differs by only ${(100 * difference / union).toFixed(1)}%`);
    }
  });
}
check('every rival palette changes a meaningful area of the actual rendered suit', () => {
  const centers = entries.filter((entry) => entry.name.endsWith('/center'));
  for (let a = 0; a < centers.length; a++) for (let b = a + 1; b < centers.length; b++) {
    let compared = 0; let different = 0;
    const ca = centers[a].cv; const cb = centers[b].cv;
    for (let y = 0; y < ca.h; y++) for (let x = 0; x < ca.w; x++) {
      if (ca.alphaAt(x, y) !== 255 || cb.alphaAt(x, y) !== 255) continue;
      compared++;
      if (ca.colorAt(x, y) !== cb.colorAt(x, y)) different++;
    }
    assert.ok(different / compared >= 0.05, `${centers[a].name}/${centers[b].name} differ on only ${different} of ${compared} opaque pixels`);
  }
});
check('tree variants contain distinct silhouettes', () => {
  const trees = entries.filter((entry) => entry.kind === 'tree');
  const masks = trees.map(({ cv }) => Uint8Array.from({ length: cv.w * cv.h }, (_, i) => cv.data[i * 4 + 3] >= 128 ? 1 : 0));
  assert.equal(new Set(masks.map(digest)).size, 3);
});
check('generation is deterministic for a representative rider and each hazard/pickup', () => {
  assert.equal(digest(drawRider('swing', PLAYER_RIDER_PALETTE).data), reports.find((entry) => entry.name === 'player/swing')!.rgbaHash);
  for (const kind of kinds) assert.equal(digest(drawObstacle(kind).data), reports.find((entry) => entry.name === `obstacle/${kind}`)!.rgbaHash);
  for (const variant of [1, 2]) assert.equal(digest(drawObstacle('tree', variant).data), reports.find((entry) => entry.name === `obstacle/tree-${variant}`)!.rgbaHash);
  assert.equal(digest(drawPickup().data), reports.find((entry) => entry.kind === 'pickup')!.rgbaHash);
});

const workload = {
  scope: 'All gameplay sprite buffers and CPU atlas packing; excludes Canvas sky/mountains, texture upload, renderer boot and GPU memory.',
  generationMs, packingMs, packingAndVerificationMs,
  totalGenerationAndPackingMs: generationMs + packingMs,
  frameBufferBytes: entries.reduce((sum, { cv }) => sum + cv.data.byteLength, 0),
  packedTextureBytes: sheets.reduce((sum, cv) => sum + cv.data.byteLength, 0),
  heapDeltaBytes: memoryAfterBuffers.heapUsed - memoryBefore.heapUsed,
  rssDeltaBytes: memoryAfterBuffers.rss - memoryBefore.rss,
  arrayBufferDeltaBytes: memoryAfterBuffers.arrayBuffers - memoryBefore.arrayBuffers,
  note: 'Timing and process memory are observational, never hardware-dependent pass/fail thresholds. The harness retains original frames as well as packed atlases for comparison; real boot need not retain both.'
};
mkdirSync('.verify', { recursive: true });
writeFileSync('.verify/art-report.json', JSON.stringify({ passed, failures, workload, assets: reports }, null, 2));
console.log(`\nGameplay sprite generation: ${generationMs.toFixed(1)}ms; atlas packing: ${packingMs.toFixed(1)}ms (${packingAndVerificationMs.toFixed(1)}ms including byte verification).`);
console.log(`Raw frames ${mib(workload.frameBufferBytes).toFixed(2)} MiB; final packed RGBA atlases ${mib(workload.packedTextureBytes).toFixed(2)} MiB.`);
console.log(`Observed process deltas: heap ${mib(workload.heapDeltaBytes).toFixed(2)} MiB, RSS ${mib(workload.rssDeltaBytes).toFixed(2)} MiB; these are diagnostic, not budgets.`);
console.log('Scope excludes Canvas-painted sky/mountains, browser startup and GPU upload; full browser boot belongs to browser acceptance.');
for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`\n=== ${passed} generated-art checks passed; ${failures.length} failed ===`);
console.log('Detailed evidence: .verify/art-report.json\n');
if (failures.length) process.exitCode = 1;
