import assert from 'node:assert/strict';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { DOMParser } from '@xmldom/xmldom';
import { processRide, processTracks, readRideSummary } from '../tracks.mjs';

const NS = 'http://www.topografix.com/GPX/1/1';
const point = (time, lat = 31, extra = '') => `<trkpt lat="${lat}" lon="121">${time ? `<time>${time}</time>` : ''}${extra}</trkpt>`;
const gpx = segments => Buffer.from(`<gpx xmlns="${NS}" xmlns:x="urn:test:sensor" version="1.1" creator="fixture"><trk>${segments.map(points => `<trkseg>${points.join('')}</trkseg>`).join('')}</trk></gpx>`);
const file = (data, coordinateSystem = 'WGS84') => ({ data, fileName: 'ride.gpx', coordinateSystem });

function workspace(files) {
  const imports = [];
  return { imports, store: { file: id => files[id] }, importFile: (value, metadata) => {
    imports.push({ ...value, metadata }); return { fileId: `merged-${imports.length}` };
  } };
}

test('preview preserves separate segments, accepts untimed coordinates, and never writes a file', async () => {
  const ws = workspace({ a: file(gpx([[point(null)], [point(null, 32)]]), 'GCJ02') });
  const result = await processTracks({ ids: ['a'] }, ws);
  assert.deepEqual(result.tracks, [[[31, 121]], [[32, 121]]]);
  assert.equal(result.count, 1);
  assert.equal(result.pointCount, 2);
  assert.deepEqual(result.coordinateSystems, ['GCJ02']);
  assert.equal(ws.imports.length, 0);
  assert.equal(result.fileId, undefined);
});

test('merge orders files by real time, trims overlapping points, preserves sensor namespaces and original offsets', async () => {
  const early = gpx([[point('2026-11-04T08:00:00+08:00'), point('2026-11-04T08:00:02+08:00', 31.1)]]);
  const late = gpx([[point('2026-11-04T00:00:01Z', 31.2), point('2026-11-04T00:00:03Z', 31.3, '<extensions><x:power>210</x:power></extensions>')]]);
  const ws = workspace({ early: file(early), late: file(late) });
  const result = await processTracks({ ids: ['late', 'early'], merge: true }, ws);
  assert.equal(result.count, 2);
  assert.equal(result.pointCount, 3);
  assert.match(result.message, /裁去 1 个/);
  assert.equal(result.fileId, 'merged-1');
  const xml = ws.imports[0].data.toString('utf8');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  const times = Array.from(parsed.getElementsByTagNameNS(NS, 'time')).map(node => node.textContent);
  assert.deepEqual(times, ['2026-11-04T08:00:00+08:00', '2026-11-04T08:00:02+08:00', '2026-11-04T00:00:03Z']);
  assert.equal(parsed.getElementsByTagNameNS('urn:test:sensor', 'power')[0].textContent, '210');
  assert.equal(parsed.getElementsByTagNameNS(NS, 'trkseg').length, 2);
  assert.equal(ws.imports[0].metadata.duration, 3);
  assert.equal(early.equals(ws.store.file('early').data), true);
});

test('merge refuses missing timestamps and reversed segments without fabricating timing', async () => {
  for (const points of [[point(null)], [point('2026-11-04T00:00:02Z'), point('2026-11-04T00:00:01Z')]]) {
    const ws = workspace({ a: file(gpx([points])) });
    await assert.rejects(processTracks({ ids: ['a'], merge: true }, ws), error => error.status === 422);
    assert.equal(ws.imports.length, 0);
  }
});

test('coordinate and calendar invalidity, missing timezone, XML entities and malformed XML are rejected', async () => {
  const fixtures = [
    gpx([[point('2026-11-04T00:00:00Z', 91)]]),
    gpx([[point('2026-02-30T00:00:00Z')]]),
    gpx([[point('2026-11-04T00:00:00')]]),
    Buffer.from('<!DOCTYPE gpx [<!ENTITY secret SYSTEM "file:///private">]><gpx/>'),
    Buffer.from(`<gpx xmlns="${NS}"><trk></gpx>`),
  ];
  for (const data of fixtures) {
    const ws = workspace({ a: file(data) });
    await assert.rejects(processTracks({ ids: ['a'] }, ws), error => error.status === 422);
    assert.equal(ws.imports.length, 0);
  }
});

