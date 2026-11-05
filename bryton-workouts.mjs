import { randomBytes, randomInt } from 'node:crypto';
import { Encoder, Profile } from '@garmin/fitsdk';

const host = 'active.brytonsport.com';
const origin = 'https://' + host;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
const safeToken = value => typeof value === 'string' && /^[A-Za-z0-9_.+/=-]{1,16000}$/.test(value);
const failure = (status, message, mayHaveUploaded = false) => Object.assign(new Error(message), { status, mayHaveUploaded });
const workoutIdOf = item => safeId(typeof item === 'string' ? item : item?.id ?? item?._id);

function resumeToken(cookie) {
  if (typeof cookie !== 'string' || /[\r\n\0]/.test(cookie)) return null;
  const values = new Set(cookie.split(';').map(part => part.trim()).filter(part =>
    /^meteor_login_token(?:[_-][A-Za-z0-9_-]+)?=/.test(part)).map(part => part.slice(part.indexOf('=') + 1)));
  const [token] = values;
  return values.size === 1 && safeToken(token) ? token : null;
}

// Bryton Active exposes the workout library through a read-only Meteor method.
function readLibrary(WebSocketImpl, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl('wss://' + host + '/sockjs/' + randomInt(100, 1000) + '/' +
      randomBytes(8).toString('hex') + '/websocket');
    const timeout = setTimeout(() => finish(failure(503, '百锐腾课表列表连接超时。')), 20_000);
    let session;
    let stage = 0;
    function finish(error, workouts) {
      if (stage === 4) return;
      stage = 4;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve({ ...session, workouts });
    }
    const send = message => socket.send(JSON.stringify([JSON.stringify(message)]));
    socket.addEventListener('error', () => finish(failure(503, '百锐腾课表列表连接失败。')));
    socket.addEventListener('close', () => finish(failure(503, '百锐腾课表列表连接已关闭。')));
    socket.addEventListener('message', ({ data }) => {
      try {
        if (typeof data !== 'string' || data.length > 4 * 1024 * 1024) throw failure(502, '百锐腾返回的课表消息无效。');
        if (data === 'o' && stage === 0) {
          stage = 1;
          return send({ msg: 'connect', version: '1', support: ['1', 'pre2', 'pre1'] });
        }
        if (!data.startsWith('a')) return;
        for (const item of JSON.parse(data.slice(1))) {
          const message = JSON.parse(item);
          if (message.msg === 'ping') send({ msg: 'pong', id: message.id });
          if (message.msg === 'failed') throw failure(502, '百锐腾课表协议连接失败。');
          if (message.msg === 'connected' && stage === 1) {
            stage = 2;
            send({ msg: 'method', id: 'login', method: 'login', params: [{ resume: token }] });
          }
          if (message.msg !== 'result') continue;
          if (stage === 2 && message.id === 'login') {
            const userId = safeId(message.result?.id);
            if (message.error || !userId) throw failure(401, '百锐腾训练课表授权失效，请重新登录。');
            const authToken = safeToken(message.result.token) ? message.result.token : token;
            session = { userId, authToken };
            stage = 3;
            send({ msg: 'method', id: 'workouts', method: 'user.file.list', params: [] });
          } else if (stage === 3 && message.id === 'workouts') {
            const workouts = Array.isArray(message.result) ? message.result : message.result?.workout;
            if (message.error || !Array.isArray(workouts) || workouts.some(item => !workoutIdOf(item))) {
              throw failure(502, '百锐腾未返回有效的课表列表。');
            }
            finish(null, workouts);
          }
        }
      } catch (error) { finish(error?.status ? error : failure(502, '百锐腾返回的课表消息无效。')); }
    });
  });
}

function percentTarget(value, units, type) {
  if (!value || typeof value.units !== 'string' || value.units.toLowerCase() !== units) {
    throw failure(422, '百锐腾骑行课表需要使用 %FTP 功率或 %MHR 心率目标。');
  }
  const lower = value.start ?? value.value;
  const upper = value.end ?? value.value;
  if (![lower, upper].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 &&
      number <= (type === 245 ? 500 : 100))) {
    throw failure(422, '百锐腾骑行课表的百分比目标无效。');
  }
  return { targetType: type, targetValue: 0, customTargetValueLow: 100_000 + Math.round(Math.min(lower, upper)),
    customTargetValueHigh: 100_000 + Math.round(Math.max(lower, upper)) };
}

