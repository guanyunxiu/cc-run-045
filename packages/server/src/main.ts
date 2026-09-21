import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { WsAdapter } from '@nestjs/platform-ws';
import { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import { config } from './config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  // 长轮询上行是 protobuf 二进制（application/x-protobuf），
  // Nest 默认只解析 json / urlencoded，需为该路由单独挂 raw parser。
  app.use('/api/collab/poll', raw({ type: () => true, limit: '5mb' }));
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({ origin: config.corsOrigin, credentials: true });
  app.setGlobalPrefix('api');

  await app.listen(config.port);
  console.log(`[blockeditor] HTTP + WS 服务已启动: http://localhost:${config.port}`);
}

void bootstrap();
