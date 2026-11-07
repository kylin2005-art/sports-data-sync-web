import { Decoder, Stream } from '@garmin/fitsdk';
import { DOMParser, DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import { WorkspaceError, isKnownOtherSport } from './sync-workspace.mjs';
import { bestFiveMinutePower } from './ride-power.mjs';
import { sampleRoute } from './public/ride-compare.js';

const GPX = 'http://www.topografix.com/GPX/1/1';
const GPX_OLD = 'http://www.topografix.com/GPX/1/0';
const TRACK_EXT = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const TRACK_EXT_V2 = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v2';
const POWER_EXT = 'http://www.garmin.com/xmlschemas/PowerExtension/v1';
const MAX_POINTS = 200000;
const MAX_SEGMENTS = 1000;
const PREVIEW_POINTS = 10000;
const RIDE_PREVIEW_POINTS = 2000;
const MAP_MAX_GAP_MS = 30_000;
const MAP_MAX_ESTIMATED_SPEED_MPS = 60;
const PRIVATE_DISTANCE_M = 500;
const EARTH_RADIUS_M = 6_371_000;
const TO_RADIANS = Math.PI / 180;
const timerStops = new Set(['stop', 'stopAll', 'stopDisable', 'stopDisableAll']);
const rideSports = new Set(['cycling', 'eBiking', 'generic']);
const indoorRideSports = new Set(['spin', 'indoorCycling', 'indoorHandCycling']);
const fail = message => { throw new WorkspaceError(422, message); };
const elements = node => Array.from(node.childNodes || []).filter(child => child.nodeType === 1);
const isGpx = node => node.namespaceURI === GPX || node.namespaceURI === GPX_OLD;
const child = (node, name) => elements(node).find(item => isGpx(item) && item.localName === name);

function coordinate(value, max) {
  if (typeof value !== 'number' && typeof value !== 'string') fail('轨迹点缺少有效经纬度。');
  if (typeof value === 'string' && !value.trim()) fail('轨迹点缺少有效经纬度。');
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > max) fail('轨迹经纬度超出有效范围。');
  return number;
}

function timestamp(value) {
  if (value == null || value === '') return { time: null, timeText: null };
  if (value instanceof Date && !Number.isFinite(value.getTime())) fail('轨迹时间无效。');
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) fail('轨迹时间无效或未注明时区；不会自动补造时间。');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const zone = match[7];
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  const time = Date.parse(text);
  if (year < 1970 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0) || !Number.isFinite(time)) {
    fail('轨迹日期、时间或时区超出有效范围。');
  }
  return { time, timeText: text };
}

