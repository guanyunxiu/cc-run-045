import type { Frame } from '@blockeditor/proto';

/**
 * 协同连接抽象。
 *
 * 一个连接对应一个用户在一个文档房间内的会话通道，
 * 物理实现可以是 WebSocket（WsConnection）或 HTTP 长轮询（PollConnection）。
 * 房间逻辑只依赖该接口，因此两种传输共用同一套 sync / awareness 语义。
 */
export interface CollabConnection {
  /** y-protocols awareness clientID（由客户端在帧中携带）。 */
  clientId: number;
  userId: string;
  userName: string;
  readonly transport: 'websocket' | 'longpoll';
  /** 是否仍可接收下行消息。 */
  alive: boolean;
  /** 向该连接发送一批协议帧。 */
  send(frames: Frame[]): void;
  close(code?: number, reason?: string): void;
}
