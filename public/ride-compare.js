const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;
const SAMPLES = 96;
const BASE_COLOR = '#8050b5';
const RIDE_COLOR = '#1768d6';
const longitudeDelta = (from, to) => ((to - from) % 360 + 540) % 360 - 180;

function distance([lonA, latA], [lonB, latB]) {
  const arc = Math.sin((latB - latA) * RAD / 2) ** 2 +
    Math.cos(latA * RAD) * Math.cos(latB * RAD) * Math.sin(longitudeDelta(lonA, lonB) * RAD / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, arc)));
}

function sampleRoute(segments) {
  const edges = [];
  let length = 0, gap = 0, previousEnd;
  for (const segment of segments ?? []) {
    if (segment.length < 2) continue;
    if (previousEnd) gap += distance(previousEnd, segment[0]);
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1], b = segment[i];
      const meters = distance(a, b);
      if (meters > 0) {
        edges.push({ a, b, start: length, meters });
        length += meters;
      }
    }
    previousEnd = segment.at(-1);
  }
  if (length < 1000 || gap > Math.max(150, length * 0.05)) return null;
  let edge = 0;
  const points = Array.from({ length: SAMPLES + 1 }, (_, index) => {
    const at = length * index / SAMPLES;
    while (edge < edges.length - 1 && edges[edge].start + edges[edge].meters < at) edge++;
    const { a, b, start, meters } = edges[edge];
    const fraction = (at - start) / meters;
    return [a[0] + longitudeDelta(a[0], b[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  });
  return { length, points };
}

function follows(a, b) {
  if (distance(a[0], b[0]) > 100 || distance(a.at(-1), b.at(-1)) > 100) return false;
  const sorted = a.map((point, i) => distance(point, b[i])).sort((left, right) => left - right);
  return sorted[Math.floor(0.9 * (sorted.length - 1))] <= 80;
}

export function compareRides(first, second) {
  const older = Date.parse(first.startTime), newer = Date.parse(second.startTime);
  const [baseline, ride] = Number.isFinite(older) && Number.isFinite(newer) && older > newer
    ? [second, first] : [first, second];
  const a = sampleRoute(baseline.mapSegments), b = sampleRoute(ride.mapSegments);
  let match = 'unavailable';
  if (a && b) {
    match = 'different';
    if (Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.85) {
      const forward = follows(a.points, b.points);
      const backward = follows(a.points, [...b.points].reverse());
      match = forward ? (backward ? 'ambiguous' : 'same') : backward ? 'reverse' : 'different';
    }
  }
  const before = baseline.metrics, after = ride.metrics;
  const comparable = match === 'same' && before.durationKind && before.durationKind === after.durationKind &&
    before.durationSeconds > 0 && after.durationSeconds > 0;
  return { baseline, ride, match, secondsSaved: comparable ? before.durationSeconds - after.durationSeconds : null };
}

function stroke(ctx, segments, x, y, baseline) {
  ctx.beginPath();
  for (const segment of segments) segment.forEach(([horizontal, vertical], i) => {
    if (i === 0) ctx.moveTo(x(horizontal), y(vertical));
    else ctx.lineTo(x(horizontal), y(vertical));
  });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = baseline ? BASE_COLOR : RIDE_COLOR;
  ctx.lineWidth = baseline ? 8 : 4;
  ctx.setLineDash(baseline ? [12, 10] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawComparisonRoutes(canvas, baseline, ride) {
  const sets = [baseline.mapSegments ?? [], ride.mapSegments ?? []];
  const points = sets.flat(2);
  if (!points.length) return false;
  const [lon, lat] = points[0];
  const aspect = Math.cos(lat * RAD);
  const projected = sets.map(segments => segments.map(segment =>
    segment.map(([x, y]) => [longitudeDelta(lon, x) * aspect, y - lat])));
  const all = projected.flat(2);
  const left = Math.min(...all.map(p => p[0])), right = Math.max(...all.map(p => p[0]));
  const bottom = Math.min(...all.map(p => p[1])), top = Math.max(...all.map(p => p[1]));
  const w = canvas.width, h = canvas.height;
  const fit = Math.min((w - 80) / (right - left), (h - 72) / (top - bottom));
  if (!Number.isFinite(fit) || fit <= 0) return false;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const x = value => w / 2 + (value - (left + right) / 2) * fit;
  const y = value => h / 2 - (value - (bottom + top) / 2) * fit;
  projected.forEach((segments, i) => stroke(ctx, segments, x, y, i === 0));
  return true;
}

export function drawComparisonElevation(canvas, baseline, ride) {
  const sets = [baseline.elevation ?? [], ride.elevation ?? []];
  const points = sets.flat(2);
  if (!points.length) return false;
  const maxDistance = Math.max(...points.map(([meters]) => meters));
  if (!(maxDistance > 0)) return false;
  const low = Math.floor(Math.min(...points.map(([, altitude]) => altitude)) / 25) * 25;
  const high = Math.max(low + 50, Math.ceil(Math.max(...points.map(([, altitude]) => altitude)) / 25) * 25);
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const x = value => 130 + value / maxDistance * (w - 176);
  const y = value => h - 58 - (value - low) / (high - low) * (h - 92);
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillStyle = '#4b607d';
  ctx.strokeStyle = '#c6d5e7';
  ctx.lineWidth = 1;
  for (const value of [low, (low + high) / 2, high]) {
    const line = y(value);
    ctx.beginPath();
    ctx.moveTo(130, line);
    ctx.lineTo(w - 46, line);
    ctx.stroke();
    ctx.fillText(`${Math.round(value)} m`, 16, line + 8);
  }
  ctx.fillText('0 km', 130, h - 19);
  ctx.textAlign = 'right';
  ctx.fillText(`${(maxDistance / 1000).toFixed(1)} km`, w - 46, h - 19);
  ctx.textAlign = 'left';
  sets.forEach((segments, i) => stroke(ctx, segments, x, y, i === 0));
  return true;
}
