<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElCard, ElTag } from 'element-plus';

const groups = [
  { title: '同步管理', views: [
    { id: 'sync', title: '数据同步', icon: 'M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4' },
    { id: 'jobs', title: '定时任务', icon: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
    { id: 'records', title: '同步记录', icon: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5' },
    { id: 'workouts', title: '训练课表', icon: 'M4 6h16v14H4zM7 3v6m10-6v6M4 11h16m-12 4h3m3 0h3' },
  ] },
  { title: '骑行', views: [
    { id: 'tracks', title: '骑行档案', icon: 'M3 7h7l2 2h9v11H3zM3 7V4h8l2 2h6v3' },
    { id: 'analysis', title: '骑行分析', icon: 'M3 19h18M7 15l4-6 4 3 5-7' },
    { id: 'routes', title: '路线手账', icon: 'M5 17l5-8 5 5 4-7m-12 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14-10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z' },
    { id: 'share', title: '分享图', icon: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8h.01' },
  ] },
  { title: '设置', views: [
    { id: 'accounts', title: '平台账号', icon: 'M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 20v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2' },
  ] },
];
const views = Object.fromEntries(groups.flatMap(group => group.views.map(view => [view.id, { ...view, group: group.title }])));
const readView = () => {
  const id = location.hash.slice(1);
  return Object.hasOwn(views, id) ? views[id] : views.sync;
};
const active = ref(readView());
const overview = ref(window.sportsSyncOverview ?? {});
const logoutPending = ref(false);
const logoutError = ref('');
const selectView = () => { active.value = readView(); };
const updateOverview = event => { overview.value = event.detail; };
const runNames = { running: '运行中', finished: '已结束', stopped: '已停止', failed: '任务失败' };
const service = computed(() => {
  const name = overview.value.viewer ? '工作台服务' : '本机服务';
  if (overview.value.online === true) return { label: name + '已连接', type: 'success' };
  if (overview.value.online === false) return { label: name + '未连接', type: 'danger' };
  return { label: '正在检查服务', type: 'info' };
});
const summary = computed(() => {
  const { connected, platforms, selected, activityCount, run } = overview.value;
  const runHint = run
    ? [`已确认 ${run.confirmed}`, `跳过 ${run.skipped}`, run.unconfirmed && `待核对 ${run.unconfirmed}`, run.guided && `待手动导入 ${run.guided}`, run.failed && `失败 ${run.failed}`].filter(Boolean).join(' · ')
    : '同步任务启动后显示进度';
  return [
    { name: '平台连接', value: connected == null ? '—' : `${connected} / ${platforms}`, hint: '已配置、保存或验证', icon: views.accounts.icon },
    { name: '本次选中', value: selected == null ? '—' : `${selected} 条`, hint: activityCount == null ? '读取活动后可勾选' : `已读取 ${activityCount} 条活动`, icon: views.records.icon },
    { name: '运行状态', value: runNames[run?.status] ?? '待开始', hint: runHint, icon: views.jobs.icon },
  ];
});

async function logout() {
  if (logoutPending.value) return;
  logoutPending.value = true;
  logoutError.value = '';
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (response.ok || response.status === 401) location.replace('/login');
    else logoutError.value = '未能退出，请重试。';
  } catch {
    logoutError.value = '无法连接工作台，请稍后重试。';
  } finally {
    logoutPending.value = false;
  }
}

onMounted(() => {
  window.addEventListener('hashchange', selectView);
  window.addEventListener('sports-sync:overview', updateOverview);
  if (window.sportsSyncOverview) overview.value = window.sportsSyncOverview;
});
onUnmounted(() => {
  window.removeEventListener('hashchange', selectView);
  window.removeEventListener('sports-sync:overview', updateOverview);
});
</script>

<template>
  <aside class="workspace-sidebar">
    <a class="workspace-brand" href="#sync" aria-label="运动数据同步首页">
      <span class="workspace-brand-icon" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none"><path d="M4 22h6l4-9 4 6 5-9h5m-5 0h5v5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <span><strong>运动数据同步</strong><small>同步工作台</small></span>
    </a>
    <nav class="workspace-menu" aria-label="工作台">
      <div v-for="group in groups" :key="group.title" class="workspace-menu-group" role="group" :aria-label="group.title">
        <p class="workspace-menu-caption" aria-hidden="true">{{ group.title }}</p>
        <a v-for="view in group.views" :key="view.id" :href="'#' + view.id" :data-tab="view.id"
           :aria-current="active.id === view.id ? 'page' : undefined">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path :d="view.icon" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>{{ view.title }}</span>
        </a>
      </div>
    </nav>
    <div class="workspace-environment"><span aria-hidden="true"></span>{{ overview.viewer?.personal ? '个人工作区' : overview.viewer ? '邀请制工作区' : '本机工作区' }}</div>
  </aside>
  <header class="workspace-topbar">
    <div class="workspace-breadcrumb"><span>{{ active.group }}</span><span aria-hidden="true">/</span><strong>{{ active.title }}</strong></div>
    <div class="workspace-topbar-controls">
      <ElTag :type="service.type" effect="light" round>
        <span class="workspace-service-dot" aria-hidden="true"></span>{{ service.label }}
      </ElTag>
      <div v-if="overview.viewer" class="workspace-user-control">
        <span class="workspace-current-user" :title="overview.viewer.username">当前用户 {{ overview.viewer.username }}</span>
        <button class="button button-quiet" type="button" :disabled="logoutPending" @click="logout">
          {{ logoutPending ? '正在退出…' : '退出登录' }}
        </button>
      </div>
      <p v-if="logoutError" class="workspace-logout-error" role="alert">{{ logoutError }}</p>
    </div>
  </header>
  <Teleport v-if="overview.viewer?.personal && overview.features?.garminDi === true" to="#garmin-authorization">
    <a class="button button-secondary" href="/garmin-di">授权佳明账号</a>
  </Teleport>
  <Teleport to="#sync-overview">
    <div class="workspace-summary" aria-label="同步概况">
      <ElCard v-for="item in summary" :key="item.name" class="workspace-summary-card" shadow="never">
        <div class="workspace-summary-text">
          <span class="workspace-summary-name">{{ item.name }}</span>
          <strong>{{ item.value }}</strong>
          <span class="workspace-summary-hint">{{ item.hint }}</span>
        </div>
        <span class="workspace-summary-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path :d="item.icon" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </ElCard>
    </div>
  </Teleport>
</template>
