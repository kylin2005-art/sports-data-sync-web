import assert from 'node:assert/strict';
import test from 'node:test';
import { createSources, SOURCE_DEFINITIONS, SOURCE_PLATFORMS } from '../sources.mjs';

// A small FIT activity record with a timestamp definition and valid header/file CRCs.
const fit = Buffer.from('0e2000080e0000002e4649547ac9400000140001fd0486000000004098ab', 'hex');
const gpx = Buffer.from('<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="30" lon="120"/></trkseg></trk></gpx>');
function fixture(responses) {
  const calls = [];
  const sources = createSources({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    const spec = responses.shift();
    assert.ok(spec, 'Unexpected additional network request');
    if (spec.error) throw spec.error;
    const body = spec.status === 304 ? null : spec.raw ?? (spec.json === undefined ? '' : JSON.stringify(spec.json));
    return new Response(body, { status: spec.status ?? 200, headers: spec.headers });
  } });
  return { sources, calls };
}
const row = id => ({ RideId: `ride_${id}`, Title: `Ride ${id}`, StartTime: 1793760000000, Distance: 500, Duration: 120.5 });

test('iGPSPORT sends exact list parameters and Bearer without guessing distance units', async () => {
  const { sources, calls } = fixture([{ json: { code: 0, data: { rows: [row(1)] } } }]);
  const result = await sources.activities('igpsport', { token: 'synthetic-igp' }, 20);
  assert.equal(new URL(calls[0].url).pathname, '/service/web-gateway/web-analyze/activity/queryMyActivity');
  assert.equal(new URL(calls[0].url).searchParams.get('pageNo'), '2');
  assert.equal(new URL(calls[0].url).searchParams.get('pageSize'), '20');
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-igp');
  assert.equal(result.activities[0].id, 'ride_1');
  assert.equal(result.activities[0].distance, null);
  assert.equal(result.activities[0].duration, 120.5);
  assert.equal(result.nextStart, null);
});

test('iGPSPORT non-page-aligned offsets collect the right twenty rows across two pages', async () => {
  const { sources, calls } = fixture([
    { json: { code: 0, data: { rows: Array.from({ length: 20 }, (_, index) => row(index + 1)) } } },
    { json: { code: 0, data: { rows: Array.from({ length: 20 }, (_, index) => row(index + 21)) } } }
  ]);
  const result = await sources.activities('igpsport', { token: 'synthetic' }, 5);
  assert.equal(result.activities.length, 20);
  assert.equal(result.activities[0].id, 'ride_6');
  assert.equal(result.activities.at(-1).id, 'ride_25');
  assert.equal(result.nextStart, 25);
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('pageNo')), ['1', '2']);
});

test('Xingzhe uses session Cookie and keeps metres and fractional seconds', async () => {
  const { sources, calls } = fixture([{ json: { code: 0, data: { data: [{ id: '123', title: 'Ride', start_time: 1793760000000, distance: 1234.5, duration: 45.75 }] } } }]);
  const result = await sources.activities('xingzhe', { sessionId: 'synthetic-session' }, 40);
  assert.equal(calls[0].url, 'https://www.imxingzhe.com/api/v1/pgworkout/?offset=40&limit=20');
  assert.equal(calls[0].headers.Cookie, 'sessionid=synthetic-session');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(result.activities[0].distance, 1234.5);
  assert.equal(result.activities[0].duration, 45.75);
  assert.equal(result.activities[0].time, new Date(1793760000000).toISOString());
});

test('Magene sends raw token and POST pagination then converts documented kilometres', async () => {
  const { sources, calls } = fixture([{ json: { code: 200, data: { list: [{ id: '123', name: 'Ride', distance_km: 12.5, time_seconds: 3600, start_riding_time: 1793760000 }], pagination: { has_more: false } } } }]);
  const result = await sources.activities('magene', { token: 'synthetic-magene' }, 20);
  assert.equal(calls[0].url, 'https://otm.onelap.cn/api/otm/ride_record/list');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { page: 2, limit: 20 });
  assert.equal(calls[0].headers.Authorization, 'synthetic-magene');
  assert.equal(result.activities[0].distance, 12500);
  assert.equal(result.nextStart, null);
});

