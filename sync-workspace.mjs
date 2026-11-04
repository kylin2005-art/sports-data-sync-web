import { randomUUID } from 'node:crypto';
import { digest } from './sync-store.mjs';

const regions = new Set(['cn', 'com']);
const pageSize = 20;
const maxActivities = 50;
const safeId = id => typeof id === 'string' && /^[\w.:-]{1,160}$/.test(id);
const durable = new Set(['sending', 'accepted', 'unconfirmed', 'confirmed', 'duplicate']);

const catalog = [
  ['cn', '佳明中国', true, true], ['com', '佳明国际', true, true],
  ['igpsport', 'iGPSPORT', true, true], ['xingzhe', '行者', true, true],
  ['magene', '迈金', true, true], ['blackbird', '黑鸟单车', true, true],
  ['bryton', '百锐腾', true, false], ['giant', '捷安特', false, true],
  ['outbase', 'Outbase', false, true], ['coros_cn', '高驰中国', true, true],
  ['coros_int', '高驰国际', true, true], ['wahoo', 'Wahoo', true, true],
  ['intervals_icu', 'Intervals.icu', true, true], ['keep', 'Keep', true, false],
  ['codoon', '咕咚', true, false], ['zepp', 'Zepp', true, false],
  ['komoot', 'Komoot', true, true], ['suunto', 'Suunto', true, true],
  ['mywhoosh', 'MyWhoosh', true, false], ['zwift', 'Zwift', true, false],
  ['cycity', '骑行市', true, true], ['twobulu', '两步路', true, false],
  ['strava', 'Strava', true, true], ['polar', 'Polar', true, false],
  ['fitbit', 'Fitbit', true, false], ['withings', 'Withings', true, false],
  ['trainingpeaks', 'TrainingPeaks', true, true], ['local', '本机文件', true, true],
];

export class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function tidyFile(file) {
  if (!Buffer.isBuffer(file?.data) || !file.data.length || file.data.length > 50 * 1024 * 1024) {
    throw new WorkspaceError(422, '未收到可用的活动文件，或文件超过 50 MB。');
  }
  const fileName = String(file.fileName || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!/\.(fit|gpx)$/i.test(fileName) || fileName.length > 240) throw new WorkspaceError(422, '活动文件需要使用 FIT 或 GPX 格式。');
  if (/\.fit$/i.test(fileName) && file.data.subarray(8, 12).toString('ascii') !== '.FIT') {
    throw new WorkspaceError(422, '文件缺少有效的 FIT 标头。');
  }
  if (/\.gpx$/i.test(fileName) && !/<(?:[\w.-]+:)?gpx(?:\s|>)/i.test(file.data.toString('utf8', 0, 16384))) {
    throw new WorkspaceError(422, '文件缺少有效的 GPX 标头。');
  }
  return { data: file.data, fileName, coordinateSystem: file.coordinateSystem };
}

function messageOf(error) {
  return Number.isInteger(error?.status) ? error.message : '本机同步服务执行失败。';
}

export class SyncWorkspace {
  #credentials = new Map();
  #verifiedOther = new Set();
  #garminAccounts = new Map();
  #seen = new Map();
  #run = null;
  #pending = null;
  #timer;
  #saved = { garmin: {}, credentials: {} };

  constructor({ garmin, store, uploads, sources, platformLogin, sessionVault, sessionData,
    isBusy = () => false, onGarminInvalid }) {
    Object.assign(this, { garmin, store, uploads, sources, platformLogin, sessionVault, isBusy });
    this.onGarminInvalid = onGarminInvalid || (region => this.clearGarmin(region));
    this.#run = store.lastRun();
    const sourceSpecs = new Map(sources.definitions.map(def => [def.id, def]));
    const targetSpecs = new Map(uploads.definitions.map(def => [def.id, def]));
    this.platforms = new Map(catalog.map(([id, name, upstreamSource, upstreamTarget]) => {
      const source = sourceSpecs.get(id);
      const target = targetSpecs.get(id);
      const garmin = regions.has(id);
      return [id, {
        id, name, upstreamSource, upstreamTarget, source: Boolean(source || garmin || id === 'local'),
        target: Boolean(target || garmin || id === 'local'), auth: garmin ? 'garmin' : id === 'local' ? 'local' : 'credential',
        browserLogin: Boolean(platformLogin?.supports(id)),
        formats: garmin || id === 'local' ? ['fit', 'gpx'] : (target?.formats || []),
        fields: [...new Map([...(source?.fields || []), ...(target?.fields || [])].map(field => [field.key, field])).values()],
        note: [source?.note, target?.note].filter(Boolean).join(' '),
      }];
    }));
    for (const [platform, credential] of Object.entries(sessionData?.credentials || {})) {
      if (!this.platforms.get(platform)?.fields.length) continue;
      const data = this.#normalizeCredential(platform, credential);
      this.#credentials.set(platform, data);
      this.#saved.credentials[platform] = data;
    }
    for (const region of regions) {
      const record = sessionData?.garmin?.[region];
      if (!record?.accountKey || !record.sessionState) continue;
      garmin.restore(region, record);
      this.#saved.garmin[region] = record;
      this.setGarmin(region, record);
    }
  }

