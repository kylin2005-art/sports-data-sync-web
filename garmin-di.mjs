import { createHash } from 'node:crypto';
import { GarminError, activityRows, importedId, originalFit, validFit } from './garmin-browser.mjs';

const regions = { cn: '国区', com: '国际区' };
const pageSize = 20;
const maxFile = 50 * 1024 * 1024;
const maxJson = 4 * 1024 * 1024;
const fitUploadFormats = Object.freeze(['fit']);
const dayMs = 24 * 60 * 60 * 1000;
// Garmin uses this grant identifier in both regions. Requests still use the selected region's token host.
const grant = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
const clientIds = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
];
const nativeHeaders = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861',
  'X-Garmin-Client-Platform': 'Android',
  'X-App-Ver': '10861',
  'X-GCExperience': 'GC5',
  Accept: 'application/json',
};

function label(region) {
  if (!Object.hasOwn(regions, region)) throw new GarminError('请选择佳明国区或国际区。', 400);
  return `佳明${regions[region]}`;
}

function idOf(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  return /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : null;
}

function token(value) {
  return typeof value === 'string' && value.length <= 16_000 && /^[!-~]+$/.test(value);
}

function sessionFor(region, data, fallbackClient, previous) {
  const access = data?.access_token;
  const refresh = data?.refresh_token ?? previous?.di_refresh_token;
  if (!token(access) || !token(refresh)) {
    throw new GarminError(`${label(region)}未返回可续期的 DI 令牌。`);
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(access.split('.')[1] || '', 'base64url').toString('utf8')); }
  catch { /* Some token responses provide expiration only in expires_in. */ }
  const claimClient = claims?.client_id;
  const client = typeof claimClient === 'string' && /^GARMIN_CONNECT_MOBILE_[A-Z0-9_]{3,60}$/.test(claimClient)
    ? claimClient : fallbackClient;
  const lifetime = Number(data.expires_in);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number.isSafeInteger(claims?.exp) && claims.exp > now ? claims.exp
    : now + (Number.isSafeInteger(lifetime) && lifetime > 0 && Number.isSafeInteger(now + lifetime) ? lifetime : 3600);
  return { region, di_token: access, di_refresh_token: refresh, di_client_id: client, expiresAt };
}

async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new GarminError('佳明返回内容超过大小限制。', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new GarminError('佳明返回内容超过大小限制。', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function json(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new GarminError('佳明未返回有效 JSON。'); }
}

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);

function reportsFailure(data) {
  return data.ok === false || data.success === false || Number(data.statusCode ?? data.status) >= 400 ||
    /fail|error|reject|denied|duplicate/i.test(String(data.status ?? '')) ||
    [data.error, data.errors, data.failure, data.failures].some(value =>
      Array.isArray(value) ? value.length > 0 : Boolean(value));
}

function canCheckOriginal(data) {
  if (!isRecord(data) || reportsFailure(data)) return false;
  const detail = data.detailedImportResult;
  if (detail == null) return Boolean(idOf(data.uploadId));
  if (!isRecord(detail) || reportsFailure(detail) ||
      (detail.failures != null && !Array.isArray(detail.failures))) return false;
  const successes = detail.successes;
  if (successes == null) return true;
  if (!Array.isArray(successes)) return false;
  if (!successes.length) return true;
  const [entry] = successes;
  return successes.length === 1 && isRecord(entry) && !reportsFailure(entry) &&
    !idOf(entry.internalId) && !idOf(entry.activityId);
}

function startInstant(value) {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}

export class GarminDi {
  #records = new Map();
  #busy = new Set();
  #request;
  #onSessionState;

  constructor({ onSessionState, request = fetch } = {}) {
    this.#request = request;
    this.#onSessionState = onSessionState;
  }

  get uploadFormats() { return fitUploadFormats; }

