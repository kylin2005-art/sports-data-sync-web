const accountEndpoint = 'https://api.komoot.de/v006/account/email';
const maxResponseBytes = 256 * 1024;

function loginError(status, message) {
  return Object.assign(new Error(`Komoot：${message}`), { status });
}

async function readToken(response) {
  const invalid = () => loginError(502, '登录响应未返回有效令牌。');
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > maxResponseBytes || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))?.password;
  } catch {
    throw invalid();
  } finally {
    reader.releaseLock();
  }
}

// Komoot's internal API exchanges HTTP Basic email/password for an email/token pair.
async function signIn(input, fetchImpl = globalThis.fetch) {
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const password = input?.password;
  if (email.length > 254 || !/^[^\s:@\u0000-\u001f\u007f]+@[^\s:@\u0000-\u001f\u007f]+\.[^\s:@\u0000-\u001f\u007f]+$/.test(email) ||
      typeof password !== 'string' || !password || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw loginError(400, '请填写有效的邮箱和密码。');
  }

  let response;
  try {
    response = await fetchImpl(`${accountEndpoint}/${encodeURIComponent(email)}/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${password}`, 'utf8').toString('base64')}`,
        'User-Agent': 'Sports-Data-Sync-Web',
      },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw loginError(502, '连接登录接口失败或超时。');
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status)) throw loginError(response.status, '平台拒绝登录，请检查邮箱、密码或账户验证状态。');
    if (response.status === 429) throw loginError(429, '登录请求过于频繁，请稍后重试。');
    throw loginError(502, `登录接口返回 HTTP ${response.status}。`);
  }

  // The response field is named `password`, but this API returns a session token in it.
  const rawToken = await readToken(response);
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > 16000 || token === password.trim() || /[\u0000-\u001f\u007f]/.test(token)) {
    throw loginError(502, '登录响应未返回有效令牌。');
  }
  return { credential: { email, token }, verified: false };
}

export const komootPasswordProviders = {
  komoot: {
    fields: [
      { key: 'email', label: '邮箱', type: 'email', required: true },
      { key: 'password', label: '账号密码', type: 'password', required: true },
    ],
    signIn,
  },
};
