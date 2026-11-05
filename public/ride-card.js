import { drawRideTerrain, hasRideTerrain } from './ride-terrain.js';

const terrainLayers = new WeakMap();

const themes = {
  neon: {
    background: '#081326', panel: '#0d2036', panelLine: '#24415b', ink: '#f6fbff',
    muted: '#b0c5dc', accent: '#71f6d8', trace: '#86ffe3', traceUnder: '#1a806f',
    grid: '#1d3852', stripes: '#122640', metric: '#10253e', radius: 24,
  },
  paper: {
    background: '#f7f9fc', panel: '#edf4fd', panelLine: '#cad9ec', ink: '#102a48',
    muted: '#465e78', accent: '#1965b5', trace: '#1762b4', traceUnder: '#b5d4f6',
    grid: '#d9e6f5', stripes: '#e7eef8', metric: '#ffffff', radius: 12,
  },
};

const fonts = 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';

function font(ctx, size, weight) {
  ctx.font = weight + ' ' + size + 'px ' + fonts;
}

function text(ctx, value, x, y, size, color, weight = 600, width) {
  font(ctx, size, weight);
  ctx.fillStyle = color;
  if (width === undefined) ctx.fillText(value, x, y);
  else ctx.fillText(value, x, y, width);
}

function box(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function writeTitle(ctx, title, x, y, width, color) {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim() || '骑行记录');
  font(ctx, 76, 800);
  let row = 0;
  for (; row < 2 && chars.length; row++) {
    let line = '';
    while (chars.length && ctx.measureText(line + chars[0]).width <= width) line += chars.shift();
    if (row === 1 && chars.length) {
      const end = Array.from(line);
      while (end.length && ctx.measureText(end.join('') + '…').width > width) end.pop();
      line = end.join('') + '…';
    }
    text(ctx, line.trim(), x, y + row * 86, 76, color, 800);
    while (chars[0] === ' ') chars.shift();
  }
  return y + row * 86;
}

function duration(value) {
  const seconds = Math.round(value);
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return parts.map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join(':');
}

function rideMetrics(ride) {
  const values = ride.metrics || {};
  const fields = [
    ['distanceM', '里程', 'km', value => (value / 1000).toFixed(2)],
    ['durationSeconds', values.durationKind === 'timer' ? '骑行用时' : values.durationKind === 'elapsed' ? '经过用时' : '用时', '', duration],
    ['ascentM', '累计爬升', 'm', Math.round],
    ['avgSpeedMps', '平均速度', 'km/h', value => (value * 3.6).toFixed(1)],
    ['avgHeartRateBpm', '平均心率', 'bpm', Math.round],
    ['avgPowerW', '平均功率', 'W', Math.round],
    ['avgCadenceRpm', '平均踏频', 'rpm', Math.round],
  ];
  return fields.flatMap(([key, label, unit, format]) => {
    const value = values[key];
    if (!Number.isFinite(value) || value < 0) return [];
    return [{ label: label + (ride.estimated?.includes(key) ? ' · 估算' : ''), unit, value: String(format(value)) }];
  });
}

function segments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(Array.isArray).map(line => line.filter(point =>
    Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))).filter(line => line.length > 1);
}

function plot(ctx, lines, area, palette, elevation = false) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const spanX = right - left, spanY = bottom - top;
  const scaleX = area.width / (spanX || 1), scaleY = area.height / (spanY || 1);
  const fit = Math.min(spanX ? scaleX : Infinity, spanY ? scaleY : Infinity);
  if (!elevation && !Number.isFinite(fit)) return false;
  const sx = elevation ? scaleX : fit, sy = elevation ? scaleY : fit;
  const offsetX = area.x + (area.width - spanX * sx) / 2;
  const offsetY = area.y + (area.height - spanY * sy) / 2;
  ctx.beginPath();
  for (const line of lines) {
    line.forEach(([x, y], index) => {
      const dx = offsetX + (x - left) * sx;
      const dy = offsetY + (elevation ? bottom - y : y - top) * sy;
      if (index === 0) ctx.moveTo(dx, dy);
      else ctx.lineTo(dx, dy);
    });
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = palette.traceUnder;
  ctx.lineWidth = elevation ? 8 : 15;
  ctx.stroke();
  ctx.strokeStyle = palette.trace;
  ctx.lineWidth = elevation ? 4 : 7;
  ctx.stroke();
  return true;
}

