import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * 缓存抽象。
 *
 * 生产用途：
 *  - 在线用户集合（doc:{id}:online）；
 *  - 临时光标 / awareness 状态快照（TTL 30s，随心跳续期）；
 *  - 房间 -> 实例路由（多实例部署时配合 pub/sub，本迭代预留接口）。
 *
 * Redis 不可用时降级为进程内 Map（功能等价于单实例部署）。
 */
@Injectable()
export class CacheService implements OnModuleInit {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private readonly memory = new Map<string, { value: string; expiresAt: number | null }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  async onModuleInit(): Promise<void> {
    try {
      const client = new Redis(config.redisUrl, {
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        // 只做一次连接尝试：连不上立刻降级为内存缓存，避免无限重连刷屏。
        retryStrategy: () => null,
      });
      // 降级后 client 仍可能 emit error，绑定空处理器防止进程崩溃。
      client.on('error', () => undefined);
      await client.connect();
      this.redis = client;
      this.logger.log('已连接 Redis');
    } catch (err) {
      this.redis = null;
      this.logger.warn(`Redis 不可用（${(err as Error).message}），降级为进程内缓存`);
      this.sweepTimer = setInterval(() => this.sweepExpired(), 10_000);
    }
  }

  get connected(): boolean {
    return this.redis !== null;
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) return this.redis.get(key);
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (this.redis) {
      if (ttlMs) await this.redis.set(key, value, 'PX', ttlMs);
      else await this.redis.set(key, value);
      return;
    }
    this.memory.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }

  async del(key: string): Promise<void> {
    if (this.redis) await this.redis.del(key);
    else this.memory.delete(key);
  }

  /** JSON map 形式的 hash 读写（在线用户 / 光标快照）。 */
  async hsetJson(key: string, field: string, value: unknown, ttlMs = 30_000): Promise<void> {
    const map = (await this.getAllMap(key)) ?? {};
    map[field] = value;
    await this.set(key, JSON.stringify(map), ttlMs);
  }

  async hdelJson(key: string, field: string): Promise<void> {
    const map = (await this.getAllMap(key)) ?? {};
    delete map[field];
    await this.set(key, JSON.stringify(map), 30_000);
  }

  async hgetAllJson<T>(key: string): Promise<Record<string, T>> {
    return ((await this.getAllMap(key)) ?? {}) as Record<string, T>;
  }

  private async getAllMap(key: string): Promise<Record<string, unknown> | null> {
    const raw = await this.get(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt !== null && entry.expiresAt < now) this.memory.delete(key);
    }
  }
}
