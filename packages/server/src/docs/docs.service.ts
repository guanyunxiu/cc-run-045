import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type DocumentRow } from '../database/database.service.js';

@Injectable()
export class DocsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async list(userId: string): Promise<DocumentRow[]> {
    return this.db.listDocumentsForUser(userId);
  }

  async get(id: string): Promise<DocumentRow | null> {
    return this.db.getDocument(id);
  }

  async create(title: string, ownerId: string): Promise<DocumentRow> {
    const now = Date.now();
    const doc: DocumentRow = {
      id: randomUUID(),
      title: title.trim() || '未命名文档',
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertDocument(doc, ownerId);
    return doc;
  }

  async touch(id: string): Promise<void> {
    await this.db.touchDocument(id, Date.now());
  }
}
