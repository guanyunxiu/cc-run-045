import type { WebSocket } from 'ws';
import {
  FrameKind,
  encodeErrorPayload,
  packFrames,
  type Frame,
} from '@blockeditor/proto';
import type { CollabConnection } from './collab-connection.js';

/** WebSocket 物理连接 -> CollabConnection 适配。 */
export class WsConnection implements CollabConnection {
  alive = true;

  constructor(
    private readonly ws: WebSocket,
    public clientId: number,
    public userId: string,
    public userName: string,
  ) {}

  readonly transport = 'websocket' as const;

  send(frames: Frame[]): void {
    if (!this.alive || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(packFrames(frames));
  }

  sendError(code: number, message: string, docId: string): void {
    this.send([{ kind: FrameKind.Error, docId, payload: encodeErrorPayload(code, message) }]);
  }

  close(code?: number, reason?: string): void {
    this.alive = false;
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close(code, reason);
    }
  }
}
