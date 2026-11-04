import assert from 'node:assert/strict';
import test from 'node:test';
import { Decoder, Stream } from '@garmin/fitsdk';
import { createCorosSources } from '../coros-source.mjs';
import { gpxToFit } from '../fit-convert.mjs';

const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><trkseg><trkpt lat="31.2" lon="121.5"><ele>23</ele><time>2026-11-04T00:00:00Z</time>
  <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>142</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat="31.201" lon="121.501"><time>2026-11-04T00:00:30Z</time></trkpt></trkseg></trk></gpx>`;
const file = { data: Buffer.from(gpx), fileName: 'ride.gpx' };

test('GPX conversion produces a valid FIT activity without changing known time, sport or sensor data', () => {
  const fit = gpxToFit(file, { type: 'cycling' });
  const decoder = new Decoder(Stream.fromBuffer(fit.data));
  assert.equal(decoder.checkIntegrity(), true);
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, []);
  assert.equal(messages.recordMesgs.length, 2);
  assert.equal(messages.recordMesgs[0].heartRate, 142);
  assert.equal(messages.recordMesgs[0].timestamp.toISOString(), '2026-11-04T00:00:00.000Z');
  assert.equal(messages.sessionMesgs[0].sport, 'cycling');
  assert.equal(messages.sessionMesgs[0].totalTimerTime, 30);
  assert.ok(messages.sessionMesgs[0].totalDistance > 100);
  assert.throws(() => gpxToFit({ ...file, data: Buffer.from(gpx.replace(/<time>.*?<\/time>/g, '')) }), /时间/);
});

test('COROS picks the right region and never forwards the login token to the file host', async () => {
  const fit = gpxToFit(file);
  const calls = [];
  const adapter = createCorosSources(async (url, options) => {
    const address = new URL(url);
    calls.push({ address, options });
    if (address.pathname === '/activity/query') {
      return Response.json({ result: '0000', data: { dataList: [{ labelId: '123', sportType: 6, distance: 15500, duration: 1600 }] } });
    }
    if (address.pathname === '/activity/detail/download') {
      return Response.json({ result: '0000', data: { fileUrl: 'https://s3.coros.com/fit/file.fit' } });
    }
    return new Response(fit.data);
  });
  const credential = { token: 'a-fixture-token', region: '3' };
  const list = await adapter.activities('coros_int', credential);
  assert.equal(list.activities[0].distance, 15500);
  assert.equal(calls[0].address.host, 'teameuapi.coros.com');
  assert.equal(calls[0].options.headers.accesstoken, credential.token);
  const result = await adapter.download('coros_cn', credential, '123', list.activities[0]);
  assert.equal(calls[1].address.host, 'teamcnapi.coros.com');
  assert.equal(calls[1].address.searchParams.get('sportType'), '6');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[2].address.host, 's3.coros.com');
  assert.equal(calls[2].options.headers, undefined);
  assert.deepEqual(result.data, fit.data);
});