test('valid empty arrays verify sessions but missing arrays never become empty success', async () => {
  for (const [platform, credential, body] of [
    ['igpsport', { token: 'synthetic' }, { code: 0, data: { rows: [] } }],
    ['xingzhe', { sessionId: 'synthetic' }, { code: 0, data: { data: [] } }],
    ['magene', { token: 'synthetic' }, { code: 200, data: { list: [] } }]
  ]) {
    const { sources } = fixture([{ json: body }]);
    assert.equal(typeof (await sources.verify(platform, credential)).message, 'string');
    const broken = fixture([{ json: { code: body.code, data: {} } }]);
    await assert.rejects(broken.sources.activities(platform, credential, 0), /活动数组/);
  }
});

test('401 403 429 500 and raw 304 are explicit failures and not retried', async () => {
  for (const status of [401, 403, 429, 500, 304]) {
    const { sources, calls } = fixture([{ status, raw: 'private upstream response' }]);
    await assert.rejects(sources.activities('igpsport', { token: 'synthetic' }, 0), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes('private upstream response'));
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('HTML malformed JSON business rejection and invalid rows fail safely', async () => {
  for (const response of [
    { raw: '<html>private-login-token</html>' }, { raw: '{broken' },
    { json: { code: 401, message: 'private-login-token' } },
    { json: { code: 0, data: { rows: [{}] } } },
    { json: { code: 0, data: { rows: [row(1), null] } } },
    { json: { code: 0, data: { rows: [{ ...row(1), RideId: 9007199254740992 }] } } }
  ]) {
    const { sources } = fixture([response]);
    await assert.rejects(sources.activities('igpsport', { token: 'synthetic' }, 0), error => {
      assert.ok(!error.message.includes('private-login-token'));
      return true;
    });
  }
});

test('iGPSPORT downloads original FIT without sending token to the signed file host', async () => {
  const { sources, calls } = fixture([
    { json: { code: 0, data: 'https://cdn.example.test/original.fit?signature=synthetic' } }, { raw: fit }
  ]);
  const result = await sources.download('igpsport', { token: 'synthetic-token' }, 'ride_123');
  assert.equal(calls[0].url, 'https://prod.zh.igpsport.com/service/web-gateway/web-analyze/activity/getDownloadUrl/ride_123');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(result.fileName, 'igpsport_ride_123.fit');
  assert.deepEqual(result.data, fit);
});

test('HTML or damaged FIT download is never returned as an activity file', async () => {
  for (const file of [Buffer.from('<html>login</html>'), Buffer.from(fit).fill(0, fit.length - 1)]) {
    const { sources } = fixture([{ json: { code: 0, data: 'https://cdn.example.test/original.fit' } }, { raw: file }]);
    await assert.rejects(sources.download('igpsport', { token: 'synthetic' }, '123'), /FIT/);
  }
});

test('Xingzhe keeps valid FIT and falls back to original GPX for unavailable FIT', async () => {
  const direct = fixture([{ raw: fit }]);
  assert.deepEqual((await direct.sources.download('xingzhe', { sessionId: 'synthetic' }, '123')).data, fit);
  assert.equal(direct.calls.length, 1);
  const fallback = fixture([{ status: 404 }, { raw: gpx }]);
  const result = await fallback.sources.download('xingzhe', { sessionId: 'synthetic' }, '123');
  assert.equal(fallback.calls[1].url, 'https://www.imxingzhe.com/api/v1/pgworkout/123/gpx/');
  assert.equal(fallback.calls[1].headers.Cookie, 'sessionid=synthetic');
  assert.equal(result.fileName, 'xingzhe_123.gpx');
  assert.deepEqual(result.data, gpx);
});

test('Xingzhe does not fall back after authentication rejection or rate limiting', async () => {
  for (const status of [401, 403, 429]) {
    const { sources, calls } = fixture([{ status }]);
    await assert.rejects(sources.download('xingzhe', { sessionId: 'synthetic' }, '123'), error => error.status === status);
    assert.equal(calls.length, 1);
  }
});

test('Magene preserves the WGS84 direct-file path and does not forward credentials to CDN', async () => {
  const { sources, calls } = fixture([
    { json: { code: 200, data: { ridingRecord: { durl: 'https://cdn.example.test/ride.fit', fitUrl: 'geo/path.fit' } } } },
    { raw: fit }
  ]);
  const result = await sources.download('magene', { token: 'synthetic' }, '123');
  assert.equal(result.coordinateSystem, 'wgs84');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.deepEqual(result.data, fit);
});

test('Magene unavailable direct file falls back to fit_content with an explicit GCJ02 marker', async () => {
  const { sources, calls } = fixture([
    { json: { code: 200, data: { ridingRecord: { durl: 'https://cdn.example.test/missing.fit', fitUrl: 'geo/path.fit' } } } },
    { status: 404 }, { raw: fit }
  ]);
  const result = await sources.download('magene', { token: 'synthetic' }, '123');
  assert.equal(calls[2].url, 'https://otm.onelap.cn/api/otm/ride_record/analysis/fit_content/' + Buffer.from('geo/path.fit').toString('base64'));
  assert.equal(calls[2].headers.Authorization, 'synthetic');
  assert.equal(result.coordinateSystem, 'gcj02');
  assert.deepEqual(result.data, fit);
});

test('source validation rejects invalid credentials pagination and unsafe download locations before use', async () => {
  const empty = fixture([]);
  await assert.rejects(empty.sources.activities('igpsport', {}, 0));
  await assert.rejects(empty.sources.activities('xingzhe', { sessionId: 'id; other=cookie' }, 0));
  await assert.rejects(empty.sources.activities('magene', { token: 'synthetic' }, -1));
  assert.equal(empty.calls.length, 0);
  for (const url of ['http://cdn.example.test/a.fit', 'https://127.0.0.1/a.fit', 'https://localhost/a.fit', 'https://user:password@cdn.example.test/a.fit']) {
    const { sources, calls } = fixture([{ json: { code: 0, data: url } }]);
    await assert.rejects(sources.download('igpsport', { token: 'synthetic' }, '123'), /下载地址/);
    assert.equal(calls.length, 1);
  }
});

test('network errors never expose credentials or full signed URLs', async () => {
  const { sources } = fixture([{ error: new Error('https://private.example/?token=private-credential') }]);
  await assert.rejects(sources.activities('igpsport', { token: 'synthetic' }, 0), error => {
    assert.ok(!error.message.includes('private-credential'));
    assert.ok(!error.message.includes('private.example'));
    return true;
  });
});

test('source form metadata exactly covers supported platforms and does not contain credentials', () => {
  assert.deepEqual(SOURCE_DEFINITIONS.map(item => item.id), SOURCE_PLATFORMS);
  for (const item of SOURCE_DEFINITIONS) {
    assert.ok(item.name && item.note);
    assert.ok(item.fields.some(field => field.required));
    assert.ok(item.fields.every(field => field.key && field.label && ['password', 'email'].includes(field.type) && typeof field.required === 'boolean'));
  }
});

test('Wahoo keeps documented summary metres and seconds and excludes plans from activity results', async () => {
  const { sources, calls } = fixture([{ json: { workouts: [
    { id: 101, workout_summary: null, minutes: 60 },
    { id: 102, name: 'Planned name', starts: '2026-11-01T08:30:00Z', workout_type_id: 40, minutes: 90,
      workout_summary: { name: 'Completed ride', distance_accum: '24909.71', duration_active_accum: '179.50' } }
  ], total: 2 } }]);
  const result = await sources.activities('wahoo', { token: 'synthetic' }, 0);
  assert.equal(calls[0].url, 'https://api.wahooligan.com/v1/workouts?page=1&per_page=20');
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic');
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].id, '102');
  assert.equal(result.activities[0].name, 'Completed ride');
  assert.equal(result.activities[0].distance, 24909.71);
  assert.equal(result.activities[0].duration, 179.5);
  assert.equal(result.nextStart, null);
});

test('Wahoo pagination advances over remote plans, including pages with no completed activities', async () => {
  const { sources } = fixture([{ json: { workouts: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, workout_summary: null })), total: 21 } }]);
  assert.deepEqual(await sources.activities('wahoo', { token: 'synthetic' }, 0), { activities: [], nextStart: 20 });
  const last = fixture([{ json: { workouts: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, workout_summary: null })), total: 20 } }]);
  assert.equal((await last.sources.activities('wahoo', { token: 'synthetic' }, 5)).nextStart, null);
});

