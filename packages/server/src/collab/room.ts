import * as Y from 'yjs';
import {
  FrameKind,
  applyAwarenessUpdatePayload,
  encodeAwarenessUpdatePayload,
  encodeErrorPayload,
  encodeSyncUpdatePayload,
  processSyncPayload,
  type Frame,
} from '@blockeditor/proto';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import { Logger } from '@nestjs/common';
import type { CollabConnection } from './collab-connection.js';
import { DatabaseService } from '../database/database.service.js';
import { CacheService } from '../cache/cache.service.js';
import { DocsService } from '../docs/docs.service.js';

/**
 * Room —— 按文档 ID 隔离的协同房间。
 *
 * 持有：
 *  - 一份服务端 Y.Doc（房间首次打开时从 PostgreSQL / 文件存储恢复状态）；
 *  - 房间级 Awareness（在线用户、临时光标状态）；
 *  - 连接表（WebSocket + 长轮询混合接入）。
 *
 * 所有二进制增量在此收敛：任一连接的 SyncUpdate 幂等 applyUpdate 后
 * 以 CRDT 合并结果广播给其余连接 —— 并发的块新增 / 删除 / 移动冲突
 * 由 Yjs 自动合并，服务端不做任何业务级冲突裁决。
 */
export class Room {
  private readonly logger: Logger;
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  private readonly connections = new Set<CollabConnection>();
  /** 同 clientID 的连接替换映射（重连场景）。 */
  private byClientId = new Map<number, CollabConnection>();
  /** 已处理的幂等键（ref），离线队列重放时去重。LRU 上限保护内存。 */
  private seenRefs = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private loaded = false;

