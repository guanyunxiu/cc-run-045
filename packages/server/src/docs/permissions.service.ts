import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, type PermissionRow } from '../database/database.service.js';

export type DocRole = 'owner' | 'editor' | 'reader';

@Injectable()
export class PermissionsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * 全局文档级权限校验。
   *  - owner / editor 可写；reader 只读；无记录则拒绝。
   */
  async requireRole(docId: string, userId: string, need: 'read' | 'write'): Promise<DocRole> {
    const permission = await this.db.getPermission(docId, userId);
    if (!permission) throw new ForbiddenException('没有该文档的访问权限');
    if (need === 'write' && permission.role === 'reader') {
      throw new ForbiddenException('只读权限，无法编辑');
    }
    return permission.role;
  }

  async getRole(docId: string, userId: string): Promise<DocRole | null> {
    return (await this.db.getPermission(docId, userId))?.role ?? null;
  }

  async grant(docId: string, userId: string, role: DocRole): Promise<PermissionRow> {
    const row: PermissionRow = { doc_id: docId, user_id: userId, role };
    await this.db.grantPermission(row);
    return row;
  }

  async assertDocumentExists(docId: string): Promise<void> {
    if (!(await this.db.getDocument(docId))) throw new NotFoundException('文档不存在');
  }

  // -------------------------------------------------------------------------
  // 块级权限扩展接口（迭代 2）：
  //
  // 当前为文档级粒度；表格 / 评论场景需要块级权限时，新增
  // block_permissions(doc_id, block_id, user_id, role) 表并在此实现：
  //
  //   async requireBlockRole(docId, blockId, userId, need): Promise<DocRole> {
  //     1. 查 block_permissions 精确命中 -> 返回块级角色
  //     2. 未命中 -> 回落到 requireRole(docId, userId, need)
  //   }
  //
  // CRDT 层不强制权限（保持离线可用），服务端在校验 SyncUpdate
  // 涉及的 blockId 集合时调用该接口即可。
  // -------------------------------------------------------------------------
}
