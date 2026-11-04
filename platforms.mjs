import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Request formats follow the existing Android adapters. Wahoo/Suunto/Intervals
// receipts additionally follow their public API docs; a bare 2xx is never success.
const secret = (key, label, required = true) => ({ key, label, type: 'password', required });
export const PLATFORM_DEFINITIONS = [
  { id: 'igpsport', name: 'iGPSPORT', formats: ['fit', 'gpx'], fields: [secret('token', 'Access Token')], note: '需有效登录 Token。异步导入仅标记已接收，请在平台核对。' },
  { id: 'xingzhe', name: '行者', formats: ['fit'], fields: [secret('sessionId', 'sessionid'), secret('csrfToken', 'csrftoken', false)], note: '需网页会话。仅上传原始 FIT，平台返回 workout_id 和解析完成状态后确认。' },
  { id: 'magene', name: '迈金 / 顽鹿', formats: ['fit'], fields: [secret('token', 'OTM 登录 Token')], note: '上传至顽鹿 OTM；success_count 表示已接收，不代表异步入库完成。' },
  { id: 'blackbird', name: '黑鸟单车', formats: ['fit'], fields: [secret('cookie', '完整 Cookie')], note: '需有效网页 Cookie。平台可能拒绝无 GPS 或含不兼容开发者字段的 FIT。' },
  { id: 'giant', name: '捷安特', formats: ['fit'], fields: [secret('token', 'user_token')], note: '使用骑行生活账号 Token；明确接收回执仍需在平台核对记录。' },
  { id: 'outbase', name: 'Outbase', formats: ['fit'], fields: [secret('sessionId', 'Sessionid')], note: '需官方网页登录会话。云端注册成功仅标记已接收。' },
  { id: 'wahoo', name: 'Wahoo', formats: ['fit'], fields: [secret('token', 'OAuth Access Token')], note: 'Token 需 workouts_write 权限；等待上传处理完成及 workout_id。' },
  { id: 'intervals_icu', name: 'Intervals.icu', formats: ['fit', 'gpx'], fields: [secret('apiKey', '个人 API Key')], note: '在 Intervals.icu 设置中获取个人 API Key；按目标活动 ID 读回确认。' },
  { id: 'suunto', name: 'Suunto / 松拓', formats: ['fit'], fields: [secret('token', 'OAuth Access Token'), secret('subscriptionKey', 'Subscription Key')], note: '需要 Suunto 开发者应用授权；等待 PROCESSED 和 workoutKey。' },
  { id: 'komoot', name: 'Komoot', formats: ['fit', 'gpx'], fields: [{ key: 'email', label: '账号邮箱', type: 'email', required: true }, secret('token', '登录 Token')], note: '使用邮箱和登录 Token（不是密码）；支持原始 FIT/GPX，不改变坐标。' },
];

const definitions = new Map(PLATFORM_DEFINITIONS.map(item => [item.id, item]));
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_FILE = 50 * 1024 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const REJECTED_HTTP = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 429]);
const safeId = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(value)) ? String(value) : null;
const positiveId = value => safeId(value) && /^[1-9]\d*$/.test(String(value)) ? String(value) : null;
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
  return value;
});
function fitCrc(bytes) {
  let value = 0;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255];
  return value;
}

export class PlatformError extends Error {
  constructor(message, { platform, status = 502, code = 'provider_error', mayHaveUploaded = false } = {}) {
    super(message);
    this.name = 'PlatformError';
    this.platform = platform;
    this.status = status;
    this.code = code;
    this.mayHaveUploaded = mayHaveUploaded;
  }
}