test('conflicting or unverified mixed coordinates are never silently merged', async () => {
  const data = gpx([[point('2026-11-04T00:00:00Z')]]);
  for (const second of ['WGS84', undefined]) {
    const b = file(data); b.coordinateSystem = second;
    const ws = workspace({ a: file(data, 'GCJ02'), b });
    await assert.rejects(processTracks({ ids: ['a', 'b'], merge: true }, ws), /坐标系/);
    assert.equal(ws.imports.length, 0);
  }
});

test('preview downsampling is bounded, retains endpoints, and does not discard output-file points', async () => {
  const points = Array.from({ length: 10050 }, (_, index) => point(new Date(Date.UTC(2026, 10, 4) + index * 1000).toISOString(), 30 + index / 100000));
  const ws = workspace({ a: file(gpx([points])) });
  const result = await processTracks({ ids: ['a'], merge: true }, ws);
  assert.equal(result.pointCount, 10050);
  assert.equal(result.previewPointCount, 10000);
  assert.deepEqual(result.tracks[0][0], [30, 121]);
  assert.deepEqual(result.tracks[0].at(-1), [30 + 10049 / 100000, 121]);
  const xml = new DOMParser().parseFromString(ws.imports[0].data.toString(), 'application/xml');
  assert.equal(xml.getElementsByTagNameNS(NS, 'trkpt').length, 10050);
});

test('FIT SDK records convert semicircles correctly and preserve time, elevation and supported sensors', async () => {
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: new Date('2026-11-04T00:00:00Z') });
  encoder.onMesg(Profile.MesgNum.RECORD, { timestamp: new Date('2026-11-04T00:00:00Z'), positionLat: 2 ** 29, positionLong: 2 ** 30, altitude: 123, heartRate: 140, cadence: 80 });
  encoder.onMesg(Profile.MesgNum.RECORD, { timestamp: new Date('2026-11-04T00:00:01Z'), positionLat: 2 ** 29, positionLong: 2 ** 30 + 1000, altitude: 124 });
  const data = Buffer.from(encoder.close());
  const ws = workspace({ a: { data, fileName: 'ride.fit', coordinateSystem: 'WGS84' } });
  const result = await processTracks({ ids: ['a'], merge: true }, ws);
  assert.deepEqual(result.tracks[0][0], [45, 90]);
  const xml = new DOMParser().parseFromString(ws.imports[0].data.toString(), 'application/xml');
  assert.equal(xml.getElementsByTagNameNS(NS, 'ele')[0].textContent, '123');
  assert.equal(xml.getElementsByTagNameNS(NS, 'time')[0].textContent, '2026-11-04T00:00:00.000Z');
  assert.equal(xml.getElementsByTagNameNS('http://www.garmin.com/xmlschemas/TrackPointExtension/v1', 'hr')[0].textContent, '140');
  const corrupt = Buffer.from(data); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(processTracks({ ids: ['a'] }, workspace({ a: { data: corrupt, fileName: 'broken.fit' } })), /CRC/);
  assert.equal(readRideSummary({ data: corrupt, fileName: 'broken.fit' }), null);
});

test('GPX route points and GPX 1.0 track points produce GPX 1.1 track points', async () => {
  const data = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/0" version="1.0"><rte><rtept lat="30" lon="120"><time>2026-11-04T00:00:00Z</time></rtept></rte></gpx>');
  const ws = workspace({ a: file(data) });
  await processTracks({ ids: ['a'], merge: true }, ws);
  const xml = new DOMParser().parseFromString(ws.imports[0].data.toString(), 'application/xml');
  assert.equal(xml.getElementsByTagNameNS(NS, 'trkpt').length, 1);
  assert.equal(xml.getElementsByTagNameNS(NS, 'time').length, 1);
});