test('Wahoo original file is tied to requested workout and downloaded without Bearer', async () => {
  const { sources, calls } = fixture([{ json: { id: 101, workout_summary: { file: { url: 'https://cdn.example.test/activity.fit' } } } }, { raw: fit }]);
  const result = await sources.download('wahoo', { token: 'synthetic' }, '101');
  assert.equal(calls[0].url, 'https://api.wahooligan.com/v1/workouts/101');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(result.fileName, 'wahoo_101.fit');
  assert.deepEqual(result.data, fit);
  for (const detail of [{ id: 999, workout_summary: { file: { url: 'https://cdn.example.test/activity.fit' } } }, { id: 101, workout_summary: null }]) {
    const mismatch = fixture([{ json: detail }]);
    await assert.rejects(mismatch.sources.download('wahoo', { token: 'synthetic' }, '101'));
    assert.equal(mismatch.calls.length, 1);
  }
});

test('Suunto requires both credentials and retains exact protected list units and offset', async () => {
  const { sources, calls } = fixture([{ json: { payload: [{ workoutKey: 'opaque-key', startTime: 1793760000000, sport: 'cycling', totalDistance: 12345.5, totalTime: 3456.75 }] } }]);
  const result = await sources.activities('suunto', { token: 'synthetic', subscriptionKey: 'synthetic-subscription' }, 5);
  assert.equal(calls[0].url, 'https://cloudapi.suunto.com/v3/workouts/?filter-by-modification-time=false&limit=20&offset=5');
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic');
  assert.equal(calls[0].headers['Ocp-Apim-Subscription-Key'], 'synthetic-subscription');
  assert.equal(result.activities[0].id, 'opaque-key');
  assert.equal(result.activities[0].distance, 12345.5);
  assert.equal(result.activities[0].duration, 3456.75);
  assert.equal(result.activities[0].time, '2026-11-04T02:40:00.000Z');
  const missing = fixture([]);
  await assert.rejects(missing.sources.activities('suunto', { token: 'synthetic' }), /Subscription Key/);
  assert.equal(missing.calls.length, 0);
});

