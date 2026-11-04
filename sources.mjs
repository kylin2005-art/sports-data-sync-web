import { isIP } from 'node:net';
import { validFit } from './garmin-browser.mjs';

// Endpoint/payload references: upstream platform Api.kt files, https://cloud-api.wahooligan.com/,
// and https://apizone.suunto.com/apis. Only protected successful responses verify a session.
// Credentials are supplied by the caller; this module never stores or logs them.
export const SOURCE_PLATFORMS = ['igpsport', 'xingzhe', 'magene', 'wahoo', 'suunto', 'intervals_icu', 'komoot'];
export const SOURCE_DEFINITIONS = [
  { id: 'igpsport', name: 'iGPSPORT', fields: [{ key: 'token', label: '登录 Token', type: 'password', required: true }], note: '使用已有登录 Token；距离单位尚未确认时不显示猜测值。' },
  { id: 'xingzhe', name: '行者', fields: [{ key: 'sessionId', label: 'sessionid', type: 'password', required: true }, { key: 'csrfToken', label: 'CSRF Token（上传时可能需要）', type: 'password', required: false }], note: '仅填写 Cookie 中 sessionid 的值；优先读取原始 FIT，无 FIT 时读取 GPX。' },
  { id: 'magene', name: '迈金', fields: [{ key: 'token', label: '登录 Token', type: 'password', required: true }], note: '优先读取原始 WGS84 FIT；备用文件可能使用 GCJ02，下载结果会注明。' },
  { id: 'wahoo', name: 'Wahoo', fields: [{ key: 'token', label: 'Access Token（含 workouts_read）', type: 'password', required: true }], note: '仅列出已完成运动；Wahoo 官方 API 不开放来自第三方应用的已完成运动。' },
  { id: 'suunto', name: 'Suunto', fields: [{ key: 'token', label: 'Access Token', type: 'password', required: true }, { key: 'subscriptionKey', label: 'API Subscription Key', type: 'password', required: true }], note: '需要已有 Suunto 授权和开发者订阅密钥，读取原始 FIT。' },
  { id: 'intervals_icu', name: 'Intervals.icu', fields: [{ key: 'apiKey', label: '个人 API Key', type: 'password', required: true }], note: '读取 1970 年以来的活动及原始 FIT/GPX；官方不开放 Strava 来源活动下载，其他原始格式暂不支持。' },
  { id: 'komoot', name: 'Komoot', fields: [{ key: 'email', label: '账号邮箱', type: 'email', required: true }, { key: 'token', label: '登录 Token', type: 'password', required: true }], note: '使用邮箱和登录 Token（不是密码）；列表包含已记录和计划路线，下载平台原始 GPX。' }
];
const NAMES = Object.fromEntries(SOURCE_DEFINITIONS.map(({ id, name }) => [id, name]));
const IGP = 'https://prod.zh.igpsport.com/service/web-gateway/web-analyze/activity';
const XZ = 'https://www.imxingzhe.com/api/v1';
const MG = 'https://otm.onelap.cn';
const WH = 'https://api.wahooligan.com';
const SU = 'https://cloudapi.suunto.com';
const ICU = 'https://intervals.icu/api/v1';
const KO = 'https://api.komoot.de/v007';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;
const FILE_LIMIT = 50 * 1024 * 1024;

export class SourceError extends Error {
  constructor(platform, message, status = 400) {
    super(`${NAMES[platform] || '数据源'}：${message}`);
    this.name = 'SourceError';
    this.platform = platform;
    this.status = status;
  }
}

