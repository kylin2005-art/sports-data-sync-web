import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { WorkspaceError } from './sync-workspace.mjs';
import { readRideHighlightMetrics } from './tracks.mjs';
import { rideExplorationCounts } from './ride-exploration.mjs';

export const HIGHLIGHT_INDEX_VERSION = 1;
const BATCH_SIZE = 8;
const activeBuilds = new WeakMap();

async function indexFiles(store) {
  const files = store.unindexedRideHighlightFiles(HIGHLIGHT_INDEX_VERSION);
  for (let start = 0; start < files.length; start += BATCH_SIZE) {
    await yieldToRequests();
    const entries = files.slice(start, start + BATCH_SIZE).map(id => {
      try { return [id, readRideHighlightMetrics(store.file(id))]; }
      catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        return [id, null];
      }
    });
    store.saveRideHighlights(HIGHLIGHT_INDEX_VERSION, entries);
  }
}

export async function buildRideHighlightIndex(store) {
  let build = activeBuilds.get(store);
  if (!build) {
    build = indexFiles(store).finally(() => activeBuilds.delete(store));
    activeBuilds.set(store, build);
  }
  await build;
}

export async function rideShareMonth(store, month, timeZone = 'UTC') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1970-01') {
    throw new WorkspaceError(400, '请选择有效的活动月份。');
  }
  let calendar;
  try {
    calendar = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new WorkspaceError(400, '月份时区无效。');
  }
  await buildRideHighlightIndex(store);
  const days = new Set();
  let rideCount = 0, distanceM = null, ascentM = null, estimatedDistance = false, estimatedAscent = false;
  let representative = null;
  for (const { id, payload } of store.rideHighlightRows(HIGHLIGHT_INDEX_VERSION)) {
    const activity = JSON.parse(payload);
    if (!activity) continue;
    const { day, month: monthValue, year } = Object.fromEntries(calendar.formatToParts(activity.time).map(part => [part.type, part.value]));
    if (`${year}-${monthValue}` !== month) continue;
    days.add(Number(day));
    rideCount++;
    if (Number.isFinite(activity.distanceM) && activity.distanceM > 0) distanceM = (distanceM ?? 0) + activity.distanceM;
    if (Number.isFinite(activity.ascentM)) ascentM = (ascentM ?? 0) + activity.ascentM;
    estimatedDistance ||= activity.estimatedDistance === true;
    estimatedAscent ||= activity.estimatedAscent === true;
    if (!representative || activity.distanceM > representative.distanceM) {
      representative = { id, distanceM: activity.distanceM };
    }
  }
  return { month, days: [...days].sort((a, b) => a - b), rideCount, distanceM, ascentM, estimatedDistance, estimatedAscent,
    representativeId: representative?.id ?? null };
}

export async function annualRideHighlights(store, year, timeZone = 'UTC') {
  if (!/^\d{4}$/.test(year) || year < '1970') throw new WorkspaceError(400, '请选择有效的活动年份。');
  let calendar;
  try { calendar = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new WorkspaceError(400, '年份时区无效。');
  }

  await buildRideHighlightIndex(store);
  const grid = await rideExplorationCounts(store);
  const records = { distance: null, ascent: null, exploration: null, power: null };
  let count = 0;
  for (const { id, name, payload } of store.rideHighlightRows(HIGHLIGHT_INDEX_VERSION)) {
    const activity = JSON.parse(payload);
    if (!activity || calendar.format(activity.time) !== year) continue;
    count++;
    const { time, distanceM, ascentM, powerW, estimatedDistance, estimatedAscent } = activity;
    const values = { distance: distanceM, ascent: ascentM, exploration: grid.get(id), power: powerW };
    for (const [key, value] of Object.entries(values)) {
      if (!(value > 0)) continue;
      const prior = records[key];
      if (!prior || value > prior.value || (value === prior.value && time < prior.time)) {
        records[key] = { id, name, time, value,
          estimated: (key === 'distance' && estimatedDistance) || (key === 'ascent' && estimatedAscent) };
      }
    }
  }
  return { year, count, records };
}