  restore(region, { accountKey, sessionState } = {}) {
    label(region);
    if (!/^[a-f0-9]{64}$/.test(accountKey) || sessionState?.region !== region ||
        !token(sessionState.di_token) || !token(sessionState.di_refresh_token) ||
        !/^GARMIN_CONNECT_MOBILE_[A-Z0-9_]{3,60}$/.test(sessionState.di_client_id) ||
        !Number.isSafeInteger(sessionState.expiresAt)) {
      throw new GarminError(`${label(region)}保存的 DI 会话无效，请重新授权。`, 400);
    }
    this.#records.set(region, { accountKey, sessionState: structuredClone(sessionState) });
  }

  forget(region) {
    this.#records.delete(region);
  }

  async #exclusive(region, action) {
    label(region);
    if (this.#busy.has(region)) throw new GarminError('已有该地区的佳明请求正在执行。', 409);
    this.#busy.add(region);
    try { return await action(); }
    finally { this.#busy.delete(region); }
  }

  async #http(region, host, path, options = {}, limit = maxJson, accepted = []) {
    try {
      const response = await this.#request(`https://${host}.garmin.${region}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(35_000),
      });
      if (!response.ok && !accepted.includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        const failure = new GarminError(`${label(region)}请求返回 HTTP ${status}。`,
          [401, 403, 429].includes(status) ? status : 502);
        failure.upstreamStatus = status;
        throw failure;
      }
      return { bytes: await readLimited(response, limit), status: response.status };
    } catch (error) {
      if (error instanceof GarminError) throw error;
      throw new GarminError(`${label(region)}网络请求未完成。`, 503);
    }
  }

  async #exchange(region, client, fields) {
    return this.#http(region, 'diauth', '/di-oauth2-service/oauth/token', {
      method: 'POST',
      headers: { ...nativeHeaders, Authorization: `Basic ${Buffer.from(client + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({ client_id: client, ...fields }),
    }, maxJson, [400, 401]);
  }

  async #api(region, session, path, { body, limit, accepted, accept = nativeHeaders.Accept } = {}) {
    return this.#http(region, 'connectapi', path, {
      method: body ? 'POST' : 'GET', body,
      headers: { ...nativeHeaders, Accept: accept, Authorization: `Bearer ${session.di_token}` },
    }, limit, accepted);
  }

  async #profile(region, session) {
    const { bytes } = await this.#api(region, session, '/userprofile-service/socialProfile');
    const profile = json(bytes);
    const id = idOf(profile?.profileId) || idOf(profile?.id);
    if (!id) throw new GarminError(`${label(region)}未返回可核对的账号 ID。`);
    return createHash('sha256').update(`garmin:${region}:${id}`).digest('hex');
  }

  async #list(region, session, start, limit, dates = '') {
    const { bytes } = await this.#api(region, session,
      `/activitylist-service/activities/search/activities?start=${start}&limit=${limit}${dates}`);
    return activityRows(json(bytes));
  }

  async authorize(region, ticket, save = this.#onSessionState, serviceUrl = `https://sso.garmin.${region}/sso/embed`) {
    return this.#exclusive(region, async () => {
      if (typeof ticket !== 'string' || !/^ST-[a-zA-Z0-9_-]{8,509}$/.test(ticket)) {
        throw new GarminError('佳明登录票据格式无效。', 400);
      }
      if (serviceUrl !== `https://sso.garmin.${region}/sso/embed` && serviceUrl !== `https://connect.garmin.${region}/app`) {
        throw new GarminError('佳明登录服务与授权地区不匹配。', 400);
      }
      if (typeof save !== 'function') throw new GarminError('佳明会话保存服务未就绪。', 503);
      let sessionState;
      for (const client of clientIds) {
        const reply = await this.#exchange(region, client, {
          service_ticket: ticket, grant_type: grant, service_url: serviceUrl,
        });
        const data = json(reply.bytes);
        if (reply.status === 200) {
          sessionState = sessionFor(region, data, client);
          break;
        }
        if (!['invalid_client', 'unauthorized_client'].includes(data?.error)) break;
      }
      if (!sessionState) throw new GarminError(`${label(region)}未接受该登录票据，请从工作台重新授权。`, 422);
      const accountKey = await this.#profile(region, sessionState);
      await this.#list(region, sessionState, 0, 1);
      const record = { accountKey, sessionState };
      await save(region, structuredClone(record));
      this.#records.set(region, record);
      return { accountKey, message: `${label(region)}授权和活动读取已验证。` };
    });
  }

  #current(region) {
    const current = this.#records.get(region);
    if (!current) throw new GarminError(`请先完成${label(region)}授权。`, 401, region);
    return current;
  }

  async #renew(region, current) {
    const old = current.sessionState;
    const reply = await this.#exchange(region, old.di_client_id, {
      grant_type: 'refresh_token', refresh_token: old.di_refresh_token,
    });
    const data = json(reply.bytes);
    if (reply.status !== 200) {
      if (data?.error === 'invalid_grant' || data?.error === 'invalid_token') {
        throw new GarminError(`${label(region)}刷新令牌已失效，请重新授权。`, 401, region);
      }
      throw new GarminError(`${label(region)}拒绝续期（HTTP ${reply.status}）。`);
    }
    const sessionState = sessionFor(region, data, old.di_client_id, old);
    const record = { accountKey: current.accountKey, sessionState };
    if (this.#records.get(region) !== current) throw new GarminError('佳明连接已变更，请重新开始。', 409);
    if (typeof this.#onSessionState !== 'function') throw new GarminError('佳明会话保存服务未就绪。', 503);
    await this.#onSessionState(region, structuredClone(record));
    if (this.#records.get(region) !== current) throw new GarminError('佳明连接已变更，请重新开始。', 409);
    this.#records.set(region, record);
    return record;
  }

  async #withAccount(region, action, force = false) {
    let current = this.#current(region);
    let refreshed = force || current.sessionState.expiresAt <= Math.floor(Date.now() / 1000) + 60;
    if (refreshed) current = await this.#renew(region, current);
    let accountKey;
    try {
      accountKey = await this.#profile(region, current.sessionState);
    } catch (error) {
      if (error.status !== 401 || refreshed) throw error;
      refreshed = true;
      current = await this.#renew(region, current);
      accountKey = await this.#profile(region, current.sessionState);
    }
    if (accountKey !== current.accountKey || this.#records.get(region) !== current) {
      throw new GarminError(`${label(region)}账号与保存的连接不一致，请重新授权。`, 401, region);
    }
    return action(current.sessionState, accountKey);
  }

  async verify(region) {
    return this.#exclusive(region, () => this.#withAccount(region, async (session, accountKey) => {
      await this.#list(region, session, 0, 1);
      return { accountKey, message: `${label(region)}连接正常。` };
    }));
  }

  async refresh(region) {
    return this.#exclusive(region, () => this.#withAccount(region, async (session, accountKey) => {
      await this.#list(region, session, 0, 1);
      return { accountKey, refreshed: true, message: `${label(region)}已续期并读回活动。` };
    }, true));
  }

  async activities(start = 0, region = 'cn', limit = pageSize) {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > pageSize) {
      throw new GarminError('佳明活动分页无效。', 400);
    }
    return this.#exclusive(region, () => this.#withAccount(region, async session => {
      const activities = await this.#list(region, session, start, limit);
      return { activities, nextStart: activities.length === limit ? start + activities.length : null };
    }));
  }

  async download(region, id) {
    const sourceId = idOf(id);
    if (!sourceId) throw new GarminError('活动 ID 无效。', 400);
    return this.#exclusive(region, () => this.#withAccount(region, async session => {
      const data = await this.#original(region, session, sourceId);
      return { data, fileName: `garmin_${sourceId}.fit` };
    }));
  }

  async #original(region, session, id) {
    const { bytes } = await this.#api(region, session, `/download-service/files/activity/${id}`, {
      limit: maxFile, accept: '*/*',
    });
    return originalFit(bytes.toString('base64'));
  }

  async #findByOriginal(region, session, file, time) {
    const instant = startInstant(time);
    if (!Number.isFinite(instant)) return null;
    // Search adjacent calendar days for timezone differences, then require an exact instant.
    const startDate = new Date(instant - dayMs).toISOString().slice(0, 10);
    const endDate = new Date(instant + dayMs).toISOString().slice(0, 10);
    const dates = `&startDate=${startDate}&endDate=${endDate}`;
    const candidates = new Set();
    for (let start = 0; start < pageSize * 3; start += pageSize) {
      const activities = await this.#list(region, session, start, pageSize, dates);
      for (const activity of activities) {
        if (startInstant(activity.time) === instant) candidates.add(activity.id);
      }
      if (candidates.size > 4) return null;
      if (activities.length < pageSize) {
        let match = null;
        for (const id of candidates) {
          if (!(await this.#original(region, session, id)).equals(file)) continue;
          if (match) return null;
          match = id;
        }
        return match;
      }
    }
    return null;
  }

  async #confirm(region, session, activityId) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { bytes } = await this.#api(region, session, `/activity-service/activity/${activityId}`);
        if (idOf(json(bytes)?.activityId) !== activityId) throw new GarminError('目标区返回的活动 ID 不匹配。');
        return { activityId, url: `https://connect.garmin.${region}/modern/activity/${activityId}`,
          message: `已在${label(region)}按活动 ID 读回确认。` };
      } catch (error) {
        if (error.upstreamStatus !== 404 || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }
  }

  async confirm(region, id) {
    const activityId = idOf(id);
    if (!activityId) throw new GarminError('目标活动 ID 无效。', 400);
    return this.#exclusive(region, () => this.#withAccount(region, session => this.#confirm(region, session, activityId)));
  }

  async upload(region, file, { beforeUpload, onImported, activity } = {}) {
    let attempted = false;
    try {
      const target = label(region);
      if (!Buffer.isBuffer(file?.data) || file.data.length > maxFile || !validFit(file.data)) {
        throw new GarminError(`仅支持将不超过 50 MB 的有效 FIT 上传到${target}。`, 400);
      }
      return await this.#exclusive(region, () => this.#withAccount(region, async session => {
        const body = new FormData();
        body.set('file', new Blob([file.data], { type: 'application/octet-stream' }), 'activity.fit');
        if (beforeUpload) {
          try { await beforeUpload(); }
          catch { throw new GarminError('未能保存上传意图，原始 FIT 尚未发送。', 503); }
        }
        attempted = true;
        const { bytes, status } = await this.#api(region, session, '/upload-service/upload', { body, accepted: [409] });
        const data = json(bytes);
        let activityId;
        let matchedOriginal = false;
        try { activityId = importedId(data, status); }
        catch (error) {
          if (status < 200 || status >= 300 || error.status !== 502 || !canCheckOriginal(data)) throw error;
          activityId = await this.#findByOriginal(region, session, file.data, activity?.time);
          if (!activityId) throw error;
          matchedOriginal = true;
        }
        if ([data, data?.detailedImportResult, data?.detailedImportResult?.successes?.[0]]
          .some(item => isRecord(item) && reportsFailure(item))) {
          throw new GarminError('佳明返回上传错误，请在目标区核对。');
        }
        if (onImported) {
          try { await onImported({ activityId, url: `https://connect.garmin.${region}/modern/activity/${activityId}` }); }
          catch { throw new GarminError(`未能保存${target}待核验记录，请先到目标区核对。`, 503); }
        }
        const receipt = await this.#confirm(region, session, activityId);
        return matchedOriginal ? { ...receipt, message: `找到字节一致的原始 FIT。${receipt.message}` } : receipt;
      }));
    } catch (error) {
      if (!attempted && error instanceof GarminError) error.mayHaveUploaded = false;
      throw error;
    }
  }
}
