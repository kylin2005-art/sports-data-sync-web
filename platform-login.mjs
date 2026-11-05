import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const sites = {
  igpsport: { url: 'https://login.passport.igpsport.cn/login?lang=zh-Hans', origins: ['https://app.igpsport.cn', 'https://prod.zh.igpsport.com'] },
  igpsport_int: { url: 'https://login.passport.igpsport.com/login', origins: ['https://app.igpsport.com', 'https://app.en.igpsport.com'] },
  xingzhe: { url: 'https://www.imxingzhe.com/login/', origins: ['https://www.imxingzhe.com', 'https://imxingzhe.com'] },
  magene: { url: 'https://otm.onelap.cn/login', origins: ['https://otm.onelap.cn'] },
  blackbird: { url: 'https://www.blackbirdsport.com/login', origins: ['https://www.blackbirdsport.com', 'https://blackbirdsport.com'] },
  bryton: { url: 'https://active.brytonsport.com/', origins: ['https://active.brytonsport.com'] },
  outbase: { url: 'https://outbase.cn/zeusfit/official-website/login.html', origins: ['https://outbase.cn', 'https://www.outbase.cn'] },
  coros_cn: { url: 'https://trainingcn.coros.com/', origins: ['https://trainingcn.coros.com'] },
  coros_int: { url: 'https://training.coros.com/login', origins: ['https://training.coros.com', 'https://trainingeu.coros.com'] },
};

function error(status, message) { return Object.assign(new Error(message), { status }); }

export class PlatformLogin {
  static platforms = Object.freeze(Object.keys(sites));
  #profiles = new Map();

  constructor(root) { this.root = root; }

  supports(id) { return Object.hasOwn(sites, id); }

  async open(id) {
    const spec = this.supports(id) && sites[id];
    if (!spec) throw error(400, '这个平台使用手动配置的授权凭据。');
    let session = this.#profiles.get(id);
    if (!session) {
      const path = join(this.root, id);
      await mkdir(path, { recursive: true, mode: 0o700 });
      let context;
      for (const channel of ['msedge', 'chrome']) {
        try {
          context = await chromium.launchPersistentContext(path, { channel, headless: false, chromiumSandbox: true, viewport: null, timeout: 20_000 });
          break;
        } catch { /* Try the next installed browser. */ }
      }
      if (!context) throw error(503, '无法打开 Edge 或 Chrome，请检查浏览器是否已安装。');
      session = { context, page: context.pages()[0] || await context.newPage() };
      this.#profiles.set(id, session);
      context.on('close', () => { if (this.#profiles.get(id) === session) this.#profiles.delete(id); });
    }
    if (session.page.isClosed()) session.page = await session.context.newPage();
    await session.page.bringToFront();
    try { await session.page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    catch { throw error(504, '平台官网打开超时，请查看浏览器窗口中的网络提示。'); }
    return { message: '在平台官网完成登录后，回到这里点击“检查会话”。' };
  }

  async credential(id) {
    const spec = this.supports(id) && sites[id];
    const session = this.#profiles.get(id);
    const page = session?.page;
    if (!spec || !page || page.isClosed()) throw error(409, '请先打开平台官网并完成登录。');
    const origin = new URL(page.url()).origin;
    if (id === 'igpsport_int' && origin === 'https://app.igpsport.cn') {
      throw error(409, 'iGPSPORT 官网已切换到中国区，请在国际区登录完成后再检查会话。');
    }
    if (!spec.origins.includes(origin)) throw error(409, '请在平台官网完成登录并等待跳转。');
    let credential;
    try {
      if (id === 'igpsport' || id === 'igpsport_int' || id === 'magene') {
        credential = await page.evaluate(({ id, origin }) => {
          if (location.origin !== origin) return null;
          if (id === 'magene') return { token: localStorage.getItem('token') };
          if (id === 'igpsport_int') return { token: localStorage.getItem('IGSTOKEN')?.replace(/^Bearer\s+/i, '') };
          const stored = JSON.parse(localStorage.getItem('persist:app-store') || '{}').global;
          const global = typeof stored === 'string' ? JSON.parse(stored) : stored;
          return { token: typeof global?.token === 'string' ? global.token.replace(/^Bearer\s+/i, '') : null };
        }, { id, origin });
      } else {
        const cookies = await session.context.cookies(id === 'bryton' ? `${origin}/api/activity/list` : spec.origins);
        const pick = key => cookies.find(cookie => cookie.name.toLowerCase() === key.toLowerCase())?.value;
        if (id === 'xingzhe') credential = { sessionId: pick('sessionid'), csrfToken: pick('csrftoken') };
        if (id === 'outbase') credential = { sessionId: pick('sessionId') || pick('session_id') };
        if (id === 'bryton') credential = { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
        if (id.startsWith('coros_')) credential = { token: pick('CPL-coros-token'),
          region: id === 'coros_cn' ? '2' : pick('CPL-coros-region') || (origin.includes('trainingeu') ? '3' : '1') };
        if (id === 'blackbird' && pick('JSESSIONID')) {
          const signedIn = await page.evaluate(async expected => {
            if (location.origin !== expected) return false;
            const response = await fetch('/api/user', { credentials: 'include', cache: 'no-store', redirect: 'error',
              signal: AbortSignal.timeout(12_000) });
            if (!response.ok) return false;
            const result = await response.json();
            const user = result?.content || result?.data;
            return result?.status === 'ok' && Boolean(user?.nickname || user?.userName);
          }, origin);
          if (signedIn) credential = { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
        }
      }
    } catch { throw error(502, '无法验证平台官网会话，请确认页面已加载完成。'); }
    const key = ['blackbird', 'bryton'].includes(id) ? 'cookie' : ['xingzhe', 'outbase'].includes(id) ? 'sessionId' : 'token';
    if (typeof credential?.[key] !== 'string' || credential[key].length <= 10) {
      throw error(409, '还没有读到有效会话，请先完成平台官网登录。');
    }
    return credential;
  }

  async close() {
    const sessions = [...this.#profiles.values()];
    this.#profiles.clear();
    await Promise.allSettled(sessions.map(session => session.context.close()));
  }
}
