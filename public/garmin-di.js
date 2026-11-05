const form = document.querySelector('#garmin-auth-form');
const region = document.querySelector('#garmin-region');
const start = document.querySelector('#garmin-start');
const refresh = document.querySelector('#garmin-refresh');
const status = document.querySelector('#garmin-auth-status');
const frame = document.querySelector('#garmin-login-frame');
const pilot = document.querySelector('#garmin-pilot-form');
const list = document.querySelector('#garmin-list');
const next = document.querySelector('#garmin-next');
const ride = document.querySelector('#garmin-ride');
const file = document.querySelector('#garmin-file');
const transfer = document.querySelector('#garmin-transfer');
const pilotStatus = document.querySelector('#garmin-pilot-status');
const fileLink = document.querySelector('#garmin-file-link');
const activityLink = document.querySelector('#garmin-activity-link');
const portalLogin = typeof window.__sportsSyncGarminPortalLogin === 'function' && window.__sportsSyncGarminPortalLogin;
const localAuthHint = document.querySelector('#garmin-local-auth-hint');
const comService = 'https://connect.garmin.com/app';
let comChromeReady = false;
let pending;
let nextStart = null;

function updateLoginButton() {
  const useChrome = comChromeReady && region.value === 'com';
  start.textContent = useChrome ? '在普通 Chrome 登录国际区' : portalLogin ? '在佳明 Connect 登录' : '打开佳明登录页';
  localAuthHint.hidden = !useChrome && !portalLogin;
}

function isWorkbenchMessage(event) {
  return event.source === window && event.origin === window.location.origin;
}

window.addEventListener('message', event => {
  if (!isWorkbenchMessage(event) || event.data?.type !== 'sports-sync-com-ready') return;
  comChromeReady = true;
  updateLoginButton();
});
window.postMessage({ type: 'sports-sync-com-probe' }, window.location.origin);
updateLoginButton();

function authorizeComInChrome(url, state) {
  return new Promise((resolve, reject) => {
    const origin = window.location.origin;
    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
    }
    function receive(event) {
      if (!isWorkbenchMessage(event) || event.data?.state !== state) return;
      if (event.data.type === 'sports-sync-com-ticket') {
        cleanup();
        resolve({ serviceUrl: comService, serviceTicket: event.data.ticket });
      } else if (event.data.type === 'sports-sync-com-error') {
        cleanup();
        reject(new Error(event.data.message || '国际区授权未完成，请重试。'));
      }
    }
    const timeout = setTimeout(() => {
      cleanup();
      window.postMessage({ type: 'sports-sync-com-cancel', state }, origin);
      reject(new Error('等待国际区授权超时，请重新打开佳明登录。'));
    }, 12 * 60_000);
    window.addEventListener('message', receive);
    window.postMessage({ type: 'sports-sync-com-start', url, state }, origin);
  });
}

function setBusy(busy) {
  for (const control of [region, start, refresh]) control.disabled = busy;
  list.disabled = busy || Boolean(pending);
  next.disabled = list.disabled || nextStart === null;
  ride.disabled = list.disabled || ride.options.length <= 1;
  file.disabled = transfer.disabled = ride.disabled || !ride.value;
}

