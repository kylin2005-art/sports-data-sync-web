import { domesticPasswordProviders } from './platform-password-domestic.mjs';
import { komootPasswordProviders } from './platform-password-komoot.mjs';
import { corosPasswordProviders } from './platform-password-coros.mjs';
import { keepPasswordProviders } from './platform-keep.mjs';
import { activityPasswordProviders } from './sources.mjs';
import { cyCityPasswordProviders } from './cycity.mjs';

const providers = new Map(Object.entries({ ...domesticPasswordProviders, ...komootPasswordProviders,
  ...corosPasswordProviders, ...keepPasswordProviders, ...activityPasswordProviders, ...cyCityPasswordProviders }));

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }

export class PlatformPasswords {
  constructor(fetchImpl = globalThis.fetch) { this.fetch = fetchImpl; }

  fields(platform) { return providers.get(platform)?.fields || []; }

  async signIn(platform, input) {
    const provider = providers.get(platform);
    if (!provider || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalid('请选择支持账号登录的平台。');
    }
    const fields = {};
    for (const { key, label, type, required } of provider.fields) {
      const raw = input[key];
      if (raw != null && typeof raw !== 'string') throw invalid(`${label}格式不正确。`);
      const value = type === 'password' ? raw : raw?.trim();
      if ((required && !value) || (value && (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)))) {
        throw invalid(`请填写有效的${label}。`);
      }
      if (value) fields[key] = value;
    }
    return provider.signIn(fields, this.fetch);
  }
}
