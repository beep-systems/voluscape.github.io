import { mediaURL, validateCatalog, selectionFromHash, selectionHash } from './catalog.js';

const base = new URL('../', import.meta.url);
const $ = (id) => document.getElementById(id);
let catalog;
let selectedTest;
let selectedResult;
let pendingLoad;
let generation = 0;
let viewerTimeout;

function showError(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function placeholder(message) {
  const box = document.createElement('div');
  box.className = 'placeholder';
  const icon = document.createElement('span');
  icon.className = 'placeholder-icon';
  icon.textContent = '◇';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('p');
  text.textContent = message;
  box.append(icon, text);
  $('scene-host').replaceChildren(box);
}

function clearViewer() {
  generation++;
  clearTimeout(viewerTimeout);
  pendingLoad?.abort();
  pendingLoad = null;
  // Navigating away and removing the iframe tears down its document and GPU context.
  const frame = $('scene-host').querySelector('iframe');
  if (frame) { frame.src = 'about:blank'; frame.remove(); }
  $('close-scene').hidden = true;
  $('open-scene').hidden = false;
  showError('scene-error');
}

function replaceVideo(test) {
  const oldVideo = $('video-host').querySelector('video');
  if (oldVideo) { oldVideo.pause(); oldVideo.removeAttribute('src'); oldVideo.load(); }
  const url = mediaURL(test.video, base);
  const video = document.createElement('video');
  video.controls = true;
  video.preload = 'none';
  video.playsInline = true;
  if (test.poster) video.poster = mediaURL(test.poster, base).href;
  video.setAttribute('aria-label', `Video for ${test.title}`);
  video.addEventListener('error', () => {
    if (selectedTest?.id === test.id && video.isConnected) showError('video-error', 'Unable to play video. Check that the file exists and the browser supports its codec.');
  });
  video.src = url.href;
  $('video-host').replaceChildren(video);
  showError('video-error');
  $('video-heading').textContent = `Video · ${test.title}`;
}

function addMetric(label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  $('metadata').append(row);
}

function renderDetails() {
  const result = selectedResult;
  $('description').textContent = [selectedTest.description, result?.description].filter(Boolean).join(' ');
  $('description').hidden = !$('description').textContent;
  $('metadata').replaceChildren();
  if (selectedTest.sizeBytes !== undefined) addMetric('Video size', `${(selectedTest.sizeBytes / 1048576).toFixed(1)} MiB`);
  if (result?.sizeBytes !== undefined) addMetric('Scene size', `${(result.sizeBytes / 1048576).toFixed(1)} MiB`);
  if (result?.gaussians !== undefined) addMetric('Gaussians', result.gaussians.toLocaleString('en-US'));
  const parameters = result?.parameters ?? selectedTest.parameters;
  $('parameters-section').hidden = parameters === undefined;
  $('parameters').textContent = parameters === undefined ? '' : JSON.stringify(parameters, null, 2);
}

function select(test, result, writeHash = true) {
  const changedVideo = selectedTest?.id !== test.id;
  clearViewer();
  selectedTest = test;
  selectedResult = result;
  $('test-select').value = test.id;
  if (changedVideo) replaceVideo(test);
  $('scene-heading').textContent = result ? `3D scene · ${result.label}` : '3D scene';
  $('scene-format').textContent = result ? mediaURL(result.scene, base).pathname.split('.').pop().toUpperCase() : 'Pending';
  $('open-scene').disabled = !result;
  placeholder(result ? 'Click "Open scene" to load the scene.' : 'No result has been added yet');
  $('scene-status').textContent = result ? 'Rotate and explore the scene.' : 'The video is available to watch.';
  renderDetails();
  if (writeHash) history.replaceState(null, '', selectionHash(test, result));
}

async function checkFile(url, signal) {
  // HEAD validates availability without downloading a large scene twice.
  let response = await fetch(url, { method: 'HEAD', signal });
  if (response.status === 405 || response.status === 501) {
    response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    await response.body?.cancel();
  }
  if (!response.ok) throw new Error(`File unavailable (HTTP ${response.status}): ${decodeURIComponent(url.pathname.split('/').pop())}`);
}

async function openScene() {
  if (!selectedResult) return;
  clearViewer();
  const currentGeneration = generation;
  const result = selectedResult;
  pendingLoad = new AbortController();
  const { signal } = pendingLoad;
  $('open-scene').disabled = true;
  $('close-scene').hidden = false;
  $('scene-status').textContent = 'Checking files…';
  const sceneURL = mediaURL(result.scene, base);
  const settingsURL = mediaURL(result.settings ?? 'viewer/settings.json', base);
  try {
    await Promise.all([checkFile(sceneURL, signal), checkFile(settingsURL, signal), checkFile(new URL('viewer/embed.html', base), signal)]);
    if (generation !== currentGeneration) return;
    const viewerURL = new URL('viewer/embed.html', base);
    viewerURL.searchParams.set('content', sceneURL.href);
    viewerURL.searchParams.set('settings', settingsURL.href);
    viewerURL.searchParams.set('lang', 'en');
    viewerURL.searchParams.set('noanim', '');
    const frame = document.createElement('iframe');
    frame.title = `Interactive scene: ${selectedTest.title}, ${result.label}`;
    frame.allow = 'fullscreen; xr-spatial-tracking';
    frame.allowFullscreen = true;
    frame.src = viewerURL.href;
    $('scene-host').replaceChildren(frame);
    $('open-scene').hidden = true;
    $('scene-status').textContent = 'Loading 3D scene...';
    viewerTimeout = setTimeout(() => {
      if (generation === currentGeneration) showError('scene-error', 'The scene is taking longer than expected. Close it and retry, or watch the video.');
    }, 90000);
  } catch (error) {
    if (generation !== currentGeneration || error.name === 'AbortError') return;
    showError('scene-error', `Unable to open scene. ${error.message}`);
    placeholder('Scene unavailable. You can still watch the video.');
    $('scene-status').textContent = 'Check the files and try again.';
    $('close-scene').hidden = true;
  } finally {
    if (generation === currentGeneration) { pendingLoad = null; $('open-scene').disabled = false; }
  }
}

$('test-select').addEventListener('change', () => {
  const test = catalog.find((item) => item.id === $('test-select').value);
  select(test, test.results[0] ?? null);
});
$('open-scene').addEventListener('click', openScene);
$('close-scene').addEventListener('click', () => select(selectedTest, selectedResult));
document.querySelector('.scene-directory').addEventListener('click', event => {
  const link = event.target.closest('a[href^="#test="]');
  if (!link || !catalog) return;
  event.preventDefault();
  const { test, result } = selectionFromHash(catalog, link.hash);
  select(test, result);
  $('workspace').focus();
});
window.addEventListener('message', event => {
  const frame = $('scene-host').querySelector('iframe');
  if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'voluscape-viewer') return;
  if (event.data.state === 'ready') {
    clearTimeout(viewerTimeout);
    showError('scene-error');
    $('scene-status').textContent = event.data.inputMode === 'touch' || matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
      ? 'Drag to rotate. Pinch to zoom; use two fingers to pan. Scroll outside the scene to move down the page.'
      : 'Drag to rotate; scroll to zoom. In Fly mode: W / S forward / backward, A / D left / right, Q / E down / up.';
  } else if (event.data.state === 'error') {
    clearTimeout(viewerTimeout);
    showError('scene-error', 'Unable to render the scene. Close it and retry in a browser with WebGL support. You can still watch the video.');
    $('scene-status').textContent = 'Scene unavailable.';
  }
});
window.addEventListener('hashchange', () => {
  if (catalog) { const { test, result } = selectionFromHash(catalog, location.hash); select(test, result); }
});
window.addEventListener('pagehide', () => { clearViewer(); $('video-host').querySelector('video')?.pause(); });

try {
  const response = await fetch(new URL('catalog.json', base), { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  catalog = validateCatalog(await response.json(), base);
  for (const test of catalog) $('test-select').append(new Option(test.title, test.id));
  $('test-select').disabled = false;
  const { test, result } = selectionFromHash(catalog, location.hash);
  select(test, result);
} catch (error) {
  showError('catalog-error', `Unable to load catalog. ${error.message}`);
  placeholder('Catalog unavailable');
}
