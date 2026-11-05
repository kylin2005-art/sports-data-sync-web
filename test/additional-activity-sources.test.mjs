import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformLogin } from '../platform-login.mjs';
import { PlatformPasswords } from '../platform-password.mjs';
import { createSources } from '../sources.mjs';

const fit = Buffer.from('0e2000080e0000002e4649547ac9400000140001fd0486000000004098ab', 'hex');
const gpx = Buffer.from('<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="30" lon="120"/></trkseg></trk></gpx>');
const bryton = 'https://active.brytonsport.com';
const whoosh = 'https://service14.mywhoosh.com/v2/rider/profile';
const igpIntl = 'https://prod.en.igpsport.com/service/web-gateway/web-analyze/activity';

test('iGPSPORT international uses separate browser and API domains, headers, and original FIT', async () => {
  assert.ok(PlatformLogin.platforms.includes('igpsport_int'));
  const calls = [];
  const signed = 'https://igpsport-fixture.s3.amazonaws.com/ride.fit';
  const credential = { token: 'intl-fixture-token' };
  const source = createSources({ fetchImpl: async (url, options) => {
    calls.push(url);
    if (url === signed) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(fit);
    }
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    assert.equal(options.headers.Origin, 'https://app.igpsport.com');
    assert.equal(options.headers['X-Platform'], 'web');
    assert.equal(options.headers['Qiwu-App-Version'], '7.07.08');
    if (url.includes('/queryMyActivity?')) return Response.json({ code: 0, data: { rows: [
      { rideId: 17, title: 'Road ride', exerciseType: 'cycling', startTime: 1793760000000, rideDistance: 23500, totalMovingTime: 1900 }
    ], totalRows: 21 } });
    return Response.json({ code: 0, data: signed });
  } });
  const page = await source.activities('igpsport_int', credential, 20);
  assert.deepEqual(page, { activities: [{ id: '17', name: 'Road ride', type: 'cycling', time: new Date(1793760000000).toISOString(),
    distance: 23500, duration: 1900 }], nextStart: null });
  assert.deepEqual(await source.download('igpsport_int', credential, '17'), { data: fit, fileName: 'igpsport_int_17.fit' });
  assert.deepEqual(calls, [`${igpIntl}/queryMyActivity?pageNo=2&pageSize=20&reqType=0&sort=1&sortType=1`, `${igpIntl}/getDownloadUrl/17`, signed]);
});

test('Bryton uses the official browser option, protected list and original file fallback', async () => {
  assert.ok(PlatformLogin.platforms.includes('bryton'));
  const calls = [];
  const credential = { cookie: 'SESSION=fixture-bryton' };
  const source = createSources({ fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Cookie, credential.cookie);
    assert.equal(options.redirect, 'error');
    if (url.includes('/list?')) return Response.json({ data: { list: [{ activityId: 123, name: '骑行', distance: 12500, elapsedTime: 1900 }] } });
    if (url.endsWith('/fit')) return new Response(null, { status: 404 });
    return new Response(gpx);
  } });
  const { activities } = await source.activities('bryton', credential, 20);
  assert.deepEqual(activities, [{ id: '123', name: '骑行', distance: 12500, duration: 1900, time: '', type: 'cycling' }]);
  assert.deepEqual(await source.download('bryton', credential, '123'), { data: gpx, fileName: 'bryton_123.gpx' });
  assert.deepEqual(calls, [`${bryton}/api/activity/list?page=2&limit=20`, `${bryton}/api/activity/123/fit`, `${bryton}/api/activity/123/gpx`]);
});

test('Bryton rejects a failure envelope and does not fall back after an auth rejection', async () => {
  const denied = createSources({ fetchImpl: async () => Response.json({ success: false, data: [] }) });
  await assert.rejects(denied.verify('bryton', { cookie: 'SESSION=fixture-bryton' }), { status: 502 });
  const calls = [];
  const expired = createSources({ fetchImpl: async url => {
    calls.push(url);
    return new Response(null, { status: 401 });
  } });
  await assert.rejects(expired.download('bryton', { cookie: 'SESSION=fixture-bryton' }, '123'), { status: 401 });
  assert.deepEqual(calls, [`${bryton}/api/activity/123/fit`]);
});

test('MyWhoosh password login returns only scoped credentials for a later protected check', async () => {
  const passwords = new PlatformPasswords(async (url, options) => {
    assert.equal(url, 'https://services.mywhoosh.com/http-service/api/login');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.Username, 'test@example.com');
    assert.equal(body.Password, 'fixture-password');
    assert.equal(body.Platform, 'Android');
    assert.equal(body.Action, 1001);
    assert.notEqual(body.CorrelationId, body.DeviceId);
    return Response.json({ Success: true, AccessToken: 'whoosh-fixture-token', WhooshId: 42, RefreshToken: 'unused' });
  });
  assert.deepEqual(await passwords.signIn('mywhoosh', { username: 'test@example.com', password: 'fixture-password' }), {
    credential: { token: 'whoosh-fixture-token', whooshId: '42' }, verified: false
  });
});

