# Third-party distribution notices

## SuperSplat Viewer 1.36.2

- Package: `@playcanvas/supersplat-viewer@1.36.2`
- Source: <https://github.com/playcanvas/supersplat-viewer>
- Archive: <https://registry.npmjs.org/@playcanvas/supersplat-viewer/-/supersplat-viewer-1.36.2.tgz>
- License: MIT, Copyright (c) 2011-2026 PlayCanvas Ltd. Full text retained in LICENSE.

`index.html` adds noindex; `index.css` is copied unchanged from the exact npm
package's `public/` directory. `index.js` includes the local framing patch below.
`settings.json` is generated from its exported
`defaultSettings('object')` function. `index.js.map` is omitted from distribution;
its development-only source-map reference is stripped from the publication artifact.

`embed.html` and `embed.js` are the gallery's own adapter, using the bundled
`createViewer` API to add a 270-degree world-X display rotation, optional leveling
and initial framing. `framing.js` is the gallery's own bounds/camera math.

### Local framing patch (2026-10-02)

The viewer handle accepts `frameScene({ bounds, direction, padding, immediate })`.
`bounds` is `{ min: [x,y,z], max: [x,y,z] }` in final world space; null uses full
resource bounds. Direction points from target toward camera and defaults to the
authored initial camera direction. Padding defaults to 1.1. Bounds, direction
and padding persist for subsequent Frame/F commands; immediate is one-shot.
Each frame command recomputes distance for the current viewport. Immediate
application cancels controller transitions. Full transformed resource bounds
are refreshed separately for clipping, including geometry excluded from framing.
Invalid bounds leave the camera unchanged. No engine internals or licenses change.
`vendor.json` preserves the original bundle checksum under `upstreamFiles` and
records the patched bundle and helper checksums under `files`.

## PlayCanvas engine 2.22.6

The viewer's browser bundle includes PlayCanvas engine 2.22.6, revision `dfcc50f`,
as declared at the start of the shipped bundle and in the package's development
dependencies. No separate engine install is required at runtime.

- Source: <https://github.com/playcanvas/engine/tree/v2.22.6>
- License: MIT, Copyright (c) 2011-2026 PlayCanvas Ltd.
- Retained full text: PLAYCANVAS-LICENSE.

Retain these notices and license texts with the browser distribution. They cover
the vendored dependencies, not the owner's videos, scenes or VoluScape code.

## Reproducing the copy

In an external scratch directory, run `npm pack @playcanvas/supersplat-viewer@1.36.2`.
Verify its SHA512 integrity against `vendor.json`, extract the archive, and copy
the three public files and LICENSE into this folder. Generate settings from the
package's `dist/settings.js` and retain the exact engine license above. Compare
the original file SHA256 checksums to `vendor.json` (`upstreamFiles` for index.js and index.html).
From the project root apply `git apply viewer/framing.patch` to the
original bundle, add the noindex meta tag to index.html, retain the gallery's `framing.js`, then compare to `files` to
reproduce the patched distribution. The original archive and
scratch directory are not part of the published site.
