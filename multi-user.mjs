import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthStore } from './auth-store.mjs';
import { HostedVault } from './hosted-vault.mjs';
import { createMultiUserServer, validatePublicOrigin } from './multi-user-server.mjs';
import { createWorkspaceHandler } from './server.mjs';
import { SyncStore } from './sync-store.mjs';
import { SyncWorkspace } from './sync-workspace.mjs';
import { PLATFORM_DEFINITIONS, PlatformUploads } from './platforms.mjs';
import { SOURCE_DEFINITIONS, activities, download, historyPage, verify } from './sources.mjs';
import { COROS_SOURCES, createCorosSources } from './coros-source.mjs';
import { KEEP_SOURCES, createKeepSources } from './platform-keep.mjs';
import { CYCITY_SOURCES, createCyCitySources } from './cycity.mjs';
import { GarminDi } from './garmin-di.mjs';
import { createLanNetwork } from './personal-network.mjs';
import { PlatformPasswords } from './platform-password.mjs';
import { PlatformLogin } from './platform-login.mjs';

const port = Number(process.env.GARMIN_WEB_PORT || '8768');
const host = process.env.GARMIN_WEB_HOST || '127.0.0.1';
const origin = process.env.GARMIN_WEB_ORIGIN;
const authMode = process.env.GARMIN_WEB_AUTH_MODE || 'invite';
const personal = authMode === 'personal';
const lanSubnet = process.env.GARMIN_WEB_LAN_SUBNET;
const diUsername = process.env.GARMIN_WEB_DI_USERNAME;
const personalDi = process.env.GARMIN_WEB_PERSONAL_DI === '1';
const dataRoot = resolve(process.env.GARMIN_WEB_DATA_DIR ||
  join(process.env.LOCALAPPDATA || homedir(), 'GarminCnTransferWebHosted'));
const authPath = join(dataRoot, 'auth.sqlite');

async function readVaultKey() {
  const file = process.env.GARMIN_WEB_VAULT_KEY_FILE;
  let encoded = process.env.GARMIN_WEB_VAULT_KEY;
  if (file) {
    if (encoded) throw new Error('请只配置一个凭据密钥来源。');
    try { encoded = (await readFile(file, 'utf8')).trim(); }
    catch { throw new Error('无法读取 GARMIN_WEB_VAULT_KEY_FILE 指定的密钥文件。'); }
  }
  const key = Buffer.from(encoded || '', 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new Error('请配置 32 字节的 Base64URL 凭据密钥。');
  }
  return key;
}

function issueInvite(authStore) {
  const { token, expiresAt } = authStore.createInvite();
  const link = new URL('/login', origin || `http://127.0.0.1:${port}`);
  link.hash = 'invite=' + token;
  console.log(link.href);
  console.log(`邀请仅可使用一次，到期时间 ${new Date(expiresAt).toISOString()}`);
}