  get busy() { return this.#pending !== null; }

  setGarmin(region, result) {
    this.#seen.delete(region);
    if (result) this.#garminAccounts.set(region, result.accountKey || `session:${randomUUID()}`);
    else this.#garminAccounts.delete(region);
  }

  hasGarmin(region) { return this.#garminAccounts.has(region); }
  hasSavedGarmin(region) { return this.hasGarmin(region) && Boolean(this.#saved.garmin[region]); }

  async #saveConnection(group, platform, value) {
    if (!this.sessionVault) return;
    const current = this.#saved[group][platform];
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    const changed = { ...this.#saved[group] };
    if (value) changed[platform] = value;
    else delete changed[platform];
    const next = { ...this.#saved, [group]: changed };
    await this.sessionVault.save(next);
    this.#saved = next;
  }

  async rememberGarmin(region, result) {
    const record = result.accountKey && result.sessionState ? { accountKey: result.accountKey, sessionState: result.sessionState } : null;
    if (record) await this.#saveConnection('garmin', region, record);
    else if (this.#saved.garmin[region]?.accountKey !== result.accountKey) await this.#saveConnection('garmin', region, undefined);
    this.setGarmin(region, result);
    return this.hasSavedGarmin(region);
  }

  async refreshGarminSession(region, record) {
    if (this.#saved.garmin[region]?.accountKey !== record.accountKey) return;
    await this.#saveConnection('garmin', region, record);
  }

  async clearGarmin(region) {
    this.setGarmin(region, null);
    this.garmin.forget?.(region);
    await this.#saveConnection('garmin', region, undefined);
  }

  state() {
    return {
      platforms: [...this.platforms.values()].map(platform => ({ ...platform,
        state: regions.has(platform.id) ? (this.hasSavedGarmin(platform.id) ? 'saved'
          : this.hasGarmin(platform.id) ? 'verified' : 'disconnected')
          : platform.id === 'local' ? 'ready' : this.#credentials.has(platform.id)
            ? (this.#saved.credentials[platform.id] ? 'saved' : this.#verifiedOther.has(platform.id) ? 'verified' : 'configured') : 'disconnected',
      })),
      jobs: this.store.jobs(), run: this.#run, history: this.store.history(), files: this.store.files(0, 50),
    };
  }

  #normalizeCredential(platform, credential) {
    const spec = this.platforms.get(platform);
    if (!spec?.fields.length || !credential || typeof credential !== 'object' || Array.isArray(credential)) {
      throw new WorkspaceError(400, '请选择已接入的平台并填写凭据。');
    }
    const data = {};
    for (const { key, label, required } of spec.fields) {
      const value = credential[key];
      if (value == null || value === '') {
        if (required) throw new WorkspaceError(400, `请填写${label}。`);
      } else if (typeof value !== 'string' || value.length > 16000 || /[\r\n\0]/.test(value)) {
        throw new WorkspaceError(400, `${label}格式不正确。`);
      } else {
        data[key] = value.trim();
        if (!data[key] && required) throw new WorkspaceError(400, `请填写${label}。`);
      }
    }
    return data;
  }

  async configure({ platform, credential }) {
    const data = this.#normalizeCredential(platform, credential);
    await this.#saveConnection('credentials', platform, data);
    this.#credentials.set(platform, data);
    this.#verifiedOther.delete(platform);
    this.#seen.delete(platform);
    return { message: this.sessionVault ? '连接凭据已加密保存，实际读取或上传时校验。' : '凭据已暂存，实际读取或上传时校验。' };
  }

  async disconnect({ platform }) {
    this.#credentials.delete(platform);
    this.#verifiedOther.delete(platform);
    this.#seen.delete(platform);
    if (regions.has(platform)) await this.onGarminInvalid(platform);
    else await this.#saveConnection('credentials', platform, undefined);
    return { message: '已断开本机连接。' };
  }

  async openPlatform({ platform }) {
    if (!this.platforms.get(platform)?.browserLogin) throw new WorkspaceError(400, '请选择支持网页登录的平台。');
    await this.disconnect({ platform });
    return this.platformLogin.open(platform);
  }

  async verifyPlatform({ platform }) {
    const spec = this.platforms.get(platform);
    if (!spec?.browserLogin) throw new WorkspaceError(400, '请选择支持网页登录的平台。');
    const credential = await this.platformLogin.credential(platform);
    if (spec.source && this.sources.verify) {
      await this.sources.verify(platform, credential);
      await this.configure({ platform, credential });
      this.#verifiedOther.add(platform);
      return { message: this.sessionVault ? '登录已验证并保存，可以关闭平台官网窗口。' : '登录已通过平台活动接口验证。' };
    }
    await this.configure({ platform, credential });
    return { message: this.sessionVault ? '已保存平台官网会话，可以关闭窗口。上传时会校验会话是否有效。' : '已读取平台官网会话，将在上传时校验。' };
  }

  #ready(id) {
    return id === 'local' || this.#credentials.has(id) || this.#garminAccounts.has(id);
  }

  #scope(id) {
    return regions.has(id) ? this.#garminAccounts.get(id) : id === 'local' ? 'local' : digest(this.#credentials.get(id));
  }

  #stable(id) {
    return id === 'local' || (regions.has(id) && !this.#garminAccounts.get(id)?.startsWith('session:'));
  }

  #require(id) {
    if (!this.#ready(id)) throw new WorkspaceError(409, `请先连接${this.platforms.get(id)?.name || '平台'}。`);
  }

  #route({ source, targets }, requireConnected = false) {
    if (!this.platforms.get(source)?.source) throw new WorkspaceError(400, '请选择已接入的数据来源。');
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > catalog.length || new Set(targets).size !== targets.length ||
        targets.some(target => target === source || !this.platforms.get(target)?.target)) {
      throw new WorkspaceError(400, '请选择至少一个已接入且与来源不同的目标。');
    }
    if (requireConnected) for (const id of [source, ...targets]) this.#require(id);
    return { source, targets };
  }

  async #invalidate(error, platform) {
    if (regions.has(error?.region)) await this.onGarminInvalid(error.region);
    else if (error?.status === 401 && !regions.has(platform)) await this.disconnect({ platform });
  }

  async list({ source, start = 0 }, remember = true) {
    if (!this.platforms.get(source)?.source) throw new WorkspaceError(400, '请选择已接入的数据来源。');
    if (!Number.isSafeInteger(start) || start < 0 || start > 100000) throw new WorkspaceError(400, '分页位置无效。');
    this.#require(source);
    try {
      let result;
      if (source === 'local') {
        const items = this.store.files(start, pageSize + 1);
        result = { activities: items.slice(0, pageSize), nextStart: items.length > pageSize ? start + pageSize : null };
      } else if (regions.has(source)) result = await this.garmin.activities(start, source);
      else result = await this.sources.activities(source, this.#credentials.get(source), start);
      if (!Array.isArray(result?.activities) || result.activities.some(item => !safeId(item?.id)) ||
          (result.nextStart !== null && (!Number.isSafeInteger(result.nextStart) || result.nextStart <= start))) {
        throw new WorkspaceError(502, '来源返回的活动列表或分页格式不正确。');
      }
      if (remember) {
        if (start === 0 || !this.#seen.has(source)) this.#seen.set(source, new Map());
        for (const item of result.activities) this.#seen.get(source).set(item.id, item);
      }
      return result;
    } catch (error) { await this.#invalidate(error, source); throw error; }
  }

  async #download(source, activity) {
    let file;
    if (source === 'local') file = this.store.file(activity.id);
    else if (regions.has(source)) file = await this.garmin.download(source, activity.id);
    else file = await this.sources.download(source, this.#credentials.get(source), activity.id, activity);
    const original = tidyFile(file);
    return { ...original, fileId: this.store.archive(original, activity) };
  }

  async testDownload({ source, id }) {
    this.#require(source);
    const item = this.#seen.get(source)?.get(id);
    if (!item) throw new WorkspaceError(400, '请从已读取的列表选择一条活动。');
    try {
      const { fileId, fileName } = await this.#download(source, item);
      return { fileId, fileName, message: '已下载原始文件。' };
    } catch (error) { await this.#invalidate(error, source); throw error; }
  }

  importFile(file, metadata) {
    const original = tidyFile(file);
    return { fileId: this.store.archive(original, metadata), fileName: original.fileName };
  }

  saveJob(input) {
    const route = this.#route(input);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const { limit, skip, interval } = input;
    if (!name || name.length > 70 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxActivities ||
        !Number.isSafeInteger(skip) || skip < 0 || skip > 1000 || ![0, 15, 30, 60].includes(interval)) {
      throw new WorkspaceError(400, '请填写任务名称、同步数量、跳过数量和检测间隔。');
    }
    const old = input.id && this.store.jobs().find(job => job.id === input.id);
    if (input.id && !old) throw new WorkspaceError(404, '未找到该同步任务。');
    const job = { ...route, id: old?.id || randomUUID(), name, limit, skip, interval,
      nextRun: interval ? Date.now() + interval * 60_000 : null, lastRun: old?.lastRun || null };
    this.store.saveJob(job);
    return job;
  }

  deleteJob({ id }) {
    if (this.#run?.status === 'running' && this.#run.jobId === id) throw new WorkspaceError(409, '请先停止正在运行的任务。');
    this.store.deleteJob(id);
    return { message: '已移除任务。' };
  }

  release({ id }) {
    const entry = typeof id === 'string' && this.store.receipt(id);
    if (!entry || !['sending', 'accepted', 'unconfirmed'].includes(entry.status)) {
      throw new WorkspaceError(409, '只有结果待核对的记录可以手动允许重试。');
    }
    this.store.saveReceipt(id, { ...entry, previousStatus: entry.status, status: 'released', message: '用户核对目标后允许再次发送。' });
    return { message: '已允许下次重传。' };
  }

  start(input) {
    if (this.busy) throw new WorkspaceError(409, '有同步任务正在运行。');
    const job = input.jobId && this.store.jobs().find(item => item.id === input.jobId);
    if (input.jobId && !job) throw new WorkspaceError(404, '未找到该同步任务。');
    const route = this.#route(job || input, true);
    let selected;
    if (!job) {
      const { ids } = input;
      const seen = this.#seen.get(route.source);
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > maxActivities || new Set(ids).size !== ids.length ||
          ids.some(id => !seen?.has(id))) throw new WorkspaceError(400, '请从已读取的列表选择 1–50 条活动。');
      selected = ids.map(id => seen.get(id));
    }
    this.#run = { id: randomUUID(), jobId: job?.id || null, name: job?.name || '手动同步', status: 'running',
      started: new Date().toISOString(), stopRequested: false, confirmed: 0, skipped: 0, failed: 0, unconfirmed: 0, logs: [] };
    this.#pending = this.#execute(route, selected, job).catch(() => {
      this.#run.status = 'failed';
      this.#log('本机存储写入失败。请检查运行记录和目标平台后再试。', 'error');
    }).finally(() => { this.#pending = null; });
    return this.#run;
  }

  async transferSingle(id) {
    const activity = this.#seen.get('cn')?.get(id);
    if (!activity) throw new WorkspaceError(400, '请从已读取的列表选择一条活动。');
    const route = { source: 'cn', targets: ['com'], ids: [id] };
    const entry = this.#entry(route, activity, 'com');
    this.start(route);
    await this.#pending;
    const receipt = this.store.receipt(entry.key);
    if (receipt?.status !== 'confirmed') {
      throw new WorkspaceError(502, receipt?.message || this.#run.logs.at(-1)?.message || '国际区转存尚未确认。');
    }
    return { id, activityId: receipt.activityId, url: receipt.url, message: receipt.message };
  }

  stop() {
    if (this.busy) this.#run.stopRequested = true;
    return { message: '当前请求结束后停止，已发出的上传仍会确认结果。' };
  }

  #log(message, level = 'info') {
    this.#run.logs.push({ time: new Date().toISOString(), message, level });
    if (this.#run.logs.length > 400) this.#run.logs.shift();
  }

  async #selectForJob(job) {
    const items = new Map();
    let start = 0;
    const need = job.skip + job.limit;
    while (items.size < need && start !== null && !this.#run.stopRequested) {
      const page = await this.list({ source: job.source, start }, false);
      for (const activity of page.activities) items.set(activity.id, activity);
      if (page.nextStart > Math.max(need + 200, 400)) {
        this.#log('已达到本轮分页上限，先处理已读取的记录。');
        break;
      }
      start = page.nextStart;
    }
    return [...items.values()].slice(job.skip, need);
  }

  #entry(route, activity, target) {
    const targetAccount = this.#scope(target);
    const key = digest(route.source, this.#scope(route.source), activity.id, target, targetAccount);
    const old = this.store.receipt(key);
    const unstableTarget = !this.#stable(target);
    const unstableIdentity = !this.#stable(route.source) || unstableTarget;
    const blocked = !durable.has(old?.status) && this.store.protectedReceipt(route.source, activity.id, target, key, unstableIdentity);
    return { key, old, blocked, receipt: { source: route.source, sourceId: activity.id,
      target, targetScope: digest('receipt-target', target, targetAccount), unstableTarget,
      unstableIdentity, name: activity.name, status: 'sending', message: '已开始发送，结果待确认。' } };
  }

  async #send(entry, target, file, activity) {
    const { key, receipt, old } = entry;
    if (entry.blocked) {
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：曾用其他连接发送，先在记录中心核对，已跳过。`);
      return 'skipped';
    }
    if (old && durable.has(old.status)) {
      if (regions.has(target) && old.activityId && ['sending', 'accepted', 'unconfirmed'].includes(old.status)) {
        const verified = await this.garmin.confirm(target, old.activityId);
        this.store.saveReceipt(key, { ...old, ...verified, status: 'confirmed', message: '已通过活动编号重新核对。' });
        this.#log(`${activity.name} → ${this.platforms.get(target).name}：已通过活动编号重新核对。`);
        return 'confirmed';
      }
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：${old.status === 'confirmed' || old.status === 'duplicate'
        ? '已有记录，跳过' : '上次上传结果待核对，已拦截重传'}。`);
      return 'skipped';
    }
    if (this.#run.stopRequested) return null;
    if (this.store.protectedFileReceipt(file.fileId, target, receipt.targetScope, receipt.unstableTarget)) {
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：相同原始文件已有发送记录，已跳过。`);
      return 'skipped';
    }
    if (target === 'local') {
      this.store.saveReceipt(key, { ...receipt, fileId: file.fileId, status: 'confirmed', message: '已保存原始文件。' });
      this.#log(`${activity.name}：已保存原始文件。`);
      return 'confirmed';
    }
    const format = file.fileName.split('.').at(-1).toLowerCase();
    const formats = this.platforms.get(target).formats;
    let outbound = file;
    if (String(file.coordinateSystem).toLowerCase().replace(/[-_]/g, '') === 'gcj02') {
      if (format !== 'fit') throw new WorkspaceError(422, '这份 GPX 使用 GCJ-02 坐标。原文件已保留，需要纠偏后再上传。');
      const { correctMageneFit } = await import('./fit-coordinate.mjs');
      file.correctedFit ||= correctMageneFit(file);
      outbound = file.correctedFit;
      this.#log(`${activity.name}：已校正上传文件的坐标，保留原始 FIT。`);
    }
    if (!formats.includes(format)) {
      if (format !== 'gpx' || !formats.includes('fit')) throw new WorkspaceError(422, `${this.platforms.get(target).name}当前不接收 ${format.toUpperCase()} 文件。`);
      const { gpxToFit } = await import('./fit-convert.mjs');
      file.convertedFit ||= gpxToFit(file, activity);
      outbound = file.convertedFit;
      this.#log(`${activity.name}：已生成 FIT 供目标上传，原始 GPX 已保留。`);
    }
    let attempted = false;
    const beforeUpload = () => {
      if (this.#run.stopRequested) throw new WorkspaceError(409, '任务已请求停止。');
      this.store.saveReceipt(key, { ...receipt, fileId: file.fileId });
      attempted = true;
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：开始上传。`);
    };
    try {
      let result;
      if (regions.has(target)) {
        const imported = await this.garmin.upload(target, outbound, {
          beforeUpload,
          onImported: ({ activityId, url }) => {
            this.store.saveReceipt(key, {
              ...receipt, fileId: file.fileId, activityId, url, status: 'unconfirmed', message: '已收到活动编号，等待目标读回。',
            });
            this.#log(`${activity.name} → ${this.platforms.get(target).name}：收到活动编号 ${activityId}，开始回查。`);
          },
        });
        result = { ...imported, status: 'confirmed' };
      } else {
        result = await this.uploads.upload({ platform: target, credential: this.#credentials.get(target),
          data: outbound.data, fileName: outbound.fileName, activity, beforeUpload });
      }
      if (!['confirmed', 'accepted', 'duplicate'].includes(result?.status)) {
        throw new WorkspaceError(502, '上传适配器未返回可确认的状态。');
      }
      this.store.saveReceipt(key, { ...receipt, fileId: file.fileId, status: result.status,
        activityId: result.activityId, url: result.url, message: result.message });
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：${result.message}`);
      return result.status === 'accepted' ? 'unconfirmed' : result.status === 'duplicate' ? 'skipped' : 'confirmed';
    } catch (error) {
      if (!attempted && this.#run.stopRequested) return null;
      if (error.outcome === 'duplicate') {
        this.store.saveReceipt(key, { ...receipt, fileId: file.fileId, status: 'duplicate', message: messageOf(error) });
        this.#log(`${activity.name} → ${this.platforms.get(target).name}：${messageOf(error)}`);
        return 'skipped';
      }
      const previous = this.store.receipt(key);
      const uncertain = attempted && (previous?.activityId || error?.mayHaveUploaded !== false);
      this.store.saveReceipt(key, { ...receipt, fileId: file.fileId, activityId: previous?.activityId, url: previous?.url,
        status: uncertain ? 'unconfirmed' : 'failed', message: messageOf(error) });
      if (uncertain) {
        this.#run.unconfirmed++;
        this.#log(`${activity.name} → ${this.platforms.get(target).name}：${messageOf(error)}`, 'error');
        await this.#invalidate(error, target);
        if ([401, 429].includes(error.status)) this.#run.stopRequested = true;
        return null;
      }
      throw error;
    }
  }

  async #execute(route, selected, job) {
    try {
      const items = selected || await this.#selectForJob(job);
      this.#log(`读取到 ${items.length} 条待处理活动。`);
      let consecutiveDownload406s = 0;
      for (const activity of items) {
        if (this.#run.stopRequested) break;
        let file;
        let downloadError;
        for (const target of route.targets) {
          if (this.#run.stopRequested) break;
          const entry = this.#entry(route, activity, target);
          try {
            if (!entry.blocked && !durable.has(entry.old?.status)) {
              if (!file) {
                if (downloadError) throw downloadError;
                this.#log(`下载原始文件：${activity.name}`);
                const started = performance.now();
                try {
                  file = await this.#download(route.source, activity);
                  consecutiveDownload406s = 0;
                  this.#log(`原始文件已保存 · ${Math.ceil(file.data.length / 1024)} KB · ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
                }
                catch (error) {
                  downloadError = error;
                  consecutiveDownload406s = error.upstreamStatus === 406 ? consecutiveDownload406s + 1 : 0;
                  await this.#invalidate(error, route.source);
                  throw error;
                }
              }
            }
            const outcome = await this.#send(entry, target, file, activity);
            if (outcome) this.#run[outcome]++;
          } catch (error) {
            const pending = entry.old?.activityId && entry.old.status !== 'confirmed';
            this.#run[pending ? 'unconfirmed' : 'failed']++;
            this.#log(`${activity.name} → ${this.platforms.get(target).name}：${messageOf(error)}`, 'error');
            if (consecutiveDownload406s >= 2 && error === downloadError) {
              this.#log('来源连续两次拒绝原始文件下载（HTTP 406），已停止本批任务。', 'error');
              this.#run.stopRequested = true;
            }
            if (error.region || [401, 429].includes(error.status)) {
              if (error !== downloadError) await this.#invalidate(error, target);
              this.#run.stopRequested = true;
            }
          }
        }
      }
      this.#run.status = this.#run.stopRequested ? 'stopped' : 'finished';
    } catch (error) {
      this.#run.status = 'failed';
      this.#log(messageOf(error), 'error');
    } finally {
      this.#run.finished = new Date().toISOString();
      if (job) {
        this.store.saveJob({ ...job, lastRun: this.#run.finished,
          nextRun: job.interval ? Date.now() + job.interval * 60_000 : null });
      }
      this.store.saveRun(this.#run);
    }
  }

  schedule() {
    this.#timer = setInterval(() => {
      if (this.busy || this.isBusy()) return;
      const job = this.store.jobs().find(item => item.nextRun && item.nextRun <= Date.now() &&
        [item.source, ...item.targets].every(id => this.#ready(id)));
      if (job) this.start({ jobId: job.id });
    }, 15_000);
    this.#timer.unref();
  }

  async close() {
    clearInterval(this.#timer);
    this.stop();
    await this.#pending;
    await this.platformLogin?.close();
    this.store.close();
  }
}
