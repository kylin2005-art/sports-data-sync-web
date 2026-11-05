import { createHash, createHmac } from 'node:crypto';
import { zipSync } from 'fflate';

const token = { key: 'token', label: '训练中心登录 Token', type: 'password', required: true };
export const COROS_TARGETS = [
  { id: 'coros_cn', name: '高驰中国', formats: ['fit'], fields: [token], note: '通过训练中心导入 FIT，按导入任务状态核对。' },
  { id: 'coros_int', name: '高驰国际', formats: ['fit'], fields: [token, { key: 'region', label: '账号区域（1 国际、3 欧洲）', type: 'text' }],
    note: '通过训练中心导入 FIT，按导入任务状态核对。' }
];

const regions = {
  1: { site: 'training.coros.com', api: 'teamapi.coros.com', bucket: 'coros-s3', region: 'us-east-1', service: 'aws', language: 'en-US' },
  2: { site: 'trainingcn.coros.com', api: 'teamcnapi.coros.com', bucket: 'coros-oss', region: 'oss-cn-beijing', service: 'aliyun', language: 'zh-CN' },
  3: { site: 'trainingeu.coros.com', api: 'teameuapi.coros.com', bucket: 'eu-coros', region: 'eu-central-1', service: 'aws', language: 'en-US' }
};
const id = value => (typeof value === 'string' || Number.isSafeInteger(value)) &&
  /^[A-Za-z0-9_-]{1,128}$/.test(String(value)) ? String(value) : null;
const hex = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const credentialValue = value => typeof value === 'string' && /^[\x21-\x7e]{1,16000}$/.test(value);

function storageCredential(result, config) {
  const data = result?.data;
  if (result?.code !== 200 || data?.service !== config.service || typeof data.credentials !== 'string') return null;
  // Training Hub applies a fixed marker to the base64-encoded STS response.
  let parsed;
  try { parsed = JSON.parse(Buffer.from(data.credentials.replace('9y78gpoERW4lBNYL', ''), 'base64').toString('utf8')); }
  catch { return null; }
  const access = parsed?.AccessKeyId;
  const secret = config.service === 'aws' ? parsed?.SecretAccessKey : parsed?.AccessKeySecret;
  const token = config.service === 'aws' ? parsed?.SessionToken : parsed?.SecurityToken;
  if (parsed?.Bucket !== config.bucket || parsed?.Region !== config.region ||
      !id(access) || !credentialValue(secret) || !credentialValue(token)) return null;
  return { access, secret, token };
}

function awsPut(config, credential, key, body, now) {
  const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const payloadHash = hex('sha256', body);
  const headers = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': date, 'x-amz-security-token': credential.token };
  const names = 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token';
  const canonical = Object.entries({ host, ...headers }).map(([name, value]) => `${name}:${value}\n`).join('');
  const request = `PUT\n/${key}\n\n${canonical}\n${names}\n${payloadHash}`;
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const signingKey = [day, config.region, 's3', 'aws4_request'].reduce(hmac, `AWS4${credential.secret}`);
  const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hex('sha256', request)}`).toString('hex');
  return {
    url: `https://${host}/${key}`,
    headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${credential.access}/${scope}, SignedHeaders=${names}, Signature=${signature}` }
  };
}

function aliyunPut(config, credential, key, now) {
  const date = now.toUTCString();
  const type = 'application/octet-stream';
  const canonical = `PUT\n\n${type}\n${date}\nx-oss-security-token:${credential.token}\n/${config.bucket}/${key}`;
  const signature = createHmac('sha1', credential.secret).update(canonical).digest('base64');
  return {
    url: `https://${config.bucket}.${config.region}.aliyuncs.com/${key}`,
    headers: { Authorization: `OSS ${credential.access}:${signature}`, Date: date, 'Content-Type': type, 'x-oss-security-token': credential.token }
  };
}

