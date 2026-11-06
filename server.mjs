import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const actions = new Set(['/api/login', '/api/verify', '/api/activities', '/api/transfer']);
const workspaceAssets = new Map([
  ['/', ['workspace.html', 'text/html; charset=utf-8']],
  ['/garmin', ['index.html', 'text/html; charset=utf-8']],
  ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
  ['/ride-card.js', ['ride-card.js', 'text/javascript; charset=utf-8']],
  ['/ride-terrain.js', ['ride-terrain.js', 'text/javascript; charset=utf-8']],
  ['/ride-image.js', ['ride-image.js', 'text/javascript; charset=utf-8']],
  ['/ride-exploration.js', ['ride-exploration.js', 'text/javascript; charset=utf-8']],
  ['/workspace-icon.svg', ['workspace-icon.svg', 'image/svg+xml']],
  ['/ui/workspace-ui.js', ['ui/workspace-ui.js', 'text/javascript; charset=utf-8']],
  ['/ui/workspace-ui.css', ['ui/workspace-ui.css', 'text/css; charset=utf-8']],
  ['/ui/ride-map.js', ['ui/ride-map.js', 'text/javascript; charset=utf-8']],
  ['/ui/ride-map.css', ['ui/ride-map.css', 'text/css; charset=utf-8']],
  ['/ui/ride-map-worker.js', ['ui/ride-map-worker.js', 'text/javascript; charset=utf-8']],
]);
const rideMapOrigins = 'https://tiles.openfreemap.org https://tiles.mapterhorn.com';
const garminDiAssets = new Map([
  ['/garmin-di', ['garmin-di.html', 'text/html; charset=utf-8']],
  ['/garmin-di.js', ['garmin-di.js', 'text/javascript; charset=utf-8']],
]);
const validId = (id) => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id);
const trackPageSize = 20;
const trackCacheSize = 100;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new RequestError(413, '请求内容过大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readInput(request, limit = 1024) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(400, '请求需要使用 JSON 格式。');
  }
  const data = await readBody(request, limit);
  try {
    const input = JSON.parse(data.toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch {
    throw new RequestError(400, '请求内容无效。');
  }
}

export function setResponseHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

export function createWorkspaceHandler(garmin, workspaceFactory, { diOrigin } = {}) {
  const verified = { cn: false, com: false };
  const seen = new Set();
  const trackSummaries = new Map();
  let exploreRide;
  let busy = false;

  async function invalidate(region) {
    verified[region] = false;
    if (region === 'cn') seen.clear();
    if (workspace) await workspace.clearGarmin(region);
  }

  const workspace = workspaceFactory?.({ isBusy: () => busy, onGarminInvalid: invalidate });
  if (workspace) {
    verified.cn = workspace.hasGarmin('cn');
    verified.com = workspace.hasGarmin('com');
  }

  async function trackLibrary(params) {
    const offsets = params.getAll('start');
    const offset = offsets[0] ?? '0';
    const start = Number(offset);
    if (offsets.length > 1 || !/^\d+$/.test(offset) || !Number.isSafeInteger(start)) {
      throw new RequestError(400, '轨迹列表分页位置无效。');
    }
    const { files, total } = workspace.store.trackLibraryPage(start, trackPageSize);
    const { readRideSummary } = await import('./tracks.mjs');
    const rows = [];
    for (const { id, name, fileName, time, created } of files) {
      if (!trackSummaries.has(id)) {
        await yieldToRequests();
        if (!trackSummaries.has(id)) {
          const summary = readRideSummary(workspace.store.file(id));
          if (trackSummaries.size >= trackCacheSize) trackSummaries.delete(trackSummaries.keys().next().value);
          trackSummaries.set(id, summary);
        }
      }
      const summary = trackSummaries.get(id);
      const activityTime = typeof time === 'string' && time !== created &&
        /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(time) && Number.isFinite(Date.parse(time)) ? time : null;
      rows.push({ id, name, fileName, startTime: summary?.startTime ?? activityTime,
        metrics: summary?.metrics ?? null, estimated: summary?.estimated ?? [] });
    }
    const next = start + rows.length;
    return { files: rows, total, nextStart: next < total ? next : null };
  }

  const workspaceActions = workspace && new Map([
    ['/api/account', input => workspace.configure(input)],
    ['/api/account/sign-in', input => workspace.signIn(input)],
    ['/api/account/browser-connect', input => workspace.connectBrowser(input)],
    ['/api/account/open', input => workspace.openPlatform(input)],
    ['/api/account/verify', input => workspace.verifyPlatform(input)],
    ['/api/accounts/check', () => workspace.checkAccounts()],
    ['/api/disconnect', input => workspace.disconnect(input)],
    ['/api/list', input => workspace.list(input)],
    ['/api/file-test', input => workspace.testDownload(input)],
    ['/api/run', input => workspace.start(input)],
    ['/api/stop', () => workspace.stop()],
    ['/api/jobs/save', input => workspace.saveJob(input)],
    ['/api/jobs/delete', input => workspace.deleteJob(input)],
    ['/api/workouts/list', input => workspace.listWorkouts(input)],
    ['/api/workouts/publish', input => workspace.publishWorkout(input)],
    ['/api/history/confirm', input => workspace.confirmReceipt(input)],
    ['/api/history/release', input => workspace.release(input)],
    ['/api/tracks', async input => (await import('./tracks.mjs')).processTracks(input, workspace)],
  ]);
  if (diOrigin && workspaceActions) {
    const challenges = new Map();
    const checkRegion = ({ region }) => {
      if (region !== 'cn' && region !== 'com') throw new RequestError(400, '请选择佳明账号区域。');
      return region;
    };
    workspaceActions.set('/api/garmin-di/start', input => {
      const region = checkRegion(input);
      const { flow = 'widget' } = input;
      if (flow !== 'widget' && flow !== 'portal') throw new RequestError(400, '佳明授权方式无效。');
      const sso = `https://sso.garmin.${region}`;
      const portal = flow === 'portal';
      const serviceUrl = portal ? `https://connect.garmin.${region}/app` : sso + '/sso/embed';
      const url = new URL(portal ? '/portal/sso/en-US/sign-in' : '/sso/signin', sso);
      url.search = new URLSearchParams(portal ? { clientId: 'GarminConnect', service: serviceUrl } : {
        id: 'gauth-widget', embedWidget: 'true', gauthHost: sso + '/sso',
        service: serviceUrl, source: diOrigin, consumeServiceTicket: 'false',
      }).toString();
      const state = randomBytes(32).toString('base64url');
      challenges.set(region, { state, serviceUrl, expires: Date.now() + 15 * 60_000 });
      return portal ? { url: url.href, state, serviceUrl } : { url: url.href, state };
    });
    workspaceActions.set('/api/garmin-di/finish', async input => {
      const region = checkRegion(input);
      const challenge = challenges.get(region);
      if (!challenge || challenge.expires <= Date.now() || challenge.state !== input.state) {
        throw new RequestError(400, '授权请求已失效，请重新打开佳明登录。');
      }
      if (typeof input.ticket !== 'string' || !/^ST-[A-Za-z0-9_-]{8,509}$/.test(input.ticket)) {
        throw new RequestError(400, '佳明返回的授权票据格式不正确。');
      }
      challenges.delete(region);
      const result = await garmin.authorize(region, input.ticket,
        (savedRegion, record) => workspace.rememberGarmin(savedRegion, record), challenge.serviceUrl);
      verified[region] = true;
      if (region === 'cn') seen.clear();
      return { message: result.message };
    });
    workspaceActions.set('/api/garmin-di/refresh', async input => {
      const { message, refreshed } = await garmin.refresh(checkRegion(input));
      return { message, refreshed };
    });
    workspaceActions.set('/api/garmin-di/verify-replay', input => workspace.verifyGarminReplay(input));
  }

  async function perform(path, input) {
    if (path === '/api/login' || path === '/api/verify') {
      const { region } = input;
      if (region !== 'cn' && region !== 'com') throw new RequestError(400, '请选择佳明账号区域。');
      if (path === '/api/login') {
        await invalidate(region);
        return garmin.openLogin(region);
      }
      if (!workspace?.hasSavedGarmin(region)) {
        verified[region] = false;
        workspace?.setGarmin(region, null);
      }
      if (region === 'cn') seen.clear();
      const result = await garmin.verify(region);
      const saved = await workspace?.rememberGarmin(region, result);
      verified[region] = true;
      if (saved) return { message: '登录已验证并保存，可以关闭佳明登录窗口。' };
      if (workspace?.sessionVault) return { message: '登录已验证，但佳明暂未提供可用于后台恢复的会话。请保留此登录窗口。' };
      return { message: result.message };
    }
    if (!verified.cn) throw new RequestError(409, '请先验证佳明国区登录。');
    if (path === '/api/activities') {
      const { start } = input;
      if (!Number.isSafeInteger(start) || start < 0) throw new RequestError(400, '活动分页位置无效。');
      const result = workspace ? await workspace.list({ source: 'cn', start }) : await garmin.activities(start);
      for (const activity of result.activities) seen.add(activity.id);
      return result;
    }
    if (!verified.com) throw new RequestError(409, '请先验证佳明国际区登录。');
    if (!validId(input.id) || !seen.has(input.id)) {
      throw new RequestError(400, '请从已读取的列表选择一条活动。');
    }
    return workspace ? workspace.transferSingle(input.id) : garmin.transfer(input.id);
  }

  async function handle(request, response, url, expectedOrigin, viewer) {
    try {
      const path = url.pathname;
      const asset = (diOrigin && garminDiAssets.get(path)) || (workspace && workspaceAssets.get(path)) || assets.get(path);
      if (request.method === 'GET' && asset) {
        const [file, type] = asset;
        const body = await readFile(new URL(`./public/${file}`, import.meta.url));
        if (path === '/garmin-di') {
          const csp = response.getHeader('Content-Security-Policy');
          response.setHeader('Content-Security-Policy', csp + '; frame-src https://sso.garmin.cn https://sso.garmin.com');
        }
        if (file === 'workspace.html' || file === 'ui/ride-map-worker.js') {
          let csp = response.getHeader('Content-Security-Policy')
            .replace("connect-src 'self'", `connect-src 'self' ${rideMapOrigins}`);
          if (file === 'workspace.html') {
            csp = csp.replace("img-src 'self'", `img-src 'self' data: blob: ${rideMapOrigins}`) + "; worker-src 'self'";
          }
          response.setHeader('Content-Security-Policy', csp);
        }
        response.writeHead(200, { 'Content-Type': type });
        return response.end(body);
      }
      if (request.method === 'GET' && path === '/api/state') return json(response, 200, verified);
      if (workspace && request.method === 'GET') {
        if (path === '/api/ride-exploration/month') {
          const { rideExplorationMonth } = await import('./ride-exploration.mjs');
          return json(response, 200, await rideExplorationMonth(workspace.store,
            url.searchParams.get('month'), url.searchParams.get('tz') ?? 'UTC'));
        }
        const explorationId = path.match(/^\/api\/ride\/([a-f0-9]{64})\/exploration$/)?.[1];
        if (explorationId) {
          const { createRideExploration } = await import('./ride-exploration.mjs');
          exploreRide ??= createRideExploration(workspace.store);
          return json(response, 200, await exploreRide(explorationId));
        }
        const rideId = path.match(/^\/api\/ride\/([a-f0-9]{64})$/)?.[1];
        if (rideId) return json(response, 200, await (await import('./tracks.mjs')).processRide({ id: rideId }, workspace));
        if (path === '/api/track-library') return json(response, 200, await trackLibrary(url.searchParams));
        if (path === '/api/workspace') {
          const state = workspace.state();
          if (viewer) {
            state.viewer = viewer;
            state.features = { browserLogin: false, garminAuthorization: false };
            if (diOrigin) state.features.garminDi = true;
          }
          return json(response, 200, state);
        }
        const match = path.match(/^\/api\/(files|keep-fit)\/([a-f0-9]{64})$/);
        const workoutId = path.match(/^\/api\/workouts\/files\/([\w.:-]{1,160})$/)?.[1];
        if (match || workoutId) {
          const file = workoutId ? await workspace.downloadWorkout(workoutId)
            : match[1] === 'keep-fit' ? await workspace.guidedFit(match[2]) : workspace.store.file(match[2]);
          if (!file) throw new RequestError(404, '找不到本机活动文件。');
          const name = encodeURIComponent(file.fileName.toWellFormed()).replace(/['()]/g, char => `%${char.charCodeAt(0).toString(16)}`);
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${name}` });
          return response.end(file.data);
        }
      }
      const importFile = workspace && path === '/api/files/import';
      if (request.method !== 'POST' || !(actions.has(path) || workspaceActions?.has(path) || importFile)) {
        return json(response, 404, { error: '未找到该页面或操作。' });
      }
      if (request.headers.origin !== expectedOrigin) throw new RequestError(403, '请从当前工作台页面执行操作。');
      if (path === '/api/stop') return json(response, 200, workspace.stop());
      const input = importFile ? null : await readInput(request, workspaceActions?.has(path) ? 64 * 1024 : 1024);
      if (busy || workspace?.busy) throw new RequestError(409, '有操作正在执行，请等它结束。');
      busy = true;
      try {
        if (importFile) {
          if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(400, '请选择活动文件。');
          const data = await readBody(request, 50 * 1024 * 1024);
          return json(response, 200, workspace.importFile({ data, fileName: url.searchParams.get('name') }));
        }
        const action = workspaceActions?.get(path);
        json(response, 200, await (action ? action(input) : perform(path, input)));
      } catch (error) {
        if (error?.region === 'cn' || error?.region === 'com') await invalidate(error.region);
        throw error;
      } finally {
        busy = false;
      }
    } catch (error) {
      const status = error?.status;
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        return json(response, status, { error: error.message });
      }
      return json(response, 500, { error: '本机服务执行失败，请重新打开登录窗口后再试。' });
    }
  }
  return { handle, workspace };
}

export function createServer(garmin, workspaceFactory) {
  const { handle, workspace } = createWorkspaceHandler(garmin, workspaceFactory);
  const server = createHttpServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    setResponseHeaders(response);
    const { host } = request.headers;
    const port = request.socket.localPort;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return json(response, 403, { error: '请使用本机地址访问。' });
    }
    const origin = `http://${host}`;
    let url;
    try { url = new URL(request.url, origin); }
    catch { return json(response, 400, { error: '请求地址无效。' }); }
    return handle(request, response, url, origin);
  });
  if (workspace) server.syncWorkspace = workspace;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { GarminBrowser } = await import('./garmin-browser.mjs');
  const { SyncStore } = await import('./sync-store.mjs');
  const { SyncWorkspace } = await import('./sync-workspace.mjs');
  const { PlatformLogin } = await import('./platform-login.mjs');
  const { PlatformPasswords } = await import('./platform-password.mjs');
  const { SessionVault } = await import('./session-vault.mjs');
  const { PLATFORM_DEFINITIONS, PlatformUploads } = await import('./platforms.mjs');
  const { SOURCE_DEFINITIONS, activities, download, historyPage, verify } = await import('./sources.mjs');
  const { COROS_SOURCES, createCorosSources } = await import('./coros-source.mjs');
  const { KEEP_SOURCES, createKeepSources } = await import('./platform-keep.mjs');
  const { CYCITY_SOURCES, createCyCitySources } = await import('./cycity.mjs');
  const coros = createCorosSources();
  const isCoros = id => COROS_SOURCES.some(item => item.id === id);
  const keep = createKeepSources();
  const cycity = createCyCitySources();
  const baseSources = { activities, download, verify };
  const sourceFor = id => id === 'keep' ? keep : id === 'cycity' ? cycity : isCoros(id) ? coros : baseSources;
  const dataRoot = join(process.env.LOCALAPPDATA || homedir(), 'GarminCnTransferWeb');
  await mkdir(dataRoot, { recursive: true });
  const profiles = join(dataRoot, 'workbench-profiles');
  const sessionVault = new SessionVault(join(dataRoot, 'sessions.dpapi'));
  const sessionData = await sessionVault.load();
  let workspace;
  const garmin = new GarminBrowser(profiles, {
    onSessionState: (region, record) => workspace.refreshGarminSession(region, record),
  });
  const store = new SyncStore(join(dataRoot, 'sync.sqlite'));
  const platformUploads = new PlatformUploads();
  const port = Number(process.env.GARMIN_WEB_PORT || '8766');
  const server = createServer(garmin, options => (workspace = new SyncWorkspace({ ...options, garmin, store, sessionVault, sessionData,
    platformLogin: new PlatformLogin(join(profiles, 'platforms')),
    platformPasswords: new PlatformPasswords(),
    uploads: { definitions: PLATFORM_DEFINITIONS, upload: input => platformUploads.upload(input) },
    sources: { definitions: [...SOURCE_DEFINITIONS, ...COROS_SOURCES, ...KEEP_SOURCES, ...CYCITY_SOURCES],
      activities: (id, ...args) => sourceFor(id).activities(id, ...args),
      download: (id, ...args) => sourceFor(id).download(id, ...args),
      historyPage,
      verify: (id, ...args) => sourceFor(id).verify(id, ...args),
    },
  })));
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : '无法启动本机服务。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    server.syncWorkspace.schedule();
    console.log(`运动数据同步网页已启动：http://127.0.0.1:${server.address().port}`);
  });
  async function stop() {
    server.close();
    await server.syncWorkspace.close();
    await garmin.close();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
