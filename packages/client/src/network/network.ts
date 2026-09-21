import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import {
  FrameKind,
  applyAwarenessUpdatePayload,
  createSyncStep1Payload,
  encodeAwarenessUpdatePayload,
  encodeSyncUpdatePayload,
  processSyncPayload,
  type Frame,
} from '@blockeditor/proto';
import { LOCAL_ORIGIN, REMOTE_ORIGIN, type BlockDoc } from '@blockeditor/core';
import type { Transport, TransportKind, TransportStatus } from './transport.js';
import { WebSocketTransport } from './websocket-transport.js';
import { LongPollTransport } from './longpoll-transport.js';
import { SyncQueue, type PendingUpdate, fromBase64 } from '../offline/sync-queue.js';

export type ConnectionPhase = 'offline' | 'connecting' | 'syncing' | 'synced';

export interface NetworkManagerOptions {
  blockDoc: BlockDoc;
  yDoc: Y.Doc;
  awareness: Awareness;
  queue: SyncQueue;
  docId: string;
  token: () => string | null;
  /** 优先传输方式，失败自动降级；默认 websocket。 */
  prefer?: TransportKind;
  wsUrl: string;
  httpUrl: string;
}

/**
 * NetworkManager —— 协同连接编排器。
 *
 * 职责：
 *  1. 选择传输（WebSocket，连续失败降级 HTTP 长轮询），统一上下行帧；
 *  2. 维护 y-protocols 两步同步握手：step1(stateVector) -> step2(增量)；
 *  3. 在线时把本地 Yjs 事务增量以 SyncUpdate 二进制广播；
 *  4. 离线时增量落入 SyncQueue；恢复后先合并远端，再幂等冲刷队列；
 *  5. 转发 awareness（光标/选区）更新。
 */
export class NetworkManager {
  private transport: Transport | null = null;
  private preferred: TransportKind;
  private downgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private downgraded = false;
  /** 是否已完成首轮流状同步（决定是否冲刷离线队列）。 */
  private initialSyncDone = false;
  private flushing = false;
  /** 等待服务端 ACK 的幂等键 -> resolve。 */
  private ackWaiters = new Map<string, () => void>();
  private phase: ConnectionPhase = 'offline';

  onPhase: ((phase: ConnectionPhase, detail?: string) => void) | null = null;

