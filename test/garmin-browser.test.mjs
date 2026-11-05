import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { chromium } from 'playwright-core';
import { zipSync } from 'fflate';
import { GarminBrowser, GarminError, validFit } from '../garmin-browser.mjs';

function fitBytes() {
  const fit = Buffer.alloc(15);
  fit[0] = 12;
  fit.writeUInt32LE(1, 4);
  fit.write('.FIT', 8, 'ascii');
  let checksum = 0;
  for (const byte of fit.subarray(0, 13)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = checksum & 1 ? (checksum >>> 1) ^ 0xa001 : checksum >>> 1;
  }
  fit.writeUInt16LE(checksum, 13);
  return fit;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const isList = call => call.url.pathname.includes('activitylist-service');
const isDetail = call => call.url.pathname.includes('/activity-service/activity/');
const posts = calls => calls.filter(call => call.method === 'POST');

async function fixture(t, override = () => undefined, browserOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'garmin-browser-unit-'));
  const calls = [], delays = [], reloads = [], launches = [];
  const identities = { cn: 100, com: 200 };
  const pages = {}, contexts = {};
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 1000 || delay === 2000) { delays.push(delay); return realTimeout(fn, 0, ...args); }
    return realTimeout(fn, delay, ...args);
  });
  t.mock.method(chromium, 'launchPersistentContext', async (profile, options) => {
    const region = profile.endsWith('cn') ? 'cn' : 'com';
    launches.push({ region, profile, ...options });
    let current = 'about:blank';
    let closed = false, onClose;
    const state = {
      cookies: [{ name: 'SESSION', value: `session-${region}`, domain: `.garmin.${region}`, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }],
      origins: [{ origin: `https://connect.garmin.${region}`, localStorage: [{ name: 'setting', value: 'value' }] }],
    };
    const page = {
      isClosed: () => closed, url: () => current, bringToFront: async () => {},
      goto: async url => { current = url; },
      reload: async () => { reloads.push(region); },
      evaluate: async (fn, args) => JSON.parse(JSON.stringify(await vm.runInNewContext(`(${fn.toString()})(__args)`, {
        __args: args, location: new URL(current), document: { querySelector: () => ({ content: `csrf-${reloads.length}` }) }, crypto: webcrypto,
        window: { localStorage: Object.fromEntries((state.origins.find(item => item.origin === new URL(current).origin)?.localStorage || []).map(item => [item.name, item.value])) },
        URL, AbortController, setTimeout, clearTimeout, TextDecoder, Uint8Array, FormData, Blob,
        btoa: text => Buffer.from(text, 'binary').toString('base64'),
        atob: text => Buffer.from(text, 'base64').toString('binary'),
        fetch: async (url, options) => {
          const call = { region, url: new URL(url), method: options.method, options };
          calls.push(call);
          let result = await override(call, calls);
          if (!result) {
            if (url.pathname.includes('socialProfile')) result = json({ profileId: identities[region], fullName: 'Private name', userName: 'private@example.invalid' });
            else if (isList(call)) result = json([]);
            else if (url.pathname.includes('download-service')) result = new Response(fitBytes());
            else if (url.pathname.includes('upload-service')) result = json({ detailedImportResult: { successes: [{ internalId: 987 }], failures: [] } });
            else if (isDetail(call)) result = json({ activityId: 987 });
            else throw new Error('Unexpected mock route');
          }
          Object.defineProperty(result, 'url', { value: url.toString() });
          return result;
        },
      }))),
    };
    pages[region] = page;
    const context = { state, pages: () => [page],
      cookies: async urls => { assert.ok(urls.every(url => new URL(url).hostname.endsWith(`garmin.${region}`))); return structuredClone(state.cookies); },
      setStorageState: async value => { Object.assign(state, structuredClone(value)); },
      on: (event, callback) => { if (event === 'close') onClose = callback; },
      close: async () => { closed = true; onClose?.(); },
    };
    contexts[region] = context;
    return context;
  });
  const browser = new GarminBrowser(root, browserOptions);
  t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
  await browser.openLogin('cn');
  await browser.openLogin('com');
  return { browser, calls, delays, identities, pages, reloads, launches, contexts, root };
}

