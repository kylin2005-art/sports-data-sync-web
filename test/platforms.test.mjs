import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { unzipSync } from 'fflate';
import { PlatformUploads, PlatformError, PLATFORM_DEFINITIONS, validateCredential } from '../platforms.mjs';

function crc(bytes) {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
  }
  return value;
}
function fit(length = 30) {
  const bytes = Buffer.alloc(length);
  bytes[0] = 12;
  bytes[1] = 16;
  bytes.writeUInt32LE(length - 14, 4);
  bytes.write('.FIT', 8);
  bytes.writeUInt16LE(crc(bytes.subarray(0, -2)), bytes.length - 2);
  return bytes;
}
const credentials = {
  intervals_icu: { apiKey: 'synthetic-api-key' },
  wahoo: { token: 'synthetic-token' },
  suunto: { token: 'synthetic-token', subscriptionKey: 'synthetic-subscription' },
  xingzhe: { sessionId: 'synthetic-session', csrfToken: 'synthetic-csrf' },
  igpsport: { token: 'synthetic-token' }, igpsport_int: { token: 'synthetic-int-token' }, magene: { token: 'synthetic-token' },
  blackbird: { cookie: 'session=synthetic-session' }, giant: { token: 'synthetic-token' },
  outbase: { sessionId: 'synthetic-session' }, komoot: { email: 'synthetic@example.com', token: 'synthetic-token' },
  coros_cn: { token: 'synthetic-token' }, coros_int: { token: 'synthetic-token', region: '3' },
  cycity: { token: 'synthetic-token' },
};
const input = (platform, extra = {}) => ({ platform, credential: credentials[platform], data: fit(), fileName: 'source.fit', activity: { id: 'synthetic-source', name: '合成骑行', type: 'cycling' }, ...extra });

function harness(steps, options = {}) {
  const calls = [];
  const queue = [...steps];
  const uploader = new PlatformUploads({
    sleep: async () => {}, pollAttempts: 2,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...init });
      assert.equal(init.redirect, 'manual');
      assert.ok(init.signal instanceof AbortSignal);
      assert.ok(queue.length, `Unexpected request to ${new URL(url).host}`);
      const step = queue.shift();
      if (typeof step === 'function') return step(String(url), init);
      const body = step.status === 204 ? null : step.raw ?? JSON.stringify(step.data ?? {});
      return new Response(body, { status: step.status || 200, headers: { 'Content-Type': step.raw ? 'text/html' : 'application/json' } });
    }, ...options,
  });
  return { uploader, calls, remaining: () => queue.length };
}

test('every offered platform has explicit credential fields and formats', () => {
  assert.equal(PLATFORM_DEFINITIONS.length, 14);
  assert.equal(new Set(PLATFORM_DEFINITIONS.map(item => item.id)).size, 14);
  for (const item of PLATFORM_DEFINITIONS) {
    assert.ok(item.fields.some(field => field.required));
    assert.ok(item.formats.includes('fit'));
    assert.deepEqual(validateCredential(item.id, { ...credentials[item.id], unexpected: 'discard-me' }), credentials[item.id]);
  }
  assert.throws(() => validateCredential('keep', {}), error => error.code === 'unsupported');
  assert.throws(() => validateCredential('wahoo', {}), error => error.status === 400);
  assert.throws(() => validateCredential('wahoo', { token: 'token\r\nInjected: header' }), error => error.code === 'credential');
  assert.throws(() => validateCredential('xingzhe', { sessionId: 'sessionid=value; extra=x' }), error => error.code === 'credential');
});

test('bad files or unsupported GPX fail before the write callback or any request', async () => {
  const { uploader, calls } = harness([]);
  let reserved = false;
  const corrupt = fit(); corrupt[15] ^= 1;
  await assert.rejects(uploader.upload(input('wahoo', { data: corrupt, beforeUpload: () => { reserved = true; } })), error => error.code === 'file' && !error.mayHaveUploaded);
  await assert.rejects(uploader.upload(input('xingzhe', { data: Buffer.from('<gpx version="1.1"><trk/></gpx>'), fileName: 'activity.gpx' })), error => error.code === 'format');
  assert.equal(calls.length, 0);
  assert.equal(reserved, false);
});