function closeLogin() {
  pending = undefined;
  frame.hidden = true;
  frame.removeAttribute('src');
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (path === '/api/workspace' && response.status === 401) {
    window.location.assign('/login');
    throw new Error('请登录工作台后再试。');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '佳明请求失败，请稍后重试。');
  return result;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  closeLogin();
  setBusy(true);
  status.textContent = '正在打开佳明登录页…';
  try {
    const selected = region.value;
    if (selected !== 'cn' && selected !== 'com') throw new Error('请选择佳明地区。');
    const origin = `https://sso.garmin.${selected}`;
    const useChrome = comChromeReady && selected === 'com';
    const { url, state, serviceUrl } = await api('/api/garmin-di/start',
      portalLogin || useChrome ? { region: selected, flow: 'portal' } : { region: selected });
    const login = new URL(url);
    if (login.origin !== origin || typeof state !== 'string' || !state) {
      throw new Error('佳明授权地址校验失败。');
    }
    if (portalLogin || useChrome) {
      const service = `https://connect.garmin.${selected}/app`;
      if (login.pathname !== '/portal/sso/en-US/sign-in' || serviceUrl !== service ||
          login.searchParams.get('service') !== service || login.searchParams.get('clientId') !== 'GarminConnect') {
        throw new Error('佳明 Connect 登录地址校验失败。');
      }
      status.textContent = '请在新开的佳明 Connect 页面登录并完成两步验证。授权结果会显示在这里。';
      const payload = useChrome ? await authorizeComInChrome(login.href, state) : await portalLogin(login.href);
      if (!await finishLogin({ region: selected, service, state }, payload)) {
        throw new Error('佳明 Connect 返回的授权结果无效。');
      }
      return;
    }
    const service = `${origin}/sso/embed`;
    if (login.pathname !== '/sso/signin' ||
        login.searchParams.get('service') !== service ||
        login.searchParams.get('source') !== window.location.origin ||
        login.searchParams.get('consumeServiceTicket') !== 'false') {
      throw new Error('佳明授权地址校验失败。');
    }
    pending = { region: selected, origin, service, state };
    frame.src = login.href;
    frame.hidden = false;
    status.textContent = '请完成佳明登录和两步验证。如果登录页空白，请检查浏览器的第三方 Cookie 设置。';
  } catch (error) {
    closeLogin();
    status.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

region.addEventListener('change', () => {
  closeLogin();
  updateLoginButton();
  status.textContent = '请选择打开佳明登录页，或验证已保存令牌的续期。';
  setBusy(false);
});

window.addEventListener('message', async (event) => {
  const attempt = pending;
  if (!attempt || event.origin !== attempt.origin || event.source !== frame.contentWindow) return;
  let payload = event.data;
  try {
    for (let i = 0; i < 2 && typeof payload === 'string'; i++) {
      if (payload.length > 8192) return;
      payload = JSON.parse(payload);
    }
  } catch {
    return;
  }
  await finishLogin(attempt, payload);
});

async function finishLogin(attempt, payload) {
  const ticket = payload?.serviceTicket;
  if (payload?.serviceUrl !== attempt.service || typeof ticket !== 'string' ||
      !/^ST-[A-Za-z0-9_-]{8,509}$/.test(ticket)) return false;

  closeLogin();
  setBusy(true);
  status.textContent = '佳明已返回授权票据，正在验证账号连接…';
  try {
    const result = await api('/api/garmin-di/finish', { region: attempt.region, state: attempt.state, ticket });
    const otherRegion = attempt.region === 'cn' ? '佳明国际' : '佳明中国';
    status.textContent = `${result.message || '佳明授权成功。'} 如尚未连接${otherRegion}，请选择该地区授权。`;
    if (attempt.region === 'cn') resetList();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setBusy(false);
  }
  return true;
}

refresh.addEventListener('click', async () => {
  closeLogin();
  setBusy(true);
  status.textContent = '正在尝试使用已保存的佳明令牌续期…';
  try {
    const result = await api('/api/garmin-di/refresh', { region: region.value });
    status.textContent = result.message || '令牌续期已通过验证。';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

window.addEventListener('pagehide', closeLogin);

function resetList() {
  ride.replaceChildren(new Option('请选择骑行', ''));
  nextStart = null;
  fileLink.hidden = activityLink.hidden = true;
}

async function runPilot(message, action) {
  setBusy(true);
  pilotStatus.textContent = message;
  fileLink.hidden = activityLink.hidden = true;
  try {
    await action();
  } catch (error) {
    pilotStatus.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function loadRides(startAt) {
  if (startAt === 0) resetList();
  const page = await api('/api/list', { source: 'cn', start: startAt });
  const cycling = page.activities.filter(item => /cycling|biking|bmx|cyclocross|virtual_ride|e_bike/i.test(item.type));
  const loaded = new Set([...ride.options].map(option => option.value));
  for (const item of cycling) {
    const id = String(item.id);
    if (loaded.has(id)) continue;
    loaded.add(id);
    const time = item.time ? new Date(item.time) : null;
    const date = time && Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN') : '';
    ride.add(new Option([date, item.name || '骑行', `ID ${id}`].filter(Boolean).join(' · '), id));
  }
  nextStart = page.nextStart;
  pilotStatus.textContent = ride.options.length > 1 ? `已找到 ${ride.options.length - 1} 条骑行，请选择一条。`
    : nextStart === null ? '没有找到骑行记录。' : '已读取的记录里没有骑行，可以加载下一页。';
}

list.addEventListener('click', () => runPilot('正在读取国区活动…', () => loadRides(0)));
next.addEventListener('click', () => runPilot('正在读取下一页…', () => loadRides(nextStart)));
ride.addEventListener('change', () => {
  fileLink.hidden = activityLink.hidden = true;
  setBusy(false);
});

function showFile(fileId) {
  if (!/^[a-f0-9]{64}$/.test(fileId)) return;
  fileLink.href = `/api/files/${fileId}`;
  fileLink.hidden = false;
}

file.addEventListener('click', () => runPilot('正在下载原始 FIT…', async () => {
  const result = await api('/api/file-test', { source: 'cn', id: ride.value });
  showFile(result.fileId);
  pilotStatus.textContent = `原始文件已保存。${result.fileName}`;
}));

pilot.addEventListener('submit', (event) => {
  event.preventDefault();
  if (transfer.disabled) return;
  return runPilot('正在同步并回查国际区活动…', async () => {
    const id = ride.value;
    const initial = await api('/api/run', { source: 'cn', targets: ['com'], ids: [id] });
    for (let attempt = 0; attempt < 120; attempt++) {
      const { run, history } = await api('/api/workspace');
      if (run?.id !== initial.id) throw new Error('这次运行记录已更新，请在工作台查看同步历史。');
      if (run.status !== 'running') {
        const receipt = run.confirmed === 1 && history.find(item => item.source === 'cn' && item.sourceId === id &&
          item.target === 'com' && item.status === 'confirmed' && item.updated >= run.started);
        if (receipt && /^\d+$/.test(receipt.activityId)) {
          activityLink.href = `https://connect.garmin.com/modern/activity/${receipt.activityId}`;
          activityLink.textContent = `查看国际区活动 ${receipt.activityId}`;
          activityLink.hidden = false;
          showFile(receipt.fileId);
          pilotStatus.textContent = `已按国际区活动 ID ${receipt.activityId} 确认。`;
        } else {
          const counts = `已确认 ${run.confirmed} 条，跳过 ${run.skipped} 条。`;
          const log = run.logs.at(-1)?.message;
          pilotStatus.textContent = log ? `${counts} ${log}` : counts;
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    pilotStatus.textContent = '任务仍在运行，请在工作台查看结果。';
  });
});
