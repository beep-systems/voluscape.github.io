// Gallery bridge around the full viewer application.
const notify = (state, controller) => {
  if (window.parent !== window) window.parent.postMessage({
    type: 'voluscape-viewer', state, inputMode: controller?.viewer?.state.inputMode
  }, location.origin);
};
try {
  const { controller } = await import('./app.js');
  let previous = 'empty';
  controller.addEventListener('statechange', ({ detail }) => {
    if (detail.status === previous) return;
    previous = detail.status;
    // The gallery displays gesture hints below the compact touch canvas.
    if (previous === 'ready' && controller.viewer?.state.inputMode === 'touch') {
      document.querySelector('.sse-controlsHintClose')?.click();
    }
    if (previous === 'empty') {
      // Loading a replacement briefly resets the controller to empty.
      queueMicrotask(() => { if (controller.state.status === 'empty') notify('empty', controller); });
    } else if (['ready', 'error'].includes(previous)) notify(previous, controller);
  });
  const content = new URL(location.href).searchParams.get('content');
  if (content) await controller.loadUrl(content);
} catch (error) {
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = 'Unable to load this 3D scene. Close it and retry.';
  document.body.replaceChildren(message);
  notify('error');
}
