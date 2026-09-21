import type * as Y from 'yjs';
import {
  FrameKind,
  createSyncStep1Payload,
  packFrames,
  unpackFrames,
  type Frame,
} from '@blockeditor/proto';
import type { CollabConnection } from './collab-connection.js';

/**
 * 长轮询连接实现。
 *
 * 每个逻辑会话由 clientId 标识，可跨多次 HTTP 请求复用：
 *  - 房间向连接 send() 时只把帧推入队列并唤醒等待者；
 *  - 挂起的 poll 请求在 flush() 时取走队列并结束；
 *  - 60 秒无请求则判定离线，移出房间。
 */
export class PollConnection implements CollabConnection {
  alive = true;
  readonly transport = 'longpoll' as const;
  private queue: Frame[] = [];
  private waiter: (() => void) | null = null;
  private lastSeen = Date.now();
  private joined = false;

  constructor(
    public clientId: number,
    public userId: string,
    public userName: string,
  ) {}

  hasJoined(): boolean {
    return this.joined;
  }

  markJoined(): void {
    this.joined = true;
  }

  send(frames: Frame[]): void {
    this.queue.push(...frames);
    this.waiter?.();
    this.waiter = null;
  }

  /**
   * 取走下行帧（最长 timeoutMs）：
   * 调用时队列里已有帧（例如入房欢迎帧 / 本次请求内入站帧的同步回复）
   * 必须立即返回，否则它们既不挂 waiter 又被随后的等待吞掉，要等 25s 超时后丢失。
   */
  async waitForFrames(timeoutMs: number): Promise<Frame[]> {
    if (this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    this.lastSeen = Date.now();
    const frames = this.queue;
    this.queue = [];
    return frames;
  }

  isExpired(now: number): boolean {
    return now - this.lastSeen > 60_000;
  }

  close(): void {
    this.alive = false;
    this.waiter?.();
  }
}

/** 构造新会话的入房欢迎帧（sync step1；awareness 由房间随后推送）。 */
export function welcomeFrames(docId: string, ydoc: Y.Doc): Frame[] {
  return [{ kind: FrameKind.SyncStep1, docId, payload: createSyncStep1Payload(ydoc) }];
}

export { packFrames, unpackFrames };
