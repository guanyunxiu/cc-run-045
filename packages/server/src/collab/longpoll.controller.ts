import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FrameKind, type Frame } from '@blockeditor/proto';
import { RoomManager } from './room-manager.service.js';
import { AuthService } from '../auth/auth.service.js';
import { PermissionsService } from '../docs/permissions.service.js';
import { PollConnection, welcomeFrames, unpackFrames, packFrames } from './poll-connection.js';

interface SessionEntry {
  connection: PollConnection;
  docId: string;
  userId: string;
}

/**
 * HTTP 长轮询降级入口：POST /api/collab/poll/:docId
 *
 * 请求体 = 上行帧二进制（可为空）；
 * 响应 = 阻塞至有下行帧或 25s 超时后的帧二进制。
 *
 * 与 WebSocket 网关共用 Room / sync / awareness 全套逻辑，
 * 仅传输适配不同，用于严格代理 / WebSocket 被封禁的网络环境。
 */
@Controller('collab')
export class LongPollController {
  private readonly logger = new Logger(LongPollController.name);
  /** 会话键 = docId:userId:clientId。 */
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    @Inject(RoomManager) private readonly rooms: RoomManager,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 15_000);
  }

  @Post('poll/:docId')
  async poll(
    @Req() req: Request,
    @Res() res: Response,
    @Param('docId') docId: string,
    @Body() body: Buffer,
  ): Promise<void> {
    const queryClientId = Number(req.query.clientId ?? NaN);
    let userId = '';
    let userName = '';
    try {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const payload = this.auth.authenticate(token);
      userId = payload.sub;
      userName = payload.name;
      await this.permissions.requireRole(docId, userId, 'read');
    } catch (err) {
      throw new ForbiddenException((err as Error).message);
    }

    // 解析上行帧（body 可能为空：首次接入 / 纯心跳 poll）。
    const incoming: Frame[] = body && body.length ? unpackFrames(new Uint8Array(body)) : [];
    const clientId = incoming.find((f) => f.clientId !== undefined)?.clientId ?? queryClientId;
    if (!Number.isFinite(clientId) || clientId === 0) {
      res.status(400).end();
      return;
    }

    const sessionKey = `${docId}:${userId}:${clientId}`;
    let session = this.sessions.get(sessionKey);
    const room = await this.rooms.getRoom(docId);

    if (!session) {
      const connection = new PollConnection(clientId, userId, userName);
      session = { connection, docId, userId };
      this.sessions.set(sessionKey, session);
      room.addConnection(connection);
      room.pushCurrentAwareness(connection);
      connection.send(welcomeFrames(docId, room.ydoc));
      connection.markJoined();
    }

    const writable = await this.permissions
      .requireRole(docId, userId, 'write')
      .then(() => true)
      .catch(() => false);

    for (const frame of incoming) {
      if (frame.kind === FrameKind.Auth || frame.kind === FrameKind.Ping) {
        if (frame.kind === FrameKind.Ping) session.connection.send([{ kind: FrameKind.Pong, docId, payload: new Uint8Array(0) }]);
        continue;
      }
      if (!writable && (frame.kind === FrameKind.SyncUpdate || frame.kind === FrameKind.SyncStep2)) {
        continue; // 静默丢弃只读用户的写操作
      }
      try {
        const reply = await room.handleFrame(session.connection, { ...frame, docId });
        if (reply) session.connection.send([reply]);
      } catch (err) {
        this.logger.warn(`长轮询帧处理失败: ${(err as Error).message}`);
      }
    }

    // 阻塞等待下行帧；25s 心跳超时，返回 Pong 维持会话。
    const frames = await session.connection.waitForFrames(25_000);
    const out = frames.length ? frames : [{ kind: FrameKind.Pong, docId, payload: new Uint8Array(0) } as Frame];

    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(packFrames(out)));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (!session.connection.isExpired(now)) continue;
      session.connection.close();
      this.rooms.getRoom(session.docId).then((room) => {
        room.removeConnection(session.connection);
        this.rooms.releaseRoom(session.docId);
      });
      this.sessions.delete(key);
    }
  }
}
