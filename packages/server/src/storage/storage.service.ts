import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 对象存储服务 —— 承载图片等二进制资源（迭代 2 图片块的上传后端）。
 *
 * 生产：S3 兼容对象存储（MinIO / AWS S3 / OSS），通过 S3_ENDPOINT 配置。
 * 开发降级：本地 .data/objects/ 目录，接口形态与 S3 直传保持一致：
 *   putObject(key, body, contentType) -> url
 *   getObject(key) -> Buffer
 *
 * 块模型中图片块仅存储资源 URL / 尺寸 / hash，不内嵌二进制，
 * 因此对象存储对 CRDT 协同层完全透明。
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly localDir = resolve(process.cwd(), '.data/objects');
  private s3: { putObject(bucket: string, key: string, body: Buffer): Promise<unknown> } | null = null;
  private bucket = 'blockeditor';

  constructor() {
    mkdirSync(this.localDir, { recursive: true });
    void this.initS3();
  }

  private async initS3(): Promise<void> {
    // S3 客户端为可选依赖：未安装 SDK / 未配置时静默使用本地目录。
    // 生产部署安装 @aws-sdk/client-s3 后，在此 new S3Client({ endpoint })
    // 并将 this.s3 替换为封装的 putObject 实现即可。
  }

  async putObject(body: Buffer, contentType: string, prefix = 'images'): Promise<{ key: string; url: string }> {
    const key = `${prefix}/${randomUUID()}`;
    if (this.s3) {
      await this.s3.putObject(this.bucket, key, body);
      return { key, url: `/api/storage/${key}` };
    }
    const safeKey = key.replace(/[^a-zA-Z0-9/_-]/g, '_');
    const filePath = resolve(this.localDir, safeKey);
    mkdirSync(resolve(filePath, '..'), { recursive: true });
    writeFileSync(filePath, body);
    void contentType;
    return { key, url: `/api/storage/${key}` };
  }

  getObject(key: string): { body: Buffer; contentType: string } | null {
    const safeKey = key.replace(/[^a-zA-Z0-9/_-]/g, '_');
    const filePath = resolve(this.localDir, safeKey);
    if (!existsSync(filePath)) return null;
    return { body: readFileSync(filePath), contentType: guessContentType(key) };
  }
}

function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}
