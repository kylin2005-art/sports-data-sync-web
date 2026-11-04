import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { unzipSync } from 'fflate';

const ORIGINS = { cn: 'https://connect.garmin.cn', com: 'https://connect.garmin.com' };
const LABELS = { cn: '国区', com: '国际区' };
const PAGE_SIZE = 20;
const MAX_FILE = 50 * 1024 * 1024;

export class GarminError extends Error {
  constructor(message, status = 502, region) {
    super(message);
    this.name = 'GarminError';
    this.status = status;
    if (region) this.region = region;
  }
}

function regionName(region) {
  if (!Object.hasOwn(ORIGINS, region)) throw new GarminError('请选择国区或国际区。', 400);
  return region;
}

// This object is private: the caller must encrypt it, never send it to the web UI.
function scopedSessionState(region, state, strict = false) {
  const domains = new Set([`garmin.${region}`, `connect.garmin.${region}`, `sso.garmin.${region}`]);
  const origins = new Set([ORIGINS[region], `https://sso.garmin.${region}`]);
  const invalid = () => { throw new GarminError('保存的佳明登录状态无效，请重新打开官方窗口登录。', 400); };
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) invalid();
  if (state.cookies.length > 1000 || state.origins.length > 100) invalid();
  const cookies = [];
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie.domain !== 'string' || !domains.has(cookie.domain.replace(/^\./, '').toLowerCase())) {
      if (strict) invalid();
      continue;
    }
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
        typeof cookie.path !== 'string' || !cookie.path.startsWith('/') ||
        !Number.isFinite(cookie.expires) || (cookie.expires < 0 && cookie.expires !== -1) ||
        typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean' ||
        !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) invalid();
    const copy = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite };
    if (cookie.partitionKey != null) {
      if (![`https://garmin.${region}`, ...origins].includes(cookie.partitionKey)) { if (strict) invalid(); else continue; }
      copy.partitionKey = cookie.partitionKey;
    }
    cookies.push(copy);
  }
  const keptOrigins = [];
  for (const origin of state.origins) {
    if (!origin || !origins.has(origin.origin)) { if (strict) invalid(); else continue; }
    if (!Array.isArray(origin.localStorage) || origin.localStorage.length > 1000) invalid();
    keptOrigins.push({ origin: origin.origin, localStorage: origin.localStorage.map(item => {
      if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') invalid();
      return { name: item.name, value: item.value };
    }).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  const result = { cookies: cookies.sort((a, b) => `${a.domain}:${a.path}:${a.name}`.localeCompare(`${b.domain}:${b.path}:${b.name}`)),
    origins: keptOrigins.sort((a, b) => a.origin.localeCompare(b.origin)) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 6 * 1024 * 1024) invalid();
  return result;
}

function activityId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return /^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : null;
}

function activityRows(data) {
  if (!Array.isArray(data)) throw new GarminError('佳明活动列表格式无效，未将错误当作空列表。');
  return data.map(row => {
    const id = row && activityId(row.activityId);
    if (!id || typeof row !== 'object') throw new GarminError('佳明活动列表包含无效活动 ID，请重新读取。');
    const distance = Number(row.distance ?? 0);
    const duration = Number(row.duration ?? 0);
    if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(duration) || duration < 0) {
      throw new GarminError('佳明活动距离或时长格式无效，请重新读取。');
    }
    const utc = row.startTimeGMT ?? row.startTimeUTC;
    let time = typeof utc === 'string' ? utc.replace(' ', 'T') : '';
    if (time && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(time)) time += 'Z';
    if (!time || !Number.isFinite(Date.parse(time))) time = typeof row.startTimeLocal === 'string' ? row.startTimeLocal : '';
    return {
      id, name: typeof row.activityName === 'string' ? row.activityName : '未命名活动',
      type: typeof row.activityType?.typeKey === 'string' ? row.activityType.typeKey : 'unknown',
      time, distance, duration,
    };
  });
}

function crc(bytes, length) {
  let value = 0;
  for (let i = 0; i < length; i++) {
    value ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
  }
  return value;
}

