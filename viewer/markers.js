import { english } from './i18n.js';
// Session-only marker ownership; picking and primitive creation use the engine bridge.
export const markerPalette = Object.freeze([
  ['red', '#ff0805'], ['blue', '#2080ff'],
  ['yellow', '#ffff00'], ['green', '#40ff40'],
  ['magenta', '#ff00ff'], ['white', '#ffffff']
].map(([id, hex]) => Object.freeze({ id, name: english.t(`color.${id}`), hex,
  rgb: Object.freeze([1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)) })));
const colorValue = id => markerPalette.find(color => color.id === id)?.rgb;

// Screen interpolation must be corrected for perspective before interpolating world positions.
export function hitMarkerSegment(segment, x, y, radius = 8) {
  if (!segment) return null;
  const { a, b, perspective } = segment;
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  if (!(length2 > 1e-8)) return null;
  const s = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2));
  const distance = Math.hypot(x - a.x - s * dx, y - a.y - s * dy);
  if (distance > radius) return null;
  const t = perspective ? s * a.depth / ((1 - s) * b.depth + s * a.depth) : s;
  return { distance, depth: a.depth + t * (b.depth - a.depth),
    position: a.position.map((value, axis) => value + t * (b.position[axis] - value)) };
}

export class SceneMarkers {
  constructor(viewer, bounds, { onAdded = () => {}, onChanged = () => {}, onError = () => {}, i18n = english } = {}) {
    this.viewer = viewer;
    this.i18n = i18n;
    this.onAdded = onAdded;
    this.onChanged = onChanged;
    this.onError = onError;
    this.height = bounds ? Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis])) * .01 : 0;
    this.items = [];
    this.connections = [];
    this.epoch = 0;
    this.mode = 'edit-markers';
    this.newMarkerType = 'route';
    this.destroyed = false;
    this.nextId = 1;
    this.selectedId = null;
    this.moveRequest = 0;
    this.blockedPointers = new Set();
    this.canvas = viewer.app?.graphicsDevice.canvas;
    this.listeners = [];
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'dblclick']) {
      const handler = event => this.handlePointer(event);
      this.canvas?.addEventListener(name, handler, true);
      this.listeners.push([name, handler]);
    }
    this.pickPoint = (x, y) => { void this.addAt(x, y); };
  }

  get markers() { return this.items.map(({ record }) => structuredClone(record)); }
  setDragCursor(hidden) {
    this.canvas?.ownerDocument?.documentElement.toggleAttribute('data-marker-dragging', hidden);
  }
  invalidate() {
    ++this.epoch;
    ++this.moveRequest;
    this.setDragCursor(false);
    if (this.drag) {
      const id = this.drag.pointerId;
      this.drag = null;
      if (this.canvas?.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    }
  }
  select(id, source = 'manual') {
    const selectedId = this.items.some(item => item.record.id === id) ? id : null;
    if (selectedId === this.selectedId && selectedId === null) return;
    this.selectedId = selectedId;
    for (const { visual, record } of this.items) visual.setSelected(record.id === this.selectedId);
    this.onChanged({ type: 'selection', id: this.selectedId, source });
  }
  // Labels supply their ID; subsequent events share the canvas capture lifecycle.
  beginDrag(event, item, fromLabel = false) {
    this.invalidate();
    this.select(item?.record.id ?? null);
    if (!item) return false;
    const rect = this.canvas.getBoundingClientRect();
    const point = fromLabel ? item.visual.screenPosition() : null;
    this.drag = { pointerId: event.pointerId, id: item.record.id, x: event.clientX, y: event.clientY, moved: false,
      offsetX: point ? point.x + rect.left - event.clientX : 0,
      offsetY: point ? point.y + rect.top - event.clientY : 0 };
    this.canvas.setPointerCapture(event.pointerId);
    return true;
  }
  handlePointer(event, markerId) {
    if (this.destroyed || this.mode !== 'edit-markers') return;
    if (this.blockedPointers.has(event.pointerId)) {
      if (event.type === 'pointerup' || event.type === 'pointercancel') this.blockedPointers.delete(event.pointerId);
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event.type === 'dblclick') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.button === 0 && markerId === undefined) this.insertAt(event.clientX, event.clientY);
      return;
    }
    if (event.type === 'pointerdown') {
      if (this.drag) {
        this.blockedPointers.add(event.pointerId);
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (event.button !== 0) return;
      let item;
      if (markerId !== undefined) {
        item = this.items.find(item => item.record.id === markerId);
        if (!item) return;
      } else {
        const rect = this.canvas.getBoundingClientRect();
        const radius = event.pointerType === 'touch' ? 24 : 14;
        const candidates = this.items.map(item => ({ item, point: item.visual.screenPosition() }))
          .filter(({ point }) => point && Math.hypot(point.x + rect.left - event.clientX, point.y + rect.top - event.clientY) <= radius)
          .sort((a, b) => a.point.depth - b.point.depth);
        item = candidates[0]?.item;
      }
      if (!this.beginDrag(event, item, markerId !== undefined)) return;
    } else {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      if (event.type === 'pointermove' || event.type === 'pointerup') {
        const drag = this.drag;
        drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3;
        if (drag.moved) {
          this.setDragCursor(true);
          const rect = this.canvas.getBoundingClientRect();
          void this.moveAt(drag.id, (event.clientX + drag.offsetX - rect.left) / rect.width, (event.clientY + drag.offsetY - rect.top) / rect.height);
        }
        if (event.type === 'pointerup') {
          this.drag = null;
          this.setDragCursor(false);
          this.canvas.releasePointerCapture(event.pointerId);
        }
      } else this.invalidate();
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  async moveAt(id, x, y) {
    if (this.destroyed || this.mode !== 'edit-markers') return;
    const epoch = this.epoch, request = ++this.moveRequest;
    try {
      const hit = await this.viewer.pickSurface(x, y);
      if (this.destroyed || epoch !== this.epoch || request !== this.moveRequest || this.mode !== 'edit-markers') return;
      const item = this.items.find(item => item.record.id === id);
      if (!item || !hit || hit.position?.length !== 3 || !hit.position.every(Number.isFinite)) return;
      item.visual.moveTo(hit);
      item.record.anchor = structuredClone(item.visual.anchor);
      for (const connection of this.connections) connection.update();
      this.onChanged({ type: 'moved', marker: structuredClone(item.record) });
    } catch (error) {
      if (!this.destroyed && epoch === this.epoch && request === this.moveRequest) this.onError(error);
    }
  }
  deleteSelected() {
    const index = this.items.findIndex(item => item.record.id === this.selectedId);
    if (this.destroyed || index < 0) return;
    // Build the replacement chain before disposing any material-owning pin.
    const remaining = this.items.filter((_, i) => i !== index), replacement = [];
    try {
      const route = remaining.filter(item => item.record.type === 'route');
      for (let i = 1; i < route.length; ++i) replacement.push(this.connect(route[i - 1], route[i]));
    } catch (error) {
      for (const connection of replacement) connection.destroy();
      this.onError(error); return;
    }
    this.invalidate();
    for (const connection of this.connections) connection.destroy();
    this.connections = replacement;
    const [removed] = this.items.splice(index, 1);
    removed.visual.destroy();
    this.selectedId = null;
    this.onChanged({ type: 'removed', marker: structuredClone(removed.record) });
  }
  deleteRouteMarkers() {
    if (this.destroyed) return;
    this.invalidate();
    const removed = this.items.filter(item => item.record.type === 'route');
    if (!removed.length) return;
    for (const connection of this.connections) connection.destroy();
    this.connections = [];
    this.items = this.items.filter(item => item.record.type !== 'route');
    if (removed.some(item => item.record.id === this.selectedId)) this.selectedId = null;
    for (const item of removed) item.visual.destroy();
    this.onChanged({ type: 'route-cleared', ids: removed.map(item => item.record.id) });
  }
  connect(from, to) {
    const connection = this.viewer.createMarkerConnection({ from: from.visual, to: to.visual, height: this.height,
      color: colorValue(from.record.color === to.record.color ? from.record.color : 'red') });
    connection.fromMarker = from; connection.toMarker = to;
    return connection;
  }
  insertAt(clientX, clientY) {
    if (this.destroyed || this.mode !== 'edit-markers' || this.drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    if (this.items.some(({ visual }) => {
      const point = visual.screenPosition();
      return point && Math.hypot(point.x - x, point.y - y) <= 14;
    })) return;
    const candidates = this.connections.map(connection => ({ connection,
      hit: hitMarkerSegment(connection.screenSegment(), x, y) }))
      .filter(candidate => candidate.hit)
      .sort((a, b) => a.hit.distance - b.hit.distance || a.hit.depth - b.hit.depth);
    const candidate = candidates[0];
    if (!candidate) return;
    const { connection, hit } = candidate;
    const color = connection.fromMarker.record.color === connection.toMarker.record.color ? connection.fromMarker.record.color : 'red';
    const replacements = [];
    let visual, item;
    try {
      const position = [...hit.position];
      position[1] -= .8 * this.height;
      visual = this.viewer.createMarkerVisual({ position, normal: [0, 0, 0], height: this.height, color: colorValue(color) });
      const record = { id: this.nextId, anchor: structuredClone(visual.anchor), height: this.height,
        color, note: '', type: 'route', name: '' };
      item = { visual, record };
      replacements.push(this.connect(connection.fromMarker, item));
      replacements.push(this.connect(item, connection.toMarker));
    } catch (error) {
      for (const replacement of replacements) replacement.destroy();
      visual?.destroy();
      this.onError(error);
      return;
    }
    this.invalidate();
    this.items.splice(this.items.indexOf(connection.toMarker), 0, item);
    this.connections.splice(this.connections.indexOf(connection), 1, ...replacements);
    ++this.nextId;
    connection.destroy();
    this.select(item.record.id, 'creation');
    this.onAdded(structuredClone(item.record));
  }
  updateMarker(id, patch) {
    const item = this.items.find(item => item.record.id === id);
    if (this.destroyed || !item) return;
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !['color', 'note', 'type', 'name'].includes(key))) throw new TypeError(this.i18n.t('error.markerMetadata'));
    if ('color' in patch && !colorValue(patch.color) || 'note' in patch && typeof patch.note !== 'string' ||
      'name' in patch && typeof patch.name !== 'string' || 'type' in patch && !['route', 'reference'].includes(patch.type)) throw new TypeError(this.i18n.t('error.markerMetadata'));
    const previous = item.record;
    const record = { ...previous, ...patch };
    if ('name' in patch) record.name = record.name.trim();
    if (record.type === 'reference' && !record.name) record.name = this.i18n.t('marker.defaultReferenceName', { id: this.i18n.formatNumber(record.id) });
    item.record = record;
    if (record.type !== previous.type) {
      const replacement = [], route = this.items.filter(item => item.record.type === 'route');
      try {
        for (let i = 1; i < route.length; ++i) replacement.push(this.connect(route[i - 1], route[i]));
      } catch (error) {
        item.record = previous;
        for (const connection of replacement) connection.destroy();
        throw error;
      }
      this.invalidate();
      for (const connection of this.connections) connection.destroy();
      this.connections = replacement;
    }
    if ('color' in patch) item.visual.setColor(colorValue(record.color));
    for (const connection of this.connections) {
      const a = connection.fromMarker.record.color, b = connection.toMarker.record.color;
      connection.setColor(colorValue(a === b ? a : 'red'));
    }
    this.onChanged({ type: 'metadata', marker: structuredClone(item.record) });
  }
  updateOrientation() {
    for (const { visual } of this.items) visual.alignToSceneUp();
    for (const connection of this.connections) connection.update();
  }
  setMode(mode) {
    if (!['edit-markers', 'add-marker', 'calibrate-scale'].includes(mode)) throw new Error(this.i18n.t('error.interactionMode'));
    if (this.destroyed) return;
    this.invalidate();
    this.blockedPointers.clear();
    this.mode = mode;
    if (mode === 'add-marker') this.select(null);
    this.viewer.setPointInteraction(mode === 'add-marker' ? this.pickPoint : mode === 'edit-markers' ? () => {} : null,
      mode === 'edit-markers' ? 'pointer' : 'crosshair');
  }
  setNewMarkerType(type) {
    if (!['route', 'reference'].includes(type)) throw new TypeError(this.i18n.t('error.markerType'));
    this.newMarkerType = type;
  }

  async addAt(x, y) {
    if (this.destroyed || this.mode !== 'add-marker') return;
    const epoch = this.epoch;
    const type = this.newMarkerType;
    try {
      const hit = await this.viewer.pickSurface(x, y);
      if (this.destroyed || epoch !== this.epoch || this.mode !== 'add-marker' || !hit) return;
      if (hit.position?.length !== 3 || !hit.position.every(Number.isFinite)) return;
      if (!(this.height > 0)) throw new Error(this.i18n.t('error.markerBounds'));
      const visual = this.viewer.createMarkerVisual({ ...hit, height: this.height, color: colorValue('red') });
      const record = { id: this.nextId, anchor: structuredClone(visual.anchor), height: this.height, color: 'red', note: '',
        type, name: type === 'reference' ? this.i18n.t('marker.defaultReferenceName', { id: this.i18n.formatNumber(this.nextId) }) : '' };
      const item = { visual, record };
      const previous = record.type === 'route' ? this.items.findLast(item => item.record.type === 'route') : null;
      if (previous) {
        try {
          this.connections.push(this.connect(previous, item));
        } catch (error) {
          visual.destroy();
          throw error;
        }
      }
      ++this.nextId;
      this.items.push(item);
      this.select(record.id, 'creation');
      this.onAdded(structuredClone(record));
    } catch (error) {
      if (!this.destroyed && epoch === this.epoch) this.onError(error);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidate();
    this.viewer.setPointInteraction(null);
    for (const [name, handler] of this.listeners) this.canvas?.removeEventListener(name, handler, true);
    for (const connection of this.connections) connection.destroy();
    this.connections.length = 0;
    for (const { visual } of this.items) visual.destroy();
    this.items.length = 0;
    this.blockedPointers.clear();
    this.listeners.length = 0;
  }
}
