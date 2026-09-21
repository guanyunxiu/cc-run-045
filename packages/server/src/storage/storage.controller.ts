import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from './storage.service.js';
import { AuthService } from '../auth/auth.service.js';

/**
 * 二进制资源上传 / 下载（迭代 2 图片块使用，接口先行）。
 * 鉴权与文档权限一致；本迭代资源全局归上传者，后续可加 docId 维度鉴权。
 */
@Controller('storage')
export class StorageController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Req() req: Request,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string },
  ): Promise<{ url: string; key: string }> {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    this.auth.authenticate(token); // 仅校验登录
    if (!file?.buffer) throw new BadRequestException('缺少上传文件');
    const prefix = file.mimetype.startsWith('image/') ? 'images' : 'files';
    return this.storage.putObject(file.buffer, file.mimetype, prefix);
  }

  /** 简易 JSON 直传（无 multipart 依赖时的测试通道）。 */
  @Post('put/:key(*)')
  async putJson(
    @Req() req: Request,
    @Param('key') key: string,
    @Body() body: { base64: string; contentType?: string },
  ): Promise<{ url: string; key: string }> {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    this.auth.authenticate(token);
    return this.storage.putObject(Buffer.from(body.base64, 'base64'), body.contentType ?? 'application/octet-stream', key.split('/')[0]);
  }

  @Get(':key(*)')
  download(@Param('key') key: string, @Res() res: Response): void {
    const object = this.storage.getObject(key);
    if (!object) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(object.body);
  }
}
