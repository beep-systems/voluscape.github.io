import { english } from './i18n.js';
// Metric calibration owns only temporary visuals and scene-local measurement state.
export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export function parseMeters(value, i18n = english) {
  const text = String(value).trim();
  const number = /^[+]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text) ? Number(text.replace(',', '.')) : NaN;
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(i18n.t('error.positiveDistance'));
  return number;
}
export class SceneMeasurements {
  constructor(viewer, height, changed = () => {}, i18n = english) {
    this.i18n = i18n; this.viewer = viewer; this.height = height; this.changed = changed;
    this.points = []; this.visuals = []; this.calibration = null;
    this.active = false; this.epoch = 0; this.busy = false; this.destroyed = false; this.message = '';
  }
  get snapshot() {
    return structuredClone({ active: this.active, points: this.points, calibration: this.calibration, message: this.message });
  }
  measure(markers) {
    const route = markers.filter(m => m.type === 'route'), segments = [];
    for (let i = 1; i < route.length; i++) segments.push({ fromId: route[i - 1].id, toId: route[i].id,
      meters: this.calibration ? distance(route[i - 1].anchor.position, route[i].anchor.position) * this.calibration.metersPerUnit : null });
    return { segments, totalMeters: this.calibration ? segments.reduce((sum, s) => sum + s.meters, 0) : null };
  }
  begin() { this.cancel(); this.active = true; this.changed(); }
  clearVisuals() {
    this.connection?.destroy(); this.connection = null;
    this.visuals.splice(0).forEach(v => v.destroy()); this.points = [];
  }
  cancel() {
    ++this.epoch; this.busy = false; this.active = false; this.message = '';
    this.clearVisuals(); this.changed();
  }
  invalidate() { ++this.epoch; this.busy = false; }
  async pick(x, y) {
    if (!this.active || this.busy || this.points.length === 2 || this.destroyed) return;
    const epoch = this.epoch; this.busy = true;
    let visual;
    try {
      const hit = await this.viewer.pickSurface(x, y);
      if (epoch !== this.epoch || !this.active || this.destroyed || !hit) return;
      if (hit.position?.length !== 3 || !hit.position.every(Number.isFinite)) return;
      visual = this.viewer.createMarkerVisual({ ...hit, height: this.height, color: [1, 1, 0] });
      const anchor = structuredClone(visual.anchor);
      if (this.points.length && distance(this.points[0].position, anchor.position) <= 1e-8) {
        visual.destroy(); visual = null; this.message = this.i18n.t('error.differentPointB'); this.changed(); return;
      }
      if (this.points.length) this.connection = this.viewer.createMarkerConnection({ from: this.visuals[0], to: visual, height: this.height, color: [1, 1, 0] });
      this.visuals.push(visual); this.points.push(anchor); visual = null; this.message = ''; this.changed();
    } catch {
      visual?.destroy();
      if (epoch === this.epoch && !this.destroyed) { this.message = this.i18n.t('error.pickSurface'); this.changed(); }
    } finally { if (epoch === this.epoch) this.busy = false; }
  }
  apply(value) {
    if (!this.active || this.points.length !== 2) throw new Error(this.i18n.t('error.chooseCalibrationPoints'));
    const meters = parseMeters(value, this.i18n), units = distance(this.points[0].position, this.points[1].position);
    const metersPerUnit = meters / units;
    if (!(units > 1e-8) || !Number.isFinite(metersPerUnit) || metersPerUnit <= 0) throw new TypeError(this.i18n.t('error.calibrationDistance'));
    this.calibration = { points: structuredClone(this.points), meters, metersPerUnit };
    this.cancel();
  }
  updateOrientation() { this.invalidate(); this.visuals.forEach(v => v.alignToSceneUp()); this.connection?.update(); }
  destroy() { this.destroyed = true; this.cancel(); this.calibration = null; }
}
