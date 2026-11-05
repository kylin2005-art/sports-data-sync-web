import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { isPrivateIpv4 } from '../personal-network.mjs';
import { PlatformLogin } from '../platform-login.mjs';

export function portalService(login) {
  const region = login.hostname === 'sso.garmin.cn' ? 'cn' : login.hostname === 'sso.garmin.com' ? 'com' : '';
  const service = `https://connect.garmin.${region}/app`;
  if (region && login.origin === `https://sso.garmin.${region}` && !login.username && !login.password && !login.hash &&
      login.pathname === '/portal/sso/en-US/sign-in' && login.searchParams.getAll('clientId').length === 1 &&
      login.searchParams.get('clientId') === 'GarminConnect' && login.searchParams.getAll('service').length === 1 &&
      login.searchParams.get('service') === service) return service;
  throw new Error('佳明 Connect 登录地址校验失败。');
}

export function portalTicket(url, service) {
  const tickets = url.searchParams.getAll('ticket');
  const [ticket] = tickets;
  if (!url.username && !url.password && !url.hash && tickets.length === 1 &&
      (url.origin + url.pathname === service || url.origin + url.pathname === `${service}/`) &&
      ticket && /^ST-[A-Za-z0-9_-]{8,509}$/.test(ticket)) return ticket;
}

export async function signInPortal(context, address) {
  const login = new URL(address);
  const serviceUrl = portalService(login);
  const portal = await context.newPage();
  let accept;
  let reject;
  const result = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  let completed = false;
  portal.once('close', () => reject(new Error('佳明登录页已关闭，请重新打开。')));
  const timeout = setTimeout(() => reject(new Error('未收到佳明授权结果。请确认佳明页面是否已完成登录，再重新授权。')), 12 * 60_000);
  try {
    await portal.route(url => Boolean(portalTicket(url, serviceUrl)), async route => {
      const request = route.request();
      const ticket = portalTicket(new URL(request.url()), serviceUrl);
      if (request.method() !== 'GET' || !request.isNavigationRequest() || request.frame() !== portal.mainFrame() ||
          !portal.url().startsWith(`${login.origin}/portal/`) || !ticket) {
        await route.continue();
        return;
      }
      // Reserve the one-use ticket for Unraid before Garmin Connect can redeem it in this tab.
      completed = true;
      try {
        await route.abort();
        accept({ serviceTicket: ticket, serviceUrl });
      } catch {
        reject(new Error('未能接收佳明授权结果，请重新授权。'));
      }
    });
    void portal.goto(login.href, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {
      if (!completed) reject(new Error('佳明 Connect 登录页未打开。请检查网络，或重新授权。'));
    });
    return await result;
  } finally {
    clearTimeout(timeout);
    await portal.close().catch(() => {});
  }
}

export async function bindPlatformLogin(context, page, workbench, platformLogin) {
  let busy = false;
  const binding = action => async (source, platform) => {
    if (source.page !== page || source.frame !== page.mainFrame()) throw new Error('请在工作台平台账号页面发起登录。');
    const caller = new URL(source.frame.url());
    if (caller.origin !== workbench.origin || caller.pathname !== '/' || caller.search || caller.username || caller.password ||
        typeof platform !== 'string' || !platformLogin.supports(platform)) {
      throw new Error('请在工作台平台账号页面选择支持网页登录的平台。');
    }
    if (busy) throw new Error('另一项平台登录操作尚未完成，请稍后重试。');
    busy = true;
    try { return await platformLogin[action](platform); }
    finally { busy = false; }
  };
  await context.exposeBinding('__sportsSyncOpenPlatform', binding('open'));
  await context.exposeBinding('__sportsSyncReadPlatform', binding('credential'));
}

async function main(workbench, address, mode = 'garmin') {
  const url = new URL(workbench);
  if (url.protocol !== 'https:' || url.href !== `${url.origin}/` ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) || !isPrivateIpv4(address) || !['garmin', 'platforms'].includes(mode)) {
    throw new Error('请使用个人工作台的 HTTPS 地址和内网 IPv4。');
  }

  const browser = await chromium.launch({
    channel: 'chrome', headless: false, chromiumSandbox: true,
    args: [`--host-resolver-rules=MAP ${url.hostname} ${address}`],
  });
  let platformLogin;
  let profilePath;
  const temporaryRoot = resolve(tmpdir());
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    if (mode === 'platforms') {
      profilePath = await mkdtemp(join(temporaryRoot, 'sports-sync-platform-'));
      platformLogin = new PlatformLogin(profilePath);
      await bindPlatformLogin(context, page, url, platformLogin);
    } else {
      let authorizing = false;
      await context.exposeBinding('__sportsSyncGarminPortalLogin', async (source, login) => {
        if (source.page !== page || source.frame !== page.mainFrame() ||
            source.frame.url() !== new URL('/garmin-di', url).href || authorizing || typeof login !== 'string') {
          throw new Error('请在工作台佳明授权页发起登录。');
        }
        authorizing = true;
        try { return await signInPortal(context, login); }
        finally { authorizing = false; }
      });
    }
    const closed = new Promise(done => page.once('close', done));
    await page.goto(new URL(mode === 'platforms' ? '/#accounts' : '/garmin-di', url).href, { waitUntil: 'domcontentloaded' });
    await closed;
  } finally {
    await platformLogin?.close();
    if (profilePath && dirname(profilePath) === temporaryRoot && basename(profilePath).startsWith('sports-sync-platform-')) {
      await rm(profilePath, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    }
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv[2], process.argv[3], process.argv[4]); }
  catch {
    console.error('无法打开独立授权窗口。请检查 Chrome 和内网工作台。');
    process.exitCode = 1;
  }
}
