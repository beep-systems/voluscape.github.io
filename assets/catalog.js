const identifier = /^[a-zA-Z0-9_-]+$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function mediaURL(path, base) {
  if (typeof path !== 'string' || !path.trim() || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(path) || path.includes('\\')) {
    throw new Error('File paths must be relative.');
  }
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error('Files must be hosted on the same site.');
  return url;
}

export function validateCatalog(catalog, base) {
  if (!Array.isArray(catalog) || catalog.length === 0) throw new Error('The catalog must be a nonempty array of tests.');
  const ids = new Set();
  for (const test of catalog) {
    if (!isObject(test) || typeof test.id !== 'string' || !identifier.test(test.id) || typeof test.title !== 'string' || !test.title.trim() || !Array.isArray(test.results)) {
      throw new Error('Each test must include id, title, video and a results array.');
    }
    if (ids.has(test.id)) throw new Error(`Duplicate test id: ${test.id}`);
    ids.add(test.id);
    mediaURL(test.video, base);
    if (test.poster !== undefined) mediaURL(test.poster, base);
    optionalMetadata(test);
    const resultIds = new Set();
    for (const result of test.results) {
      if (!isObject(result) || typeof result.id !== 'string' || !identifier.test(result.id) || typeof result.label !== 'string' || !result.label.trim()) {
        throw new Error(`Invalid variant in test ${test.id}.`);
      }
      if (resultIds.has(result.id)) throw new Error(`Duplicate variant id: ${result.id}`);
      resultIds.add(result.id);
      const scene = mediaURL(result.scene, base);
      if (!/\.(sog|ply)$/i.test(scene.pathname)) throw new Error('Scenes must use bundled SOG or Gaussian PLY.');
      if (result.settings !== undefined) mediaURL(result.settings, base);
      optionalMetadata(result);
    }
  }
  return catalog;
}

function optionalMetadata(item) {
  if (item.description !== undefined && typeof item.description !== 'string') throw new Error('description must be a string.');
  for (const key of ['sizeBytes', 'gaussians']) {
    if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key] < 0)) throw new Error(`${key} must be a nonnegative integer.`);
  }
  if (item.parameters !== undefined && !isObject(item.parameters)) throw new Error('parameters must be an object.');
}

export function selectionFromHash(catalog, hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const test = catalog.find((item) => item.id === params.get('test')) ?? catalog[0];
  const result = test.results.find((item) => item.id === params.get('variant')) ?? test.results[0] ?? null;
  return { test, result };
}

export function selectionHash(test, result) {
  const params = new URLSearchParams({ test: test.id });
  if (result) params.set('variant', result.id);
  return `#${params}`;
}
