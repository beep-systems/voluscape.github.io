import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, run, parseArgs, prepareBranch, installCandidate } from '../scripts/update-vendor.mjs';

async function scratch(t) {
  const parent = fileURLToPath(new URL('../../build/viewer-update-tests/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function repo(root, name) {
  const dir = join(root, name); await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Fixture');
  await git(dir, 'config', 'user.email', 'fixture@example.invalid');
  return dir;
}
async function commit(dir, content) {
  await writeFile(join(dir, 'file.txt'), content);
  await git(dir, 'add', 'file.txt'); await git(dir, 'commit', '-m', content);
}
test('requires an explicit release and accepts paths containing spaces', () => {
  assert.deepEqual(parseArgs(['--tag', 'v1.37.0', '--fork-dir', 'some path']), {tag:'v1.37.0','fork-dir':'some path'});
  for (const args of [[], ['--tag', 'main'], ['--tag', '--bad'], ['--tag', 'v1.37.0', '--bad', 'x']]) assert.throws(() => parseArgs(args));
});
test('real Git update rejects dirty/unknown tags, resumes resolved conflicts and is repeatable', async t => {
  const root = await scratch(t), upstream = await repo(root, 'upstream');
  await commit(upstream, 'base'); await git(upstream, 'tag', 'v1.36.2');
  const fork = join(root, 'fork with spaces');
  await run('git', ['clone', upstream, fork], root);
  await git(fork, 'config', 'user.name', 'Fixture'); await git(fork, 'config', 'user.email', 'fixture@example.invalid');
  await git(fork, 'remote', 'rename', 'origin', 'upstream');
  await git(fork, 'switch', '-c', 'voluscape'); await commit(fork, 'local');
  const origin = join(root, 'origin.git'); await run('git', ['clone', '--bare', fork, origin], root);
  await git(fork, 'remote', 'add', 'origin', origin);
  await commit(upstream, 'upstream'); await git(upstream, 'tag', 'v1.37.0');
  await writeFile(join(fork, 'file.txt'), 'dirty');
  await assert.rejects(prepareBranch(fork, 'v1.37.0'), /uncommitted/);
  await git(fork, 'restore', 'file.txt');
  await assert.rejects(prepareBranch(fork, 'v9.9.9'), /failed/);
  await assert.rejects(prepareBranch(fork, 'v1.37.0'), /CONFLICT/);
  assert.equal(await git(fork, 'branch', '--show-current'), 'updates/v1.37.0');
  await assert.rejects(prepareBranch(fork, 'v1.37.0'), /uncommitted/);
  await commit(fork, 'resolved');
  await prepareBranch(fork, 'v1.37.0'); const head = await git(fork, 'rev-parse', 'HEAD');
  await prepareBranch(fork, 'v1.37.0'); assert.equal(await git(fork, 'rev-parse', 'HEAD'), head);
});
test('failed candidate copy and failed final rename retain complete previous vendor', async t => {
  const root = await scratch(t), old = join(root, 'vendor'), next = join(root, 'candidate'), backup = join(root, 'backup');
  await mkdir(old); await mkdir(next); await writeFile(join(old, 'index.js'), 'old'); await writeFile(join(next, 'index.js'), 'new');
  await assert.rejects(installCandidate(next, old, backup, {copy:async()=>{throw Error('copy failure');}}), /copy failure/);
  assert.equal(await readFile(join(old, 'index.js'), 'utf8'), 'old');
  await assert.rejects(installCandidate(next, old, backup, {move:async(a,b)=>{if(a.includes('.next-')) throw Error('rename failure'); await rename(a,b);}}), /rename failure/);
  assert.equal(await readFile(join(old, 'index.js'), 'utf8'), 'old');
  await installCandidate(next, old, backup);
  assert.equal(await readFile(join(old, 'index.js'), 'utf8'), 'new');
  assert.equal(await readFile(join(backup, 'index.js'), 'utf8'), 'old');
});
test('a failed subprocess is logged and stops the pipeline', async t => {
  const root = await scratch(t), log = join(root, 'failure.log');
  await assert.rejects(run(process.execPath, ['-e', 'console.error("build failed");process.exit(7)'], root, log), /failed \(7\)/);
  assert.match(await readFile(log, 'utf8'), /build failed/);
});