test('original-file GET accepts Garmin ZIP and returns the unchanged FIT', async t => {
  const fit = fitBytes();
  const { browser, calls } = await fixture(t, call => {
    if (!call.url.pathname.includes('download-service')) return;
    if (call.options.headers.Accept !== '*/*') return new Response(null, { status: 406 });
    return new Response(zipSync({ 'original.fit': fit }), { headers: { 'Content-Type': 'application/zip' } });
  });
  const result = await browser.download('cn', '123');
  assert.deepEqual(result.data, fit);
  assert.equal(calls.filter(call => call.url.pathname.includes('download-service')).length, 1);
  assert.equal(posts(calls).length, 0);
});

test('list HTTP 403 reloads Connect and retries once with the refreshed CSRF and same pagination', async t => {
  const { browser, calls, reloads } = await fixture(t, call => {
    if (isList(call) && call.options.headers['connect-csrf-token'] === 'csrf-0') return new Response(null, { status: 403 });
  });
  assert.deepEqual(await browser.activities(20, 'cn'), { activities: [], nextStart: null });
  assert.deepEqual(reloads, ['cn']);
  const lists = calls.filter(isList);
  assert.deepEqual(lists.map(call => call.options.headers['connect-csrf-token']), ['csrf-0', 'csrf-1']);
  assert.ok(lists.every(call => call.url.searchParams.get('start') === '20' && call.url.searchParams.get('limit') === '20'));
  assert.equal(calls.filter(call => call.url.pathname.includes('socialProfile')).length, 2);
});

test('continued list HTTP 403 stops after one reload, and upload HTTP 403 is never replayed', async t => {
  const { browser, calls, reloads } = await fixture(t, call => {
    if ((call.region === 'cn' && isList(call)) || call.url.pathname.includes('upload-service')) return new Response(null, { status: 403 });
  });
  await assert.rejects(browser.activities(), /HTTP 403/);
  assert.equal(calls.filter(isList).length, 2);
  assert.deepEqual(reloads, ['cn']);
  await assert.rejects(browser.upload('com', { data: fitBytes(), fileName: 'original.fit' }), /HTTP 403/);
  assert.equal(posts(calls).length, 1);
  assert.deepEqual(reloads, ['cn']);
});

test('target 404 propagation retries only exact-ID GET, with durable callbacks before readback', async t => {
  let details = 0;
  const events = [];
  const { browser, calls, delays } = await fixture(t, call => {
    if (call.method === 'POST') events.push('post');
    if (isDetail(call)) {
      events.push('readback');
      return ++details < 3 ? new Response(null, { status: 404 }) : json({ activityId: 987 });
    }
  });
  const receipt = await browser.transfer('123', {
    beforeUpload: async () => events.push('intent'),
    onImported: async value => { assert.equal(value.activityId, '987'); events.push('imported'); },
  });
  assert.deepEqual(events, ['intent', 'post', 'imported', 'readback', 'readback', 'readback']);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(posts(calls).length, 1);
  assert.equal(receipt.id, '123');
  assert.equal(receipt.activityId, '987');
  assert.ok(calls.filter(isDetail).every(call => call.url.pathname.endsWith('/987') && !call.url.search));
});

test('persistent 404 stops after three reads, preserves stage and never posts twice', async t => {
  const { browser, calls } = await fixture(t, call => isDetail(call) ? new Response(null, { status: 404 }) : undefined);
  await assert.rejects(browser.transfer('123'), error => error.message.includes('第 3 次') && error.message.includes('HTTP 404') && error.message.includes('勿立即重传'));
  assert.equal(calls.filter(isDetail).length, 3);
  assert.equal(posts(calls).length, 1);
});