test('ride preview uses FIT session units and supports indoor files without GPS', () => {
  const encode = new Encoder();
  const startTime = new Date('2026-11-04T08:00:00+08:00');
  encode.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1 });
  encode.onMesg(Profile.MesgNum.RECORD, { timestamp: startTime, heartRate: 145, power: 200, cadence: 85 });
  encode.onMesg(Profile.MesgNum.SESSION, { startTime, sport: 'cycling', totalDistance: 15000,
    totalTimerTime: 1800, totalElapsedTime: 2100, totalAscent: 245, enhancedAvgSpeed: 8.4,
    avgHeartRate: 145, avgPower: 200, avgCadence: 85 });
  const ws = workspace({ a: { data: Buffer.from(encode.close()), fileName: 'indoor.fit' } });
  const result = processRide({ id: 'a' }, ws);
  assert.deepEqual(result, {
    name: 'indoor.fit', format: 'fit', startTime: '2026-11-04T00:00:00.000Z', metrics: {
      distanceM: 15000, durationSeconds: 1800, durationKind: 'timer', ascentM: 245,
      avgSpeedMps: 8.4, avgHeartRateBpm: 145, avgPowerW: 200, avgCadenceRpm: 85,
    }, estimated: [], route: [], trimmedRoute: [], elevation: [],
    mapSegments: [], mapSpeedEstimated: false, mapCoordinateSystem: null,
  });
  assert.deepEqual(readRideSummary(ws.store.file('a')),
    { startTime: result.startTime, metrics: result.metrics, estimated: result.estimated });
  assert.equal(ws.imports.length, 0);
});

