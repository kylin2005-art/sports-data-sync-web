import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { GarminDi } from '../garmin-di.mjs';

const fit = Buffer.from('0c000000010000002e464954000e04', 'hex');
const ride = { activityId: 321, activityName: 'Sample ride', activityType: { typeKey: 'road_biking' } };
const tokenData = { access_token: 'temporary-access', refresh_token: 'initial-refresh', expires_in: 3600 };

test('browser authorization uses CN hosts, returns no tokens, and restores and persists DI refresh', async () => {
  let saved;
  let renewalCount = 0;
  const request = async (input, options) => {
    const url = new URL(input);
    assert.equal(options.redirect, 'error');
    assert.equal(url.hostname.endsWith('.garmin.cn'), true);
    if (url.hostname === 'diauth.garmin.cn') {
      assert.equal(url.pathname, '/di-oauth2-service/oauth/token');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.ok(options.body instanceof URLSearchParams);
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.equal(options.headers.Accept, 'application/json');
        assert.equal(options.body.get('refresh_token'), tokenData.refresh_token);
        assert.equal(options.body.get('client_id'), 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2');
        renewalCount++;
        return Response.json({ ...tokenData, access_token: 'renewed-access', refresh_token: 'renewed-refresh' });
      }
      assert.equal(options.body.get('service_ticket'), 'ST-unique-test-ticket');
      assert.equal(options.body.get('service_url'), 'https://sso.garmin.cn/sso/embed');
      assert.equal(options.body.get('grant_type'), 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket');
      return Response.json({ ...tokenData, expires_in: 1 });
    }
    assert.equal(options.headers.Authorization, renewalCount ? 'Bearer renewed-access' : 'Bearer temporary-access');
    if (url.pathname === '/userprofile-service/socialProfile') return Response.json({ profileId: 77 });
    if (url.pathname === '/download-service/files/activity/321') {
      if (options.headers.Accept !== '*/*') return new Response(null, { status: 406 });
      return new Response(zipSync({ 'sample.fit': fit }));
    }
    assert.equal(url.pathname, '/activitylist-service/activities/search/activities');
    return Response.json([ride]);
  };
  const onSessionState = async (region, record) => {
    assert.equal(region, 'cn');
    saved = structuredClone(record);
  };
  const first = new GarminDi({ request, onSessionState });
  const authorization = await first.authorize('cn', 'ST-unique-test-ticket');
  assert.deepEqual(Object.keys(authorization).sort(), ['accountKey', 'message']);
  assert.equal(saved.sessionState.di_refresh_token, tokenData.refresh_token);
  const restarted = new GarminDi({ request, onSessionState });
  assert.throws(() => restarted.restore('com', saved), /会话无效/);
  restarted.restore('cn', saved);
  const result = await restarted.activities(0, 'cn');
  assert.equal(result.activities[0].type, 'road_biking');
  assert.equal(renewalCount, 1);
  assert.equal(saved.sessionState.di_refresh_token, 'renewed-refresh');
  const original = await restarted.download('cn', result.activities[0].id);
  assert.deepEqual(original.data, fit);
  assert.equal(renewalCount, 1);
});

for (const region of ['cn', 'com']) test(`${region} sends one original FIT and saves the returned ID before readback`, async () => {
  const calls = [];
  let mismatched = false;
  const request = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.hostname.endsWith(`.garmin.${region}`), true);
    if (url.hostname === `diauth.garmin.${region}`) return Response.json(tokenData);
    if (url.pathname === '/userprofile-service/socialProfile') return Response.json({ id: 98 });
    if (url.pathname === '/activitylist-service/activities/search/activities') return Response.json([]);
    if (url.pathname === '/upload-service/upload') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), fit);
      calls.push('post');
      return Response.json({ detailedImportResult: { successes: [{ internalId: 987 }], failures: [] } });
    }
    assert.equal(url.pathname, '/activity-service/activity/987');
    calls.push('read');
    return Response.json({ activityId: mismatched ? 988 : 987 });
  };
  const adapter = new GarminDi({ request, onSessionState: async () => {} });
  assert.deepEqual(adapter.uploadFormats, ['fit']);
  await adapter.authorize(region, 'ST-unique-test-ticket');
  const link = `https://connect.garmin.${region}/modern/activity/987`;
  const result = await adapter.upload(region, { data: fit }, {
    beforeUpload: () => calls.push('intent'),
    onImported: result => {
      assert.deepEqual(result, { activityId: '987', url: link });
      calls.push('persist-id');
    },
  });
  assert.equal(result.activityId, '987');
  assert.equal(result.url, link);
  assert.deepEqual(calls, ['intent', 'post', 'persist-id', 'read']);
  mismatched = true;
  await assert.rejects(adapter.confirm(region, '987'), /活动 ID 不匹配/);
  assert.deepEqual(calls, ['intent', 'post', 'persist-id', 'read', 'read']);
});

