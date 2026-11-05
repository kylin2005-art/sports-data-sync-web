import assert from 'node:assert/strict';
import test from 'node:test';
import { createSources } from '../sources.mjs';

const origin = 'https://www.blackbirdsport.com';
const credential = { cookie: 'JSESSIONID=fixture-session' };
const fit = Buffer.from('0e2000080e0000002e4649547ac9400000140001fd0486000000004098ab', 'hex');
const startTime = Date.UTC(2026, 10, 5, 8, 0);

test('blackbird activity pages follow record IDs across an upstream page boundary', async () => {
  const calls = [];
  const record = recordId => ({ recordId, title: `骑行 ${recordId}`, startTime, distance: 5000, duration: 600 });
  const source = createSources({ fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Cookie, credential.cookie);
    assert.equal(options.redirect, 'error');
    const rows = calls.length === 1 ? Array.from({ length: 100 }, (_, i) => record(120 - i)) : [record(20), record(19)];
    return Response.json({ status: 'ok', content: rows });
  } });
  const page = await source.activities('blackbird', credential, 99);
  assert.deepEqual(calls, [`${origin}/api/records?lastRecordId=0&pageSize=100`, `${origin}/api/records?lastRecordId=21&pageSize=100`]);
  assert.deepEqual(page.activities.map(item => item.id), ['21', '20', '19']);
  assert.deepEqual(page.activities[0], { id: '21', name: '骑行 21', time: new Date(startTime).toISOString(), type: 'cycling', distance: 5000, duration: 600 });
  assert.equal(page.nextStart, null);
});

test('blackbird native history traverses more than a thousand records without replaying a cursor', async () => {
  const cursors = new Set();
  const source = createSources({ fetchImpl: async url => {
    const cursor = new URL(url).searchParams.get('lastRecordId');
    assert.equal(cursors.has(cursor), false);
    cursors.add(cursor);
    const first = cursor === '0' ? 1101 : Number(cursor) - 1;
    const content = Array.from({ length: Math.min(100, first) }, (_, i) => ({ recordId: first - i, startTime }));
    return Response.json({ status: 'ok', content });
  } });
  let cursor = null, count = 0, last;
  do {
    const page = await source.historyPage('blackbird', credential, cursor);
    count += page.activities.length;
    last = page.activities.at(-1)?.id;
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(count, 1101);
  assert.equal(last, '1');
  assert.equal(cursors.size, 12);
});

test('blackbird validates and preserves a same-origin original FIT', async () => {
  const calls = [];
  const source = createSources({ fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Cookie, credential.cookie);
    if (calls.length === 1) return Response.json({ fitUrl: '/files/21.fit' });
    assert.equal(options.headers.Referer, `${origin}/api/records/21`);
    return new Response(fit);
  } });
  assert.deepEqual(await source.download('blackbird', credential, '21'), { data: fit, fileName: 'blackbird_21.fit' });
  assert.deepEqual(calls, [`${origin}/api/records/21/data`, `${origin}/files/21.fit`]);
});

test('blackbird never requests a foreign FIT URL and reconstructs a timed WGS84 GPX', async () => {
  const calls = [];
  const source = createSources({ fetchImpl: async url => {
    calls.push(url);
    return Response.json({ status: 'ok', content: {
      startTime, fitUrl: 'https://foreign.example/21.fit',
      track: '31.2,121.4,5,12000,135,80,180,0,0;31.201,121.401,6,14000,139,82,216,10,0;'
    } });
  } });
  const file = await source.download('blackbird', credential, '21');
  assert.deepEqual(calls, [`${origin}/api/records/21/data`]);
  assert.equal(file.fileName, 'blackbird_21.gpx');
  assert.equal(file.coordinateSystem, 'wgs84');
  const gpx = file.data.toString('utf8');
  assert.match(gpx, /<time>2026-11-05T08:00:10\.000Z<\/time>/);
  assert.match(gpx, /<gpxtpx:power>120<\/gpxtpx:power>/);
  assert.doesNotMatch(gpx, /lat="31\.2000000"/);
});

test('blackbird rejects a login error envelope and does not invent timestamps', async () => {
  const denied = createSources({ fetchImpl: async () => Response.json({ status: 'error', content: [] }) });
  await assert.rejects(denied.verify('blackbird', credential), { status: 502 });
  await assert.rejects(denied.download('blackbird', credential, '21'), { status: 502 });
  const missingTime = createSources({ fetchImpl: async () => Response.json({ status: 'ok', content: {
    points: [{ lat: 31, lng: 121 }, { lat: 31.1, lng: 121.1 }]
  } }) });
  await assert.rejects(missingTime.download('blackbird', credential, '21'), { status: 422 });
});
