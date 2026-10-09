import { createI18n, applyTranslations } from './i18n.js';
import { createViewer } from './vendor/index.js';
import { SceneController } from './controller.js';
import { markerPalette } from './markers.js';
import { TopControls, CompactControls } from './top-controls.js';

export const i18n = createI18n(new URL(location.href).searchParams.get('lang'));
const { t, formatNumber } = i18n;
document.documentElement.lang = i18n.locale;
applyTranslations(document, i18n);
const find = id => document.getElementById(id);
const host = find('scene-host');
const input = find('scene-file');
const status = find('scene-status');
const error = find('scene-error');
const level = find('auto-level');
const settings = await fetch(new URL(location.href).searchParams.get('settings') ?? './vendor/settings.json').then(response => {
  if (!response.ok) throw new Error(t('error.settingsUnavailable'));
  return response.json();
});
export const controller = new SceneController(host, {
  createViewer, settings, i18n,
  renderer: new URL(location.href).searchParams.has('webgl') ? 'webgl' : 'webgpu'
});
let levelMessage = '';
let editingId = null, draftColor = 'red', editingType = null;
let editorSuppressed = false;
controller.addEventListener('markerselection', event => {
  const bounds = host.getBoundingClientRect();
  editorSuppressed = event.detail.source === 'creation' && (bounds.width <= 768 || bounds.height <= 480);
});
const palette = find('marker-palette');
const showDraftColor = () => {
  for (const button of palette.children) button.setAttribute('aria-pressed', String(button.dataset.color === draftColor));
};
for (const color of markerPalette) {
  const button = document.createElement('button');
  button.type = 'button'; button.dataset.color = color.id;
  button.title = t(`color.${color.id}`); button.setAttribute('aria-label', button.title);
  button.style.setProperty('--swatch', color.hex);
  button.addEventListener('click', () => {
    if (editingId !== null) controller.updateMarker(editingId, { color: color.id });
  });
  palette.append(button);
}
const resetDraft = marker => {
  draftColor = marker?.color ?? 'red';
  find('marker-note').value = marker?.note ?? '';
  find('marker-name').value = marker?.name ?? '';
  find('marker-save-status').textContent = '';
  showDraftColor();
};
const renderEditor = () => {
  const marker = controller.markers.find(marker => marker.id === controller.state.selectedMarkerId);
  const id = marker?.id ?? null;
  if (id === null) editorSuppressed = false;
  find('marker-editor').hidden = id === null || editorSuppressed || controller.state.interactionMode === 'calibrate-scale';
  if (id !== editingId) { editingId = id; editingType = null; resetDraft(marker); }
  draftColor = marker?.color ?? 'red'; showDraftColor();
  for (const button of find('marker-type').children) {
    button.setAttribute('aria-pressed', String(button.dataset.type === marker?.type));
  }
  if (marker?.type === 'reference' && editingType !== 'reference' && !find('marker-name').value) find('marker-name').value = marker.name;
  editingType = marker?.type ?? null;
  find('marker-editor-title').textContent = id === null ? '' : t('marker.editorTitle', { id });
};
find('marker-note').addEventListener('input', () => { find('marker-save-status').textContent = t('marker.unsaved'); });
// The upstream engine listens on window: keep typing and text editing local.
for (const id of ['marker-note', 'marker-name', 'marker-type']) {
  for (const type of ['keydown', 'keyup']) find(id).addEventListener(type, event => event.stopPropagation());
}
find('marker-name').addEventListener('input', () => { find('marker-save-status').textContent = t('marker.unsaved'); });
for (const button of find('marker-type').children) {
  button.addEventListener('click', () => {
    if (editingId !== null) controller.updateMarker(editingId, { type: button.dataset.type });
  });
}
const saveMarker = () => {
  if (editingId === null) return;
  const patch = { note: find('marker-note').value, name: find('marker-name').value };
  controller.updateMarker(editingId, patch);
  resetDraft(controller.markers.find(marker => marker.id === editingId));
  find('marker-save-status').textContent = t('marker.saved');
};
find('save-marker').addEventListener('click', saveMarker);
find('marker-name').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    saveMarker();
  }
});
const render = () => {
  const { state } = controller;
  host.dataset.status = state.status;
  for (const id of ['orientation-controls', 'fit-controls', 'toolbar']) {
    find(id).hidden = state.status !== 'ready';
  }
  find('empty-state').hidden = state.status === 'ready';
  host.toggleAttribute('data-loading', state.status === 'loading');
  find('file-name').textContent = state.filename;
  find('close-scene').title = state.filename ? t('scene.closeFileHint', { filename: state.filename }) : t('scene.closeHint');
  find('close-scene').disabled = state.status === 'empty';
  find('fit-scene').disabled = state.status !== 'ready';
  for (const [id, mode, type] of [['route-mode', 'add-marker', 'route'], ['reference-mode', 'add-marker', 'reference'], ['edit-mode', 'edit-markers']]) {
    find(id).disabled = state.status !== 'ready';
    find(id).setAttribute('aria-pressed', String(state.interactionMode === mode && (!type || state.newMarkerType === type)));
  }
  find('marker-count').textContent = t('marker.count', { count: formatNumber(state.markerCount) });
  find('edit-mode').title = t('marker.editHint');
  find('delete-marker').disabled = state.status !== 'ready' || state.selectedMarkerId == null;
  find('edit-hint').hidden = state.status !== 'ready' || state.interactionMode !== 'edit-markers';
  find('set-scale').disabled = state.status !== 'ready';
  find('delete-route').disabled = state.status !== 'ready' || !controller.markers.some(marker => marker.type === 'route');
  find('set-scale').setAttribute('aria-pressed', String(state.interactionMode === 'calibrate-scale'));
  renderMeasurements();
  renderEditor();
  status.textContent = state.status === 'loading' ? t('scene.loading', { progress: formatNumber(Math.round(state.progress)) })
    : state.status === 'ready' ? levelMessage : state.status === 'error' ? t('scene.loadFailed') : t('scene.notLoaded');
  find('open-scene').title = t('scene.openHint', { detail: state.status === 'ready' ? state.filename : status.textContent });
  level.parentElement.title = t('scene.autoLevelHint', { detail: levelMessage || t('scene.autoLevelDescription') });
  if (state.status !== 'error') error.hidden = true;
};
let wasChoosing = false;
function renderMeasurements() {
  const m = controller.measurements;
  find('measurement-summary').hidden = controller.state.status !== 'ready';
  find('route-length').textContent = m.totalMeters === null ? t('scale.notSet') : t('scale.routeLength', { distance: formatNumber(m.totalMeters, 2) });
  find('scale-editor').hidden = !m.active;
  find('scale-hint').textContent = m.points.length === 0 ? t('scale.pickA') : m.points.length === 1 ? t('scale.pickB') : t('scale.enterDistance');
  const choosing = m.active && m.points.length === 2;
  find('scale-fields').hidden = !choosing;
  find('apply-scale').hidden = !choosing;
  find('scale-error').textContent = m.message;
  find('scale-error').hidden = !m.message;
  if (!m.active) find('scale-distance').value = '';
  if (choosing && !wasChoosing) find('scale-distance').focus({ preventScroll: true });
  wasChoosing = choosing;
}
controller.addEventListener('measurementchange', renderMeasurements);
const deleteDialog = find('delete-route-dialog');
let deleteContext = null;
const closeDeleteDialog = (confirmed = false) => {
  const context = deleteContext;
  deleteContext = null;
  if (deleteDialog.open) deleteDialog.close();
  if (!context || controller.viewer !== context.viewer || controller.generation !== context.generation) return;
  context.viewer.state.inputEnabled = context.inputEnabled;
  if (confirmed) controller.deleteRouteMarkers();
  const target = find('delete-route').disabled ? find('set-scale') : find('delete-route');
  target.focus({ preventScroll: true });
};
find('delete-route').addEventListener('click', () => {
  const count = controller.markers.filter(marker => marker.type === 'route').length;
  if (!count || controller.state.status !== 'ready' || deleteDialog.open) return;
  deleteContext = { viewer: controller.viewer, generation: controller.generation, inputEnabled: controller.viewer.state.inputEnabled };
  find('delete-route-message').textContent = t('route.deleteConfirm', { count: formatNumber(count) });
  controller.session.cameraDragCursor?.reset();
  controller.viewer.state.inputEnabled = false;
  deleteDialog.showModal();
  find('cancel-delete-route').focus({ preventScroll: true });
});
find('confirm-delete-route').addEventListener('click', () => closeDeleteDialog(true));
find('cancel-delete-route').addEventListener('click', () => closeDeleteDialog());
deleteDialog.addEventListener('cancel', event => { event.preventDefault(); closeDeleteDialog(); });
deleteDialog.addEventListener('close', () => { if (!deleteDialog.open && deleteContext) closeDeleteDialog(); });
controller.addEventListener('statechange', () => {
  if (deleteContext && (controller.viewer !== deleteContext.viewer || controller.generation !== deleteContext.generation || controller.state.status !== 'ready')) closeDeleteDialog();
});
// Capture before engine/document handlers; native dialog navigation still handles Tab/Enter/ESC.
for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
  if (deleteDialog.open) event.stopImmediatePropagation();
}, true);
window.addEventListener('pagehide', () => closeDeleteDialog(), { once: true });
find('set-scale').addEventListener('click', () => controller.beginScaleCalibration());
find('cancel-scale').addEventListener('click', () => controller.cancelScaleCalibration());
find('scale-form').addEventListener('submit', event => {
  event.preventDefault();
  try { controller.applyScaleCalibration(find('scale-distance').value); }
  catch (error) { find('scale-error').textContent = error.message; find('scale-error').hidden = false; }
});
for (const type of ['keydown', 'keyup']) find('scale-editor').addEventListener(type, event => event.stopPropagation());
controller.addEventListener('statechange', render);
controller.addEventListener('error', event => { error.textContent = event.detail.message; error.hidden = false; });
controller.addEventListener('transformchange', event => {
  const { estimate, autoLevel } = event.detail;
  level.disabled = !estimate;
  level.checked = autoLevel;
  levelMessage = !estimate ? t('scene.noLevelEstimate') : autoLevel ? t('scene.estimatedTilt', { degrees: formatNumber(estimate.tiltDegrees, 1) }) : t('scene.originalTilt');
  render();
});
const open = file => { level.disabled = false; level.checked = controller.autoLevel; void controller.loadFile(file); };
find('open-scene').addEventListener('click', () => input.click());
input.addEventListener('change', () => { const file = input.files[0]; input.value = ''; if (file) open(file); });
find('close-scene').addEventListener('click', () => controller.closeScene());
find('fit-scene').addEventListener('click', () => controller.fitScene());
for (const [id, type] of [['route-mode', 'route'], ['reference-mode', 'reference']]) {
  find(id).addEventListener('click', () => {
    controller.setNewMarkerType(type);
    controller.setInteractionMode('add-marker');
  });
}
find('edit-mode').addEventListener('click', () => controller.setInteractionMode('edit-markers'));
find('delete-marker').addEventListener('click', () => controller.deleteSelectedMarker());
find('close-marker-editor').addEventListener('click', () => {
  controller.clearMarkerSelection();
  const { interactionMode, newMarkerType } = controller.state;
  find(interactionMode === 'edit-markers' ? 'edit-mode' : `${newMarkerType}-mode`).focus({ preventScroll: true });
});
// Capture precedes the form fields' isolated keyboard handlers; keep native fullscreen Escape.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (controller.state.interactionMode !== 'edit-markers') {
    controller.setInteractionMode('edit-markers');
  } else if (!find('marker-editor').hidden) {
    const editor = find('marker-editor');
    const focused = editor.contains(document.activeElement);
    editorSuppressed = true;
    renderEditor();
    if (focused) find('edit-mode').focus({ preventScroll: true });
  }
}, true);
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (controller.state.interactionMode === 'edit-markers' && ['Delete', 'Backspace'].includes(event.key)) {
    event.preventDefault(); controller.deleteSelectedMarker();
  }
});
find('display-rotation').addEventListener('change', event => controller.setDisplayRotation(event.target.checked));
level.addEventListener('change', event => controller.setAutoLevel(event.target.checked));
document.addEventListener('dragover', event => { event.preventDefault(); document.body.dataset.dragging = ''; });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) delete document.body.dataset.dragging; });
document.addEventListener('drop', event => {
  event.preventDefault(); delete document.body.dataset.dragging;
  if (event.dataTransfer.files.length !== 1) {
    error.textContent = t('error.dropOneFile'); error.hidden = false;
  } else open(event.dataTransfer.files[0]);
});
window.addEventListener('pagehide', () => controller.destroy(), { once: true });
render();
const topControls = new TopControls(controller, {
  tools: find('scene-tools'), toolbar: find('toolbar'), summary: find('measurement-summary'), editor: find('marker-editor'), calibration: find('scale-editor'), dialog: find('delete-route-dialog')
});
const compactControls = new CompactControls(controller, { t, activity: () => topControls.activity() });
window.addEventListener('pagehide', () => compactControls.destroy(), { once: true });
window.addEventListener('pagehide', () => topControls.destroy(), { once: true });
