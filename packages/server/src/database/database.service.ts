import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

/**
 * 数据库访问层。
 *
 * 生产：PostgreSQL（users / documents / permissions / ydoc_state）。
 * 开发降级：DATABASE_URL 连不上时透明切换到 .data/file-store.json，
 * 功能完整，便于零基础设施启动与端到端演示。
 */
export interface UserRow {
  id: string;
  name: string;
  password_hash: string | null;
  created_at: number;
}

export interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: number;
  updated_at: number;
}

export interface PermissionRow {
  doc_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'reader';
}

type Table = 'users' | 'documents' | 'permissions' | 'ydoc_state';

interface FileStoreShape {
  users: UserRow[];
  documents: DocumentRow[];
  permissions: PermissionRow[];
  /** Yjs 文档全量状态（二进制以 base64 存放）。 */
  ydoc_state: Array<{ doc_id: string; state_b64: string; updated_at: number }>;
}

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private pg: import('pg').Pool | null = null;
  private usePostgres = false;
  private readonly filePath = resolve(process.cwd(), '.data/file-store.json');
  private fileStore: FileStoreShape = { users: [], documents: [], permissions: [], ydoc_state: [] };

  async onModuleInit(): Promise<void> {
    try {
      const { default: { Pool } } = await import('pg');
      this.pg = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2000 });
      await this.pg.query('SELECT 1');
      await this.ensureSchema();
      this.usePostgres = true;
      this.logger.log('已连接 PostgreSQL');
    } catch (err) {
      this.usePostgres = false;
      this.logger.warn(`PostgreSQL 不可用（${(err as Error).message}），降级为本地文件存储 ${this.filePath}`);
      this.loadFileStore();
    }
  }

  private async ensureSchema(): Promise<void> {
    const sqlPath = new URL('./schema.sql', import.meta.url);
    // tsx / 编译产物两种运行方式下 import.meta.url 均指向本目录。
    const sql = readFileSync(sqlPath, 'utf8');
    await this.pg!.query(sql);
  }

  // -------------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------------

  async findUserByName(name: string): Promise<UserRow | null> {
    if (this.usePostgres) {
      const { rows } = await this.pg!.query<UserRow>('SELECT * FROM users WHERE name = $1', [name]);
      return rows[0] ?? null;
    }
    return this.fileStore.users.find((u) => u.name === name) ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    if (this.usePostgres) {
      const { rows } = await this.pg!.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ?? null;
    }
    return this.fileStore.users.find((u) => u.id === id) ?? null;
  }

  async insertUser(user: UserRow): Promise<void> {
    if (this.usePostgres) {
      await this.pg!.query(
        'INSERT INTO users (id, name, password_hash, created_at) VALUES ($1,$2,$3,$4)',
        [user.id, user.name, user.password_hash, user.created_at],
      );
      return;
    }
    this.fileStore.users.push(user);
    this.saveFileStore();
  }

  // -------------------------------------------------------------------------
  // documents + permissions
  // -------------------------------------------------------------------------

  async listDocumentsForUser(userId: string): Promise<DocumentRow[]> {
    if (this.usePostgres) {
      const { rows } = await this.pg!.query<DocumentRow>(
        `SELECT d.* FROM documents d
         JOIN permissions p ON p.doc_id = d.id
         WHERE p.user_id = $1 ORDER BY d.updated_at DESC`,
        [userId],
      );
      return rows;
    }
    const allowed = new Set(
      this.fileStore.permissions.filter((p) => p.user_id === userId).map((p) => p.doc_id),
    );
    return this.fileStore.documents
      .filter((d) => allowed.has(d.id))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  async getDocument(id: string): Promise<DocumentRow | null> {
    if (this.usePostgres) {
      const { rows } = await this.pg!.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id]);
      return rows[0] ?? null;
    }
    return this.fileStore.documents.find((d) => d.id === id) ?? null;
  }

  async insertDocument(doc: DocumentRow, ownerId: string): Promise<void> {
    if (this.usePostgres) {
      const client = await this.pg!.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO documents (id, title, owner_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)',
          [doc.id, doc.title, doc.owner_id, doc.created_at, doc.updated_at],
        );
        await client.query(
          'INSERT INTO permissions (doc_id, user_id, role) VALUES ($1,$2,$3)',
          [doc.id, ownerId, 'owner'],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }
    this.fileStore.documents.push(doc);
    this.fileStore.permissions.push({ doc_id: doc.id, user_id: ownerId, role: 'owner' });
    this.saveFileStore();
  }

  async touchDocument(id: string, updatedAt: number): Promise<void> {
    if (this.usePostgres) {
      await this.pg!.query('UPDATE documents SET updated_at = $2 WHERE id = $1', [id, updatedAt]);
      return;
    }
    const doc = this.fileStore.documents.find((d) => d.id === id);
    if (doc) doc.updated_at = updatedAt;
    this.saveFileStore();
  }

  async getPermission(docId: string, userId: string): Promise<PermissionRow | null> {
    if (this.usePostgres) {
      const { rows } = await this.pg!.query<PermissionRow>(
        'SELECT * FROM permissions WHERE doc_id = $1 AND user_id = $2',
        [docId, userId],
      );
      return rows[0] ?? null;
    }
    return (
      this.fileStore.permissions.find((p) => p.doc_id === docId && p.user_id === userId) ?? null
    );
  }

  async grantPermission(permission: PermissionRow): Promise<void> {
    if (this.usePostgres) {
      await this.pg!.query(
        `INSERT INTO permissions (doc_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [permission.doc_id, permission.user_id, permission.role],
      );
      return;
    }
    const existing = this.fileStore.permissions.find(
      (p) => p.doc_id === permission.doc_id && p.user_id === permission.user_id,
    );
    if (existing) existing.role = permission.role;
    else this.fileStore.permissions.push(permission);
    this.saveFileStore();
  }

  // -------------------------------------------------------------------------
  // Yjs 文档状态
  // -------------------------------------------------------------------------

  async loadYdocState(docId: string): Promise<Uint8Array | null> {
    if (this.usePostgres) {
      const { rows } = await this.pg!.query<{ state_b64: string }>(
        'SELECT state_b64 FROM ydoc_state WHERE doc_id = $1',
        [docId],
      );
      return rows[0] ? Buffer.from(rows[0].state_b64, 'base64') : null;
    }
    const row = this.fileStore.ydoc_state.find((r) => r.doc_id === docId);
    return row ? Uint8Array.from(Buffer.from(row.state_b64, 'base64')) : null;
  }

  async saveYdocState(docId: string, state: Uint8Array): Promise<void> {
    const b64 = Buffer.from(state).toString('base64');
    if (this.usePostgres) {
      await this.pg!.query(
        `INSERT INTO ydoc_state (doc_id, state_b64, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (doc_id) DO UPDATE SET state_b64 = EXCLUDED.state_b64,
                                           updated_at = EXCLUDED.updated_at`,
        [docId, b64, Date.now()],
      );
      return;
    }
    const row = this.fileStore.ydoc_state.find((r) => r.doc_id === docId);
    if (row) {
      row.state_b64 = b64;
      row.updated_at = Date.now();
    } else {
      this.fileStore.ydoc_state.push({ doc_id: docId, state_b64: b64, updated_at: Date.now() });
    }
    this.saveFileStore();
  }

  // -------------------------------------------------------------------------
  // 文件存储降级
  // -------------------------------------------------------------------------

  private loadFileStore(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      try {
        this.fileStore = JSON.parse(readFileSync(this.filePath, 'utf8')) as FileStoreShape;
        this.fileStore.users ??= [];
        this.fileStore.documents ??= [];
        this.fileStore.permissions ??= [];
        this.fileStore.ydoc_state ??= [];
      } catch {
        // 损坏的文件不阻断启动，以空库继续。
      }
    }
  }

  private saveFileStore(): void {
    if (this.usePostgres) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.fileStore, null, 2));
  }
}
