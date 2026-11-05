import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublicOrigin } from '../multi-user-server.mjs';
import { createLanNetwork } from '../personal-network.mjs';

test('private HTTP is opt-in, and LAN admission checks the direct socket address', () => {
  const origin = 'http://192.168.50.20:8768';
  assert.throws(() => validatePublicOrigin(origin));
  assert.throws(() => validatePublicOrigin('http://1.1.1.1:8768', { allowPrivateHttp: true }));
  assert.equal(validatePublicOrigin(origin, { allowPrivateHttp: true }).origin, origin);
  const network = createLanNetwork({ subnet: '192.168.50.0/24', hostname: '192.168.50.20', setupIp: '192.168.50.10' });
  assert.equal(network.allows('127.0.0.1'), true);
  assert.equal(network.allows('::ffff:192.168.50.75'), true);
  assert.equal(network.allows('192.168.51.75'), false);
  assert.equal(network.allows('::ffff:172.25.0.1'), false);
  assert.equal(network.checkSetup('::ffff:192.168.50.10'), true);
  assert.equal(network.checkSetup('127.0.0.1'), false);
  assert.equal(network.checkSetup('192.168.50.75'), false);
});

test('LAN configuration cannot allow public networks or a setup IP outside its subnet', () => {
  const config = { subnet: '192.168.50.0/24', hostname: '192.168.50.20', setupIp: '192.168.50.10' };
  for (const invalid of [
    { subnet: '10.0.0.0/7' },
    { subnet: '192.168.50.0/24/1' },
    { subnet: '172.0.0.0/12' },
    { hostname: '192.168.51.20' },
    { setupIp: '192.168.51.10' },
    { setupIp: undefined },
  ]) assert.throws(() => createLanNetwork({ ...config, ...invalid }));
});

test('a DNS origin requires an explicit in-subnet LAN address without relaxing peer checks', () => {
  const config = { subnet: '192.168.50.0/24', hostname: 'ride-lan.example.test', setupIp: '192.168.50.10' };
  const network = createLanNetwork({ ...config, lanIp: '192.168.50.20' });
  assert.equal(network.allows('::ffff:192.168.50.75'), true);
  assert.equal(network.allows('192.168.51.75'), false);
  assert.equal(network.checkSetup('192.168.50.10'), true);
  assert.equal(network.checkSetup('192.168.50.75'), false);
  for (const invalid of [
    {},
    { lanIp: '192.168.51.20' },
    { lanIp: '192.168.50.20', hostname: '192.168.51.20' },
    { lanIp: '192.168.50.20', hostname: 'https://ride-lan.example.test' },
  ]) assert.throws(() => createLanNetwork({ ...config, ...invalid }));
});
