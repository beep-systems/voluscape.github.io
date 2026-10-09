// Screen-space text with the same approximate splat occlusion policy as upstream annotations.
export class MarkerLabels {
  constructor(viewer, markers, host) {
    this.viewer = viewer; this.markers = markers; this.host = host;
    this.layer = document.createElement('div'); this.layer.className = 'marker-labels';
    host.append(this.layer);
    this.onPointerDown = event => {
      if (this.destroyed || this.markers.mode !== 'edit-markers') return;
      const label = event.target.closest('.marker-label');
      if (!label || label.hidden || this.labels.get(Number(label.dataset.markerId)) !== label) return;
      this.markers.handlePointer(event, Number(label.dataset.markerId));
    };
    this.onDoubleClick = event => {
      if (this.markers.mode === 'edit-markers') { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    this.layer.addEventListener('pointerdown', this.onPointerDown);
    this.layer.addEventListener('dblclick', this.onDoubleClick);
    this.labels = new Map(); this.epoch = 0; this.signature = null; this.destroyed = false;
    this.onFrame = () => this.refresh();
    viewer.app.on('frameend', this.onFrame);
  }
  refresh() {
    if (this.destroyed) return;
    this.layer.dataset.mode = this.markers.mode;
    const canvas = this.viewer.app.graphicsDevice.canvas, rect = canvas.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const named = this.markers.items.filter(item => item.record.name.trim());
    const ids = new Set(named.map(item => item.record.id));
    for (const [id, label] of this.labels) if (!ids.has(id)) { label.remove(); this.labels.delete(id); }
    const targets = [];
    for (const item of named) {
      let label = this.labels.get(item.record.id);
      if (!label) {
        label = document.createElement('span'); label.className = 'marker-label'; label.dataset.markerId = item.record.id;
        label.hidden = true; this.layer.append(label); this.labels.set(item.record.id, label);
      }
      label.textContent = item.record.name;
      const screen = item.visual.screenPosition();
      if (screen && screen.x >= 0 && screen.x < rect.width && screen.y >= 0 && screen.y < rect.height) {
        label.style.left = `${screen.x + rect.left - hostRect.left}px`;
        label.style.top = `${screen.y + rect.top - hostRect.top}px`;
        targets.push({ label, screen, id: item.record.id });
      } else label.hidden = true;
    }
    const camera = this.viewer.app.root.findComponents('camera')[0];
    const signature = JSON.stringify([rect.width, rect.height, rect.left, rect.top,
      Array.from(camera.entity.getWorldTransform().data), Array.from(camera.projectionMatrix.data),
      named.map(item => [item.record.id, item.record.name, item.visual.screenPosition()])]);
    if (signature === this.signature) return;
    this.signature = signature;
    const epoch = ++this.epoch;
    clearTimeout(this.timer);
    for (const label of this.labels.values()) label.hidden = true;
    if (!targets.length) return;
    this.timer = setTimeout(async () => {
      try {
        const opacity = await this.viewer.pickVisibility(targets.map(({ screen }) => ({
          x: screen.x / rect.width, y: screen.y / rect.height, depth: screen.depth * .9
        })), 13 / rect.height);
        if (this.destroyed || epoch !== this.epoch) return;
        targets.forEach(({ label }, index) => { label.hidden = opacity[index] == null || opacity[index] >= .5; });
      } catch { /* Keep labels hidden until another scene/view change allows a fresh test. */ }
    }, 150);
  }
  invalidate() { this.signature = null; ++this.epoch; clearTimeout(this.timer); for (const label of this.labels.values()) label.hidden = true; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.invalidate();
    this.viewer.app.off('frameend', this.onFrame);
    this.layer.removeEventListener('pointerdown', this.onPointerDown);
    this.layer.removeEventListener('dblclick', this.onDoubleClick);
    this.labels.clear(); this.layer.remove();
  }
}