test('ambiguous 2xx import requires one exact-time identical FIT and confirms that target ID', async () => {
  const sourceTime = '2025-04-17T01:01:01Z';
  const alternate = Buffer.from('0c000000010000002e46495401cfc4', 'hex');
  const calls = [];
  const adapter = new GarminDi({
    onSessionState: async () => {},
    request: async (input, options) => {
      const url = new URL(input);
      assert.equal(url.hostname.endsWith('.garmin.com'), true);
      if (url.hostname === 'diauth.garmin.com') return Response.json(tokenData);
      if (url.pathname === '/userprofile-service/socialProfile') return Response.json({ id: 98 });
      if (url.pathname === '/upload-service/upload') {
        assert.equal(options.method, 'POST');
        calls.push('post');
        return Response.json({ uploadId: 55 }, { status: 201 });
      }
      if (url.pathname === '/activitylist-service/activities/search/activities') {
        if (url.searchParams.get('limit') === '1') return Response.json([]);
        assert.equal(url.searchParams.get('startDate'), '2025-04-16');
        assert.equal(url.searchParams.get('endDate'), '2025-04-18');
        calls.push('list');
        return Response.json([
          { ...ride, activityId: 986, startTimeGMT: '2025-04-17 01:01:02' },
          { ...ride, activityId: 987, startTimeGMT: '2025-04-17 01:01:01' },
          { ...ride, activityId: 988, startTimeGMT: '2025-04-17 09:01:01+08:00' },
          { ...ride, activityId: 989, startTimeLocal: '2025-04-17 01:01:01' },
        ]);
      }
      assert.equal(options.method, 'GET');
      if (url.pathname === '/download-service/files/activity/987') {
        assert.equal(options.headers.Accept, '*/*');
        calls.push('original-987');
        return new Response(zipSync({ 'original.fit': fit }));
      }
      if (url.pathname === '/download-service/files/activity/988') {
        calls.push('original-988');
        return new Response(alternate);
      }
      assert.equal(url.pathname, '/activity-service/activity/987');
      calls.push('confirm');
      return Response.json({ activityId: '987' });
    },
  });
  await adapter.authorize('com', 'ST-unique-test-ticket');
  const result = await adapter.upload('com', { data: fit }, {
    activity: { time: sourceTime },
    beforeUpload: () => calls.push('intent'),
    onImported: ({ activityId }) => { assert.equal(activityId, '987'); calls.push('persist-id'); },
  });
  assert.equal(result.activityId, '987');
  assert.match(result.message, /找到字节一致的原始 FIT。.*按活动 ID 读回确认/);
  assert.deepEqual(calls, ['intent', 'post', 'list', 'original-987', 'original-988', 'persist-id', 'confirm']);
});