test('a denied write reservation stops the request without claiming possible upload', async () => {
  const { uploader, calls } = harness([]);
  await assert.rejects(uploader.upload(input('giant', { beforeUpload: () => { throw new Error('private ledger detail'); } })), error => error.code === 'preflight' && error.status === 409 && !error.mayHaveUploaded && !error.message.includes('private'));
  assert.equal(calls.length, 0);
});

test('Intervals requires the returned activity id to match its authenticated readback', async () => {
  const { uploader, calls } = harness([{ data: { activities: [{ id: 'i123' }] } }, { data: { id: 'i123' } }]);
  const result = await uploader.upload(input('intervals_icu'));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.activityId, 'i123');
  assert.equal(result.url, 'https://intervals.icu/activities/i123');
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('API_KEY:synthetic-api-key').toString('base64')}`);
  assert.match(new URL(calls[0].url).searchParams.get('external_id'), /^sports-sync-[0-9a-f]{64}$/);
  assert.deepEqual(Buffer.from(await calls[0].body.get('file').arrayBuffer()), fit());
  assert.match(calls[1].url, /\/activity\/i123$/);
});

test('Intervals bare HTTP success or mismatched id is never confirmed', async () => {
  for (const steps of [[{ data: {} }], [{ data: { activities: [{ id: 'i123' }] } }, { data: { id: 'i456' } }], [{ data: { errors: ['synthetic-error'], activities: [{ id: 'i123' }] } }]]) {
    const { uploader } = harness(steps);
    await assert.rejects(uploader.upload(input('intervals_icu')), error => error instanceof PlatformError && error.mayHaveUploaded);
  }
});

test('Xingzhe sends original FIT with MD5 and requires parsed workout receipt', async () => {
  const { uploader, calls } = harness([{ data: { code: 0, data: { workout_id: 123, handle_msg: 'ok' } } }]);
  const result = await uploader.upload(input('xingzhe'));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.activityId, '123');
  assert.equal(calls[0].headers.Cookie, 'sessionid=synthetic-session; csrftoken=synthetic-csrf');
  assert.equal(calls[0].headers['X-CSRFToken'], 'synthetic-csrf');
  assert.equal(calls[0].body.get('md5'), createHash('md5').update(fit()).digest('hex'));
  assert.deepEqual(Buffer.from(await calls[0].body.get('fit_file').arrayBuffer()), fit());
});

const corosAccount = { data: { result: '0000', data: { userId: '123456' } } };
const corosRegistration = { data: { result: '0000', data: { id: 'task-1' } } };
function corosSts(china, bucketOverride) {
  const bucket = china ? 'coros-oss' : 'eu-coros';
  const region = china ? 'oss-cn-beijing' : 'eu-central-1';
  const service = china ? 'aliyun' : 'aws';
  const credentials = {
    Bucket: bucketOverride || bucket, Region: region, AccessKeyId: 'mock-storage-id',
    ...(china ? { AccessKeySecret: 'mock-storage-secret', SecurityToken: 'mock-storage-token' }
      : { SecretAccessKey: 'mock-storage-secret', SessionToken: 'mock-storage-token' })
  };
  const encoded = Buffer.from(JSON.stringify(credentials)).toString('base64');
  return { data: { code: 200, data: { service, credentials: encoded.slice(0, 5) + '9y78gpoERW4lBNYL' + encoded.slice(5) } } };
}

test('COROS China and international use their own Training Hub session and upload original FIT inside a ZIP', async () => {
  for (const platform of ['coros_cn', 'coros_int']) {
    const china = platform === 'coros_cn';
    const site = china ? 'trainingcn.coros.com' : 'trainingeu.coros.com';
    const api = china ? 'teamcnapi.coros.com' : 'teameuapi.coros.com';
    const storage = china ? 'coros-oss.oss-cn-beijing.aliyuncs.com' : 'eu-coros.s3.eu-central-1.amazonaws.com';
    const { uploader, calls, remaining } = harness([
      corosAccount, corosSts(china), { status: 204 }, corosRegistration,
      { data: { result: '0000', data: [{ id: 'other-task', status: 2 }, { id: 'task-1', status: 1 }] } },
      { data: { result: '0000', data: [{ id: 'task-1', status: 2, errorSize: 0 }] } }
    ]);
    let reservations = 0;
    const bytes = fit(21 * 1024);
    const result = await uploader.upload(input(platform, { data: bytes, beforeUpload: () => {
      assert.equal(calls.length, 2); reservations++;
    } }));
    assert.equal(reservations, 1);
    assert.equal(remaining(), 0);
    assert.equal(result.status, 'accepted');
    assert.equal(result.activityId, undefined);
    assert.match(result.message, /task-1 已处理/);
    assert.equal(calls[0].url, `https://${api}/account/query`);
    assert.equal(calls[1].url, `https://${site}/api/proxy/oss/sts`);
    assert.equal(calls[1].headers.Cookie, `CPL-coros-region=${china ? 2 : 3}; CPL-coros-token=synthetic-token`);
    assert.equal(calls[2].method, 'PUT');
    const zip = calls[2].body;
    const md5 = createHash('md5').update(zip).digest('hex');
    const key = `fit_zip/123456/${md5}.zip`;
    assert.equal(calls[2].url, `https://${storage}/${key}`);
    assert.equal(calls[2].headers.Cookie, undefined);
    assert.equal(calls[2].headers.accesstoken, undefined);
    assert.deepEqual(Buffer.from(unzipSync(zip)['source.fit']), bytes);
    if (china) {
      const date = calls[2].headers.Date;
      const signature = createHmac('sha1', 'mock-storage-secret').update(
        `PUT\n\napplication/octet-stream\n${date}\nx-oss-security-token:mock-storage-token\n/coros-oss/${key}`
      ).digest('base64');
      assert.equal(calls[2].headers.Authorization, `OSS mock-storage-id:${signature}`);
    } else {
      assert.match(calls[2].headers.Authorization, /^AWS4-HMAC-SHA256 Credential=mock-storage-id\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[a-f0-9]{64}$/);
      assert.equal(calls[2].headers['x-amz-content-sha256'], createHash('sha256').update(zip).digest('hex'));
    }
    assert.equal(calls[3].url, `https://${api}/activity/fit/import`);
    assert.equal(calls[3].headers.accesstoken, 'synthetic-token');
    const params = JSON.parse(calls[3].body.get('jsonParameter'));
    assert.deepEqual(params, {
      source: 1, timezone: -new Date().getTimezoneOffset() / 15 || 0, bucket: china ? 'coros-oss' : 'eu-coros',
      md5, size: zip.length, object: key, serviceName: china ? 'aliyun' : 'aws', oriFileName: 'source.zip'
    });
    assert.equal(calls[4].url, `https://${api}/activity/fit/getImportSportList`);
    assert.deepEqual(JSON.parse(calls[4].body), { size: 10 });
  }
});

