import * as Y from 'yjs';
import type { BlockAttributes, BlockMeta, DeltaItem, InlineAttributes } from './types.js';

/** Yjs 内部存储单个块的 Y.Map 别名（meta/attrs/text 三个键）。 */
export type YBlock = Y.Map<unknown>;
export type YBlockMeta = Y.Map<unknown>;
export type YBlockAttrs = Y.Map<unknown>;

/**
 * BlockNode：YBlock 之上的只读 / 写入门面（view）。
 *
 * 不持有任何块数据副本，所有读写直接落到 Yjs 结构上，因此：
 *  - 多端合并后读到的永远是 CRDT 收敛后的最新值；
 *  - 任何写入都会产生 Yjs 事务，自动进入离线持久化与协同同步链路；
 *  - 实例轻量，可按帧创建，无需做引用缓存。
 *
 * 所有写方法都必须经由 BlockDoc.transactLocal 提供的事务上下文调用，
 * 以统一 origin（撤销栈、本地/远端区分依赖 origin）。
 */
export class BlockNode {
  readonly y: YBlock;

  constructor(yBlock: YBlock) {
    this.y = yBlock;
  }

  private get metaMap(): YBlockMeta {
    return this.y.get('meta') as YBlockMeta;
  }

  private get attrsMap(): YBlockAttrs {
    return this.y.get('attrs') as YBlockAttrs;
  }

  get text(): Y.XmlText {
    return this.y.get('text') as Y.XmlText;
  }

  get id(): string {
    return this.metaMap.get('id') as string;
  }

  get type(): string {
    return this.metaMap.get('type') as string;
  }

  get parentId(): string | null {
    return (this.metaMap.get('parentId') as string | null) ?? null;
  }

  get createdBy(): string | null {
    return (this.metaMap.get('createdBy') as string | null) ?? null;
  }

  get createdAt(): number {
    return this.metaMap.get('createdAt') as number;
  }

  get updatedAt(): number {
    return this.metaMap.get('updatedAt') as number;
  }

  getMeta(): BlockMeta {
    return {
      id: this.id,
      type: this.type,
      parentId: this.parentId,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  getAttr<T = unknown>(key: string): T | undefined {
    return this.attrsMap.get(key) as T | undefined;
  }

  getAttrs(): BlockAttributes {
    return Object.fromEntries(this.attrsMap.entries()) as BlockAttributes;
  }

  getDelta(): DeltaItem[] {
    return this.text.toDelta() as DeltaItem[];
  }

  /** 纯文本投影（复制 / 搜索 / 长轮询降级预览使用）。 */
  getPlainText(): string {
    return this.getDelta()
      .map((d) => d.insert ?? '')
      .join('');
  }

  // -----------------------------------------------------------------------
  // 写操作 —— 全部以 Yjs 事务驱动（由 BlockDoc 包裹 origin 后调用）。
  // 直接调用以下方法时不会再开启新事务，必须处于 doc.transact 回调内。
  // -----------------------------------------------------------------------

  setType(type: string): void {
    this.metaMap.set('type', type);
    this.touch();
  }

  setAttr(key: string, value: unknown): void {
    this.attrsMap.set(key, value);
    this.touch();
  }

  setAttrs(attrs: BlockAttributes): void {
    this.transactMany(() => {
      for (const [key, value] of Object.entries(attrs)) this.attrsMap.set(key, value);
    });
    this.touch();
  }

  removeAttr(key: string): void {
    this.attrsMap.delete(key);
    this.touch();
  }

  /** 行内插入文本。index 为 Y.XmlText 的字符串偏移。 */
  insertText(index: number, text: string, attributes?: InlineAttributes): void {
    this.text.insert(index, text, attributes ?? {});
    this.touch();
  }

  deleteText(index: number, length: number): void {
    this.text.delete(index, length);
    this.touch();
  }

  replaceText(index: number, length: number, text: string, attributes?: InlineAttributes): void {
    this.text.delete(index, length);
    this.text.insert(index, text, attributes ?? {});
    this.touch();
  }

  /** 对区间套用行内格式（加粗、链接等），length 0 时无操作。 */
  formatText(index: number, length: number, attributes: InlineAttributes): void {
    if (length > 0) this.text.format(index, length, attributes);
    this.touch();
  }

  /** 以 Delta 数组整体覆盖行内内容（粘贴 / 初始化使用）。 */
  applyDelta(delta: DeltaItem[]): void {
    const currentLength = this.text.length;
    if (currentLength > 0) this.text.delete(0, currentLength);
    for (const op of delta) {
      if (typeof op.insert === 'string') {
        this.text.insert(this.text.length, op.insert, op.attributes ?? {});
      } else if (typeof op.retain === 'number') {
        if (op.attributes) this.text.format(this.text.length, op.retain, op.attributes);
      } else if (typeof op.delete === 'number') {
        // 归一化的剪贴板数据通常只有 insert；防御性地忽略越界 delete。
      }
    }
    this.touch();
  }

  /** 在块内同一事务里批量改多个属性，避免产生多个 Yjs 事务。 */
  transactMany(fn: () => void): void {
    fn();
  }

  private touch(): void {
    this.metaMap.set('updatedAt', Date.now());
  }
}

/** 在 Y.Doc 上初始化一个 YBlock（须在事务内调用）。 */
export function createYBlock(options: {
  id: string;
  type: string;
  now: number;
  createdBy: string | null;
  parentId?: string | null;
  attrs?: BlockAttributes;
}): YBlock {
  const yBlock = new Y.Map<unknown>();

  const meta = new Y.Map<unknown>();
  meta.set('id', options.id);
  meta.set('type', options.type);
  meta.set('parentId', options.parentId ?? null);
  meta.set('createdBy', options.createdBy);
  meta.set('createdAt', options.now);
  meta.set('updatedAt', options.now);

  const attrs = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(options.attrs ?? {})) attrs.set(key, value);

  yBlock.set('meta', meta);
  yBlock.set('attrs', attrs);
  yBlock.set('text', new Y.XmlText());
  return yBlock;
}
