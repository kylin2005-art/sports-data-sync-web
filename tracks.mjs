import { Decoder, Stream } from '@garmin/fitsdk';
import { DOMParser, DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import { WorkspaceError } from './sync-workspace.mjs';

const GPX = 'http://www.topografix.com/GPX/1/1';
const GPX_OLD = 'http://www.topografix.com/GPX/1/0';
const TRACK_EXT = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const MAX_POINTS = 200000;
const PREVIEW_POINTS = 10000;
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

function readFit(data) {
  let decoded;
  try {
    const decoder = new Decoder(Stream.fromBuffer(data));
    if (!decoder.checkIntegrity()) fail('FIT 长度或 CRC 校验失败。');
    decoded = decoder.read({ applyScaleAndOffset: true, convertDateTimesToDates: true, includeUnknownData: false });
  } catch (error) { if (error instanceof WorkspaceError) throw error; fail('FIT 无法解析。'); }
  if (decoded.errors.length) fail('FIT 解码包含错误，未使用不完整轨迹。');
  const segments = [];
  let points = [], count = 0;
  for (const record of decoded.messages.recordMesgs || []) {
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
      heartRate: record.heartRate, cadence: record.cadence, temperature: record.temperature });
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

/** Parsed coordinates use degrees and time uses epoch milliseconds; GPX DOM nodes retain extensions. */
export function parseTrack(file) {
  if (!Buffer.isBuffer(file?.data) || !file.data.length || file.data.length > 50 * 1024 * 1024) {
    throw new WorkspaceError(413, '轨迹文件为空或超过 50 MB。');
  }
  const format = typeof file.fileName === 'string' ? file.fileName.match(/\.(fit|gpx)$/i)?.[1]?.toLowerCase() : null;
  if (!format) fail('仅支持 FIT 或 GPX 轨迹。');
  return { format, segments: format === 'fit' ? readFit(file.data) : readGpx(file.data),
    coordinateSystem: typeof file.coordinateSystem === 'string' ? file.coordinateSystem.toUpperCase().replace(/[-_\s]/g, '') : 'UNKNOWN' };
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
  if (segments.length > 1000) fail('轨迹分段过多，请分批处理。');
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
