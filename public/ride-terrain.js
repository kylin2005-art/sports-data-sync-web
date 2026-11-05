const terrainColors = ['#39baff', '#46d8ff', '#59ebda', '#72f3bd', '#aaf195', '#d9ef89', '#ffdc81', '#ffb46c'];
const groundCorners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];

function validPoint(point) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
    Number.isFinite(point[2]) && point[0] >= 0 && point[0] <= 1 && point[1] >= 0 && point[1] <= 1;
}

export function hasRideTerrain(route) {
  return Array.isArray(route) && route.some(segment => Array.isArray(segment) &&
    segment.some((point, index) => index > 0 && validPoint(point) && validPoint(segment[index - 1])));
}

function measuredRuns(route) {
  const runs = [];
  for (const segment of route) {
    if (!Array.isArray(segment)) continue;
    let run = [];
    for (const point of segment) {
      if (validPoint(point)) run.push(point);
      else {
        if (run.length > 1) runs.push(run);
        run = [];
      }
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

function makeCamera(azimuth, width, height, verticalSpan) {
  const yaw = azimuth * Math.PI / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const project = ([x, y, z]) => [cos * (x - 0.5) - sin * (y - 0.5),
    0.59 * (sin * (x - 0.5) + cos * (y - 0.5)) - 0.81 * z];
  const bounds = groundCorners.flatMap(([x, y]) => [project([x, y, 0]), project([x, y, verticalSpan])]);
  const xMin = Math.min(...bounds.map(([x]) => x));
  const xMax = Math.max(...bounds.map(([x]) => x));
  const yMin = Math.min(...bounds.map(([, y]) => y));
  const yMax = Math.max(...bounds.map(([, y]) => y));
  const scale = Math.min(width * 0.88 / (xMax - xMin), height * 0.72 / (yMax - yMin));
  return point => {
    const [x, y] = project(point);
    return [width / 2 + (x - (xMin + xMax) / 2) * scale,
      height * 0.49 + (y - (yMin + yMax) / 2) * scale];
  };
}

/** Draw an oblique view of recorded route elevations. Azimuth is in degrees. */
export function drawRideTerrain(canvas, route, { azimuth = -40, minLabelSize = 12 } = {}) {
  const ctx = canvas?.getContext('2d');
  if (!ctx) return false;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!width || !height || !hasRideTerrain(route)) return false;

  const runs = measuredRuns(route);
  let low = Infinity;
  let high = -Infinity;
  for (const run of runs) {
    for (const [, , altitude] of run) {
      low = Math.min(low, altitude);
      high = Math.max(high, altitude);
    }
  }
  const altitudeRange = high - low;
  if (!Number.isFinite(altitudeRange)) return false;
  // The vertical scale is illustrative and limited so small altitude changes stay subtle.
  const altitudeScale = 0.44 / Math.max(60, altitudeRange);
  const camera = makeCamera(Number.isFinite(azimuth) ? azimuth % 360 : -40, width, height,
    altitudeRange * altitudeScale);
  const thickness = Math.max(1, Math.min(width, height) / 410);
  const append = (points, project = camera) => {
    ctx.moveTo(...project(points[0]));
    for (let index = 1; index < points.length; index++) ctx.lineTo(...project(points[index]));
  };

  ctx.save();
  const backdrop = ctx.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, '#142845');
  backdrop.addColorStop(0.48, '#0c192d');
  backdrop.addColorStop(1, '#081223');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);

  ctx.beginPath();
  append(groundCorners);
  ctx.closePath();
  ctx.fillStyle = '#112641';
  ctx.fill();
  ctx.strokeStyle = '#47637f';
  ctx.lineWidth = 1.35 * thickness;
  ctx.stroke();
  ctx.beginPath();
  for (let index = 1; index < 10; index++) {
    const coordinate = index / 10;
    append([[0, coordinate, 0], [1, coordinate, 0]]);
    append([[coordinate, 0, 0], [coordinate, 1, 0]]);
  }
  ctx.lineWidth = thickness * 0.8;
  ctx.strokeStyle = '#2c4761';
  ctx.stroke();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const run of runs) append(run, ([x, y]) => camera([x, y, 0]));
  ctx.strokeStyle = '#4bc9f450';
  ctx.lineWidth = thickness * 2.5;
  ctx.stroke();

  const projected = runs.map(run => run.map(([x, y, altitude]) => ({
    at: camera([x, y, (altitude - low) * altitudeScale]), altitude,
  })));
  ctx.beginPath();
  for (const run of projected) append(run, point => point.at);
  ctx.strokeStyle = '#071020';
  ctx.lineWidth = thickness * 7;
  ctx.stroke();

  const bands = terrainColors.map(() => []);
  for (const run of projected) {
    for (let index = 1; index < run.length; index++) {
      const a = run[index - 1];
      const b = run[index];
      const position = altitudeRange ? ((a.altitude - low) / altitudeRange + (b.altitude - low) / altitudeRange) / 2 : 0.45;
      bands[Math.round(position * (bands.length - 1))].push([a.at, b.at]);
    }
  }
  ctx.lineWidth = thickness * 4.25;
  bands.forEach((lines, index) => {
    if (!lines.length) return;
    ctx.beginPath();
    for (const [a, b] of lines) {
      ctx.moveTo(...a);
      ctx.lineTo(...b);
    }
    ctx.strokeStyle = terrainColors[index];
    ctx.stroke();
  });

  const font = Math.round(Math.max(minLabelSize, height * 0.037));
  const margin = Math.round(Math.min(width, height) * 0.06);
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#cbddf0';
  ctx.fillText(`海拔 ${Math.round(low)}${low === high ? '' : `–${Math.round(high)}`} m`, margin, height - margin);
  if (altitudeRange > 0) {
    const barWidth = Math.min(width * 0.27, 140 * thickness);
    const end = width - margin;
    const legend = ctx.createLinearGradient(end - barWidth, 0, end, 0);
    terrainColors.forEach((color, index) => legend.addColorStop(index / (terrainColors.length - 1), color));
    ctx.fillStyle = legend;
    ctx.fillRect(end - barWidth, height - margin - font * 0.55, barWidth, thickness * 3);
  }
  ctx.restore();
  return true;
}