function createWorkspaceRegistry(key) {
  const workspaces = new Map();
  const coros = createCorosSources();
  const isCoros = id => COROS_SOURCES.some(item => item.id === id);
  const keep = createKeepSources();
  const cycity = createCyCitySources();
  const baseSources = { activities, download, verify };
  const sourceFor = id => id === 'keep' ? keep : id === 'cycity' ? cycity : isCoros(id) ? coros : baseSources;
  const accountLogin = origin?.startsWith('https://') ? new PlatformPasswords() : undefined;
  const browserPlatforms = accountLogin ? PlatformLogin.platforms : [];

  async function open(id, username) {
    const dir = join(dataRoot, 'users', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const sessionVault = new HostedVault(join(dir, 'credentials.vault'), key, id);
    const saved = await sessionVault.load();
    const store = new SyncStore(join(dir, 'sync.sqlite'));
    try {
      const diOrigin = (personal ? personalDi : diUsername && username === diUsername) ? origin : undefined;
      let workspace;
      const garmin = diOrigin ? new GarminDi({
        onSessionState: (region, record) => workspace.refreshGarminSession(region, record),
      }) : {};
      const platformUploads = new PlatformUploads();
      const context = createWorkspaceHandler(garmin, options => new SyncWorkspace({
        ...options, garmin, store, sessionVault,
        platformPasswords: accountLogin, browserPlatforms,
        sessionData: diOrigin ? saved : { credentials: saved.credentials },
        uploads: { definitions: PLATFORM_DEFINITIONS, upload: input => platformUploads.upload(input) },
        sources: { definitions: [...SOURCE_DEFINITIONS, ...COROS_SOURCES, ...KEEP_SOURCES, ...CYCITY_SOURCES],
          activities: (id, ...args) => sourceFor(id).activities(id, ...args),
          download: (id, ...args) => sourceFor(id).download(id, ...args),
          historyPage,
          verify: (id, ...args) => sourceFor(id).verify(id, ...args),
        },
      }), { diOrigin });
      workspace = context.workspace;
      workspace.schedule();
      return context;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  function workspaceFor({ id, username }) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效工作区。');
    if (!workspaces.has(id)) {
      workspaces.set(id, open(id, username).catch(error => {
        workspaces.delete(id);
        throw error;
      }));
    }
    return workspaces.get(id);
  }

  async function close() {
    await Promise.allSettled([...workspaces.values()].map(async pending => (await pending).workspace.close()));
  }
  return { workspaceFor, close };
}

async function start(authStore, key, network, tls) {
  const users = authStore.listUsers();
  if (personal && users.length > 1) throw new Error('个人模式需要空的数据目录或仅有一个账号的数据目录。');
  const registry = createWorkspaceRegistry(key);
  let ready = false;
  const server = createMultiUserServer({
    authStore, workspaceFor: registry.workspaceFor, origin, personal, network, tls, isReady: () => ready,
  });
  try {
    const restored = await Promise.allSettled(users.map(user => registry.workspaceFor(user)));
    const unavailable = restored.filter(result => result.status === 'rejected').length;
    ready = unavailable === 0;
    if (unavailable) console.error(`${unavailable} 个工作区暂时无法读取，请检查凭据密钥和数据目录。`);
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(port, host, accept);
    });
  } catch (error) {
    await registry.close();
    throw error;
  }
  console.log(`${personal ? '个人' : '邀请制'}工作台已启动：${origin || `http://127.0.0.1:${port}`}`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await new Promise(done => server.close(done));
    await registry.close();
    authStore.close();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GARMIN_WEB_PORT 端口无效。');
  if (!['invite', 'personal'].includes(authMode)) throw new Error('GARMIN_WEB_AUTH_MODE 须为 invite 或 personal。');
  if (lanSubnet && !personal) throw new Error('内网模式仅适用于个人工作台。');
  const publicOrigin = validatePublicOrigin(origin, { allowPrivateHttp: Boolean(lanSubnet) });
  const tlsKey = process.env.GARMIN_WEB_TLS_KEY_FILE;
  const tlsCert = process.env.GARMIN_WEB_TLS_CERT_FILE;
  if ((tlsKey || tlsCert) && (!tlsKey || !tlsCert || publicOrigin?.protocol !== 'https:')) {
    throw new Error('启用 HTTPS 须同时配置证书、私钥和 HTTPS 工作台地址。');
  }
  const lanIp = process.env.GARMIN_WEB_LAN_IP || undefined;
  if (lanIp && (!lanSubnet || !tlsKey)) throw new Error('单独配置内网发布地址需要内网 HTTPS。');
  if (personalDi && (!personal || !lanSubnet || !tlsKey)) {
    throw new Error('个人佳明授权需要启用内网 HTTPS。');
  }
  const network = lanSubnet ? createLanNetwork({
    subnet: lanSubnet, hostname: publicOrigin?.hostname, lanIp, setupIp: process.env.GARMIN_WEB_SETUP_IP,
  }) : undefined;
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('GARMIN_WEB_HOST 须为 127.0.0.1 或 0.0.0.0。');
  if (host === '0.0.0.0' && !origin) {
    throw new Error('监听 0.0.0.0 时，请配置 GARMIN_WEB_ORIGIN。');
  }
  const command = process.argv[2];
  if (command && command !== 'invite') throw new Error('支持的命令：node multi-user.mjs [invite]。');
  if (command === 'invite' && personal) throw new Error('个人模式从登录页完成首次设置。');
  const key = command ? null : await readVaultKey();
  const tls = tlsKey && !command ? { key: await readFile(tlsKey), cert: await readFile(tlsCert) } : undefined;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const authStore = new AuthStore(authPath);
  try {
    if (command === 'invite') {
      issueInvite(authStore);
      authStore.close();
    } else await start(authStore, key, network, tls);
  } catch (error) {
    authStore.close();
    throw error;
  }
}

try { await main(); }
catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : error.message);
  process.exitCode = 1;
}
