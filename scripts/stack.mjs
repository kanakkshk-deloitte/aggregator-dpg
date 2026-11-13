#!/usr/bin/env node
// scripts/stack.mjs
//
// Cross-platform host-side orchestrator for the aggregator-dpg local stack.
// Single source of truth for setup/up/down/reset/logs/ps/psql/rebuild-web —
// replaces the POSIX-only Makefile recipe bodies. Uses only node: builtins.
// Belongs to the aggregator-dpg local-dev tooling (host-side, not shipped code).

import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (parent of scripts/). */
export const repoRoot = join(__dirname, '..');

/**
 * Root-owned system directories searched for a child-process executable,
 * most trusted first. Deliberately excludes `/usr/local/bin` and
 * `/opt/homebrew/bin`: Homebrew chowns those to the invoking user on macOS,
 * so they are exactly the user-writable directories S4036 warns about and
 * would defeat the point of resolving here rather than through `PATH`.
 */
const DEFAULT_SYSTEM_ROOT = String.raw`C:\Windows`;

const SYSTEM_BIN_DIRS =
  process.platform === 'win32'
    ? [
        join(process.env.SystemRoot ?? DEFAULT_SYSTEM_ROOT, 'System32'),
        process.env.SystemRoot ?? DEFAULT_SYSTEM_ROOT,
      ]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Resolves an executable name to an absolute path under SYSTEM_BIN_DIRS.
 *
 * Best-effort hardening, not a guarantee: `sudo` and `tee` live in `/usr/bin`
 * on every supported platform and are always resolved, but `docker` and
 * `pnpm` commonly install outside these prefixes (Docker Desktop ships in
 * `/Applications` on macOS), and for those this returns the bare name and the
 * lookup still goes through `PATH` — the same behaviour as before. This is a
 * host-side dev script, so keeping those working matters more than refusing
 * to run; treat the fallback as unhardened.
 *
 * @param {string} name - Bare executable name (e.g. `docker`).
 * @returns {string} The absolute path when found under a root-owned system
 *   directory, otherwise the bare name (resolved via PATH by the caller).
 */
export function resolveExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of SYSTEM_BIN_DIRS) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/** Host entries the browser + containers must resolve to the local machine. */
export const HOST_ENTRIES = [
  ['127.0.0.1', 'keycloak'],
  ['127.0.0.1', 'minio'],
];

/** Subcommands the orchestrator accepts. */
export const COMMANDS = [
  'setup',
  'up',
  'dev',
  'down',
  'reset',
  'logs',
  'ps',
  'psql',
  'rebuild-web',
];

/** Thrown when argv contains no command or an unknown one. */
export class UsageError extends Error {
  /** @param {string | undefined} cmd - The offending command token. */
  constructor(cmd) {
    super(cmd ? `Unknown command: ${cmd}` : 'No command given');
    this.name = 'UsageError';
  }
}

export const USAGE = `Usage: node scripts/stack.mjs <${COMMANDS.join('|')}>`;

/**
 * Returns the OS-correct path to the hosts file.
 *
 * @param {NodeJS.Platform} platform - process.platform value.
 * @returns The hosts-file path for that platform.
 */
export function hostsFilePath(platform) {
  return platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}

/**
 * Whether `.env` should be chmod-ed to 600.
 *
 * @param {NodeJS.Platform} platform - process.platform value.
 * @returns true on Unix, false on Windows (NTFS perms differ).
 */
export function shouldChmod(platform) {
  return platform !== 'win32';
}

/**
 * Decides which source file (if any) to copy into `.env`.
 *
 * @param {{ envExists: boolean, localExists: boolean, templateExists: boolean }} state
 * @returns 'skip' | 'env.local' | 'env.template' | 'none'.
 */
export function chooseEnvSource({ envExists, localExists, templateExists }) {
  if (envExists) return 'skip';
  if (localExists) return 'env.local';
  if (templateExists) return 'env.template';
  return 'none';
}

