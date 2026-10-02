# VoluScape

A compact gallery comparing seven drone videos with interactive Gaussian-splatting landscapes. Public URL: https://voluscape.beep.systems/.

## Local preview

Requires Node.js 20 or newer. The site has no runtime package dependencies.

```sh
npm test
npm run serve
```

Open http://127.0.0.1:4173/. To check a repository subpath, run `npm run serve -- --prefix /preview` and open http://127.0.0.1:4173/preview/.
If the default port is occupied, add `--port 4174` to the preview command.

Scenes load only after **Open scene**. Drag to orbit and scroll/pinch to zoom. On touch devices, two fingers pan; scroll outside the viewer to move through the page. Close the scene to release its rendering resources.

## Content and build

`catalog.json` is the source for scene names, descriptions, relative media paths and statistics. After changing the catalog, run `npm run content` to refresh the HTML scene directory. Add or regenerate posters with `npm run posters` using the optional browser setup below. Videos and scene geometry are never rewritten.

```sh
npm run build
npm run serve -- --root dist
```

The build replaces the generated `dist/` with only public assets and required third-party notices. Tests, vendor provenance, patches, development notes and IDE settings stay outside that artifact. GitHub Pages must publish the artifact, not the repository root. Files committed to a public GitHub repository remain publicly visible even when excluded from the website.

## Browser checks

Install optional tooling locally; it is not part of the published site:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run build
npm run test:browser
npm run test:scenes
npm run test:mobile
```

`PLAYWRIGHT_MODULE` and `PREVIEW_BROWSER` can point to an existing Playwright module and Chromium executable. `PREVIEW_TEST_OUTPUT` selects the screenshot/report directory (default: ignored `build/`). Browser checks cover real MP4 decode, real SOG rendering, synthetic viewer fixtures, touch emulation and responsive layouts. Emulation is not verification on a physical phone; check iOS Safari and Android Chrome before publishing.

## GitHub Pages publication

1. In repository **Settings → Pages**, choose **GitHub Actions** as the source and set the custom domain to `voluscape.beep.systems`.
2. The existing DNS CNAME currently points to `voluscape.github.io`, while this checkout's remote is `beep-systems/voluscape.github.io`. DNS is intentionally unchanged. Confirm that the domain reaches the intended repository before release.
3. Commit the prepared files, then manually run **Publish GitHub Pages** in **Actions**. The workflow runs Node tests, builds the allowlisted artifact and deploys it. Pushes do not publish automatically. A CNAME file is not used to configure the domain for this Actions workflow.
4. Enable **Enforce HTTPS** when the certificate is available. Check the public gallery, all media, canonical URL, robots and sitemap over HTTPS.

Canonical and social metadata use `https://voluscape.beep.systems/`. Hash links select scenes on the same indexed page; viewer documents are marked `noindex`. No deployment or DNS change is performed by local builds.
