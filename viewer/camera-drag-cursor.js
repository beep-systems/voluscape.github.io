// Observe unconsumed mouse gestures; marker capture handlers stop their own input.
export class CameraDragCursor {
  constructor(viewer) {
    this.viewer = viewer;
    this.canvas = viewer.app.graphicsDevice.canvas;
    this.root = this.canvas.ownerDocument.documentElement;
    const window = this.canvas.ownerDocument.defaultView;
    this.listeners = [];
    const listen = (target, name, handler, capture = false) => {
      target.addEventListener(name, handler, capture);
      this.listeners.push(() => target.removeEventListener(name, handler, capture));
    };
    this.reset = () => { this.gesture = null; this.root.removeAttribute('data-camera-dragging'); };
    listen(this.canvas, 'pointerdown', event => {
      if (event.pointerType !== 'mouse' || ![0, 2].includes(event.button) ||
        !['orbit', 'fly'].includes(viewer.state.cameraMode) || !viewer.state.inputEnabled) return;
      this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    listen(window, 'pointermove', event => {
      const gesture = this.gesture;
      if (!gesture || event.pointerId !== gesture.id) return;
      if (!(event.buttons & 3)) { this.reset(); return; }
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3) {
        this.root.setAttribute('data-camera-dragging', '');
      }
    }, true);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      listen(window, name, event => { if (event.pointerId === this.gesture?.id) this.reset(); }, true);
    }
    listen(window, 'blur', this.reset);
    listen(window, 'keydown', event => { if (event.key === 'Escape') this.reset(); }, true);
    for (const name of ['cameraMode:changed', 'inputEnabled:changed']) {
      viewer.events.on(name, this.reset);
      this.listeners.push(() => viewer.events.off(name, this.reset));
    }
  }
  destroy() { this.reset(); this.listeners.splice(0).forEach(remove => remove()); }
}