test('COROS rejects invalid storage identity before staging and preserves ambiguity after registration', async () => {
  const data = fit(21 * 1024);
  const invalid = harness([corosAccount, corosSts(true, 'other-bucket')]);
  await assert.rejects(invalid.uploader.upload(input('coros_cn', { data })), error =>
    error.code === 'storage' && !error.mayHaveUploaded);
  assert.equal(invalid.calls.length, 2);
  const noJob = harness([corosAccount, corosSts(true), { status: 204 }, { data: { result: '0000', data: {} } }]);
  await assert.rejects(noJob.uploader.upload(input('coros_cn', { data })), error =>
    error.code === 'unconfirmed' && error.mayHaveUploaded);
  assert.equal(noJob.calls.length, 4);
  const rejected = harness([corosAccount, corosSts(true), { status: 204 }, corosRegistration,
    { data: { result: '0000', data: [{ id: 'task-1', status: 2, errorSize: 1, message: 'private response' }] } }
  ]);
  await assert.rejects(rejected.uploader.upload(input('coros_cn', { data })), error =>
    error.code === 'unconfirmed' && error.mayHaveUploaded && !error.message.includes('private response'));
});

test('CyCity sends a FIT to its parser and registers only that parsed payload', async () => {
  const parsed = { startTime: '2026-10-25 18:00:00', movingDistance: 23.5 };
  const { uploader, calls } = harness([{ data: { code: 200, data: parsed } }, { data: { code: 200 } }]);
  const receipt = await uploader.upload(input('cycity'));
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.activityId, undefined);
  assert.equal(calls[0].url, 'https://cycity.cc/api/mobile/cycling/import');
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-token');
  assert.deepEqual(Buffer.from(await calls[0].body.get('file').arrayBuffer()), fit());
  assert.equal(calls[1].url, 'https://cycity.cc/api/mobile/cycling/uploadImportData');
  assert.deepEqual(JSON.parse(calls[1].body), parsed);
  const malformed = harness([{ data: { code: 200, data: [] } }]);
  await assert.rejects(malformed.uploader.upload(input('cycity')), error => error.code === 'unconfirmed');
  assert.equal(malformed.calls.length, 1);
});

