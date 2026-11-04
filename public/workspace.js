'use strict';

const byId = id => document.getElementById(id);
const tabs = ['sync', 'accounts', 'jobs', 'records', 'tracks'];
const statusNames = {
  sending: '等待确认', accepted: '平台已接收', unconfirmed: '待核对', confirmed: '已确认',
  duplicate: '平台判定重复', failed: '失败', released: '允许重试',
};
const connectionNames = { ready: '可用', saved: '已保存', verified: '已验证', configured: '已配置', disconnected: '待连接' };
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const model = {
  platforms: [], jobs: [], history: [], files: [], run: null, source: 'cn', targets: new Set(['com']),
  activities: [], selected: new Set(), next: null, loaded: false, working: false,
  credential: null, jobId: null, tracks: new Set(),
};
let syncing = false;
let recording = null;

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
const connected = id => Boolean(platform(id) && platform(id).state !== 'disconnected');
const running = () => model.run?.status === 'running';

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
  let result;
  try { result = await response.json(); }
  catch { throw new Error('本机服务没有返回有效结果。'); }
  if (!response.ok) throw new Error(result.error || `请求未完成（HTTP ${response.status}）。`);
  return result;
}

async function perform(action) {
  if (model.working) return;
  model.working = true;
  renderControls();
  notice('');
  try { await action(); }
  catch (error) {
    notice(error instanceof TypeError ? '无法连接本机服务。' : error.message, 'error');
    await refresh().catch(() => {});
  } finally {
    model.working = false;
    renderControls();
  }
}