test('MyWhoosh preserves activity IDs, uses the provider file ID and keeps Bearer off S3', async () => {
  const calls = [];
  const credential = { token: 'whoosh-fixture-token', whooshId: '42' };
  const signed = 'https://fixture.s3.eu-central-1.amazonaws.com/ride.fit?X-Amz-Signature=fixture';
  const source = createSources({ fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    if (url === signed) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(fit);
    }
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    const body = JSON.parse(options.body);
    if (url.endsWith('/activities')) {
      assert.deepEqual(body, { page: 2, limit: 20, sortDate: 'DESC' });
      return Response.json({ data: { results: [{ id: 'draft' }, { _id: 'ride-1', activityFileId: 'file/1', distanceKm: 42.5 }] } });
    }
    assert.deepEqual(body, { key: '42', fileId: 'file/1' });
    return Response.json({ data: signed });
  } });
  const { activities } = await source.activities('mywhoosh', credential, 20);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].id, 'ride-1');
  assert.equal(activities[0].distance, 42500);
  assert.deepEqual(await source.download('mywhoosh', credential, 'ride-1', activities[0]), { data: fit, fileName: 'mywhoosh_ride-1.fit' });
  assert.deepEqual(calls, [`${whoosh}/activities`, `${whoosh}/download-activity-file`, signed]);
});

test('MyWhoosh rejects unrecognized list envelopes, unrelated file IDs and non-S3 URLs', async () => {
  let calls = 0;
  const source = createSources({ fetchImpl: async () => {
    calls++;
    return Response.json({ data: 'https://nonvendor.example/ride.fit' });
  } });
  const credential = { token: 'whoosh-fixture-token', whooshId: '42' };
  await assert.rejects(source.verify('mywhoosh', credential), { status: 502 });
  await assert.rejects(source.download('mywhoosh', credential, 'ride-1', { id: 'unrelated', fileId: 'file/1' }), { status: 422 });
  await assert.rejects(source.download('mywhoosh', credential, 'ride-1', { id: 'ride-1', fileId: 'file/1' }), { status: 502 });
  assert.equal(calls, 2);
});

test('Zwift account login uses the public client ID and stores only the access token', async () => {
  const passwords = new PlatformPasswords(async (url, options) => {
    assert.equal(url, 'https://secure.zwift.com/auth/realms/zwift/tokens/access/codes');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.fromEntries(options.body), {
      grant_type: 'password', username: 'rider@example.com', password: 'fixture-password', client_id: 'Zwift_Mobile_Link'
    });
    return Response.json({ access_token: 'zwift-fixture-token', refresh_token: 'unused' });
  });
  assert.deepEqual(await passwords.signIn('zwift', { username: 'rider@example.com', password: 'fixture-password' }), {
    credential: { token: 'zwift-fixture-token' }, verified: false
  });
});

test('Zwift uses the authenticated player ID and does not paginate the response twice', async () => {
  const calls = [];
  const credential = { token: 'zwift-fixture-token' };
  const source = createSources({ fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    if (url === 'https://us-or-rly101.zwift.com/api/profiles/me') return new Response(null, { status: 404 });
    if (url.endsWith('/me')) return Response.json({ id: 987 });
    return Response.json([{ activityId: 123, distanceInMeters: 5000, durationInSeconds: 600 },
      { activityId: 124, name: 'Park run', sport: 'RUNNING', distanceInMeters: 3000, durationInSeconds: 750 }]);
  } });
  const page = await source.activities('zwift', credential, 20);
  assert.deepEqual(calls, ['https://us-or-rly101.zwift.com/api/profiles/me', 'https://us.zwift.com/api/profiles/me',
    'https://us-or-rly101.zwift.com/api/profiles/987/activities?start=20&limit=20']);
  assert.deepEqual(page, { activities: [
    { id: '123', name: 'Zwift 骑行', type: 'cycling', time: '', distance: 5000, duration: 600 },
    { id: '124', name: 'Park run', type: 'cycling', sport: 'RUNNING', time: '', distance: 3000, duration: 750 }
  ], nextStart: null });
});

test('Zwift honours unavailable FIT before following signed links, and never sends Bearer to S3', async () => {
  const credential = { token: 'zwift-fixture-token' };
  const signed = 'https://fixture.s3.amazonaws.com/123.fit';
  const blocked = createSources({ fetchImpl: async url => {
    assert.equal(url, 'https://us-or-rly101.zwift.com/api/activities/123');
    return Response.json({ id: 123, fitnessData: { status: 'NOT_AVAILABLE', fullDataUrl: signed } });
  } });
  await assert.rejects(blocked.download('zwift', credential, '123'), { status: 403 });
  const source = createSources({ fetchImpl: async (url, options) => {
    if (url === signed) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(fit);
    }
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    return Response.json({ id: 123, fitnessData: { status: 'AVAILABLE', fullDataUrl: signed } });
  } });
  assert.deepEqual(await source.download('zwift', credential, '123'), { data: fit, fileName: 'zwift_123.fit' });
});
