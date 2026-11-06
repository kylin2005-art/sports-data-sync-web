import assert from 'node:assert/strict';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { bestFiveMinutePower } from '../ride-power.mjs';
import { annualRideHighlights } from '../ride-highlights.mjs';
import { SyncStore } from '../sync-store.mjs';

const samples = (seconds, watts) => Array.from({ length: seconds + 1 }, (_, index) => ({
  time: index * 1000, power: typeof watts === 'function' ? watts(index) : watts,
}));

test('five-minute power uses elapsed sample time, including zero watts', () => {
  const dense = samples(300, i => i < 60 ? 0 : 200);
  const sparse = dense.filter((_, i) => i % 3 === 0);
  assert.equal(bestFiveMinutePower([sparse]), 160);
  assert.equal(bestFiveMinutePower([samples(340, i => i < 40 ? 50 : 210)]), 210);
  assert.equal(bestFiveMinutePower([samples(299, 100)]), null);
});

test('five-minute power does not bridge missing samples, timing gaps, segments or FIT pauses', () => {
  const run = samples(400, 200);
  assert.equal(bestFiveMinutePower([run.filter(sample => sample.time < 198000 || sample.time >= 205000)]), null);
  assert.equal(bestFiveMinutePower([run.map(sample => sample.time === 200000 ? { ...sample, power: null } : sample)]), null);
  assert.equal(bestFiveMinutePower([run.map(sample => ({ ...sample, timer: sample.time < 200000 ? 0 : 2 }))]), null);
  assert.equal(bestFiveMinutePower([run.slice(0, 200), run.slice(200)]), null);
});

function fit(date, sport, distance, ascent, watts) {
  const encoder = new Encoder();
  const startTime = new Date(date);
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1 });
  samples(300, watts).forEach(({ time, power }) => {
    encoder.onMesg(Profile.MesgNum.RECORD, { timestamp: new Date(+startTime + time), power });
  });
  encoder.onMesg(Profile.MesgNum.SESSION, { startTime, sport, totalDistance: distance, totalAscent: ascent });
  return { fileName: 'indoor.fit', data: Buffer.from(encoder.close()) };
}

test('annual highlights combine indoor FIT and indexed GPX, then reuse stored results', async () => {
  const store = new SyncStore();
  try {
    const indoor = store.archive(fit('2025-12-31T23:00:00Z', 'cycling', 12000, 305, 230));
    store.archive(fit('2026-02-01T11:00:00Z', 'running', 99000, 999, 999));
    const points = [100, 104, 112, 108, 116].map((ele, i) =>
      `<trkpt lat="35" lon="${118 + i * 0.06}"><ele>${ele}</ele><time>2026-02-05T09:00:0${i}Z</time></trkpt>`);
    const gpx = { fileName: 'outdoor.gpx', data: Buffer.from(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`) };
    const outdoor = store.archive(gpx);
    assert.equal(store.archive(gpx), outdoor);
    const result = await annualRideHighlights(store, '2026', 'Asia/Shanghai');
    assert.equal(result.count, 2);
    assert.equal(result.records.distance.id, outdoor);
    assert.equal(result.records.distance.estimated, true);
    assert.equal(result.records.ascent.id, indoor);
    assert.equal(result.records.ascent.value, 305);
    assert.equal(result.records.exploration.id, outdoor);
    assert.equal(result.records.exploration.value, 5);
    assert.equal(result.records.power.id, indoor);
    assert.equal(result.records.power.value, 230);

    store.file = () => { throw new Error('indexed archive was read again'); };
    const utc = await annualRideHighlights(store, '2026', 'UTC');
    assert.equal(utc.count, 1);
    assert.equal(utc.records.ascent.value, 20);
    assert.equal(utc.records.ascent.estimated, true);
    assert.equal(utc.records.power, null);
    assert.equal((await annualRideHighlights(store, '2024')).count, 0);
    await assert.rejects(annualRideHighlights(store, '2026', 'Invalid/Zone'), { status: 400 });
  } finally {
    store.close();
  }
});
