/**
 * Objective audio measurements. Loads the built game at ?soundcheck=1 in
 * headless Chromium, renders every sound effect, the music at each Flow level
 * and the speed/surface layers with OfflineAudioContext (the exact recipes and
 * output stage the game uses), and measures them. Neither the agent that wrote
 * this nor CI can hear the result, so these numbers are the safety net:
 *
 *   per effect  silent, clipping, too long/short, too little energy above
 *               300 Hz (phone speakers), or near-identical to another effect
 *   music       30 s at each Flow level: no clipping, and levels measurably differ
 *   ride        80/100/120% speed are clearly different; powder and ice differ
 *
 * Usage: node scripts/measureAudio.mjs [--url=http://127.0.0.1:4173] [--out=DIR]
 * Without --url it serves ./dist itself. Writes a markdown table and WAV files to --out.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = resolve(arg('out') ?? '.verify/audio');
mkdirSync(join(outDir, 'wav'), { recursive: true });
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require('playwright');
const SR = 44100;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function serve() {
  const root = resolve('dist');
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    let file = join(root, url === '/' ? 'index.html' : decodeURIComponent(url));
    if (!existsSync(file) || file.endsWith('/')) file = join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// ---- analysis -------------------------------------------------------------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
const FRAME = 2048;
const hann = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)));
/** Power spectrum of one frame starting at `start` (zero padded). */
function frameSpectrum(x, start) {
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) re[i] = (x[start + i] ?? 0) * hann[i];
  fft(re, im);
  const p = new Float64Array(FRAME / 2);
  for (let i = 0; i < FRAME / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}
const BANDS = Array.from({ length: 17 }, (_, i) => 100 * Math.pow(12000 / 100, i / 16));
const binHz = SR / FRAME;

function analyse(x, { fingerprint = true } = {}) {
  let peak = 0, sum = 0, first = -1, last = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    sum += x[i] * x[i];
    if (a > 0.01) { if (first < 0) first = i; last = i; }
  }
  const active = first < 0 ? 0 : last - first + 1;
  const duration = active / SR;
  let activeSum = 0;
  for (let i = Math.max(0, first); i <= last; i++) activeSum += x[i] * x[i];
  const rms = active ? Math.sqrt(activeSum / active) : 0;
  // Whole-signal spectrum: Welch-style average over frames.
  const total = new Float64Array(FRAME / 2);
  let frames = 0;
  const hop = FRAME / 2;
  const from = Math.max(0, first - hop), to = Math.max(from + 1, last);
  const stride = active > SR * 5 ? hop * 8 : hop; // music is long: sample every 8th frame
  for (let s = from; s < to; s += stride) { const p = frameSpectrum(x, s); for (let i = 0; i < p.length; i++) total[i] += p[i]; frames++; }
  let all = 0, above = 0, weighted = 0, above4k = 0;
  for (let i = 1; i < total.length; i++) {
    const f = i * binHz;
    all += total[i]; weighted += total[i] * f;
    if (f >= 300) above += total[i];
    if (f >= 4000) above4k += total[i];
  }
  const out = { peak, rms, duration, firstS: first / SR, above300: all ? above / all : 0, above4k: all ? above4k / all : 0, centroid: all ? weighted / all : 0, frames };
  if (fingerprint) {
    // 10 time slices over the audible part x 16 log bands, log energy, mean removed.
    const slices = 10;
    const fp = [];
    const len = Math.max(FRAME, active);
    for (let k = 0; k < slices; k++) {
      const start = Math.max(0, first) + Math.floor(k * len / slices);
      const acc = new Float64Array(16);
      const span = Math.max(1, Math.floor(len / slices / hop));
      for (let m = 0; m < span; m++) {
        const p = frameSpectrum(x, start + m * hop);
        for (let b = 0; b < 16; b++) {
          for (let i = Math.ceil(BANDS[b] / binHz); i < Math.min(p.length, BANDS[b + 1] / binHz); i++) acc[b] += p[i];
        }
      }
      for (let b = 0; b < 16; b++) fp.push(Math.log10(1e-9 + acc[b] / span));
    }
    const mean = fp.reduce((a, v) => a + v, 0) / fp.length;
    out.fp = fp.map(v => v - mean);
  }
  return out;
}
const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(na * nb);
};
function wav(x) {
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return buf;
}
const db = v => v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf';

