<script setup lang="ts">
defineEmits<{
  (e: 'heading', level: number): void;
  (e: 'paragraph'): void;
  (e: 'quote'): void;
  (e: 'code'): void;
  (e: 'insert', type: string): void;
  (e: 'mark', mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code'): void;
  (e: 'undo'): void;
  (e: 'redo'): void;
}>();
</script>

<template>
  <div class="toolbar">
    <button title="撤销 (Ctrl/⌘+Z)" @click="$emit('undo')">↶</button>
    <button title="重做 (Ctrl/⌘+Shift+Z)" @click="$emit('redo')">↷</button>
    <span class="sep" />
    <button title="正文" @click="$emit('paragraph')">正文</button>
    <button title="一级标题" @click="$emit('heading', 1)">H1</button>
    <button title="二级标题" @click="$emit('heading', 2)">H2</button>
    <button title="三级标题" @click="$emit('heading', 3)">H3</button>
    <button title="引用块" @click="$emit('quote')">❝ 引用</button>
    <button title="代码块" @click="$emit('code')">{{ '</>' }} 代码</button>
    <span class="sep" />
    <button title="加粗 Ctrl/⌘+B" @click="$emit('mark', 'bold')"><b>B</b></button>
    <button title="斜体 Ctrl/⌘+I" @click="$emit('mark', 'italic')"><i>I</i></button>
    <button title="下划线 Ctrl/⌘+U" @click="$emit('mark', 'underline')"><u>U</u></button>
    <button title="删除线" @click="$emit('mark', 'strike')"><s>S</s></button>
    <button title="行内代码" class="be-mark-code" @click="$emit('mark', 'code')">code</button>
  </div>
</template>