function readGpx(data) {
  let xml, document;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { fail('GPX 不是有效的 UTF-8 文本。'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('GPX 不允许 DTD 或实体声明。');
  try { document = new DOMParser({ onError: () => { throw new Error('Invalid XML'); } }).parseFromString(xml, 'application/xml'); }
  catch { fail('GPX XML 结构无效。'); }
  const root = document.documentElement;
  if (!root || root.localName !== 'gpx' || !isGpx(root)) fail('文件不是有效 GPX 1.0/1.1。');
  const segments = [];
  let pointCount = 0;
  for (const track of elements(root)) {
    const groups = isGpx(track) && track.localName === 'trk' ? elements(track).filter(node => isGpx(node) && node.localName === 'trkseg') :
      isGpx(track) && track.localName === 'rte' ? [track] : [];
    for (const group of groups) {
      const points = elements(group).filter(node => isGpx(node) && ['trkpt', 'rtept'].includes(node.localName)).map(node => {
        if (++pointCount > MAX_POINTS) fail('轨迹点过多，请分批处理（每批最多 200000 点）。');
        const elevation = child(node, 'ele')?.textContent;
        if (elevation != null && (!elevation.trim() || !Number.isFinite(Number(elevation)))) fail('轨迹海拔不是有效数值。');
        return { lat: coordinate(node.getAttribute('lat'), 90), lon: coordinate(node.getAttribute('lon'), 180),
          ...timestamp(child(node, 'time')?.textContent), ...(elevation != null ? { elevation: Number(elevation) } : {}), node };
      });
      if (points.length) segments.push(points);
    }
  }
  return segments;
}

function decodeFit(data, expandComponents) {
  let decoded;
  try {
    const decoder = new Decoder(Stream.fromBuffer(data));
    if (!decoder.checkIntegrity()) fail('FIT 长度或 CRC 校验失败。');
    decoded = decoder.read({ applyScaleAndOffset: true, convertDateTimesToDates: true, includeUnknownData: false,
      expandComponents, mergeHeartRates: expandComponents });
  } catch (error) { if (error instanceof WorkspaceError) throw error; fail('FIT 无法解析。'); }
  if (decoded.errors.length) fail('FIT 解码包含错误，未使用不完整轨迹。');
  return decoded.messages;
}

function compressedFitSpeed(bytes) {
  // FIT Record field 8 packs 12 little-endian speed bits at 100 units per m/s.
  if (!Array.isArray(bytes) || bytes.length !== 3 || !bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ||
      bytes.every(value => value === 255)) return null;
  return (bytes[0] | ((bytes[1] & 0x0f) << 8)) / 100;
}

function readFit(messages) {
  const segments = [];
  let points = [], count = 0;
  for (const record of messages.recordMesgs || []) {
    if (record.positionLat == null || record.positionLong == null) {
      if (points.length) segments.push(points);
      points = [];
      continue;
    }
    if (++count > MAX_POINTS) fail('轨迹点过多，请分批处理（每批最多 200000 点）。');
    const lat = coordinate(record.positionLat * 180 / 2 ** 31, 90);
    const lon = coordinate(record.positionLong * 180 / 2 ** 31, 180);
    const elevation = record.enhancedAltitude ?? record.altitude;
    if (elevation != null && !Number.isFinite(elevation)) fail('FIT 海拔不是有效数值。');
    points.push({ lat, lon, ...timestamp(record.timestamp), elevation,
      heartRate: record.heartRate, cadence: record.cadence, temperature: record.temperature,
      speedMps: nonnegative(record.enhancedSpeed) ?? nonnegative(record.speed) ?? compressedFitSpeed(record.compressedSpeedDistance),
      powerW: nonnegative(record.power), odometerM: nonnegative(record.distance) });
  }
  if (points.length) segments.push(points);
  return segments;
}

function cloneGpxNode(document, source, point = false) {
  if (source.nodeType !== 1) return document.importNode(source, true);
  if (!isGpx(source)) return document.importNode(source, true);
  const output = document.createElementNS(GPX, point ? 'trkpt' : source.localName);
  for (const attribute of Array.from(source.attributes)) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
    output.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
  for (const node of Array.from(source.childNodes)) output.appendChild(cloneGpxNode(document, node));
  return output;
}

function mergedGpx(segments) {
  const document = new DOMImplementation().createDocument(GPX, 'gpx', null);
  const root = document.documentElement;
  root.setAttribute('version', '1.1');
  root.setAttribute('creator', 'Garmin transfer local track tools');
  const track = document.createElementNS(GPX, 'trk');
  root.appendChild(track);
  const addText = (parent, name, value, namespace = GPX) => {
    const element = document.createElementNS(namespace, name);
    element.appendChild(document.createTextNode(String(value)));
    parent.appendChild(element);
    return element;
  };
  addText(track, 'name', '合并轨迹');
  for (const points of segments) {
    const segment = document.createElementNS(GPX, 'trkseg');
    track.appendChild(segment);
    for (const point of points) {
      if (point.node) { segment.appendChild(cloneGpxNode(document, point.node, true)); continue; }
      const node = document.createElementNS(GPX, 'trkpt');
      node.setAttribute('lat', String(point.lat));
      node.setAttribute('lon', String(point.lon));
      if (point.elevation != null) addText(node, 'ele', point.elevation);
      addText(node, 'time', point.timeText);
      const values = [['hr', point.heartRate], ['cad', point.cadence], ['atemp', point.temperature]]
        .filter(([name, value]) => Number.isFinite(value) && (name === 'atemp' || value >= 0));
      if (values.length) {
        const extension = document.createElementNS(GPX, 'extensions');
        const fields = document.createElementNS(TRACK_EXT, 'gpxtpx:TrackPointExtension');
        extension.appendChild(fields); node.appendChild(extension);
        for (const [name, value] of values) addText(fields, `gpxtpx:${name}`, value, TRACK_EXT);
      }
      segment.appendChild(node);
    }
  }
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(document));
}

function preview(segments) {
  const allowance = Math.max(2, Math.floor(PREVIEW_POINTS / segments.length));
  return segments.map(points => {
    const size = Math.min(points.length, allowance);
    return Array.from({ length: size }, (_, index) => {
      const point = points[size === 1 ? 0 : Math.round(index * (points.length - 1) / (size - 1))];
      return [point.lat, point.lon];
    });
  });
}

function trackFormat(file) {
  if (!Buffer.isBuffer(file?.data) || !file.data.length || file.data.length > 50 * 1024 * 1024) {
    throw new WorkspaceError(413, '轨迹文件为空或超过 50 MB。');
  }
  const format = typeof file.fileName === 'string' ? file.fileName.match(/\.(fit|gpx)$/i)?.[1]?.toLowerCase() : null;
  if (!format) fail('仅支持 FIT 或 GPX 轨迹。');
  return format;
}

function readTrack(file, expandComponents = true) {
  const format = trackFormat(file);
  const messages = format === 'fit' ? decodeFit(file.data, expandComponents) : null;
  return { format, segments: messages ? readFit(messages) : readGpx(file.data), messages };
}

/** Parsed coordinates use degrees and time uses epoch milliseconds; GPX DOM nodes retain extensions. */
export function parseTrack(file) {
  const { format, segments } = readTrack(file);
  return { format, segments,
    coordinateSystem: typeof file.coordinateSystem === 'string' ? file.coordinateSystem.toUpperCase().replace(/[-_\s]/g, '') : 'UNKNOWN' };
}

function distanceBetween(left, right) {
  const latitude = Math.sin((right.lat - left.lat) * TO_RADIANS / 2) ** 2;
  const longitude = Math.sin((right.lon - left.lon) * TO_RADIANS / 2) ** 2;
  const arc = latitude + Math.cos(left.lat * TO_RADIANS) * Math.cos(right.lat * TO_RADIANS) * longitude;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, arc)));
}

