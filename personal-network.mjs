import { BlockList, isIPv4 } from 'node:net';

const privateRanges = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
].map(([start, bits]) => {
  const addresses = new BlockList();
  addresses.addSubnet(start, bits);
  return { addresses, bits };
});

function ipv4(address) {
  const value = typeof address === 'string' ? address.replace(/^::ffff:/i, '') : '';
  return isIPv4(value) ? value : '';
}

export function isPrivateIpv4(address) {
  return isIPv4(address) && privateRanges.some(({ addresses }) => addresses.check(address));
}

export function createLanNetwork({ subnet, hostname, setupIp, lanIp = hostname }) {
  const [start, prefix] = subnet.split('/');
  const parent = isIPv4(start) && privateRanges.find(({ addresses }) => addresses.check(start));
  const bits = Number(prefix);
  if (!parent || !/^\d{1,2}$/.test(prefix) || subnet !== `${start}/${prefix}` || bits < parent.bits || bits > 32) {
    throw new Error('GARMIN_WEB_LAN_SUBNET 须为私有 IPv4 网段。');
  }
  const allowed = new BlockList();
  allowed.addSubnet(start, bits);
  if (!isIPv4(lanIp) || !allowed.check(lanIp) || !isIPv4(setupIp) || !allowed.check(setupIp)) {
    throw new Error('工作台地址和 GARMIN_WEB_SETUP_IP 必须位于同一个配置的内网网段。');
  }
  if (hostname !== lanIp && (typeof hostname !== 'string' || hostname.length > 253 ||
      !hostname.includes('.') || isIPv4(hostname) || !hostname.split('.').every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) {
    throw new Error('GARMIN_WEB_LAN_IP 与工作台地址不同时，工作台须使用 DNS 域名。');
  }
  return {
    allows(address) {
      const value = ipv4(address);
      return value === '127.0.0.1' || Boolean(value && allowed.check(value));
    },
    checkSetup: address => ipv4(address) === setupIp,
  };
}
