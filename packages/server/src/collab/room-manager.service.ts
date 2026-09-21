import { Inject, Injectable, Logger } from '@nestjs/common';
import { Room } from './room.js';
import { DatabaseService } from '../database/database.service.js';
import { CacheService } from '../cache/cache.service.js';
import { DocsService } from '../docs/docs.service.js';

/**
 * RoomManager —— 文档房间的全局注册表与生命周期管理。
 *
 *  - 按文档 ID 懒加载房间（首次接入时从持久化状态恢复 Y.Doc）；
 *  - 引用计数：最后一个连接离开后保留房间一小段时间（快速重连友好），
 *    随后持久化并销毁，释放服务端内存；
 *  - 多实例部署时房间定位应结合 Redis 路由表（本迭代单实例，接口已预留）。
 */
@Injectable()
export class RoomManager {
  private readonly logger = new Logger(RoomManager.name);
  private readonly rooms = new Map<string, { room: Room; disposeTimer: ReturnType<typeof setTimeout> | null }>();
  /** 当前正在加载的房间，去重并发接入。 */
  private readonly loading = new Map<string, Promise<Room>>();

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(DocsService) private readonly docs: DocsService,
  ) {}

  async getRoom(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing) {
      if (existing.disposeTimer) {
        clearTimeout(existing.disposeTimer);
        existing.disposeTimer = null;
      }
      await existing.room.ensureLoaded();
      return existing.room;
    }

    const loading = this.loading.get(docId);
    if (loading) return loading;

    const promise = (async () => {
      const room = new Room(docId, this.db, this.cache, this.docs);
      await room.ensureLoaded();
      this.rooms.set(docId, { room, disposeTimer: null });
      this.loading.delete(docId);
      this.logger.log(`房间已打开 ${docId}`);
      return room;
    })();
    this.loading.set(docId, promise);
    return promise;
  }

  /** 连接离开后调用，归零时延迟回收房间。 */
  releaseRoom(docId: string): void {
    const entry = this.rooms.get(docId);
    if (!entry || entry.room.connectionCount > 0) return;
    entry.disposeTimer = setTimeout(() => {
      void entry.room.destroy();
      this.rooms.delete(docId);
      this.logger.log(`空闲房间已回收 ${docId}`);
    }, 30_000);
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }
}