for (const status of [401, 403, 429, 500]) {
  test(`readback HTTP ${status} does not retry or repeat POST`, async t => {
    const { browser, calls, delays } = await fixture(t, call => isDetail(call) ? new Response(null, { status }) : undefined);
    await assert.rejects(browser.transfer('123'), error => error.message.includes('目标活动读回') && (status !== 401 || error.region === 'com'));
    assert.equal(calls.filter(isDetail).length, 1);
    assert.equal(posts(calls).length, 1);
    assert.equal(delays.length, 0);
  });
}

test('valid JSON with a different activity ID is not accepted or retried', async t => {
  const { browser, calls } = await fixture(t, call => isDetail(call) ? json({ activityId: 988 }) : undefined);
  await assert.rejects(browser.transfer('123'), /目标活动 ID 不匹配/);
  assert.equal(calls.filter(isDetail).length, 1);
  assert.equal(posts(calls).length, 1);
});

test('intent persistence failure prevents upload and imported-ID persistence failure prevents readback', async t => {
  const { browser, calls } = await fixture(t);
  await assert.rejects(browser.transfer('123', { beforeUpload: async () => { throw new Error('private disk path'); } }), error => error.message.includes('未发送文件') && !error.message.includes('private'));
  assert.equal(posts(calls).length, 0);
  await assert.rejects(browser.transfer('123', { onImported: async () => { throw new Error('secret value'); } }), error => error.message.includes('保存待核验记录失败') && !error.message.includes('secret'));
  assert.equal(posts(calls).length, 1);
  assert.equal(calls.filter(isDetail).length, 0);
});

test('standalone confirm only reads while download can be reused for both region uploads', async t => {
  const { browser, calls } = await fixture(t);
  const file = await browser.download('cn', '123');
  assert.equal(file.fileName, 'garmin_123.fit');
  assert.deepEqual(file.data, fitBytes());
  await browser.upload('com', file);
  await browser.upload('cn', file);
  assert.equal(calls.filter(call => call.url.pathname.includes('download-service')).length, 1);
  assert.deepEqual(posts(calls).map(call => call.region), ['com', 'cn']);
  const count = posts(calls).length;
  assert.equal((await browser.confirm('com', '987')).activityId, '987');
  assert.equal(posts(calls).length, count);
});

test('accountKey is stable and opaque, and browser account switch blocks operations until manual verify', async t => {
  const { browser, calls, identities } = await fixture(t);
  const first = await browser.verify('com');
  assert.match(first.accountKey, /^[0-9a-f]{64}$/);
  assert.equal(first.accountKey, (await browser.verify('com')).accountKey);
  assert.ok(!JSON.stringify(first).includes('private'));
  identities.com = 201;
  await assert.rejects(browser.upload('com', { data: fitBytes(), fileName: 'ride.fit' }), error => error.status === 401 && error.region === 'com');
  assert.equal(posts(calls).length, 0);
  await browser.openLogin('com');
  const next = await browser.verify('com');
  assert.notEqual(next.accountKey, first.accountKey);
});

test('activity verification may fall back without inventing account identity', async t => {
  const { browser } = await fixture(t, call => call.url.pathname.includes('socialProfile') ? new Response(null, { status: 404 }) : undefined);
  assert.equal(Object.hasOwn(await browser.verify('cn'), 'accountKey'), false);
});

test('China verification waits through the blank sign-in redirect and uses the returned activity tab', async t => {
  const { browser, calls, contexts, pages } = await fixture(t);
  await pages.cn.goto('https://connect.garmin.cn/signin/');
  await assert.rejects(browser.verify('cn'), error => error.status === 409 && !error.region);
  assert.deepEqual(calls, []);

  const activityTab = { ...pages.cn };
  pages.cn.url = () => 'https://sso.garmin.cn/portal/sso/zh-CN/sign-in';
  await activityTab.goto('https://connect.garmin.cn/app/activities');
  contexts.cn.pages = () => [pages.cn, activityTab];
  const result = await browser.verify('cn');
  assert.equal(result.sessionState.cookies[0].value, 'session-cn');
  assert.equal(calls.filter(isList).length, 1);
});

