import { validFit } from './garmin-browser.mjs';

export const CYCITY_API = 'https://cycity.cc/api';
const tokenField = { key: 'token', label: '登录 Token', type: 'password', required: true };
export const CYCITY_SOURCES = [{ id: 'cycity', name: 'CyCity 骑行市', fields: [tokenField], note: '读取骑行列表及原始 FIT。' }];
export const CYCITY_TARGET = {
  id: 'cycity', name: 'CyCity 骑行市', formats: ['fit'], fields: [tokenField],
  note: '导入 FIT 后显示平台接收回执。'
};

const pageSize = 20;
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9._~+\/-]+=*$/.test(value) && value.length <= 16000;
const id = value => (typeof value === 'string' || Number.isSafeInteger(value)) &&
  /^[A-Za-z0-9_-]{1,128}$/.test(String(value)) ? String(value) : null;
const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const error = (status, message) => Object.assign(new Error(`CyCity 骑行市：${message}`), { status });

function auth(credential) {
  if (!validToken(credential?.token)) throw error(400, '请配置有效登录会话。');
  return { Authorization: `Bearer ${credential.token}` };
}

async function request(fetchImpl, path, options, limit) {
  let response;
  try {
    response = await fetchImpl(`${CYCITY_API}${path}`, {
      ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw error(502, '网络连接失败或超时。');
  }
  if (response.status !== 200 || Number(response.headers.get('content-length')) > limit || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (response.status !== 200) throw error([401, 403, 429].includes(response.status) ? response.status : 502, `平台返回 HTTP ${response.status}。`);
    throw error(502, '响应缺失或超出大小限制。');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw error(413, '响应超出大小限制。');
      chunks.push(chunk);
    }
  } catch (cause) {
    if (cause.status === 413) throw cause;
    throw error(502, '读取响应失败。');
  }
  return Buffer.concat(chunks, size);
}

async function json(fetchImpl, path, options) {
  const bytes = await request(fetchImpl, path, { ...options, headers: { Accept: 'application/json', ...options.headers } }, 1024 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw error(502, '平台未返回有效 JSON。'); }
}

export const cyCityPasswordProviders = {
  cycity: {
    fields: [
      { key: 'mobile', label: '手机号', type: 'tel', required: true },
      { key: 'password', label: '账号密码', type: 'password', required: true }
    ],
    async signIn(input, fetchImpl = globalThis.fetch) {
      const mobile = typeof input?.mobile === 'string' ? input.mobile.trim() : '';
      const password = input?.password;
      if (!/^\+?\d{6,16}$/.test(mobile) || typeof password !== 'string' || !password ||
          password.length > 1024 || /[\u0000-\u001f\u007f]/.test(password)) {
        throw error(400, '请填写有效的手机号和密码。');
      }
      const result = await json(fetchImpl, '/auth/mobile/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://app.cycity.cc' },
        body: JSON.stringify({ phonenumber: mobile, password, grantType: 'password' })
      });
      if (result?.code !== 200) throw error(401, '平台未确认登录，请检查手机号、密码或账号验证状态。');
      const token = result.data?.access_token;
      if (!validToken(token) || token === password.trim()) throw error(502, '平台未返回有效登录会话。');
      return { credential: { token }, verified: false };
    }
  }
};

export function createCyCitySources({ fetchImpl = globalThis.fetch } = {}) {
  async function list(credential, page, size) {
    const query = new URLSearchParams({ pageNum: page, pageSize: size });
    const result = await json(fetchImpl, `/mobile/cycling/rideRecordsPage?${query}`, { headers: auth(credential) });
    if (result?.code === 401 || result?.code === 403) throw error(result.code, '登录会话失效或权限不足。');
    if (result?.code !== 200 || !Array.isArray(result.rows) || result.rows.length > size) throw error(502, '平台未返回有效骑行列表。');
    return result;
  }

  return {
    async activities(_platform, credential, start = 0) {
      if (!Number.isSafeInteger(start) || start < 0) throw error(400, '骑行列表起点无效。');
      const page = 1 + Math.floor(start / pageSize);
      const offset = start % pageSize;
      const first = await list(credential, page, pageSize);
      let rows = first.rows.slice(offset);
      let more = Number.isSafeInteger(first.total) ? start - offset + first.rows.length < first.total : first.rows.length === pageSize;
      if (offset && more) {
        const second = await list(credential, page + 1, pageSize);
        rows = rows.concat(second.rows.slice(0, offset));
        more = second.rows.length > offset;
      }
      const activities = rows.map(row => {
        const activityId = id(row?.id);
        if (!activityId) throw error(502, '平台返回的骑行编号无效。');
        const km = numeric(row.movingDistance);
        return { id: activityId, name: 'CyCity 骑行', type: 'cycling',
          time: typeof row.startTime === 'string' ? row.startTime : '',
          distance: km === null ? null : km * 1000, duration: numeric(row.movingDuration) };
      });
      return { activities, nextStart: more && activities.length ? start + activities.length : null };
    },

    async verify(_platform, credential) { await list(credential, 1, 1); },

    async download(_platform, credential, value) {
      const activityId = id(value);
      if (!activityId) throw error(400, '骑行编号无效。');
      const data = await request(fetchImpl, `/mobile/cycling/exportFitFile?rideId=${activityId}`, {
        headers: { ...auth(credential), Accept: 'application/octet-stream' }
      }, 50 * 1024 * 1024);
      if (!validFit(data)) throw error(502, '平台返回的原始 FIT 未通过完整性校验。');
      return { data, fileName: `cycity_${activityId}.fit` };
    }
  };
}
