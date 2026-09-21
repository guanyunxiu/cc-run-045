import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service.js';
import { AuthService } from '../auth/auth.service.js';
import { PermissionsService } from '../docs/permissions.service.js';

interface AuthedRequest extends Request {
  headers: Request['headers'];
}

/** 在线状态只读接口（Redis 快照），供客户端在长轮询模式下补全 presence。 */
@Controller('collab')
export class PresenceController {
  constructor(
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  @Get('presence/:docId')
  async presence(@Req() req: AuthedRequest, @Param('docId') docId: string): Promise<unknown> {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = this.auth.authenticate(token);
    await this.permissions.requireRole(docId, payload.sub, 'read');
    const [online, awareness] = await Promise.all([
      this.cache.hgetAllJson(`doc:${docId}:online`),
      this.cache.get(`doc:${docId}:awareness`),
    ]);
    return { online, awareness: awareness ? JSON.parse(awareness) : {} };
  }
}
