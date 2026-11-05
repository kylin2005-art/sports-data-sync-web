import assert from 'node:assert/strict';
import test from 'node:test';
import { Decoder, Encoder, Profile, Stream } from '@garmin/fitsdk';
import { createIntervalsWorkouts, plannedFit, WORKOUT_TARGETS } from '../intervals-workouts.mjs';

const intervalsKey = 'test-calendar-key';
const igpsToken = 'test-workout-token';
const dates = { oldest: '2026-11-05', newest: '2026-11-11' };
const event = { id: 51, name: 'Endurance intervals', type: 'Ride', category: 'WORKOUT',
  start_date_local: '2026-11-07T09:00:00', workout_doc: { steps: [
    { duration: 180, warmup: true, power: { value: 55, units: '%ftp' } },
    { reps: 2, steps: [
      { duration: 300, power: { start: 200, end: 220, units: 'w' }, cadence: { value: 85, units: 'rpm' } },
      { duration: 120, intensity: 'recovery' },
    ] },
  ] } };

function fitFile(type) {
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type, manufacturer: 'development', product: 0 });
  if (type === 'workout') {
    encoder.onMesg(Profile.MesgNum.WORKOUT, { sport: 'cycling', wktName: 'Endurance intervals', numValidSteps: 1 });
    encoder.onMesg(Profile.MesgNum.WORKOUT_STEP, { messageIndex: 0, durationType: 'time', durationTime: 180,
      targetType: 'open', intensity: 'warmup' });
  }
  return Buffer.from(encoder.close());
}

test('calendar and planned FIT use only the authenticated calendar endpoints', async () => {
  const fit = fitFile('workout');
  assert.equal(plannedFit(fit), true);
  assert.equal(plannedFit(fitFile('activity')), false);
  const corrupt = Buffer.from(fit);
  corrupt[corrupt.length - 1] ^= 1;
  assert.equal(plannedFit(corrupt), false);
  const calls = [];
  const client = createIntervalsWorkouts({ fetchImpl: async (input, options) => {
    const url = new URL(input);
    calls.push(url.pathname);
    assert.equal(url.hostname, 'intervals.icu');
    assert.equal(options.redirect, 'error');
    assert.equal(Buffer.from(options.headers.Authorization.slice(6), 'base64').toString(), 'API_KEY:' + intervalsKey);
    if (url.pathname.endsWith('/events')) {
      assert.equal(url.searchParams.get('category'), 'WORKOUT');
      assert.equal(url.searchParams.get('oldest'), dates.oldest);
      assert.equal(url.searchParams.get('newest'), dates.newest);
      return Response.json([event, { category: 'NOTE' }]);
    }
    return new Response(url.pathname.endsWith('/51/download.fit') ? fit : fitFile('activity'));
  } });
  assert.deepEqual(await client.list({ apiKey: intervalsKey }, dates), { workouts: [{
    id: '51', name: event.name, type: 'Ride', startLocal: event.start_date_local,
  }] });
  assert.deepEqual(await client.download({ apiKey: intervalsKey }, { id: '51' }), {
    data: fit, fileName: 'intervals-workout-51.fit', contentType: 'application/octet-stream',
  });
  await assert.rejects(client.download({ apiKey: intervalsKey }, { id: '52' }), { status: 502 });
  await assert.rejects(client.download({ apiKey: intervalsKey }, { id: '../51' }), { status: 400 });
  await assert.rejects(client.list({ apiKey: intervalsKey }, { ...dates, oldest: '2026-02-30' }), { status: 400 });
  assert.deepEqual(calls, ['/api/v1/athlete/0/events', '/api/v1/athlete/0/events/51/download.fit',
    '/api/v1/athlete/0/events/52/download.fit']);
});

for (const [platform, host, origin] of [
  ['igpsport', 'prod.zh.igpsport.com', 'https://app.igpsport.cn'],
  ['igpsport_int', 'prod.en.igpsport.com', 'https://app.igpsport.com'],
]) test(platform + ' preflights scope, writes a structured workout and reads back its ID', async () => {
  const sequence = [];
  const client = createIntervalsWorkouts({ fetchImpl: async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'intervals.icu') {
      assert.equal(url.searchParams.get('resolve'), 'true');
      sequence.push('calendar');
      return Response.json([event]);
    }
    assert.equal(url.hostname, host);
    assert.equal(options.headers.Origin, origin);
    assert.equal(options.headers.Authorization, 'Bearer ' + igpsToken);
    if (url.pathname.endsWith('/EditCustomWorkOut')) {
      sequence.push('post');
      const { data } = JSON.parse(options.body);
      assert.equal(data.totalTime, 1020);
      assert.equal(data.workoutType, 'bike');
      const [warmup, repeats] = data.structure;
      assert.equal(warmup.intensityClass, 'WarmUp');
      assert.deepEqual(warmup.intensityTarget, { unit: 'PercentOfFTP', minValue: 55, maxValue: 55 });
      assert.deepEqual(repeats.length, { unit: 'Repetition', value: 2 });
      assert.deepEqual(repeats.steps[0].intensityTarget, { unit: 'PowerCustom', value: 0, minValue: 200, maxValue: 220 });
      assert.deepEqual(repeats.steps[0].cadenceTarget, { unit: 'Cadence', minValue: 85, maxValue: 85 });
      assert.equal(repeats.steps[1].intensityClass, 'Rest');
      return Response.json({ code: 0, data: { workoutId: 72 } });
    }
    assert.match(url.pathname, /\/CustomWorkout$/);
    sequence.push('list');
    return Response.json({ code: 0, data: { items: sequence.includes('post') ? [{ workoutId: 72 }] : [] } });
  } });
  assert.ok(WORKOUT_TARGETS.includes(platform));
  const result = await client.publish({ platform, credential: { token: igpsToken }, apiKey: intervalsKey, id: 51, ...dates,
    beforeUpload: () => sequence.push('intent'),
    onImported: ({ workoutId }) => { assert.equal(workoutId, '72'); sequence.push('receipt'); },
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.workoutId, '72');
  assert.deepEqual(sequence, ['calendar', 'list', 'intent', 'post', 'receipt', 'list']);
});