test('Xingzhe duplicate is structural and error text cannot impersonate it', async () => {
  const duplicate = harness([{ status: 400, data: { code: 9006 } }]);
  assert.equal((await duplicate.uploader.upload(input('xingzhe'))).status, 'duplicate');
  const fake = harness([{ data: { code: 123, msg: 'not duplicate 9006' } }]);
  await assert.rejects(fake.uploader.upload(input('xingzhe')));
  const failedParse = harness([{ data: { code: 0, data: { workout_id: 123, handle_msg: 'invalid file' } } }]);
  await assert.rejects(failedParse.uploader.upload(input('xingzhe')));
});

test('Xingzhe HTTP200 authentication error invalidates credentials without false success', async () => {
  const { uploader } = harness([{ data: { code: 401, message: 'synthetic-sensitive-body' } }]);
  await assert.rejects(uploader.upload(input('xingzhe')), error => error.status === 401 && !error.mayHaveUploaded && !error.message.includes('synthetic-sensitive-body'));
});

test('Magene, Blackbird and Giant use structured acceptance and never invent activity IDs', async () => {
  for (const [platform, data, field] of [['magene', { code: 200, data: { success_count: 1 } }, 'jilu0'], ['blackbird', { status: 'ok' }, 'file'], ['giant', { status: 1 }, 'files[]']]) {
    const { uploader, calls } = harness([{ data }]);
    const result = await uploader.upload(input(platform));
    assert.equal(result.status, 'accepted');
    assert.equal(result.activityId, undefined);
    assert.equal(result.url, undefined);
    assert.ok(calls[0].body.get(field) instanceof Blob);
  }
});

test('legacy providers do not accept success words inside errors or HTML', async () => {
  for (const [platform, response] of [['magene', { data: { code: 200, data: { success_count: 0 } } }], ['blackbird', { data: { message: 'unsuccessful' } }], ['blackbird', { data: { code: 0, status: 'failed' } }], ['giant', { raw: '<html>success</html>' }]]) {
    const { uploader } = harness([response]);
    await assert.rejects(uploader.upload(input(platform)), error => error instanceof PlatformError && error.mayHaveUploaded);
  }
});

test('iGPSPORT reserves once after signed URL preflight and never sends credentials to storage', async () => {
  const { uploader, calls } = harness([
    { data: { code: 0, data: { signedUrl: 'https://igpsport.oss-cn-hangzhou.aliyuncs.com/fit?signature=synthetic', ossId: 'synthetic-oss' } } },
    { status: 204 }, { data: { code: 0, data: { id: 'only-a-job-id' } } },
  ]);
  let reservations = 0;
  const result = await uploader.upload(input('igpsport', { beforeUpload: () => { reservations++; assert.equal(calls.length, 1); } }));
  assert.equal(reservations, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.activityId, undefined);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers['Content-Type'], undefined);
  assert.equal(JSON.parse(calls[2].body).ossName, 'synthetic-oss');
});