function measureTrack(segments, messages, includeShare) {
  let distanceM = 0;
  const changes = includeShare ? timerChanges(messages) : [];
  let speedEstimated = false;
  const measured = segments.map(points => points.map((point, index) => {
    const previous = points[index - 1];
    if (previous) distanceM += distanceBetween(previous, point);
    const measuredPoint = { lat: point.lat, lon: point.lon, altitude: point.elevation ?? null, distanceM };
    if (!includeShare) return measuredPoint;
    const timer = timerIndex(changes, point.time);
    const recorded = point.node ? gpxSensors(point.node).speedMps : point.speedMps;
    const elapsed = previous?.time != null && point.time != null ? point.time - previous.time : null;
    const continuous = previous && !changes[timer]?.paused && timerIndex(changes, previous.time) === timer;
    const estimate = continuous && recorded == null ? estimatedSpeed(previous, point, elapsed) : null;
    speedEstimated ||= estimate != null;
    return { ...measuredPoint, speedMps: continuous ? recorded ?? estimate ?? null : null };
  }));
  return { measured, distanceM, speedEstimated };
}

function sample(items, limit) {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * (items.length - 1) / (limit - 1))]);
}

function sampleSegments(segments) {
  const drawable = sample(segments.filter(points => points.length >= 2), RIDE_PREVIEW_POINTS / 2);
  if (!drawable.length) return [];
  const allowance = Math.floor(RIDE_PREVIEW_POINTS / drawable.length);
  return drawable.map(points => sample(points, allowance));
}

const longitudeDelta = (from, to) => ((to - from) % 360 + 540) % 360 - 180;

function normalizeRoute(segments) {
  const points = segments.flat();
  if (!points.length) return [];
  const box = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
  let longitude = points[0].lon;
  const projected = segments.map(segment => segment.map(point => {
    longitude += longitudeDelta(longitude, point.lon);
    box.minLon = Math.min(box.minLon, longitude);
    box.maxLon = Math.max(box.maxLon, longitude);
    box.minLat = Math.min(box.minLat, point.lat);
    box.maxLat = Math.max(box.maxLat, point.lat);
    return [longitude, point.lat, point.altitude];
  }));
  const longitudeScale = Math.cos((box.minLat + box.maxLat) * TO_RADIANS / 2);
  const width = (box.maxLon - box.minLon) * longitudeScale;
  const height = box.maxLat - box.minLat;
  const scale = Math.max(width, height);
  if (!scale) return [];
  const xOffset = (1 - width / scale) / 2;
  const yOffset = (1 - height / scale) / 2;
  return projected.map(segment => segment.map(([lon, lat, altitude]) => [
    xOffset + (lon - box.minLon) * longitudeScale / scale, yOffset + (box.maxLat - lat) / scale, altitude,
  ]));
}

