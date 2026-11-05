import { gcj02ToWgs84 } from './fit-coordinate.mjs';

const fields = ['startTime', 'start_time', 'beginTime', 'begin_time', 'startDate', 'start_date', 'date', 'time', 'startTimestamp', 'start_timestamp'];
const number = value => typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;

function epoch(value) {
  const numeric = number(value);
  const ms = Number.isFinite(numeric) ? (numeric >= 1e12 ? numeric : numeric >= 1e9 ? numeric * 1000 : NaN)
    : typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 1e12 && ms <= 8.64e15 ? ms : NaN;
}

function blackbirdPoint(point, start) {
  if (typeof point === 'string') {
    // The nine-field Blackbird format is GCJ-02, altitude, centiwatts, bpm, rpm, deci-km/h, seconds and a reserved field.
    const columns = point.split(',');
    if (columns.length !== 9) return null;
    const [lat, lon, altitude, power, heart, cadence, speed, offset] = columns.map(number);
    return { lat, lon, altitude, power: power / 100, heart, cadence, speed: speed / 36, at: start + offset * 1000 };
  }
  if (!point || typeof point !== 'object') return null;
  const at = epoch(point.time ?? point.timestamp);
  return {
    lat: number(point.lat ?? point.latitude), lon: number(point.lng ?? point.longitude),
    altitude: number(point.ele ?? point.altitude), power: number(point.power ?? point.watts),
    heart: number(point.hr ?? point.heartRate ?? point.heart_rate), cadence: number(point.cad ?? point.cadence),
    at: Number.isFinite(at) ? at : start + number(point.offset ?? point.time_offset) * 1000
  };
}

export function blackbirdTrackGpx(detail) {
  const track = detail.track ?? detail.points;
  const points = Array.isArray(track) ? track : typeof track === 'string' ? track.split(';') : [];
  if (points.length < 2 || points.length > 50_001) return null;
  const start = fields.map(field => epoch(detail[field])).find(Number.isFinite);
  const xml = [];
  let first, last;
  for (const raw of points) {
    const point = blackbirdPoint(raw, start);
    if (!point) continue;
    const { lat, lon, altitude, power, heart, cadence, speed, at } = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) continue;
    if (!Number.isFinite(at) || at < 1e12 || at > 8.64e15 || at < last) return null;
    const [latitude, longitude] = gcj02ToWgs84(lat, lon);
    first ??= at;
    last = at;
    const extensions = [[heart, 'hr'], [cadence, 'cad'], [speed, 'speed'], [power, 'power']]
      .filter(([value]) => Number.isFinite(value) && value > 0)
      .map(([value, tag]) => `<gpxtpx:${tag}>${value}</gpxtpx:${tag}>`).join('');
    xml.push(`<trkpt lat="${latitude.toFixed(7)}" lon="${longitude.toFixed(7)}">${Number.isFinite(altitude) ? `<ele>${altitude}</ele>` : ''}<time>${new Date(at).toISOString()}</time>${extensions ? `<extensions><gpxtpx:TrackPointExtension>${extensions}</gpxtpx:TrackPointExtension></extensions>` : ''}</trkpt>`);
  }
  if (xml.length < 2 || last <= first) return null;
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx creator="Sports Data Sync Web" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">' +
    '<trk><name>黑鸟骑行</name><type>cycling</type><trkseg>' + xml.join('\n') + '</trkseg></trk></gpx>');
}
