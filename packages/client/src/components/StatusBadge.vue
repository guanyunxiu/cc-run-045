<script setup lang="ts">
defineProps<{
  phase: string;
  detail: string;
}>();

const label: Record<string, string> = {
  offline: '离线（本地编辑中）',
  connecting: '连接中…',
  syncing: '同步中…',
  synced: '已连接 · 实时协同',
};
</script>

<template>
  <span class="status-pill" :class="phase">
    <span class="dot" />
    {{ label[phase] ?? phase }}<template v-if="phase === 'syncing' && detail"> · {{ detail }}</template>
  </span>
</template>
