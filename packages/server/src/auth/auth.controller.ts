import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** 开发态演示登录，生产环境替换为正式账号体系。 */
  @Post('dev-login')
  @HttpCode(200)
  async devLogin(@Body() body: { name?: string }): Promise<{ token: string; user: { id: string; name: string } }> {
    return this.auth.devLogin(body.name ?? '');
  }
}
