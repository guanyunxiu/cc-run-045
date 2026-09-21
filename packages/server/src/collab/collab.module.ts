import { Module } from '@nestjs/common';
import { CollabGateway } from './collab.gateway.js';
import { LongPollController } from './longpoll.controller.js';
import { RoomManager } from './room-manager.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DocsModule } from '../docs/docs.module.js';
import { PresenceController } from './presence.controller.js';

@Module({
  imports: [DatabaseModule, CacheModule, AuthModule, DocsModule],
  controllers: [LongPollController, PresenceController],
  providers: [CollabGateway, RoomManager],
  exports: [RoomManager],
})
export class CollabModule {}