export function validFit(bytes) {
  if (bytes.length < 14 || ![12, 14].includes(bytes[0])) return false;
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== '.FIT') return false;
  const payload = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (!payload || bytes[0] + payload + 2 !== bytes.length) return false;
  if (bytes[0] === 14 && (bytes[12] || bytes[13]) && crc(bytes, 14) !== 0) return false;
  return crc(bytes, bytes.length) === 0;
}

function originalFit(base64) {
  const bytes = Buffer.from(base64, 'base64');
  if (validFit(bytes)) return bytes;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new GarminError('佳明下载内容不是有效 FIT 或 ZIP，已停止上传。');
  let files;
  let fitCount = 0;
  let oversized = false;
  try {
    files = unzipSync(bytes, { filter: entry => {
      if (!entry.name.toLowerCase().endsWith('.fit')) return false;
      fitCount++;
      if (entry.originalSize > MAX_FILE) { oversized = true; return false; }
      return fitCount === 1;
    } });
  } catch { throw new GarminError('佳明下载 ZIP 无法解压，已停止上传。'); }
  if (oversized) throw new GarminError('原始 FIT 超过 50 MB，本原型不处理该文件。', 413);
  if (fitCount !== 1) throw new GarminError('下载 ZIP 中没有唯一的 FIT 文件，已停止上传。');
  const fit = Object.values(files)[0];
  if (!fit || !validFit(fit)) throw new GarminError('原始 FIT 长度或校验不通过，已停止上传。');
  return Buffer.from(fit);
}

function importedId(data, status) {
  const detail = data?.detailedImportResult;
  const failures = detail?.failures;
  if (Array.isArray(failures) && failures.length) {
    const noSuccesses = detail.successes == null || (Array.isArray(detail.successes) && detail.successes.length === 0);
    const duplicate = failures.every(item => Array.isArray(item?.messages) && item.messages.length &&
      item.messages.every(message => typeof message?.content === 'string' && /^duplicate activity$/i.test(message.content.trim())));
    if (duplicate && noSuccesses && (status === 409 || (status >= 200 && status < 300))) {
      const error = new GarminError('佳明提示活动已存在，未新增记录；请在目标区核对。', 409);
      error.outcome = 'duplicate';
      error.mayHaveUploaded = false;
      throw error;
    }
    const error = new GarminError('佳明明确返回活动导入失败，未记录为成功。', 422);
    // A mixed successes/failures reply is not a definitive rejection.
    if (noSuccesses) error.mayHaveUploaded = false;
    throw error;
  }
  if (status < 200 || status >= 300) throw new GarminError(`目标区上传返回 HTTP ${status}，未确认导入。`);
  const successes = detail?.successes;
  if ((failures != null && !Array.isArray(failures)) || !Array.isArray(successes) || successes.length !== 1) {
    throw new GarminError('上传结果未确认：佳明未返回唯一成功活动 ID，请先到目标区核对，勿立即重传。');
  }
  const internal = activityId(successes[0]?.internalId);
  const explicit = activityId(successes[0]?.activityId);
  if ((!internal && !explicit) || (internal && explicit && internal !== explicit)) {
    throw new GarminError('上传结果未确认：佳明返回的活动 ID 无效，请先到目标区核对，勿立即重传。');
  }
  return explicit || internal;
}

export class GarminBrowser {
  #sessions = new Map();
  #busy = false;
  #profileRoot;
  #saved = new Map();
  #onSessionState;

  constructor(profileRoot, { onSessionState } = {}) {
    this.#profileRoot = resolve(profileRoot);
    this.#onSessionState = onSessionState;
  }

  restore(region, record) {
    regionName(region);
    if (!record || !/^[0-9a-f]{64}$/.test(record.accountKey)) throw new GarminError('保存的佳明账号身份无效，请重新验证登录。', 400);
    const sessionState = scopedSessionState(region, record.sessionState, true);
    this.#saved.set(region, { accountKey: record.accountKey, sessionState });
    const session = this.#sessions.get(region);
    if (session) { session.accountKey = record.accountKey; session.manualLogin = false; session.invalidated = false; }
  }

