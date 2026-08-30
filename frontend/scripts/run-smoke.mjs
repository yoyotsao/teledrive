/**
 * Runs the smoke suite against the live site.
 *
 * All this wrapper does is set TELEDRIVE_SMOKE=1 before handing off to
 * Playwright — playwright.config.ts reads it to skip starting a vite dev
 * server the smoke suite would never talk to. A shell one-liner would do it on
 * Linux, but the primary environment here is PowerShell, where `VAR=x cmd`
 * is not a thing.
 *
 * Extra arguments are passed straight through:
 *   npm run test:e2e:smoke -- --headed -g "folder survives"
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const playwrightCli = fileURLToPath(
  new URL('../node_modules/@playwright/test/cli.js', import.meta.url),
);

const child = spawn(
  process.execPath,
  [playwrightCli, 'test', '--project=smoke', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, TELEDRIVE_SMOKE: '1' },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
