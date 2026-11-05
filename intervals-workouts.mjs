import { randomUUID } from 'node:crypto';
import { Decoder, Stream } from '@garmin/fitsdk';
import { publishBrytonWorkout } from './bryton-workouts.mjs';

const intervals = 'https://intervals.icu/api/v1/athlete/0/events';
const igpsports = new Map([
  ['igpsport', { host: 'prod.zh.igpsport.com', origin: 'https://app.igpsport.cn', language: 'zh-CN' }],
  ['igpsport_int', { host: 'prod.en.igpsport.com', origin: 'https://app.igpsport.com', language: 'en' }],
]);
const jsonLimit = 4 * 1024 * 1024;
const fitLimit = 2 * 1024 * 1024;
const dayMs = 86_400_000;
const rejectedStatus = new Set([400, 401, 403, 404, 405, 415, 422, 429]);
const cycling = new Set(['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', 'EBikeRide',
  'EMountainBikeRide', 'TrackRide', 'Cyclocross', 'Handcycle', 'Velomobile']);
export const WORKOUT_TARGETS = Object.freeze([...igpsports.keys(), 'bryton']);
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const secret = value => typeof value === 'string' && /^[!-~]{1,16000}$/.test(value);
const positiveId = value => (typeof value === 'string' || Number.isSafeInteger(value)) &&
  /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : null;

function fail(status, message, mayHaveUploaded = false) {
  throw Object.assign(new Error(message), { status, mayHaveUploaded });
}

function localDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : NaN;
}

function calendarQuery({ oldest, newest }, resolve = false) {
  const range = localDate(newest) - localDate(oldest);
  if (!Number.isFinite(range) || range < 0 || range >= 31 * dayMs) {
    fail(400, '请选择有效的课表日期，单次最多查询 31 天。');
  }
  return new URLSearchParams({ oldest, newest, category: 'WORKOUT', ...(resolve && { resolve: 'true' }) });
}

function eventId(value) {
  const id = positiveId(value);
  if (!id || Number(id) > 2147483647) fail(400, 'Intervals.icu 课表编号无效。');
  return id;
}

function eventMetadata(event) {
  const id = positiveId(event.id);
  const startLocal = event.start_date_local;
  if (!id || Number(id) > 2147483647 || typeof startLocal !== 'string' ||
      !Number.isFinite(localDate(startLocal.slice(0, 10))) || typeof event.type !== 'string') {
    fail(502, 'Intervals.icu 返回的课表编号、日期或运动类型无效。');
  }
  return { id, name: typeof event.name === 'string' && event.name.trim() ? event.name.trim().slice(0, 250) : '训练课表',
    type: event.type, startLocal };
}

export function plannedFit(data) {
  try {
    const decoder = new Decoder(Stream.fromBuffer(data));
    if (!decoder.checkIntegrity()) return false;
    const { messages, errors } = decoder.read();
    const steps = messages.workoutStepMesgs?.length;
    return errors.length === 0 && messages.fileIdMesgs?.length === 1 &&
      messages.fileIdMesgs[0].type === 'workout' && messages.workoutMesgs?.length === 1 &&
      steps > 0 && messages.workoutMesgs[0].numValidSteps === steps && !messages.activityMesgs?.length;
  } catch { return false; }
}

function range(value) {
  if (!record(value)) return null;
  const min = value.start ?? value.value;
  const max = value.end ?? value.value;
  if (![min, max].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 5000)) return null;
  return { minValue: Math.round(Math.min(min, max)), maxValue: Math.round(Math.max(min, max)) };
}

