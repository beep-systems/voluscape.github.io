import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneController } from '../controller.js';

test('superseded device initialization is destroyed, URLs released, and no globals needed', async context => {
  const previous = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const revoked = [], handles = [], pending = [];
  globalThis.document = { createElement: () => ({ style: {}, remove() { this.removed = true; } }) };
  URL.createObjectURL = file => `blob:${file.name}`;
  URL.revokeObjectURL = url => revoked.push(url);
  context.after(() => { globalThis.document = previous.document; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; });
  const controller = new SceneController({ appendChild() {} }, { createViewer: options => {
    const handle = { destroy() { this.destroyed = true; } };
    handles.push(handle);
    return new Promise(resolve => pending.push(() => resolve(handle)));
  } });
  const first = controller.loadFile({ name: 'first.ply', size: 1 });
  await Promise.resolve();
  controller.closeScene();
  const second = controller.loadFile({ name: 'second.sog', size: 1 });
  pending.shift()(); await first; await Promise.resolve();
  assert.equal(handles[0].destroyed, true);
  controller.closeScene(); pending.shift()(); await second;
  assert.equal(handles[1].destroyed, true);
  assert.deepEqual(revoked, ['blob:first.ply', 'blob:second.sog']);
  assert.equal(controller.viewer, null);
  assert.equal(controller.state.status, 'empty');
  controller.destroy();
  await assert.rejects(controller.loadFile({ name: 'third.ply', size: 1 }), /destroyed/);
});

test('URL replacement shares cancellation, passes settings and never revokes remote URLs', async context => {
  const previous = { document: globalThis.document, location: globalThis.location, revoke: URL.revokeObjectURL };
  const revoked = [], options = [], pending = [];
  globalThis.location = { href: 'https://example.test/preview/viewer/embed.html', origin: 'https://example.test' };
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }) };
  URL.revokeObjectURL = url => revoked.push(url);
  context.after(() => { globalThis.document = previous.document; globalThis.location = previous.location; URL.revokeObjectURL = previous.revoke; });
  const settings = { version: 2 };
  const controller = new SceneController({ appendChild() {} }, { createViewer: value => {
    options.push(value);
    return new Promise(resolve => pending.push(() => resolve({ destroy() {} })));
  } });
  await assert.rejects(controller.loadUrl('https://elsewhere.test/scene.sog'), /same origin/);
  await assert.rejects(controller.loadUrl('javascript:alert(1)'), /same origin/);
  const first = controller.loadUrl('../scenes/first.sog', { settings });
  await Promise.resolve();
  const second = controller.loadUrl('../scenes/second.ply', { filename: 'custom.ply' });
  pending.shift()(); await first; await Promise.resolve();
  controller.closeScene(); pending.shift()(); await second;
  assert.equal(options[0].contentUrl, 'https://example.test/preview/scenes/first.sog');
  assert.equal(options[0].contentFilename, 'first.sog');
  assert.equal(options[0].settings, settings);
  assert.equal(options[1].contentFilename, 'custom.ply');
  assert.deepEqual(revoked, []);
  assert.equal(controller.state.status, 'empty');
  controller.destroy();
  await assert.rejects(controller.loadUrl('../scenes/third.sog'), /destroyed/);
});
