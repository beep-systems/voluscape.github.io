import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir, rename, stat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const upstreamUrl = 'https://github.com/playcanvas/supersplat-viewer.git';
export const forkUrl = 'https://github.com/beep-systems/supersplat-viewer.git';
export const nodeVersion = '24.14.1';
export const npmVersion = '11.11.0';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha = data => createHash('sha256').update(data).digest('hex');
export const textHash = data => sha(data.toString().replaceAll('\r\n', '\n'));
const exists = async p => stat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
export async function run(command, args, cwd, log) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', async code => {
      try {
        if (log) await writeFile(log, output);
        if (code) reject(new Error(`${command} ${args.join(' ')} failed (${code}). ${log ? `See ${log}` : output}`));
        else accept(output.trim());
      } catch (error) { reject(error); }
    });
  });
}
export const git = (cwd, ...args) => run('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args], cwd);
export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--tag', '--fork-dir'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: update-vendor.mjs --tag v1.37.0 [--fork-dir path]');
    const key = args[i].slice(2); if (options[key]) throw new Error(`Duplicate ${args[i]}`);
    options[key] = args[++i];
  }
  if (!/^v\d+\.\d+\.\d+$/.test(options.tag ?? '')) throw new Error('An explicit stable release tag is required, e.g. v1.37.0');
  return options;
}
async function npm(cwd, args, log) {
  const cli = process.env.VIEWER_NPM_CLI ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  return run(process.execPath, [cli, ...args], cwd, log);
}

