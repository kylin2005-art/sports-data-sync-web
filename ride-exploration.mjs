import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { WorkspaceError } from './sync-workspace.mjs';
import { readRideExplorationTrack } from './tracks.mjs';

const CELL_METERS = 500;
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
  return { cells, time: timeMs(startTime ?? (file.time === file.created ? null : file.time)) };
}

export function createRideExploration(store) {
  // Archive IDs are content hashes. Keep only cell keys and timestamps in memory.
  const cache = new Map();
  function read(id) {
    if (!cache.has(id)) {
      const file = store.file(id);
      if (!file) throw new WorkspaceError(404, '活动文件不存在，请刷新文件列表。');
      try { cache.set(id, readCells(file)); }
      catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        cache.set(id, { error: error.message });
      }
    }
    return cache.get(id);
  }

  return async function explore(id) {
    const selected = read(id);
    if (!selected.cells?.size) throw new WorkspaceError(422, selected.error ?? '这个活动没有可用于探索的 GPS 轨迹。');
    const earlier = new Set();
    // A snapshot avoids skipping rows if a background sync imports files mid-scan.
    const files = store.fileIdsInArchiveOrder();
    const selectedIndex = files.indexOf(id);
    for (let i = 0; i < files.length; i++) {
      if (i % 8 === 0) await yieldToRequests();
      if (i === selectedIndex) continue;
      const prior = read(files[i]);
      if (!prior.cells?.size) continue;
      const precedes = Number.isFinite(prior.time) && Number.isFinite(selected.time)
        ? prior.time < selected.time : i < selectedIndex;
      if (precedes) for (const cell of prior.cells) earlier.add(cell);
    }
    const split = key => key.split(',').map(Number);
    return {
      cellMeters: CELL_METERS,
      currentCells: [...selected.cells].map(split),
      previousCells: [...earlier].map(split),
      newCells: [...selected.cells].filter(cell => !earlier.has(cell)).map(split),
    };
  };
}