test('Suunto downloads encoded workout key with both headers and validates FIT', async () => {
  const { sources, calls } = fixture([{ raw: fit }]);
  const result = await sources.download('suunto', { token: 'synthetic', subscriptionKey: 'synthetic-subscription' }, 'opaque/key');
  assert.equal(calls[0].url, 'https://cloudapi.suunto.com/v3/workouts/opaque%2Fkey/fit');
  assert.equal(calls[0].headers['Ocp-Apim-Subscription-Key'], 'synthetic-subscription');
  assert.deepEqual(result.data, fit);
  const corrupt = fixture([{ raw: '<html>login</html>' }]);
  await assert.rejects(corrupt.sources.download('suunto', { token: 'synthetic', subscriptionKey: 'synthetic-subscription' }, 'key'), /FIT/);
});

test('Wahoo and Suunto empty arrays verify while absent arrays and malformed records do not', async () => {
  for (const [platform, credential, key, malformed] of [
    ['wahoo', { token: 'synthetic' }, 'workouts', { id: 1 }],
    ['suunto', { token: 'synthetic', subscriptionKey: 'synthetic' }, 'payload', { sport: 'cycling' }]
  ]) {
    const empty = fixture([{ json: { [key]: [] } }]);
    assert.ok((await empty.sources.verify(platform, credential)).message);
    for (const json of [{}, { [key]: [malformed] }]) {
      await assert.rejects(fixture([{ json }]).sources.activities(platform, credential));
    }
    for (const status of [401, 403, 429, 500]) {
      const failed = fixture([{ status, raw: 'credential-private' }]);
      await assert.rejects(failed.sources.activities(platform, credential), error => error.status === status && !error.message.includes('credential-private'));
      assert.equal(failed.calls.length, 1);
    }
  }
});

