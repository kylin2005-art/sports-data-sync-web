'use strict';

const byId = id => document.getElementById(id);
const form = byId('auth-form');
const invite = byId('auth-invite');
const username = byId('auth-username');
const password = byId('auth-password');
const confirmation = byId('auth-confirm');
const submit = byId('auth-submit');
const switchMode = byId('auth-switch');
const retry = byId('auth-retry');
const error = byId('auth-error');
const modes = {
  login: {
    title: '登录工作台', button: '登录', busy: '正在登录…',
    description: '使用工作台账号登录，查看自己的平台连接、任务和活动文件。',
  },
  register: {
    title: '使用邀请码注册', button: '注册并登录', busy: '正在注册…',
    description: '填写管理员提供的一次性邀请码，创建自己的工作台账号。',
  },
  setup: {
    title: '设置个人工作台', button: '创建账号并登录', busy: '正在创建账号…',
    description: '设置工作台的用户名和密码，以后用这个账号登录。',
  },
};
let mode = 'login';
let personal = false;

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function setMode(next) {
  mode = next;
  const { title, description, button } = modes[mode];
  const register = mode === 'register';
  const setup = mode === 'setup';
  const creating = register || setup;
  form.action = '/api/auth/' + mode;
  byId('auth-title').textContent = title;
  byId('auth-description').textContent = description;
  byId('auth-invite-field').hidden = !register;
  invite.required = register;
  invite.disabled = !register;
  if (!register) invite.value = '';
  byId('auth-confirm-field').hidden = !setup;
  confirmation.required = setup;
  confirmation.disabled = !setup;
  confirmation.value = '';
  byId('auth-rules').hidden = !creating;
  if (creating) {
    username.setAttribute('aria-describedby', 'auth-rules');
    password.setAttribute('aria-describedby', 'auth-rules');
  } else {
    username.removeAttribute('aria-describedby');
    password.removeAttribute('aria-describedby');
  }
  password.autocomplete = creating ? 'new-password' : 'current-password';
  password.value = '';
  submit.textContent = button;
  byId('auth-switch-label').textContent = register ? '已有工作台账号？' : '收到邀请码？';
  switchMode.textContent = register ? '返回登录' : '使用邀请码注册';
  showError();
}

switchMode.addEventListener('click', () => {
  if (personal) return;
  setMode(mode === 'register' ? 'login' : 'register');
  (mode === 'register' ? invite : username).focus();
});

function readInvitationLink() {
  const inviteFromLink = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (!inviteFromLink || form.hidden || submit.disabled) return;
  if (!personal) {
    setMode('register');
    invite.value = inviteFromLink;
  }
  history.replaceState(null, '', location.pathname + location.search);
}

async function checkSetup() {
  retry.hidden = true;
  byId('auth-description').textContent = '正在检查工作台设置…';
  try {
    const response = await fetch('/api/auth/setup');
    let required = false;
    if (response.ok) {
      ({ required } = await response.json());
      if (typeof required !== 'boolean') throw new Error();
      personal = true;
    } else if (![401, 404].includes(response.status)) {
      const result = await response.json().catch(() => ({}));
      byId('auth-description').textContent = result.error || '无法检查工作台设置，请重试。';
      retry.hidden = false;
      return;
    }
    byId('auth-brand-context').textContent = personal ? '个人工作台' : '邀请制工作台';
    byId('auth-switch-row').hidden = personal;
    setMode(required ? 'setup' : 'login');
    form.hidden = false;
    readInvitationLink();
  } catch {
    byId('auth-description').textContent = '无法检查工作台设置，请重试。';
    retry.hidden = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  showError();
  if (mode === 'setup' && password.value !== confirmation.value) {
    showError('两次输入的密码不一致，请重新确认。');
    confirmation.focus();
    return;
  }
  submit.disabled = true;
  switchMode.disabled = true;
  form.setAttribute('aria-busy', 'true');
  submit.textContent = modes[mode].busy;
  try {
    const data = { username: username.value.trim(), password: password.value };
    if (mode === 'register') data.invite = invite.value.trim();
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      if (mode === 'setup' && response.status === 409) {
        setMode('login');
        showError('首次设置已完成，请使用已创建的账号登录。');
        username.focus();
        return;
      }
      const result = await response.json().catch(() => ({}));
      showError(result.error || '操作未完成，请检查填写的信息后重试。');
      return;
    }
    location.replace('/#sync');
  } catch {
    showError('无法连接工作台，请稍后重试。');
  } finally {
    submit.disabled = false;
    switchMode.disabled = false;
    form.removeAttribute('aria-busy');
    submit.textContent = modes[mode].button;
  }
});

retry.addEventListener('click', checkSetup);
window.addEventListener('hashchange', readInvitationLink);
checkSetup();