function grid(ctx, area, color) {
  ctx.beginPath();
  for (let x = area.x; x <= area.x + area.width; x += 48) {
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.height);
  }
  for (let y = area.y; y <= area.y + area.height; y += 48) {
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.width, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Paints one export-ready image. The supplied route is already normalized, never a GPS map. */
export function drawRideCard(canvas, ride, options = {}) {
  const { ratio, theme, route, routeView, azimuth, showDate = false } = options;
  const routeMode = route === 'full' || route === 'trimmed' ? route : 'hidden';
  const selectedRoute = routeMode === 'full' ? ride.route : routeMode === 'trimmed' ? ride.trimmedRoute : [];
  const palette = theme === 'paper' ? themes.paper : themes.neon;
  const tall = ratio === '9:16';
  canvas.width = 1080;
  canvas.height = tall ? 1920 : 1440;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (theme !== 'paper') {
    ctx.strokeStyle = palette.stripes;
    ctx.lineWidth = 12;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(736 + i * 40, 0);
      ctx.lineTo(1080, 344 - i * 40);
      ctx.stroke();
    }
  }
  const margin = 64;
  const cardWidth = canvas.width - margin * 2;
  const top = tall ? 105 : 80;
  box(ctx, margin, top, 12, 34, 4, palette.accent);
  text(ctx, '骑行活动', margin + 28, top, 28, palette.accent, 750);
  const format = typeof ride.format === 'string' ? ride.format.toUpperCase() : '';
  if (format === 'FIT' || format === 'GPX') text(ctx, format, 946, top, 26, palette.muted, 650, 70);
  const title = typeof options.title === 'string' ? options.title.slice(0, 240) : '';
  const titleEnd = writeTitle(ctx, title, margin, top + 59, cardWidth, palette.ink);
  const date = showDate && ride.startTime ? new Date(ride.startTime) : null;
  const dateVisible = date && Number.isFinite(date.getTime());
  if (dateVisible) {
    text(ctx, date.toLocaleDateString('zh-CN'), margin, titleEnd + 10, 25, palette.muted);
  }

  const metrics = rideMetrics(ride);
  const primary = metrics.shift();
  const cols = metrics.length === 4 ? 2 : Math.min(3, metrics.length);
  const tileHeight = tall ? 191 : 147;
  const gap = 14;
  const rows = cols ? Math.ceil(metrics.length / cols) : 0;
  const heroY = titleEnd + (dateVisible ? 50 : 0) + (tall ? 58 : 46);
  const heroBottom = canvas.height - (tall ? 176 : 146) - (rows ? 24 + rows * tileHeight + (rows - 1) * gap : 0);
  const heroHeight = heroBottom - heroY;
  box(ctx, margin, heroY, cardWidth, heroHeight, palette.radius, palette.panel, palette.panelLine);
  const tracks = segments(selectedRoute);
  const elevation = segments(ride.elevation);
  if (primary) {
    text(ctx, primary.label, margin + 32, heroY + 26, 29, palette.muted);
    text(ctx, primary.value + (primary.unit ? ' ' + primary.unit : ''), margin + 32, heroY + 68, 70, palette.ink, 800, cardWidth - 64);
  }

  const plotX = margin + 36;
  const plotWidth = cardWidth - 72;
  const plotY = heroY + (primary ? 167 : 46);
  const plotHeight = heroY + heroHeight - plotY - 46;
  const area = { x: plotX, y: plotY, width: plotWidth, height: plotHeight };
  const inset = elevation.length && tracks.length ? 132 : 0;
  const routeArea = { ...area, height: plotHeight - inset };
  let trackDrawn = false;
  if (routeView === '3d' && hasRideTerrain(selectedRoute)) {
    const headingHeight = 32;
    if (canvas.ownerDocument && routeArea.height > headingHeight) {
      let layer = terrainLayers.get(canvas);
      if (!layer) {
        layer = canvas.ownerDocument.createElement('canvas');
        terrainLayers.set(canvas, layer);
      }
      if (layer.width !== routeArea.width) layer.width = routeArea.width;
      const height = routeArea.height - headingHeight;
      if (layer.height !== height) layer.height = height;
      trackDrawn = drawRideTerrain(layer, selectedRoute, { azimuth, minLabelSize: 24 });
      if (trackDrawn) {
        text(ctx, '3D 海拔轨迹', routeArea.x, routeArea.y, 22, palette.muted);
        ctx.drawImage(layer, routeArea.x, routeArea.y + headingHeight);
      }
    }
  }
  if (!trackDrawn && tracks.length) {
    grid(ctx, routeArea, palette.grid);
    trackDrawn = plot(ctx, tracks, {
      x: plotX + 28, y: plotY + 18, width: plotWidth - 56, height: routeArea.height - 36,
    }, palette);
  }
  if (elevation.length) {
    const profile = trackDrawn ? { ...area, y: plotY + plotHeight - 105, height: 105 } : area;
    text(ctx, '海拔走势', plotX, profile.y, 22, palette.muted);
    plot(ctx, elevation, {
      x: profile.x + 4, y: profile.y + 36, width: profile.width - 8, height: profile.height - 42,
    }, palette, true);
  } else if (!trackDrawn) {
    grid(ctx, area, palette.grid);
    const centerY = plotY + plotHeight / 2;
    for (const radius of [48, 82, 116]) {
      ctx.beginPath();
      ctx.arc(plotX + plotWidth * .78, centerY, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = palette.panelLine;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const message = routeMode === 'hidden' ? '轨迹已隐藏'
      : routeMode === 'trimmed' ? '隐藏首尾后无可绘制轨迹' : '未记录可绘制轨迹';
    text(ctx, '骑行数据', plotX + 28, centerY - 43, 38, palette.ink, 750, plotWidth * .55);
    text(ctx, message, plotX + 28, centerY + 10, 25, palette.muted, 600, plotWidth * .55);
  }

  if (metrics.length) {
    const tileWidth = (cardWidth - (cols - 1) * gap) / cols;
    const y = heroY + heroHeight + 24;
    metrics.forEach((metric, index) => {
      const x = margin + (index % cols) * (tileWidth + gap);
      const top = y + Math.floor(index / cols) * (tileHeight + gap);
      box(ctx, x, top, tileWidth, tileHeight, palette.radius, palette.metric, palette.panelLine);
      text(ctx, metric.label, x + 24, top + 22, 25, palette.muted, 650, tileWidth - 48);
      text(ctx, metric.value, x + 24, top + 58, 52, palette.ink, 750, tileWidth - 48);
      if (metric.unit) text(ctx, metric.unit, x + 24, top + 114, 21, palette.accent);
    });
  }

  ctx.fillStyle = palette.panelLine;
  ctx.fillRect(margin, canvas.height - 94, cardWidth, 2);
  text(ctx, '运动数据同步', margin, canvas.height - 67, 23, palette.muted, 650);
  if (routeMode !== 'full') {
    ctx.textAlign = 'right';
    text(ctx, routeMode === 'trimmed' ? '轨迹隐藏首尾' : '轨迹已隐藏', canvas.width - margin, canvas.height - 67, 23, palette.muted);
  }
}