  forget(region) {
    regionName(region);
    this.#saved.delete(region);
    const session = this.#sessions.get(region);
    if (session) { session.invalidated = true; session.manualLogin = false; delete session.accountKey; }
  }

  async #exclusive(action, persist = true) {
    if (this.#busy) throw new GarminError('已有操作正在执行，请等待完成。', 409);
    this.#busy = true;
    try {
      const result = await action();
      if (persist) await this.#persistChangedSessions();
      return result;
    } catch (error) {
      if (error instanceof GarminError && error.status === 401 && error.region) this.forget(error.region);
      throw error;
    } finally { this.#busy = false; }
  }

  async #snapshot(region, session) {
    const cookies = await session.context.cookies([`${ORIGINS[region]}/app`, `${ORIGINS[region]}/gc-api/`, `https://sso.garmin.${region}/`, `https://garmin.${region}/`]);
    const localStorage = await this.#page(region).evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })));
    return scopedSessionState(region, { cookies, origins: [{ origin: ORIGINS[region], localStorage }] });
  }

  async #persistChangedSessions() {
    for (const [region, session] of this.#sessions) {
      const saved = this.#saved.get(region);
      if (!saved || session.invalidated || session.page.isClosed() || session.accountKey !== saved.accountKey) continue;
      let sessionState;
      try { sessionState = await this.#snapshot(region, session); }
      catch { continue; } // Closing a window must not erase its last verified snapshot.
      if (JSON.stringify(sessionState) === JSON.stringify(saved.sessionState)) continue;
      const record = { accountKey: saved.accountKey, sessionState };
      if (this.#onSessionState) {
        try { await this.#onSessionState(region, structuredClone(record)); }
        catch { throw new GarminError('佳明登录状态更新未能保存，请检查本机存储并重新验证；若刚上传文件，请先核对结果。', 503); }
      }
      this.#saved.set(region, record);
    }
  }

  async #launch(region, headless) {
    const profile = join(this.#profileRoot, region);
    await mkdir(profile, { recursive: true });
    let context;
    for (const channel of ['msedge', 'chrome']) {
      try {
        context = await chromium.launchPersistentContext(profile, { channel, headless, viewport: headless ? { width: 1280, height: 900 } : null, timeout: 20000 });
        break;
      } catch { /* Never return browser diagnostics containing profile or page data. */ }
    }
    if (!context) throw new GarminError('无法启动本机 Edge 或 Chrome。请安装其中一个浏览器，并关闭本工具先前打开的窗口后重试。', 503);
    const page = context.pages()[0] || await context.newPage();
    const session = { context, page, headless, manualLogin: !headless };
    this.#sessions.set(region, session);
    context.on('close', () => { if (this.#sessions.get(region) === session) this.#sessions.delete(region); });
    return session;
  }

  async #ensureSession(region) {
    let session = this.#sessions.get(region);
    if (session?.invalidated) throw new GarminError(`${LABELS[region]}需要重新打开官方窗口登录并验证。`, 401, region);
    if (session && !session.page.isClosed()) return session;
    const saved = this.#saved.get(region);
    if (!saved) throw new GarminError(`${LABELS[region]}尚无可恢复的登录状态，请打开官方窗口登录并验证。`, 401, region);
    if (session) await session.context.close().catch(() => {});
    session = await this.#launch(region, true);
    session.accountKey = saved.accountKey;
    try {
      await session.context.setStorageState(structuredClone(saved.sessionState));
      await session.page.goto(`${ORIGINS[region]}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      await session.context.close().catch(() => {});
      throw new GarminError(`${LABELS[region]}后台浏览器未能恢复，请检查网络后重试，或打开官方窗口重新验证。`, 503);
    }
    this.#page(region);
    return session;
  }

  async #stage(stage, action) {
    try { return await action(); }
    catch (error) {
      if (error instanceof GarminError) {
        error.message = `${stage}：${error.message}`;
        throw error;
      }
      throw new GarminError(`${stage}：操作未完成，请重试。`);
    }
  }

  async openLogin(region) {
    regionName(region);
    return this.#exclusive(async () => {
      let session = this.#sessions.get(region);
      this.#saved.delete(region);
      if (session?.headless || session?.page.isClosed()) { await session.context.close().catch(() => {}); session = null; }
      if (!session) session = await this.#launch(region, false);
      session.invalidated = false;
      session.manualLogin = true;
      delete session.accountKey;
      if (session.page.isClosed()) session.page = await session.context.newPage();
      await session.page.bringToFront();
      try { await session.page.goto(`${ORIGINS[region]}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch { throw new GarminError(`${LABELS[region]}登录页未加载完成，请在已打开的官方浏览器窗口检查网络后重试。`, 504); }
      return { message: `请在${LABELS[region]}佳明官方窗口完成登录和两步验证，再点击“验证登录”。` };
    }, false);
  }

  #page(region) {
    regionName(region);
    const session = this.#sessions.get(region);
    const page = session?.page;
    if (session?.invalidated) throw new GarminError(`${LABELS[region]}登录已失效，请重新打开官方窗口验证。`, 401, region);
    if (!page || page.isClosed()) throw new GarminError(`${LABELS[region]}浏览器已关闭，本次操作已停止；已验证的登录将在下次操作时尝试后台恢复。`, 503);
    let origin;
    try { origin = new URL(page.url()).origin; } catch { /* An unfinished navigation is not a logged-in page. */ }
    if (origin !== ORIGINS[region]) throw new GarminError(`请先在${LABELS[region]}官方页面完成登录和两步验证。`, 401, region);
    return page;
  }

  async #request(region, path, { binary = false, upload = null } = {}) {
    let page;
    try { page = this.#page(region); }
    catch (error) {
      if (upload && error instanceof GarminError) error.mayHaveUploaded = false;
      throw error;
    }
    let response;
    try {
      response = await page.evaluate(async ({ origin, path, binary, upload, maxFile }) => {
        if (location.origin !== origin) return { reason: 'session' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35000);
        try {
          const url = new URL(path, origin);
          if (url.origin !== origin || !url.pathname.startsWith('/gc-api/')) return { reason: 'path' };
          const activityList = url.pathname === '/gc-api/activitylist-service/activities/search/activities';
          if (activityList) url.searchParams.set('_gctFresh', crypto.randomUUID());
          // Garmin can return the original FIT in a ZIP with a different media type.
          const headers = { Accept: binary ? '*/*' : 'application/json', 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache', 'X-Requested-With': 'XMLHttpRequest' };
          const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
          if (csrf) headers['connect-csrf-token'] = csrf;
          let body;
          if (upload) {
            const raw = atob(upload.base64);
            const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
            body = new FormData();
            body.append('file', new Blob([bytes], { type: 'application/octet-stream' }), upload.name);
          }
          const options = { method: upload ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers, body, signal: controller.signal };
          let result = await fetch(url, options);
          if (activityList && result.status === 304) {
            url.searchParams.set('_gctFresh', crypto.randomUUID());
            result = await fetch(url, options);
          }
          const status = result.status;
          if (new URL(result.url).origin !== origin) return { reason: 'session' };
          if ((upload && !(status >= 200 && status < 300) && status !== 409) || (!upload && status !== 200)) return { status };
          if (result.headers.get('content-type')?.includes('text/html')) return { status, reason: 'html' };
          const limit = binary ? maxFile : 5 * 1024 * 1024;
          if (Number(result.headers.get('content-length')) > limit) return { status, reason: 'size' };
          const reader = result.body?.getReader();
          if (!reader) return { status, reason: 'empty' };
          const chunks = [];
          let size = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > limit) { await reader.cancel(); return { status, reason: 'size' }; }
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          if (binary) {
            let text = '';
            for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return { status, base64: btoa(text) };
          }
          try { return { status, data: JSON.parse(new TextDecoder().decode(bytes)) }; }
          catch { return { status, reason: 'json' }; }
        } catch { return { reason: controller.signal.aborted ? 'timeout' : 'network' }; }
        finally { clearTimeout(timer); }
      }, { origin: ORIGINS[region], path, binary, upload, maxFile: MAX_FILE });
    } catch {
      // Navigation/closing can destroy the execution context; never expose Playwright's URL-bearing error.
      throw new GarminError(upload ? `上传结果未确认：浏览器页面发生变化，请先到${LABELS[region]}核对，勿立即重传。` : `${LABELS[region]}页面已变化或浏览器已关闭，本次操作已停止；下次操作可尝试恢复已保存的登录。`, upload ? 502 : 503);
    }
    if (!upload && response.reason === 'html' && this.#sessions.get(region)?.headless) {
      throw new GarminError(`${LABELS[region]}后台收到登录或验证网页，请打开官方窗口重新验证。`, 401, region);
    }
    if (response.reason === 'session' || response.status === 401 || response.status === 429 || response.status === 403) {
      const status = response.reason === 'session' ? 401 : response.status;
      const message = status === 401 ? `${LABELS[region]}登录失效，请重新登录并验证。` : status === 429 ?
        `${LABELS[region]}平台限流，本次已停止，请稍后重试。` : `${LABELS[region]}佳明拒绝访问（HTTP 403），请在官方窗口检查验证提示。`;
      const error = new GarminError(message, status, status === 401 ? region : undefined);
      if (upload) error.mayHaveUploaded = false;
      throw error;
    }
    if (response.reason) {
      if (upload) throw new GarminError(`上传结果未确认：未收到有效导入结果，请先到${LABELS[region]}核对，勿立即重传。`);
      const messages = { html: '返回了登录或验证网页', json: '返回了无效 JSON', size: '响应超过本原型的大小限制', empty: '没有返回响应正文', timeout: '请求超时', network: '网络连接失败或发生重定向', path: '请求路径无效' };
      throw new GarminError(`${LABELS[region]}${messages[response.reason] || '读取失败'}，未将错误当作空列表。`, response.reason === 'timeout' ? 504 : 502);
    }
    if ((!upload && response.status !== 200) || (upload && !(response.status >= 200 && response.status < 300) && response.status !== 409)) {
      const error = new GarminError(`${LABELS[region]}${upload ? '上传结果未确认' : '读取失败'}：HTTP ${response.status || 0}${upload ? `，请先到${LABELS[region]}核对，勿立即重传` : ''}。`);
      error.upstreamStatus = response.status;
      throw error;
    }
    return response;
  }

  async #checkAccount(region, rebind = false) {
    await this.#ensureSession(region);
    this.#page(region);
    const session = this.#sessions.get(region);
    let key;
    try {
      const response = await this.#request(region, '/gc-api/userprofile-service/socialProfile');
      const stableId = activityId(response.data?.profileId) || activityId(response.data?.id);
      if (stableId) key = createHash('sha256').update(`garmin:${region}:${stableId}`).digest('hex');
    } catch (error) {
      if (error.region || error.status === 401 || error.status === 429) throw error;
      if (session.headless && (error.status === 503 || error.status === 504)) throw error;
      // Some accounts expose activities without socialProfile; no persistent identity is invented.
    }
    if (!rebind && session.accountKey && key !== session.accountKey) {
      if (!key) throw new GarminError(`${LABELS[region]}当前账号身份无法核实，已停止操作；请打开官方窗口重新验证登录。`, 503);
      throw new GarminError(`${LABELS[region]}浏览器账号已变化，请重新验证登录并重新选择活动。`, 401, region);
    }
    if (key) session.accountKey = key;
    else if (rebind) delete session.accountKey;
    return key;
  }

  async #verify(region, rebind = false) {
    await this.#checkAccount(region, rebind);
    await this.#readActivityList(region, 0, 1);
    const accountKey = this.#sessions.get(region)?.accountKey;
    return { message: `${LABELS[region]}登录和活动读取已验证。`, ...(accountKey ? { accountKey } : {}) };
  }