/**
 * Returns the HOST_ENTRIES not already present in the given hosts-file content.
 *
 * @param {string} content - Raw hosts-file text.
 * @param {Array<[string, string]>} entries - Entries to check (defaults to HOST_ENTRIES).
 * @returns The [ip, host] pairs that are missing.
 */
export function missingHostEntries(content, entries = HOST_ENTRIES) {
  return entries.filter(([ip, host]) => {
    const escapedIp = ip.replaceAll('.', '\\.');
    const re = new RegExp(`^\\s*${escapedIp}\\s+${host}(\\s|$)`, 'm');
    return !re.test(content);
  });
}

/**
 * Builds the manual-edit instructions printed on Windows when hosts entries are missing.
 *
 * @param {Array<[string, string]>} missing - Missing [ip, host] pairs.
 * @param {NodeJS.Platform} platform - process.platform value (defaults to 'win32').
 * @returns Multi-line instruction text.
 */
export function windowsHostsInstructions(missing, platform = 'win32') {
  const lines = missing.map(([ip, host]) => `${ip} ${host}`).join('\n');
  return [
    `Add these lines to ${hostsFilePath(platform)} (open Notepad as Administrator):`,
    '',
    lines,
    '',
    'Required so the browser and containers resolve the OIDC issuer to the same host.',
  ].join('\n');
}

/**
 * Extracts and validates the subcommand from process.argv.
 *
 * @param {string[]} argv - Full argv array (argv[2] is the command).
 * @returns The validated command string.
 * @throws {UsageError} If the command is missing or unrecognized.
 */
export function parseCommand(argv) {
  const cmd = argv[2];
  if (!cmd || !COMMANDS.includes(cmd)) {
    throw new UsageError(cmd);
  }
  return cmd;
}

// ---- impure operations ----

/**
 * Runs a child process inheriting stdio; throws on failure.
 *
 * @param {string} cmd - Executable name.
 * @param {string[]} args - Arguments.
 * @param {object} [opts] - Extra spawnSync options (merged over defaults).
 * @throws {Error} If the process cannot start or exits non-zero.
 */
function run(cmd, args, opts = {}) {
  const res = spawnSync(resolveExecutable(cmd), args, { stdio: 'inherit', cwd: repoRoot, ...opts });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
  }
  return res;
}

