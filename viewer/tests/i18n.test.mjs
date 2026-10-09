import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import en from '../locales/en.js';
import { createI18n, resolveLocale, applyTranslations, english } from '../i18n.js';
import { SceneController } from '../controller.js';
import { SceneMeasurements, parseMeters } from '../measurements.js';
import { SceneMarkers, markerPalette } from '../markers.js';

const dictionaries = { en, de: {
  'scene.open': 'Test öffnen', 'error.invalidFile': 'Test Datei',
  'error.loadFile': 'Test Fehler {filename}', 'error.positiveDistance': 'Test Abstand',
  'error.differentPointB': 'Test anderer B', 'error.pickSurface': 'Test Oberfläche',
  'error.chooseCalibrationPoints': 'Test A und B', 'error.calibrationDistance': 'Test Kalibrierung',
  'marker.defaultReferenceName': 'Test Punkt {id}'
}, 'pt-BR': {} };

test('locale choice is explicit, case insensitive, uses base tags and English fallback', () => {
  for (const language of [undefined, null, '', 'ru', 'de', 'toString']) assert.equal(createI18n(language).locale, 'en');
  assert.equal(resolveLocale('DE-de', dictionaries), 'de');
  assert.equal(resolveLocale(' PT-br ', dictionaries), 'pt-BR');
  assert.equal(resolveLocale('pt', dictionaries), 'en');
  assert.equal(createI18n().locale, 'en');
});

test('lookup falls back per key and interpolation preserves parameters as literal text', () => {
  const i18n = createI18n('de', dictionaries);
  assert.equal(i18n.t('scene.open'), 'Test öffnen');
  assert.equal(i18n.t('action.save'), 'Save');
  assert.equal(i18n.t('unknown.key'), 'unknown.key');
  assert.equal(i18n.t('toString'), 'toString');
  const filename = '<img src=x onerror=alert(1)>$&{count}';
  assert.equal(i18n.t('error.loadFile', { filename }), `Test Fehler ${filename}`);
  assert.equal(i18n.t('error.loadFile'), 'Test Fehler {filename}');
  assert.equal(i18n.formatNumber(1234.5, 2), '1234,50');
  assert.equal(english.formatNumber(1234.5, 2), '1234.50');
  assert.equal(english.formatNumber(5), '5');
});

test('declarative attribute translations preserve icon children and use textContent', () => {
  const icon = { name: 'svg' };
  const button = { children: [icon], attrs: { 'data-i18n-title': 'scene.open', 'data-i18n-aria-label': 'scene.open' },
    getAttribute(name) { return this.attrs[name] ?? null; }, setAttribute(name, value) { this.attrs[name] = value; } };
  const label = { ...button, attrs: { 'data-i18n': 'scene.empty' }, children: [], textContent: '' };
  const i18n = createI18n('de', { de: { 'scene.empty': '<b>Test text</b>' }, en });
  applyTranslations({ querySelectorAll: () => [button, label] }, i18n);
  assert.deepEqual(button.children, [icon]);
  assert.equal(button.attrs.title, 'Open scene');
  assert.equal(button.attrs['aria-label'], 'Open scene');
  assert.equal(label.textContent, '<b>Test text</b>');
});

test('all declarative translation keys and palette names exist in the English locale', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g)) assert.equal(typeof en[key], 'string', key);
  for (const color of markerPalette) assert.equal(color.name, en[`color.${color.id}`]);
  for (const name of ['app', 'controller', 'markers', 'measurements', 'distance-labels']) {
    const source = await readFile(new URL(`../${name}.js`, import.meta.url), 'utf8');
    for (const [, key] of source.matchAll(/\bt\('([^']+)'/g)) assert.equal(typeof en[key], 'string', `${name}: ${key}`);
  }
  assert.equal(Object.values(en).every(value => typeof value === 'string'), true);
});

test('controller localizes own errors and passes the resolved locale to the viewer', async context => {
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, oldDocument = globalThis.document;
  context.after(() => { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; globalThis.document = oldDocument; });
  URL.createObjectURL = () => 'blob:fixture'; URL.revokeObjectURL = () => {};
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }) };
  const controller = new SceneController({ appendChild() {} }, { i18n: createI18n('DE-de', dictionaries), settings: {},
    createViewer: async options => { assert.equal(options.lang, 'de'); throw new Error('Engine diagnostic'); } });
  const errors = []; controller.addEventListener('error', event => errors.push(event.detail));
  await controller.loadFile({ name: 'empty.ply', size: 0 });
  assert.equal(errors[0].message, 'Test Datei');
  await controller.loadFile({ name: 'scene.ply', size: 1 });
  assert.deepEqual(errors[1], { message: 'Test Fehler scene.ply', cause: 'Error: Engine diagnostic' });
  controller.destroy();
});

test('reference names are localized when generated; saved names and comments stay intact', async () => {
  const viewer = { setPointInteraction() {}, pickSurface: async () => ({ position: [0, 0, 0] }),
    createMarkerVisual: () => ({ anchor: {position:[0,0,0]}, setSelected() {}, setColor() {}, destroy() {} }) };
  const markers = new SceneMarkers(viewer, { min:[0,0,0], max:[1,1,1] }, { i18n:createI18n('de', dictionaries) });
  markers.setMode('add-marker'); markers.setNewMarkerType('reference'); await markers.addAt(.5, .5);
  assert.equal(markers.markers[0].name, 'Test Punkt 1');
  markers.updateMarker(1, { name: '<b>User name</b>', note: 'User note' });
  assert.equal(markers.markers[0].name, '<b>User name</b>'); assert.equal(markers.markers[0].note, 'User note');
  markers.updateMarker(1, { name: ' ' }); assert.equal(markers.markers[0].name, 'Test Punkt 1');
  markers.destroy();
});

test('calibration messages use the injected locale without changing numeric input rules', async () => {
  const i18n = createI18n('de', dictionaries);
  assert.throws(() => parseMeters('0', i18n), /Test Abstand/);
  assert.equal(parseMeters('1,25', i18n), 1.25);
  const viewer = { pickSurface: async () => ({position:[0,0,0]}),
    createMarkerVisual: () => ({ anchor:{position:[0,0,0]}, destroy() {} }) };
  const measurements = new SceneMeasurements(viewer, 1, () => {}, i18n);
  assert.throws(() => measurements.apply(1), /Test A und B/);
  measurements.begin(); await measurements.pick(0, 0); await measurements.pick(0, 0);
  assert.equal(measurements.snapshot.message, 'Test anderer B');
  viewer.pickSurface = async () => { throw Error('Engine'); }; await measurements.pick(0, 0);
  assert.equal(measurements.snapshot.message, 'Test Oberfläche');
  measurements.destroy();
});
