import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { json, readInput, RequestError, setResponseHeaders } from './server.mjs';
import { isPrivateIpv4 } from './personal-network.mjs';

const authAssets = new Map([
  ['/login', ['auth.html', 'text/html; charset=utf-8']],
  ['/auth.css', ['auth.css', 'text/css; charset=utf-8']],
  ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']],
  ['/workspace-icon.svg', ['workspace-icon.svg', 'image/svg+xml']],
]);
const browserLogin = new Set(['/api/login', '/api/verify', '/api/account/open', '/api/account/verify']);

export function validatePublicOrigin(value, { allowPrivateHttp = false } = {}) {
  if (!value) return null;
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== value || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && (local || (allowPrivateHttp && isPrivateIpv4(url.hostname)))))) {
    throw new Error('GARMIN_WEB_ORIGIN 须为 HTTPS 源地址，本机或指定的个人内网可用 HTTP。');
  }
  return url;
}

function createAuthLimiter() {
  const attempts = new Map();
  let active = 0;
  return async (request, username, action) => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (entry.until <= now) attempts.delete(key);
    }
    const address = request.socket.remoteAddress;
    const account = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 32) : '';
    const limits = [
      [`address:${address}`, 40, 60_000],
      [`account:${address}:${account}`, 8, 5 * 60_000],
    ];
    if (active >= 4 || attempts.size >= 2048 || limits.some(([key, max]) => (attempts.get(key)?.count || 0) >= max)) {
      throw new RequestError(429, '登录或注册请求过多，请稍后重试。');
    }
    for (const [key, , ttl] of limits) {
      const entry = attempts.get(key) || { count: 0, until: now + ttl };
      entry.count++;
      attempts.set(key, entry);
    }
    active++;
    try { return await action(); }
    finally { active--; }
  };
}

export function createMultiUserServer({ authStore, workspaceFor, origin, isReady = () => true, personal = false, network, tls }) {
  const publicOrigin = validatePublicOrigin(origin, { allowPrivateHttp: Boolean(network) });
  const secure = publicOrigin?.protocol === 'https:';
  if (tls && (!secure || !tls.key || !tls.cert)) {
    throw new Error('直接 TLS 需要 HTTPS 工作台地址、证书和私钥。');
  }
  const cookieName = secure ? '__Host-sports_sync_session' : 'sports_sync_session';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const limitAuth = createAuthLimiter();

  const create = tls ? createHttpsServer : createServer;
  return create({ ...tls, requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    setResponseHeaders(response);
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      if (network && !network.allows(request.socket.remoteAddress)) {
        throw new RequestError(403, '请在工作台所在的内网访问。');
      }
      const { host } = request.headers;
      const port = request.socket.localPort;
      if (publicOrigin ? host !== publicOrigin.host : host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new RequestError(403, '请使用配置的工作台地址访问。');
      }
      const expectedOrigin = publicOrigin?.origin || `http://${host}`;
      const url = new URL(request.url, expectedOrigin);
      if (url.origin !== expectedOrigin) throw new RequestError(403, '请求地址无效。');
      const path = url.pathname;
      if (request.method === 'POST' && request.headers.origin !== expectedOrigin) {
        throw new RequestError(403, '请从当前工作台页面执行操作。');
      }

      if (request.method === 'GET' && path === '/healthz') {
        const ok = isReady();
        return json(response, ok ? 200 : 503, { ok });
      }
      if (request.method === 'GET' && authAssets.has(path)) {
        const [file, contentType] = authAssets.get(path);
        const body = await readFile(new URL(`./public/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(body);
      }
      const setup = personal && path === '/api/auth/setup';
      const login = path === '/api/auth/login';
      const register = path === '/api/auth/register';
      if (setup && ['GET', 'POST'].includes(request.method)) {
        const required = authStore.setupRequired();
        if (required && network && !network.checkSetup(request.socket.remoteAddress)) {
          throw new RequestError(403, '请在部署时指定的设备上完成首次设置。');
        }
        if (request.method === 'GET') return json(response, 200, { required });
        if (!required) throw new RequestError(409, '首次设置已完成，请登录工作台。');
      }
      if (personal && register) throw new RequestError(404, '未找到该页面或操作。');
      if (request.method === 'POST' && (login || register || setup)) {
        const input = await readInput(request, 4096);
        const session = await limitAuth(request, input.username, async () => {
          if (login) return authStore.login(input);
          const user = await (setup ? authStore.setupOwner(input) : authStore.register(input));
          return { ...authStore.createSession(user.id), user };
        });
        const seconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
        response.setHeader('Set-Cookie', `${cookieName}=${session.token}; ${cookieAttributes}; Max-Age=${seconds}`);
        return json(response, login ? 200 : 201, { viewer: { username: session.user.username } });
      }

      const cookies = (request.headers.cookie || '').split(';').map(cookie => cookie.trim())
        .filter(cookie => cookie.startsWith(cookieName + '='));
      const token = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : '';
      const user = authStore.getSession(token);
      if (!user) {
        if (path.startsWith('/api/')) throw new RequestError(401, '请登录工作台。');
        if (request.method !== 'GET') throw new RequestError(405, '请求方式无效。');
        response.writeHead(302, { Location: '/login' });
        return response.end();
      }
      const viewer = { username: user.username };
      if (request.method === 'GET' && path === '/api/auth/session') return json(response, 200, { viewer });
      if (request.method === 'POST' && path === '/api/auth/logout') {
        authStore.revokeSession(token);
        response.setHeader('Set-Cookie', `${cookieName}=; ${cookieAttributes}; Max-Age=0`);
        return json(response, 200, { message: '已退出工作台。' });
      }
      if (browserLogin.has(path)) throw new RequestError(503, '多用户模式的平台官网授权尚未开放。');
      if (path === '/garmin' || path.startsWith('/api/auth/')) throw new RequestError(404, '未找到该页面或操作。');
      const context = await workspaceFor(user);
      return await context.handle(request, response, url, expectedOrigin, personal ? { ...viewer, personal: true } : viewer);
    } catch (error) {
      const status = error?.status;
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        if (status === 429) response.setHeader('Retry-After', '60');
        return json(response, status, { error: error.message });
      }
      return json(response, 500, { error: '工作台服务执行失败，请稍后重试。' });
    }
  });
}
