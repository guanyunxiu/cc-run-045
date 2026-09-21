import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { DocsService } from './docs.service.js';
import { PermissionsService } from './permissions.service.js';
import { AuthService } from '../auth/auth.service.js';

interface AuthedRequest extends Request {
  userId?: string;
}

@Controller('docs')
export class DocsController {
  constructor(
    @Inject(DocsService) private readonly docs: DocsService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  private currentUserId(req: AuthedRequest): string {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.auth.authenticate(token).sub;
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    const userId = this.currentUserId(req);
    const rows = await this.docs.list(userId);
    return rows.map((r) => this.toDto(r));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { title?: string }) {
    const userId = this.currentUserId(req);
    const doc = await this.docs.create(body.title ?? '', userId);
    return this.toDto(doc);
  }

  @Get(':id')
  async get(@Req() req: AuthedRequest, @Param('id') id: string) {
    const userId = this.currentUserId(req);
    await this.permissions.requireRole(id, userId, 'read').catch(() => {
      throw new ForbiddenException('无权访问该文档');
    });
    const doc = await this.docs.get(id);
    if (!doc) throw new ForbiddenException('文档不存在');
    return this.toDto(doc);
  }

  private toDto(row: import('../database/database.service.js').DocumentRow) {
    return {
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
