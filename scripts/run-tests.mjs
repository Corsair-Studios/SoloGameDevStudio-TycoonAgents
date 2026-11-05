// Cross-platform, cross-Node-version test runner entrypoint.
//
// `node --test "out/test/**/*.test.js"` relies on shell glob expansion,
// which Node 20/22 CLIs don't do themselves (glob support in the test
// runner's own file resolution arrived later). This script walks
// out/test itself, collects every *.test.js file, and passes the
// explicit file list to `node --test`, so behavior is identical on
// Node 20, 22, and 24 and on any shell (bash, PowerShell, cmd).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'out', 'test');

function collect(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collect(full));
    } else if (entry.endsWith('.test.js')) {
      files.push(full);
    }
  }
  return files;
}

// Windows rejects command lines over 32767 characters (spawnSync ENAMETOOLONG),
// and CI checkouts have long absolute paths. Keep each `node --test` spawn's
// file list under this many characters (well below the limit, leaving room
// for the executable path, flags and extraArgs).
export const COMMAND_LINE_BUDGET = 8000;

// Split files into consecutive batches whose joined length (each file plus a
// separating space) stays within budget. A single oversized file still gets
// its own batch. Order is preserved and every file appears exactly once.
export function batchFiles(files, budget = COMMAND_LINE_BUDGET) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 1;
    if (current.length > 0 && length + cost > budget) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function main() {
const files = collect(testDir).sort();

if (files.length === 0) {
  console.error(`No *.test.js files found under ${testDir}`);
  process.exit(1);
}

// A hung test (leaked timer/handle, an awaited promise that never settles,
// a real network call) used to make `node --test` sit forever, which is why
// builds could take hours. --test-timeout bounds any single test to 60s
// before Node fails it, and --test-force-exit makes the process exit right
// after the run completes even if something left a handle open, instead of
// hanging on exit. Callers can still override either by passing their own
// --test-timeout/--test-force-exit in extraArgs (the ones passed here run
// first, and Node's test runner takes the LAST occurrence of a flag).
const DEFAULT_TEST_TIMEOUT_MS = 60_000;

const extraArgs = process.argv.slice(2);
const hasTimeoutFlag = extraArgs.some((a) => a.startsWith('--test-timeout'));
const hasForceExitFlag = extraArgs.some((a) => a.startsWith('--test-force-exit') || a.startsWith('--no-test-force-exit'));

const hardeningArgs = [
  ...(hasTimeoutFlag ? [] : [`--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`]),
  ...(hasForceExitFlag ? [] : ['--test-force-exit']),
];

// Claude Code local-scope MCP registration edits the user's Claude config file.
// No test may ever touch the real ~/.claude.json: point it at a throwaway
// directory and skip the real `claude` binary for every test process.
const claudeSandbox = mkdtempSync(path.join(os.tmpdir(), 'tycoon-test-claude-'));

const extraLength = extraArgs.join(' ').length + hardeningArgs.join(' ').length;
const batches = batchFiles(files, Math.max(1000, COMMAND_LINE_BUDGET - extraLength));
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeSandbox, TYCOON_CLAUDE_BIN: 'none', USERPROFILE: path.join(claudeSandbox, 'home'), HOME: path.join(claudeSandbox, 'home'), TYCOON_TEST_HOME_SANDBOX: '1', TYCOON_MCP_VERIFY_DELAY_MS: '0' };

let failedStatus = 0;
let launchError = null;
let signal = null;
for (let i = 0; i < batches.length; i++) {
  if (batches.length > 1) {
    console.error(`
=== test batch ${i + 1}/${batches.length} (${batches[i].length} files) ===`);
  }
  const result = spawnSync(process.execPath, ['--test', ...hardeningArgs, ...extraArgs, ...batches[i]], { stdio: 'inherit', env });
  if (result.error) { launchError = result.error; break; }
  if (result.signal) { signal = result.signal; break; }
  if (result.status !== 0 && failedStatus === 0) failedStatus = result.status ?? 1;
}
try { rmSync(claudeSandbox, { recursive: true, force: true }); } catch { /* best effort */ }

if (launchError) {
  console.error(`Failed to launch the test runner: ${launchError.message}`);
  process.exit(1);
}
if (signal) {
  console.error(`Test run was terminated by signal ${signal}.`);
  process.exit(1);
}
if (failedStatus !== 0) {
  console.error(
    `Test run failed (exit code ${failedStatus}). If a specific file's name is ` +
      `followed by a timeout duration above (e.g. "test timed out after 60000ms"), ` +
      "that file is hanging — fix the leak (open handle/timer/unsettled promise) " +
      'before re-running, or narrow the run to it with `npm run test:fast -- <pattern>`.',
  );
}

process.exit(failedStatus);
}

// Run only when executed directly; tests import batchFiles without side effects.
function isRunDirectly() {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const self = fileURLToPath(import.meta.url);
  try {
    return norm(realpathSync(process.argv[1])) === norm(realpathSync(self));
  } catch {
    return norm(path.resolve(process.argv[1])) === norm(self);
  }
}
const isMainModule = isRunDirectly();
if (isMainModule) {
  main();
}
