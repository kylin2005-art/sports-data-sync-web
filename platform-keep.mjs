import { createDecipheriv } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { gcj02ToWgs84 } from './fit-coordinate.mjs';

const origin = 'https://api.gotokeep.com';
const tokenField = { key: 'token', label: '登录 Token', type: 'password', required: true };
export const KEEP_SOURCES = [{
  id: 'keep', name: 'Keep', fields: [tokenField],
  note: '读取骑行记录，并将带有 GPS 轨迹的户外骑行转换为 GPX。'
}];

const pageSize = 20;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,140}$/.test(value);
const validToken = value => typeof value === 'string' && value.length <= 16000 && /^[A-Za-z0-9._~+\/-]+=*$/.test(value);
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
const date = value => value >= Date.UTC(1990, 0, 1) && value <= Date.UTC(2100, 0, 1) ? new Date(value).toISOString() : '';
const error = (status, message) => Object.assign(new Error(`Keep：${message}`), { status });

async function json(fetchImpl, path, options, limit) {
  let response;
  try {
    response = await fetchImpl(`${origin}${path}`, {
      ...options,
      headers: { Accept: 'application/json', 'User-Agent': 'Sports-Data-Sync-Web', ...options.headers },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000)
    });
  } catch {
    throw error(502, '网络连接失败或超时。');
  }
  if (response.status !== 200 || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) throw error(413, '平台响应超出大小限制。');
    throw error([401, 403, 429].includes(response.status) ? response.status : 502, `平台返回 HTTP ${response.status}。`);
  }
  let result;
  try {
    if (!response.body) throw error(502, '平台未返回 JSON 数据。');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw error(413, '平台响应超出大小限制。');
      chunks.push(chunk);
    }
    result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (cause) {
    if (cause.status === 413) throw cause;
    throw error(502, '平台未返回有效 JSON 数据。');
  }
  return result;
}

function bearer(credential) {
  if (!validToken(credential?.token)) throw error(400, '请配置有效登录会话。');
  return { Authorization: `Bearer ${credential.token}` };
}

async function signIn(input, fetchImpl = globalThis.fetch) {
  const mobile = typeof input?.mobile === 'string' ? input.mobile.trim() : '';
  const password = input?.password;
  if (!/^\+?\d{6,16}$/.test(mobile) || typeof password !== 'string' || !password ||
      password.length > 1024 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw error(400, '请填写有效的手机号和密码。');
  }
  const result = await json(fetchImpl, '/v1.1/users/login', {
    method: 'POST', body: new URLSearchParams({ mobile, password })
  }, 256 * 1024);
  if (result?.ok !== true) throw error(401, '平台未确认登录，请检查手机号、密码或账号验证状态。');
  const token = result.data?.token;
  if (!validToken(token) || token === password.trim()) throw error(502, '平台未返回有效登录会话。');
  return { credential: { token }, verified: false };
}

export const keepPasswordProviders = {
  keep: {
    fields: [
      { key: 'mobile', label: '手机号', type: 'tel', required: true },
      { key: 'password', label: '账号密码', type: 'password', required: true }
    ],
    signIn
  }
};