  async #readActivityList(region, start, limit) {
    const path = `/gc-api/activitylist-service/activities/search/activities?start=${start}&limit=${limit}`;
    let response;
    try { response = await this.#request(region, path); }
    catch (error) {
      if (error.status !== 403) throw error;
      const page = this.#page(region);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }); }
      catch { throw error; }
      await this.#checkAccount(region);
      response = await this.#request(region, path);
    }
    return activityRows(response.data);
  }

  async verify(region) {
    regionName(region);
    return this.#exclusive(async () => {
      const session = await this.#ensureSession(region);
      const result = await this.#verify(region, session.manualLogin && !session.headless);
      session.manualLogin = false;
      if (!result.accountKey) return result;
      let sessionState;
      try { sessionState = await this.#snapshot(region, session); }
      catch { throw new GarminError(`${LABELS[region]}登录已验证，但登录状态未能保存，请保持官方窗口打开并重新验证。`, 503); }
      this.#saved.set(region, { accountKey: result.accountKey, sessionState });
      return { ...result, sessionState: structuredClone(sessionState) };
    }, false);
  }

  async activities(start = 0, region = 'cn') {
    regionName(region);
    if (!Number.isSafeInteger(start) || start < 0) throw new GarminError('分页起点无效。', 400);
    return this.#exclusive(async () => {
      await this.#stage('活动账号验证', () => this.#checkAccount(region));
      const activities = await this.#readActivityList(region, start, PAGE_SIZE);
      return { activities, nextStart: activities.length === PAGE_SIZE ? start + activities.length : null };
    });
  }

  async #download(region, sourceId) {
    await this.#stage('来源账号验证', () => this.#checkAccount(region));
    const download = await this.#stage('原始文件下载', () => this.#request(region, `/gc-api/download-service/files/activity/${sourceId}`, { binary: true }));
    const data = await this.#stage('原始 FIT 校验', () => originalFit(download.base64));
    return { data, fileName: `garmin_${sourceId}.fit` };
  }

  async download(region, id) {
    regionName(region);
    const sourceId = activityId(id);
    if (!sourceId) throw new GarminError('活动 ID 无效。', 400);
    return this.#exclusive(() => this.#download(region, sourceId));
  }

  async #validateFile(region, file) {
    if (!file || !Buffer.isBuffer(file.data) || !file.data.length || file.data.length > MAX_FILE) {
      throw new GarminError('请选择不超过 50 MB 的 FIT 或 GPX 文件。', 400);
    }
    const data = Buffer.from(file.data);
    const extension = typeof file.fileName === 'string' ? file.fileName.match(/\.(fit|gpx)$/i)?.[1]?.toLowerCase() : null;
    if (extension === 'fit') {
      if (!validFit(data)) throw new GarminError('FIT 长度或校验不通过，未上传文件。', 400);
    } else if (extension === 'gpx') {
      let xml;
      try { xml = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { throw new GarminError('GPX 必须为有效 UTF-8 XML，未上传文件。', 400); }
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new GarminError('GPX 不支持外部文档或实体声明，未上传文件。', 400);
      await this.#ensureSession(region);
      let valid;
      try {
        valid = await this.#page(region).evaluate(text => {
          const document = new DOMParser().parseFromString(text, 'application/xml');
          const root = document.documentElement;
          if (document.getElementsByTagName('parsererror').length || root.localName !== 'gpx' ||
              !['http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1'].includes(root.namespaceURI)) return false;
          const points = [...document.getElementsByTagNameNS(root.namespaceURI, 'trkpt'), ...document.getElementsByTagNameNS(root.namespaceURI, 'rtept')];
          return points.length > 0 && points.every(point => {
            const lat = point.getAttribute('lat'), lon = point.getAttribute('lon');
            return lat?.trim() && lon?.trim() && Number.isFinite(Number(lat)) && Math.abs(Number(lat)) <= 90 && Number.isFinite(Number(lon)) && Math.abs(Number(lon)) <= 180;
          });
        }, xml);
      } catch (error) {
        if (error instanceof GarminError) throw error;
        throw new GarminError('GPX 校验未完成，请检查佳明浏览器窗口。', 502);
      }
      if (!valid) throw new GarminError('GPX 结构或轨迹坐标无效，未上传文件。', 400);
    } else throw new GarminError('仅支持 FIT 或 GPX 文件。', 400);
    // The original bytes are preserved. Keep the submitted filename free of local paths.
    return { data, fileName: `activity.${extension}` };
  }

  async #confirm(region, targetId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await this.#checkAccount(region);
        const check = await this.#request(region, `/gc-api/activity-service/activity/${targetId}`);
        if (activityId(check.data?.activityId) !== targetId) throw new GarminError('目标活动 ID 不匹配。');
        return { activityId: targetId, url: `${ORIGINS[region]}/modern/activity/${targetId}`, message: `已在${LABELS[region]}按活动 ID 读回确认。` };
      } catch (error) {
        if (error instanceof GarminError && error.upstreamStatus === 404 && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
          // Recheck the account on the next attempt: the official browser remains user controlled.
          continue;
        }
        const detail = error instanceof GarminError ? error.message : '请求未完成。';
        throw new GarminError(`目标活动读回（第 ${attempt + 1} 次）：${detail} 已有导入 ID，但尚未确认，请到${LABELS[region]}核对，勿立即重传。`, error instanceof GarminError ? error.status : 502, error instanceof GarminError ? error.region : undefined);
      }
    }
  }

  async confirm(region, id) {
    regionName(region);
    const targetId = activityId(id);
    if (!targetId) throw new GarminError('目标活动 ID 无效。', 400);
    return this.#exclusive(async () => {
      await this.#stage('目标账号验证', () => this.#checkAccount(region));
      return this.#confirm(region, targetId);
    });
  }

  async #upload(region, file, { beforeUpload, onImported } = {}) {
    let attempted = false;
    try {
    if ((beforeUpload != null && typeof beforeUpload !== 'function') || (onImported != null && typeof onImported !== 'function')) {
      throw new GarminError('上传记录回调无效，未发送文件。', 400);
    }
    const validated = await this.#stage('上传文件校验', () => this.#validateFile(region, file));
    await this.#stage('目标账号验证', () => this.#verify(region));
    if (beforeUpload) {
      try { await beforeUpload(); }
      catch { throw new GarminError('上传准备：无法保存上传意图，未发送文件。', 503); }
    }
    // A POST is issued once. A timeout or missing activity ID must never trigger an upload retry.
    attempted = true;
    const uploaded = await this.#stage('目标文件上传', () => this.#request(region, '/gc-api/upload-service/upload/', { upload: { base64: validated.data.toString('base64'), name: validated.fileName } }));
    const targetId = await this.#stage('导入结果解析', () => importedId(uploaded.data, uploaded.status));
    if (onImported) {
      try { await onImported({ activityId: targetId, url: `${ORIGINS[region]}/modern/activity/${targetId}` }); }
      catch { throw new GarminError('佳明已返回导入 ID，但保存待核验记录失败，请到目标区核对，勿立即重传。', 503); }
    }
    return this.#confirm(region, targetId);
    } catch (error) {
      if (!attempted && error instanceof GarminError) error.mayHaveUploaded = false;
      throw error;
    }
  }

  async upload(region, file, callbacks = {}) {
    regionName(region);
    return this.#exclusive(() => this.#upload(region, file, callbacks));
  }

  async transfer(id, callbacks = {}) {
    const sourceId = activityId(id);
    if (!sourceId) throw new GarminError('活动 ID 无效。', 400);
    return this.#exclusive(async () => {
      const file = await this.#download('cn', sourceId);
      const receipt = await this.#upload('com', file, callbacks);
      return { id: sourceId, ...receipt };
    });
  }

  async close() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(session => session.context.close()));
  }
}
