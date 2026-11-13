import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePnpmCli } from './new-service.ts';

test('resolvePnpmCli accepts the pnpm entry points npm_execpath can point at', () => {
  for (const cli of [
    '/home/u/.local/share/pnpm/store/v11/links/pnpm/bin/pnpm.cjs',
    '/Users/u/Library/pnpm/pnpm',
    'C:\\Users\\u\\AppData\\Local\\pnpm\\pnpm.exe',
    '/usr/lib/node_modules/pnpm/bin/pnpm.js',
    '/opt/corepack/pnpm.mjs',
  ]) {
    assert.deepEqual(resolvePnpmCli(cli), { cli }, `expected ${cli} to be accepted`);
  }
});

test('resolvePnpmCli rejects an unset npm_execpath without side effects', () => {
  const r = resolvePnpmCli(undefined);
  assert.ok('error' in r);
  assert.match(r.error, /npm_execpath is unset/);
  assert.match(r.error, /pnpm new-service <name>/);
});

test('resolvePnpmCli rejects an empty npm_execpath', () => {
  assert.ok('error' in resolvePnpmCli(''));
});

test('resolvePnpmCli refuses npm and yarn rather than silently using them', () => {
  for (const [cli, name] of [
    ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'npm-cli.js'],
    ['/usr/lib/node_modules/yarn/bin/yarn.js', 'yarn.js'],
    ['/usr/lib/node_modules/corepack/dist/npx.js', 'npx.js'],
    ['/tmp/evil/pnpm-not-really.js', 'pnpm-not-really.js'],
  ]) {
    const r = resolvePnpmCli(cli);
    assert.ok('error' in r, `expected ${cli} to be rejected`);
    assert.match(r.error, /pnpm-only/);
    assert.ok(r.error.includes(name), `error should name the offending CLI ${name}`);
    assert.ok(r.error.includes(cli), 'error should include the full path');
  }
});

test('resolvePnpmCli does not match pnpm as a path substring', () => {
  // A directory called pnpm must not make an arbitrary entry point pass.
  assert.ok('error' in resolvePnpmCli('/home/u/pnpm/bin/npm-cli.js'));
  assert.ok('error' in resolvePnpmCli('/pnpm'.repeat(3) + '/yarn.js'));
});