function idValue(value, platform) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new SourceError(platform, '活动编号格式无效');
  if (typeof value !== 'string' && typeof value !== 'number') throw new SourceError(platform, '活动编号缺失');
  const id = String(value);
  if (!id.trim() || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id)) throw new SourceError(platform, '活动编号格式无效');
  return id;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function time(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (Number.isFinite(number) && number > 1_000_000_000) {
    const date = new Date(number > 1_000_000_000_000 ? number : number * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }
  return String(value);
}

function credentials(platform, credential) {
  if (!SOURCE_PLATFORMS.includes(platform)) throw new SourceError(platform, '尚未接入该来源');
  const key = platform === 'xingzhe' ? 'sessionId' : platform === 'intervals_icu' ? 'apiKey' : 'token';
  const value = credential?.[key];
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new SourceError(platform, '请先填写有效登录凭据', 401);
  if (platform === 'xingzhe' && /[;\s]/.test(value)) throw new SourceError(platform, '请仅填写 sessionId 的值', 401);
  if (platform === 'igpsport') return { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${value}`, Origin: 'https://app.igpsport.cn', Referer: 'https://app.igpsport.cn/' };
  if (platform === 'xingzhe') return { 'User-Agent': UA, Accept: 'application/json', Cookie: `sessionid=${value}`, Referer: 'https://www.imxingzhe.com/xingzhe/workouts/list' };
  if (platform === 'wahoo') return { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${value}` };
  if (platform === 'intervals_icu') return { 'User-Agent': UA, Accept: 'application/json', Authorization: `Basic ${Buffer.from(`API_KEY:${value}`, 'utf8').toString('base64')}` };
  if (platform === 'komoot') {
    const email = credential?.email;
    if (typeof email !== 'string' || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email)) throw new SourceError(platform, '请填写有效账号邮箱', 401);
    return { 'User-Agent': UA, Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${value}`, 'utf8').toString('base64')}` };
  }
  if (platform === 'suunto') {
    const subscriptionKey = credential?.subscriptionKey;
    if (typeof subscriptionKey !== 'string' || !subscriptionKey.trim() || /[\r\n]/.test(subscriptionKey)) throw new SourceError(platform, '请填写有效 API Subscription Key', 401);
    return { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${value}`, 'Ocp-Apim-Subscription-Key': subscriptionKey };
  }
  return { 'User-Agent': UA, Accept: 'application/json', Authorization: value, Origin: MG, Referer: `${MG}/calendar` };
}

function fileUrl(value, platform) {
  let url;
  try { url = new URL(value); } catch { throw new SourceError(platform, '下载地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname) ||
      !url.hostname.includes('.') || /(^|\.)(localhost|local|internal)$/.test(url.hostname)) {
    throw new SourceError(platform, '下载地址不是公开 HTTPS 地址');
  }
  return url.href;
}

async function bytes(response, platform, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new SourceError(platform, '响应文件超出大小限制', 413);
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError(platform, '响应没有正文');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new SourceError(platform, '响应文件超出大小限制', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(platform, '读取响应失败或超时', 502);
  }
  return Buffer.concat(chunks, length);
}

function isGpx(data) {
  const text = data.toString('utf8').trim();
  return !/<!DOCTYPE|<!ENTITY|<html\b/i.test(text) &&
    /^(?:<\?xml[^?]*\?>\s*)?<gpx(?:\s|>)/i.test(text) && /<\/gpx>\s*$/i.test(text);
}

export function createSources({ fetchImpl = globalThis.fetch } = {}) {
  async function request(platform, url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new SourceError(platform, '连接失败、发生跳转或超时', 502);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new SourceError(platform, `请求失败 HTTP ${response.status}`, response.status >= 400 ? response.status : 502);
    }
    return response;
  }

  async function json(platform, url, options) {
    const response = await request(platform, url, options);
    let value;
    try { value = JSON.parse((await bytes(response, platform, 2 * 1024 * 1024)).toString('utf8')); }
    catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(platform, '返回的不是有效 JSON，未取得活动数据', 502);
    }
    if (!value || typeof value !== 'object' || (Array.isArray(value) && platform !== 'intervals_icu')) throw new SourceError(platform, '接口响应格式无效', 502);
    const expected = platform === 'magene' ? 200 : 0;
    if (['igpsport', 'xingzhe', 'magene'].includes(platform) && value.code !== expected) {
      const status = [401, 403, 429].includes(Number(value.code)) ? Number(value.code) : 502;
      throw new SourceError(platform, '接口未确认请求成功，请检查登录凭据', status);
    }
    return value;
  }

  async function readPage(platform, headers, offset, credential) {
    let result, rows, more;
    if (platform === 'igpsport') {
      result = await json(platform, `${IGP}/queryMyActivity?pageNo=${Math.floor(offset / PAGE_SIZE) + 1}&pageSize=20&reqType=0&sort=1`, { headers });
      const data = result.data ?? result;
      rows = data.rows ?? data.list;
      more = Array.isArray(rows) && rows.length === PAGE_SIZE;
    } else if (platform === 'xingzhe') {
      result = await json(platform, `${XZ}/pgworkout/?offset=${offset}&limit=20`, { headers });
      rows = result.data?.data;
      more = Array.isArray(rows) && rows.length === PAGE_SIZE;
    } else if (platform === 'wahoo') {
      result = await json(platform, `${WH}/v1/workouts?page=${Math.floor(offset / PAGE_SIZE) + 1}&per_page=20`, { headers });
      rows = result.workouts;
      more = Array.isArray(rows) && rows.length === PAGE_SIZE &&
        (!Number.isSafeInteger(result.total) || offset + rows.length < result.total);
    } else if (platform === 'suunto') {
      result = await json(platform, `${SU}/v3/workouts/?filter-by-modification-time=false&limit=20&offset=${offset}`, { headers });
      rows = result.payload;
      more = Array.isArray(rows) && rows.length === PAGE_SIZE;
    } else if (platform === 'komoot') {
      const page = Math.floor(offset / PAGE_SIZE);
      result = await json(platform, `${KO}/users/${encodeURIComponent(credential.email)}/tours/?limit=20&page=${page}`, { headers });
      rows = result._embedded?.tours;
      const totalPages = result.page?.totalPages;
      if (!Number.isSafeInteger(totalPages) || totalPages < 0) throw new SourceError(platform, '接口未返回有效分页信息', 502);
      more = Array.isArray(rows) && rows.length > 0 && page + 1 < totalPages;
    } else {
      result = await json(platform, `${MG}/api/otm/ride_record/list`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: Math.floor(offset / PAGE_SIZE) + 1, limit: PAGE_SIZE })
      });
      rows = result.data?.list;
      more = Array.isArray(rows) && rows.length === PAGE_SIZE && result.data?.pagination?.has_more !== false;
    }
    if (!Array.isArray(rows)) throw new SourceError(platform, '接口未返回活动数组', 502);
    return { rows, more };
  }

  function normalize(platform, row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SourceError(platform, '活动条目格式无效', 502);
    if (platform === 'igpsport') {
      return {
        id: idValue(row.RideId ?? row.rideId ?? row.id, platform), name: String(row.Title ?? row.title ?? row.name ?? '运动'),
        type: String(row.type ?? row.sportType ?? '运动'),
        time: time(row.StartTime ?? row.startTime ?? row.start_time ?? row.RideDate ?? row.rideDate ?? row.BeginTime ?? row.beginTime ?? row.createTime ?? row.Date),
        // Upstream guesses metres vs kilometres from the magnitude. Leave it unknown until the unit is known.
        distance: null, duration: numeric(row.Duration ?? row.duration ?? row.movingTime)
      };
    }
    if (platform === 'xingzhe') return {
      id: idValue(row.id, platform), name: String(row.title ?? '运动'), type: String(row.type ?? row.sport ?? '运动'),
      time: time(row.start_time), distance: numeric(row.distance), duration: numeric(row.duration)
    };
    if (platform === 'wahoo') {
      const summary = row.workout_summary;
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new SourceError(platform, '运动摘要格式无效', 502);
      return {
        id: idValue(row.id, platform), name: String(summary.name ?? row.name ?? '运动'), type: String(row.workout_type_id ?? '运动'),
        time: time(row.starts), distance: numeric(summary.distance_accum), duration: numeric(summary.duration_active_accum)
      };
    }
    if (platform === 'suunto') return {
      id: idValue(row.workoutKey, platform), name: String(row.workoutName ?? row.sport ?? '运动'), type: String(row.sport ?? '运动'),
      time: time(row.startTime), distance: numeric(row.totalDistance), duration: numeric(row.totalTime)
    };
    if (platform === 'intervals_icu') return {
      id: idValue(row.id, platform), name: String(row.name ?? '运动'), type: String(row.type ?? '运动'),
      time: time(row.start_date ?? row.start_date_local), distance: numeric(row.distance), duration: numeric(row.moving_time)
    };
    if (platform === 'komoot') return {
      id: idValue(row.id, platform), name: `${row.status === 'planned' ? '计划路线：' : ''}${String(row.name ?? row.sport ?? '路线')}`,
      type: String(row.sport ?? '路线'), time: time(row.date), distance: numeric(row.distance), duration: numeric(row.duration)
    };
    const km = numeric(row.distance_km);
    return {
      id: idValue(row.id, platform), name: typeof row.name === 'string' && row.name.trim() ? row.name : '骑行', type: 'cycling',
      time: time(row.start_riding_time), distance: km === null ? null : km * 1000, duration: numeric(row.time_seconds)
    };
  }

  async function activities(platform, credential, start = 0) {
    const headers = credentials(platform, credential);
    if (!Number.isSafeInteger(start) || start < 0) throw new SourceError(platform, '分页位置无效');
    if (platform === 'intervals_icu') {
      // Official API has date/limit pagination but no offset. Request one extra row to detect continuation.
      // https://intervals.icu/api/v1/docs/ — listActivities / downloadActivityFile.
      if (start > 2147483626) throw new SourceError(platform, '分页位置超出接口范围');
      const rows = await json(platform, `${ICU}/athlete/0/activities?oldest=1970-01-01&limit=${start + PAGE_SIZE + 1}&fields=id,name,type,source,start_date,start_date_local,distance,moving_time`, { headers });
      if (!Array.isArray(rows)) throw new SourceError(platform, '接口未返回活动数组', 502);
      const selected = rows.slice(start, start + PAGE_SIZE);
      const exportable = selected.filter(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SourceError(platform, '活动条目格式无效', 502);
        // Official API returns empty stubs for Strava activities and forbids their original-file export.
        return Object.keys(row).length > 0 && String(row.source ?? '').toUpperCase() !== 'STRAVA';
      });
      return { activities: exportable.map(row => normalize(platform, row)), nextStart: rows.length > start + PAGE_SIZE ? start + PAGE_SIZE : null };
    }
    if (platform === 'wahoo') {
      const offset = Math.floor(start / PAGE_SIZE) * PAGE_SIZE;
      const current = await readPage(platform, headers, offset, credential);
      const rows = current.rows.slice(start % PAGE_SIZE);
      const completed = rows.filter(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, 'workout_summary')) throw new SourceError(platform, '活动条目缺少运动摘要字段', 502);
        idValue(row.id, platform);
        return row.workout_summary !== null;
      });
      // Offset counts remote records, including planned workouts which have no completed activity file.
      return { activities: completed.map(row => normalize(platform, row)), nextStart: current.more ? offset + current.rows.length : null };
    }
    const result = [];
    const directOffset = ['xingzhe', 'suunto'].includes(platform);
    let offset = directOffset ? start : Math.floor(start / PAGE_SIZE) * PAGE_SIZE;
    let skip = directOffset ? 0 : start % PAGE_SIZE;
    let more = false;
    do {
      const current = await readPage(platform, headers, offset, credential);
      const selected = current.rows.slice(skip, skip + PAGE_SIZE - result.length);
      result.push(...selected.map(row => normalize(platform, row)));
      more = skip + selected.length < current.rows.length || current.more;
      if (!current.more || result.length === PAGE_SIZE) break;
      offset += PAGE_SIZE;
      skip = 0;
    } while (result.length < PAGE_SIZE);
    return { activities: result, nextStart: more && result.length ? start + result.length : null };
  }

  async function binary(platform, url, headers = { 'User-Agent': UA, Accept: '*/*' }) {
    return bytes(await request(platform, fileUrl(url, platform), { headers }), platform, FILE_LIMIT);
  }

  async function download(platform, credential, value) {
    const headers = credentials(platform, credential);
    const id = idValue(value, platform);
    const encoded = encodeURIComponent(id);
    const fileName = `${platform}_${id.replace(/[^A-Za-z0-9._-]/g, '_')}.fit`;
    if (platform === 'igpsport') {
      const response = await json(platform, `${IGP}/getDownloadUrl/${encoded}`, { headers });
      const data = response.data;
      const url = typeof data === 'string' ? data : data?.url ?? data?.downloadUrl ?? response.url ?? response.downloadUrl;
      const file = await binary(platform, url);
      if (!validFit(file)) throw new SourceError(platform, 'FIT 文件长度或校验失败，未继续传输', 502);
      return { data: file, fileName };
    }
    if (platform === 'xingzhe') {
      try {
        const file = await binary(platform, `${XZ}/workout/${encoded}/fit/`, headers);
        if (validFit(file)) return { data: file, fileName };
      } catch (error) {
        if ([401, 403, 429].includes(error.status)) throw error;
      }
      const file = await binary(platform, `${XZ}/pgworkout/${encoded}/gpx/`, headers);
      if (!isGpx(file)) throw new SourceError(platform, '未取得有效 FIT 或 GPX 文件', 502);
      return { data: file, fileName: fileName.replace(/\.fit$/, '.gpx') };
    }
    if (platform === 'wahoo' || platform === 'suunto') {
      let file;
      if (platform === 'wahoo') {
        const detail = await json(platform, `${WH}/v1/workouts/${encoded}`, { headers });
        if (idValue(detail.id, platform) !== id) throw new SourceError(platform, '下载详情活动编号不匹配', 502);
        const url = detail.workout_summary?.file?.url;
        if (typeof url !== 'string' || !url) throw new SourceError(platform, '该运动没有可下载的 FIT 文件', 404);
        file = await binary(platform, url);
      } else {
        file = await binary(platform, `${SU}/v3/workouts/${encoded}/fit`, headers);
      }
      if (!validFit(file)) throw new SourceError(platform, 'FIT 文件长度或校验失败，未继续传输', 502);
      return { data: file, fileName };
    }
    if (platform === 'intervals_icu') {
      const file = await binary(platform, `${ICU}/activity/${encoded}/file`, headers);
      if (validFit(file)) return { data: file, fileName };
      if (isGpx(file)) return { data: file, fileName: fileName.replace(/\.fit$/, '.gpx') };
      throw new SourceError(platform, '原始文件不是受支持的有效 FIT/GPX，未继续传输', 502);
    }
    if (platform === 'komoot') {
      const file = await binary(platform, `${KO}/tours/${encoded}.gpx`, { ...headers, Accept: 'application/gpx+xml' });
      if (!isGpx(file)) throw new SourceError(platform, '未取得有效原始 GPX 文件', 502);
      return { data: file, fileName: fileName.replace(/\.fit$/, '.gpx'), coordinateSystem: 'wgs84' };
    }
    const response = await json(platform, `${MG}/api/otm/ride_record/analysis/${encoded}`, { headers });
    const riding = response.data?.ridingRecord;
    if (!riding || typeof riding !== 'object') throw new SourceError(platform, '活动详情缺少文件信息', 502);
    if (riding.durl) {
      try {
        const file = await binary(platform, riding.durl);
        if (validFit(file)) return { data: file, fileName, coordinateSystem: 'wgs84' };
      } catch (error) {
        if ([401, 403, 429].includes(error.status)) throw error;
      }
    }
    if (typeof riding.fitUrl !== 'string' || !riding.fitUrl) throw new SourceError(platform, '该记录没有可下载的 FIT 文件', 404);
    const fitPath = Buffer.from(riding.fitUrl, 'utf8').toString('base64');
    const file = await binary(platform, `${MG}/api/otm/ride_record/analysis/fit_content/${fitPath}`, headers);
    if (!validFit(file)) throw new SourceError(platform, 'FIT 文件长度或校验失败，未继续传输', 502);
    return { data: file, fileName, coordinateSystem: 'gcj02' };
  }

  async function verify(platform, credential) {
    await activities(platform, credential, 0);
    return { message: `${NAMES[platform]}活动列表会话已验证。` };
  }
  return { activities, download, verify };
}

const sources = createSources();
export const activities = (...args) => sources.activities(...args);
export const download = (...args) => sources.download(...args);
export const verify = (...args) => sources.verify(...args);
