import { validFit } from './garmin-browser.mjs';

const tokenField = { key: 'token', label: '训练中心登录 Token', type: 'password', required: true };
export const COROS_SOURCES = [
  { id: 'coros_cn', name: '高驰中国', fields: [tokenField], note: '通过中国区训练中心读取原始 FIT。' },
  { id: 'coros_int', name: '高驰国际', fields: [tokenField, { key: 'region', label: '账号区域（1 国际、3 欧洲）', type: 'text' }],
    note: '国际区默认使用区域 1，欧洲区选择 3。' },
];

const hosts = { 1: 'teamapi.coros.com', 2: 'teamcnapi.coros.com', 3: 'teameuapi.coros.com' };
const pageSize = 20;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validNumber = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value) >= 0;

function reject(status, message) { return Object.assign(new Error(`高驰：${message}`), { status }); }

function connection(platform, credential) {
  const token = credential?.token;
  const region = platform === 'coros_cn' ? '2' : (credential?.region || '1');
  if (typeof token !== 'string' || token.length < 10 || /[;\s\0]/.test(token)) throw reject(400, '请配置有效会话。');
  if (!Object.hasOwn(hosts, region) || (platform !== 'coros_cn' && region === '2')) throw reject(400, '账号区域无效。');
  return { base: `https://${hosts[region]}`, headers: { Accept: 'application/json', accesstoken: token,
    Cookie: `CPL-coros-region=${region}; CPL-coros-token=${token}` } };
}

function fileUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw reject(502, '平台未返回有效下载地址。'); }
  const host = url.hostname;
  const coros = host === 'coros.com' || host.endsWith('.coros.com');
  const amazon = /^(?:coros-s3|eu-coros)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
  const aliyun = /^(?:coros-oss|coros|test-coros)\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(coros || amazon || aliyun)) {
    throw reject(502, '下载地址与高驰的文件域名不匹配。');
  }
  return url;
}

async function bytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw reject(413, '返回文件过大。');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > limit) throw reject(413, '返回文件过大。');
      chunks.push(chunk);
    }
  } catch (error) { if (error.status) throw error; throw reject(502, '读取响应中断。'); }
  return Buffer.concat(chunks);
}

export function createCorosSources(fetchImpl = fetch) {
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw reject(502, '网络连接失败或平台发生重定向。'); }
    if (response.status !== 200) {
      throw reject([401, 403, 429].includes(response.status) ? response.status : 502, `平台返回 HTTP ${response.status}。`);
    }
    return response;
  }

  async function json(url, options) {
    const response = await request(url, options);
    const buffer = await bytes(response, 5 * 1024 * 1024);
    let result;
    try { result = JSON.parse(buffer.toString('utf8')); } catch { throw reject(502, '平台未返回有效 JSON。'); }
    if (result?.result !== '0000' || !result.data || typeof result.data !== 'object') throw reject(502, '平台未确认此请求，请检查账号会话。');
    return result.data;
  }

  async function query(platform, credential, page, size) {
    const { base, headers } = connection(platform, credential);
    const search = new URLSearchParams({ modeList: '', pageNumber: page, size });
    const data = await json(`${base}/activity/query?${search}`, { headers });
    if (!Array.isArray(data.dataList) || data.dataList.length > size) throw reject(502, '活动列表格式错误。');
    return data.dataList.map(item => {
      const id = typeof item?.labelId === 'string' ? item.labelId : Number.isSafeInteger(item?.labelId) ? String(item.labelId) : '';
      const sportCode = Number(item?.sportType);
      if (!validId(id) || item.sportType == null || !Number.isSafeInteger(sportCode) || sportCode < 0) {
        throw reject(502, '活动编号或运动类型无效。');
      }
      return { id, sportCode, name: typeof item.name === 'string' && item.name.trim() ? item.name : '高驰运动',
        type: 'unknown', time: typeof item.startTime === 'string' ? item.startTime : '',
        distance: validNumber(item.distance) ? Number(item.distance) : null,
        duration: validNumber(item.duration) ? Number(item.duration) : null };
    });
  }

  return {
    async activities(platform, credential, start = 0) {
      const offset = start % pageSize;
      const page = 1 + Math.floor(start / pageSize);
      const first = await query(platform, credential, page, pageSize);
      let activities = first.slice(offset);
      let more = first.length === pageSize;
      if (offset && more) {
        const second = await query(platform, credential, page + 1, pageSize);
        activities = [...activities, ...second.slice(0, offset)];
        more = second.length > offset;
      }
      return { activities, nextStart: more ? start + activities.length : null };
    },

    async verify(platform, credential) { await query(platform, credential, 1, 1); },

    async download(platform, credential, id, activity) {
      const { base, headers } = connection(platform, credential);
      if (!validId(id) || !Number.isSafeInteger(activity?.sportCode)) throw reject(400, '请重新读取活动和运动类型。');
      const search = new URLSearchParams({ labelId: id, sportType: activity.sportCode, fileType: '4' });
      const result = await json(`${base}/activity/detail/download?${search}`, { method: 'POST', headers, body: new URLSearchParams() });
      const response = await request(fileUrl(result.fileUrl));
      const data = await bytes(response, 50 * 1024 * 1024);
      if (!validFit(data)) throw reject(502, '下载文件未通过 FIT 完整性校验。');
      return { data, fileName: `coros_${id}.fit` };
    },
  };
}