function igpsStep(source, index, depth = 0) {
  if (!record(source) || depth > 4 || source.ramp || source.maxeffort || source.pace || source._pace ||
      source.distance || (source.freeride && (source.power || source.hr))) {
    fail(422, 'iGPSPORT 暂无法保留这份课表中的渐进、冲刺、配速或距离步骤。');
  }
  const { reps, steps, duration } = source;
  const name = typeof source.text === 'string' && source.text.trim() ? source.text.trim().slice(0, 64) : '步骤 ' + (index + 1);
  const base = { name, uuid: randomUUID() };
  if (steps?.length || reps != null) {
    if (!Number.isInteger(reps) || reps < 1 || reps > 100 || !Array.isArray(steps) || !steps.length || steps.length > 100) {
      fail(422, '课表重复步骤的次数或内容无效。');
    }
    return { ...base, type: 'Repetition', intensityClass: 'Active', openDuration: 'false',
      length: { unit: 'Repetition', value: reps }, steps: steps.map((step, position) => igpsStep(step, position, depth + 1)) };
  }
  const open = source.until_lap_press === true;
  if (!open && (!Number.isInteger(duration) || duration < 1 || duration > 86_400)) fail(422, '课表步骤缺少有效时长。');
  const intensity = source.intensity;
  const intensityClass = source.warmup || intensity === 'warmup' ? 'WarmUp' :
    source.cooldown || intensity === 'cooldown' ? 'CoolDown' :
      intensity === 'rest' || intensity === 'recovery' ? 'Rest' : 'Active';
  const result = { ...base, type: 'Step', intensityClass, openDuration: String(open) };
  if (!open) result.length = { unit: 'Second', value: duration };

  const { power, _power, hr, _hr, cadence } = source;
  if ((power || _power) && (hr || _hr)) fail(422, 'iGPSPORT 无法同时保留单步的功率与心率目标。');
  if (power || _power) {
    const relative = /^%ftp$/i.test(power?.units || '') && range(power);
    const target = relative || range(_power ?? power);
    if (!target || (!relative && !_power && !/^w(?:atts?)?$/i.test(power?.units || ''))) fail(422, '课表功率目标缺少可验证的单位或数值。');
    result.intensityTarget = relative ? { unit: 'PercentOfFTP', ...target } : { unit: 'PowerCustom', value: 0, ...target };
  }
  if (hr || _hr) {
    const target = range(_hr ?? hr);
    if (!target || target.minValue < 20 || target.maxValue > 255 || (!_hr && !/^bpm$/i.test(hr?.units || ''))) {
      fail(422, '课表心率目标缺少有效的每分钟心率。');
    }
    result.intensityTarget = { unit: 'HeartRateCustom', ...target };
  }
  if (cadence) {
    const target = range(cadence);
    if (!target || target.maxValue > 255 || !/^rpm$/i.test(cadence.units || '')) fail(422, '课表踏频目标无效。');
    result.cadenceTarget = { unit: 'Cadence', ...target };
  }
  return result;
}

function igpsPayload(event, metadata) {
  const doc = event.workout_doc;
  if (!Array.isArray(doc?.steps) || !doc.steps.length || doc.steps.length > 100) {
    fail(422, 'iGPSPORT 只接受具有结构化步骤的骑行课表。');
  }
  const structure = doc.steps.map((step, position) => igpsStep(step, position));
  const seconds = steps => steps.reduce((total, step) => total +
    (step.type === 'Repetition' ? step.length.value * seconds(step.steps) : (step.length?.value ?? 0)), 0);
  const totalTime = seconds(structure);
  if (totalTime > 86_400) fail(422, '课表的计划总时长超过 24 小时。');
  return { data: { title: metadata.name.slice(0, 64), description: String(doc.description ?? event.description ?? '').slice(0, 500),
    totalTime, workoutType: 'bike', sportBigType: 1, allowDeletion: true, structure } };
}

