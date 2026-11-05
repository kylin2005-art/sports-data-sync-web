import { Map, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

const STREET_ORIGIN = 'https://tiles.openfreemap.org';
const TERRAIN_ORIGIN = 'https://tiles.mapterhorn.com';
const STREET_STYLE = `${STREET_ORIGIN}/styles/liberty`;
const TERRAIN_SOURCE = 'ride-dem';
const ROUTE_SOURCE = 'ride-route';
const ROUTE_COLOR = '#1768d6';
const MISSING_COLOR = '#737f92';
const LOAD_TIMEOUT = 14_000;
const METRICS = {
  speed: { field: 'speedKph', index: 2, multiplier: 3.6, unit: 'km/h', stops: [15, 25, 35, 45] },
  power: { field: 'powerW', index: 3, multiplier: 1, unit: 'W', stops: [100, 150, 200, 250, 300] },
};
const COLORS = ['#1460d2', '#008578', '#728200', '#c57800', '#ce3f38', '#a82064'];

function validPoint(point) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180 &&
    Number.isFinite(point[1]) && Math.abs(point[1]) <= 85.051129;
}

function readEdges(segments) {
  const edges = [];
  let origin;
  for (const segment of segments) {
    let previous;
    let previousCoords;
    for (const point of segment) {
      if (!validPoint(point)) {
        previous = undefined;
        continue;
      }
      origin ??= point[0];
      const longitude = origin + ((point[0] - origin + 540) % 360 - 180);
      const coords = [longitude, point[1]];
      if (previous && (previousCoords[0] !== coords[0] || previousCoords[1] !== coords[1])) {
        const properties = {};
        for (const { field, index, multiplier } of Object.values(METRICS)) {
          const start = previous[index];
          const end = point[index];
          if (Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end >= 0) {
            properties[field] = (start / 2 + end / 2) * multiplier;
          }
        }
        edges.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: [previousCoords, coords] } });
      }
      previous = point;
      previousCoords = coords;
    }
  }
  return edges;
}

function lineColor(mode) {
  const metric = METRICS[mode];
  if (!metric) return ROUTE_COLOR;
  const stops = metric.stops.flatMap((limit, index) => [limit, COLORS[index + 1]]);
  return ['step', ['number', ['get', metric.field], -1], MISSING_COLOR, 0, COLORS[0], ...stops];
}

export function hasRideMapMetric(segments, mode) {
  const metric = METRICS[mode];
  return Boolean(metric && readEdges(segments).some(edge => Number.isFinite(edge.properties[metric.field])));
}

export function rideMapLegend(segments, mode) {
  const metric = METRICS[mode];
  if (!metric) return [{ label: '路线', color: ROUTE_COLOR }];
  const edges = readEdges(segments);
  const measured = edges.filter(edge => Number.isFinite(edge.properties[metric.field])).length;
  const labels = metric.stops.map((limit, index) => `${index ? `${metric.stops[index - 1]}–` : '< '}${limit} ${metric.unit}`);
  labels.push(`≥ ${metric.stops.at(-1)} ${metric.unit}`);
  const legend = measured ? labels.map((label, index) => ({ label, color: COLORS[index] })) : [];
  if (!measured || measured < edges.length) legend.push({ label: '无有效读数', color: MISSING_COLOR });
  return legend;
}