  constructor(private readonly options: NetworkManagerOptions) {
    this.preferred = options.prefer ?? 'websocket';
    // 本地事务 -> 在线广播 / 离线入队；远端更新（REMOTE_ORIGIN / 本管理器
    // 通过 processSyncPayload 注入的 origin）直接忽略。
    options.yDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN) this.handleLocalUpdate(update);
    });
    options.awareness.on(
      'update',
      (
        params: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === this) return; // 远端回环不再广播
        const changed = [...params.added, ...params.updated, ...params.removed];
        if (changed.length) {
          this.send([
            {
              kind: FrameKind.AwarenessUpdate,
              docId: options.docId,
              clientId: options.awareness.clientID,
              payload: encodeAwarenessUpdatePayload(options.awareness, changed),
            },
          ]);
        }
      },
    );
    window.addEventListener('online', this.handleBrowserOnline);
    window.addEventListener('offline', this.handleBrowserOffline);
  }

  /** 单连接内本地更新自增序号，与 clientID 拼成幂等键。 */
  private updateSeq = 0;

  private nextRef(): string {
    this.updateSeq += 1;
    return `${this.options.awareness.clientID}:${this.updateSeq}`;
  }

  private handleLocalUpdate(update: Uint8Array): void {
    const ref = this.nextRef();
    if (this.phase === 'synced' && this.transport?.status === 'online') {
      this.send([
        {
          kind: FrameKind.SyncUpdate,
          docId: this.options.docId,
          clientId: this.options.awareness.clientID,
          payload: encodeSyncUpdatePayload(update),
          ref,
        },
      ]);
      return;
    }
    // 离线（或尚未完成首同步）：二进制增量连同幂等键落本地队列。
    void this.options.queue.enqueue(ref, update);
  }

  // 保留 dedupeKey 供未来需要从更新字节计算去重键的场景。
  private dedupeKey(): string {
    return this.nextRef();
  }

  start(): void {
    this.connect(this.preferred);
  }

  stop(): void {
    window.removeEventListener('online', this.handleBrowserOnline);
    window.removeEventListener('offline', this.handleBrowserOffline);
    if (this.downgradeTimer) clearTimeout(this.downgradeTimer);
    this.transport?.disconnect();
    this.transport = null;
    this.setPhase('offline');
  }

  private connect(kind: TransportKind): void {
    this.transport?.disconnect();
    const common = {
      docId: this.options.docId,
      token: this.options.token(),
      clientId: this.options.awareness.clientID,
    };
    const transport: Transport =
      kind === 'websocket'
        ? new WebSocketTransport({ ...common, url: this.options.wsUrl })
        : new LongPollTransport({ ...common, url: this.options.httpUrl });

    transport.onStatus = (status, detail) => this.handleStatus(status, detail, kind);
    transport.onMessage = (frames) => this.handleFrames(frames);
    this.transport = transport;
    this.initialSyncDone = false;
    this.setPhase('connecting');
    transport.connect();

    if (kind === 'websocket' && !this.downgraded) {
      // 8 秒内未进入在线态，判定 WebSocket 不可用，降级长轮询。
      this.downgradeTimer = setTimeout(() => {
        if (this.transport === transport && transport.status !== 'online') {
          this.downgraded = true;
          this.connect('longpoll');
        }
      }, 8_000);
    }
  }

  private handleStatus(status: TransportStatus, detail: string | undefined, kind: TransportKind): void {
    if (status === 'online') {
      if (this.downgradeTimer) clearTimeout(this.downgradeTimer);
      this.downgradeTimer = null;
      this.setPhase('syncing', kind === 'longpoll' ? '已降级为 HTTP 长轮询' : detail);
      this.handshake();
    } else if (status === 'offline' || status === 'error') {
      this.initialSyncDone = false;
      this.setPhase('offline', detail);
      if (status === 'error' && kind === 'websocket' && !this.downgraded) {
        this.downgraded = true;
        this.connect('longpoll');
      }
    }
  }

  /** sync step1：服务端以 step2 回补差异。 */
  private handshake(): void {
    this.send([
      {
        kind: FrameKind.Auth,
        docId: this.options.docId,
        clientId: this.options.awareness.clientID,
        payload: new TextEncoder().encode(this.options.token() ?? ''),
      },
      {
        kind: FrameKind.SyncStep1,
        docId: this.options.docId,
        clientId: this.options.awareness.clientID,
        payload: createSyncStep1Payload(this.options.yDoc),
      },
    ]);
  }

  private async handleFrames(frames: Frame[]): Promise<void> {
    for (const frame of frames) {
      switch (frame.kind) {
        case FrameKind.SyncStep1:
        case FrameKind.SyncStep2:
        case FrameKind.SyncUpdate: {
          // 以 NetworkManager 为远端 origin：内核将识别为非本地变更，不进撤销栈。
          const reply = processSyncPayload(frame.payload, this.options.yDoc, REMOTE_ORIGIN);
          if (reply && frame.kind === FrameKind.SyncStep1) {
            this.send([
              { kind: FrameKind.SyncStep2, docId: frame.docId || this.options.docId, payload: reply },
            ]);
          }
          if (frame.kind === FrameKind.SyncStep2 && !this.initialSyncDone) {
            this.initialSyncDone = true;
            this.setPhase('synced');
            void this.flushQueue();
          }
          if (frame.kind === FrameKind.SyncUpdate && this.phase !== 'synced') {
            // 握手期间的增量并入后仍以 step2 完成为准。
          }
          break;
        }
        case FrameKind.AwarenessUpdate:
        case FrameKind.AwarenessQuery:
          applyAwarenessUpdatePayload(frame.payload, this.options.awareness, this);
          break;
        case FrameKind.Ping:
          this.send([{ kind: FrameKind.Pong, docId: frame.docId || this.options.docId, payload: new Uint8Array(0) }]);
          break;
        case FrameKind.Pong:
          break;
        case FrameKind.Error:
          console.warn('[collab] 服务端错误帧', frame.payload);
          break;
        case FrameKind.Ack:
          await this.handleAck(frame);
          break;
        default:
          break;
      }
    }
  }

  /** 服务端对某幂等键的确认，出队对应更新。 */
  private async handleAck(frame: Frame): Promise<void> {
    const key = new TextDecoder().decode(frame.payload);
    this.ackWaiters.get(key)?.();
    const pending = await this.options.queue.all();
    const matched = pending.find((item) => item.dedupeKey === key);
    if (matched) await this.options.queue.remove(matched.seq);
  }

  /** 网络恢复后：状态校验已在握手 step1/step2 完成，这里幂等冲刷本地增量。 */
  private async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let pending: PendingUpdate[] = await this.options.queue.all();
      while (pending.length && this.transport?.status === 'online') {
        const item = pending[0];
        await this.options.queue.markAttempt(item.seq);

        const acked = new Promise<void>((resolve) => this.ackWaiters.set(item.dedupeKey, resolve));
        this.send([
          {
            kind: FrameKind.SyncUpdate,
            docId: this.options.docId,
            clientId: this.options.awareness.clientID,
            payload: encodeSyncUpdatePayload(fromBase64(item.updateB64)),
            ref: item.dedupeKey,
          },
        ]);
        // 等 ACK；2 秒兜底也继续（Yjs 更新幂等，重复推送安全）。
        await Promise.race([
          acked,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
        this.ackWaiters.delete(item.dedupeKey);
        await this.options.queue.remove(item.seq);
        pending = await this.options.queue.all();
      }
    } finally {
      this.flushing = false;
    }
  }

  private send(frames: Frame[]): void {
    if (frames.length) this.transport?.send(frames);
  }

  private readonly handleBrowserOnline = (): void => {
    // 传输层自身会重连；若当前彻底无传输（stop 除外），补一次握手。
    if (this.phase === 'offline' && this.transport && this.transport.status !== 'online') {
      this.transport.connect();
    }
  };

  private readonly handleBrowserOffline = (): void => {
    this.initialSyncDone = false;
    this.setPhase('offline', '浏览器报告网络已断开');
  };

  private setPhase(phase: ConnectionPhase, detail?: string): void {
    this.phase = phase;
    this.onPhase?.(phase, detail);
  }

  get currentPhase(): ConnectionPhase {
    return this.phase;
  }

  get transportKind(): TransportKind | null {
    return this.transport?.kind ?? null;
  }
}
