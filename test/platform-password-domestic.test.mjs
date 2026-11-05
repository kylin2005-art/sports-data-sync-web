import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domesticPasswordProviders } from '../platform-password-domestic.mjs';

test('迈金 password login sends the provider digest and returns only the token for verification', async () => {
  const result = await domesticPasswordProviders.magene.signIn({ account: ' rider ', password: 'password' }, async (url, init) => {
    assert.equal(url, 'https://otm.onelap.cn/api/login');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { account: 'rider', password: '5f4dcc3b5aa765d61d8327deb882cf99' });
    return Response.json({ code: 200, data: [{ profile: 'sample' }, { token: 'jwt.fake.token', refresh_token: 'unused' }] });
  });
  assert.deepEqual(result, { credential: { token: 'jwt.fake.token' }, verified: false });
});

test('捷安特 form login requires authenticated identity to report verification', async () => {
  for (const user of [{ userId: 42 }, { nickname: 'rider' }]) {
    const result = await domesticPasswordProviders.giant.signIn({ username: 'rider', password: ' pass+密码 ' }, async (url, init) => {
      assert.equal(url, 'https://ridelife.giant.com.cn/index.php/api/login');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(init.body), { username: 'rider', password: ' pass+密码 ' });
      return Response.json({ status: '1', user, user_token: 'sample-token' });
    });
    assert.deepEqual(result, { credential: { token: 'sample-token' }, verified: Boolean(user.userId) });
  }
});

test('login rejects oversized and denied replies without returning provider content', async () => {
  const input = { username: 'rider', password: 'password' };
  const secret = 'sensitive-example';
  const responses = [
    [Response.json({ status: 0, msg: secret }), 401],
    [new Response(secret, { status: 429 }), 429],
    [Response.json({ status: 1, user_token: secret.repeat(10000) }), 502],
  ];
  for (const [response, status] of responses) {
    await assert.rejects(domesticPasswordProviders.giant.signIn(input, async () => response),
      error => error.status === status && !error.message.includes(secret));
  }
});
