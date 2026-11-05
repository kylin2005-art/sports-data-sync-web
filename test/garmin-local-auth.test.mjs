import assert from 'node:assert/strict';
import test from 'node:test';
import { portalService, portalTicket, signInPortal } from '../tools/garmin-local-auth.mjs';

const ticket = 'ST-test-ticket';
const cnService = 'https://connect.garmin.cn/app';
const cnPortal = new URL('https://sso.garmin.cn/portal/sso/en-US/sign-in');
cnPortal.search = new URLSearchParams({ clientId: 'GarminConnect', service: cnService });

test('a portal grant requires the exact official origin, region, path and single ticket', () => {
  assert.equal(portalService(cnPortal), cnService);
  const comPortal = new URL(cnPortal);
  comPortal.hostname = 'sso.garmin.com';
  assert.throws(() => portalService(comPortal), /地址校验失败/);
  comPortal.searchParams.set('service', 'https://connect.garmin.com/app');
  assert.equal(portalService(comPortal), 'https://connect.garmin.com/app');

  assert.equal(portalTicket(new URL(`${cnService}?ticket=${ticket}`), cnService), ticket);
  for (const invalid of [
    `https://connect.garmin.com/app?ticket=${ticket}`,
    `https://connect.garmin.cn.example.com/app?ticket=${ticket}`,
    `${cnService}/activities?ticket=${ticket}`,
    `${cnService}?ticket=${ticket}&ticket=`,
    `${cnService}?ticket=invalid`,
  ]) assert.equal(portalTicket(new URL(invalid), cnService), undefined);
});

test('only a top-level portal redirect is stopped before sending the one-use grant', async () => {
  const rootFrame = {};
  const nextUrl = `${cnService}?ticket=${ticket}`;
  const events = [];
  let onRoute;
  const tab = {
    once() {},
    mainFrame: () => rootFrame,
    url: () => cnPortal.href,
    route: async (matches, handler) => {
      assert.equal(matches(new URL(nextUrl)), true);
      onRoute = handler;
    },
    goto: async () => {
      for (const frame of [{}, rootFrame]) {
        await onRoute({
          request: () => ({ url: () => nextUrl, method: () => 'GET', isNavigationRequest: () => true, frame: () => frame }),
          continue: async () => events.push('continued subframe'),
          abort: async () => events.push('stopped main-frame request'),
        });
      }
    },
    close: async () => events.push('closed portal'),
  };
  assert.deepEqual(await signInPortal({ newPage: async () => tab }, cnPortal.href), {
    serviceTicket: ticket, serviceUrl: cnService,
  });
  assert.deepEqual(events, ['continued subframe', 'stopped main-frame request', 'closed portal']);
});