test('Intervals uses personal API key and explicit date range, then slices documented descending results', async () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({ id: `i${100 + index}`, name: `Ride ${index}`, type: 'Ride', source: 'UPLOAD', start_date_local: '2026-11-04T12:00:00', distance: 12345.5, moving_time: 3600 }));
  const { sources, calls } = fixture([{ json: rows }]);
  const result = await sources.activities('intervals_icu', { apiKey: 'synthetic-key' }, 5);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/athlete/0/activities');
  assert.equal(url.searchParams.get('oldest'), '1970-01-01');
  assert.equal(url.searchParams.get('limit'), '26');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('API_KEY:synthetic-key').toString('base64'));
  assert.equal(result.activities.length, 20);
  assert.equal(result.activities[0].id, 'i105');
  assert.equal(result.activities.at(-1).id, 'i124');
  assert.equal(result.activities[0].distance, 12345.5);
  assert.equal(result.activities[0].duration, 3600);
  assert.equal(result.nextStart, 25);
});

test('Intervals official Strava stubs do not become downloadable activities and raw offset still advances', async () => {
  const { sources } = fixture([{ json: [...Array.from({ length: 20 }, () => ({})), { id: 'i123', source: 'UPLOAD' }] }]);
  assert.deepEqual(await sources.activities('intervals_icu', { apiKey: 'synthetic' }), { activities: [], nextStart: 20 });
  const strava = fixture([{ json: [{ id: '123', source: 'STRAVA' }] }]);
  assert.deepEqual(await strava.sources.activities('intervals_icu', { apiKey: 'synthetic' }), { activities: [], nextStart: null });
});

test('Intervals preserves original FIT and GPX and refuses HTML TCX or damaged FIT', async () => {
  for (const [file, extension] of [[fit, 'fit'], [gpx, 'gpx']]) {
    const { sources, calls } = fixture([{ raw: file }]);
    const result = await sources.download('intervals_icu', { apiKey: 'synthetic' }, 'i123');
    assert.equal(calls[0].url, 'https://intervals.icu/api/v1/activity/i123/file');
    assert.equal(result.fileName, `intervals_icu_i123.${extension}`);
    assert.deepEqual(result.data, file);
  }
  for (const raw of ['<html>private-token</html>', '<TrainingCenterDatabase/>', Buffer.from(fit).fill(0, fit.length - 1)]) {
    await assert.rejects(fixture([{ raw }]).sources.download('intervals_icu', { apiKey: 'synthetic' }, 'i123'), /FIT\/GPX/);
  }
});

