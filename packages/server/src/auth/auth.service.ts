import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { DatabaseService, type UserRow } from '../database/database.service.js';

export interface JwtPayload {
  sub: string;
  name: string;
  iat: number;
}

/**
 * 极简 HMAC-SHA256 JWT（无第三方依赖）。
 * 生产环境可直接替换为标准鉴权服务，令牌格式保持 JWT 兼容。
 */
@Injectable()
export class AuthService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  private b64url(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
  }

  sign(payload: Omit<JwtPayload, 'iat'>): string {
    const full: JwtPayload = { ...payload, iat: Date.now() };
    const header = this.b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = this.b64url(JSON.stringify(full));
    const sig = createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }

  verify(token: string | null | undefined): JwtPayload {
    if (!token) throw new UnauthorizedException('缺少令牌');
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('令牌格式错误');
    const [header, body, sig] = parts;
    const expected = createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
    const sigBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
      throw new UnauthorizedException('令牌签名无效');
    }
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload;
    } catch {
      throw new UnauthorizedException('令牌载荷无效');
    }
  }

  /** 从 HTTP Authorization 头或 WebSocket 协议帧中解析用户。 */
  authenticate(token: string | null | undefined): JwtPayload {
    return this.verify(token);
  }

  /** 开发态演示登录：按昵称自动注册 / 登录并签发令牌。 */
  async devLogin(name: string): Promise<{ token: string; user: { id: string; name: string } }> {
    const trimmed = name.trim();
    if (!trimmed) throw new UnauthorizedException('昵称不能为空');
    let row: UserRow | null = await this.db.findUserByName(trimmed);
    if (!row) {
      row = { id: randomUUID(), name: trimmed, password_hash: null, created_at: Date.now() };
      await this.db.insertUser(row);
    }
    const token = this.sign({ sub: row.id, name: row.name });
    return { token, user: { id: row.id, name: row.name } };
  }
}
