# Updating the SuperSplat fork

The runtime vendors a built browser distribution. Source changes are maintained
in the `voluscape` branch of [our fork](https://github.com/beep-systems/supersplat-viewer),
with [PlayCanvas](https://github.com/playcanvas/supersplat-viewer) as `upstream`.
Do not patch generated `vendor/index.js` or merge upstream into the VoluScape repository.

## Prerequisites

Use Node.js **24.14.1**, npm **11.11.0**, Git and authenticated access to the fork.
The application itself still requires only Node.js 20+ and has no runtime install
or build step. Build dependencies belong to the fork's committed lockfile.
`VIEWER_NPM_CLI` can specify the npm CLI JavaScript path if it is not installed
beside Node.js.

Browser validation needs Playwright, Sharp and Chromium. Install these in the
ignored workspace, separately from the source build dependencies:

```powershell
npm install --prefix build/viewer-update-tools --no-save --package-lock=false playwright sharp
node build/viewer-update-tools/node_modules/playwright/cli.js install chromium
$env:PLAYWRIGHT_MODULE = (Resolve-Path build/viewer-update-tools/node_modules/playwright/index.mjs).Path
$env:SHARP_MODULE = (Resolve-Path build/viewer-update-tools/node_modules/sharp/dist/index.mjs).Path
```

If your Sharp version uses another entry, use its resolved module path instead.
`PREVIEW_BROWSER` optionally points to an existing Chromium executable.

## Prepare an update

Commit existing vendor changes first. The fork must have a clean working tree.
Run from the repository root:

```powershell
node viewer/scripts/update-vendor.mjs --tag v1.37.0
# Or use an existing clone:
node viewer/scripts/update-vendor.mjs --tag v1.37.0 --fork-dir 'D:/scratch/supersplat-viewer'
```

The default checkout is `build/supersplat-viewer`. The command clones the fork
when absent, verifies remote URLs, fetches `origin/voluscape` and the explicit
upstream release, and creates `updates/<tag>` from the maintained fork branch.
It uses merge, preserving published history. An existing update branch must
contain the current `origin/voluscape` before it can be reused.

On conflict, the checkout remains on the update branch with the conflict visible.
Resolve the TypeScript conflict, run `git add` and `git commit`, then repeat the
same command. It never resets local changes or automatically resolves conflicts.
An obsolete update branch must be reconciled with `origin/voluscape` manually.

After `npm ci`, the command runs typecheck, lint, formatting checks, build and
upstream unit tests. It generates a candidate in a new
`build/viewer-updates/<tag>-<timestamp>/` directory, runs VoluScape unit tests and
all six browser suites (including localization) sequentially, then replaces the entire vendor directory.
Failures leave the current vendor intact. The previous vendor remains in the
run directory. Logs and browser reports remain there too; no scene footage is used.

## Review and retain

Review `git diff -- viewer/vendor`, the manifest and test reports. Push the
prepared fork branch and merge it into `voluscape`; preserve its recorded commit
as an ancestor. Then commit the vendor update in VoluScape. The CLI does not
push, merge the permanent branch, commit VoluScape or publish the gallery.

Update version references in README. Run the gallery browser, real-scene and
mobile checks after replacing the vendor.

`vendor/vendor.json` pins upstream/fork commits, viewer/engine versions, the
lockfile hash, build commands and Node/npm versions. Artifact text hashes use LF
normalization so Git CRLF conversion does not change their identity. `framing.js`
is the retained host math helper; the fork compiles its TypeScript counterpart
into the bundle. The manifest covers both the built distribution and host helper.

To reproduce a distribution, clone the fork into a new directory, check out the
manifest's exact fork commit, use its recorded Node/npm versions, and run
`npm ci` and `npm run build`. Generate `settings.json` using
`dist/settings.js`'s `defaultSettings('object')`; copy `public/index.js` and
`public/index.css`, stripping only the JS source-map reference. Retain both exact
license texts. The CLI's exported `prepareCandidate` performs this packaging.
Compare LF-normalized hashes against the manifest.
Generated shader strings retain upstream whitespace; the bundle's Git attribute
excludes trailing whitespace from formatting checks without rewriting that data.

Rollback by restoring the complete previous vendor and manifest from a known
VoluScape commit. Do not mix artifacts from different builds. The previous gallery
distribution and its patch are retained in this repository’s Git history.
