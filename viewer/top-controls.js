// Follow the upstream controls' timer and fade classes; never run a second timer.
export class TopControls {
  constructor(controller, { tools, toolbar, summary, editor, calibration, dialog }) {
    this.controller = controller;
    this.panels = [tools, toolbar, summary].filter(Boolean);
    this.targets = [...this.panels, editor, calibration].filter(Boolean);
    this.editor = editor;
    this.viewer = null;
    this.controls = null;
    this.held = false;
    this.hovered = new Set();
    this.removers = [];
    // Keep the same nodes (and drafts/listeners) inside the browser's top layer.
    this.overlays = [tools, toolbar?.parentElement, dialog].filter(Boolean).map(node => {
      const anchor = document.createComment('fullscreen overlay home');
      node.before(anchor);
      return { node, anchor };
    });
    this.observer = new MutationObserver(() => this.sync());
    this.editorObserver = new MutationObserver(() => this.sync());
    this.editorObserver.observe(editor, { attributes: true, attributeFilter: ['hidden'] });
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      this.removers.push(() => target.removeEventListener(type, handler));
    };
    listen(controller, 'statechange', () => this.sync());
    listen(controller, 'viewerdispose', () => {
      this.disposingViewer = controller.viewer;
      this.moveOverlays(null);
    });
    // Native fullscreen may blur a host field before fullscreenchange arrives.
    listen(document, 'focusin', event => {
      if (event.target === document.body || event.target === document.fullscreenElement) return;
      this.focusedOverlay = this.overlays.some(({ node }) => node.contains(event.target)) ? event.target : null;
    });
    listen(document, 'fullscreenchange', () => {
      this.sync();
      this.activity();
    });
    for (const target of this.targets) {
      listen(target, 'pointerenter', event => {
        if (event.pointerType === 'mouse') this.hovered.add(target);
        this.activity();
      });
      listen(target, 'pointerleave', () => { this.hovered.delete(target); this.activity(); });
      for (const type of ['pointerdown', 'click', 'input', 'focusin']) {
        listen(target, type, () => this.activity());
      }
      listen(target, 'focusout', () => queueMicrotask(() => this.sync()));
    }
    // Tab must restore hidden buttons before the browser chooses its focus target.
    listen(document, 'keydown', event => { if (event.key === 'Tab') this.activity(); });
    this.sync();
  }

  activity() {
    this.controller.viewer?.events.fire('inputEvent', 'uiActivity');
    this.sync();
  }

  moveOverlays(destination) {
    const active = document.activeElement;
    const focused = destination && (active === document.body || active === destination)
      ? this.focusedOverlay ?? active : active;
    const restoreFocus = this.overlays.some(({ node }) => node.contains(focused));
    let moved = false;
    for (const { node, anchor } of this.overlays) {
      const parent = destination ?? anchor.parentNode;
      if (node.parentNode !== parent) {
        if (destination) destination.appendChild(node);
        else anchor.after(node);
        moved = true;
      }
    }
    if (moved && restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
  }

  sync() {
    const viewer = this.controller.state.status === 'ready' && this.controller.viewer !== this.disposingViewer ? this.controller.viewer : null;
    const root = viewer ? this.controller.container.querySelector('.sse-viewer') : null;
    this.moveOverlays(root && document.fullscreenElement === root ? root : null);
    if (viewer !== this.viewer) {
      this.observer.disconnect();
      this.viewer = viewer;
      this.controls = viewer ? this.controller.container.querySelector('.sse-controlsWrap') : null;
      if (this.controls) this.observer.observe(this.controls, { attributes: true, attributeFilter: ['class'] });
    }
    // Touch browsers can leave :hover sticky after a tap; only mouse hover holds UI.
    // Hiding/reparenting UI can omit pointerleave; retain only actual mouse hover.
    for (const target of this.hovered) if (target.hidden || !target.isConnected || !target.matches(':hover')) this.hovered.delete(target);
    const held = this.controller.state.interactionMode === 'calibrate-scale' || !this.editor.hidden || this.hovered.size > 0 || this.targets.some(target =>
      target.contains(document.activeElement) && document.activeElement.matches(':focus-visible'));
    const released = this.held && !held;
    this.held = held;
    if (released) this.viewer?.events.fire('inputEvent', 'uiActivity');
    const hidden = !!this.controls && !held && this.controls.classList.contains('sse-faded-out');
    const dimmed = !!this.controls && !held && this.controls.classList.contains('sse-dimmed');
    for (const panel of this.panels) {
      panel.classList.toggle('top-faded-out', hidden);
      panel.classList.toggle('top-dimmed', dimmed && !hidden);
      panel.inert = hidden;
    }
  }

  destroy() {
    for (const { node, anchor } of this.overlays) {
      anchor.after(node);
      anchor.remove();
    }
    this.observer.disconnect();
    this.editorObserver.disconnect();
    this.removers.splice(0).forEach(remove => remove());
    for (const panel of this.panels) {
      panel.classList.remove('top-faded-out', 'top-dimmed');
      panel.inert = false;
    }
  }
}
