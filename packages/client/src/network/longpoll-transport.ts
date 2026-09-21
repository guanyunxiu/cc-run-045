import { packFrames, unpackFrames, type Frame } from '@blockeditor/proto';
import type { Transport, TransportOptions, TransportStatus } from './transport.js';

/**
 * HTTP 长轮询降级传输。
 *
 * 交互模型：
 *  - 客户端持续挂一个 POST /api/collab/poll/<docId> 请求（二进制 body 为本端帧）；
 *  - 服务端阻塞至"有下行帧"或 25s 超时后返回（可能仅含 Pong）；
 *  - 客户端收到响应后立刻发起下一次 poll，形成等价于推送的通道；
 *  - 上行帧随每次 poll body 捎带，无额外连接，天然穿透严格代理。
 *
 * 后端路由文档 ID 在路径里（且统一带 /api 前缀），鉴权走 Authorization
 * 头；帧协议、房间、sync/awareness 逻辑与 WebSocket 完全共用。
 */
export class LongPollTransport implements Transport {
  readonly kind = 'longpoll' as const;
  status: TransportStatus = 'idle';
  onMessage: ((frames: Frame[]) => void) | null = null;
  onStatus: ((status: TransportStatus, detail?: string) => void) | null = null;

  private stopped = false;
  private polling = false;
  /** 等待下一次 poll 捎带上行的帧。 */
  private outbound: Frame[] = [];
  private readonly endpoint: string;
  private online = false;

  constructor(private readonly options: TransportOptions) {
    const base = this.options.url.replace(/\/$/, '');
    this.endpoint = `${base}/api/collab/poll/${encodeURIComponent(this.options.docId)}`;
  }

  connect(): void {
    this.stopped = false;
    this.setStatus('connecting');
    this.loop();
    // 断网恢复后立即补一次 poll，而不是等当前请求超时。
    window.addEventListener('online', this.kick);
  }

  private readonly kick = (): void => {
    if (!this.stopped && !this.polling) this.loop();
  };

  disconnect(): void {
    this.stopped = true;
    window.removeEventListener('online', this.kick);
    this.setStatus('idle');
  }

  send(frames: Frame[]): void {
    this.outbound.push(...frames);
    this.kick();
  }

  private async loop(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const frames = this.outbound;
      this.outbound = [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const response = await fetch(
        `${this.endpoint}?clientId=${this.options.clientId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-protobuf',
            ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
          },
          body: packFrames(frames).buffer as ArrayBuffer,
          signal: controller.signal,
          credentials: 'include',
        },
      );
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`长轮询 HTTP ${response.status}`);
      }
      if (!this.online) {
        this.online = true;
        this.setStatus('online');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length) this.onMessage?.(unpackFrames(bytes));
    } catch (err) {
      if (!this.stopped) {
        this.online = false;
        this.setStatus('offline', err instanceof Error ? err.message : String(err));
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      this.polling = false;
      if (!this.stopped) {
        // 立即续挂；网络不可用时 fetch 会快速失败并退避。
        void this.loop();
      }
    }
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    this.onStatus?.(status, detail);
  }
}
