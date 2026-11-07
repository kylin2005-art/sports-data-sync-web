import { rideShareSvg, shareThemes } from './ride-share-art.js';
import { downloadCanvas, shareCanvas } from './ride-image.js';

const byId = id => document.getElementById('ride-share-' + id);
const monthlyThemes = new Set([5, 23]);
const performanceThemes = new Set([3, 4, 10, 11, 16, 22, 24]);
const collectionThemes = new Set([5, 6, 7, 9, 13, 14, 18, 19, 23]);
const routeThemes = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 15, 16, 20, 21, 22]);
const dateThemes = new Set([1, 7, 8, 9, 11, 13, 15, 16, 18, 19, 21, 23]);
const category = id => performanceThemes.has(id) ? 'performance' : collectionThemes.has(id) ? 'collection' : 'activity';
const localMonth = value => {
  const date = value ? new Date(value) : new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

async function drawPoster(canvas, svg, isCurrent) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!isCurrent()) return;
    canvas.width = 1080;
    canvas.height = 1224;
    canvas.getContext('2d').drawImage(image, 0, 0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function photoData(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error('请选择 12 MB 以内的 JPG、PNG 或 WebP 图片。');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1080 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

export function createRideShareLibrary(api) {
  const dialog = byId('library');
  const themes = byId('themes'), canvas = byId('library-canvas'), status = byId('library-status');
  const download = byId('library-download'), share = byId('library-native');
  const controls = Object.fromEntries(['filter', 'title', 'scope', 'month', 'target', 'photo', 'date', 'notes']
    .map(key => [key, byId(key)]));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let session, selected = 1, revision = 0;

  function fetchOnce(path) {
    const requests = session.requests;
    if (!requests.has(path)) {
      requests.set(path, api(path).catch(error => { requests.delete(path); throw error; }));
    }
    return requests.get(path);
  }

  function drawCatalog() {
    const filter = controls.filter.value;
    themes.replaceChildren(...shareThemes.filter(theme => filter === 'all' || category(theme.id) === filter)
      .map(theme => {
        const number = String(theme.id).padStart(2, '0');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'share-library-theme';
        button.dataset.theme = theme.id;
        button.title = theme.description;
        button.setAttribute('aria-pressed', String(theme.id === selected));
        const image = new Image(216, 245);
        image.alt = '';
        image.loading = 'lazy';
        image.src = `/ride-theme-previews/${number}.webp`;
        const name = document.createElement('span');
        name.textContent = `${number} ${theme.name}`;
        button.append(image, name);
        return button;
      }));
  }

  function setReady(ready) {
    canvas.hidden = !ready;
    download.disabled = share.disabled = !ready;
  }

  async function refresh() {
    if (!session) return;
    const current = session, id = selected, ticket = ++revision;
    const isCurrent = () => dialog.open && session === current && revision === ticket;
    const monthly = monthlyThemes.has(id);
    const route = routeThemes.has(id);
    const ride = current.ride;
    const month = controls.month.value;
    const target = controls.target.valueAsNumber;
    const scope = route ? controls.scope.value : 'hidden';
    const options = { ride, scope, title: controls.title.value, showDate: controls.date.checked, target,
      comparison: current.comparison, record: current.record, photo: id === 18 ? current.photo : null };
    byId('selected').textContent = `${String(id).padStart(2, '0')} ${shareThemes[id - 1].name}`;
    for (const [field, visible] of Object.entries({
      title: !monthly, scope: route, month: monthly, target: id === 24, photo: id === 18,
      date: Boolean(ride?.startTime) && dateThemes.has(id), notes: id === 6,
    })) byId(`${field}-field`).hidden = !visible;
    setReady(false);
    if (!ride && !monthly) {
      status.textContent = '这套主题需要一条骑行。请在轨迹工具选择活动并打开「分享图」。';
      return;
    }
    if (id === 24 && (!controls.target.validity.valid || !Number.isFinite(target))) {
      status.textContent = '请输入 1–2000 km 的目标里程。';
      return;
    }
    status.textContent = '正在生成预览…';
    let hint = scope === 'hidden' && route ? '路线已隐藏。' : scope !== 'hidden' ? '熟悉当地路线的人仍可能认出位置。' : '';
    try {
      if (monthly) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1970-01') throw new Error('请选择有效的月份。');
        const params = new URLSearchParams({ month, tz: timeZone });
        options.monthly = { ...await fetchOnce(`/api/ride-share/month?${params}`) };
        if (!isCurrent()) return;
        if (id === 5 && scope !== 'hidden' && options.monthly.representativeId) {
          options.monthly.representative = await fetchOnce(`/api/ride/${encodeURIComponent(options.monthly.representativeId)}`);
        }
        if (!options.monthly.rideCount) hint = '这个月没有可统计的骑行。';
        else if (id === 23) hint = '月历会标出每个骑行日，导出时也会包含这些日期。';
      }
      if (id === 4) {
        if (ride.mapSegments?.length) {
          options.exploration = await fetchOnce(`/api/ride/${encodeURIComponent(current.id)}/exploration`);
        } else hint = '这条活动没有可计算探索格子的定位轨迹。';
        if (scope === 'trimmed') hint = '裁剪范围只显示探索数量。完整路线范围可显示格子。';
      }
      if (id === 6 && controls.notes.checked) {
        const { entries } = await fetchOnce('/api/ride-journal');
        options.journal = entries.find(entry => entry.id === current.id);
        if (!options.journal) hint = '这条活动还没有手账笔记。可先收藏路线并填写。';
      }
      if (id === 3 && !current.comparison && !current.record) {
        hint = '当前为单次成绩。可从同路线对比或年度高光打开这一主题。';
      }
      if (!isCurrent()) return;
      const targetRide = monthly ? options.monthly.representative : ride;
      if (route && scope !== 'hidden' && id !== 4 &&
          !(scope === 'full' ? targetRide?.route : targetRide?.trimmedRoute)?.length) {
        hint = '所选范围没有可用路线，仍可导出已有数据。';
      }
      await drawPoster(canvas, rideShareSvg(id, options), isCurrent);
      if (!isCurrent()) return;
      setReady(true);
      status.textContent = hint || '可下载或分享这张 PNG。';
    } catch (error) {
      if (isCurrent()) status.textContent = error.message || '无法生成分享图，请重试。';
    }
  }

  themes.addEventListener('click', event => {
    const button = event.target.closest('[data-theme]');
    if (!button) return;
    selected = Number(button.dataset.theme);
    for (const item of themes.children) item.setAttribute('aria-pressed', String(item === button));
    void refresh();
  });
  controls.filter.addEventListener('change', drawCatalog);
  for (const control of ['title', 'scope', 'month', 'target', 'date', 'notes']) {
    controls[control].addEventListener(['title', 'target'].includes(control) ? 'input' : 'change', refresh);
  }
  controls.photo.addEventListener('change', async () => {
    const current = session;
    const file = controls.photo.files[0];
    if (!current) return;
    const ticket = ++current.photoRevision;
    current.photo = null;
    revision++;
    setReady(false);
    try {
      const photo = file ? await photoData(file) : null;
      if (session !== current || current.photoRevision !== ticket) return;
      current.photo = photo;
      await refresh();
    } catch (error) {
      if (session !== current || current.photoRevision !== ticket) return;
      controls.photo.value = '';
      await refresh();
      if (session === current && selected === 18) status.textContent = error.message || '无法读取合影。';
    }
  });
  for (const [button, action] of [[download, downloadCanvas], [share, shareCanvas]]) {
    button.addEventListener('click', async () => {
      const ticket = revision;
      try {
        const outcome = await action(canvas, `Ride-${String(selected).padStart(2, '0')}-${shareThemes[selected - 1].name}.png`);
        if (ticket === revision) status.textContent = outcome === 'cancelled' ? '已取消分享。' :
          outcome === 'downloaded' ? 'PNG 已下载。' : '图片已分享。';
      } catch {
        if (ticket === revision) status.textContent = '导出失败，请重试。';
      }
    });
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    session = null;
    revision++;
    controls.photo.value = '';
    canvas.width = canvas.width;
    setReady(false);
  });

  return function open(context, initialTheme = 1) {
    session = { ...context, photo: null, photoRevision: 0, requests: new Map() };
    selected = initialTheme;
    controls.filter.value = 'all';
    controls.title.value = '';
    controls.scope.value = 'hidden';
    controls.month.value = context.month || localMonth(context.ride?.startTime);
    controls.target.value = '100';
    controls.date.checked = controls.notes.checked = false;
    controls.photo.value = '';
    drawCatalog();
    if (!dialog.open) dialog.showModal();
    void refresh();
  };
}
