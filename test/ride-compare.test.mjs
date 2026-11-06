import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRides } from '../public/ride-compare.js';

const route = [[118, 35], [118.011, 35.002], [118.018, 35.010], [118.023, 35.017]];
const ride = (points, durationSeconds, day, durationKind = 'timer') => ({
  startTime: day ? `2026-11-${day}T10:00:00Z` : null,
  mapSegments: [points],
  metrics: { durationKind, durationSeconds },
});

test('a denser slightly shifted trace of the same route gets a chronological time comparison', () => {
  const old = ride(route, 900, '02');
  const recent = ride([[118.0001, 35], [118.006, 35.0011], [118.011, 35.0021],
    [118.014, 35.0054], [118.0181, 35.01], [118.023, 35.0169]], 780, '05');
  const result = compareRides(recent, old);
  assert.equal(result.baseline, old);
  assert.equal(result.ride, recent);
  assert.equal(result.match, 'same');
  assert.equal(result.secondsSaved, 120);
});

test('reverse rides and different courses do not get a speed comparison', () => {
  const old = ride(route, 900, '02');
  const reverse = compareRides(old, ride([...route].reverse(), 780, '05'));
  assert.equal(reverse.match, 'reverse');
  assert.equal(reverse.secondsSaved, null);
  const detour = [route[0], [118.011, 35.006], route[2], route[3]];
  const different = compareRides(old, ride(detour, 780, '05'));
  assert.equal(different.match, 'different');
  assert.equal(different.secondsSaved, null);
});

test('out-and-back traces, missing positioning and different time measurements withhold the delta', () => {
  const loop = [...route, ...route.slice(0, -1).reverse()];
  const ambiguous = compareRides(ride(loop, 900, '02'), ride(loop, 780, '05'));
  assert.equal(ambiguous.match, 'ambiguous');
  assert.equal(ambiguous.secondsSaved, null);
  const old = ride(route, 900, null);
  const incompatible = compareRides(old, ride(route, 780, '05', 'elapsed'));
  assert.equal(incompatible.baseline, old);
  assert.equal(incompatible.match, 'same');
  assert.equal(incompatible.secondsSaved, null);
  assert.equal(compareRides(old, ride([], 780, '05')).match, 'unavailable');
  assert.equal(compareRides(old, {
    ...ride(route, 780, '05'), mapSegments: [route.slice(0, 2), route.slice(2)],
  }).match, 'unavailable');
});
