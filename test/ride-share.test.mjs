import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { rideShareSvg, shareThemes } from '../public/ride-share-art.js';
import { posterData } from '../public/ride-share-data.js';
import { rideShareMonth } from '../ride-highlights.mjs';
import { SyncStore } from '../sync-store.mjs';

test('the complete theme catalog produces valid SVG and preserves route privacy', () => {
  const ride = { name: 'Private location', startTime: '2026-11-07T08:00:00Z',
    metrics: { distanceM: 31415, ascentM: 432, durationSeconds: 3600 },
    route: [[[.1, .5, 123], [.3, .9, 456]]], trimmedRoute: [[[.2, .6, 234], [.3, .9, 456]]],
    routeSpeeds: [[null, 10]], trimmedRouteSpeeds: [[null, 10]],
  };
  const options = { ride, title: '骑行 <&>', monthly: { month: '2026-11', days: [7], rideCount: 1, distanceM: 31415 } };
  assert.equal(shareThemes.length, 24);
  for (const { id } of shareThemes) {
    const svg = rideShareSvg(id, options);
    const douyin = rideShareSvg(id, { ...options, format: 'douyin' });
    const errors = [];
    const parser = new DOMParser({ onError: (_level, error) => errors.push(error) });
    const standard = parser.parseFromString(svg, 'image/svg+xml').documentElement;
    const tall = parser.parseFromString(douyin, 'image/svg+xml').documentElement;
    assert.deepEqual(errors, [], `theme ${id}`);
    assert.equal(standard.getAttribute('height'), '1224');
    assert.equal(tall.getAttribute('width'), '1080');
    assert.equal(tall.getAttribute('height'), '1920');
    assert.equal(tall.getAttribute('viewBox'), '0 0 360 640');
    assert.equal(tall.getElementsByTagName('g')[0].getAttribute('transform'), 'translate(0 116)');
    for (const document of [standard, tall]) {
      const titles = Array.from(document.getElementsByTagName('text')).filter(node => node.hasAttribute('data-poster-title'));
      assert.deepEqual(titles.map(node => node.textContent), [options.title], `theme ${id} main title`);
    }
    assert.doesNotMatch(svg, /Private location|undefined|NaN/);
    assert.doesNotMatch(douyin, /Private location|undefined|NaN/);
  }
  const hidden = posterData(1, options);
  const full = posterData(1, { ...options, scope: 'full' });
  const trimmed = posterData(1, { ...options, scope: 'trimmed' });
  assert.equal(hidden.date, '');
  assert.equal(hidden.route, '');
  assert.equal(hidden.hasSpeeds, false);
  assert.equal(trimmed.first, null);
  assert.notEqual(full.route, trimmed.route);
  assert.match(rideShareSvg(1, { ...options, scope: 'trimmed' }), /骑行 &lt;&amp;&gt;/);
  assert.ok(!rideShareSvg(1, { ...options, scope: 'trimmed' }).includes(full.route));
  assert.match(rideShareSvg(23, { ...options, title: '  ' }), /data-poster-title="">2026 年 11 月<\/text>/);
});

test('monthly share counts activity days in the requested time zone and reuses its index', async () => {
  const store = new SyncStore();
  try {
    const ids = ['a', 'b', 'c'].map(name => store.archive({ fileName: `${name}.gpx`, data: Buffer.from(name) }));
    store.saveRideHighlights(1, [
      [ids[0], { time: Date.parse('2026-10-31T20:00:00Z'), distanceM: 1000, ascentM: 10, estimatedDistance: true }],
      [ids[1], { time: Date.parse('2026-11-01T06:00:00Z'), distanceM: 3000, ascentM: null }],
      [ids[2], { time: Date.parse('2026-11-08T00:00:00Z'), distanceM: 2000, ascentM: 20, estimatedAscent: true }],
    ]);
    store.file = () => { throw new Error('should reuse indexed summaries'); };
    const local = await rideShareMonth(store, '2026-11', 'Asia/Shanghai');
    assert.deepEqual(local, { month: '2026-11', days: [1, 8], rideCount: 3, distanceM: 6000, ascentM: 30,
      estimatedDistance: true, estimatedAscent: true, representativeId: ids[1] });
    assert.equal((await rideShareMonth(store, '2026-11', 'UTC')).rideCount, 2);
    await assert.rejects(rideShareMonth(store, '2026-99'), { status: 400 });
  } finally {
    store.close();
  }
});
