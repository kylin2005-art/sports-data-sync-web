import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createServer } from '../server.mjs';

const record = { id: '123', name: 'Synthetic ride', type: 'cycling', time: '2026-11-04T08:00:00Z', distance: 12.5, duration: 1800 };
const page = { activities: [record], nextStart: 20 };
const receipt = { id: '123', activityId: '999', url: 'https://connect.garmin.com/modern/activity/999', message: 'Synthetic import confirmed' };

async function fixture(t, overrides = {}) {
  const calls = [];
  const defaults = {
    openLogin: async region => ({ message: `Login ${region} opened` }),
    verify: async region => ({ message: `Verified ${region}` }),
    activities: async () => page,
    transfer: async () => receipt,
    close: async () => {}
  };
  const adapter = Object.fromEntries(Object.entries(defaults).map(([name, implementation]) => [name, async (...args) => {
    calls.push({ name, args });
    return (overrides[name] || implementation)(...args);
  }]));
  const server = createServer(adapter);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  function request(method, path, body, options = {}) {
    const host = options.host ?? `127.0.0.1:${port}`;
    const headers = { Host: host };
    if (method === 'POST') {
      if (options.origin !== null) headers.Origin = options.origin ?? `http://${host}`;
      if (options.contentType !== null) headers['Content-Type'] = options.contentType ?? 'application/json';
    }
    const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, method, path, headers, agent: false }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: response.statusCode, json, text });
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error('Synthetic HTTP test timed out')));
      request.on('error', reject);
      request.end(payload);
    });
  }
  return { request, calls, port };
}

function error(response, status) {
  assert.equal(response.status, status, response.text);
  assert.equal(typeof response.json?.error, 'string');
  assert.ok(response.json.error.length > 0);
}

async function verifiedBoth(request) {
  assert.equal((await request('POST', '/api/verify', { region: 'cn' })).status, 200);
  assert.equal((await request('POST', '/api/verify', { region: 'com' })).status, 200);
}

test('initial state is unverified without contacting Garmin', async t => {
  const { request, calls } = await fixture(t);
  const response = await request('GET', '/api/state');
  assert.equal(response.status, 200);
  assert.equal(response.json.cn, false);
  assert.equal(response.json.com, false);
  assert.deepEqual(calls, []);
});

test('only localhost and 127.0.0.1 with the listening port are accepted as Host', async t => {
  const { request, calls, port } = await fixture(t);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal((await request('GET', '/api/state', undefined, { host })).status, 200);
  }
  for (const host of [`evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1:${port + 1}`, 'localhost']) {
    error(await request('GET', '/api/state', undefined, { host }), 403);
  }
  assert.deepEqual(calls, []);
});

