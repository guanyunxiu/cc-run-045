import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import type { WebSocketServer as WsServerType } from 'ws';
import {
  FrameKind,
  createSyncStep1Payload,
  encodeErrorPayload,
  unpackFrames,
} from '@blockeditor/proto';
import { RoomManager } from './room-manager.service.js';
import { WsConnection } from './ws-connection.js';
import { AuthService } from '../auth/auth.service.js';
import { PermissionsService } from '../docs/permissions.service.js';

interface ConnectionMeta {
  connection: WsConnection;
  docId: string;
  authenticated: boolean;
}

/**
 * CollabGateway —— 二次封装 y-websocket 语义的 Nest WebSocket 网关。
 *
 * 注意：@nestjs/platform-ws 的 WsAdapter 对 upgrade 路径做精确匹配，
 * 不支持路径参数，因此固定挂载在 /collab/ws，文档 ID 经 query 参数
 * ?doc=<id> 传入（与 y-websocket 生态的 room 传参习惯一致）。
 *
 * 与原生 y-websocket 的差异：
 *  - 物理封套为 protobuf Frame（y-protobuf），而非裸 y-protocol 字节；
 *  - 接入时强制文档级权限校验（JWT 经 query token 或 Auth 帧携带）；
 *  - 房间由 Nest DI 管理，可直接注入 PostgreSQL / Redis；
 *  - sync / awareness 的二进制语义与 y-websocket 完全一致。
 */
@WebSocketGateway({ path: '/collab/ws' })
export class CollabGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(CollabGateway.name);

  @WebSocketServer()
  private server!: WsServerType;

  /** ws 实例 -> 连接元数据。 */
  private readonly meta = new Map<WebSocket, ConnectionMeta>();

  constructor(
    @Inject(RoomManager) private readonly rooms: RoomManager,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  async handleConnection(ws: WebSocket, request: { url?: string; socket?: unknown }): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const docId = url.searchParams.get('doc') ?? url.pathname.split('/').pop() ?? '';
    const queryToken = url.searchParams.get('token');

    ws.binaryType = 'arraybuffer';

    // 鉴权优先使用 query token（WS 握手时无法自定义头），Auth 帧可后续覆盖。
    let token = queryToken;
    let userId = '';
    let userName = '';
    try {
      const payload = this.auth.authenticate(token);
      userId = payload.sub;
      userName = payload.name;
    } catch (err) {
      // 允许先连接，但在 Auth 帧到来前拒绝一切写操作。
      this.logger.debug(`连接暂未鉴权: ${(err as Error).message}`);
    }

    let docAuthorized = false;
    if (userId && docId) {
      try {
        await this.permissions.requireRole(docId, userId, 'read');
        docAuthorized = true;
      } catch {
        ws.close(4403, '无权访问该文档');
        return;
      }
    }

    if (!docId) {
      ws.close(4400, '缺少文档 ID');
      return;
    }

    const connection = new WsConnection(ws, 0, userId, userName);
    const meta: ConnectionMeta = { connection, docId, authenticated: docAuthorized };
    this.meta.set(ws, meta);

    ws.on('message', (data: ArrayBuffer | Buffer) =>
      this.handleMessage(meta, new Uint8Array(data as ArrayBuffer)),
    );
    ws.on('close', () => this.cleanup(ws));
    ws.on('error', () => this.cleanup(ws));
  }

  private async handleMessage(meta: ConnectionMeta, bytes: Uint8Array): Promise<void> {
    let frames;
    try {
      frames = unpackFrames(bytes);
    } catch (err) {
      meta.connection.close(4400, `帧解析失败: ${(err as Error).message}`);
      return;
    }

    for (const frame of frames) {
      // 延迟鉴权：首帧 Auth。
      if (frame.kind === FrameKind.Auth) {
        const token = new TextDecoder().decode(frame.payload);
        try {
          const payload = this.auth.authenticate(token);
          await this.permissions.requireRole(meta.docId, payload.sub, 'read');
          meta.connection.userId = payload.sub;
          meta.connection.userName = payload.name;
          meta.authenticated = true;
          meta.connection.clientId = frame.clientId ?? 0;
          await this.joinRoom(meta);
        } catch (err) {
          meta.connection.close(4401, `鉴权失败: ${(err as Error).message}`);
          return;
        }
        continue;
      }

      if (!meta.authenticated) {
        meta.connection.sendError(4401, '请先发送 Auth 帧', meta.docId);
        continue;
      }
      // clientID 可能在首个非 Auth 帧才确定（query 直连场景）。
      if (meta.connection.clientId === 0 && frame.clientId) {
        meta.connection.clientId = frame.clientId;
        await this.joinRoom(meta);
      }

      // 写操作需要 editor 以上角色。
      if (
        (frame.kind === FrameKind.SyncUpdate || frame.kind === FrameKind.SyncStep2) &&
        !(await this.isWritable(meta))
      ) {
        meta.connection.send([
          { kind: FrameKind.Error, docId: meta.docId, payload: encodeErrorPayload(4403, '只读权限') },
        ]);
        continue;
      }

      const room = await this.rooms.getRoom(meta.docId);
      const reply = await room.handleFrame(meta.connection, { ...frame, docId: meta.docId });
      if (reply) meta.connection.send([reply]);
    }
  }

  private async isWritable(meta: ConnectionMeta): Promise<boolean> {
    try {
      await this.permissions.requireRole(meta.docId, meta.connection.userId, 'write');
      return true;
    } catch {
      return false;
    }
  }

  private joinedRooms = new WeakSet<object>();

  private async joinRoom(meta: ConnectionMeta): Promise<void> {
    if (meta.connection.clientId === 0) return;
    if (this.joinedRooms.has(meta.connection)) return;
    this.joinedRooms.add(meta.connection);

    const room = await this.rooms.getRoom(meta.docId);
    room.addConnection(meta.connection);
    room.pushCurrentAwareness(meta.connection);
    // 标准 y-websocket 握手：服务端主动发 sync step1，客户端回 step2。
    meta.connection.send([
      {
        kind: FrameKind.SyncStep1,
        docId: meta.docId,
        payload: createSyncStep1Payload(room.ydoc),
      },
    ]);
  }

  handleDisconnect(client: WebSocket): void {
    this.cleanup(client);
  }

  private cleanup(ws: WebSocket): void {
    const meta = this.meta.get(ws);
    if (!meta) return;
    this.meta.delete(ws);
    meta.connection.alive = false;
    this.rooms.getRoom(meta.docId).then((room) => {
      room.removeConnection(meta.connection);
      this.rooms.releaseRoom(meta.docId);
    });
  }
}