function outsidePrivateEdge(center, left, right, leftDistance, rightDistance, depth = 0) {
  const deltaLon = longitudeDelta(left.lon, right.lon);
  const latitude = left.lat * right.lat <= 0 ? 0 : Math.min(Math.abs(left.lat), Math.abs(right.lat));
  // The drawn line interpolates latitude and longitude. Bound its spherical
  // length using the largest cosine of latitude it can encounter.
  const upperLength = EARTH_RADIUS_M * TO_RADIANS * Math.hypot(right.lat - left.lat,
    deltaLon * Math.cos(latitude * TO_RADIANS));
  // For any point on the line, twice its distance to the center is at least
  // the sum of the endpoint distances minus the line length.
  if (leftDistance + rightDistance - upperLength >= 2 * PRIVATE_DISTANCE_M) return true;
  if (depth === 10) return false;
  const middle = { lat: (left.lat + right.lat) / 2, lon: left.lon + deltaLon / 2 };
  const middleDistance = distanceBetween(center, middle);
  return middleDistance >= PRIVATE_DISTANCE_M &&
    outsidePrivateEdge(center, left, middle, leftDistance, middleDistance, depth + 1) &&
    outsidePrivateEdge(center, middle, right, middleDistance, rightDistance, depth + 1);
}

function splitPrivateRoute(segments, first, last, totalDistance) {
  const split = [];
  for (const segment of segments) {
    let part = [];
    for (const point of segment) {
      if (point.distanceM < PRIVATE_DISTANCE_M || totalDistance - point.distanceM < PRIVATE_DISTANCE_M ||
          point.fromStart < PRIVATE_DISTANCE_M || point.fromFinish < PRIVATE_DISTANCE_M) {
        if (part.length >= 2) split.push(part);
        part = [];
        continue;
      }
      const previous = part.at(-1);
      if (previous && (!outsidePrivateEdge(first, previous, point, previous.fromStart, point.fromStart) ||
          !outsidePrivateEdge(last, previous, point, previous.fromFinish, point.fromFinish))) {
        if (part.length >= 2) split.push(part);
        part = [];
      }
      part.push(point);
    }
    if (part.length >= 2) split.push(part);
  }
  return split;
}

function privateRoute(measured, totalDistance) {
  if (totalDistance <= 2 * PRIVATE_DISTANCE_M) return [];
  const first = measured[0][0], last = measured.at(-1).at(-1);
  const distances = measured.map(segment => segment.map(point => ({ ...point,
    fromStart: distanceBetween(first, point), fromFinish: distanceBetween(last, point) })));
  const trimmed = splitPrivateRoute(distances, first, last, totalDistance);
  // Downsampling can introduce a new straight connection that cuts across a
  // radius even when each of the original edges stayed outside it.
  return splitPrivateRoute(sampleSegments(trimmed), first, last, totalDistance);
}

function elevationProfile(measured) {
  const segments = [];
  for (const segment of measured) {
    let part = [];
    for (const point of segment) {
      if (point.altitude != null) {
        part.push([point.distanceM, point.altitude]);
      } else {
        if (part.length) segments.push(part);
        part = [];
      }
    }
    if (part.length) segments.push(part);
  }
  return sampleSegments(segments.filter(points => points[0][0] < points.at(-1)[0]));
}

const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;

function sensorValue(element) {
  const value = element?.textContent?.trim();
  return value && /^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? nonnegative(Number(value)) : null;
}

function gpxSensors(node) {
  const extensions = elements(child(node, 'extensions') ?? {});
  const track = extensions.find(element => element.localName === 'TrackPointExtension' &&
    [TRACK_EXT, TRACK_EXT_V2].includes(element.namespaceURI));
  const fields = track ? elements(track).filter(element => element.namespaceURI === track.namespaceURI) : [];
  const field = name => fields.find(element => element.localName === name);
  const power = extensions.find(element => (element.localName === 'PowerInWatts' && element.namespaceURI === POWER_EXT) ||
    (element.localName === 'power' && (!element.namespaceURI || isGpx(element))));
  return {
    speedMps: sensorValue(field('speed')) ?? (node.namespaceURI === GPX_OLD ? sensorValue(child(node, 'speed')) : null),
    powerW: sensorValue(power) ?? sensorValue(field('power')),
  };
}

