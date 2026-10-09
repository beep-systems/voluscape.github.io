import { english } from './i18n.js';
import { SceneMeasurements } from './measurements.js';
import { DistanceLabels } from './distance-labels.js';
import { SceneOrientation } from './orientation.js';
import { SceneMarkers } from './markers.js';
import { MarkerLabels } from './marker-labels.js';
import { CameraDragCursor } from './camera-drag-cursor.js';

export class SceneController extends EventTarget {
  constructor(container, { createViewer, settings, renderer = 'webgpu', i18n = english } = {}) {
    super();
    this.container = container;
    this.createViewer = createViewer;
    this.settings = settings;
    this.renderer = renderer;
    this.i18n = i18n;
    this.viewer = null;
    this.transformation = null;
    this.state = { status: 'empty', filename: '', progress: 0, interactionMode: 'edit-markers', newMarkerType: 'route', markerCount: 0, selectedMarkerId: null };
    this.displayRotation = true;
    this.autoLevel = true;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.session = null;
    this.destroyed = false;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  update(patch) { this.state = { ...this.state, ...patch }; this.emit('statechange', { ...this.state }); }

  dispose(session = this.session) {
    if (!session || session.disposed) return;
    // Host overlays must leave the viewer-owned root before it is removed.
    if (session === this.session) this.emit('viewerdispose');
    session.disposed = true;
    session.listeners.splice(0).forEach(remove => remove());
    session.cameraDragCursor?.destroy();
    session.distanceLabels?.destroy();
    session.measurements?.destroy();
    session.labels?.destroy();
    session.markers?.destroy();
    session.viewer?.destroy();
    if (session.objectUrl) URL.revokeObjectURL(session.url);
    session.host.remove();
    if (this.session === session) {
      this.session = null;
      this.viewer = null;
      this.orientation = null;
      this.transformation = null;
    }
  }

  closeScene() {
    ++this.generation;
    this.dispose();
    this.emit('measurementchange', this.measurements);
    this.update({ status: 'empty', filename: '', progress: 0, interactionMode: 'edit-markers', newMarkerType: 'route', markerCount: 0, selectedMarkerId: null });
  }

  async loadFile(file) {
    if (this.destroyed) throw new Error(this.i18n.t('error.controllerDestroyed'));
    if (!file || !/\.(ply|sog)$/i.test(file.name) || !file.size) {
      this.emit('error', { message: this.i18n.t('error.invalidFile') });
      return;
    }
    return this.loadSource({ file, filename: file.name, settings: this.settings });
  }

  async loadUrl(url, { filename, settings = this.settings } = {}) {
    const source = new URL(url, location.href);
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== location.origin) {
      throw new TypeError('Scene URL must use the same origin.');
    }
    filename ??= decodeURIComponent(source.pathname.split('/').pop());
    return this.loadSource({ url: source.href, filename, settings });
  }

  async loadSource({ file, url, filename, settings }) {
    if (this.destroyed) throw new Error(this.i18n.t('error.controllerDestroyed'));
    this.closeScene();
    const generation = this.generation;
    this.update({ status: 'loading', filename, progress: 0 });
    // Serialize device creation. A superseded createViewer must finish and be destroyed
    // before the next instance starts; scene loading itself remains cancellable.
    const task = async () => {
      if (generation !== this.generation) return;
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;inset:0';
      this.container.appendChild(host);
      const session = { host, url: file ? URL.createObjectURL(file) : url, objectUrl: !!file, listeners: [], disposed: false, viewer: null };
      this.session = session;
      const active = () => generation === this.generation && !session.disposed;
      const fail = error => {
        if (!active()) return;
        ++this.generation;
        this.update({ status: 'error' });
        this.emit('error', { message: this.i18n.t('error.loadFile', { filename }), cause: String(error) });
        // Do not tear down the asset registry during its error dispatch.
        setTimeout(() => this.dispose(session), 0);
      };
      try {
        const viewer = await this.createViewer({ container: host, contentUrl: session.url,
          contentFilename: filename, settings, lang: this.i18n.locale, noanim: true,
          renderer: this.renderer, exposeGlobals: false });
        session.viewer = viewer;
        if (!active()) {
          // closeScene may already have disposed the host while initialization was pending.
          viewer.destroy();
          return;
        }
        this.viewer = viewer;
        const listen = (target, event, handler) => {
          target.on(event, handler);
          session.listeners.push(() => target.off(event, handler));
        };
        listen(viewer.app.assets, 'error', fail);
        listen(viewer.events, 'progress:changed', value => {
          if (active()) this.update({ progress: value });
        });
        const ready = () => {
          if (!active() || !viewer.state.loaded || this.orientation) return;
          try {
            this.orientation = new SceneOrientation(viewer);
            this.applyOrientation();
            // A degenerate sampled bound falls back to full resource bounds for sizing.
            const bounds = this.transformation.bounds ?? sceneResourceBounds(viewer);
            session.markers = new SceneMarkers(viewer, bounds, {
              i18n: this.i18n,
              onAdded: marker => {
                if (!active()) return;
                this.update({ markerCount: session.markers.markers.length });
                this.emit('markeradded', marker);
                session.labels?.refresh();
                this.emitMeasurements();
              },
              onChanged: change => {
                if (!active()) return;
                // Selection intent reaches the host before state renders the editor.
                if (change.type === 'selection') this.emit('markerselection', change);
                this.update({ markerCount: session.markers.markers.length, selectedMarkerId: session.markers.selectedId });
                this.emit('markerchange', change);
                this.emitMeasurements();
                session.labels?.refresh();
              },
              onError: error => this.emit('error', { message: this.i18n.t('error.updateMarker'), cause: String(error) })
            });
            session.measurements = new SceneMeasurements(viewer, session.markers.height, () => { if (active()) this.emitMeasurements(); }, this.i18n);
            // Scene labels belong to the same root as the canvas, including native fullscreen.
            const labelHost = viewer.app.graphicsDevice.canvas.parentElement;
            session.distanceLabels = new DistanceLabels(viewer, session.markers, session.measurements, labelHost, this.i18n);
            session.labels = new MarkerLabels(viewer, session.markers, labelHost);
            session.markers.setMode('edit-markers');
            session.cameraDragCursor = new CameraDragCursor(viewer);
            const reveal = () => { if (active()) this.update({ status: 'ready', progress: 100 }); };
            viewer.app.once('frameend', reveal);
            session.listeners.push(() => viewer.app.off('frameend', reveal));
          } catch (error) { fail(error); }
        };
        listen(viewer.events, 'loaded:changed', ready);
        if (viewer.state.loaded) ready();
        // Capture a parser error that happened before the async handle became available.
        for (const asset of viewer.app.assets.list()) {
          if (asset.type === 'gsplat' && asset.loaded && !asset.resource) fail('Scene parser failed.');
        }
      } catch (error) { fail(error); }
    };
    this.queue = this.queue.then(task, task);
    await this.queue;
  }

