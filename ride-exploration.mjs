import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { WorkspaceError } from './sync-workspace.mjs';
import { readRideExplorationTrack } from './tracks.mjs';

const CELL_METERS = 500;
// Bump when the grid or track eligibility rules change.
const INDEX_VERSION = 1;
const RADIANS = Math.PI / 180;
const RADIUS = 6378137;
const timeMs = value => value ? Date.parse(value) : NaN;
const cellPair = key => key.split(',').map(Number);

function readCells(file) {
  const { startTime, segments } = readRideExplorationTrack(file);
  const cells = new Set();
  for (const segment of segments) for (const { lat, lon } of segment) {
    if (Math.abs(lat) > 85.05112878 || (lat === 0 && lon === 0)) continue;
    const x = Math.floor(RADIUS * (lon === 180 ? -180 : lon) * RADIANS / CELL_METERS);
    const y = Math.floor(RADIUS * Math.asinh(Math.tan(lat * RADIANS)) / CELL_METERS);
    cells.add(`${x},${y}`);
  }
  const time = timeMs(startTime ?? (file.time === file.created ? null : file.time));
  return { cells: [...cells], time: Number.isFinite(time) ? time : null };
}

function indexFile(store, id) {
  // Another request may have indexed this file while this scan yielded.
  const indexed = store.rideExploration(id, INDEX_VERSION);
  if (indexed) return indexed;
  const file = store.file(id);
  if (!file) throw new WorkspaceError(404, '活动文件不存在，请刷新文件列表。');
  let entry;
  try { entry = readCells(file); }
  catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    entry = { error: error.message };
  }
  // Write each result separately so an interrupted scan can resume.
  store.saveRideExploration(id, INDEX_VERSION, entry);
  return entry;
}

export async function buildRideExplorationIndex(store) {
  const pending = store.unindexedRideFiles(INDEX_VERSION);
  for (let i = 0; i < pending.length; i++) {
    if (i % 8 === 0) await yieldToRequests();
    indexFile(store, pending[i]);
  }
}

export async function rideExplorationMonth(store, month, timeZone = 'UTC') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1970-01') {
    throw new WorkspaceError(400, '请选择有效的活动月份。');
  }
  let calendar;
  try {
    calendar = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit' });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new WorkspaceError(400, '月份时区无效。');
  }
  await buildRideExplorationIndex(store);
  const visits = new Map();
  let rideCount = 0, highlight = null, previousBest = null;
  for (const { id, payload } of store.rideExplorationInArchiveOrder(INDEX_VERSION)) {
    const { cells, time } = JSON.parse(payload);
    if (!cells?.length || !Number.isFinite(time)) continue;
    const parts = calendar.formatToParts(time);
    const year = parts.find(part => part.type === 'year').value;
    if (year !== month.slice(0, 4)) continue;
    const activityMonth = `${year}-${parts.find(part => part.type === 'month').value}`;
    if (activityMonth < month) previousBest = Math.max(previousBest ?? 0, cells.length);
    if (activityMonth !== month) continue;
    rideCount++;
    for (const cell of cells) visits.set(cell, (visits.get(cell) ?? 0) + 1);
    if (!highlight || cells.length > highlight.cells || (cells.length === highlight.cells && time < highlight.time)) {
      highlight = { id, time, cells: cells.length };
    }
  }
  if (highlight) highlight.name = store.fileNameForExploration(highlight.id);
  return { month, cellMeters: CELL_METERS, rideCount, highlight, previousBest,
    heatCells: [...visits].map(([key, count]) => [...cellPair(key), count]) };
}

export function createRideExploration(store) {
  return async function explore(id) {
    const selected = indexFile(store, id);
    if (!selected.cells?.length) throw new WorkspaceError(422, selected.error ?? '这个活动没有可用于探索的 GPS 轨迹。');
    await buildRideExplorationIndex(store);

    const earlier = new Set();
    const files = store.rideExplorationInArchiveOrder(INDEX_VERSION);
    const selectedIndex = files.findIndex(file => file.id === id);
    for (let i = 0; i < files.length; i++) {
      if (i === selectedIndex) continue;
      const prior = JSON.parse(files[i].payload);
      if (!prior.cells?.length) continue;
      const precedes = Number.isFinite(prior.time) && Number.isFinite(selected.time)
        ? prior.time < selected.time : i < selectedIndex;
      if (precedes) for (const cell of prior.cells) earlier.add(cell);
    }
    return {
      cellMeters: CELL_METERS,
      currentCells: selected.cells.map(cellPair),
      previousCells: [...earlier].map(cellPair),
      newCells: selected.cells.filter(cell => !earlier.has(cell)).map(cellPair),
    };
  };
}
