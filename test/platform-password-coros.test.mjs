import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compare } from 'bcryptjs';
import { corosPasswordProviders } from '../platform-password-coros.mjs';

test('高驰账号登录向选定地区发送官网格式的密码证明', async () => {
  const password = 'synthetic-高驰-password';
  const digest = createHash('md5').update(password).digest('hex');
  for (const { provider, account, region, host } of [
    { provider: 'coros_cn', account: '13800000000', region: '2', host: 'teamcnapi.coros.com' },
    { provider: 'coros_int', account: 'example@example.test', region: '1', host: 'teamapi.coros.com' },
    { provider: 'coros_int', account: 'example@example.test', region: '3', host: 'teameuapi.coros.com' },
  ]) {
    const token = 'synthetic-coros-session';
    const result = await corosPasswordProviders[provider].signIn({ account, password, region }, async (url, init) => {
      assert.equal(url, `https://${host}/account/login`);
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ['account', 'accountType', 'p1', 'p2']);
      assert.equal(body.account, account);
      assert.equal(body.accountType, 2);
      assert.ok(body.p1.startsWith(body.p2));
      assert.equal(await compare(digest, body.p1), true);
      assert.equal(init.body.includes(password), false);
      return Response.json({ result: '0000', data: { accessToken: token, regionId: Number(region) } });
    });
    assert.deepEqual(result, { credential: { token, region }, verified: false });
  }
});

test('高驰双重验证和账号地区不符时停在登录阶段', async () => {
  const credentials = { account: 'example@example.test', password: 'synthetic-password', region: '1' };
  for (const [response, message] of [
    [{ result: '0000', data: { twoFactorRequired: true, loginTicket: 'synthetic-private-ticket' } }, /额外验证/],
    [{ result: '30011' }, /额外验证/],
    [{ result: '0000', data: { accessToken: 'synthetic-private-token', regionId: 2 } }, /账号地区/],
  ]) {
    let calls = 0;
    await assert.rejects(corosPasswordProviders.coros_int.signIn(credentials, async () => {
      calls++;
      return Response.json(response);
    }), error => error.status === 403 && message.test(error.message) && !error.message.includes('synthetic'));
    assert.equal(calls, 1);
  }
});