test('an unauthorized response during manual China login can be retried in the same window', async t => {
  let signedIn = false;
  const { browser, launches } = await fixture(t, call => call.region === 'cn' && !signedIn ? new Response(null, { status: 401 }) : undefined);
  await assert.rejects(browser.verify('cn'), error => error.status === 409 && !error.region);
  signedIn = true;
  assert.ok((await browser.verify('cn')).sessionState);
  assert.equal(launches.length, 2);
});

test('known identity cannot silently degrade when socialProfile stops working', async t => {
  let unavailable = false;
  const { browser, calls } = await fixture(t, call => unavailable && call.url.pathname.includes('socialProfile') ? new Response(null, { status: 404 }) : undefined);
  await browser.verify('com');
  unavailable = true;
  await assert.rejects(browser.upload('com', { data: fitBytes(), fileName: 'ride.fit' }), /当前账号身份无法核实/);
  assert.equal(posts(calls).length, 0);
});

test('account change during 404 delay stops further confirmation reads', async t => {
  let identities;
  const fixtureResult = await fixture(t, call => {
    if (isDetail(call)) { identities.com = 201; return new Response(null, { status: 404 }); }
  });
  identities = fixtureResult.identities;
  await assert.rejects(fixtureResult.browser.transfer('123'), error => error.region === 'com' && error.message.includes('账号已变化') && error.message.includes('勿立即重传'));
  assert.equal(fixtureResult.calls.filter(isDetail).length, 1);
  assert.equal(posts(fixtureResult.calls).length, 1);
});

test('asynchronous intent callback cannot change already validated file bytes', async t => {
  const { browser, calls } = await fixture(t);
  const data = fitBytes();
  await browser.upload('com', { data, fileName: 'ride.fit' }, { beforeUpload: async () => data.fill(0) });
  const uploaded = Buffer.from(await posts(calls)[0].options.body.get('file').arrayBuffer());
  assert.deepEqual(uploaded, fitBytes());
});

test('list-only 304 retry changes nonce and retains pagination and requested region', async t => {
  let count = 0;
  const { browser, calls } = await fixture(t, call => isList(call) && ++count === 1 ? new Response(null, { status: 304 }) : undefined);
  assert.deepEqual(await browser.activities(20, 'com'), { activities: [], nextStart: null });
  const lists = calls.filter(isList);
  assert.equal(lists.length, 2);
  assert.ok(lists.every(call => call.region === 'com' && call.url.searchParams.get('start') === '20' && call.url.searchParams.get('limit') === '20'));
  assert.notEqual(lists[0].url.searchParams.get('_gctFresh'), lists[1].url.searchParams.get('_gctFresh'));
  assert.ok(calls.filter(call => !isList(call)).every(call => !call.url.searchParams.has('_gctFresh')));
});

test('two 304s remain an explicit failure; malformed JSON and HTML never become an empty list', async t => {
  let mode = '304';
  const { browser, calls } = await fixture(t, call => {
    if (!isList(call)) return;
    if (mode === '304') return new Response(null, { status: 304 });
    return new Response(mode === 'html' ? '<html>login</html>' : '{broken', { headers: { 'Content-Type': mode === 'html' ? 'text/html' : 'application/json' } });
  });
  await assert.rejects(browser.activities(), /HTTP 304/);
  assert.equal(calls.filter(isList).length, 2);
  for (mode of ['html', 'json']) await assert.rejects(browser.activities(), GarminError);
});