test('iGPSPORT rejects non-HTTPS, credentialed and unexpected dynamic storage hosts', async () => {
  for (const signedUrl of ['http://bucket.aliyuncs.com/file', 'https://bucket.aliyuncs.com.evil.test/file', 'https://user:password@bucket.aliyuncs.com/file', 'https://127.0.0.1/file']) {
    const { uploader, calls } = harness([{ data: { code: 0, data: { signedUrl, ossId: 'synthetic' } } }]);
    let reserved = false;
    await assert.rejects(uploader.upload(input('igpsport', { beforeUpload: () => { reserved = true; } })), error => error.code === 'storage' && !error.mayHaveUploaded);
    assert.equal(reserved, false);
    assert.equal(calls.length, 1);
  }
});

test('iGPSPORT international sends the file and import metadata only through its own region', async () => {
  const { uploader, calls } = harness([
    { data: { code: 0, data: { signedUrl: 'https://igpsport.oss-cn-hongkong.aliyuncs.com/fit?signature=synthetic', ossId: 'int-oss' } } },
    { status: 204 }, { data: { code: 0, data: { id: 'only-a-job-id' } } }
  ]);
  const result = await uploader.upload(input('igpsport_int', { fileName: `${'x'.repeat(60)}.fit` }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.activityId, undefined);
  assert.equal(calls[0].url, 'https://prod.en.igpsport.com/service/sportg/third-party-server/oss/getSignedUrl?fileExtension=.fit');
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-int-token');
  assert.equal(calls[0].headers.Origin, 'https://app.igpsport.com');
  assert.equal(calls[0].headers['X-Platform'], 'web');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers['Content-Type'], '');
  assert.deepEqual(calls[1].body, fit());
  assert.equal(calls[2].url, 'https://prod.en.igpsport.com/service/web-gateway/web-analyze/activity/uploadByOss');
  assert.equal(calls[2].headers.Authorization, 'Bearer synthetic-int-token');
  assert.deepEqual(JSON.parse(calls[2].body), { fileName: `${'x'.repeat(50)}.fit`, ossName: 'int-oss' });
});

test('Outbase registers the exact uploaded file and only marks registration accepted', async () => {
  const { uploader, calls } = harness([{ data: { message: 'SUCCESS' } }, { data: { ec: 0 } }]);
  let count = 0;
  const result = await uploader.upload(input('outbase', { beforeUpload: () => { count++; } }));
  assert.equal(result.status, 'accepted');
  assert.equal(count, 1);
  const registration = JSON.parse(calls[1].body);
  assert.equal(registration.fitGuid, new URL(calls[0].url).searchParams.get('id'));
  assert.equal(registration.sign, createHash('md5').update(fit()).digest('hex'));
  assert.equal(registration.fileSize, fit().length);
  assert.equal(calls[0].headers.Sessionid, undefined);
  assert.equal(calls[1].headers.Sessionid, 'synthetic-session');
});

test('Wahoo polls one submitted file until complete with a workout id', async () => {
  const { uploader, calls } = harness([{ status: 201, data: { token: 'synthetic-job', status: 'pending' } }, { data: { status: 'in_progress' } }, { data: { status: 'complete', workout_id: 99 } }]);
  const result = await uploader.upload(input('wahoo'));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.activityId, '99');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls[0].body.get('workout_file_upload[file]'), `data:application/vnd.fit;base64,${fit().toString('base64')}`);
});

test('Wahoo invalid or missing job data is never assumed successful', async () => {
  for (const data of [{}, { token: '' }, { status: 'complete' }, { status: 'complete', workout_id: 0 }, { status: 'error', error: 'synthetic-private-error' }]) {
    const { uploader } = harness([{ data }]);
    await assert.rejects(uploader.upload(input('wahoo')), error => error.mayHaveUploaded && !error.message.includes('synthetic-private-error'));
  }
});

test('Wahoo pending timeout is accepted and duplicate stays a separate outcome', async () => {
  const pending = { data: { token: 'synthetic-job', status: 'pending' } };
  const { uploader, calls } = harness([pending, pending, pending]);
  assert.equal((await uploader.upload(input('wahoo'))).status, 'accepted');
  assert.equal(calls.length, 3);
  const duplicate = harness([{ data: { status: 'duplicate', workout_id: 99 } }]);
  assert.equal((await duplicate.uploader.upload(input('wahoo'))).status, 'duplicate');
});

