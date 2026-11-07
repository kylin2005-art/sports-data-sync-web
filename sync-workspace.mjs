import { randomUUID } from 'node:crypto';
import { createIntervalsWorkouts, WORKOUT_TARGETS } from './intervals-workouts.mjs';
import { digest } from './sync-store.mjs';

const regions = new Set(['cn', 'com']);
const pageSize = 20;
const maxActivities = 50;
const safeId = id => typeof id === 'string' && /^[\w.:-]{1,160}$/.test(id);
const pagedJob = job => job?.mode === 'all' || job?.mode === 'incremental';
const activityTimestamp = value => typeof value === 'string' && /[T ].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  ? Date.parse(value) : NaN;
const awaitingConfirmation = new Set(['sending', 'accepted', 'unconfirmed']);
const durable = new Set([...awaitingConfirmation, 'confirmed', 'duplicate', 'guided']);
const sportKey = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/[ _-]+/g, '') : '';
const cyclingSports = new Set([
  'cycling', 'biking', 'road_biking', 'mountain_biking', 'downhill_biking', 'indoor_cycling',
  'gravel_cycling', 'virtual_cycling', 'virtual_biking', 'track_cycling', 'cyclocross', 'bmx', 'e_bike_fitness', 'e_bike_mountain',
  'handcycling', 'indoor_handcycling', 'ride', 'virtual_ride', 'mountain_bike_ride', 'gravel_ride', 'e_bike_ride',
  'e_mountain_bike_ride', 'track_ride', 'handcycle', 'velomobile', '骑行', '公路骑行', '山地骑行', '室内骑行',
].map(sportKey));
const sourceSportRequired = new Set(['zwift', 'mywhoosh', 'bryton']);
const suuntoCyclingSports = new Set(['mtb', 'gravel', 'spinning']);
const corosCyclingSports = new Set([200, 201, 203, 204]);

function sportGroup(source, activity) {
  if (source === 'coros_cn' || source === 'coros_int') {
    if (corosCyclingSports.has(activity.sportCode)) return 'cycling';
    if (activity.sportCode === 100) return 'other';
  }
  // These adapters used a fixed cycling label even for platforms with other sports.
  const sport = sportKey(sourceSportRequired.has(source) ? activity.sport : activity.type);
  if (cyclingSports.has(sport) || (regions.has(source) && sport === 'commuting') ||
      (source === 'suunto' && suuntoCyclingSports.has(sport))) return 'cycling';
  return otherSports.has(sport) ? 'other' : 'unknown';
}
const otherSports = new Set([
  'running', 'run', 'trail_running', 'trail_run', 'treadmill_running', 'track_running', 'virtual_running',
  'virtual_run', 'walking', 'walk', 'hiking', 'hike', 'swimming', 'swim', 'lap_swimming', 'open_water_swimming',
  'strength_training', 'weight_training', 'yoga', 'pilates', 'rowing', 'indoor_rowing', 'elliptical', 'triathlon',
  'multisport', 'skiing', 'golf', 'cardio_training', '跑步', '徒步', '步行', '游泳', '力量训练',
].map(sportKey));

export const isKnownOtherSport = value => otherSports.has(sportKey(value));

