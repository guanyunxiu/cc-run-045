import { Module } from '@nestjs/common';
import { DocsController } from './docs.controller.js';
import { DocsService } from './docs.service.js';
import { PermissionsService } from './permissions.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [DocsController],
  providers: [DocsService, PermissionsService],
  exports: [DocsService, PermissionsService],
})
export class DocsModule {}
