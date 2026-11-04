import assert from 'node:assert/strict';
import test from 'node:test';
import { Decoder, Stream } from '@garmin/fitsdk';
import { correctMageneFit } from '../fit-coordinate.mjs';

function crc(bytes) { let c = 0; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; } return c; }
function wrap(payload) {
  const data = Buffer.alloc(12 + payload.length + 2);
  data[0] = 12; data[1] = 0x20; data.writeUInt16LE(2100, 2); data.writeUInt32LE(payload.length, 4); data.write('.FIT', 8);
  payload.copy(data, 12); data.writeUInt16LE(crc(data.subarray(0, -2)), data.length - 2);
  return data;
}
function fixture(little = true, lat = 31.2304, lon = 121.4737) {
  const definition = Buffer.from([0x40, 0, little ? 0 : 1, little ? 20 : 0, little ? 0 : 20, 4, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 3, 1, 2]);
  const record = Buffer.alloc(14); record[0] = 0;
  record[little ? 'writeUInt32LE' : 'writeUInt32BE'](1000000000, 1);
  record[little ? 'writeInt32LE' : 'writeInt32BE'](Math.round(lat * 2 ** 31 / 180), 5);
  record[little ? 'writeInt32LE' : 'writeInt32BE'](Math.round(lon * 2 ** 31 / 180), 9); record[13] = 143;
  return { data: wrap(Buffer.concat([definition, record])), fileName: 'magene.fit', coordinateSystem: 'gcj02' };
}

for (const little of [true, false]) test(`coordinates corrected with ${little ? 'little' : 'big'} endian; every other byte preserved`, () => {
  const source = fixture(little), original = Buffer.from(source.data);
  const result = correctMageneFit(source);
  assert.equal(result.coordinateSystem, 'wgs84');
  assert.deepEqual(source.data, original);
  const latStart = 12 + 18 + 5, lonStart = latStart + 4;
  for (let i = 0; i < original.length - 2; i++) {
    if (i >= latStart && i < lonStart + 4) continue;
    assert.equal(result.data[i], original[i], `non-coordinate byte ${i}`);
  }
  const decoder = new Decoder(Stream.fromBuffer(result.data));
  assert.equal(decoder.checkIntegrity(), true);
  const { messages, errors } = decoder.read(); assert.equal(errors.length, 0);
  const record = messages.recordMesgs[0];
  assert.equal(record.heartRate, 143);
  assert.ok(Math.abs(record.positionLat * 180 / 2 ** 31 - 31.232329) < 0.00002);
  assert.ok(Math.abs(record.positionLong * 180 / 2 ** 31 - 121.469177) < 0.00002);
});

test('outside-China coordinates remain byte-identical and double-conversion is refused', () => {
  const source = fixture(true, 40.7, -74);
  assert.deepEqual(correctMageneFit(source).data, source.data);
  assert.throws(() => correctMageneFit({ ...source, coordinateSystem: 'wgs84' }), error => error.status === 422);
});

test('corrupt CRC, compressed headers, developer definitions and undefined records are rejected', () => {
  const source = fixture(); const damaged = Buffer.from(source.data); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => correctMageneFit({ ...source, data: damaged }), /校验失败/);
  for (const [offset, header, reason] of [[18, 0x80, /压缩/], [0, 0x60, /developer/], [18, 1, /没有对应/]]) {
    const payload = Buffer.from(source.data.subarray(12, -2)); payload[offset] = header;
    const data = wrap(payload), original = Buffer.from(data);
    assert.throws(() => correctMageneFit({ ...source, data }), reason);
    assert.deepEqual(data, original);
  }
});

test('truncated definitions, invalid field type, unpaired and out-of-range coordinates fail safely', () => {
  const source = fixture();
  const truncated = wrap(Buffer.from([0x40, 0, 0, 20, 0, 4, 0]));
  assert.throws(() => correctMageneFit({ ...source, data: truncated }), /截断/);
  const payload = Buffer.from(source.data.subarray(12, -2)); payload[11] = 0x86;
  assert.throws(() => correctMageneFit({ ...source, data: wrap(payload) }), /sint32/);
  assert.throws(() => correctMageneFit(fixture(true, 91, 120)), /超出范围/);
});
