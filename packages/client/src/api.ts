/**
 * HTTP API 封装：登录 / 文档元数据 / 权限。
 * 协同数据流（Yjs 二进制增量）走 WebSocket / 长轮询，不经此模块。
 */

const BASE = '/api';
const TOKEN_KEY = 'be:token';

/** 读取登录后存放在 localStorage 的 JWT（与 App.vue 登录落盘的键一致）。 */
function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export interface UserInfo {
  id: string;
  name: string;
}

export interface DocumentMeta {
  id: string;
  title: string;
  ownerId: string;
  updatedAt: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`API ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

/** 开发态演示登录：服务端直接发一个内存 JWT。 */
export async function login(name: string): Promise<{ token: string; user: UserInfo }> {
  return request('/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function listDocuments(): Promise<DocumentMeta[]> {
  return request('/docs');
}

export async function createDocument(title: string): Promise<DocumentMeta> {
  return request('/docs', { method: 'POST', body: JSON.stringify({ title }) });
}

export async function getDocument(id: string): Promise<DocumentMeta> {
  return request(`/docs/${id}`);
}