export async function uploadCoros(uploads, ctx, credential, file) {
  const region = ctx.platform === 'coros_cn' ? '2' : credential.region || '1';
  if (!(ctx.platform === 'coros_cn' ? region === '2' : ['1', '3'].includes(region)) || /[;\s]/.test(credential.token)) {
    throw uploads.error(ctx, '训练中心会话或账号区域无效。', 'credential', 400);
  }
  if (file.bytes.length < 20 * 1024) throw uploads.error(ctx, '训练中心要求活动文件至少为 20 KB。', 'file', 400);
  const config = regions[region];
  const site = `https://${config.site}`;
  const api = `https://${config.api}`;
  const cookie = `CPL-coros-region=${region}; CPL-coros-token=${credential.token}`;
  const headers = {
    Accept: 'application/json', Cookie: cookie, accesstoken: credential.token,
    Origin: site, Referer: `${site}/`, YFHeader: JSON.stringify({ language: config.language })
  };
  function checked(result) {
    if (result?.result === '1019') throw uploads.error(ctx, '训练中心会话已失效，请重新授权。', 'http', 401);
    if (result?.result !== '0000') throw uploads.error(ctx, '训练中心未确认此请求。', 'unconfirmed');
    return result.data;
  }
  const account = checked((await uploads.request(ctx, `${api}/account/query`, { headers })).data);
  const userId = id(account?.userId);
  if (!userId) throw uploads.error(ctx, '训练中心未返回有效账号编号。', 'credential');
  headers.YFHeader = JSON.stringify({ language: config.language, userId });

  const sts = await uploads.request(ctx, `${site}/api/proxy/oss/sts`, { headers: { Cookie: cookie, Accept: 'application/json' } });
  const temporary = storageCredential(sts.data, config);
  if (!temporary) throw uploads.error(ctx, '训练中心未返回与当前地区匹配的存储授权。', 'storage');

  // Select the single-FIT ZIP variant accepted by Training Hub. Hash and size describe the selected ZIP.
  const zip = zipSync({ [file.fileName]: file.bytes }, { mtime: new Date(1980, 0, 1) });
  const md5 = hex('md5', zip);
  const key = `fit_zip/${userId}/${md5}.zip`;
  const now = new Date();
  const storage = config.service === 'aws' ? awsPut(config, temporary, key, zip, now) : aliyunPut(config, temporary, key, now);
  // Only registration can import an activity. Retrying the same staged object is safe before registration.
  await uploads.request(ctx, storage.url, { method: 'PUT', headers: storage.headers, body: zip,
    write: true, allowed: [200, 201, 204], json: false });

  const body = new FormData();
  body.set('jsonParameter', JSON.stringify({
    source: 1, timezone: -now.getTimezoneOffset() / 15, bucket: config.bucket, md5, size: zip.length,
    object: key, serviceName: config.service, oriFileName: file.fileName.replace(/\.fit$/i, '.zip')
  }));
  const imported = checked((await uploads.request(ctx, `${api}/activity/fit/import`, {
    method: 'POST', headers, body, write: true, payload: true
  })).data);
  const jobId = id(imported?.id);
  if (!jobId) throw uploads.error(ctx, '未收到导入任务编号，请在训练中心核对。', 'unconfirmed');
  const receipt = uploads.receipt(ctx, 'accepted');
  receipt.message = `${ctx.name}已接收导入任务 ${jobId}，请在训练中心核对活动。`;

  for (let attempt = 0; attempt < uploads.pollAttempts; attempt++) {
    const result = await uploads.request(ctx, `${api}/activity/fit/getImportSportList`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ size: 10 })
    });
    const tasks = checked(result.data);
    if (!Array.isArray(tasks)) throw uploads.error(ctx, '无法核对导入任务状态，请在训练中心检查。', 'unconfirmed');
    const job = tasks.find(task => id(task?.id) === jobId);
    if (job?.status === 2) {
      if (job.errorSize > 0) throw uploads.error(ctx, '训练中心报告活动导入有错误。', 'unconfirmed');
      receipt.message = `${ctx.name}导入任务 ${jobId} 已处理，请在训练中心核对活动记录。`;
      return receipt;
    }
    if (job?.status < 0) throw uploads.error(ctx, '训练中心报告活动导入失败。', 'unconfirmed');
    if (attempt + 1 < uploads.pollAttempts) await uploads.sleep(3000);
  }
  return receipt;
}
