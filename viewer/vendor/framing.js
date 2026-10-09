// Display-only framing. Bounds never change the source or renderer geometry.
export function validBounds(bounds) {
  return !!bounds && ['min', 'max'].every(key => Array.isArray(bounds[key]) &&
    bounds[key].length === 3 && bounds[key].every(Number.isFinite)) &&
    bounds.min.every((value, axis) => value <= bounds.max[axis]) &&
    Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis])) > 1e-8;
}

export function framingBounds(points, fallback = null) {
  const finite = points.filter(point => point.length === 3 && point.every(Number.isFinite));
  if (!finite.length) return validBounds(fallback) ? fallback : null;
  const ranges = [0, 1, 2].map(axis => {
    const values = finite.map(point => point[axis]).sort((a, b) => a - b);
    const trim = finite.length >= 100;
    return [values[trim ? Math.floor((values.length - 1) * .02) : 0],
      values[trim ? Math.ceil((values.length - 1) * .98) : values.length - 1]];
  });
  const bounds = { min: ranges.map(range => range[0]), max: ranges.map(range => range[1]) };
  return validBounds(bounds) ? bounds : validBounds(fallback) ? fallback : null;
}

export function framePose(bounds, direction, fov, width, height, padding = 1.1) {
  if (!validBounds(bounds) || !Array.isArray(direction) || direction.length !== 3 ||
      !direction.every(Number.isFinite) || Math.hypot(...direction) < 1e-8 ||
      !Number.isFinite(fov) || fov <= 0 || fov >= 180 ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      !Number.isFinite(padding) || padding < 1) return null;
  const target = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
  const radius = Math.hypot(...bounds.max.map((value, axis) => (value - bounds.min[axis]) / 2));
  // The pinned viewer applies FOV along the larger canvas dimension.
  const halfAngle = Math.atan(Math.tan(fov * Math.PI / 360) * Math.min(width, height) / Math.max(width, height));
  const distance = padding * radius / Math.sin(halfAngle);
  const length = Math.hypot(...direction);
  const position = target.map((value, axis) => value + direction[axis] / length * distance);
  return position.every(Number.isFinite) && Number.isFinite(distance) ? { position, target, distance, fov } : null;
}
