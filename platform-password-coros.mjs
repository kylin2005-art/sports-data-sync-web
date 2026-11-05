import { createHash } from 'node:crypto';
import { genSalt, hash } from 'bcryptjs';

const regions = {
  '1': { host: 'teamapi.coros.com', site: 'training.coros.com', language: 'en-US' },
  '2': { host: 'teamcnapi.coros.com', site: 'trainingcn.coros.com', language: 'zh-CN' },
  '3': { host: 'teameuapi.coros.com', site: 'trainingeu.coros.com', language: 'en-US' },
};
const passwordField = { key: 'password', label: '密码', type: 'password', required: true };
const challengeMessage = '高驰要求额外验证，请在对应地区的高驰训练中心完成登录。';

function loginError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function signInCoros(input, fetchImpl, china) {
  const account = typeof input?.account === 'string' ? input.account.trim() : '';
  const password = input?.password;
  const region = china ? '2' : (input?.region || '1');
  if (!china && region !== '1' && region !== '3') throw loginError(400, '请选择高驰国际区（1）或欧洲区（3）。');
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(account);
  const phone = /^\+?\d{7,16}$/.test(account);
  if (account.length > 254 || (!email && !(china && phone)) ||
      typeof password !== 'string' || !password || password.length > 512 || password.includes('\0')) {
    throw loginError(400, china ? '请填写高驰中国账号和密码。' : '请填写高驰国际账号邮箱和密码。');
  }
  const { host, site, language } = regions[region];
  // The Training Hub password flow uses a fresh bcrypt salt and the MD5 hex digest of the password.
  const salt = await genSalt(10);
  const digest = createHash('md5').update(password, 'utf8').digest('hex');
  const proof = await hash(digest, salt);
  let response;
  try {
    response = await fetchImpl(`https://${host}/account/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: `https://${site}`,
        YFHeader: JSON.stringify({ language }),
      },
      body: JSON.stringify({ account, accountType: 2, p1: proof, p2: salt }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw loginError(503, '无法连接高驰训练中心，请稍后再试。');
  }
  if (response.status === 403) throw loginError(403, challengeMessage);
  if (response.status === 429) throw loginError(429, '高驰登录请求过于频繁，请稍后再试。');
  if (response.status === 401) throw loginError(401, '高驰未接受该账号登录，请检查账号和密码。');
  if (!response.ok) throw loginError(502, '高驰训练中心暂时无法完成登录。');
  let result;
  try { result = await response.json(); }
  catch { throw loginError(502, '高驰未返回有效的登录结果。'); }
  const data = result?.data;
  if (result?.result === '30011' || data?.twoFactorRequired === true) {
    throw loginError(403, challengeMessage);
  }
  if (result?.result !== '0000') throw loginError(401, '高驰未接受该账号登录，请检查账号、密码和所选地区。');
  const token = data?.accessToken;
  if (String(data?.regionId) !== region) throw loginError(403, '高驰返回的账号地区与选择不符，请按账号所属地区登录。');
  if (typeof token !== 'string' || token.length < 10 || token.length > 16000 || /[;\s\0]/.test(token)) {
    throw loginError(502, '高驰未返回有效登录会话。');
  }
  return { credential: { token, region }, verified: false };
}

export const corosPasswordProviders = {
  coros_cn: {
    fields: [{ key: 'account', label: '手机号或邮箱', type: 'text', required: true }, passwordField],
    signIn: (input, fetchImpl = fetch) => signInCoros(input, fetchImpl, true),
  },
  coros_int: {
    fields: [
      { key: 'account', label: '邮箱', type: 'text', required: true },
      passwordField,
      { key: 'region', label: '账号区域（1 国际，3 欧洲，默认 1）', type: 'text', required: false },
    ],
    signIn: (input, fetchImpl = fetch) => signInCoros(input, fetchImpl, false),
  },
};
