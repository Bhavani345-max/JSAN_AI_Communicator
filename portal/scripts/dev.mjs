#!/usr/bin/env node
/**
 * Run the portal's two development processes as one foreground command.
 *
 * The backend serves the API on 8080; the frontend serves the UI on 5173 and
 * proxies /api and /v1 back to the backend (see frontend/vite.config.ts). Both
 * have to be running for the UI to do anything, so this starts the pair,
 * labels their output, and makes one Ctrl+C stop both.
 *
 * It shells out to the same `dev:backend` / `dev:frontend` scripts rather than
 * calling `node src/server.js` and `vite` directly, so the sub-packages stay
 * the single source of truth for how each one starts. Changing the frontend's
 * dev script does not also require changing this file.
 *
 * Written by hand rather than with `concurrently` to keep the portal root at
 * zero dependencies - it exists to aggregate scripts, and its lockfile has no
 * packages in it. That is worth more here than the features a runner adds.
 *
 * Known limitation: the children's stdin is not connected, because two
 * processes cannot sensibly share one terminal's input. Vite's interactive
 * shortcuts (`r` to restart, `h` for help) are therefore unavailable under
 * this script. Run `npm run dev:frontend` on its own when you want them.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Windows resolves `npm` to npm.cmd, and since CVE-2024-27980 Node refuses to
// spawn a .cmd without a shell - it throws EINVAL rather than running it. So
// the shell is required there, which is also why stopping a child needs
// taskkill below: with a shell in between, the signal would reach cmd.exe and
// leave the actual server running.
const WINDOWS = process.platform === 'win32';
const NPM = WINDOWS ? 'npm.cmd' : 'npm';

const TARGETS = [
  { name: 'backend', script: 'dev:backend', color: '\x1b[36m' },
  { name: 'frontend', script: 'dev:frontend', color: '\x1b[35m' }
];

const STDIO = ['ignore', 'pipe', 'pipe'];
// Piping makes both children see a non-TTY stdout and drop their colours.
// Vite and npm both honour FORCE_COLOR, so the output stays readable.
const ENV = { ...process.env, FORCE_COLOR: '1' };

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const width = Math.max(...TARGETS.map((t) => t.name.length));

/**
 * Fail before spawning anything if the dependencies are not installed.
 *
 * dev:backend and dev:frontend deliberately skip `npm install` so a restart
 * stays instant, which means on a fresh clone they fail with a bare "vite is
 * not recognized" from inside a child process - two layers down, and not
 * obviously about installing. Checking here turns that into one sentence
 * naming the command to run.
 */
const missing = TARGETS
  .map((t) => t.name)
  .filter((name) => !fs.existsSync(path.join(ROOT, name, 'node_modules')));

if (missing.length) {
  console.error(`\nDependencies are not installed for: ${missing.join(', ')}`);
  console.error('The dev scripts do not install for you. Run this once, then retry:\n');
  console.error('  npm run check:backend && npm run check:frontend\n');
  process.exit(1);
}

let shuttingDown = false;
const children = [];

function label(target, line) {
  return `${target.color}[${target.name.padEnd(width)}]${RESET} ${line}`;
}

/**
 * Print a child's output one whole line at a time.
 *
 * A pipe hands over arbitrary chunks, not lines, so a chunk boundary can land
 * mid-line - writing chunks straight through would put a prefix in the middle
 * of a sentence. The trailing partial line is held back until the rest of it
 * arrives, and flushed at end-of-stream so a final line without a newline is
 * not swallowed.
 */
function pipeLines(target, stream, out) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) out.write(`${label(target, line)}\n`);
  });
  stream.on('end', () => {
    if (pending) out.write(`${label(target, pending)}\n`);
  });
}

function start(target) {
  // Windows takes the whole command as one string with no args array. An args
  // array alongside shell:true raises DEP0190 on every start, because a shell
  // concatenates arguments instead of escaping them - harmless for the fixed
  // literals here, but it would print a security warning each time. POSIX
  // needs no shell at all, which also keeps the child directly killable.
  const child = WINDOWS
    ? spawn(`${NPM} run ${target.script}`, { cwd: ROOT, shell: true, stdio: STDIO, env: ENV })
    : spawn(NPM, ['run', target.script], { cwd: ROOT, stdio: STDIO, env: ENV });

  pipeLines(target, child.stdout, process.stdout);
  pipeLines(target, child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    // One process alone is not a working portal: the UI without the API serves
    // a page whose every request 502s, and the API without the UI is a blank
    // tab. So the first exit takes the other down rather than leaving a half
    // stack running and looking healthy.
    if (shuttingDown) return;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`\n${DIM}${target.name} exited (${why}) - stopping the other${RESET}\n`);
    stopAll();
    process.exitCode = code ?? 1;
  });

  child.on('error', (e) => {
    console.error(label(target, `could not start: ${e.message}`));
    stopAll();
    process.exitCode = 1;
  });

  children.push({ target, child });
}

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (WINDOWS) {
      // /t includes the process tree. Without it only the cmd.exe wrapper dies
      // and node/vite keep holding 8080 and 5173, so the next `npm run dev`
      // fails on a port already in use.
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${DIM}Stopping both processes...${RESET}`);
    stopAll();
  });
}

console.log(`${DIM}Starting backend (8080) and frontend (5173). Ctrl+C stops both.${RESET}\n`);
TARGETS.forEach(start);
