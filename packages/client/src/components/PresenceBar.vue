<script setup lang="ts">
import type { AwarenessState } from '../collab/awareness-state';

defineProps<{
  users: Map<number, AwarenessState>;
}>();
</script>

<template>
  <div class="presence">
    <span
      v-for="state in users.values()"
      :key="state.user.id"
      class="avatar"
      :style="{ backgroundColor: state.user.color }"
      :title="state.user.name"
    >
      {{ state.user.name.slice(0, 1).toUpperCase() }}
    </span>
  </div>
</template>
