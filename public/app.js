'use strict';

const byId = id => document.getElementById(id);
const state = {
  cn: false, com: false, known: false, busy: null,
  pending: { cn: false, com: false }, activities: [], selectedId: null,
  nextStart: null, loaded: false, listFresh: false, confirmed: new Map()
};
const regionName = region => region === 'cn' ? '国内区' : '国际区';
const ready = region => state.known && state[region] && !state.pending[region];
const selected = () => state.activities.find(item => item.id === state.selectedId);

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'same-origin'
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('本地服务未返回有效结果，请检查服务是否仍在运行。'); }
  if (!response.ok || data.error) throw new Error(data.error || `请求未完成（HTTP ${response.status}）。`);
  return data;
}

function errorMessage(error) {
  return error instanceof TypeError ? '无法连接本地服务，请确认服务仍在运行。' : error.message || '请求未完成，请稍后重试。';
}

function notice(id, text, kind = 'info') {
  const element = byId(id);
  element.textContent = text;
  element.hidden = !text;
  element.className = `notice ${kind}${id === 'transfer-notice' ? ' transfer-notice' : ''}`;
}

function accountMessage(region, message, isError = false) {
  const element = byId(`${region}-message`);
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function renderControls() {
  for (const region of ['cn', 'com']) {
    const badge = byId(`${region}-status`);
    badge.textContent = !state.known ? '未连接服务' : state.pending[region] ? '等待验证' : ready(region) ? '已验证' : '待验证';
    badge.className = `session-status${ready(region) ? ' ready' : state.pending[region] ? ' pending' : ''}`;
  }
  document.querySelectorAll('[data-login], [data-verify]').forEach(button => { button.disabled = !!state.busy; });
  byId('load-button').disabled = !!state.busy || !ready('cn');
  byId('load-button').textContent = state.loaded ? '刷新最近 20 条' : '读取最近 20 条';
  byId('next-button').disabled = !!state.busy || !ready('cn') || !state.listFresh || state.nextStart === null;
  byId('next-button').hidden = state.nextStart === null;
  byId('activity-fieldset').disabled = !!state.busy || !state.listFresh || !ready('cn');
  const item = selected();
  const confirmed = item && state.confirmed.has(item.id);
  byId('selected-name').textContent = item ? item.name : '尚未选择运动记录';
  byId('transfer-hint').textContent = confirmed ? '这条记录已获得国际区活动编号，可通过下方链接核对。'
    : !ready('cn') || !ready('com') ? '请先验证国内区和国际区登录，再转存所选记录。'
    : !state.listFresh && state.loaded ? '国内区登录已更新，请重新读取活动后再选择。'
    : '当前支持单条转存，目标为佳明国际区。';
  byId('transfer-button').disabled = !!state.busy || !item || !state.listFresh || !ready('cn') || !ready('com') || confirmed;
  byId('transfer-button').textContent = confirmed ? '这条记录已转存 ✓' : '确认转存到国际区 →';
}

async function refreshState() {
  try {
    const data = await api('/api/state');
    if (typeof data.cn !== 'boolean' || typeof data.com !== 'boolean') throw new Error('本地服务返回的登录状态无效。');
    state.cn = data.cn;
    state.com = data.com;
    state.known = true;
    byId('connection-notice').hidden = true;
    renderControls();
    return true;
  } catch (error) {
    state.known = false;
    byId('connection-notice').textContent = errorMessage(error);
    byId('connection-notice').hidden = false;
    renderControls();
    return false;
  }
}

async function perform(button, label, action) {
  if (state.busy) return;
  state.busy = button.id || label;
  const previous = button.textContent;
  renderControls();
  button.textContent = label;
  button.setAttribute('aria-busy', 'true');
  try { await action(); }
  finally {
    state.busy = null;
    button.textContent = previous;
    button.removeAttribute('aria-busy');
    renderControls();
  }
}

async function sessionAction(button, action, region) {
  await perform(button, action === 'login' ? '正在打开…' : '正在验证…', async () => {
    accountMessage(region, action === 'login' ? '正在打开独立的佳明官方登录窗口…' : `正在验证${regionName(region)}会话…`);
    try {
      const data = await api(`/api/${action}`, { region });
      if (action === 'login') state.pending[region] = true;
      const refreshed = await refreshState();
      if (action === 'verify' && refreshed && state[region]) state.pending[region] = false;
      if (region === 'cn') {
        state.listFresh = false;
        byId('receipt').hidden = true;
        notice('transfer-notice', '');
        if (state.loaded) notice('list-notice', '国内区登录已更新，请刷新活动列表后再转存。');
      }
      if (region === 'com' && action === 'login') {
        state.confirmed.clear();
        byId('receipt').hidden = true;
        renderList();
      }
      accountMessage(region, data.message || (action === 'login'
        ? '请在新窗口完成登录及两步验证，然后回到这里点击“验证登录”。'
        : ready(region) ? '登录已验证，可以继续。' : '尚未确认登录，请完成官方页面上的验证后再试。'));
    } catch (error) {
      accountMessage(region, errorMessage(error), true);
      await refreshState();
    }
  });
}

function distance(value) {
  if (typeof value !== 'number') return value ? String(value) : '—';
  return Number.isFinite(value) && value >= 0 ? `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} km` : '—';
}

function duration(value) {
  if (typeof value !== 'number') return value ? String(value) : '—';
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function time(value) {
  if (!value) return '日期未提供';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function renderList() {
  const container = byId('activity-list');
  const fragment = document.createDocumentFragment();
  for (const activity of state.activities) {
    const row = document.createElement('label');
    row.className = `activity-row${activity.id === state.selectedId ? ' selected' : ''}`;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activity';
    radio.value = activity.id;
    radio.className = 'activity-radio';
    radio.checked = activity.id === state.selectedId;
    radio.setAttribute('aria-label', `选择 ${activity.name}，${time(activity.time)}`);
    const content = textElement('div', 'activity-text', '');
    const name = textElement('div', 'activity-title', activity.name);
    if (state.confirmed.has(activity.id)) name.append(textElement('span', 'row-confirmed', '已转存'));
    const meta = textElement('div', 'activity-meta', '');
    meta.append(textElement('span', '', time(activity.time)), textElement('span', '', activity.type || '运动'));
    content.append(name, meta);
    const metrics = [['距离', distance(activity.distance)], ['时长', duration(activity.duration)]].map(([label, value]) => {
      const metric = textElement('div', 'activity-metric', '');
      metric.append(textElement('span', 'metric-label', label), document.createTextNode(value));
      return metric;
    });
    row.append(radio, content, ...metrics);
    fragment.append(row);
  }
  container.replaceChildren(fragment);
  byId('empty-state').hidden = state.activities.length > 0;
  byId('activity-fieldset').hidden = state.activities.length === 0;
  byId('list-footer').hidden = state.activities.length === 0;
  byId('list-count').textContent = `已读取 ${state.activities.length} 条${state.nextStart === null ? ' · 已到末尾' : ''}`;
  if (state.loaded && !state.activities.length) {
    byId('empty-title').textContent = '国内区暂无运动记录';
    byId('empty-copy').textContent = '接口已返回空列表。可核对登录账号后重新读取。';
  }
  renderControls();
}

async function loadActivities(button, append) {
  if (!ready('cn')) return;
  const start = append ? state.nextStart : 0;
  if (start === null) return;
  await perform(button, '正在读取…', async () => {
    notice('list-notice', '正在读取国内区运动记录…');
    try {
      const data = await api('/api/activities', { start });
      if (!Array.isArray(data.activities) || !data.activities.every(item => item && typeof item.id === 'string' && item.id)) {
        throw new Error('活动列表格式不完整，本次未更新列表。');
      }
      if (data.nextStart !== null && (!Number.isInteger(data.nextStart) || data.nextStart <= start)) throw new Error('活动分页信息无效，本次未更新列表。');
      const items = data.activities.map(item => ({ ...item, name: String(item.name || '未命名活动') }));
      const merged = append ? [...state.activities, ...items] : items;
      state.activities = [...new Map(merged.map(item => [item.id, item])).values()];
      state.nextStart = data.nextStart;
      state.loaded = true;
      state.listFresh = true;
      if (!selected()) {
        state.selectedId = null;
        byId('receipt').hidden = true;
        notice('transfer-notice', '');
      }
      byId('list-caption').textContent = '选择一条记录，核对后转存到国际区。';
      renderList();
      notice('list-notice', '');
    } catch (error) {
      notice('list-notice', errorMessage(error), 'error');
      await refreshState();
    }
  });
}

async function transfer() {
  const activity = selected();
  if (!activity || !state.listFresh || !ready('cn') || !ready('com') || state.confirmed.has(activity.id)) return;
  await perform(byId('transfer-button'), '正在转存并确认…', async () => {
    byId('receipt').hidden = true;
    notice('transfer-notice', `正在转存“${activity.name}”，并等待国际区确认。请保持本地服务运行。`);
    try {
      const data = await api('/api/transfer', { id: activity.id });
      if (String(data.id) !== activity.id || !/^[1-9][0-9]*$/.test(String(data.activityId))) throw new Error('未收到明确的国际区活动编号，尚不能确认成功。请先在国际区核对记录。');
      let url;
      try { url = new URL(data.url); } catch { throw new Error('已收到活动编号，但查看链接无效，请到国际区核对记录。'); }
      if (url.origin !== 'https://connect.garmin.com' || !url.pathname.endsWith(`/activity/${data.activityId}`)) {
        throw new Error('返回的活动链接与国际区活动编号不匹配，请到国际区核对记录。');
      }
      state.confirmed.set(activity.id, data);
      byId('receipt-name').textContent = activity.name;
      byId('receipt-detail').textContent = `国际区活动编号 ${data.activityId}`;
      byId('receipt-link').href = url.href;
      byId('receipt').hidden = false;
      notice('transfer-notice', data.message || '转存已确认，请打开国际区记录核对。', 'success');
      renderList();
      byId('receipt').focus({ preventScroll: true });
    } catch (error) {
      notice('transfer-notice', `${errorMessage(error)} 未确认成功时，请先核对国际区记录，再决定是否重试。`, 'error');
      await refreshState();
    }
  });
}

document.querySelectorAll('[data-login]').forEach(button => button.addEventListener('click', () => sessionAction(button, 'login', button.dataset.login)));
document.querySelectorAll('[data-verify]').forEach(button => button.addEventListener('click', () => sessionAction(button, 'verify', button.dataset.verify)));
byId('load-button').addEventListener('click', event => loadActivities(event.currentTarget, false));
byId('next-button').addEventListener('click', event => loadActivities(event.currentTarget, true));
byId('transfer-button').addEventListener('click', transfer);
byId('activity-list').addEventListener('change', event => {
  if (!event.target.matches('input[name="activity"]')) return;
  state.selectedId = event.target.value;
  document.querySelectorAll('.activity-row').forEach(row => row.classList.toggle('selected', row.querySelector('input').checked));
  const result = state.confirmed.get(state.selectedId);
  if (result) {
    byId('receipt-name').textContent = selected().name;
    byId('receipt-detail').textContent = `国际区活动编号 ${result.activityId}`;
    byId('receipt-link').href = result.url;
  }
  byId('receipt').hidden = !result;
  notice('transfer-notice', '');
  renderControls();
});

refreshState();
