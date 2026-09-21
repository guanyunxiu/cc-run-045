<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useEditor } from '../composables/useEditor';
import Toolbar from './Toolbar.vue';
import StatusBadge from './StatusBadge.vue';
import PresenceBar from './PresenceBar.vue';

const props = defineProps<{
  docId: string;
  docTitle: string;
  user: { id: string; name: string };
  token: () => string | null;
  wsBaseUrl: string;
  httpBaseUrl: string;
}>();

const host = ref<HTMLElement | null>(null);

const editor = useEditor({
  docId: props.docId,
  user: props.user,
  token: props.token,
  wsBaseUrl: props.wsBaseUrl,
  httpBaseUrl: props.httpBaseUrl,
});

onMounted(async () => {
  if (host.value) await editor.mount(host.value);
});

const onPaste = (event: ClipboardEvent) => editor.session.value?.paste(event);
const onCopy = (event: ClipboardEvent) => editor.session.value?.copy(event);
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <h1>📓 BlockEditor</h1>
      <div class="doc-title">{{ docTitle }}</div>
      <Toolbar
        @heading="(level) => editor.setHeading(level)"
        @paragraph="editor.setBlockType('paragraph')"
        @quote="editor.setBlockType('quote')"
        @code="editor.setBlockType('code')"
        @insert="(type) => editor.insertBlock(type)"
        @mark="(mark) => editor.toggleMark(mark)"
        @undo="editor.undo()"
        @redo="editor.redo()"
      />
      <PresenceBar :users="editor.remoteUsers.value" />
      <StatusBadge :phase="editor.phase.value" :detail="editor.phaseDetail.value" />
    </header>
    <!-- 全局块复制粘贴：copy/paste 在捕获阶段委托给当前会话 -->
    <div
      class="editor-host"
      ref="host"
      @paste="onPaste"
      @copy="onCopy"
    />
  </div>
</template>
