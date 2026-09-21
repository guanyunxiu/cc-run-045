import { packFrames, unpackFrames, type Frame } from '@blockeditor/proto';
import type { Transport, TransportOptions, TransportStatus } from './transport.js';

/** 带指数退避重连的 WebSocket 传输，负载为 protobuf length-delimited 二进制。 */
export class WebSocketTransport implements Transport {
  readonly kind = 'websocket' as const;
  status: TransportStatus = 'idle';
  onMessage: ((frames: Frame[]) => void) | null = null;
  onStatus: ((status: TransportStatus, detail?: string) => void) | null = null;

  private ws: WebSocket | null = null;
  /** 连接尚未 open 时的待发帧，open 后立即冲刷。 */
  private queued: Frame[] = [];
  private closedByUs = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pingFrame: Frame;

  constructor(private readonly options: TransportOptions) {
    this.pingFrame = { kind: 8 as Frame['kind'], docId: options.docId, payload: new Uint8Array(0), clientId: options.clientId };
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    this.setStatus('connecting');
    const url = new URL(this.options.url);
    url.searchParams.set('doc', this.options.docId);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      this.failWithFallback(String(err));
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.setStatus('online');
      if (this.queued.length) {
        ws.send(packFrames(this.queued).buffer);
        this.queued = [];
      }
      this.startPing();
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return; // 本协议只收发二进制
      try {
        this.onMessage?.(unpackFrames(new Uint8Array(event.data as ArrayBuffer)));
      } catch (err) {
        console.warn('[ws] 帧解析失败', err);
      }
    });

    ws.addEventListener('close', (event) => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUs) {
        this.setStatus('idle');
        return;
      }
      // 1008 = 服务端鉴权 / 权限拒绝；4401 等业务码同样不重试。
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        this.failWithFallback(`连接被拒绝 (${event.code}) ${event.reason}`);
        return;
      }
      this.setStatus('offline', `连接关闭，${event.reason || '准备重连'}`);
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close 事件会紧随其后，统一在 close 中决策（降级或重连）。
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send([this.pingFrame]), 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs) return;
    this.reconnectAttempts += 1;
    // 1s, 2s, 4s ... 最大 15s；长连期间网络抖动也走该路径。
    const delay = Math.min(15_000, 2 ** this.reconnectAttempts * 500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (navigator.onLine === false) return; // 浏览器已明确断网，等 online 事件
      this.open();
    }, delay);
  }

  /** 连续失败或被环境拒绝时抛出 offline，由 NetworkManager 降级到长轮询。 */
  private failWithFallback(detail: string): void {
    this.setStatus('error', detail);
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }

  send(frames: Frame[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queued.push(...frames);
      return;
    }
    this.ws.send(packFrames(frames).buffer);
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    this.onStatus?.(status, detail);
  }
}
