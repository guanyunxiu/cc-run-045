<script setup lang="ts">
import { onMounted, ref } from 'vue';
import EditorRoot from './components/EditorRoot.vue';
import { createDocument, listDocuments, login, type DocumentMeta, type UserInfo } from './api.js';

// 演示环境：直连本机 Nest 服务；生产环境由部署环境注入。
const wsBaseUrl = `ws://${location.hostname}:3000`;
const httpBaseUrl = '';

const name = ref(localStorage.getItem('be:name') ?? '');
const token = ref<string | null>(localStorage.getItem('be:token'));
const user = ref<UserInfo | null>(JSON.parse(localStorage.getItem('be:user') ?? 'null'));
const docs = ref<DocumentMeta[]>([]);
const current = ref<DocumentMeta | null>(null);
const newTitle = ref('');
const errorMessage = ref('');

async function refreshDocs(): Promise<void> {
  try {
    docs.value = await listDocuments();
    errorMessage.value = '';
  } catch (err) {
    docs.value = [];
    errorMessage.value = `文档列表加载失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

onMounted(() => {
  if (token.value && user.value) void refreshDocs();
});

async function doLogin(): Promise<void> {
  if (!name.value.trim()) return;
  const result = await login(name.value.trim());
  token.value = result.token;
  user.value = result.user;
  localStorage.setItem('be:name', name.value);
  localStorage.setItem('be:token', result.token);
  localStorage.setItem('be:user', JSON.stringify(result.user));
  await refreshDocs();
}

async function create(): Promise<void> {
  if (!newTitle.value.trim()) return;
  try {
    current.value = await createDocument(newTitle.value.trim());
    newTitle.value = '';
    errorMessage.value = '';
  } catch (err) {
    errorMessage.value = `新建文档失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

function logout(): void {
  token.value = null;
  user.value = null;
  current.value = null;
  localStorage.removeItem('be:token');
  localStorage.removeItem('be:user');
}
</script>

<template>
  <EditorRoot
    v-if="current && user"
    :key="current.id"
    :doc-id="current.id"
    :doc-title="current.title"
    :user="user"
    :token="() => token"
    :ws-base-url="wsBaseUrl"
    :http-base-url="httpBaseUrl"
  />

  <div v-else class="doc-picker">
    <h1>📓 BlockEditor · 分布式块级协同编辑器</h1>
    <p style="color: var(--be-muted)">
      Yjs CRDT 内核 · protobuf 二进制增量 · IndexedDB 离线优先 · Vue3 自研块渲染引擎
    </p>

    <template v-if="!user">
      <input v-model="name" placeholder="输入昵称登录（开发态演示登录）" @keyup.enter="doLogin" />
      <button @click="doLogin">登录</button>
    </template>

    <template v-else>
      <div style="display:flex; gap:8px">
        <input v-model="newTitle" placeholder="新建文档标题" @keyup.enter="create" />
        <button @click="create">新建</button>
      </div>
      <div class="doc-list">
        <div v-for="doc in docs" :key="doc.id" class="doc-item" @click="current = doc">
          <strong>{{ doc.title }}</strong>
          <div style="font-size:12px;color:var(--be-muted)">
            {{ doc.id }} · 更新于 {{ new Date(doc.updatedAt).toLocaleString() }}
          </div>
        </div>
      </div>
      <p v-if="errorMessage" style="color:#ef4444">{{ errorMessage }}</p>
      <p><button style="background:#6b7280" @click="logout">退出登录</button></p>
    </template>
  </div>
</template>
