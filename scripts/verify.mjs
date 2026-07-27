/**
 * The gate. Runs every check in sequence and fails loudly on the first break:
 *
 *   1. `tsc` type-check + `vite build`   — the code compiles
 *   2. `verifySolvability`               — every generated course is still beatable
 *   3. `smokeTest`                       — the game boots, renders, no console errors
 *
 * Step 2 is the important one during the v2 visual overhaul: the epic promises
 * that rendering work does not touch generation/collision logic, and this is
 * what turns that promise into something enforced rather than asserted.
 *
 * Usage: npm run verify
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))));
    p.on('error', rej);
  });

const step = async (label, fn) => {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
  await fn();
  console.log(`\x1b[32m✔ ${label}\x1b[0m`);
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.map': 'application/json'
};

/** Serves `dist/` so the smoke test runs against the real production build. */
function serveDist(root, port) {
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    let file = join(root, url === '/' ? 'index.html' : decodeURIComponent(url));
    if (!existsSync(file) || file.endsWith('/')) file = join(root, 'index.html');
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

try {
  await step('build (tsc + vite)', () => run('npm', ['run', 'build']));
  await step('course solvability', () => run('npm', ['run', 'verify:solvability']));

  const PORT = 4173;
  const server = await serveDist(resolve('dist'), PORT);
  try {
    await step('visual smoke test', () =>
      run('node', ['scripts/smokeTest.mjs', `--url=http://localhost:${PORT}`])
    );
  } finally {
    server.close();
  }

  console.log('\n\x1b[32m=== ALL GATES PASSED ===\x1b[0m\n');
} catch (err) {
  console.error(`\n\x1b[31m=== GATE FAILED ===\x1b[0m\n${err.message}\n`);
  process.exit(1);
}