test('invalid FIT and multi-FIT archives stop before POST; external XML entities are rejected', async t => {
  let multi = false;
  const { browser, calls } = await fixture(t, call => multi && call.url.pathname.includes('download-service') ? new Response(zipSync({ 'one.fit': fitBytes(), 'two.fit': fitBytes() })) : undefined);
  assert.equal(validFit(fitBytes()), true);
  const bad = fitBytes(); bad[12] ^= 1;
  assert.equal(validFit(bad), false);
  await assert.rejects(browser.upload('com', { data: bad, fileName: 'ride.fit' }), /校验不通过/);
  multi = true;
  await assert.rejects(browser.transfer('123'), /唯一的 FIT/);
  await assert.rejects(browser.upload('com', { data: Buffer.from('<!DOCTYPE gpx><gpx/>'), fileName: 'ride.gpx' }), /实体声明/);
  assert.equal(posts(calls).length, 0);
});

test('uploadId without imported activity ID cannot trigger readback or onImported', async t => {
  const { browser, calls } = await fixture(t, call => call.method === 'POST' ? json({ uploadId: 999 }, 202) : undefined);
  let callback = false;
  await assert.rejects(browser.transfer('123', { onImported: async () => { callback = true; } }), /未返回唯一成功活动 ID/);
  assert.equal(callback, false);
  assert.equal(calls.filter(isDetail).length, 0);
  assert.equal(posts(calls).length, 1);
});

test('duplicate and definitive rejection have typed outcomes; mixed replies remain unconfirmed', async t => {
  let mode = 'duplicate';
  const { browser } = await fixture(t, call => {
    if (call.method !== 'POST') return;
    return json({ detailedImportResult: {
      failures: [{ messages: [{ content: mode === 'rejected' ? 'Invalid file' : 'Duplicate activity' }] }],
      successes: mode === 'mixed' ? [{ internalId: 987 }] : [],
    } });
  });
  await assert.rejects(browser.transfer('123'), error => error.outcome === 'duplicate' && error.mayHaveUploaded === false);
  mode = 'rejected';
  await assert.rejects(browser.transfer('123'), error => error.status === 422 && error.mayHaveUploaded === false);
  mode = 'mixed';
  await assert.rejects(browser.transfer('123'), error => error.outcome !== 'duplicate' && error.mayHaveUploaded !== false);
  await assert.rejects(browser.upload('com', { data: Buffer.from('bad'), fileName: 'bad.fit' }), error => error.mayHaveUploaded === false);
});

test('verified session-only cookies survive window close through lazy headless reopen on the same profile', async t => {
  const { browser, contexts, launches, calls } = await fixture(t);
  const verified = await browser.verify('cn');
  assert.equal(verified.sessionState.cookies[0].expires, -1);
  await contexts.cn.close();
  assert.equal(launches.length, 2);
  const result = await browser.activities();
  assert.deepEqual(result.activities, []);
  assert.equal(launches.length, 3);
  assert.equal(launches[2].headless, true);
  assert.equal(launches[2].profile, launches[0].profile);
  assert.deepEqual(contexts.cn.state, verified.sessionState);
  assert.equal(posts(calls).length, 0);
});

test('restore is memory-only, makes a private copy, and background verify never rebinds another account', async t => {
  const { browser, root, launches, identities } = await fixture(t);
  const record = await browser.verify('cn');
  await browser.close();
  const restarted = new GarminBrowser(root);
  t.after(() => restarted.close());
  restarted.restore('cn', record);
  record.sessionState.cookies[0].value = 'caller-mutation';
  assert.equal(launches.length, 2);
  const result = await restarted.verify('cn');
  assert.equal(result.sessionState.cookies[0].value, 'session-cn');
  identities.cn = 101;
  await assert.rejects(restarted.verify('cn'), error => error.status === 401 && error.region === 'cn');
  const count = launches.length;
  await assert.rejects(restarted.activities(), error => error.status === 401);
  assert.equal(launches.length, count);
});