export async function prepareCandidate(fork, viewer, tag) {
  await mkdir(join(viewer, 'vendor'), { recursive: true });
  const destination = join(viewer, 'vendor');
  for (const name of ['copy-provenance.json', 'framing.patch', 'markers.patch']) {
    await rm(join(destination, name), { force: true });
  }
  const pkg = JSON.parse(await readFile(join(fork, 'package.json')));
  if (`v${pkg.version}` !== tag) throw new Error('Package version does not match selected upstream tag');
  const engine = JSON.parse(await readFile(join(fork, 'node_modules/playcanvas/package.json')));
  if (engine.version !== pkg.devDependencies.playcanvas) throw new Error('Installed engine does not match the pinned source dependency');
  await cp(join(fork, 'public/index.css'), join(destination, 'index.css'));
  const js = (await readFile(join(fork, 'public/index.js'), 'utf8')).replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm, '');
  await writeFile(join(destination, 'index.js'), js);
  await cp(join(fork, 'LICENSE'), join(destination, 'LICENSE'));
  await cp(join(fork, 'node_modules/playcanvas/LICENSE'), join(destination, 'PLAYCANVAS-LICENSE'));
  const { defaultSettings } = await import(pathToFileURL(join(fork, 'dist/settings.js')));
  await writeFile(join(destination, 'settings.json'), JSON.stringify(defaultSettings('object'), null, 2) + '\n');
  await writeFile(join(destination, 'THIRD-PARTY.md'), `# Third-party distribution notices\n\nSuperSplat Viewer ${pkg.version}: MIT, PlayCanvas Ltd.\nSource: https://github.com/playcanvas/supersplat-viewer/tree/${tag}\nVoluScape fork: https://github.com/beep-systems/supersplat-viewer\n\nPlayCanvas ${pkg.devDependencies.playcanvas}: MIT. Full licenses are retained in LICENSE and PLAYCANVAS-LICENSE.\n\nThe fork implements dynamic world-space framing/full-geometry clipping, delegated point interaction, surface/visibility picking, marker primitives and Fly mouse inversion in source modules. Host UI, marker ownership and measurements remain outside the bundle. See vendor.json for exact source commits and artifact checksums; see ../UPDATING.md for reproduction. These licenses do not select a license for VoluScape.\n`);
  const manifest = {
    schemaVersion: 2, package: pkg.name, version: pkg.version, engineVersion: pkg.devDependencies.playcanvas,
    upstream: { url: upstreamUrl, tag, commit: await git(fork, 'rev-parse', `${tag}^{commit}`) },
    fork: { url: forkUrl, commit: await git(fork, 'rev-parse', 'HEAD') },
    build: { node: process.versions.node, npm: await npm(fork, ['--version']), lockfileSha256: textHash(await readFile(join(fork, 'package-lock.json'))), commands: ['npm ci', 'npm run build'], textNormalization: 'LF' },
    files: {}
  };
  for (const name of ['index.js', 'index.css', 'settings.json', 'LICENSE', 'PLAYCANVAS-LICENSE', 'THIRD-PARTY.md', 'framing.js']) {
    manifest.files[name] = textHash(await readFile(join(destination, name)));
  }
  await writeFile(join(destination, 'vendor.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function validateCandidate(viewer, evidence) {
  await mkdir(evidence, { recursive: true });
  const tests = (await readdir(join(viewer, 'tests'))).filter(name => name.endsWith('.test.mjs')).map(name => join(viewer, 'tests', name));
  await run(process.execPath, ['--test', ...tests], viewer, join(evidence, 'unit.log'));
  for (const name of ['browser', 'markers-browser', 'top-controls-browser', 'measurements-browser', 'route-clear-browser', 'i18n-browser']) {
    console.log(`Checking ${name}…`);
    await run(process.execPath, [join(viewer, 'tests', `${name}.mjs`)], viewer, join(evidence, `${name}.log`));
  }
}

export async function installCandidate(candidate, destination, backup, operations = {}) {
  const copy = operations.copy ?? cp;
  const move = operations.move ?? rename;
  // Rename the complete directory only after a full replacement has been prepared.
  const replacement = `${destination}.next-${process.pid}`;
  await mkdir(replacement);
  try {
    await copy(candidate, replacement, { recursive: true });
    await move(destination, backup);
    try { await move(replacement, destination); }
    catch (error) { await move(backup, destination); throw error; }
  } catch (error) {
    await rm(replacement, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareBranch(fork, tag) {
  if (await git(fork, 'status', '--porcelain')) throw new Error('Fork has uncommitted changes; resolve and commit merge conflicts before retrying');
  await git(fork, 'fetch', 'origin', 'voluscape');
  await git(fork, 'fetch', 'upstream', 'tag', tag);
  const upstreamCommit = await git(fork, 'rev-parse', `${tag}^{commit}`);
  const branch = `updates/${tag}`;
  if (await git(fork, 'branch', '--list', branch)) {
    await git(fork, 'switch', branch);
    await git(fork, 'merge-base', '--is-ancestor', 'origin/voluscape', 'HEAD');
  } else await git(fork, 'switch', '-c', branch, 'origin/voluscape');
  await git(fork, 'merge', '--no-edit', upstreamCommit);
  return branch;
}

export async function update(options) {
  if (process.versions.node !== nodeVersion) throw new Error(`Use Node.js ${nodeVersion}; actual ${process.versions.node}`);
  if (await npm(root, ['--version']) !== npmVersion) throw new Error(`Use npm ${npmVersion}`);
  const dirty = await git(root, 'status', '--porcelain', '--', 'viewer/vendor');
  if (dirty) throw new Error('Vendor has uncommitted changes; commit or restore them before updating');
  const fork = resolve(options['fork-dir'] ?? join(root, 'build/supersplat-viewer'));
  if (!await exists(join(fork, '.git'))) {
    await mkdir(dirname(fork), { recursive: true });
    await run('git', ['clone', forkUrl, fork], root);
    await git(fork, 'remote', 'add', 'upstream', upstreamUrl);
  }
  for (const [remote, url] of [['origin', forkUrl], ['upstream', upstreamUrl]]) {
    if ((await git(fork, 'remote', 'get-url', remote)).replace(/\.git$/, '') !== url.replace(/\.git$/, '')) throw new Error(`Unexpected ${remote} URL`);
  }
  // A conflict is deliberately left in this branch for manual resolution.
  const branch = await prepareBranch(fork, options.tag);
  const sourceCommit = await git(fork, 'rev-parse', 'HEAD');
  const runId = `${options.tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const work = join(root, 'build/viewer-updates', runId);
  await mkdir(work, { recursive: true });
  await npm(fork, ['ci'], join(work, 'install.log'));
  for (const script of ['type:check', 'lint', 'fmt', 'build', 'test:unit']) {
    console.log(`Fork: ${script}…`);
    await npm(fork, ['run', script], join(work, `${script.replace(':', '-')}.log`));
  }
  if (await git(fork, 'status', '--porcelain') || await git(fork, 'rev-parse', 'HEAD') !== sourceCommit) {
    throw new Error('Source checkout changed during the build; vendor was not installed');
  }
  const viewer = join(work, 'viewer');
  await cp(join(root, 'viewer'), viewer, { recursive: true, filter: source => !source.includes('node_modules') });
  const manifest = await prepareCandidate(fork, viewer, options.tag);
  await validateCandidate(viewer, join(work, 'checks'));
  if (await git(root, 'status', '--porcelain', '--', 'viewer/vendor')) {
    throw new Error('Vendor changed while candidate checks were running; nothing was installed');
  }
  await installCandidate(join(viewer, 'vendor'), join(root, 'viewer/vendor'), join(work, 'previous-vendor'));
  console.log(`Prepared ${manifest.version}, fork ${manifest.fork.commit}. Evidence: ${work}\nReview vendor diff, push ${branch} and merge it into voluscape, then commit vendor in VoluScape. No push or project commit was performed.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  update(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