export function validateCredential(platform, credential) {
  const definition = definitions.get(platform);
  if (!definition) throw new PlatformError('这个平台的 Web 上传暂未实现。', { platform, status: 400, code: 'unsupported' });
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new PlatformError(`请配置${definition.name}凭证。`, { platform, status: 400, code: 'credential' });
  }
  const result = {};
  for (const field of definition.fields) {
    const value = credential[field.key];
    if (value !== undefined && typeof value !== 'string') throw new PlatformError(`${field.label}格式无效。`, { platform, status: 400, code: 'credential' });
    const trimmed = value?.trim() || '';
    if ((field.required && !trimmed) || trimmed.length > 16000 || /[\r\n\0]/.test(trimmed)) {
      throw new PlatformError(`请填写有效的${field.label}。`, { platform, status: 400, code: 'credential' });
    }
    if ((field.key === 'sessionId' || field.key === 'csrfToken') && /[;\s]/.test(trimmed)) {
      throw new PlatformError(`${field.label}只填写对应值，不要包含整段 Cookie。`, { platform, status: 400, code: 'credential' });
    }
    if (field.type === 'email' && (!/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(trimmed))) {
      throw new PlatformError('请填写有效的账号邮箱。', { platform, status: 400, code: 'credential' });
    }
    if (trimmed) result[field.key] = trimmed;
  }
  return result;
}

function inputFile(platform, data, fileName) {
  if (!(data instanceof Uint8Array) || data.length < 14 || data.length > MAX_FILE) {
    throw new PlatformError('活动文件为空、格式无效或超过 50 MB。', { platform, status: 400, code: 'file' });
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const fit = [12, 14].includes(bytes[0]) && bytes.subarray(8, 12).toString('ascii') === '.FIT';
  const format = fit ? 'fit' : 'gpx';
  if (!fit) {
    const prefix = bytes.subarray(0, Math.min(bytes.length, 2048)).toString('utf8').replace(/^\uFEFF/, '');
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<gpx(?:\s|>)/i.test(prefix) || !/<\/gpx>\s*$/i.test(bytes.subarray(-128).toString('utf8'))) {
      throw new PlatformError('仅支持原始 FIT 或 GPX 活动文件。', { platform, status: 400, code: 'file' });
    }
  } else if (!bytes.readUInt32LE(4) || bytes.readUInt32LE(4) + bytes[0] + 2 !== bytes.length || fitCrc(bytes) !== 0 ||
    (bytes[0] === 14 && (bytes[12] || bytes[13]) && fitCrc(bytes.subarray(0, 14)) !== 0)) {
    throw new PlatformError('FIT 文件长度或校验码无效，已停止上传。', { platform, status: 400, code: 'file' });
  }
  if (!definitions.get(platform).formats.includes(format)) {
    throw new PlatformError(`${definitions.get(platform).name}当前仅接受 FIT；请先选择可下载原始 FIT 的记录。`, { platform, status: 400, code: 'format' });
  }
  const stem = String(fileName || 'activity').split(/[\\/]/).at(-1).replace(/[\r\n\0"]/g, '').replace(/\.(fit|gpx)$/i, '').slice(0, 120) || 'activity';
  return { bytes, format, fileName: `${stem}.${format}` };
}

function multipart(field, file, extra = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(extra)) form.set(key, String(value));
  form.set(field, new Blob([file.bytes], { type: 'application/octet-stream' }), file.fileName);
  return form;
}

function checkedStorageUrl(value, allowed) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  return allowed.some(host => url.hostname === host || (host.startsWith('.') && url.hostname.endsWith(host))) ? url.href : null;
}

function publicLink(value, hosts) {
  return checkedStorageUrl(value, hosts) || undefined;
}

export class PlatformUploads {
  constructor({ fetchImpl = globalThis.fetch, sleep = delay, timeoutMs = 60_000, pollAttempts = 15 } = {}) {
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.pollAttempts = pollAttempts;
  }

  async upload({ platform, credential, data, fileName, activity = {}, beforeUpload } = {}) {
    const auth = validateCredential(platform, credential);
    const file = inputFile(platform, data, fileName);
    const context = { platform, name: definitions.get(platform).name, beforeUpload, started: false, mayHaveUploaded: false };
    try {
      return await this[platform](context, auth, file, activity);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      // Never include provider response text, credentials or signed URLs in errors.
      throw this.error(context, '操作未完成，请检查连接并到目标平台核对。', 'unknown');
    }
  }