function trackPoints(encoded) {
  if (typeof encoded !== 'string' || !encoded.trim()) throw error(422, '这条骑行没有可导出的 GPS 轨迹。');
  // Upstream KeepApi.kt documents the encoding of the authenticated geoPoints payload.
  let value;
  try {
    const decipher = createDecipheriv('aes-128-cbc', '56fe59;82g:d873c', '2346892432920300');
    const compressed = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]);
    const decompress = compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync : inflateRawSync;
    value = JSON.parse(decompress(compressed, { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8'));
  } catch {
    throw error(422, '无法解码这条骑行的 GPS 轨迹。');
  }
  const points = Array.isArray(value) ? value : [value?.points, value?.data, value?.runmap, value?.tracks].find(Array.isArray);
  if (!points || points.length < 2 || points.length > 75_000) throw error(422, '这条骑行的轨迹点数量无效。');
  return points;
}

function cyclingGpx(detail) {
  let firstTime, lastTime;
  const startTime = number(detail.startTime);
  const points = trackPoints(detail.geoPoints).map(point => {
    const lat = number(point?.lat ?? point?.latitude);
    const lon = number(point?.lon ?? point?.longitude);
    const altitude = number(point?.altitude);
    const offset = number(point?.timestamp);
    let time = number(point?.unixTimestamp);
    if (time === null && offset >= 100_000_000_000) time = offset;
    if (time === null && startTime !== null && offset !== null && offset >= 0) {
      time = startTime + (offset >= 100_000_000 ? offset : offset * 1000);
    }
    const timestamp = date(time);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
        !timestamp || time < lastTime) throw error(422, '这条骑行的轨迹坐标或时间无效。');
    firstTime ??= time;
    lastTime = time;
    const [latitude, longitude] = gcj02ToWgs84(lat, lon);
    return `<trkpt lat="${latitude.toFixed(7)}" lon="${longitude.toFixed(7)}">${altitude === null ? '' : `<ele>${altitude}</ele>`}<time>${timestamp}</time></trkpt>`;
  });
  if (lastTime <= firstTime) throw error(422, '这条骑行没有有效的轨迹时长。');
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx creator="Sports Data Sync Web" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
    '<trk><name>Keep 骑行</name><type>cycling</type><trkseg>' +
    points.join('\n') + '</trkseg></trk></gpx>');
}

export function createKeepSources({ fetchImpl = globalThis.fetch } = {}) {
  async function list(credential, cursor) {
    const query = new URLSearchParams({ dateUnit: 'all', type: 'cycling', lastDate: cursor });
    const result = await json(fetchImpl, `/pd/v3/stats/detail?${query}`, { headers: bearer(credential) }, 2 * 1024 * 1024);
    if (result?.ok === false || !Array.isArray(result?.data?.records)) throw error(502, '平台未返回有效骑行列表。');
    return result.data;
  }

  return {
    async activities(_platform, credential, start = 0) {
      if (!Number.isSafeInteger(start) || start < 0 || start > 1000) throw error(400, '骑行列表起点无效。');
      const activities = new Map();
      const visited = new Set();
      let cursor = 0;
      for (let page = 0; page < 32; page++) {
        visited.add(cursor);
        const data = await list(credential, cursor);
        for (const record of data.records) {
          if (!Array.isArray(record?.logs)) throw error(502, '平台返回的骑行列表格式不正确。');
          if (!record.logs.length) continue;
          const stats = record.logs[0]?.stats;
          const id = stats?.id;
          if (!validId(id)) throw error(502, '平台返回的骑行编号无效。');
          if (!activities.has(id)) activities.set(id, {
            id, name: 'Keep 骑行', type: 'cycling', time: date(number(stats.startTime)),
            distance: number(stats.distance), duration: number(stats.duration)
          });
        }
        const next = number(data.lastTimestamp) ?? 0;
        if (!Number.isSafeInteger(next) || next < 0) throw error(502, '平台返回的骑行分页信息无效。');
        if (next > 0 && visited.has(next) && next !== cursor) throw error(502, '平台返回的骑行分页重复。');
        if (activities.size > start + pageSize || next === 0 || next === cursor) {
          const items = [...activities.values()].sort((a, b) => b.time.localeCompare(a.time));
          return { activities: items.slice(start, start + pageSize), nextStart: items.length > start + pageSize ? start + pageSize : null };
        }
        cursor = next;
      }
      throw error(502, '平台骑行列表超出分页读取限制。');
    },

    async verify(_platform, credential) { await list(credential, 0); },

    async download(_platform, credential, id) {
      if (!validId(id)) throw error(400, '骑行编号无效。');
      const result = await json(fetchImpl, `/pd/v3/cyclinglog/${id}`, { headers: bearer(credential) }, 8 * 1024 * 1024);
      if (result?.ok === false || !result?.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
        throw error(502, '平台未返回有效骑行详情。');
      }
      return { data: cyclingGpx(result.data), fileName: `keep_${id}.gpx`, coordinateSystem: 'wgs84' };
    }
  };
}