test('POST requires an Origin matching the exact request Host', async t => {
  const { request, calls, port } = await fixture(t);
  for (const origin of [null, 'null', 'https://evil.example', `http://localhost:${port}`, `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
    error(await request('POST', '/api/login', { region: 'cn' }, { origin }), 403);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request('POST', '/api/login', { region: 'cn' }, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status, 200);
  assert.deepEqual(calls, [{ name: 'openLogin', args: ['cn'] }]);
});

test('non-JSON malformed and invalid request bodies are rejected before the adapter', async t => {
  const { request, calls } = await fixture(t);
  for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded']) {
    error(await request('POST', '/api/login', { region: 'cn' }, { contentType }), 400);
  }
  for (const raw of ['{', '', 'null', '[]']) {
    error(await request('POST', '/api/login', undefined, { raw }), 400);
  }
  for (const body of [{}, { region: 'global' }, { region: 1 }]) {
    error(await request('POST', '/api/login', body), 400);
    error(await request('POST', '/api/verify', body), 400);
  }
  assert.deepEqual(calls, []);
});

test('login does not verify a region and verify returns the adapter message', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('POST', '/api/login', { region: 'cn' })).status, 200);
  let state = (await request('GET', '/api/state')).json;
  assert.equal(state.cn, false);
  assert.equal(state.com, false);
  const verified = await request('POST', '/api/verify', { region: 'cn' });
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.json, { message: 'Verified cn' });
  state = (await request('GET', '/api/state')).json;
  assert.equal(state.cn, true);
  assert.equal(state.com, false);
  assert.deepEqual(calls.map(call => call.name), ['openLogin', 'verify']);
});

test('activity reads require CN verification and preserve pagination', async t => {
  const { request, calls } = await fixture(t);
  error(await request('POST', '/api/activities', { start: 0 }), 409);
  assert.equal((await request('POST', '/api/verify', { region: 'cn' })).status, 200);
  for (const start of [-1, 0.5, '0', null]) error(await request('POST', '/api/activities', { start }), 400);
  const response = await request('POST', '/api/activities', { start: 20 });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, page);
  assert.deepEqual(calls.filter(call => call.name === 'activities'), [{ name: 'activities', args: [20] }]);
});

test('transfer requires both verified regions and an activity seen in the source list', async t => {
  const { request, calls } = await fixture(t);
  error(await request('POST', '/api/transfer', { id: '123' }), 409);
  assert.equal((await request('POST', '/api/verify', { region: 'cn' })).status, 200);
  assert.equal((await request('POST', '/api/activities', { start: 0 })).status, 200);
  error(await request('POST', '/api/transfer', { id: '123' }), 409);
  assert.equal((await request('POST', '/api/verify', { region: 'com' })).status, 200);
  error(await request('POST', '/api/transfer', { id: '456' }), 400);
  for (const id of ['0', '-1', '1.5', 'abc', 123, null]) error(await request('POST', '/api/transfer', { id }), 400);
  assert.equal(calls.filter(call => call.name === 'transfer').length, 0);
  const response = await request('POST', '/api/transfer', { id: '123' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, receipt);
  assert.deepEqual(calls.filter(call => call.name === 'transfer'), [{ name: 'transfer', args: ['123'] }]);
});

test('opening a new CN login invalidates verification and previously seen activities', async t => {
  const { request } = await fixture(t);
  await verifiedBoth(request);
  assert.equal((await request('POST', '/api/activities', { start: 0 })).status, 200);
  assert.equal((await request('POST', '/api/login', { region: 'cn' })).status, 200);
  const state = (await request('GET', '/api/state')).json;
  assert.equal(state.cn, false);
  assert.equal(state.com, true);
  error(await request('POST', '/api/transfer', { id: '123' }), 409);
  assert.equal((await request('POST', '/api/verify', { region: 'cn' })).status, 200);
  error(await request('POST', '/api/transfer', { id: '123' }), 400);
});

test('re-verifying CN clears seen IDs and activities must be read again', async t => {
  const { request } = await fixture(t);
  await verifiedBoth(request);
  assert.equal((await request('POST', '/api/activities', { start: 0 })).status, 200);
  assert.equal((await request('POST', '/api/verify', { region: 'cn' })).status, 200);
  error(await request('POST', '/api/transfer', { id: '123' }), 400);
  assert.equal((await request('POST', '/api/activities', { start: 0 })).status, 200);
  assert.equal((await request('POST', '/api/transfer', { id: '123' })).status, 200);
});

test('opening COM login invalidates only COM verification', async t => {
  const { request } = await fixture(t);
  await verifiedBoth(request);
  assert.equal((await request('POST', '/api/activities', { start: 0 })).status, 200);
  assert.equal((await request('POST', '/api/login', { region: 'com' })).status, 200);
  const state = (await request('GET', '/api/state')).json;
  assert.equal(state.cn, true);
  assert.equal(state.com, false);
  error(await request('POST', '/api/transfer', { id: '123' }), 409);
  assert.equal((await request('POST', '/api/verify', { region: 'com' })).status, 200);
  assert.equal((await request('POST', '/api/transfer', { id: '123' })).status, 200);
});

test('failed re-verification removes the previous verified state and seen IDs', async t => {
  let rejectVerification = false;
  const { request } = await fixture(t, { verify: async () => {
    if (rejectVerification) throw new Error('Synthetic session expired');
    return { message: 'Synthetic verified session' };
  } });
  await verifiedBoth(request);
  assert.equal((await request('POST', '/api/activities', { start: 0 })).status, 200);
  rejectVerification = true;
  const failure = await request('POST', '/api/verify', { region: 'cn' });
  assert.ok(failure.status >= 400);
  assert.equal(typeof failure.json.error, 'string');
  assert.equal((await request('GET', '/api/state')).json.cn, false);
  rejectVerification = false;
  assert.equal((await request('POST', '/api/verify', { region: 'cn' })).status, 200);
  error(await request('POST', '/api/transfer', { id: '123' }), 400);
});

test('a busy adapter rejects overlapping operations and releases the lock afterward', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { request, calls } = await fixture(t, { openLogin: async () => { entered(); await pending; return { message: 'Synthetic login opened' }; } });
  const first = request('POST', '/api/login', { region: 'cn' });
  await started;
  try {
    error(await request('POST', '/api/verify', { region: 'com' }), 409);
    assert.equal(calls.filter(call => call.name === 'verify').length, 0);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await request('POST', '/api/verify', { region: 'com' })).status, 200);
});
