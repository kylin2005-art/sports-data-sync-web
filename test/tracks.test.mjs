import assert from 'node:assert/strict';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { DOMParser } from '@xmldom/xmldom';
import { processTracks } from '../tracks.mjs';

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
});

test('GPX route points and GPX 1.0 track points produce GPX 1.1 track points', async () => {
  const data = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/0" version="1.0"><rte><rtept lat="30" lon="120"><time>2026-11-04T00:00:00Z</time></rtept></rte></gpx>');
  const ws = workspace({ a: file(data) });
  await processTracks({ ids: ['a'], merge: true }, ws);
  const xml = new DOMParser().parseFromString(ws.imports[0].data.toString(), 'application/xml');
  assert.equal(xml.getElementsByTagNameNS(NS, 'trkpt').length, 1);
  assert.equal(xml.getElementsByTagNameNS(NS, 'time').length, 1);
});
