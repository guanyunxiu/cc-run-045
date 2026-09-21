import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { CacheModule } from './cache/cache.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DocsModule } from './docs/docs.module.js';
import { CollabModule } from './collab/collab.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    // 基础设施（PostgreSQL / Redis，均带本地降级）。
    DatabaseModule,
    CacheModule,
    // 业务。
    AuthModule,
    DocsModule,
    CollabModule,
    StorageModule,
  ],
})
export class AppModule {}