test('ride preview estimates GPX distance within segments and trims over 500 m per end', () => {
  const timed = (offset, lat, elevation) => point(new Date(Date.UTC(2026, 10, 4) + offset * 1000).toISOString(),
    lat, '<ele>' + elevation + '</ele>');
  const data = gpx([
    Array.from({ length: 5 }, (_, i) => timed(i * 10, 31 + i * 0.002, 10 + i)),
    Array.from({ length: 5 }, (_, i) => timed((i + 5) * 10, 31.5 + i * 0.002, 20 + i)),
  ]);
  const ws = workspace({ a: file(data) });
  const result = processRide({ id: 'a' }, ws);
  assert.ok(result.metrics.distanceM > 1770 && result.metrics.distanceM < 1790);
  assert.equal(result.metrics.durationSeconds, 90);
  assert.equal(result.metrics.durationKind, 'elapsed');
  assert.equal(result.metrics.avgSpeedMps, null);
  assert.equal(result.metrics.ascentM, null);
  assert.deepEqual(result.estimated, ['distanceM', 'durationSeconds']);
  assert.deepEqual(result.route.map(segment => segment.map(([,, alt]) => alt)), [[10, 11, 12, 13, 14], [20, 21, 22, 23, 24]]);
  assert.deepEqual(result.trimmedRoute.map(segment => segment.map(([,, alt]) => alt)), [[13, 14], [20, 21]]);
  for (const segment of [...result.route, ...result.trimmedRoute]) {
    for (const [x, y] of segment) {
      assert.equal(x, 0.5);
      assert.ok(y >= 0 && y <= 1);
    }
  }
  assert.equal(result.elevation[1][0][0], result.elevation[0].at(-1)[0]);
  assert.equal(result.elevation[1].at(-1)[0], result.metrics.distanceM);
  assert.equal(result.startTime, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(readRideSummary(ws.store.file('a')),
    { startTime: result.startTime, metrics: result.metrics, estimated: result.estimated });
  assert.equal(ws.imports.length, 0);
  assert.equal(data.equals(ws.store.file('a').data), true);
});

test('short or untimed routes omit unavailable ride metrics and keep missing altitude null', () => {
  const data = gpx([[point(null, 31, '<ele>7</ele>'), point(null, 31.001), point(null, 31.002, '<ele>9</ele>')]]);
  const ws = workspace({ a: { ...file(data), time: '2026-11-05T00:00:00Z', distance: 1234, duration: 56 } });
  const result = processRide({ id: 'a' }, ws);
  assert.equal(result.startTime, null);
  assert.ok(result.metrics.distanceM > 200 && result.metrics.distanceM < 250);
  assert.equal(result.metrics.durationSeconds, null);
  assert.equal(result.metrics.durationKind, null);
  assert.deepEqual(result.estimated, ['distanceM']);
  assert.deepEqual(result.route[0].map(([,, alt]) => alt), [7, null, 9]);
  assert.deepEqual(result.trimmedRoute, []);
  assert.deepEqual(result.elevation, []);
  assert.deepEqual(readRideSummary(ws.store.file('a')),
    { startTime: null, metrics: result.metrics, estimated: ['distanceM'] });
  assert.throws(() => processRide({ id: 'other' }, ws), { status: 404 });
});

test('trimmed ride splits edges passing through an endpoint radius and preserves safe portions', () => {
  const at = (lat, altitude) => '<trkpt lat="' + lat + '" lon="0"><ele>' + altitude + '</ele></trkpt>';
  const crossingOnly = [0, 0.006, -0.006, -0.012].map(at);
  const withSafePortions = [0, 0.006, 0.012, -0.006, -0.012, -0.018].map(at);
  const ws = workspace({ a: file(gpx([crossingOnly])), b: file(gpx([withSafePortions])) });
  assert.deepEqual(processRide({ id: 'a' }, ws).trimmedRoute, []);
  const result = processRide({ id: 'b' }, ws);
  assert.deepEqual(result.trimmedRoute.map(segment => segment.map(([, , alt]) => alt)), [[1, 2], [3, 4]]);
});

test('downsampling cannot create a new trimmed edge across an endpoint radius', () => {
  const at = (lat, lon, altitude) => '<trkpt lat="' + lat + '" lon="' + lon + '"><ele>' + altitude + '</ele></trkpt>';
  const points = [at(0, 0, 100), at(-0.0045, 0.0022, 101), at(0, 0.008, 102), at(0.0045, 0.0022, 103),
    ...Array.from({ length: 3997 }, (_, i) => at(0.0045, 0.003 + i / 1_000_000, 200)),
    at(0.0045, 0.04, 300)];
  const ws = workspace({ a: file(gpx([points])) });
  const result = processRide({ id: 'a' }, ws);
  assert.equal(result.mapSegments.flat().length, 2000);
  const routes = result.trimmedRoute;
  assert.ok(routes.length > 0);
  assert.ok(routes[0].some(([, , alt]) => alt === 103));
  assert.ok(routes.every(segment => segment.length >= 2 &&
    !segment.some(([, , alt]) => alt === 101 || alt === 102)));
});

test('multiple FIT sessions are not labeled as one ride', () => {
  const encode = new Encoder();
  encode.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity' });
  encode.onMesg(Profile.MesgNum.SESSION, { sport: 'cycling', totalTimerTime: 1800 });
  encode.onMesg(Profile.MesgNum.SESSION, { sport: 'running', totalTimerTime: 600 });
  const ws = workspace({ a: { data: Buffer.from(encode.close()), fileName: 'multi.fit' } });
  assert.throws(() => processRide({ id: 'a' }, ws), { status: 422 });
  assert.equal(readRideSummary(ws.store.file('a')), null);
});

test('explicit noncycling FIT is refused while generic and indoor cycling are supported', () => {
  function activity(sport, subSport) {
    const encoder = new Encoder();
    encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity' });
    encoder.onMesg(Profile.MesgNum.SESSION, { sport, ...(subSport && { subSport }), totalTimerTime: 1800 });
    return { data: Buffer.from(encoder.close()), fileName: 'activity.fit' };
  }
  const ws = workspace({ run: activity('running'), unknown: activity('generic'),
    indoor: activity('fitnessEquipment', 'indoorCycling'), bike: activity('eBiking') });
  assert.throws(() => processRide({ id: 'run' }, ws), { status: 422 });
  assert.equal(readRideSummary(ws.store.file('run')), null);
  for (const id of ['unknown', 'indoor', 'bike']) assert.equal(processRide({ id }, ws).metrics.durationSeconds, 1800);
});

test('map prefers recorded FIT speed and power, estimates missing speed, and splits timer pauses and long gaps', () => {
  const encoder = new Encoder();
  const time = seconds => new Date(Date.UTC(2026, 10, 4) + seconds * 1000);
  const semicircles = degrees => Math.round(degrees * 2 ** 31 / 180);
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity' });
  const timer = (seconds, eventType) => encoder.onMesg(Profile.MesgNum.EVENT, {
    event: 'timer', eventType, timestamp: time(seconds),
  });
  const writePoint = (seconds, position, fields = {}) => encoder.onMesg(Profile.MesgNum.RECORD, {
    timestamp: time(seconds), positionLat: semicircles(31), positionLong: semicircles(121 + position * 0.00005), ...fields,
  });
  timer(0, 'start');
  writePoint(0, 0, { enhancedSpeed: 0, speed: 8, power: 0, distance: 0 });
  writePoint(1, 1, { speed: 6, power: 125, distance: 6 });
  writePoint(2, 2, { distance: 13 });
  timer(3, 'stop');
  timer(6, 'start');
  writePoint(7, 3, { distance: 21, power: 160 });
  writePoint(8, 4, { distance: 31, power: 0 });
  writePoint(55, 5, { distance: 60 });
  writePoint(56, 6, { distance: 65 });
  writePoint(57, 7, { compressedSpeedDistance: [0x85, 0x03, 0x20] });
  const ws = workspace({ a: { data: Buffer.from(encoder.close()), fileName: 'ride.fit' } });
  const result = processRide({ id: 'a' }, ws);
  assert.equal(result.mapCoordinateSystem, 'WGS84');
  assert.equal(result.mapSpeedEstimated, true);
  assert.deepEqual(result.mapSegments.map(segment => segment.map(point => point.slice(2))),
    [[[0, 0], [6, 125], [7, null]], [[10, 160], [10, 0]], [[5, null], [5, null], [9.01, null]]]);
  assert.ok(Math.abs(result.mapSegments[0][0][0] - 121) < 1e-6);
  assert.ok(Math.abs(result.mapSegments[0][0][1] - 31) < 1e-6);
  assert.equal(result.route.length, 1);
  assert.equal(ws.imports.length, 0);
});

test('map reads recognized GPX point extensions, preserves zero, and never derives across track segments', () => {
  const time = seconds => new Date(Date.UTC(2026, 10, 4) + seconds * 1000).toISOString();
  const speed = '<extensions><tp:TrackPointExtension><tp:speed>0</tp:speed><tp:power>0</tp:power></tp:TrackPointExtension></extensions>';
  const watts = '<extensions><p:PowerInWatts>190</p:PowerInWatts></extensions>';
  const genericWatts = '<extensions><power>225</power></extensions>';
  const unrelated = '<extensions><x:power>999</x:power></extensions>';
  const data = Buffer.from(gpx([
    [point(time(0), 31, speed), point(time(1), 31.00003, watts), point(time(2), 31.00006, unrelated)],
    [point(time(3), 31.00009, genericWatts), point(time(4), 31.00012)],
    [point(time(40), 31.00015), point(time(41), 31.00018), point(time(90), 31.00021), point(time(91), 31.00024)],
    [point(null, 31.00025), point(null, 31.00026)],
  ]).toString().replace('xmlns:x="urn:test:sensor"',
    'xmlns:x="urn:test:sensor" xmlns:tp="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" xmlns:p="http://www.garmin.com/xmlschemas/PowerExtension/v1"'));
  const ws = workspace({ a: file(data, 'EPSG:4326') });
  const result = processRide({ id: 'a' }, ws);
  const segments = result.mapSegments;
  assert.equal(result.mapCoordinateSystem, 'WGS84');
  assert.equal(result.mapSpeedEstimated, true);
  assert.deepEqual(segments.map(segment => segment.length), [3, 2, 2, 2, 2]);
  assert.deepEqual(segments[0][0], [121, 31, 0, 0]);
  assert.equal(segments[0][1][3], 190);
  assert.ok(segments[0][1][2] > 3 && segments[0][1][2] < 4);
  assert.equal(segments[0][2][3], null);
  assert.ok(segments[1][0][2] > 3 && segments[1][0][2] < 4);
  assert.equal(segments[1][0][2], segments[1][1][2]);
  assert.equal(segments[1][0][3], 225);
  assert.ok(segments[3][0][2] > 3 && segments[3][0][2] < 4);
  assert.equal(segments[3][0][2], segments[3][1][2]);
  assert.equal(segments[3][0][3], null);
  assert.deepEqual(segments[4].map(point => point.slice(2)), [[null, null], [null, null]]);
});

test('unverified or non-WGS84 coordinates stay out of the real map while the share shape still works', () => {
  const data = gpx([[point(null, 31), point(null, 31.01)]]);
  const ws = workspace({ gcj: file(data, 'GCJ-02'), bd: file(data, 'BD09'), unknown: file(data, 'UNKNOWN'),
    standard: { data, fileName: 'ride.gpx' } });
  for (const id of ['gcj', 'bd', 'unknown']) {
    const result = processRide({ id }, ws);
    assert.equal(result.mapCoordinateSystem, null);
    assert.equal(result.mapSpeedEstimated, false);
    assert.deepEqual(result.mapSegments, []);
    assert.equal(result.route.length, 1);
  }
  const standard = processRide({ id: 'standard' }, ws);
  assert.equal(standard.mapCoordinateSystem, 'WGS84');
  assert.equal(standard.mapSpeedEstimated, false);
  assert.deepEqual(standard.mapSegments, [[[121, 31, null, null], [121, 31.01, null, null]]]);
});
