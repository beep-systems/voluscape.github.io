import { english } from './i18n.js';
import { MarkerLabels } from './marker-labels.js';

// Reuse the existing visibility policy, with passive labels and world-space midpoints.
export class DistanceLabels {
  constructor(viewer, markers, measurements, host, i18n = english) {
    const model = {
      mode: 'calibrate-scale',
      get items() {
        const result = measurements.visuals.map((visual, i) => ({ visual, record: { id: `cal-${i}`, name: i ? 'B' : 'A' } }));
        const lengths = measurements.measure(markers.markers).segments;
        if (measurements.calibration) for (const connection of markers.connections) {
          const a = connection.fromMarker.record.id, b = connection.toMarker.record.id;
          const length = lengths.find(s => s.fromId === a && s.toId === b);
          if (!length) continue;
          result.push({ record: { id: `${a}-${b}`, name: i18n.t('scale.segmentLength', { distance: i18n.formatNumber(length.meters, 2) }) },
            visual: { screenPosition() {
              if (!connection.entity.enabled) return null;
              const camera = viewer.app.root.findComponents('camera')[0];
              const point = connection.entity.getPosition();
              const depth = point.clone().sub(camera.entity.getPosition()).dot(camera.entity.forward);
              if (depth <= camera.nearClip) return null;
              const screen = camera.worldToScreen(point);
              return { x: screen.x, y: screen.y, depth };
            } } });
        }
        return result;
      }
    };
    this.labels = new MarkerLabels(viewer, model, host);
    this.labels.layer.className = 'distance-labels';
  }
  invalidate() { this.labels.invalidate(); this.labels.refresh(); }
  destroy() { this.labels.destroy(); }
}