const suuntoInit = { status: 201, data: { id: 'synthetic-upload', url: 'https://suunto.blob.core.windows.net/fit/synthetic?sig=synthetic-secret', method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' } } };
test('Suunto uses official init fields and storage headers, then requires processed workoutKey', async () => {
  const { uploader, calls } = harness([suuntoInit, { status: 201 }, { data: { status: 'ACCEPTED' } }, { data: { status: 'PROCESSED', workoutKey: 'synthetic-workout', webUrl: 'https://www.suunto.com/move/synthetic/synthetic-workout' } }]);
  const result = await uploader.upload(input('suunto'));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.activityId, 'synthetic-workout');
  assert.equal(calls[1].headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers['Ocp-Apim-Subscription-Key'], undefined);
  assert.equal(calls[2].headers['Ocp-Apim-Subscription-Key'], 'synthetic-subscription');
});

test('Suunto rejects unknown storage hosts before sending any FIT data', async () => {
  const { uploader, calls } = harness([{ data: { ...suuntoInit.data, url: 'https://suunto.blob.core.windows.net.evil.test/file' } }]);
  await assert.rejects(uploader.upload(input('suunto')), error => error.code === 'storage' && !error.mayHaveUploaded);
  assert.equal(calls.length, 1);
});

test('Suunto ERROR and PROCESSED without a workoutKey remain failures', async () => {
  for (const data of [{ status: 'ERROR', message: 'synthetic-private-error' }, { status: 'PROCESSED' }]) {
    const { uploader } = harness([suuntoInit, { status: 201 }, { data }]);
    await assert.rejects(uploader.upload(input('suunto')), error => error.mayHaveUploaded && !error.message.includes('synthetic-private-error'));
  }
});

test('Komoot raw GPX preserves bytes and verifies the returned tour id', async () => {
  const gpx = Buffer.from('<?xml version="1.0"?><gpx version="1.1"><trk/></gpx>');
  const { uploader, calls } = harness([{ status: 201, data: { id: 321 } }, { data: { id: 321 } }]);
  const result = await uploader.upload(input('komoot', { data: gpx, fileName: 'activity.gpx' }));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.url, 'https://www.komoot.com/tour/321');
  assert.equal(new URL(calls[0].url).searchParams.get('data_type'), 'gpx');
  assert.equal(new URL(calls[0].url).searchParams.get('sport'), 'racebike');
  assert.deepEqual(calls[0].body, gpx);
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('synthetic@example.com:synthetic-token').toString('base64')}`);
});

test('401 and 429 stop immediately while timeout after submission remains ambiguous', async () => {
  for (const status of [401, 429]) {
    const { uploader, calls } = harness([{ status, data: { message: 'synthetic-sensitive-response' } }]);
    await assert.rejects(uploader.upload(input('giant')), error => error.status === status && !error.mayHaveUploaded && !error.message.includes('synthetic-sensitive-response'));
    assert.equal(calls.length, 1);
  }
  const { uploader, calls } = harness([(_url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic-url-with-token')), { once: true }))], { timeoutMs: 20 });
  await assert.rejects(uploader.upload(input('giant')), error => error.code === 'network' && error.mayHaveUploaded && !error.message.includes('synthetic-url-with-token'));
  assert.equal(calls.length, 1);
});

test('a poll authentication failure after upload must retain possible-upload state', async () => {
  const { uploader, calls } = harness([{ data: { status: 'pending', token: 'synthetic-job' } }, { status: 401 }]);
  await assert.rejects(uploader.upload(input('wahoo')), error => error.status === 401 && error.mayHaveUploaded);
  assert.equal(calls.length, 2);
});

test('HTTP redirects and HTML never produce successful or accepted receipts', async () => {
  for (const step of [{ status: 302 }, { raw: '<html>Please sign in. success</html>' }]) {
    const { uploader, calls } = harness([step]);
    await assert.rejects(uploader.upload(input('giant')));
    assert.equal(calls.length, 1);
  }
});
