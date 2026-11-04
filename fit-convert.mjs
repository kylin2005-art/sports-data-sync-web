import { Encoder, Profile } from '@garmin/fitsdk';
import { parseTrack } from './tracks.mjs';

const degreesToSemicircles = 2 ** 31 / 180;
const extension = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };

function between(first, next) {
  const rad = Math.PI / 180;
  const a = Math.sin((next.lat - first.lat) * rad / 2) ** 2 + Math.cos(first.lat * rad) * Math.cos(next.lat * rad) *
    Math.sin((next.lon - first.lon) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function sport(type) {
  const name = String(type || '').toLowerCase();
  if (/cycl|ride|骑行/.test(name)) return 'cycling';
  if (/run|跑步/.test(name)) return 'running';
  if (/hik|徒步/.test(name)) return 'hiking';
  if (/walk|步行/.test(name)) return 'walking';
  return 'generic';
}

function pointFields(point) {
  const values = {};
  const read = name => {
    const text = point.node?.getElementsByTagNameNS(extension, name)?.[0]?.textContent?.trim();
    return text ? Number(text) : NaN;
  };
  const heartRate = read('hr'), cadence = read('cad'), temperature = read('atemp');
  if (Number.isInteger(heartRate) && heartRate > 0 && heartRate < 255) values.heartRate = heartRate;
  if (Number.isInteger(cadence) && cadence >= 0 && cadence < 255) values.cadence = cadence;
  if (Number.isFinite(temperature) && temperature >= -128 && temperature < 127) values.temperature = Math.round(temperature);
  if (Number.isFinite(point.elevation) && point.elevation >= -500 && point.elevation < 100000) values.enhancedAltitude = point.elevation;
  return values;
}

export function gpxToFit(file, activity = {}) {
  const parsed = parseTrack(file);
  if (parsed.format !== 'gpx') reject('请选择 GPX 文件。');
  const points = parsed.segments.flat();
  if (points.length < 2 || points.some(point => point.time == null || point.time < Date.UTC(1990, 0, 1)) ||
      points.some((point, index) => index > 0 && point.time < points[index - 1].time) || points.at(-1).time <= points[0].time) {
    reject('GPX 转 FIT 需要至少两个按时间排序、带时区的有效轨迹点。');
  }
  const encode = new Encoder();
  const write = (kind, fields) => encode.onMesg(Profile.MesgNum[kind], fields);
  const startTime = new Date(points[0].time), timestamp = new Date(points.at(-1).time);
  write('FILE_ID', { manufacturer: 'development', product: 0, timeCreated: startTime, type: 'activity' });
  let totalDistance = 0, totalTimerTime = 0;
  for (const segment of parsed.segments) {
    write('EVENT', { timestamp: new Date(segment[0].time), event: 'timer', eventType: 'start' });
    let previous;
    for (const point of segment) {
      if (previous) totalDistance += between(previous, point);
      write('RECORD', { timestamp: new Date(point.time), positionLat: Math.round(point.lat * degreesToSemicircles),
        positionLong: point.lon === 180 ? -2147483648 : Math.round(point.lon * degreesToSemicircles),
        distance: totalDistance, ...pointFields(point) });
      previous = point;
    }
    totalTimerTime += (segment.at(-1).time - segment[0].time) / 1000;
    write('EVENT', { timestamp: new Date(segment.at(-1).time), event: 'timer', eventType: 'stop' });
  }
  const summary = { startTime, timestamp, totalDistance, totalTimerTime, totalElapsedTime: (timestamp - startTime) / 1000 };
  const sportName = sport(activity.type);
  write('LAP', { ...summary, messageIndex: 0, sport: sportName });
  write('SESSION', { ...summary, messageIndex: 0, sport: sportName, subSport: 'generic', firstLapIndex: 0, numLaps: 1 });
  write('ACTIVITY', { timestamp, totalTimerTime, numSessions: 1, type: 'manual' });
  return { data: Buffer.from(encode.close()), fileName: file.fileName.replace(/\.gpx$/i, '.fit'), coordinateSystem: file.coordinateSystem };
}