function timerChanges(messages) {
  return (messages?.eventMesgs ?? []).filter(event => event.event === 'timer' &&
    (event.eventType === 'start' || timerStops.has(event.eventType)))
    .map(event => ({ time: event.timestamp?.getTime(), paused: event.eventType !== 'start' }))
    .filter(event => Number.isFinite(event.time))
    .sort((left, right) => left.time - right.time);
}

function timerIndex(changes, time) {
  if (time == null) return -1;
  let start = 0, end = changes.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (changes[middle].time <= time) start = middle + 1;
    else end = middle;
  }
  return start - 1;
}

function estimatedSpeed(previous, point, elapsedMs) {
  if (elapsedMs == null || elapsedMs <= 0 || elapsedMs > MAP_MAX_GAP_MS) return null;
  const pathDistance = previous.odometerM != null && point.odometerM != null && point.odometerM >= previous.odometerM
    ? point.odometerM - previous.odometerM : distanceBetween(previous, point);
  const speed = pathDistance * 1000 / elapsedMs;
  return speed <= MAP_MAX_ESTIMATED_SPEED_MPS ? speed : null;
}

function hasMapDatum(file) {
  // GPX and standard FIT GPS positions use WGS84. Some adapters and merged
  // files explicitly record a different or unverified datum.
  const datum = typeof file.coordinateSystem === 'string' ? file.coordinateSystem.toUpperCase().replace(/[-_\s:]/g, '') : '';
  return !datum || datum === 'WGS84' || datum === 'EPSG4326';
}

function rideMap(file, segments, messages) {
  if (!hasMapDatum(file)) {
    return { mapSegments: [], mapSpeedEstimated: false, mapCoordinateSystem: null };
  }
  const changes = timerChanges(messages);
  const spans = [];
  for (const segment of segments) {
    let span = [], previous, previousTimer = -1;
    for (const point of segment) {
      const timer = timerIndex(changes, point.time);
      const elapsedMs = previous?.time != null && point.time != null ? point.time - previous.time : null;
      const broken = previous && (timer !== previousTimer || (elapsedMs != null &&
        (elapsedMs <= 0 || elapsedMs > MAP_MAX_GAP_MS)));
      if (broken) {
        if (span.length >= 2) spans.push(span);
        span = [];
      }
      const { speedMps, powerW } = point.node ? gpxSensors(point.node) : point;
      const first = span.length === 1 && span[0].coords[2] == null ? span[0] : null;
      const edgeSpeed = (speedMps == null || first) && previous && !broken && !changes[timer]?.paused
        ? estimatedSpeed(previous, point, elapsedMs) : null;
      if (first && edgeSpeed != null) {
        first.coords[2] = edgeSpeed;
        first.estimated = true;
      }
      const estimate = speedMps == null ? edgeSpeed : null;
      span.push({ coords: [point.lon, point.lat, speedMps ?? estimate, powerW ?? null], estimated: estimate != null });
      previous = point;
      previousTimer = timer;
    }
    if (span.length >= 2) spans.push(span);
  }
  const sampled = sampleSegments(spans);
  return {
    mapSegments: sampled.map(span => span.map(point => point.coords)),
    mapSpeedEstimated: sampled.some(span => span.some(point => point.estimated)),
    mapCoordinateSystem: sampled.length ? 'WGS84' : null,
  };
}

function rideMetrics(format, session, segments, trackDistance) {
  const timerSeconds = nonnegative(session?.totalTimerTime);
  let elapsedSeconds = nonnegative(session?.totalElapsedTime);
  let distanceM = nonnegative(session?.totalDistance);
  const estimated = [];
  if (format === 'gpx') {
    if (trackDistance > 0) {
      distanceM = trackDistance;
      estimated.push('distanceM');
    }
    const points = segments.flat();
    if (points.length >= 2 && points.every((point, index) => point.time != null &&
        (index === 0 || point.time >= points[index - 1].time))) {
      const elapsed = (points.at(-1).time - points[0].time) / 1000;
      if (elapsed > 0) {
        elapsedSeconds = elapsed;
        estimated.push('durationSeconds');
      }
    }
  }
  const metrics = { distanceM, durationSeconds: timerSeconds ?? elapsedSeconds,
    durationKind: timerSeconds !== null ? 'timer' : elapsedSeconds !== null ? 'elapsed' : null,
    ascentM: nonnegative(session?.totalAscent),
    avgSpeedMps: nonnegative(session?.enhancedAvgSpeed) ?? nonnegative(session?.avgSpeed),
    avgHeartRateBpm: session?.avgHeartRate > 0 ? nonnegative(session.avgHeartRate) : null,
    avgPowerW: nonnegative(session?.avgPower), avgCadenceRpm: nonnegative(session?.avgCadence) };
  return { metrics, estimated };
}