  applyOrientation() {
    if (!this.orientation) return;
    this.session?.cameraDragCursor?.reset();
    this.session?.markers?.invalidate();
    this.transformation = this.orientation.apply(this.displayRotation, this.autoLevel);
    this.session?.markers?.updateOrientation();
    this.session?.measurements?.updateOrientation();
    this.session?.distanceLabels?.invalidate();
    this.session?.labels?.invalidate();
    this.emit('transformchange', structuredClone(this.transformation));
  }
  fitScene() { if (this.state.status === 'ready') this.viewer?.frameScene(); }
  setDisplayRotation(enabled) { this.displayRotation = !!enabled; this.applyOrientation(); }
  setAutoLevel(enabled) { this.autoLevel = !!enabled; this.applyOrientation(); }
  get markers() { return this.session?.markers?.markers ?? []; }
  setInteractionMode(mode) {
    if (!['add-marker', 'edit-markers', 'calibrate-scale'].includes(mode)) throw new Error(this.i18n.t('error.interactionMode'));
    if (this.state.status !== 'ready' || mode === this.state.interactionMode) return;
    this.session.measurements.cancel();
    this.session.markers.setMode(mode);
    if (mode === 'calibrate-scale') {
      this.session.measurements.begin();
      const measurements = this.session.measurements;
      this.viewer.setPointInteraction((x, y) => { void measurements.pick(x, y); }, 'crosshair');
    }
    this.session.cameraDragCursor?.reset();
    this.session.labels?.refresh();
    this.update({ interactionMode: mode });
  }
  get measurements() {
    const m = this.session?.measurements;
    return m ? { ...m.snapshot, ...m.measure(this.markers) } : { active: false, points: [], calibration: null, message: '', segments: [], totalMeters: null };
  }
  emitMeasurements() { this.session?.distanceLabels?.invalidate(); this.emit('measurementchange', this.measurements); }
  beginScaleCalibration() { this.setInteractionMode('calibrate-scale'); }
  applyScaleCalibration(value) { this.session?.measurements?.apply(value); this.setInteractionMode('edit-markers'); }
  cancelScaleCalibration() { if (this.state.interactionMode === 'calibrate-scale') this.setInteractionMode('edit-markers'); }
  deleteSelectedMarker() { this.session?.markers?.deleteSelected(); }
  deleteRouteMarkers() { this.session?.markers?.deleteRouteMarkers(); }
  clearMarkerSelection() { this.session?.markers?.select(null); }
  updateMarker(id, metadata) { this.session?.markers?.updateMarker(id, metadata); }
  setNewMarkerType(type) {
    if (!['route', 'reference'].includes(type)) throw new TypeError(this.i18n.t('error.markerType'));
    if (this.state.status !== 'ready') return;
    this.session.markers.setNewMarkerType(type);
    this.update({ newMarkerType: type });
  }
  destroy() { this.closeScene(); this.destroyed = true; }
}

function sceneResourceBounds(viewer) {
  const component = viewer.app.root.findComponents('gsplat')[0];
  const bounds = component?.resource?.aabb;
  if (!bounds) return null;
  const lo = bounds.getMin(), hi = bounds.getMax();
  // Only the diagonal is used for marker size. Current display transforms are rotations.
  return { min: [lo.x, lo.y, lo.z], max: [hi.x, hi.y, hi.z] };
}