export function createIntervalsWorkouts({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  async function request(url, { headers, body, platform, limit = jsonLimit, binary = false }) {
    let bytes;
    try {
      const response = await fetchImpl(url, { headers, ...(body && { method: 'POST', body }),
        redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = [401, 403, 404, 429].includes(response.status) ? response.status : 502;
        fail(status, platform + '课表接口返回 HTTP ' + response.status + '。', Boolean(body) && !rejectedStatus.has(response.status));
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > limit) fail(502, platform + '课表响应超出大小限制。', Boolean(body));
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) {
      if (error?.status) throw error;
      fail(503, platform + '课表请求未完成。', Boolean(body));
    }
    if (binary) return bytes;
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { fail(502, platform + '未返回有效的课表 JSON。', Boolean(body)); }
  }

  function intervalsRead(apiKey, suffix, binary = false) {
    if (!secret(apiKey)) fail(400, '请配置有效的 Intervals.icu 个人 API Key。');
    return request(intervals + suffix, { platform: 'Intervals.icu', binary, limit: binary ? fitLimit : jsonLimit,
      headers: { Authorization: 'Basic ' + Buffer.from('API_KEY:' + apiKey).toString('base64'),
        Accept: binary ? 'application/octet-stream' : 'application/json' } });
  }

  async function calendar(apiKey, dates, resolve) {
    const events = await intervalsRead(apiKey, '?' + calendarQuery(dates, resolve));
    if (!Array.isArray(events) || events.some(event => !record(event))) fail(502, 'Intervals.icu 未返回有效的课表列表。');
    return events.filter(event => event.category === 'WORKOUT');
  }

  async function igpsList(api, headers, page, mayHaveUploaded) {
    const result = await request(api + '/CustomWorkout?PageIndex=' + page + '&PageSize=50',
      { platform: 'iGPSPORT', headers });
    if (result?.code !== 0 || !Array.isArray(result.data?.items)) {
      fail(502, 'iGPSPORT 未返回有效的自定义课表列表，请检查当前登录凭据。', mayHaveUploaded);
    }
    return result.data.items;
  }

  return {
    async list({ apiKey } = {}, dates = {}) {
      const events = await calendar(apiKey, dates);
      return { workouts: events.map(eventMetadata) };
    },

    async download({ apiKey } = {}, { id } = {}) {
      const safeId = eventId(id);
      const data = await intervalsRead(apiKey, '/' + safeId + '/download.fit', true);
      if (!plannedFit(data)) fail(502, 'Intervals.icu 未返回通过校验的计划课表 FIT。');
      return { data, fileName: 'intervals-workout-' + safeId + '.fit', contentType: 'application/octet-stream' };
    },

    async publish({ platform, credential, apiKey, id, oldest, newest, beforeUpload, onImported } = {}) {
      if (!WORKOUT_TARGETS.includes(platform)) fail(400, '请选择已接入的训练课表目标。');
      const igpsport = igpsports.get(platform);
      if (igpsport && !secret(credential?.token)) fail(400, '请先在账号页配置 iGPSPORT Token。');
      const safeId = eventId(id);
      const events = await calendar(apiKey, { oldest, newest }, true);
      const event = events.find(item => positiveId(item.id) === safeId);
      if (!event) fail(404, '所选日期内没有找到这条 Intervals.icu 课表。');
      const workout = eventMetadata(event);
      const workoutDate = workout.startLocal.slice(0, 10);
      if (workoutDate < oldest || workoutDate > newest) fail(404, '所选日期内没有找到这条 Intervals.icu 课表。');
      if (!cycling.has(workout.type)) fail(422, '当前仅支持向所选码表平台发布骑行课表。');
      if (platform === 'bryton') return publishBrytonWorkout({ credential, event, workout, beforeUpload, onImported, request, WebSocketImpl });
      const payload = igpsPayload(event, workout);
      const api = 'https://' + igpsport.host + '/service/mobile/api/WorkOut';
      const headers = { Authorization: 'Bearer ' + credential.token, Accept: 'application/json',
        'Accept-Language': igpsport.language, Origin: igpsport.origin, Referer: igpsport.origin + '/' };
      await igpsList(api, headers, 1, false);
      await beforeUpload?.();
      const result = await request(api + '/EditCustomWorkOut', { platform: 'iGPSPORT', body: JSON.stringify(payload),
        headers: { ...headers, 'Content-Type': 'application/json' } });
      if (typeof result?.code !== 'number') fail(502, 'iGPSPORT 未返回有效的课表发布结果。', true);
      if (result.code !== 0) fail(422, 'iGPSPORT 拒绝发布这条课表。');
      const workoutId = positiveId(result.data?.workoutId);
      if (!workoutId) fail(502, 'iGPSPORT 未返回课表编号，请先到目标平台核对。', true);
      try {
        await onImported?.({ workoutId });
        for (let page = 1; page <= 5; page++) {
          const items = await igpsList(api, headers, page, true);
          if (items.some(item => positiveId(item?.workoutId ?? item?.id ?? item?.workout_id) === workoutId)) {
            return { status: 'confirmed', workoutId, message: '已按课表编号在 iGPSPORT 读回确认。' };
          }
          if (items.length < 50) break;
        }
      } catch (error) {
        if (error?.status) {
          error.mayHaveUploaded = true;
          throw error;
        }
        fail(502, 'iGPSPORT 已返回课表编号，但读回未完成。', true);
      }
      fail(502, 'iGPSPORT 已返回课表编号，但未能从课表列表读回。', true);
    },
  };
}
