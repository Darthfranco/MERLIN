import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReport, inspectHosting, supportedNode } from '../scripts/hosting-doctor.mjs';

test('hosting inspector respects the repository Node minimum', () => {
  for (const version of ['22.16.0', '22.20.1', '24.0.0']) assert.equal(supportedNode(version), true);
  for (const version of ['22.15.9', '21.99.0', '20.16.0', 'invalid', '22.16.0-rc.1']) assert.equal(supportedNode(version), false);
});

test('inspection reports missing prerequisites without creating files or claiming readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'merlin-hosting-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = formatReport(await inspectHosting({ root, nodeVersion: '20.0.0', platform: 'linux', environment: { PATH: '' } }));
  assert.match(report, /\[NEEDS ATTENTION\] Node.js/);
  assert.match(report, /Assistant entry point: absent/);
  assert.match(report, /Phone-to-assistant synchronization.*not implemented/);
  assert.match(report, /No readiness verdict is issued/);
  assert.deepEqual(await readdir(root), []);
});

test('inspection never exposes config, household data, environment secrets, or executes PATH candidates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'merlin-hosting-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['src', 'node_modules/ws', 'data', 'bin'].map(path => mkdir(join(root, path), { recursive: true })));
  const config = 'META_API_KEY=synthetic-config-secret\n';
  const memory = 'synthetic-household-memory';
  await Promise.all([
    writeFile(join(root, '.env'), config, { mode: 0o600 }),
    writeFile(join(root, 'data/memory.json'), memory),
    writeFile(join(root, 'src/server.js'), 'throw new Error("must not import");'),
    writeFile(join(root, 'node_modules/ws/package.json'), '{invalid-manifest-not-read}'),
    writeFile(join(root, 'bin/npm'), '#!/bin/sh\ntouch should-never-execute\n', { mode: 0o700 }),
  ]);
  await chmod(join(root, 'data'), 0o700);
  const report = formatReport(await inspectHosting({ root, nodeVersion: '22.16.0', platform: 'linux', environment: { PATH: join(root, 'bin'), META_API_KEY: 'synthetic-env-secret' } }));
  assert.match(report, /\[PRESENT\] npm on PATH/);
  assert.match(report, /A key variable is nonempty/);
  assert.doesNotMatch(report, /synthetic-|invalid-manifest|must not import/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), config);
  assert.equal(await readFile(join(root, 'data/memory.json'), 'utf8'), memory);
  assert.deepEqual((await readdir(root)).sort(), ['.env', 'bin', 'data', 'node_modules', 'src']);
});

test('inspection flags private config permissions without reading values', async t => {
  if (process.platform === 'win32') return t.skip('POSIX permissions');
  const root = await mkdtemp(join(tmpdir(), 'merlin-hosting-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'synthetic-secret');
  await chmod(join(root, '.env'), 0o644);
  const checks = await inspectHosting({ root, platform: 'linux', environment: { PATH: '' } });
  assert.equal(checks.find(check => check.item === '.env permissions')?.status, 'NEEDS ATTENTION');
  assert.doesNotMatch(formatReport(checks), /synthetic-secret/);
});