export function createRideMap(container, segments, { mode = 'route', terrain = true, onStatus = () => {} } = {}) {
  const edges = readEdges(segments);
  let map;
  let streetTimer;
  let terrainTimer;
  let styleReady = false;
  let streetReady = false;
  let terrainReady = false;
  let streetDelayed = false;
  let terrainFailed = false;
  let contextLost = false;
  let activeTerrain = false;
  let lastStatus;

  function report(state, message) {
    const status = { state, message, ...(styleReady || state === 'error' ? { terrain: activeTerrain } : {}) };
    if (lastStatus?.state === state && lastStatus.message === message && lastStatus.terrain === status.terrain) return;
    lastStatus = status;
    onStatus(status);
  }

  function reportProgress() {
    if (contextLost) return;
    if (terrainFailed && streetDelayed) {
      report('warning', '街道底图和地形暂未加载，仍可查看骑行路线。');
    } else if (terrainFailed) {
      report('warning', '地形暂不可用，已切换为二维地图。');
    } else if (streetDelayed) {
      report('warning', '街道底图暂未加载，仍可查看骑行路线。');
    } else if (streetReady && (!activeTerrain || terrainReady)) {
      report('ready', activeTerrain ? '三维地图已加载。' : '二维地图已加载。');
    } else {
      report('loading', activeTerrain ? '正在加载街道底图和地形…' : '正在加载街道底图…');
    }
  }

  function destroy() {
    clearTimeout(streetTimer);
    clearTimeout(terrainTimer);
    const currentMap = map;
    map = undefined;
    currentMap?.remove();
  }

  function fatal(message) {
    destroy();
    activeTerrain = false;
    report('error', message);
  }

  function setMode(nextMode) {
    mode = nextMode;
    if (styleReady && map) map.setPaintProperty(ROUTE_SOURCE, 'line-color', lineColor(mode));
  }

  function setTerrain(enabled, failed = false) {
    terrain = Boolean(enabled);
    if (!styleReady || !map || terrain === activeTerrain) return;
    clearTimeout(terrainTimer);
    terrainReady = false;
    terrainFailed = failed;
    activeTerrain = terrain;
    if (terrain) {
      try {
        map.addSource(TERRAIN_SOURCE, {
          type: 'raster-dem', url: `${TERRAIN_ORIGIN}/tilejson.json`, tileSize: 512, encoding: 'terrarium',
          attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener noreferrer">© Mapterhorn</a>',
        });
        map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1 });
        map.setMaxPitch(60);
        map.setPitch(52);
        terrainTimer = setTimeout(() => setTerrain(false, true), LOAD_TIMEOUT);
      } catch {
        setTerrain(false, true);
        return;
      }
    } else {
      map.setTerrain(null);
      map.setMaxPitch(0);
      if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE);
    }
    reportProgress();
  }

  const controls = { setMode, setTerrain, destroy };
  if (!edges.length) {
    report('error', '这个文件没有可绘制的地图路线。');
    return controls;
  }

  const bounds = [[Infinity, Infinity], [-Infinity, -Infinity]];
  for (const { geometry } of edges) for (const [lon, lat] of geometry.coordinates) {
    bounds[0][0] = Math.min(bounds[0][0], lon);
    bounds[0][1] = Math.min(bounds[0][1], lat);
    bounds[1][0] = Math.max(bounds[1][0], lon);
    bounds[1][1] = Math.max(bounds[1][1], lat);
  }

  reportProgress();
  try {
    setWorkerUrl(workerUrl);
    map = new Map({
      container, style: STREET_STYLE, bounds, fitBoundsOptions: { padding: 40, maxZoom: 15 },
      maxPitch: 0, cooperativeGestures: true, attributionControl: { compact: false },
      locale: {
        'Map.Title': '骑行路线地图',
        'NavigationControl.ZoomIn': '放大地图',
        'NavigationControl.ZoomOut': '缩小地图',
        'NavigationControl.ResetBearing': '拖动可旋转地图，点击回到正北',
        'CooperativeGesturesHandler.WindowsHelpText': '按住 Ctrl 并滚动来缩放地图',
        'CooperativeGesturesHandler.MacHelpText': '按住 ⌘ 并滚动来缩放地图',
        'CooperativeGesturesHandler.MobileHelpText': '用两根手指移动地图',
        'ScaleControl.Meters': '米',
        'ScaleControl.Kilometers': '公里',
      },
      transformRequest: url => {
        const { origin } = new URL(url);
        if (origin !== STREET_ORIGIN && origin !== TERRAIN_ORIGIN) throw new Error('地图资源地址不受支持。');
        return { url, credentials: 'omit' };
      },
    });
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
  } catch {
    fatal('无法初始化地图。请检查浏览器的 WebGL 支持。');
    container.replaceChildren();
    return controls;
  }

  streetTimer = setTimeout(() => {
    if (!styleReady) return fatal('街道底图服务暂不可用。');
    streetDelayed = !streetReady;
    reportProgress();
  }, LOAD_TIMEOUT);

  map.on('error', event => {
    if (!styleReady && event.error?.url === STREET_STYLE) fatal('街道底图服务暂不可用。');
    else if (activeTerrain && event.error?.url === `${TERRAIN_ORIGIN}/tilejson.json`) setTerrain(false, true);
  });
  map.on('webglcontextlost', () => {
    contextLost = true;
    report('warning', '地图图形上下文已中断，正在尝试恢复。');
  });
  map.on('webglcontextrestored', () => {
    contextLost = false;
    reportProgress();
  });
  map.on('sourcedata', event => {
    if (!event.coord) return;
    if (event.sourceId === TERRAIN_SOURCE && activeTerrain && !terrainReady) {
      terrainReady = true;
      clearTimeout(terrainTimer);
    } else if (event.source?.type === 'vector' && !streetReady) {
      streetReady = true;
      streetDelayed = false;
      clearTimeout(streetTimer);
    } else return;
    reportProgress();
  });
  map.once('style.load', () => {
    try {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: edges } });
      const layout = { 'line-join': 'round', 'line-cap': 'round' };
      map.addLayer({ id: 'ride-route-halo', source: ROUTE_SOURCE, type: 'line', layout,
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.94 } });
      map.addLayer({ id: ROUTE_SOURCE, source: ROUTE_SOURCE, type: 'line', layout,
        paint: { 'line-color': lineColor(mode), 'line-width': 5 } });
      styleReady = true;
      if (terrain) setTerrain(true);
      else reportProgress();
    } catch {
      fatal('地图路线绘制失败。');
    }
  });
  return controls;
}