test('Intervals validates a true empty list and rejects malformed responses or auth failures', async () => {
  assert.ok((await fixture([{ json: [] }]).sources.verify('intervals_icu', { apiKey: 'synthetic' })).message);
  for (const response of [{ json: {} }, { json: [null] }, { json: [{ name: 'Missing ID' }] }, { raw: '<html>login</html>' }, { status: 401 }, { status: 429 }]) {
    const { sources, calls } = fixture([response]);
    await assert.rejects(sources.activities('intervals_icu', { apiKey: 'synthetic' }));
    assert.equal(calls.length, 1);
  }
});

test('Komoot uses email/token Basic, zero-based pages and documented metres/seconds', async () => {
  const { sources, calls } = fixture([{ json: { _embedded: { tours: [{ id: '123', name: 'Road', sport: 'racebike', date: '2026-11-04T08:00:00Z', distance: 23456.5, duration: 1234.75 }] }, page: { totalPages: 2 } } }]);
  const result = await sources.activities('komoot', { email: 'synthetic+test@example.test', token: 'synthetic-token' }, 20);
  assert.equal(calls[0].url, 'https://api.komoot.de/v007/users/synthetic%2Btest%40example.test/tours/?limit=20&page=1');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('synthetic+test@example.test:synthetic-token').toString('base64'));
  assert.equal(result.activities[0].distance, 23456.5);
  assert.equal(result.activities[0].duration, 1234.75);
  assert.equal(result.nextStart, null);
});

test('Komoot unaligned pagination keeps correct rows and labels planned routes', async () => {
  const tours = start => Array.from({ length: 20 }, (_, index) => ({ id: String(start + index), name: 'Route', status: 'planned' }));
  const { sources, calls } = fixture([
    { json: { _embedded: { tours: tours(1) }, page: { totalPages: 2 } } },
    { json: { _embedded: { tours: tours(21) }, page: { totalPages: 2 } } }
  ]);
  const result = await sources.activities('komoot', { email: 'synthetic@example.test', token: 'synthetic' }, 5);
  assert.equal(result.activities.length, 20);
  assert.equal(result.activities[0].id, '6');
  assert.equal(result.activities.at(-1).id, '25');
  assert.match(result.activities[0].name, /^计划路线：/);
  assert.equal(result.nextStart, 25);
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('page')), ['0', '1']);
});

test('Komoot original GPX stays on fixed API host and keeps original bytes', async () => {
  const { sources, calls } = fixture([{ raw: gpx }]);
  const result = await sources.download('komoot', { email: 'synthetic@example.test', token: 'synthetic' }, '123');
  assert.equal(calls[0].url, 'https://api.komoot.de/v007/tours/123.gpx');
  assert.equal(calls[0].headers.Accept, 'application/gpx+xml');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(result.fileName, 'komoot_123.gpx');
  assert.equal(result.coordinateSystem, 'wgs84');
  assert.deepEqual(result.data, gpx);
});

test('Komoot empty list verifies, while missing credentials/pagination/array and bad downloads fail', async () => {
  const credential = { email: 'synthetic@example.test', token: 'synthetic' };
  assert.ok((await fixture([{ json: { _embedded: { tours: [] }, page: { totalPages: 0 } } }]).sources.verify('komoot', credential)).message);
  const missing = fixture([]);
  await assert.rejects(missing.sources.activities('komoot', { token: 'synthetic' }));
  assert.equal(missing.calls.length, 0);
  for (const response of [ { json: { _embedded: { tours: [] } } }, { json: { page: { totalPages: 1 } } }, { json: { _embedded: { tours: [{}] }, page: { totalPages: 1 } } }, { status: 401 }, { status: 403 }, { status: 429 } ]) {
    await assert.rejects(fixture([response]).sources.activities('komoot', credential));
  }
  for (const raw of ['<html>private-token</html>', '<gpx>incomplete', '<!DOCTYPE gpx><gpx></gpx>']) {
    await assert.rejects(fixture([{ raw }]).sources.download('komoot', credential, '123'), error => /GPX/.test(error.message) && !error.message.includes('private-token'));
  }
});
