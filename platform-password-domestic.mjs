import { createHash } from 'node:crypto';

const mageneOrigin = 'https://otm.onelap.cn';
const giantOrigin = 'https://ridelife.giant.com.cn';
const browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const maxResponseBytes = 128 * 1024;
const passwordField = { key: 'password', label: '密码', type: 'password', required: true };

function error(status, message) { return Object.assign(new Error(message), { status }); }

function accountAndPassword(input, key) {
  const account = input?.[key];
  const password = input?.password;
  if (typeof account !== 'string' || !account.trim() || account.length > 320 || /[\r\n\0]/.test(account) ||
      typeof password !== 'string' || !password.length || password.length > 1024 || /[\r\n\0]/.test(password)) {
    throw error(400, '请填写有效的账号和密码。');
  }
  return [account.trim(), password];
}

async function readLoginResponse(response) {
  if (!response.body || Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid login response');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Invalid login response');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

async function loginJson(fetchImpl, url, name, headers, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': browserAgent, Accept: 'application/json', ...headers }, body
    });
  } catch {
    throw error(502, `${name}登录请求未完成，请稍后重试。`);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw error(401, `${name}拒绝登录，请检查账号、密码或官网验证。`);
    if (response.status === 429) throw error(429, `${name}登录请求过于频繁，请稍后重试。`);
    throw error(502, `${name}登录接口暂不可用。`);
  }
  try { return await readLoginResponse(response); }
  catch { throw error(502, `${name}未返回可识别的登录响应。`); }
}

function credentialFor(token, name) {
  if (typeof token !== 'string' || token.length > 16000 || !/^[\x21-\x7e]+$/.test(token)) {
    throw error(502, `${name}未返回有效的登录凭据。`);
  }
  return { token };
}

function identifiesUser(id) {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0;
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !/^(?:0+|null|undefined)$/i.test(id);
}

// Login wire formats follow the upstream Android MageneApi and GiantApi clients.
export const domesticPasswordProviders = {
  magene: {
    fields: [{ key: 'account', label: '迈金账号或手机号', type: 'text', required: true }, passwordField],
    async signIn(input, fetchImpl = globalThis.fetch) {
      const [account, password] = accountAndPassword(input, 'account');
      const result = await loginJson(fetchImpl, `${mageneOrigin}/api/login`, '迈金', {
        'Content-Type': 'application/json', Origin: mageneOrigin, Referer: `${mageneOrigin}/login`
      }, JSON.stringify({ account, password: createHash('md5').update(password, 'utf8').digest('hex') }));
      if (result?.code !== 200 && result?.code !== '200') throw error(401, '迈金拒绝登录，请检查账号、密码或官网验证。');
      const token = Array.isArray(result.data) ? result.data.find(item => item?.token)?.token : undefined;
      return { credential: credentialFor(token, '迈金'), verified: false };
    }
  },
  giant: {
    fields: [{ key: 'username', label: '骑行生活账号', type: 'text', required: true }, passwordField],
    async signIn(input, fetchImpl = globalThis.fetch) {
      const [username, password] = accountAndPassword(input, 'username');
      const result = await loginJson(fetchImpl, `${giantOrigin}/index.php/api/login`, '捷安特', {
        'Content-Type': 'application/x-www-form-urlencoded', Referer: giantOrigin
      }, new URLSearchParams({ username, password }));
      if (result?.status !== 1 && result?.status !== '1') throw error(401, '捷安特拒绝登录，请检查账号、密码或官网验证。');
      return { credential: credentialFor(result.user_token, '捷安特'), verified: identifiesUser(result.user?.userId) };
    }
  }
};
