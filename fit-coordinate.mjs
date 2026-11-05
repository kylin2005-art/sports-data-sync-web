import { Decoder, Stream, Profile } from '@garmin/fitsdk';

function reject(message) {
  const error = new Error(`迈金 FIT 坐标修正：${message}；原文件未改变。`);
  error.status = 422;
  throw error;
}

function crc(bytes) {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
  }
  return value;
}

// Same forward transform and bounded inverse as upstream util/FitGcj02Fixer.kt.
function forward(lat, lon) {
  const x = lon - 105, y = lat - 35, pi = Math.PI;
  const common = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  let dy = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x)) + common;
  dy += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
  dy += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y / 30 * pi)) * 2 / 3;
  let dx = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x)) + common;
  dx += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
  dx += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
  const rad = lat / 180 * pi, ee = .00669342162296594323, a = 6378245;
  const magic = 1 - ee * Math.sin(rad) ** 2, root = Math.sqrt(magic);
  return [lat + dy * 180 / (a * (1 - ee) / (magic * root) * pi), lon + dx * 180 / (a / root * Math.cos(rad) * pi)];
}

function inverse(lat, lon) {
  if (lon < 72.004 || lon > 137.8347 || lat < .8293 || lat > 55.8271) return [lat, lon];
  let lowLat = lat - .02, highLat = lat + .02, lowLon = lon - .02, highLon = lon + .02;
  for (let attempt = 0; attempt < 30; attempt++) {
    const guessLat = (lowLat + highLat) / 2, guessLon = (lowLon + highLon) / 2;
    const [mappedLat, mappedLon] = forward(guessLat, guessLon);
    if (Math.abs(mappedLat - lat) < 1e-8 && Math.abs(mappedLon - lon) < 1e-8) return [guessLat, guessLon];
    if (mappedLat > lat) highLat = guessLat; else lowLat = guessLat;
    if (mappedLon > lon) highLon = guessLon; else lowLon = guessLon;
  }
  reject('坐标反算未收敛');
}

export { inverse as gcj02ToWgs84 };

export function correctMageneFit(file) {
  if (!Buffer.isBuffer(file?.data) || file.data.length > 50 * 1024 * 1024 || !/\.fit$/i.test(file.fileName || '')) reject('需要不超过 50 MB 的 FIT 文件');
  if (String(file.coordinateSystem).toLowerCase().replace(/[-_]/g, '') !== 'gcj02') reject('只接受明确标记为 GCJ02 的备用文件，防止重复修正');
  try { if (!new Decoder(Stream.fromBuffer(file.data)).checkIntegrity()) reject('完整性或 CRC 校验失败'); }
  catch (error) { if (error.status) throw error; reject('FIT 文件无法校验'); }
  const data = Buffer.from(file.data), header = data[0];
  if (![12, 14].includes(header) || ![1, 2].includes(data[1] >> 4)) reject('不支持的 FIT 头或协议版本');
  const end = header + data.readUInt32LE(4);
  if (end + 2 !== data.length) reject('文件长度不匹配');
  const definitions = new Map(), sizes = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];
  let offset = header, pairsSeen = 0;
  const requireBytes = count => { if (offset + count > end) reject('定义或数据记录被截断'); };
  while (offset < end) {
    const record = data[offset++];
    if (record & 0x80) reject('暂不支持压缩时间戳记录');
    if (record & 0x10) reject('记录保留位无效');
    if (record & 0x20) reject('暂不支持 developer 字段');
    const local = record & 0x0f;
    if (record & 0x40) {
      requireBytes(5);
      if (data[offset] !== 0 || ![0, 1].includes(data[offset + 1])) reject('消息定义保留位或字节序无效');
      const little = data[offset + 1] === 0;
      const global = little ? data.readUInt16LE(offset + 2) : data.readUInt16BE(offset + 2);
      const profile = Profile.messages[global];
      if (!profile) reject('暂不支持未知消息定义');
      const count = data[offset + 4]; offset += 5;
      requireBytes(count * 3);
      const fields = [], seen = new Set(); let size = 0;
      for (let i = 0; i < count; i++) {
        const number = data[offset++], bytes = data[offset++], type = data[offset++];
        if (seen.has(number) || !bytes || type & 0x60 || !sizes[type & 0x1f] || bytes % sizes[type & 0x1f]) reject('字段定义无效');
        seen.add(number);
        const meta = profile.fields[number];
        if (!meta) reject('暂不支持未知字段定义');
        fields.push({ offset: size, bytes, type, meta }); size += bytes;
      }
      const coords = fields.filter(field => field.meta.units === 'semicircles');
      const pairs = [];
      for (const field of coords) {
        if (!field.meta.name.endsWith('Lat') && !field.meta.name.endsWith('Long')) reject('不支持的半圆坐标字段');
        if (field.bytes !== 4 || field.type !== 0x85) reject('坐标字段不是单个 sint32');
        const other = coords.find(item => item.meta.name === field.meta.name.replace(/Lat$|Long$/, field.meta.name.endsWith('Lat') ? 'Long' : 'Lat'));
        if (!other) reject('经纬度字段不成对');
        if (field.meta.name.endsWith('Lat')) pairs.push([field, other]);
      }
      definitions.set(local, { little, size, pairs });
    } else {
      const definition = definitions.get(local);
      if (!definition) reject('数据记录没有对应消息定义');
      requireBytes(definition.size);
      for (const [latField, lonField] of definition.pairs) {
        const latOffset = offset + latField.offset, lonOffset = offset + lonField.offset;
        const latRaw = definition.little ? data.readInt32LE(latOffset) : data.readInt32BE(latOffset);
        const lonRaw = definition.little ? data.readInt32LE(lonOffset) : data.readInt32BE(lonOffset);
        if (latRaw === 0x7fffffff && lonRaw === 0x7fffffff) continue;
        if (latRaw === 0x7fffffff || lonRaw === 0x7fffffff) reject('经纬度有效状态不一致');
        const lat = latRaw * 180 / 2 ** 31, lon = lonRaw * 180 / 2 ** 31;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) reject('经纬度超出范围');
        const [fixedLat, fixedLon] = inverse(lat, lon); pairsSeen++;
        const write = definition.little ? 'writeInt32LE' : 'writeInt32BE';
        data[write](Math.round(fixedLat * 2 ** 31 / 180), latOffset);
        data[write](Math.round(fixedLon * 2 ** 31 / 180), lonOffset);
      }
      offset += definition.size;
    }
  }
  if (!pairsSeen) reject('没有可验证的标准经纬度对');
  data.writeUInt16LE(crc(data.subarray(0, end)), end);
  if (!new Decoder(Stream.fromBuffer(data)).checkIntegrity()) reject('修正后的 FIT 校验失败');
  return { data, fileName: file.fileName, coordinateSystem: 'wgs84' };
}
