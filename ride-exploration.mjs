import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { WorkspaceError } from './sync-workspace.mjs';
import { readRideExplorationTrack } from './tracks.mjs';

const CELL_METERS = 500;
// Bump when the grid or track eligibility rules change.
const INDEX_VERSION = 1;
const RADIANS = Math.PI / 180;
const RADIUS = 6378137;
const timeMs = value => value ? Date.parse(value) : NaN;

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
    const split = key => key.split(',').map(Number);
    return {
      cellMeters: CELL_METERS,
      currentCells: selected.cells.map(split),
      previousCells: [...earlier].map(split),
      newCells: selected.cells.filter(cell => !earlier.has(cell)).map(split),
    };
  };
}
