#!/usr/bin/env node
/**
 * One command for the whole test suite.
 *
 *   node scripts/run-tests.mjs            # the three isolated layers
 *   node scripts/run-tests.mjs --smoke    # …and the live-site smoke suite
 *   node scripts/run-tests.mjs --only=backend
 *
 * The default run is deliberately the set that is safe to run on every change:
 * no Telegram account, no network, nothing left behind in a real drive. The
 * smoke layer talks to the live site and needs an interactive login the first
 * time, so it is opt-in — see TESTING.md.
 *
 * Every layer runs even if an earlier one fails, because "backend broke" and
 * "the UI broke" are usually different problems and finding out about both in
 * one run is worth the extra minute. The exit code is non-zero if any failed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const FRONTEND = join(ROOT, 'frontend');

const args = process.argv.slice(2);
const withSmoke = args.includes('--smoke');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const WINDOWS = process.platform === 'win32';
const NPM = WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const npmArgs = (script) => WINDOWS
  ? ['/d', '/s', '/c', `npm run ${script}`]
  : ['run', script];

const LAYERS = [
  {
    key: 'backend',
    title: 'backend · pytest',
    detail: 'API + service, temp SQLite, Telegram faked',
    cwd: BACKEND,
    command: PYTHON,
    args: ['-m', 'pytest'],
  },
  {
    key: 'unit',
    title: 'frontend · vitest',
    detail: 'pure logic in src/lib, no browser',
    cwd: FRONTEND,
    command: NPM,
    args: npmArgs('test:unit'),
  },
  {
    key: 'ui',
    title: 'frontend · playwright (isolated)',
    detail: 'real browser, in-memory backend, no network',
    cwd: FRONTEND,
    command: NPM,
    args: npmArgs('test:e2e'),
  },
  {
    key: 'smoke',
    title: 'frontend · playwright (smoke @real)',
    detail: 'the live site and a real Telegram session',
    cwd: FRONTEND,
    command: NPM,
    args: npmArgs('test:e2e:smoke'),
    optIn: true,
  },
];

function selected(layer) {
  if (only) return layer.key === only;
  return withSmoke || !layer.optIn;
}

function run(layer) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n[1m▶ ${layer.title}[0m — ${layer.detail}`);
    console.log(`  ${layer.command} ${layer.args.join(' ')}  (in ${layer.cwd})\n`);

    const child = spawn(layer.command, layer.args, {
      cwd: layer.cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => {
      resolve({ ...layer, code: code ?? 1, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function preflight() {
  const problems = [];
  if (!existsSync(join(FRONTEND, 'node_modules'))) {
    problems.push('frontend/node_modules is missing — run `npm install` in frontend/');
  }
  if (!existsSync(join(BACKEND, 'pytest.ini'))) {
    problems.push('backend/pytest.ini is missing — the backend suite will not be configured');
  }
  if (withSmoke && !existsSync(join(FRONTEND, 'tests', 'smoke', 'storageState.json'))) {
    console.log(
      '[33mnote:[0m no cached login for the smoke suite — a Chrome window will open '
      + 'and wait for you to log in.',
    );
  }
  return problems;
}

const problems = preflight();
if (problems.length) {
  for (const problem of problems) console.error(`[31merror:[0m ${problem}`);
  process.exit(1);
}

const layers = LAYERS.filter(selected);
if (layers.length === 0) {
  console.error(`[31merror:[0m --only=${only} matched no layer`);
  console.error(`available: ${LAYERS.map((l) => l.key).join(', ')}`);
  process.exit(1);
}

const results = [];
for (const layer of layers) results.push(await run(layer));

const width = Math.max(...results.map((r) => r.title.length));
console.log('\n' + '─'.repeat(width + 22));
for (const result of results) {
  const mark = result.code === 0 ? '[32mPASS[0m' : '[31mFAIL[0m';
  console.log(`${mark}  ${result.title.padEnd(width)}  ${result.seconds.toFixed(1)}s`);
}
console.log('─'.repeat(width + 22));

const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.log(`\n[31m${failed.length} of ${results.length} layers failed.[0m`);
  console.log('Playwright report: frontend/playwright-report (npm run test:e2e:report)');
  process.exit(1);
}
console.log(`\n[32mAll ${results.length} layers passed.[0m`);
if (!withSmoke && !only) {
  console.log('The live-site smoke suite was not run — add --smoke when you need it.');
}
