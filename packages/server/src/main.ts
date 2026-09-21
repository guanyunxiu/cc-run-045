import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { WsAdapter } from '@nestjs/platform-ws';
import { config } from './config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  // 长轮询上行帧为 protobuf 二进制（Content-Type: application/x-protobuf），
  // 默认的 json/urlencoded 解析器会把请求体留空；这里按 Buffer 原样收下。
  app.useBodyParser('raw', { type: 'application/x-protobuf', limit: '5mb' });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({ origin: config.corsOrigin, credentials: true });
  app.setGlobalPrefix('api');

  await app.listen(config.port);
  console.log(`[blockeditor] HTTP + WS 服务已启动: http://localhost:${config.port}`);
}

void bootstrap();