function showTab() {
  const hash = location.hash.slice(1);
  const current = tabs.includes(hash) ? hash : 'sync';
  document.querySelectorAll('[data-panel]').forEach(node => { node.hidden = node.dataset.panel !== current; });
  document.querySelectorAll('[data-tab]').forEach(node => {
    if (node.dataset.tab === current) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
}

function renderSelect(select, selected) {
  const options = model.platforms.filter(item => item.source);
  select.replaceChildren(...options.map(item => {
    const option = element('option', '', item.name);
    option.value = item.id;
    return option;
  }));
  select.value = options.some(item => item.id === selected) ? selected : (options[0]?.id || '');
}

function renderChoices(container, source, selected, showState) {
  container.replaceChildren(...model.platforms.filter(item => item.target && item.id !== source).map(item => {
    const choice = element('label', 'choice');
    const input = element('input');
    input.type = 'checkbox';
    input.value = item.id;
    input.checked = selected.has(item.id);
    input.addEventListener('change', () => {
      if (container.id === 'targets') {
        if (input.checked) model.targets.add(item.id);
        else model.targets.delete(item.id);
        renderControls();
      }
    });
    const text = showState && !connected(item.id) ? `${item.name} · 待连接` : item.name;
    choice.append(input, document.createTextNode(text));
    return choice;
  }));
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
    [...model.targets].some(id => !connected(id));
  byId('selected-count').textContent = `已选 ${model.selected.size} 条`;
  byId('source-status').textContent = connected(model.source) ? connectionNames[platform(model.source).state] : '先到平台账号连接此来源。';
  byId('stop').hidden = !running();
  byId('stop').disabled = model.run?.stopRequested === true;
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

function credentialDialog(item) {
  model.credential = item.id;
  byId('credential-title').textContent = `连接 ${item.name}`;
  byId('credential-note').textContent = item.note || '连接凭据加密保存在本机。';
  byId('credential-error').hidden = true;
  byId('credential-fields').replaceChildren(...item.fields.map(field => {
    const container = element('label', 'field', field.label);
    const input = element('input');
    input.type = field.type || 'password';
    input.name = field.key;
    input.required = !!field.required;
    input.autocomplete = 'off';
    input.maxLength = 16000;
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

function renderAccounts() {
  const specs = model.platforms.filter(item => item.id !== 'local' && (item.source || item.target));
  byId('accounts').replaceChildren(...specs.map(item => {
    const card = element('article', 'panel platform-card');
    const head = element('div', 'panel-top');
    const isConnected = connected(item.id);
    head.append(element('h2', '', item.name), element('span', `session-status${isConnected ? ' ready' : ''}`, connectionNames[item.state]));
    const actions = element('div', 'action-row');
    if (item.auth === 'garmin') {
      actions.append(button('打开官方登录 ↗', () => accountAction('/api/login', item.id)),
        button('验证登录', () => accountAction('/api/verify', item.id), 'quiet'));
    } else {
      if (item.browserLogin) {
        const doLogin = path => perform(async () => {
          const result = await api(`/api/account/${path}`, { platform: item.id });
          if (model.source === item.id) clearActivities();
          await refresh(true);
          notice(result.message, 'success');
        });
        actions.append(button('打开平台官网 ↗', () => doLogin('open')), button('检查会话', () => doLogin('verify'), 'quiet'));
      }
      actions.append(button(isConnected ? '更换凭据' : '配置凭据', () => credentialDialog(item), item.browserLogin ? 'quiet' : 'secondary'));
    }
    if (isConnected) actions.append(button('断开', () => perform(async () => {
      await api('/api/disconnect', { platform: item.id });
      if (model.source === item.id) clearActivities();
      await refresh(true);
    }), 'quiet'));
    card.append(head, element('p', 'muted', [item.source && '读取', item.target && '上传'].filter(Boolean).join(' · ')), actions);
    return card;
  }));
  byId('coverage').replaceChildren(...model.platforms.filter(item => item.id !== 'local').map(item => {
    const directions = [item.upstreamSource && (item.source ? '读取已接入' : '读取待移植'),
      item.upstreamTarget && (item.target ? '上传已接入' : '上传待移植')].filter(Boolean);
    return element('p', '', `${item.name} · ${directions.join(' · ')}`);
  }));
}

function editJob(job) {
  model.jobId = job?.id || null;
  byId('job-title').textContent = job ? '编辑任务' : '新建任务';
  byId('job-reset').hidden = !job;
  byId('job-name').value = job?.name || '';
  renderSelect(byId('job-source'), job?.source || model.source);
  renderChoices(byId('job-targets'), byId('job-source').value, new Set(job?.targets || model.targets), false);
  byId('job-limit').value = job?.limit || 20;
  byId('job-skip').value = job?.skip || 0;
  byId('job-interval').value = job?.interval || 0;
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
    const timing = job.interval ? `每 ${job.interval} 分钟 · ${[job.source, ...job.targets].every(connected) ? `下次 ${formatTime(job.nextRun)}` : '等待账号连接'}` : '仅手动';
    return recordRow(job.name, `${path} · ${job.limit} 条 · 跳过 ${job.skip} 条 · ${timing}`, [
      button('运行', () => startRun({ jobId: job.id })), button('编辑', () => editJob(job), 'quiet'),
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

function renderFiles() {
  const keyword = byId('file-filter').value.trim().toLowerCase();
  const files = model.files.filter(file => `${file.name} ${file.fileName}`.toLowerCase().includes(keyword));
  byId('file-list').replaceChildren(...files.map(file => recordRow(file.name,
    `${file.fileName} · ${formatTime(file.time)} · ${Math.ceil(file.size / 1024)} KB`, [fileLink(file.id)])));
  if (!files.length) byId('file-list').append(element('p', 'empty', keyword ? '没有匹配的本机文件。' : '同步下载的文件会在这里显示。'));
  byId('track-files').replaceChildren(...model.files.map(file => {
    const row = recordRow(file.name, file.fileName);
    const input = element('input');
    input.type = 'checkbox';
    input.checked = model.tracks.has(file.id);
    input.setAttribute('aria-label', `选用轨迹 ${file.name}`);
    input.addEventListener('change', () => {
      if (!input.checked) model.tracks.delete(file.id);
      else if (model.tracks.size < 10) model.tracks.add(file.id);
      else { input.checked = false; notice('一次最多处理 10 个文件。'); }
    });
    row.prepend(input);
    return row;
  }));
  if (!model.files.length) byId('track-files').append(element('p', 'empty', '先在记录中心导入或下载活动文件。'));
}

function renderHistory() {
  byId('history').replaceChildren(...model.history.map(entry => {
    const actions = [];
    if (entry.fileId) actions.push(fileLink(entry.fileId, '原文件'));
    if (typeof entry.url === 'string' && entry.url.startsWith('https://')) actions.push(link('目标记录 ↗', entry.url, 'quiet'));
    if (['sending', 'accepted', 'unconfirmed'].includes(entry.status)) {
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

function renderRun() {
  const run = model.run;
  byId('run-panel').hidden = !run;
  if (run) {
    const status = { running: '运行中', finished: '已结束', stopped: '已停止', failed: '任务失败' }[run.status];
    byId('run-summary').textContent = `${run.name} · ${status} · 确认 ${run.confirmed} · 跳过 ${run.skipped} · 待核对 ${run.unconfirmed} · 失败 ${run.failed}`;
    const log = byId('run-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 15;
    log.replaceChildren(...run.logs.map(item => {
      const line = element('li', '', `${formatTime(item.time)}  ${item.message}`);
      line.dataset.level = item.level;
      return line;
    }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  renderControls();
}

async function refresh(force = false) {
  const state = await api('/api/workspace');
  const update = key => force || JSON.stringify(state[key]) !== JSON.stringify(model[key]);
  if (update('platforms')) {
    const initial = !model.platforms.length;
    model.platforms = state.platforms;
    renderSelect(byId('source'), model.source);
    renderChoices(byId('targets'), model.source, model.targets, true);
    renderAccounts();
    if (initial) editJob();
  }
  if (update('jobs')) { model.jobs = state.jobs; renderJobs(); }
  if (update('files')) { model.files = state.files; renderFiles(); }
  if (update('history')) { model.history = state.history; renderHistory(); }
  if (update('run')) { model.run = state.run; renderRun(); }
  renderControls();
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
  byId('track-png').disabled = false;
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
byId('stop').addEventListener('click', () => perform(async () => {
  notice((await api('/api/stop', {})).message);
  await refresh();
}));
byId('close-dialog').addEventListener('click', () => byId('credential-dialog').close());
byId('credential-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const result = await api('/api/account', { platform: model.credential, credential: Object.fromEntries(new FormData(form)) });
    if (model.source === model.credential) clearActivities();
    byId('credential-dialog').close();
    await refresh(true);
    notice(result.message, 'success');
  } catch (error) {
    byId('credential-error').textContent = error.message;
    byId('credential-error').hidden = false;
  } finally { submit.disabled = false; }
});
byId('credential-dialog').addEventListener('close', () => byId('credential-fields').replaceChildren());
byId('job-source').addEventListener('change', event => renderChoices(byId('job-targets'), event.target.value, new Set(checked('job-targets')), false));
byId('job-reset').addEventListener('click', () => editJob());
byId('job-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => {
    await api('/api/jobs/save', {
      id: model.jobId, name: byId('job-name').value, source: byId('job-source').value, targets: checked('job-targets'),
      limit: Number(byId('job-limit').value), skip: Number(byId('job-skip').value), interval: Number(byId('job-interval').value),
    });
    await refresh();
    editJob();
    notice('同步任务已保存。', 'success');
  });
});
byId('file-filter').addEventListener('input', renderFiles);
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
byId('track-png').addEventListener('click', () => byId('track-canvas').toBlob(blob => {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const download = document.createElement('a');
  download.href = url;
  download.download = '运动轨迹.png';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));
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
window.addEventListener('hashchange', showTab);
showTab();
refresh(true).catch(error => notice(error.message, 'error'));
setInterval(async () => {
  if (model.working || syncing || document.hidden) return;
  syncing = true;
  try { await refresh(); } catch { /* Keep the current view while the local service is restarting. */ }
  finally { syncing = false; }
}, 2000);