function rideStartTime(session, messages, segments) {
  const sessionStart = session?.startTime?.getTime();
  if (Number.isFinite(sessionStart)) return session.startTime.toISOString();
  let first = Infinity;
  if (messages) {
    for (const record of messages.recordMesgs || []) {
      const time = record.timestamp?.getTime();
      if (Number.isFinite(time)) first = Math.min(first, time);
    }
  } else {
    for (const segment of segments) for (const point of segment) {
      if (point.time != null) first = Math.min(first, point.time);
    }
  }
  return Number.isFinite(first) ? new Date(first).toISOString() : null;
}

function rideSession(messages) {
  if (messages?.sessionMesgs?.length > 1) fail('这个 FIT 包含多个运动阶段，请选用单次活动的 FIT。');
  const session = messages?.sessionMesgs?.[0];
  if (typeof session?.sport === 'string' && !rideSports.has(session.sport) &&
      !(session.sport === 'fitnessEquipment' && indoorRideSports.has(session.subSport))) {
    fail('所选 FIT 已标记为其他运动，请选择骑行活动。');
  }
  return session;
}

export function readRideExplorationTrack(file) {
  if (!hasMapDatum(file)) fail('这个文件的坐标系无法用于探索地图。');
  if (/\.gpx$/i.test(file.fileName) && isKnownOtherSport(file.type)) fail('所选 GPX 已标记为其他运动，请选择骑行活动。');
  const { messages, segments } = readTrack(file, false);
  if (segments.length > MAX_SEGMENTS) fail('活动轨迹分段过多。');
  const session = rideSession(messages);
  return { startTime: rideStartTime(session, messages, segments), segments };
}

function estimatedAscent(segments) {
  let ascent = 0, usable = false;
  for (const segment of segments) {
    let anchor, peak, climbing;
    for (const { elevation } of segment) {
      if (!Number.isFinite(elevation)) {
        if (climbing) ascent += peak - anchor;
        anchor = undefined;
        climbing = false;
        continue;
      }
      if (anchor === undefined) { anchor = elevation; continue; }
      usable = true;
      if (!climbing) {
        anchor = Math.min(anchor, elevation);
        if (elevation - anchor >= 3) { climbing = true; peak = elevation; }
      } else if (peak - elevation >= 3) {
        ascent += peak - anchor;
        anchor = elevation;
        climbing = false;
      } else {
        peak = Math.max(peak, elevation);
      }
    }
    if (climbing) ascent += peak - anchor;
  }
  return usable ? ascent : null;
}

export function readRideHighlightMetrics(file) {
  if (isKnownOtherSport(file.type)) return null;
  const { messages, segments } = readTrack(file, false);
  if (segments.length > MAX_SEGMENTS) fail('活动轨迹分段过多。');
  const session = rideSession(messages);
  const time = Date.parse(rideStartTime(session, messages, segments) ?? (file.time !== file.created ? file.time : null));
  if (!Number.isFinite(time)) return null;
  const distance = nonnegative(session?.totalDistance);
  let distanceM = distance;
  if (!distanceM) {
    distanceM = 0;
    for (const points of segments) {
      for (let i = 1; i < points.length; i++) distanceM += distanceBetween(points[i - 1], points[i]);
    }
  }
  const ascent = nonnegative(session?.totalAscent);
  const ascentM = ascent ?? estimatedAscent(segments);
  let powerSegments;
  if (messages) {
    const changes = timerChanges(messages);
    powerSegments = [(messages.recordMesgs ?? []).map(record => {
      const time = record.timestamp?.getTime();
      const timer = timerIndex(changes, time);
      return { time, power: record.power, timer, paused: changes[timer]?.paused };
    })];
  } else {
    powerSegments = segments.map(points => points.map(point => ({
      time: point.time, power: gpxSensors(point.node).powerW,
    })));
  }
  return { time, distanceM, ascentM, powerW: bestFiveMinutePower(powerSegments),
    estimatedDistance: !distance && distanceM > 0, estimatedAscent: ascent === null && ascentM !== null };
}

