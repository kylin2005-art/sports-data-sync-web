import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { WorkspaceError } from './sync-workspace.mjs';
import { readRideSummary } from './tracks.mjs';

const VERSION = 1;
const PAGE_SIZE = 20;
const builds = new WeakMap();
const fields = [
  ['Distance', 'distanceM', '距离', 1000],
  ['Ascent', 'ascentM', '累计爬升', 1],
  ['Speed', 'avgSpeedMps', '平均速度', 1 / 3.6],
  ['Power', 'avgPowerW', '平均功率', 1],
];

function parameter(params, key, message) {
  const values = params.getAll(key);
  if (values.length > 1) throw new WorkspaceError(400, message);
  return values[0] ?? null;
}

function dateBound(params, key) {
  const message = '轨迹日期范围无效。';
  const input = parameter(params, key, message);
  if (input === null) return null;
  const value = Date.parse(input);
  if (!Number.isFinite(value) || new Date(value).toISOString() !== input) throw new WorkspaceError(400, message);
  return value;
}

function metricBound(params, key, label) {
  const message = `${label}范围无效，请输入非负数。`;
  const input = parameter(params, key, message);
  if (input === null) return null;
  const value = Number(input);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input) || !Number.isFinite(value)) throw new WorkspaceError(400, message);
  return value;
}

function filtersFrom(params) {
  const from = dateBound(params, 'from'), before = dateBound(params, 'before');
  if (from !== null && before !== null && from >= before) throw new WorkspaceError(400, '开始日期不能晚于结束日期。');
  const ranges = [];
  for (const [key, metric, label, multiplier] of fields) {
    const min = metricBound(params, 'min' + key, label), max = metricBound(params, 'max' + key, label);
    if (min === null && max === null) continue;
    if (min !== null && max !== null && min > max) throw new WorkspaceError(400, `${label}下限不能大于上限。`);
    const lower = min === null ? null : min * multiplier, upper = max === null ? null : max * multiplier;
    if (lower === Infinity || upper === Infinity) throw new WorkspaceError(400, `${label}范围过大。`);
    ranges.push([metric, lower, upper]);
  }
  return { from, before, ranges };
}

function summarize(file) {
  const summary = readRideSummary(file, { includeEstimates: true });
  const { time, created } = file;
  const activityTime = typeof time === 'string' && time !== created &&
    /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(time) && Number.isFinite(Date.parse(time)) ? time : null;
  return { startTime: summary?.startTime ?? activityTime, metrics: summary?.metrics ?? null, estimated: summary?.estimated ?? [] };
}

async function indexArchive(store) {
  const ids = store.unindexedTrackFiles(VERSION);
  for (let offset = 0; offset < ids.length; offset += 8) {
    await yieldToRequests();
    const entries = [];
    for (const id of ids.slice(offset, offset + 8)) {
      if (store.trackSummary(id, VERSION)) continue;
      const file = store.file(id);
      if (file) entries.push([id, summarize(file)]);
    }
    if (entries.length) store.saveTrackSummaries(VERSION, entries);
  }
}

export function buildTrackSummaryIndex(store) {
  let build = builds.get(store);
  if (!build) {
    build = indexArchive(store).finally(() => builds.delete(store));
    builds.set(store, build);
  }
  return build;
}

export async function readTrackLibrary(store, params) {
  const message = '轨迹列表分页位置无效。';
  const offset = parameter(params, 'start', message) ?? '0';
  const start = Number(offset);
  if (!/^\d+$/.test(offset) || !Number.isSafeInteger(start)) throw new WorkspaceError(400, message);
  const filters = filtersFrom(params);
  const filtered = filters.from !== null || filters.before !== null || filters.ranges.length > 0;
  let files, total;
  if (filtered) {
    await buildTrackSummaryIndex(store);
    ({ files, total } = store.filteredTrackPage(VERSION, start, PAGE_SIZE, filters));
  } else {
    const page = store.trackLibraryPage(start, PAGE_SIZE);
    total = page.total;
    files = [];
    for (const file of page.files) {
      let summary = store.trackSummary(file.id, VERSION);
      if (!summary) {
        await yieldToRequests();
        summary = store.trackSummary(file.id, VERSION);
        if (!summary) {
          const original = store.file(file.id);
          if (!original) continue;
          summary = summarize(original);
          store.saveTrackSummaries(VERSION, [[file.id, summary]]);
        }
      }
      files.push({ ...file, ...summary });
    }
  }
  const rows = files.map(({ id, name, fileName, startTime, metrics, estimated }) =>
    ({ id, name, fileName, startTime, metrics, estimated }));
  const next = start + rows.length;
  return { files: rows, total, nextStart: next < total ? next : null };
}