test('background 401 stops without retry; 429 and network failures preserve the saved proof', async t => {
  let mode;
  const { browser, contexts, calls, launches, root } = await fixture(t, call => {
    if (mode && call.url.pathname.includes('socialProfile')) return new Response(null, { status: mode });
  });
  const record = await browser.verify('cn');
  await contexts.cn.close();
  for (mode of [429, 500]) {
    const before = calls.length;
    await assert.rejects(browser.activities(), error => error.status === (mode === 429 ? 429 : 503) && !error.region);
    assert.equal(calls.length, before + 1);
  }
  mode = 401;
  await assert.rejects(browser.activities(), error => error.status === 401 && error.region === 'cn');
  const count = launches.length, before = calls.length;
  await assert.rejects(browser.activities(), error => error.status === 401);
  assert.equal(launches.length, count);
  assert.equal(calls.length, before);
  // The same valid record is sufficient after a process restart; no password is exposed.
  assert.equal(typeof record.accountKey, 'string');
  assert.ok(root);
});

test('closing evaluate during GET preserves proof and closing POST never repeats upload', async t => {
  const { browser, contexts, pages, calls, launches } = await fixture(t);
  await browser.verify('cn');
  const evaluate = pages.cn.evaluate;
  pages.cn.evaluate = async () => { await contexts.cn.close(); throw new Error('context destroyed with secret'); };
  await assert.rejects(browser.activities(), error => error.status === 503 && !error.region && !error.message.includes('secret'));
  await browser.activities();
  assert.equal(launches.at(-1).headless, true);
  assert.notEqual(pages.cn.evaluate, evaluate);
  await browser.verify('com');
  const normal = pages.com.evaluate;
  pages.com.evaluate = async (fn, args) => {
    if (args?.upload) { await contexts.com.close(); throw new Error('upload context destroyed'); }
    return normal(fn, args);
  };
  await assert.rejects(browser.upload('com', { data: fitBytes(), fileName: 'ride.fit' }), error => error.status === 502 && !error.region && error.mayHaveUploaded !== false);
  assert.equal(posts(calls).length, 0);
  await browser.activities(0, 'com');
  assert.equal(launches.at(-1).headless, true);
});

test('changed snapshots are awaited once, are official-scope only, and verify does not call persistence twice', async t => {
  const saved = [];
  const { browser, contexts } = await fixture(t, () => undefined, { onSessionState: async (region, record) => {
    await new Promise(resolve => setImmediate(resolve));
    saved.push({ region, record });
  } });
  contexts.cn.state.cookies.push({ ...contexts.cn.state.cookies[0], domain: '.example.invalid', value: 'unrelated' });
  const record = await browser.verify('cn');
  assert.equal(record.sessionState.cookies.length, 1);
  assert.equal(saved.length, 0);
  contexts.cn.state.cookies[0].value = 'rotated';
  await browser.activities();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].record.sessionState.cookies[0].value, 'rotated');
  await browser.activities();
  assert.equal(saved.length, 1);
  assert.throws(() => browser.restore('com', record), GarminError);
  const bad = structuredClone(record);
  bad.sessionState.origins.push({ origin: 'https://example.invalid', localStorage: [] });
  assert.throws(() => browser.restore('cn', bad), GarminError);
});

test('no stable identity stays manual-only; forget blocks lazy restore without deleting profile', async t => {
  let noIdentity = true;
  const { browser, contexts, launches } = await fixture(t, call => noIdentity && call.url.pathname.includes('socialProfile') ? new Response(null, { status: 404 }) : undefined);
  assert.equal(Object.hasOwn(await browser.verify('cn'), 'sessionState'), false);
  await contexts.cn.close();
  await assert.rejects(browser.activities(), error => error.status === 401);
  assert.equal(launches.length, 2);
  noIdentity = false;
  await browser.openLogin('cn');
  await browser.verify('cn');
  await contexts.cn.close();
  await browser.activities();
  await browser.openLogin('cn');
  assert.equal(launches.at(-1).headless, false);
  await browser.verify('cn');
  browser.forget('cn');
  await assert.rejects(browser.activities(), error => error.status === 401);
});