test('iGPSPORT leaves uncertain writes pending and never sends unsupported plan steps', async () => {
  let posts = 0;
  let unsupported = false;
  const client = createIntervalsWorkouts({ fetchImpl: async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'intervals.icu') {
      return Response.json([unsupported ? { ...event, workout_doc: { steps: [{ duration: 300, ramp: true }] } } : event]);
    }
    if (options.method === 'POST') {
      posts++;
      return Response.json({ code: 0, data: { workoutId: 72 } });
    }
    return Response.json({ code: 0, data: { items: [{ workoutId: 73 }] } });
  } });
  const input = { platform: 'igpsport', credential: { token: igpsToken }, apiKey: intervalsKey, id: 51, ...dates };
  await assert.rejects(client.publish(input), { status: 502, mayHaveUploaded: true });
  assert.equal(posts, 1);
  unsupported = true;
  await assert.rejects(client.publish(input), { status: 422, mayHaveUploaded: false });
  assert.equal(posts, 1);
});

test('Bryton schedules a native FIT and confirms only byte-identical authenticated readback', async () => {
  const token = 'workout-browser-token';
  const previous = { id: 'oldWorkout' };
  const newPath = '/files/userFiles/newWorkout/original/newWorkout.fit';
  const workout = { ...event, workout_doc: { steps: [
    { reps: 2, steps: [{ duration: 300, power: { value: 80, units: '%ftp' } }, { duration: 120, intensity: 'recovery' }] },
    { until_lap_press: true },
  ] } };
  let uploaded;
  let mismatch = false;
  const calls = [];
  class MockSocket extends EventTarget {
    constructor(url) {
      super();
      assert.match(url, /^wss:\/\/active\.brytonsport\.com\/sockjs\/\d{3}\/[0-9a-f]{16}\/websocket$/);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'o' })));
    }
    send(frame) {
      const [raw] = JSON.parse(frame);
      const message = JSON.parse(raw);
      let response;
      if (message.msg === 'connect') response = { msg: 'connected' };
      else if (message.method === 'login') {
        assert.deepEqual(message.params, [{ resume: token }]);
        response = { msg: 'result', id: 'login', result: { id: 'athleteAccount', token } };
      } else {
        assert.equal(message.method, 'user.file.list');
        calls.push('library');
        const items = uploaded ? [previous, { id: 'newWorkout', url: newPath }] : [previous];
        response = { msg: 'result', id: 'workouts', result: { workout: items } };
      }
      const data = 'a' + JSON.stringify([JSON.stringify(response)]);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
    close() {}
  }
  const client = createIntervalsWorkouts({ WebSocketImpl: MockSocket, fetchImpl: async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'intervals.icu') return Response.json([workout]);
    assert.equal(url.hostname, 'active.brytonsport.com');
    assert.equal(options.headers['X-User-Id'], 'athleteAccount');
    assert.equal(options.headers['X-Auth-Token'], token);
    if (options.method === 'POST') {
      assert.equal(url.pathname, '/workout/upload/athleteAccount');
      calls.push('post');
      const { body } = options;
      assert.equal(body.get('provider'), 'bryton');
      assert.match(body.get('name'), /^bsWO_icu_51_[a-f0-9]{12}\.fit$/);
      assert.equal(body.get('file').name, body.get('name'));
      const info = JSON.parse(body.get('info'));
      assert.deepEqual(info.plan, ['2026-11-07']);
      assert.equal(info.interval.length, 4);
      uploaded = Buffer.from(await body.get('file').arrayBuffer());
      assert.equal(plannedFit(uploaded), true);
      const { messages } = new Decoder(Stream.fromBuffer(uploaded)).read();
      assert.equal(messages.fileIdMesgs[0].manufacturer, 'bryton');
      assert.equal(messages.workoutStepMesgs[0].targetType, 245);
      assert.equal(messages.workoutStepMesgs[0].customTargetValueLow, 100080);
      assert.equal(messages.workoutStepMesgs[2].repeatSteps, 2);
      assert.equal(messages.workoutStepMesgs[3].durationType, 'open');
      return new Response(null, { status: 200 });
    }
    assert.equal(url.pathname, newPath);
    calls.push('read');
    return new Response(mismatch ? fitFile('workout') : uploaded);
  } });
  const input = { platform: 'bryton', credential: { cookie: 'other=abc; meteor_login_token=' + token },
    apiKey: intervalsKey, id: '51', ...dates, beforeUpload: () => calls.push('intent'),
    onImported: ({ workoutId }) => { assert.equal(workoutId, 'newWorkout'); calls.push('receipt'); } };
  assert.ok(WORKOUT_TARGETS.includes('bryton'));
  assert.equal((await client.publish(input)).workoutId, 'newWorkout');
  assert.deepEqual(calls, ['library', 'intent', 'post', 'library', 'read', 'receipt']);
  uploaded = undefined;
  mismatch = true;
  await assert.rejects(client.publish(input), { status: 502, mayHaveUploaded: true });
  assert.deepEqual(calls.slice(6), ['library', 'intent', 'post', 'library', 'read']);
  await assert.rejects(client.publish({ ...input, credential: { cookie: 'other=abc' } }), { status: 401, mayHaveUploaded: false });
  assert.equal(calls.filter(call => call === 'post').length, 2);
});
