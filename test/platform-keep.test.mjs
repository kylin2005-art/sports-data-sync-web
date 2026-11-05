import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { gpxToFit } from '../fit-convert.mjs';
import { validFit } from '../garmin-browser.mjs';
import { createKeepSources, keepPasswordProviders } from '../platform-keep.mjs';
import { parseTrack } from '../tracks.mjs';

const token = 'keep.mock-session-1234';
const startTime = Date.UTC(2026, 9, 25, 10);
const activity = (index) => ({ logs: [{ stats: {
  id: `ride_${index}`, startTime: startTime - index * 3_600_000, distance: 23100, duration: 3600
} }] });

function encodeTrack(points) {
  const cipher = createCipheriv('aes-128-cbc', '56fe59;82g:d873c', '2346892432920300');
  return Buffer.concat([cipher.update(gzipSync(JSON.stringify(points))), cipher.final()]).toString('base64');
}

test('Keep posts a form and returns only the session token for protected verification', async () => {
  const input = { mobile: '+8613800138000', password: 'test +/&中文' };
  const result = await keepPasswordProviders.keep.signIn(input, async (url, options) => {
    assert.equal(url, 'https://api.gotokeep.com/v1.1/users/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.fromEntries(options.body), input);
    return Response.json({ ok: true, data: { token, mobile: input.mobile } });
  });
  assert.deepEqual(result, { credential: { token }, verified: false });
  await assert.rejects(
    keepPasswordProviders.keep.signIn(input, async () => Response.json({ ok: false, text: input.password })),
    error => error.status === 401 && !error.message.includes(input.password)
  );
});

test('Keep requires a protected activity array and follows its cursor without duplicate rides', async () => {
  const cursors = [];
  const sources = createKeepSources({ fetchImpl: async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, 'https://api.gotokeep.com/pd/v3/stats/detail');
    assert.equal(target.searchParams.get('type'), 'cycling');
    assert.equal(target.searchParams.get('dateUnit'), 'all');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    const cursor = Number(target.searchParams.get('lastDate'));
    cursors.push(cursor);
    return Response.json({ ok: true, data: cursor
      ? { records: [activity(19), activity(20), activity(21)], lastTimestamp: 0 }
      : { records: Array.from({ length: 20 }, (_, index) => activity(index)), lastTimestamp: startTime }
    });
  } });
  await sources.verify('keep', { token });
  assert.deepEqual(cursors, [0]);
  const page = await sources.activities('keep', { token });
  assert.equal(page.nextStart, 20);
  assert.equal(page.activities.length, 20);
  assert.deepEqual(page.activities[0], {
    id: 'ride_0', name: 'Keep 骑行', type: 'cycling', time: new Date(startTime).toISOString(), distance: 23100, duration: 3600
  });
  const final = await sources.activities('keep', { token }, page.nextStart);
  assert.deepEqual(final.activities.map(item => item.id), ['ride_20', 'ride_21']);
  assert.equal(final.nextStart, null);
  assert.deepEqual(cursors, [0, 0, startTime, 0, startTime]);
  const denied = createKeepSources({ fetchImpl: async () => Response.json({ ok: false, data: { records: [] } }) });
  await assert.rejects(denied.verify('keep', { token }), { status: 502 });
});

test('Keep converts its authenticated cycling payload to WGS84 GPX usable for FIT conversion', async () => {
  const sources = createKeepSources({ fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.gotokeep.com/pd/v3/cyclinglog/ride_0');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({ ok: true, data: { startTime, geoPoints: encodeTrack([
      { latitude: 39.9102265, longitude: 116.4037136, unixTimestamp: startTime, altitude: 56 },
      { lat: 39.9103265, lon: 116.4038136, timestamp: 20, altitude: 58 }
    ]) } });
  } });
  const file = await sources.download('keep', { token }, 'ride_0');
  assert.equal(file.fileName, 'keep_ride_0.gpx');
  assert.equal(file.coordinateSystem, 'wgs84');
  const [first, second] = parseTrack(file).segments[0];
  assert.ok(Math.abs(first.lat - 39.908823) < 0.00005);
  assert.ok(Math.abs(first.lon - 116.397470) < 0.00005);
  assert.equal(first.elevation, 56);
  assert.equal(first.time, startTime);
  assert.equal(second.time, startTime + 20_000);
  assert.ok(validFit(gpxToFit(file, { type: 'cycling' }).data));
});

test('Keep rejects activities lacking a real route and never fetches an alternate provider URL', async () => {
  let calls = 0;
  const sources = createKeepSources({ fetchImpl: async () => {
    calls++;
    return Response.json({ ok: true, data: { rawDataURL: 'http://192.0.2.1/ignore' } });
  } });
  await assert.rejects(sources.download('keep', { token }, 'ride_0'), { status: 422 });
  await assert.rejects(sources.download('keep', { token }, '../ride_0'), { status: 400 });
  assert.equal(calls, 1);
});
