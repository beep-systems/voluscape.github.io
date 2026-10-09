import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDragCursor } from '../camera-drag-cursor.js';

function setup() {
  const window = new EventTarget(), canvas = new EventTarget(), attributes = new Set(), events = new Map();
  canvas.ownerDocument = { defaultView: window, documentElement: {
    setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name)
  } };
  const viewer = { app: { graphicsDevice: { canvas } }, state: { cameraMode: 'orbit', inputEnabled: true },
    events: { on: (name, callback) => events.set(name, callback), off: name => events.delete(name) } };
  const cursor = new CameraDragCursor(viewer);
  const send = (target, name, patch = {}) => {
    const event = new Event(name);
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 10, clientY: 10 }, patch);
    target.dispatchEvent(event);
  };
  return { cursor, window, canvas, viewer, events, send, hidden: () => attributes.has('data-camera-dragging') };
}

test('camera cursor hides only during LMB/RMB mouse movement in Orbit/Fly and restores on release', () => {
  const c = setup();
  for (const mode of ['orbit', 'fly']) for (const button of [0, 2]) {
    c.viewer.state.cameraMode = mode;
    c.send(c.canvas,'pointerdown',{button}); assert.equal(c.hidden(),false);
    c.send(c.window,'pointermove',{clientX:12}); assert.equal(c.hidden(),false);
    c.send(c.window,'pointermove',{clientX:20,buttons:button===0?1:2}); assert.equal(c.hidden(),true);
    c.send(c.window,'pointerup'); assert.equal(c.hidden(),false);
  }
  for (const patch of [{pointerType:'touch'},{button:1}]) {
    c.send(c.canvas,'pointerdown',patch); c.send(c.window,'pointermove',{clientX:20}); assert.equal(c.hidden(),false);
  }
  c.viewer.state.cameraMode='walk';
  c.send(c.canvas,'pointerdown'); c.send(c.window,'pointermove',{clientX:20}); assert.equal(c.hidden(),false);
  c.cursor.destroy();
});

test('camera cursor restores on cancellation, mode/input changes, blur, escape and disposal', () => {
  const c=setup();
  for (const reset of [()=>c.send(c.window,'pointercancel'),()=>c.send(c.window,'lostpointercapture'),
    ()=>c.send(c.window,'blur'),()=>c.send(c.window,'keydown',{key:'Escape'}),
    ()=>c.send(c.window,'pointermove',{buttons:0}),()=>c.events.get('cameraMode:changed')(),
    ()=>c.events.get('inputEnabled:changed')(),()=>c.cursor.destroy()]) {
    c.send(c.canvas,'pointerdown');c.send(c.window,'pointermove',{clientX:20});assert.equal(c.hidden(),true);
    c.send(c.window,'pointerup',{pointerId:2});assert.equal(c.hidden(),true);
    reset();assert.equal(c.hidden(),false);
  }
  assert.equal(c.events.size,0);
  c.send(c.canvas,'pointerdown');c.send(c.window,'pointermove',{clientX:20});assert.equal(c.hidden(),false);
});