// ---- run ------------------------------------------------------------------
let hosted = null;
const baseUrl = arg('url') ?? (hosted = await serve()).url;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const failures = [];
const fail = message => { failures.push(message); console.log(`FAIL ${message}`); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${baseUrl}/?soundcheck=1`);
  await page.waitForFunction(() => window.__audioLab, null, { timeout: 30000 });
  const decode = b64 => new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0));
  const render = async (fn, arg) => decode(await page.evaluate(async ([name, a]) => {
    const lab = window.__audioLab;
    const data = name === 'sound' ? await lab.renderSound(a.kind, a.options) : name === 'music' ? await lab.renderMusic(a.level, a.seconds) : await lab.renderRide(a.state, a.seconds);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, [fn, arg]));
  const info = await page.evaluate(() => window.__audioLab.SOUND_KINDS.map(k => ({ kind: k, label: window.__audioLab.SOUNDS[k].label, maxS: window.__audioLab.SOUNDS[k].maxS })));

  const rows = [];
  for (const { kind, label, maxS } of info) {
    const x = await render('sound', { kind, options: { step: 4 } });
    writeFileSync(join(outDir, 'wav', `sfx-${kind}.wav`), wav(x));
    const m = analyse(x);
    rows.push({ kind, label, maxS, ...m });
  }
  const MIN_ABOVE_300 = 0.3;
  for (const r of rows) {
    if (r.peak < 0.05) fail(`${r.kind} is silent or nearly (peak ${r.peak.toFixed(3)})`);
    if (r.peak > 0.985) fail(`${r.kind} clips (peak ${r.peak.toFixed(3)})`);
    if (r.duration > r.maxS) fail(`${r.kind} lasts ${r.duration.toFixed(2)}s, over its ${r.maxS}s limit`);
    if (r.duration < 0.04) fail(`${r.kind} is shorter than 40 ms`);
    if (r.above300 < MIN_ABOVE_300) fail(`${r.kind} has only ${(r.above300 * 100).toFixed(0)}% of its energy above 300 Hz (need ${MIN_ABOVE_300 * 100}%)`);
  }
  // Near-identical: similar time-frequency shape AND similar length and level.
  const pairs = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const sim = cosine(rows[i].fp, rows[j].fp);
    pairs.push({ a: rows[i].kind, b: rows[j].kind, sim });
    const lengthRatio = Math.max(rows[i].duration, rows[j].duration) / Math.max(0.01, Math.min(rows[i].duration, rows[j].duration));
    if (sim > 0.93 && lengthRatio < 1.5) fail(`${rows[i].kind} and ${rows[j].kind} are near-identical (shape similarity ${sim.toFixed(3)}, length ratio ${lengthRatio.toFixed(2)})`);
  }
  pairs.sort((p, q) => q.sim - p.sim);

  const music = [];
  for (let level = 0; level < 4; level++) {
    const x = await render('music', { level, seconds: 30 });
    writeFileSync(join(outDir, 'wav', `music-flow${level}.wav`), wav(x.subarray(0, SR * 30)));
    music.push({ level, ...analyse(x) });
  }
  music.forEach(m => {
    if (m.peak > 0.985) fail(`music flow ${m.level} clips (peak ${m.peak.toFixed(3)})`);
    if (m.peak < 0.05) fail(`music flow ${m.level} is silent`);
    if (m.above300 < MIN_ABOVE_300) fail(`music flow ${m.level} has only ${(m.above300 * 100).toFixed(0)}% above 300 Hz`);
  });
  for (let i = 1; i < music.length; i++) {
    const sim = cosine(music[i - 1].fp, music[i].fp);
    const rmsChange = Math.abs(music[i].rms / music[i - 1].rms - 1);
    const centroidChange = Math.abs(music[i].centroid / music[i - 1].centroid - 1);
    music[i].vsPrev = { sim, rmsChange, centroidChange };
    if (!(rmsChange > 0.03 || centroidChange > 0.05) || sim > 0.995) fail(`music flow ${i} does not differ measurably from flow ${i - 1} (sim ${sim.toFixed(3)}, rms ${(rmsChange * 100).toFixed(1)}%, centroid ${(centroidChange * 100).toFixed(1)}%)`);
  }

  const ride = {};
  for (const [name, state] of [
    ['80% snow', { speed01: 0.8, airborne: false, carving: true, boosting: false }],
    ['100% snow', { speed01: 1, airborne: false, carving: true, boosting: false }],
    ['120% snow', { speed01: 1.2, airborne: false, carving: true, boosting: true }],
    ['100% powder', { speed01: 1, airborne: false, carving: true, boosting: false, surface: 'powder' }],
    ['100% ice', { speed01: 1, airborne: false, carving: true, boosting: false, surface: 'ice' }],
    ['100% ice, straight', { speed01: 1, airborne: false, carving: false, boosting: false, surface: 'ice' }]
  ]) {
    const x = await render('ride', { state, seconds: 2 });
    writeFileSync(join(outDir, 'wav', `ride-${name.replace(/[ ,%]+/g, '_')}.wav`), wav(x));
    ride[name] = analyse(x.subarray(Math.floor(SR * 0.2)), { fingerprint: false });
  }
  const step = (a, b) => ride[b].rms / ride[a].rms;
  if (step('80% snow', '100% snow') < 1.35) fail(`ride 80% -> 100% only ${db(step('80% snow', '100% snow'))} dB apart (need >= 2.6 dB)`);
  if (step('100% snow', '120% snow') < 1.35) fail(`ride 100% -> 120% only ${db(step('100% snow', '120% snow'))} dB apart (need >= 2.6 dB)`);
  if (!(ride['120% snow'].centroid > ride['100% snow'].centroid && ride['100% snow'].centroid > ride['80% snow'].centroid)) fail('ride brightness does not rise with speed');
  if (!(ride['100% powder'].rms < ride['100% snow'].rms * 0.8)) fail('powder does not damp the ride sound');
  if (!(ride['100% ice'].above4k > ride['100% snow'].above4k * 1.3)) fail('ice does not add a scraping edge (energy above 4 kHz)');
  if (!(ride['100% ice'].rms > ride['100% ice, straight'].rms)) fail('carving on ice is not louder than riding straight');
  if (errors.length) fail(`page errors: ${errors.join('; ')}`);

  // ---- report -------------------------------------------------------------
  const lines = [];
  lines.push('| sound | length s (max) | peak dBFS | RMS dBFS | >300 Hz | centroid Hz |', '|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.kind} | ${r.duration.toFixed(2)} (${r.maxS}) | ${db(r.peak)} | ${db(r.rms)} | ${(r.above300 * 100).toFixed(0)}% | ${Math.round(r.centroid)} |`);
  lines.push('', '| music (30 s) | peak dBFS | RMS dBFS | >300 Hz | centroid Hz | similarity to previous | RMS change | centroid change |', '|---|---|---|---|---|---|---|---|');
  for (const m of music) lines.push(`| flow ${m.level} | ${db(m.peak)} | ${db(m.rms)} | ${(m.above300 * 100).toFixed(0)}% | ${Math.round(m.centroid)} | ${m.vsPrev ? m.vsPrev.sim.toFixed(3) : '-'} | ${m.vsPrev ? (m.vsPrev.rmsChange * 100).toFixed(0) + '%' : '-'} | ${m.vsPrev ? (m.vsPrev.centroidChange * 100).toFixed(0) + '%' : '-'} |`);
  lines.push('', '| ride layer (steady) | RMS dBFS | centroid Hz | >300 Hz | >4 kHz |', '|---|---|---|---|---|');
  for (const [name, m] of Object.entries(ride)) lines.push(`| ${name} | ${db(m.rms)} | ${Math.round(m.centroid)} | ${(m.above300 * 100).toFixed(0)}% | ${(m.above4k * 100).toFixed(0)}% |`);
  lines.push('', 'Most similar effect pairs (1.0 = identical shape):', ...pairs.slice(0, 8).map(p => `- ${p.a} / ${p.b}: ${p.sim.toFixed(3)}`));
  const report = lines.join('\n');
  writeFileSync(join(outDir, 'audio-measurements.md'), report + '\n');
  console.log(report);
} finally {
  await browser.close();
  hosted?.server.close();
}
if (failures.length) { console.log(`\n${failures.length} audio check(s) failed`); process.exit(1); }
console.log('\nPASS audio measurements: every effect audible, unclipped, within length, with phone-speaker energy, and distinct; music levels differ; ride layers follow speed and surface');
