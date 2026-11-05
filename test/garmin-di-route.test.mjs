import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { createWorkspaceHandler } from '../server.mjs';

test('hosted Garmin grants a regional one-time challenge to the pilot workspace only', async t => {
  const saves = [];
  const exchanges = [];
  const garmin = {
    async authorize(region, ticket, save, serviceUrl) {
      exchanges.push({ region, ticket, serviceUrl });
      await save(region, { accountKey: 'account-key', sessionState: { di_token: 'private-test-token' } });
      return { message: 'verified', accountKey: 'account-key' };
    },
    async refresh(region) {
      assert.equal(region, 'cn');
      return { message: 'renewed', refreshed: true, sessionState: { di_token: 'private-test-token' } };
    },
  };
  const workspace = {
    hasGarmin: () => false,
    rememberGarmin: async (region, record) => { saves.push({ region, ...record }); },
    verifyGarminReplay: ({ id }) => ({ id, status: 'done', skipped: 1 }),
  };
  const pilot = createWorkspaceHandler(garmin, () => workspace, { diOrigin: 'https://sync.example.test' });
  const other = createWorkspaceHandler({}, () => workspace);
  const server = createMultiUserServer({
    authStore: { getSession: token => token === 'pilot' || token === 'other' ? { username: token } : null },
    workspaceFor: user => user.username === 'pilot' ? pilot : other,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token = 'pilot', requestOrigin = origin) => fetch(origin + '/api/garmin-di/' + path, {
    method: 'POST',
    headers: { Origin: requestOrigin, Cookie: 'sports_sync_session=' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const start = { region: 'cn' };
  assert.equal((await post('start', start, 'none')).status, 401);
  assert.equal((await post('start', start, 'other')).status, 404);
  assert.equal((await post('start', start, 'pilot', 'https://wrong.example.test')).status, 403);
  const page = await fetch(origin + '/garmin-di', { headers: { Cookie: 'sports_sync_session=pilot' } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/sso\.garmin\.cn https:\/\/sso\.garmin\.com/);
  assert.equal((await fetch(origin + '/garmin-di', { headers: { Cookie: 'sports_sync_session=other' } })).status, 404);

  const { url, state } = await (await post('start', start)).json();
  const login = new URL(url);
  assert.equal(login.origin, 'https://sso.garmin.cn');
  assert.equal(login.searchParams.get('source'), 'https://sync.example.test');
  const finish = { region: 'cn', state, ticket: 'ST-testticket' };
  assert.equal((await post('finish', { ...finish, region: 'com' })).status, 400);
  assert.equal((await post('finish', finish, 'other')).status, 404);
  const accepted = await post('finish', finish);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { message: 'verified' });
  assert.deepEqual(exchanges, [{ region: 'cn', ticket: 'ST-testticket', serviceUrl: 'https://sso.garmin.cn/sso/embed' }]);
  assert.deepEqual(saves, [{ region: 'cn', accountKey: 'account-key', sessionState: { di_token: 'private-test-token' } }]);
  assert.equal((await post('finish', finish)).status, 400);
  assert.deepEqual(await (await post('refresh', start)).json(), { message: 'renewed', refreshed: true });

  const replay = { id: '123', receiptId: 'a'.repeat(64), targetActivityId: '456' };
  assert.equal((await post('verify-replay', replay, 'none')).status, 401);
  assert.equal((await post('verify-replay', replay, 'other')).status, 404);
  assert.deepEqual(await (await post('verify-replay', replay)).json(), { id: '123', status: 'done', skipped: 1 });

  assert.equal((await post('start', { region: 'cn', flow: 'custom' })).status, 400);
  for (const [region, otherRegion] of [['cn', 'com'], ['com', 'cn']]) {
    const expected = `https://connect.garmin.${region}/app`;
    const started = await post('start', { region, flow: 'portal', serviceUrl: 'https://example.test/app' });
    assert.equal(started.status, 200);
    const challenge = await started.json();
    const login = new URL(challenge.url);
    assert.equal(login.origin, `https://sso.garmin.${region}`);
    assert.equal(login.pathname, '/portal/sso/en-US/sign-in');
    assert.equal(login.searchParams.get('clientId'), 'GarminConnect');
    assert.equal(login.searchParams.get('service'), expected);
    assert.equal(challenge.serviceUrl, expected);

    const completion = { region, state: challenge.state, ticket: 'ST-portal-ticket', serviceUrl: 'https://example.test/app' };
    assert.equal((await post('finish', { ...completion, region: otherRegion })).status, 400);
    assert.equal((await post('finish', completion)).status, 200);
    assert.deepEqual(exchanges.at(-1), { region, ticket: completion.ticket, serviceUrl: expected });
    assert.equal((await post('finish', completion)).status, 400);
  }
});
