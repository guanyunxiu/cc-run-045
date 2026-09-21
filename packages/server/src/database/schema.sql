-- BlockEditor 服务端 PostgreSQL 结构。
-- 启动时由 DatabaseService.ensureSchema 幂等执行。

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

-- 全局文档级读写权限。owner / editor（读写）/ reader（只读）。
-- 块级权限在迭代 2 以 block_permissions 表扩展（预留接口见 permissions.service.ts）。
CREATE TABLE IF NOT EXISTS permissions (
  doc_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'reader')),
  PRIMARY KEY (doc_id, user_id)
);

-- Yjs 文档持久化：以合并后的全量二进制状态存放，
-- 重启房间时从该状态重建 CRDT，历史增量无需保留（CRDT 自包含）。
CREATE TABLE IF NOT EXISTS ydoc_state (
  doc_id     TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state_b64  TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
