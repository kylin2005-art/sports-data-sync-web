import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCyCitySources, cyCityPasswordProviders } from '../cycity.mjs';
import { gpxToFit } from '../fit-convert.mjs';

const credential = { token: 'synthetic-cycity-token' };
const fixture = gpxToFit({ fileName: 'ride.gpx', data: Buffer.from(
  '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' +
  '<trkpt lat="35.1" lon="117.2"><time>2026-10-24T10:00:00Z</time></trkpt>' +
  '<trkpt lat="35.2" lon="117.3"><time>2026-10-24T10:05:00Z</time></trkpt></trkseg></trk></gpx>'
) }, { type: 'cycling' }).data;

test('CyCity sends the upstream phone password form only to its fixed HTTPS host and returns a token', async () => {
  const input = { mobile: '13800000000', password: 'mock password' };
  const result = await cyCityPasswordProviders.cycity.signIn(input, async (url, options) => {
    assert.equal(url, 'https://cycity.cc/api/auth/mobile/login');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { phonenumber: input.mobile, password: input.password, grantType: 'password' });
    return Response.json({ code: 200, data: { access_token: credential.token, userId: '1' } });
  });
  assert.deepEqual(result, { credential, verified: false });
});

test('CyCity validates the protected ride list and returns the provider FIT unchanged', async () => {
  const paths = [];
  const sources = createCyCitySources({ fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    assert.equal(options.redirect, 'error');
    paths.push(url);
    if (url.includes('/exportFitFile?')) return new Response(fixture);
    return Response.json({ code: 200, total: 1, rows: [
      { id: '123', startTime: '2026-10-24 18:00:00', movingDistance: 21.5, movingDuration: 3600 }
    ] });
  } });
  await sources.verify('cycity', credential);
  assert.deepEqual(await sources.activities('cycity', credential), {
    activities: [{ id: '123', name: 'CyCity 骑行', type: 'cycling', time: '2026-10-24 18:00:00', distance: 21500, duration: 3600 }],
    nextStart: null
  });
  assert.deepEqual(await sources.download('cycity', credential, '123'), { data: fixture, fileName: 'cycity_123.fit' });
  assert.deepEqual(paths, [
    'https://cycity.cc/api/mobile/cycling/rideRecordsPage?pageNum=1&pageSize=1',
    'https://cycity.cc/api/mobile/cycling/rideRecordsPage?pageNum=1&pageSize=20',
    'https://cycity.cc/api/mobile/cycling/exportFitFile?rideId=123'
  ]);
  const invalid = createCyCitySources({ fetchImpl: async () => Response.json({ code: 200, msg: 'private data' }) });
  await assert.rejects(invalid.verify('cycity', credential), error => error.status === 502 && !error.message.includes('private data'));
  await assert.rejects(invalid.download('cycity', credential, '123'), { status: 502 });
});