function nativeFit(event, workout) {
  const rawSteps = event.workout_doc?.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length || rawSteps.length > 100) {
    throw failure(422, '百锐腾需要具有结构化步骤的骑行课表。');
  }
  const steps = [];
  function append(source, nested = false) {
    if (!source || typeof source !== 'object' || source.ramp || source.maxeffort || source.distance || source.pace ||
        source._pace || source.cadence || ((source.power || source._power) && (source.hr || source._hr)) ||
        (source.freeride && (source.power || source.hr))) {
      throw failure(422, '百锐腾暂无法保留这份课表中的渐进、冲刺、距离、配速、踏频或多种目标。');
    }
    if (source.steps?.length || source.reps != null) {
      if (nested || !Number.isInteger(source.reps) || source.reps < 1 || source.reps > 100 ||
          !Array.isArray(source.steps) || !source.steps.length || source.steps.length > 100) {
        throw failure(422, '百锐腾课表的重复步骤无效或包含多层重复。');
      }
      const start = steps.length;
      for (const child of source.steps) append(child, true);
      steps.push({ messageIndex: steps.length, durationType: 'repeatUntilStepsCmplt',
        durationValue: start, targetValue: source.reps });
      return;
    }
    const open = source.until_lap_press === true;
    if (!open && (!Number.isInteger(source.duration) || source.duration < 1 || source.duration > 86_400)) {
      throw failure(422, '百锐腾课表步骤缺少有效时长。');
    }
    const intensity = source.warmup || source.intensity === 'warmup' ? 'warmup' :
      source.cooldown || source.intensity === 'cooldown' ? 'cooldown' :
        ['rest', 'recovery'].includes(source.intensity) ? 'rest' : 'active';
    const target = source.power || source._power ? percentTarget(source.power, '%ftp', 245) :
      source.hr || source._hr ? percentTarget(source.hr, '%mhr', 249) : { targetType: 'open', targetValue: 0 };
    steps.push({ messageIndex: steps.length, wktStepName: typeof source.text === 'string' ? source.text.slice(0, 16) : '步骤',
      durationType: open ? 'open' : 'time', durationValue: open ? 0 : source.duration * 1000, intensity, ...target });
  }
  for (const source of rawSteps) {
    append(source);
    if (steps.length > 100) throw failure(422, '百锐腾课表包含过多步骤。');
  }
  const encode = new Encoder();
  encode.onMesg(Profile.MesgNum.FILE_ID, { type: 'workout', manufacturer: 'bryton', serialNumber: 255, timeCreated: new Date() });
  encode.onMesg(Profile.MesgNum.WORKOUT, { sport: 'cycling', numValidSteps: steps.length, wktName: workout.name.slice(0, 64) });
  for (const step of steps) encode.onMesg(Profile.MesgNum.WORKOUT_STEP, step);
  return { data: Buffer.from(encode.close()), stepCount: steps.length };
}

export async function publishBrytonWorkout({ credential, event, workout, beforeUpload, onImported, request, WebSocketImpl }) {
  const token = resumeToken(credential?.cookie);
  if (!token) throw failure(401, '百锐腾会话缺少训练课表授权，请重新登录百锐腾 Active。');
  const { data, stepCount } = nativeFit(event, workout);
  const before = await readLibrary(WebSocketImpl, token);
  const previous = new Set(before.workouts.map(workoutIdOf));
  const fileName = 'bsWO_icu_' + workout.id + '_' + randomBytes(6).toString('hex') + '.fit';
  const body = new FormData();
  body.set('name', fileName);
  body.set('provider', 'bryton');
  body.set('info', JSON.stringify({ name: workout.name, description: String(event.description ?? '').slice(0, 500),
    plan: [workout.startLocal.slice(0, 10)], provider: 'bryton', interval: Array.from({ length: stepCount }, () => ({ target_type: '' })),
    create_time: Date.now(), ver: 5 }));
  body.set('file', new Blob([data], { type: 'application/octet-stream' }), fileName);
  const headers = { 'X-User-Id': before.userId, 'X-Auth-Token': before.authToken };
  await beforeUpload?.();
  await request(origin + '/workout/upload/' + before.userId, { headers, body, binary: true, platform: '百锐腾' });
  try {
    const after = await readLibrary(WebSocketImpl, before.authToken);
    if (after.userId !== before.userId) throw failure(401, '百锐腾读回账号已变更。');
    const candidates = new Map();
    for (const item of after.workouts) {
      const id = workoutIdOf(item);
      if (previous.has(id)) continue;
      const path = '/files/userFiles/' + id + '/original/' + id + '.fit';
      if (item.url !== path && item.url !== origin + path) throw failure(502, '百锐腾新课表缺少可核验的文件地址。');
      candidates.set(id, path);
    }
    if (candidates.size > 4) throw failure(502, '百锐腾新课表超过核验范围。');
    const matches = [];
    for (const [id, path] of candidates) {
      const downloaded = await request(origin + path, { headers: { ...headers, 'X-Auth-Token': after.authToken },
        binary: true, limit: 2 * 1024 * 1024, platform: '百锐腾' });
      if (downloaded.equals(data)) matches.push(id);
    }
    if (matches.length !== 1) throw failure(502, '百锐腾课表尚未读回唯一且一致的 FIT。');
    const [workoutId] = matches;
    await onImported?.({ workoutId });
    return { status: 'confirmed', workoutId, message: '已在百锐腾课表库读回字节一致的 FIT。' };
  } catch (error) {
    throw failure(error?.status || 502, error?.status ? error.message : '百锐腾课表读回未完成。', true);
  }
}
