import type { Frame } from '@blockeditor/proto';

export type TransportStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'error';

export type TransportKind = 'websocket' | 'longpoll';

export interface TransportOptions {
  docId: string;
  token: string | null;
  /** 客户端 awareness clientID。 */
  clientId: number;
  /** WebSocket 基址，如 ws://host:3000/collab/ws；长轮询形如 http://host:3000/api。 */
  url: string;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly status: TransportStatus;
  /** 收到一批帧（物理消息中可含多帧）。 */
  onMessage: ((frames: Frame[]) => void) | null;
  onStatus: ((status: TransportStatus, detail?: string) => void) | null;
  connect(): void;
  disconnect(): void;
  send(frames: Frame[]): void;
}
