import { estimateLevel, sampleWorldCenters } from './level.js';
import { framingBounds } from './vendor/framing.js';

// Keep the engine's authored transforms. Every change starts from this snapshot.
export class SceneOrientation {
  constructor(viewer) {
    this.viewer = viewer;
    this.items = viewer.app.root.findComponents('gsplat').map(component => ({
      component,
      rotation: component.entity.getRotation().clone(),
      position: component.entity.getPosition().clone()
    }));
  }

  sample() {
    const budget = Math.floor(4000 / Math.max(1, this.items.length));
    return this.items.flatMap(({ component }) => component.resource?.centers
      ? sampleWorldCenters(component.resource.centers, component.entity.getWorldTransform().data, budget)
      : []);
  }

  apply(displayRotation, autoLevel) {
    for (const { component, rotation, position } of this.items) {
      component.entity.setRotation(rotation);
      component.entity.setPosition(position);
      if (displayRotation) component.entity.rotate(270, 0, 0);
    }
    const estimate = estimateLevel(this.sample());
    if (estimate && autoLevel) {
      for (const { component } of this.items) {
        const entity = component.entity;
        const rotation = entity.getRotation().clone();
        const position = entity.getPosition().clone();
        const correction = rotation.clone().set(...estimate.quaternion);
        entity.setRotation(correction.clone().mul(rotation));
        entity.setPosition(correction.transformVector(position));
      }
    }
    const bounds = framingBounds(this.sample());
    this.viewer.frameScene({ bounds, padding: 1.1, immediate: true });
    return {
      displayRotation,
      autoLevel: !!estimate && autoLevel,
      estimate,
      bounds,
      // Per-component column-major source-to-display matrices, including upstream conversion.
      transforms: this.items.map(({ component }) => Array.from(component.entity.getWorldTransform().data))
    };
  }
}
