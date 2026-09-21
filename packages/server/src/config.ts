/**
 * 运行期配置。极简 env 读取（不引入额外配置框架）。
 * PostgreSQL / Redis 不可用时各服务自动降级，保证开发环境零依赖启动。
 */
export const config = {
  port: Number(process.env.HTTP_PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://blockeditor:blockeditor@localhost:5432/blockeditor',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    bucket: process.env.S3_BUCKET ?? 'blockeditor',
  },
};
