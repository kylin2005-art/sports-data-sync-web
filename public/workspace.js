'use strict';

const byId = id => document.getElementById(id);
const tabs = ['sync', 'accounts', 'jobs', 'records', 'tracks'];
const statusNames = {
  sending: '等待确认', accepted: '平台已接收', unconfirmed: '待核对', confirmed: '已确认',
  duplicate: '平台判定重复', guided: '待手动导入', failed: '失败', released: '允许重试',
};
const connectionNames = { ready: '可用', saved: '已保存', verified: '已验证', configured: '已配置', disconnected: '待连接', expired: '需重新连接' };
const checkNames = { valid: '登录有效', unknown: '暂无法核验', unsupported: '使用时校验' };
const platformGuides = {
  igpsport: { note: '使用 iGPSPORT 中国区账号。已有中国区登录 Token 时，也可手动配置。' },
  igpsport_int: { note: '使用 iGPSPORT 国际区账号。若官网自动跳到中国区，先确认留在国际站，再检查会话。' },
  xingzhe: { note: '网页登录会读取行者会话。手动配置时填写 sessionid 的值，上传需要时补充 CSRF Token。' },
  magene: { note: '使用迈金账号或手机号，或通过网页登录顽鹿 OTM。' },
  blackbird: { note: '使用黑鸟单车网页账号。手动配置时填写该网站的完整 Cookie。' },
  bryton: { note: '登录 Bryton Active 国际站。支持读取运动记录。推送计划课表需要官网会话包含课表访问权限。' },
  giant: { note: '使用捷安特「骑行生活」账号和密码。本工作台可向它上传 FIT。' },
  outbase: { note: '在 Outbase 官网输入手机号和短信验证码，再回工作台检查会话。本工作台可向它上传 FIT。' },
  coros_cn: { note: '使用高驰中国区手机号或邮箱。遇到额外验证时，通过中国区训练中心网页登录。' },
  coros_int: { note: '使用国际区邮箱。全球区域填 1，欧洲区域填 3。遇到额外验证时，通过对应区域的训练中心网页登录。' },
  wahoo: { note: '按官方开发者文档完成 OAuth 授权后填入 Access Token。授权需含 user_read，读取加 workouts_read，上传加 workouts_write。令牌过期后更换。',
    link: ['Wahoo 授权文档', 'https://cloud-api.wahooligan.com/#authorization'] },
  intervals_icu: { note: '在 Intervals.icu 设置底部的 Developer Settings 生成个人 API Key，再回工作台保存。',
    link: ['Intervals.icu 设置', 'https://intervals.icu/settings'] },
  keep: { note: '读取骑行用手机号和密码连接。作为目标时，从「记录中心」下载准备好的 FIT，再到手机 Keep App 手动导入。' },
  komoot: { note: '使用 Komoot 邮箱和密码登录。手动配置时使用同一邮箱和已有登录 Token。' },
  suunto: { note: '在 Suunto API Zone 订阅 Developer API 并完成 OAuth 授权，再填入 Access Token 和 Subscription Key。令牌过期后更换。',
    link: ['Suunto 开发者接入指南', 'https://apizone.suunto.com/how-to-start'] },
  mywhoosh: { note: '使用 MyWhoosh 账号和密码。手动配置需 Token 和 Whoosh ID。会话失效后重新登录。' },
  zwift: { note: '使用 Zwift 账号和密码。只读取本账号有权下载的活动，会话失效后重新登录。' },
  cycity: { note: '使用骑行市注册手机号和密码。已有该账号的 Token 时，也可手动配置。' },
};
const unconnectedGuides = {
  codoon: '当前没有直连接入。若已取得 FIT 或 GPX，可从本机文件导入。',
  zepp: '当前没有直连接入。可在 Intervals.icu 授权 Amazfit，再把 Intervals.icu 设为来源。',
};
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const model = {
  platforms: [], jobs: [], history: [], files: [], run: null, source: 'cn', targets: new Set(['com']),
  activities: [], selected: new Set(), next: null, loaded: false, working: false,
  credential: null, jobId: null, tracks: new Set(), ride: null, viewer: null, features: {}, workoutTargets: [],
};
const trackLibrary = { page: null, start: 0, loading: false, retryStart: 0, sort: 'startTime', direction: -1 };
let monthlyRide = null;
const trackDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const trackColumns = [
  ['durationSeconds', rideDuration], ['distanceM', value => (value / 1000).toFixed(2)],
  ['avgPowerW', Math.round], ['avgHeartRateBpm', Math.round],
  ['avgSpeedMps', value => (value * 3.6).toFixed(1)], ['ascentM', Math.round],
];
let syncing = false;
let recording = null;
let workspaceOnline;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, handler, kind = 'secondary') {
  const node = element('button', `button button-${kind}`, text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function link(text, href, kind = 'secondary') {
  const node = element('a', `button button-${kind}`, text);
  node.href = href;
  if (/^https:\/\//.test(href)) { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
  return node;
}

function fileLink(id, text = '下载') { return link(text, `/api/files/${id}`); }
const platform = id => model.platforms.find(item => item.id === id);
const label = id => platform(id)?.name || id;
const connected = id => Boolean(platform(id) && !['disconnected', 'expired'].includes(platform(id).state));
const targetReady = id => Boolean(platform(id)?.guided || connected(id));
const garminAvailable = () => model.features.garminDi === true || model.features.garminAuthorization !== false;
const usablePlatform = item => item.auth !== 'garmin' || garminAvailable();
const running = () => model.run?.status === 'running';

function publishOverview() {
  const platforms = model.platforms.filter(item => item.id !== 'local' && (item.source || item.target) && usablePlatform(item));
  const run = model.run;
  const detail = {
    online: workspaceOnline,
    viewer: model.viewer,
    features: model.features,
    platforms: model.platforms.length ? platforms.length : undefined,
    connected: model.platforms.length ? platforms.filter(item => connected(item.id)).length : undefined,
    selected: model.selected.size,
    activityCount: model.loaded ? model.activities.length : null,
    run: run && {
      status: run.status, confirmed: run.confirmed, skipped: run.skipped, unconfirmed: run.unconfirmed, guided: run.guided, failed: run.failed,
    },
  };
  window.sportsSyncOverview = detail;
  window.dispatchEvent(new CustomEvent('sports-sync:overview', { detail }));
}

function notice(text, kind = 'info') {
  const node = byId('notice');
  node.textContent = text || '';
  node.className = `notice ${kind}`;
  node.hidden = !text;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (path === '/api/workspace' && response.status === 401) {
    location.replace('/login');
    throw new Error('登录已过期，请重新登录。');
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('工作台服务没有返回有效结果。'); }
  if (!response.ok) throw Object.assign(new Error(result.error || `请求未完成（HTTP ${response.status}）。`), { status: response.status });
  return result;
}

async function perform(action) {
  if (model.working) return;
  model.working = true;
  renderControls();
  notice('');
  try { await action(); }
  catch (error) {
    notice(error instanceof TypeError ? '无法连接工作台服务。' : error.message, 'error');
    await refresh().catch(() => {});
  } finally {
    model.working = false;
    renderControls();
  }
}

function showTab() {
  const hash = location.hash.slice(1);
  const current = tabs.includes(hash) ? hash : 'sync';
  if (current !== 'tracks' && byId('ride-terrain-dialog').open) byId('ride-terrain-dialog').close();
  if (current !== 'tracks' && monthlyRide) clearMonthlyRide();
  document.querySelectorAll('[data-panel]').forEach(node => { node.hidden = node.dataset.panel !== current; });
  document.querySelectorAll('[data-tab]').forEach(node => {
    if (node.dataset.tab === current) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (current === 'tracks' && !trackLibrary.page) loadTrackLibrary();
}

function renderSelect(select, selected) {
  const options = model.platforms.filter(item => item.source && usablePlatform(item));
  select.replaceChildren(...options.map(item => {
    const option = element('option', '', item.name);
    option.value = item.id;
    return option;
  }));
  select.value = options.some(item => item.id === selected) ? selected : (options[0]?.id || '');
}

function renderChoices(container, source, selected, connectedOnly) {
  const targets = model.platforms.filter(item => item.target && item.id !== source && usablePlatform(item) &&
    (!connectedOnly || connected(item.id)));
  const savedTargets = connectedOnly ? [] : model.jobs.find(job => job.id === model.jobId)?.targets || [];
  if (connectedOnly) {
    const available = new Set(targets.map(item => item.id));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
  }
  container.replaceChildren(...targets.map(item => {
    const choice = element('label', 'choice');
    const input = element('input');
    input.type = 'checkbox';
    input.value = item.id;
    const offline = !connected(item.id);
    input.checked = selected.has(item.id) && (!offline || savedTargets.includes(item.id));
    input.disabled = offline && !input.checked;
    input.addEventListener('change', () => {
      if (container.id === 'targets') {
        if (input.checked) model.targets.add(item.id);
        else model.targets.delete(item.id);
        renderControls();
      } else if (offline) input.disabled = !input.checked;
    });
    const text = offline ? `${item.name} · ${connectionNames[item.state]}` : item.guided ? `${item.name} · 手动导入` : item.name;
    choice.append(input, document.createTextNode(text));
    return choice;
  }));
  if (connectedOnly && !targets.length) container.append(element('p', 'muted', '暂无可用目标，请先到平台账号连接。'));
}

function renderControls() {
  const busy = model.working || running();
  byId('source').disabled = busy || !model.platforms.length;
  byId('load').disabled = busy || !connected(model.source);
  byId('load').textContent = model.loaded ? '刷新最近 20 条' : '读取最近 20 条';
  byId('next').disabled = busy || !connected(model.source);
  byId('next').hidden = model.next === null;
  byId('select-all').disabled = busy || !model.activities.length;
  byId('activity-fieldset').disabled = busy || !connected(model.source);
  byId('download-test').disabled = busy || model.selected.size !== 1 || !connected(model.source);
  byId('run').disabled = busy || !connected(model.source) || model.selected.size === 0 || model.targets.size === 0 ||
    [...model.targets].some(id => !targetReady(id));
  document.querySelectorAll('[data-job-sync]').forEach(node => { node.disabled = busy || node.dataset.jobSync === 'blocked'; });
  byId('setup-full-ride').disabled = busy || !platform(model.source)?.source;
  byId('selected-count').textContent = `已选 ${model.selected.size} 条`;
  byId('source-status').textContent = connected(model.source) ? connectionNames[platform(model.source).state] : '先到平台账号连接此来源。';
  byId('stop').hidden = !running();
  byId('stop').disabled = model.run?.stopRequested === true;
  byId('analyze-ride').disabled = model.working || model.tracks.size !== 1;
  byId('compare-ride').disabled = model.working || model.tracks.size !== 2;
  byId('draw-track').disabled = model.working || !model.tracks.size;
  byId('merge-track').disabled = model.working || model.tracks.size < 2;
  byId('track-selection').textContent = `已选 ${model.tracks.size} 条`;
  byId('track-clear').hidden = !model.tracks.size;
  document.querySelectorAll('[data-open-ride]').forEach(button => { button.disabled = model.working; });
  publishOverview();
}

function recordRow(name, meta, actions = []) {
  const row = element('div', 'record');
  const content = element('div', 'record-main');
  content.append(element('strong', '', name), element('p', 'record-meta', meta));
  row.append(content);
  if (actions.length) {
    const group = element('div', 'record-actions');
    group.append(...actions);
    row.append(group);
  }
  return row;
}

function renderActivities() {
  byId('activities').replaceChildren(...model.activities.map(item => {
    const distance = typeof item.distance === 'number' ? `${(item.distance / 1000).toFixed(2)} km` : '距离未知';
    const duration = typeof item.duration === 'number' ? `${Math.round(item.duration / 60)} 分钟` : '时长未知';
    const row = recordRow(item.name, `${formatTime(item.time)} · ${distance} · ${duration}`);
    const check = element('input');
    check.type = 'checkbox';
    check.checked = model.selected.has(item.id);
    check.setAttribute('aria-label', `选择 ${item.name}`);
    check.addEventListener('change', () => {
      if (!check.checked) model.selected.delete(item.id);
      else if (model.selected.size < 50) model.selected.add(item.id);
      else { check.checked = false; notice('每次最多同步 50 条活动。'); }
      renderControls();
    });
    row.prepend(check);
    return row;
  }));
  byId('activity-empty').hidden = model.activities.length > 0;
  byId('activity-empty').textContent = model.loaded
    ? (model.next === null ? '来源返回了空活动列表。' : '这一页没有已完成的活动，可继续读取下一页。')
    : '读取活动后可选择 1–50 条。';
  renderControls();
}

function clearActivities() {
  model.activities = [];
  model.selected.clear();
  model.next = null;
  model.loaded = false;
  renderActivities();
}

function useSource(id) {
  model.source = id;
  model.targets.delete(id);
  byId('source').value = id;
  clearActivities();
  renderChoices(byId('targets'), id, model.targets, true);
}

async function load(append) {
  const result = await api('/api/list', { source: model.source, start: append ? model.next : 0 });
  const merged = append ? [...model.activities, ...result.activities] : result.activities;
  model.activities = [...new Map(merged.map(item => [item.id, item])).values()];
  if (!append) model.selected.clear();
  model.next = result.nextStart;
  model.loaded = true;
  renderActivities();
}

function credentialDialog(item, signIn = false) {
  model.credential = { id: item.id, signIn };
  byId('credential-title').textContent = signIn ? `登录 ${item.name}` : `连接 ${item.name}`;
  byId('credential-note').textContent = signIn ? '使用平台账号登录。工作台只保存平台签发的连接凭据。' :
    item.note || (model.viewer ? '连接凭据加密保存在你的工作区。' : '连接凭据加密保存在本机。');
  byId('credential-form').querySelector('[type=submit]').textContent = signIn ? '登录并连接' : '保存连接';
  byId('credential-error').hidden = true;
  const fields = signIn ? item.signInFields : item.fields;
  byId('credential-fields').replaceChildren(...fields.map(field => {
    const container = element('label', 'field', field.label);
    const input = element('input');
    input.type = field.type || 'password';
    input.name = field.key;
    input.required = !!field.required;
    input.autocomplete = 'off';
    input.maxLength = signIn ? 512 : 16000;
    container.append(input);
    return container;
  }));
  byId('credential-dialog').showModal();
}

function accountAction(path, region) {
  return perform(async () => {
    const result = await api(path, { region });
    if (model.source === region) clearActivities();
    await refresh(true);
    notice(result.message, 'success');
  });
}

function connectionGuide(item, { canOpenBrowser, garminAuthorization, open }) {
  const guide = element('details', 'connection-guide');
  guide.dataset.platform = item.id;
  guide.open = open;
  guide.append(element('summary', '', '接入说明'));
  const steps = [];
  const info = platformGuides[item.id];
  if (item.auth === 'garmin') {
    if (model.features.garminDi) {
      steps.push(`点「授权佳明账号」，选择「${item.name}」，在佳明页面登录并按提示完成两步验证。`,
        '回到授权页确认「已保存」。如果官网登录卡住，可按使用说明在 Windows 打开独立授权窗口。');
    } else if (garminAuthorization) {
      steps.push('点「打开官方登录」，在佳明页面完成登录和验证。', '回到工作台点「验证登录」。');
    } else {
      steps.push('此工作区尚未开放佳明授权。');
    }
  } else {
    if (info?.note) guide.append(element('p', '', info.note));
    if (item.signInFields?.length) {
      const fields = item.signInFields.filter(field => field.required).map(field => field.label).join('、');
      steps.push(`点「账号登录」，填写${fields}，再点「登录并连接」。`);
    }
    if (canOpenBrowser) {
      steps.push('点「打开平台官网」，登录并完成所需验证，再回到本页点「检查会话」。');
    } else if (item.browserImport) {
      steps.push('按使用说明在 Windows 打开平台授权窗口，再点「打开平台官网」。登录后回到本页点「检查会话」。');
    }
    if (item.fields.length) {
      const fields = item.fields.filter(field => field.required).map(field => field.label).join('、');
      steps.push(`已有凭据时，点「配置凭据」或「更换凭据」，填写${fields}并保存。`);
    }
  }
  const list = element('ol');
  list.append(...steps.map(step => element('li', '', step)));
  guide.append(list);
  if (info?.link) guide.append(link(...info.link, 'quiet'));
  return guide;
}

function renderAccounts() {
  const specs = model.platforms.filter(item => item.id !== 'local' && (item.source || item.target));
  const browserLogin = model.features.browserLogin ?? !model.viewer;
  const localBrowser = typeof window.__sportsSyncOpenPlatform === 'function' && typeof window.__sportsSyncReadPlatform === 'function';
  const garminAuthorization = model.features.garminAuthorization ?? !model.viewer;
  const openGuides = new Set([...byId('accounts').querySelectorAll('.connection-guide[open]')].map(guide => guide.dataset.platform));
  byId('accounts').replaceChildren(...specs.map(item => {
    const card = element('article', 'panel platform-card');
    const head = element('div', 'panel-top');
    const isConnected = connected(item.id);
    const check = checkNames[item.check];
    head.append(element('h2', '', item.name), element('span', `session-status${isConnected ? ' ready' : ''}`,
      check ? `${connectionNames[item.state]} · ${check}` : connectionNames[item.state]));
    const actions = element('div', 'action-row');
    const useLocalHelper = localBrowser && item.browserImport;
    const canOpenBrowser = useLocalHelper || (browserLogin && item.browserLogin);
    if (item.auth === 'garmin') {
      if (model.features.garminDi) {
        actions.append(link('授权佳明账号', '/garmin-di'));
      } else if (garminAuthorization) {
        actions.append(button('打开官方登录 ↗', () => accountAction('/api/login', item.id)),
          button('验证登录', () => accountAction('/api/verify', item.id), 'quiet'));
      } else {
        actions.append(element('p', 'muted', '服务器版佳明授权暂未开放。'));
      }
    } else {
      if (canOpenBrowser) {
        const doLogin = path => perform(async () => {
          let result;
          if (!useLocalHelper) result = await api(`/api/account/${path}`, { platform: item.id });
          else if (path === 'open') result = await window.__sportsSyncOpenPlatform(item.id);
          else {
            const credential = await window.__sportsSyncReadPlatform(item.id);
            result = await api('/api/account/browser-connect', { platform: item.id, credential });
          }
          if (model.source === item.id) clearActivities();
          await refresh(true);
          notice(result.message, 'success');
        });
        actions.append(button('打开平台官网 ↗', () => doLogin('open')), button('检查会话', () => doLogin('verify'), 'quiet'));
      }
      const canSignIn = item.signInFields?.length > 0;
      if (canSignIn) actions.append(button('账号登录', () => credentialDialog(item, true)));
      actions.append(button(isConnected ? '更换凭据' : '配置凭据', () => credentialDialog(item),
        canOpenBrowser || canSignIn ? 'quiet' : 'secondary'));
    }
    if (isConnected || item.state === 'expired') actions.append(button('断开', () => perform(async () => {
      await api('/api/disconnect', { platform: item.id });
      if (model.source === item.id) clearActivities();
      await refresh(true);
    }), 'quiet'));
    card.append(head, element('p', 'muted', [item.source && '读取', item.target && (item.guided ? '引导导入' : '上传')].filter(Boolean).join(' · ')), actions);
    card.append(connectionGuide(item, { canOpenBrowser, garminAuthorization, open: openGuides.has(item.id) }));
    return card;
  }));
  byId('coverage').replaceChildren(...model.platforms.filter(item => item.id !== 'local').map(item => {
    const directions = [item.upstreamSource && (item.source ? '读取已接入' : '读取待移植'),
      item.upstreamTarget && (item.guided ? '手动导入' : item.target ? '上传已接入' : '上传待移植')].filter(Boolean);
    const row = element('p', '', `${item.name} · ${directions.join(' · ')}`);
    if (unconnectedGuides[item.id]) row.append(element('small', 'coverage-note', unconnectedGuides[item.id]));
    return row;
  }));
}

function editJob(job) {
  model.jobId = job?.id || null;
  byId('job-title').textContent = job ? '编辑任务' : '新建任务';
  byId('job-reset').hidden = !job;
  byId('job-name').value = job?.name || '';
  renderSelect(byId('job-source'), job?.source || model.source);
  renderChoices(byId('job-targets'), byId('job-source').value, new Set(job?.targets || model.targets), false);
  byId('job-mode').value = job ? job.mode || 'recent' : 'all';
  byId('job-activity-type').value = job?.activityType || 'all';
  byId('job-limit').value = job?.limit || 20;
  byId('job-skip').value = job?.skip || 0;
  byId('job-interval').value = job?.interval || 0;
  renderJobMode();
}

function renderJobMode() {
  const recent = byId('job-mode').value === 'recent';
  const activityType = byId('job-activity-type');
  activityType.disabled = recent;
  activityType.parentElement.hidden = recent;
  for (const id of ['job-limit', 'job-skip']) {
    const input = byId(id);
    input.disabled = !recent;
    input.parentElement.hidden = !recent;
  }
  byId('job-mode-help').textContent = recent ? '每次只检查指定范围，已有回执的活动会跳过。'
    : `首次逐页读取来源历史。以后只传新增活动和明确失败的记录。${activityType.value === 'cycling' ? '仅发送来源已标注的骑行，类型不明的活动会单独计数。' : ''}`;
}

function checked(container) { return [...byId(container).querySelectorAll('input:checked')].map(node => node.value); }

function startRun(input) {
  return perform(async () => {
    model.run = await api('/api/run', input);
    renderRun();
    byId('run-panel').scrollIntoView({ block: 'nearest' });
    await refresh();
  });
}

function renderJobs() {
  byId('job-list').replaceChildren(...model.jobs.map(job => {
    const path = `${label(job.source)} → ${job.targets.map(label).join('、')}`;
    const sourceReady = connected(job.source);
    const missing = job.targets.filter(id => !targetReady(id));
    const canSync = sourceReady && missing.length < job.targets.length;
    if (!sourceReady) missing.unshift(job.source);
    const timing = missing.length ? `等待连接 ${missing.map(label).join('、')}`
      : job.interval ? `每 ${job.interval} 分钟 · 下次 ${formatTime(job.nextRun)}` : '仅手动';
    const scope = job.mode === 'all' ? (job.historyScannedAt ? '增量同步' : '待首次全量') : `${job.limit} 条 · 跳过 ${job.skip} 条`;
    const connectedOnly = canSync && missing.length > 0;
    const sync = button(connectedOnly ? '同步已连接目标' : '立即同步', () => startRun({ jobId: job.id, connectedOnly }), 'primary');
    sync.dataset.jobSync = canSync ? 'ready' : 'blocked';
    return recordRow(job.name, `${path} · ${scope}${job.activityType === 'cycling' ? ' · 仅骑行' : ''} · ${timing}`, [
      sync, ...(missing.length ? [link('连接账号', '#accounts', 'quiet')] : []),
      button('编辑', () => editJob(job), 'quiet'),
      button('移除', () => perform(async () => {
        if (!confirm(`移除任务“${job.name}”？`)) return;
        await api('/api/jobs/delete', { id: job.id });
        if (model.jobId === job.id) editJob();
        await refresh();
      }), 'quiet'),
    ]);
  }));
  if (!model.jobs.length) byId('job-list').append(element('p', 'empty', '还没有保存同步任务。'));
}

function renderWorkoutList(workouts, range) {
  byId('workout-list').replaceChildren(...workouts.map(workout => {
    const actions = [link('下载课表 FIT', `/api/workouts/files/${encodeURIComponent(workout.id)}`)];
    for (const id of model.workoutTargets.filter(connected)) {
      actions.push(button(`推送到 ${label(id)}`, () => perform(async () => {
        const result = await api('/api/workouts/publish', { ...range, id: workout.id, platform: id });
        notice(result.message || '课表已处理。', result.status === 'confirmed' ? 'success' : 'info');
      }), 'quiet'));
    }
    return recordRow(workout.name, `${workout.startLocal.replace('T', ' ')} · ${workout.type || '训练'}`, actions);
  }));
  if (!workouts.length) byId('workout-list').append(element('p', 'empty', '这段日期没有已计划的训练。'));
}

function renderFiles() {
  const keyword = byId('file-filter').value.trim().toLowerCase();
  const files = model.files.filter(file => `${file.name} ${file.fileName}`.toLowerCase().includes(keyword));
  byId('file-list').replaceChildren(...files.map(file => {
    const analyze = button('分析 / 战报', () => openRide(file.id), 'quiet');
    analyze.dataset.openRide = '';
    analyze.disabled = model.working;
    return recordRow(file.name, `${file.fileName} · ${formatTime(file.time)} · ${Math.ceil(file.size / 1024)} KB`,
      [analyze, fileLink(file.id)]);
  }));
  if (!files.length) byId('file-list').append(element('p', 'empty', keyword ? '没有匹配的本机文件。' : '同步下载的文件会在这里显示。'));
}

function renderTrackRows() {
  const { page, sort, direction } = trackLibrary;
  const value = file => sort === 'startTime' ? Date.parse(file.startTime) : file.metrics?.[sort];
  const files = [...(page?.files || [])].sort((left, right) => {
    const a = value(left), b = value(right);
    if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : 0;
    return Number.isFinite(b) ? (a - b) * direction : -1;
  });
  document.querySelectorAll('[data-track-sort]').forEach(button => {
    const heading = button.parentElement;
    if (button.dataset.trackSort === sort) heading.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
    else heading.removeAttribute('aria-sort');
  });
  byId('track-files').replaceChildren(...files.map(file => {
    const row = element('tr');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = model.tracks.has(file.id);
    input.setAttribute('aria-label', `选用轨迹 ${file.name}`);
    input.addEventListener('change', () => {
      if (!input.checked) model.tracks.delete(file.id);
      else if (model.tracks.size < 10) model.tracks.add(file.id);
      else { input.checked = false; notice('一次最多处理 10 个文件。'); }
      if (model.ride && (model.tracks.size !== 1 || !model.tracks.has(model.ride.id))) clearRide();
      byId('ride-compare').hidden = true;
      renderControls();
    });
    const selection = element('td');
    selection.append(input);
    const name = element('th', 'track-name', file.name);
    name.scope = 'row';
    name.title = file.fileName;
    const date = Date.parse(file.startTime);
    row.append(selection, name, Number.isFinite(date)
      ? element('td', '', trackDate.format(date)) : element('td', 'track-missing', '—'));
    for (const [key, format] of trackColumns) {
      const metric = file.metrics?.[key];
      const estimated = file.estimated?.includes(key);
      const durationNote = key === 'durationSeconds' && file.metrics?.durationKind === 'elapsed' ? ' · 经过' : '';
      row.append(Number.isFinite(metric) ? element('td', '', `${estimated ? '≈ ' : ''}${format(metric)}${durationNote}`)
        : element('td', 'track-missing', '—'));
    }
    return row;
  }));
}

async function loadTrackLibrary(start = trackLibrary.start) {
  if (trackLibrary.loading) return;
  trackLibrary.loading = true;
  trackLibrary.retryStart = start;
  const status = byId('track-library-status');
  const prev = byId('track-prev'), next = byId('track-next'), retry = byId('track-retry');
  prev.disabled = next.disabled = true;
  retry.hidden = true;
  status.textContent = '正在读取轨迹…';
  try {
    const page = await api(`/api/track-library?start=${start}`);
    trackLibrary.page = page;
    trackLibrary.start = start;
    renderTrackRows();
    status.textContent = page.files.length ? `第 ${start + 1}–${start + page.files.length} 条 · 共 ${page.total} 条`
      : '先在记录中心导入或下载活动文件。';
  } catch (error) {
    status.textContent = error instanceof TypeError ? '无法连接工作台服务，请重试。' : error.message;
    retry.hidden = false;
  } finally {
    trackLibrary.loading = false;
    prev.disabled = trackLibrary.start === 0;
    next.disabled = trackLibrary.page?.nextStart == null;
  }
}

function renderHistory() {
  byId('history').replaceChildren(...model.history.map(entry => {
    const actions = [];
    if (entry.status === 'guided') actions.push(link('下载 Keep 导入 FIT', `/api/keep-fit/${entry.id}`));
    if (entry.fileId) actions.push(fileLink(entry.fileId, '原文件'));
    if (typeof entry.url === 'string' && entry.url.startsWith('https://')) actions.push(link('目标记录 ↗', entry.url, 'quiet'));
    if (['sending', 'accepted', 'unconfirmed'].includes(entry.status)) {
      if (entry.activityId && ['cn', 'com'].includes(entry.target)) {
        actions.push(button('回查目标记录', () => perform(async () => {
          const result = await api('/api/history/confirm', { id: entry.id });
          await refresh();
          notice(result.message, 'success');
        })));
      }
      actions.push(button('核对后允许重试', () => perform(async () => {
        if (!confirm('请先在目标平台核对。确定要允许这条记录再次上传吗？')) return;
        await api('/api/history/release', { id: entry.id });
        await refresh();
      }), 'quiet'));
    }
    const meta = `${label(entry.source)} → ${label(entry.target)} · ${statusNames[entry.status]} · ${entry.message || ''} · ${formatTime(entry.updated)}`;
    return recordRow(entry.name, meta, actions);
  }));
  if (!model.history.length) byId('history').append(element('p', 'empty', '同步结果会按活动和目标保存在这里。'));
}

function renderRunHelp(run) {
  const issue = run.issue;
  const stages = { list: '读取活动列表', download: '下载原始文件', upload: '准备或上传文件', confirm: '回查目标记录', storage: '保存到工作台', sync: '执行同步' };
  const parts = [];
  if (issue) {
    const where = [issue.platform && label(issue.platform), stages[issue.stage]].filter(Boolean).join(' · ');
    parts.push(`最近故障 · ${where}。${issue.message}`);
    if (issue.status === 401) parts.push('请重新连接该平台，再运行任务。');
    else if (issue.status === 403) parts.push('请检查该平台的账号权限，或在官网完成安全验证。');
    else if (issue.status === 429) parts.push('平台限制请求频率。请稍后再试，避免连续点击重跑。');
    else if (issue.stage === 'download' && issue.status === 406) parts.push('请到来源平台试下载一条原始 FIT，确认能下载后再继续批量同步。');
  }
  if (run.unconfirmed > 0) parts.push('有记录仍待核对。请先在目标平台确认是否已收到，再决定是否允许重传。');
  const help = byId('run-help');
  help.hidden = !parts.length;
  const guidance = byId('run-guidance');
  const text = parts.join(' ');
  if (guidance.textContent !== text) guidance.textContent = text;
  byId('run-help-accounts').hidden = ![401, 403].includes(issue?.status);
  byId('run-help-records').hidden = !(run.unconfirmed > 0);
  byId('run-help-actions').hidden = byId('run-help-accounts').hidden && byId('run-help-records').hidden;
}

function renderRun() {
  const run = model.run;
  byId('run-panel').hidden = !run;
  if (run) {
    const status = { running: '运行中', finished: run.failed ? '已结束，有失败' : '已结束', stopped: '已停止', failed: '任务失败' }[run.status];
    const coverage = Number.isSafeInteger(run.scanned) ? ` · 扫描 ${run.scanned} 条${run.activityType === 'cycling' ? ` · 骑行 ${run.matched} 条 · 类型不明 ${run.unclassified} 条` : ''}` : '';
    byId('run-summary').textContent = `${run.name} · ${status}${coverage} · 确认 ${run.confirmed} · 跳过 ${run.skipped} · 待核对 ${run.unconfirmed}${run.guided ? ` · 待手动导入 ${run.guided}` : ''} · 失败 ${run.failed}`;
    renderRunHelp(run);
    const log = byId('run-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 15;
    const logLabels = { success: '成功', error: '错误', pending: '待核对' };
    log.replaceChildren(...run.logs.map(item => {
      const line = element('li', '', `${formatTime(item.time)}  `);
      line.dataset.level = item.level;
      if (Object.hasOwn(logLabels, item.level)) line.append(element('strong', 'log-level', logLabels[item.level]));
      line.append(item.message);
      return line;
    }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  renderControls();
}

async function refresh(force = false) {
  let state;
  try {
    state = await api('/api/workspace');
    workspaceOnline = true;
  } catch (error) {
    workspaceOnline = false;
    publishOverview();
    throw error;
  }
  if (model.viewer && state.viewer?.username !== model.viewer.username) {
    location.reload();
    return;
  }
  model.viewer = state.viewer || null;
  model.features = state.features || {};
  model.workoutTargets = state.workoutTargets || [];
  byId('garmin-preset').hidden = !garminAvailable();
  if (model.viewer) byId('workspace-footer-label').textContent = model.viewer.personal
    ? '运动数据同步 · 个人工作区' : '运动数据同步 · 邀请制工作区';
  const update = key => force || JSON.stringify(state[key]) !== JSON.stringify(model[key]);
  const platformsChanged = update('platforms');
  if (platformsChanged) {
    const initial = !model.platforms.length;
    model.platforms = state.platforms;
    if (initial && !garminAvailable()) {
      model.source = 'local';
      model.targets.clear();
    }
    renderSelect(byId('source'), model.source);
    renderChoices(byId('targets'), model.source, model.targets, true);
    renderAccounts();
    if (initial) editJob();
    else renderChoices(byId('job-targets'), byId('job-source').value, new Set(checked('job-targets')), false);
  }
  if (platformsChanged || update('jobs')) { model.jobs = state.jobs; renderJobs(); }
  if (update('files')) {
    model.files = state.files;
    renderFiles();
    if (trackLibrary.page) {
      if (location.hash === '#tracks') loadTrackLibrary();
      else trackLibrary.page = null;
    }
  }
  if (update('history')) { model.history = state.history; renderHistory(); }
  if (update('run')) { model.run = state.run; renderRun(); }
  renderControls();
}

function checkAccountsAfterLogin() {
  const key = 'sports-sync-check-accounts';
  if (!model.viewer || !sessionStorage.getItem(key) || model.working || running()) return;
  return perform(async () => {
    notice('正在检查已保存的平台账号…');
    let result;
    try { result = await api('/api/accounts/check', {}); }
    catch (error) {
      if (error.status === 409) { notice('当前操作结束后会检查平台账号。'); return; }
      sessionStorage.removeItem(key);
      throw error;
    }
    sessionStorage.removeItem(key);
    await refresh();
    notice(result.message, result.expired || result.unknown ? 'info' : 'success');
  });
}

function drawTrack(tracks) {
  const canvas = byId('track-canvas');
  const context = canvas.getContext('2d');
  const points = tracks.flat();
  if (!points.length) throw new Error('所选文件没有有效定位点。');
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of points) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  }
  const aspect = Math.max(0.05, Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
  const xRange = (maxLon - minLon) * aspect;
  const yRange = maxLat - minLat;
  const scale = Math.min((canvas.width - 72) / Math.max(xRange, 0.0001), (canvas.height - 72) / Math.max(yRange, 0.0001));
  const offsetX = (canvas.width - xRange * scale) / 2;
  const offsetY = (canvas.height - yRange * scale) / 2;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = tracks.length > 1 ? '#176e5780' : '#176e57';
  context.lineWidth = tracks.length > 1 ? 4 : 7;
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (const track of tracks) {
    context.beginPath();
    track.forEach(([lat, lon], i) => {
      const x = offsetX + (lon - minLon) * aspect * scale;
      const y = offsetY + (maxLat - lat) * scale;
      if (i) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.stroke();
  }
  byId('track-info').textContent = `显示 ${tracks.length} 段轨迹，可导出透明 PNG。`;
  byId('track-preview').hidden = false;
  byId('track-png').disabled = false;
}

function clearRide() {
  if (byId('ride-terrain-dialog').open) byId('ride-terrain-dialog').close();
  closeRideMap();
  closeRideExploration();
  model.ride = null;
  byId('ride-studio').hidden = true;
  byId('ride-download').disabled = true;
  byId('ride-share-image').disabled = true;
}

function closeRideMap() {
  const ride = model.ride;
  if (ride?.map) {
    const map = ride.map;
    ride.map = null;
    map.destroy();
  }
  byId('ride-map-view').hidden = true;
  byId('ride-map-toggle').textContent = '加载真实地图';
  byId('ride-map-toggle').setAttribute('aria-expanded', 'false');
}

function closeRideExploration() {
  const ride = model.ride;
  ride?.explorationMap?.destroy();
  if (ride) ride.explorationMap = null;
  byId('ride-exploration').hidden = true;
  byId('ride-exploration-results').hidden = true;
  const toggle = byId('ride-exploration-toggle');
  toggle.disabled = false;
  toggle.textContent = '加载探索地图';
  toggle.setAttribute('aria-expanded', 'false');
}

async function toggleRideExploration() {
  const ride = model.ride;
  if (!ride) return;
  const view = byId('ride-exploration');
  if (!view.hidden) return closeRideExploration();
  const toggle = byId('ride-exploration-toggle');
  const status = byId('ride-exploration-status');
  const mapView = byId('exploration-map-view');
  toggle.disabled = true;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = '收起探索地图';
  status.textContent = '正在计算探索格子。首次读取全部本地轨迹可能需要一些时间…';
  view.hidden = false;
  const active = () => model.ride === ride && !view.hidden;
  try {
    const [grid, { drawExplorationCard }] = await Promise.all([
      api(`/api/ride/${encodeURIComponent(ride.id)}/exploration`), import('/ride-exploration.js'),
    ]);
    if (!active()) return;
    byId('exploration-new').textContent = grid.newCells.length.toLocaleString('zh-CN');
    byId('exploration-current').textContent = grid.currentCells.length.toLocaleString('zh-CN');
    byId('exploration-history').textContent = grid.previousCells.length.toLocaleString('zh-CN');
    drawExplorationCard(byId('exploration-card'), grid);
    mapView.hidden = false;
    byId('ride-exploration-results').hidden = false;

    const { createRideMap } = await import('/ui/ride-map.js');
    if (!active()) return;
    const openMap = basemap => {
      ride.explorationMap = createRideMap(byId('exploration-map-canvas'), ride.data.mapSegments, {
        grid, terrain: false, basemap,
        onStatus({ state, message }) {
          if (!active()) return;
          status.textContent = message;
          if (state === 'error') {
            if (basemap && message.startsWith('街道底图')) {
              queueMicrotask(() => { if (active()) openMap(false); });
            } else {
              mapView.hidden = true;
            }
          }
        },
      });
    };
    openMap(true);
  } catch (error) {
    if (!active()) return;
    mapView.hidden = true;
    status.textContent = byId('ride-exploration-results').hidden
      ? (error.message || '探索格子读取失败，请重试。') : '探索地图暂时无法加载，仍可保存探索卡。';
  } finally {
    if (active()) toggle.disabled = false;
  }
}

function clearMonthlyRide() {
  const report = monthlyRide;
  monthlyRide = null;
  report?.map?.destroy();
  byId('ride-month-result').hidden = true;
  byId('ride-month-status').textContent = '';
  byId('ride-month-load').disabled = false;
}

async function loadMonthlyRide() {
  clearMonthlyRide();
  const status = byId('ride-month-status');
  const month = byId('ride-month-input').value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    status.textContent = '请选择月份。';
    return;
  }
  const report = { month };
  monthlyRide = report;
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const params = new URLSearchParams({ month, tz: timeZone || 'UTC' });
  const load = byId('ride-month-load');
  const mapView = byId('ride-month-map-view');
  load.disabled = true;
  status.textContent = '正在汇总当月格子…';
  try {
    const [data, { drawMonthlyPostcard, monthlyRecord }, image] = await Promise.all([
      api(`/api/ride-exploration/month?${params}`), import('/ride-exploration.js'), import('/ride-image.js'),
    ]);
    if (monthlyRide !== report) return;
    if (!data.highlight) {
      status.textContent = '该月没有带定位和日期的骑行。请选择其他月份，或先导入 FIT / GPX。';
      return;
    }
    Object.assign(report, { data, drawMonthlyPostcard, image });
    byId('ride-month-count').textContent = data.rideCount.toLocaleString('zh-CN');
    byId('ride-month-cells').textContent = data.heatCells.length.toLocaleString('zh-CN');
    byId('ride-month-highlight').textContent = `${data.highlight.name} · 单次覆盖 ${data.highlight.cells.toLocaleString('zh-CN')} 格`;
    byId('ride-month-record').textContent = monthlyRecord(data);
    byId('ride-month-route').checked = false;
    byId('ride-month-route').disabled = false;
    byId('ride-month-download').disabled = false;
    byId('ride-month-share').disabled = false;
    report.drawMonthlyPostcard(byId('ride-month-card'), data);
    byId('ride-month-result').hidden = false;
    mapView.hidden = false;
    const { createRideMap } = await import('/ui/ride-map.js');
    if (monthlyRide !== report) return;
    const openMap = basemap => {
      report.map = createRideMap(byId('ride-month-map'), [], {
        grid: data, terrain: false, basemap,
        onStatus({ state, message }) {
          if (monthlyRide !== report) return;
          status.textContent = message;
          if (state !== 'error') return;
          if (basemap && message.startsWith('街道底图')) {
            queueMicrotask(() => { if (monthlyRide === report) openMap(false); });
          } else {
            mapView.hidden = true;
          }
        },
      });
    };
    openMap(true);
  } catch (error) {
    if (monthlyRide !== report) return;
    mapView.hidden = true;
    status.textContent = report.data ? '热图暂时无法加载，仍可保存明信片。' : (error.message || '月度骑行读取失败。');
  } finally {
    if (monthlyRide === report) load.disabled = false;
  }
}

async function updateMonthlyRoute() {
  const report = monthlyRide;
  if (!report?.data) return;
  const toggle = byId('ride-month-route');
  const download = byId('ride-month-download');
  const share = byId('ride-month-share');
  toggle.disabled = download.disabled = share.disabled = true;
  try {
    if (toggle.checked && !report.trimmedRoute) {
      const { trimmedRoute } = await api(`/api/ride/${encodeURIComponent(report.data.highlight.id)}`);
      if (monthlyRide !== report) return;
      report.trimmedRoute = trimmedRoute;
    }
    if (toggle.checked && !report.trimmedRoute.length) {
      toggle.checked = false;
      notice('这趟骑行裁剪后没有可用的路线。');
    }
    report.drawMonthlyPostcard(byId('ride-month-card'), report.data, toggle.checked ? report.trimmedRoute : []);
  } catch {
    if (monthlyRide !== report) return;
    toggle.checked = false;
    notice('暂时无法读取代表骑行的裁剪路线。', 'error');
  } finally {
    if (monthlyRide === report) toggle.disabled = download.disabled = share.disabled = false;
  }
}

async function saveMonthlyRide(method) {
  const report = monthlyRide;
  if (!report?.data) return;
  try {
    const outcome = await report.image[method](byId('ride-month-card'), `骑行明信片-${report.month}.png`);
    if (outcome === 'downloaded') notice('PNG 图片已保存。', 'success');
    if (outcome === 'cancelled') notice('分享未完成，可以直接下载 PNG。');
  } catch {
    notice('无法生成 PNG 图片，请重试。', 'error');
  }
}

function showRideMapLegend(legend, estimatedSpeed) {
  const list = byId('ride-map-legend');
  const items = legend.map(({ label, color }) => {
    const item = element('li');
    const swatch = element('span', 'swatch');
    swatch.style.backgroundColor = color;
    swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, label);
    return item;
  });
  if (estimatedSpeed) items.push(element('li', '', '含按距离和时间估算的速度'));
  list.replaceChildren(...items);
  list.hidden = items.length === 0;
}

async function toggleRideMap() {
  const ride = model.ride;
  if (!ride?.data.mapSegments?.length) return;
  if (!byId('ride-map-view').hidden) return closeRideMap();
  const toggle = byId('ride-map-toggle');
  toggle.disabled = true;
  toggle.textContent = '正在打开地图…';
  const controls = byId('ride-map-mode');
  const terrain = byId('ride-map-terrain');
  const canvas = byId('ride-map-canvas');
  const toolbar = byId('ride-map-controls');
  const status = byId('ride-map-status');
  const segments = ride.data.mapSegments;
  try {
    const { createRideMap, rideMapLegend, hasRideMapMetric } = await import('/ui/ride-map.js');
    if (model.ride !== ride) return;
    const hasSpeed = hasRideMapMetric(segments, 'speed');
    const hasPower = hasRideMapMetric(segments, 'power');
    controls.options[1].disabled = !hasSpeed;
    controls.options[1].textContent = hasSpeed ? '速度' : '速度（无记录）';
    controls.options[2].disabled = !hasPower;
    controls.options[2].textContent = hasPower ? '功率' : '功率（无记录）';
    controls.value = hasSpeed ? 'speed' : hasPower ? 'power' : 'route';
    terrain.checked = true;
    terrain.disabled = false;
    canvas.hidden = false;
    toolbar.hidden = false;
    status.textContent = '正在加载底图与地形…';
    byId('ride-map-view').hidden = false;
    ride.refreshMapMode = () => {
      const mode = controls.value;
      ride.map?.setMode(mode);
      showRideMapLegend(rideMapLegend(segments, mode), mode === 'speed' && ride.data.mapSpeedEstimated);
    };
    ride.refreshMapMode();
    ride.map = createRideMap(canvas, segments, {
      mode: controls.value,
      onStatus({ state, message, terrain: terrainOn }) {
        if (model.ride !== ride || byId('ride-map-view').hidden) return;
        status.textContent = message || '';
        if (typeof terrainOn === 'boolean') terrain.checked = terrainOn;
        if (state === 'error') {
          canvas.hidden = true;
          toolbar.hidden = true;
          byId('ride-map-legend').hidden = true;
        }
      },
    });
  } catch {
    if (model.ride !== ride) return;
    byId('ride-map-view').hidden = false;
    canvas.hidden = true;
    toolbar.hidden = true;
    byId('ride-map-legend').hidden = true;
    status.textContent = '真实地图暂时无法加载。下方仍可查看文件内的海拔轨迹。';
  } finally {
    if (model.ride === ride) {
      toggle.disabled = false;
      toggle.textContent = '关闭地图';
      toggle.setAttribute('aria-expanded', 'true');
    }
  }
}

function rideDuration(seconds) {
  const total = Math.round(seconds);
  const parts = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  return parts.map(value => String(value).padStart(2, '0')).join(':');
}

function renderRideComparison({ baseline, ride, match, secondsSaved }, drawRoutes, drawElevation) {
  const descriptions = {
    same: '两趟路线接近，行进方向一致。',
    reverse: '两趟路线接近，行进方向相反。',
    ambiguous: '路线接近，往返方向难以区分。',
    different: '两趟路线的走向或起终点差异较大。',
    unavailable: '定位点不足、轨迹断点较多或路线过短，无法判断是否同路线。',
  };
  byId('ride-compare-status').textContent = descriptions[match];
  const seconds = secondsSaved == null ? null : Math.round(secondsSaved);
  const approximate = [baseline, ride].some(activity => activity.estimated.includes('durationSeconds')) ? '（估算）' : '';
  byId('ride-compare-time').textContent = seconds == null
    ? (match === 'same' ? '两趟的时长口径不同或缺少时长，分别列在下表。' : '下表显示各自的数据。')
    : seconds === 0 ? `两趟用时相同${approximate}。` : `对照骑行比基准${seconds > 0 ? '快' : '慢'} ${rideDuration(Math.abs(seconds))}${approximate}。`;
  for (const [id, activity] of [['ride-compare-baseline', baseline], ['ride-compare-current', ride]]) {
    byId(id).textContent = [activity.name || '活动', activity.startTime && formatTime(activity.startTime)].filter(Boolean).join(' · ');
  }
  const metrics = [
    ['durationSeconds', '用时', rideDuration],
    ['distanceM', '距离', value => `${(value / 1000).toFixed(2)} km`],
    ['ascentM', '累计爬升', value => `${Math.round(value)} m`],
    ['avgSpeedMps', '平均速度', value => `${(value * 3.6).toFixed(1)} km/h`],
    ['avgHeartRateBpm', '平均心率', value => `${Math.round(value)} bpm`],
    ['avgPowerW', '平均功率', value => `${Math.round(value)} W`],
  ];
  const rows = metrics.map(([key, label, format]) => {
    const row = element('tr');
    const heading = element('th', '', label);
    heading.scope = 'row';
    row.append(heading, ...[baseline, ride].map(activity => {
      const value = activity.metrics[key];
      if (!Number.isFinite(value)) return element('td', '', '—');
      const duration = key === 'durationSeconds' ? (activity.metrics.durationKind === 'timer' ? ' · 运动计时' : ' · 经过时长') : '';
      return element('td', '', `${activity.estimated.includes(key) ? '≈ ' : ''}${format(value)}${duration}`);
    }));
    return row;
  });
  byId('ride-compare-metrics').replaceChildren(...rows);
  byId('ride-compare-estimated').hidden = !baseline.estimated.length && !ride.estimated.length;
  const route = byId('ride-compare-route'), elevation = byId('ride-compare-elevation');
  route.hidden = !drawRoutes(route, baseline, ride);
  elevation.hidden = !drawElevation(elevation, baseline, ride);
  const routeCount = [baseline, ride].filter(activity => activity.mapSegments.length).length;
  byId('ride-compare-route-note').textContent = route.hidden ? '没有可绘制的定位轨迹。' :
    routeCount === 1 ? '仅一趟有定位轨迹。紫色虚线为基准，蓝色实线为对照。' : '紫色虚线为基准，蓝色实线为对照。';
  const elevationCount = [baseline, ride].filter(activity => activity.elevation.length).length;
  byId('ride-compare-elevation-note').textContent = elevation.hidden ? '没有可绘制的海拔数据。' :
    elevationCount === 1 ? '仅一趟记录了可绘制的海拔。紫色为基准，蓝色为对照。' : '紫色为基准，蓝色为对照，横轴为各自累计距离。';
  byId('ride-compare').hidden = false;
  byId('ride-compare-heading').focus();
}

function openRideComparison() {
  const ids = [...model.tracks];
  if (ids.length !== 2 || model.working) return;
  byId('ride-compare').hidden = true;
  clearRide();
  return perform(async () => {
    const [{ compareRides, drawComparisonRoutes, drawComparisonElevation }, ...rides] = await Promise.all([
      import('/ride-compare.js'), ...ids.map(id => api(`/api/ride/${encodeURIComponent(id)}`)),
    ]);
    if (location.hash !== '#tracks' || model.tracks.size !== 2 || !ids.every(id => model.tracks.has(id))) return;
    renderRideComparison(compareRides(...rides), drawComparisonRoutes, drawComparisonElevation);
  });
}

function showRideMetrics(ride) {
  const { metrics, estimated, startTime, format } = ride;
  const rows = [
    ['distanceM', '距离', 'km', value => (value / 1000).toFixed(2)],
    ['durationSeconds', metrics.durationKind === 'timer' ? '运动计时' : '经过时长', '', rideDuration],
    ['ascentM', '累计爬升', 'm', Math.round],
    ['avgSpeedMps', '平均速度', 'km/h', value => (value * 3.6).toFixed(1)],
    ['avgHeartRateBpm', '平均心率', 'bpm', Math.round],
    ['avgPowerW', '平均功率', 'W', Math.round],
    ['avgCadenceRpm', '平均踏频', 'rpm', Math.round],
  ];
  byId('ride-source').textContent = [format.toUpperCase(), startTime && formatTime(startTime), estimated.length && '带 ≈ 的指标为估算'].filter(Boolean).join(' · ');
  const cards = rows.filter(([key]) => Number.isFinite(metrics[key])).map(([key, label, unit, formatValue]) => {
    const card = element('div', 'ride-metric');
    const value = element('dd', '', `${estimated.includes(key) ? '≈ ' : ''}${formatValue(metrics[key])}`);
    if (unit) value.append(element('span', 'ride-unit', unit));
    card.append(element('dt', '', label), value);
    return card;
  });
  byId('ride-metrics').replaceChildren(...cards);
  byId('ride-metrics').hidden = cards.length === 0;
  if (!cards.length) byId('ride-source').textContent += ' · 文件没有可用的骑行统计';
}

function refreshRideCard() {
  if (!model.ride) return;
  const { data, drawCard, hasRideTerrain, cardRouteView } = model.ride;
  const route = byId('ride-route').value;
  const visibleRoute = route === 'full' ? data.route : route === 'trimmed' ? data.trimmedRoute : [];
  const canShowTerrain = hasRideTerrain(visibleRoute);
  const routeView = canShowTerrain ? cardRouteView : '2d';
  byId('ride-route-view').value = routeView;
  byId('ride-route-view').disabled = !canShowTerrain;
  byId('ride-share-angle-field').hidden = routeView !== '3d';
  byId('ride-share-terrain-open').hidden = routeView !== '3d';
  byId('ride-route-note').textContent = route === 'hidden'
    ? '路线和日期默认隐藏。选择显示路线后，有连续海拔数据的轨迹可用 3D。'
    : `${canShowTerrain ? '' : '所选范围缺少连续海拔，显示 2D 轮廓。'}熟悉当地路线的人仍可能认出位置。`;
  drawCard(byId('ride-card'), data, {
    theme: byId('ride-theme').value, ratio: byId('ride-ratio').value,
    title: byId('ride-title').value.trim() || '骑行战报',
    route, routeView, azimuth: Number(byId('ride-angle').value), showDate: byId('ride-date').checked,
  });
}

function refreshRideTerrain() {
  const angle = byId('ride-angle').value;
  for (const id of ['ride-angle', 'ride-share-angle', 'ride-full-angle']) {
    byId(id).value = angle;
    byId(`${id}-value`).textContent = `${angle}°`;
  }
  if (model.ride?.hasTerrain) {
    model.ride.drawTerrain(byId('ride-terrain'), model.ride.data.route, { azimuth: Number(angle) });
  }
  if (byId('ride-terrain-dialog').open) refreshTerrainViewer();
}

function refreshTerrainViewer() {
  const ride = model.ride;
  if (!ride) return;
  const scope = byId('ride-terrain-scope').value;
  const route = scope === 'trimmed' || (scope === 'hidden' && !ride.hasTerrain) ? ride.data.trimmedRoute : ride.data.route;
  const drawn = ride.drawTerrain(byId('ride-terrain-full'), route, { azimuth: Number(byId('ride-angle').value) });
  byId('ride-terrain-share').disabled = byId('ride-terrain-download').disabled = !drawn || scope === 'hidden';
  byId('ride-terrain-share-status').textContent = scope === 'hidden' ? '选择分享范围后可分享 PNG。'
    : scope === 'trimmed' ? '图片只显示裁剪后的立体轨迹。' : '图片会显示完整路线。';
}

function openTerrainViewer(scope = 'hidden') {
  const ride = model.ride;
  const dialog = byId('ride-terrain-dialog');
  if (!ride || dialog.open) return;
  const select = byId('ride-terrain-scope');
  select.options[1].disabled = !ride.hasRideTerrain(ride.data.trimmedRoute);
  select.options[2].disabled = !ride.hasTerrain;
  select.value = scope;
  dialog.showModal();
  refreshRideTerrain();
}

function saveRideImage(method, canvasId, filename, report = notice) {
  const ride = model.ride;
  if (!ride) return;
  ride[method](byId(canvasId), filename).then(result => {
    if (model.ride !== ride) return;
    if (result === 'downloaded') report('PNG 图片已保存。', 'success');
    if (result === 'cancelled') report('分享未完成，可以直接下载 PNG。', 'info');
  }).catch(() => {
    if (model.ride === ride) report('无法生成 PNG 图片，请重试。', 'error');
  });
}

function openRide(id) {
  if (model.working) return;
  byId('ride-compare').hidden = true;
  if (model.tracks.size !== 1 || !model.tracks.has(id)) {
    model.tracks = new Set([id]);
    renderTrackRows();
  }
  if (location.hash !== '#tracks') location.hash = '#tracks';
  clearRide();
  return perform(async () => {
    const [data, { drawRideCard }, { hasRideTerrain, drawRideTerrain }, { downloadCanvas, shareCanvas }] = await Promise.all([
      api(`/api/ride/${encodeURIComponent(id)}`), import('/ride-card.js'), import('/ride-terrain.js'), import('/ride-image.js'),
    ]);
    if (model.tracks.size !== 1 || !model.tracks.has(id)) return;
    const hasTerrain = hasRideTerrain(data.route);
    model.ride = { id, data, drawCard: drawRideCard, drawTerrain: drawRideTerrain, hasRideTerrain, hasTerrain,
      cardRouteView: '3d', downloadCanvas, shareCanvas };
    const canMap = Boolean(data.mapSegments?.length);
    byId('ride-map-toggle').hidden = !canMap;
    byId('ride-map-toggle').disabled = false;
    byId('ride-map-description').textContent = canMap ? '按速度或功率为路线着色。打开后，底图服务会收到当前区域的地图瓦片请求。' : '文件没有可用于底图的标准 GPS 轨迹。';
    showRideMetrics(data);
    byId('ride-terrain').hidden = !hasTerrain;
    byId('ride-angle-field').hidden = !hasTerrain;
    byId('ride-terrain-open').hidden = !hasTerrain;
    byId('ride-terrain-note').textContent = hasTerrain ? '海拔来自原文件，纵向放大便于查看起伏。可旋转视角。' : '文件缺少连续的定位和海拔，仍可使用已有指标生成战报。';
    byId('ride-angle').value = '35';
    byId('ride-title').value = '';
    byId('ride-route').value = 'hidden';
    byId('ride-route').options[1].disabled = !data.trimmedRoute.length;
    byId('ride-route').options[2].disabled = !data.route.length;
    byId('ride-date').checked = false;
    byId('ride-date').disabled = !data.startTime;
    byId('ride-studio').hidden = false;
    refreshRideTerrain();
    refreshRideCard();
    byId('ride-download').disabled = false;
    byId('ride-share-image').disabled = false;
    if (location.hash === '#tracks') byId(canMap ? 'ride-map-heading' : 'ride-analysis-heading').focus();
  });
}

async function importFile(file, name = file.name) {
  const response = await fetch(`/api/files/import?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function updateRecorder(text) {
  const active = recording?.watch != null;
  byId('start-record').disabled = active;
  byId('record-type').disabled = active;
  byId('stop-record').disabled = !active;
  byId('save-record').disabled = active || (recording?.points.length || 0) < 2;
  if (text) { byId('recorder-stats').textContent = text; return; }
  if (!recording) return;
  const elapsed = Math.max(0, Math.floor(((recording.finished || Date.now()) - recording.started) / 1000));
  byId('recorder-stats').textContent = `${recording.points.length} 个定位点 · ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒 · ${(recording.distance / 1000).toFixed(2)} km`;
}

function distanceBetween(first, second) {
  const rad = Math.PI / 180;
  const dLat = (second.lat - first.lat) * rad;
  const dLon = (second.lon - first.lon) * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(first.lat * rad) * Math.cos(second.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, value)));
}

function stopRecording(text) {
  if (recording?.watch == null) return;
  navigator.geolocation.clearWatch(recording.watch);
  recording.watch = null;
  recording.finished = Date.now();
  clearInterval(recording.timer);
  updateRecorder(text);
}

function startRecording() {
  if (!navigator.geolocation) return updateRecorder('当前浏览器没有可用的定位功能。');
  if (recording?.points.length && !confirm('开始新记录会清除这次未保存的定位点。继续吗？')) return;
  const current = { points: [], distance: 0, started: Date.now(), type: byId('record-type').value, watch: null };
  recording = current;
  current.watch = navigator.geolocation.watchPosition(position => {
    if (recording !== current || current.watch == null) return;
    const { latitude: lat, longitude: lon, altitude: ele, accuracy } = position.coords;
    if (![lat, lon, accuracy].every(Number.isFinite) || accuracy > 100) return updateRecorder('定位精度不足，正在等待较准的位置。');
    const point = { lat, lon, ele, time: position.timestamp };
    const last = current.points.at(-1);
    if (last && point.time <= last.time) return;
    if (last) current.distance += distanceBetween(last, point);
    current.points.push(point);
    if (current.points.length >= 100000) stopRecording('已达到记录容量，请保存 GPX。');
    else updateRecorder();
  }, error => {
    if (recording !== current) return;
    if (error.code === 1) stopRecording('浏览器未授予定位权限。');
    else updateRecorder('暂未取得定位，请检查设备定位是否可用。');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  current.timer = setInterval(() => { if (current.points.length) updateRecorder(); }, 1000);
  updateRecorder('正在等待设备定位…');
}

byId('source').addEventListener('change', event => useSource(event.target.value));
byId('garmin-preset').addEventListener('click', () => { model.targets = new Set(['com']); useSource('cn'); });
byId('load').addEventListener('click', () => perform(() => load(false)));
byId('next').addEventListener('click', () => perform(() => load(true)));
byId('select-all').addEventListener('click', () => {
  const ids = model.activities.slice(0, 50).map(item => item.id);
  model.selected = ids.every(id => model.selected.has(id)) ? new Set() : new Set(ids);
  renderActivities();
});
byId('download-test').addEventListener('click', () => perform(async () => {
  const result = await api('/api/file-test', { source: model.source, id: [...model.selected][0] });
  await refresh();
  notice(`已下载 ${result.fileName}，可在记录中心查看。`, 'success');
}));
byId('run').addEventListener('click', () => startRun({ source: model.source, targets: [...model.targets], ids: [...model.selected] }));
byId('setup-full-ride').addEventListener('click', () => {
  editJob();
  byId('job-name').value = `${label(model.source)}全量骑行`;
  byId('job-activity-type').value = 'cycling';
  renderJobMode();
  location.hash = '#jobs';
  showTab();
  byId('job-name').focus();
});
byId('stop').addEventListener('click', () => perform(async () => {
  notice((await api('/api/stop', {})).message);
  await refresh();
}));
byId('close-dialog').addEventListener('click', () => byId('credential-dialog').close());
byId('credential-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  const connection = model.credential;
  if (!connection) return;
  const { id, signIn } = connection;
  const data = Object.fromEntries(new FormData(form));
  submit.disabled = true;
  try {
    const result = await api(signIn ? '/api/account/sign-in' : '/api/account',
      signIn ? { platform: id, fields: data } : { platform: id, credential: data });
    if (model.source === id) clearActivities();
    if (model.credential === connection) byId('credential-dialog').close();
    await refresh(true);
    notice(result.message, 'success');
  } catch (error) {
    if (model.credential === connection) {
      byId('credential-error').textContent = error.message;
      byId('credential-error').hidden = false;
    }
  } finally { submit.disabled = false; }
});
byId('credential-dialog').addEventListener('close', () => {
  model.credential = null;
  byId('credential-fields').replaceChildren();
});
byId('job-source').addEventListener('change', event => renderChoices(byId('job-targets'), event.target.value, new Set(checked('job-targets')), false));
byId('job-mode').addEventListener('change', renderJobMode);
byId('job-activity-type').addEventListener('change', renderJobMode);
byId('job-reset').addEventListener('click', () => editJob());
byId('job-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => {
    const mode = byId('job-mode').value;
    await api('/api/jobs/save', {
      id: model.jobId, name: byId('job-name').value, source: byId('job-source').value, targets: checked('job-targets'),
      mode, activityType: mode === 'all' ? byId('job-activity-type').value : 'all', interval: Number(byId('job-interval').value),
      ...(mode === 'recent' && { limit: Number(byId('job-limit').value), skip: Number(byId('job-skip').value) }),
    });
    await refresh();
    editJob();
    notice('同步任务已保存。', 'success');
  });
});

function workoutDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const workoutToday = new Date();
byId('workout-oldest').value = workoutDate(workoutToday);
workoutToday.setDate(workoutToday.getDate() + 14);
byId('workout-newest').value = workoutDate(workoutToday);
byId('workout-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => {
    const range = { oldest: byId('workout-oldest').value, newest: byId('workout-newest').value };
    const { workouts } = await api('/api/workouts/list', range);
    renderWorkoutList(workouts, range);
  });
});
byId('file-filter').addEventListener('input', renderFiles);
byId('track-prev').addEventListener('click', () => loadTrackLibrary(Math.max(0, trackLibrary.start - 20)));
byId('track-next').addEventListener('click', () => loadTrackLibrary(trackLibrary.page.nextStart));
byId('track-retry').addEventListener('click', () => loadTrackLibrary(trackLibrary.retryStart));
byId('track-clear').addEventListener('click', () => {
  model.tracks.clear();
  clearRide();
  byId('ride-compare').hidden = true;
  renderTrackRows();
  renderControls();
});
document.querySelectorAll('[data-track-sort]').forEach(button => button.addEventListener('click', () => {
  const sort = button.dataset.trackSort;
  trackLibrary.direction = sort === trackLibrary.sort ? -trackLibrary.direction : -1;
  trackLibrary.sort = sort;
  renderTrackRows();
}));
byId('file-input').addEventListener('change', event => {
  const input = event.currentTarget;
  const files = [...input.files];
  input.value = '';
  perform(async () => {
    let count = 0;
    const errors = [];
    for (const file of files) {
      try {
        await importFile(file);
        count++;
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    await refresh();
    notice(`已导入 ${count} 个文件。${errors.join(' ')}`, errors.length ? 'error' : 'success');
  });
});
byId('draw-track').addEventListener('click', () => perform(async () => {
  const result = await api('/api/tracks', { ids: [...model.tracks] });
  drawTrack(result.tracks);
  if (result.message) byId('track-info').textContent = result.message;
}));
byId('merge-track').addEventListener('click', () => perform(async () => {
  const result = await api('/api/tracks', { ids: [...model.tracks], merge: true });
  drawTrack(result.tracks);
  await refresh();
  notice(result.message || `已合并 ${result.count} 个文件，GPX 已存入记录中心。`, 'success');
}));
byId('track-png').addEventListener('click', () => {
  import('/ride-image.js').then(({ downloadCanvas }) => downloadCanvas(byId('track-canvas'), '运动轨迹.png'))
    .catch(() => notice('无法生成 PNG 图片，请重试。', 'error'));
});
byId('analyze-ride').addEventListener('click', () => openRide(model.tracks.values().next().value));
byId('compare-ride').addEventListener('click', openRideComparison);
for (const control of ['ride-title', 'ride-theme', 'ride-ratio', 'ride-route', 'ride-date']) {
  byId(control).addEventListener(control === 'ride-title' ? 'input' : 'change', refreshRideCard);
}
byId('ride-route-view').addEventListener('change', event => {
  if (!model.ride) return;
  model.ride.cardRouteView = event.target.value;
  refreshRideCard();
});
for (const id of ['ride-angle', 'ride-share-angle', 'ride-full-angle']) {
  byId(id).addEventListener('input', event => {
    byId('ride-angle').value = event.target.value;
    refreshRideTerrain();
    if (!byId('ride-share-angle-field').hidden) refreshRideCard();
  });
}
byId('ride-terrain-open').addEventListener('click', () => openTerrainViewer());
byId('ride-share-terrain-open').addEventListener('click', () => openTerrainViewer(byId('ride-route').value));
byId('ride-terrain-close').addEventListener('click', () => byId('ride-terrain-dialog').close());
byId('ride-terrain-scope').addEventListener('change', refreshTerrainViewer);
for (const [buttonId, method] of [['ride-terrain-share', 'shareCanvas'], ['ride-terrain-download', 'downloadCanvas']]) {
  byId(buttonId).addEventListener('click', () => {
    saveRideImage(method, 'ride-terrain-full', '3D海拔轨迹.png', message => {
      byId('ride-terrain-share-status').textContent = message;
    });
  });
}
byId('ride-map-toggle').addEventListener('click', toggleRideMap);
byId('ride-map-mode').addEventListener('change', () => model.ride?.refreshMapMode?.());
byId('ride-map-terrain').addEventListener('change', event => model.ride?.map?.setTerrain(event.target.checked));
byId('ride-download').addEventListener('click', () => saveRideImage('downloadCanvas', 'ride-card', '骑行战报.png'));
byId('ride-share-image').addEventListener('click', () => saveRideImage('shareCanvas', 'ride-card', '骑行战报.png'));
byId('ride-exploration-toggle').addEventListener('click', toggleRideExploration);
byId('exploration-fit-all').addEventListener('click', () => model.ride?.explorationMap?.fitExploration());
byId('exploration-download').addEventListener('click', () => saveRideImage('downloadCanvas', 'exploration-card', '骑行探索卡.png'));
byId('exploration-share').addEventListener('click', () => saveRideImage('shareCanvas', 'exploration-card', '骑行探索卡.png'));
const monthToday = new Date();
byId('ride-month-input').value = `${monthToday.getFullYear()}-${String(monthToday.getMonth() + 1).padStart(2, '0')}`;
byId('ride-month-input').addEventListener('input', clearMonthlyRide);
byId('ride-month-load').addEventListener('click', loadMonthlyRide);
byId('ride-month-open').addEventListener('click', () => {
  if (monthlyRide?.data) openRide(monthlyRide.data.highlight.id);
});
byId('ride-month-route').addEventListener('change', updateMonthlyRoute);
byId('ride-month-download').addEventListener('click', () => saveMonthlyRide('downloadCanvas'));
byId('ride-month-share').addEventListener('click', () => saveMonthlyRide('shareCanvas'));
byId('start-record').addEventListener('click', startRecording);
byId('stop-record').addEventListener('click', () => stopRecording());
byId('save-record').addEventListener('click', () => perform(async () => {
  if (recording?.watch != null || !recording || recording.points.length < 2) return;
  const name = `${recording.type}-${new Date(recording.started).toISOString().replace(/[:.]/g, '-')}`;
  const points = recording.points.map(point => `<trkpt lat="${point.lat}" lon="${point.lon}">${Number.isFinite(point.ele) ? `<ele>${point.ele}</ele>` : ''}<time>${new Date(point.time).toISOString()}</time></trkpt>`).join('');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Sports Data Sync"><trk><name>${name}</name><trkseg>${points}</trkseg></trk></gpx>`;
  await importFile(new Blob([gpx]), `${name}.gpx`);
  recording = null;
  updateRecorder('定位记录已保存，可在记录中心下载。');
  await refresh();
}));
window.addEventListener('pagehide', () => stopRecording());
window.addEventListener('pageshow', event => {
  if (event.persisted && model.viewer) location.reload();
});
window.addEventListener('hashchange', showTab);
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  byId('main').focus();
});
showTab();
refresh(true).then(checkAccountsAfterLogin).catch(error => notice(error.message, 'error'));
setInterval(async () => {
  if (model.working || syncing || document.hidden) return;
  syncing = true;
  try { await refresh(); await checkAccountsAfterLogin(); } catch { /* Keep the current view while the local service is restarting. */ }
  finally { syncing = false; }
}, 2000);