  constructor(
    readonly docId: string,
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
    private readonly docs: DocsService,
  ) {
    this.logger = new Logger(`Room:${docId.slice(0, 8)}`);
    // 房间内文档更新 -> 广播（事务 origin 标记来源连接，广播时排除发送者）。
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin instanceof InternalOrigin && origin.connection) {
        this.broadcastExcept(origin.connection, {
          kind: FrameKind.SyncUpdate,
          docId: this.docId,
          clientId: origin.connection.clientId,
          payload: encodeSyncUpdatePayload(update),
        });
        this.schedulePersist();
      }
    });

    // awareness 变化：
    //  1. 二进制增量广播（光标 / 选区）；
    //  2. 在线用户与光标快照写入 Redis（TTL 30s）。
    this.awareness.on('update', (params: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const { added, updated, removed } = params;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      const source = origin instanceof InternalOrigin ? origin.connection : null;
      // 房间自身 ydoc.clientID 的空状态续期不广播（无 user 字段，非真实用户）。
      // removed 状态必须广播（光标消失）；added/updated 仅在携带 user 时转发。
      const removedSet = new Set(removed);
      const broadcastable = changed.filter(
        (id) => removedSet.has(id) || (id !== this.awareness.clientID && this.hasUserState(id)),
      );
      if (broadcastable.length) {
        const frame: Frame = {
          kind: FrameKind.AwarenessUpdate,
          docId: this.docId,
          payload: encodeAwarenessUpdatePayload(this.awareness, broadcastable),
        };
        for (const conn of this.connections) {
          if (conn === source) continue;
          conn.send([frame]);
        }
      }
      void this.snapshotAwareness();
    });
  }

  /** 从持久化层恢复 CRDT 状态（仅首次）。 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const state = await this.db.loadYdocState(this.docId);
    if (state && state.length) {
      Y.applyUpdate(this.ydoc, state, new InternalOrigin(null));
      this.logger.log(`已恢复文档状态（${state.length} 字节）`);
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  addConnection(connection: CollabConnection): void {
    // 同一 clientID 重连：踢掉旧连接，避免重复广播。
    const existing = this.byClientId.get(connection.clientId);
    if (existing) {
      existing.close(4000, '同用户在别处重新连接');
      this.connections.delete(existing);
    }
    this.connections.add(connection);
    this.byClientId.set(connection.clientId, connection);
    // 在线信息写入 Redis 快照（不注入 awareness：房间 Awareness 的
    // local state 只有一个槽位，多连接必须用各自客户端的状态通道）。
    void this.markOnline(connection);
    this.logger.log(`连接加入 client=${connection.clientId} user=${connection.userName}，房间人数=${this.connections.size}`);
  }

  removeConnection(connection: CollabConnection): void {
    if (!this.connections.has(connection)) return;
    this.connections.delete(connection);
    if (this.byClientId.get(connection.clientId) === connection) {
      this.byClientId.delete(connection.clientId);
      // 广播该客户端 awareness 移除（光标消失）。
      removeAwarenessClient(this.awareness, connection.clientId);
    }
    void this.markOffline(connection);
    this.logger.log(`连接离开 client=${connection.clientId}，房间人数=${this.connections.size}`);
  }

  /** 给新加入连接补齐房间当前 awareness：主动推送其他用户的状态。 */
  pushCurrentAwareness(connection: CollabConnection): void {
    // Awareness 构造时会为房间自身 ydoc.clientID 写入空 local state {}，
    // 必须排除：它不是任何真实用户的状态。
    const clientIds = [...this.awareness.getStates().keys()].filter(
      (id) => id !== connection.clientId && id !== this.awareness.clientID && this.hasUserState(id),
    );
    if (clientIds.length) {
      connection.send([
        {
          kind: FrameKind.AwarenessUpdate,
          docId: this.docId,
          payload: encodeAwarenessUpdatePayload(this.awareness, clientIds),
        },
      ]);
    }
  }

  /** 房间只向客户端同步带 user 字段的真实用户 awareness 状态。 */
  private hasUserState(clientId: number): boolean {
    const state = this.awareness.getStates().get(clientId);
    return Boolean(state && state.user);
  }

  // -------------------------------------------------------------------------
  // 帧路由
  // -------------------------------------------------------------------------

  async handleFrame(connection: CollabConnection, frame: Frame): Promise<Frame | null> {
    if (frame.kind === FrameKind.Auth) return null; // 鉴权在接入层完成，帧仅留痕。

    switch (frame.kind) {
      case FrameKind.SyncStep1:
      case FrameKind.SyncStep2: {
        const reply = processSyncPayload(frame.payload, this.ydoc, new InternalOrigin(null));
        if (reply && frame.kind === FrameKind.SyncStep1) {
          return { kind: FrameKind.SyncStep2, docId: this.docId, payload: reply };
        }
        if (reply) this.schedulePersist();
        return null;
      }
      case FrameKind.SyncUpdate: {
        // 幂等去重：离线队列重放的同一 ref 只合并一次。
        if (frame.ref) {
          if (this.seenRefs.has(frame.ref)) {
            return { kind: FrameKind.Ack, docId: this.docId, payload: new TextEncoder().encode(frame.ref) };
          }
          this.rememberRef(frame.ref);
        }
        processSyncPayload(frame.payload, this.ydoc, new InternalOrigin(connection));
        this.schedulePersist();
        return frame.ref
          ? { kind: FrameKind.Ack, docId: this.docId, payload: new TextEncoder().encode(frame.ref) }
          : null;
      }
      case FrameKind.AwarenessUpdate:
      case FrameKind.AwarenessQuery: {
        if (frame.kind === FrameKind.AwarenessUpdate && frame.payload.length) {
          applyAwarenessUpdatePayload(frame.payload, this.awareness, new InternalOrigin(connection));
        }
        if (frame.kind === FrameKind.AwarenessQuery) this.pushCurrentAwareness(connection);
        return null;
      }
      case FrameKind.Ping:
        return { kind: FrameKind.Pong, docId: this.docId, payload: new Uint8Array(0) };
      default:
        return {
          kind: FrameKind.Error,
          docId: this.docId,
          payload: encodeErrorPayload(4000, `房间不支持的帧类型 ${frame.kind}`),
        };
    }
  }

  private rememberRef(ref: string): void {
    this.seenRefs.add(ref);
    if (this.seenRefs.size <= 2000) return;
    // 简单 FIFO 裁剪：迭代插入顺序即时间顺序。
    const first = this.seenRefs.values().next().value;
    if (first !== undefined) this.seenRefs.delete(first);
  }

  // -------------------------------------------------------------------------
  // 广播
  // -------------------------------------------------------------------------

  /** 向除 except 外的所有存活连接广播同一帧。 */
  private broadcastExcept(except: CollabConnection | null, frame: Frame, _persist = false): void {
    for (const connection of this.connections) {
      if (connection === except || !connection.alive) continue;
      connection.send([frame]);
    }
  }

  // -------------------------------------------------------------------------
  // 持久化（防抖合并写入，避免高频更新打爆数据库）
  // -------------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 500);
  }

  async persistNow(): Promise<void> {
    if (this.destroyed) return;
    const state = Y.encodeStateAsUpdate(this.ydoc);
    await this.db.saveYdocState(this.docId, state);
    await this.docs.touch(this.docId);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persistNow();
    this.awareness.destroy();
    this.ydoc.destroy();
  }

  // -------------------------------------------------------------------------
  // Redis：在线用户 / 临时光标快照
  // -------------------------------------------------------------------------

  private async markOnline(connection: CollabConnection): Promise<void> {
    await this.cache.hsetJson(
      `doc:${this.docId}:online`,
      String(connection.clientId),
      {
        userId: connection.userId,
        userName: connection.userName,
        transport: connection.transport,
        joinedAt: Date.now(),
      },
      60_000,
    );
  }

  private async markOffline(connection: CollabConnection): Promise<void> {
    await this.cache.hdelJson(`doc:${this.docId}:online`, String(connection.clientId));
  }

  private async snapshotAwareness(): Promise<void> {
    const snapshot: Record<string, unknown> = {};
    this.awareness.getStates().forEach((state, clientId) => {
      if (state.user) snapshot[String(clientId)] = state;
    });
    await this.cache.set(`doc:${this.docId}:awareness`, JSON.stringify(snapshot), 30_000);
  }
}

/** 内部标记：区分 Yjs 事务由哪个连接（或服务端自身）发起。 */
class InternalOrigin {
  constructor(readonly connection: CollabConnection | null) {}
}

function removeAwarenessClient(awareness: Awareness, clientId: number): void {
  // 官方推荐：removeAwarenessStates 会触发 awareness 'update' 事件并附带 removed。
  removeAwarenessStates(awareness, [clientId], 'connection closed');
}