  error(ctx, message, code = 'provider_error', status = 502) {
    return new PlatformError(`${ctx.name}：${message}`, { platform: ctx.platform, status, code, mayHaveUploaded: ctx.mayHaveUploaded });
  }

  receipt(ctx, status, activityId, url) {
    return { platform: ctx.platform, status, ...(activityId ? { activityId } : {}), ...(url ? { url } : {}), message:
      status === 'confirmed' ? `${ctx.name}已明确返回活动记录，请在目标平台核对。`
        : status === 'duplicate' ? `${ctx.name}明确报告文件已存在，本次没有新增记录。`
          : `${ctx.name}已接收文件，尚未确认活动入库，请到目标平台核对，勿立即重传。` };
  }

  async request(ctx, url, { method = 'GET', headers = {}, body, write = false, payload = false, allowed = [200], json = true } = {}) {
    const priorUpload = ctx.mayHaveUploaded;
    if (write && !ctx.started) {
      // The caller can persist an intent before the first external mutation.
      if (ctx.beforeUpload) {
        try { await ctx.beforeUpload(); }
        catch { throw this.error(ctx, '当前转存操作未获准登记，未发起上传。', 'preflight', 409); }
      }
      ctx.started = true;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (payload) ctx.mayHaveUploaded = true;
      const response = await this.fetch(url, { method, headers: { 'User-Agent': BROWSER_UA, ...headers }, body, redirect: 'manual', signal: controller.signal });
      if (!allowed.includes(response.status)) {
        if (payload && REJECTED_HTTP.has(response.status)) ctx.mayHaveUploaded = priorUpload;
        const status = response.status === 401 || response.status === 403 || response.status === 429 ? response.status : 502;
        const message = response.status === 401 || response.status === 403 ? '凭证失效或权限不足，请重新授权。'
          : response.status === 429 ? '请求频率受限，请稍后再试。'
            : response.status >= 300 && response.status < 400 ? '请求被重定向，未跟随跳转，请检查登录会话。'
              : `请求返回 HTTP ${response.status}，未确认成功。`;
        await response.body?.cancel();
        throw this.error(ctx, message, 'http', status);
      }
      if (!json) { await response.body?.cancel(); return { status: response.status }; }
      const reader = response.body?.getReader();
      if (!reader) throw this.error(ctx, '收到空响应，未确认成功。', 'unconfirmed');
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw this.error(ctx, '响应过大，未确认成功。', 'unconfirmed'); }
        chunks.push(Buffer.from(value));
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw this.error(ctx, '返回了非 JSON 内容，未确认成功。', 'unconfirmed'); }
      return { status: response.status, data: result };
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw this.error(ctx, controller.signal.aborted ? '请求超时，未自动重试，请到平台核对。' : '网络连接中断，未自动重试，请到平台核对。', 'network');
    } finally { clearTimeout(timer); }
  }

  async intervals_icu(ctx, credential, file, activity) {
    const headers = { Authorization: basic('API_KEY', credential.apiKey) };
    const url = new URL('https://intervals.icu/api/v1/athlete/0/activities');
    url.searchParams.set('external_id', `sports-sync-${createHash('sha256').update(file.bytes).digest('hex')}`);
    if (activity.name) url.searchParams.set('name', String(activity.name).slice(0, 250));
    const { data } = await this.request(ctx, url.href, { method: 'POST', headers, body: multipart('file', file), write: true, payload: true, allowed: [200, 201] });
    if (data?.error || (Array.isArray(data?.errors) && data.errors.length)) throw this.error(ctx, '平台报告上传错误，未确认成功。');
    const entries = Array.isArray(data?.activities) ? data.activities : [];
    if (entries.length !== 1 || !safeId(entries[0]?.id)) throw this.error(ctx, '未返回唯一的活动 ID，请到平台核对。', 'unconfirmed');
    const id = String(entries[0].id);
    const detail = await this.request(ctx, `https://intervals.icu/api/v1/activity/${encodeURIComponent(id)}`, { headers });
    if (safeId(detail.data?.id) !== id) throw this.error(ctx, '目标活动读回不匹配，请到平台核对。', 'unconfirmed');
    return this.receipt(ctx, 'confirmed', id, `https://intervals.icu/activities/${encodeURIComponent(id)}`);
  }

  async xingzhe(ctx, credential, file) {
    const headers = { Cookie: `sessionid=${credential.sessionId}${credential.csrfToken ? `; csrftoken=${credential.csrfToken}` : ''}`, Referer: 'https://www.imxingzhe.com/upload/fit', Accept: 'application/json' };
    if (credential.csrfToken) headers['X-CSRFToken'] = credential.csrfToken;
    const { data, status } = await this.request(ctx, 'https://www.imxingzhe.com/api/v1/fit/upload/', { method: 'POST', headers, body: multipart('fit_file', file, { md5: md5(file.bytes) }), write: true, payload: true, allowed: [200, 400] });
    if (data?.code === 9006) return this.receipt(ctx, 'duplicate');
    if (data?.code === 401 || data?.code === 403) { ctx.mayHaveUploaded = false; throw this.error(ctx, '会话已失效，请重新授权。', 'http', data.code); }
    if (status !== 200 || data?.code !== 0) throw this.error(ctx, '平台未明确接受该 FIT 文件。');
    const id = positiveId(data.data?.workout_id);
    if (id && data.data?.handle_msg === 'ok') return this.receipt(ctx, 'confirmed', id);
    if (data.data?.handle_msg && data.data.handle_msg !== 'ok') throw this.error(ctx, '平台未报告文件解析完成。', 'unconfirmed');
    return this.receipt(ctx, 'accepted');
  }

  async magene(ctx, credential, file) {
    const { data } = await this.request(ctx, 'https://otm.onelap.cn/api/otm/ride_record/upload/fit', {
      method: 'POST', headers: { Authorization: credential.token, Origin: 'https://otm.onelap.cn', Referer: 'https://otm.onelap.cn/analysis' },
      body: multipart('jilu0', file), write: true, payload: true,
    });
    if (data?.code !== 200 || data.data?.success_count !== 1) throw this.error(ctx, '平台未明确接收这一条文件。');
    return this.receipt(ctx, 'accepted');
  }

  async blackbird(ctx, credential, file) {
    const { data } = await this.request(ctx, 'https://www.blackbirdsport.com/api/records/upload', {
      method: 'POST', headers: { Cookie: credential.cookie }, body: multipart('file', file), write: true, payload: true,
    });
    if (data?.error || data?.success === false || ['error', 'failed'].includes(data?.status) ||
      ![data?.status === 'ok', data?.code === 0, data?.code === 200, data?.success === true].some(Boolean)) {
      throw this.error(ctx, '平台拒绝文件或没有明确接收回执。');
    }
    return this.receipt(ctx, 'accepted');
  }

  async giant(ctx, credential, file) {
    const { data } = await this.request(ctx, 'https://ridelife.giant.com.cn/index.php/api/upload_fit', {
      method: 'POST', headers: { Referer: 'https://ridelife.giant.com.cn' },
      body: multipart('files[]', file, { token: credential.token, device: 'bike_computer', brand: 'giant' }), write: true, payload: true,
    });
    if (data?.status !== 1 || data?.error || data?.success === false) throw this.error(ctx, '平台未返回明确接收回执。');
    return this.receipt(ctx, 'accepted');
  }

  async igpsport(ctx, credential, file, activity) {
    const headers = { Authorization: `Bearer ${credential.token}`, Origin: 'https://app.igpsport.cn', Referer: 'https://app.igpsport.cn/' };
    const signed = await this.request(ctx, `https://prod.zh.igpsport.com/service/sportg/third-party-server/oss/getSignedUrl?fileExtension=.${file.format}`, { headers });
    const url = checkedStorageUrl(signed.data?.data?.signedUrl, ['.aliyuncs.com']);
    const ossId = signed.data?.data?.ossId;
    if (![0, 200].includes(signed.data?.code) || !url || typeof ossId !== 'string' || !ossId || ossId.length > 1000) throw this.error(ctx, '未取得有效的官方存储上传地址。', 'storage');
    // The presigned URL binds headers; do not forward the API Bearer or add Content-Type.
    await this.request(ctx, url, { method: 'PUT', body: file.bytes, write: true, payload: true, allowed: [200, 201, 204], json: false });
    const title = String(activity.name || '运动记录').slice(0, 250);
    const result = await this.request(ctx, 'https://prod.zh.igpsport.com/service/web-gateway/web-analyze/activity/uploadByOss', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, write: true,
      body: JSON.stringify({ fileName: file.fileName, ossName: ossId, title, name: title, activityName: title }),
    });
    if (![0, 200].includes(result.data?.code)) throw this.error(ctx, '文件已上传，但平台未明确接收导入任务。', 'unconfirmed');
    return this.receipt(ctx, 'accepted');
  }

  async outbase(ctx, credential, file) {
    const guid = randomUUID();
    const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date()).replaceAll('-', '');
    const id = `${guid}${date}`;
    const hex = guid.replaceAll('-', '');
    const url = new URL('https://melon-gateway.immomo.com/zeusfit/resource/h5/upload');
    for (const [key, value] of Object.entries({ source: 'zeusfit', id, uri: `/resource/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${id}.fit`, momoid: '0' })) url.searchParams.set(key, value);
    const headers = { Origin: 'https://outbase.cn', Referer: 'https://outbase.cn/' };
    const uploaded = await this.request(ctx, url.href, { method: 'POST', headers, body: multipart('file', file), write: true, payload: true });
    if (uploaded.data?.message !== 'SUCCESS') throw this.error(ctx, '存储端未返回明确接收回执。', 'unconfirmed');
    const registered = await this.request(ctx, 'https://melon-gateway.immomo.com/zeusfit/api/h5/sport/upload/fit', {
      method: 'POST', headers: { ...headers, Sessionid: credential.sessionId, Uagent: `${BROWSER_UA} PCAgent/1.0.0`, 'Content-Type': 'application/json' }, write: true,
      body: JSON.stringify({ fitGuid: id, sign: md5(file.bytes), fileName: file.fileName, fileSize: file.bytes.length }),
    });
    if (registered.data?.ec === 503) return this.receipt(ctx, 'duplicate');
    if (registered.data?.ec === 410001) throw this.error(ctx, '登录会话已失效，文件导入未确认。', 'http', 401);
    if (registered.data?.ec !== 0) throw this.error(ctx, '文件已上传，但注册运动记录未确认。', 'unconfirmed');
    return this.receipt(ctx, 'accepted');
  }

  async wahoo(ctx, credential, file, activity) {
    const headers = { Authorization: `Bearer ${credential.token}` };
    const form = new URLSearchParams({ 'workout_file_upload[file]': `data:application/vnd.fit;base64,${file.bytes.toString('base64')}`, 'workout_file_upload[filename]': file.fileName });
    if (activity.name) form.set('workout_file_upload[workout_name]', String(activity.name).slice(0, 250));
    let { data } = await this.request(ctx, 'https://api.wahooligan.com/v1/workout_file_uploads', { method: 'POST', headers, body: form, write: true, payload: true, allowed: [200, 201] });
    const token = safeId(data?.token);
    for (let attempt = 0; attempt <= this.pollAttempts; attempt++) {
      if (data?.status === 'duplicate') return this.receipt(ctx, 'duplicate', positiveId(data.workout_id));
      if (data?.status === 'error') throw this.error(ctx, '平台报告文件处理失败。');
      if (data?.status === 'complete') {
        const id = positiveId(data.workout_id);
        if (!id) throw this.error(ctx, '处理完成但缺少 workout_id，未确认活动记录。', 'unconfirmed');
        return this.receipt(ctx, 'confirmed', id);
      }
      if (!token || !['pending', 'in_progress'].includes(data?.status)) throw this.error(ctx, '返回的上传状态无法确认。', 'unconfirmed');
      if (attempt === this.pollAttempts) return this.receipt(ctx, 'accepted');
      await this.sleep(2000);
      ({ data } = await this.request(ctx, `https://api.wahooligan.com/v1/workout_file_uploads/${encodeURIComponent(token)}`, { headers }));
    }
  }

  async suunto(ctx, credential, file, activity) {
    const headers = { Authorization: `Bearer ${credential.token}`, 'Ocp-Apim-Subscription-Key': credential.subscriptionKey, Accept: 'application/json' };
    const initial = await this.request(ctx, 'https://cloudapi.suunto.com/v2/upload', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, write: true,
      body: JSON.stringify({ description: String(activity.name || '运动记录').slice(0, 250), notifyUser: false, privacy: 'DEFAULT' }), allowed: [200, 201],
    });
    const id = safeId(initial.data?.id);
    const url = checkedStorageUrl(initial.data?.url, ['suunto.blob.core.windows.net']);
    if (!id || !url || initial.data?.method !== 'PUT' || initial.data?.headers?.['x-ms-blob-type'] !== 'BlockBlob') throw this.error(ctx, '未取得有效的官方文件上传参数。', 'storage');
    await this.request(ctx, url, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/vnd.garmin.fit' }, body: file.bytes, write: true, payload: true, allowed: [200, 201], json: false });
    for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
      const result = await this.request(ctx, `https://cloudapi.suunto.com/v2/upload/${encodeURIComponent(id)}`, { headers });
      if (result.data?.status === 'ERROR') throw this.error(ctx, '平台报告文件处理失败。');
      if (result.data?.status === 'PROCESSED') {
        const workout = safeId(result.data.workoutKey);
        if (!workout) throw this.error(ctx, '处理完成但缺少 workoutKey，未确认活动记录。', 'unconfirmed');
        return this.receipt(ctx, 'confirmed', workout, publicLink(result.data.webUrl, ['www.suunto.com', 'suunto.com']));
      }
      if (!['NEW', 'ACCEPTED'].includes(result.data?.status)) throw this.error(ctx, '返回的上传状态无法确认。', 'unconfirmed');
      if (attempt + 1 < this.pollAttempts) await this.sleep(2000);
    }
    return this.receipt(ctx, 'accepted');
  }

  async komoot(ctx, credential, file, activity) {
    const headers = { Authorization: basic(credential.email, credential.token), 'User-Agent': 'sports-data-sync-web/0.1', 'Content-Type': 'application/octet-stream' };
    const url = new URL('https://api.komoot.de/v007/tours/');
    url.searchParams.set('data_type', file.format);
    url.searchParams.set('name', String(activity.name || '运动记录').slice(0, 250));
    if (file.format === 'gpx') {
      const type = String(activity.type || '').toLowerCase();
      url.searchParams.set('sport', /cycl|bik|ride|骑/.test(type) ? 'racebike' : /run|跑/.test(type) ? 'jogging' : /hik|walk|徒步/.test(type) ? 'hike' : 'other');
    }
    const result = await this.request(ctx, url.href, { method: 'POST', headers, body: file.bytes, write: true, payload: true, allowed: [201, 202] });
    const id = positiveId(result.data?.id);
    if (!id) throw this.error(ctx, '没有返回明确的路线 ID，未确认成功。', 'unconfirmed');
    const detail = await this.request(ctx, `https://api.komoot.de/v007/tours/${id}`, { headers: { Authorization: headers.Authorization, 'User-Agent': headers['User-Agent'] } });
    if (positiveId(detail.data?.id) !== id) throw this.error(ctx, '目标路线读回不匹配，请到平台核对。', 'unconfirmed');
    return this.receipt(ctx, result.status === 202 ? 'duplicate' : 'confirmed', id, `https://www.komoot.com/tour/${id}`);
  }
}