/** @returns true if the Docker daemon is reachable. */
function dockerRunning() {
  const res = spawnSync(resolveExecutable('docker'), ['info'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

/** Exits with an actionable message if Docker is not running. */
function ensureDocker() {
  if (!dockerRunning()) {
    console.error(
      'Docker daemon not reachable. Start Docker Desktop (Windows/Mac) or the docker service (Linux), then retry.',
    );
    process.exit(1);
  }
}

const envFile = join(repoRoot, '.env');

/** Bootstraps .env, file perms, and hosts entries. Idempotent. */
function setup() {
  const platform = process.platform;

  // 1. Resolve .env
  const choice = chooseEnvSource({
    envExists: existsSync(envFile),
    localExists: existsSync(join(repoRoot, 'infra/env.local')),
    templateExists: existsSync(join(repoRoot, 'infra/env.template')),
  });
  if (choice === 'skip') {
    console.log('.env already exists — leaving untouched.');
  } else if (choice === 'env.local') {
    copyFileSync(join(repoRoot, 'infra/env.local'), envFile);
    console.log('Created .env from infra/env.local. Ready to run: pnpm stack:up');
  } else if (choice === 'env.template') {
    copyFileSync(join(repoRoot, 'infra/env.template'), envFile);
    console.log('Created .env from infra/env.template.');
    console.log('Fill change-me-* placeholders. Generate a secret with:');
    console.log(
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
    );
  } else {
    console.error('No infra/env.local or infra/env.template found — cannot create .env.');
    process.exit(1);
  }

  // 2. Permissions (Unix only)
  if (shouldChmod(platform) && existsSync(envFile)) {
    chmodSync(envFile, 0o600);
  }

  // 3. Hosts entries
  const hostsPath = hostsFilePath(platform);
  let content = '';
  try {
    content = readFileSync(hostsPath, 'utf8');
  } catch {
    content = ''; // unreadable hosts file → treat as empty, all entries "missing"
  }
  const missing = missingHostEntries(content);
  if (missing.length === 0) {
    console.log(`${hostsPath} already maps keycloak + minio — skipping.`);
  } else if (platform === 'win32') {
    console.log('');
    console.log(windowsHostsInstructions(missing, platform));
    console.log('');
  } else {
    console.log(`Adding host entries to ${hostsPath} (sudo required)...`);
    // Lead with a newline when the file does not already end in one. macOS ships
    // /etc/hosts with no trailing newline, so a bare `tee -a` concatenates the
    // first entry onto the final `::1 localhost` line — which both breaks IPv6
    // localhost resolution and defeats missingHostEntries() (its `^\s*<ip>`
    // anchor can no longer match), so every later run appends a duplicate.
    const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
    const lines =
      (needsLeadingNewline ? '\n' : '') +
      missing.map(([ip, host]) => `${ip} ${host}`).join('\n') +
      '\n';
    const res = spawnSync(resolveExecutable('sudo'), [resolveExecutable('tee'), '-a', hostsPath], {
      input: lines,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    if (res.error || res.status !== 0) {
      console.warn('Could not edit the hosts file automatically. Add these lines manually:');
      console.warn(lines);
    }
  }

  // 4. Final hint
  console.log('');
  console.log('Setup complete. Run: pnpm stack:up   (or: make up)');
}

/**
 * Compose args for the LOCAL DEV stack: base file + the dev overlay
 * (docker-compose.dev.yml), plus the `storage` profile so local MinIO starts.
 * The overlay relaxes TLS verification and binds backing-service ports to
 * 127.0.0.1. A VM/prod deploy runs a bare `docker compose up -d` (base file
 * only) and gets NONE of this — see docker-compose.dev.yml.
 */
const composeArgs = (...rest) => [
  'compose',
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.dev.yml',
  '--profile',
  'storage',
  ...rest,
];

/** Brings the full local dev stack up after a Docker preflight + .env check. */
function up() {
  ensureDocker();
  if (!existsSync(envFile)) {
    console.error('No .env found — run: pnpm stack:setup');
    process.exit(1);
  }
  run('docker', composeArgs('up', '-d', '--build'));
}

const down = () => run('docker', composeArgs('down'));
const reset = () => run('docker', composeArgs('down', '-v'));
const logs = () => run('docker', composeArgs('logs', '-f'));
const ps = () => run('docker', composeArgs('ps'));
const psql = () =>
  run('docker', composeArgs('exec', 'postgres', 'psql', '-U', 'aggregator', '-d', 'aggregator'));

/**
 * Rebuilds the web image and restarts it — for web CODE changes.
 *
 * Not needed for an env change: the image takes no `NEXT_PUBLIC_*` build args,
 * so every setting is read at runtime and `up -d web` alone applies it.
 */
function rebuildWeb() {
  run('pnpm', ['--filter', '@aggregator-dpg/web', 'build']);
  run('docker', composeArgs('build', 'web'));
  run('docker', composeArgs('up', '-d', 'web'));
}

const HANDLERS = {
  setup,
  up,
  dev: up, // `dev` is an alias for `up`
  down,
  reset,
  logs,
  ps,
  psql,
  'rebuild-web': rebuildWeb,
};

/** Parses argv and runs the matching handler. */
function main() {
  let cmd;
  try {
    cmd = parseCommand(process.argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error(USAGE);
      process.exit(2);
    }
    throw err;
  }
  try {
    HANDLERS[cmd]();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// Only run when invoked directly (`node scripts/stack.mjs ...`), not when
// imported by the test module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
