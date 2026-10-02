// Gallery adapter. The viewer has a documented local framing patch.

const params = new URL(location.href).searchParams;
document.documentElement.dataset.orienting = '';
let viewer;
let failed = false;
let controlsObserver;
const notify = state => {
  if (window.parent !== window) window.parent.postMessage({ type: 'voluscape-viewer', state, inputMode: viewer?.state.inputMode }, location.origin);
};
function fail() {
  if (failed) return;
  failed = true;
  controlsObserver?.disconnect();
  // Let the engine finish dispatching asset errors before tearing down its registry.
  const failedViewer = viewer;
  setTimeout(() => failedViewer?.destroy(), 0);
  delete document.documentElement.dataset.orienting;
  const message = document.createElement('p');
  message.className = 'embed-error';
  message.setAttribute('role', 'alert');
  message.textContent = 'Unable to load this 3D scene. Close it and retry in a browser with WebGL support.';
  document.body.replaceChildren(message);
  notify('error');
}
try {
  const [{ createViewer }, { estimateLevel, sampleWorldCenters }, { framingBounds }] = await Promise.all([
    import('./index.js'), import('./level.js'), import('./framing.js')
  ]);
  viewer = await createViewer({
    container: document.body,
    contentUrl: params.get('content'),
    settings: params.get('settings') ?? './settings.json',
    lang: 'en',
    noanim: true,
    renderer: params.has('webgl') ? 'webgl' : 'webgpu',
    exposeGlobals: true
  });
  viewer.app.assets.on('error', fail);
  const controls = document.getElementById('level-controls');
  const mainControls = document.querySelector('.sse-controlsWrap');
  const syncControls = () => {
    for (const state of ['sse-faded-in', 'sse-faded-out', 'sse-dimmed']) {
      controls.classList.toggle(state, mainControls.classList.contains(state));
    }
    controls.inert = mainControls.classList.contains('sse-faded-out');
  };
  controlsObserver = new MutationObserver(syncControls);
  controlsObserver.observe(mainControls, { attributes: true, attributeFilter: ['class'] });
  syncControls();
  // Share the viewer's existing hover timer instead of starting a separate one.
  const holdControls = () => mainControls.dispatchEvent(new Event('pointerenter'));
  const releaseControls = () => mainControls.dispatchEvent(new Event('pointerleave'));
  controls.addEventListener('pointerenter', holdControls);
  controls.addEventListener('pointerleave', releaseControls);
  controls.addEventListener('focusin', holdControls);
  controls.addEventListener('focusout', event => { if (!controls.contains(event.relatedTarget)) releaseControls(); });
  const orient = () => {
    // Add a world-X rotation to the upstream coordinate conversion (180° on Z).
    // Source splats, their covariance and SH remain unchanged on disk.
    const components = viewer.app.root.findComponents('gsplat');
    for (const component of components) {
      component.entity.rotate(270, 0, 0);
    }
    const coarse = components.map(component => ({
      entity: component.entity,
      rotation: component.entity.getRotation().clone(),
      position: component.entity.getPosition().clone()
    }));
    // Bound CPU fitting cost. Never download or decompress the scene a second time.
    const samplePoints = () => components.flatMap(component => component.resource?.centers
      ? sampleWorldCenters(component.resource.centers, component.entity.getWorldTransform().data, Math.floor(4000/components.length))
      : []);
    const estimate = estimateLevel(samplePoints());
    const checkbox = document.getElementById('auto-level');
    const status = document.getElementById('level-status');
    window.previewLevel = estimate; // Read-only diagnostic for verification.
    const apply = () => {
      for (const item of coarse) {
        item.entity.setRotation(item.rotation);
        item.entity.setPosition(item.position);
        if (checkbox.checked && estimate) {
          const correction = item.rotation.clone().set(...estimate.quaternion);
          item.entity.setRotation(correction.clone().mul(item.rotation));
          item.entity.setPosition(correction.transformVector(item.position));
        }
      }
      status.textContent = estimate && checkbox.checked
        ? `Estimated tilt: ${estimate.tiltDegrees.toFixed(1)}°`
        : estimate ? 'Original tilt' : 'No reliable estimate';
      document.documentElement.dataset.levelStatus = estimate && checkbox.checked ? 'applied' : 'skipped';
      const bounds = framingBounds(samplePoints());
      window.previewFraming = { bounds }; // Display-only diagnostic for verification.
      viewer.frameScene({ bounds, padding: 1.1, immediate: true });
    };
    checkbox.disabled = !estimate;
    checkbox.checked = !!estimate;
    checkbox.addEventListener('change', apply);
    document.getElementById('fit-scene').addEventListener('click', () => viewer.frameScene());
    document.getElementById('level-controls').hidden = false;
    // The gallery already shows touch instructions; keep the narrow canvas clear.
    if (viewer.state.inputMode === 'touch') document.querySelector('.sse-controlsHintClose')?.click();
    apply();
    // Reveal the canvas only after a frame with the corrected orientation.
    viewer.app.once('frameend', () => { delete document.documentElement.dataset.orienting; notify('ready'); });
  };
  const safeOrient = () => { try { orient(); } catch { fail(); } };
  if (viewer.state.loaded) safeOrient();
  else viewer.events.once('loaded:changed', safeOrient);
  window.addEventListener('pagehide', () => { controlsObserver.disconnect(); viewer.destroy(); }, { once: true });
} catch (error) {
  fail();
}
