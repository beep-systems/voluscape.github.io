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
    const held = document.documentElement.hasAttribute('data-compact-menu') || this.controller.state.interactionMode === 'calibrate-scale' || !this.editor.hidden || this.hovered.size > 0 || this.targets.some(target =>
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

// Host-only adaptation; keep the vendor distribution and controller API intact.
export class CompactControls {
  constructor(controller, { t, activity }) {
    this.controller = controller;
    this.t = t;
    this.activity = activity;
    this.find = id => document.getElementById(id);
    this.menu = this.find('compact-menu');
    this.more = this.find('compact-more');
    this.actions = this.find('compact-actions');
    this.compact = false;
    this.removers = [];
    this.homes = ['file-controls', 'orientation-controls', 'route-tools', 'fit-scene'].map(id => {
      const node = this.find(id), anchor = document.createComment('compact control home');
      node.before(anchor);
      return { node, anchor };
    });
    for (const group of this.homes.slice(0, 3)) {
      for (const control of group.node.querySelectorAll('button, label')) {
        const text = document.createElement('span');
        text.className = 'compact-action-label';
        text.textContent = control.getAttribute('aria-label') ?? control.querySelector('input')?.getAttribute('aria-label');
        control.append(text);
      }
    }
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this.removers.push(() => target.removeEventListener(type, handler, options));
    };
    listen(this.more, 'click', () => this.setMenu(this.menu.hidden));
    listen(this.menu, 'click', event => {
      if (event.target.closest('button')) this.setMenu(false, !this.find('delete-route-dialog').open);
    });
    listen(this.menu, 'change', () => this.setMenu(false));
    // Consume the entire dismissal gesture before the canvas/engine sees it.
    listen(window, 'pointerdown', event => {
      if (!this.menu.hidden && !this.menu.contains(event.target) && !this.more.contains(event.target)) {
        event.preventDefault(); event.stopImmediatePropagation();
        this.dismissPointer = event.pointerId;
        this.setMenu(false);
      }
    }, true);
    for (const type of ['pointerup', 'click']) listen(window, type, event => {
      if (this.dismissPointer === undefined) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (type === 'click') this.dismissPointer = undefined;
    }, true);
    listen(window, 'pointercancel', () => { this.dismissPointer = undefined; }, true);
    listen(window, 'keydown', event => {
      if (this.menu.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); this.setMenu(false);
      } else if (this.menu.contains(event.target)) event.stopPropagation();
    }, true);
    listen(this.menu, 'keyup', event => event.stopPropagation());
    listen(this.find('compact-fullscreen'), 'click', async () => {
      try {
        const viewer = controller.viewer;
        if (viewer.state.isFullscreen) await viewer.exitFullscreen();
        else await viewer.requestFullscreen();
      } catch {
        const error = this.find('scene-error');
        error.textContent = t('scene.fullscreenFailed'); error.hidden = false;
      }
      this.update();
    });
    listen(controller, 'statechange', () => {
      if (controller.state.status !== 'ready') this.setMenu(false, false);
      this.update();
    });
    listen(document, 'fullscreenchange', () => { this.setMenu(false, false); this.update(); });
    listen(window, 'resize', () => this.update());
    listen(window, 'scroll', () => this.update(), true);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', () => this.update());
      listen(window.visualViewport, 'scroll', () => this.update());
    }
    this.resize = new ResizeObserver(() => this.update());
    this.resize.observe(controller.container);
    this.observer = new MutationObserver(() => this.update());
    for (const id of ['marker-editor', 'scale-editor']) this.observer.observe(this.find(id), { attributes: true, attributeFilter: ['hidden'] });
    this.update();
  }

  setMenu(open, focus = true) {
    this.menu.hidden = !open;
    this.more.setAttribute('aria-expanded', String(open));
    document.documentElement.toggleAttribute('data-compact-menu', open);
    this.update();
    this.activity();
    if (focus) {
      const target = open ? this.menu.querySelector('button:not(:disabled)') : this.more;
      target?.focus({ preventScroll: true });
    }
  }

  update() {
    const bounds = this.controller.container.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport ? Math.max(bounds.top, viewport.offsetTop) : bounds.top;
    const bottom = viewport ? Math.min(bounds.bottom, viewport.offsetTop + viewport.height) : bounds.bottom;
    const height = Math.max(0, bottom - top);
    const compact = bounds.width <= 600 || bounds.height <= 480;
    const html = document.documentElement;
    html.toggleAttribute('data-compact-ui', compact);
    html.toggleAttribute('data-short-ui', compact && height <= 360);
    html.style.setProperty('--compact-height', `${height}px`);
    html.style.setProperty('--compact-bottom', `${Math.max(0, window.innerHeight - bottom)}px`);
    html.style.setProperty('--compact-left', `${bounds.left}px`);
    html.style.setProperty('--compact-top', `${top}px`);
    html.style.setProperty('--compact-right', `${Math.max(0, window.innerWidth - bounds.right)}px`);
    if (compact !== this.compact) {
      const focused = document.activeElement;
      this.compact = compact;
      this.menu.hidden = true;
      this.more.setAttribute('aria-expanded', 'false');
      html.removeAttribute('data-compact-menu');
      for (const { node, anchor } of this.homes) {
        if (compact) {
          if (node.id === 'fit-scene') this.actions.prepend(node);
          else this.menu.append(node);
        } else anchor.after(node);
      }
      if (focused && focused !== document.body) {
        if (compact && this.menu.contains(focused)) this.more.focus({ preventScroll: true });
        else focused.focus({ preventScroll: true });
      }
    }
    this.actions.hidden = !compact;
    const ready = this.controller.state.status === 'ready';
    if (compact) {
      const files = this.homes[0];
      if (ready && files.node.parentElement !== this.menu) this.menu.prepend(files.node);
      else if (!ready && files.node.parentNode !== files.anchor.parentNode) files.anchor.after(files.node);
    }
    this.find('fit-scene').hidden = compact && !ready;
    this.find('compact-fullscreen').hidden = !ready;
    const editor = !this.find('marker-editor').hidden;
    const scale = !this.find('scale-editor').hidden;
    html.toggleAttribute('data-compact-scale-entry', compact && scale && !this.find('scale-fields').hidden);
    html.toggleAttribute('data-compact-editor', compact && editor);
    html.toggleAttribute('data-compact-panel', compact && (editor || scale || !this.menu.hidden));
    const controls = this.controller.container.querySelector('.sse-controlsWrap');
    if (this.bottomControls && this.bottomControls !== controls) this.bottomControls.inert = this.bottomWasInert;
    if (controls !== this.bottomControls) {
      this.bottomControls = controls;
      this.bottomWasInert = controls?.inert ?? false;
    }
    if (controls) controls.inert = this.bottomWasInert || (compact && (editor || scale || !this.menu.hidden));
    const label = this.t(this.controller.viewer?.state.isFullscreen ? 'scene.exitFullscreen' : 'scene.fullscreen');
    this.find('compact-fullscreen').setAttribute('aria-label', label);
    this.find('compact-fullscreen').title = label;
  }

  destroy() {
    this.resize.disconnect(); this.observer.disconnect();
    this.removers.splice(0).forEach(remove => remove());
    for (const { node, anchor } of this.homes) { anchor.after(node); anchor.remove(); }
    for (const label of document.querySelectorAll('.compact-action-label')) label.remove();
    if (this.bottomControls) this.bottomControls.inert = this.bottomWasInert;
    for (const name of ['data-compact-ui', 'data-short-ui', 'data-compact-menu', 'data-compact-editor', 'data-compact-panel', 'data-compact-scale-entry']) document.documentElement.removeAttribute(name);
    for (const name of ['--compact-height', '--compact-bottom', '--compact-left', '--compact-right', '--compact-top']) document.documentElement.style.removeProperty(name);
  }
}
