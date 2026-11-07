import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { matchRideRoutes } from './public/ride-compare.js';
import { countNewMonthlyRideCells } from './ride-exploration.mjs';
import { WorkspaceError } from './sync-workspace.mjs';
import { readRideReportEntry } from './tracks.mjs';

const INDEX_VERSION = 1;
const activeBuilds = new WeakMap();

async function indexArchive(store) {
  const ids = store.unindexedRideReportFiles(INDEX_VERSION);
  for (let index = 0; index < ids.length; index++) {
    if (index % 8 === 0) await yieldToRequests();
    const id = ids[index];
    let entry;
    try { entry = readRideReportEntry(store.file(id)); }
    catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      entry = null;
    }
    store.saveRideReport(id, INDEX_VERSION, entry);
  }
}

function buildIndex(store) {
  let build = activeBuilds.get(store);
  if (!build) {
    build = indexArchive(store).finally(() => activeBuilds.delete(store));
    activeBuilds.set(store, build);
  }
  return build;
}

function monthSummary(rides) {
  const summary = { rideCount: rides.length, rideDays: new Set(rides.map(ride => ride.day)).size,
    distanceM: null, ascentM: null, timerSeconds: null, elapsedSeconds: null,
    distanceCount: 0, ascentCount: 0, estimatedDistance: false, estimatedAscent: false, longest: null };
  for (const { id, name, time, metrics, estimated } of rides) {
    const { distanceM, ascentM, durationSeconds, durationKind } = metrics;
    if (distanceM > 0) {
      summary.distanceM = (summary.distanceM ?? 0) + distanceM;
      summary.distanceCount++;
      summary.estimatedDistance ||= estimated.includes('distanceM');
      if (!summary.longest || distanceM > summary.longest.distanceM) {
        summary.longest = { id, name, time, distanceM, estimated: estimated.includes('distanceM') };
      }
    }
    if (ascentM !== null) {
      summary.ascentM = (summary.ascentM ?? 0) + ascentM;
      summary.ascentCount++;
      summary.estimatedAscent ||= estimated.includes('ascentM');
    }
    if (durationSeconds > 0 && durationKind === 'timer') summary.timerSeconds = (summary.timerSeconds ?? 0) + durationSeconds;
    if (durationSeconds > 0 && durationKind === 'elapsed') summary.elapsedSeconds = (summary.elapsedSeconds ?? 0) + durationSeconds;
  }
  return summary;
}

function comparison(baseline, ride) {
  const before = baseline.metrics, after = ride.metrics;
  const delta = key => Number.isFinite(before[key]) && Number.isFinite(after[key]) ? after[key] - before[key] : null;
  return {
    baseline: { id: baseline.id, name: baseline.name, time: baseline.time },
    ride: { id: ride.id, name: ride.name, time: ride.time },
    durationKind: after.durationKind, secondsSaved: before.durationSeconds - after.durationSeconds,
    estimatedTime: [baseline, ride].some(entry => entry.estimated.includes('durationSeconds')),
    heartRateDelta: delta('avgHeartRateBpm'), powerDelta: delta('avgPowerW'),
  };
}

export async function monthlyRideReport(store, month, timeZone = 'UTC') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1970-01') {
    throw new WorkspaceError(400, '请选择有效的活动月份。');
  }
  let calendar;
  try {
    calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new WorkspaceError(400, '月份时区无效。');
  }
  const dateAt = time => {
    const parts = Object.fromEntries(calendar.formatToParts(time).map(part => [part.type, part.value]));
    return { month: `${parts.year}-${parts.month}`, day: parts.day };
  };
  const [year, monthNumber] = month.split('-').map(Number);
  const previousMonth = monthNumber === 1 ? `${year - 1}-12` : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;
  await buildIndex(store);
  const archive = store.rideReportRows(INDEX_VERSION).map(({ id, name, payload }) => {
    const entry = JSON.parse(payload);
    return { id, name, ...entry, ...dateAt(entry.time) };
  }).filter(ride => ride.month <= month).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const rides = archive.filter(ride => ride.month === month);
  const current = monthSummary(rides);
  const previous = monthSummary(archive.filter(ride => ride.month === previousMonth));
  const comparisons = [];
  let matchedCount = 0, fasterCount = 0;
  for (const [index, ride] of rides.entries()) {
    if (!ride.route || !ride.metrics.durationKind || !(ride.metrics.durationSeconds > 0)) continue;
    if (index % 8 === 0) await yieldToRequests();
    for (let prior = index + 1; prior < archive.length; prior++) {
      const baseline = archive[prior];
      if (baseline.metrics.durationKind !== ride.metrics.durationKind || !(baseline.metrics.durationSeconds > 0) ||
          baseline.time + baseline.metrics.durationSeconds * 1000 > ride.time) continue;
      if (matchRideRoutes(baseline.route, ride.route) !== 'same') continue;
      const result = comparison(baseline, ride);
      matchedCount++;
      if (Math.round(result.secondsSaved) > 0) fasterCount++;
      if (comparisons.length < 10) comparisons.push(result);
      break;
    }
  }
  const newCells = current.rideCount
    ? await countNewMonthlyRideCells(store, time => dateAt(time).month, month, new Set(archive.map(ride => ride.id)))
    : null;
  return { month, previousMonth, current, previous, newCells, matchedCount, fasterCount, comparisons };
}