function estimateRideMetrics(segments, metrics) {
  const estimates = {};
  if (metrics.ascentM == null) {
    const ascent = estimatedAscent(segments);
    if (ascent != null) estimates.ascentM = ascent;
  }
  if (metrics.avgSpeedMps == null && metrics.distanceM > 0 && metrics.durationSeconds > 0) {
    estimates.avgSpeedMps = metrics.distanceM / metrics.durationSeconds;
  }
  return estimates;
}

export function readRideReportEntry(file) {
  if (isKnownOtherSport(file.type)) return null;
  const { format, messages, segments } = readTrack(file, false);
  if (segments.length > MAX_SEGMENTS) fail('活动轨迹分段过多。');
  const session = rideSession(messages);
  const start = rideStartTime(session, messages, segments);
  const time = Date.parse(start ?? (file.time !== file.created ? file.time : null));
  if (!Number.isFinite(time)) return null;
  const { distanceM } = measureTrack(segments, messages, false);
  const { metrics, estimated } = rideMetrics(format, session, segments, distanceM);
  if (!(metrics.distanceM > 0) && distanceM > 0) {
    metrics.distanceM = distanceM;
    if (!estimated.includes('distanceM')) estimated.push('distanceM');
  }
  if (metrics.ascentM === null) {
    metrics.ascentM = estimatedAscent(segments);
    if (metrics.ascentM !== null) estimated.push('ascentM');
  }
  const { mapSegments } = rideMap(file, segments, messages);
  return { time, metrics, estimated, route: sampleRoute(mapSegments) };
}

export function readRideSummary(file, { includeEstimates = false } = {}) {
  try {
    const format = trackFormat(file);
    const messages = format === 'fit' ? decodeFit(file.data, false) : null;
    const session = rideSession(messages);
    const segments = format === 'gpx' ? readGpx(file.data) : [];
    if (segments.length > MAX_SEGMENTS) return null;
    let distanceM = 0;
    for (const points of segments) {
      for (let index = 1; index < points.length; index++) distanceM += distanceBetween(points[index - 1], points[index]);
    }
    const startTime = rideStartTime(session, messages, segments);
    const { metrics, estimated } = rideMetrics(format, session, segments, distanceM);
    if (includeEstimates) {
      const extra = estimateRideMetrics(segments, metrics);
      Object.assign(metrics, extra);
      estimated.push(...Object.keys(extra));
    }
    return startTime || Object.values(metrics).some(value => value !== null) ? { startTime, metrics, estimated } : null;
  } catch (error) {
    if (error instanceof WorkspaceError) return null;
    throw error;
  }
}

export function processRide({ id, includeShare = false } = {}, workspace) {
  if (typeof id !== 'string' || !/^[\w.:-]{1,160}$/.test(id)) throw new WorkspaceError(400, '请选择一个本地活动文件。');
  const file = workspace.store.file(id);
  if (!file) throw new WorkspaceError(404, '活动文件不存在，请刷新文件列表。');
  // FIT SDK component expansion can overwrite a recorded enhancedSpeed with
  // legacy speed when both fields appear in the same record.
  const { format, messages, segments } = readTrack(file, false);
  if (segments.length > MAX_SEGMENTS) fail('活动轨迹分段过多。');
  const session = rideSession(messages);
  const startTime = rideStartTime(session, messages, segments);
  const { measured, distanceM, speedEstimated } = measureTrack(segments, messages, includeShare);
  const { metrics, estimated } = rideMetrics(format, session, segments, distanceM);
  const full = sampleSegments(measured), trimmed = privateRoute(measured, distanceM);
  const route = normalizeRoute(full), trimmedRoute = normalizeRoute(trimmed);
  const elevation = elevationProfile(measured);
  if (!startTime && !route.length && Object.values(metrics).every(value => value === null)) {
    fail('所选文件没有可用的活动指标或轨迹。');
  }
  const result = { name: file.name || file.fileName, format, startTime, metrics, estimated, route, trimmedRoute, elevation,
    ...rideMap(file, segments, messages) };
  if (!includeShare) return result;
  const speeds = points => points.map(segment => segment.map(point => point.speedMps));
  const shareMetrics = estimateRideMetrics(segments, metrics);
  return { ...result, shareMetrics, routeSpeeds: speeds(full), trimmedRouteSpeeds: speeds(trimmed), shareSpeedEstimated: speedEstimated };
}