const catalog = [
  ['cn', '佳明中国', true, true], ['com', '佳明国际', true, true],
  ['igpsport', 'iGPSPORT 中国', true, true], ['igpsport_int', 'iGPSPORT 国际', true, true], ['xingzhe', '行者', true, true],
  ['magene', '迈金', true, true], ['blackbird', '黑鸟单车', true, true],
  ['bryton', '百锐腾', true, false], ['giant', '捷安特', false, true],
  ['outbase', 'Outbase', false, true], ['coros_cn', '高驰中国', true, true],
  ['coros_int', '高驰国际', true, true], ['wahoo', 'Wahoo', true, true],
  ['intervals_icu', 'Intervals.icu', true, true], ['keep', 'Keep', true, true],
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
  #accountChecks = new Map();
  #garminAccounts = new Map();
  #seen = new Map();
  #run = null;
  #pending = null;
  #timer;
  #saved = { garmin: {}, credentials: {} };

  constructor({ garmin, store, uploads, sources, platformLogin, platformPasswords, browserPlatforms = [], sessionVault, sessionData,
    isBusy = () => false, onGarminInvalid, workouts = createIntervalsWorkouts() }) {
    Object.assign(this, { garmin, store, uploads, sources, platformLogin, platformPasswords, sessionVault, isBusy, workouts });
    this.onGarminInvalid = onGarminInvalid || (region => this.clearGarmin(region));
    this.#run = store.lastRun();
    const sourceSpecs = new Map(sources.definitions.map(def => [def.id, def]));
    const targetSpecs = new Map(uploads.definitions.map(def => [def.id, def]));
    this.platforms = new Map(catalog.map(([id, name, upstreamSource, upstreamTarget]) => {
      const source = sourceSpecs.get(id);
      const target = targetSpecs.get(id);
      const garmin = regions.has(id);
      const guided = id === 'keep';
      const signInFields = platformPasswords?.fields(id);
      return [id, {
        id, name, upstreamSource, upstreamTarget, source: Boolean(source || garmin || id === 'local'),
        target: Boolean(target || garmin || guided || id === 'local'), guided, auth: garmin ? 'garmin' : id === 'local' ? 'local' : 'credential',
        browserLogin: Boolean(platformLogin?.supports(id)),
        ...(signInFields?.length ? { signInFields } : {}),
        ...(browserPlatforms.includes(id) ? { browserImport: true } : {}),
        formats: garmin ? this.garmin.uploadFormats || ['fit', 'gpx'] : guided ? ['fit'] : id === 'local' ? ['fit', 'gpx'] : (target?.formats || []),
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
    this.#accountChecks.delete(region);
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
        check: this.#accountChecks.get(platform.id),
        state: this.#accountChecks.get(platform.id) === 'expired' ? 'expired' : regions.has(platform.id) ? (this.hasSavedGarmin(platform.id) ? 'saved'
          : this.hasGarmin(platform.id) ? 'verified' : 'disconnected')
          : platform.id === 'local' ? 'ready' : this.#credentials.has(platform.id)
            ? (this.#saved.credentials[platform.id] ? 'saved' : this.#verifiedOther.has(platform.id) ? 'verified' : 'configured') : 'disconnected',
      })),
      jobs: this.store.jobs(), run: this.#run, history: this.store.history(), files: this.store.files(0, 50),
      workoutTargets: WORKOUT_TARGETS.filter(id => this.platforms.get(id)?.fields.length),
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
    this.#accountChecks.delete(platform);
    this.#verifiedOther.delete(platform);
    this.#seen.delete(platform);
    return { message: this.sessionVault ? '连接凭据已加密保存，实际读取或上传时校验。' : '凭据已暂存，实际读取或上传时校验。' };
  }

  async signIn({ platform, fields }) {
    const spec = this.platforms.get(platform);
    if (!spec?.signInFields?.length) throw new WorkspaceError(400, '请选择支持账号登录的平台。');
    const { credential, verified } = await this.platformPasswords.signIn(platform, fields);
    return this.#connectVerified(spec, credential, verified);
  }

  async connectBrowser({ platform, credential }) {
    const spec = this.platforms.get(platform);
    if (!spec?.browserImport) throw new WorkspaceError(400, '请选择支持网页登录的平台。');
    return this.#connectVerified(spec, credential);
  }

  async #connectVerified(spec, credential, verified) {
    const platform = spec.id;
    const data = this.#normalizeCredential(platform, credential);
    const verifySource = spec.source && typeof this.sources.verify === 'function';
    if (verifySource) await this.sources.verify(platform, data);
    await this.configure({ platform, credential: data });
    if (verifySource || verified === true) {
      this.#verifiedOther.add(platform);
      return { message: `${spec.name}已通过登录验证。` };
    }
    return { message: `${spec.name}已连接，首次上传时会校验授权。` };
  }

  async disconnect({ platform }) {
    this.#credentials.delete(platform);
    this.#accountChecks.delete(platform);
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
    return this.#accountChecks.get(id) !== 'expired' &&
      (id === 'local' || this.#credentials.has(id) || this.#garminAccounts.has(id));
  }

  async checkAccounts() {
    const check = async (id, verify) => {
      let status = 'unsupported';
      if (verify) {
        try { await verify(); status = 'valid'; }
        catch (error) {
          status = error?.status === 401 || this.#accountChecks.get(id) === 'expired' ? 'expired' : 'unknown';
        }
      }
      return [id, status];
    };
    const other = Promise.all([...this.#credentials].map(([id, credential]) => check(id,
      this.platforms.get(id)?.source && this.sources.verify ? () => this.sources.verify(id, credential) : null)));
    const garmin = [];
    // A token refresh can save credentials. Serialize Garmin checks so their vault writes do not overlap.
    for (const region of this.#garminAccounts.keys()) {
      garmin.push(await check(region, () => this.garmin.verify(region)));
    }
    const results = [...garmin, ...await other];
    this.#accountChecks = new Map(results);
    const totals = { valid: 0, expired: 0, unknown: 0, unsupported: 0 };
    for (const [, status] of results) totals[status]++;
    return { ...totals, message: results.length ?
      `平台账号检查完成 · 有效 ${totals.valid} · 需重新连接 ${totals.expired} · 暂无法核验 ${totals.unknown} · 使用时校验 ${totals.unsupported}` :
      '平台账号检查完成，当前没有已保存的连接。' };
  }

  #targetReady(id) {
    return this.platforms.get(id)?.guided || this.#ready(id);
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
    if (requireConnected) {
      this.#require(source);
      for (const id of targets) if (!this.platforms.get(id).guided) this.#require(id);
    }
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

  async guidedFit(id) {
    const receipt = this.store.receipt(id);
    const file = receipt?.status === 'guided' && receipt.target === 'keep' && this.store.file(receipt.fileId);
    if (!file) throw new WorkspaceError(404, '找不到待导入 Keep 的文件。');
    if (/\.gpx$/i.test(file.fileName)) return (await import('./fit-convert.mjs')).gpxToFit(file, file);
    if (String(file.coordinateSystem).toLowerCase().replace(/[-_]/g, '') === 'gcj02') {
      return (await import('./fit-coordinate.mjs')).correctMageneFit(file);
    }
    return file;
  }

  listWorkouts(input) {
    this.#require('intervals_icu');
    return this.workouts.list(this.#credentials.get('intervals_icu'), input);
  }

  downloadWorkout(id) {
    this.#require('intervals_icu');
    return this.workouts.download(this.#credentials.get('intervals_icu'), { id });
  }

  async publishWorkout({ platform, id, oldest, newest }) {
    if (!WORKOUT_TARGETS.includes(platform) || !safeId(id)) throw new WorkspaceError(400, '请选择课表与支持推送的设备平台。');
    this.#require('intervals_icu');
    this.#require(platform);
    const key = digest('intervals-workout', platform, id);
    const old = this.store.workoutReceipt(key);
    if (old && old.status !== 'failed') return { ...old, message: old.status === 'confirmed' ? '这份课表已有推送回执，已跳过。' : '上次推送结果待核对，已拦截重传。' };
    let attempted = false;
    const save = result => { this.store.saveWorkoutReceipt(key, result); return result; };
    try {
      const result = await this.workouts.publish({ platform, id, oldest, newest,
        apiKey: this.#credentials.get('intervals_icu').apiKey, credential: this.#credentials.get(platform),
        beforeUpload: () => { save({ status: 'sending' }); attempted = true; },
        onImported: ({ workoutId }) => save({ status: 'unconfirmed', workoutId }),
      });
      return save(result);
    } catch (error) {
      if (attempted && error.mayHaveUploaded !== false) {
        return save({ ...this.store.workoutReceipt(key), status: 'unconfirmed', message: '课表推送结果待核对，请先查看目标平台。' });
      }
      if (attempted) save({ status: 'failed', message: messageOf(error) });
      throw error;
    }
  }

  saveJob(input) {
    const route = this.#route(input);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const { limit, skip, interval } = input;
    const mode = input.mode ?? (limit !== undefined || skip !== undefined ? 'recent' : 'all');
    const activityType = input.activityType ?? 'all';
    if (!name || name.length > 70 || !['all', 'recent', 'incremental'].includes(mode) || ![0, 15, 30, 60].includes(interval) ||
        !['all', 'cycling'].includes(activityType) || (mode === 'recent' && activityType !== 'all') ||
        (mode === 'recent' && (!Number.isSafeInteger(limit) || limit < 1 || limit > maxActivities ||
          !Number.isSafeInteger(skip) || skip < 0 || skip > 1000))) {
      throw new WorkspaceError(400, '请检查任务名称、同步范围和检测间隔。');
    }
    const old = input.id && this.store.jobs().find(job => job.id === input.id);
    if (input.id && !old) throw new WorkspaceError(404, '未找到该同步任务。');
    if (old && this.busy && this.#run.jobId === old.id) throw new WorkspaceError(409, '请先停止正在运行的任务。');
    for (const target of route.targets) {
      if (!old?.targets.includes(target)) this.#require(target);
    }
    const sameRoute = old?.source === route.source && (old.activityType ?? 'all') === activityType &&
      old.targets.length === route.targets.length &&
      old.targets.every(target => route.targets.includes(target));
    const paused = old?.paused === true;
    const job = { ...route, id: old?.id || randomUUID(), name, mode, activityType, interval,
      ...(paused && { paused }),
      nextRun: !paused && interval ? Date.now() + interval * 60_000 : null, lastRun: old?.lastRun || null };
    if (mode === 'recent') Object.assign(job, { limit, skip });
    if (mode === 'all') job.historyScannedAt = sameRoute ? old.historyScannedAt || null : null;
    if (mode === 'incremental') {
      const keepStart = old?.mode === 'incremental' && old.source === route.source && Number.isFinite(activityTimestamp(old.incrementalSince));
      job.incrementalSince = keepStart ? old.incrementalSince : new Date().toISOString();
    }
    this.store.saveJob(job);
    return job;
  }

  setJobPaused({ id, paused }) {
    if (typeof paused !== 'boolean') throw new WorkspaceError(400, '请选择暂停或恢复任务。');
    const job = this.store.jobs().find(item => item.id === id);
    if (!job) throw new WorkspaceError(404, '未找到该同步任务。');
    const stopping = this.busy && this.#run.jobId === id;
    if (!paused && job.paused && stopping) throw new WorkspaceError(409, '当前同步正在结束，请稍后恢复任务。');
    if ((job.paused === true) !== paused) {
      this.store.saveJob({ ...job, paused, nextRun: !paused && job.interval ? Date.now() + job.interval * 60_000 : null });
    }
    if (paused && stopping) this.stop();
    return { message: paused ? (stopping ? '任务已暂停，当前请求结束后停止同步。' : '任务已暂停。') : '任务已恢复。' };
  }

  deleteJob({ id }) {
    if (this.#run?.status === 'running' && this.#run.jobId === id) throw new WorkspaceError(409, '请先停止正在运行的任务。');
    this.store.deleteJob(id);
    return { message: '已移除任务。' };
  }

  release({ id }) {
    const entry = typeof id === 'string' && this.store.receipt(id);
    if (!entry || !awaitingConfirmation.has(entry.status)) {
      throw new WorkspaceError(409, '只有结果待核对的记录可以手动允许重试。');
    }
    this.store.saveReceipt(id, { ...entry, previousStatus: entry.status, status: 'released', message: '用户核对目标后允许再次发送。' });
    return { message: '已允许下次重传。' };
  }

  async confirmReceipt({ id }) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new WorkspaceError(400, '回执编号无效。');
    const entry = this.store.receipt(id);
    if (!entry) throw new WorkspaceError(404, '找不到该同步回执。');
    const { target, source, sourceId, targetScope, status } = entry;
    if (!regions.has(target) || !/^[1-9]\d{0,19}$/.test(entry.activityId) ||
        (!awaitingConfirmation.has(status) && status !== 'confirmed')) {
      throw new WorkspaceError(409, '只有带目标活动 ID 的佳明回执可以回查。');
    }
    this.#require(target);
    const targetAccount = this.#scope(target);
    const matches = targetScope ? targetScope === digest('receipt-target', target, targetAccount)
      : this.#ready(source) && id === digest(source, this.#scope(source), sourceId, target, targetAccount);
    if (!this.#stable(target) || !matches) {
      throw new WorkspaceError(409, `请连接生成这条回执时使用的${this.platforms.get(target).name}账号，再回查。`);
    }
    if (status === 'confirmed') return { message: '这条活动已经确认。' };
    return this.#confirmReceipt(id, entry);
  }

  async #confirmReceipt(id, entry) {
    const verified = await this.garmin.confirm(entry.target, entry.activityId);
    if (verified?.activityId !== entry.activityId) throw new WorkspaceError(502, '目标活动 ID 不匹配，回执仍待核对。');
    const message = '已通过活动编号重新核对。';
    this.store.saveReceipt(id, { ...entry, ...verified, status: 'confirmed', message });
    return { message };
  }

  start(input) { return this.#start(input); }

  verifyGarminReplay({ id, receiptId, targetActivityId }) {
    if (!safeId(id) || typeof receiptId !== 'string' || !/^[a-f0-9]{64}$/.test(receiptId) ||
        typeof targetActivityId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetActivityId)) {
      throw new WorkspaceError(400, '请提供国区活动 ID、已确认回执编号和国际区活动 ID。');
    }
    return this.#start({ source: 'cn', targets: ['com'], ids: [id] }, { receiptId, targetActivityId });
  }

  #start(input, verification) {
    if (this.busy) throw new WorkspaceError(409, '有同步任务正在运行。');
    const job = input.jobId && this.store.jobs().find(item => item.id === input.jobId);
    if (input.jobId && !job) throw new WorkspaceError(404, '未找到该同步任务。');
    if (job?.paused) throw new WorkspaceError(409, '请先恢复已暂停的任务。');
    const connectedOnly = job && input.connectedOnly === true;
    const route = this.#route(job || input, !connectedOnly);
    let omittedTargets = [];
    if (connectedOnly) {
      this.#require(route.source);
      omittedTargets = route.targets.filter(target => !this.#targetReady(target));
      route.targets = route.targets.filter(target => !omittedTargets.includes(target));
      if (!route.targets.length) throw new WorkspaceError(409, '请先连接至少一个同步目标。');
    }
    let selected;
    if (!job) {
      const { ids } = input;
      const seen = this.#seen.get(route.source);
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > maxActivities || new Set(ids).size !== ids.length ||
          ids.some(id => !seen?.has(id))) throw new WorkspaceError(400, '请从已读取的列表选择 1–50 条活动。');
      selected = ids.map(id => seen.get(id));
    }
    this.#run = { id: randomUUID(), jobId: job?.id || null, name: job?.name || (verification ? '重启去重验收' : '手动同步'), status: 'running',
      started: new Date().toISOString(), stopRequested: false, confirmed: 0, skipped: 0, failed: 0, unconfirmed: 0, guided: 0,
      ...(omittedTargets.length && { omittedTargets }),
      ...(pagedJob(job) && { activityType: job.activityType ?? 'all', scanned: 0, matched: 0, unclassified: 0 }),
      ...(job?.mode === 'incremental' && { outsideIncrement: 0, missingTime: 0 }),
      logs: [] };
    this.#pending = this.#execute(route, selected, job, verification).catch(() => {
      this.#run.status = 'failed';
      const message = '本机存储写入失败。请检查运行记录和目标平台后再试。';
      this.#recordIssue(new WorkspaceError(503, message), 'storage');
      this.#log(message, 'error');
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

  #recordIssue(error, stage, platform) {
    this.#run.issue = { stage, platform, status: error?.upstreamStatus ?? error?.status, message: messageOf(error) };
  }

  async #selectForJob(job) {
    const items = new Map();
    let start = 0;
    const need = job.skip + job.limit;
    while (items.size < need && start !== null && !this.#run.stopRequested) {
      let page;
      try { page = await this.list({ source: job.source, start }, false); }
      catch (error) { this.#recordIssue(error, 'list', job.source); throw error; }
      for (const activity of page.activities) items.set(activity.id, activity);
      if (page.nextStart > Math.max(need + 200, 400)) {
        this.#log('已达到本轮分页上限，先处理已读取的记录。');
        break;
      }
      start = page.nextStart;
    }
    return [...items.values()].slice(job.skip, need);
  }

  async *#scanHistory(source, since) {
    const seen = new Set();
    const native = source === 'blackbird' && this.sources.historyPage;
    const cursors = new Set();
    for (let position = native ? '' : 0; position !== null && !this.#run.stopRequested;) {
      let page;
      try {
        if (native) {
          this.#require(source);
          try { page = await this.sources.historyPage(source, this.#credentials.get(source), position || null); }
          catch (error) { await this.#invalidate(error, source); throw error; }
          if (!Array.isArray(page?.activities) || page.activities.some(item => !safeId(item?.id)) ||
              (page.nextCursor !== null && (!safeId(page.nextCursor) || cursors.has(page.nextCursor)))) {
            throw new WorkspaceError(502, '来源返回的历史列表或游标不正确。');
          }
          cursors.add(page.nextCursor);
        } else {
          page = await this.list({ source, start: position }, false);
        }
      } catch (error) {
        this.#recordIssue(error, 'list', source);
        throw error;
      }
      for (const activity of page.activities) {
        // The local store orders by import time. Remote lists may be out of order.
        if (source === 'local' && since !== undefined && activityTimestamp(activity.created) < since) return;
        if (seen.has(activity.id)) continue;
        seen.add(activity.id);
        yield activity;
      }
      position = native ? page.nextCursor : page.nextStart;
    }
  }

  #entry(route, activity, target) {
    const guided = this.platforms.get(target).guided;
    const sourceAccount = this.#scope(route.source);
    const targetAccount = guided ? 'guided' : this.#scope(target);
    const key = digest(route.source, sourceAccount, activity.id, target, targetAccount);
    const old = this.store.receipt(key);
    const unstableTarget = !guided && !this.#stable(target);
    const unstableIdentity = !this.#stable(route.source) || unstableTarget;
    const blocked = !durable.has(old?.status) && this.store.protectedReceipt(route.source, activity.id, target, key, unstableIdentity);
    const reverse = !guided && !durable.has(old?.status) && this.store.importedFrom(route.source, activity.id, sourceAccount, target, targetAccount);
    return { key, old, blocked, reverse, receipt: { source: route.source, sourceId: activity.id,
      target, targetScope: digest('receipt-target', target, targetAccount), unstableTarget,
      unstableIdentity, name: activity.name, status: 'sending', message: '已开始发送，结果待确认。' } };
  }

  async #send(entry, target, file, activity) {
    const { key, receipt, old } = entry;
    if (entry.reverse) {
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：已有回执表明来自该账号，已跳过回传。`);
      return 'skipped';
    }
    if (entry.blocked) {
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：曾用其他连接发送，先在同步记录核对，已跳过。`);
      return 'skipped';
    }
    if (old && durable.has(old.status)) {
      const pending = awaitingConfirmation.has(old.status);
      if (regions.has(target) && old.activityId && pending) {
        const { message } = await this.#confirmReceipt(key, old);
        this.#log(`${activity.name} → ${this.platforms.get(target).name}：${message}`, 'success');
        return 'confirmed';
      }
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：${pending
        ? '上次上传结果待核对，已拦截重传' : '已有记录，跳过'}。`, pending ? 'pending' : 'info');
      return 'skipped';
    }
    if (this.#run.stopRequested) return null;
    if (this.store.protectedFileReceipt(file.fileId, target, receipt.targetScope, receipt.unstableTarget)) {
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：相同原始文件已有发送记录，已跳过。`);
      return 'skipped';
    }
    if (target === 'local') {
      this.store.saveReceipt(key, { ...receipt, fileId: file.fileId, status: 'confirmed', message: '已保存原始文件。' });
      this.#log(`${activity.name}：已保存原始文件。`, 'success');
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
    if (this.platforms.get(target).guided) {
      const { validFit } = await import('./garmin-browser.mjs');
      if (!validFit(outbound.data)) throw new WorkspaceError(422, 'FIT 完整性校验失败，无法准备 Keep 导入。');
      this.store.saveReceipt(key, { ...receipt, fileId: file.fileId, status: 'guided',
        message: '请下载 FIT，在手机 Keep App 的「运动数据文件导入」中选择文件。' });
      this.#log(`${activity.name} → Keep：FIT 已准备好，请在同步记录下载并手动导入。`);
      return 'guided';
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
          beforeUpload, activity,
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
      const level = result.status === 'confirmed' ? 'success' : result.status === 'accepted' ? 'pending' : 'info';
      this.#log(`${activity.name} → ${this.platforms.get(target).name}：${result.message}`, level);
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
        this.#recordIssue(error, previous?.activityId ? 'confirm' : 'upload', target);
        this.#log(`${activity.name} → ${this.platforms.get(target).name}：${messageOf(error)}`, 'pending');
        await this.#invalidate(error, target);
        if ([401, 429].includes(error.status)) this.#run.stopRequested = true;
        return null;
      }
      throw error;
    }
  }

  async #execute(route, selected, job, verification) {
    const fullHistory = job?.mode === 'all';
    const incremental = job?.mode === 'incremental';
    const since = incremental ? activityTimestamp(job.incrementalSince) : undefined;
    try {
      if (this.#run.omittedTargets) {
        this.#log(`本次只同步已连接目标。未连接：${this.#run.omittedTargets.map(target => this.platforms.get(target).name).join('、')}。`);
      }
      if (incremental && !Number.isFinite(since)) throw new WorkspaceError(400, '仅增量任务缺少有效的启用时间，请重新保存。');
      const items = pagedJob(job) ? this.#scanHistory(route.source, since) : selected || await this.#selectForJob(job);
      if (incremental) this.#log('仅增量：只处理任务启用后的活动，已有回执会跳过。');
      else if (fullHistory) this.#log(job.historyScannedAt ? '增量同步：检查来源列表，已有回执的活动不会重传。'
        : '首次同步：逐页读取全部历史活动，已有回执的活动不会重传。');
      else this.#log(`读取到 ${items.length} 条待处理活动。`);
      let consecutiveDownload406s = 0;
      for await (const activity of items) {
        if (this.#run.stopRequested) break;
        if (pagedJob(job)) {
          this.#run.scanned++;
          if (incremental) {
            const time = activityTimestamp(route.source === 'local' ? activity.created : activity.time);
            if (!Number.isFinite(time)) { this.#run.missingTime++; continue; }
            if (time < since) { this.#run.outsideIncrement++; continue; }
          }
          const sport = sportGroup(route.source, activity);
          if (sport === 'unknown') this.#run.unclassified++;
          if (this.#run.activityType === 'cycling' && sport !== 'cycling') continue;
          this.#run.matched++;
        }
        let file;
        let downloadError;
        for (const target of route.targets) {
          if (this.#run.stopRequested) break;
          const entry = this.#entry(route, activity, target);
          if (verification && (entry.key !== verification.receiptId || entry.old?.status !== 'confirmed' ||
              entry.old.activityId !== verification.targetActivityId)) {
            this.#run.failed++;
            const error = new WorkspaceError(409, '当前账号下没有与预期国际区活动 ID 一致的已确认回执。验收已停止。');
            this.#recordIssue(error, 'confirm', target);
            throw error;
          }
          try {
            if (!entry.blocked && !entry.reverse && !durable.has(entry.old?.status)) {
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
            if (this.#run.stopRequested) break;
            const outcome = await this.#send(entry, target, file, activity);
            if (outcome) this.#run[outcome]++;
          } catch (error) {
            const pending = entry.old?.activityId && entry.old.status !== 'confirmed';
            this.#run[pending ? 'unconfirmed' : 'failed']++;
            if (error === downloadError) this.#recordIssue(error, 'download', route.source);
            else this.#recordIssue(error, pending ? 'confirm' : 'upload', target);
            this.#log(`${activity.name} → ${this.platforms.get(target).name}：${messageOf(error)}`, pending ? 'pending' : 'error');
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
      if (!this.#run.issue) this.#recordIssue(error, 'sync');
      this.#log(messageOf(error), 'error');
    } finally {
      this.#run.finished = new Date().toISOString();
      if (fullHistory) {
        const { status, activityType, scanned, matched, unclassified } = this.#run;
        const outcome = status === 'finished' ? '完成' : status === 'stopped' ? '已停止' : '中断';
        const unknown = activityType === 'cycling' && unclassified ? `，跳过运动类型未识别的 ${unclassified} 条` : '';
        this.#log(`历史扫描${outcome}：已检查 ${scanned} 条，符合范围 ${matched} 条${unknown}。`);
      } else if (incremental) {
        const { scanned, matched, outsideIncrement, missingTime } = this.#run;
        const skipped = missingTime ? `，跳过时间不明确的 ${missingTime} 条` : '';
        this.#log(`仅增量：已检查 ${scanned} 条，符合范围 ${matched} 条，排除启用前 ${outsideIncrement} 条${skipped}。`);
      }
      if (job && !this.#run.omittedTargets) {
        const saved = this.store.jobs().find(item => item.id === job.id);
        if (saved) {
          const historyScannedAt = saved.mode === 'all' && !saved.historyScannedAt && this.#run.status === 'finished' ? this.#run.finished : saved.historyScannedAt;
          this.store.saveJob({ ...saved, ...(saved.mode === 'all' && { historyScannedAt }), lastRun: this.#run.finished,
            nextRun: !saved.paused && saved.interval ? Date.now() + saved.interval * 60_000 : null });
        }
      }
      this.store.saveRun(this.#run);
    }
  }

  schedule() {
    this.#timer = setInterval(() => {
      if (this.busy || this.isBusy()) return;
      const job = this.store.jobs().find(item => !item.paused && item.nextRun && item.nextRun <= Date.now() &&
        this.#ready(item.source) && item.targets.every(id => this.#targetReady(id)));
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