test('explicit, malformed, non-JSON and non-2xx upload outcomes never trigger target search', async () => {
  const duplicate = { detailedImportResult: { failures: [{ messages: [{ content: 'Duplicate Activity' }] }] } };
  const replies = [
    [Response.json(duplicate, { status: 409 }), error => error.outcome === 'duplicate'],
    [Response.json({ detailedImportResult: { failures: [{ messages: [{ content: 'Invalid file' }] }] } }), /明确返回活动导入失败/],
    [Response.json({ uploadId: 55, error: 'Upload failed' }), /未返回唯一成功活动 ID/],
    [Response.json({ detailedImportResult: { successes: [{ activityId: 987 }, { activityId: 988 }] } }), /未返回唯一成功活动 ID/],
    [Response.json({ detailedImportResult: { successes: [{ internalId: 987, activityId: 988 }] } }), /活动 ID 无效/],
    [Response.json({ detailedImportResult: { failures: {} } }), /未返回唯一成功活动 ID/],
    [Response.json({ status: 'FAILED', detailedImportResult: { successes: [{ activityId: 987 }] } }), /返回上传错误/],
    [Response.json({ uploadId: 55 }, { status: 409 }), /HTTP 409/],
    [new Response('<html>Sign in</html>', { status: 200 }), /未返回有效 JSON/],
  ];
  let postCount = 0;
  const adapter = new GarminDi({
    onSessionState: async () => {},
    request: async (input, options) => {
      const url = new URL(input);
      if (url.hostname === 'diauth.garmin.cn') return Response.json(tokenData);
      if (url.pathname === '/userprofile-service/socialProfile') return Response.json({ id: 98 });
      if (url.pathname === '/activitylist-service/activities/search/activities' && url.searchParams.get('limit') === '1') return Response.json([]);
      assert.equal(url.pathname, '/upload-service/upload');
      assert.equal(options.method, 'POST');
      return replies[postCount++][0];
    },
  });
  await adapter.authorize('cn', 'ST-unique-test-ticket');
  for (const [, expected] of replies) {
    await assert.rejects(adapter.upload('cn', { data: fit }, {
      activity: { time: '2025-04-17T01:01:01Z' },
      onImported: () => assert.fail('An upload was incorrectly reported as confirmed'),
    }), expected);
  }
  assert.equal(postCount, replies.length);
});

test('ambiguous 2xx import does not confirm if multiple target originals match byte for byte', async () => {
  let posts = 0;
  const adapter = new GarminDi({
    onSessionState: async () => {},
    request: async input => {
      const url = new URL(input);
      if (url.hostname === 'diauth.garmin.cn') return Response.json(tokenData);
      if (url.pathname === '/userprofile-service/socialProfile') return Response.json({ id: 98 });
      if (url.pathname === '/upload-service/upload') {
        posts++;
        return Response.json({ detailedImportResult: { successes: [], failures: [] } });
      }
      if (url.pathname === '/activitylist-service/activities/search/activities') {
        if (url.searchParams.get('limit') === '1') return Response.json([]);
        return Response.json([987, 988].map(activityId =>
          ({ ...ride, activityId, startTimeGMT: '2025-04-17 01:01:01' })));
      }
      assert.match(url.pathname, /^\/download-service\/files\/activity\/98[78]$/);
      return new Response(fit);
    },
  });
  await adapter.authorize('cn', 'ST-unique-test-ticket');
  await assert.rejects(adapter.upload('cn', { data: fit }, {
    activity: { time: '2025-04-17T01:01:01Z' },
    onImported: () => assert.fail('An ambiguous ID was incorrectly reported'),
  }), /未返回唯一成功活动 ID/);
  assert.equal(posts, 1);
});

test('a failed initial account check does not store credentials or contact the other region', async () => {
  let writes = 0;
  const request = async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname.endsWith('.garmin.cn'), true);
    return url.hostname === 'diauth.garmin.cn' ? Response.json(tokenData) : new Response('private error content', { status: 403 });
  };
  const adapter = new GarminDi({ request, onSessionState: async () => { writes++; } });
  await assert.rejects(adapter.authorize('cn', 'ST-unique-test-ticket'), error =>
    error.status === 403 && !error.message.includes('private error content'));
  assert.equal(writes, 0);
  await assert.rejects(adapter.verify('cn'), error => error.status === 401 && error.region === 'cn');
});

test('portal ticket exchange only uses the exact Garmin service for its own region', async () => {
  const services = [];
  const request = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.hostname.endsWith('.garmin.com'), true);
    if (url.hostname === 'diauth.garmin.com') {
      services.push(options.body.get('service_url'));
      return Response.json(tokenData);
    }
    if (url.pathname === '/userprofile-service/socialProfile') return Response.json({ id: 98 });
    assert.equal(url.pathname, '/activitylist-service/activities/search/activities');
    return Response.json([]);
  };
  const adapter = new GarminDi({ request, onSessionState: async () => {} });
  for (const serviceUrl of ['https://connect.garmin.cn/app', 'https://connect.garmin.com/app/', 'https://example.test/app']) {
    await assert.rejects(adapter.authorize('com', 'ST-portal-test-ticket', undefined, serviceUrl), { status: 400 });
  }
  assert.deepEqual(services, []);
  await adapter.authorize('com', 'ST-portal-test-ticket', undefined, 'https://connect.garmin.com/app');
  assert.deepEqual(services, ['https://connect.garmin.com/app']);
});