export async function processTracks({ ids, merge = false } = {}, workspace) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[\w.:-]{1,160}$/.test(id)) || typeof merge !== 'boolean') {
    throw new WorkspaceError(400, '请选择 1–20 个不重复的本地轨迹文件。');
  }
  const files = ids.map(id => workspace.store.file(id));
  if (files.some(file => !file)) throw new WorkspaceError(404, '有轨迹文件不存在，请刷新文件列表。');
  if (files.some(file => !Buffer.isBuffer(file.data) || file.data.length > 50 * 1024 * 1024) || files.reduce((sum, file) => sum + file.data.length, 0) > 100 * 1024 * 1024) {
    throw new WorkspaceError(413, '轨迹文件过大：单个最多 50 MB，每批最多 100 MB。');
  }
  const parsed = files.map(parseTrack);
  let segments = parsed.flatMap(track => track.segments);
  if (!segments.length) fail('所选文件没有可绘制的 GPS 轨迹点（室内活动可能没有定位数据）。');
  if (segments.length > MAX_SEGMENTS) fail('轨迹分段过多，请分批处理。');
  const originalCount = segments.reduce((sum, points) => sum + points.length, 0);
  if (originalCount > MAX_POINTS) fail('轨迹点过多，请分批处理（每批最多 200000 点）。');
  const coordinateSystems = [...new Set(parsed.map(track => track.coordinateSystem))];
  const limitations = ['预览保留源文件坐标，未做 WGS84/GCJ02/BD09 转换；预览最多显示 10000 点，文件点数不受预览抽样影响。',
    '合并保留 GPX 逐点扩展；FIT 转 GPX 保留坐标、已有时间、海拔和可用心率/踏频/温度，设备、圈段、功率及其他 FIT 专用字段不完整保留。'];
  let fileId, trimmed = 0;
  if (merge) {
    const known = coordinateSystems.filter(system => system !== 'UNKNOWN');
    if (known.length > 1 || (known.some(system => system !== 'WGS84') && coordinateSystems.includes('UNKNOWN'))) fail('轨迹坐标系不同或无法确认一致，请先统一坐标系再合并。');
    if (segments.some(points => points.some(point => point.time == null))) fail('有轨迹点缺少时间，无法按时间合并；可预览原轨迹，不会补造时间。');
    for (const points of segments) {
      if (points.some((point, index) => index > 0 && point.time < points[index - 1].time)) fail('轨迹段内时间倒退，请修正源文件后合并。');
    }
    segments.sort((left, right) => left[0].time - right[0].time);
    let last = -Infinity;
    segments = segments.map(points => points.filter(point => {
      if (point.time <= last) { trimmed++; return false; }
      last = point.time; return true;
    })).filter(points => points.length);
    const data = mergedGpx(segments);
    const first = segments[0][0], tail = segments.at(-1).at(-1);
    const result = await workspace.importFile({ data, fileName: 'merged-track.gpx' }, {
      name: '合并轨迹', type: 'unknown', time: first.timeText, duration: (tail.time - first.time) / 1000,
      coordinateSystem: coordinateSystems.length === 1 ? coordinateSystems[0] : 'UNKNOWN',
    });
    fileId = result.fileId;
  }
  const tracks = preview(segments);
  const pointCount = segments.reduce((sum, points) => sum + points.length, 0);
  return { tracks, count: ids.length, pointCount, previewPointCount: tracks.reduce((sum, track) => sum + track.length, 0),
    coordinateSystems, limitations, ...(fileId ? { fileId } : {}),
    message: merge ? `已将 ${ids.length} 个文件按时间合并为 GPX，保留 ${pointCount} 个轨迹点，裁去 ${trimmed} 个重叠时间点；未补造时间。` :
      `已读取 ${ids.length} 个文件、${pointCount} 个轨迹点；显示原始坐标，未转换坐标系。` };
}
